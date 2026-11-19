/**
 * AIRI in the world: an outside AI (for example the AIRI desktop app, through its MCP settings) lives in the game as
 * one of the characters and decides for herself. The other characters keep their own brains, as NPCs.
 *
 * The path is AIRI ⇄ MCP ⇄ bridge/airi-mcp.mjs ⇄ WebSocket ⇄ this page. AiriLink is the page's end of the
 * WebSocket: it answers the bridge's requests (status, look, act) and reports what happens to the character.
 * AiriBrain is that character's brain: while AIRI is connected, every decision waits for AIRI's next action, and
 * the character's own brain is not asked. Without AIRI it is the character's usual brain.
 */
import type { Agent } from './agent'
import type { Action, Brain, Observation, Persona } from './types'
import type { World } from './world'
import { EMOTIONS, GESTURES } from './acting'

/** where the bridge listens by default (bridge/airi-mcp.mjs, --ws) */
export const DEFAULT_BRIDGE = 'ws://127.0.0.1:8789'
/** the character AIRI plays */
export const AIRI_NAME = 'Airi'

/** the brain of the character AIRI plays: AIRI's actions while AIRI is connected, the usual brain otherwise */
export class AiriBrain implements Brain {
  /** AIRI is connected and decides for the character */
  private on = false
  /** an action AIRI sent before the character was ready for it */
  private queued: Action | null = null
  /** the decision the character is waiting on, while AIRI has not acted yet */
  private waiting: { persona: Persona; obs: Observation; resolve: (a: Action) => void; reject: (e: unknown) => void } | null = null
  /** told each time the character needs a decision (AiriLink passes it on as an event) */
  onTurn?: (obs: Observation) => void

  constructor(private readonly own: Brain) {}

  get controlled() { return this.on }
  /** the character is standing by for AIRI's next action */
  get awaiting() { return this.waiting !== null }

  decide(persona: Persona, obs: Observation): Promise<Action> {
    if (!this.on) return this.own.decide(persona, obs)
    if (this.queued) {
      const a = this.queued
      this.queued = null
      return Promise.resolve(a)
    }
    this.onTurn?.(obs)
    return new Promise((resolve, reject) => { this.waiting = { persona, obs, resolve, reject } })
  }

  reflect(persona: Persona, memories: string[]) {
    return this.own.reflect ? this.own.reflect(persona, memories) : Promise.resolve([])
  }

  /** AIRI connected or left. Leaving hands a waiting decision back to the character's own brain. */
  setControl(on: boolean) {
    this.on = on
    if (on) return
    this.queued = null
    const w = this.waiting
    this.waiting = null
    if (w) this.own.decide(w.persona, w.obs).then(w.resolve, w.reject)
  }

  /** AIRI's next action: taken now if the character is waiting for one, else when it next decides */
  act(a: Action): 'now' | 'queued' {
    const w = this.waiting
    if (w) {
      this.waiting = null
      w.resolve(a)
      return 'now'
    }
    this.queued = a
    return 'queued'
  }
}

/** a request from the bridge, and the page's answer */
type Request = { id: number; method: 'status' | 'look' | 'act'; params?: Record<string, unknown> }
type FromBridge = Request | { type: 'control'; on: boolean }

/** what an event tells AIRI: something the character noticed or did, or that it is waiting for a decision */
export interface AiriEvent { time: string; kind: 'memory' | 'turn'; text: string }

/** The page's end of the bridge: connects, reconnects, answers requests and reports events. */
export class AiriLink {
  private ws: WebSocket | null = null
  private seen: number
  private retry?: ReturnType<typeof setTimeout>
  state: 'connecting' | 'open' | 'closed' = 'connecting'

  constructor(
    private readonly url: string,
    private readonly brain: AiriBrain,
    private readonly me: Agent,
    private readonly world: World,
    private readonly everyone: readonly Agent[],
  ) {
    this.seen = me.logged
    brain.onTurn = obs => this.send({ type: 'event', event: { time: obs.time, kind: 'turn', text: turnText(obs) } })
    this.connect()
  }

  /** one line for the HUD */
  get statusText() {
    if (this.state !== 'open') return `AIRI: waiting for the bridge at ${this.url}`
    return this.brain.controlled ? `AIRI: connected, playing ${this.me.name}` : 'AIRI: bridge connected, no AIRI yet'
  }

  /** call each frame: passes on what the character has noticed or done since the last call */
  update() {
    const mem = this.me.memory
    // the memory keeps only its last 50 lines: count what is new by the running total of lines
    const fresh = Math.min(mem.length, this.me.logged - this.seen)
    this.seen = this.me.logged
    for (const line of mem.slice(mem.length - fresh)) {
      const [time, ...rest] = line.split('  ')
      this.send({ type: 'event', event: { time, kind: 'memory', text: rest.join('  ') } })
    }
  }

