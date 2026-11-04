import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { Archive, CalendarDays, ChevronLeft, ChevronRight, Clapperboard } from "lucide-react"
import { motion } from "motion/react"
import { useState } from "react"
import { Link } from "react-router"
import { Badge } from "@/components/ui/badge"
import { STATUS_ICON, STATUS_TONE } from "@/features/projects/constants"
import { openProjectInAfterEffects } from "@/features/projects/open-in-ae"
import { ProjectCover } from "@/features/projects/project-cover"
import { formatDeadline, isOverdue, priorityLabel } from "@/features/projects/project-utils"
import { MOVE } from "@/lib/motion"
import type { ProjectRecord, ProjectStatus } from "@/lib/tauri"
import { cn } from "@/lib/utils"

export const BOARD_COLUMNS: { status: ProjectStatus; label: string }[] = [
  { status: "not_started", label: "Not started" },
  { status: "in_progress", label: "In progress" },
  { status: "in_review", label: "In review" },
  { status: "quality_check", label: "Quality check" },
  { status: "completed", label: "Completed" },
]

const byDeadline = (a: ProjectRecord, b: ProjectRecord) =>
  (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || a.name.localeCompare(b.name)

/** A compact card: a small cover on the left, the name and dates beside it. Four of them fit a column's minimum height. */
function Card({ p, overlay }: { p: ProjectRecord; overlay?: boolean }) {
  const overdue = isOverdue(p)
  return (
    <div
      className={cn(
        "group/kcard relative flex items-center gap-3 rounded-xl border bg-card p-2 text-card-foreground",
        overlay && "rotate-1 shadow-md",
      )}
    >
      <ProjectCover projectId={p.id} name={p.name} available={p.available} className="size-14 shrink-0 rounded-lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link
          to={`/projects/${p.id}`}
          draggable={false}
          className="truncate text-sm font-semibold outline-none group-hover/kcard:pr-7 group-focus-within/kcard:pr-7"
        >
          {p.name}
        </Link>
        <p className="truncate text-xs text-muted-foreground">{p.client || "No client"}</p>
        <div className="mt-0.5 flex h-5 items-center gap-2 text-xs whitespace-nowrap">
          <span className={cn("flex items-center gap-1", overdue ? "font-medium text-destructive" : "text-muted-foreground")}>
            {p.deadline && <CalendarDays className="size-3.5" />}
            {p.deadline ? formatDeadline(p.deadline) : "No date"}
          </span>
          {p.priority === "high" && <Badge>{priorityLabel(p.priority)}</Badge>}
        </div>
      </div>
      {p.available && !overlay && (
        <button
          type="button"
          aria-label={`Open ${p.name} in After Effects`}
          title="Open in After Effects"
          // a click here must not start a drag or open the project
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void openProjectInAfterEffects(p.id)}
          className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md bg-background/85 text-foreground opacity-0 backdrop-blur-sm transition-opacity hover:bg-background group-hover/kcard:opacity-100 focus-visible:opacity-100"
        >
          <Clapperboard className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function DraggableCard({ p }: { p: ProjectRecord }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: p.id, disabled: !p.available })
  return (
    <motion.div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      layout="position"
      transition={{ layout: MOVE }}
      title={p.available ? undefined : "Folder not found, so this project can't be moved."}
      className={cn("touch-none", p.available && "cursor-grab active:cursor-grabbing")}
    >
      <div className={cn("transition-opacity", !p.available && "opacity-60", isDragging && "opacity-30")}>
        <Card p={p} />
      </div>
    </motion.div>
  )
}

/** The board fills the page below the cards above it, and a column scrolls when it has more cards than fit. */
function CardList({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">{children}</div>
}

function StatusIcon({ status }: { status: ProjectStatus }) {
  const { icon: Icon, color } = STATUS_ICON[status]
  return <Icon aria-hidden className={cn("size-4 shrink-0", color)} />
}

function Column({ status, label, projects }: { status: ProjectStatus; label: string; projects: ProjectRecord[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      className={cn(
        "flex min-w-64 flex-1 flex-col gap-2 rounded-2xl bg-muted/50 p-2 transition-colors",
        isOver && "bg-muted ring-2 ring-ring/30",
      )}
    >
      {/* The heading takes the status colour, the same one the project page and the calendar use. */}
      <header className={cn("flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium", STATUS_TONE[status].chip)}>
        <StatusIcon status={status} />
        {label}
        <span className="ml-auto rounded-md bg-background/50 px-1.5 text-xs font-normal tabular-nums text-foreground/70">{projects.length}</span>
      </header>
      <CardList>
        {projects.map((p) => (
          <DraggableCard key={p.id} p={p} />
        ))}
        {projects.length === 0 && <p className="m-auto px-2 text-center text-xs text-muted-foreground">Drop a project here. We’ll take it from there.</p>}
      </CardList>
    </section>
  )
}

function ArchivedStrip({ projects }: { projects: ProjectRecord[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: "archived" })
  const [open, setOpen] = useState(false)
  return (
    <section
      ref={setNodeRef}
      aria-label="Archived"
      className={cn(
        "flex shrink-0 flex-col gap-2 rounded-2xl bg-muted/30 p-2 transition-colors",
        open ? "w-64" : "w-12 items-center",
        isOver && "bg-muted ring-2 ring-ring/30",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn("flex items-center gap-2 text-sm font-medium text-muted-foreground", !open && "flex-col py-1")}
      >
        {open ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        <Archive className="size-4" />
        <span className={cn(!open && "[writing-mode:vertical-rl]")}>Archived</span>
        <span className="text-xs font-normal">{projects.length}</span>
      </button>
      {open && (
        <CardList>
          {projects.map((p) => (
            <DraggableCard key={p.id} p={p} />
          ))}
          {projects.length === 0 && <p className="m-auto px-2 text-center text-xs text-muted-foreground">Drop it here to archive. Not delete. Relax.</p>}
        </CardList>
      )}
    </section>
  )
}

export function KanbanBoard({
  projects,
  onMove,
}: {
  projects: ProjectRecord[]
  /** Called when a card is dropped on a different column. */
  onMove: (p: ProjectRecord, to: ProjectStatus) => void
}) {
  const [dragging, setDragging] = useState<ProjectRecord | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), // a plain click still opens the project
    useSensor(KeyboardSensor),
  )

  function onDragStart(e: DragStartEvent) {
    setDragging(projects.find((p) => p.id === e.active.id) ?? null)
  }
  function onDragEnd(e: DragEndEvent) {
    setDragging(null)
    const p = projects.find((x) => x.id === e.active.id)
    const to = e.over?.id as ProjectStatus | undefined
    if (p && to && to !== p.status) onMove(p, to)
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="relative min-h-[26rem] flex-1">
        <div className="absolute inset-0 flex items-stretch gap-3 overflow-x-auto pb-2">
          {BOARD_COLUMNS.map((c) => (
            <Column key={c.status} {...c} projects={projects.filter((p) => p.status === c.status).sort(byDeadline)} />
          ))}
          <ArchivedStrip projects={projects.filter((p) => p.status === "archived").sort(byDeadline)} />
        </div>
      </div>
      <DragOverlay>{dragging && <div className="w-60"><Card p={dragging} overlay /></div>}</DragOverlay>
    </DndContext>
  )
}
