/**
 * Skills: how the characters carry out everyday actions, step by step. Each skill implements one or more of
 * the behaviour rules in RULES.md, which every action must follow. tests/skills.test.ts checks each rule.
 */
import type { Vec2 } from '../types'

export type Pose = 'stand' | 'sit' | 'lie' | 'swim'

/** body movements that skills play (they are not offered to the LLM as gestures) */
export const SKILL_MOTIONS = ['reach_handle', 'push_door', 'pull_door', 'shoes'] as const
export type SkillMotion = (typeof SKILL_MOTIONS)[number]

/** one step of a skill; the agent runs the steps in order (agent.ts, runStep) */
export type Step =
  /** walk on the navigation grid; a route through the house door becomes the door skill */
  | { do: 'walk'; to: Vec2 }
  /** a short straight walk off the grid, already checked to keep clear of furniture (skills/bed.ts) */
  | { do: 'squeeze'; to: Vec2 }
  /** the last step onto a seat, or into the water, as the activity needs */
  | { do: 'onto'; to: Vec2 }
  /** turn to a heading (radians, 0 = +z) */
  | { do: 'face'; heading: number; secs: number }
  /** change pose while moving the body to `at` over `secs` (sitting down on a bed edge, lying down, getting up) */
  | { do: 'pose'; pose: Pose; at: Vec2; heading: number; secs: number }
  /** play a body movement; it can move the door or take the shoes off or on as it ends */
  | { do: 'act'; motion: SkillMotion; secs: number; door?: 'open' | 'close'; shoes?: 'off' | 'on' }
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
