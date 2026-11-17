/**
 * Skill: finding another way when blocked (rule R4).
 *
 * A walker that cannot move on for a moment stops and thinks. If there is another route round whatever is in
 * the way, it takes that; otherwise it waits for the way to clear and tries again. It never pushes through
 * people or things (R0), and after a few tries it gives up and decides on something else.
 */
import type { Vec2 } from '../types'
import type { World } from '../world'
import { dist } from '../world'

/** seconds stuck before stopping to think */
export const STUCK_THINK = 1.0
/** how many times to look for a way round (with waits in between) before giving up */
export const DETOUR_TRIES = 4
/** seconds to wait for the way to clear when there is no other route */
export const DETOUR_WAIT = 2.5
/** keep this far from whatever was in the way when planning round it */
const AROUND = 0.75

export const THINK_BLOCKED = 'Something is in the way. Is there another way round?'
export const THINK_WAIT = 'No other way. I will wait for it to clear.'
export const THINK_GIVE_UP = 'I cannot get through here. I will do something else.'

/**
 * Another route from `from` to `to` that keeps clear of `blockers`, or null if there is none worth taking
 * (none at all, or one more than three times as long as going straight).
 */
export function routeAround(world: World, from: Vec2, to: Vec2, blockers: Vec2[]): Vec2[] | null {
  const path = world.route(from, to, blockers.map(b => ({ x: b.x, z: b.z, r: AROUND })))
  if (!path) return null
  let len = 0, prev = from
  for (const p of path) { len += dist(prev, p); prev = p }
  return len <= 3 * dist(from, to) + 4 ? path : null
}
