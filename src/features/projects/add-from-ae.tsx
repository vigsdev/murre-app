import { listen } from "@tauri-apps/api/event"
import { open } from "@tauri-apps/plugin-dialog"
import { Clapperboard } from "lucide-react"
import { useEffect, useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { PROJECTS_CHANGED } from "@/features/sync/sync-context"
import { api, errorMessage, type PremiereCandidate, type VersionCandidate } from "@/lib/tauri"

interface Progress {
  text: string
  done: boolean
  ok: boolean
  projectId: string | null
}

const TOAST_ID = "add-project-from-ae"

/** Shows how "add the open After Effects project to Murre" is going, wherever it was started (here or in the panel). */
export function AddProjectProgress() {
  const navigate = useNavigate()
  useEffect(() => {
    let off: (() => void) | null = null
    let cancelled = false
    void listen<Progress>("add-project-progress", (e) => {
      const p = e.payload
      if (!p.done) return void toast.loading(p.text, { id: TOAST_ID, duration: Infinity })
      window.dispatchEvent(new Event(PROJECTS_CHANGED))
      const action = p.projectId ? { label: "Open", onClick: () => navigate(`/projects/${p.projectId}`) } : undefined
      if (p.ok) toast.success(p.text, { id: TOAST_ID, duration: 12000, action })
      else toast.error(p.text, { id: TOAST_ID, duration: 15000, action })
    })
      .then((fn) => (cancelled ? fn() : (off = fn)))
      .catch(() => {})
    return () => {
      cancelled = true
      off?.()
    }
  }, [navigate])
  return null
}

/** The default name for a project: the open file's name without its extension, bracketed notes ("(converted)") and version number. */
const suggestName = (file: string) => {
  let stem = file.replace(/\.aep$/i, "").trim()
  stem = stem.replace(/(\s*[([][^)\]]*[)\]])+$/, "").trim() || stem
  return stem.replace(/[-_ ]*v\d+$/i, "").replace(/[-_ ]+\d{1,3}$/, "").trim() || stem || "Untitled project"
}

const fileSize = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)
const fileDate = (secs: number | null) => (secs ? new Date(secs * 1000).toLocaleDateString(undefined, { dateStyle: "medium" }) : "")

/**
 * Other versions found next to the open project. One tick brings them all along; "Choose which…" opens the list for
 * picking some. Most folders hold one project's versions, and an extra small file is easy to delete, so copying is the default.
 */
