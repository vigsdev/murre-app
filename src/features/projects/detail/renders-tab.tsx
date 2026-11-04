import { CircleCheck, Info, RefreshCw, TriangleAlert } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatBytes, formatDateTime } from "@/lib/format"
import { api, errorMessage, type MediaTools, type ProjectRecord, type RenderEntry, type RendersListing } from "@/lib/tauri"
import { RenderPanel } from "@/features/render/render-panel"
import { cn } from "@/lib/utils"
import { RenderDetailSheet } from "./render-detail-sheet"
import { RenderThumb } from "./render-thumb"
import { installFfmpegHint } from "@/lib/platform"

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; listing: RendersListing }

const FILTERS = [
  { value: "all", label: "All" },
  { value: "05 Pre-Renders", label: "Pre-Renders" },
  { value: "06 Renders", label: "Renders" },
  { value: "07 Deliverables", label: "Deliverables" },
] as const

export function RendersTab({ project, reloadToken = 0, compsToken = 0 }: { project: ProjectRecord; reloadToken?: number; compsToken?: number }) {
  const [state, setState] = useState<State>({ status: "loading" })
  const [tools, setTools] = useState<MediaTools | null>(null)
  const [filter, setFilter] = useState<string>("all")
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      setState({ status: "ready", listing: await api.listRenders(project.id) })
    } catch (e) {
      setState({ status: "error", message: errorMessage(e) })
    } finally {
      setRefreshing(false)
    }
  }, [project.id])

  useEffect(() => {
    setState({ status: "loading" })
    void load()
    api.getMediaTools().then(setTools).catch(() => setTools({ ffmpeg: null, ffprobe: null }))
  }, [load])

  // Files changed on disk: re-read the render list in place.
  useEffect(() => {
    if (reloadToken > 0) void load()
  }, [reloadToken, load])

  const entries = state.status === "ready" ? state.listing.entries : []
  const visible = useMemo(() => entries.filter((e) => filter === "all" || e.folder === filter), [entries, filter])
  const selected = useMemo(() => entries.find((e) => e.path === selectedPath) ?? null, [entries, selectedPath])

  async function approve(entry: RenderEntry, approved: boolean) {
    setBusy(true)
    try {
      const listing = await api.setRenderApproved(project.id, entry.path, approved)
      setState({ status: "ready", listing })
      toast.success(approved ? "Marked as approved" : "Approval removed")
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const missingTools = tools && (!tools.ffmpeg || !tools.ffprobe)
  const changedCount = entries.filter((e) => e.approval?.state === "changed").length

  return (
    <div className="flex flex-col gap-3">
      <RenderPanel project={project} reloadToken={reloadToken + compsToken} onRenderEnded={() => void load()} />
      <div className="flex items-center gap-2">
        <Tabs value={filter} onValueChange={(v) => setFilter(String(v))} className="min-w-0 flex-1">
          <TabsList>
            {FILTERS.map((f) => (
              <TabsTrigger key={f.value} value={f.value}>
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Button variant="ghost" size="icon-sm" aria-label="Refresh" disabled={refreshing} onClick={() => void load()}>
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </Button>
      </div>

      {missingTools && (
        <Alert>
          <Info />
          <AlertTitle>Murre’s media tools wouldn’t start</AlertTitle>
          <AlertDescription>
            Thumbnails and media details need ffmpeg and ffprobe, which come with Murre. Reinstall Murre, or {installFfmpegHint}, then press
            refresh. Files can still be listed, approved, opened and played without them.
          </AlertDescription>
        </Alert>
      )}

      {changedCount > 0 && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>
            {changedCount} approved {changedCount === 1 ? "file has" : "files have"} changed
          </AlertTitle>
          <AlertDescription>The approval is kept as it was. Open the file to approve the new version or remove the approval.</AlertDescription>
        </Alert>
      )}

      {state.status === "ready" && state.listing.missingApproved.length > 0 && (
        <Alert>
          <Info />
          <AlertTitle>Approved files not found on disk</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 flex flex-col gap-1">
              {state.listing.missingApproved.map((p) => (
                <li key={p} className="flex items-center gap-2">
                  <span className="min-w-0 break-all">{p}</span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void approve({ path: p } as RenderEntry, false)}
                    disabled={busy}
                  >
                    Clear record
                  </Button>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {state.status === "loading" && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      )}

      {state.status === "error" && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}

      {state.status === "ready" && visible.length === 0 && (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {entries.length === 0
            ? "No renders yet. Video, image and audio files in 05 Pre-Renders, 06 Renders and 07 Deliverables appear here."
            : "Nothing in this folder."}
        </Card>
      )}

      {visible.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {visible.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                onClick={() => setSelectedPath(e.path)}
                className="group/render block w-full overflow-hidden rounded-xl border bg-card text-left transition hover:border-ring focus-visible:outline-none"
              >
                <RenderThumb projectId={project.id} entry={e} ffmpegAvailable={!!tools?.ffmpeg} />
                <div className="flex flex-col gap-1 p-3">
                  <span className="truncate text-sm font-medium" title={e.name}>
                    {e.name}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {e.folder.slice(3)} · {formatBytes(e.sizeBytes)} · {formatDateTime(e.modifiedAt / 1000)}
                  </span>
                  <div className="flex gap-1">
                    {e.approval?.state === "current" && (
                      <Badge variant="secondary">
                        <CircleCheck /> Approved
                      </Badge>
                    )}
                    {e.approval?.state === "changed" && (
                      <Badge variant="destructive">
                        <TriangleAlert /> Changed since approval
                      </Badge>
                    )}
                    <Badge variant="outline" className="uppercase">
                      {e.extension}
                    </Badge>
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {state.status === "ready" && state.listing.truncated && (
        <p className="text-xs text-muted-foreground">Showing the first 2000 media files only.</p>
      )}

      <RenderDetailSheet
        projectId={project.id}
        entry={selected}
        tools={tools}
        busy={busy}
        onClose={() => setSelectedPath(null)}
        onApprove={(e, a) => void approve(e, a)}
      />
    </div>
  )
}
