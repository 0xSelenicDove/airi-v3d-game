import type { Action, Brain, Needs, Observation, Persona, Vec2, WorldObject, Affordance } from './types'
import { World, clamp, dist } from './world'
import { MemoryStream } from './memory'

type State =
  | { k: 'idle' }
  | { k: 'thinking' }
  | { k: 'moving'; path: Vec2[]; obj: WorldObject; aff: Affordance }
  | { k: 'doing'; obj: WorldObject; aff: Affordance; left: number; orbitAngle?: number }
  | { k: 'waiting'; left: number }
  /** stopped to talk with someone; `resume` is the trip it interrupted */
  | { k: 'chatting'; with: Agent; resume?: { obj: WorldObject; aff: Affordance } }

/** walking and swimming speeds in m/s (a relaxed indoor walk) */
export const WALK_SPEED = 1.2
export const SWIM_SPEED = 0.6
/** closest two standing agents' centres get to each other */
export const PERSONAL_SPACE = 0.6
/** how far ahead a walker looks for people in its way */
const LOOKAHEAD = 1.6
/** seconds a walker waits behind someone who does not move before it steps past as a last resort */
const STUCK_LIMIT = 4

export class Agent {
  pos: Vec2
  needs: Needs = { energy: 70, fun: 60, knowledge: 50 }
  state: State = { k: 'idle' }
  memory: string[] = []
  mem = new MemoryStream()
  private reflecting = false
  speech = ''
  thought = ''
  speechUntil = 0
  /** called whenever this agent says something aloud (used for text-to-speech) */
  onSay?: (text: string) => void
  thoughtUntil = 0
  private lastResult?: string
  private inbox: string[] = []
  private claimed?: string
  pose: 'stand' | 'sit' | 'lie' | 'swim' = 'stand'
  heading = 0
  /** current walking speed in m/s, for the walk cycle */
  speedNow = 0
  /** hand gesture shown until `gestureUntil` (performance.now ms) */
  gesture: '' | 'wave' = ''
  gestureUntil = 0
  private stuck = 0

  constructor(public persona: Persona, start: Vec2, private brain: Brain, private world: World) {
    this.pos = { ...start }
    world.inhabitants.push(this)
  }

  get name() { return this.persona.name }
  /** closest other inhabitant within `range` metres, if any */
  nearestOther(range: number) {
    let best: { pos: Vec2 } | undefined, bd = range
    for (const i of this.world.inhabitants) {
      if (i === (this as unknown)) continue
      const d = dist(this.pos, i.pos)
      if (d < bd) { bd = d; best = i }
    }
    return best
  }
  get activity() {
    const s = this.state
    return s.k === 'doing' ? `${s.aff.verb} (${s.obj.id})` : s.k === 'moving' ? `walking to ${s.obj.id}` : s.k === 'waiting' ? 'idling'
      : s.k === 'chatting' ? `chatting with ${s.with.name}` : 'standing around'
  }

  get dest(): Vec2 | undefined {
    const s = this.state
    return s.k === 'moving' ? s.path[s.path.length - 1] : s.k === 'doing' ? this.pos : undefined
  }

  /** remember what someone said in a conversation, without asking the brain to answer it */
  overhear(from: string, text: string) {
    this.log(`heard ${from} say "${text}"`, 4)
  }

  /** say something aloud: speech bubble, memory, text-to-speech, and optionally a wave */
  say(text: string, wave = false) {
    this.speech = text
    this.speechUntil = performance.now() + 3000 + text.length * 70
    if (wave) { this.gesture = 'wave'; this.gestureUntil = performance.now() + 1800 }
    this.log(`said "${text}"`, 4)
    this.onSay?.(text)
  }

  /** stop and talk with `other`; endChat() resumes a trip in progress */
  startChat(other: Agent) {
    const s = this.state
    this.state = { k: 'chatting', with: other, resume: s.k === 'moving' ? { obj: s.obj, aff: s.aff } : undefined }
    this.speedNow = 0
    this.faceTowards(other.pos)
  }

  endChat() {
    const s = this.state
    if (s.k !== 'chatting') return
    this.log(`chatted with ${s.with.name}`, 3)
    if (s.resume) this.walkTo(s.resume.obj, s.resume.aff)
    else this.state = { k: 'idle' }
  }

  faceTowards(p: Vec2) {
    if (dist(p, this.pos) > 1e-3) this.heading = Math.atan2(p.x - this.pos.x, p.z - this.pos.z)
  }

  hear(from: string, text: string) {
    this.inbox.push(`${from}: "${text}"`)
    this.log(`heard ${from} say "${text}"`, 6)
  }

