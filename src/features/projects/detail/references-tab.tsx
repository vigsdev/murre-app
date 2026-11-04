import { cn } from "@/lib/utils"
import { Circle, FileUp, Link2, Minus, MoveRight, Shapes, Square, Type, TriangleAlert } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { BoardCanvas, type BoardHandle } from "@/features/references/board-canvas"
import { emptyBoard, normalizeUrl, parseBoard, type Board } from "@/features/references/board"
import { isTldrawCanvas, migrateTldraw } from "@/features/references/migrate-tldraw"
import { registerFlush } from "@/lib/flush-registry"
import { api, errorMessage, isConflictError } from "@/lib/tauri"

const AUTOSAVE_DELAY_MS = 1500

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; board: Board; unsupported: boolean; converted: boolean }
type SaveState =
  | { kind: "saved"; at: number | null }
  | { kind: "unsaved" }
  | { kind: "saving" }
  | { kind: "error"; message: string }

function statusText(s: SaveState) {
  switch (s.kind) {
    case "saving":
      return "Saving…"
    case "unsaved":
      return "Unsaved changes"
    case "error":
      return `Not saved: ${s.message}`
    case "saved":
      return s.at ? `Saved ${new Date(s.at * 1000).toLocaleTimeString(undefined, { timeStyle: "short" })}` : "Saved"
  }
}

/** Reads what is on disk: a Murre board, an older tldraw board (converted), or something it cannot open. */
function readCanvas(canvas: Record<string, unknown> | null): { board: Board; unsupported: boolean; converted: boolean; dropped: number } {
  if (canvas === null) return { board: emptyBoard(), unsupported: false, converted: false, dropped: 0 }
  if (isTldrawCanvas(canvas)) {
    const { board, dropped } = migrateTldraw(canvas)
    return { board, unsupported: false, converted: true, dropped }
  }
  const board = parseBoard(canvas)
  return board
    ? { board, unsupported: false, converted: false, dropped: 0 }
    : { board: emptyBoard(), unsupported: true, converted: false, dropped: 0 }
}

