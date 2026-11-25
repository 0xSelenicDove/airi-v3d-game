"""
Live motion for the game from Kimodo, NVIDIA's text-to-motion model. It speaks the WebSocket protocol of
tools/ardy/ardy_server.py (the protocol is described there), so the game plays either one.

Kimodo makes a few seconds of motion at a time. Each part starts on the last frames of the part before it, and
follows the path, places, heights and poses that the game gives. Each connection is one character with its own motion.

The server binds to 127.0.0.1 only.

On top of the ARDY protocol:
  client to server: {"t": "play", "text": "a person stretches both arms"}
                    any description, in English. A new description loads the text model (about 16 GB of RAM, about
                    25 s), and each one takes about 0.5 s to encode. The text model is freed after some minutes with
                    nothing to encode. Encoded descriptions are kept in the text cache.
  server to client: {"t": "text", "text": "...", "state": "loading" | "ready" | "failed", "prompt": "text_1a2b3c4d"}
                    with "ready", play "prompt" like any other prompt.
  The ready message also has "texts": true.

Usage: python kimodo_server.py --text-encoders DIR --checkpoints DIR --text-cache FILE.npz [--port 8793] [--steps 30]
"""
import argparse
import asyncio
import hashlib
import json
import os
import queue
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

# prompts stay on this machine: the text model and the motion model load from local folders only
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'ardy'))

import numpy as np
import torch
from scipy.spatial.transform import Rotation
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from plans import BONES, FPS, Anchor, GameFrame, StagePlan, WalkPlan, wrap

MODEL = 'Kimodo-SOMA-RP-v1.2'
SEGMENT = 90         # frames made at a time while standing or holding a pose
LONGEST = 150        # the most frames made at a time along a path
SHORTEST = 24        # the fewest frames made at a time
OVERLAP = 5          # a part starts on this many frames of the part before (Kimodo's own transition length)
BLEND = 10           # frames over which a seam's correction fades out, at least
SEAM_SPEED = 4.0     # degrees per frame: a bigger correction fades out over more frames
AHEAD = 80           # make more while fewer than this many frames are ready past the playback position
MARGIN = 6           # a change starts this many frames after the playback position, plus the time that making it takes
PATH_EVERY = 3       # frames between root constraints on a path or in a furniture stage
UPRIGHT = ('idle', 'relax')  # prompts that end standing upright with the hands at the sides
UPRIGHT_FROM = 24    # frames into such a part where the hips and hands are held there
UPRIGHT_EVERY = 6    # frames between those holds
POSE_FROM = 10       # a bed pose is held from this many frames into a part, so a part can first settle from the one before
POSE_EVERY = 9       # frames between the held bed pose's keyframes
UNLOAD_SECONDS = 300 # the text model is freed after this long with nothing to encode
OVERHEAD = 60        # a part costs about as much as this many frames more than it has (measured: 0.9 s for 32 frames, 2 s for 155)
LONGEST_TEXT = 300   # characters in a description
# prompts this server does not offer, so the game plays its clips for them. Lying down with Kimodo dropped back fast
# and swung an arm into the wall, and getting up stayed lying through the sitting up. At the desk, typing slumped back
# in the chair, and standing up ended lying on the floor.
CLIPS_INSTEAD = ('motion_lie_down', 'motion_lie', 'motion_get_up', 'motion_sit_down', 'motion_sit', 'motion_type', 'motion_stand_up')

MIRROR = np.diag([-1.0, 1.0, 1.0])  # SOMA (x left) to Unity (x right)


def about_y(angle):
    """rotation about the up axis by `angle`: it turns the facing direction +z toward +x, like the heading"""
    c, s = np.cos(angle), np.sin(angle)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


WORKER_FLAG = '--text-worker'
REPLY = '@@'         # lines from the text worker that are replies start with this (the libraries print other lines)


