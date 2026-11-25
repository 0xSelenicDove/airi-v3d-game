"""
What the live motion servers share: the bone map, the walk and furniture plans, the anchor that keeps a standing
character on its spot, and the mapping between game metres and the model's. ARDY (ardy_server.py) and Kimodo
(tools/kimodo/kimodo_server.py) both make SOMA motion at 30 fps, so the same plans drive both.

Needs only numpy and scipy.
"""
import numpy as np
from scipy.spatial.transform import Rotation

FPS = 30
SETTLE_SECONDS = 0.9 # how slowly the anchor follows the feet and the heading follows the hips
STOP_FRAMES = 50     # the walk prompt changes to "slow down and stop" this many frames before the end
POSE_FRAMES = 12     # a step's full-body keyframe applies over its last frames
TURN_FIRST = np.radians(35)     # a path starting further round than this is turned to on the spot first
TURN_SPEED = np.radians(150)    # per second
ACCELERATE, BRAKE = 1.4, 1.0    # m/s2
RUN_ACCELERATE, RUN_BRAKE = 2.4, 1.8
RUN_STOP_FRAMES = 36            # the same as STOP_FRAMES, for a run: it brakes harder

# SOMA joint -> Unity HumanBodyBones name, parents first
BONES = {
    'Hips': 'Hips', 'Spine1': 'Spine', 'Spine2': 'Chest', 'Chest': 'UpperChest', 'Neck1': 'Neck', 'Head': 'Head',
}
for soma, unity in (('Leg', 'UpperLeg'), ('Shin', 'LowerLeg'), ('Foot', 'Foot'), ('ToeBase', 'Toes'),
                    ('Shoulder', 'Shoulder'), ('Arm', 'UpperArm'), ('ForeArm', 'LowerArm'), ('Hand', 'Hand')):
    for side in ('Left', 'Right'):
        BONES[side + soma] = side + unity

def wrap(angle):
    return (angle + np.pi) % (2 * np.pi) - np.pi


class Anchor:
    """
    keeps a standing character on its spot. ARDY's root wanders over time, and the game owns where a character stands
    and faces. The hips are expressed relative to a point that follows the feet slowly, and the heading that follows the
    hips slowly is taken out: weight shifts and twists stay, drift does not.
    """

    def __init__(self, state=None):
        self.point = None if state is None else state[0].copy()
        self.heading = 0.0 if state is None else state[1]

    def stand(self, world, hips, feet):
        rate = 1.0 - np.exp(-1.0 / (FPS * SETTLE_SECONDS))
        forward = world[0] @ np.array([0.0, 0.0, 1.0])
        yaw = float(np.arctan2(forward[0], forward[2]))
        mid = feet.mean(axis=0)
        if self.point is None:
            self.point = mid.copy()
            self.heading = yaw
        else:
            self.point += (mid - self.point) * rate
            self.heading += wrap(yaw - self.heading) * rate
        undo = Rotation.from_euler('y', -self.heading)
        d = hips - self.point
        return undo.apply([d[0], 0.0, d[2]]) + np.array([0.0, hips[1], 0.0]), (undo * Rotation.from_matrix(world)).as_quat()

    def walk(self, world, hips, feet, root_unity, yaw):
        """body relative to the walking root; the anchor stays on the feet, ready for when the character stops"""
        self.point = feet.mean(axis=0)
        self.heading = yaw
        undo = Rotation.from_euler('y', -yaw)
        d = hips - root_unity
        return undo.apply([d[0], 0.0, d[2]]) + np.array([0.0, hips[1], 0.0]), (undo * Rotation.from_matrix(world)).as_quat()

    def state(self):
        return self.point.copy(), self.heading


class GameFrame:
    """maps game metres on the ground to the model's: mirrored, scaled to its body size, and turned and moved to line up"""

    def __init__(self, scale, game_xz, game_yaw, root_xz, root_heading):
        self.scale = scale
        self.turn = root_heading + game_yaw
        self.shift = np.zeros(2)
        self.shift = np.asarray(root_xz) - self.to_model(np.asarray(game_xz, dtype=float))

    def _rotate(self, p, angle):
        c, s = np.cos(angle), np.sin(angle)
        return np.stack([p[..., 0] * c + p[..., 1] * s, -p[..., 0] * s + p[..., 1] * c], axis=-1)

    def to_model(self, xz):
        p = np.array(xz, dtype=float)
        p[..., 0] *= -1
        return self._rotate(p / self.scale, self.turn) + self.shift

    def to_game(self, xz):
        p = self._rotate(np.asarray(xz) - self.shift, -self.turn) * self.scale
        p[..., 0] *= -1
        return p

    def yaw_to_game(self, heading):
        return wrap(self.turn - heading)


