"""Model the interactive props for the Unity game: every part that moves is its own object.

Run from the repository root:

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/blender/build_props.py -- --repo .

Outputs one .glb per prop in Assets/Art/Props/. Unity imports them with UniGLTF, and
Assets/Scripts/Editor/SliceSceneBuilder.cs adds the joints by node name:

    <Prop>                 the fixed body (a static collider)
      <Prop>.Hinge.<Part>  a part that swings; its origin is on the hinge axis, the axis is vertical (Blender z)
                           unless the name ends in ".X" (a lid that swings about the left-right axis)
      <Prop>.Soft.<Part>   cloth (the blanket): Unity gives it a Cloth component

Every prop is built facing Blender -Y (its front). Edges are bevelled and big panels get a few
loop cuts, so nothing reads as a raw box.
"""

import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
REPO = os.path.abspath(argv[argv.index('--repo') + 1] if '--repo' in argv else '.')
OUT = os.path.join(REPO, 'Assets', 'Art', 'Props')
os.makedirs(OUT, exist_ok=True)

_mats = {}


def mat(name, rgb, rough=0.6, metal=0.0):
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    _mats[name] = m
    return m


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _mats.clear()


def world_origin(ob):
    """an object's origin in world space (nothing here is rotated, and matrix_world is stale until the view layer updates)"""
    p = Vector((0, 0, 0))
    while ob is not None:
        p += ob.location
        ob = ob.parent
    return p


def box(name, size, center, material, bevel=0.012, segments=3, parent=None, origin=None):
    """a bevelled box; `origin` (world) is where the object's pivot goes (default: its centre)"""
    sx, sy, sz = size
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((sx, sy, sz)), verts=bm.verts)
    if bevel > 0:
        b = min(bevel, min(size) * 0.45)
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=b, segments=segments, affect='EDGES', profile=0.5)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(material)
    pivot = Vector(origin) if origin is not None else Vector(center)
    # mesh is built around (0,0,0): shift it so the pivot is the object's origin
    off = Vector(center) - pivot
    me.transform(__import__('mathutils').Matrix.Translation(off))
    ob.location = pivot
    if parent is not None:
        ob.parent = parent
        ob.location = pivot - world_origin(parent)
    return ob


def cylinder(name, r, depth, center, material, axis='Z', parent=None, verts=24):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=r, radius2=r, depth=depth)
    if axis == 'X':
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=__import__('mathutils').Matrix.Rotation(math.pi / 2, 3, 'Y'))
    elif axis == 'Y':
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=__import__('mathutils').Matrix.Rotation(math.pi / 2, 3, 'X'))
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(material)
    ob.location = Vector(center)
    if parent is not None:
        ob.parent = parent
        ob.location = Vector(center) - world_origin(parent)
    return ob


def empty(name, loc=(0, 0, 0), parent=None):
    ob = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    if parent is not None:
        ob.parent = parent
    return ob


def export(name):
    bpy.context.view_layer.update()
    path = os.path.join(OUT, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_yup=True, export_apply=True,
                              export_extras=True)
    print(f'[props] wrote {path}')


# ---------------------------------------------------------------- fridge (0.7 w, 0.7 d, 1.8 h)
def fridge():
    clear()
    white = mat('fridge_white', (0.92, 0.93, 0.94), 0.35)
    steel = mat('steel', (0.75, 0.76, 0.78), 0.25, 1.0)
    inner = mat('fridge_inside', (0.97, 0.98, 1.0), 0.5)
    glass = mat('shelf_glass', (0.8, 0.9, 0.95), 0.05)
    W, D, H, T = 0.7, 0.66, 1.8, 0.04
    root = empty('Fridge')
    # an open box: back, sides, top, bottom; the front is the door
    box('Fridge.Back', (W, T, H), (0, D / 2 - T / 2, H / 2), white, parent=root)
    box('Fridge.Left', (T, D, H), (-W / 2 + T / 2, 0, H / 2), white, parent=root)
    box('Fridge.Right', (T, D, H), (W / 2 - T / 2, 0, H / 2), white, parent=root)
    box('Fridge.Top', (W, D, T), (0, 0, H - T / 2), white, parent=root)
    box('Fridge.Bottom', (W, D, 0.08), (0, 0, 0.04), white, parent=root)
    box('Fridge.Liner', (W - 2 * T - 0.004, 0.005, H - 0.14), (0, D / 2 - T - 0.003, H / 2), inner, bevel=0, parent=root)
    for i, z in enumerate((0.45, 0.85, 1.25)):
        box(f'Fridge.Shelf{i}', (W - 2 * T - 0.01, D - T - 0.08, 0.01), (0, 0.02, z), glass, bevel=0.003, parent=root)
    # door: hinge on the right front edge (seen from the front, -Y)
    hinge = Vector((W / 2, -D / 2, 0))
    door = box('Fridge.Hinge.Door', (W, 0.06, H - 0.02), (0, -D / 2 - 0.03, H / 2), white, bevel=0.02,
               parent=root, origin=hinge)
    box('Fridge.Door.Handle', (0.03, 0.04, 0.5), (-W / 2 + 0.07, -D / 2 - 0.085, 1.1), steel, bevel=0.01, parent=door)
    box('Fridge.Door.Gasket', (W - 0.04, 0.012, H - 0.06), (0, -D / 2 + 0.004, H / 2), mat('gasket', (0.2, 0.2, 0.2), 0.8),
        bevel=0.004, parent=door)
    # a few things inside
    box('Fridge.Milk', (0.08, 0.08, 0.2), (-0.15, 0.05, 0.56), mat('milk', (0.95, 0.95, 0.9)), bevel=0.01, parent=root)
    cylinder('Fridge.Jar', 0.05, 0.12, (0.12, 0.08, 0.92), mat('jar', (0.9, 0.4, 0.2), 0.2), parent=root)
    export('Fridge')


