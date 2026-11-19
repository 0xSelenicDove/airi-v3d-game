/**
 * Skills: how the characters carry out everyday actions, step by step. Each skill implements one or more of
 * the behaviour rules in RULES.md, which every action must follow. tests/skills.test.ts checks each rule.
 */
import type { Vec2 } from '../types'

export type Pose = 'stand' | 'sit' | 'lie' | 'swim'

/** body movements that skills play (they are not offered to the LLM as gestures) */
export const SKILL_MOTIONS = ['reach_handle', 'push_door', 'pull_door', 'shoes', 'move_chair'] as const
export type SkillMotion = (typeof SKILL_MOTIONS)[number]

/** one step of a skill; the agent runs the steps in order (agent.ts, runStep) */
export type Step =
  /** walk on the navigation grid; a route through the house door becomes the door skill */
  | { do: 'walk'; to: Vec2 }
  /** a short straight walk off the grid, already checked to keep clear of furniture (skills/bed.ts) */
  | { do: 'squeeze'; to: Vec2 }
  /** the last step onto a seat, or into the water, as the activity needs */
  | { do: 'onto'; to: Vec2 }
  /** turn to a heading (radians, 0 = +z), or to the door handle on one face of the leaf */
  | { do: 'face'; heading: number; secs: number; toHandle?: 'in' | 'out' }
  /**
   * change pose while moving the body to `at` over `secs` (sitting down on a bed edge, lying down, getting up).
   * Between sitting and standing, the feet stay where they are and the hips swing over them (Agent.rise)
   */
  | { do: 'pose'; pose: Pose; at: Vec2; heading: number; secs: number }
  /**
   * play a body movement over `secs`. It can move the door to `doorTo` (0 shut .. 1 open), keep a hand on the
   * handle (`reach` 'in' or 'out', the face of the leaf), both hands on the feet ('feet') or a hand on the
   * chair's top ('chair'), slide the body to `slide`, slide the seat's chair out to `chairTo` metres, walk with
   * the door's edge (`follow`), and take the shoes off or put them on as it ends
   */
  | { do: 'act'; motion: SkillMotion; secs: number; doorTo?: number; reach?: 'in' | 'out' | 'feet' | 'chair'; slide?: Vec2; chairTo?: number; follow?: boolean; shoes?: 'off' | 'on' }
  /** stop and think, with the thought shown above the head */
  | { do: 'think'; text: string; secs: number }
  /** take the door (wait if someone else has it) or let it go */
  | { do: 'door'; take: boolean }
  /** start the activity this plan was for */
  | { do: 'use' }
  /** blocked: look for another way round to `to`, or wait and try again (skills/detour.ts) */
  | { do: 'reroute'; to: Vec2; exact: boolean }

export interface Rule {
  id: string
  rule: string
  /** where it is implemented */
  skill: string
}

/** the rules every action must follow (mirrors RULES.md) */
export const RULES: Rule[] = [
  { id: 'R0', rule: 'Nothing passes through anything else: people, furniture, walls, the door and props never overlap.', skill: 'agent.ts (avoid, crowds), skills/door.ts, skills/detour.ts, physics.ts' },
  { id: 'R1', rule: 'Take the shoes off before lying down in a bed, and put them back on after getting up.', skill: 'skills/bed.ts' },
  { id: 'R2', rule: 'Walk to the side of the bed, sit down on its edge, then lie down; get up the same way in reverse.', skill: 'skills/bed.ts' },
  { id: 'R3', rule: 'To pass the door: reach for the handle, open it slowly, go through, turn round and close it.', skill: 'skills/door.ts' },
  { id: 'R4', rule: 'When the way is blocked, stop and think whether to take another route; never push through.', skill: 'skills/detour.ts' },
]
