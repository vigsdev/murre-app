import type { ProjectPriority, ProjectRecord, ProjectStatus } from "@/lib/tauri"
import { PRIORITY_OPTIONS, STATUS_OPTIONS } from "./constants"

export type SortKey = "updated" | "deadline" | "name" | "priority"
export type StatusFilter = "not_archived" | "all" | ProjectStatus
export type PriorityFilter = "all" | ProjectPriority

export interface ListQuery {
  search: string
  sort: SortKey
  status: StatusFilter
  priority: PriorityFilter
}

export const DEFAULT_QUERY: ListQuery = { search: "", sort: "updated", status: "not_archived", priority: "all" }

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "updated", label: "Recently updated" },
  { value: "deadline", label: "Deadline (soonest)" },
  { value: "name", label: "Name (A–Z)" },
  { value: "priority", label: "Priority (highest)" },
]

export const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "not_archived", label: "All except archived" },
  { value: "all", label: "All statuses" },
  ...STATUS_OPTIONS,
]

export const PRIORITY_FILTER_OPTIONS: { value: PriorityFilter; label: string }[] = [
  { value: "all", label: "All priorities" },
  ...PRIORITY_OPTIONS,
]

const PRIORITY_RANK: Record<ProjectPriority, number> = { high: 0, medium: 1, low: 2 }

export function isDefaultQuery(q: ListQuery) {
  return (
    q.search.trim() === "" &&
    q.status === DEFAULT_QUERY.status &&
    q.priority === DEFAULT_QUERY.priority
  )
}

export function applyQuery(projects: ProjectRecord[], q: ListQuery): ProjectRecord[] {
  const needle = q.search.trim().toLowerCase()
  const filtered = projects.filter((p) => {
    if (q.status === "not_archived" ? p.status === "archived" : q.status !== "all" && p.status !== q.status) {
      return false
    }
    if (q.priority !== "all" && p.priority !== q.priority) return false
    if (!needle) return true
    return [p.name, p.client ?? "", p.description ?? ""].some((f) => f.toLowerCase().includes(needle))
  })

  const byName = (a: ProjectRecord, b: ProjectRecord) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  return filtered.sort((a, b) => {
    switch (q.sort) {
      case "name":
        return byName(a, b)
      case "priority":
        return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byName(a, b)
      case "deadline":
        // Projects without a deadline go last.
        if (a.deadline === b.deadline) return byName(a, b)
        if (!a.deadline) return 1
        if (!b.deadline) return -1
        return a.deadline.localeCompare(b.deadline)
      default:
        return b.updatedAt - a.updatedAt || byName(a, b)
    }
  })
}

/** Today as `YYYY-MM-DD` in local time. */
export function todayIso(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function isOverdue(p: Pick<ProjectRecord, "deadline" | "status">, today = todayIso()): boolean {
  return !!p.deadline && p.deadline < today && p.status !== "completed" && p.status !== "archived"
}

export function formatDeadline(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { dateStyle: "medium" })
}

export function statusLabel(s: ProjectStatus) {
  return STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s
}

export function priorityLabel(p: ProjectPriority) {
  return PRIORITY_OPTIONS.find((o) => o.value === p)?.label ?? p
}

/** Same name, same colours: a stable two-stop gradient used when a project has no render to show. */
export function projectGradient(name: string): string {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619)
  const hue = (h >>> 0) % 360
  const hue2 = (hue + 40 + ((h >>> 9) % 50)) % 360
  return `linear-gradient(135deg, oklch(0.78 0.14 ${hue}), oklch(0.62 0.17 ${hue2}))`
}

/** "today", "yesterday", "5 days ago", "3 weeks ago"… for a Unix-seconds timestamp. */
export function timeAgo(unixSecs: number, now = Date.now()): string {
  const days = Math.floor((now - unixSecs * 1000) / 86_400_000)
  if (days <= 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) return `${days} days ago`
  if (days < 30) return `${Math.floor(days / 7)} week${days >= 14 ? "s" : ""} ago`
  if (days < 365) return `${Math.floor(days / 30)} month${days >= 60 ? "s" : ""} ago`
  return `${Math.floor(days / 365)} year${days >= 730 ? "s" : ""} ago`
}
