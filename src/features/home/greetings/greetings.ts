// The rules behind Home's greeting. Plain functions, no AI and no network: look at what is going on, pick the most
// important thing that applies, pick a line for it, and keep that line for the day.
//
// The order of importance, the daily rotation and the repeat rules follow the greeting spec.

import { GREETINGS, type GreetingGroup } from "./greetings-data"

export type GreetingEventKind = "completed" | "packaged" | "scanned"

export interface GreetingEvent {
  kind: GreetingEventKind
  project: string | null
  /** Milliseconds since 1970. */
  at: number
}

export interface GreetingState {
  v: 1
  /** The "welcome to Murre" greeting has been shown. */
  launched: boolean
  /** The "first project" greeting has been shown. */
  firstProjectShown: boolean
  /** What Home shows today. It stays the same all day unless something worth a new greeting happens. */
  today: { date: string; key: string; text: string } | null
  /** The last days' greetings, oldest first, one per day. */
  history: { date: string; key: string; text: string }[]
  /** Things that happened elsewhere in Murre and have not had their greeting yet. */
  events: (GreetingEvent & { seen?: boolean })[]
}

export const EMPTY_STATE: GreetingState = { v: 1, launched: false, firstProjectShown: false, today: null, history: [], events: [] }

/** Reads saved text; anything unreadable starts a fresh state rather than breaking Home. */
export function parseState(raw: string | null): GreetingState {
  if (!raw) return { ...EMPTY_STATE, history: [], events: [] }
  try {
    const v = JSON.parse(raw)
    if (!v || typeof v !== "object" || v.v !== 1) throw new Error("unknown shape")
    const line = (x: unknown) =>
      x && typeof x === "object" && typeof (x as { date?: unknown }).date === "string" && typeof (x as { text?: unknown }).text === "string" && typeof (x as { key?: unknown }).key === "string"
        ? (x as { date: string; key: string; text: string })
        : null
    return {
      v: 1,
      launched: v.launched === true,
      firstProjectShown: v.firstProjectShown === true,
      today: line(v.today),
      history: Array.isArray(v.history) ? v.history.map(line).filter((x: unknown): x is { date: string; key: string; text: string } => !!x).slice(-14) : [],
      events: Array.isArray(v.events)
        ? v.events
            .filter((e: unknown) => !!e && typeof e === "object" && ["completed", "packaged", "scanned"].includes((e as GreetingEvent).kind) && typeof (e as GreetingEvent).at === "number")
            .slice(-10)
        : [],
    }
  } catch {
    return { ...EMPTY_STATE, history: [], events: [] }
  }
}

export interface ProjectFacts {
  name: string
  status: string
  /** `YYYY-MM-DD`, or null. */
  deadline: string | null
}

export interface GreetingInput {
  now: Date
  name: string
  projects: ProjectFacts[]
  companionConnected: boolean
  state: GreetingState
}

export interface GreetingResult {
  text: string
  key: string
  state: GreetingState
  /** The state changed and needs saving. */
  changed: boolean
}

const ACTIVE = new Set(["in_progress", "in_review", "quality_check"])
/// A person who has not opened Murre for this many days gets the "been a while" line.
const AWAY_DAYS = 5
/// How many recent lines are avoided when there is another to choose.
const AVOID_RECENT = 3
const EVENT_LIFETIME_MS = 36 * 3600 * 1000

