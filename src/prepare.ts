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

/** scale every texture under `root` larger than `max` down to fit, keeping its aspect (in the browser's decoder) */
export async function shrinkTextures(root: THREE.Object3D, max = MAX_TEXTURE) {
  if (typeof createImageBitmap !== 'function') return
  await Promise.all(texturesOf(root).map(async t => {
    const img = t.image as (ImageBitmap | HTMLImageElement | HTMLCanvasElement) & { width: number; height: number } | null
    if (!img || !img.width || !img.height || Math.max(img.width, img.height) <= max) return
    const k = max / Math.max(img.width, img.height)
    try {
      const small = await createImageBitmap(img, {
        resizeWidth: Math.max(1, Math.round(img.width * k)),
        resizeHeight: Math.max(1, Math.round(img.height * k)),
        resizeQuality: 'high',
      })
      if ('close' in img && typeof img.close === 'function') img.close()
      t.image = small
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
