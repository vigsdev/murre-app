import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { CircleCheck, CircleX, Clapperboard, FolderSearch, Loader2, ScrollText, Square, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { api, errorMessage, type CompEntry, type CompsView, type ProjectRecord, type RenderJob } from "@/lib/tauri"
import { RenderDialog } from "./render-dialog"
import { useRenderJob } from "./use-render-job"

const trim = (n: number) => String(Math.round(n * 1000) / 1000)

/** "Render Main Comps": the Main Comps from the last scan, and the render that is running. */
export function RenderPanel({
  project,
  reloadToken = 0,
  onRenderEnded,
}: {
  project: ProjectRecord
  reloadToken?: number
  onRenderEnded: () => void
}) {
  const [comps, setComps] = useState<CompsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<CompEntry | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showLog, setShowLog] = useState(false)
  const { job, clear } = useRenderJob()
  const thisProject = job && job.projectId === project.id ? job : null
  const running = job?.state === "running"

  const load = useCallback(async () => {
    try {
      setComps(await api.getComps(project.id))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load, reloadToken])

  // Tell the person how a render they were watching ended, and refresh the file list.
  const lastState = useRef<string | null>(null)
  useEffect(() => {
    const prev = lastState.current
    lastState.current = job ? `${job.id}:${job.state}` : null
    if (!job || job.projectId !== project.id || job.state === "running") return
    if (prev === `${job.id}:running`) {
      if (job.state === "finished") toast.success(`Rendered “${job.compName}”`)
      else if (job.state === "cancelled") toast("Render cancelled. Back to the drawing board.")
      else toast.error(job.message ?? "The render failed.")
      onRenderEnded()
    }
  }, [job, project.id, onRenderEnded])

  const mains = comps?.comps.filter((c) => c.main) ?? []
  // The comp chosen in the list; if it is no longer a Main Comp (after a scan, say) the first one is used.
  const selected = mains.find((c) => c.id === selectedId) ?? mains[0] ?? null

  return (
    <Card className="gap-3 p-4">
      <div className="flex items-center gap-2">
        <Clapperboard className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-medium">Render Main Comps</h3>
      </div>

      {thisProject && <JobView job={thisProject} onLog={() => setShowLog(true)} onClear={() => void clear().catch((e) => toast.error(errorMessage(e)))} />}
      {job && job.projectId !== project.id && running && (
        <p className="text-sm text-muted-foreground">A render of “{job.compName}” is running in another project.</p>
      )}

      {!comps && !error && <Skeleton className="h-10" />}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {comps && !comps.lastScanAt && (
        <p className="text-sm text-muted-foreground">
          This project has not been scanned yet. Open it in After Effects and press “Scan in After Effects” (or Scan project in the Companion panel).
        </p>
      )}
      {comps && comps.lastScanAt && mains.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No Main Comps selected. Choose them in the Companion panel; only Main Comps can be rendered here.
        </p>
      )}
      {selected && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Select
              items={mains.map((c) => ({ value: String(c.id), label: c.name }))}
              value={String(selected.id)}
              onValueChange={(v) => v && setSelectedId(Number(v))}
            >
              <SelectTrigger className="min-w-0 flex-1" aria-label="Composition to render" data-testid="render-comp-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {mains.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" disabled={running} onClick={() => setPicked(selected)}>
              Render…
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {selected.width}×{selected.height} · {trim(selected.frameRate)} fps · {trim(selected.duration)} s{selected.folder ? ` · ${selected.folder}` : ""}
            {mains.length > 1 ? ` · ${mains.length} Main Comps` : ""}
          </p>
        </div>
      )}

      <RenderDialog project={project} comp={picked} onClose={() => setPicked(null)} onStarted={() => setShowLog(false)} />
      <LogDialog open={showLog} job={thisProject} onClose={() => setShowLog(false)} />
    </Card>
  )
}

