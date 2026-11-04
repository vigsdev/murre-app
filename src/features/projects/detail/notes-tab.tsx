import { cn } from "@/lib/utils"
import type { JSONContent } from "@tiptap/react"
import { ChevronLeft, ChevronRight, Plus, TriangleAlert, X } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { RichTextEditor } from "@/components/rich-text-editor"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { registerFlush } from "@/lib/flush-registry"
import { api, errorMessage, isConflictError, type NotesView } from "@/lib/tauri"

const AUTOSAVE_DELAY_MS = 800
const MAX_PAGES = 20

/** One page of notes; the first page has no id. */
interface Page {
  id: string | null
  content: JSONContent | null
}

const pagesOf = (view: NotesView): Page[] => [
  { id: null, content: view.content as JSONContent | null },
  ...view.pages.map((p) => ({ id: p.id, content: p.content as JSONContent | null })),
]

/** The words in a note, to tell whether a page is empty and to name it. */
function textOf(node: JSONContent | null | undefined): string {
  if (!node) return ""
  const own = typeof node.text === "string" ? node.text : ""
  return [own, ...(node.content ?? []).map(textOf)].join(" ").replace(/\s+/g, " ").trim()
}

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; content: JSONContent | null }

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

/** `fill` makes the editor use all the height its parent offers (the app-wide Notes page). */
export function NotesTab({ projectId, placeholder, fill = false }: { projectId: string | null; placeholder?: string; fill?: boolean }) {
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [save, setSave] = useState<SaveState>({ kind: "saved", at: null })
  const [conflict, setConflict] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [editorKey, setEditorKey] = useState(0)
  // All pages as last saved, which page is open, and what the editor was last given. The editor is only given content
  // when a page is opened: it owns the text while it is being edited.
  const [pages, setPages] = useState<Page[]>([{ id: null, content: null }])
  const pagesRef = useRef<Page[]>(pages)
  const [current, setCurrent] = useState(0)
  const [shown, setShown] = useState<{ key: string; content: JSONContent | null }>({ key: "0-first", content: null })
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Inside a project page the editor takes whatever window height is left below the tabs (the page header and banner
  // above it vary), so it always fills the window and follows resizing.
  const frame = useRef<HTMLDivElement>(null)
  const [fitHeight, setFitHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (fill) return
    const measure = () => {
      const top = frame.current?.getBoundingClientRect().top
      if (top !== undefined) setFitHeight(Math.max(360, Math.floor(window.innerHeight - top - 24)))
    }
    measure()
    const raf = window.requestAnimationFrame(measure) // again once the tab has settled into place
    window.addEventListener("resize", measure)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener("resize", measure)
    }
  }, [fill, load.status])

  // Save bookkeeping lives in refs so edits never wait on React renders.
  const revision = useRef(0)
  const latest = useRef<{ id: string | null; doc: JSONContent } | null>(null)
  const dirty = useRef(false)
  const blocked = useRef(false) // set while a conflict or unreadable content forbids saving
  const timer = useRef<number | undefined>(undefined)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const mounted = useRef(true)

  /** Keep the saved copy of every page; the editor itself is left alone. */
  const remember = (view: NotesView) => {
    const next = pagesOf(view)
    pagesRef.current = next
    if (mounted.current) setPages(next)
  }

  /** Open page `index` of the saved pages, giving the editor that page's content. */
  const showPage = (index: number, from: Page[] = pagesRef.current) => {
    const i = Math.min(Math.max(index, 0), from.length - 1)
    setCurrent(i)
    setShown({ key: `${editorKey}-${from[i].id ?? "first"}`, content: from[i].content })
    setUnsupported(false)
  }

  const flush = useCallback(() => {
    window.clearTimeout(timer.current)
    chain.current = chain.current.then(async () => {
      if (!dirty.current || blocked.current || !latest.current) return
      const { id, doc } = latest.current
      dirty.current = false
      if (mounted.current) setSave({ kind: "saving" })
      try {
        const view = await api.saveNotes(projectId, doc as Record<string, unknown>, revision.current, id)
        revision.current = view.revision
        remember(view)
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

  const fetchFromDisk = useCallback(async () => {
    const view = await api.getNotes(projectId)
    revision.current = view.revision
    return view
  }, [projectId])

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    fetchFromDisk()
      .then((view) => {
        if (cancelled) return
        latest.current = null
        dirty.current = false
        const all = pagesOf(view)
        pagesRef.current = all
        setPages(all)
        setCurrent(0)
        setShown({ key: "0-first", content: all[0].content })
        setLoad({ status: "ready", content: view.content as JSONContent | null })
        setSave({ kind: "saved", at: view.updatedAt })
      })
      .catch((e) => !cancelled && setLoad({ status: "error", message: errorMessage(e) }))

    // Write pending edits when the window is hidden or the tab is left.
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
  }, [fetchFromDisk, flush])

  function onChange(doc: JSONContent) {
    if (blocked.current && !conflict) return
    latest.current = { id: pagesRef.current[current]?.id ?? null, doc }
    dirty.current = true
    setSave({ kind: "unsaved" })
    window.clearTimeout(timer.current)
    if (!blocked.current) timer.current = window.setTimeout(() => void flush(), AUTOSAVE_DELAY_MS)
  }

  function onContentError() {
    blocked.current = true
    dirty.current = false
    setUnsupported(true)
  }

  async function reloadFromDisk() {
    try {
      const view = await fetchFromDisk()
      latest.current = null
      dirty.current = false
      blocked.current = false
      setConflict(false)
      const all = pagesOf(view)
      pagesRef.current = all
      setPages(all)
      setLoad({ status: "ready", content: view.content as JSONContent | null })
      setSave({ kind: "saved", at: view.updatedAt })
      setEditorKey((k) => k + 1)
      const i = Math.min(current, all.length - 1)
      setCurrent(i)
      setShown({ key: `r${editorKey + 1}-${all[i].id ?? "first"}`, content: all[i].content })
    } catch (e) {
      setSave({ kind: "error", message: errorMessage(e) })
    }
  }

  async function overwriteWithMine() {
    try {
      await fetchFromDisk() // adopt the newest revision, then save my version on top of it
      blocked.current = false
      setConflict(false)
      dirty.current = true
      await flush()
    } catch (e) {
      setSave({ kind: "error", message: errorMessage(e) })
    }
  }

  /** Save what is being typed, then run `then`. Page changes wait for a clean save so no edit is lost. */
  async function afterSave(then: () => Promise<void> | void) {
    if (blocked.current) return void toast.error("Resolve the notes conflict first.")
    await flush()
    if (dirty.current || blocked.current) return // the save did not go through; the status line says why
    await then()
  }

  const goTo = (index: number) => void afterSave(() => showPage(index))

  const addPage = () =>
    void afterSave(async () => {
      try {
        const view = await api.addNotesPage(projectId, revision.current)
        revision.current = view.revision
        const all = pagesOf(view)
        pagesRef.current = all
        setPages(all)
        showPage(all.length - 1, all)
      } catch (e) {
        if (isConflictError(e)) {
          blocked.current = true
          setConflict(true)
        } else toast.error(errorMessage(e))
      }
    })

  const removePage = () =>
    void afterSave(async () => {
      const id = pagesRef.current[current]?.id
      if (!id) return
      try {
        const view = await api.deleteNotesPage(projectId, id, revision.current)
        revision.current = view.revision
        const all = pagesOf(view)
        pagesRef.current = all
        setPages(all)
        showPage(current - 1, all)
      } catch (e) {
        if (isConflictError(e)) {
          blocked.current = true
          setConflict(true)
        } else toast.error(errorMessage(e))
      }
    })

  const bar = pages.length > 1

  if (load.status === "loading") return <Skeleton className="h-72" />

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

  return (
    <div
      ref={frame}
      className={cn("relative", fill ? "min-h-0 flex-1" : "overflow-hidden rounded-xl border")}
      style={fill ? undefined : { height: fitHeight ?? 480 }}
    >
      <div className={cn("absolute inset-x-3 z-20 mx-auto flex max-w-xl flex-col gap-2", bar ? "top-14" : "top-3")}>
      {conflict && (
        <Banner title="These notes were changed somewhere else">
          Your edits have not been saved. You can load the version on disk (your unsaved edits are discarded), or
          replace it with what you have here.
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
        <Banner title="This note can't be shown by this version of Murre">
          It contains content the editor doesn't understand, so it is read-only to avoid losing anything. The file on
          disk has not been changed.
        </Banner>
      )}
      </div>

      <RichTextEditor
        key={shown.key}
        content={shown.content}
        className={bar ? "absolute inset-x-0 top-11 bottom-0" : "absolute inset-0"}
        disabled={unsupported}
        onChange={onChange}
        onContentError={onContentError}
        placeholder={placeholder ?? "Write project notes, briefs, feedback…"}
      />

      <div className={cn("absolute right-4 z-30 flex items-center gap-2", bar ? "top-1.5" : "top-3")}>
        <p role="status" className="text-xs text-muted-foreground" aria-live="polite">
          {statusText(save)}
          {save.kind === "error" && (
            <Button size="xs" variant="link" onClick={() => void flush()}>
              Retry
            </Button>
          )}
        </p>
        {current > 0 && (
          <Button
            variant="secondary"
            size="icon-sm"
            className="rounded-full"
            aria-label="Delete this page"
            onClick={() => (textOf(pages[current]?.content) || textOf(latest.current?.doc) ? setConfirmDelete(true) : removePage())}
          >
            <X />
          </Button>
        )}
      </div>

      {pages.length > 1 && (
        <nav aria-label="Pages" className="absolute top-0 left-4 right-56 z-30 flex h-11 items-center gap-1 overflow-x-auto">
          {pages.map((p, i) => (
            <Button
              key={p.id ?? "first"}
              size="xs"
              variant={i === current ? "secondary" : "ghost"}
              aria-current={i === current ? "page" : undefined}
              title={textOf(p.content).slice(0, 60) || `Page ${i + 1}`}
              onClick={() => (i === current ? undefined : goTo(i))}
            >
              {i + 1}
            </Button>
          ))}
        </nav>
      )}

      {current > 0 && (
        <Button variant="secondary" size="icon-lg" className="absolute top-1/2 left-4 z-30 -translate-y-1/2 rounded-full shadow-md" aria-label="Previous page" onClick={() => goTo(current - 1)}>
          <ChevronLeft />
        </Button>
      )}
      {current < pages.length - 1 ? (
        <Button variant="secondary" size="icon-lg" className="absolute top-1/2 right-4 z-30 -translate-y-1/2 rounded-full shadow-md" aria-label="Next page" onClick={() => goTo(current + 1)}>
          <ChevronRight />
        </Button>
      ) : (
        pages.length < MAX_PAGES && (
          <Button variant="secondary" size="icon-lg" className="absolute top-1/2 right-4 z-30 -translate-y-1/2 rounded-full shadow-md" aria-label="Add a page" onClick={addPage}>
            <Plus />
          </Button>
        )
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete page {current + 1}?</AlertDialogTitle>
            <AlertDialogDescription>The text on this page is deleted with it. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false)
                removePage()
              }}
            >
              Delete page
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
