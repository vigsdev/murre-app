import { useEffect, useRef, useState } from "react"
import { api, type ProjectSummary } from "@/lib/tauri"
import { enqueue } from "./detail/render-thumb"

/** One read per project per session; `null` means there was no readable project file. */
const summaries = new Map<string, ProjectSummary | null>()

/**
 * "1920×1080 · 30 fps · 155 comps", read from the project's main .aep when the card comes into view (two at a time,
 * with the thumbnails). Nothing shows until it's known.
 */
export function ProjectFormat({ projectId, available }: { projectId: string; available: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [summary, setSummary] = useState<ProjectSummary | null>(summaries.get(projectId) ?? null)

  useEffect(() => {
    if (summaries.has(projectId)) return setSummary(summaries.get(projectId) ?? null)
    const el = ref.current
    if (!el || !available) return
    const controller = new AbortController()
    const observer = new IntersectionObserver(
      ([hit]) => {
        if (!hit?.isIntersecting) return
        observer.disconnect()
        enqueue(() => api.projectSummary(projectId), controller.signal)
          .then((s) => {
            summaries.set(projectId, s)
            if (!controller.signal.aborted) setSummary(s)
          })
          .catch(() => {})
      },
      { rootMargin: "200px" },
    )
    observer.observe(el)
    return () => {
      controller.abort()
      observer.disconnect()
    }
  }, [projectId, available])

  return (
    <p ref={ref} className="min-h-4 truncate text-xs text-muted-foreground tabular-nums">
      {summary && `${summary.width}×${summary.height} · ${summary.frameRate} fps · ${summary.comps} ${summary.comps === 1 ? "comp" : "comps"}`}
    </p>
  )
}
