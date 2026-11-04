import { listen } from "@tauri-apps/api/event"
import { useEffect, useRef } from "react"
import { toast } from "sonner"
import { api, errorMessage, type ProjectChange } from "@/lib/tauri"

const COALESCE_MS = 800

function merge(a: ProjectChange | null, b: ProjectChange): ProjectChange {
  if (!a) return { ...b, metadata: [...b.metadata] }
  return {
    projectId: b.projectId,
    metadata: [...new Set([...a.metadata, ...b.metadata])],
    files: a.files || b.files,
    rootChanged: a.rootChanged || b.rootChanged,
  }
}

/**
 * Watches one project's folder while `projectId` is set, and calls `onChange` (at most about
 * once a second) with what changed. Pass `null` to stop watching.
 */
export function useProjectWatch(projectId: string | null, onChange: (change: ProjectChange) => void) {
  const handler = useRef(onChange)
  handler.current = onChange

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    let pending: ProjectChange | null = null
    let timer: number | undefined

    void (async () => {
      try {
        const off = await listen<ProjectChange>("project-files-changed", (event) => {
          if (event.payload.projectId !== projectId) return
          pending = merge(pending, event.payload)
          if (timer === undefined) {
            timer = window.setTimeout(() => {
              timer = undefined
              const change = pending
              pending = null
              if (change && !cancelled) handler.current(change)
            }, COALESCE_MS)
          }
        })
        if (cancelled) return off()
        unlisten = off
        await api.watchProject(projectId)
      } catch (e) {
        if (!cancelled) {
          toast.warning("Live updates are off for this project", {
            description: `${errorMessage(e)} Reopen the project to refresh it.`,
          })
        }
      }
    })()

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      unlisten?.()
      void api.unwatchProject(projectId).catch(() => {})
    }
  }, [projectId])
}
