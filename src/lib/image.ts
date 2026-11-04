const AVATAR_SIZE = 256

/**
 * Center-crop an image file to a square and re-encode it as a 256px PNG.
 * Returns the PNG as base64 (no `data:` prefix) plus an object URL preview.
 */
export async function prepareAvatar(file: File): Promise<{ base64: string; previewUrl: string }> {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.")

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error("That image could not be read. Try a PNG or JPEG.")
  }

  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const canvas = document.createElement("canvas")
    canvas.width = AVATAR_SIZE
    canvas.height = AVATAR_SIZE
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("Could not process the image.")
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    )
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
    if (!blob) throw new Error("Could not process the image.")
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ""
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return { base64: btoa(binary), previewUrl: URL.createObjectURL(blob) }
  } finally {
    bitmap.close()
  }
}
