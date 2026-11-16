import { cn } from "@/lib/utils"
import type { JSONContent } from "@tiptap/react"
import { Plus, TriangleAlert, X } from "lucide-react"
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

/** A page's name: its first line, the way a notes app names a note. */
function pageName(content: JSONContent | null | undefined): string {
  const first = content?.content?.find((n) => textOf(n))
  return textOf(first).slice(0, 80)
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
  // Every page opened so far keeps its editor (hidden when not shown), so its undo history survives switching pages.
  const [editors, setEditors] = useState<{ key: string; content: JSONContent | null }[]>([{ key: "0-first", content: null }])
  const [shownKey, setShownKey] = useState("0-first")

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

  const editorKeyOf = (gen: number, id: string | null) => `${gen}-${id ?? "first"}`

  /** Open page `index` of the saved pages: its editor if it was open before, else a new one with that page's content. */
  const showPage = (index: number, from: Page[] = pagesRef.current) => {
    const i = Math.min(Math.max(index, 0), from.length - 1)
    const key = editorKeyOf(editorKey, from[i].id)
    setCurrent(i)
    setEditors((list) => (list.some((e) => e.key === key) ? list : [...list, { key, content: from[i].content }]))
    setShownKey(key)
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
        setEditors([{ key: "0-first", content: all[0].content }])
        setShownKey("0-first")
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
      // Fresh editors from what is on disk; the old ones (and their undo) belong to a version that was replaced.
      const key = editorKeyOf(editorKey + 1, all[i].id)
      setEditors([{ key, content: all[i].content }])
      setShownKey(key)
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

  /** Delete page `index` (never the first). The open page stays open, or its neighbour when it is the one deleted. */
  const removePage = (index: number) =>
    void afterSave(async () => {
      const id = pagesRef.current[index]?.id
      if (!id) return
      const openId = pagesRef.current[current]?.id ?? null
      try {
        const view = await api.deleteNotesPage(projectId, id, revision.current)
        revision.current = view.revision
        const all = pagesOf(view)
        pagesRef.current = all
        setPages(all)
        setEditors((list) => list.filter((e) => e.key !== editorKeyOf(editorKey, id)))
        if (index === current) showPage(index - 1, all)
        else setCurrent(Math.max(0, all.findIndex((p) => p.id === openId)))
      } catch (e) {
        if (isConflictError(e)) {
          blocked.current = true
          setConflict(true)
        } else toast.error(errorMessage(e))
      }
    })

  /** The open page's name follows what is being typed, before it is saved. */
  const nameOf = (i: number) => {
    const page = pages[i]
    const typed = i === current && latest.current && latest.current.id === (page?.id ?? null) ? latest.current.doc : null
    return pageName(typed ?? page?.content) || "Untitled"
  }
  const hasText = (i: number) => !!(textOf(pages[i]?.content) || (i === current && textOf(latest.current?.doc)))
  const [deleting, setDeleting] = useState<number | null>(null)

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
      className={cn("relative flex", fill ? "min-h-0 flex-1" : "overflow-hidden rounded-xl border")}
      style={fill ? undefined : { height: fitHeight ?? 480 }}
    >
      {/* Pages, named by their first line. The first page is always there; the others can be deleted. */}
      <nav aria-label="Pages" className="flex w-56 shrink-0 flex-col border-r">
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {pages.map((p, i) => (
            <li key={p.id ?? "first"} className="group/page relative">
              <button
                type="button"
                aria-current={i === current ? "page" : undefined}
                title={nameOf(i)}
                onClick={() => (i === current ? undefined : goTo(i))}
                className={cn(
                  "flex h-9 w-full items-center rounded-lg px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  i > 0 && "pr-9",
                  i === current ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <span className={cn("truncate", nameOf(i) === "Untitled" && "text-muted-foreground/70")}>{nameOf(i)}</span>
              </button>
              {i > 0 && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 group-hover/page:opacity-100 focus-visible:opacity-100"
                  aria-label={`Delete “${nameOf(i)}”`}
                  title="Delete page"
                  onClick={() => (hasText(i) ? setDeleting(i) : removePage(i))}
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
        <div className="border-t p-2">
          <Button
            variant="ghost"
            className="h-9 w-full justify-start rounded-lg px-3 text-muted-foreground hover:text-foreground"
            disabled={pages.length >= MAX_PAGES}
            title={pages.length >= MAX_PAGES ? `${MAX_PAGES} pages is the most for now` : undefined}
            onClick={addPage}
          >
            <Plus /> New page
          </Button>
        </div>
      </nav>

      <div className="relative min-w-0 flex-1">
        <div className="absolute inset-x-3 top-3 z-20 mx-auto flex max-w-xl flex-col gap-2">
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

        {editors.map((e) => (
          <RichTextEditor
            key={e.key}
            content={e.content}
            className={cn("absolute inset-0", e.key !== shownKey && "hidden")}
            disabled={unsupported}
            onChange={onChange}
            onContentError={onContentError}
            placeholder={placeholder ?? "Write project notes, briefs, feedback…"}
          />
        ))}

        <p role="status" className="absolute top-3 right-4 z-30 text-xs text-muted-foreground" aria-live="polite">
          {statusText(save)}
          {save.kind === "error" && (
            <Button size="xs" variant="link" onClick={() => void flush()}>
              Retry
            </Button>
          )}
        </p>
      </div>

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting !== null ? nameOf(deleting) : ""}”?</AlertDialogTitle>
            <AlertDialogDescription>The text on this page is deleted with it. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const i = deleting
                setDeleting(null)
                if (i !== null) removePage(i)
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
