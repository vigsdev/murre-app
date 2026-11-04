import { FileAudio, ImageOff } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { api, type RenderEntry } from "@/lib/tauri"

/**
 * Thumbnails are made by ffmpeg, which can be slow on large files, so requests
 * run at most two at a time and results are remembered for the session.
 * The key includes size and date, so a changed file gets a fresh thumbnail.
 */
const MAX_PARALLEL = 2
const cache = new Map<string, string | null>()
const waiting: Array<() => void> = []
let running = 0

function pump() {
  while (running < MAX_PARALLEL && waiting.length > 0) {
    running++
    waiting.shift()!()
  }
}

export function enqueue<T>(job: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      if (signal.aborted) {
        running--
        pump()
        reject(new DOMException("aborted", "AbortError"))
        return
      }
      job()
        .then(resolve, reject)
        .finally(() => {
          running--
          pump()
        })
    }
    waiting.push(start)
    pump()
  })
}

const keyOf = (projectId: string, e: RenderEntry) => `${projectId}|${e.path}|${e.sizeBytes}|${e.modifiedAt}`

type ThumbState = { status: "idle" } | { status: "loading" } | { status: "ready"; url: string | null } | { status: "failed" }

export function RenderThumb({ projectId, entry, ffmpegAvailable }: { projectId: string; entry: RenderEntry; ffmpegAvailable: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const key = keyOf(projectId, entry)
  const [state, setState] = useState<ThumbState>(() =>
    cache.has(key) ? { status: "ready", url: cache.get(key) ?? null } : { status: "idle" },
  )

  useEffect(() => {
    if (cache.has(key)) {
      setState({ status: "ready", url: cache.get(key) ?? null })
      return
    }
    if (entry.kind === "audio" || !ffmpegAvailable) {
      setState({ status: "idle" })
      return
    }
    const el = ref.current
    if (!el) return
    const controller = new AbortController()
    const observer = new IntersectionObserver(
      ([hit]) => {
        if (!hit?.isIntersecting) return
        observer.disconnect()
        setState({ status: "loading" })
        enqueue(() => api.renderThumbnail(projectId, entry.path), controller.signal)
          .then((url) => {
            cache.set(key, url)
            if (!controller.signal.aborted) setState({ status: "ready", url })
          })
          .catch(() => {
            if (!controller.signal.aborted) setState({ status: "failed" })
          })
      },
      { rootMargin: "200px" },
    )
    observer.observe(el)
    return () => {
      controller.abort()
      observer.disconnect()
    }
  }, [key, projectId, entry.path, entry.kind, ffmpegAvailable])

  return (
    <div ref={ref} className="flex aspect-video w-full items-center justify-center overflow-hidden bg-muted text-muted-foreground">
      {state.status === "ready" && state.url ? (
        <img src={state.url} alt="" className="size-full object-cover" draggable={false} />
      ) : state.status === "loading" ? (
        <Skeleton className="size-full rounded-none" />
      ) : entry.kind === "audio" ? (
        <FileAudio className="size-8" />
      ) : (
        <ImageOff className="size-8 opacity-60" />
      )}
    </div>
  )
}
