export interface Memory {
  id: number
  /** game minutes when it happened */
  time: number
  text: string
  /** 1 (mundane) .. 10 (life-changing) */
  importance: number
  kind: 'event' | 'reflection'
  lastAccess: number
}

const STOP = new Set(['the', 'and', 'for', 'was', 'with', 'that', 'this', 'its', 'you', 'are', 'got', 'had', 'has'])
const tokens = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)))

/**
 * Memory stream in the style of "Generative Agents": every event is stored, and recall ranks by
 * recency + importance + relevance to the current situation. Relevance here is keyword overlap
 * (swap `relevance` for embedding similarity later).
 */
export class MemoryStream {
  items: Memory[] = []
  private nextId = 1
  /** importance accumulated since the last reflection */
  unreflected = 0

  constructor(private cap = 400) {}

  add(time: number, text: string, importance = 2, kind: Memory['kind'] = 'event') {
    const m: Memory = { id: this.nextId++, time, text, importance, kind, lastAccess: time }
    this.items.push(m)
    if (kind === 'event') this.unreflected += importance
    if (this.items.length > this.cap) this.prune()
    return m
  }

  /** Top-k memories for a situation description. */
  retrieve(now: number, query: string, k = 6): Memory[] {
    const q = tokens(query)
    const scored = this.items.map(m => {
      const hours = Math.max(0, (now - m.lastAccess) / 60)
      const recency = Math.pow(0.99, hours)
      const mt = tokens(m.text)
      let overlap = 0
      for (const t of q) if (mt.has(t)) overlap++
      const relevance = q.size ? overlap / q.size : 0
      return { m, score: recency + m.importance / 10 + relevance }
    })
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, k).map(s => s.m)
    top.forEach(m => (m.lastAccess = now))
    return top
  }

  recent(n: number) { return this.items.slice(-n) }
  reflections(n = 3) { return this.items.filter(m => m.kind === 'reflection').slice(-n) }

  /** Forget the least valuable events first; reflections are kept. */
  private prune() {
    let worst = -1, worstScore = Infinity
    this.items.forEach((m, i) => {
      if (m.kind === 'reflection') return
      const s = m.importance * 1000 + m.time / 1000 // low importance, then oldest
      if (s < worstScore) { worstScore = s; worst = i }
    })
    if (worst >= 0) this.items.splice(worst, 1)
  }

  toJSON() { return { items: this.items, nextId: this.nextId, unreflected: this.unreflected } }

  static fromJSON(d: any, cap?: number) {
    const s = new MemoryStream(cap)
    if (d && Array.isArray(d.items)) {
      s.items = d.items
      s.nextId = d.nextId ?? s.items.length + 1
      s.unreflected = d.unreflected ?? 0
    }
    return s
  }
}
