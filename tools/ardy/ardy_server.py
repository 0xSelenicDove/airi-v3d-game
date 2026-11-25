"""
Live motion for the game: ARDY generates the body's motion a little ahead of playback and streams it over a local
WebSocket. Each connection is one character with its own motion.

The server binds to 127.0.0.1 only. It loads no text model: prompts come from the cache that encode_prompts.py wrote.

Client to server (JSON text):
  {"t": "play", "prompt": "wave"}   change what the body does, from a few frames after the playback position
  {"t": "walk", "frame": 123, "x": 1.0, "z": 2.0, "yaw": 0.5, "path": [[x, z], ...], "speed": 0.85, "scale": 0.8, "run": false}
                                    walk or run along a path in game metres. x, z and yaw (radians) are where the
                                    character is at that frame. scale is the avatar's leg length over the model's.
  {"t": "stage", "frame": 123, "x": 1.0, "z": 2.0, "yaw": 0.5, "scale": 0.8, "hold": true, "steps": [{"prompt": "motion_sit_down",
   "seconds": 1.5, "x": 1.0, "z": 2.0, "yaw": 0.5, "rootY": 0.56, "pose": "lie"}, ...]}
                                    move through furniture poses: root place, heading and height are constrained, and
                                    "pose" (lie or longsit) is a full-body keyframe at the end of a step. With hold, the
                                    last step is held until the next request.
  {"t": "at", "frame": 123}         the frame the client is playing
  {"t": "pause"}                    stop generating, and start fresh on the next play

Server to client:
  JSON text, first message: {"t": "ready", "fps": 30, "prompts": [...], "bones": [...], "rest": {...}}
  binary: int32 start frame, int32 frame count, int32 bone count, int32 epoch, then for each frame 7 floats and one
  quaternion per bone (x, y, z, w), little-endian. The 7 floats are the hips offset (3), the character's game position
  x and z and yaw in radians, and 1 while the stream walks the character, 2 in a furniture stage, 0 while it stands.
  All in Unity axes.
  Rotations are world rotations relative to the T-pose, with the character's own heading taken out. A later batch
  replaces any frames it overlaps.

Usage: python ardy_server.py --checkpoints DIR --text-cache FILE.npz [--port 8791] [--steps 7]
"""
import argparse
import asyncio
import hashlib
import json
import os
import struct
import threading
import time
from pathlib import Path

os.environ.setdefault('ARDY_SKIP_MOTION_CORRECTION', '1')

import numpy as np
import torch
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from ardy.model.load_model import load_model

from plans import BONES, FPS, Anchor, GameFrame, StagePlan, WalkPlan, wrap

MODEL = 'ARDY-SOMA-RP-30FPS-Horizon60'
HISTORY = 4          # frames of past motion the model sees (a multiple of its 4-frame patch)
KEEP = 32            # frames kept from each 60-frame window
AHEAD = 40           # generate while fewer than this many frames are ready past the playback position
REPLAN_MARGIN = 7    # a new prompt takes over this many frames after the playback position
PATH_EVERY = 4       # frames between path constraints
PATH_GUIDANCE = 2.0  # how strongly the path steers the motion: 2 kept the root within 4 cm of a path with a corner
STAGE_EVERY = 3      # frames between root constraints in a furniture stage

MIRROR = torch.diag(torch.tensor([-1.0, 1.0, 1.0]))  # SOMA (x left) to Unity (x right)