function VersionChecklist({ others, picked, onChange }: { others: VersionCandidate[]; picked: string[]; onChange: (names: string[]) => void }) {
  const [expanded, setExpanded] = useState(false)
  if (others.length === 0) return null
  const all = others.map((o) => o.name)
  const total = others.filter((o) => picked.includes(o.name)).reduce((n, o) => n + o.size, 0)
  const toggle = (name: string) => onChange(picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name])
  const summary =
    picked.length === 0
      ? `Don't copy the other ${others.length === 1 ? "version" : `${others.length} versions`}`
      : picked.length === others.length
        ? `Copy ${others.length === 1 ? "the other version" : `all ${others.length} other versions`} (${fileSize(total)})`
        : `Copy ${picked.length} of ${others.length} other versions (${fileSize(total)})`
  return (
    <div className="flex flex-col gap-2" data-testid="version-checklist">
      <div className="flex items-center gap-3">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm font-medium">
          <Checkbox checked={picked.length > 0} onCheckedChange={(c) => onChange(c ? all : [])} />
          <span className="truncate">{summary}</span>
        </label>
        <Button type="button" variant="ghost" size="xs" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
          {expanded ? "Hide list" : "Choose which…"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Other After Effects files saved next to this one. They are copied as they are and keep pointing at their original footage: open one in
        After Effects and use copy and relink to bring its files in.{others.length >= 30 ? " The 30 most recent are listed." : ""}
      </p>
      {expanded && (
        <>
          <div className="flex gap-1">
            <Button type="button" variant="outline" size="xs" onClick={() => onChange(all)}>
              Select all
            </Button>
            <Button type="button" variant="outline" size="xs" onClick={() => onChange([])}>
              Select none
            </Button>
          </div>
          <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border">
            {others.map((o) => (
              <li key={o.name}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                  <Checkbox checked={picked.includes(o.name)} onCheckedChange={() => toggle(o.name)} />
                  <span className="min-w-0 flex-1 truncate" title={o.name}>
                    {o.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{[fileDate(o.modified), fileSize(o.size)].filter(Boolean).join(" · ")}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * Premiere Pro projects found beside the After Effects project or one folder above it. Nothing is ticked until the person
 * chooses: collecting copies the footage each project uses, which can be large, so the size is shown before they agree.
 */
function PremiereChecklist({ found, picked, onChange }: { found: PremiereCandidate[]; picked: string[]; onChange: (paths: string[]) => void }) {
  if (found.length === 0) return null
  const toggle = (path: string) => onChange(picked.includes(path) ? picked.filter((p) => p !== path) : [...picked, path])
  const total = found.filter((f) => picked.includes(f.path)).reduce((n, f) => n + f.bytes, 0)
  return (
    <div className="flex flex-col gap-2" data-testid="premiere-checklist">
      <p className="text-sm font-medium">
        Premiere Pro {found.length === 1 ? "project" : "projects"} found{picked.length > 0 ? ` · ${fileSize(total)} of footage will be copied` : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        If you need {found.length === 1 ? "it" : "them"}, tick to collect: the footage a project uses is copied into <code>04 Premiere &amp; SFX</code>{" "}
        and a copy of the project is saved pointing at it. The original project is not changed.
      </p>
      <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border">
        {found.map((f) => (
          <li key={f.path}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
              <Checkbox checked={picked.includes(f.path)} onCheckedChange={() => toggle(f.path)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate" title={f.path}>
                  {f.name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {f.location === "above" ? "Folder above" : f.location === "inside" ? "Subfolder" : "Same folder"} · {f.footage} {f.footage === 1 ? "file" : "files"}, {fileSize(f.bytes)}
                  {f.missing > 0 ? ` · ${f.missing} not found` : ""}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{fileDate(f.modified)}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AddFromAeButton() {
  const [dialog, setDialog] = useState<{ name: string; file: string; others: VersionCandidate[]; picked: string[]; premiere: PremiereCandidate[]; premierePicked: string[] } | null>(null)
  const [busy, setBusy] = useState(false)

  async function begin() {
    setBusy(true)
    try {
      const ae = await api.checkAfterEffects()
      if (!ae.connected) {
        return void toast.error(
          ae.running
            ? "After Effects is running but the Companion is not connected. Install it in Settings and restart After Effects."
            : "Open After Effects and the project you want to add.",
        )
      }
      if (ae.kind === "empty") return void toast.error("After Effects has nothing open. Open a project there first.")
      // A saved project may have older versions saved beside it; listing them is read-only, and failing to is not a reason to stop.
      const others = ae.kind === "saved" && ae.path ? await api.listOtherVersions(ae.path).catch(() => []) : []
      // Premiere Pro projects next to it, for the same reason: read-only, and nothing is ticked.
      const premiere = ae.kind === "saved" && ae.path ? await api.listPremiereProjects(ae.path).catch(() => []) : []
      setDialog({
        premiere,
        premierePicked: [],
        name: ae.kind === "saved" ? suggestName(ae.name) : "Untitled project",
        file: ae.kind === "saved" ? ae.name : "",
        others,
        picked: others.map((o) => o.name),
      })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function choose() {
    if (!dialog || !dialog.name.trim()) return
    try {
      const dir = await open({ directory: true, multiple: false, title: "Choose where to create the project folder" })
      if (typeof dir !== "string") return
      const name = dialog.name.trim()
      setDialog(null)
      await api.addProjectFromAfterEffects(name, dir, dialog.picked, dialog.premierePicked)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void begin()}>
        <Clapperboard /> Import from After Effects
      </Button>
      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add the open After Effects project</DialogTitle>
            <DialogDescription>
              A new Murre project folder is made, a copy of the project is saved into it, then it is scanned and the files it uses are
              copied in. {dialog?.file ? <>Your original file <code>{dialog.file}</code> is not changed: work in the new copy from now on.</> : "Your open project is saved as a copy."}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="ae-project-name">Project name</FieldLabel>
            <Input
              id="ae-project-name"
              value={dialog?.name ?? ""}
              maxLength={100}
              onChange={(e) => setDialog((d) => (d ? { ...d, name: e.target.value } : d))}
            />
          </Field>
          {dialog && <VersionChecklist others={dialog.others} picked={dialog.picked} onChange={(picked) => setDialog((d) => (d ? { ...d, picked } : d))} />}
          {dialog && (
            <PremiereChecklist
              found={dialog.premiere}
              picked={dialog.premierePicked}
              onChange={(premierePicked) => setDialog((d) => (d ? { ...d, premierePicked } : d))}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button disabled={!dialog?.name.trim()} onClick={() => void choose()}>
              Choose folder and add…
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
