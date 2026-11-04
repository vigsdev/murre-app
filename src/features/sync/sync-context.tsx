import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { api, type ReconcileReport } from "@/lib/tauri"

/** Fired on `window` when the project list may have changed on disk. Pages reload on it. */
export const PROJECTS_CHANGED = "murre:projects-changed"

const INTERVAL_MS = 60_000
const MIN_GAP_MS = 5_000

interface SyncValue {
  report: ReconcileReport | null
  /** Re-check now (e.g. right after relinking a project). */
  rescan: () => Promise<void>
}

const SyncContext = createContext<SyncValue>({ report: null, rescan: async () => {} })

export function useSync() {
  return useContext(SyncContext)
}

/** Calls `onChange` whenever a reconciliation scan finds the project list changed. */
export function useProjectsChanged(onChange: () => void) {
  const ref = useRef(onChange)
  ref.current = onChange
  useEffect(() => {
    const handler = () => ref.current()
    window.addEventListener(PROJECTS_CHANGED, handler)
    return () => window.removeEventListener(PROJECTS_CHANGED, handler)
  }, [])
}

/**
 * Keeps the app in step with the disk: scans at start-up, whenever the window regains focus,
 * and once a minute. A scan only updates the index; it never writes to project folders.
 */
export function SyncProvider({ children }: { children: ReactNode }) {
  const [report, setReport] = useState<ReconcileReport | null>(null)
  const baseline = useRef<string | null>(null)
  const lastRun = useRef(0)
  const running = useRef(false)

  const run = useCallback(async (force: boolean) => {
    if (running.current || (!force && Date.now() - lastRun.current < MIN_GAP_MS)) return
    running.current = true
    lastRun.current = Date.now()
    try {
      const r = await api.reconcileProjects()
      // `synced` lists one-off updates; the rest describes the current state.
      const sig = JSON.stringify({ ...r, synced: [] })
      const changed = r.synced.length > 0 || (baseline.current !== null && sig !== baseline.current)
      baseline.current = sig
      setReport(r)
      if (changed) window.dispatchEvent(new Event(PROJECTS_CHANGED))
    } catch {
      // Keep the last known state; the next scan will try again.
    } finally {
      running.current = false
    }
  }, [])

  useEffect(() => {
    void run(true)
    const onFocus = () => void run(false)
    window.addEventListener("focus", onFocus)
    const timer = window.setInterval(() => void run(false), INTERVAL_MS)
    return () => {
      window.removeEventListener("focus", onFocus)
      window.clearInterval(timer)
    }
  }, [run])

  const value = useMemo<SyncValue>(() => ({ report, rescan: () => run(true) }), [report, run])
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}
