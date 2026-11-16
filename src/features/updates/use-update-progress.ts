import { listen } from "@tauri-apps/api/event"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { formatBytes } from "@/lib/format"
import { api, type UpdateProgress } from "@/lib/tauri"

const IDLE: UpdateProgress = { stage: "idle" }

/** What the updater is doing, kept current from its `update-progress` events. */
export function useUpdateProgress(): UpdateProgress {
  const [progress, setProgress] = useState<UpdateProgress>(IDLE)
  useEffect(() => {
    let cancelled = false
    let off: (() => void) | undefined
    api
      .updateProgress()
      .then((p) => !cancelled && setProgress(p))
      .catch(() => {})
    try {
      void listen<UpdateProgress>("update-progress", (e) => e.payload && setProgress(e.payload))
        .then((f) => (cancelled ? f() : (off = f)))
        .catch(() => {})
    } catch {
      // Not running inside the app.
    }
    return () => {
      cancelled = true
      off?.()
    }
  }, [])
  return progress
}

/** The line for a stage, or null when there is nothing to show. */
export function updateLine(p: UpdateProgress): string | null {
  switch (p.stage) {
    case "idle":
      return null
    case "checking":
      return "Checking for updates…"
    case "downloading": {
      if (p.total && p.total > 0) {
        const pct = Math.min(100, Math.floor((p.done / p.total) * 100))
        return `Downloading Murre ${p.version}… ${pct}%`
      }
      return p.done > 0 ? `Downloading Murre ${p.version}… ${formatBytes(p.done)}` : `Downloading Murre ${p.version}…`
    }
    case "installing":
      return `Installing Murre ${p.version}…`
  }
}

const TOAST_ID = "murre-update"

/** Shows checking and download progress as one small message that updates in place. Mounted once, in the app shell. */
export function useUpdateToasts() {
  const progress = useUpdateProgress()
  useEffect(() => {
    const line = updateLine(progress)
    if (line) toast.loading(line, { id: TOAST_ID, duration: Infinity })
    else toast.dismiss(TOAST_ID)
  }, [progress])
}
