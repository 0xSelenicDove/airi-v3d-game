import type { Action, Brain, NeedName, Observation, Persona } from './types'
import { actingHelp, gestureOf, splitTags } from './acting'

/** the need each activity mainly serves, for the mock brain; other verbs are chores */
const VERB_NEED: Record<string, NeedName> = {
  use_computer: 'fun', relax: 'fun', read: 'knowledge', eat: 'energy', grab_snack: 'energy', cook: 'energy',
  tend_garden: 'fun', check_mail: 'fun', admire_flowers: 'fun', enjoy_fresh_air: 'fun', stargaze: 'fun',
  watch_ducks: 'fun', warm_up: 'fun', sit_by_fire: 'fun', swim: 'fun', fish: 'fun', sleep_in_tent: 'energy', rest_in_tent: 'energy',
}
/** a little nudge to go out when the weather is the same all day: being outside is a nice change */
const OUTSIDE_BONUS = 12
/** chance per decision, on an evening, to head for the campfire */
const CAMP_CHANCE = 0.2
/** chores (washing, laundry, changing clothes) win only now and then */
const CHORE_SCORE = 25

/**
 * Utility-based stand-in for an LLM. Replace with LLMBrain to drive agents with a real model.
 * Emulates "personality + needs" decision making so the rest of the pipeline can be tested.
 */
export class MockBrain implements Brain {
  /** Rule-based "reflection": notice habits and social patterns in recent memories. */
  async reflect(p: Persona, memories: string[]): Promise<string[]> {
    const count = (re: RegExp) => memories.filter(m => re.test(m)).length
    const out: string[] = []
    const reads = count(/finished read/), pc = count(/finished use_computer/), sleeps = count(/finished sleep/)
    if (reads >= 2 && reads >= pc) out.push('I have been reading a lot lately, and I like learning new things.')
    if (pc >= 2 && pc > reads) out.push('I spend a lot of time on the computer; it is my favourite way to relax.')
    if (sleeps >= 1) out.push('I sleep better when I follow my own rhythm.')
    const talk = new Map<string, number>()
    for (const m of memories) { const r = /heard (\w+) say/.exec(m); if (r) talk.set(r[1], (talk.get(r[1]) ?? 0) + 1) }
    for (const [name, n] of talk) if (n >= 2) out.push(`${name} talks to me often; we are becoming friends.`)
    return out.slice(0, 3)
  }

  async decide(p: Persona, obs: Observation): Promise<Action> {
    await new Promise(r => setTimeout(r, 300 + Math.random() * 500)) // fake latency
    const [s, e] = p.sleepWindow
    const inSleepWindow = s < e ? obs.hour >= s && obs.hour < e : obs.hour >= s || obs.hour < e
    const n = obs.needs
    // be sociable now and then, and answer if spoken to
    if (obs.heard.length && Math.random() < 0.6) {
      return { type: 'say', text: pick(['Oh, hi!', 'Yeah, same here.', 'How is your day going?']), emotion: 'happy', gesture: pick(['nod', 'wave_right', '']) || undefined, thought: `${obs.others[0]?.name ?? 'Someone'} spoke to me` }
    }
    if (obs.others.length && Math.random() < 0.12) return { type: 'say', text: pick(['（微笑）（挥挥右手）Hello!', 'What are you up to?', '(happy) Nice room, huh?']) }
    if (n.energy < 20 || (inSleepWindow && n.energy < 80)) {
      // out camping, the tent is right there; otherwise camp out only now and then
      const cot = obs.objects.find(o => !o.inUseBy && o.verbs.includes('sleep_in_tent'))
      if (cot && Math.random() < (obs.place === 'meadow' ? 0.85 : 0.1)) {
        return { type: 'interact', object: cot.id, verb: 'sleep_in_tent', thought: 'It is a nice night, I will sleep in the tent.' }
      }
      return { type: 'interact', object: obs.yourBed, verb: 'sleep' }
    }
    // some evenings, go camping: an evening by the campfire, and then the tent
    if (obs.hour >= 17 && obs.hour < 23 && Math.random() < CAMP_CHANCE) {
      const fire = obs.objects.filter(o => !o.inUseBy && o.verbs.some(v => v === 'sit_by_fire' || v === 'warm_up'))
      const spot = pick(fire)
      if (spot) {
        const verb = spot.verbs.find(v => v === 'sit_by_fire' || v === 'warm_up')!
        return { type: 'interact', object: spot.id, verb, thought: 'What a lovely evening, I will go and sit by the campfire.' }
      }
    }
    // now and then, act out how it feels: stretch when tired, think when curious, cheer when in a good mood
    if (Math.random() < 0.08) {
      const g = n.energy < 45 ? 'stretch' : n.knowledge < 40 ? 'think' : n.fun > 70 ? pick(['cheer', 'jump']) : pick(['nod', 'shrug', 'raise_right_hand'])
      return { type: 'gesture', gesture: g, emotion: n.energy < 45 ? 'relaxed' : n.fun > 70 ? 'happy' : 'neutral', thought: 'Just moving a bit.' }
    }
    // every free activity in the room, scored by how much the agent needs what it gives
    const scores: [number, Action][] = obs.objects
      .filter(o => !o.inUseBy)
      .flatMap(o => o.verbs.filter(v => v !== 'sleep' && v !== 'sleep_in_tent').map((v): [number, Action] => {
        const need = VERB_NEED[v]
        const score = (need ? 100 - n[need] : CHORE_SCORE) + (o.outside ? OUTSIDE_BONUS : 0)
        return [score, { type: 'interact', object: o.id, verb: v }]
      }))
    if (!scores.length) return { type: 'wait', minutes: 10 }
    scores.sort((a, b) => b[0] + Math.random() * 15 - (a[0] + Math.random() * 15))
    return scores[0][1]
  }
}

