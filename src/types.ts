export type Vec2 = { x: number; z: number }

export type NeedName = 'energy' | 'fun' | 'knowledge'
export type Needs = Record<NeedName, number> // 0..100, higher = better

export interface Affordance {
  verb: string
  /** game minutes the activity takes */
  duration: number
  /** total change applied to needs over the duration */
  effects: Partial<Needs>
  /** animation pose hint for the renderer */
  pose: 'sit' | 'lie' | 'stand'
}

export interface WorldObject {
  id: string
  kind: string
  pos: Vec2
  /** where an agent stands/sits when using it */
  usePos: Vec2
  affordances: Affordance[]
  /** floor area that blocks walking (axis-aligned rectangle); omit for walk-through things like chairs */
  footprint?: { cx: number; cz: number; w: number; d: number }
  /** where to walk to before stepping onto usePos (needed when usePos is inside the footprint) */
  approach?: Vec2
}

export type Action = (
  | { type: 'interact'; object: string; verb: string }
  | { type: 'say'; text: string }
  | { type: 'wait'; minutes: number }
) & { /** short inner monologue, shown in the HUD */ thought?: string }

/** What the world needs to know about an agent (avoids a circular import with agent.ts). */
export interface Inhabitant {
  name: string
  pos: Vec2
  activity: string
  hear(from: string, text: string): void
}

export interface Observation {
  time: string // "Day 1 14:05"
  hour: number
  location: string
  needs: Needs
  objects: { id: string; kind: string; verbs: string[]; inUseBy?: string }[]
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
