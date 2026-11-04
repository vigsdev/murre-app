import { Calendar, CornerDownLeft, FileText, FolderKanban, Home, PanelLeft, PenTool, Plus, Settings, X, type LucideIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useSidebar } from "@/components/ui/sidebar"
import { STATUS_OPTIONS, STATUS_TONE } from "@/features/projects/constants"
import { SPACE_ICONS } from "@/features/spaces/space-icons"
import { useSpaces } from "@/features/spaces/spaces-context"
import { useTabs } from "@/features/tabs/tabs-context"
import { api, type ProjectRecord } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { rank, type Searchable } from "./match"
import { modKey } from "@/lib/platform"

type Entry = Searchable & {
  id: string
  group: "Recent" | "Pages" | "Projects" | "Spaces" | "Actions"
  lead: ReactNode
  /** Opens a page: the entry's route. Actions have `run` instead. */
  path?: string
  run?: () => void
}

const PAGES: { label: string; path: string; icon: LucideIcon }[] = [
  { label: "Home", path: "/", icon: Home },
  { label: "Projects", path: "/projects", icon: FolderKanban },
  { label: "Notes", path: "/notes", icon: FileText },
  { label: "Calendar", path: "/calendar", icon: Calendar },
  { label: "Referenxe", path: "/referenxe", icon: PenTool },
  { label: "Settings", path: "/settings", icon: Settings },
]

const STATUS_LABEL = new Map(STATUS_OPTIONS.map((o) => [o.value, o.label]))
const ICON = "size-4 shrink-0 text-muted-foreground"

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>
  const hit = new Set(indices)
  return (
    <>
      {Array.from(text).map((ch, i) => (
        <span key={i} className={hit.has(i) ? "font-semibold" : undefined}>
          {ch}
        </span>
      ))}
    </>
  )
}

/** Cmd+K or Cmd+P: jump to a project, space or page, or run a small action, from the keyboard. */
export function Switcher() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [recent, setRecent] = useState<string[]>([])
  const navigate = useNavigate()
  const { spaces } = useSpaces()
  const { activeId, openNew, close } = useTabs()
  const { toggleSidebar } = useSidebar()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "p")) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])

  // Fresh data and a clean box each time it opens.
  useEffect(() => {
    if (!open) return
    setQuery("")
    setActive(0)
    api.listProjects().then(setProjects).catch(() => {})
    api.recentProjects().then(setRecent).catch(() => {})
  }, [open])

  const entries = useMemo<Entry[]>(() => {
    const byId = new Map(projects.map((p) => [p.id, p]))
    const projectEntry = (p: ProjectRecord, group: Entry["group"]): Entry => ({
      id: `${group}:${p.id}`,
      group,
      label: p.name,
      hint: [p.client, STATUS_LABEL.get(p.status)].filter(Boolean).join(" · "),
      path: `/projects/${p.id}`,
      lead: <span aria-hidden className={cn("mx-1 size-2 shrink-0 rounded-full", STATUS_TONE[p.status]?.dot ?? "bg-muted-foreground/40")} />,
    })
    const list: Entry[] = []
    if (!query.trim()) {
      for (const id of recent.slice(0, 5)) {
        const p = byId.get(id)
        if (p) list.push(projectEntry(p, "Recent"))
      }
    }
    for (const p of PAGES) list.push({ id: `page:${p.path}`, group: "Pages", label: p.label, path: p.path, lead: <p.icon aria-hidden className={ICON} /> })
    for (const p of projects) list.push(projectEntry(p, "Projects"))
    for (const s of spaces) {
      const Icon = SPACE_ICONS[s.icon] ?? FolderKanban
      list.push({ id: `space:${s.id}`, group: "Spaces", label: s.name, hint: "Space", path: `/spaces/${s.id}`, lead: <Icon aria-hidden className={ICON} /> })
    }
    list.push(
      { id: "act:project", group: "Actions", label: "New project", path: "/projects/new", lead: <Plus aria-hidden className={ICON} /> },
      { id: "act:tab", group: "Actions", label: "New tab", run: () => openNew("/"), lead: <Plus aria-hidden className={ICON} /> },
      { id: "act:close", group: "Actions", label: "Close this tab", run: () => close(activeId), lead: <X aria-hidden className={ICON} /> },
      { id: "act:sidebar", group: "Actions", label: "Show or hide the sidebar", run: toggleSidebar, lead: <PanelLeft aria-hidden className={ICON} /> },
    )
    return list
  }, [projects, recent, spaces, query, openNew, close, activeId, toggleSidebar])

  const results = useMemo(() => {
    const ranked = rank(query, entries, 40)
    // With a query the best matches lead whatever group they are in; without one the groups keep their order.
    return ranked
  }, [query, entries])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const choose = (entry: Entry, inNewTab: boolean) => {
    setOpen(false)
    if (entry.run) return entry.run()
    if (!entry.path) return
    if (inNewTab) openNew(entry.path)
    else navigate(entry.path)
  }

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const hit = results[active]
      if (hit) choose(hit.item, e.metaKey || e.ctrlKey)
    }
  }

  let lastGroup = ""
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        // The app behind stays sharp: a faint dim, no blur. The panel itself is the frosted part.
        overlayClassName="bg-black/10 supports-backdrop-filter:backdrop-blur-none"
        className="top-[18%] -translate-y-0 gap-0 overflow-hidden bg-popover/75 p-0 shadow-2xl ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Jump to</DialogTitle>
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="switcher-list"
          aria-activedescendant={results[active] ? `switcher-${active}` : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          placeholder="Jump to a project, space or page"
          className="h-12 w-full border-b bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div ref={listRef} id="switcher-list" role="listbox" className="max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">Nothing matches that.</p>}
          {results.map(({ item, indices }, i) => {
            const heading = !query.trim() && item.group !== lastGroup ? item.group : null
            lastGroup = item.group
            return (
              <div key={item.id}>
                {heading && <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">{heading}</p>}
                <div
                  id={`switcher-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={(e) => choose(item, e.metaKey || e.ctrlKey)}
                  className={cn("flex h-9 cursor-default items-center gap-2.5 rounded-lg px-3 text-sm", i === active && "bg-foreground/[0.07]")}
                >
                  {item.lead}
                  <span className="truncate">
                    <Highlighted text={item.label} indices={indices} />
                  </span>
                  {item.hint && <span className="ml-auto truncate pl-3 text-xs text-muted-foreground/70">{item.hint}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><CornerDownLeft className="size-3" /> Open</span>
          <span>{modKey}↵ New tab</span>
          <span className="ml-auto">Esc to close</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
