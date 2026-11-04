import { ChevronLeft, ChevronRight } from "lucide-react"
import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import type { ProjectRecord } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { STATUS_TONE } from "../projects/constants"
import { addMonths, monthGrid, parseIso } from "./date-utils"

const MAX_UPCOMING = 6
const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"]

function daysFrom(today: string, iso: string): number {
  return Math.round((parseIso(iso).getTime() - parseIso(today).getTime()) / 86_400_000)
}

function when(n: number): string {
  if (n < 0) return n === -1 ? "Yesterday" : `${-n} days ago`
  if (n === 0) return "Today"
  if (n === 1) return "Tomorrow"
  return `In ${n} days`
}

/** The left side of the calendar: the next deadlines, and a small month that follows the big one. */
export function CalendarPanel({
  projects,
  month,
  today,
  markers,
  onMonth,
  onDay,
}: {
  projects: ProjectRecord[]
  month: Date
  today: string
  /** Days of the shown month that have something on them: the status of the first deadline, or null for only events. */
  markers: Map<string, ProjectRecord["status"] | null>
  onMonth: (to: Date) => void
  onDay: (iso: string) => void
}) {
  // Finished and archived projects are not "upcoming". Overdue ones stay, at the top, because they still need attention.
  const upcoming = useMemo(
    () =>
      projects
        .filter((p) => p.deadline && p.status !== "archived" && p.status !== "completed")
        .sort((a, b) => a.deadline!.localeCompare(b.deadline!) || a.name.localeCompare(b.name))
        .slice(0, MAX_UPCOMING),
    [projects],
  )
  const cells = useMemo(() => monthGrid(month), [month])
  const label = month.toLocaleDateString(undefined, { month: "long", year: "numeric" })

  return (
    <aside aria-label="Upcoming deadlines and month" className="hidden w-60 shrink-0 flex-col gap-5 min-[1100px]:flex">
      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <h2 className="px-1 text-sm font-medium">Upcoming deadlines</h2>
        {upcoming.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">No deadlines coming up. Enjoy it.</p>
        ) : (
          <ul className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
            {upcoming.map((p) => {
              const n = daysFrom(today, p.deadline!)
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onDay(p.deadline!)}
                    className="flex w-full flex-col gap-0.5 rounded-xl border bg-card px-3 py-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <span className="flex items-center gap-2">
                      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_TONE[p.status].dot)} />
                      <span className="min-w-0 truncate text-sm font-medium">{p.name}</span>
                    </span>
                    <span className={cn("pl-4 text-xs text-muted-foreground", n < 0 && "font-medium text-destructive")}>
                      {parseIso(p.deadline!).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {when(n)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-label="Month" className="flex shrink-0 flex-col gap-1 rounded-2xl border bg-card p-3">
        <div className="flex items-center justify-between">
          <span className="pl-1 text-sm font-medium">{label}</span>
          <span className="flex">
            <Button size="icon-xs" variant="ghost" aria-label="Previous month" onClick={() => onMonth(addMonths(month, -1))}>
              <ChevronLeft />
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="Next month" onClick={() => onMonth(addMonths(month, 1))}>
              <ChevronRight />
            </Button>
          </span>
        </div>
        <div className="grid grid-cols-7 text-center text-[11px] text-muted-foreground">
          {DAY_LETTERS.map((d, i) => (
            <span key={i} className="py-1">
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5">
          {cells.map((c, i) => {
            const mark = markers.get(c.iso)
            const has = markers.has(c.iso)
            return (
              <button
                key={i}
                type="button"
                onClick={() => onDay(c.iso)}
                aria-label={c.iso}
                className={cn(
                  "relative mx-auto flex size-7 items-center justify-center rounded-full text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
                  !c.inMonth && "text-muted-foreground/50",
                  c.iso === today && "bg-primary font-medium text-primary-foreground hover:bg-primary",
                )}
              >
                {c.day}
                {has && c.inMonth && (
                  <span
                    aria-hidden
                    className={cn("absolute bottom-0.5 size-1 rounded-full", c.iso === today ? "bg-primary-foreground" : mark ? STATUS_TONE[mark].dot : "bg-muted-foreground")}
                  />
                )}
              </button>
            )
          })}
        </div>
      </section>
    </aside>
  )
}
