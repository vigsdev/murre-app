import { convertFileSrc } from "@tauri-apps/api/core"
import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { CircleCheck, ExternalLink, FolderSearch, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes, formatDateTime } from "@/lib/format"
import { api, errorMessage, type MediaInfo, type MediaTools, type RenderEntry } from "@/lib/tauri"

export function formatDuration(secs: number): string {
  const total = Math.round(secs * 100) / 100
  const m = Math.floor(total / 60)
  const s = total - m * 60
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, "0")}` : `${s.toFixed(2)} s`
}

type Probe = { status: "loading" } | { status: "ready"; info: MediaInfo } | { status: "error"; message: string }
type Playback = { status: "loading" } | { status: "ready"; src: string } | { status: "error"; message: string }

interface Props {
  projectId: string
  entry: RenderEntry | null
  tools: MediaTools | null
  busy: boolean
  onClose: () => void
  onApprove: (entry: RenderEntry, approved: boolean) => void
}

export function RenderDetailSheet({ projectId, entry, tools, busy, onClose, onApprove }: Props) {
  return (
    <Sheet open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {entry && <Body projectId={projectId} entry={entry} tools={tools} busy={busy} onApprove={onApprove} />}
      </SheetContent>
    </Sheet>
  )
}

function Body({ projectId, entry, tools, busy, onApprove }: Omit<Props, "entry" | "onClose"> & { entry: RenderEntry }) {
  const [probe, setProbe] = useState<Probe>({ status: "loading" })
  const [playback, setPlayback] = useState<Playback>({ status: "loading" })
  const [playerFailed, setPlayerFailed] = useState(false)

  const fingerprint = `${entry.path}|${entry.sizeBytes}|${entry.modifiedAt}`

  useEffect(() => {
    let live = true
    setPlayerFailed(false)
    if (entry.kind === "image") {
      setPlayback({ status: "error", message: "" })
    } else {
      setPlayback({ status: "loading" })
      api
        .renderPlaybackPath(projectId, entry.path)
        .then((abs) => live && setPlayback({ status: "ready", src: convertFileSrc(abs) }))
        .catch((e) => live && setPlayback({ status: "error", message: errorMessage(e) }))
    }
    if (!tools?.ffprobe) {
      setProbe({ status: "error", message: "Murre’s media tool (ffprobe) wouldn’t start. Reinstall Murre, or install FFmpeg yourself (brew install ffmpeg)." })
    } else {
      setProbe({ status: "loading" })
      api
        .probeRender(projectId, entry.path)
        .then((info) => live && setProbe({ status: "ready", info }))
        .catch((e) => live && setProbe({ status: "error", message: errorMessage(e) }))
    }
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fingerprint, tools?.ffprobe])

  const approval = entry.approval
  const rows: Array<[string, string]> = [
    ["Folder", entry.folder],
    ["File size", formatBytes(entry.sizeBytes)],
    ["Modified", formatDateTime(entry.modifiedAt / 1000)],
  ]
  if (probe.status === "ready") {
    const { info } = probe
    const v = info.video
    if (v?.width && v.height) rows.push(["Resolution", `${v.width} × ${v.height}`])
    if (v?.frameRate) rows.push(["Frame rate", `${Number(v.frameRate.toFixed(3))} fps`])
    if (v?.codec) rows.push(["Video codec", v.codec])
    if (v?.pixelFormat) rows.push(["Pixel format", v.pixelFormat])
    if (info.durationSecs !== null && entry.kind !== "image") rows.push(["Duration", formatDuration(info.durationSecs)])
    if (info.audio) {
      const a = info.audio
      rows.push(["Audio", [a.codec, a.sampleRate ? `${a.sampleRate / 1000} kHz` : null, a.channels ? `${a.channels} ch` : null].filter(Boolean).join(" · ")])
    }
    if (info.bitRate) rows.push(["Bit rate", `${(info.bitRate / 1_000_000).toFixed(1)} Mbps`])
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="break-all pr-8">{entry.name}</SheetTitle>
        <SheetDescription className="break-all">{entry.path}</SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-4 px-4 pb-4">
        <Preview entry={entry} playback={playback} failed={playerFailed} onFail={() => setPlayerFailed(true)} projectId={projectId} tools={tools} />

        <div className="flex flex-wrap items-center gap-2">
          {approval?.state === "current" && (
            <Badge variant="secondary">
              <CircleCheck /> Approved {formatDateTime(approval.approvedAt)}
            </Badge>
          )}
          {approval?.state === "changed" && (
            <Badge variant="destructive">
              <TriangleAlert /> File changed since it was approved
            </Badge>
          )}
          {!approval && <Badge variant="outline">Not approved</Badge>}
        </div>

        {approval?.state === "changed" && (
          <p role="alert" className="text-sm text-muted-foreground">
            This file's size or date is different from when you approved it (on {formatDateTime(approval.approvedAt)}). The approval has been kept as
            it was. Approve again if this version is the right one, or remove the approval.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {approval?.state === "current" ? (
            <Button variant="outline" disabled={busy} onClick={() => onApprove(entry, false)}>
              Remove approval
            </Button>
          ) : (
            <>
              <Button disabled={busy} onClick={() => onApprove(entry, true)}>
                {approval ? "Approve this version" : "Mark as approved"}
              </Button>
              {approval && (
                <Button variant="outline" disabled={busy} onClick={() => onApprove(entry, false)}>
                  Remove approval
                </Button>
              )}
            </>
          )}
          <Button variant="outline" onClick={() => api.openAsset(projectId, entry.path).catch((e) => toast.error(errorMessage(e)))}>
            <ExternalLink data-icon="inline-start" /> Open
          </Button>
          <Button variant="outline" onClick={() => revealItemInDir(entry.absolutePath).catch((e) => toast.error(errorMessage(e)))}>
            <FolderSearch data-icon="inline-start" /> Show in Finder
          </Button>
        </div>

        <Separator />

        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
        {probe.status === "loading" && <Skeleton className="h-16" />}
        {probe.status === "error" && <p className="text-sm text-muted-foreground">{probe.message}</p>}
      </div>
    </>
  )
}

function Preview({
  entry,
  playback,
  failed,
  onFail,
  projectId,
  tools,
}: {
  entry: RenderEntry
  playback: Playback
  failed: boolean
  onFail: () => void
  projectId: string
  tools: MediaTools | null
}) {
  if (entry.kind === "image") {
    return <StillPreview projectId={projectId} entry={entry} tools={tools} />
  }
  if (playback.status === "loading") return <Skeleton className="aspect-video w-full" />
  if (playback.status === "error" || failed) {
    return (
      <div className="flex flex-col gap-2">
        {entry.kind === "video" && <StillPreview projectId={projectId} entry={entry} tools={tools} />}
        <p className="text-sm text-muted-foreground">
          {playback.status === "error"
            ? playback.message
            : "This file can't be played inside the app (the codec may not be supported). Use Open to play it in your default player."}
        </p>
      </div>
    )
  }
  return entry.kind === "video" ? (
    <video key={playback.src} src={playback.src} controls preload="metadata" onError={onFail} className="aspect-video w-full rounded-lg bg-black" />
  ) : (
    <audio key={playback.src} src={playback.src} controls preload="metadata" onError={onFail} className="w-full" />
  )
}

function StillPreview({ projectId, entry, tools }: { projectId: string; entry: RenderEntry; tools: MediaTools | null }) {
  const [url, setUrl] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    let live = true
    setUrl(null)
    setSettled(!tools?.ffmpeg)
    if (tools?.ffmpeg) {
      api
        .renderThumbnail(projectId, entry.path)
        .then((u) => live && setUrl(u))
        .catch(() => {})
        .finally(() => live && setSettled(true))
    }
    return () => {
      live = false
    }
  }, [projectId, entry.path, entry.sizeBytes, entry.modifiedAt, tools?.ffmpeg])
  return url ? (
    <img src={url} alt="" className="aspect-video w-full rounded-lg bg-muted object-contain" />
  ) : settled ? (
    <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-muted text-sm text-muted-foreground">No preview for this one. A little mystery remains.</div>
  ) : (
    <Skeleton className="aspect-video w-full" />
  )
}
