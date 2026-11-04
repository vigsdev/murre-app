import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { AnimatePresence, motion } from "motion/react"
import aeIcon from "@/assets/adobe/after-effects.svg"
import { listItem } from "@/lib/motion"
import { CircleCheck, CircleMinus, Clapperboard, FolderSearch, MoreHorizontal, Pencil, RefreshCw, TriangleAlert } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes, formatDateTime } from "@/lib/format"
import { api, errorMessage, type Workfile, type WorkfileScan } from "@/lib/tauri"
import { cn } from "@/lib/utils"

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; scan: WorkfileScan }

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

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const scan = await api.scanWorkfiles(projectId)
      setState({ status: "ready", scan })
      onScan?.(scan)
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
          <code> _v03</code>.
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
              <p className="py-6 text-center text-sm text-muted-foreground">
                No .aep files here yet. After Effects hasn’t moved in.
              </p>
            ) : (
              <Versions scan={state.scan} pending={pending} onMark={mark} onOpen={onOpen} onNote={saveNote} showAll={showAll} setShowAll={setShowAll} />
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
  scan,
  pending,
  onMark,
  onOpen,
  onNote,
  showAll,
  setShowAll,
}: {
  scan: WorkfileScan
  pending: boolean
  onMark: (path: string | null) => Promise<void>
  onOpen: (path: string) => void
  onNote: (path: string, text: string) => Promise<boolean>
  showAll: boolean
  setShowAll: (v: boolean) => void
}) {
  const head = scan.workfiles.find((w) => w.isCurrent) ?? scan.workfiles[0]
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
      <WorkfileRow w={head} head pending={pending} onMark={onMark} onOpen={onOpen} onNote={onNote} />
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
                <WorkfileRow w={w} pending={pending} onMark={onMark} onOpen={onOpen} onNote={onNote} />
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
  pending,
  onMark,
  onOpen,
  onNote,
}: {
  w: Workfile
  head?: boolean
  pending: boolean
  onMark: (path: string | null) => Promise<void>
  onOpen: (path: string) => void
  onNote: (path: string, text: string) => Promise<boolean>
}) {
  return (
    <div className={cn("group/row flex items-center gap-3.5 rounded-xl px-3.5 py-3", head ? "bg-muted ring-1 ring-foreground/5" : "hover:bg-muted/50")}>
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
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {folderOf(w.path)} · {formatDateTime(w.modifiedAt)} · {formatBytes(w.sizeBytes)}
        </p>
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
          <DropdownMenuItem onClick={() => void revealItemInDir(w.absolutePath).catch((e) => toast.error(errorMessage(e)))}>
            <FolderSearch /> Reveal in Finder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