  private release() {
    if (this.claimed) this.world.release(this.claimed, this.name)
    this.claimed = undefined
  }

  private log(msg: string, importance = 2) {
    this.mem.add(this.world.minutes, msg, importance)
    this.memory.push(`${this.world.clock}  ${msg}`)
    if (this.memory.length > 50) this.memory.shift()
  }

  /** Situation description used to pull relevant memories. */
  private recall(heard: string[]): string[] {
    const n = this.needs
    const wants = [n.energy < 35 && 'tired sleep bed', n.fun < 35 && 'bored computer desk', n.knowledge < 35 && 'read bookshelf']
    const query = [this.activity, ...heard, ...this.world.inhabitants.filter(i => i !== this).map(i => `${i.name} ${i.activity}`), ...wants.filter(Boolean) as string[]].join(' ')
    return this.mem.retrieve(this.world.minutes, query, 6)
      .sort((a, b) => a.time - b.time)
      .map(m => `[${this.world.format(m.time)}] ${m.kind === 'reflection' ? '(insight) ' : ''}${m.text}`)
  }

  /** Once enough has happened, ask the brain for higher-level conclusions and store them. */
  private maybeReflect() {
    if (this.reflecting || !this.brain.reflect || this.mem.unreflected < 40) return
    this.reflecting = true
    this.mem.unreflected = 0
    const lines = this.mem.recent(40).map(m => `[${this.world.format(m.time)}] ${m.text}`)
    this.brain.reflect(this.persona, lines)
      .then(ins => ins.forEach(t => {
        if (this.mem.reflections(20).some(r => r.text === t)) return
        this.mem.add(this.world.minutes, t, 8, 'reflection')
        this.memory.push(`${this.world.clock}  🧠 ${t}`)
      }))
      .catch(e => console.warn('reflect failed', e))
      .finally(() => (this.reflecting = false))
  }

  private observe(): Observation {
    const inbox = this.inbox.splice(0)
    return {
      time: this.world.clock,
      hour: this.world.hour,
      location: `(${this.pos.x.toFixed(1)}, ${this.pos.z.toFixed(1)})`,
      place: this.world.placeOf(this.pos),
      needs: { ...this.needs },
      objects: this.world.objects.map(o => ({
        id: o.id, kind: o.kind, verbs: o.affordances.filter(a => this.world.isAvailable(a)).map(a => a.verb),
        inUseBy: this.world.occupant(o.id), ...(o.outdoors && { outside: true as const }),
      })).filter(o => o.verbs.length),
      others: this.world.inhabitants
        .filter(i => i !== this)
        .map(i => ({ name: i.name, activity: i.activity, distance: +dist(this.pos, i.pos).toFixed(1) })),
      heard: inbox,
      yourBed: this.persona.bed,
      lastResult: this.lastResult,
      recentMemory: this.memory.slice(-5),
      memories: this.recall(inbox),
      insights: this.mem.reflections(3).map(m => m.text),
    }
  }

