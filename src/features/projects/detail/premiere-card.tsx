import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { FolderSearch, MoreHorizontal, RefreshCw, Video } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { formatBytes, formatDateTime } from "@/lib/format"
import { api, errorMessage, type PremiereFile } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { showInFileBrowser } from "@/lib/platform"

/**
 * The Premiere Pro projects saved in the project's `04 Premiere & SFX` folder. Shown only when there is at least one, so a
 * project without Premiere files looks the same as before. Read-only: open it, or show it in Finder.
 */
export function PremiereCard({ projectId, reloadToken = 0 }: { projectId: string; reloadToken?: number }) {
  const [files, setFiles] = useState<PremiereFile[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      setFiles(await api.getPremiereProjects(projectId))
    } catch {
      setFiles([])
    } finally {
      setRefreshing(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load, reloadToken])

  if (files.length === 0) return null

  return (
    <Card data-testid="premiere-card">
      <CardHeader>
        <CardTitle>Premiere Pro projects</CardTitle>
        <CardDescription>
          .prproj files saved in <code>04 Premiere &amp; SFX</code>, newest first.
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" aria-label="Check again" disabled={refreshing} onClick={() => void load()}>
            <RefreshCw className={cn(refreshing && "animate-spin")} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1">
          {files.map((f) => (
            <li key={f.path} className="flex items-center gap-3 rounded-lg px-2 py-2">
              <Video className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="truncate">{f.name}</span>
                  {f.readable && f.missing > 0 && <Badge variant="outline">{f.missing} not found</Badge>}
                  {!f.readable && <Badge variant="outline">Could not read</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(f.modifiedAt)} · {formatBytes(f.sizeBytes)}
                  {f.readable && ` · ${f.footage} ${f.footage === 1 ? "footage file" : "footage files"}`}
                  {f.readable && f.linked > 0 && ` · ${f.linked} linked ${f.linked === 1 ? "project" : "projects"}`}
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${f.name}`} />}>
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void api.openAsset(projectId, f.path).catch((e) => toast.error(errorMessage(e)))}>
                    <Video /> Open
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void revealItemInDir(f.absolutePath).catch((e) => toast.error(errorMessage(e)))}>
                    <FolderSearch /> {showInFileBrowser}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