def text_worker(encoders_dir):
    """
    the text model in its own process: one JSON line in ({"text": ...}), one reply line out. Loading it in the
    server's process changed torch's default dtype for a moment, and a motion made on the other thread then failed
    with "mat1 and mat2 must have the same dtype".
    """
    os.environ['TEXT_ENCODERS_DIR'] = encoders_dir
    from kimodo.model import LLM2VecEncoder
    encoder = LLM2VecEncoder(
        base_model_name_or_path='McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp',
        peft_model_name_or_path='McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised',
        dtype='bfloat16', llm_dim=4096, device='cpu',
    )
    print(REPLY + json.dumps({'ready': True}), flush=True)
    for line in sys.stdin:
        text = json.loads(line)['text']
        with torch.no_grad():
            feat, _ = encoder([text])
        feat = feat[0].float().cpu().numpy()
        print(REPLY + json.dumps({'shape': list(feat.shape), 'feature': feat.ravel().tolist()}), flush=True)


class Texts:
    """
    text features, keyed by the text: read from the cache file, or made by the text model. The text model starts (in
    its own process) only for a text that is not in the cache, and stops when it has had nothing to do for a while.
    """

    def __init__(self, cache_file, encoders_dir):
        self.file = cache_file
        self.encoders_dir = encoders_dir
        self.features = {}
        os.makedirs(os.path.dirname(os.path.abspath(cache_file)), exist_ok=True)
        if os.path.exists(cache_file):
            with np.load(cache_file) as f:
                self.features = {k: f[k] for k in f.files}
        self.worker = None
        self.used = 0.0
        self.jobs = queue.Queue()
        self.busy = threading.Lock()   # held while the text model loads, encodes or is freed
        threading.Thread(target=self._run, daemon=True).start()

    @staticmethod
    def key(text):
        return hashlib.sha1(text.encode('utf-8')).hexdigest()

    def has(self, text):
        return self.key(text) in self.features

    def get(self, text):
        return self.features[self.key(text)]

    def encode(self, texts):
        """encode the texts that are not in the cache yet, here and now"""
        with self.busy:
            self._encode([t for t in dict.fromkeys(texts) if not self.has(t)])

    def _encode(self, todo):
        if not todo:
            return
        self.used = time.time()
        if self.worker is None:
            print(f'loading the text model for {len(todo)} new text(s)', flush=True)
            started = time.time()
            self.worker = subprocess.Popen([sys.executable, '-u', __file__, WORKER_FLAG, self.encoders_dir],
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                           text=True, encoding='utf-8', bufsize=1)
            self._reply()
            print(f'text model loaded in {time.time() - started:.0f} s', flush=True)
        for text in todo:
            started = time.time()
            self.worker.stdin.write(json.dumps({'text': text}) + '\n')
            self.worker.stdin.flush()
            reply = self._reply()
            self.features[self.key(text)] = np.array(reply['feature'], dtype=np.float32).reshape(reply['shape'])
            self.used = time.time()
            print(f'encoded in {time.time() - started:.1f} s: {text}', flush=True)
        tmp = self.file + '.tmp.npz'
        np.savez(tmp, **self.features)
        os.replace(tmp, self.file)

    def _reply(self):
        """the text worker's next reply; other lines it prints are passed over"""
        for line in self.worker.stdout:
            if line.startswith(REPLY):
                return json.loads(line[len(REPLY):])
        raise RuntimeError('the text model stopped')

    def unload(self):
        with self.busy:
            if self.worker is not None:
                self.worker.stdin.close()
                try:
                    self.worker.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.worker.kill()
                self.worker = None
                print('text model freed', flush=True)

    def request(self, text, done):
        """encode `text` on the encoder thread, then call done(ok) there"""
        self.jobs.put((text, done))

    def _run(self):
        while True:
            try:
                text, done = self.jobs.get(timeout=10)
            except queue.Empty:
                if self.worker is not None and not self.busy.locked() and time.time() - self.used > UNLOAD_SECONDS:
                    self.unload()
                continue
            try:
                self.encode([text])
                done(True)
            except Exception as error:
                print(f'encoding failed: {type(error).__name__}: {error}', flush=True)
                self.unload()
                done(False)


