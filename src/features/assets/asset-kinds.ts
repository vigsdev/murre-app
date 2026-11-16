import type { AssetEntry, FootageView, StorageKind } from "@/lib/tauri"
import { isWindows } from "@/lib/platform"

/** The same groups the app counts storage by (`assets::storage_kind`). */
const KIND_OF: Record<string, StorageKind> = {}
const group = (kind: StorageKind, exts: string[]) => exts.forEach((e) => (KIND_OF[e] = kind))
group("video", ["mov", "mp4", "m4v", "mxf", "avi", "webm", "mkv", "r3d", "braw", "mts"])
group("image", ["png", "jpg", "jpeg", "tif", "tiff", "webp", "gif", "exr", "dpx", "bmp", "heic", "tga"])
group("audio", ["wav", "mp3", "aif", "aiff", "m4a", "aac", "flac", "ogg"])
group("design", ["psd", "psb", "ai", "eps", "svg", "indd"])
group("project", ["aep", "aepx", "aet", "prproj", "mogrt", "c4d", "blend"])

export const kindOf = (e: Pick<AssetEntry, "extension">): StorageKind => KIND_OF[e.extension ?? ""] ?? "other"

export const KIND_LABEL: Record<StorageKind, string> = {
  video: "Video",
  image: "Images",
  audio: "Audio",
  design: "PSD & AI",
  project: "AE & Premiere",
  other: "Other",
}

/** One colour per kind, so the storage bar and its legend can be told apart. */
export const KIND_COLOR: Record<StorageKind, string> = {
  video: "#5b8def",
  image: "#3fae86",
  audio: "#e0a43a",
  design: "#e0708f",
  project: "#9a86ec",
  other: "var(--color-muted-foreground)",
}

/** Files a thumbnail can be made for (`renders::kind_of` without audio). */
const THUMB = new Set(["png", "jpg", "jpeg", "tif", "tiff", "webp", "gif", "exr", "dpx", "bmp", "mov", "mp4", "m4v", "mxf", "avi", "webm", "mkv"])
export const hasThumb = (e: Pick<AssetEntry, "extension" | "kind">) => e.kind === "file" && THUMB.has(e.extension ?? "")

/** Kinds After Effects imports as footage: only these can be "not used". */
export const FOOTAGE_KINDS: StorageKind[] = ["video", "image", "audio", "design"]

const norm = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "")
  return isWindows ? s.toLowerCase() : s
}

/**
 * What the last Companion scan says the `.aep` uses: each file's path, with the footage names it goes by in After
 * Effects. `null` until the project has been scanned.
 */
export function usageOf(view: FootageView | null): Map<string, string[]> | null {
  if (!view || (view.lastScanAt === null && view.assets.length === 0)) return null
  const used = new Map<string, string[]>()
  for (const a of view.assets) if (a.status === "inside" || a.status === "sequence") used.set(norm(a.path), a.names)
  return used
}

export const usedNames = (usage: Map<string, string[]> | null, e: Pick<AssetEntry, "absolutePath">) =>
  usage?.get(norm(e.absolutePath)) ?? null