  tick(realDt: number, gameDt: number) {
    this.world.decayNeeds(this.needs, gameDt)
    const s = this.state
    switch (s.k) {
      case 'idle':
        this.pose = this.world.inWater(this.pos) ? 'swim' : 'stand' // still in the lake: keep floating
        this.state = { k: 'thinking' }
        this.brain.decide(this.persona, this.observe()).then(a => this.apply(a)).catch(err => {
          this.lastResult = `error: ${err}`
          this.state = { k: 'waiting', left: 10 }
        })
        break
      case 'moving': {
        const target = s.path[0]
        const d = dist(this.pos, target)
        // in the lake (wading in from the shore, or swimming back out) the agent swims, slower than it walks
        const swimming = this.world.inWater(this.pos) || (s.aff.pose === 'swim' && s.path.length === 1 && !!s.obj.approach)
        this.pose = swimming ? 'swim' : 'stand'
        // the last step onto a seat or bed goes into the furniture, where nobody else stands
        const onto = !!s.obj.approach && s.path.length === 1
        const free = swimming || onto ? { dx: 0, dz: 0, scale: 1 } : null
        const full = (swimming ? SWIM_SPEED : WALK_SPEED) * realDt
        if (d <= full) {
          this.pos = { ...target }
          this.speedNow = full / Math.max(realDt, 1e-6)
          this.stuck = 0
          s.path.shift()
          if (!s.path.length) {
            this.pose = s.aff.pose
            this.speedNow = 0
            this.heading = s.aff.pose === 'lie' ? Math.PI / 2 : Math.atan2(s.obj.pos.x - target.x, s.obj.pos.z - target.z)
            this.state = { k: 'doing', obj: s.obj, aff: s.aff, left: s.aff.duration, orbitAngle: 0 }
            this.log(`started ${s.aff.verb} at ${s.obj.id}`, 1)
          }
        } else {
          const dx = (target.x - this.pos.x) / d, dz = (target.z - this.pos.z) / d
          const av = free ?? this.avoid(dx, dz, s.path[s.path.length - 1])
          let mx = dx + av.dx, mz = dz + av.dz
          const ml = Math.hypot(mx, mz) || 1
          mx /= ml; mz /= ml
          const step = full * av.scale
          this.heading = Math.atan2(mx, mz)
          const right = { x: -dz, z: dx }
          // try the steered step, then a sidestep to the right, then to the left; never walk into someone
          const tries = free ? [{ x: mx, z: mz }] : [{ x: mx, z: mz }, right, { x: -right.x, z: -right.z }]
          let moved = false
          for (const t of tries) {
            const p = { x: this.pos.x + t.x * step, z: this.pos.z + t.z * step }
            if (!free && !this.world.isFree(p) && this.world.isFree(this.pos)) continue
            if (!free && this.crowds(p) && this.stuck < STUCK_LIMIT) continue
            this.pos = p
            moved = true
            break
          }
          this.stuck = moved ? Math.max(0, this.stuck - realDt) : this.stuck + realDt
          this.speedNow = moved ? step / Math.max(realDt, 1e-6) : 0
        }
        break
      }
      case 'doing': {
        const frac = Math.min(gameDt, s.left) / s.aff.duration
        for (const [k, v] of Object.entries(s.aff.effects)) {
          this.needs[k as keyof Needs] = clamp(this.needs[k as keyof Needs] + v! * frac)
        }
        if (s.aff.orbit && s.orbitAngle !== undefined) {
          // swimming laps: a circle whose east-most point is the use point, so the swimmer starts where it arrived
          const r = s.aff.orbit
          s.orbitAngle += (0.6 / r) * realDt
          const a = s.orbitAngle
          this.pos = { x: s.obj.usePos.x - r + Math.cos(a) * r, z: s.obj.usePos.z + Math.sin(a) * r }
          this.heading = Math.atan2(-Math.sin(a), Math.cos(a))
        }
        s.left -= gameDt
        if (s.left <= 0) {
          this.lastResult = `finished ${s.aff.verb} at ${s.obj.id}`
          this.release()
          this.log(this.lastResult)
          this.state = { k: 'idle' }
        }
        break
      }
      case 'waiting':
        s.left -= gameDt
        if (s.left <= 0) this.state = { k: 'idle' }
        break
      case 'chatting': {
        // close in to a comfortable talking distance, then face each other
        const d = dist(this.pos, s.with.pos)
        this.speedNow = 0
        if (d > 1.2) {
          const step = Math.min(WALK_SPEED * 0.6 * realDt, d - 1.2)
          const p = { x: this.pos.x + (s.with.pos.x - this.pos.x) / d * step, z: this.pos.z + (s.with.pos.z - this.pos.z) / d * step }
          if (this.world.isFree(p)) { this.pos = p; this.speedNow = step / Math.max(realDt, 1e-6) }
        }
        this.faceTowards(s.with.pos)
        break
      }
    }
    if (this.speech && performance.now() > this.speechUntil) this.speech = ''
    this.maybeReflect()
  }

  /** Validate and apply an action from the brain. Errors are fed back as next observation. */
  private apply(a: Action) {
    if (a.thought) { this.thought = a.thought; this.thoughtUntil = performance.now() + 3500; this.log(`thought: ${a.thought}`, 3) }
    if (a.type === 'say') {
      this.say(a.text)
      this.world.broadcast(this, a.text)
      this.lastResult = 'said it'
      this.state = { k: 'idle' }
    } else if (a.type === 'wait') {
      this.state = { k: 'waiting', left: Math.max(1, Math.min(120, a.minutes)) }
    } else if (a.type === 'interact') {
      const obj = this.world.find(a.object)
      const aff = obj?.affordances.find(x => x.verb === a.verb)
      if (!obj || !aff) {
        this.lastResult = `invalid action: no "${a.verb}" on "${a.object}"`
        this.state = { k: 'waiting', left: 5 }
        return
      }
      if (!this.world.isAvailable(aff)) {
        this.lastResult = `invalid action: "${a.verb}" is not possible at this time of day`
        this.state = { k: 'waiting', left: 5 }
        return
      }
      const who = this.world.occupant(obj.id)
      if (who && who !== this.name && aff.pose !== 'stand') {
        this.lastResult = `invalid action: ${obj.id} is in use by ${who}`
        this.state = { k: 'waiting', left: 5 }
        return
      }
      if (aff.pose !== 'stand') { this.world.claim(obj.id, this.name); this.claimed = obj.id }
      this.log(`decided to ${aff.verb} at ${obj.id}`, 1)
      this.walkTo(obj, aff)
    }
  }

