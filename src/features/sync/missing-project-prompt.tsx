import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api, errorMessage, type ProjectRecord } from "@/lib/tauri"
import { locateProjectFolder } from "./locate-folder"
import { PROJECTS_CHANGED, useSync } from "./sync-context"

/**
 * Asks what to do about a project whose folder has gone: moved, renamed, deleted, or on a drive that is not connected.
 * One project at a time. "Not now" leaves it alone until the app is opened again, so a disconnected drive is not a nag.
 * Removing only forgets the project in Murre; nothing on disk is touched.
 */
export function MissingProjectPrompt() {
  const { report, rescan } = useSync()
  const [skipped, setSkipped] = useState<string[]>([])
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [busy, setBusy] = useState(false)

  const nextId = report?.unavailable.find((id) => !skipped.includes(id)) ?? null

  useEffect(() => {
    if (!nextId) return setProject(null)
    let cancelled = false
    api
      .getProject(nextId)
      .then((p) => {
        if (cancelled) return
        // An archived project is out of the way on purpose, so it is not asked about.
        if (p.status === "archived") setSkipped((s) => [...s, nextId])
        else setProject(p)
      })
      .catch(() => !cancelled && setSkipped((s) => [...s, nextId]))
    return () => {
      cancelled = true
    }
  }, [nextId])

  const refresh = async () => {
    await rescan()
    window.dispatchEvent(new Event(PROJECTS_CHANGED))
  }

  const relink = async () => {
    if (!project) return
    setBusy(true)
    try {
      if (await locateProjectFolder(project)) {
        setProject(null)
        await refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!project) return
    setBusy(true)
    try {
      await api.removeProject(project.id)
      toast.success(`Removed “${project.name}” from Murre`, { description: "Nothing on your disk was deleted. Breathe easy." })
      setProject(null)
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const later = () => project && setSkipped((s) => [...s, project.id])

  return (
    <Dialog open={project !== null} onOpenChange={(o) => !o && !busy && later()}>
      <DialogContent className="sm:max-w-md" data-testid="missing-project">
        <DialogHeader>
          <DialogTitle>Can’t find “{project?.name}”</DialogTitle>
          <DialogDescription>
            It used to be at <span className="break-all font-mono text-xs">{project?.path}</span>. The folder may have been moved, renamed or
            deleted, or it is on a drive that is not connected.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={later}>
            Not now
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void remove()}>
            Yes, remove from Murre
          </Button>
          <Button disabled={busy} onClick={() => void relink()}>
            Relink…
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
