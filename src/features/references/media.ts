import { convertFileSrc } from "@tauri-apps/api/core"
import { api, type ImportedMedia } from "@/lib/tauri"

export const MAX_MEDIA_BYTES = 40 * 1024 * 1024

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("That file could not be read."))
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(",") + 1))
    }
    reader.readAsDataURL(file)
  })
}

/**
 * Copies a file into the project's reference media folder (`.murre/references/media/`). The board refers to it by
 * file name, so the board file stays small and nothing is embedded or sent anywhere. Files are never deleted when
 * items are.
 */
export async function importMedia(projectId: string | null, file: File): Promise<ImportedMedia> {
  if (file.size > MAX_MEDIA_BYTES) throw new Error("That file is too big for the reference board (40 MB max). Even moodboards have limits.")
  return api.importReferenceMedia(projectId, await toBase64(file))
}

/**
 * True when pasted text is the code of an SVG (what "Copy as SVG" in a design tool puts on the clipboard): after an
 * optional XML line, comments and doctype it starts with an `<svg` element, and that is closed. The app checks the
 * file again when it is added.
 */
export function looksLikeSvg(text: string): boolean {
  let t = text.replace(/^\uFEFF/, "").trimStart()
  for (;;) {
    const m = /^(<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^>]*>)\s*/i.exec(t)
    if (!m) break
    t = t.slice(m[0].length)
  }
  return /^<svg[\s>/]/.test(t) && (/<\/svg>/.test(t) || /\/>\s*$/.test(t))
}

const urls = new Map<string, Promise<string>>()

/** Browser-loadable URL for a media file. Cached per project and file. */
export function mediaUrl(projectId: string | null, file: string): Promise<string> {
  const key = `${projectId ?? "global"}/${file}`
  let url = urls.get(key)
  if (!url) {
    url = api.referenceMediaPath(projectId, file).then((abs) => convertFileSrc(abs))
    url.catch(() => urls.delete(key))
    urls.set(key, url)
  }
  return url
}

/** Natural size of an image or video file, used to give new items the right proportions. */
export function measureMedia(file: File, kind: "image" | "video"): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const done = (v: { w: number; h: number } | null) => {
      URL.revokeObjectURL(url)
      resolve(v)
    }
    if (kind === "image") {
      const img = new Image()
      img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = () => done(null)
      img.src = url
    } else {
      const v = document.createElement("video")
      v.preload = "metadata"
      v.onloadedmetadata = () => done({ w: v.videoWidth, h: v.videoHeight })
      v.onerror = () => done(null)
      v.src = url
    }
  })
}
