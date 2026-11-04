import { listen } from "@tauri-apps/api/event"
import { useCallback, useEffect, useState } from "react"
import { api, type RenderJob } from "@/lib/tauri"

/** The running render, or the most recent one that ended. Updates are pushed by the app. */
export function useRenderJob() {
  const [job, setJob] = useState<RenderJob | null>(null)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null
    let sawEvent = false
    void (async () => {
      try {
        const off = await listen<RenderJob>("render-update", (e) => {
          sawEvent = true
          setJob(e.payload)
        })
        if (cancelled) return off()
        unlisten = off
        const current = await api.getRenderJob()
        // An update that arrived while we were asking is newer than this answer.
        if (!cancelled && !sawEvent) setJob(current)
      } catch {
        // Without events the panel still works; it just will not update by itself.
      }
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  /** Clear the card of a render that has ended. */
  const clear = useCallback(async () => {
    await api.clearRenderJob()
    setJob(null)
  }, [])

  return { job, clear }
}
