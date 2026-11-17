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
Beyond the gate in the fence a path leads to a meadow with a pond, a bench and a campfire.
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
    'water':       0x5aa6d6,
    'flame':       0xf59a2f,
    'ember':       0xd9552b,
    'duck':        0xfaf7ef,
    'beak':        0xf2b134,
    'canvas':      0xecdcb4,
    'canvas_south': 0xecdcb4,  # the side that faces the default camera; the game draws it see-through
    'canvas_acc':  0xc9694c,
    'tent_floor':  0x9b8b6a,
    'lantern':     0xffd27a,
    'blanket_a':   0x4f8f98,
    'blanket_b':   0xe08a78,
    'pillow':      0xf4efe6,
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
# the meadow beyond the gate, and the area agents may walk in: the yard plus a strip east of the fence
MEADOW = (23.3, 1.3, 8.0)       # centre x, z and radius of the grassy clearing
LAKE = (21.0, 6.5, 5.0, 3.6)    # centre x, z and the two radii (x, z): too deep to wade, a place to swim and fish
PIER = (23.0, 3.0, 6.8, 1.6)    # centre x, where it starts on land (z), where it ends in the water (z), width
BENCH2 = (22.0, 1.4)            # faces the lake (+z)
FIRE = (27.6, -1.2)
TENT = (29.0, 2.6)             # ridge along x, open at the west end, closed at the east end
# z0 puts a navigation cell centre exactly on the door line (z = 3), the doorway is only two cells wide
AREA = {'x0': -FX, 'x1': 31.0, 'z0': -11.5, 'z1': 12.5}


def in_yard(x, z, margin=0.0):
    return abs(x) < FX + margin and FZ0 - margin < z < FZ1 + margin


# what the game needs to know: obstacles to walk around and the places agents can use (game coordinates)
OBSTACLES = []
OBJECTS = []


def obstacle(cx, cz, w, d):
    OBSTACLES.append({'cx': round(cx, 3), 'cz': round(cz, 3), 'w': round(w, 3), 'd': round(d, 3)})


def r3(v):
    return round(v, 3)


def patch(batch, cx, cz, rx, rz, h, n=36, wobble=0.04):
    """a flat, slightly irregular ellipse on the ground at height h"""
    pts = []
    for i in range(n):
        a = i * 2 * math.pi / n
        pts.append(P(cx + math.cos(a) * rx * (1 + wobble * math.sin(a * 5)), cz + math.sin(a) * rz * (1 + wobble * math.cos(a * 3)), h))
    batch.poly(list(reversed(pts)))


def slab(batch, corners, t):
    """a thin panel through four corners (Blender points), t thick, for canvas"""
    a, b, c, d = corners
    n = (b - a).cross(d - a).normalized() * (t / 2)
    lo = [q - n for q in corners]
    hi = [q + n for q in corners]
    for q in ((lo[0], lo[1], lo[2], lo[3]), (hi[3], hi[2], hi[1], hi[0]), (lo[0], hi[0], hi[1], lo[1]),
              (lo[1], hi[1], hi[2], lo[2]), (lo[2], hi[2], hi[3], lo[3]), (lo[3], hi[3], hi[0], lo[0])):
        batch.poly(list(q))


def prism(batch, tri, dx):
    """a triangle (three Blender points in a plane of constant x) extruded dx along x"""
    a = [Vector(q) for q in tri]
    b = [q + Vector((dx, 0, 0)) for q in a]
    batch.poly(a)
    batch.poly(list(reversed(b)))
    for i in range(3):
        j = (i + 1) % 3
        batch.poly([a[i], a[j], b[j], b[i]])


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
while x < 16.5:
    z = DOOR_Z + 1.1 * math.sin((x - 7.4) * 0.28)
    B['path'].frustum(P(x, z, -0.17), 0.55 + rng.uniform(-0.06, 0.08), 0.5, 0.1, sides=8, rot=rng.uniform(0, 1))
    x += 0.95 + rng.uniform(-0.1, 0.15)
    n += 1

