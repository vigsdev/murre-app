import { useEffect, useRef, useState } from "react"
import { enqueue } from "./detail/render-thumb"
import { api } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { projectGradient } from "./project-utils"

/** One lookup per project per session; `null` means "no thumbnail, show the gradient". */
const covers = new Map<string, string | null>()
let toolsPromise: Promise<boolean> | null = null
const ffmpegAvailable = () => (toolsPromise ??= api.getMediaTools().then((t) => !!t.ffmpeg).catch(() => false))

/**
 * The picture at the top of a project card or page: a frame from the newest
 * render when there is one, otherwise a gradient made from the project name.
 */
export function ProjectCover({
  projectId,
  name,
  available = true,
  className,
  children,
}: {
  projectId: string
  name: string
  available?: boolean
  className?: string
  children?: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState<string | null>(covers.get(projectId) ?? null)

  useEffect(() => {
    if (covers.has(projectId)) {
      setUrl(covers.get(projectId) ?? null)
      return
    }
    const el = ref.current
    if (!el || !available) return
    const controller = new AbortController()
    const observer = new IntersectionObserver(
      ([hit]) => {
        if (!hit?.isIntersecting) return
        observer.disconnect()
        void (async () => {
          try {
            if (!(await ffmpegAvailable())) return
            const { entries } = await api.listRenders(projectId)
            const newest = entries.filter((e) => e.kind !== "audio").sort((a, b) => b.modifiedAt - a.modifiedAt)[0]
            if (!newest) {
              covers.set(projectId, null)
              return
            }
            const thumb = await enqueue(() => api.renderThumbnail(projectId, newest.path), controller.signal)
            covers.set(projectId, thumb)
            if (!controller.signal.aborted) setUrl(thumb)
          } catch {
            // keep the gradient; try again next session
          }
        })()
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
    <div ref={ref} className={cn("relative overflow-hidden", className)} style={{ backgroundImage: projectGradient(name) }}>
      {url && <img src={url} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />}
      {children}
    </div>
  )
}
