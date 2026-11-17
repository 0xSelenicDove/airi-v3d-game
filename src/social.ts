import type { Agent } from './agent'
import { World, dist } from './world'

/** two people this close (metres) can notice each other */
const MEET_RANGE = 1.8
/** they must move this far apart before the next chance to meet */
const PART_RANGE = 3.2
/** game minutes before the same two people can stop and chat again */
const COOLDOWN = 60

type Line = { by: Agent; text: string; wave?: boolean }

/** activity verbs as they read in a sentence; others just lose their underscores */
const VERB_PHRASES: Record<string, string> = {
  use_computer: 'use the computer', grab_snack: 'grab a snack', wash_dishes: 'wash the dishes',
  do_laundry: 'do the laundry', change_clothes: 'change my clothes', enjoy_fresh_air: 'get some fresh air',
  read: 'read for a while', relax: 'relax for a bit', eat: 'have something to eat', sleep: 'get some sleep',
  check_mail: 'check the mail', tend_garden: 'tend the garden', watch_ducks: 'watch the ducks',
  sit_by_fire: 'sit by the fire', rest_in_tent: 'rest in the tent', sleep_in_tent: 'sleep in the tent',
}

interface Talk {
  a: Agent
  b: Agent
  lines: Line[]
  i: number
  /** real seconds until the next line */
  next: number
  /** both stopped to talk (a chat), or only exchanged a greeting in passing */
  stopped: boolean
}

const pick = <T>(xs: T[], r: () => number) => xs[Math.floor(r() * xs.length) % xs.length]

/**
 * Chance meetings between agents. When two people come within a couple of metres, they may stop for a short
 * chat, stop to say hello, wave in passing, or just walk on. The lines are small talk from the situation:
 * the time of day, where each one is going, and how tired they are.
 */
export class Social {
  private talks: Talk[] = []
  private lastMet = new Map<string, number>()
  private noticed = new Set<string>()

  constructor(private world: World, private agents: Agent[], private rand: () => number = Math.random) {}

  /** the talk `a` takes part in, if any */
  talkOf(a: Agent) { return this.talks.find(t => t.a === a || t.b === a) }

  update(realDt: number) {
    for (const t of [...this.talks]) this.advance(t, realDt)
    for (let i = 0; i < this.agents.length; i++) {
      for (let j = i + 1; j < this.agents.length; j++) this.check(this.agents[i], this.agents[j])
    }
  }

  private key(a: Agent, b: Agent) { return [a.name, b.name].sort().join('|') }

  /** standing and free to stop: walking, idling or waiting, on land, not in a talk */
  private canStop(a: Agent) {
    const k = a.state.k
    return (k === 'moving' || k === 'idle' || k === 'waiting') && a.pose === 'stand' && !this.world.inWater(a.pos) && !this.talkOf(a)
  }

  /** busy with something, but awake and able to answer from where they are */
  private canAnswer(a: Agent) {
    return a.state.k === 'doing' && (a.pose === 'sit' || a.pose === 'stand') && !this.talkOf(a)
  }

  /** nothing solid between them: the floor between them is walkable (endpoints may be on furniture) */
  private inSight(a: Agent, b: Agent) {
    const d = dist(a.pos, b.pos)
    if (d < 1) return true
    const t0 = 0.45 / d, t1 = 1 - t0
    const p = (t: number) => ({ x: a.pos.x + (b.pos.x - a.pos.x) * t, z: a.pos.z + (b.pos.z - a.pos.z) * t })
    return this.world.clearLine(p(t0), p(t1))
  }

  private check(a: Agent, b: Agent) {
    const key = this.key(a, b)
    const d = dist(a.pos, b.pos)
    if (d > PART_RANGE) { this.noticed.delete(key); return }
    if (d > MEET_RANGE || this.noticed.has(key) || this.talkOf(a) || this.talkOf(b)) return
    const walking = (x: Agent) => x.state.k === 'moving'
    // a meeting happens when at least one of them walks up to the other
    if (!walking(a) && !walking(b)) return
    if (a.state.k === 'thinking' || b.state.k === 'thinking') return // decide again once their plans settle
    if (!this.inSight(a, b)) return
    this.noticed.add(key)
    const recent = this.world.minutes - (this.lastMet.get(key) ?? -Infinity) < COOLDOWN
    const r = this.rand()
    if (this.canStop(a) && this.canStop(b)) {
      if (!recent && r < 0.45) this.begin(a, b, this.chat(a, b), true)
      else if (!recent && r < 0.8) this.begin(a, b, this.hello(a, b, true), true)
      else if (r < 0.9) this.begin(a, b, this.hello(a, b, false), false)
    } else {
      // one walks past the other, who is busy: a wave and a word, nobody stops
      const [walker, other] = walking(a) && this.canAnswer(b) ? [a, b] : walking(b) && this.canAnswer(a) ? [b, a] : [null, null]
      if (walker && other && !recent && r < 0.6) this.begin(walker, other, this.passBy(walker, other), false)
    }
  }

  private begin(a: Agent, b: Agent, lines: Line[], stop: boolean) {
    if (stop) { a.startChat(b); b.startChat(a) }
    this.talks.push({ a, b, lines, i: 0, next: stop ? 0.5 : 0, stopped: stop })
  }