# ---- the meadow: a lighter clearing with a lake (its surface is 2 cm above the clearing, which is 2 cm
# above the yard it overlaps, so no two flat faces share a height) ----
patch(B['grass_yard'], MEADOW[0], MEADOW[1], MEADOW[2], MEADOW[2] * 1.15, -0.14)
patch(B['water'], LAKE[0], LAKE[1], LAKE[2], LAKE[3], -0.12, n=44, wobble=0.0)

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
    if (x - MEADOW[0]) ** 2 + (z - MEADOW[1]) ** 2 < (MEADOW[2] * 1.15 + 1.5) ** 2:
        continue
    if rng.random() > 0.9 - 0.8 * (math.hypot(x, z) / 62):
        continue
    s = rng.uniform(0.8, 1.55)
    r = 1.3 * s
    if not free_spot(x, z, r):
        continue
    (round_tree if rng.random() < 0.55 else pine_tree)(x, z, s)
    placed.append((x, z, r))
    if FX < x < AREA['x1'] - 0.5 and AREA['z0'] + 0.5 < z < AREA['z1'] - 0.5:
        obstacle(x, z, 0.6, 0.6)  # the trunk, in the strip east of the fence
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


def bench(bx, bz):
    B['wood'].box(P(bx, bz, 0.43), (1.5, 0.45, 0.07))
    B['wood'].box(P(bx, bz - 0.2, 0.76), (1.5, 0.07, 0.4))
    for dx in (-0.65, 0.65):
        B['wood'].box(P(bx + dx, bz, 0.115), (0.08, 0.4, 0.57))
    obstacle(bx, bz, 1.5, 0.5)


bx0, bz0 = BENCH
bench(bx0, bz0)

vx, vz = PATCH                     # vegetable patch on the left side
B['soil'].box(P(vx, vz, -0.1), (2.6, 1.8, 0.2))
for i in range(4):
    for j in range(3):
        B['veg'].blob(P(vx - 0.9 + i * 0.6, vz - 0.6 + j * 0.6, 0.12), (0.2, 0.2, 0.18), rot=rng.uniform(0, 3))
obstacle(vx, vz, 2.6, 1.8)

# ---- meadow props: a second bench facing the pond, rocks round the pond, ducks, a campfire ----
bench(*BENCH2)

# the lake blocks walking, except along the pier: slices across it (0.5 m wide), and in the strip of the pier the
# water only blocks beyond its end. (A slice uses the wider of its two edges, so the barrier is never too small.)
lcx, lcz, lrx, lrz = LAKE
px_, pz0, pz1, pw = PIER
xa = lcx - lrx
while xa < lcx + lrx - 1e-6:
    xb = min(xa + 0.5, lcx + lrx)
    xi = 0.0 if xa < lcx < xb else min(abs(xa - lcx), abs(xb - lcx))
    zh = lrz * math.sqrt(max(0.0, 1 - (xi / lrx) ** 2))
    z_lo, z_hi = lcz - zh, lcz + zh
    if xb > px_ - pw / 2 and xa < px_ + pw / 2:
        z_lo = pz1
    if z_hi > z_lo:
        obstacle((xa + xb) / 2, (z_lo + z_hi) / 2, xb - xa, z_hi - z_lo)
    xa = xb

# rocks round the edge, reeds on the shore, lily pads and ducks on the water
for i in range(26):
    a = i * 2 * math.pi / 26 + rng.uniform(-0.08, 0.08)
    rx_, rz_ = lrx * rng.uniform(1.0, 1.08), lrz * rng.uniform(1.0, 1.1)
    sx, sz = lcx + math.cos(a) * rx_, lcz + math.sin(a) * rz_
    if abs(sx - px_) < pw / 2 + 0.3 and sz < lcz:       # not under the pier
        continue
    if sx < lcx - lrx + 1.6 and abs(sz - lcz) < 1.4:    # nor at the swimmers' west beach
        continue
    sr = rng.uniform(0.14, 0.26)
    B['rock'].blob(P(sx, sz, sr * 0.3 - 0.12), (sr, sr * 0.9, sr * 0.6), rot=rng.uniform(0, 3), jitter=0.15, rng=rng)
    if rng.random() < 0.5:   # a few reeds
        for _ in range(4):
            B['veg'].frustum(P(sx + rng.uniform(-0.3, 0.3), sz + rng.uniform(-0.3, 0.3) * (1 if sz > lcz else -1), -0.13),
                             0.04, 0.0, rng.uniform(0.6, 1.1), sides=4, rot=rng.uniform(0, 1))