export function isoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${m}-${day}`
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000)
}

/** Same input, same number. Used instead of randomness so the pick for a day never changes. */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

interface Values {
  name?: string
  project?: string
  count?: number
  days?: number
  deadline?: string
}

const PLACEHOLDER = /\{(name|project|count|days|deadline)\}/g

/** Fills in a line, or returns null when it needs something that is not known. */
export function fill(line: string, v: Values): string | null {
  let missing = false
  const out = line.replace(PLACEHOLDER, (_, key: keyof Values) => {
    const val = v[key]
    if (val === undefined || val === "") {
      missing = true
      return ""
    }
    return String(val)
  })
  return missing ? null : out
}

interface Context {
  key: string
  /** Lower comes first. Contexts with the same whole number share a turn and are rotated by date. */
  priority: number
  groups: GreetingGroup[]
  values: Values
}

function timeGroup(hour: number): GreetingGroup {
  if (hour >= 5 && hour < 12) return "morning"
  if (hour >= 12 && hour < 17) return "afternoon"
  if (hour >= 17 && hour < 21) return "evening"
  return "lateNight"
}

/** Deadline nudges are the stress in the app. They are not repeated day after day. */
const URGENT = new Set(["overdue", "dueTomorrow", "dueSoon"])

function contexts(input: GreetingInput, date: string, firstEver: boolean, gapDays: number | null, fresh: GreetingEvent[]): Context[] {
  const { name, now, state } = input
  const today = dayNumber(date)
  const live = input.projects.filter((p) => p.status !== "archived")
  const open = live.filter((p) => p.status !== "completed")
  const active = live.filter((p) => ACTIVE.has(p.status))
  const withDays = open
    .filter((p) => p.deadline)
    .map((p) => ({ p, left: dayNumber(p.deadline as string) - today }))
    .sort((a, b) => a.left - b.left || a.p.name.localeCompare(b.p.name))
  const out: Context[] = []
  const base: Values = { name: name.trim() || undefined }

  // 1. Something just happened, or something is due today or late.
  for (const e of fresh) {
    if (e.kind === "completed") out.push({ key: "completed", priority: 1.0, groups: ["completed"], values: { ...base, project: e.project ?? undefined } })
    if (e.kind === "packaged") out.push({ key: "packaged", priority: 1.0, groups: ["packaged"], values: { ...base, project: e.project ?? undefined } })
  }
  const dueToday = withDays.find((x) => x.left === 0)
  if (dueToday) out.push({ key: "dueToday", priority: 1.1, groups: ["dueToday"], values: { ...base, project: dueToday.p.name, deadline: dueToday.p.deadline ?? undefined } })
  const late = withDays.find((x) => x.left < 0)
  if (late) out.push({ key: "overdue", priority: 1.2, groups: ["overdue"], values: { ...base, project: late.p.name, deadline: late.p.deadline ?? undefined } })

  // 2. Milestones.
  if (firstEver) out.push({ key: "firstLaunch", priority: 2.0, groups: ["firstLaunch"], values: base })
  if (live.length === 1 && state.launched && !state.firstProjectShown) out.push({ key: "firstProject", priority: 2.1, groups: ["firstProject"], values: { ...base, project: live[0].name } })
  if (live.length > 0 && open.length === 0) out.push({ key: "allCompleted", priority: 2.2, groups: ["allCompleted"], values: base })

  // 3. A deadline coming up.
  const tomorrow = withDays.find((x) => x.left === 1)
  if (tomorrow) out.push({ key: "dueTomorrow", priority: 3.0, groups: ["dueTomorrow"], values: { ...base, project: tomorrow.p.name, deadline: tomorrow.p.deadline ?? undefined, days: 1 } })
  const soon = withDays.find((x) => x.left === 2 || x.left === 3)
  if (soon) out.push({ key: "dueSoon", priority: 3.1, groups: ["dueSoon"], values: { ...base, project: soon.p.name, deadline: soon.p.deadline ?? undefined, days: soon.left } })

  // 4. What the workspace looks like.
  if (gapDays !== null && gapDays >= AWAY_DAYS) out.push({ key: "inactive", priority: 4.0, groups: ["inactive"], values: base })
  if (live.length === 0) out.push({ key: "noProjects", priority: 4.5, groups: ["noProjects"], values: base })
  if (active.length >= 2) out.push({ key: "multiActive", priority: 4.5, groups: ["multiActive"], values: { ...base, count: active.length } })
  if (active.length === 1) out.push({ key: "oneActive", priority: 4.5, groups: ["oneActive"], values: { ...base, project: active[0].name } })
  const nextTwoWeeks = withDays.some((x) => x.left <= 14)
  if (open.length > 0 && !nextTwoWeeks) out.push({ key: "noDeadlines", priority: 4.5, groups: ["noDeadlines"], values: base })

  // 5. After Effects. These come up now and then, not every day.
  for (const e of fresh) {
    if (e.kind === "scanned") out.push({ key: "scanned", priority: 5.0, groups: ["scanned"], values: { ...base, project: e.project ?? undefined } })
  }
  const occasionally = hash(`${date}|${name}|companion`) % 4 === 0
  if (occasionally) {
    out.push(input.companionConnected
      ? { key: "companionOn", priority: 5.5, groups: ["companionOn"], values: base }
      : { key: "companionOff", priority: 5.5, groups: ["companionOff"], values: base })
  }

  // 6. Otherwise the time of day. A new day also lets "back again" lines in, unless it is the very first launch.
  out.push({ key: "time", priority: 6, groups: firstEver ? [timeGroup(now.getHours())] : [timeGroup(now.getHours()), "firstOfDay"], values: base })
  return out
}

/** Picks the greeting for today, or returns what is already saved for today. */
export function chooseGreeting(input: GreetingInput): GreetingResult {
  const { now, state } = input
  const date = isoDate(now)
  const fresh = state.events.filter((e) => !e.seen && now.getTime() - e.at < EVENT_LIFETIME_MS && e.at <= now.getTime() + 60_000)
  const sameDay = state.today?.date === date

  // Already chosen today and nothing new to say.
  if (sameDay && fresh.length === 0 && state.today) return { text: state.today.text, key: state.today.key, state, changed: false }

  const previousDay = sameDay ? null : (state.today?.date ?? null)
  const gapDays = previousDay ? dayNumber(date) - dayNumber(previousDay) : null
  // Only a Murre with nothing in it has a first launch. Someone who already has projects when this first runs is not new.
  const firstEver = !state.launched && input.projects.every((p) => p.status === "archived")
  const all = contexts(input, date, firstEver, gapDays, fresh)

  // History without today's entry, for repeat checks.
  const before = state.history.filter((h) => h.date !== date)
  const lastTwo = before.slice(-2)

  const eligible = all.filter((c) => !(URGENT.has(c.key) && lastTwo.length === 2 && lastTwo.every((h) => h.key === c.key)))
  const best = Math.floor(Math.min(...eligible.map((c) => c.priority)))
  const tier = eligible.filter((c) => Math.floor(c.priority) === best)
  const lowest = Math.min(...tier.map((c) => c.priority))
  const top = tier.filter((c) => c.priority === lowest)
  // Same importance: rotate between them by date, so the choice is stable for the day.
  const ctx = top[hash(`${date}|${input.name}|pick`) % top.length]

  const avoid = new Set(before.slice(-AVOID_RECENT).map((h) => h.text))
  const lines = ctx.groups.flatMap((g) => GREETINGS[g]).map((l) => fill(l, ctx.values)).filter((l): l is string => l !== null)
  const fresher = lines.filter((l) => !avoid.has(l))
  const pool = fresher.length > 0 ? fresher : lines
  const text = pool.length > 0 ? pool[hash(`${date}|${input.name}|${ctx.key}`) % pool.length] : fill("Hey, {name}. Let's make something good.", { name: input.name.trim() || undefined }) ?? "Let's make something good."

  const next: GreetingState = {
    ...state,
    launched: true,
    firstProjectShown: state.firstProjectShown || ctx.key === "firstProject",
    today: { date, key: ctx.key, text },
    history: [...before, { date, key: ctx.key, text }].slice(-14),
    events: state.events.map((e) => (e.seen ? e : { ...e, seen: true })).slice(-10),
  }
  return { text, key: ctx.key, state: next, changed: true }
}
