"""
Convert a Kimodo motion (BVH on the SOMA skeleton, exported with a T-pose rest) to a VRM animation (.vrma).

The game plays .vrma clips on any VRM avatar with @pixiv/three-vrm-animation. This script:
- reads the BVH and works out each joint's rotation in the world, relative to the T-pose,
- maps the SOMA joints onto VRM humanoid bones (a joint between two mapped bones, such as Neck2, is folded into
  the next bone),
- writes a glTF binary with the VRMC_vrm_animation extension: one node per bone, at rest in T-pose, and one
  rotation track per bone, plus the hips' movement.

Loops:
- `--loop walk` cuts one full stride (two steps) out of the middle of a walk and keeps it in place: the hips stay
  over the origin, so the game moves the person and plays the clip faster or slower to match.
- `--loop idle` keeps the person in place and blends the end back into the start.

Usage: python bvh_to_vrma.py input.bvh output.vrma [--loop walk|idle|none]
Needs only numpy.
"""
import argparse
import json
import math
import struct
import sys

import numpy as np

# SOMA joint -> VRM humanoid bone. Joints left out (Neck2, the eyes, the jaw, the first joint of each finger but
# the thumb, the finger ends) are folded into the next mapped bone.
SOMA_TO_VRM = {
    'Hips': 'hips', 'Spine1': 'spine', 'Spine2': 'chest', 'Chest': 'upperChest', 'Neck1': 'neck', 'Head': 'head',
    'LeftLeg': 'leftUpperLeg', 'LeftShin': 'leftLowerLeg', 'LeftFoot': 'leftFoot', 'LeftToeBase': 'leftToes',
    'RightLeg': 'rightUpperLeg', 'RightShin': 'rightLowerLeg', 'RightFoot': 'rightFoot', 'RightToeBase': 'rightToes',
}
for side, s in (('Left', 'left'), ('Right', 'right')):
    SOMA_TO_VRM.update({
        f'{side}Shoulder': f'{s}Shoulder', f'{side}Arm': f'{s}UpperArm', f'{side}ForeArm': f'{s}LowerArm',
        f'{side}Hand': f'{s}Hand',
        f'{side}HandThumb1': f'{s}ThumbMetacarpal', f'{side}HandThumb2': f'{s}ThumbProximal', f'{side}HandThumb3': f'{s}ThumbDistal',
    })
    for soma, vrm in (('Index', 'Index'), ('Middle', 'Middle'), ('Ring', 'Ring'), ('Pinky', 'Little')):
        SOMA_TO_VRM.update({
            f'{side}Hand{soma}2': f'{s}{vrm}Proximal', f'{side}Hand{soma}3': f'{s}{vrm}Intermediate',
            f'{side}Hand{soma}4': f'{s}{vrm}Distal',
        })


class Joint:
    def __init__(self, name, parent):
        self.name, self.parent = name, parent
        self.offset = np.zeros(3)
        self.channels = []
        self.children = []


def parse_bvh(path):
    with open(path, encoding='utf-8') as f:
        tokens = f.read().split()
    i = 0
    joints, stack = [], []

    def take():
        nonlocal i
        i += 1
        return tokens[i - 1]

    assert take() == 'HIERARCHY'
    while True:
        t = take()
        if t in ('ROOT', 'JOINT'):
            j = Joint(take(), stack[-1] if stack else None)
            if j.parent is not None:
                j.parent.children.append(j)
            joints.append(j)
            stack.append(j)
        elif t == 'End':
            take()  # Site
            assert take() == '{'
            take(); take(); take(); take()  # OFFSET x y z
            assert take() == '}'
        elif t == '{':
            pass
        elif t == '}':
            stack.pop()
        elif t == 'OFFSET':
            stack[-1].offset = np.array([float(take()) for _ in range(3)])
        elif t == 'CHANNELS':
            stack[-1].channels = [take() for _ in range(int(take()))]
        elif t == 'MOTION':
            break
    assert take() == 'Frames:'
    frames = int(take())
    assert take() == 'Frame' and take() == 'Time:'
    frame_time = float(take())
    n = sum(len(j.channels) for j in joints)
    data = np.array([float(x) for x in tokens[i:i + frames * n]]).reshape(frames, n)
    return joints, data, frame_time


