import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDndContext, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core"
import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import { PROJECTS_CHANGED } from "@/features/sync/sync-context"
import { api, errorMessage, type ProjectRecord, type Space } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { useSpaces } from "./spaces-context"

/**
 * Dragging a project card onto a Space in the sidebar moves the project into it; dragging a Space onto another Space
 * changes their order.
 * This uses pointer events (like the Home board), not the browser's own drag and drop, which the app window can intercept.
 */
const SPACE_PREFIX = "space:"
const SPACE_DRAG_PREFIX = "space-drag:"

export function ProjectDndProvider({ children }: { children: ReactNode }) {
  const { spaces, setSpaces, reload } = useSpaces()
  const [dragging, setDragging] = useState<ProjectRecord | null>(null)
  const [draggingSpace, setDraggingSpace] = useState<Space | null>(null)
  // A click still opens the project; dragging starts only after the pointer has moved a little.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  function onDragStart(e: DragStartEvent) {
    setDragging((e.active.data.current?.project as ProjectRecord | undefined) ?? null)
    setDraggingSpace((e.active.data.current?.space as Space | undefined) ?? null)
  }

  /** Put the dragged Space where the one it was dropped on is. */
  async function reorder(dragged: Space, targetId: string) {
    const ids = spaces.map((x) => x.id)
    const from = ids.indexOf(dragged.id)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0 || from === to) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    // Show the new order at once; the saved order replaces it (or the old one comes back if saving fails).
    const previous = spaces
    setSpaces(ids.map((id) => spaces.find((x) => x.id === id)!))
    try {
      setSpaces(await api.reorderSpaces(ids))
    } catch (err) {
      setSpaces(previous)
      toast.error(errorMessage(err))
      await reload()
    }
  }

  async function onDragEnd(e: DragEndEvent) {
    setDragging(null)
    setDraggingSpace(null)
    const over = e.over ? String(e.over.id) : ""
    const draggedSpace = e.active.data.current?.space as Space | undefined
    if (draggedSpace) {
      if (over.startsWith(SPACE_PREFIX)) await reorder(draggedSpace, over.slice(SPACE_PREFIX.length))
      return
    }
    const project = e.active.data.current?.project as ProjectRecord | undefined
    if (!project || !over.startsWith(SPACE_PREFIX)) return
    const space = spaces.find((s) => s.id === over.slice(SPACE_PREFIX.length))
    if (!space) return
    if (project.spaceId === space.id) return void toast.info(`“${project.name}” is already in ${space.name}`)
    try {
      await api.setProjectSpace(project.id, space.id)
      toast.success(`Moved “${project.name}” to ${space.name}`)
      window.dispatchEvent(new Event(PROJECTS_CHANGED))
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={(e) => void onDragEnd(e)} onDragCancel={() => { setDragging(null); setDraggingSpace(null) }}>
      {children}
      <DragOverlay dropAnimation={null}>
        {(dragging || draggingSpace) && (
          <div className="w-fit max-w-60 truncate rounded-lg border bg-card px-3 py-2 text-sm font-medium shadow-lg">{dragging?.name ?? draggingSpace?.name}</div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

/** Makes a project card, or its row under a Space in the sidebar, draggable. A project whose folder is missing can't be moved. */
export function useDraggableProject(project: ProjectRecord, source = "card") {
  // The same project can be on screen twice (its card and its row in the sidebar), so the source is part of the id.
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `project:${source}:${project.id}`, data: { project }, disabled: !project.available })
  return { setNodeRef, listeners, isDragging }
}

/**
 * A Space row in the sidebar: projects can be dropped on it, and the row itself can be dragged to reorder the Spaces.
 * While a Space is dragged, a line shows where it will land; while a project is dragged, the row is highlighted.
 */
export function useSpaceRow(space: Space) {
  const { spaces } = useSpaces()
  const { active } = useDndContext()
  const drop = useDroppable({ id: SPACE_PREFIX + space.id })
  const drag = useDraggable({ id: SPACE_DRAG_PREFIX + space.id, data: { space } })
  const draggedSpace = active?.data.current?.space as Space | undefined
  const reordering = !!draggedSpace && drop.isOver && draggedSpace.id !== space.id
  const after = reordering && spaces.findIndex((x) => x.id === draggedSpace.id) < spaces.findIndex((x) => x.id === space.id)
  return {
    setNodeRef: (el: HTMLElement | null) => {
      drop.setNodeRef(el)
      drag.setNodeRef(el)
    },
    // Dragging starts only from the Space's own row, not from the project list inside it.
    listeners: {
      ...drag.listeners,
      onPointerDown: (e: React.PointerEvent) => {
        if ((e.target as HTMLElement).closest('[data-sidebar="menu-sub"]')) return
        drag.listeners?.onPointerDown?.(e)
      },
    },
    className: cn(
      "rounded-md transition-shadow",
      drop.isOver && !draggedSpace && "bg-accent ring-2 ring-primary",
      reordering && (after ? "shadow-[0_2px_0_0_var(--color-primary)]" : "shadow-[0_-2px_0_0_var(--color-primary)]"),
      drag.isDragging && "opacity-40",
    ),
  }
}