class Motion:
    """the model, and turning its output into what the game plays"""

    def __init__(self, checkpoints, cache_file, prompts_file, device):
        self.device = device
        self.model = load_model(MODEL, device=device, text_encoder=False, checkpoints_dir=checkpoints)
        self.horizon = self.model.gen_horizon_len
        self.skeleton = self.model.skeleton.somaskel77
        names = self.skeleton.bone_order_names
        self.joints = [names.index(n) for n in BONES]
        self.hips = names.index('Hips')
        self.feet = [names.index('LeftFoot'), names.index('RightFoot')]
        self.mirror = MIRROR.to(device)

        prompts = json.loads(Path(prompts_file).read_text(encoding='utf-8'))
        self.prompts = {}
        with np.load(cache_file) as cache:
            for name, text in prompts.items():
                key = hashlib.sha1(text.encode('utf-8')).hexdigest()
                if key not in cache.files:
                    raise SystemExit(f'prompt "{name}" is not in the cache: run encode_prompts.py')
                feat = torch.from_numpy(cache[key]).float().to(device)[None]
                self.prompts[name] = (feat, torch.ones(feat.shape[:2], dtype=torch.bool, device=device))
        self.rest = self._rest()
        self.poses = self._body_poses()

    def _body_poses(self):
        """full-body poses for the bed, facing heading 0, relative to the root: flat on the back, and sitting with straight legs"""
        skeleton = self.model.skeleton
        names = skeleton.bone_order_names

        def about_x(deg):
            a = np.radians(deg)
            return np.array([[1.0, 0.0, 0.0], [0.0, np.cos(a), -np.sin(a)], [0.0, np.sin(a), np.cos(a)]])

        def about_z(deg):
            a = np.radians(deg)
            return np.array([[np.cos(a), -np.sin(a), 0.0], [np.sin(a), np.cos(a), 0.0], [0.0, 0.0, 1.0]])

        def pose(torso, legs):
            rotations = np.repeat(torso[None], len(names), axis=0)
            for i, n in enumerate(names):
                if any(k in n for k in ('Leg', 'Shin', 'Foot', 'Toe')):
                    rotations[i] = legs
                for side, deg in (('Left', -72), ('Right', 72)):
                    if n.startswith(side) and any(k in n for k in ('Arm', 'Hand')):
                        rotations[i] = torso @ about_z(deg)
            world = torch.tensor(rotations, dtype=torch.float32, device=self.device)[None, None]
            _, joints, _ = skeleton.fk(skeleton.global_rots_to_local_rots(world), torch.zeros(1, 1, 3, device=self.device))
            return joints[0, 0].cpu().numpy()

        flat = about_x(-90)
        return {'lie': pose(flat, flat), 'longsit': pose(np.eye(3), flat)}

    def conditions(self, h, offsets, xz, heading, root_y=None, keys=None):
        """the constraints for one window: root place and heading, optional root height, and optional full-body keyframes"""
        device = self.device
        rep = self.model.motion_rep
        frames = torch.tensor(offsets + h, device=device)
        index = {'root_2d': [frames], 'global_root_heading': [frames]}
        data = {
            'root_2d': [torch.tensor(xz, dtype=torch.float32, device=device)],
            'global_root_heading': [torch.tensor(np.stack([np.cos(heading), np.sin(heading)], axis=1), dtype=torch.float32, device=device)],
        }
        if root_y is not None:
            index['root_y_pos'] = [frames]
            data['root_y_pos'] = [torch.tensor(root_y, dtype=torch.float32, device=device)]
        if keys is not None:
            chosen = [i for i, k in enumerate(keys) if k][::2]
            if chosen:
                pairs, where = [], []
                for i in chosen:
                    c, s = np.cos(heading[i]), np.sin(heading[i])
                    turn = np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
                    place = turn @ self.poses[keys[i]].T
                    place = place.T + np.array([xz[i, 0], root_y[i], xz[i, 1]])
                    for j, p in enumerate(place):
                        pairs.append([int(offsets[i]) + h, j])
                        where.append(p)
                index['global_joints_positions'] = [torch.tensor(pairs, device=device)]
                data['global_joints_positions'] = [torch.tensor(np.array(where), dtype=torch.float32, device=device)]
        observed, mask = rep.create_conditions(index, data, h + self.horizon, to_normalize=False, device=device)
        return (rep.normalize(observed) * mask)[None], mask[None]

    def _rest(self):
        """the standard T-pose: each bone's position in Unity axes, for fitting it to an avatar's proportions"""
        # identity rotations on this skeleton are its neutral pose: upright, arms out along x, toes toward +z.
        # (to_standard_tpose is a different thing: it changes each bone's axes for a BVH export.)
        joints = self.skeleton.neutral_joints.cpu().numpy() * np.array([-1, 1, 1])
        floor = float(joints[:, 1].min())
        return {
            'positions': {BONES[n]: joints[self.skeleton.bone_order_names.index(n)].round(5).tolist() for n in BONES},
            'hipsHeight': round(float(joints[self.hips, 1] - floor), 5),
        }

    @torch.no_grad()
    def step(self, history, prompt, steps, cfg, condition=None):
        feat, mask = self.prompts[prompt]
        h = 0 if history is None else history.shape[1]
        observed, motion_mask = condition if condition is not None else (None, None)
        return self.model.autoregressive_step(
            num_frames=h + self.horizon, num_denoising_steps=steps, motion_mask=motion_mask, observed_motion=observed,
            cfg_weight=(cfg, PATH_GUIDANCE if condition is not None else cfg), texts=None, text_feat=feat, text_pad_mask=mask,
            init_history_sequence=history,
        )

    @torch.no_grad()
    def decode(self, features):
        """[1, T, D] model features -> world rotations, hips, feet (Unity axes), and the root and heading (model axes)"""
        out = self.model.motion_rep.inverse(features, is_normalized=True)
        root = out['root_positions'][0].cpu().numpy()
        cos_sin = out['global_root_heading'][0]
        heading = torch.atan2(cos_sin[:, 1], cos_sin[:, 0]).cpu().numpy()
        out = self.model.skeleton.output_to_SOMASkeleton77(out)
        world = self.mirror @ out['global_rot_mats'][0][:, self.joints] @ self.mirror
        joints = out['posed_joints'][0]
        hips = joints[:, self.hips] * self.mirror.diagonal()
        feet = joints[:, self.feet] * self.mirror.diagonal()
        return world.cpu().numpy(), hips.cpu().numpy(), feet.cpu().numpy(), root, heading