class WalkPlan:
    """where the root is at each frame: an optional turn on the spot, then along the rounded path, easing in and out"""

    def __init__(self, start_frame, start_xz, start_heading, corners, speed, run=False):
        self.run = run
        accelerate, brake = (RUN_ACCELERATE, RUN_BRAKE) if run else (ACCELERATE, BRAKE)
        points = np.vstack([start_xz, corners])
        for _ in range(2):
            q = [points[0]]
            for a, b in zip(points[:-1], points[1:]):
                q += [a * 0.75 + b * 0.25, a * 0.25 + b * 0.75]
            q.append(points[-1])
            points = np.array(q)
        arc = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))]
        keep = np.r_[True, np.diff(arc) > 1e-6]
        points, arc = points[keep], arc[keep]
        total = arc[-1]

        along, d, v = [], 0.0, 0.0
        while d < total - 1e-3:
            v = min(min(speed, np.sqrt(2 * brake * (total - d))), v + accelerate / FPS)
            d = min(total, d + v / FPS)
            along.append(d)
        along = np.array(along if along else [total])

        def at(distance):
            return np.stack([np.interp(distance, arc, points[:, 0]), np.interp(distance, arc, points[:, 1])], axis=1)

        xz = at(along)
        tangent = at(np.minimum(along + 0.06, total)) - at(np.maximum(along - 0.06, 0.0))
        heading = np.unwrap(np.arctan2(tangent[:, 0], tangent[:, 1]))
        turn = wrap(heading[0] - start_heading)
        heading = heading - heading[0] + start_heading + turn

        turn_frames = 0
        if abs(turn) > TURN_FIRST:
            turn_frames = max(12, int(abs(turn) / TURN_SPEED * FPS))
            k = np.arange(1, turn_frames + 1) / turn_frames
            k = k * k * (3 - 2 * k)
            xz = np.vstack([np.repeat(np.asarray(start_xz)[None], turn_frames, axis=0), xz])
            heading = np.r_[start_heading + turn * k, heading]
        else:
            heading = heading - turn * np.clip(1.0 - np.arange(len(heading)) / 20.0, 0.0, 1.0)

        self.xz, self.heading = xz, heading
        self.start = start_frame
        self.end = start_frame + len(xz)
        self.turn_end = start_frame + turn_frames

    def at(self, frames):
        i = np.clip(np.asarray(frames) - self.start, 0, len(self.xz) - 1)
        return self.xz[i], self.heading[i]

    def prompt_at(self, frame):
        if frame < self.turn_end - 8:
            return 'motion_turn'
        left = self.end - frame
        if left > (RUN_STOP_FRAMES if self.run else STOP_FRAMES):
            return 'motion_run' if self.run else 'motion_walk'
        if left <= -10:
            return 'idle'
        return 'motion_run_stop' if self.run else 'motion_walk_stop'


class StagePlan:
    """a furniture routine: the root eases through places, headings and heights, with full-body keyframes where given"""

    def __init__(self, start_frame, start_xz, start_heading, start_y, steps, hold):
        xz, heading, height, self.prompts, self.keys = [], [], [], [], []
        x, z, h, y = float(start_xz[0]), float(start_xz[1]), float(start_heading), float(start_y)
        for step in steps:
            n = max(1, int(round(step['seconds'] * FPS)))
            k = np.clip(np.arange(1, n + 1) / max(1.0, n * 0.85), 0.0, 1.0)
            k = k * k * (3 - 2 * k)
            to_h = h + wrap(step['heading'] - h)
            xz.append(np.stack([x + (step['x'] - x) * k, z + (step['z'] - z) * k], axis=1))
            heading.append(h + (to_h - h) * k)
            height.append(y + (step['y'] - y) * k)
            self.prompts += [step['prompt']] * n
            self.keys += [step.get('pose') if i >= n - POSE_FRAMES else None for i in range(n)]
            x, z, h, y = step['x'], step['z'], to_h, step['y']
        self.xz, self.heading, self.height = np.vstack(xz), np.concatenate(heading), np.concatenate(height)
        self.start = start_frame
        self.length = len(self.prompts)
        self.hold = hold
        self.hold_prompt = self.prompts[-1]
        self.hold_pose = steps[-1].get('pose')
        self.end = float('inf') if hold else start_frame + self.length

    def at(self, frames):
        offset = np.asarray(frames) - self.start
        i = np.clip(offset, 0, self.length - 1)
        keys = [self.hold_pose if o >= self.length and self.hold else self.keys[j] for o, j in zip(offset, i)]
        return self.xz[i], self.heading[i], self.height[i], keys

    def prompt_at(self, frame):
        i = frame - self.start
        if i < self.length:
            return self.prompts[max(i, 0)]
        return self.hold_prompt if self.hold else 'idle'
