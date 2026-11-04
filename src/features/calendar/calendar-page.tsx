import { ChevronLeft, ChevronRight, Plus } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, errorMessage, type CalendarEvent, type EventInput, type ProjectRecord } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { CalendarPanel } from "./calendar-panel"
import { DaySheet } from "./day-sheet"
import { useProjectsChanged } from "@/features/sync/sync-context"
import { addMonths, monthGrid, parseIso, startOfMonth, toIso, WEEKDAYS } from "./date-utils"
import { EventDialog } from "./event-dialog"
import { STATUS_TONE } from "../projects/constants"
import { statusLabel } from "../projects/project-utils"

const MAX_CHIPS = 3
/** Priority at the end of a deadline: one mark for low, two for medium, three for high. */
const PRIORITY_MARK = { low: "!", medium: "!!", high: "!!!" } as const

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready" }

export function CalendarPage() {
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  // Which way the last change went, so the new month slides in from that side.
  const [slide, setSlide] = useState<1 | -1>(1)
  function goTo(to: Date) {
    setSlide(to.getTime() >= month.getTime() ? 1 : -1)
    setMonth(to)
  }
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [day, setDay] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ open: boolean; event: CalendarEvent | null }>({ open: false, event: null })
  const [toDelete, setToDelete] = useState<CalendarEvent | null>(null)
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null)

  // The month slides in by animating the same element, not by replacing it: a trackpad swipe stays attached to the
  // element it started on, so replacing the grid under the cursor made the next swipe do nothing until the mouse moved.
  const gridRef = useRef<HTMLDivElement>(null)
  const shownMonth = useRef(month.getTime())
  useEffect(() => {
    if (shownMonth.current === month.getTime()) return
    shownMonth.current = month.getTime()
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    gridRef.current?.animate(
      [{ transform: `translateX(${slide * 40}px)`, opacity: 0 }, { transform: "translateX(0)", opacity: 1 }],
      { duration: 300, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    )
  }, [month, slide])

  const cells = useMemo(() => monthGrid(month), [month])
  const first = cells[0].iso
  const last = cells[cells.length - 1].iso
  const today = toIso(new Date())

  const refresh = useCallback(async () => {
    try {
      const [p, e] = await Promise.all([api.listProjects(), api.listEvents(first, last)])
      setProjects(p)
      setEvents(e)
      setLoad({ status: "ready" })
    } catch (err) {
      setLoad({ status: "error", message: errorMessage(err) })
    }
  }, [first, last])

  useEffect(() => {
    void refresh()
  }, [refresh])
  useProjectsChanged(() => void refresh())

  // Archived projects are hidden from the calendar, like from the default project list.
  const deadlinesByDay = useMemo(() => {
    const map = new Map<string, ProjectRecord[]>()
    for (const p of projects) {
      if (!p.deadline || p.status === "archived") continue
      map.set(p.deadline, [...(map.get(p.deadline) ?? []), p])
    }
    return map
  }, [projects])

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const e of events) map.set(e.date, [...(map.get(e.date) ?? []), e])
    return map
  }, [events])

  // What the small month shows under each day: the status colour of the first deadline, or a plain dot for events.
  const markers = useMemo(() => {
    const map = new Map<string, ProjectRecord["status"] | null>()
    for (const [iso, list] of deadlinesByDay) map.set(iso, list[0].status)
    for (const iso of eventsByDay.keys()) if (!map.has(iso)) map.set(iso, null)
    return map
  }, [deadlinesByDay, eventsByDay])

  // Used by the side panel: go to the day's month, then open the day.
  function openDay(iso: string) {
    const d = parseIso(iso)
    const m = startOfMonth(d)
    if (m.getTime() !== month.getTime()) goTo(m)
    setDay(iso)
  }

  async function submitEvent(input: EventInput): Promise<string | null> {
    try {
      if (dialog.event) await api.updateEvent(dialog.event.id, input)
      else await api.addEvent(input)
      toast.success(dialog.event ? "Event saved" : "Event added")
      await refresh()
      return null
    } catch (e) {
      return errorMessage(e)
    }
  }

  async function confirmDelete() {
    const target = toDelete
    setToDelete(null)
    if (!target) return
    try {
      await api.deleteEvent(target.id)
      toast.success("Event deleted. One less thing on the calendar.")
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
      await refresh()
    }
  }

  async function changeDeadline(p: ProjectRecord, deadline: string | null) {
    setBusyProjectId(p.id)
    try {
      await api.setProjectDeadline(p.id, deadline)
      toast.success(deadline ? `${p.name}: deadline moved` : `${p.name}: deadline removed`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusyProjectId(null)
      await refresh()
    }
  }

  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" })

  return (
    <div className="fit-page flex flex-col overflow-x-clip">
      <PageHeader
        title="Calendar"
        start={
          <>
            <Button size="icon-sm" variant="outline" aria-label="Previous month" onClick={() => goTo(addMonths(month, -1))}>
              <ChevronLeft />
            </Button>
            <Button size="icon-sm" variant="outline" aria-label="Next month" onClick={() => goTo(addMonths(month, 1))}>
              <ChevronRight />
            </Button>
            <Button size="sm" variant="outline" onClick={() => goTo(startOfMonth(new Date()))}>
              Today
            </Button>
            <h2 className="ml-2 truncate text-lg font-medium" aria-live="polite">
              {monthLabel}
            </h2>
          </>
        }
        end={
          <Button size="sm" onClick={() => setDialog({ open: true, event: null })}>
            <Plus data-icon="inline-start" /> Add event
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 gap-4 overflow-x-clip px-6 pb-6 pt-1">
      <CalendarPanel projects={projects} month={month} today={today} markers={markers} onMonth={goTo} onDay={openDay} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-x-clip">
        {load.status === "error" && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-destructive">
              {load.message}
            </p>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        )}

        {load.status === "loading" && <Skeleton className="min-h-96 flex-1" />}

        {load.status === "ready" && (
          <div ref={gridRef} role="grid" aria-label={monthLabel} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border">
            <div role="row" className="grid grid-cols-7 border-b bg-muted/40 text-xs text-muted-foreground">
              {WEEKDAYS.map((w) => (
                <div key={w} role="columnheader" className="px-2 py-1.5 font-medium">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] grid-cols-7">
              {cells.map((c, i) => {
                const dl = deadlinesByDay.get(c.iso) ?? []
                const ev = eventsByDay.get(c.iso) ?? []
                const chips = [
                  ...dl.map((p) => ({ key: `p-${p.id}`, label: p.name, kind: "deadline" as const, done: p.status === "completed", priority: p.priority, status: p.status })),
                  ...ev.map((e) => ({ key: `e-${e.id}`, label: e.title, kind: "event" as const, done: false, priority: null, status: null })),
                ]
                const extra = chips.length - MAX_CHIPS
                return (
                  <button
                    key={i} // by position, so the cells under the cursor stay the same elements when the month changes
                    type="button"
                    role="gridcell"
                    aria-label={`${c.iso}${dl.length ? `, ${dl.length} deadline${dl.length > 1 ? "s" : ""}` : ""}${ev.length ? `, ${ev.length} event${ev.length > 1 ? "s" : ""}` : ""}`}
                    onClick={() => setDay(c.iso)}
                    className={cn(
                      "flex min-h-0 flex-col items-stretch gap-1 overflow-hidden border-r border-b p-1.5 text-left transition hover:bg-muted/50 focus-visible:outline-none nth-[7n]:border-r-0",
                      !c.inMonth && "bg-muted/20 text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-6 items-center justify-center rounded-full text-xs",
                        c.iso === today && "bg-primary font-medium text-primary-foreground",
                      )}
                    >
                      {c.day}
                    </span>
                    {chips.slice(0, MAX_CHIPS).map((chip) => (
                      <span
                        key={chip.key}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs",
                          chip.status ? STATUS_TONE[chip.status].chip : "bg-muted text-foreground",
                          chip.done && "line-through opacity-60",
                        )}
                        title={chip.status ? `Deadline: ${chip.label} (${statusLabel(chip.status)}, ${chip.priority} priority)` : chip.label}
                      >
                        {chip.status && <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_TONE[chip.status].dot)} />}
                        <span className="min-w-0 flex-1 truncate">{chip.label}</span>
                        {chip.priority && (
                          <span aria-hidden className="shrink-0 font-semibold tracking-tighter opacity-60">
                            {PRIORITY_MARK[chip.priority]}
                          </span>
                        )}
                      </span>
                    ))}
                    {extra > 0 && <span className="px-1.5 text-xs text-muted-foreground">+{extra} more</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
      </div>

      <DaySheet
        day={day}
        deadlines={day ? (deadlinesByDay.get(day) ?? []) : []}
        events={day ? (eventsByDay.get(day) ?? []) : []}
        busyProjectId={busyProjectId}
        onClose={() => setDay(null)}
        onAddEvent={() => setDialog({ open: true, event: null })}
        onEditEvent={(e) => setDialog({ open: true, event: e })}
        onDeleteEvent={setToDelete}
        onChangeDeadline={(p, d) => void changeDeadline(p, d)}
      />

      <EventDialog
        open={dialog.open}
        event={dialog.event}
        defaultDate={day ?? today}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        onSubmit={submitEvent}
      />

      <AlertDialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this event?</AlertDialogTitle>
            <AlertDialogDescription>"{toDelete?.title}" will be removed from your calendar. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Delete event</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