class Stream:
    """one character's motion"""

    def __init__(self, loop):
        self.loop = loop
        self.outbox = asyncio.Queue()
        self.lock = threading.Lock()
        self.prompt = None
        self.replan = False
        self.at = 0
        self.epoch = 0
        self.features = None       # model features of every frame kept, from frame `base`
        self.base = 0
        self.anchors = {}          # frame -> (point, heading) after that frame
        self.roots = {}            # frame -> (x, z, heading) of the model's root
        self.walk_request = None
        self.plan = None
        self.game = None
        self.closed = False

    @property
    def end(self):
        return self.base + (0 if self.features is None else self.features.shape[1])

    def play(self, prompt):
        with self.lock:
            changed = prompt != self.prompt
            self.prompt = prompt
            if isinstance(self.plan, StagePlan) and self.plan.hold:
                self.plan.hold_prompt = prompt
            elif changed and self.features is not None and self.plan is None:
                self.replan = True

    def walk(self, request):
        with self.lock:
            self.walk_request = request

    def pause(self):
        with self.lock:
            self.prompt = None
            self.replan = False
            self.features = None
            self.base = self.at = 0
            self.anchors = {}
            self.roots = {}
            self.walk_request = None
            self.plan = None
            self.epoch += 1

    def wants_frames(self):
        with self.lock:
            if self.prompt is None and self.plan is None:
                return False
            ready_to_walk = self.walk_request is not None and self.features is not None
            return self.replan or ready_to_walk or self.end - self.at < AHEAD


