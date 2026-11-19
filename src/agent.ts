import type { Action, Brain, Needs, Observation, Persona, Vec2, Vec3, WorldObject, Affordance } from './types'
import { World, clamp, dist } from './world'
import { MemoryStream } from './memory'
import { GESTURE_INFO, emotionOf, gestureOf, type Emotion, type Gesture } from './acting'
import type { Pose, SkillMotion, Step } from './skills'
import { getUp, lieDown } from './skills/bed'
import { besideDoor, crossesDoor, doorSpots, handle, inSwing, openAt, throughDoor } from './skills/door'
import { chairOut, chairTop, sitDown, standUp } from './skills/seat'
import { DETOUR_TRIES, DETOUR_WAIT, STUCK_THINK, THINK_BLOCKED, THINK_GIVE_UP, THINK_WAIT, routeAround } from './skills/detour'

type State =
  | { k: 'idle' }
  | { k: 'thinking' }
  /**
   * walking a path. `next` are the skill steps that follow on arrival; `exact` legs go straight (off the grid,
   * already checked to be clear); `onto` is the final step onto a seat or into the water; `busy` legs are part of
   * something that must not be interrupted (passing the door, squeezing beside a bed)
   */
  | { k: 'moving'; path: Vec2[]; obj: WorldObject; aff: Affordance; next?: Step[]; exact?: boolean; onto?: boolean; busy?: boolean }
  /**
   * running the steps of a skill (skills/): `t` is real seconds into the current step; `from`, `fromPose`,
   * `fromHeading`, `doorFrom` and `chairFrom` are where the body was, its pose and heading, the door and the
   * seat's chair when it began
   */
  | { k: 'routine'; steps: Step[]; obj: WorldObject; aff: Affordance; t: number; from: Vec2; fromPose: Pose; fromHeading: number; doorFrom: number; chairFrom: number; started: boolean }
  | { k: 'doing'; obj: WorldObject; aff: Affordance; left: number; orbitAngle?: number }
  | { k: 'waiting'; left: number }
  /** acting out a gesture on the spot; `left` is in real seconds */
  | { k: 'gesturing'; gesture: Gesture; left: number }
  /** stopped to talk with someone; `resume` is the trip it interrupted */
  | { k: 'chatting'; with: Agent; resume?: { obj: WorldObject; aff: Affordance } }

