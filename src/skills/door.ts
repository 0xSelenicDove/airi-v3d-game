/**
 * Skill: going through the house door (rule R3).
 *
 * Reach for the handle, open the door slowly, walk through, turn round, reach for the handle and close the
 * door slowly. The door opens outward (into the yard), so going out you push it, and coming in you stand clear
 * of its swing and pull it. Only one person uses the door at a time, and nobody walks through it while it is
 * shut or moving (R0).
 */
import type { Vec2 } from '../types'
import type { World } from '../world'
import { dist } from '../world'
import type { Step } from './index'

/**
 * The door leaf, matching DOOR_leaf in public/models/room.glb: hinged on the south jamb of the doorway in the
 * right-hand wall, 0.86 m wide, opening 100 degrees outward (towards +x). main.ts warns when the model differs.
 */
export const DOOR_LEAF = { width: 0.86, openDeg: 100, hingeOffset: { x: 0.05, z: -0.43 } }
/** seconds to open or close it: slowly, by hand */
export const DOOR_SECS = 1.6

export function hinge(world: World): Vec2 {
  return { x: world.door.x + DOOR_LEAF.hingeOffset.x, z: world.door.z + DOOR_LEAF.hingeOffset.z }
}

/** the leaf as a segment from the hinge to its free edge, for a door that is `open` (0..1) */
export function leaf(world: World, open: number): [Vec2, Vec2] {
  const h = hinge(world), a = (DOOR_LEAF.openDeg * Math.PI / 180) * open
  // shut, the leaf runs along +z from the hinge; opening turns it towards +x
  return [h, { x: h.x + Math.sin(a) * DOOR_LEAF.width, z: h.z + Math.cos(a) * DOOR_LEAF.width }]
}

/** is `p` where the leaf swings (outside the wall, within its width of the hinge), with a body's margin? */
export function inSwing(world: World, p: Vec2) {
  return p.x >= world.door.x - 0.05 && dist(p, hinge(world)) <= DOOR_LEAF.width + 0.3
}

/** the spots to stand at on either side: inside clear of the wall, outside clear of the leaf's swing */
export function doorSpots(world: World) {
  const d = world.door
  return {
    inside: { x: d.x - 0.65, z: d.z },
    /** the doorway itself, just outside the wall */
    sill: { x: d.x + 0.4, z: d.z + 0.15 },
    outside: { x: d.x + 1.0, z: d.z + 0.6 },
  }
}

/** inside the house walls (the yard and the meadow are outside) */
export const insideHouse = (world: World, p: Vec2) => Math.abs(p.x) < world.bounds.w / 2 && Math.abs(p.z) < world.bounds.d / 2

/** does walking along `path` (starting at `from`) take you through the house door? */
export function crossesDoor(world: World, from: Vec2, path: Vec2[]) {
  let prev = from
  for (const p of path) {
    if (insideHouse(world, prev) !== insideHouse(world, p)) return true
    prev = p
  }
  return false
}

/** turn to face point `p` from point `from` */
const facing = (from: Vec2, p: Vec2) => Math.atan2(p.x - from.x, p.z - from.z)

/**
 * Steps to get from `from` to `to` through the door: walk to the near side, use the door, and walk on.
 * The final walk is left to the caller's route, so this ends on the far side.
 */
export function throughDoor(world: World, from: Vec2): Step[] {
  const s = doorSpots(world)
  const [, handleShut] = leaf(world, 0)
  const goingOut = insideHouse(world, from)
  if (goingOut) {
    const [, handleOpen] = leaf(world, 1)
    return [
      // take the door before walking up to it, so nobody else is waiting on the spot we need
      { do: 'door', take: true },
      { do: 'walk', to: s.inside },
      { do: 'face', heading: facing(s.inside, { x: world.door.x, z: world.door.z }), secs: 0.4 },
      { do: 'act', motion: 'reach_handle', secs: 0.6 },
      { do: 'act', motion: 'push_door', secs: DOOR_SECS, door: 'open' },
      { do: 'squeeze', to: s.sill },
      { do: 'squeeze', to: s.outside },
      { do: 'face', heading: facing(s.outside, handleOpen), secs: 0.6 },
      { do: 'act', motion: 'reach_handle', secs: 0.5 },
      { do: 'act', motion: 'pull_door', secs: DOOR_SECS, door: 'close' },
      { do: 'door', take: false },
    ]
  }
  return [
    { do: 'door', take: true },
    { do: 'walk', to: s.outside },
    { do: 'face', heading: facing(s.outside, handleShut), secs: 0.4 },
    { do: 'act', motion: 'reach_handle', secs: 0.6 },
    { do: 'act', motion: 'pull_door', secs: DOOR_SECS, door: 'open' },
    { do: 'squeeze', to: s.sill },
    { do: 'squeeze', to: s.inside },
    { do: 'face', heading: facing(s.inside, { x: world.door.x, z: world.door.z }), secs: 0.6 },
    { do: 'act', motion: 'reach_handle', secs: 0.5 },
    { do: 'act', motion: 'push_door', secs: DOOR_SECS, door: 'close' },
    { do: 'door', take: false },
  ]
}