class Generator(threading.Thread):
    """one thread owns the GPU and serves the streams in turn"""

    def __init__(self, motion, steps, cfg):
        super().__init__(daemon=True)
        self.motion, self.steps, self.cfg = motion, steps, cfg
        self.streams = []
        self.guard = threading.Lock()

    def add(self, stream):
        with self.guard:
            self.streams.append(stream)

    def remove(self, stream):
        stream.closed = True
        with self.guard:
            self.streams.remove(stream)

    def run(self):
        while True:
            with self.guard:
                ready = [s for s in self.streams if s.wants_frames()]
            if not ready:
                time.sleep(0.005)
                continue
            # the stream closest to running out goes first
            ready.sort(key=lambda s: (not (s.replan or s.walk_request), s.end - s.at))
            try:
                self.generate(ready[0])
            except Exception as error:
                print(f'generation failed: {type(error).__name__}: {error}', flush=True)
                ready[0].pause()

    def start_walk(self, s, request, cut):
        """called with the stream locked: line the game up with the model at the client's frame, and plan the path"""
        frame = min(max(int(request['frame']), s.base), cut - 1)
        here = s.roots.get(frame) or s.roots[cut - 1]
        s.game = GameFrame(float(request['scale']), (request['x'], request['z']), float(request['yaw']), here[:2], here[2])
        corners = s.game.to_model(np.array(request['path'], dtype=float))
        start = s.roots[cut - 1]
        s.plan = WalkPlan(cut, np.array(start[:2]), start[2], corners, float(request['speed']) / float(request['scale']), bool(request.get('run')))

    def start_stage(self, s, request, cut):
        """called with the stream locked: line the game up with the model, and plan the furniture steps"""
        frame = min(max(int(request['frame']), s.base), cut - 1)
        here = s.roots.get(frame) or s.roots[cut - 1]
        s.game = GameFrame(float(request['scale']), (request['x'], request['z']), float(request['yaw']), here[:2], here[2])
        steps = []
        for step in request['steps']:
            place = s.game.to_model(np.array([step['x'], step['z']], dtype=float))
            steps.append({
                'prompt': step['prompt'], 'seconds': float(step['seconds']), 'x': float(place[0]), 'z': float(place[1]),
                'heading': float(wrap(s.game.turn - float(step['yaw']))), 'y': float(step['rootY']), 'pose': step.get('pose'),
            })
        start = s.roots[cut - 1]
        s.plan = StagePlan(cut, start[:2], start[2], start[3], steps, bool(request.get('hold')))

    def generate(self, s):
        with s.lock:
            epoch = s.epoch
            request = s.walk_request if s.features is not None else None
            if request is not None:
                s.walk_request = None
            replan = s.replan or request is not None
            s.replan = False
            features, base = s.features, s.base
            cut = s.end
            if replan:
                cut = min(s.end, max(s.at + REPLAN_MARGIN, base + HISTORY))
            if request is not None:
                if request.get('t') == 'stage':
                    self.start_stage(s, request, cut)
                else:
                    self.start_walk(s, request, cut)
            elif s.plan is not None and cut >= s.plan.end + 30:
                s.plan = None
                s.prompt = 'idle'
            plan, game = s.plan, s.game
            prompt = plan.prompt_at(cut) if plan is not None else s.prompt
        history = None
        if features is not None:
            start = max(cut - HISTORY, base)
            start = cut - ((cut - start) // 4) * 4
            history = features[:, start - base:cut - base].clone()
        h = 0 if history is None else history.shape[1]

        condition = None
        if isinstance(plan, StagePlan):
            offsets_in_window = np.arange(STAGE_EVERY - 1, self.motion.horizon, STAGE_EVERY)
            xz, heading, height, keys = plan.at(cut + offsets_in_window)
            condition = self.motion.conditions(h, offsets_in_window, xz, heading, height, keys)
        elif plan is not None:
            offsets_in_window = np.arange(PATH_EVERY - 1, self.motion.horizon, PATH_EVERY)
            xz, heading = plan.at(cut + offsets_in_window)
            condition = self.motion.conditions(h, offsets_in_window, xz, heading)

        started = time.perf_counter()
        window = self.motion.step(history, prompt, self.steps, self.cfg, condition)
        kept = window[:, h:h + KEEP]
        # decoded with its history, then the history is cut off
        world, hips, feet, root, root_heading = self.motion.decode(window[:, :h + KEEP])
        world, hips, feet, root, root_heading = world[h:], hips[h:], feet[h:], root[h:], root_heading[h:]

        count = len(world)
        head = np.zeros((count, 7), dtype=np.float32)
        quats = np.zeros((count, world.shape[1], 4), dtype=np.float32)
        with s.lock:
            if s.epoch != epoch:
                return
            previous = s.anchors.get(cut - 1)
            anchor = Anchor(previous)
            states = []
            for i in range(count):
                if plan is not None and cut + i < plan.end:
                    yaw = -float(root_heading[i])
                    root_unity = np.array([-root[i, 0], 0.0, root[i, 2]])
                    offset, quat = anchor.walk(world[i], hips[i], feet[i], root_unity, yaw)
                    game_xz = game.to_game(root[i, [0, 2]])
                    head[i, 3:7] = game_xz[0], game_xz[1], game.yaw_to_game(root_heading[i]), 2.0 if isinstance(plan, StagePlan) else 1.0
                else:
                    offset, quat = anchor.stand(world[i], hips[i], feet[i])
                head[i, :3] = offset
                quats[i] = quat
                states.append(anchor.state())
            s.features = kept if features is None else torch.cat([features[:, :cut - base], kept], dim=1)
            # the past is not needed beyond what a replan can reach back to
            drop = max(0, min(s.at, cut) - HISTORY - 8 - s.base)
            if drop > 0:
                s.features = s.features[:, drop:]
                s.base += drop
            s.anchors = {f: a for f, a in s.anchors.items() if s.base <= f < cut}
            s.roots = {f: a for f, a in s.roots.items() if s.base <= f < cut}
            for i, state in enumerate(states):
                s.anchors[cut + i] = state
                s.roots[cut + i] = (float(root[i, 0]), float(root[i, 2]), float(root_heading[i]), float(root[i, 1]))
            late = s.at - cut

        header = struct.pack('<iiii', cut, count, quats.shape[1], epoch)
        body = np.concatenate([head, quats.reshape(count, -1)], axis=1).astype('<f4').tobytes()
        s.loop.call_soon_threadsafe(s.outbox.put_nowait, header + body)
        ms = (time.perf_counter() - started) * 1000
        print(f'{prompt:<16} frames {cut}-{cut + count}  {ms:4.0f} ms  playing {s.at}'
              f'{"  replan" if replan else ""}{f"  LATE by {late} frames" if late > 0 else ""}', flush=True)


async def handle(ws, motion, generator):
    stream = Stream(asyncio.get_running_loop())
    generator.add(stream)

    async def sender():
        while True:
            await ws.send(await stream.outbox.get())

    send = asyncio.create_task(sender())
    try:
        await ws.send(json.dumps({
            't': 'ready', 'fps': FPS, 'prompts': list(motion.prompts), 'bones': list(BONES.values()), 'rest': motion.rest,
        }))
        async for raw in ws:
            if not isinstance(raw, str):
                continue
            message = json.loads(raw)
            kind = message.get('t')
            if kind == 'at':
                with stream.lock:
                    stream.at = max(stream.at, int(message['frame']))
            elif kind == 'play' and message.get('prompt') in motion.prompts:
                stream.play(message['prompt'])
            elif kind == 'walk':
                stream.walk(message)
            elif kind == 'stage' and all(step.get('prompt') in motion.prompts for step in message.get('steps', [{}])):
                stream.walk(message)
            elif kind == 'pause':
                stream.pause()
    except ConnectionClosed:
        pass
    finally:
        send.cancel()
        generator.remove(stream)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--checkpoints', required=True)
    parser.add_argument('--text-cache', required=True)
    parser.add_argument('--prompts', default=str(Path(__file__).with_name('prompts.json')))
    parser.add_argument('--port', type=int, default=8791)
    parser.add_argument('--steps', type=int, default=7, help='denoising steps, 1 to 10')
    parser.add_argument('--cfg', type=float, default=3.0, help='how strongly the prompt steers the motion')
    args = parser.parse_args()

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    motion = Motion(args.checkpoints, args.text_cache, args.prompts, device)
    generator = Generator(motion, max(1, min(args.steps, 10)), args.cfg)
    generator.start()
    async with serve(lambda ws: handle(ws, motion, generator), '127.0.0.1', args.port, max_size=2 ** 20):
        print(f'ready on port {args.port}: {len(motion.prompts)} prompts, {args.steps} steps, {device}', flush=True)
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
