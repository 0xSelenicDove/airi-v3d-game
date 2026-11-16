import type { Action, Brain, Needs, Observation, Persona, Vec2, WorldObject, Affordance } from './types'
import { World, clamp, dist } from './world'
import { MemoryStream } from './memory'

type State =
  | { k: 'idle' }
  | { k: 'thinking' }
  | { k: 'moving'; path: Vec2[]; obj: WorldObject; aff: Affordance }
  | { k: 'doing'; obj: WorldObject; aff: Affordance; left: number }
  | { k: 'waiting'; left: number }

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
  pose: 'stand' | 'sit' | 'lie' = 'stand'
  heading = 0

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
    return s.k === 'doing' ? `${s.aff.verb} (${s.obj.id})` : s.k === 'moving' ? `walking to ${s.obj.id}` : s.k === 'waiting' ? 'idling' : 'standing around'
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
      needs: { ...this.needs },
      objects: this.world.objects.map(o => ({
        id: o.id, kind: o.kind, verbs: o.affordances.map(a => a.verb), inUseBy: this.world.occupant(o.id),
      })),
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
        this.pose = 'stand'
        this.state = { k: 'thinking' }
        this.brain.decide(this.persona, this.observe()).then(a => this.apply(a)).catch(err => {
          this.lastResult = `error: ${err}`
          this.state = { k: 'waiting', left: 10 }
        })
        break
      case 'moving': {
        const target = s.path[0]
        const d = dist(this.pos, target)
        const step = 2.2 * realDt
        if (d <= step) {
          this.pos = { ...target }
          s.path.shift()
          if (!s.path.length) {
            this.pose = s.aff.pose
            this.heading = s.aff.pose === 'lie' ? Math.PI / 2 : Math.atan2(s.obj.pos.x - target.x, s.obj.pos.z - target.z)
            this.state = { k: 'doing', obj: s.obj, aff: s.aff, left: s.aff.duration }
            this.log(`started ${s.aff.verb} at ${s.obj.id}`, 1)
          }
        } else {
          const dx = (target.x - this.pos.x) / d, dz = (target.z - this.pos.z) / d
          this.heading = Math.atan2(dx, dz)
          let nx = this.pos.x + dx * step, nz = this.pos.z + dz * step
          // step aside from other agents so they do not walk through each other
          for (const o of this.world.inhabitants) {
            if (o === this) continue
            const od = dist({ x: nx, z: nz }, o.pos)
            if (od < 0.7 && od > 0.001) {
              const push = (0.7 - od) * 0.5
              const px = nx + ((nx - o.pos.x) / od) * push, pz = nz + ((nz - o.pos.z) / od) * push
              if (this.world.isFree({ x: px, z: pz })) { nx = px; nz = pz }
            }
          }
          this.pos.x = nx; this.pos.z = nz
        }
        break
      }
      case 'doing': {
        const frac = Math.min(gameDt, s.left) / s.aff.duration
        for (const [k, v] of Object.entries(s.aff.effects)) {
          this.needs[k as keyof Needs] = clamp(this.needs[k as keyof Needs] + v! * frac)
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
    }
    if (this.speech && performance.now() > this.speechUntil) this.speech = ''
    this.maybeReflect()
  }

  /** Validate and apply an action from the brain. Errors are fed back as next observation. */
  private apply(a: Action) {
    if (a.thought) { this.thought = a.thought; this.thoughtUntil = performance.now() + 3500; this.log(`thought: ${a.thought}`, 3) }
    if (a.type === 'say') {
      this.speech = a.text
      this.speechUntil = performance.now() + 3000 + a.text.length * 70
      this.log(`said "${a.text}"`, 4)
      this.world.broadcast(this, a.text)
      this.onSay?.(a.text)
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
      const who = this.world.occupant(obj.id)
      if (who && who !== this.name && aff.pose !== 'stand') {
        this.lastResult = `invalid action: ${obj.id} is in use by ${who}`
        this.state = { k: 'waiting', left: 5 }
        return
      }
      if (aff.pose !== 'stand') { this.world.claim(obj.id, this.name); this.claimed = obj.id }
      this.log(`decided to ${aff.verb} at ${obj.id}`, 1)
      const via = obj.approach
      const path = this.world.findPath(this.pos, via ?? obj.usePos)
      if (via) path.push({ ...obj.usePos }) // last step onto the bed / seat ignores obstacles
      this.state = { k: 'moving', path, obj, aff }
    }
  }

  get statusText() {
    const s = this.state
    const act = s.k === 'doing' ? `${s.aff.verb} @${s.obj.id}` : s.k === 'moving' ? `→ ${s.obj.id}` : s.k
    const n = this.needs
    const insight = this.mem.reflections(1)[0]
    return `${this.persona.name}: ${act}${insight ? `\n  🧠 ${insight.text}` : ''}${this.thought ? `\n  💭 ${this.thought}` : ''}${this.speech ? `\n  💬 ${this.speech}` : ''}\n  energy ${n.energy.toFixed(0)}  fun ${n.fun.toFixed(0)}  knowledge ${n.knowledge.toFixed(0)}`
  }
}
