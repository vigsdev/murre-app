import { Calendar, ChevronLeft, ChevronRight, FileText, FolderKanban, Home, PenTool, Plus, Settings, X, type LucideIcon } from "lucide-react"
import { motion } from "motion/react"
import { useEffect, useRef, useState } from "react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { STATUS_TONE } from "@/features/projects/constants"
import { MOVE } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { projectIdOf, spaceIdOf, type Tab } from "./tab-state"
import { useTabs } from "./tabs-context"

const PAGE_ICON: Record<string, LucideIcon> = {
  "/": Home,
  "/projects": FolderKanban,
  "/projects/new": Plus,
  "/notes": FileText,
  "/calendar": Calendar,
  "/referenxe": PenTool,
  "/settings": Settings,
}

/** Which ends of a row that scrolls sideways still have tabs hidden past them. */
function useOverflowEnds(count: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [ends, setEnds] = useState({ start: false, end: false })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const next = { start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }
      setEnds((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
    }
    read()
    el.addEventListener("scroll", read, { passive: true })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => {
      el.removeEventListener("scroll", read)
      ro.disconnect()
    }
  }, [count])
  return { ref, ends }
}

function TabLead({ tab }: { tab: Tab }) {
  const { projectOf } = useTabs()
  if (projectIdOf(tab.path)) {
    const status = projectOf(tab)?.status
    return <span aria-hidden className={cn("size-2 shrink-0 rounded-full", status && STATUS_TONE[status] ? STATUS_TONE[status].dot : "bg-muted-foreground/40")} />
  }
  const Icon = spaceIdOf(tab.path) ? FolderKanban : (PAGE_ICON[tab.path] ?? FileText)
  return <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
}

function TabButton({ tab, active }: { tab: Tab; active: boolean }) {
  const { title, select, close } = useTabs()
  const ref = useRef<HTMLDivElement>(null)
  const name = title(tab)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [active])
  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={name}
      onClick={() => select(tab.id)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          close(tab.id)
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          select(tab.id)
        }
      }}
      className={cn(
        "group/tab relative flex h-7 w-40 shrink-0 cursor-default items-center gap-2 rounded-lg pr-1 pl-2.5 text-[13px] select-none",
        active ? "text-foreground" : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
      )}
    >
      {active && <motion.span layoutId="tab-active" transition={MOVE} aria-hidden className="absolute inset-0 rounded-lg bg-foreground/[0.09] dark:bg-foreground/[0.13]" />}
      <span className="relative flex min-w-0 flex-1 items-center gap-2">
        <TabLead tab={tab} />
        <span className="truncate">{name}</span>
      </span>
      <button
        type="button"
        aria-label={`Close ${name}`}
        onClick={(e) => {
          e.stopPropagation()
          close(tab.id)
        }}
        className={cn(
          "relative flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-foreground/10 hover:text-foreground",
          active ? "opacity-70" : "opacity-0 group-hover/tab:opacity-100",
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

/**
 * The open pages, in the row along the top of the page card. It floats over the page (it takes no room of its own;
 * each page header leaves space for it) and stays put while the page scrolls.
 */
export function TabStrip() {
  const { tabs, activeId, openNew, back, forward, canBack, canForward } = useTabs()
  const { ref: rowRef, ends } = useOverflowEnds(tabs.length)
  const fade = `linear-gradient(to right, ${ends.start ? "transparent, black 24px" : "black"}, ${ends.end ? "black calc(100% - 24px), transparent" : "black"})`
  return (
    <div className="sticky top-0 z-40 h-0 shrink-0">
      <div
        data-tauri-drag-region
        role="tablist"
        aria-label="Open pages"
        className={cn(
          "tab-strip absolute inset-x-0 top-0 flex h-8 items-center gap-1 rounded-t-2xl pr-3 pl-3")}
      >
        <SidebarTrigger className="mac-hide -ml-1 size-7" />
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label="Back"
            disabled={!canBack}
            onClick={back}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground enabled:hover:bg-foreground/[0.06] enabled:hover:text-foreground disabled:opacity-30"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Forward"
            disabled={!canForward}
            onClick={forward}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground enabled:hover:bg-foreground/[0.06] enabled:hover:text-foreground disabled:opacity-30"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <div
          ref={rowRef}
          style={{ maskImage: fade, WebkitMaskImage: fade }}
          className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((t) => (
            <TabButton key={t.id} tab={t} active={t.id === activeId} />
          ))}
        </div>
        <button
          type="button"
          aria-label="New tab"
          title="New tab"
          onClick={() => openNew("/")}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
      </div>
    </div>
  )
}
