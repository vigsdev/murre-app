import { ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { NavLink, useLocation, useNavigate } from "react-router"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { useProjectsChanged } from "@/features/sync/sync-context"
import { api, errorMessage, type ProjectRecord, type Space } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { useDraggableProject, useSpaceRow } from "./project-dnd"
import { SpaceDialog } from "./space-dialog"
import { SpaceIcon } from "./space-icons"
import { useSpaces } from "./spaces-context"

const OPEN_KEY = "murre.sidebar.openSpaces"
/** Projects listed under a Space before "N more" (the Space's page shows all of them). */
const MAX_SHOWN = 8

function readOpen(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(OPEN_KEY) ?? "[]")
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/** Active (not archived) projects, for the lists under each Space. */
function useSidebarProjects() {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const load = useCallback(() => {
    api
      .listProjects()
      .then((list) => setProjects(list.filter((p) => p.status !== "archived")))
      .catch(() => {}) // the sidebar still works without the project lists
  }, [])
  useEffect(load, [load])
  useProjectsChanged(load)
  return projects
}

/** A Space's row: a project can be dropped on it, and the row can be dragged to reorder the Spaces. */
function SpaceItem({ space, children }: { space: Space; children: React.ReactNode }) {
  const row = useSpaceRow(space)
  return (
    <SidebarMenuItem ref={row.setNodeRef} {...row.listeners} className={row.className}>
      {children}
    </SidebarMenuItem>
  )
}

/** A project listed under its Space. It can be dragged onto another Space to move it. */
function SpaceProjectRow({ project: p, active }: { project: ProjectRecord; active: boolean }) {
  const drag = useDraggableProject(p, "sidebar")
  return (
    <SidebarMenuSubItem ref={drag.setNodeRef} {...drag.listeners} className={cn(drag.isDragging && "opacity-40")}>
      <SidebarMenuSubButton isActive={active} render={<NavLink to={`/projects/${p.id}`} title={p.name} draggable={false} />} className={cn(!p.available && "opacity-60")}>
        <span>{p.name}</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}

export function SpacesNav() {
  const { spaces, loaded, error, reload } = useSpaces()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<{ open: boolean; space: Space | null }>({ open: false, space: null })
  const [toDelete, setToDelete] = useState<Space | null>(null)
  const projects = useSidebarProjects()
  const [open, setOpen] = useState<string[]>(readOpen)

  const toggle = useCallback((id: string) => {
    setOpen((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      try {
        window.localStorage.setItem(OPEN_KEY, JSON.stringify(next))
      } catch {
        // remembering which Spaces are open is only a convenience
      }
      return next
    })
  }, [])

  // Opening a project (from anywhere) reveals it in its Space.
  const openProjectId = pathname.startsWith("/projects/") ? pathname.split("/")[2] : null
  const openProjectSpace = projects.find((p) => p.id === openProjectId)?.spaceId ?? null
  useEffect(() => {
    if (openProjectSpace) setOpen((cur) => (cur.includes(openProjectSpace) ? cur : [...cur, openProjectSpace]))
  }, [openProjectSpace])

  async function submit(name: string, icon: string): Promise<string | null> {
    try {
      if (dialog.space) await api.updateSpace(dialog.space.id, name, icon)
      else {
        const created = await api.createSpace(name, icon)
        navigate(`/spaces/${created.id}`)
      }
      await reload()
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
      await api.deleteSpace(target.id)
      toast.success(`Removed the Space “${target.name}”`, { description: "Its projects were kept." })
      if (pathname === `/spaces/${target.id}`) navigate("/projects")
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      await reload()
    }
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Spaces</SidebarGroupLabel>
      <SidebarGroupAction title="New Space" aria-label="New Space" onClick={() => setDialog({ open: true, space: null })}>
        <Plus />
      </SidebarGroupAction>
      <SidebarGroupContent>
        <SidebarMenu>
          {loaded && error && (
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => void reload()} tooltip="Could not load Spaces. Click to retry.">
                <span className="text-destructive">Couldn't load Spaces. Retry</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {loaded && !error && spaces.length === 0 && (
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Create a Space" onClick={() => setDialog({ open: true, space: null })} className="text-muted-foreground">
                <Plus />
                <span>Create a Space</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {spaces.map((s) => {
            const inSpace = projects.filter((p) => p.spaceId === s.id)
            const expanded = open.includes(s.id)
            return (
              <SpaceItem key={s.id} space={s}>
                <SidebarMenuButton
                  tooltip={s.name}
                  isActive={pathname === `/spaces/${s.id}`}
                  render={<NavLink to={`/spaces/${s.id}`} />}
                  className="pr-14"
                >
                  <SpaceIcon icon={s.icon} />
                  <span>{s.name}</span>
                </SidebarMenuButton>
                <SidebarMenuAction
                  aria-label={`${expanded ? "Hide" : "Show"} projects in ${s.name}`}
                  aria-expanded={expanded}
                  onClick={() => toggle(s.id)}
                >
                  <ChevronRight className={cn("transition-transform", expanded && "rotate-90")} />
                </SidebarMenuAction>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<SidebarMenuAction showOnHover className="right-7.5" aria-label={`Options for ${s.name}`} />}>
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="start">
                    <DropdownMenuItem onClick={() => setDialog({ open: true, space: s })}>
                      <Pencil /> Edit
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setToDelete(s)}>
                      <Trash2 /> Remove Space
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {expanded && (
                  <SidebarMenuSub>
                    {inSpace.length === 0 && (
                      <SidebarMenuSubItem>
                        <span className="flex h-7 items-center px-3 text-xs text-muted-foreground">No projects yet. A beautifully clean slate.</span>
                      </SidebarMenuSubItem>
                    )}
                    {inSpace.slice(0, MAX_SHOWN).map((p) => (
                      <SpaceProjectRow key={p.id} project={p} active={pathname === `/projects/${p.id}`} />
                    ))}
                    {inSpace.length > MAX_SHOWN && (
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton render={<NavLink to={`/spaces/${s.id}`} />} className="text-muted-foreground">
                          <span>{inSpace.length - MAX_SHOWN} more…</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    )}
                  </SidebarMenuSub>
                )}
              </SpaceItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>

      <SpaceDialog open={dialog.open} space={dialog.space} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))} onSubmit={submit} />

      <AlertDialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the Space “{toDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Only the Space is removed. Its projects stay in Murre and keep all their files; they will just not be in a Space.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Remove Space</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarGroup>
  )
}
