/**
 * Skill: going through the house door (rule R3).
 *
 * The door opens outward (into the yard), and the hand stays on the handle while the door moves:
 * - going out: stand at the door with a hand on the handle, push it open while stepping into the doorway, let it
 *   swing open, walk out and round its edge, take the handle again, and walk with the door as it closes.
 * - coming in: stand beside the door, outside its swing, with a hand on the handle; walk back with the door as it
 *   opens, walk in, turn round in the doorway as the door swings back on its closer, take the inside handle and
 *   pull it shut while stepping back in.
 * Only one person uses the door at a time, nobody walks through it unless it is open, and the leaf never sweeps
 * through anybody (R0).
 */
import type { Vec2, Vec3 } from '../types'
import type { World } from '../world'
import { dist } from '../world'
import type { Step } from './index'

/**
 * The door leaf, matching DOOR_leaf in public/models/room.glb: hinged on the south jamb of the doorway in the
 * right-hand wall, 0.86 m wide, opening 100 degrees outward (towards +x). main.ts warns when the model differs.
 */
export const DOOR_LEAF = { width: 0.86, openDeg: 100, hingeOffset: { x: 0.05, z: -0.43 } }
/** the handle: this far in from the leaf's free edge, at this height, standing out this far from either face */
const HANDLE = { in: 0.07, y: 0.95, out: 0.05 }
/**
 * people walking with the door keep this far from the hinge: clear of the leaf (0.86 m) by a body's half width and
 * a little more, yet within an arm's reach (about 0.48 m on small VRoid avatars) of the handle (0.79 m)
 */
const FOLLOW_R = 1.2
/** how far the door is pushed by hand when going out, and pulled by hand when closing from inside: within reach */
const PUSHED = 0.3
/** seconds to open or close it by hand: slowly */
export const DOOR_SECS = 1.6

export function hinge(world: World): Vec2 {
  return { x: world.door.x + DOOR_LEAF.hingeOffset.x, z: world.door.z + DOOR_LEAF.hingeOffset.z }
}

const angle = (open: number) => (DOOR_LEAF.openDeg * Math.PI / 180) * open

/** the leaf as a segment from the hinge to its free edge, for a door that is `open` (0..1) */
export function leaf(world: World, open: number): [Vec2, Vec2] {
  const h = hinge(world), a = angle(open)
  // shut, the leaf runs along +z from the hinge; opening turns it towards +x
  return [h, { x: h.x + Math.sin(a) * DOOR_LEAF.width, z: h.z + Math.cos(a) * DOOR_LEAF.width }]
}

/** where the handle is on the inside or the outside face of the leaf */
export function handle(world: World, open: number, face: 'in' | 'out'): Vec3 {
  const h = hinge(world), a = angle(open), r = DOOR_LEAF.width - HANDLE.in
  // the outside face points along +x when shut, turning with the leaf
  const nx = Math.cos(a), nz = -Math.sin(a), s = face === 'out' ? HANDLE.out : -HANDLE.out
  return { x: h.x + Math.sin(a) * r + nx * s, y: HANDLE.y, z: h.z + Math.cos(a) * r + nz * s }
}

/** a spot outside, beside the leaf at the angle of a door that is `open`, clear of its swing */
export function besideDoor(world: World, open: number): Vec2 {
  const h = hinge(world), a = angle(open)
  return { x: h.x + Math.sin(a) * FOLLOW_R, z: h.z + Math.cos(a) * FOLLOW_R }
}

/** is `p` where the leaf swings (outside the wall, within its width of the hinge), with a body's margin? */
export function inSwing(world: World, p: Vec2) {
  return p.x >= world.door.x - 0.05 && dist(p, hinge(world)) <= DOOR_LEAF.width + 0.3
}

/** the spots on either side */
export function doorSpots(world: World) {
  const d = world.door
  return {
    /** inside, facing the door, the handle within arm's reach (and clear of the coat rack) */
    inside: { x: d.x - 0.35, z: d.z + 0.1 },
    /** in the doorway, at the wall's inner face */
    threshold: { x: d.x, z: d.z + 0.15 },
    /** just outside the doorway, clear of the open leaf */
    sill: { x: d.x + 0.4, z: d.z + 0.15 },
    /** outside, round the free edge of the open leaf */
    round: { x: d.x + 1.3, z: d.z },
    /** outside, waiting for the door: clear of its swing */
    outside: besideDoor(world, 0.15),
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

/**
 * Steps to get from `from` through the door. The final walk is left to the caller's route, so this ends on the
 * far side.
 */
export function throughDoor(world: World, from: Vec2): Step[] {
  const s = doorSpots(world)
  if (insideHouse(world, from)) {
    return [
      // take the door before walking up to it, so nobody else is waiting on the spot we need
      { do: 'door', take: true },
      { do: 'walk', to: s.inside },
      { do: 'face', heading: Math.PI / 2, secs: 0.4 },
      { do: 'act', motion: 'reach_handle', secs: 0.6, reach: 'in' },
      // push it open by the handle, stepping into the doorway with it; then it swings open by itself
      { do: 'act', motion: 'push_door', secs: 1.3, doorTo: PUSHED, reach: 'in', slide: s.threshold },
      { do: 'act', motion: 'push_door', secs: 0.8, doorTo: 1 },
      { do: 'squeeze', to: s.sill },
      { do: 'squeeze', to: s.round },
      { do: 'squeeze', to: besideDoor(world, 1) },
      // turn round, take the handle, and walk with the door as it closes
      { do: 'face', heading: 0, secs: 0.5, toHandle: 'out' },
      { do: 'act', motion: 'reach_handle', secs: 0.5, reach: 'out' },
      { do: 'act', motion: 'pull_door', secs: DOOR_SECS, doorTo: 0.15, reach: 'out', follow: true },
      { do: 'act', motion: 'pull_door', secs: 0.4, doorTo: 0 },
      { do: 'door', take: false },
    ]
  }
  return [
    { do: 'door', take: true },
    { do: 'walk', to: s.outside },
    { do: 'face', heading: 0, secs: 0.4, toHandle: 'out' },
    { do: 'act', motion: 'reach_handle', secs: 0.6, reach: 'out' },
    // pull it open by the handle, walking back with it, clear of its swing
    { do: 'act', motion: 'pull_door', secs: DOOR_SECS, doorTo: 1, reach: 'out', follow: true },
    { do: 'squeeze', to: s.round },
    { do: 'squeeze', to: s.sill },
    { do: 'squeeze', to: s.threshold },
    // turn round in the doorway; the door swings back towards it on its closer while the hand reaches out, then
    // the hand takes the inside handle and pulls the door shut, stepping back in as it comes
    { do: 'face', heading: Math.PI / 2, secs: 0.5 },
    { do: 'act', motion: 'reach_handle', secs: 1.0, doorTo: PUSHED },
    { do: 'act', motion: 'pull_door', secs: 1.2, doorTo: 0, reach: 'in', slide: s.inside },
    { do: 'door', take: false },
  ]
}
