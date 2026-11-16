import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { AnimatePresence, motion } from "motion/react"
import aeIcon from "@/assets/adobe/after-effects.svg"
import { listItem } from "@/lib/motion"
import { CircleCheck, CircleMinus, Clapperboard, FolderSearch, GitCompareArrows, MoreHorizontal, Pencil, RefreshCw, TriangleAlert } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes, formatDateTime } from "@/lib/format"
import { api, errorMessage, type VersionDetails, type VersionDiff, type Workfile, type WorkfileScan } from "@/lib/tauri"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { baseName, showInFileBrowser } from "@/lib/platform"
import { StarterProgress, announceStarter, useStarter } from "../starter-progress"
import { defaultInstall, useAeInstalls } from "../use-ae-installs"

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; scan: WorkfileScan }

/** "2026-11-14T23:26:46+05:30" as a local date and time, in the app's usual format. */
function formatIso(iso: string) {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : formatDateTime(Math.floor(t / 1000))
}

function folderOf(path: string) {
  const i = path.lastIndexOf("/")
  return i === -1 ? "Project folder" : path.slice(0, i)
}

export function WorkfileTimeline({
  projectId,
  reloadToken = 0,
  onOpen,
  onScan,
}: {
  projectId: string
  reloadToken?: number
  /** Called with every fresh scan, so neighbours can use it without scanning again. */
  onScan?: (scan: WorkfileScan) => void
  /** Opens the given .aep (project-relative path) in After Effects. */
  onOpen: (path: string) => void
}) {
  const [state, setState] = useState<State>({ status: "loading" })
  const [refreshing, setRefreshing] = useState(false)
  const [pending, setPending] = useState(false)
  const [showAll, setShowAll] = useState(false)
  // Read from the .aep files after the list shows: who saved each one, what it came from, its auto-saves. Optional.
  const [details, setDetails] = useState<VersionDetails | null>(null)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const scan = await api.scanWorkfiles(projectId)
      setState({ status: "ready", scan })
      onScan?.(scan)
      api.workfileVersions(projectId).then(setDetails, () => setDetails(null))
    } catch (e) {
      setState({ status: "error", message: errorMessage(e) })
    } finally {
      setRefreshing(false)
    }
  }, [projectId, onScan])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (reloadToken > 0) void load()
  }, [reloadToken, load])

  async function mark(path: string | null) {
    setPending(true)
    try {
      const scan = await api.setCurrentAep(projectId, path)
      setState({ status: "ready", scan })
      onScan?.(scan)
      toast.success(path ? "Marked as current After Effects project" : "Current project cleared")
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending(false)
    }
  }

  /** Saves the one-line note of a version. A failure keeps what was typed visible, so it can be tried again. */
  async function saveNote(path: string, text: string): Promise<boolean> {
    try {
      const scan = await api.setWorkfileNote(projectId, path, text)
      setState({ status: "ready", scan })
      onScan?.(scan)
      return true
    } catch (e) {
      toast.error(errorMessage(e))
      return false
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>After Effects versions</CardTitle>
        <CardDescription>
          .aep files found in this project, newest first. Versions are detected from file names such as
          <code> _v03</code>, and each file says which After Effects saved it and which version it was saved from.
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" aria-label="Rescan" disabled={refreshing} onClick={() => void load()}>
            <RefreshCw className={cn(refreshing && "animate-spin")} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {state.status === "loading" && <Skeleton className="h-32" />}

        {state.status === "error" && (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        )}

        {state.status === "ready" && (
          <>
            {state.scan.currentAep && !state.scan.currentAep.exists && (
              <div role="status" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="flex-1">
                  <p className="font-medium">Your current project file has gone missing.</p>
                  <p className="break-all text-muted-foreground">{state.scan.currentAep.path}</p>
                  <p className="text-muted-foreground">It may have been renamed or moved. Mark another file as current.</p>
                </div>
                <Button size="xs" variant="outline" disabled={pending} onClick={() => void mark(null)}>
                  Clear
                </Button>
              </div>
            )}

            {state.scan.workfiles.length === 0 ? (
              <CreateFirstAep projectId={projectId} onDone={() => void load()} />
            ) : (
              <Versions projectId={projectId} scan={state.scan} details={details} pending={pending} onMark={mark} onOpen={onOpen} onNote={saveNote} showAll={showAll} setShowAll={setShowAll} />
            )}

            {state.scan.truncated && (
              <p className="text-xs text-muted-foreground">Showing the first 1000 files only.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** The empty state: no .aep yet, so offer to have After Effects make the first one. */
function CreateFirstAep({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const starter = useStarter()
  const install = defaultInstall(useAeInstalls())
  const create = async () => {
    try {
      announceStarter(await starter.run(projectId, install?.path ?? null), baseName)
    } catch (e) {
      toast.error(errorMessage(e))
    }
    onDone()
  }
  if (starter.stage) return <StarterProgress stage={starter.stage} aerenderPath={install?.path ?? null} />
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <p className="text-sm text-muted-foreground">No .aep files here yet. After Effects hasn’t moved in.</p>
      <Button type="button" size="sm" variant="outline" disabled={starter.running} onClick={() => void create()}>
        <img src={aeIcon} alt="" className="size-4" />
        Create in After Effects
      </Button>
    </div>
  )
}

const OLDER_SHOWN = 3

const DISMISSED_KEY = "murre.dismissedNewerSaves"

/** Files whose "saved more recently" nudge was dismissed, with the save time that was dismissed. Kept on this Mac. */
function readDismissed(): Record<string, string> {
  try {
    const v = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "{}")
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

function writeDismissed(map: Record<string, string>) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(map))
  } catch {
    /* blocked storage: the nudge just comes back next time */
  }
}

/** The current version stands out at the top; older ones hang below it, newest first. */
function Versions({
  projectId,
  scan,
  details,
  pending,
  onMark,
  onOpen,
  onNote,
  showAll,
  setShowAll,
}: {
  projectId: string
  scan: WorkfileScan
  details: VersionDetails | null
  pending: boolean
  onMark: (path: string | null) => Promise<void>
  onOpen: (path: string) => void
  onNote: (path: string, text: string) => Promise<boolean>
  showAll: boolean
  setShowAll: (v: boolean) => void
}) {
  const head = scan.workfiles.find((w) => w.isCurrent) ?? scan.workfiles[0]
  // What a version is compared with: the file it was saved from, else the next older file in the list.
  const baseOf = (w: Workfile): string | null => {
    const parent = details?.versions.find((v) => v.path === w.path)?.parent
    if (parent) return parent
    const older = scan.workfiles.filter((o) => o !== w && o.modifiedAt < w.modifiedAt).sort((a, b) => b.modifiedAt - a.modifiedAt)[0]
    return older?.path ?? null
  }
  const older = scan.workfiles.filter((w) => w !== head)
  const shown = showAll ? older : older.slice(0, OLDER_SHOWN)
  // If the most recently saved file is not the one shown as current, say so.
  const newest = scan.workfiles.reduce((a, b) => (b.modifiedAt > a.modifiedAt ? b : a), scan.workfiles[0])
  const [dismissed, setDismissed] = useState(readDismissed)
  const newer = newest && newest !== head && newest.modifiedAt > head.modifiedAt ? newest : null
  // A dismissal only covers that save. Saving the file again brings the question back.
  const suggest = newer && dismissed[newer.path] !== String(newer.modifiedAt) ? newer : null
  function dismiss(w: Workfile) {
    const next = { ...dismissed, [w.path]: String(w.modifiedAt) }
    setDismissed(next)
    writeDismissed(next)
  }
  return (
    <div className="flex flex-col gap-3">
      <WorkfileRow w={head} head details={details} base={baseOf(head)} projectId={projectId} pending={pending} onMark={onMark} onOpen={onOpen} onNote={onNote} />
      {suggest && (
        <div role="status" className="ml-[2.125rem] flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-dashed px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 text-muted-foreground">
            <span className="font-medium text-foreground">{suggest.name}</span> was saved more recently
            ({formatDateTime(suggest.modifiedAt)}). Is that the one you are working on?
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => dismiss(suggest)}>
              Dismiss
            </Button>
            <Button size="xs" variant="outline" disabled={pending} onClick={() => void onMark(suggest.path)}>
              Mark as current
            </Button>
          </div>
        </div>
      )}
      {older.length > 0 && (
        <ul className="ml-[2.125rem] flex flex-col gap-1 border-l pl-3">
          <AnimatePresence initial={false}>
            {shown.map((w) => (
              <motion.li key={w.path} {...listItem}>
                <WorkfileRow w={w} details={details} base={baseOf(w)} projectId={projectId} pending={pending} onMark={onMark} onOpen={onOpen} onNote={onNote} />
              </motion.li>
            ))}
          </AnimatePresence>
          {older.length > OLDER_SHOWN && (
            <li>
              <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setShowAll(!showAll)}>
                {showAll ? "Show less" : `Show ${older.length - OLDER_SHOWN} more`}
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

function WorkfileRow({
  w,
  head,
  details,
  base,
  projectId,
  pending,
  onMark,
  onOpen,
  onNote,
}: {
  w: Workfile
  head?: boolean
  details: VersionDetails | null
  /** The version to compare this one with, if any. */
  base: string | null
  projectId: string
  pending: boolean
  onMark: (path: string | null) => Promise<void>
  onOpen: (path: string) => void
  onNote: (path: string, text: string) => Promise<boolean>
}) {
  const d = details?.versions.find((v) => v.path === w.path)
  const parent = d?.parent ? baseName(d.parent) : null
  const autoSaves = details?.autoSaves.filter((a) => a.parent === w.path) ?? []
  const [comparing, setComparing] = useState(false)
  return (
    <div className={cn("group/row flex items-start gap-3.5 rounded-xl px-3.5 py-3", head ? "bg-muted ring-1 ring-foreground/5" : "hover:bg-muted/50")}>
      {/* The same size for every row, so names line up. Only the file that is current is in color. */}
      <img
        src={aeIcon}
        alt=""
        draggable={false}
        aria-hidden
        className={cn("size-10 shrink-0 rounded-[10px]", !w.isCurrent && "opacity-60 grayscale dark:opacity-90 dark:brightness-[5]")}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("truncate text-sm", head && "font-medium")}>{w.name}</span>
          {w.isCurrent && <Badge>Current</Badge>}
          {/* On the highlighted row the secondary badge is the same grey as the row, so it needs its own fill to read as a badge. */}
          {w.version !== null && <Badge variant="secondary" className={head ? "bg-background text-foreground" : undefined}>v{w.version}</Badge>}
          {w.version !== null && w.isLatestVersion && <Badge variant="outline">Highest version</Badge>}
          {d?.sameProject === false && (
            <Badge variant="outline" title="This file started as a different After Effects document: a template, or another project's file saved here.">
              Other project file
            </Badge>
          )}
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground" title={d?.savedAt ? `Last saved in After Effects: ${formatIso(d.savedAt)}` : undefined}>
          {folderOf(w.path)} · {formatDateTime(w.modifiedAt)} · {formatBytes(w.sizeBytes)}
          {d?.savedWith && ` · AE ${d.savedWith}${d.beta ? " Beta" : ""}`}
          {parent && ` · saved from ${parent}`}
        </p>
        {d?.tooNew && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-3.5 shrink-0" />
            Saved in After Effects {d.savedWith}. The After Effects here is {details?.installedMajor ? `${details.installedMajor}.x` : "older"}, so it can’t open this file.
          </p>
        )}
        {autoSaves.length > 0 && (
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer select-none hover:text-foreground">
              {autoSaves.length} auto-save{autoSaves.length === 1 ? "" : "s"} from this version
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {autoSaves.map((a) => (
                <li key={a.path} className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{baseName(a.path)}</span>
                  {a.savedAt && <span className="shrink-0 tabular-nums">{formatIso(a.savedAt)}</span>}
                  <Button size="xs" variant="ghost" className="shrink-0" onClick={() => onOpen(a.path)}>
                    Open in AE
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        )}
        <VersionNote w={w} head={head} onSave={(text) => onNote(w.path, text)} />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${w.name}`} />}>
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-44 whitespace-nowrap">
          <DropdownMenuItem onClick={() => onOpen(w.path)}>
            <Clapperboard /> Open in AE
          </DropdownMenuItem>
          {w.isCurrent ? (
            <DropdownMenuItem disabled={pending} onClick={() => void onMark(null)}>
              <CircleMinus /> Unmark as current
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={pending} onClick={() => void onMark(w.path)}>
              <CircleCheck /> Mark as current
            </DropdownMenuItem>
          )}
          {base && (
            <DropdownMenuItem onClick={() => setComparing(true)}>
              <GitCompareArrows /> What changed since {baseName(base)}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void revealItemInDir(w.absolutePath).catch((e) => toast.error(errorMessage(e)))}>
            <FolderSearch /> {showInFileBrowser}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {base && comparing && <ChangesDialog projectId={projectId} from={base} to={w.path} onClose={() => setComparing(false)} />}
    </div>
  )
}

/** What changed between two versions, read from both files. */
function ChangesDialog({ projectId, from, to, onClose }: { projectId: string; from: string; to: string; onClose: () => void }) {
  const [diff, setDiff] = useState<VersionDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.compareWorkfiles(projectId, from, to).then(setDiff, (e) => setError(errorMessage(e)))
  }, [projectId, from, to])
  const groups: [string, string[]][] = diff
    ? [
        ["New comps", diff.compsAdded],
        ["Changed comps", diff.compsChanged],
        ["Removed comps", diff.compsRemoved],
        ["New footage", diff.footageAdded],
        ["Footage no longer used", diff.footageRemoved],
        ["New effects", diff.effectsAdded],
        ["New fonts", diff.fontsAdded],
        ["Fonts no longer used", diff.fontsRemoved],
      ]
    : []
  const shown = groups.filter(([, items]) => items.length > 0)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>What changed in {baseName(to)}</DialogTitle>
          <DialogDescription>Compared with {baseName(from)}, from the saved files.</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!diff && !error && <Skeleton className="h-24" />}
        {diff && shown.length === 0 && <p className="text-sm text-muted-foreground">No changes to comps, footage, effects or fonts. The work is in the details.</p>}
        {shown.length > 0 && (
          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
            {shown.map(([title, items]) => (
              <section key={title} className="flex flex-col gap-1">
                <h3 className="text-xs text-muted-foreground">
                  {title} <span className="tabular-nums">· {items.length}</span>
                </h3>
                <ul className="flex flex-col gap-0.5 text-sm">
                  {items.slice(0, 50).map((x) => (
                    <li key={x} className="truncate" title={x}>
                      {x}
                    </li>
                  ))}
                  {items.length > 50 && <li className="text-muted-foreground">…and {items.length - 50} more</li>}
                </ul>
              </section>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

const NOTE_MAX = 280

/**
 * The one line about what changed in a version. Click to write or edit; Enter or leaving the box saves, Escape cancels,
 * and an empty line removes the note. The newest version asks for a note until it has one.
 */
function VersionNote({ w, head, onSave }: { w: Workfile; head?: boolean; onSave: (text: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState("")
  const [saving, setSaving] = useState(false)
  const label = w.version !== null ? `v${w.version}` : "this version"

  async function commit() {
    if (saving) return
    if (text.trim() === (w.note ?? "")) return setEditing(false)
    setSaving(true)
    const ok = await onSave(text)
    setSaving(false)
    if (ok) setEditing(false)
  }

  if (editing) {
    return (
      <Input
        autoFocus
        className="mt-1 h-7 text-xs"
        aria-label={`Note for ${w.name}`}
        placeholder={`What changed in ${label}?`}
        maxLength={NOTE_MAX}
        value={text}
        disabled={saving}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit()
          if (e.key === "Escape") setEditing(false)
        }}
      />
    )
  }
  const start = () => {
    setText(w.note ?? "")
    setEditing(true)
  }
  if (w.note) {
    return (
      <button type="button" onClick={start} className="group mt-1 flex max-w-full items-start gap-1 text-left text-xs" title="Edit note">
        <span className="min-w-0 break-words">{w.note}</span>
        <Pencil className="mt-0.5 size-3 shrink-0 opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60" />
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={start}
      className={cn("mt-1 text-left text-xs text-muted-foreground hover:text-foreground", !head && "opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100")}
    >
      {head ? `What changed in ${label}? Add a note` : "Add a note"}
    </button>
  )
}