# ---------------------------------------------------------------- laptop (0.34 w, 0.24 d)
def laptop():
    clear()
    alu = mat('laptop_alu', (0.62, 0.64, 0.68), 0.3, 0.9)
    keys = mat('laptop_keys', (0.08, 0.08, 0.09), 0.7)
    screen = mat('laptop_screen', (0.05, 0.07, 0.1), 0.1)
    W, D, Tb, Tl = 0.34, 0.24, 0.016, 0.008
    root = empty('Laptop')
    box('Laptop.Base', (W, D, Tb), (0, 0, Tb / 2), alu, bevel=0.006, parent=root)
    box('Laptop.Keys', (W - 0.04, 0.1, 0.002), (0, -0.01, Tb + 0.001), keys, bevel=0.001, parent=root)
    box('Laptop.Pad', (0.1, 0.06, 0.001), (0, -0.085, Tb + 0.0005), mat('pad', (0.55, 0.57, 0.6), 0.3, 0.8), bevel=0.0005,
        parent=root)
    # lid: hinge along the back edge, swings about the left-right axis; built closed (lying on the base)
    hinge = Vector((0, D / 2, Tb))
    lid = box('Laptop.Hinge.Lid.X', (W, D, Tl), (0, 0, Tb + Tl / 2 + 0.001), alu, bevel=0.004, parent=root, origin=hinge)
    # the screen is on the underside of the closed lid
    box('Laptop.Lid.Screen', (W - 0.02, D - 0.03, 0.001), (0, 0.005, Tb + 0.0005), screen, bevel=0, parent=lid)
    export('Laptop')


# ---------------------------------------------------------------- door in its frame (0.9 x 2.05 opening)
def door():
    clear()
    wood = mat('door_wood', (0.78, 0.66, 0.5), 0.55)
    frame_m = mat('door_frame', (0.95, 0.94, 0.92), 0.5)
    brass = mat('brass', (0.85, 0.7, 0.35), 0.25, 1.0)
    W, H, T, F = 0.9, 2.05, 0.045, 0.06
    root = empty('Door')
    box('Door.FrameL', (F, 0.14, H + F), (-W / 2 - F / 2, 0, (H + F) / 2), frame_m, bevel=0.008, parent=root)
    box('Door.FrameR', (F, 0.14, H + F), (W / 2 + F / 2, 0, (H + F) / 2), frame_m, bevel=0.008, parent=root)
    box('Door.FrameTop', (W + 2 * F, 0.14, F), (0, 0, H + F / 2), frame_m, bevel=0.008, parent=root)
    # leaf: hinge on the left edge
    hinge = Vector((-W / 2, 0, 0))
    leaf = box('Door.Hinge.Leaf', (W - 0.006, T, H - 0.01), (0, 0, H / 2), wood, bevel=0.006, parent=root, origin=hinge)
    # raised panels on both faces
    for side in (-1, 1):
        for z in (0.55, 1.45):
            box(f'Door.Leaf.Panel{side}{z}', (W - 0.24, 0.006, 0.7), (0, side * (T / 2 + 0.002), z), wood, bevel=0.003,
                parent=leaf)
        # lever handles
        box(f'Door.Leaf.Rose{side}', (0.05, 0.01, 0.12), (W / 2 - 0.08, side * (T / 2 + 0.005), 1.0), brass, bevel=0.004,
            parent=leaf)
        box(f'Door.Leaf.Lever{side}', (0.13, 0.02, 0.02), (W / 2 - 0.13, side * (T / 2 + 0.03), 1.02), brass, bevel=0.008,
            parent=leaf)
    empty('Door.HandleFront', (W / 2 - 0.15, -(T / 2 + 0.04), 1.02), parent=leaf)
    empty('Door.HandleBack', (W / 2 - 0.15, (T / 2 + 0.04), 1.02), parent=leaf)
    export('Door')


