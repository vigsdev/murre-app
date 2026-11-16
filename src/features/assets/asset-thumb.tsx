import { useEffect, useRef, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { api, type AssetEntry } from "@/lib/tauri"
import { enqueue } from "@/features/projects/detail/render-thumb"
import { iconFor } from "@/features/projects/detail/file-icons"
import { hasThumb } from "./asset-kinds"

/** Remembered for the session; the key changes with the file's size and date, so an edited file gets a new one. */
const cache = new Map<string, string | null>()

type Thumb = { status: "idle" | "loading" | "failed" } | { status: "ready"; url: string | null }

/**
 * The picture at the top of a file card: a thumbnail for images and video (made when the card scrolls into view,
 * two at a time), otherwise the file's icon and extension.
 */
export function AssetThumb({ projectId, entry }: { projectId: string; entry: AssetEntry }) {
  const ref = useRef<HTMLDivElement>(null)
  const key = `${projectId}|${entry.path}|${entry.sizeBytes}|${entry.modifiedAt}`
  const can = hasThumb(entry)
  const [thumb, setThumb] = useState<Thumb>(() => (cache.has(key) ? { status: "ready", url: cache.get(key) ?? null } : { status: "idle" }))

  useEffect(() => {
    if (!can) return
    if (cache.has(key)) return setThumb({ status: "ready", url: cache.get(key) ?? null })
    const el = ref.current
    if (!el) return
    const controller = new AbortController()
    const observer = new IntersectionObserver(
      ([hit]) => {
        if (!hit?.isIntersecting) return
        observer.disconnect()
        setThumb({ status: "loading" })
        enqueue(() => api.assetThumbnail(projectId, entry.path), controller.signal)
          .then((url) => {
            cache.set(key, url)
            if (!controller.signal.aborted) setThumb({ status: "ready", url })
          })
          .catch(() => {
            // No FFmpeg, or a file it can't read: the icon is fine.
            cache.set(key, null)
            if (!controller.signal.aborted) setThumb({ status: "failed" })
          })
      },
      { rootMargin: "200px" },
    )
    observer.observe(el)
    return () => {
      controller.abort()
      observer.disconnect()
    }
  }, [key, can, projectId, entry.path])

  const Icon = iconFor(entry)
  return (
    <div ref={ref} className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
      {thumb.status === "ready" && thumb.url ? (
        <img src={thumb.url} alt="" className="size-full object-cover" draggable={false} />
      ) : thumb.status === "loading" ? (
        <Skeleton className="size-full rounded-none" />
      ) : (
        <span className="flex flex-col items-center gap-1.5">
          <Icon className="size-7 opacity-80" />
          {entry.extension && <span className="font-mono text-xs uppercase">{entry.extension}</span>}
        </span>
      )}
    </div>
  )
}
