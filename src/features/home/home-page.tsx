import { FolderKanban, Plus } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { listItem } from "@/lib/motion"
import { toast } from "sonner"
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { addDays, toIso } from "@/features/calendar/date-utils"
import { KanbanBoard } from "./kanban-board"
import { TimeTimeline } from "./time-timeline"
import { recordGreetingEvent } from "./greetings/events"
import { useGreeting } from "./greetings/use-greeting"
import { ProjectCover } from "@/features/projects/project-cover"
import { STATUS_TONE } from "@/features/projects/constants"
import { useProfile } from "@/features/profile/profile-context"
import { formatDeadline, isOverdue, statusLabel, todayIso } from "@/features/projects/project-utils"
import { useProjectsChanged } from "@/features/sync/sync-context"
import { api, errorMessage, type CalendarEvent, type ProjectRecord, type ProjectStatus } from "@/lib/tauri"
import { cn } from "@/lib/utils"

const UPCOMING_DAYS = 14
const LIST_LIMIT = 6
const ACTIVE = new Set(["in_progress", "in_review", "quality_check"])

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; projects: ProjectRecord[]; events: CalendarEvent[]; openedIds: string[] }

interface UpcomingItem {
  key: string
  date: string
  label: string
  kind: "deadline" | "event"
  to?: string
  overdue: boolean
}