# ---------------------------------------------------------------- bed (0.95 w, 2.05 l), head at +Y
def bed():
    clear()
    wood = mat('bed_wood', (0.55, 0.38, 0.25), 0.6)
    sheet = mat('sheet', (0.94, 0.94, 0.92), 0.9)
    blanket_m = mat('blanket', (0.42, 0.55, 0.75), 0.95)
    pillow_m = mat('pillow', (0.97, 0.96, 0.93), 0.9)
    W, L = 0.95, 2.05
    root = empty('Bed')
    box('Bed.Frame', (W + 0.06, L + 0.06, 0.28), (0, 0, 0.18), wood, bevel=0.02, parent=root)
    box('Bed.Headboard', (W + 0.06, 0.06, 0.9), (0, L / 2 + 0.03, 0.45), wood, bevel=0.025, parent=root)
    for x in (-1, 1):
        for y in (-1, 1):
            box(f'Bed.Leg{x}{y}', (0.06, 0.06, 0.06), (x * W / 2, y * L / 2, 0.03), wood, bevel=0.01, parent=root)
    box('Bed.Mattress', (W, L, 0.2), (0, 0, 0.42), sheet, bevel=0.06, segments=4, parent=root)
    box('Bed.Pillow', (0.6, 0.38, 0.12), (0, L / 2 - 0.25, 0.58), pillow_m, bevel=0.05, segments=4, parent=root)
    # blanket: a subdivided sheet lying on the mattress, overhanging the sides; Unity simulates it as cloth
    me = bpy.data.meshes.new('Bed.Soft.Blanket')
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=18, y_segments=29, size=0.5)
    # 1.75 m long: enough to lie over a body from the chest and still cover the feet
    bmesh.ops.scale(bm, vec=Vector((W + 0.3, 1.75, 1)), verts=bm.verts)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    bl = bpy.data.objects.new('Bed.Soft.Blanket', me)
    bpy.context.scene.collection.objects.link(bl)
    me.materials.append(blanket_m)
    bl.location = (0, -0.4, 0.535)
    bl.parent = root   # one sheet of vertices (no thickness): cloth needs a single layer; Unity draws it double-sided
    export('Bed')


# ---------------------------------------------------------------- desk (1.2 w, 0.6 d, 0.74 h) and chair (seat 0.46)
def desk():
    clear()
    wood = mat('desk_wood', (0.72, 0.56, 0.4), 0.5)
    leg = mat('desk_leg', (0.18, 0.18, 0.2), 0.4, 0.6)
    W, D, H = 1.2, 0.6, 0.74
    root = empty('Desk')
    box('Desk.Top', (W, D, 0.03), (0, 0, H - 0.015), wood, bevel=0.01, parent=root)
    for x in (-1, 1):
        for y in (-1, 1):
            box(f'Desk.Leg{x}{y}', (0.04, 0.04, H - 0.03), (x * (W / 2 - 0.05), y * (D / 2 - 0.05), (H - 0.03) / 2), leg,
                bevel=0.01, parent=root)
    box('Desk.Rail', (W - 0.1, 0.02, 0.08), (0, D / 2 - 0.05, H - 0.07), leg, bevel=0.005, parent=root)
    export('Desk')


def chair():
    clear()
    wood = mat('chair_wood', (0.6, 0.45, 0.32), 0.5)
    cushion = mat('chair_cushion', (0.75, 0.42, 0.35), 0.9)
    S, H = 0.44, 0.46
    root = empty('Chair')
    box('Chair.Seat', (S, S, 0.04), (0, 0, H - 0.02), wood, bevel=0.012, parent=root)
    box('Chair.Cushion', (S - 0.04, S - 0.04, 0.03), (0, 0, H + 0.015), cushion, bevel=0.014, segments=4, parent=root)
    for x in (-1, 1):
        for y in (-1, 1):
            box(f'Chair.Leg{x}{y}', (0.035, 0.035, H - 0.04), (x * (S / 2 - 0.03), y * (S / 2 - 0.03), (H - 0.04) / 2),
                wood, bevel=0.008, parent=root)
    # back at +Y (the chair faces -Y)
    for x in (-1, 1):
        box(f'Chair.Post{x}', (0.035, 0.035, 0.45), (x * (S / 2 - 0.03), S / 2 - 0.02, H + 0.225), wood, bevel=0.008,
            parent=root)
    box('Chair.Back', (S - 0.02, 0.025, 0.2), (0, S / 2 - 0.02, H + 0.33), wood, bevel=0.01, parent=root)
    export('Chair')


fridge()
laptop()
desk()
chair()
door()
bed()
print('[props] done')
