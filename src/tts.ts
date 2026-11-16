import type { Persona } from './types'

/** Per-persona voice character. Pitch/rate are tweaked so two agents are easy to tell apart. */
export interface VoiceStyle { pitch: number; rate: number; /** substring preferred in the voice name, e.g. "Samantha" */ prefer?: string }

/**
 * Text-to-speech through the browser's built-in Web Speech API (no backend, no key).
 * Browsers only allow speech after a user gesture, so it stays silent until the first click or key press.
 */
export class Speaker {
  enabled = true
  private unlocked = false
  private voices: SpeechSynthesisVoice[] = []
  private assigned = new Map<string, SpeechSynthesisVoice | undefined>()
  readonly supported = typeof speechSynthesis !== 'undefined'

  constructor() {
    if (!this.supported) return
    const load = () => { this.voices = speechSynthesis.getVoices() }
    load()
    speechSynthesis.addEventListener('voiceschanged', load)
    const unlock = () => { this.unlocked = true; removeEventListener('pointerdown', unlock); removeEventListener('keydown', unlock) }
    addEventListener('pointerdown', unlock)
    addEventListener('keydown', unlock)
  }

  toggle() {
    this.enabled = !this.enabled
    if (!this.enabled && this.supported) speechSynthesis.cancel()
    return this.enabled
  }

  /** Give each persona its own voice (distinct where the system has enough of them). */
  private voiceFor(p: Persona, style: VoiceStyle) {
    if (this.assigned.has(p.name)) return this.assigned.get(p.name)
    // skip macOS novelty voices (Albert, Bad News, Zarvox, ...), which are unpleasant for conversation
    const novelty = /Albert|Bad |Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Ralph|Kathy/
    const en = this.voices.filter(v => /^en/i.test(v.lang) && !novelty.test(v.name))
    const pool = en.length ? en : this.voices
    const taken = new Set([...this.assigned.values()])
    const v = pool.find(x => style.prefer && x.name.includes(style.prefer) && !taken.has(x)) ?? pool.find(x => !taken.has(x)) ?? pool[0]
    if (this.voices.length) this.assigned.set(p.name, v) // only cache once voices are loaded
    return v
  }

  /** volume 0..1, e.g. lower for agents far from the camera */
  say(p: Persona, text: string, style: VoiceStyle, volume = 1) {
    if (!this.supported || !this.enabled || !this.unlocked || volume <= 0.02) return
    const u = new SpeechSynthesisUtterance(text)
    const v = this.voiceFor(p, style)
    if (v) { u.voice = v; u.lang = v.lang }
    u.pitch = style.pitch
    u.rate = style.rate
    u.volume = Math.min(1, volume)
    speechSynthesis.speak(u) // queued: a second speaker waits for the first to finish
  }
}