for lx_, lz_ in ((24.8, 5.0), (25.4, 6.6), (24.9, 8.0), (24.2, 8.9), (20.5, 3.9), (19.2, 9.2)):  # lily pads
    B['veg'].frustum(P(lx_, lz_, -0.11), 0.32, 0.3, 0.01, sides=9)
    B['flower_pink'].blob(P(lx_ + 0.05, lz_, -0.08), (0.08, 0.08, 0.06))
for dx_, dz_ in ((18.2, 8.6), (17.5, 7.9), (19.4, 9.3)):  # ducks, in the south-west
    B['duck'].blob(P(dx_, dz_, -0.07), (0.2, 0.15, 0.13), rot=rng.uniform(0, 3))
    B['duck'].blob(P(dx_, dz_ + 0.14, 0.05), (0.09, 0.09, 0.09))
    B['beak'].box(P(dx_, dz_ + 0.25, 0.04), (0.05, 0.08, 0.03))

# the pier: its deck top is at 0 (the floor height, where the avatars' feet are), piles go down into the water
B['wood'].box(P(px_, (pz0 + pz1) / 2, -0.04), (pw, pz1 - pz0, 0.08))
for zz in (pz0 + 0.4, (pz0 + pz1) / 2, pz1 - 0.2):
    for sx_ in (-1, 1):
        B['trunk'].box(P(px_ + sx_ * (pw / 2 - 0.06), zz, -0.5), (0.14, 0.14, 1.0))
for sx_ in (-1, 1):   # a taller mooring post at each corner of the end
    B['trunk'].box(P(px_ + sx_ * (pw / 2 - 0.06), pz1 - 0.12, 0.2), (0.14, 0.14, 0.45))
B['wood'].box(P(px_ - 0.45, pz1 - 0.55, 0.1), (0.3, 0.3, 0.2))   # a bucket for the catch

fx_, fz_ = FIRE
for i in range(7):  # ring of stones
    a = i * 2 * math.pi / 7
    B['rock'].blob(P(fx_ + math.cos(a) * 0.55, fz_ + math.sin(a) * 0.55, 0.0), (0.16, 0.16, 0.12), rot=a, jitter=0.1, rng=rng)
for k in range(3):  # three logs crossed over each other
    B['trunk'].box(P(fx_, fz_, -0.1 + 0.05 * k), (0.7, 0.11, 0.1), rot=k * math.pi / 3 + 0.2)
B['ember'].frustum(P(fx_, fz_, 0.12), 0.32, 0.12, 0.28, sides=7)
B['flame'].frustum(P(fx_, fz_, 0.22), 0.22, 0.0, 0.55, sides=6, rot=0.4)
obstacle(fx_, fz_, 1.3, 1.3)

# ---- the camp: a tent with two cots, log seats round the fire, a lantern ----
tx, tz = TENT
TL, TW, TH, TG = 1.5, 2.0, 2.2, -0.12     # half length, half width, ridge height, ground level
B['tent_floor'].box(P(tx, tz, TG + 0.01), (2 * TL, 2 * TW, 0.03))
for sz_ in (-1, 1):
    slab(B['canvas_south' if sz_ == 1 else 'canvas'], [P(tx - TL, tz + sz_ * TW, TG), P(tx + TL, tz + sz_ * TW, TG),
                       P(tx + TL, tz, TH), P(tx - TL, tz, TH)], 0.03)
prism(B['canvas_acc'], [P(tx + TL, tz - TW, TG), P(tx + TL, tz + TW, TG), P(tx + TL, tz, TH)], 0.03)
B['wood'].box(P(tx, tz, TH + 0.02), (2 * TL + 0.4, 0.07, 0.07))   # ridge pole, sticking out at both ends
obstacle(tx, tz, 2 * TL + 0.2, 2 * TW + 0.2)

