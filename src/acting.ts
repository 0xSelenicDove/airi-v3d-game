/**
 * What an agent can act out: body gestures and facial emotions, with the words the LLM may use for them.
 *
 * The LLM picks them in two ways:
 * - JSON keys: {"type":"gesture","gesture":"wave_right"}, or "emotion" / "gesture" on a "say" action
 * - leading tags in what it says, Chinese or English: "（微笑）（挥挥右手）早上好！" or "(smile) Morning!"
 * The game plays them procedurally on any VRM and checks first that the body has room for the movement.
 */

export const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'relaxed', 'shy'] as const
export type Emotion = (typeof EMOTIONS)[number]

export const GESTURES = [
  'wave_right', 'wave_left', 'raise_right_hand', 'raise_left_hand', 'raise_right_leg', 'raise_left_leg',
  'nod', 'shake_head', 'bow', 'stretch', 'clap', 'point', 'shrug', 'cheer', 'jump', 'think',
] as const
export type Gesture = (typeof GESTURES)[number]

/** where the body needs free space for a gesture, in the agent's own frame (x right, y up, z forward, metres) */
export interface Clearance { from: [number, number, number]; dir: [number, number, number]; reach: number }

export interface GestureInfo {
  /** real seconds */
  duration: number
  /** poses it can be done in; sitting allows only upper-body gestures */
  poses: ('stand' | 'sit')[]
  /** rays that must be free of furniture, walls and people */
  clear: Clearance[]
  /** what the agent says it does, for memory and feedback */
  label: string
}

const R = -1, L = 1 // the agent's right is -x in its own frame (it faces +z)
const up = (side: number, reach = 0.75): Clearance => ({ from: [side * 0.2, 1.35, 0], dir: [side * 0.4, 1, 0], reach })
const out = (side: number, reach = 0.65): Clearance => ({ from: [side * 0.2, 1.3, 0], dir: [side, 0, 0], reach })
const front = (y: number, reach: number): Clearance => ({ from: [0, y, 0.1], dir: [0, 0, 1], reach })

export const GESTURE_INFO: Record<Gesture, GestureInfo> = {
  wave_right: { duration: 2.2, poses: ['stand', 'sit'], clear: [out(R), up(R, 0.6)], label: 'waved with the right hand' },
  wave_left: { duration: 2.2, poses: ['stand', 'sit'], clear: [out(L), up(L, 0.6)], label: 'waved with the left hand' },
  raise_right_hand: { duration: 2.0, poses: ['stand', 'sit'], clear: [up(R)], label: 'raised the right hand' },
  raise_left_hand: { duration: 2.0, poses: ['stand', 'sit'], clear: [up(L)], label: 'raised the left hand' },
  raise_right_leg: { duration: 2.0, poses: ['stand'], clear: [{ from: [-0.1, 0.5, 0.1], dir: [0, 0, 1], reach: 0.55 }], label: 'raised the right leg' },
  raise_left_leg: { duration: 2.0, poses: ['stand'], clear: [{ from: [0.1, 0.5, 0.1], dir: [0, 0, 1], reach: 0.55 }], label: 'raised the left leg' },
  nod: { duration: 1.4, poses: ['stand', 'sit'], clear: [], label: 'nodded' },
  shake_head: { duration: 1.4, poses: ['stand', 'sit'], clear: [], label: 'shook the head' },
  bow: { duration: 2.0, poses: ['stand'], clear: [front(1.3, 0.6)], label: 'bowed' },
  stretch: { duration: 2.6, poses: ['stand', 'sit'], clear: [up(R), up(L)], label: 'stretched' },
  clap: { duration: 1.8, poses: ['stand', 'sit'], clear: [front(1.15, 0.4)], label: 'clapped' },
  point: { duration: 1.8, poses: ['stand', 'sit'], clear: [front(1.3, 0.7)], label: 'pointed ahead' },
  shrug: { duration: 1.5, poses: ['stand', 'sit'], clear: [], label: 'shrugged' },
  cheer: { duration: 2.0, poses: ['stand', 'sit'], clear: [up(R), up(L)], label: 'cheered with both arms up' },
  jump: { duration: 1.0, poses: ['stand'], clear: [{ from: [0, 1.5, 0], dir: [0, 1, 0], reach: 0.6 }], label: 'jumped' },
  think: { duration: 2.2, poses: ['stand', 'sit'], clear: [], label: 'thought it over' },
}