export function HomePage() {
  const profile = useProfile()
  const [load, setLoad] = useState<Load>({ status: "loading" })

  async function fetchAll() {
    try {
      const today = new Date()
      const [projects, events, openedIds] = await Promise.all([
        api.listProjects(),
        api.listEvents(toIso(today), toIso(addDays(today, UPCOMING_DAYS))),
        // The list of recently opened projects is a nicety: Home still works without it.
        api.recentProjects().catch(() => [] as string[]),
      ])
      setLoad({ status: "ready", projects, events, openedIds })
    } catch (e) {
      setLoad({ status: "error", message: errorMessage(e) })
    }
  }

  useEffect(() => {
    void fetchAll()
  }, [])
  useProjectsChanged(() => void fetchAll())

  const greeting = useGreeting(profile.name, load.status === "ready" ? load.projects : null)

  const data = useMemo(() => {
    if (load.status !== "ready") return null
    const today = todayIso()
    const until = toIso(addDays(new Date(), UPCOMING_DAYS))
    const live = load.projects.filter((p) => p.status !== "archived")
    const active = live
      .filter((p) => ACTIVE.has(p.status))
      .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || a.name.localeCompare(b.name))
    const recent = [...live].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name)).slice(0, LIST_LIMIT)
    const upcoming: UpcomingItem[] = [
      ...live
        .filter((p) => p.deadline && p.status !== "completed" && p.deadline <= until)
        .map((p) => ({
          key: `p-${p.id}`,
          date: p.deadline!,
          label: p.name,
          kind: "deadline" as const,
          to: `/projects/${p.id}`,
          overdue: isOverdue(p, today),
        })),
      ...load.events.map((e) => ({ key: `e-${e.id}`, date: e.date, label: e.title, kind: "event" as const, overdue: false })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label))
    const stats = {
      total: live.length,
      active: active.length,
      overdue: live.filter((p) => isOverdue(p, today)).length,
      dueSoon: live.filter((p) => p.deadline && p.deadline >= today && p.deadline <= until && p.status !== "completed").length,
      completed: live.filter((p) => p.status === "completed").length,
    }
    // The last four projects opened, newest first. A person who has not opened any yet gets the most recently changed ones.
    const byId = new Map(live.map((p) => [p.id, p]))
    const opened = load.openedIds.map((id) => byId.get(id)).filter((p): p is ProjectRecord => !!p)
    const lastOpened = [...opened, ...recent.filter((p) => !opened.includes(p))].slice(0, 4)
    return { active, recent, lastOpened, upcoming, stats, total: load.projects.length }
  }, [load])

  /** Moves a card to another column right away, and puts it back if saving fails. */
  async function moveProject(p: ProjectRecord, to: ProjectStatus) {
    const setStatus = (id: string, status: ProjectStatus) =>
      setLoad((cur) =>
        cur.status === "ready" ? { ...cur, projects: cur.projects.map((x) => (x.id === id ? { ...x, status } : x)) } : cur,
      )
    const input = {
      id: p.id,
      name: p.name,
      client: p.client,
      deadline: p.deadline,
      priority: p.priority,
      description: p.description,
    }
    setStatus(p.id, to)
    try {
      await api.updateProject({ ...input, status: to })
      if (to === "completed" && p.status !== "completed") recordGreetingEvent("completed", p.name)
    } catch (e) {
      setStatus(p.id, p.status)
      toast.error(errorMessage(e))
    }
  }

  return (
    <>
      <PageHeader hero title={greeting ?? " "} titleClassName="text-2xl" />
      <div className="flex w-full min-w-0 flex-1 flex-col gap-6 px-6 pb-6 pt-1">
        <p className="-mt-3 text-sm text-muted-foreground">{new Date().toLocaleDateString(undefined, { dateStyle: "full" })}</p>

        {load.status === "loading" && (
          <div className="grid gap-4 md:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-44" />
            ))}
          </div>
        )}

        {load.status === "error" && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>Your projects are playing hide-and-seek. Try again.</EmptyTitle>
              <EmptyDescription role="alert">{load.message}</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={() => void fetchAll()}>
              Try again
            </Button>
          </Empty>
        )}

        {data && data.total === 0 && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderKanban />
              </EmptyMedia>
              <EmptyTitle>Hey, welcome to Murre.</EmptyTitle>
              <EmptyDescription>
                Create your first project, or import a folder you already work in. Your deadlines, notes and renders will show up here.
              </EmptyDescription>
            </EmptyHeader>
            <div className="flex gap-2">
              <Button render={<Link to="/projects/new" />}>
                <Plus /> New project
              </Button>
              <Button variant="outline" render={<Link to="/projects" />}>
                Bring in a project
              </Button>
            </div>
          </Empty>
        )}

        {data && data.total > 0 && (
          <>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-3">
              {data.lastOpened.map((p) => (
                <Link
                  key={p.id}
                  to={`/projects/${p.id}`}
                  className="flex min-w-0 items-center gap-3 rounded-2xl border p-2.5 transition-colors hover:bg-muted/50"
                >
                  <ProjectCover projectId={p.id} name={p.name} available={p.available} className="size-12 shrink-0 rounded-xl" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{p.name}</span>
                    <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_TONE[p.status].dot)} />
                      <span className="truncate">{p.client || statusLabel(p.status)}</span>
                    </span>
                  </span>
                </Link>
              ))}
              </div>
              <ComingUp items={data.upcoming} />
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Projects" value={data.stats.total} hint={`${data.stats.completed} completed`} />
              <Stat label="Active" value={data.stats.active} hint="In progress, review or QC" />
              <Stat label="Due in 14 days" value={data.stats.dueSoon} hint="Not completed yet" />
              <Stat label="Overdue" value={data.stats.overdue} hint="Past their deadline" tone={data.stats.overdue > 0 ? "bad" : undefined} />
            </div>

            <TimeTimeline />

            <KanbanBoard projects={load.status === "ready" ? load.projects : []} onMove={(p, to) => void moveProject(p, to)} />
          </>
        )}
      </div>
    </>
  )
}

const COMING_UP_SHOWN = 4

function ComingUp({ items }: { items: UpcomingItem[] }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-2xl border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Coming up</h2>
        <Link to="/calendar" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
          {items.length > COMING_UP_SHOWN ? `See all ${items.length}` : "Calendar"}
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing in the next {UPCOMING_DAYS} days. That feels nice, doesn’t it?</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          <AnimatePresence initial={false}>
            {items.slice(0, COMING_UP_SHOWN).map((u) => (
              <motion.li key={u.key} {...listItem} className="flex items-center gap-2 text-sm">
                <span className={cn("w-[5.5rem] shrink-0 whitespace-nowrap text-xs text-muted-foreground", u.overdue && "font-medium text-destructive")}>
                  {u.overdue ? "Overdue" : formatDeadline(u.date)}
                </span>
                <Link to={u.to ?? "/calendar"} className="min-w-0 flex-1 truncate underline-offset-4 hover:underline">
                  {u.to ? "⚑ " : ""}
                  {u.label}
                </Link>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: number; hint: string; tone?: "bad" }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-card p-4 ring-1 ring-foreground/10">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-3xl font-semibold tabular-nums", tone === "bad" && "text-destructive")}>{value}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  )
}