  private advance(t: Talk, realDt: number) {
    // a talk ends early if one of them was pulled away (for example, the brain sent them elsewhere)
    const broken = t.stopped && (t.a.state.k !== 'chatting' || t.b.state.k !== 'chatting')
    t.next -= realDt
    if (!broken && t.next > 0) return
    if (!broken && t.i < t.lines.length) {
      const line = t.lines[t.i++]
      const other = line.by === t.a ? t.b : t.a
      line.by.say(line.text, line.wave)
      other.overhear(line.by.name, line.text)
      t.next = 1.4 + line.text.length * 0.045
      return
    }
    this.talks.splice(this.talks.indexOf(t), 1)
    this.lastMet.set(this.key(t.a, t.b), this.world.minutes)
    if (t.stopped) { t.a.endChat(); t.b.endChat() }
  }

  // ---- what they say ----

  private greeting(to: Agent) {
    const h = this.world.hour
    const r = this.rand
    if (h >= 5 && h < 11) return pick([`Good morning, ${to.name}!`, 'Morning!', `Morning, ${to.name}.`], r)
    if (h >= 18 || h < 5) return pick([`Good evening, ${to.name}.`, `Hey, ${to.name}.`, 'Evening!'], r)
    return pick([`Hi, ${to.name}!`, `Hey, ${to.name}!`, 'Oh, hello!'], r)
  }

  private answer(to: Agent) {
    return pick([`Hi, ${to.name}!`, 'Hey!', `Oh, hi ${to.name}.`, 'Hello!'], this.rand)
  }

  /** where `a` is heading, as a phrase, or undefined */
  private errand(a: Agent) {
    const s = a.state.k === 'chatting' ? a.state.resume : a.state.k === 'moving' ? a.state : undefined
    if (!s) return undefined
    return { kind: s.obj.kind, verb: VERB_PHRASES[s.aff.verb] ?? s.aff.verb.replace(/_/g, ' ') }
  }

  /** small-talk topics that fit the situation of `b`; each is a question to `b` and `b`'s answer */
  private topics(b: Agent): [string, string][] {
    const h = this.world.hour
    const out: [string, string][] = []
    const e = this.errand(b)
    if (e) out.push(['Where are you off to?', `To the ${e.kind}. I want to ${e.verb}.`])
    if (b.needs.energy < 40) out.push(['You look a bit tired.', pick(['I am. I could use a nap.', 'Yeah, I stayed up too late.'], this.rand)])
    if (b.needs.knowledge < 45) out.push(['Read anything good lately?', 'Not yet. I keep meaning to.'])
    else out.push(['Read anything good lately?', pick(['A little. I will tell you about it later.', 'Yes! A really good one.'], this.rand)])
    if (b.needs.fun < 40) out.push(['Everything all right?', 'Just a bit bored, that is all.'])
    if (h >= 9 && h < 17) out.push(["Nice day out, isn't it?", 'It is. Maybe we can go out to the yard later.'])
    if (h >= 18) out.push(['Long day?', pick(['A good one, though.', 'Long, but nice.'], this.rand)])
    if ((h >= 11 && h < 14) || (h >= 17 && h < 20)) out.push(['Have you eaten yet?', 'Not yet. Maybe I will cook something.'])
    out.push(['How are you doing?', pick(['Pretty good, thanks.', 'Not bad at all.'], this.rand)])
    return out
  }

  private chat(a: Agent, b: Agent): Line[] {
    const lines: Line[] = [
      { by: a, text: this.greeting(b), wave: true },
      { by: b, text: this.answer(a), wave: true },
    ]
    const asked = new Set<string>()
    const n = 1 + Math.floor(this.rand() * 2)
    for (let k = 0; k < n; k++) {
      // take turns asking; the answer is about the one who answers
      const [asker, other] = k % 2 === 0 ? [a, b] : [b, a]
      const topics = this.topics(other).filter(([q]) => !asked.has(q))
      if (!topics.length) break
      const [q, ans] = topics[Math.floor(this.rand() * topics.length) % topics.length]
      asked.add(q)
      lines.push({ by: asker, text: q }, { by: other, text: ans })
    }
    lines.push({ by: a, text: pick(['See you later!', 'Talk later!', 'Catch you later.'], this.rand) })
    lines.push({ by: b, text: pick(['Bye!', 'See you!', 'Later!'], this.rand), wave: true })
    return lines
  }

  private hello(a: Agent, b: Agent, stop: boolean): Line[] {
    return stop
      ? [{ by: a, text: this.greeting(b), wave: true }, { by: b, text: this.answer(a), wave: true }]
      : [{ by: a, text: pick(['Hi!', 'Hey!', `Hi, ${b.name}.`], this.rand), wave: true }, { by: b, text: pick(['Hey!', 'Hi!'], this.rand), wave: true }]
  }

  private passBy(walker: Agent, other: Agent): Line[] {
    return [
      { by: walker, text: pick([`Hi, ${other.name}!`, 'Hey there!', `Don't let me bother you, ${other.name}.`], this.rand), wave: true },
      { by: other, text: pick(['Hi!', 'Hey!', 'Oh, hi.'], this.rand) },
    ]
  }
}
