import { Link } from "react-router"
import { Archive, ArchiveRestore, CalendarDays, Clapperboard, FolderSearch, MoreHorizontal, Pencil, TriangleAlert, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useDraggableProject } from "@/features/spaces/project-dnd"
import type { ProjectRecord } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { openProjectInAfterEffects } from "./open-in-ae"
import { ProjectCover } from "./project-cover"
import { formatDeadline, isOverdue, priorityLabel, statusLabel, timeAgo } from "./project-utils"

interface Props {
  project: ProjectRecord
  onEdit: (p: ProjectRecord) => void
  onArchive: (p: ProjectRecord) => void
  onUnarchive: (p: ProjectRecord) => void
  onRemove: (p: ProjectRecord) => void
  onReveal: (p: ProjectRecord) => void
  onLocate: (p: ProjectRecord) => void
  /** Shown in the footer of the all-projects list. */
  spaceName?: string
}

const STATUS_DOT: Record<ProjectRecord["status"], string> = {
  not_started: "bg-muted-foreground/50",
  in_progress: "bg-blue-500",
  in_review: "bg-amber-500",
  quality_check: "bg-violet-500",
  completed: "bg-emerald-500",
  archived: "bg-muted-foreground/30",
}

export function ProjectCard({ project: p, onEdit, onArchive, onUnarchive, onRemove, onReveal, onLocate, spaceName }: Props) {
  const overdue = isOverdue(p)
  const drag = useDraggableProject(p)
  return (
    <div
      ref={drag.setNodeRef}
      // Drag the card onto a Space in the sidebar to move the project there.
      {...drag.listeners}
      className={cn(
        "group/card relative flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground",
        drag.isDragging && "opacity-40",
        !p.available && "opacity-75",
      )}
    >
      <ProjectCover projectId={p.id} name={p.name} available={p.available} className="aspect-[16/10] rounded-none">
        {/* The menu floats over the picture's corner and appears on hover or keyboard focus. */}
        <div className="absolute top-2 right-2 z-10 opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="bg-background/85 backdrop-blur-sm hover:bg-background"
                  aria-label={`Actions for ${p.name}`}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!p.available && <DropdownMenuItem onClick={() => onLocate(p)}>Locate folder…</DropdownMenuItem>}
              <DropdownMenuItem onClick={() => void openProjectInAfterEffects(p.id)} disabled={!p.available}>
                <Clapperboard /> Open in After Effects
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onEdit(p)} disabled={!p.available}>
                <Pencil /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onReveal(p)} disabled={!p.available}>
                <FolderSearch /> Show in Finder
              </DropdownMenuItem>
              {p.status === "archived" ? (
                <DropdownMenuItem onClick={() => onUnarchive(p)} disabled={!p.available}>
                  <ArchiveRestore /> Unarchive (back to Completed)
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => onArchive(p)} disabled={!p.available}>
                  <Archive /> Archive
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => onRemove(p)}>
                <Trash2 /> Remove from Murre
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ProjectCover>

      <div className="flex min-w-0 flex-col gap-1 p-3">
        <h3 className="truncate text-sm font-semibold">
          {/* Stretched link: the whole card opens the project; the actions menu sits above it. */}
          <Link to={`/projects/${p.id}`} className="outline-none after:absolute after:inset-0">
            {p.name}
          </Link>
        </h3>
        <p className="truncate text-xs text-muted-foreground">
          {[p.client || "No client", spaceName].filter(Boolean).join(" · ")}
        </p>
        {/* Hovering (or focusing) the card unfolds the description. */}
        {p.description && (
          <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 group-focus-within/card:grid-rows-[1fr] group-hover/card:grid-rows-[1fr]">
            <p className="overflow-hidden text-xs text-muted-foreground">
              <span className="line-clamp-3 block pt-1">{p.description}</span>
            </p>
          </div>
        )}
        {!p.available && (
          <p className="flex items-center gap-1.5 pt-1 text-xs text-destructive" role="status">
            <TriangleAlert className="size-3.5 shrink-0" />
            Folder not found. Reconnect the drive, or use Locate folder if it was moved.
          </p>
        )}
        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[p.status])} />
            <span className="truncate">{statusLabel(p.status)}</span>
          </span>
          {p.priority === "high" && <Badge>{priorityLabel(p.priority)}</Badge>}
          <span className={cn("ml-auto flex shrink-0 items-center gap-1", overdue && "font-medium text-destructive")}>
            {p.deadline && <CalendarDays className="size-3.5" />}
            {p.deadline ? `${overdue ? "Overdue · " : ""}${formatDeadline(p.deadline)}` : timeAgo(p.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  )
}
