/**
 * Motion clips: walking and standing motion captured from a motion model (Kimodo, see tools/kimodo), stored as VRM
 * animations (.vrma) in public/motions and listed in public/motions/index.json.
 *
 * The clips play under the rest of the avatar's motion: the avatar's own pose is blended towards the clip, then
 * gestures, the head turning to look at someone, and the hands reaching for things (IK) go on top. Each person picks
 * a clip of the right kind at random, and a new one now and then, so motion does not repeat.
 * Without the motion files the game runs on its procedural motion alone.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { VRM } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, createVRMAnimationHumanoidTracks, type VRMAnimation } from '@pixiv/three-vrm-animation'

export type ClipKind = 'walk' | 'idle'

/** an entry of public/motions/index.json */
export interface ClipInfo {
  file: string
  kind: ClipKind
  /** walks: the walking speed of the clip in m/s, to match the playback rate to the walker */
  speed?: number
  /** the prompt the clip was made from */
  prompt?: string
}

/** the motion files, loaded once and shared by everybody */
export class MotionLibrary {
  constructor(readonly clips: { info: ClipInfo; anim: VRMAnimation }[] = []) {}

  static async load(base = 'motions/'): Promise<MotionLibrary> {
    let list: ClipInfo[]
    try {
      const res = await fetch(`${base}index.json`)
      if (!res.ok) return new MotionLibrary()
      list = await res.json() as ClipInfo[]
    } catch {
      return new MotionLibrary()
    }
    const loader = new GLTFLoader()
    loader.register(parser => new VRMAnimationLoaderPlugin(parser))
    const clips = await Promise.all(list.map(async info => {
      const gltf = await loader.loadAsync(`${base}${info.file}`)
      const anim = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0]
      return anim ? { info, anim } : null
    }))
    return new MotionLibrary(clips.filter(c => c !== null))
  }

  of(kind: ClipKind) {
    return this.clips.filter(c => c.info.kind === kind)
  }
}

/**
 * Bones the clips leave alone: the avatar sets the head and neck (looking at people, nodding) and the fingers
 * after the clip, each frame. A clip under them mixed with that pose by an amount that depended on the frame time,
 * so the head twitched when a frame took longer.
 */
const OWN_BONES = /^(?:head|neck|(?:left|right)(?:Thumb|Index|Middle|Ring|Little))/

/** one clip, bound to one avatar's bones, sampled by hand so it can blend with the avatar's own pose */
class BoundClip {
  readonly duration: number
  private readonly bones: { node: THREE.Object3D; sample: THREE.Interpolant }[] = []
  private readonly hips?: { node: THREE.Object3D; sample: THREE.Interpolant }

  constructor(readonly info: ClipInfo, anim: VRMAnimation, vrm: VRM) {
    this.duration = anim.duration
    const meta = vrm.meta.metaVersion === '0' ? '0' : '1'
    const tracks = createVRMAnimationHumanoidTracks(anim, vrm.humanoid, meta)
    for (const [bone, track] of tracks.rotation) {
      if (OWN_BONES.test(bone)) continue
      const node = vrm.humanoid.getNormalizedBoneNode(bone)
      if (node) this.bones.push({ node, sample: track.InterpolantFactoryMethodLinear() })
    }
    const hips = tracks.translation.get('hips'), node = vrm.humanoid.getNormalizedBoneNode('hips')
    if (hips && node) this.hips = { node, sample: hips.InterpolantFactoryMethodLinear() }
  }

  /** blend every bone `w` of the way to the clip's pose at `time` (seconds, wrapped round the loop) */
  apply(time: number, w: number, q = new THREE.Quaternion()) {
    const t = ((time % this.duration) + this.duration) % this.duration
    for (const b of this.bones) {
      const v = b.sample.evaluate(t)
      b.node.quaternion.slerp(q.set(v[0], v[1], v[2], v[3]), w)
    }
  }

  /** the hips' height in the clip at `time` */
  hipsY(time: number) {
    if (!this.hips) return null
    const t = ((time % this.duration) + this.duration) % this.duration
    return this.hips.sample.evaluate(t)[1]
  }
}

/** seconds to blend from one clip to the next, or in and out of clips */
const FADE = 0.35

/**
 * Plays clips on one avatar: the kind it is asked for, a random clip of that kind, fading between them. Idle clips
 * change to another at random after a loop or two.
 */
export class ClipPlayer {
  private readonly bound = new Map<ClipKind, BoundClip[]>()
  private cur: { clip: BoundClip; time: number; loops: number } | null = null
  private prev: { clip: BoundClip; time: number; w: number } | null = null
  /** how much of the pose comes from clips, fading in and out */
  weight = 0
  private readonly q = new THREE.Quaternion()

  constructor(lib: MotionLibrary, vrm: VRM, private readonly rnd: () => number = Math.random) {
    for (const { info, anim } of lib.clips) {
      const list = this.bound.get(info.kind) ?? []
      list.push(new BoundClip(info, anim, vrm))
      this.bound.set(info.kind, list)
    }
  }

  has(kind: ClipKind) {
    return !!this.bound.get(kind)?.length
  }

  private pick(kind: ClipKind, not?: BoundClip) {
    const list = this.bound.get(kind) ?? []
    const choices = list.length > 1 ? list.filter(c => c !== not) : list
    return choices[Math.floor(this.rnd() * choices.length)]
  }

  /**
   * Advance and apply. `kind` is what the avatar is doing (null: no clip). `rate` scales the playback speed (a
   * walk plays at the walker's pace; negative plays it backwards).
   */
  update(dt: number, kind: ClipKind | null, rate = 1) {
    const want = kind && this.has(kind) ? kind : null
    if (want && (!this.cur || this.cur.clip.info.kind !== want)) this.switchTo(this.pick(want))
    this.weight += ((want ? 1 : 0) - this.weight) * (1 - Math.exp(-dt / (FADE / 3)))
    if (!this.cur || this.weight < 0.005) {
      if (!want) this.cur = null
      return
    }
    const c = this.cur
    c.time += dt * (want ? rate : 1)
    if (c.time >= c.clip.duration * (c.loops + 1)) {
      c.loops++
      // standing about: now and then change to another idle clip
      if (want === 'idle' && this.rnd() < 0.5) this.switchTo(this.pick('idle', c.clip))
    }
    if (this.prev) {
      this.prev.time += dt * (want ? rate : 1)
      this.prev.w -= dt / FADE
      if (this.prev.w <= 0) this.prev = null
    }
    // the clip fading out first, then the current one over it
    if (this.prev) this.prev.clip.apply(this.prev.time, this.weight * this.prev.w, this.q)
    this.cur.clip.apply(this.cur.time, this.weight * (this.prev ? 1 - this.prev.w : 1), this.q)
  }

  /** the hips' height in the current clip, or null */
  hipsY() {
    return this.cur ? this.cur.clip.hipsY(this.cur.time) : null
  }

  /** the walking speed the current clip was made at, if it is a walk */
  clipSpeed() {
    return this.cur?.clip.info.speed ?? null
  }

  private switchTo(clip: BoundClip | undefined) {
    if (!clip) return
    if (this.cur) this.prev = { clip: this.cur.clip, time: this.cur.time, w: 1 }
    // start somewhere along a walk or an idle clip, so two people do not move in step
    this.cur = { clip, time: clip.info.kind === 'idle' ? this.rnd() * clip.duration : 0, loops: 0 }
  }
}