function JobView({ job, onLog, onClear }: { job: RenderJob; onLog: () => void; onClear: () => void }) {
  const [cancelling, setCancelling] = useState(false)
  useEffect(() => {
    if (job.state !== "running") setCancelling(false)
  }, [job.state])

  async function cancel() {
    setCancelling(true)
    try {
      await api.cancelRender()
    } catch (e) {
      setCancelling(false)
      toast.error(errorMessage(e))
    }
  }

  const pct = job.percent === null ? null : Math.round(job.percent * 100)
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3" data-testid="render-job" data-state={job.state}>
      <div className="flex items-center gap-2">
        {job.state === "running" && <Loader2 className="size-4 animate-spin" aria-hidden />}
        {job.state === "finished" && <CircleCheck className="size-4 text-emerald-600" aria-hidden />}
        {(job.state === "failed" || job.state === "cancelled") && <CircleX className="size-4 text-destructive" aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {job.state === "running" && (cancelling ? "Cancelling" : "Rendering")}
          {job.state === "finished" && "Finished"}
          {job.state === "failed" && "Failed"}
          {job.state === "cancelled" && "Cancelled"}
          {" · "}
          {job.compName}
        </span>
        {job.state === "running" && (
          <Button size="xs" variant="outline" disabled={cancelling} onClick={() => void cancel()}>
            <Square /> Cancel render
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={onLog}>
          <ScrollText /> Log
        </Button>
        {job.state !== "running" && (
          <Button size="xs" variant="ghost" onClick={onClear} aria-label="Clear this render from the list">
            <X /> Clear
          </Button>
        )}
        {job.state === "finished" && job.outputExists && (
          <Button size="xs" variant="ghost" onClick={() => void revealItemInDir(job.output).catch((e) => toast.error(errorMessage(e)))}>
            <FolderSearch /> Show file
          </Button>
        )}
      </div>

      {job.state === "running" && (
        <>
          <div
            role="progressbar"
            aria-label="Render progress (estimate)"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={pct === null ? "h-full w-1/3 animate-pulse rounded-full bg-primary" : "h-full rounded-full bg-primary transition-[width]"}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between gap-3 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{job.lastLine ?? "Starting After Effects…"}</span>
            {pct !== null && (
              <span className="shrink-0">
                about {pct}% · frame {job.frame} of {job.totalFrames}
              </span>
            )}
          </div>
        </>
      )}

      {job.message && job.state !== "running" && (
        <Alert variant={job.state === "failed" ? "destructive" : "default"}>
          <AlertTitle>{job.state === "failed" ? "The render did not finish" : job.state === "cancelled" ? "Render cancelled" : "Saved under a different name"}</AlertTitle>
          <AlertDescription>{job.message}</AlertDescription>
        </Alert>
      )}
      {job.warnings.map((w) => (
        <p key={w} className="text-xs text-muted-foreground">
          {w}
        </p>
      ))}
    </div>
  )
}

function LogDialog({ open, job, onClose }: { open: boolean; job: RenderJob | null; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null)
  const state = job?.state
  const last = job?.lastLine

  useEffect(() => {
    if (!open) return
    let cancelled = false
    api
      .getRenderLog(500)
      .then((l) => !cancelled && setLines(l))
      .catch(() => !cancelled && setLines([]))
    return () => {
      cancelled = true
    }
  }, [open, state, last])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Render log{job ? ` · ${job.compName}` : ""}</DialogTitle>
          <DialogDescription>
            The last lines aerender printed. The full log is saved at {job?.logPath ?? "the app data folder"}.
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap" data-testid="render-log">
          {lines === null ? "Loading…" : lines.length === 0 ? "No output yet." : lines.join("\n")}
        </pre>
        {job && (
          <Button size="sm" variant="outline" className="self-start" onClick={() => void revealItemInDir(job.logPath).catch((e) => toast.error(errorMessage(e)))}>
            <FolderSearch /> Show log file
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