export interface LLMOptions {
  /** full chat-completions URL, e.g. http://localhost:11434/v1/chat/completions */
  url: string
  model: string
  apiKey?: string
  /**
   * Send the instructions as a real `system` message. Off by default: some hosted models (e.g. Gemini via
   * gateways) follow instructions much more reliably when they sit in the user turn.
   */
  systemRole?: boolean
  timeoutMs?: number
}

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]

/** Calls any OpenAI-compatible chat endpoint (your own model server, Ollama, LM Studio, vLLM, ...). */
export class LLMBrain implements Brain {
  /** last problem, shown in the HUD; empty when healthy */
  status = ''
  /** how model replies were handled, for evaluation */
  stats = { calls: 0, strict: 0, coerced: 0, failed: 0, totalMs: 0 }
  private fallback = new MockBrain()

  constructor(private o: LLMOptions) {}

  async decide(p: Persona, obs: Observation): Promise<Action> {
    try {
      const action = await this.ask(p, obs)
      this.status = ''
      return action
    } catch (err) {
      this.status = `LLM error (using fallback): ${err instanceof Error ? err.message : err}`
      console.warn(this.status)
      return this.fallback.decide(p, obs)
    }
  }

  async reflect(p: Persona, memories: string[]): Promise<string[]> {
    try {
      const text = await this.chat(
        `You are ${p.name}. ${p.description}\nBelow are your recent memories. Write 1-3 high-level insights about yourself, your habits, or your relationships, ` +
          `in first person, one sentence each. Reply with a JSON array of strings only.`,
        memories.join('\n'),
      )
      const a = text.indexOf('['), b = text.lastIndexOf(']')
      const arr = JSON.parse(text.slice(a, b + 1))
      return (Array.isArray(arr) ? arr : []).filter(x => typeof x === 'string').slice(0, 3)
    } catch (err) {
      console.warn('LLM reflect failed, using fallback:', err)
      return this.fallback.reflect(p, memories)
    }
  }

  private async ask(p: Persona, obs: Observation): Promise<Action> {
    // spell out every legal action so the model copies one instead of inventing a format
    const legal = obs.objects
      .filter(o => !o.inUseBy)
      .flatMap(o => o.verbs.map(v => `{"type":"interact","object":"${o.id}","verb":"${v}"}`))
    const system =
      `You are ${p.name}, an AI living in a small house with a fenced yard, and a meadow with a pond a lake with a pier (swim, fish) a campfire and a tent with two cots beyond the gate, in a 3D world. ${p.description}\n` +
      `You live a natural daily life: sleep at night, and spend your day on things you enjoy. Needs (0-100, low = urgent): energy, fun, knowledge.\n` +
      `Your bed is "${obs.yourBed}". Objects marked inUseBy are taken by someone else. Objects marked "outside":true are outside the house: ` +
      `you walk out through the door (and the gate, for the meadow) to use them, so they are a nice change in good daylight. ` +
      `"place" tells you where you are. Now and then you may go camping: spend the evening by the campfire, then sleep in the tent (once you are in the meadow that is easier than walking home). Some activities are only offered at certain hours.\n` +
      `You share the house with others (see "others"); "heard" shows what they said to you. Be natural, not repetitive.\n` +
      `"memories" are things you recall that relate to the moment; "insights" are your own conclusions about your life. Let them shape your choices and what you say.\n\n` +
      `Choose ONE next action. Your reply MUST be exactly one JSON object with a "thought" key (one short sentence) plus ONE of these action shapes, copied exactly:\n` +
      legal.map(l => `- ${l.slice(0, -1)},"thought":"..."}`).join('\n') + '\n' +
      `- {"type":"say","text":"<what you say aloud>","emotion":"happy","gesture":"wave_right","thought":"..."}\n` +
      `- {"type":"gesture","gesture":"nod","emotion":"happy","thought":"..."}\n` +
      `- {"type":"wait","minutes":10,"thought":"..."}\n` +
      `You have a body and a face: "gesture" moves your body and "emotion" sets your face. Both are optional on say; ` +
      `you may also start the text with tags like (smile)(wave) or （微笑）（挥挥右手）. Available ${actingHelp()}. ` +
      `A gesture only happens if there is room for it; lastResult tells you when something was in the way.\n` +
      `Use only the "type" values interact, say, gesture, wait. Do not add any other keys, plans or commands. Output the JSON object only. If lastResult reports an error, pick a different action.`

    this.stats.calls++
    const t0 = performance.now()
    const reply = await this.chat(system, JSON.stringify(obs))
    this.stats.totalMs += performance.now() - t0
    try {
      const a = parseAction(reply)
      this.stats.strict++
      return a
    } catch {
      const c = coerceAction(reply, obs)
      if (c) { this.stats.coerced++; return c }
      this.stats.failed++
      throw new Error(`unusable reply: ${reply.replace(/\s+/g, ' ').slice(0, 100)}`)
    }
  }

