"""Build the outdoor surroundings for airi-v3d-game in Blender: yard, fence, path, trees, hills.

Run from the repository root:

    blender -b --factory-startup -P tools/blender/build_outdoor.py -- --repo .

Outputs:
    public/models/outdoor.glb   the scenery for three.js (GLTFLoader), loaded next to room.glb
    src/yard-layout.json        the yard rectangle, the door, what blocks walking and the outdoor activities
    assets/outdoor.blend        the same scene, for editing in Blender

Coordinates are the same as build_room.py: game (three.js) x right, y up, z toward the camera, the room
spans x -5..5 and z -4..4. Blender is z-up, so a game point (gx, gz) at height h is Blender (gx, -gz, h).

Everything is flat-shaded low poly with a handful of plain materials, merged into one mesh per material,
so the whole scenery is a few draw calls. The scenery stays outside the room's footprint, and the fence and
the stepping stones leave the door on the right wall (x = 5, z = 3) free, so nothing here touches pathfinding.
"""

import bpy
import bmesh
import json
import math
import os
import random
import sys
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
REPO = os.path.abspath(argv[argv.index('--repo') + 1] if '--repo' in argv else '.')

# start from an empty scene (keeps add-ons and preferences, unlike read_factory_settings)
bpy.ops.wm.read_homefile(use_empty=True)
scene = bpy.context.scene
scene.name = 'Outdoor'
coll = bpy.data.collections.new('Outdoor')
scene.collection.children.link(coll)


def P(gx, gz, h=0.0):
    """game ground position -> Blender vector"""
    return Vector((gx, -gz, h))