def axis_rot(axis, deg):
    a = np.radians(deg)
    c, s = np.cos(a), np.sin(a)
    m = np.zeros(a.shape + (3, 3))
    m[..., 0, 0] = m[..., 1, 1] = m[..., 2, 2] = 1
    k = {'X': (1, 2), 'Y': (2, 0), 'Z': (0, 1)}[axis]
    m[..., k[0], k[0]] = c
    m[..., k[1], k[1]] = c
    m[..., k[0], k[1]] = -s
    m[..., k[1], k[0]] = s
    return m


def world_motion(joints, data):
    """per joint: world rotation [F,3,3] and world position [F,3] (BVH units), and rest world positions"""
    F = data.shape[0]
    col = 0
    rot, pos, rest = {}, {}, {}
    for j in joints:
        local = np.broadcast_to(np.eye(3), (F, 3, 3)).copy()
        trans = np.broadcast_to(j.offset, (F, 3)).copy()
        for ch in j.channels:
            v = data[:, col]
            col += 1
            if ch.endswith('rotation'):
                local = local @ axis_rot(ch[0], v)
            else:
                trans[:, 'XYZ'.index(ch[0])] = v
        if j.parent is None:
            rot[j.name], pos[j.name] = local, trans
            rest[j.name] = j.offset.copy()
        else:
            pr = rot[j.parent.name]
            rot[j.name] = pr @ local
            # position channels (the hips under the Root joint) replace the offset
            pos[j.name] = pos[j.parent.name] + np.einsum('fij,fj->fi', pr, trans)
            rest[j.name] = rest[j.parent.name] + j.offset
    return rot, pos, rest


def mat_to_quat(m):
    """rotation matrices [...,3,3] to quaternions [...,4] (x, y, z, w)"""
    m = np.asarray(m)
    q = np.empty(m.shape[:-2] + (4,))
    tr = m[..., 0, 0] + m[..., 1, 1] + m[..., 2, 2]
    for idx in np.ndindex(m.shape[:-2]):
        a = m[idx]
        t = tr[idx]
        if t > 0:
            s = math.sqrt(t + 1.0) * 2
            q[idx] = [(a[2, 1] - a[1, 2]) / s, (a[0, 2] - a[2, 0]) / s, (a[1, 0] - a[0, 1]) / s, 0.25 * s]
        elif a[0, 0] > a[1, 1] and a[0, 0] > a[2, 2]:
            s = math.sqrt(1.0 + a[0, 0] - a[1, 1] - a[2, 2]) * 2
            q[idx] = [0.25 * s, (a[0, 1] + a[1, 0]) / s, (a[0, 2] + a[2, 0]) / s, (a[2, 1] - a[1, 2]) / s]
        elif a[1, 1] > a[2, 2]:
            s = math.sqrt(1.0 + a[1, 1] - a[0, 0] - a[2, 2]) * 2
            q[idx] = [(a[0, 1] + a[1, 0]) / s, 0.25 * s, (a[1, 2] + a[2, 1]) / s, (a[0, 2] - a[2, 0]) / s]
        else:
            s = math.sqrt(1.0 + a[2, 2] - a[0, 0] - a[1, 1]) * 2
            q[idx] = [(a[0, 2] + a[2, 0]) / s, (a[1, 2] + a[2, 1]) / s, 0.25 * s, (a[1, 0] - a[0, 1]) / s]
    # keep neighbouring frames on the same side, so interpolation takes the short way
    flat = q.reshape(-1, 4)
    for k in range(1, len(flat)):
        if np.dot(flat[k], flat[k - 1]) < 0:
            flat[k] = -flat[k]
    return q


def slerp(a, b, t):
    d = np.dot(a, b)
    if d < 0:
        b, d = -b, -d
    if d > 0.9995:
        r = a + (b - a) * t
        return r / np.linalg.norm(r)
    th = math.acos(d)
    return (math.sin((1 - t) * th) * a + math.sin(t * th) * b) / math.sin(th)


