import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { ChevronRight, ExternalLink, Folder, FolderSearch, LayoutGrid, List, MoreHorizontal, RefreshCw, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes, formatDateTime } from "@/lib/format"
import { api, errorMessage, type AssetEntry, type AssetListing, type FootageView, type ProjectRecord, type StorageKind, type StorageView } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { FootagePanel } from "@/features/footage/footage-panel"
import { AssetThumb } from "@/features/assets/asset-thumb"
import { FOOTAGE_KINDS, KIND_COLOR, KIND_LABEL, kindOf, usageOf, usedNames } from "@/features/assets/asset-kinds"
import { FolderTree } from "@/features/assets/folder-tree"
import { StorageOverview } from "@/features/assets/storage-overview"
import { iconFor } from "./file-icons"
import { showInFileBrowser } from "@/lib/platform"

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; listing: AssetListing }

type View = "grid" | "list"
type Use = "all" | "used" | "unused"

const VIEW_KEY = "murre.assets.view"
const readView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"
  } catch {
    return "grid"
  }
}

export function AssetsTab({ project, reloadToken = 0, footageToken = 0 }: { project: ProjectRecord; reloadToken?: number; footageToken?: number }) {
  const [folder, setFolder] = useState("")
  const [state, setState] = useState<State>({ status: "loading" })
  const [refreshing, setRefreshing] = useState(false)
  const [storage, setStorage] = useState<StorageView | null>(null)
  const [footage, setFootage] = useState<FootageView | null>(null)
  const [view, setView] = useState<View>(readView)
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState<StorageKind | "all">("all")
  const [use, setUse] = useState<Use>("all")

  const load = useCallback(
    async (path: string) => {
      setRefreshing(true)
      try {
        setState({ status: "ready", listing: await api.listAssets(project.id, path) })
      } catch (e) {
        setState({ status: "error", message: errorMessage(e) })
      } finally {
        setRefreshing(false)
      }
    },
    [project.id],
  )

  const loadStorage = useCallback(() => {
    // The overview and the folder list are extras: without them the files still show.
    api.assetStorage(project.id).then(setStorage, () => setStorage(null))
  }, [project.id])

  useEffect(() => {
    setState({ status: "loading" })
    void load(folder)
  }, [folder, load])

  useEffect(() => loadStorage(), [loadStorage])
  // A kind picked in one folder may not exist in the next.
  useEffect(() => setKind("all"), [folder])

  // Files changed on disk: look again, without a loading flash.
  const shownFolder = useRef(folder)
  shownFolder.current = folder
  useEffect(() => {
    if (reloadToken > 0) {
      void load(shownFolder.current)
      loadStorage()
    }
  }, [reloadToken, load, loadStorage])

  useEffect(() => {
    let cancelled = false
    api.getFootage(project.id).then(
      (v) => !cancelled && setFootage(v),
      () => !cancelled && setFootage(null),
    )
    return () => {
      cancelled = true
    }
  }, [project.id, footageToken])

  const usage = useMemo(() => usageOf(footage), [footage])

  const changeView = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* remembered for this visit only */
    }
  }

  function activate(entry: AssetEntry) {
    if (entry.kind === "directory") {
      setFolder(entry.path)
      setQuery("")
    } else if (entry.openable) {
      api.openAsset(project.id, entry.path).catch((e) => toast.error(errorMessage(e)))
    }
  }

  const entries = state.status === "ready" ? state.listing.entries : []
  const q = query.trim().toLowerCase()
  const folders = entries.filter((e) => e.kind === "directory" && (!q || e.name.toLowerCase().includes(q)))
  const files = entries.filter((e) => {
    if (e.kind === "directory") return false
    if (q && !e.name.toLowerCase().includes(q)) return false
    const k = kindOf(e)
    if (kind !== "all" && k !== kind) return false
    if (use !== "all" && usage) {
      const used = usedNames(usage, e) !== null
      if (use === "used" && !used) return false
      if (use === "unused" && (used || !FOOTAGE_KINDS.includes(k))) return false
    }
    return true
  })
  // Only offer the kinds this folder has.
  const kindsHere = [...new Set(entries.filter((e) => e.kind !== "directory").map(kindOf))]
  const sizeOf = (path: string) => storage?.folders.find((f) => f.path === path)
  const crumbs = folder ? folder.split("/") : []
  const filtering = q !== "" || kind !== "all" || use !== "all"

  return (
    <div className="flex flex-col gap-4">
      <FootagePanel projectId={project.id} reloadToken={footageToken} />
      {storage && <StorageOverview storage={storage} />}

      <div className="flex min-w-0 gap-4">
        {storage && (
          <aside className="hidden w-60 shrink-0 md:block">
            <div className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border p-2">
              <FolderTree rootName={project.name} storage={storage} folder={folder} onOpen={(p) => (setFolder(p), setQuery(""))} />
            </div>
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
            {["", ...crumbs.map((_, i) => crumbs.slice(0, i + 1).join("/"))].map((path, i, all) => {
              const label = i === 0 ? project.name : crumbs[i - 1]
              const last = i === all.length - 1
              return (
                <span key={path || "/"} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                  {last ? (
                    <span aria-current="page" className="truncate">{label}</span>
                  ) : (
                    <button type="button" className="truncate text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => (setFolder(path), setQuery(""))}>
                      {label}
                    </button>
                  )}
                </span>
              )
            })}
          </nav>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-56">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Search this folder" placeholder="Search this folder" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
            </div>
            {kindsHere.length > 1 && (
              <div role="group" aria-label="Kind of file" className="flex flex-wrap items-center gap-1">
                <Chip on={kind === "all"} onClick={() => setKind("all")}>All</Chip>
                {(Object.keys(KIND_LABEL) as StorageKind[])
                  .filter((k) => kindsHere.includes(k))
                  .map((k) => (
                    <Chip key={k} on={kind === k} onClick={() => setKind(kind === k ? "all" : k)}>
                      <span aria-hidden className="size-1.5 rounded-full" style={{ background: KIND_COLOR[k] }} />
                      {KIND_LABEL[k]}
                    </Chip>
                  ))}
              </div>
            )}
            <div className="ml-auto flex items-center gap-1">
              {usage && (
                <div role="group" aria-label="Used in After Effects" className="mr-1 flex items-center gap-1">
                  <Chip on={use === "used"} onClick={() => setUse(use === "used" ? "all" : "used")}>Used in AE</Chip>
                  <Chip on={use === "unused"} onClick={() => setUse(use === "unused" ? "all" : "unused")}>Not used</Chip>
                </div>
              )}
              <div className="flex items-center rounded-lg border p-0.5">
                <Button variant={view === "grid" ? "secondary" : "ghost"} size="icon-sm" aria-label="Show as grid" aria-pressed={view === "grid"} onClick={() => changeView("grid")}>
                  <LayoutGrid />
                </Button>
                <Button variant={view === "list" ? "secondary" : "ghost"} size="icon-sm" aria-label="Show as list" aria-pressed={view === "list"} onClick={() => changeView("list")}>
                  <List />
                </Button>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh"
                disabled={refreshing}
                onClick={() => {
                  void load(folder)
                  loadStorage()
                }}
              >
                <RefreshCw className={cn(refreshing && "animate-spin")} />
              </Button>
            </div>
          </div>

          {usage === null && footage !== null && (
            <p className="text-xs text-muted-foreground">Scan the project from After Effects to see which of these files it uses.</p>
          )}

          {state.status === "loading" && <Skeleton className="h-48" />}

          {state.status === "error" && (
            <div className="flex flex-col items-start gap-2 rounded-xl border p-4">
              <p role="alert" className="text-sm text-destructive">
                {state.message}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void load(folder)}>
                  Try again
                </Button>
                {folder && (
                  <Button size="sm" variant="ghost" onClick={() => setFolder("")}>
                    Back to project folder
                  </Button>
                )}
              </div>
            </div>
          )}

          {state.status === "ready" && entries.length === 0 && (
            <p className="rounded-xl border p-8 text-center text-sm text-muted-foreground">Empty folder. Not even a lonely PNG.</p>
          )}

          {state.status === "ready" && entries.length > 0 && folders.length === 0 && files.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-xl border p-8 text-center text-sm text-muted-foreground">
              Nothing here matches.
              {filtering && (
                <Button size="sm" variant="outline" onClick={() => (setQuery(""), setKind("all"), setUse("all"))}>
                  Clear filters
                </Button>
              )}
            </div>
          )}

          {folders.length > 0 && (
            <section aria-label="Folders" className="flex flex-col gap-2">
              <h3 className="text-xs text-muted-foreground">Folders</h3>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2">
                {folders.map((e) => {
                  const size = sizeOf(e.path)
                  return (
                    <button
                      key={e.path}
                      type="button"
                      onClick={() => activate(e)}
                      className="flex items-center gap-3 rounded-xl border p-3 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <Folder className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{e.name}</span>
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          {size ? `${size.files.toLocaleString()} ${size.files === 1 ? "file" : "files"} · ${formatBytes(size.bytes)}` : formatDateTime(e.modifiedAt)}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          {files.length > 0 && (
            <section aria-label="Files" className="flex flex-col gap-2">
              <h3 className="text-xs text-muted-foreground">Files</h3>
              {view === "grid" ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-3">
                  {files.map((e) => (
                    <FileCard key={e.path} projectId={project.id} entry={e} used={usedNames(usage, e)} scanned={usage !== null} onActivate={() => activate(e)} />
                  ))}
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="pl-4">Name</TableHead>
                        {usage && <TableHead className="hidden w-32 lg:table-cell">In After Effects</TableHead>}
                        <TableHead className="hidden w-24 text-right sm:table-cell">Size</TableHead>
                        <TableHead className="hidden w-44 md:table-cell">Modified</TableHead>
                        <TableHead className="w-12" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {files.map((e) => (
                        <AssetRow key={e.path} entry={e} used={usedNames(usage, e)} scanned={usage !== null} onActivate={() => activate(e)} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          )}

          {state.status === "ready" && state.listing.truncated && (
            <p className="text-xs text-muted-foreground">Showing the first 5000 items only.</p>
          )}
        </div>
      </div>
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        on ? "border-transparent bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

/** Whether the last scan saw the file in the `.aep`, said quietly. */
function UsedMark({ used, entry, scanned }: { used: string[] | null; entry: AssetEntry; scanned: boolean }) {
  if (!scanned) return null
  if (used) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`In After Effects as ${used.map((n) => `“${n}”`).join(", ")}`}>
        <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
        Used
      </span>
    )
  }
  if (!FOOTAGE_KINDS.includes(kindOf(entry))) return null
  return <span className="text-xs text-muted-foreground/70">Not used</span>
}

function FileActions({ entry: e, onActivate }: { entry: AssetEntry; onActivate: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${e.name}`} />}>
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {e.openable && (
          <DropdownMenuItem onClick={onActivate}>
            <ExternalLink /> Open
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => void revealItemInDir(e.absolutePath).catch((err) => toast.error(errorMessage(err)))}>
          <FolderSearch /> {showInFileBrowser}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FileCard({ projectId, entry: e, used, scanned, onActivate }: { projectId: string; entry: AssetEntry; used: string[] | null; scanned: boolean; onActivate: () => void }) {
  return (
    <div className="group relative flex flex-col gap-2 rounded-xl border p-2 transition-colors hover:bg-accent/40">
      <button
        type="button"
        disabled={!e.openable}
        onClick={onActivate}
        title={e.openable ? `Open ${e.name}` : e.name}
        className="flex flex-col gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <AssetThumb projectId={projectId} entry={e} />
        <span className="flex min-w-0 flex-col gap-0.5 px-1">
          <span className="truncate text-sm">{e.name}</span>
          <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
            {e.sizeBytes !== null ? formatBytes(e.sizeBytes) : e.kind === "symlink" ? "Shortcut" : ""}
            <UsedMark used={used} entry={e} scanned={scanned} />
          </span>
        </span>
      </button>
      <div className="absolute top-3 right-3 rounded-md bg-background/80 opacity-0 backdrop-blur group-hover:opacity-100 focus-within:opacity-100">
        <FileActions entry={e} onActivate={onActivate} />
      </div>
    </div>
  )
}

function AssetRow({ entry: e, used, scanned, onActivate }: { entry: AssetEntry; used: string[] | null; scanned: boolean; onActivate: () => void }) {
  const Icon = iconFor(e)
  return (
    <TableRow>
      <TableCell className="max-w-0 pl-4">
        <button
          type="button"
          disabled={!e.openable}
          onClick={onActivate}
          title={e.openable ? "Open file" : undefined}
          className="flex w-full min-w-0 items-center gap-3 rounded-md text-left outline-none disabled:cursor-default"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{e.name}</span>
        </button>
      </TableCell>
      {scanned && (
        <TableCell className="hidden lg:table-cell">
          <UsedMark used={used} entry={e} scanned={scanned} />
        </TableCell>
      )}
      <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
        {e.sizeBytes !== null ? formatBytes(e.sizeBytes) : e.kind === "symlink" ? "Shortcut" : ""}
      </TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">{formatDateTime(e.modifiedAt)}</TableCell>
      <TableCell className="text-right">
        <FileActions entry={e} onActivate={onActivate} />
      </TableCell>
    </TableRow>
  )
}
