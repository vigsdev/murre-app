import {
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Layers,
  Link2,
  type LucideIcon,
} from "lucide-react"
import type { AssetEntry } from "@/lib/tauri"

const IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "bmp", "svg", "heic", "exr", "dpx"]
const VIDEO = ["mov", "mp4", "m4v", "avi", "mkv", "mxf", "webm", "prores"]
const AUDIO = ["wav", "mp3", "aif", "aiff", "m4a", "flac", "ogg"]
const DESIGN = ["psd", "psb", "ai", "aep", "aepx", "prproj", "indd", "fig", "c4d"]
const TEXT = ["txt", "md", "pdf", "doc", "docx", "rtf", "json", "csv", "xml", "srt"]
const ARCHIVE = ["zip", "rar", "7z", "tar", "gz"]

export function iconFor(entry: Pick<AssetEntry, "kind" | "extension">): LucideIcon {
  if (entry.kind === "directory") return Folder
  if (entry.kind === "symlink") return Link2
  const ext = entry.extension ?? ""
  if (IMAGE.includes(ext)) return FileImage
  if (VIDEO.includes(ext)) return FileVideo
  if (AUDIO.includes(ext)) return FileAudio
  if (DESIGN.includes(ext)) return Layers
  if (TEXT.includes(ext)) return FileText
  if (ARCHIVE.includes(ext)) return FileArchive
  return File
}
