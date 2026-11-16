"""Assemble the single-room layout for airi-v3d-game in Blender from the Kenney Furniture Kit.

Run from the repository root:

    blender -b --factory-startup -P tools/blender/build_room.py -- --repo . [--render <dir>]

Inputs:
    assets/kenney-furniture-kit/*.glb   low-poly CC0 models by Kenney (www.kenney.nl), see License.txt

Outputs:
    public/models/room.glb          the room for three.js (GLTFLoader)
    src/room-layout.json            furniture footprints and interaction points, in game coordinates
    assets/room.blend               the same scene, for editing in Blender

Coordinates
    Game (three.js): x right, y up, z toward the camera. The room spans x -5..5 and z -4..4,
    the back wall is at z = -4 and the left wall at x = -5 (same as src/world.ts).
    Blender: z up. glTF export with +Y up maps Blender (x, y, z) to three (x, z, -y),
    so a game point (gx, gz) at height h is Blender (gx, -gz, h).
    Kenney models face glTF +Z, which is game +z. They are scaled by 2 to real-world size.

Load budget
    Every model shares one set of 15 materials (no textures), and each piece of furniture is one mesh.
    The script prints the triangle count, the draw-call count and the file size.

Checks (the script exits with code 1 when one fails)
    * two pieces of furniture intersect (triangle test on the real meshes, touching is fine),
    * a posed avatar (sitting, lying or standing at an interaction point) would clip into furniture,
    * a seat or bed has the wrong height for the poses in src/avatar.ts,
    * an interaction point cannot be reached on the game's navigation grid.
"""

import bpy
import bmesh
import json
import math
import os
import sys
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


REPO = os.path.abspath(arg('--repo', '.'))
RENDER_DIR = arg('--render')
KIT = os.path.join(REPO, 'assets', 'kenney-furniture-kit')

# room constants (match src/world.ts)
ROOM_W, ROOM_D = 10.0, 8.0
HW, HD = ROOM_W / 2, ROOM_D / 2
NAV_CELL, AGENT_R = 0.2, 0.35
K = 2.0  # Kenney units to metres

# avatar pose numbers from src/avatar.ts
SIT_HIPS_Y = 0.55   # hips height when sitting
SIT_FORWARD = 0.12  # usePos is this far in front of the hips
LIE_Y = 0.62        # body height when lying

TOUCH = 0.004       # intersections shallower than this count as touching

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
ROOM_COLL = bpy.data.collections.new('Room')
scene.collection.children.link(ROOM_COLL)
ROOT = bpy.data.objects.new('Room', None)
ROOM_COLL.objects.link(ROOT)


def g2b(gx, gz, h=0.0):
    return Vector((gx, -gz, h))


# --------------------------------------------------------------------------------------------
# materials: one shared material per Kenney material name, plus a few recolours
# --------------------------------------------------------------------------------------------
SHARED = {}


