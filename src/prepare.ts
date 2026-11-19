/**
 * Getting a model ready to draw without a freeze. Before a loaded model goes into the scene:
 * - textures larger than the game needs are scaled down (VRoid exports often carry 4096 px textures, 1.5 GB of GPU
 *   memory per character; at this camera distance 1024 px looks the same),
 * - its shaders are compiled in the background (KHR_parallel_shader_compile, where the browser has it),
 * - its textures are uploaded to the GPU one at a time, yielding in between.
 * Done all at once on the first frame it is drawn, this took most of a second and the game stood still.
 */
import * as THREE from 'three'

/** the largest texture side kept, in pixels */
export const MAX_TEXTURE = 1024

/** every texture the meshes under `root` use, once each (MToon keeps its textures in uniforms) */
export function texturesOf(root: THREE.Object3D): THREE.Texture[] {
  const found = new Set<THREE.Texture>()
  root.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const uniforms = (m as THREE.ShaderMaterial).uniforms ?? {}
      for (const v of [...Object.values(m), ...Object.values(uniforms).map(u => u?.value)]) {
        if ((v as THREE.Texture | null)?.isTexture) found.add(v as THREE.Texture)
      }
    }
  })
  return [...found]
}

/** the worker that scales textures (shrink-worker.ts), started on first use */
let worker: Worker | null = null
let nextJob = 1
const jobs = new Map<number, (image: ImageBitmap) => void>()

/** scale a decoded texture image in the worker; the original is handed over, and comes back if scaling fails */
function shrinkInWorker(image: ImageBitmap, width: number, height: number): Promise<ImageBitmap> {
  if (!worker) {
    worker = new Worker(new URL('./shrink-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; image: ImageBitmap }>) => {
      jobs.get(e.data.id)?.(e.data.image)
      jobs.delete(e.data.id)
    }
  }
  const id = nextJob++
  return new Promise(resolve => {
    jobs.set(id, resolve)
    worker!.postMessage({ id, image, width, height }, [image])
  })
}

/** scale every texture under `root` larger than `max` down to fit, keeping its aspect, off the main thread */
export async function shrinkTextures(root: THREE.Object3D, max = MAX_TEXTURE) {
  if (typeof createImageBitmap !== 'function') return
  await Promise.all(texturesOf(root).map(async t => {
    const img = t.image as (ImageBitmap | HTMLImageElement | HTMLCanvasElement) & { width: number; height: number } | null
    if (!img || !img.width || !img.height || Math.max(img.width, img.height) <= max) return
    const k = max / Math.max(img.width, img.height)
    const width = Math.max(1, Math.round(img.width * k)), height = Math.max(1, Math.round(img.height * k))
    try {
      if (typeof Worker === 'function' && typeof ImageBitmap === 'function' && img instanceof ImageBitmap) {
        t.image = await shrinkInWorker(img, width, height)
      } else {
        // not a decoded bitmap (an <img> or a canvas): scale it here
        t.image = await createImageBitmap(img, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
      }
      t.needsUpdate = true
    } catch {
      // a texture the browser cannot redraw keeps its size: it still works, only heavier
    }
  }))
}

/** hand control back to the browser for a moment, without the long timer delay of a background tab */
const yieldNow = () => new Promise<void>(resolve => {
  const ch = new MessageChannel()
  ch.port1.onmessage = () => resolve()
  ch.port2.postMessage(0)
})

/** get `root` ready to draw in `scene`: smaller textures, compiled shaders, textures on the GPU */
export async function prepareForScene(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene, root: THREE.Object3D) {
  await shrinkTextures(root)
  try { await renderer.compileAsync(root, camera, scene) } catch { /* compiled on first draw instead */ }
  for (const t of texturesOf(root)) {
    renderer.initTexture(t)
    await yieldNow()
  }
}