  private connect() {
    this.state = 'connecting'
    let ws: WebSocket
    try { ws = new WebSocket(this.url) } catch { this.later(); return }
    this.ws = ws
    ws.onopen = () => { this.state = 'open' }
    ws.onclose = () => {
      this.state = 'closed'
      this.ws = null
      this.brain.setControl(false)
      this.later()
    }
    ws.onerror = () => ws.close()
    ws.onmessage = e => {
      let msg: FromBridge
      try { msg = JSON.parse(String(e.data)) as FromBridge } catch { return }
      if ('type' in msg) {
        if (msg.type === 'control') this.brain.setControl(!!msg.on)
        return
      }
      this.answer(msg).then(
        result => this.send({ id: msg.id, result }),
        (err: unknown) => this.send({ id: msg.id, error: err instanceof Error ? err.message : String(err) }),
      )
    }
  }

  private later() {
    clearTimeout(this.retry)
    this.retry = setTimeout(() => this.connect(), 3000)
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private async answer(req: Request): Promise<unknown> {
    switch (req.method) {
      case 'status': return this.status()
      case 'look': {
        const o = this.me.look()
        return { you: this.you(), ...o, needs: this.you().needs }
      }
      case 'act': return this.act(req.params ?? {})
    }
  }

  private you() {
    const a = this.me
    return {
      name: a.name, doing: a.activity, place: this.world.placeOf(a.pos), pose: a.pose,
      needs: Object.fromEntries(Object.entries(a.needs).map(([k, v]) => [k, Math.round(v)])),
      waitingForYou: this.brain.awaiting,
    }
  }

  private status() {
    return {
      time: this.world.clock,
      you: this.you(),
      others: this.everyone.filter(a => a !== this.me).map(a => ({ name: a.name, doing: a.activity, place: this.world.placeOf(a.pos) })),
      gestures: GESTURES,
      emotions: EMOTIONS,
    }
  }

  /** take an action from AIRI: check its shape, end the current activity if asked, and hand it to the brain */
  private async act(p: Record<string, unknown>) {
    const str = (k: string) => typeof p[k] === 'string' && (p[k] as string).trim() ? (p[k] as string).trim() : undefined
    const extra = { thought: str('thought'), emotion: str('emotion'), gesture: p.type === 'say' ? str('gesture') : undefined }
    let action: Action
    switch (p.type) {
      case 'interact': {
        const object = str('object'), verb = str('verb')
        if (!object || !verb) throw new Error('interact needs "object" and "verb" (see look: objects)')
        action = { type: 'interact', object, verb, ...extra }
        break
      }
      case 'say': {
        const text = str('text')
        if (!text) throw new Error('say needs "text"')
        action = { type: 'say', text, ...extra }
        break
      }
      case 'gesture': {
        const gesture = str('gesture')
        if (!gesture) throw new Error('gesture needs "gesture" (see world_status: gestures)')
        action = { type: 'gesture', gesture, thought: extra.thought, emotion: extra.emotion }
        break
      }
      case 'wait': {
        const minutes = Number(p.minutes)
        if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('wait needs "minutes" (game minutes, 1 to 120)')
        action = { type: 'wait', minutes, thought: extra.thought, emotion: extra.emotion }
        break
      }
      default:
        throw new Error('type must be one of interact, say, gesture, wait')
    }
    if (!this.brain.controlled) throw new Error(`${this.me.name} is not under your control (the bridge has no MCP client)`)
    const before = this.me.lastResult
    const stopped = p.interrupt === true && this.me.stopActivity()
    const when = this.brain.act(action)
    // an action taken now is checked at once: give AIRI the result (an invalid object, a busy seat) straight away
    await new Promise(r => setTimeout(r, 0))
    const result = this.me.lastResult !== before ? this.me.lastResult : undefined
    return {
      accepted: when === 'now' ? 'doing it now'
        : stopped ? 'stopping the current activity, then doing it'
        : p.interrupt === true ? `queued: ${this.me.name} is in the middle of ${this.me.activity}, which cannot be cut short; it runs right after`
        : `queued: ${this.me.name} is busy (${this.me.activity}); it runs when that ends, or send interrupt: true`,
      ...(result && { result }),
      doing: this.me.activity,
    }
  }
}

/** a short line for a decision event: when, what just happened, what was heard */
function turnText(obs: Observation) {
  const parts = [`your turn to decide (place: ${obs.place})`]
  if (obs.lastResult) parts.push(`last: ${obs.lastResult}`)
  if (obs.heard.length) parts.push(`heard: ${obs.heard.join(' | ')}`)
  return parts.join('. ')
}