# cots: the top is 0.5 m above the floor, like the beds (the lying pose in src/avatar.ts expects it)
cots = []
for k, zc in enumerate((tz - 0.8, tz + 0.8), 1):
    cx_ = tx + 0.1
    for lx in (-0.9, 0.9):
        for lz in (-0.32, 0.32):
            B['wood'].box(P(cx_ + lx, zc + lz, 0.19), (0.07, 0.07, 0.62))
    B['wood'].box(P(cx_, zc, 0.475), (2.0, 0.8, 0.05))
    B['blanket_a' if k == 1 else 'blanket_b'].box(P(cx_ + 0.2, zc, 0.52), (1.3, 0.76, 0.05))
    B['pillow'].box(P(cx_ - 0.75, zc, 0.55), (0.4, 0.5, 0.1))  # the sleeper's head is at the west end, as in the beds
    cots.append((cx_, zc))
# a lantern hanging from the ridge pole
B['wood'].box(P(tx, tz, 1.95), (0.02, 0.02, 0.5))
B['lantern'].box(P(tx, tz, 1.62), (0.16, 0.16, 0.22))
LIGHTS = [
    {'id': 'campfire', 'x': FIRE[0], 'y': 0.7, 'z': FIRE[1], 'color': 0xff8a3c, 'intensity': 7, 'distance': 9, 'flicker': True},
    {'id': 'tent_lantern', 'x': tx, 'y': 1.6, 'z': tz, 'color': 0xffc27a, 'intensity': 3.5, 'distance': 5, 'flicker': False},
]

# log seats round the fire: tops 0.46 m (the sitting height in src/avatar.ts)
LOG_W = 0.4
logs = [((FIRE[0] - 1.9, FIRE[1]), 'z'), ((FIRE[0], FIRE[1] + 1.9), 'x')]
for (lx_, lz_), along in logs:
    size = (LOG_W, 1.3, 0.62) if along == 'z' else (1.3, LOG_W, 0.62)
    B['trunk'].box(P(lx_, lz_, 0.15), size)
    obstacle(lx_, lz_, size[0], size[1])

# ---- what agents can do outside (game coordinates; see room-layout.json for the indoor ones) ----
# `hours` limits an activity to part of the day [from, to) and may wrap past midnight.


def aff(verb, duration, effects, pose='stand', hours=None, orbit=None, orbit_z=None, lap=False, speed=None):
    a = {'verb': verb, 'duration': duration, 'effects': effects, 'pose': pose}
    if hours:
        a['hours'] = hours
    if orbit:  # swim in a circle of this radius while doing it; the use point is on the circle, due east of its centre
        a['orbit'] = orbit
    if orbit_z:   # ... or an ellipse: `orbit` is its x radius and this its z radius
        a['orbitZ'] = orbit_z
    if lap:       # keep going after the time is up until the loop is finished, back at the use point
        a['lap'] = True
    if speed:     # m/s along the loop
        a['speed'] = speed
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
for k, sx_ in enumerate((-0.4, 0.4), 1):
    hx = BENCH2[0] + sx_
    place_obj(f'pond_bench_seat_{k}', 'pond bench seat', (hx, BENCH2[1] + 3.0), (hx, BENCH2[1] + 0.12),
              [aff('relax', 45, {'fun': 20, 'energy': 8}, 'sit', DAY),
               aff('read', 60, {'knowledge': 22, 'fun': 8, 'energy': -2}, 'sit', DAY)],
              approach=(hx, BENCH2[1] + 0.225 + 0.5))
# the lake: `watch_ducks` from the shore, fishing at the end of the pier, swimming from the shores
place_obj('lake', 'lake', (lcx, lcz), (lcx - 1.4, lcz - lrz - 0.75),
          [aff('watch_ducks', 20, {'fun': 12, 'energy': 2}, 'stand', DAY)])