/** `fill` makes the board use all the height its parent offers (the app-wide Referenxe page). */
export function ReferencesTab({ projectId, fill = false }: { projectId: string | null; fill?: boolean }) {
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [save, setSave] = useState<SaveState>({ kind: "saved", at: null })
  const [conflict, setConflict] = useState(false)
  const [boardKey, setBoardKey] = useState(0)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkText, setLinkText] = useState("")
  const [linkError, setLinkError] = useState<string | null>(null)

  const boardRef = useRef<BoardHandle>(null)
  const frame = useRef<HTMLDivElement>(null)
  // Inside a project page the board takes whatever window height is left below it (the page header, banner and tabs above
  // it vary), so every board control stays on screen.
  const [fitHeight, setFitHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (fill) return
    const measure = () => {
      const top = frame.current?.getBoundingClientRect().top
      if (top !== undefined) setFitHeight(Math.max(360, Math.floor(window.innerHeight - top - 24)))
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [fill, load.status])
  const fileInput = useRef<HTMLInputElement>(null)
  const revision = useRef(0)
  const dirty = useRef(false)
  const blocked = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const mounted = useRef(true)
  /** The latest board, kept here too so a flush right after unmount still has something to write. */
  const latestBoard = useRef<Board | null>(null)
  const unsupported = load.status === "ready" && load.unsupported

  const flush = useCallback(() => {
    window.clearTimeout(timer.current)
    chain.current = chain.current.then(async () => {
      const board = boardRef.current?.getBoard() ?? latestBoard.current
      if (!dirty.current || blocked.current || !board) return
      dirty.current = false
      if (mounted.current) setSave({ kind: "saving" })
      try {
        const view = await api.saveReferences(projectId, board as unknown as Record<string, unknown>, revision.current)
        revision.current = view.revision
        if (mounted.current) setSave(dirty.current ? { kind: "unsaved" } : { kind: "saved", at: view.updatedAt })
      } catch (e) {
        dirty.current = true
        if (isConflictError(e)) {
          blocked.current = true
          if (mounted.current) {
            setConflict(true)
            setSave({ kind: "unsaved" })
          }
        } else if (mounted.current) {
          setSave({ kind: "error", message: errorMessage(e) })
        }
      }
    })
    return chain.current
  }, [projectId])

  const markDirty = useCallback(
    (board: Board) => {
      latestBoard.current = board
      if (blocked.current) return
      dirty.current = true
      setSave({ kind: "unsaved" })
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), AUTOSAVE_DELAY_MS)
    },
    [flush],
  )

  const fetchFromDisk = useCallback(async () => {
    const view = await api.getReferences(projectId)
    revision.current = view.revision
    return view
  }, [projectId])

  const applyDiskState = useCallback(
    (view: { canvas: Record<string, unknown> | null; updatedAt: number | null }) => {
      const read = readCanvas(view.canvas)
      latestBoard.current = read.board
      blocked.current = read.unsupported
      dirty.current = false
      setLoad({ status: "ready", board: read.board, unsupported: read.unsupported, converted: read.converted })
      setSave({ kind: "saved", at: view.updatedAt })
      if (read.converted) {
        // Boards made by earlier versions are converted once and saved right away. The old file is kept next to the
        // new one, so nothing is lost even for the things that cannot be carried over.
        dirty.current = true
        void flush()
        if (read.dropped > 0) {
          toast.warning(
            `${read.dropped} drawing${read.dropped === 1 ? "" : "s"} or shape${read.dropped === 1 ? "" : "s"} could not be carried over to the new board. Your original board is kept as references.tldraw-backup.json in the project's .murre/references folder.`,
            { duration: 12000 },
          )
        }
      }
    },
    [flush],
  )

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    fetchFromDisk()
      .then((view) => !cancelled && applyDiskState(view))
      .catch((e) => !cancelled && setLoad({ status: "error", message: errorMessage(e) }))

    const onHide = () => {
      if (document.visibilityState === "hidden") void flush()
    }
    const onBlur = () => void flush()
    document.addEventListener("visibilitychange", onHide)
    window.addEventListener("blur", onBlur)
    const unregister = registerFlush(flush)
    return () => {
      unregister()
      cancelled = true
      mounted.current = false
      document.removeEventListener("visibilitychange", onHide)
      window.removeEventListener("blur", onBlur)
      void flush()
    }
  }, [fetchFromDisk, applyDiskState, flush])

  async function addLink() {
    const url = normalizeUrl(linkText)
    if (!url) {
      setLinkError("Enter a web address starting with http:// or https://.")
      return
    }
    boardRef.current?.addLink(url)
    setLinkOpen(false)
    setLinkText("")
    setLinkError(null)
  }

  async function reloadFromDisk() {
    try {
      const view = await fetchFromDisk()
      setConflict(false)
      applyDiskState(view)
      setBoardKey((k) => k + 1)
    } catch (e) {
      setSave({ kind: "error", message: errorMessage(e) })
    }
  }

  async function overwriteWithMine() {
    try {
      await fetchFromDisk()
      blocked.current = false
      setConflict(false)
      dirty.current = true
      await flush()
    } catch (e) {
      setSave({ kind: "error", message: errorMessage(e) })
    }
  }

  if (load.status === "loading") return <Skeleton className={fill ? "min-h-96 flex-1" : "h-96"} />
  if (load.status === "error") {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-destructive">
          {load.message}
        </p>
        <Button size="sm" variant="outline" onClick={() => void reloadFromDisk()}>
          Try again
        </Button>
      </div>
    )
  }

  const openFile = () => fileInput.current?.click()
  const openLink = () => setLinkOpen(true)

  return (
    <div
      ref={frame}
      className={cn("relative overflow-hidden", fill ? "min-h-0 flex-1" : "rounded-xl border")}
      style={fill ? undefined : { height: fitHeight ?? 480 }}
    >
      <div className="absolute inset-0">
        <BoardCanvas
          key={boardKey}
          ref={boardRef}
          projectId={projectId}
          initial={load.board}
          readOnly={unsupported}
          onChange={markDirty}
          onPickFile={openFile}
          onPickLink={openLink}
        />
      </div>

      {(conflict || unsupported) && (
        <div className="absolute inset-x-3 top-3 z-20 mx-auto flex max-w-xl flex-col gap-2">
          {conflict && (
            <Banner title="This board was changed somewhere else">
              Your edits have not been saved. You can load the version on disk (your unsaved edits are discarded), or replace it with
              what you have here.
              <div className="mt-2 flex gap-2">
                <Button size="xs" variant="outline" onClick={() => void reloadFromDisk()}>
                  Load version from disk
                </Button>
                <Button size="xs" variant="outline" onClick={() => void overwriteWithMine()}>
                  Overwrite with my version
                </Button>
              </div>
            </Banner>
          )}
          {unsupported && (
            <Banner title="This board can't be opened by this version of Murre">
              It was saved by something newer or different, so it is read-only to avoid losing anything. The file on disk has not been
              changed.
            </Banner>
          )}
        </div>
      )}

      <p role="status" aria-live="polite" className="absolute top-3 right-4 z-10 text-xs text-muted-foreground">
        {statusText(save)}
        {save.kind === "error" && (
          <Button size="xs" variant="link" onClick={() => void flush()}>
            Retry
          </Button>
        )}
      </p>

      <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground">
        <Button variant="ghost" size="icon-sm" disabled={unsupported} aria-label="Add image or file" title="Add image or file (I)" onClick={openFile}>
          <FileUp />
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={unsupported} aria-label="Add text" title="Add text (T)" onClick={() => boardRef.current?.addText()}>
          <Type />
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={unsupported} aria-label="Add link" title="Add link (K)" onClick={openLink}>
          <Link2 />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" disabled={unsupported} aria-label="Add shape" title="Add shape" />}
          >
            <Shapes />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="top">
            <DropdownMenuItem onClick={() => boardRef.current?.addShape("rect")}>
              <Square /> Rectangle
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => boardRef.current?.addShape("ellipse")}>
              <Circle /> Ellipse
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => boardRef.current?.addShape("line")}>
              <Minus /> Line
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => boardRef.current?.addShape("arrow")}>
              <MoveRight /> Arrow
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.svg,video/mp4,video/quicktime,video/webm,application/pdf,.pdf"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ""
          void boardRef.current?.addFiles(files)
        }}
      />

      <Dialog open={linkOpen} onOpenChange={(o) => (setLinkOpen(o), !o && setLinkError(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add link</DialogTitle>
            <DialogDescription>Adds a link card to the board. Murre does not visit the page.</DialogDescription>
          </DialogHeader>
          <form
            id="add-link"
            onSubmit={(e) => {
              e.preventDefault()
              void addLink()
            }}
          >
            <Input
              autoFocus
              aria-label="Web address"
              placeholder="https://example.com/reference"
              value={linkText}
              onChange={(e) => {
                setLinkText(e.target.value)
                setLinkError(null)
              }}
            />
            {linkError && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {linkError}
              </p>
            )}
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" form="add-link">
              Add link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Banner({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div>
        <p className="font-medium">{title}</p>
        <div className="text-muted-foreground">{children}</div>
      </div>
    </div>
  )
}
