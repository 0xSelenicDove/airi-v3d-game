import type { Action, Brain, Observation, Persona } from './types'

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
    if (obs.heard.length && Math.random() < 0.6) return { type: 'say', text: pick(['Oh, hi!', 'Yeah, same here.', 'How is your day going?']), thought: `${obs.others[0]?.name ?? 'Someone'} spoke to me` }
    if (obs.others.length && Math.random() < 0.12) return { type: 'say', text: pick(['Hello!', 'What are you up to?', 'Nice room, huh?']) }
    const free = (id: string) => !obs.objects.find(o => o.id === id)?.inUseBy
    if (n.energy < 20 || (inSleepWindow && n.energy < 80)) return { type: 'interact', object: obs.yourBed, verb: 'sleep' }
    const scores: [number, Action][] = [
      [free('desk') ? 100 - n.fun : -1, { type: 'interact', object: 'desk', verb: 'use_computer' }],
      [100 - n.knowledge, { type: 'interact', object: 'bookshelf', verb: 'read' }],
    ]
    scores.sort((a, b) => b[0] + Math.random() * 15 - (a[0] + Math.random() * 15))
    return scores[0][1]
  }
}

export interface LLMOptions {
  /** full chat-completions URL, e.g. http://localhost:11434/v1/chat/completions */
  url: string
  model: string
  apiKey?: string
  timeoutMs?: number
}

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]

/** Calls any OpenAI-compatible chat endpoint (your own model server, Ollama, LM Studio, vLLM, ...). */
export class LLMBrain implements Brain {
  /** last problem, shown in the HUD; empty when healthy */
  status = ''
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
    const verbs = obs.objects.map(o => `${o.id} (${o.kind}): ${o.verbs.join(', ')}`).join('\n')
    const system =
      `You are ${p.name}, an AI living in a small room in a 3D world. ${p.description}\n` +
      `You live a natural daily life: sleep at night, and spend your day on things you enjoy. Needs (0-100, low = urgent): energy, fun, knowledge.\n` +
      `Your bed is "${obs.yourBed}". Beds and chairs fit one person at a time; objects marked inUseBy are taken.\n` +
      `You share the room with others (see "others"); you may talk to them with a say action, and "heard" shows what they said to you. Be natural, not repetitive.\n` +
      `Things you can interact with:\n${verbs}\n\n` +
      `Choose ONE next action. Reply with a single JSON object and nothing else:\n` +
      `{"thought":"<one short sentence>","type":"interact","object":"<id>","verb":"<verb>"}\n` +
      `{"thought":"...","type":"say","text":"..."}\n` +
      `{"thought":"...","type":"wait","minutes":10}\n` +
      `"memories" are things you recall that relate to the moment; "insights" are your own conclusions about your life. Let them shape your choices and what you say. ` +
      `Use only the objects and verbs listed. If lastResult reports an error, fix it.`

    return parseAction(await this.chat(system, JSON.stringify(obs)))
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
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
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
  if (a.type === 'say' && typeof a.text === 'string') return a
  if (a.type === 'wait') return { ...a, minutes: Number(a.minutes) || 10 }
  throw new Error(`bad action: ${JSON.stringify(a).slice(0, 100)}`)
}
