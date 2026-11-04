import { Archive, CircleCheck, CircleDashed, Eye, Loader, ShieldCheck, type LucideIcon } from "lucide-react"
import type { ProjectPriority, ProjectStatus } from "@/lib/tauri"

export const STATUS_OPTIONS: { value: ProjectStatus; label: string }[] = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "in_review", label: "In review" },
  { value: "quality_check", label: "Quality check" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
]

export const PRIORITY_OPTIONS: { value: ProjectPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
]

/** Colours that mark a project's status: a tinted chip, a matching dot, and the soft fade behind the project page. */
export const STATUS_TONE: Record<ProjectStatus, { chip: string; dot: string; glow: string }> = {
  not_started: { chip: "bg-slate-500/15 text-foreground", dot: "bg-slate-400", glow: "from-slate-500/20 via-slate-500/[0.07] dark:from-slate-500/35 dark:via-slate-600/15" },
  in_progress: { chip: "bg-blue-500/15 text-foreground", dot: "bg-blue-500", glow: "from-blue-500/20 via-blue-500/[0.07] dark:from-blue-700/45 dark:via-blue-900/20" },
  in_review: { chip: "bg-amber-500/15 text-foreground", dot: "bg-amber-500", glow: "from-amber-500/25 via-amber-500/[0.08] dark:from-amber-700/40 dark:via-amber-900/15" },
  quality_check: { chip: "bg-violet-500/15 text-foreground", dot: "bg-violet-500", glow: "from-violet-500/20 via-violet-500/[0.07] dark:from-violet-700/45 dark:via-violet-900/20" },
  completed: { chip: "bg-green-500/15 text-foreground", dot: "bg-green-500", glow: "from-green-500/20 via-green-500/[0.07] dark:from-green-700/40 dark:via-green-900/15" },
  archived: { chip: "bg-muted text-muted-foreground", dot: "bg-muted-foreground", glow: "from-neutral-500/15 via-neutral-500/[0.05] dark:from-neutral-500/25 dark:via-neutral-600/10" },
}

/** One icon per status, with the colour it is drawn in. */
export const STATUS_ICON: Record<ProjectStatus, { icon: LucideIcon; color: string }> = {
  not_started: { icon: CircleDashed, color: "text-slate-400" },
  in_progress: { icon: Loader, color: "text-blue-500" },
  in_review: { icon: Eye, color: "text-amber-500" },
  quality_check: { icon: ShieldCheck, color: "text-violet-500" },
  completed: { icon: CircleCheck, color: "text-green-500" },
  archived: { icon: Archive, color: "text-muted-foreground" },
}
