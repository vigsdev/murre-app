import { listen } from "@tauri-apps/api/event"
import { useEffect, useState } from "react"
import { api, type CompanionStatus } from "@/lib/tauri"

const OFFLINE: CompanionStatus = {
  connected: false,
  aepPath: null,
  projectId: null,
  scanning: false,
  progress: null,
  last: null,
}

/** Live status of the After Effects Companion (pushed by the app; no polling). */
export function useCompanionStatus() {
  const [status, setStatus] = useState<CompanionStatus>(OFFLINE)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null
    void (async () => {
      try {
        const off = await listen<CompanionStatus>("companion-status", (e) => e.payload && setStatus(e.payload))
        if (cancelled) return off()
        unlisten = off
        const first = await api.getCompanionStatus()
        // An update that arrived while we were asking is newer than this answer.
        if (!cancelled && first) setStatus((cur) => (cur === OFFLINE ? first : cur))
      } catch {
        // Without the live link the app still works; the control just stays "offline".
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  return { status, ready }
}