for k, sx_ in enumerate((-0.45, 0.45), 1):
    place_obj(f'fish_spot_{k}', 'fishing spot', (px_ + sx_, pz1 + 2.5), (px_ + sx_, pz1 - 0.6),
              [aff('fish', 45, {'fun': 14, 'knowledge': 4, 'energy': -2}, 'stand', [6, 20])])
SWIM = {'fun': 24, 'energy': -10}
R_SWIM = 0.9
place_obj('swim_1', 'swimming water', (lcx, lcz), (18.0 + R_SWIM, 6.2),
          [aff('swim', 50, SWIM, 'swim', [9, 18], orbit=R_SWIM)], approach=(15.2, 6.2))
place_obj('swim_2', 'swimming water', (lcx, lcz), (19.0 + R_SWIM, 4.5),
          [aff('swim', 50, SWIM, 'swim', [9, 18], orbit=R_SWIM)], approach=(19.9 + 0.9, 2.1))
# the rowboat: moored at the end of the pier. The rider walks onto the pier end, steps into the boat and rows one
# lap round an ellipse that starts at the mooring, then steps out again.
BOAT_USE = (23.1, pz1 + 1.5)     # the seat: the boat's middle, 1.5 m beyond the end of the pier
place_obj('rowboat', 'rowboat', (BOAT_USE[0], BOAT_USE[1] + 1.7), BOAT_USE,
          [aff('boat', 50, {'fun': 22, 'energy': -6, 'knowledge': 2}, 'sit', [8, 19], orbit=1.6, orbit_z=1.0, lap=True, speed=0.9)],
          approach=(px_, pz1 - 0.4))
place_obj('campfire', 'campfire', FIRE, (FIRE[0] - 1.1, FIRE[1]),
          [aff('warm_up', 30, {'fun': 14, 'energy': 5}, 'stand', [17, 24])])
for k, (cx_, zc) in enumerate(cots, 1):
    # like the beds: the use point is on the cot, and the way in is a straight line from the open end of the tent
    place_obj(f'tent_cot_{k}', 'camp cot', (cx_, zc), (cx_, zc),
              [aff('sleep_in_tent', 360, {'energy': 90}, 'lie', [20, 8]),
               aff('rest_in_tent', 60, {'energy': 25}, 'lie', DAY)],
              approach=(tx - TL - 0.7, zc))
for k, ((lx_, lz_), along) in enumerate(logs):
    for j, off in enumerate((-0.35, 0.35), 1):
        if along == 'z':   # faces +x, towards the fire
            hips = (lx_, lz_ + off)
            use, pos, appr = (hips[0] + 0.12, hips[1]), FIRE, (lx_ + LOG_W / 2 + 0.5, hips[1])
        else:              # faces -z, towards the fire
            hips = (lx_ + off, lz_)
            use, pos, appr = (hips[0], hips[1] - 0.12), FIRE, (hips[0], lz_ - LOG_W / 2 - 0.5)
        place_obj(f'log_seat_{2 * k + j}', 'log seat', pos, use,
                  [aff('sit_by_fire', 40, {'fun': 16, 'energy': 8}, 'sit', [17, 24])], approach=appr)
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

# ---- the rowboat: its own node, BOAT, so the game can move it. The origin is the middle of the seat (the rider's
# hips), and +z is forward (the bow). It is moored at the end of the pier, bow to the south, where the game puts it
# when nobody is rowing. The seat top is 0.46 m, the sitting height in src/avatar.ts; the waterline is at -0.12.
BP = {}


def bb(name):
    if name not in BP:
        BP[name] = Batch(materials[name])
    return BP[name]


def lbox(name, c, size):
    bb(name).box(P(*c), size)


def seg_slab(name, p0, p1, w, t):
    """a flat strip from p0 to p1 (x, z, height), w wide, t thick"""
    dx, dz = p1[0] - p0[0], p1[1] - p0[1]
    n = math.hypot(dx, dz) or 1.0
    ux, uz = -dz / n * w / 2, dx / n * w / 2
    slab(bb(name), [P(p0[0] + ux, p0[1] + uz, p0[2]), P(p1[0] + ux, p1[1] + uz, p1[2]),
                    P(p1[0] - ux, p1[1] - uz, p1[2]), P(p0[0] - ux, p0[1] - uz, p0[2])], t)