  private async chat(system: string, user: string): Promise<string> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 30000)
    try {
      const res = await fetch(this.o.url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.o.apiKey && { Authorization: `Bearer ${this.o.apiKey}` }),
        },
        body: JSON.stringify({
          model: this.o.model,
          temperature: 0.8,
          messages: this.o.systemRole
            ? [{ role: 'system', content: system }, { role: 'user', content: user }]
            : [{ role: 'user', content: `${system}\n\nCurrent situation:\n${user}\n\nYour reply:` }],
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)
      const data = await res.json()
      return data.choices?.[0]?.message?.content ?? ''
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Models often wrap JSON in prose or code fences; pull out the first balanced object and validate it. */
export function parseAction(text: string): Action {
  const start = text.indexOf('{')
  if (start < 0) throw new Error('no JSON in reply')
  let depth = 0, end = -1
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) { end = i; break }
  }
  if (end < 0) throw new Error('unterminated JSON')
  const a = JSON.parse(text.slice(start, end + 1))
  if (a.type === 'interact' && typeof a.object === 'string' && typeof a.verb === 'string') return a
  if (a.type === 'say' && typeof a.text === 'string') {
    // tags at the start of the text, e.g. "（微笑）早上好", become the emotion and the gesture
    const t = splitTags(a.text)
    return { ...a, text: t.text || a.text, emotion: a.emotion ?? t.emotion, gesture: a.gesture ?? t.gesture }
  }
  if (a.type === 'gesture' && typeof a.gesture === 'string') return { ...a, gesture: gestureOf(a.gesture) ?? a.gesture }
  if (a.type === 'wait') return { ...a, minutes: Number(a.minutes) || 10 }
  throw new Error(`bad action: ${JSON.stringify(a).slice(0, 100)}`)
}

/**
 * Second line of defence for replies that are JSON-ish but not in our schema, e.g.
 * {"action":"sleep(bed=bed2)"} or {"command":"sleep bed2"}: recover the intent by finding a
 * legal (object, verb) pair mentioned in the reply. Returns null if nothing legal is found.
 */
export function coerceAction(text: string, obs: Observation): Action | null {
  const has = (w: string) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text) // whole word only
  const free = obs.objects.filter(o => !o.inUseBy)
  const thought = /"(?:thought|plan|reason)"\s*:\s*"([^"]{1,200})"/i.exec(text)?.[1]
  const withThought = (a: Action): Action => (thought ? { ...a, thought } : a)

  // 1) an object id and one of its verbs both appear
  const both = free.flatMap(o => o.verbs.map(v => ({ o, v }))).filter(({ o, v }) => has(o.id) && has(v))
  if (both.length) {
    const pick = both.find(x => x.o.id === obs.yourBed) ?? both[0]
    // "sleep in a bed" means *her* bed, not whichever bed the model happened to name
    const mine = free.find(o => o.id === obs.yourBed)
    if (mine && mine.kind === pick.o.kind && mine.verbs.includes(pick.v)) return withThought({ type: 'interact', object: mine.id, verb: pick.v })
    return withThought({ type: 'interact', object: pick.o.id, verb: pick.v })
  }
  // 1b) only an object appears and it has a single verb (e.g. "target": "desk")
  const named = free.filter(o => o.verbs.length === 1 && has(o.id))
  if (named.length === 1) return withThought({ type: 'interact', object: named[0].id, verb: named[0].verbs[0] })
  // 2) only a verb appears and it is unambiguous (e.g. "sleep" -> your bed)
  const byVerb = free.flatMap(o => o.verbs.map(v => ({ o, v }))).filter(({ v }) => has(v))
  const uniq = [...new Set(byVerb.map(x => x.v))]
  if (uniq.length === 1) {
    const pick = byVerb.find(x => x.o.id === obs.yourBed) ?? byVerb[0]
    return withThought({ type: 'interact', object: pick.o.id, verb: pick.v })
  }
  // 3) plain speech
  const say = /"text"\s*:\s*"([^"]{1,300})"/i.exec(text)?.[1]
  if (say && !/"target"|"object"/i.test(text)) return withThought({ type: 'say', text: say })
  return null
}
