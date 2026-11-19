export type Vec2 = { x: number; z: number }
export type Vec3 = { x: number; y: number; z: number }

/** physical space queries; set on the World once the physics engine is ready (see physics.ts) */
export interface Space {
  /** is the segment from `from` along `dir` (normalised here) free of solid things for `reach` metres? */
  isClear(from: Vec3, dir: Vec3, reach: number, ignore?: string): boolean
}

export type NeedName = 'energy' | 'fun' | 'knowledge'
export type Needs = Record<NeedName, number> // 0..100, higher = better

export interface Affordance {
  verb: string
  /** game minutes the activity takes */
  duration: number
  /** total change applied to needs over the duration */
  effects: Partial<Needs>
  /** animation pose hint for the renderer */
  pose: 'sit' | 'lie' | 'stand' | 'swim'
  /** only available from hour `[0]` up to (not including) `[1]`; may wrap past midnight, e.g. [20, 5] */
  hours?: [number, number]
  /** swim or row round a loop while doing it: a circle of this radius (m), or an ellipse with `orbitZ` as its z radius.
   * The use point is on the loop, due east of its centre. */
  orbit?: number
  orbitZ?: number
  /** keep going after the time is up until the loop is finished, back at the use point (so a boat returns to its mooring) */
  lap?: boolean
  /** m/s along the loop (default 0.6) */
  speed?: number
}

/** axis-aligned floor rectangle */
export type Footprint = { cx: number; cz: number; w: number; d: number }

/** a chair or stool at a table: it slides out to sit down and back in afterwards (skills/seat.ts) */
export interface TableChair {
  /** its furniture id (the key of World.chairOut) and its node in the room model */
  furniture: string
  node: string
  /** its centre when pushed in, and the way it slides out (a unit vector away from the table) */
  at: Vec2
  out: Vec2
  /** its size across the way it slides, and along it; the height of its top (a backrest or the seat) */
  w: number
  d: number
  top: number
}

export interface WorldObject {
  id: string
  kind: string
  pos: Vec2
  /** where an agent stands/sits when using it */
  usePos: Vec2
  affordances: Affordance[]
  /** floor area that blocks walking (axis-aligned rectangle); omit for things one can walk through */
  footprint?: Footprint
  /** where to walk to before stepping onto usePos (needed when usePos is inside the footprint) */
  approach?: Vec2
  /** the chair to pull out, for a seat at a table */
  chair?: TableChair
  /** in the yard rather than in the house */
  outdoors?: boolean
}

export type Action = (
  | { type: 'interact'; object: string; verb: string }
  | { type: 'say'; text: string }
  | { type: 'wait'; minutes: number }
  /** act something out on the spot, e.g. "wave_right" or "nod" (see acting.ts) */
  | { type: 'gesture'; gesture: string }
) & {
  /** short inner monologue, shown in the HUD */
  thought?: string
  /** facial emotion to show with the action, e.g. "happy" (see acting.ts) */
  emotion?: string
  /** a gesture to make while speaking */
  gesture?: string
}

/** What the world needs to know about an agent (avoids a circular import with agent.ts). */
export interface Inhabitant {
  name: string
  pos: Vec2
  /** sitting and lying inhabitants are on furniture, off the walkable floor */
  pose: 'stand' | 'sit' | 'lie' | 'swim'
  /** where it is walking to, or where it stands for an activity */
  dest?: Vec2
  activity: string
  hear(from: string, text: string): void
}

export interface Observation {
  time: string // "Day 1 14:05"
  hour: number
  location: string
  /** where you are: in the house, the fenced yard, or the meadow beyond the gate (campfire, tent, pond) */
  place: 'house' | 'yard' | 'meadow'
  needs: Needs
  objects: { id: string; kind: string; verbs: string[]; inUseBy?: string; /** set for things in the yard */ outside?: true }[]
  /** other inhabitants and what they are doing */
  others: { name: string; activity: string; distance: number }[]
  /** things said nearby since your last decision */
  heard: string[]
  yourBed: string
  /** memories recalled as relevant to the current situation, oldest first */
  memories: string[]
  /** your own higher-level conclusions about your life so far */
  insights: string[]
  /** result of the previous action, including validation errors */
  lastResult?: string
  recentMemory: string[]
}

export interface Brain {
  decide(persona: Persona, obs: Observation): Promise<Action>
  /** Turn recent memories into 1-3 higher-level insights. Optional: without it, no reflection happens. */
  reflect?(persona: Persona, memories: string[]): Promise<string[]>
}

export interface Persona {
  name: string
  description: string
  color: number
  /** hours of day this agent prefers to sleep, e.g. [0, 8] */
  sleepWindow: [number, number]
  /** id of the bed this agent sleeps in */
  bed: string
}