H0, H1 = -0.25, 0.37                      # hull bottom and top
lbox('wood', (0, -0.3, H0 + 0.025), (1.1, 2.4, 0.05))           # floor
bb('wood').poly([P(0.55, 0.9, H0 + 0.05), P(0, 1.6, H0 + 0.05), P(-0.55, 0.9, H0 + 0.05)])   # floor of the bow
for sx_ in (-1, 1):
    lbox('blanket_a', (sx_ * 0.57, -0.3, (H0 + H1) / 2), (0.07, 2.4, H1 - H0))                # side planks, painted teal
    lbox('pillow', (sx_ * 0.57, -0.3, H1 + 0.02), (0.11, 2.4, 0.04))                           # rail
    slab(bb('blanket_a'), [P(sx_ * 0.57, 0.9, H0), P(0, 1.6, H0), P(0, 1.6, H1), P(sx_ * 0.57, 0.9, H1)], 0.07)
    seg_slab('pillow', (sx_ * 0.57, 0.9, H1 + 0.04), (0, 1.6, H1 + 0.04), 0.1, 0.04)
    lbox('wood', (sx_ * 0.5, 0.0, 0.40), (0.1, 0.32, 0.07))                                    # seat supports
lbox('blanket_a', (0, -1.5, (H0 + H1) / 2), (1.2, 0.07, H1 - H0))                              # stern
lbox('wood', (0, 0.0, 0.435), (1.15, 0.32, 0.05))                                              # the seat
lbox('wood', (0, -1.0, 0.1), (1.05, 0.28, 0.04))                                               # a stern seat
for sx_ in (-1, 1):                       # oars: out through the rowlocks and down into the water
    seg_slab('trunk', (sx_ * 0.25, 0.3, 0.52), (sx_ * 1.75, -0.25, -0.1), 0.06, 0.04)
    seg_slab('pillow', (sx_ * 1.45, -0.19, -0.02), (sx_ * 1.9, -0.3, -0.12), 0.24, 0.03)
    lbox('trunk', (sx_ * 0.62, 0.3, 0.42), (0.06, 0.06, 0.12))                                 # the rowlock
boat_root = bpy.data.objects.new('BOAT', None)
coll.objects.link(boat_root)
boat_root.location = P(BOAT_USE[0], BOAT_USE[1] - 0.12, 0)

# ---- build objects ----
objs = []
for k, b in B.items():
    if len(b.bm.faces):
        objs.append(b.build('OUT_' + k))
    else:
        b.bm.free()

for k, b in BP.items():
    part = b.build('BOAT_' + k)
    part.parent = boat_root
    objs.append(part)
objs.append(boat_root)
tris = sum(len(o.data.polygons) for o in objs if o.type == 'MESH')
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
             'the camera. The only way out of the house is the door, and out of the yard the gate in the fence.',
    'yard': {'x0': -FX, 'x1': FX, 'z0': FZ0, 'z1': FZ1},  # the fenced yard
    'gate': {'x': FX, 'z': DOOR_Z, 'halfWidth': 1.0},      # the gap in its right-hand side
    'area': AREA,                                           # everything agents may walk in
    'boat': {'x': BOAT_USE[0], 'z': BOAT_USE[1] - 0.12, 'hw': 0.65, 'hl': 1.6},          # moored at the pier end
    'water': {'x': LAKE[0], 'z': LAKE[1], 'rx': LAKE[2], 'rz': LAKE[3]},   # the lake (an ellipse)
    'pier': {'x': PIER[0], 'z0': PIER[1], 'z1': PIER[2], 'w': PIER[3]},    # a dry strip across it
    'door': {'x': 5.0, 'z': DOOR_Z, 'halfWidth': 0.25},
    'lights': LIGHTS,
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
    if o.type != 'MESH':
        continue
    me = o.data
    me.calc_loop_triangles()
    tri_count += len(me.loop_triangles)
print('triangles:', tri_count)