  private walkTo(obj: WorldObject, aff: Affordance) {
    const via = obj.approach
    const path = this.world.findPath(this.pos, via ?? this.spotAt(obj, aff))
    if (via) path.push({ ...obj.usePos }) // last step onto the bed / seat ignores obstacles
    this.stuck = 0
    this.state = { k: 'moving', path, obj, aff }
  }

  /**
   * Where to stand to use `obj`. Standing activities can be shared, so when someone already stands at (or is
   * heading to) the use point, take a free spot beside it instead of walking into them.
   */
  private spotAt(obj: WorldObject, aff: Affordance): Vec2 {
    if (aff.pose !== 'stand' || aff.orbit) return obj.usePos
    const near = (a: Vec2, b: Vec2) => dist(a, b) < PERSONAL_SPACE + 0.05
    const taken = (p: Vec2) => this.world.inhabitants.some(o => o !== this && o.pose === 'stand' &&
      (near(o.pos, p) || (o.dest !== undefined && near(o.dest, p))))
    if (!taken(obj.usePos)) return obj.usePos
    const fx = obj.pos.x - obj.usePos.x, fz = obj.pos.z - obj.usePos.z, fl = Math.hypot(fx, fz) || 1
    const side = { x: -fz / fl, z: fx / fl }
    for (const k of [1, -1, 2, -2]) {
      const p = { x: obj.usePos.x + side.x * k * 0.65, z: obj.usePos.z + side.z * k * 0.65 }
      if (this.world.isFree(p) && !taken(p)) return p
    }
    return obj.usePos
  }

  /**
   * Steering away from people ahead: each walker turns to its own right, so two people meeting head-on pass
   * each other, and it slows down when someone is close. Seated and lying people are on furniture and ignored.
   */
  private avoid(dx: number, dz: number, goal: Vec2) {
    const rx = -dz, rz = dx
    let sx = 0, sz = 0, scale = 1
    for (const o of this.world.inhabitants) {
      if (o === this || o.pose === 'sit' || o.pose === 'lie') continue
      const ox = o.pos.x - this.pos.x, oz = o.pos.z - this.pos.z
      const d = Math.hypot(ox, oz)
      if (d > LOOKAHEAD || d < 1e-4) continue
      const ahead = ox * dx + oz * dz, side = ox * rx + oz * rz
      if (ahead <= 0 || Math.abs(side) > PERSONAL_SPACE) continue
      // someone standing on our goal: slow down and stop short instead of swerving around them
      if (dist(goal, o.pos) < PERSONAL_SPACE) { scale = Math.min(scale, clamp((d - PERSONAL_SPACE) / 0.6, 0, 1)); continue }
      const w = (1 - d / LOOKAHEAD) * 1.8
      const turn = side > 0.05 ? -1 : 1 // they are on our right: go left; otherwise keep right
      sx += rx * turn * w; sz += rz * turn * w
      scale = Math.min(scale, 0.35 + 0.65 * clamp((d - PERSONAL_SPACE) / 0.8, 0, 1))
    }
    return { dx: sx, dz: sz, scale }
  }

  /** would standing at `p` bring us closer than personal space to someone who stands or walks? */
  private crowds(p: Vec2) {
    return this.world.inhabitants.some(o => {
      if (o === this || o.pose === 'sit' || o.pose === 'lie') return false
      const next = dist(p, o.pos)
      return next < PERSONAL_SPACE && next < dist(this.pos, o.pos)
    })
  }

  get statusText() {
    const s = this.state
    const act = s.k === 'doing' ? `${s.aff.verb} @${s.obj.id}` : s.k === 'moving' ? `→ ${s.obj.id}`
      : s.k === 'chatting' ? `chatting with ${s.with.name}` : s.k
    const n = this.needs
    const insight = this.mem.reflections(1)[0]
    return `${this.persona.name}: ${act}${insight ? `\n  🧠 ${insight.text}` : ''}${this.thought ? `\n  💭 ${this.thought}` : ''}${this.speech ? `\n  💬 ${this.speech}` : ''}\n  energy ${n.energy.toFixed(0)}  fun ${n.fun.toFixed(0)}  knowledge ${n.knowledge.toFixed(0)}`
  }
}
