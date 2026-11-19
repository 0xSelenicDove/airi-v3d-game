/**
 * Drawing resolution that follows the GPU. A laptop browser often runs on the integrated GPU, where drawing the room
 * at full resolution gives about 25 frames per second; with fewer pixels it runs at 50 to 70. When frames stay slow,
 * the pixel ratio steps down; when there is room again, it steps back up. A fast GPU stays at the full ratio.
 */
import type * as THREE from 'three'

/** a frame slower than this on average (ms, about 42 fps) is too slow; one faster than FAST leaves room */
const SLOW_MS = 24
const FAST_MS = 14
/** how long frames must stay slow (or fast) before the ratio changes, seconds */
const SLOW_FOR = 1
const FAST_FOR = 4
/** pixel ratio change per step, and the lowest ratio used */
const STEP = 0.25
const LOWEST = 0.75
/** frames longer than this are hitches (a model loading, the tab coming back), not the steady speed: not counted */
const HITCH_MS = 100

export class AdaptiveResolution {
  /** the pixel ratio in use */
  ratio: number
  private avg = 16
  private slow = 0
  private fast = 0

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly highest: number) {
    this.ratio = highest
    renderer.setPixelRatio(highest)
  }

  /** call once per frame with the time since the last frame, ms */
  update(frameMs: number) {
    if (frameMs > HITCH_MS) return
    this.avg += (frameMs - this.avg) * 0.05
    const s = frameMs / 1000
    this.slow = this.avg > SLOW_MS ? this.slow + s : 0
    this.fast = this.avg < FAST_MS ? this.fast + s : 0
    const lowest = Math.min(this.highest, LOWEST)
    if (this.slow > SLOW_FOR && this.ratio > lowest) this.set(Math.max(lowest, this.ratio - STEP))
    else if (this.fast > FAST_FOR && this.ratio < this.highest) this.set(Math.min(this.highest, this.ratio + STEP))
  }

  private set(ratio: number) {
    this.ratio = ratio
    this.renderer.setPixelRatio(ratio)
    // judge the new ratio on its own frames
    this.slow = this.fast = 0
    this.avg = (SLOW_MS + FAST_MS) / 2
  }
}
