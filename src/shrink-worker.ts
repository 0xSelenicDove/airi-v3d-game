/**
 * Scales textures down off the main thread (prepare.ts). Redrawing a 4096 px texture at 1024 px takes tens of
 * milliseconds, and the browser does it on the thread that asks: for a VRoid model's 28 large textures that was most
 * of a second of frozen page. If scaling fails, the original comes back unchanged.
 */
interface Job { id: number; image: ImageBitmap; width: number; height: number }

const post = (msg: unknown, transfer: Transferable[]) => (self as unknown as Worker).postMessage(msg, transfer)

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, image, width, height } = e.data
  let small: ImageBitmap
  try {
    small = await createImageBitmap(image, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
  } catch {
    post({ id, image }, [image])
    return
  }
  image.close()
  post({ id, image: small }, [small])
}