/** walking and swimming speeds in m/s (a relaxed indoor walk) */
export const WALK_SPEED = 1.2
export const SWIM_SPEED = 0.6
/** starting and stopping like a person: m/s gained per second, m/s lost per second, and the slowest arrival */
const ACCEL = 2.4
const DECEL = 1.8
const MIN_PACE = 0.3
/** steps that carry on walking, so a walk that ends in one does not slow down first */
const WALKING_STEPS = new Set(['walk', 'squeeze', 'onto'])
/** closest two standing agents' centres get to each other */
export const PERSONAL_SPACE = 0.6
/** how far ahead a walker looks for people in its way */
const LOOKAHEAD = 1.6
/** jump timing in real seconds: crouch before take-off, then time in the air */
export const JUMP_CROUCH = 0.22
export const JUMP_AIR = 0.5

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
  /** walking backwards (pulling the door along), so the walk cycle runs the other way */
  walkBack = false
  /** the speed the walk has built up to: it rises when setting off and falls before stopping */
  private pace = 0
  /** body movement being played, from `gestureStart` until `gestureUntil` (performance.now ms) */
  gesture: Gesture | SkillMotion | '' = ''
  /** shoes on; they come off before lying down in bed (rule R1) */
  shoesOn = true
  /** where a hand must be right now (a door handle), or both hands on the feet; the avatar reaches there */
  reach: Vec3 | 'feet' | null = null
  /**
   * sitting down or standing up: how far up the body is, 0 (seated) .. 1 (standing), and the seat's use point (to
   * find its height). The avatar keeps the feet where they are and swings the hips up over them. Null at other times.
   */
  rise: { u: number; seat: Vec2 } | null = null
  /** sitting up in bed or lying down: how far up the back is, 0 (lying) .. 1 (sitting). Null at other times. */
  recline: number | null = null
  gestureStart = 0
  gestureUntil = 0
  /** facial emotion shown until `emotionUntil` (performance.now ms) */
  emotion: Emotion = 'neutral'
  emotionUntil = 0
  /** height of the feet above the ground, for jumps */
  lift = 0
  private stuck = 0
  /** how often this trip has been blocked so far (rule R4); it gives up after DETOUR_TRIES */
  private detours = 0

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
      : s.k === 'chatting' ? `chatting with ${s.with.name}` : s.k === 'gesturing' ? GESTURE_INFO[s.gesture].label
      : s.k === 'routine' ? describe(s.steps[0], s.obj.id) : 'standing around'
  }

  get dest(): Vec2 | undefined {
    const s = this.state
    return s.k === 'moving' ? s.path[s.path.length - 1] : s.k === 'doing' ? this.pos : undefined
  }

  /** remember what someone said in a conversation, without asking the brain to answer it */
  overhear(from: string, text: string) {
    this.log(`heard ${from} say "${text}"`, 4)
  }

  /** say something aloud: speech bubble, memory, text-to-speech, and optionally a face and a gesture */
  say(text: string, act: { emotion?: Emotion; gesture?: Gesture } = {}) {
    this.speech = text
    this.speechUntil = performance.now() + 3000 + text.length * 70
    if (act.emotion) this.feel(act.emotion, 2.5 + text.length * 0.06)
    if (act.gesture) this.play(act.gesture)
    this.log(`said "${text}"`, 4)
    this.onSay?.(text)
  }

  /** show an emotion on the face for `seconds` */
  feel(emotion: Emotion, seconds = 3) {
    this.emotion = emotion
    this.emotionUntil = performance.now() + seconds * 1000
  }

  /**
   * Why `g` cannot be done right now, or null if it can: the pose has to allow it, and the space the arms,
   * legs or head move through has to be free of furniture, walls and other people.
   */
  whyNot(g: Gesture): string | null {
    const info = GESTURE_INFO[g]
    const pose = this.pose === 'sit' ? 'sit' : this.pose === 'stand' ? 'stand' : null
    if (!pose || !info.poses.includes(pose)) return `cannot ${g.replace(/_/g, ' ')} while ${this.pose === 'lie' ? 'lying down' : this.pose === 'swim' ? 'swimming' : 'sitting'}`
    const space = this.world.space
    if (!space) return null
    const s = Math.sin(this.heading), c = Math.cos(this.heading)
    // the agent's own frame: x to its left, z forward; sitting lowers everything by about 0.4 m
    const drop = pose === 'sit' ? 0.4 : 0
    const toWorld = (x: number, z: number) => ({ x: x * c + z * s, z: -x * s + z * c })
    for (const r of info.clear) {
      const o = toWorld(r.from[0], r.from[2]), d = toWorld(r.dir[0], r.dir[2])
      const from = { x: this.pos.x + o.x, y: r.from[1] - drop, z: this.pos.z + o.z }
      if (!space.isClear(from, { x: d.x, y: r.dir[1], z: d.z }, r.reach, this.name)) return `no room to ${g.replace(/_/g, ' ')} here: something is in the way`
    }
    return null
  }

  /** start a gesture if there is room; returns the reason when not */
  play(g: Gesture): string | null {
    const why = this.whyNot(g)
    if (why) return why
    this.gesture = g
    this.gestureStart = performance.now()
    this.gestureUntil = this.gestureStart + GESTURE_INFO[g].duration * 1000
    return null
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
    if (s.k !== 'moving') this.pace = 0
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
        this.walkBack = false
        const target = s.path[0]
        const d = dist(this.pos, target)
        // in the lake (wading in from the shore, or swimming back out) the agent swims, slower than it walks
        const swimming = this.world.inWater(this.pos) || (s.aff.pose === 'swim' && !!s.onto)
        this.pose = swimming ? 'swim' : 'stand'
        // the last step onto a seat goes into the furniture, where nobody else stands
        const onto = !!s.onto
        const free = swimming || onto ? { dx: 0, dz: 0, scale: 1 } : null
        // an exact leg (beside a bed, through the doorway) keeps to its line: no steering, no grid
        // set off and stop gradually: speed up, and slow down for the end of the walk unless it carries on
        const top = swimming ? SWIM_SPEED : WALK_SPEED
        // how far there is still to walk: this path, and the walking steps straight after it
        let left = d
        for (let i = 1; i < s.path.length; i++) left += dist(s.path[i - 1], s.path[i])
        let end = s.path[s.path.length - 1]
        for (const n of s.next ?? []) {
          if (!WALKING_STEPS.has(n.do) || !('to' in n)) break
          left += dist(end, n.to)
          end = n.to
        }
        const brake = Math.max(MIN_PACE, Math.sqrt(2 * DECEL * left))
        this.pace = Math.min(top, brake, this.pace + ACCEL * realDt)
        const full = this.pace * realDt
        if (d <= full) {
          this.pos = { ...target }
          this.speedNow = full / Math.max(realDt, 1e-6)
          this.stuck = 0
          s.path.shift()
          // carry on towards the next point with the rest of this frame's step, so the walk does not stall at
          // every corner of the path
          if (s.path.length) this.carryOn(s.path[0], full - d)
          if (!s.path.length && s.next) {
            const walksOn = !!s.next[0] && WALKING_STEPS.has(s.next[0].do)
            this.speedNow = 0
            this.startRoutine(s.next, s.obj, s.aff)
            // the next walking step goes on in this frame too
            const st = this.state
            if (walksOn && st.k === 'moving' && st.path[0]) {
              this.carryOn(st.path[0], full - d)
              this.speedNow = this.pace
            }
          } else if (!s.path.length) {
            this.pose = s.aff.pose
            this.speedNow = 0
            this.heading = s.aff.pose === 'lie' ? Math.PI / 2 : Math.atan2(s.obj.pos.x - target.x, s.obj.pos.z - target.z)
            this.state = { k: 'doing', obj: s.obj, aff: s.aff, left: s.aff.duration, orbitAngle: 0 }
            this.log(`started ${s.aff.verb} at ${s.obj.id}`, 1)
          }
        } else {
          const dx = (target.x - this.pos.x) / d, dz = (target.z - this.pos.z) / d
          const av = free ?? (s.exact ? { dx: 0, dz: 0, scale: 1 } : this.avoid(dx, dz, s.path[s.path.length - 1]))
          let mx = dx + av.dx, mz = dz + av.dz
          const ml = Math.hypot(mx, mz) || 1
          mx /= ml; mz /= ml
          const step = full * av.scale
          this.heading = Math.atan2(mx, mz)
          const right = { x: -dz, z: dx }
          // try the steered step, then a sidestep to the right, then to the left; never walk into someone
          const tries = free || s.exact ? [{ x: mx, z: mz }] : [{ x: mx, z: mz }, right, { x: -right.x, z: -right.z }]
          let moved = false
          // slowed to a stop (someone stands on the goal) counts as stuck, not as walking
          if (step > 1e-4) for (const t of tries) {
            const p = { x: this.pos.x + t.x * step, z: this.pos.z + t.z * step }
            if (!free && !s.exact && !this.world.isFree(p) && this.world.isFree(this.pos)) continue
            // never walk into someone (R0): wait, and after a moment look for another way (R4)
            if (!free && this.crowds(p)) continue
            this.pos = p
            moved = true
            break
          }
          // stuck means not getting closer to where we are going: sidestepping on the spot does not count (R4)
          const progress = d - dist(this.pos, target)
          this.stuck = moved && progress > step * 0.3 ? Math.max(0, this.stuck - realDt) : this.stuck + realDt
          this.speedNow = moved ? step / Math.max(realDt, 1e-6) : 0
          if (this.stuck >= STUCK_THINK) {
            this.stuck = 0
            this.speedNow = 0
            const goal = s.path[s.path.length - 1]
            this.startRoutine([
              { do: 'think', text: THINK_BLOCKED, secs: 1.2 },
              { do: 'reroute', to: goal, exact: !!s.exact },
              ...(s.next ?? []),
            ], s.obj, s.aff)
          }
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
          this.log(this.lastResult)
          if (s.aff.pose === 'lie') {
            // get up the way one lay down: sit up on the edge, shoes on, stand, step back (R1, R2)
            this.startRoutine(getUp(this.world, s.obj), s.obj, s.aff)
          } else if (s.aff.pose === 'sit' && s.obj.approach) {
            // stand up off the seat, stepping forward to where one came from (R0)
            this.startRoutine(standUp(this.world, s.obj), s.obj, s.aff)
          } else {
            this.release()
            this.state = { k: 'idle' }
          }
        }
        break
      }
      case 'routine':
        this.runStep(realDt)
        break
      case 'waiting':
        s.left -= gameDt
        if (s.left <= 0) this.state = { k: 'idle' }
        break
      case 'gesturing':
        s.left -= realDt
        if (s.left <= 0) { this.lastResult = `${GESTURE_INFO[s.gesture].label}`; this.state = { k: 'idle' } }
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
    this.lift = this.jumpHeight()
    this.maybeReflect()
  }

  /** Validate and apply an action from the brain. Errors are fed back as next observation. */
  private apply(a: Action) {
    if (a.thought) { this.thought = a.thought; this.thoughtUntil = performance.now() + 3500; this.log(`thought: ${a.thought}`, 3) }
    if (a.type === 'say') {
      const emotion = emotionOf(a.emotion), gesture = gestureOf(a.gesture)
      this.say(a.text, { emotion })
      this.world.broadcast(this, a.text)
      this.lastResult = 'said it'
      this.state = { k: 'idle' }
      if (gesture) {
        const why = this.play(gesture)
        if (why) this.lastResult = `said it, but ${why}`
        else this.state = { k: 'gesturing', gesture, left: GESTURE_INFO[gesture].duration }
      }
    } else if (a.type === 'gesture') {
      const gesture = gestureOf(a.gesture)
      const emotion = emotionOf(a.emotion)
      if (!gesture) {
        this.lastResult = `invalid action: unknown gesture "${a.gesture}"`
        this.state = { k: 'waiting', left: 5 }
        return
      }
      const why = this.play(gesture)
      if (why) {
        this.lastResult = `invalid action: ${why}`
        this.state = { k: 'waiting', left: 5 }
        return
      }
      if (emotion) this.feel(emotion, GESTURE_INFO[gesture].duration + 1)
      this.log(GESTURE_INFO[gesture].label, 2)
      this.state = { k: 'gesturing', gesture, left: GESTURE_INFO[gesture].duration }
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
    // beds by the bed skill (R1, R2); seats and the water by their approach point, then the last step onto them
    // seats by the seat skill: step up to the seat, turn round, and sit down onto it (never walk into it, R0)
    const steps: Step[] = aff.pose === 'lie' ? lieDown(this.world, obj, aff)
      : aff.pose === 'sit' && obj.approach ? sitDown(this.world, obj)
      : obj.approach ? [{ do: 'walk', to: obj.approach }, { do: 'onto', to: { ...obj.usePos } }, { do: 'use' }]
      : [{ do: 'walk', to: this.spotAt(obj, aff) }, { do: 'use' }]
    this.stuck = 0
    this.detours = 0
    // a fresh plan starts without the door: it takes the door again if the way leads through it
    if (this.world.doorUser === this.name) this.world.doorUser = undefined
    this.startRoutine(steps, obj, aff)
  }

  /** walk up to `r` metres straight towards `to`, unless someone is in the way */
  private carryOn(to: Vec2, r: number) {
    const d = dist(this.pos, to)
    if (d < 1e-6 || r <= 0) return
    const k = Math.min(r, d) / d
    const p = { x: this.pos.x + (to.x - this.pos.x) * k, z: this.pos.z + (to.z - this.pos.z) * k }
    if (!this.crowds(p)) {
      this.heading = Math.atan2(to.x - this.pos.x, to.z - this.pos.z)
      this.pos = p
    }
  }

  private startRoutine(steps: Step[], obj: WorldObject, aff: Affordance) {
    this.state = {
      k: 'routine', steps: [...steps], obj, aff, t: 0, from: { ...this.pos }, fromPose: this.pose, fromHeading: this.heading,
      doorFrom: this.world.doorOpen, chairFrom: chairOut(this.world, obj), started: false,
    }
    this.runStep(0)
  }

  /** blocked for too long (R4): let go of the door and of whatever was claimed, and decide again */
  private giveUp(id: string) {
    this.thought = THINK_GIVE_UP
    this.thoughtUntil = performance.now() + 3000
    this.lastResult = `could not get to ${id}: the way was blocked`
    this.log(this.lastResult, 3)
    if (this.world.doorUser === this.name) this.world.doorUser = undefined
    this.release()
    this.state = { k: 'idle' }
  }

  /** finish the current skill step and go on with the next one */
  private nextStep(s: Extract<State, { k: 'routine' }>) {
    s.steps.shift()
    s.t = 0
    s.from = { ...this.pos }
    s.fromPose = this.pose
    s.fromHeading = this.heading
    s.chairFrom = chairOut(this.world, s.obj)
    s.started = false
  }

  /**
   * Run the current step of a skill (skills/). Walking steps hand over to the 'moving' state with the rest of
   * the steps to follow; the others run here over their time.
   */
  private runStep(realDt: number) {
    const s = this.state
    if (s.k !== 'routine') return
    for (let guard = 0; guard < 8; guard++) {
      const step = s.steps[0]
      if (!step) {
        // a plan without an activity (getting up, giving up) ends here
        this.release()
        this.state = { k: 'idle' }
        return
      }
      const first = !s.started
      s.started = true
      if (first) s.doorFrom = this.world.doorOpen
      else s.t += realDt
      switch (step.do) {
        case 'walk': {
          const path = this.world.findPath(this.pos, step.to)
          // a spot just off the walking grid (beside a wall, the door or a bed): walk to the grid's edge, then a
          // short squeeze the rest of the way
          if (!this.world.isFree(step.to) && path.length > 1 && dist(path[path.length - 2], step.to) < 0.8) {
            s.steps.splice(0, 1, { do: 'walk', to: path[path.length - 2] }, { do: 'squeeze', to: step.to })
            s.started = false
            continue
          }
          // a route through the house door goes by the door skill (R3)
          if (this.world.doorUser !== this.name && crossesDoor(this.world, this.pos, path)) {
            s.steps.splice(0, 1, ...throughDoor(this.world, this.pos), step)
            s.started = false
            continue
          }
          // walking up to the door it holds, nobody stops it for a chat
          this.state = { k: 'moving', path, obj: s.obj, aff: s.aff, next: s.steps.slice(1), busy: this.world.doorUser === this.name }
          return
        }
        case 'squeeze':
          this.state = { k: 'moving', path: [{ ...step.to }], obj: s.obj, aff: s.aff, next: s.steps.slice(1), exact: true, busy: true }
          return
        case 'onto':
          this.state = { k: 'moving', path: [{ ...step.to }], obj: s.obj, aff: s.aff, next: s.steps.slice(1), onto: true, busy: true }
          return
        case 'face':
          if (step.toHandle) { const h = handle(this.world, this.world.doorOpen, step.toHandle); this.heading = Math.atan2(h.x - this.pos.x, h.z - this.pos.z) }
          else this.heading = step.heading
          this.speedNow = 0
          if (s.t < step.secs) return
          break
        case 'pose': {
          if (first && step.pose === 'stand' && this.world.inhabitants.some(o => o !== this && o.pose === 'stand' && dist(o.pos, step.at) < PERSONAL_SPACE)) {
            // someone stands where we would stand up: wait for them to move (R0)
            s.steps.unshift({ do: 'think', text: 'Someone is standing right there. I will wait.', secs: 1.5 })
            s.started = false
            continue
          }
          const sitUp = s.fromPose === 'lie' && step.pose === 'sit', lieDown = s.fromPose === 'sit' && step.pose === 'lie'
          if (first) {
            this.pose = step.pose
            if (!sitUp && !lieDown) this.heading = step.heading
          }
          const k = Math.min(1, s.t / step.secs), e = k * k * (3 - 2 * k)
          let f = e
          const up = s.fromPose === 'sit' && step.pose === 'stand', down = s.fromPose === 'stand' && step.pose === 'sit'
          if (up || down) {
            // the thighs swing up from level (or down to it) about the knees, over feet that stay put: the hips
            // move along by the thigh's reach, 1 - cos of its swing, while they rise by its sine (avatar.ts)
            const u = up ? e : 1 - e
            f = up ? 1 - Math.cos(u * Math.PI / 2) : Math.cos(u * Math.PI / 2)
            this.rise = k < 1 ? { u, seat: { ...s.obj.usePos } } : null
          }
          if (sitUp || lieDown) {
            // the back swings up from the bed (or down onto it) about the hips while the body turns, so the legs
            // swing over the edge; the turn is done a little before the end, when the knees bend (avatar.ts)
            this.recline = k < 1 ? (sitUp ? e : 1 - e) : null
            const kt = Math.min(1, k / 0.8), et = kt * kt * (3 - 2 * kt)
            const turn = Math.atan2(Math.sin(step.heading - s.fromHeading), Math.cos(step.heading - s.fromHeading))
            this.heading = s.fromHeading + turn * et
          }
          this.pos = { x: s.from.x + (step.at.x - s.from.x) * f, z: s.from.z + (step.at.z - s.from.z) * f }
          if (k < 1) return
          break
        }
        case 'act': {
          if (first && step.doorTo !== undefined && this.world.inhabitants.some(o => o !== this && inSwing(this.world, o.pos))) {
            // someone is where the door swings: do not hit them with it (R0); after a while, give the door up
            if (++this.detours > DETOUR_TRIES * 2) { this.giveUp(s.obj.id); return }
            s.steps.unshift({ do: 'think', text: 'Someone is behind the door. I will wait.', secs: 1.5 })
            s.started = false
            continue
          }
          if (first) {
            this.gesture = step.motion
            this.gestureStart = performance.now()
            this.gestureUntil = this.gestureStart + step.secs * 1000
          }
          const k = Math.min(1, s.t / step.secs), e = k * k * (3 - 2 * k)
          const was = { ...this.pos }
          // the door moves with the hand, slowly (R3), and so does a chair at a table
          if (step.doorTo !== undefined) this.world.doorOpen = s.doorFrom + (step.doorTo - s.doorFrom) * e
          if (step.chairTo !== undefined && s.obj.chair) this.world.chairOut.set(s.obj.chair.furniture, s.chairFrom + (step.chairTo - s.chairFrom) * e)
          if (step.slide) this.pos = { x: s.from.x + (step.slide.x - s.from.x) * e, z: s.from.z + (step.slide.z - s.from.z) * e }
          if (step.follow && step.doorTo !== undefined) {
            // walk with the door's edge, starting from where one stands: wait there until the door comes level
            const at = openAt(this.world, s.from)
            this.pos = besideDoor(this.world, clamp(this.world.doorOpen, Math.min(at, step.doorTo), Math.max(at, step.doorTo)))
          }
          // the legs step with the body as it moves, backwards when the body goes the way it does not face
          const mx = this.pos.x - was.x, mz = this.pos.z - was.z
          this.speedNow = s.t > 0 ? Math.hypot(mx, mz) / Math.max(realDt, 1e-6) : 0
          this.walkBack = mx * Math.sin(this.heading) + mz * Math.cos(this.heading) < 0
          // the hand stays on the handle as the door moves, or both hands go to the feet
          if (step.reach === 'feet') this.reach = 'feet'
          else if (step.reach === 'chair') this.reach = s.obj.chair ? chairTop(this.world, s.obj.chair, this.pos) : null
          else if (step.reach) {
            const h = handle(this.world, this.world.doorOpen, step.reach)
            this.reach = h
            if (step.follow) this.heading = Math.atan2(h.x - this.pos.x, h.z - this.pos.z)
          } else this.reach = null
          if (k < 1) return
          if (step.shoes) this.shoesOn = step.shoes === 'on'
          this.reach = null
          this.speedNow = 0
          break
        }
        case 'think':
          if (first) { this.thought = step.text; this.thoughtUntil = performance.now() + step.secs * 1000 + 500; this.log(`thought: ${step.text}`, 2) }
          this.speedNow = 0
          if (s.t < step.secs) return
          break
        case 'door':
          if (step.take) {
            const user = this.world.doorUser
            if (user && user !== this.name) {
              // someone else is at the door: wait for them, out of the way of the door's swing
              s.steps.unshift(
                ...(inSwing(this.world, this.pos) ? [{ do: 'walk', to: doorSpots(this.world).outside } as Step] : []),
                { do: 'think', text: `${user} is using the door. I will wait.`, secs: 1.5 },
              )
              s.started = false
              continue
            }
            this.world.doorUser = this.name
          } else if (this.world.doorUser === this.name) this.world.doorUser = undefined
          break
        case 'reroute': {
          // blocked again and again on this trip: stop trying (R4)
          if (++this.detours > DETOUR_TRIES + 2) { this.giveUp(s.obj.id); return }
          // is the way clear again (the person moved on, the ball rolled away, the door is free)?
          const ahead = step.exact ? step.to : (this.world.findPath(this.pos, step.to)[0] ?? step.to)
          const d = dist(this.pos, ahead) || 1
          const probe = { x: this.pos.x + (ahead.x - this.pos.x) / d * 0.15, z: this.pos.z + (ahead.z - this.pos.z) / d * 0.15 }
          if (!this.crowds(probe)) {
            this.state = step.exact
              ? { k: 'moving', path: [{ ...step.to }], obj: s.obj, aff: s.aff, next: s.steps.slice(1), exact: true, busy: true }
              : { k: 'moving', path: this.world.findPath(this.pos, step.to), obj: s.obj, aff: s.aff, next: s.steps.slice(1) }
            return
          }
          // still blocked: plan round the people and the stuck things nearby, if there is a way
          const blockers = [
            ...this.world.inhabitants.filter(o => o !== this && o.pose !== 'sit' && o.pose !== 'lie').map(o => o.pos),
            ...this.world.props,
          ].filter(b => dist(b, this.pos) < 1.6)
          const path = step.exact || !blockers.length ? null : routeAround(this.world, this.pos, step.to, blockers)
          if (path) {
            this.state = { k: 'moving', path, obj: s.obj, aff: s.aff, next: s.steps.slice(1) }
            return
          }
          // no way round: wait for it to clear, then look again
          s.steps.splice(0, 1, { do: 'think', text: THINK_WAIT, secs: DETOUR_WAIT }, step)
          s.started = false
          continue
        }
        case 'use':
          this.detours = 0
          this.pose = s.aff.pose
          if (s.aff.pose !== 'lie') this.heading = Math.atan2(s.obj.pos.x - this.pos.x, s.obj.pos.z - this.pos.z)
          this.speedNow = 0
          this.state = { k: 'doing', obj: s.obj, aff: s.aff, left: s.aff.duration, orbitAngle: 0 }
          this.log(`started ${s.aff.verb} at ${s.obj.id}`, 1)
          return
      }
      this.nextStep(s)
    }
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

  /**
   * Height of a jump in progress: a crouch, then a ballistic flight under gravity (g = 9.81 m/s^2), then the
   * landing. The flight takes JUMP_AIR seconds, so the take-off speed is g * JUMP_AIR / 2.
   */
  private jumpHeight() {
    if (this.gesture !== 'jump') return 0
    const t = (performance.now() - this.gestureStart) / 1000 - JUMP_CROUCH
    if (t <= 0 || t >= JUMP_AIR) return 0
    const v0 = 9.81 * JUMP_AIR / 2
    return v0 * t - 0.5 * 9.81 * t * t
  }

  /** would standing at `p` bring us closer than personal space to someone who stands or walks? */
  private crowds(p: Vec2) {
    const w = this.world
    // the door swings here while someone else is using it
    if (w.doorUser && w.doorUser !== this.name && inSwing(w, p) && !inSwing(w, this.pos)) return true
    // a ball that cannot roll away (against a wall or furniture) is in the way; a free one gets pushed
    for (const b of w.props) {
      const d = dist(p, b)
      if (d < 0.26 + b.r && d < dist(this.pos, b)) {
        const k = 0.15 / (d || 1)
        if (!w.isFree({ x: b.x + (b.x - p.x) * k, z: b.z + (b.z - p.z) * k })) return true
      }
    }
    return w.inhabitants.some(o => {
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

/** what someone running a skill step is doing, for the others and the HUD */
function describe(step: Step | undefined, id: string) {
  switch (step?.do) {
    case 'act': return step.motion === 'shoes' ? 'changing shoes' : 'using the door'
    case 'pose': return step.pose === 'lie' ? `lying down at ${id}` : step.pose === 'sit' ? `sitting down at ${id}` : `getting up from ${id}`
    case 'think': return 'thinking'
    case 'door': return 'at the door'
    default: return `going to ${id}`
  }
}
