/**
 * How a person moves: each character gets a walking and standing style of its own (from its name, so it stays the
 * same between visits), and the style drifts a little over time, so no two strides and no two idle moments look
 * exactly the same.
 */

/** a person's way of moving; amplitudes are bone angles in radians */
export interface MotionStyle {
  /** walk-cycle phase per second at walking speed (about 0.8 to 1 stride per second) */
  cadence: number
  /** how far the thighs swing forward and back */
  stride: number
  /** how high the knee folds in the swing */
  knee: number
  /** how far the arms swing */
  armSwing: number
  /** how far the arms hang out from the sides */
  armOut: number
  /** how much the elbows bend */
  elbow: number
  /** how much the chest turns against the hips */
  twist: number
  /** leaning forward while walking */
  lean: number
  /** the hips dropping on the side of the swinging leg */
  hipDrop: number
  /** the body bobbing up and down with the steps, in metres */
  bounce: number
  /** standing: how far the weight shifts from foot to foot */
  idleSway: number
  /** how fast this person's style drifts (the drift's period is about 1 / this, in seconds) */
  drift: number
}

/** a small seeded random generator (mulberry32), so a name always gives the same style */
export function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** a 32-bit hash of a string (FNV-1a) */
export function hash(text: string) {
  let h = 0x811C9DC5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** the range each style value is picked from */
export const STYLE_RANGE: { [K in keyof MotionStyle]: [number, number] } = {
  cadence: [5.2, 6.3],
  stride: [0.48, 0.66],
  knee: [0.8, 1.05],
  armSwing: [0.32, 0.6],
  armOut: [1.2, 1.36],
  elbow: [0.35, 0.6],
  twist: [0.06, 0.13],
  lean: [0.03, 0.09],
  hipDrop: [0.03, 0.07],
  bounce: [0.02, 0.035],
  idleSway: [0.01, 0.03],
  drift: [0.12, 0.25],
}

/** the style of the person called `name` */
export function styleFor(name: string): MotionStyle {
  const rnd = seeded(hash(name))
  const out = {} as MotionStyle
  for (const key of Object.keys(STYLE_RANGE) as (keyof MotionStyle)[]) {
    const [lo, hi] = STYLE_RANGE[key]
    out[key] = lo + (hi - lo) * rnd()
  }
  return out
}

/**
 * Smooth noise in -1..1 over time: two slow waves at unrelated frequencies with random phases. Cheap, never
 * jumps, and does not repeat for a long time.
 */
export class Drift {
  private readonly f1: number
  private readonly f2: number
  private readonly p1: number
  private readonly p2: number

  constructor(rnd: () => number, rate: number) {
    this.f1 = rate * Math.PI * 2 * (0.8 + rnd() * 0.4)
    this.f2 = this.f1 * (1.618 + rnd() * 0.5)
    this.p1 = rnd() * Math.PI * 2
    this.p2 = rnd() * Math.PI * 2
  }

  at(t: number) {
    return 0.65 * Math.sin(this.f1 * t + this.p1) + 0.35 * Math.sin(this.f2 * t + this.p2)
  }
}

/** a small idle movement, played now and then while standing still */
export type Fidget = 'shift' | 'look' | 'glance_down' | 'stretch_neck' | 'roll_shoulders'
export const FIDGETS: Fidget[] = ['shift', 'look', 'glance_down', 'stretch_neck', 'roll_shoulders']

/** picks idle movements at random moments: one every few seconds, never the same one twice in a row */
export class FidgetPicker {
  current: { kind: Fidget; start: number; secs: number; side: number } | null = null
  private next: number
  private last: Fidget | null = null

  constructor(private readonly rnd: () => number = Math.random, now = 0) {
    this.next = now + 2 + rnd() * 4
  }

  /** the fidget playing at time `t` (seconds), with its progress 0..1; null between fidgets */
  update(t: number) {
    if (this.current && t > this.current.start + this.current.secs) {
      this.current = null
      this.next = t + 3 + this.rnd() * 6
    }
    if (!this.current && t >= this.next) {
      const choices = FIDGETS.filter(f => f !== this.last)
      const kind = choices[Math.floor(this.rnd() * choices.length)]
      this.last = kind
      this.current = { kind, start: t, secs: kind === 'shift' ? 3 + this.rnd() * 3 : 1.4 + this.rnd() * 1.2, side: this.rnd() < 0.5 ? -1 : 1 }
    }
    return this.current ? { ...this.current, u: (t - this.current.start) / this.current.secs } : null
  }

  /** stop any fidget (the person started doing something else) */
  reset(t: number) {
    this.current = null
    this.next = t + 2 + this.rnd() * 4
  }
}