class CachedText(torch.nn.Module):
    """Kimodo's text encoder, answered from the cache: a text must be encoded before it is played"""

    def __init__(self, texts):
        super().__init__()
        self.texts = texts

    def forward(self, texts):
        out = torch.zeros(len(texts), 1, 4096)
        for i, text in enumerate(texts):
            out[i, 0] = torch.from_numpy(self.texts.get(text)[0])
        return out, [1] * len(texts)


class Raw:
    """conditions written straight into Kimodo's inputs, for what its constraint sets do not cover alone"""

    def __init__(self, **items):
        self.items = items  # feature name -> (indices, values)

    def update_constraints(self, data_dict, index_dict):
        for name, (index, value) in self.items.items():
            index_dict[name].append(index)
            data_dict[name].append(value)


class Part:
    """frames of motion in the server's model space: 77 SOMA joints, plus the smooth root and the heading"""

    def __init__(self, joints, rots, root, heading):
        self.joints, self.rots, self.root, self.heading = joints, rots, root, heading

    def __len__(self):
        return len(self.root)

    def slice(self, start, end=None):
        return Part(self.joints[start:end], self.rots[start:end], self.root[start:end], self.heading[start:end])

    def then(self, other):
        return Part(np.concatenate([self.joints, other.joints]), np.concatenate([self.rots, other.rots]),
                    np.concatenate([self.root, other.root]), np.concatenate([self.heading, other.heading]))


