import { ChevronRight, Folder, FolderOpen } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { formatBytes } from "@/lib/format"
import type { StorageView } from "@/lib/tauri"
import { cn } from "@/lib/utils"

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** The project's real folders as a tree. `folder` is the open one ("" for the project folder itself). */
export function FolderTree({
  rootName,
  storage,
  folder,
  onOpen,
}: {
  rootName: string
  storage: StorageView
  folder: string
  onOpen: (path: string) => void
}) {
  const children = useMemo(() => {
    const map = new Map<string, StorageView["folders"]>()
    for (const f of storage.folders) {
      const p = parentOf(f.path)
      map.set(p, [...(map.get(p) ?? []), f])
    }
    return map
  }, [storage.folders])

  // The top level starts open, and the open folder's parents open with it.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]))
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev)
      for (let p = parentOf(folder); p; p = parentOf(p)) next.add(p)
      if (folder) next.add(parentOf(folder))
      return next.size === prev.size ? prev : next
    })
  }, [folder])

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const row = (path: string, label: string, bytes: number, depth: number) => {
    const kids = children.get(path) ?? []
    const open = expanded.has(path)
    const active = path === folder
    const Icon = active ? FolderOpen : Folder
    return (
      <li key={path || "/"}>
        <div
          className={cn(
            "group flex h-8 items-center gap-1 rounded-lg pr-2 text-sm",
            active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          {kids.length > 0 ? (
            <button
              type="button"
              aria-label={open ? `Close ${label}` : `Open ${label}`}
              aria-expanded={open}
              className="flex size-5 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => toggle(path)}
            >
              <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            </button>
          ) : (
            <span className="size-5 shrink-0" />
          )}
          <button
            type="button"
            aria-current={active ? "page" : undefined}
            title={label}
            className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpen(path)}
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{bytes > 0 ? formatBytes(bytes) : ""}</span>
        </div>
        {kids.length > 0 && open && <ul>{kids.map((k) => row(k.path, nameOf(k.path), k.bytes, depth + 1))}</ul>}
      </li>
    )
  }

  return (
    <nav aria-label="Folders">
      <ul className="flex flex-col gap-0.5">{row("", rootName, storage.total.bytes, 0)}</ul>
    </nav>
  )
}
