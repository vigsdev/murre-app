import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { ExternalLink, Folder, FolderSearch, Info, MoreHorizontal, RefreshCw } from "lucide-react"
import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Card, CardContent } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes, formatDateTime } from "@/lib/format"
import { api, errorMessage, type AssetEntry, type AssetListing, type ProjectRecord } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { FootagePanel } from "@/features/footage/footage-panel"
import { iconFor } from "./file-icons"
import { showInFileBrowser } from "@/lib/platform"

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; listing: AssetListing }

export function AssetsTab({ project, reloadToken = 0, footageToken = 0 }: { project: ProjectRecord; reloadToken?: number; footageToken?: number }) {
  const [folder, setFolder] = useState("")
  const [state, setState] = useState<State>({ status: "loading" })
  const [refreshing, setRefreshing] = useState(false)

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

  useEffect(() => {
    setState({ status: "loading" })
    void load(folder)
  }, [folder, load])

  // Files changed on disk: re-list the folder being shown, without a loading flash.
  const shownFolder = useRef(folder)
  shownFolder.current = folder
  useEffect(() => {
    if (reloadToken > 0) void load(shownFolder.current)
  }, [reloadToken, load])

  const crumbs = folder ? folder.split("/") : []

  function activate(entry: AssetEntry) {
    if (entry.kind === "directory") {
      setFolder(entry.path)
    } else if (entry.openable) {
      api.openAsset(project.id, entry.path).catch((e) => toast.error(errorMessage(e)))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <FootagePanel projectId={project.id} reloadToken={footageToken} />
      <div className="flex items-center gap-2">
        <Breadcrumb className="min-w-0 flex-1">
          <BreadcrumbList>
            <BreadcrumbItem>
              {crumbs.length === 0 ? (
                <BreadcrumbPage>{project.name}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink render={<button type="button" onClick={() => setFolder("")} />}>{project.name}</BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {crumbs.map((name, i) => {
              const path = crumbs.slice(0, i + 1).join("/")
              const last = i === crumbs.length - 1
              return (
                <Fragment key={path}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    {last ? (
                      <BreadcrumbPage>{name}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink render={<button type="button" onClick={() => setFolder(path)} />}>{name}</BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              )
            })}
          </BreadcrumbList>
        </Breadcrumb>
        <Button variant="ghost" size="icon-sm" aria-label="Refresh" disabled={refreshing} onClick={() => void load(folder)}>
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </Button>
      </div>

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        These files are on disk. Once the After Effects Companion scans the project, we can tell which ones are actually used.
      </p>

      <Card className="gap-0 overflow-hidden py-0">
        <CardContent className="p-0">
          {state.status === "loading" && <Skeleton className="m-4 h-40" />}

          {state.status === "error" && (
            <div className="flex flex-col items-start gap-2 p-4">
              <p role="alert" className="text-sm text-destructive">
                {state.message}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void load(folder)}>
                  Try again
                </Button>
                {folder && (
                  <Button size="sm" variant="ghost" onClick={() => setFolder("")}>
                    Back to project root
                  </Button>
                )}
              </div>
            </div>
          )}

          {state.status === "ready" && state.listing.entries.length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">Empty folder. Not even a lonely PNG.</p>
          )}

          {state.status === "ready" && state.listing.entries.length > 0 && (
            <>
              {state.listing.entries.some((e) => e.kind === "directory") && (
                <div className="grid grid-cols-2 gap-3 border-b p-4 md:grid-cols-3 xl:grid-cols-4">
                  {state.listing.entries
                    .filter((e) => e.kind === "directory")
                    .map((e) => (
                      <button
                        key={e.path}
                        type="button"
                        onClick={() => activate(e)}
                        className="flex items-center gap-3 rounded-xl bg-muted/50 p-3 text-left outline-none transition-colors hover:bg-muted"
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-foreground/10">
                          <Folder className="size-4" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{e.name}</span>
                          <span className="block text-xs text-muted-foreground">{formatDateTime(e.modifiedAt)}</span>
                        </span>
                      </button>
                    ))}
                </div>
              )}
              {state.listing.entries.some((e) => e.kind !== "directory") && (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-4">Name</TableHead>
                      <TableHead className="hidden w-24 sm:table-cell">Type</TableHead>
                      <TableHead className="hidden w-24 text-right sm:table-cell">Size</TableHead>
                      <TableHead className="hidden w-44 md:table-cell">Modified</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {state.listing.entries
                      .filter((e) => e.kind !== "directory")
                      .map((e) => (
                        <AssetRow key={e.path} entry={e} onActivate={() => activate(e)} />
                      ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}

          {state.status === "ready" && state.listing.truncated && (
            <p className="border-t p-3 text-xs text-muted-foreground">Showing the first 5000 items only.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function AssetRow({ entry: e, onActivate }: { entry: AssetEntry; onActivate: () => void }) {
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
      <TableCell className="hidden text-muted-foreground uppercase sm:table-cell">
        {e.kind === "symlink" ? "Shortcut" : (e.extension ?? "File")}
      </TableCell>
      <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
        {e.sizeBytes !== null ? formatBytes(e.sizeBytes) : ""}
      </TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">{formatDateTime(e.modifiedAt)}</TableCell>
      <TableCell className="text-right">
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
      </TableCell>
    </TableRow>
  )
}