class Motion:
    """the model, and turning its output into what the game plays"""

    def __init__(self, texts, prompts, device):
        from kimodo import load_model
        from kimodo.sanitize import sanitize_texts
        self.sanitize = lambda text: sanitize_texts([text])[0]
        self.device = device
        self.texts = texts
        self.prompts = {name: self.sanitize(text) for name, text in prompts.items() if name not in CLIPS_INSTEAD}
        texts.encode(list(self.prompts.values()))
        texts.unload()
        self.model = load_model(MODEL, device=device, default_family='Kimodo', text_encoder=CachedText(texts))
        self.skeleton = self.model.skeleton                 # the 30 joints the model works on
        self.output = self.model.output_skeleton            # the 77 joints it returns
        names = list(self.output.bone_order_names)
        self.joints = [names.index(n) for n in BONES]
        self.hips = names.index('Hips')
        self.feet = [names.index('LeftFoot'), names.index('RightFoot')]
        self.slice = self.skeleton.get_skel_slice(self.output)
        self.hands = [list(self.skeleton.bone_order_names).index(n) for n in ('LeftHand', 'RightHand')]
        self.rest = self._rest()
        self.poses = self._body_poses()
        self.stand_height, self.stand_hands = self._standing()

    def _rest(self):
        """the standard T-pose: each bone's position in Unity axes, for fitting it to an avatar's proportions"""
        joints = self.output.neutral_joints.cpu().numpy() * np.array([-1, 1, 1])
        floor = float(joints[:, 1].min())
        names = list(self.output.bone_order_names)
        return {
            'positions': {BONES[n]: joints[names.index(n)].round(5).tolist() for n in BONES},
            'hipsHeight': round(float(joints[self.hips, 1] - floor), 5),
        }

    def _body_poses(self):
        """full-body poses for the bed, facing heading 0, relative to the root: flat on the back, and sitting with straight legs"""
        skeleton = self.skeleton
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

    def _standing(self):
        """
        Kimodo's own standing: the root's height, and each hand's place relative to the root when facing +z. Kimodo
        carries on from the pose a part starts in, so without these an "idle" after a squat stays low, and raised arms
        stay up.
        """
        part = self.make('idle', 90, [], np.zeros(3), 0.0, 30)
        names = list(self.output.bone_order_names)
        hands = [names.index('LeftHand'), names.index('RightHand')]
        ground = part.root * np.array([1.0, 0.0, 1.0])
        places = [(part.joints[i, hands] - ground[i]) @ about_y(-part.heading[i]).T for i in range(len(part))]
        height = float(np.median(part.root[:, 1]))
        print(f'standing: root {height:.3f} m, hands {np.median(places, axis=0).round(3).tolist()}', flush=True)
        return height, np.median(places, axis=0)

    def constraints(self, before, lead, total, plan, start_frame, prompt=None):
        """
        constraints for one part, in a frame where the part starts at the origin facing +z. `before` is the motion just
        before the part (its last `lead` frames are the part's first frames), or None for a first part.
        Returns the constraints, and the origin and heading of that frame.
        """
        from kimodo.constraints import EndEffectorConstraintSet, FullBodyConstraintSet, Root2DConstraintSet
        device = self.device
        if before is not None:
            origin = before.root[0].copy()
            origin[1] = 0.0
            turn = float(before.heading[0])
        else:
            origin, turn = np.zeros(3), 0.0
        to_local = about_y(-turn)

        def tensor(a):
            return torch.tensor(np.asarray(a), dtype=torch.float32, device=device)

        out = []
        if before is not None:
            pos = (before.joints[:, self.slice] - origin) @ to_local.T
            rot = to_local @ before.rots[:, self.slice]
            root = ((before.root - origin) @ to_local.T)[:, [0, 2]]
            index = torch.arange(lead)
            out.append(FullBodyConstraintSet(self.skeleton, index, tensor(pos), tensor(rot), tensor(root)))
            out.append(EndEffectorConstraintSet(self.skeleton, index, tensor(pos), tensor(rot), tensor(root),
                                                joint_names=['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot']))
        if plan is None:
            if prompt in UPRIGHT:
                local = np.arange(lead + UPRIGHT_FROM, total, UPRIGHT_EVERY)
                if len(local):
                    # where the part starts, facing the way it starts: a standing character stays about there. The
                    # facing is held too: with the hands held and the facing free, the body spun up to 180 degrees
                    stand = np.array([0.0, 0.0, 0.0]) if before is None else (before.root[-1] - origin) @ to_local.T
                    hands = self.stand_hands + np.array([stand[0], 0.0, stand[2]])
                    pairs = [[int(f), j] for f in local for j in self.hands]
                    where = [hands[k] for _ in local for k in range(2)]
                    out.append(Raw(root_y_pos=(torch.tensor(local), tensor(np.full(len(local), self.stand_height))),
                                   smooth_root_2d=(torch.tensor(local), tensor(np.tile([stand[0], stand[2]], (len(local), 1)))),
                                   global_root_heading=(torch.tensor(local), tensor(np.tile([1.0, 0.0], (len(local), 1)))),
                                   global_joints_positions=(torch.tensor(pairs), tensor(where))))
            return out, origin, turn

        local = np.arange(lead + PATH_EVERY - 1, total, PATH_EVERY)
        frames = start_frame + local
        if isinstance(plan, StagePlan):
            xz, heading, height, keys = plan.at(frames)
        else:
            (xz, heading), height, keys = plan.at(frames), None, None
        flat = np.stack([xz[:, 0], np.zeros(len(xz)), xz[:, 1]], axis=1)
        xz_local = ((flat - origin) @ to_local.T)[:, [0, 2]]
        heading_local = heading - turn
        out.append(Root2DConstraintSet(self.skeleton, torch.tensor(local), tensor(xz_local),
                                       global_root_heading=tensor(np.stack([np.cos(heading_local), np.sin(heading_local)], axis=1))))
        if height is not None:
            out.append(Raw(root_y_pos=(torch.tensor(local), tensor(height))))
            chosen = [i for i, k in enumerate(keys) if k and local[i] >= lead + POSE_FROM][::max(1, POSE_EVERY // PATH_EVERY)]
            if chosen:
                pairs, where = [], []
                for i in chosen:
                    place = self.poses[keys[i]] @ about_y(heading_local[i]).T + np.array([xz_local[i, 0], height[i], xz_local[i, 1]])
                    for j, p in enumerate(place):
                        pairs.append([int(local[i]), j])
                        where.append(p)
                out.append(Raw(global_joints_positions=(torch.tensor(pairs), tensor(where))))
        return out, origin, turn

    @torch.no_grad()
    def make(self, prompt, frames, constraints, origin, turn, steps):
        """one part of `frames` frames, placed back from the part's own frame into model space"""
        out = self.model(self.prompts[prompt], frames, num_denoising_steps=steps, constraint_lst=constraints,
                         return_numpy=True, post_processing=False, progress_bar=lambda x, **k: x)
        to_world = about_y(turn)
        gh = out['global_root_heading']
        return Part(out['posed_joints'] @ to_world.T + origin, to_world @ out['global_rot_mats'],
                    out['smooth_root_pos'] @ to_world.T + origin, wrap(np.arctan2(gh[:, 1], gh[:, 0]) + turn))

    def unity(self, part):
        """world rotations, hips and feet in Unity axes, and the root and heading in model axes"""
        world = MIRROR @ part.rots[:, self.joints] @ MIRROR
        hips = part.joints[:, self.hips] * MIRROR.diagonal()
        feet = part.joints[:, self.feet] * MIRROR.diagonal()
        return world, hips, feet, part.root, part.heading


def ease_seam(part, before, lead):
    """
    Kimodo holds a part's first frames to the motion before it, but the frames right after can still jump. The first
    new frame is moved to where the motion before was heading, and the move fades out over the next frames: at least
    BLEND frames, and more for a big difference, so that no correction is more than SEAM_SPEED degrees per frame.
    `before` holds the last two frames before the part.
    """
    if len(part) <= lead or len(before) < 2:
        return part
    prev, last = before.slice(0, 1), before.slice(1, 2)
    rots = last.rots[0] @ np.swapaxes(prev.rots[0], -1, -2) @ last.rots[0]
    joints = 2 * last.joints[0] - prev.joints[0]
    root = 2 * last.root[0] - prev.root[0]
    heading = last.heading[0] + wrap(last.heading[0] - prev.heading[0])
    delta = Rotation.from_matrix(rots @ np.swapaxes(part.rots[lead], -1, -2)).as_rotvec()
    d_joints = joints - part.joints[lead]
    d_root = root - part.root[lead]
    d_heading = wrap(heading - part.heading[lead])
    biggest = float(np.degrees(np.linalg.norm(delta, axis=1)).max())
    n = int(np.clip(np.ceil(biggest / SEAM_SPEED), BLEND, 3 * BLEND))
    for k in range(min(n, len(part) - lead)):
        w = 1.0 - k / n
        f = lead + k
        part.rots[f] = Rotation.from_rotvec(delta * w).as_matrix() @ part.rots[f]
        part.joints[f] += d_joints * w
        part.root[f] += d_root * w
        part.heading[f] += d_heading * w
    return part


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
        self.motion = None         # every frame kept, from frame `base`
        self.base = 0
        self.anchors = {}          # frame -> (point, heading) after that frame
        self.roots = {}            # frame -> (x, z, heading, height) of the model's root
        self.walk_request = None
        self.plan = None
        self.after = None          # what to play once the plan ends
        self.game = None

    @property
    def end(self):
        return self.base + (0 if self.motion is None else len(self.motion))

    def send(self, message):
        self.loop.call_soon_threadsafe(self.outbox.put_nowait, message)

    def play(self, prompt):
        with self.lock:
            changed = prompt != self.prompt
            self.prompt = prompt
            if isinstance(self.plan, StagePlan) and self.plan.hold:
                self.plan.hold_prompt = prompt
            elif self.plan is not None:
                self.after = prompt
            elif changed and self.motion is not None:
                self.replan = True

    def walk(self, request):
        with self.lock:
            self.walk_request = request

    def pause(self):
        with self.lock:
            self.prompt = None
            self.replan = False
            self.motion = None
            self.base = self.at = 0
            self.anchors = {}
            self.roots = {}
            self.walk_request = None
            self.plan = None
            self.after = None
            self.epoch += 1

    def wants_frames(self):
        with self.lock:
            if self.prompt is None and self.plan is None:
                return False
            ready_to_walk = self.walk_request is not None and self.motion is not None
            return self.replan or ready_to_walk or self.end - self.at < AHEAD


class Generator(threading.Thread):
    """one thread owns the GPU and serves the streams in turn"""

    def __init__(self, motion, steps):
        super().__init__(daemon=True)
        self.motion, self.steps = motion, steps
        self.streams = []
        self.guard = threading.Lock()
        self.rate = 0.009          # seconds per frame of a part, overhead included, learnt as it runs

    def add(self, stream):
        with self.guard:
            self.streams.append(stream)

    def remove(self, stream):
        with self.guard:
            self.streams.remove(stream)

    def run(self):
        while True:
            with self.guard:
                ready = [s for s in self.streams if s.wants_frames()]
            if not ready:
                time.sleep(0.005)
                continue
            # a change goes first, then the stream closest to running out
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

    def length(self, plan, prompt, cut):
        """frames to make from `cut`: up to where the plan changes prompt"""
        if plan is None:
            return SEGMENT
        longest = SEGMENT if plan.end == float('inf') else max(SHORTEST, min(LONGEST, int(plan.end - cut)))
        n = SHORTEST
        while n < longest and plan.prompt_at(cut + n) == prompt:
            n += 1
        return n

    def generate(self, s):
        motion = self.motion
        with s.lock:
            epoch = s.epoch
            request = s.walk_request if s.motion is not None else None
            if request is not None:
                s.walk_request = None
            replan = s.replan or request is not None
            s.replan = False
            cut = s.end
            if replan:
                # the change starts where playback will be once this part is made
                lag = int(np.ceil(self.rate * (OVERLAP + SEGMENT + OVERHEAD) * FPS * 1.15))
                cut = min(s.end, max(s.at + MARGIN + lag, s.base + OVERLAP))
            if request is not None:
                s.after = None
                if request.get('t') == 'stage':
                    self.start_stage(s, request, cut)
                else:
                    self.start_walk(s, request, cut)
            elif s.plan is not None and cut >= s.plan.end:
                s.plan = None
                s.prompt = s.after or 'idle'
                s.after = None
            plan, game = s.plan, s.game
            prompt = plan.prompt_at(cut) if plan is not None else s.prompt
            lead = OVERLAP if s.motion is not None else 0
            before = s.motion.slice(cut - lead - s.base, cut - s.base) if lead else None
        frames = self.length(plan, prompt, cut)
        if replan:
            frames = min(frames, SEGMENT)  # a change starts sooner with a shorter part
        total = lead + frames

        started = time.perf_counter()
        constraints, origin, turn = motion.constraints(before, lead, total, plan, cut - lead, prompt)
        part = motion.make(prompt, total, constraints, origin, turn, self.steps)
        if before is not None:
            part = ease_seam(part, before.slice(lead - 2, lead), lead)
        new = part.slice(lead)
        took = time.perf_counter() - started
        self.rate = self.rate * 0.7 + took / (total + OVERHEAD) * 0.3

        world, hips, feet, root, root_heading = motion.unity(new)
        count = len(new)
        head = np.zeros((count, 7), dtype=np.float32)
        quats = np.zeros((count, world.shape[1], 4), dtype=np.float32)
        with s.lock:
            if s.epoch != epoch:
                return
            anchor = Anchor(s.anchors.get(cut - 1))
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
            s.motion = new if s.motion is None else s.motion.slice(0, cut - s.base).then(new)
            # the past is not needed beyond what a change can reach back to
            drop = max(0, min(s.at, cut) - OVERLAP - 8 - s.base)
            if drop > 0:
                s.motion = s.motion.slice(drop)
                s.base += drop
            s.anchors = {f: a for f, a in s.anchors.items() if s.base <= f < cut}
            s.roots = {f: a for f, a in s.roots.items() if s.base <= f < cut}
            for i, state in enumerate(states):
                s.anchors[cut + i] = state
                s.roots[cut + i] = (float(root[i, 0]), float(root[i, 2]), float(root_heading[i]), float(root[i, 1]))
            late = s.at - cut

        header = struct.pack('<iiii', cut, count, quats.shape[1], epoch)
        body = np.concatenate([head, quats.reshape(count, -1)], axis=1).astype('<f4').tobytes()
        s.send(header + body)
        print(f'{prompt:<16} frames {cut}-{cut + count}  {took * 1000:4.0f} ms  playing {s.at}'
              f'{"  replan" if replan else ""}{f"  LATE by {late} frames" if late > 0 else ""}', flush=True)


def ask_text(stream, motion, texts, raw):
    """make a description playable, and tell the client when it is"""
    text = motion.sanitize(raw.strip()[:LONGEST_TEXT])
    name = 'text_' + Texts.key(text)[:8]

    def reply(state):
        stream.send(json.dumps({'t': 'text', 'text': raw, 'state': state, 'prompt': name}))

    def done(ok):
        if ok:
            motion.prompts[name] = text
        reply('ready' if ok else 'failed')

    if texts.has(text):
        done(True)
    else:
        reply('loading')
        texts.request(text, done)


async def handle(ws, motion, texts, generator):
    stream = Stream(asyncio.get_running_loop())
    generator.add(stream)

    async def sender():
        while True:
            await ws.send(await stream.outbox.get())

    send = asyncio.create_task(sender())
    try:
        await ws.send(json.dumps({
            't': 'ready', 'fps': FPS, 'prompts': list(motion.prompts), 'bones': list(BONES.values()), 'rest': motion.rest,
            'texts': True,
        }))
        async for raw in ws:
            if not isinstance(raw, str):
                continue
            message = json.loads(raw)
            kind = message.get('t')
            if kind == 'at':
                with stream.lock:
                    stream.at = max(stream.at, int(message['frame']))
            elif kind == 'play' and isinstance(message.get('text'), str) and message['text'].strip():
                ask_text(stream, motion, texts, message['text'])
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
    parser.add_argument('--text-encoders', required=True, help='folder holding McGill-NLP and meta-llama')
    parser.add_argument('--checkpoints', required=True, help=f'folder holding {MODEL}')
    parser.add_argument('--text-cache', required=True, help='npz file of encoded texts, made if missing')
    parser.add_argument('--prompts', default=str(HERE.parent / 'ardy' / 'prompts.json'))
    parser.add_argument('--port', type=int, default=8793)
    parser.add_argument('--steps', type=int, default=30, help='denoising steps, 10 to 100')
    args = parser.parse_args()

    os.environ['CHECKPOINT_DIR'] = args.checkpoints
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    texts = Texts(args.text_cache, args.text_encoders)
    prompts = json.loads(Path(args.prompts).read_text(encoding='utf-8'))
    motion = Motion(texts, prompts, device)
    generator = Generator(motion, max(10, min(args.steps, 100)))
    generator.start()
    async with serve(lambda ws: handle(ws, motion, texts, generator), '127.0.0.1', args.port, max_size=2 ** 20):
        print(f'ready on port {args.port}: {len(motion.prompts)} prompts, {generator.steps} steps, {device}', flush=True)
        await asyncio.Future()


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == WORKER_FLAG:
        text_worker(sys.argv[2])
    else:
        asyncio.run(main())
