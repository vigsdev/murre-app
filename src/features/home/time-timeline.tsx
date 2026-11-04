import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useCompanionStatus } from "@/features/companion/use-companion-status"
import { api, type ProjectTime } from "@/lib/tauri"
import { cn } from "@/lib/utils"

type Range = "today" | "week" | "month"

const RANGES: { id: Range; label: string; days: number }[] = [
  { id: "today", label: "Today", days: 1 },
  { id: "week", label: "7 days", days: 7 },
  { id: "month", label: "30 days", days: 30 },
]
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** A day cell is fully shaded at this many hours. */
const FULL_DAY_HOURS = 10
const REFRESH_MS = 30_000

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "42 min", "3 h", "3 h 20 min". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 1)} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** The same project always gets the same colour. */
function colorOf(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `oklch(0.72 0.13 ${(h * 137.5) % 360})`
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

export function TimeTimeline() {
  const [range, setRange] = useState<Range>("today")
  // What is on screen, with the range it was read for. A new range keeps showing the old one until its own numbers
  // arrive, so the cells never get drawn against the wrong days.
  const [data, setData] = useState<{ range: Range; from: number; to: number; rows: ProjectTime[] } | null>(null)
  const rows = data?.rows ?? null
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // When the numbers were last read, so a live row can keep counting between reads.
  const [loadedAt, setLoadedAt] = useState(() => Date.now())
  // Reload soon after a project opens or closes in After Effects, so the card does not wait for the next refresh.
  const { status } = useCompanionStatus()
  const openKey = (status.connections ?? []).map((c) => c.projectId ?? "").sort().join(",")

  const days = RANGES.find((r) => r.id === range)!.days
  // Today runs from midnight; longer ranges end tonight and reach back whole days.
  const to = startOfDay(now) + DAY
  const from = to - days * DAY

  useEffect(() => {
    let live = true
    async function load() {
      const t = Date.now()
      try {
        const out = await api.timePerProject(from, to)
        if (!live) return
        setData({ range, from, to, rows: out })
        setFailed(false)
        setNow(t)
        setLoadedAt(t)
      } catch {
        if (live) setFailed(true)
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    // A change in what is open: read again once the log has caught up.
    const soon = window.setTimeout(() => void load(), 1500)
    return () => {
      live = false
      window.clearInterval(timer)
      window.clearTimeout(soon)
    }
  }, [range, from, to, openKey])

  // While something is open, the clock moves every second so its bar grows smoothly.
  const anyLive = rows?.some((r) => r.live) ?? false
  useEffect(() => {
    if (!anyLive) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [anyLive])

  // A live row counts up from the last read: its last stretch reaches "now" and its total grows with it.
  const shown = useMemo(
    () =>
      rows?.map((r) => {
        if (!r.live || r.spans.length === 0) return r
        const extra = Math.max(0, now - loadedAt)
        const spans = r.spans.map((s, i) => (i === r.spans.length - 1 ? { ...s, end: Math.max(s.end, Math.min(now, data!.to)) } : s))
        return { ...r, spans, totalMs: r.totalMs + extra }
      }) ?? null,
    [rows, data, now, loadedAt],
  )

  const total = useMemo(() => (shown ?? []).reduce((n, r) => n + r.totalMs, 0), [shown])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Time in After Effects</CardTitle>
        <CardDescription>
          How long After Effects was open on each project.
          {rows && rows.length > 0 && <> {formatDuration(total)} in all.</>}
        </CardDescription>
        <CardAction>
          <div className="flex gap-1" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <Button
                key={r.id}
                size="sm"
                variant={range === r.id ? "secondary" : "ghost"}
                aria-pressed={range === r.id}
                onClick={() => setRange(r.id)}
              >
                {r.label}
              </Button>
            ))}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="min-h-[8.5rem]">
        {failed && !rows ? (
          <p className="text-sm text-muted-foreground">Couldn’t read the time log. It’ll try again in a moment.</p>
        ) : rows === null ? null : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing recorded for {(data?.range ?? range) === "today" ? "today" : "this range"}. Time counts while After Effects has one of your projects open.
          </p>
        ) : (
          // Fades in when the range changes, and stays put on the regular refresh.
          <div key={data!.range} className="animate-in fade-in-0 duration-150">
            {data!.range === "today" ? (
              <DayView rows={shown ?? rows} from={data!.from} now={now} />
            ) : (
              <DaysView rows={shown ?? rows} from={data!.from} days={RANGES.find((r) => r.id === data!.range)!.days} now={now} />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Label({ row }: { row: ProjectTime }) {
  return (
    <Link to={`/projects/${row.projectId}`} className="flex min-w-0 items-center gap-2 text-sm underline-offset-4 hover:underline">
      <span
        className={cn("size-2 shrink-0 rounded-full", row.live && "live-ring")}
        style={{ background: colorOf(row.projectId), "--c": colorOf(row.projectId) } as React.CSSProperties}
        title={row.live ? "Open in After Effects now" : undefined}
      />
      <span className="truncate font-medium">{row.name}</span>
    </Link>
  )
}

const ROW = "grid grid-cols-[9rem_minmax(0,1fr)_6rem] items-center gap-3"

/** One bar per stretch of time, laid along the hours of the day. */
function DayView({ rows, from, now }: { rows: ProjectTime[]; from: number; now: number }) {
  // Show the hours that matter, at least eight, instead of a mostly empty 24.
  const starts = rows.flatMap((r) => r.spans.map((s) => s.start))
  const ends = rows.flatMap((r) => r.spans.map((s) => s.end))
  let first = Math.floor((Math.min(...starts) - from) / HOUR)
  let last = Math.ceil((Math.max(...ends) - from) / HOUR)
  if (last - first < 8) {
    const mid = Math.round((first + last) / 2)
    first = mid - 4
    last = mid + 4
  }
  first = Math.max(0, first)
  last = Math.min(24, Math.max(last, first + 1))
  const lo = from + first * HOUR
  const span = (last - first) * HOUR
  const pct = (t: number) => `${((Math.min(Math.max(t, lo), lo + span) - lo) / span) * 100}%`
  const ticks = Array.from({ length: last - first + 1 }, (_, i) => first + i)
  const step = ticks.length > 14 ? 3 : ticks.length > 8 ? 2 : 1
  const nowInside = now >= lo && now <= lo + span

  return (
    <div className="flex flex-col gap-2">
      <div className={ROW}>
        <span />
        <div className="relative h-4 text-xs text-muted-foreground">
          {ticks
            .filter((_, i) => i % step === 0)
            .map((h) => (
              <span key={h} className="absolute -translate-x-1/2 whitespace-nowrap tabular-nums" style={{ left: pct(from + h * HOUR) }}>
                {new Date(from + h * HOUR).toLocaleTimeString(undefined, { hour: "numeric" })}
              </span>
            ))}
        </div>
        <span />
      </div>
      {rows.map((r) => (
        <div key={r.projectId} className={ROW}>
          <Label row={r} />
          <div className="relative h-8 rounded-lg bg-muted/40">
            {ticks.map((h) => (
              <span key={h} className="absolute inset-y-0 w-px bg-border/60" style={{ left: pct(from + h * HOUR) }} />
            ))}
            {r.spans.map((s, i) => {
              const live = r.live && i === r.spans.length - 1
              return (
                <span
                  key={i}
                  title={live ? `${clock(s.start)} until now` : `${clock(s.start)} to ${clock(s.end)}`}
                  className={cn("absolute inset-y-1 min-w-1 overflow-hidden rounded-md", live && "transition-[width] duration-1000 ease-linear")}
                  style={{
                    left: pct(s.start),
                    width: `calc(${pct(s.end)} - ${pct(s.start)})`,
                    background: colorOf(r.projectId),
                  }}
                >
                  {live && <span aria-hidden className="live-shimmer absolute inset-y-0 w-1/3" />}
                </span>
              )
            })}
            {r.live && (
              <span
                aria-hidden
                className="live-ring absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[left] duration-1000 ease-linear"
                style={{ left: pct(r.spans[r.spans.length - 1].end), background: colorOf(r.projectId), "--c": colorOf(r.projectId) } as React.CSSProperties}
              />
            )}
            {nowInside && <span className="absolute inset-y-0 w-px bg-foreground/50 transition-[left] duration-1000 ease-linear" style={{ left: pct(now) }} />}
          </div>
          <span className="whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">{formatDuration(r.totalMs)}</span>
        </div>
      ))}
    </div>
  )
}

/** One cell per day, shaded by how long After Effects was open. */
function DaysView({ rows, from, days, now }: { rows: ProjectTime[]; from: number; days: number; now: number }) {
  const cells = rows.map((r) => {
    const perDay = new Array<number>(days).fill(0)
    for (const s of r.spans) {
      for (let d = Math.max(0, Math.floor((s.start - from) / DAY)); d < days; d++) {
        const a = Math.max(s.start, from + d * DAY)
        const b = Math.min(s.end, from + (d + 1) * DAY)
        if (b <= a) break
        perDay[d] += b - a
      }
    }
    return perDay
  })
  const dayLabel = (d: number) => new Date(from + d * DAY + HOUR).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
  const todayIndex = Math.floor((now - from) / DAY)
  const labelEvery = days > 10 ? 7 : 1

  return (
    <div className="flex flex-col gap-2">
      <div className={ROW}>
        <span />
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }}>
          {Array.from({ length: days }, (_, d) => (
            <span key={d} className="h-4 whitespace-nowrap text-xs text-muted-foreground">
              {(days - 1 - d) % labelEvery === 0 ? new Date(from + d * DAY + HOUR).toLocaleDateString(undefined, days > 10 ? { month: "short", day: "numeric" } : { weekday: "short" }) : ""}
            </span>
          ))}
        </div>
        <span />
      </div>
      {rows.map((r, i) => (
        <div key={r.projectId} className={ROW}>
          <Label row={r} />
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }}>
            {cells[i].map((ms, d) => (
              <span
                key={d}
                title={ms > 0 ? `${dayLabel(d)}: ${formatDuration(ms)}` : dayLabel(d)}
                className={cn("h-8 rounded-md bg-muted/40", d === todayIndex && "ring-1 ring-foreground/30", r.live && d === todayIndex && "live-ring")}
                style={
                  ms > 0
                    ? ({
                        background: colorOf(r.projectId),
                        "--c": colorOf(r.projectId),
                        opacity: 0.25 + 0.75 * Math.min(ms / (FULL_DAY_HOURS * HOUR), 1),
                      } as React.CSSProperties)
                    : undefined
                }
              />
            ))}
          </div>
          <span className="whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">{formatDuration(r.totalMs)}</span>
        </div>
      ))}
    </div>
  )
}