def lin(c):
    """sRGB 0..1 -> linear, glTF stores linear base colours"""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexcolor(h):
    r, g, b = ((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255
    return (lin(r), lin(g), lin(b), 1.0)


PALETTE = {
    'grass_far':   0x5f9a55,
    'grass_yard':  0x7cbc62,
    'path':        0xc9bfa5,
    'foundation':  0x8d8a84,
    'fence':       0xe9e0c8,
    'trunk':       0x70503a,
    'leaf_a':      0x3f8f4b,
    'leaf_b':      0x58ab55,
    'leaf_c':      0x7fb94f,
    'pine':        0x2c6e4f,
    'hill_a':      0x6f9f7a,
    'hill_b':      0x86ae8c,
    'rock':        0x9c9a98,
    'soil':        0x6b4a34,
    'veg':         0x4f9d3a,
    'flower_pink': 0xf08fb0,
    'flower_yel':  0xf5d04a,
    'flower_wht':  0xf6f3ea,
    'mail_red':    0xc8432f,
    'wood':        0xb98756,
}

materials = {}
for name, hx in PALETTE.items():
    m = bpy.data.materials.new('out_' + name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = hexcolor(hx)
    bsdf.inputs['Roughness'].default_value = 0.95
    bsdf.inputs['Metallic'].default_value = 0.0
    materials[name] = m


class Batch:
    """flat-shaded geometry for one material, built as one bmesh"""

    def __init__(self, mat):
        self.mat = mat
        self.bm = bmesh.new()

    def poly(self, pts):
        vs = [self.bm.verts.new(p) for p in pts]
        try:
            self.bm.faces.new(vs)
        except ValueError:
            pass  # duplicate face

    def box(self, c, size, rot=0.0):
        """axis-aligned box centred on Blender point c, size (x, y, z), turned about z by rot"""
        sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
        R = Matrix.Rotation(rot, 3, 'Z')
        v = [c + R @ Vector((x * sx, y * sy, z * sz)) for z in (-1, 1) for y in (-1, 1) for x in (-1, 1)]
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self.poly([v[i] for i in q])

    def frustum(self, c, r_bottom, r_top, h, sides=7, rot=0.0):
        """cylinder or cone standing on Blender point c, base at c.z"""
        ang = [rot + i * 2 * math.pi / sides for i in range(sides)]
        bot = [c + Vector((math.cos(a) * r_bottom, math.sin(a) * r_bottom, 0)) for a in ang]
        top = [c + Vector((math.cos(a) * r_top, math.sin(a) * r_top, h)) for a in ang]
        for i in range(sides):
            j = (i + 1) % sides
            if r_top < 1e-4:
                self.poly([bot[i], bot[j], c + Vector((0, 0, h))])
            else:
                self.poly([bot[i], bot[j], top[j], top[i]])
        self.poly(list(reversed(bot)))
        if r_top >= 1e-4:
            self.poly(top)

    def blob(self, c, radii, rot=0.0, jitter=0.0, rng=None):
        """low-poly ball: an icosahedron with every edge split once (80 triangles), squashed to radii"""
        t = (1 + 5 ** 0.5) / 2
        base = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
                (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
        faces = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2),
                 (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5),
                 (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
        pts = [Vector(p).normalized() for p in base]
        cache = {}

        def mid(a, b):
            k = (min(a, b), max(a, b))
            if k not in cache:
                pts.append(((pts[a] + pts[b]) / 2).normalized())
                cache[k] = len(pts) - 1
            return cache[k]

        tris = []
        for a, b, d in faces:
            ab, bd, da = mid(a, b), mid(b, d), mid(d, a)
            tris += [(a, ab, da), (b, bd, ab), (d, da, bd), (ab, bd, da)]
        R = Matrix.Rotation(rot, 3, 'Z')
        out = []
        for p in pts:
            q = Vector((p.x * radii[0], p.y * radii[1], p.z * radii[2]))
            if jitter and rng:
                q *= 1 + rng.uniform(-jitter, jitter)
            out.append(c + R @ q)
        for a, b, d in tris:
            self.poly([out[a], out[b], out[d]])

    def build(self, name):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        me.materials.append(self.mat)
        for p in me.polygons:
            p.use_smooth = False
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        return ob


B = {k: Batch(m) for k, m in materials.items()}
rng = random.Random(7)

# ---- exclusion zone: the yard, inside the fence ----
FX, FZ0, FZ1 = 11.0, -9.5, 9.0  # fence: x -11..11, z -9.5..9
DOOR_Z = 3.0                    # the door is on the right wall (x = 5) at z = 3
GATE = 1.3                      # half width of the gap in the right-hand fence


def in_yard(x, z, margin=0.0):
    return abs(x) < FX + margin and FZ0 - margin < z < FZ1 + margin


# what the game needs to know: obstacles to walk around and the places agents can use (game coordinates)
OBSTACLES = []
OBJECTS = []


def obstacle(cx, cz, w, d):
    OBSTACLES.append({'cx': round(cx, 3), 'cz': round(cz, 3), 'w': round(w, 3), 'd': round(d, 3)})


def r3(v):
    return round(v, 3)


# ---- ground ----
# foundation under the room, walls start at z = 0 and the floor slab ends at -0.1
B['foundation'].box(P(0, 0, -0.17), (10.5, 8.5, 0.30))
# far ground, a disc well past the hills' feet
B['grass_far'].frustum(P(0, 0, -0.20), 90, 90, 0.02, sides=48)
# the mown yard, a slightly raised and squarer disc
yard_pts = []
for i in range(40):
    a = i * 2 * math.pi / 40
    rx, rz = 16.5, 14.0
    yard_pts.append(P(math.cos(a) * rx * (1 + 0.04 * math.sin(a * 5)), math.sin(a) * rz * (1 + 0.04 * math.cos(a * 3)), -0.16))
B['grass_yard'].poly(list(reversed(yard_pts)))

# ---- patio and stepping stones from the door ----
# starts at the edge of the foundation (x = 5.25) so the two tops, both at -0.02, do not overlap and flicker
B['path'].box(P(6.075, DOOR_Z, -0.10), (1.65, 2.0, 0.16))
x = 7.4
n = 0
while x < 30:
    z = DOOR_Z + 1.1 * math.sin((x - 7.4) * 0.28)
    B['path'].frustum(P(x, z, -0.17), 0.55 + rng.uniform(-0.06, 0.08), 0.5, 0.1, sides=8, rot=rng.uniform(0, 1))
    x += 0.95 + rng.uniform(-0.1, 0.15)
    n += 1

# ---- fence around the yard, with a gate gap on the right ----
post_h, rail_h = 0.95, (0.35, 0.7)


def fence_run(a, b, skip=None):
    """posts every ~1.2 m between two game points, two rails between them"""
    ax, az = a
    bx, bz = b
    length = math.hypot(bx - ax, bz - az)
    cnt = max(1, round(length / 1.2))
    ang = -math.atan2(bz - az, bx - ax)  # game z is Blender -y
    pts = [(ax + (bx - ax) * i / cnt, az + (bz - az) * i / cnt) for i in range(cnt + 1)]
    for px, pz in pts:
        if skip and skip(px, pz):
            continue
        B['fence'].box(P(px, pz, post_h / 2 - 0.19), (0.12, 0.12, post_h), ang)
    for i in range(cnt):
        (x0, z0), (x1, z1) = pts[i], pts[i + 1]
        mx, mz = (x0 + x1) / 2, (z0 + z1) / 2
        if skip and skip(mx, mz):
            continue
        for rh in rail_h:
            B['fence'].box(P(mx, mz, rh - 0.19), (length / cnt, 0.05, 0.09), ang)


fence_run((-FX, FZ0), (FX, FZ0))
fence_run((-FX, FZ1), (FX, FZ1))
fence_run((-FX, FZ0), (-FX, FZ1))
fence_run((FX, FZ0), (FX, FZ1), skip=lambda x, z: abs(z - DOOR_Z) < GATE + 0.6)
for sz in (-1, 1):  # gate posts, a little taller
    B['fence'].box(P(FX, DOOR_Z + sz * (GATE + 0.05), 0.55 - 0.19), (0.2, 0.2, 1.3))

# ---- trees ----
placed = []


def free_spot(x, z, r):
    return all((x - px) ** 2 + (z - pz) ** 2 > (r + pr) ** 2 for px, pz, pr in placed)


def round_tree(x, z, s):
    B['trunk'].frustum(P(x, z, -0.2), 0.16 * s, 0.11 * s, 1.5 * s, sides=6, rot=rng.uniform(0, 1))
    leaf = rng.choice(['leaf_a', 'leaf_b', 'leaf_c'])
    B[leaf].blob(P(x, z, 2.3 * s), (1.35 * s, 1.35 * s, 1.15 * s), rot=rng.uniform(0, 3), jitter=0.12, rng=rng)
    B[leaf].blob(P(x + rng.uniform(-0.5, 0.5) * s, z + rng.uniform(-0.5, 0.5) * s, 3.1 * s),
                 (0.95 * s, 0.95 * s, 0.85 * s), rot=rng.uniform(0, 3), jitter=0.12, rng=rng)


def pine_tree(x, z, s):
    B['trunk'].frustum(P(x, z, -0.2), 0.14 * s, 0.1 * s, 1.0 * s, sides=6)
    for k, (r, h, y0) in enumerate(((1.35, 1.6, 0.7), (1.05, 1.5, 1.7), (0.72, 1.4, 2.6))):
        B['pine'].frustum(P(x, z, y0 * s), r * s, 0.0, h * s, sides=7, rot=rng.uniform(0, 1))


# two trees in the back corners of the yard, the rest of the forest outside the fence
for x, z, kind in ((-8.6, -7.4, 'round'), (8.2, -7.8, 'round'), (-9.2, 6.0, 'pine')):
    (round_tree if kind == 'round' else pine_tree)(x, z, rng.uniform(0.95, 1.15))
    placed.append((x, z, 2.2))
    obstacle(x, z, 0.6, 0.6)  # the trunk

tries = 0
count = 0
while count < 90 and tries < 6000:
    tries += 1
    # denser near the yard, thinning out with distance
    d = rng.uniform(0, 1) ** 1.6
    x = rng.uniform(-48, 48)
    z = rng.uniform(-48, 44)
    if in_yard(x, z, 1.8):
        continue
    # keep the straight-on view from the windows and the path to the door a little open
    if abs(z - DOOR_Z) < 2.2 and x > 0:
        continue
    if rng.random() > 0.9 - 0.8 * (math.hypot(x, z) / 62):
        continue
    s = rng.uniform(0.8, 1.55)
    r = 1.3 * s
    if not free_spot(x, z, r):
        continue
    (round_tree if rng.random() < 0.55 else pine_tree)(x, z, s)
    placed.append((x, z, r))
    count += 1
print('trees:', count + 3)

# ---- bushes and flowers along the walls (below the window sills) ----
flower_mats = ['flower_pink', 'flower_yel', 'flower_wht']
bushes = [(-4.2, -4.55), (-0.2, -4.6), (2.9, -4.55), (4.4, -4.6), (-5.7, -2.4), (-5.65, 1.6), (-5.6, 3.5),
          (2.0, 4.65), (-3.0, 4.6), (5.65, -1.6)]
for bx, bz in bushes:
    sz = rng.uniform(0.38, 0.52)
    obstacle(bx, bz, 1.3, 1.1)
    B[rng.choice(['leaf_a', 'leaf_b'])].blob(P(bx, bz, sz * 0.8 - 0.1), (0.62, 0.5, sz), rot=rng.uniform(0, 3), jitter=0.1, rng=rng)
    fm = rng.choice(flower_mats)
    for _ in range(5):
        fx, fz = bx + rng.uniform(-0.45, 0.45), bz + rng.uniform(-0.35, 0.35)
        B[fm].blob(P(fx, fz, sz * 1.5 - 0.15), (0.07, 0.07, 0.07))

# ---- small props: rocks, mailbox, bench, vegetable patch ----
BENCH = (-1.5, -6.6)    # faces the house
PATCH = (-8.0, 1.5)
MAILBOX = (FX - 0.9, DOOR_Z + 2.6)  # just inside the fence beside the gate
FLOWERS = bushes[8]     # the bush south of the house, flowers on its far side
KEEP_CLEAR = [(BENCH[0], BENCH[1], 2.0), (PATCH[0], PATCH[1], 2.4), (MAILBOX[0], MAILBOX[1], 1.4),
              (FLOWERS[0], FLOWERS[1] + 0.9, 1.4), (7.5, 0.5, 1.2)] + [(p[0], p[1], 1.3) for p in placed[:3]]
for _ in range(14):
    x, z = rng.uniform(-14, 14), rng.uniform(-11, 12)
    if abs(x) < 6.2 and abs(z) < 5.2 or abs(z - DOOR_Z) < 1.8 and x > 5:
        continue
    if any((x - kx) ** 2 + (z - kz) ** 2 < kr * kr for kx, kz, kr in KEEP_CLEAR):
        continue
    s = rng.uniform(0.18, 0.42)
    B['rock'].blob(P(x, z, s * 0.4 - 0.18), (s, s * 0.85, s * 0.6), rot=rng.uniform(0, 3), jitter=0.18, rng=rng)
    if in_yard(x, z) and s >= 0.25:
        obstacle(x, z, 2.1 * s, 2.1 * s)

mx, mz = MAILBOX
B['wood'].box(P(mx, mz, 0.55 - 0.19), (0.1, 0.1, 1.1))
B['mail_red'].box(P(mx, mz, 1.2 - 0.19), (0.5, 0.26, 0.28))
obstacle(mx, mz, 0.5, 0.3)

# the bench seat is 0.46 m above the room floor, the height the avatar's sitting pose expects (src/avatar.ts)
bx0, bz0 = BENCH
B['wood'].box(P(bx0, bz0, 0.43), (1.5, 0.45, 0.07))
B['wood'].box(P(bx0, bz0 - 0.2, 0.76), (1.5, 0.07, 0.4))
for dx in (-0.65, 0.65):
    B['wood'].box(P(bx0 + dx, bz0, 0.115), (0.08, 0.4, 0.57))
obstacle(bx0, bz0, 1.5, 0.5)

vx, vz = PATCH                     # vegetable patch on the left side
B['soil'].box(P(vx, vz, -0.1), (2.6, 1.8, 0.2))
for i in range(4):
    for j in range(3):
        B['veg'].blob(P(vx - 0.9 + i * 0.6, vz - 0.6 + j * 0.6, 0.12), (0.2, 0.2, 0.18), rot=rng.uniform(0, 3))
obstacle(vx, vz, 2.6, 1.8)

# ---- what agents can do outside (game coordinates; see room-layout.json for the indoor ones) ----
# `hours` limits an activity to part of the day [from, to) and may wrap past midnight.


def aff(verb, duration, effects, pose='stand', hours=None):
    a = {'verb': verb, 'duration': duration, 'effects': effects, 'pose': pose}
    if hours:
        a['hours'] = hours
    return a


def place_obj(id, kind, pos, use, affs, approach=None):
    o = {'id': id, 'kind': kind, 'outdoors': True, 'pos': {'x': r3(pos[0]), 'z': r3(pos[1])},
         'usePos': {'x': r3(use[0]), 'z': r3(use[1])}, 'affordances': affs}
    if approach:
        o['approach'] = {'x': r3(approach[0]), 'z': r3(approach[1])}
    OBJECTS.append(o)


DAY = [7, 19]
# bench: two seats side by side. Hips sit on the seat, the use point is SIT_FORWARD (0.12 m) in front of them.
for k, sx_ in enumerate((-0.4, 0.4), 1):
    hx = bx0 + sx_
    place_obj(f'bench_seat_{k}', 'garden bench seat', (hx, bz0 + 1.1), (hx, bz0 + 0.12),
              [aff('relax', 45, {'fun': 18, 'energy': 8}, 'sit', DAY),
               aff('read', 60, {'knowledge': 22, 'fun': 8, 'energy': -2}, 'sit', DAY)],
              approach=(hx, bz0 + 0.225 + 0.5))
place_obj('garden', 'vegetable garden', (vx, vz), (vx, vz + 0.9 + 0.4),
          [aff('tend_garden', 40, {'fun': 12, 'knowledge': 6, 'energy': -6}, 'stand', DAY)])
place_obj('mailbox', 'mailbox', (mx, mz), (mx - 0.7, mz),
          [aff('check_mail', 10, {'fun': 6, 'knowledge': 3}, 'stand', [8, 20])])
place_obj('flower_bush', 'flowering bush', FLOWERS, (FLOWERS[0], FLOWERS[1] + 0.55 + 0.45),
          [aff('admire_flowers', 12, {'fun': 10}, 'stand', DAY)])
place_obj('lawn', 'lawn', (7.5, -3.0), (7.5, 0.5),
          [aff('enjoy_fresh_air', 25, {'fun': 10, 'energy': -2}, 'stand', DAY),
           aff('stargaze', 40, {'fun': 18, 'energy': 3}, 'stand', [20, 5])])

# ---- distant hills, a ring that fades into the fog ----
for i in range(18):
    a = i * 2 * math.pi / 18 + rng.uniform(-0.1, 0.1)
    dist = rng.uniform(62, 76)
    w = rng.uniform(13, 22)
    h = rng.uniform(5, 11)
    B[rng.choice(['hill_a', 'hill_b'])].blob(P(math.cos(a) * dist, math.sin(a) * dist, -h * 0.25), (w, w * rng.uniform(0.8, 1.1), h),
                                            rot=rng.uniform(0, 3), jitter=0.08, rng=rng)

# ---- build objects ----
objs = []
for k, b in B.items():
    if len(b.bm.faces):
        objs.append(b.build('OUT_' + k))
    else:
        b.bm.free()

tris = sum(len(o.data.polygons) for o in objs)
print('meshes:', len(objs))

# ---- export ----
out_glb = os.path.join(REPO, 'public', 'models', 'outdoor.glb')
os.makedirs(os.path.dirname(out_glb), exist_ok=True)
for o in bpy.data.objects:
    o.select_set(o in objs)
bpy.context.view_layer.objects.active = objs[0]
# the override keeps the export working when the script is run from a live Blender session (blender-mcp)
wins = bpy.context.window_manager.windows
override = dict(window=wins[0]) if wins else {}
with bpy.context.temp_override(**override, scene=scene, view_layer=bpy.context.view_layer,
                               active_object=objs[0], selected_objects=objs):
    bpy.ops.export_scene.gltf(filepath=out_glb, use_selection=True, export_format='GLB', export_yup=True,
                              export_apply=True, export_cameras=False, export_lights=False)
print('exported', out_glb, os.path.getsize(out_glb) // 1024, 'KB')

yard = {
    'about': 'Generated by tools/blender/build_outdoor.py. Game coordinates (three.js): x right, y up, z toward '
             'the camera. Agents stay inside the fence; the only way in and out of the house is the door.',
    'yard': {'x0': -FX, 'x1': FX, 'z0': FZ0, 'z1': FZ1},
    'door': {'x': 5.0, 'z': DOOR_Z, 'halfWidth': 0.25},
    'obstacles': OBSTACLES,
    'objects': OBJECTS,
}
with open(os.path.join(REPO, 'src', 'yard-layout.json'), 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(yard, fh, indent=2, ensure_ascii=False)
    fh.write('\n')

os.makedirs(os.path.join(REPO, 'assets'), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(REPO, 'assets', 'outdoor.blend'), copy=True)
tri_count = 0
for o in objs:
    me = o.data
    me.calc_loop_triangles()
    tri_count += len(me.loop_triangles)
print('triangles:', tri_count)