def build(joints, data, frame_time, loop):
    rot, pos, rest = world_motion(joints, data)
    names = [j.name for j in joints]
    unit = 0.01  # Kimodo writes centimetres

    # which way the character faces in the BVH: VRM wants its left along +X (and so its face along +Z)
    left = rest['LeftLeg'] - rest['RightLeg']
    turn = np.eye(3) if left[0] > 0 else np.diag([-1.0, 1.0, -1.0])  # half a turn about Y

    # the mapped bones, each with its nearest mapped ancestor
    by_name = {j.name: j for j in joints}
    bones = [n for n in names if n in SOMA_TO_VRM]

    def mapped_parent(n):
        p = by_name[n].parent
        while p is not None and p.name not in SOMA_TO_VRM:
            p = p.parent
        return p.name if p is not None else None

    parents = {n: mapped_parent(n) for n in bones}
    F = data.shape[0]
    # world rotations relative to the T-pose, in VRM's axes
    W = {n: turn @ rot[n] @ turn.T for n in bones}
    hips = np.einsum('ij,fj->fi', turn, pos['Hips']) * unit

    # loop range
    lo, hi = 0, F
    if loop == 'walk':
        # one stride: between two moments the left foot passes the right one going forward (in the hips' frame)
        lf = np.einsum('ij,fj->fi', turn, pos['LeftFoot']) * unit
        rf = np.einsum('ij,fj->fi', turn, pos['RightFoot']) * unit
        head = W['Hips'][:, :, 2].copy()  # the hips' forward direction
        head[:, 1] = 0
        head /= np.linalg.norm(head, axis=1, keepdims=True)
        sig = np.einsum('fi,fi->f', lf - rf, head)
        up = [k for k in range(1, F) if sig[k - 1] < 0 <= sig[k]]
        if len(up) < 3:
            sys.exit(f'walk: found only {len(up)} strides; generate a longer walk')
        mid = len(up) // 2
        lo, hi = up[mid - 1], up[mid]
    frames = np.arange(lo, hi + (1 if loop == 'walk' else 0))
    n = len(frames)

    # the walk's speed (metres per second) along the ground, for matching the playback rate to the walker
    travel = hips[frames[-1]] - hips[frames[0]]
    speed = float(np.hypot(travel[0], travel[2]) / ((n - 1) * frame_time)) if n > 1 else 0.0

    # in place: take out the movement over the ground (and the turn of the whole body, for a walk)
    hip_track = hips[frames].copy()
    if loop in ('walk', 'idle'):
        t = np.linspace(0, 1, n)[:, None]
        hip_track[:, [0, 2]] -= (hip_track[0, [0, 2]] + (hip_track[-1, [0, 2]] - hip_track[0, [0, 2]]) * t)
    if loop == 'walk':
        # face along +Z throughout: undo the hips' average heading
        fwd = travel / (np.linalg.norm(travel) + 1e-9)
        yaw = math.atan2(fwd[0], fwd[2])
        c, s = math.cos(-yaw), math.sin(-yaw)
        ry = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
        W = {k: ry @ v for k, v in W.items()}
        hip_track = hip_track @ ry.T
    if loop:
        hip_track[:, [0, 2]] -= hip_track[:, [0, 2]].mean(axis=0)

    local = {}
    for b in bones:
        w = W[b][frames]
        p = parents[b]
        local[b] = mat_to_quat(w if p is None else np.swapaxes(W[p][frames], 1, 2) @ w)

    if loop == 'idle':
        # blend the last half second back into the first frame
        k = min(n // 3, int(round(0.5 / frame_time)))
        for b in bones:
            for i in range(k):
                u = (i + 1) / k
                local[b][n - k + i] = slerp(local[b][n - k + i], local[b][0], u * u * (3 - 2 * u))
        for i in range(k):
            u = (i + 1) / k
            e = u * u * (3 - 2 * u)
            hip_track[n - k + i] = hip_track[n - k + i] * (1 - e) + hip_track[0] * e
    if loop == 'walk':
        # the last frame is the next stride's first: make it match exactly
        for b in bones:
            local[b][-1] = local[b][0] if np.dot(local[b][-1], local[b][0]) >= 0 else -local[b][0]

    rest_m = {b: turn @ rest[b] * unit for b in bones}
    return {
        'bones': bones, 'parents': parents, 'rest': rest_m, 'local': local, 'hips': hip_track,
        'times': np.arange(n) * frame_time, 'speed': speed,
    }


def write_vrma(clip, out, name, meta):
    bones, parents, rest = clip['bones'], clip['parents'], clip['rest']
    index = {b: i for i, b in enumerate(bones)}
    blob = bytearray()
    views, accessors = [], []

    def add(arr, typ, minmax=False):
        arr = np.ascontiguousarray(arr, dtype=np.float32)
        while len(blob) % 4:
            blob.append(0)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': arr.nbytes})
        blob.extend(arr.tobytes())
        acc = {'bufferView': len(views) - 1, 'componentType': 5126, 'count': len(arr), 'type': typ}
        if minmax:
            acc['min'] = arr.min(axis=0).tolist() if arr.ndim > 1 else [float(arr.min())]
            acc['max'] = arr.max(axis=0).tolist() if arr.ndim > 1 else [float(arr.max())]
        accessors.append(acc)
        return len(accessors) - 1

    nodes = []
    for b in bones:
        p = parents[b]
        t = rest[b] - (rest[p] if p else 0)
        node = {'name': SOMA_TO_VRM[b], 'translation': [float(x) for x in t]}
        kids = [index[c] for c in bones if parents[c] == b]
        if kids:
            node['children'] = kids
        nodes.append(node)
    time = add(clip['times'], 'SCALAR', minmax=True)
    samplers, channels = [], []
    for b in bones:
        samplers.append({'input': time, 'output': add(clip['local'][b], 'VEC4'), 'interpolation': 'LINEAR'})
        channels.append({'sampler': len(samplers) - 1, 'target': {'node': index[b], 'path': 'rotation'}})
    samplers.append({'input': time, 'output': add(clip['hips'], 'VEC3'), 'interpolation': 'LINEAR'})
    channels.append({'sampler': len(samplers) - 1, 'target': {'node': index['Hips'], 'path': 'translation'}})
    gltf = {
        'asset': {'version': '2.0', 'generator': 'airi-v3d-game tools/kimodo/bvh_to_vrma.py'},
        'extensionsUsed': ['VRMC_vrm_animation'],
        'extensions': {'VRMC_vrm_animation': {
            'specVersion': '1.0',
            'humanoid': {'humanBones': {SOMA_TO_VRM[b]: {'node': index[b]} for b in bones}},
        }},
        'scene': 0,
        'scenes': [{'nodes': [index['Hips']]}],
        'nodes': nodes,
        'animations': [{'name': name, 'samplers': samplers, 'channels': channels, 'extras': meta}],
        'buffers': [{'byteLength': len(blob)}],
        'bufferViews': views,
        'accessors': accessors,
    }
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    while len(blob) % 4:
        blob.append(0)
    with open(out, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
        f.write(struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('bvh')
    ap.add_argument('out')
    ap.add_argument('--loop', choices=['walk', 'idle', 'none'], default='none')
    ap.add_argument('--name', default='')
    ap.add_argument('--prompt', default='')
    a = ap.parse_args()
    joints, data, ft = parse_bvh(a.bvh)
    clip = build(joints, data, ft, None if a.loop == 'none' else a.loop)
    meta = {'loop': a.loop, 'speed': round(clip['speed'], 4), 'prompt': a.prompt, 'source': 'Kimodo (nv-tlabs/kimodo)'}
    write_vrma(clip, a.out, a.name or a.loop, meta)
    print(f'{a.out}: {len(clip["times"])} frames, {clip["times"][-1]:.2f} s, speed {clip["speed"]:.2f} m/s')


if __name__ == '__main__':
    main()