/** words for emotions; Chinese labels follow the LumenAct style, e.g. （微笑） */
const EMOTION_WORDS: Record<string, Emotion> = {
  neutral: 'neutral', calm: 'relaxed', happy: 'happy', smile: 'happy', joy: 'happy', laugh: 'happy', excited: 'happy',
  sad: 'sad', upset: 'sad', cry: 'sad', angry: 'angry', annoyed: 'angry', mad: 'angry', surprised: 'surprised',
  shocked: 'surprised', relaxed: 'relaxed', sleepy: 'relaxed', tired: 'relaxed', shy: 'shy', embarrassed: 'shy',
  平静: 'neutral', 自然: 'neutral', 微笑: 'happy', 开心: 'happy', 高兴: 'happy', 大笑: 'happy', 笑: 'happy', 兴奋: 'happy',
  难过: 'sad', 伤心: 'sad', 哭: 'sad', 失落: 'sad', 生气: 'angry', 愤怒: 'angry', 不满: 'angry', 惊讶: 'surprised',
  吃惊: 'surprised', 震惊: 'surprised', 放松: 'relaxed', 困: 'relaxed', 累: 'relaxed', 害羞: 'shy', 脸红: 'shy',
}

/** words for gestures; Chinese phrases follow the HAST-SEC style, e.g. 挥挥左手, 把右手举高, 抬起右腿 */
const GESTURE_WORDS: [RegExp, Gesture][] = [
  [/挥.*左手|左手.*挥|wave.*left/i, 'wave_left'],
  [/挥.*手|招手|wave/i, 'wave_right'],
  [/(举|抬).*左手|左手.*(举|抬)|raise.*left.*(hand|arm)/i, 'raise_left_hand'],
  [/(举|抬).*右?手|右手.*(举|抬)|raise.*(hand|arm)/i, 'raise_right_hand'],
  [/(举|抬).*左腿|左腿.*(举|抬)|raise.*left.*leg/i, 'raise_left_leg'],
  [/(举|抬).*右?腿|右腿.*(举|抬)|raise.*leg/i, 'raise_right_leg'],
  [/点头|nod/i, 'nod'],
  [/摇头|shake.*head/i, 'shake_head'],
  [/鞠躬|弯腰|bow/i, 'bow'],
  [/伸懒腰|伸展|stretch/i, 'stretch'],
  [/拍手|鼓掌|clap/i, 'clap'],
  [/指|point/i, 'point'],
  [/耸肩|shrug/i, 'shrug'],
  [/欢呼|万岁|cheer|hooray/i, 'cheer'],
  [/跳|jump|hop/i, 'jump'],
  [/思考|想一想|托腮|think|ponder/i, 'think'],
]

export function emotionOf(word: string | undefined): Emotion | undefined {
  if (!word) return undefined
  const w = word.trim().toLowerCase()
  if ((EMOTIONS as readonly string[]).includes(w)) return w as Emotion
  if (EMOTION_WORDS[w]) return EMOTION_WORDS[w]
  const hit = Object.keys(EMOTION_WORDS).filter(k => /[^\x00-\x7f]/.test(k) && w.includes(k)).sort((a, b) => b.length - a.length)[0]
  return hit ? EMOTION_WORDS[hit] : undefined
}

export function gestureOf(word: string | undefined): Gesture | undefined {
  if (!word) return undefined
  const w = word.trim()
  if ((GESTURES as readonly string[]).includes(w.toLowerCase())) return w.toLowerCase() as Gesture
  return GESTURE_WORDS.find(([re]) => re.test(w))?.[1]
}

/**
 * Split leading tags off a line: "（微笑）（挥挥右手）早上好！" -> text "早上好！", emotion happy, gesture wave_right.
 * Tags that are neither are left in the text.
 */
export function splitTags(line: string): { text: string; emotion?: Emotion; gesture?: Gesture } {
  let rest = line.trim(), emotion: Emotion | undefined, gesture: Gesture | undefined
  for (;;) {
    const m = /^[(（]([^()（）]{1,16})[)）]\s*/.exec(rest)
    if (!m) break
    const e = emotion ? undefined : emotionOf(m[1])
    const g = e || gesture ? undefined : gestureOf(m[1])
    if (!e && !g) break
    if (e) emotion = e
    if (g) gesture = g
    rest = rest.slice(m[0].length)
  }
  return { text: rest, emotion, gesture }
}

/** a short list for the LLM prompt */
export function actingHelp() {
  return `gestures: ${GESTURES.join(', ')}; emotions: ${EMOTIONS.join(', ')}`
}