def srgb(hexcolor):
    v = int(hexcolor.lstrip('#'), 16)
    c = [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


RECOLOR = {
    # name: (Kenney material it replaces, sRGB colour)
    # cosy palette: sage and dusty-blue walls, pale oak, terracotta, teal and mustard textiles
    'fabric_teal': ('carpet', '#4f8f98'),
    'fabric_coral': ('carpet', '#e08a78'),
    'fabric_terracotta': ('carpet', '#c9694c'),
    'fabric_mustard': ('carpet', '#e0ae45'),
    'fabric_charcoal': ('carpet', '#4a4f57'),
    'rug_cream': ('carpet', '#efe3cb'),
    'rug_cream_edge': ('carpetDarker', '#5a8f94'),
    'floor_oak': ('wood', '#dcbd91'),
    'floor_tile': ('wood', '#e4ded2'),
    'wall_back': ('_defaultMat', '#b9cdb6'),
    'wall_left': ('_defaultMat', '#c9d6e3'),
    'wall_front': ('_defaultMat', '#f3ecdf'),
    'wall_right': ('_defaultMat', '#f3ecdf'),
}


def shared_material(src, rename=None):
    """Return the shared material for an imported Kenney material (or a recolour of it)."""
    base = src.name.split('.')[0]
    key = rename or base
    if key in SHARED:
        return SHARED[key]
    m = src.copy()
    m.name = 'kenney_' + key if not rename else key
    if rename:
        lin = srgb(RECOLOR[rename][1])
        bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        bsdf.inputs['Base Color'].default_value = (*lin, 1.0)
        m.diffuse_color = (*lin, 1.0)
    # Kenney sets metallic 0.5 on one fabric, which renders oddly; furniture here is not metal.
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    if base.startswith('carpet'):
        bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Roughness'].default_value = 0.35 if base in ('metal', 'metalLight', 'glass') else 0.8
    SHARED[key] = m
    return m


# --------------------------------------------------------------------------------------------
# items: one placed Kenney model each, joined into one mesh
# --------------------------------------------------------------------------------------------
ITEMS = {}
FACING_YAW = {'+z': 0.0, '+x': math.pi / 2, '-z': math.pi, '-x': -math.pi / 2}
FACING_VEC = {'+z': (0, 1), '+x': (1, 0), '-z': (0, -1), '-x': (-1, 0)}


class Item:
    def __init__(self, id, kind, obj, facing, blocks, collide, group):
        self.id, self.kind, self.obj, self.facing = id, kind, obj, facing
        self.blocks, self.collide, self.group = blocks, collide, group
        self.bvh = None

    def world_verts(self):
        # Objects only carry a location (scale and turn live in the mesh), and matrix_world is
        # stale until the depsgraph updates, so build the matrix from the location.
        mw = Matrix.Translation(self.obj.location)
        return [mw @ v.co for v in self.obj.data.vertices]

    def aabb(self):
        """(gx0, gx1, gz0, gz1, h0, h1) in game coordinates."""
        vs = self.world_verts()
        xs = [v.x for v in vs]
        zs = [-v.y for v in vs]
        hs = [v.z for v in vs]
        return min(xs), max(xs), min(zs), max(zs), min(hs), max(hs)

    def footprint(self):
        a = self.aabb()
        return {'cx': (a[0] + a[1]) / 2, 'cz': (a[2] + a[3]) / 2, 'w': a[1] - a[0], 'd': a[3] - a[2]}

    def build_bvh(self):
        vs = self.world_verts()
        self.bvh = BVHTree.FromPolygons(vs, [tuple(p.vertices) for p in self.obj.data.polygons])
        return self.bvh


def place(id, model, kind=None, facing='+z', scale=(K, K, K), h=0.0, blocks=True, collide=True,
          group='furniture', recolor=None, x0=None, x1=None, cx=None, z0=None, z1=None, cz=None):
    """Import a Kenney model, scale and turn it so its front faces `facing` (game direction),
    then move it so its bounding box meets the given edges (x0/x1/cx and z0/z1/cz, game coordinates)
    and its bottom sits at height h."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(KIT, model + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    for o in meshes:
        o.data = o.data.copy()
        o.data.transform(o.matrix_world)
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
    target = meshes[0]
    for o in new:  # glTF import adds empties for the node tree; only the meshes are kept
        if o.type != 'MESH':
            bpy.data.objects.remove(o)
    if len(meshes) > 1:
        with bpy.context.temp_override(active_object=target, object=target,
                                       selected_objects=meshes, selected_editable_objects=meshes):
            bpy.ops.object.join()
    ob = target
    me = ob.data
    me.transform(Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0)))
    me.transform(Matrix.Rotation(FACING_YAW[facing], 4, 'Z'))
    vs = [v.co for v in me.vertices]
    gx_min, gx_max = min(v.x for v in vs), max(v.x for v in vs)
    gz_min, gz_max = min(-v.y for v in vs), max(-v.y for v in vs)
    h_min = min(v.z for v in vs)
    w, d = gx_max - gx_min, gz_max - gz_min
    tx = x0 if x0 is not None else (x1 - w if x1 is not None else cx - w / 2)
    tz = z0 if z0 is not None else (z1 - d if z1 is not None else cz - d / 2)
    # origin at the footprint centre, on the floor of the model
    me.transform(Matrix.Translation(Vector((-(gx_min + w / 2), (gz_min + d / 2), -h_min))))
    ob.location = g2b(tx + w / 2, tz + d / 2, h)
    for slot in ob.material_slots:
        base = slot.material.name.split('.')[0]
        rename = recolor.get(base) if recolor else None
        slot.material = shared_material(slot.material, rename)
    for p in me.polygons:
        p.use_smooth = False
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    ROOM_COLL.objects.link(ob)
    ob.name = me.name = f'FURN_{id}'
    ob.parent = ROOT
    ob['item_id'] = id
    ob['kind'] = kind or model
    ob['model'] = model
    ob['blocks_walk'] = 1 if blocks else 0
    it = Item(id, kind or model, ob, facing, blocks, collide, group)
    ITEMS[id] = it
    return it


SHELL = dict(blocks=False, group='shell')

# ============================================================================================
# room shell: Kenney floor tiles, walls, two windows and a door
# ============================================================================================
for i in range(5):
    for j in range(4):
        place(f'floor_{i}_{j}', 'floorFull', 'floor', h=-0.1, x0=-HW + 2 * i, z0=-HD + 2 * j,
              recolor={'wood': 'floor_tile' if i == 4 and j >= 1 else 'floor_oak'}, collide=False, **SHELL)
WALL_T = 0.1
back = ['wall', 'wallWindow', 'wallWindow', 'wall', 'wall']  # x -5..5, 2 m each
for i, m in enumerate(back):
    xa = -HW + 2 * i
    end = i in (0, len(back) - 1)
    sx = K * (2 + WALL_T) / 2 if end else K
    place(f'wall_back_{i}', m, 'wall', facing='+z', scale=(sx, K, K), cz=-HD - WALL_T / 2, recolor={'_defaultMat': 'wall_back'},
          **({'x0': xa - WALL_T} if i == 0 else {'x1': xa + 2 + WALL_T} if end else {'x0': xa}), **SHELL)
for i in range(5):
    xa = -HW + 2 * i
    end = i in (0, 4)
    sx = K * (2 + WALL_T) / 2 if end else K
    place(f'wall_front_{i}', 'wall', 'wall', facing='-z', scale=(sx, K, K), cz=HD + WALL_T / 2, recolor={'_defaultMat': 'wall_front'},
          **({'x0': xa - WALL_T} if i == 0 else {'x1': xa + 2 + WALL_T} if end else {'x0': xa}), **SHELL)
for j in range(4):
    place(f'wall_left_{j}', 'wall', 'wall', facing='+x', cx=-HW - WALL_T / 2, z0=-HD + 2 * j,
          recolor={'_defaultMat': 'wall_left'}, **SHELL)
right = ['wall', 'wall', 'wall', 'wallDoorway']  # z -4..4
for j, m in enumerate(right):
    place(f'wall_right_{j}', m, 'wall', facing='-x', cx=HW + WALL_T / 2, z0=-HD + 2 * j, recolor={'_defaultMat': 'wall_right'}, **SHELL)
door = place('door', 'doorwayFront', 'door', facing='-x', cx=HW + WALL_T / 2, cz=-HD + 7.0, **SHELL)

# ============================================================================================
# sleeping area: two single beds, nightstand, wardrobe
# ============================================================================================
bed1 = place('bed', 'bedSingle', 'bed', facing='+x', x0=-HW + 0.01, z0=-HD + 0.01,
             recolor={'carpet': 'fabric_teal'})
a = bed1.aabb()
ns = place('nightstand', 'cabinetBedDrawerTable', 'nightstand', facing='+x', x0=-HW + 0.01, z0=a[3] + 0.04)
nsa = ns.aabb()
place('bedside_lamp', 'lampRoundTable', 'table lamp', facing='+x', cx=(nsa[0] + nsa[1]) / 2,
      cz=(nsa[2] + nsa[3]) / 2, h=nsa[5] + 0.002, blocks=False)
bed2 = place('bed2', 'bedSingle', 'bed', facing='+x', x0=-HW + 0.01, z0=nsa[3] + 0.04,
             recolor={'carpet': 'fabric_coral'})
b2 = bed2.aabb()
wr1 = place('wardrobe', 'bookcaseClosedDoors', 'wardrobe', facing='+x', x0=-HW + 0.01, z0=b2[3] + 0.5)
wa = wr1.aabb()
place('wardrobe_b', 'bookcaseClosedDoors', 'wardrobe', facing='+x', x0=-HW + 0.01, z0=wa[3] + 0.005)

# reading corner: armchair, little table, floor lamp
arm = place('armchair', 'loungeChair', 'armchair', facing='+x', x0=-HW + 0.01, z0=2.3, scale=(K, K * 0.75, K),
            recolor={'carpet': 'fabric_mustard'})
aa = arm.aabb()
place('side_table', 'cabinetBedDrawer', 'side table', facing='+x', x0=-HW + 0.01, z1=aa[2] - 0.08)
place('reading_lamp', 'lampRoundFloor', 'floor lamp', facing='+x', x0=-HW + 0.05, z0=aa[3] + 0.08)

# ============================================================================================
# living area: sofa under the first window, coffee table, rug, TV on the front wall
# ============================================================================================
# NOTICE:
# Kenney seats are about 0.68 m deep. The sitting pose in src/avatar.ts has flat thighs and straight
# shins, so a deep seat puts the shins inside the cushion. Sofa and armchair depth is scaled by 0.75.
# Remove the depth scale when the sitting pose bends the knees over the seat edge.
SEAT_DEPTH = (K, K * 0.75, K)
sofa = place('sofa', 'loungeSofa', 'sofa', facing='+z', cx=-0.0, z0=-HD + 0.06, scale=SEAT_DEPTH,
             recolor={'carpet': 'fabric_terracotta'})
sa = sofa.aabb()
ct = place('coffee_table', 'tableCoffee', 'coffee table', facing='+z', cx=0.0, z0=sa[3] + 1.0)
cta = ct.aabb()
place('rug', 'rugRounded', 'rug', facing='+z', cx=0.0, cz=(cta[2] + cta[3]) / 2 - 0.2, h=0.0, blocks=False,
      collide=False, recolor={'carpet': 'rug_cream', 'carpetDarker': 'rug_cream_edge'})
tvc = place('tv_cabinet', 'cabinetTelevision', 'tv cabinet', facing='-z', cx=0.0, z1=HD - 0.01)
tva = tvc.aabb()
place('tv', 'televisionModern', 'television', facing='-z', cx=0.0, cz=(tva[2] + tva[3]) / 2, h=tva[5] + 0.002,
      blocks=False)

# ============================================================================================
# work area: desk under the second window, office chair, bookshelf, plant
# ============================================================================================
# NOTICE:
# The Kenney desk leaves 0.65 m under the top, and the sitting thighs in src/avatar.ts reach 0.66 m.
# The desk height is scaled by 1.07 (top 0.82 m, 0.695 m clear). Remove it when the pose or desk changes.
desk = place('desk', 'desk', 'computer desk', facing='+z', cx=2.0, z0=-HD + 0.06, scale=(K, K, K * 1.07))
da = desk.aabb()
KNEE_X = da[0] + 0.95  # the desk has a drawer on its left; the knees go under the open right part
place('monitor', 'computerScreen', 'monitor', facing='+z', cx=KNEE_X, z0=da[2] + 0.08, h=da[5] + 0.002, blocks=False)
place('keyboard', 'computerKeyboard', 'keyboard', facing='+z', cx=KNEE_X, z1=da[3] - 0.06, h=da[5] + 0.002,
      blocks=False)
place('mouse', 'computerMouse', 'mouse', facing='+z', cx=KNEE_X + 0.38, z1=da[3] - 0.08, h=da[5] + 0.002,
      blocks=False)
place('desk_lamp', 'lampSquareTable', 'desk lamp', facing='+z', cx=da[0] + 0.2, z0=da[2] + 0.06,
      h=da[5] + 0.002, blocks=False)
chair = place('desk_chair', 'chairDesk', 'office chair', facing='-z', cx=KNEE_X, z0=da[3], blocks=False,
              recolor={'carpet': 'fabric_charcoal'})

shelf = place('bookshelf', 'bookcaseClosedWide', 'bookshelf', facing='-x', x1=HW - 0.01, z0=-2.95)
bsa = shelf.aabb()
shelf.build_bvh()
fp = shelf.footprint()
level, levels = bsa[5] - 0.01, []
while level > 0.05:  # find each upward-facing shelf surface with at least 0.26 m free above it
    hit, normal, _, _ = shelf.bvh.ray_cast(g2b(fp['cx'], fp['cz'] - 0.3, level), Vector((0, 0, -1)))
    if hit is None:
        break
    if normal.z > 0.5:
        up = shelf.bvh.ray_cast(hit + Vector((0, 0, 0.005)), Vector((0, 0, 1)))[0]
        if up is None or up.z - hit.z > 0.26:
            levels.append(hit.z)
    level = hit.z - 0.005
for k, lv in enumerate(levels):
    for m, dz in enumerate((-0.42, 0.3) if k % 2 == 0 else (-0.1,)):
        place(f'books_{k}_{m}', 'books', 'books', facing='-x', cx=fp['cx'], cz=fp['cz'] + dz, h=lv + 0.002,
              blocks=False)
place('plant', 'pottedPlant', 'potted plant', facing='+z', cx=4.45, cz=-3.55, scale=(2.4, 2.4, 2.4))

# ============================================================================================
# kitchen along the right wall: fridge, sink, drawers, cooker, wall cabinets, hood
# ============================================================================================
fr = place('fridge', 'kitchenFridgeLarge', 'fridge', facing='-x', x1=HW - 0.01, z0=bsa[3] + 0.08)
fra = fr.aabb()
z = fra[3] + 0.01
counter = []
for id, model in (('sink_cabinet', 'kitchenSink'), ('drawer_cabinet', 'kitchenCabinetDrawer'),
                  ('stove_cabinet', 'kitchenStoveElectric')):
    it = place(id, model, model, facing='-x', x1=HW - 0.01, z0=z)
    counter.append(it)
    z = it.aabb()[3] + 0.003
sink, drawers, stove = counter
top = drawers.aabb()[5]
place('microwave', 'kitchenMicrowave', 'microwave', facing='-x', x1=HW - 0.03,
      cz=(drawers.aabb()[2] + drawers.aabb()[3]) / 2 + 0.12, h=top + 0.002, blocks=False)
upper_h = 1.45
place('upper_cabinet_a', 'kitchenCabinetUpperDouble', 'wall cabinet', facing='-x', x1=HW - 0.01,
      cz=(sink.aabb()[2] + sink.aabb()[3]) / 2, h=upper_h, blocks=False)
place('upper_cabinet_b', 'kitchenCabinetUpper', 'wall cabinet', facing='-x', x1=HW - 0.01,
      cz=(drawers.aabb()[2] + drawers.aabb()[3]) / 2, h=upper_h, blocks=False)
place('range_hood', 'hoodModern', 'range hood', facing='-x', x1=HW - 0.01,
      cz=(stove.aabb()[2] + stove.aabb()[3]) / 2, h=upper_h, blocks=False)
place('trash_bin', 'trashcan', 'trash bin', facing='+z', cx=da[1] + 0.35, cz=-HD + 0.3, scale=(1.6, 1.6, 1.6))

# ============================================================================================
# dining table with two stools
# ============================================================================================
# NOTICE:
# The Kenney table is 0.65 m high with its apron at 0.56 m, too low for the sitting thighs (0.66 m) in
# src/avatar.ts. Its height is scaled by 1.2 (top 0.78 m, apron 0.67 m). Remove it when the pose changes.
t_scale = (K, K, K * 1.2)
table = place('dining_table', 'table', 'dining table', facing='+z', cx=1.4, cz=1.4, scale=t_scale)
ta = table.aabb()
STOOL_SEAT = 0.46
s_scale = (2.4, 2.4, STOOL_SEAT / 0.405)
stool1 = place('stool_1', 'stoolBarSquare', 'stool', facing='+z', cx=1.4, cz=ta[2] - 0.22, scale=s_scale,
               blocks=False)
stool2 = place('stool_2', 'stoolBarSquare', 'stool', facing='-z', cx=1.4, cz=ta[3] + 0.22, scale=s_scale,
               blocks=False)
place('fruit_plant', 'plantSmall2', 'small plant', facing='+z', cx=1.4, cz=1.4, h=ta[5] + 0.002, blocks=False,
      scale=(2.4, 2.4, 2.4))

# ============================================================================================
# entrance: shoe shelf, coat rack, door mat, washing machine
# ============================================================================================
place('shoe_shelf', 'bookcaseOpenLow', 'shoe shelf', facing='-z', x1=HW - 0.6 - 0.95 - 0.1, z1=HD - 0.01)
place('coat_rack', 'coatRackStanding', 'coat rack', facing='-z', cx=HW - 0.35, cz=HD - 0.35)
place('door_mat', 'rugDoormat', 'door mat', facing='-x', x1=HW - 0.03, cz=3.0, blocks=False, collide=False)
washer = place('washer', 'washer', 'washing machine', facing='-z', cx=2.0, z1=HD - 0.01)

# ============================================================================================
# geometry helpers for the checks
# ============================================================================================
bpy.context.view_layer.update()
for it in ITEMS.values():
    it.build_bvh()


def overlap_depth(a, b):
    return min(min(a[1], b[1]) - max(a[0], b[0]), min(a[3], b[3]) - max(a[2], b[2]),
               min(a[5], b[5]) - max(a[4], b[4]))


def ray_down(item, gx, gz, top=3.0):
    """Height of the first surface of `item` below (gx, top, gz), or None."""
    hit = item.bvh.ray_cast(g2b(gx, gz, top), Vector((0, 0, -1)))
    return hit[0].z if hit[0] is not None else None


def ray_back(item, a, h, facing):
    """Distance along `facing` from the item's front edge to the first surface hit when looking back
    into the item at height h and sideways offset a. Used to find the seat back."""
    fx, fz = FACING_VEC[facing]
    sx, sz = -fz, fx
    fp = item.footprint()
    cxg, czg = fp['cx'] + sx * a, fp['cz'] + sz * a
    start = (cxg + fx * 2.0, czg + fz * 2.0)
    hit = item.bvh.ray_cast(g2b(start[0], start[1], h), Vector((-fx, fz, 0)).normalized())
    if hit[0] is None:
        return None
    return Vector((hit[0].x, -hit[0].y))


def frame_pt(origin, facing, a, b):
    fx, fz = FACING_VEC[facing]
    sx, sz = -fz, fx
    return (origin[0] + a * sx + b * fx, origin[1] + a * sz + b * fz)


# ============================================================================================
# interactions
# ============================================================================================
INTERACTIONS = []
errors, notes = [], []


def add(id, kind, furniture, pose, use, target, verbs, approach=None, related=(), hips=None, seat=None,
        head_dir=None):
    INTERACTIONS.append({'id': id, 'kind': kind, 'furniture': furniture, 'pose': pose, 'use': use,
                         'target': target, 'approach': approach, 'verbs': verbs,
                         'related': set(related) | {furniture}, 'hips': hips, 'seat': seat,
                         'head_dir': head_dir})


KNEE_REACH = 0.27  # the shins start 0.33 m in front of the hips; keep the seat edge 6 cm behind them for the calves


def seat_hips(item, a, facing):
    """Hips position on a seat: KNEE_REACH behind the front edge of the seat cushion."""
    fp = item.footprint()
    top = ray_down(item, fp['cx'], fp['cz'], top=0.6)
    hit = ray_back(item, a, top - 0.03, facing)
    fx, fz = FACING_VEC[facing]
    return (hit.x - fx * KNEE_REACH, hit.y - fz * KNEE_REACH)


def move(item, dgx, dgz):
    item.obj.location += Vector((dgx, -dgz, 0.0))
    item.build_bvh()


def sit(id, kind, furniture, item_for_seat, facing, hips, verbs, target=None, related=(), from_front=True):
    """`from_front`: the agent walks up from the side the seat faces (sofa); otherwise from behind
    the seat (a chair at a table)."""
    fx, fz = FACING_VEC[facing]
    use = (hips[0] + fx * SIT_FORWARD, hips[1] + fz * SIT_FORWARD)
    tgt = target or (hips[0] + fx, hips[1] + fz)
    seat_h = ray_down(item_for_seat, hips[0], hips[1], top=1.2)
    add(id, kind, furniture, 'sit', use, tgt, verbs, approach=None, related=related, hips=hips,
        seat=(item_for_seat.id, seat_h))
    INTERACTIONS[-1]['facing'] = facing
    INTERACTIONS[-1]['approach_dir'] = (fx, fz) if from_front else (-fx, -fz)


def stand(id, kind, furniture, facing, verbs, dist=0.45, a=0.0):
    fp = ITEMS[furniture].footprint()
    fx, fz = FACING_VEC[facing]
    half = (fp['w'] if fx else fp['d']) / 2
    center = (fp['cx'], fp['cz'])
    front = frame_pt(center, facing, a, half)
    use = (front[0] + fx * dist, front[1] + fz * dist)
    add(id, kind, furniture, 'stand', use, frame_pt(center, facing, a, 0.0), verbs)


SLEEP = [{'verb': 'sleep', 'duration': 360, 'effects': {'energy': 90}, 'pose': 'lie'}]
for bed in (bed1, bed2):
    fp = bed.footprint()
    use = (-HW + 1.15, fp['cz'])
    add(bed.id, 'bed', bed.id, 'lie', use, use, SLEEP, approach=(fp['cx'] + fp['w'] / 2 + 0.45, fp['cz']),
        head_dir=(-1, 0), seat=(bed.id, ray_down(bed, use[0], use[1], top=1.2)))

for k, a in enumerate((-0.45, 0.45)):
    hips = seat_hips(sofa, a, '+z')
    sit(f'sofa_seat_{k + 1}', 'sofa seat', 'sofa', sofa, '+z', hips,
        [{'verb': 'relax', 'duration': 45, 'effects': {'fun': 20, 'energy': 8}, 'pose': 'sit'}],
        target=(hips[0], HD))
hips = seat_hips(arm, 0.0, '+x')
sit('armchair', 'armchair', 'armchair', arm, '+x', hips,
    [{'verb': 'read', 'duration': 60, 'effects': {'knowledge': 25, 'fun': 10, 'energy': -3}, 'pose': 'sit'}])
# office chair: slide it so the hips sit 0.28 m behind the desk edge (thighs reach 0.14 m under the top)
hips = seat_hips(chair, 0.0, '-z')
move(chair, 0.0, (da[3] + 0.28) - hips[1])
hips = seat_hips(chair, 0.0, '-z')
sit('desk', 'computer desk', 'desk', chair, '-z', hips,
    [{'verb': 'use_computer', 'duration': 90, 'effects': {'fun': 35, 'energy': -12}, 'pose': 'sit'}],
    related=['desk_chair'], from_front=False)
for k, (st, facing) in enumerate(((stool1, '+z'), (stool2, '-z'))):
    fp = st.footprint()
    sit(f'dining_seat_{k + 1}', 'dining seat', 'dining_table', st, facing, (fp['cx'], fp['cz']),
        [{'verb': 'eat', 'duration': 30, 'effects': {'energy': 30, 'fun': 8}, 'pose': 'sit'}],
        target=(1.4, 1.4), related=[st.id], from_front=False)

stand('bookshelf', 'bookshelf', 'bookshelf', '-x',
      [{'verb': 'read', 'duration': 60, 'effects': {'knowledge': 30, 'fun': 8, 'energy': -5}, 'pose': 'stand'}])
stand('fridge', 'fridge', 'fridge', '-x',
      [{'verb': 'grab_snack', 'duration': 10, 'effects': {'energy': 12, 'fun': 4}, 'pose': 'stand'}])
stand('sink', 'sink', 'sink_cabinet', '-x',
      [{'verb': 'wash_dishes', 'duration': 15, 'effects': {'fun': -2}, 'pose': 'stand'}])
stand('stove', 'stove', 'stove_cabinet', '-x',
      [{'verb': 'cook', 'duration': 30, 'effects': {'energy': 20, 'fun': 6}, 'pose': 'stand'}])
stand('wardrobe', 'wardrobe', 'wardrobe', '+x',
      [{'verb': 'change_clothes', 'duration': 10, 'effects': {'fun': 4}, 'pose': 'stand'}])
# stand at, and face, the gap between the two wardrobe halves
INTERACTIONS[-1]['use'] = (INTERACTIONS[-1]['use'][0], wa[3])
INTERACTIONS[-1]['target'] = (INTERACTIONS[-1]['target'][0], wa[3])
stand('washer', 'washing machine', 'washer', '-z',
      [{'verb': 'do_laundry', 'duration': 15, 'effects': {'fun': -2, 'energy': -3}, 'pose': 'stand'}])

# ============================================================================================
# navigation grid, same rules as src/world.ts
# ============================================================================================
nx, nz = round(ROOM_W / NAV_CELL), round(ROOM_D / NAV_CELL)
footprints = [it.footprint() for it in ITEMS.values() if it.blocks]


def cell_center(i, j):
    return -HW + (i + 0.5) * NAV_CELL, -HD + (j + 0.5) * NAV_CELL


def cell_of(x, z):
    return int(math.floor((x + HW) / NAV_CELL)), int(math.floor((z + HD) / NAV_CELL))


blocked = [[False] * nx for _ in range(nz)]
for j in range(nz):
    for i in range(nx):
        x, z = cell_center(i, j)
        b = abs(x) > HW - AGENT_R or abs(z) > HD - AGENT_R
        for fp in footprints:
            if abs(x - fp['cx']) < fp['w'] / 2 + AGENT_R and abs(z - fp['cz']) < fp['d'] / 2 + AGENT_R:
                b = True
        blocked[j][i] = b


def is_free(p):
    i, j = cell_of(*p)
    return 0 <= i < nx and 0 <= j < nz and not blocked[j][i]


# approach points for seats: the nearest free spot straight in front of the seat
for ia in INTERACTIONS:
    if ia['pose'] != 'sit':
        continue
    fx, fz = ia['approach_dir']
    for k in [x / 10 for x in range(3, 25)]:
        p = (round(ia['use'][0] + fx * k, 3), round(ia['use'][1] + fz * k, 3))
        if is_free(p):
            ia['approach'] = p
            break
    else:
        errors.append(f'{ia["id"]}: no free approach point in front of the seat')
    if not is_free(ia['use']) and not ia['approach']:
        errors.append(f'{ia["id"]}: use point blocked and no approach')

start = cell_of(0.0, 0.5)
reach = set()
if is_free((0.0, 0.5)):
    q = [start]
    reach.add(start)
    while q:
        ci, cj = q.pop()
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                if not di and not dj:
                    continue
                ni, nj = ci + di, cj + dj
                if not (0 <= ni < nx and 0 <= nj < nz) or blocked[nj][ni] or (ni, nj) in reach:
                    continue
                if di and dj and (blocked[cj][ci + di] or blocked[cj + dj][ci]):
                    continue
                reach.add((ni, nj))
                q.append((ni, nj))
else:
    errors.append('spawn area (0, 0.5) is blocked')
for ia in INTERACTIONS:
    goal = ia['approach'] or ia['use']
    if not is_free(goal):
        errors.append(f'{ia["id"]}: point {goal} is on a blocked cell')
    elif cell_of(*goal) not in reach:
        errors.append(f'{ia["id"]}: point {goal} cannot be reached')
free_cells = sum(1 for j in range(nz) for i in range(nx) if not blocked[j][i])
notes.append(f'walkable cells: {free_cells} of {nx * nz}, reachable from the middle: {len(reach)}')

# ============================================================================================
# collision checks on the real meshes
# ============================================================================================
coll_items = [it for it in ITEMS.values() if it.collide and it.group == 'furniture']
shell_items = [it for it in ITEMS.values() if it.collide and it.group == 'shell']
aabbs = {it.id: it.aabb() for it in ITEMS.values()}


def meshes_clash(a, b):
    """True when the two items' triangles cross deeper than TOUCH."""
    d = overlap_depth(aabbs[a.id], aabbs[b.id])
    if d <= TOUCH:
        return 0.0
    pairs = a.bvh.overlap(b.bvh)
    return d if pairs else 0.0


pairs = [(coll_items[i], coll_items[j]) for i in range(len(coll_items)) for j in range(i + 1, len(coll_items))]
pairs += [(f, s) for f in coll_items for s in shell_items]
for a, b in pairs:
    d = meshes_clash(a, b)
    if d:
        errors.append(f'intersect: {a.id} x {b.id} (boxes overlap {d * 100:.1f} cm)')

for it in coll_items:
    a = aabbs[it.id]
    if a[0] < -HW - 0.001 or a[1] > HW + 0.001 or a[2] < -HD - 0.001 or a[3] > HD + 0.001:
        errors.append(f'outside the room: {it.id}')


def box_bvh(bb):
    x0, x1, z0, z1, h0, h1 = bb
    vs = [g2b(x, z, h) for x in (x0, x1) for z in (z0, z1) for h in (h0, h1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return BVHTree.FromPolygons(vs, faces)


def verts_inside(it, bb):
    x0, x1, z0, z1, h0, h1 = bb
    for v in it.world_verts():
        if x0 < v.x < x1 and z0 < -v.y < z1 and h0 < v.z < h1:
            return True
    return False


def body_boxes(ia):
    out = []
    if ia['pose'] == 'sit':
        hx, hz = ia['hips']
        facing = ia['facing']
        for nm, (a0, a1, b0, b1, h0, h1) in {
            'torso': (-0.2, 0.2, -0.15, 0.12, 0.5, 1.35),
            'thighs': (-0.19, 0.19, -0.1, 0.42, 0.48, 0.66),
            'shins': (-0.19, 0.19, 0.33, 0.52, 0.12, 0.55),  # feet below 0.12 m may rest on a chair base
        }.items():
            p, q = frame_pt((hx, hz), facing, a0, b0), frame_pt((hx, hz), facing, a1, b1)
            out.append((nm, (min(p[0], q[0]), max(p[0], q[0]), min(p[1], q[1]), max(p[1], q[1]), h0, h1), ()))
    elif ia['pose'] == 'lie':
        ux, uz = ia['use']
        x_head, x_feet = ux + ia['head_dir'][0] * 0.95, ux - ia['head_dir'][0] * 0.95
        out.append(('body', (min(x_head, x_feet), max(x_head, x_feet), uz - 0.25, uz + 0.25, LIE_Y - 0.08, LIE_Y + 0.25),
                    (ia['furniture'],)))
    else:
        ux, uz = ia['use']
        out.append(('body', (ux - 0.22, ux + 0.22, uz - 0.22, uz + 0.22, 0.02, 1.75), ()))
    return out


def body_hits(bb, exclude):
    bv = box_bvh(bb)
    hits = []
    for it in coll_items + shell_items:
        if it.id in exclude or overlap_depth(bb, aabbs[it.id]) <= TOUCH:
            continue
        if bv.overlap(it.bvh) or verts_inside(it, bb):
            hits.append(it.id)
    return hits


for ia in INTERACTIONS:
    for nm, bb, excl in body_boxes(ia):
        for hit in body_hits(bb, excl):
            errors.append(f'avatar at {ia["id"]} ({nm}) hits {hit}')
    # seat heights for the fixed poses
    if ia['pose'] == 'sit':
        sid, sh = ia['seat']
        if sh is None:
            errors.append(f'{ia["id"]}: no seat surface under the hips')
        elif not (SIT_HIPS_Y - 0.15 <= sh <= SIT_HIPS_Y - 0.06):
            errors.append(f'{ia["id"]}: seat height {sh:.2f} m does not fit hips at {SIT_HIPS_Y} m')
        else:
            notes.append(f'{ia["id"]}: seat {sh:.2f} m')
    if ia['pose'] == 'lie':
        sid, sh = ia['seat']
        if sh is None or not (LIE_Y - 0.2 <= sh <= LIE_Y - 0.02):
            errors.append(f'{ia["id"]}: mattress height {sh} does not fit the lying pose at {LIE_Y} m')
        else:
            notes.append(f'{ia["id"]}: mattress {sh:.2f} m')
    # the last step from the approach point onto the seat or bed passes no other furniture
    if ia['approach']:
        (ax, az), (ux, uz) = ia['approach'], ia['use']
        for k in range(21):
            t = k / 20
            px, pz = ax + (ux - ax) * t, az + (uz - az) * t
            hits = body_hits((px - 0.17, px + 0.17, pz - 0.17, pz + 0.17, 0.12, 1.6), ia['related'])
            if hits:
                errors.append(f'step onto {ia["id"]} crosses {hits[0]}')
                break

# ============================================================================================
# join the floor tiles and walls into a few meshes (fewer draw calls), interaction markers
# ============================================================================================


def join(name, ids):
    objs = [ITEMS[i].obj for i in ids]
    for o in objs:
        o.data.transform(o.matrix_basis)
        o.matrix_basis = Matrix.Identity(4)
    with bpy.context.temp_override(active_object=objs[0], object=objs[0], selected_objects=objs,
                                   selected_editable_objects=objs):
        bpy.ops.object.join()
    objs[0].name = objs[0].data.name = name
    for k in ('item_id', 'model'):
        if k in objs[0]:
            del objs[0][k]
    objs[0]['kind'] = name.lower()
    for i in ids:
        del ITEMS[i]
    return objs[0]


join('Floor', [i for i in ITEMS if i.startswith('floor_')])
join('Walls_Back', [i for i in ITEMS if i.startswith('wall_back_')])
join('Walls_Left', [i for i in ITEMS if i.startswith('wall_left_')])
join('Walls_Right', [i for i in ITEMS if i.startswith('wall_right_')])
join('Walls_Front', [i for i in ITEMS if i.startswith('wall_front_')])

# ============================================================================================
# decor: baseboards, curtains, wall art, cushions, rugs, small plants. Visual only: not in the layout
# file, not walkable obstacles and not part of the clipping checks.
# ============================================================================================
DECOR = {}


def decor_batch(name, hexcolor):
    if name not in DECOR:
        m = bpy.data.materials.new('decor_' + name)
        m.use_nodes = True
        bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        bsdf.inputs['Base Color'].default_value = (*srgb(hexcolor), 1.0)
        bsdf.inputs['Roughness'].default_value = 0.85
        bsdf.inputs['Metallic'].default_value = 0.0
        DECOR[name] = (m, bmesh.new())
    return DECOR[name][1]


def dbox(name, hexcolor, cx, cz, h0, sx, sz, sh, rot=0.0):
    """box centred on game point (cx, cz), bottom at h0, sizes (x, z, height), turned about the vertical by rot"""
    bm = decor_batch(name, hexcolor)
    c = g2b(cx, cz, h0 + sh / 2)
    R = Matrix.Rotation(rot, 3, 'Z')
    v = [bm.verts.new(c + R @ Vector((x * sx / 2, y * sz / 2, z * sh / 2)))
         for z in (-1, 1) for y in (-1, 1) for x in (-1, 1)]
    for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        bm.faces.new([v[i] for i in q])


def wall_box(name, hexcolor, wall, along, h0, w, h, depth, off=0.0):
    """flat box on the inside of the 'back' (along = x) or 'left' (along = z) wall"""
    if wall == 'back':
        dbox(name, hexcolor, along, -HD + off + depth / 2, h0, w, depth, h)
    else:
        dbox(name, hexcolor, -HW + off + depth / 2, along, h0, depth, w, h)


def picture(wall, along, hc, w, h, art):
    """framed abstract print: white frame, cream mat, and a few coloured shapes (art = list of colours)"""
    wall_box('frame', '#f7f3ea', wall, along, hc - h / 2, w, h, 0.035)
    wall_box('mat', '#efe6d2', wall, along, hc - h / 2 + 0.04, w - 0.08, h - 0.08, 0.04)
    wall_box(f'art_{art[0]}', art[0], wall, along - w * 0.16, hc - h * 0.3, w * 0.22, h * 0.5, 0.045)
    wall_box(f'art_{art[1]}', art[1], wall, along + w * 0.16, hc - h * 0.12, w * 0.22, h * 0.3, 0.045)
    wall_box(f'art_{art[2]}', art[2], wall, along, hc + h * 0.18, w * 0.12, w * 0.12, 0.045)


# baseboards on all four walls (the right one stops short of the door)
BASE = '#f7f3ea'
wall_box('base', BASE, 'back', 0.0, 0.0, ROOM_W, 0.12, 0.022)
wall_box('base', BASE, 'left', 0.0, 0.0, ROOM_D, 0.12, 0.022)
dbox('base', BASE, 0.0, HD - 0.011, 0.0, ROOM_W, 0.022, 0.12)
dbox('base', BASE, HW - 0.011, (-HD + 2.4) / 2, 0.0, 0.022, 2.4 + HD, 0.12)
dbox('base', BASE, HW - 0.011, (3.6 + HD) / 2, 0.0, 0.022, HD - 3.6, 0.12)

# curtains on the two back windows: a rod, and a panel on each side and between them
# (window openings: x -2.47..-1.53 and -0.47..0.47, sill 0.88 m, head 2.02 m)
CURT = '#f1d9a8'
dbox('rod', '#5b4636', -1.0, -HD + 0.1, 2.28, 4.0, 0.03, 0.03)
for cxp, wd in ((-2.74, 0.34), (-1.0, 0.5), (0.74, 0.34)):
    dbox('curtain', CURT, cxp, -HD + 0.06, 0.98, wd, 0.08, 1.3)
    dbox('curtain_fold', '#e3c78b', cxp + wd * 0.18, -HD + 0.105, 0.98, wd * 0.18, 0.02, 1.3)

# wall art above the beds, and beside the desk
picture('left', -3.42, 1.7, 0.7, 0.5, ('#4f8f98', '#e08a78', '#e0ae45'))
picture('left', -1.67, 1.7, 0.7, 0.5, ('#c9694c', '#4f8f98', '#efe3cb'))
picture('back', 3.9, 1.95, 0.5, 0.65, ('#e0ae45', '#4f8f98', '#c9694c'))

# cushions on the sofa ends
sofa_a = ITEMS['sofa'].aabb()
for sx_, col, tilt in ((-1, '#e0ae45', 0.18), (1, '#f3ead8', -0.18)):
    dbox('cushion_' + col, col, sx_ * 0.74, sofa_a[2] + 0.27, 0.43, 0.36, 0.1, 0.36, rot=tilt)

# rugs: a striped one beside the beds, a runner in the kitchen
dbox('rug_bed', '#ecd3b0', -2.05, -2.55, 0.003, 1.1, 2.4, 0.012)
for dz_ in (-0.9, 0.9):
    dbox('rug_stripe', '#c9694c', -2.05, -2.55 + dz_, 0.015, 1.1, 0.1, 0.002)
dbox('rug_kitchen', '#d9cdb8', 3.95, -0.6, 0.003, 0.9, 2.3, 0.012)
for dz_ in (-1.0, 1.0):
    dbox('rug_kstripe', '#5a8f94', 3.95, -0.6 + dz_, 0.015, 0.9, 0.08, 0.002)

# small plants and books on the tables
ct_a, st_a = ITEMS['coffee_table'].aabb(), ITEMS['side_table'].aabb()
place('plant_coffee', 'plantSmall2', 'small plant', cx=-0.3, cz=(ct_a[2] + ct_a[3]) / 2, h=ct_a[5] + 0.002,
      scale=(1.8, 1.8, 1.8), blocks=False, collide=False, group='decor')
place('books_coffee', 'books', 'books', facing='+z', cx=0.32, cz=(ct_a[2] + ct_a[3]) / 2, h=ct_a[5] + 0.002,
      scale=(1.4, 1.4, 1.4), blocks=False, collide=False, group='decor')
place('plant_side', 'plantSmall2', 'small plant', cx=(st_a[0] + st_a[1]) / 2, cz=(st_a[2] + st_a[3]) / 2,
      h=st_a[5] + 0.002, scale=(1.4, 1.4, 1.4), blocks=False, collide=False, group='decor')

for name, (mat, bm) in DECOR.items():
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('DECOR_' + name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    for poly in me.polygons:
        poly.use_smooth = False
    ob = bpy.data.objects.new('DECOR_' + name, me)
    ROOM_COLL.objects.link(ob)
    ob.parent = ROOT

markers = bpy.data.objects.new('Interactions', None)
markers.parent = ROOT
ROOM_COLL.objects.link(markers)


def heading(ia):
    if ia['pose'] == 'lie':
        return math.pi / 2
    return math.atan2(ia['target'][0] - ia['use'][0], ia['target'][1] - ia['use'][1])


def r3(v):
    return round(v, 3)


for ia in INTERACTIONS:
    for kind, p in (('use', ia['use']), ('approach', ia['approach'])):
        if not p:
            continue
        e = bpy.data.objects.new(f'IP_{ia["id"]}_{kind}', None)
        e.empty_display_type = 'SINGLE_ARROW' if kind == 'use' else 'PLAIN_AXES'
        e.empty_display_size = 0.3
        e.location = g2b(p[0], p[1], 0.0)
        e.rotation_euler = (0.0, 0.0, heading(ia))
        e['interaction'] = ia['id']
        e['point'] = kind
        e['pose'] = ia['pose']
        e['verbs'] = ','.join(v['verb'] for v in ia['verbs'])
        e.parent = markers
        ROOM_COLL.objects.link(e)

for it in ITEMS.values():
    if it.blocks:
        fp = it.footprint()
        it.obj['footprint'] = [r3(fp['cx']), r3(fp['cz']), r3(fp['w']), r3(fp['d'])]


def fp_json(fp):
    return {k: r3(v) for k, v in fp.items()}


layout = {
    'about': 'Generated by tools/blender/build_room.py from the Kenney Furniture Kit (CC0). Game coordinates '
             '(three.js): x right, y up, z toward the camera, back wall at z = -4. Affordances are suggestions.',
    'room': {'w': ROOM_W, 'd': ROOM_D, 'wallThickness': WALL_T,
             'walls': {'back': 'Walls_Back', 'left': 'Walls_Left', 'right': 'Walls_Right', 'front': 'Walls_Front'},
             'hideForGameCamera': ['Walls_Front', 'Walls_Right']},
    'furniture': [{'id': it.id, 'kind': it.kind, 'node': it.obj.name, 'blocksWalk': it.blocks,
                   'footprint': fp_json(it.footprint()) if it.blocks else None}
                  for it in ITEMS.values() if it.group == 'furniture'],
    'objects': [],
}
seen = set()
for ia in INTERACTIONS:
    f = ITEMS.get(ia['furniture'])
    obj = {'id': ia['id'], 'kind': ia['kind'], 'furniture': ia['furniture'],
           'pos': {'x': r3(ia['target'][0]), 'z': r3(ia['target'][1])},
           'usePos': {'x': r3(ia['use'][0]), 'z': r3(ia['use'][1])},
           'affordances': ia['verbs']}
    if ia['approach']:
        obj['approach'] = {'x': r3(ia['approach'][0]), 'z': r3(ia['approach'][1])}
    if f and f.blocks and ia['furniture'] not in seen:
        obj['footprint'] = fp_json(f.footprint())
        seen.add(ia['furniture'])
    layout['objects'].append(obj)

# purge unused data so the files stay small
for me in list(bpy.data.meshes):
    if me.users == 0:
        bpy.data.meshes.remove(me)
for m in list(bpy.data.materials):
    if m.users == 0:
        bpy.data.materials.remove(m)
for img in list(bpy.data.images):
    if img.users == 0:
        bpy.data.images.remove(img)

room_objs = [o for o in ROOM_COLL.objects if o.type == 'MESH']
tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in room_objs)
draws = sum(len({p.material_index for p in o.data.polygons}) for o in room_objs)
layout['stats'] = {'meshes': len(room_objs), 'triangles': tris, 'drawCalls': draws,
                   'materials': len(bpy.data.materials)}
layout['checks'] = {'errors': errors, 'notes': notes}

# ============================================================================================
# write outputs
# ============================================================================================
os.makedirs(os.path.join(REPO, 'public', 'models'), exist_ok=True)
glb_path = os.path.join(REPO, 'public', 'models', 'room.glb')
json_path = os.path.join(REPO, 'src', 'room-layout.json')
blend_path = os.path.join(REPO, 'assets', 'room.blend')
with open(json_path, 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(layout, fh, indent=2, ensure_ascii=False)
    fh.write('\n')
# No textures are used, so UVs and vertex colours are left out to keep the file small.
gltf_opts = dict(filepath=glb_path, export_format='GLB', export_apply=True, export_extras=True, export_yup=True,
                 export_cameras=False, export_lights=False, export_texcoords=False)
props = bpy.ops.export_scene.gltf.get_rna_type().properties
if 'export_vertex_color' in props:
    gltf_opts['export_vertex_color'] = 'NONE'
elif 'export_colors' in props:
    gltf_opts['export_colors'] = False
bpy.ops.export_scene.gltf(**gltf_opts)

# lights and cameras for the .blend and the previews (not exported)
world = bpy.data.worlds.new('World')
scene.world = world
bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
bg.inputs['Color'].default_value = (0.75, 0.82, 0.92, 1)
bg.inputs['Strength'].default_value = 0.8
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
sun.data.energy = 3.0
sun.data.angle = math.radians(8)
sun.rotation_euler = (math.radians(40), math.radians(-20), math.radians(25))
scene.collection.objects.link(sun)
area = bpy.data.objects.new('RoomLight', bpy.data.lights.new('RoomLight', 'AREA'))
area.data.energy = 500
area.data.size = 4.0
area.location = (0, 0, 2.5)
scene.collection.objects.link(area)


def camera(name, loc, look, fov=45, ortho=None):
    cd = bpy.data.cameras.new(name)
    if ortho:
        cd.type = 'ORTHO'
        cd.ortho_scale = ortho
    else:
        cd.sensor_fit = 'VERTICAL'
        cd.angle = math.radians(fov)
    cam = bpy.data.objects.new(name, cd)
    cam.location = loc
    cam.rotation_euler = (Vector(look) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    scene.collection.objects.link(cam)
    return cam


cams = {
    'overview': camera('Cam_Game', (0, -11, 9), (0, 0, 0.5)),
    'plan': camera('Cam_Plan', (0, 0, 20), (0, 0, 0), ortho=10.8),
    'kitchen': camera('Cam_Kitchen', g2b(-1.5, 2.6, 1.7), g2b(4.6, -0.6, 0.9), fov=60),
    'bedroom': camera('Cam_Bedroom', g2b(0.6, 3.6, 1.8), g2b(-4.2, -2.2, 0.6), fov=60),
}
scene.camera = cams['overview']
# write only the scene and its data, not the UI: saved screens hold local paths from the machine that ran the script
bpy.data.libraries.write(blend_path, {scene}, path_remap='RELATIVE_ALL', compress=True)

if RENDER_DIR:
    os.makedirs(RENDER_DIR, exist_ok=True)
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = 1400, 900
    try:
        scene.eevee.taa_render_samples = 24
    except Exception:
        pass
    scene.view_settings.view_transform = 'Standard'
    bg.inputs['Strength'].default_value = 0.45
    sun.data.energy = 2.2
    area.data.energy = 250
    bpy.data.objects['Walls_Front'].hide_render = True
    for key in ('overview', 'kitchen', 'bedroom'):
        outside = key == 'overview'
        bpy.data.objects['Walls_Right'].hide_render = outside
        bpy.data.objects['FURN_door'].hide_render = outside
        scene.camera = cams[key]
        scene.render.filepath = os.path.join(RENDER_DIR, f'room-{key}.png')
        bpy.ops.render.render(write_still=True)
    # plan view: green = use point (bar shows facing), yellow = approach point
    mk = bpy.data.collections.new('PlanMarkers')
    scene.collection.children.link(mk)

    def marker_mat(name, color):
        m = bpy.data.materials.new(name)
        bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        bsdf.inputs['Emission Color'].default_value = (*srgb(color), 1)
        bsdf.inputs['Emission Strength'].default_value = 3.0
        return m

    g, y = marker_mat('mk_use', '#20c060'), marker_mat('mk_approach', '#f0c020')

    def disc(p, m, r):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=20, radius1=r, radius2=r, depth=0.02)
        me = bpy.data.meshes.new('mk')
        bm.to_mesh(me)
        bm.free()
        me.materials.append(m)
        o = bpy.data.objects.new('mk', me)
        o.location = g2b(p[0], p[1], 2.9)
        mk.objects.link(o)
        return o

    for ia in INTERACTIONS:
        disc(ia['use'], g, 0.09)
        if ia['approach']:
            disc(ia['approach'], y, 0.07)
        hd = heading(ia)
        o = disc((ia['use'][0] + math.sin(hd) * 0.15, ia['use'][1] + math.cos(hd) * 0.15), g, 0.04)
    for n in ('upper_cabinet_a', 'upper_cabinet_b', 'range_hood'):
        bpy.data.objects['FURN_' + n].hide_render = True
    bpy.data.objects['Walls_Right'].hide_render = False
    scene.camera = cams['plan']
    scene.render.resolution_x, scene.render.resolution_y = 1400, 1120
    scene.render.filepath = os.path.join(RENDER_DIR, 'room-plan.png')
    bpy.ops.render.render(write_still=True)

print('ROOM_REPORT_BEGIN')
print('stats:', json.dumps(layout['stats']))
for n in notes:
    print('note:', n)
for e in errors:
    print('ERROR:', e)
print(f'errors: {len(errors)}')
print('glb bytes:', os.path.getsize(glb_path))
print('ROOM_REPORT_END')
sys.exit(1 if errors else 0)
