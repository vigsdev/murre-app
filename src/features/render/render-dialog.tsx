import { open } from "@tauri-apps/plugin-dialog"
import { TriangleAlert } from "lucide-react"
import { useEffect, useState, type FormEvent } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, errorMessage, type AerenderStatus, type CompEntry, type ProjectRecord, type RenderJob } from "@/lib/tauri"

interface Props {
  project: ProjectRecord
  comp: CompEntry | null
  onClose: () => void
  onStarted: (job: RenderJob) => void
}

/** A file name that is a good starting point (the person can change it). */
export function suggestFileName(compName: string): string {
  const base = compName.replace(/[\\/:*?"<>|[\]#%\u0000-\u001f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "")
  return `${base || "render"}.mov`
}

/** Where a render can be saved: the project's three render folders. */
export const SAVE_AS = [
  { value: "pre", label: "Pre-render", folder: "05 Pre-Renders" },
  { value: "render", label: "Render", folder: "06 Renders" },
  { value: "deliverable", label: "Deliverable", folder: "07 Deliverables" },
] as const
type SaveAs = (typeof SAVE_AS)[number]["value"]

export function RenderDialog({ project, comp, onClose, onStarted }: Props) {
  return (
    <Dialog open={comp !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {comp && <RenderForm key={comp.id} project={project} comp={comp} onClose={onClose} onStarted={onStarted} />}
      </DialogContent>
    </Dialog>
  )
}

function RenderForm({ project, comp, onClose, onStarted }: Omit<Props, "comp"> & { comp: CompEntry }) {
  const [saveAs, setSaveAs] = useState<SaveAs>("render")
  const [dir, setDir] = useState(`${project.path}/06 Renders`)
  const [fileName, setFileName] = useState(suggestFileName(comp.name))
  const [rs, setRs] = useState("")
  const [om, setOm] = useState("")
  const [ae, setAe] = useState<AerenderStatus | null>(null)
  const [aePath, setAePath] = useState("") // "" = automatic
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .getAerenderStatus()
      .then((s) => alive && setAe(s))
      .catch(() => {}) // the render itself reports a missing aerender
    return () => {
      alive = false
    }
  }, [])

  const installs = ae?.detected ?? []
  const installName = (i: { label: string; version: string | null }) => (i.version ? `${i.label} · ${i.version}` : i.label)

  /** Picking what the render is for points "Save in" at that folder (it can still be changed afterwards). */
  function chooseSaveAs(value: SaveAs) {
    setSaveAs(value)
    const folder = SAVE_AS.find((o) => o.value === value)?.folder
    if (folder) setDir(`${project.path}/${folder}`)
  }

  async function chooseFolder() {
    try {
      const picked = await open({ directory: true, multiple: false, defaultPath: dir, title: "Choose where to save the render" })
      if (typeof picked === "string") setDir(picked)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setStarting(true)
    setError(null)
    try {
      const job = await api.startRender({
        projectId: project.id,
        compId: comp.id,
        outputDir: dir.trim(),
        fileName,
        rsTemplate: rs.trim() || null,
        omTemplate: om.trim() || null,
        aerenderPath: aePath || null,
      })
      onStarted(job)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Render “{comp.name}”</DialogTitle>
        <DialogDescription>
          Renders with Adobe After Effects’ aerender, from the saved project file. Unsaved changes in After Effects are not included.
        </DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <Field>
          <FieldLabel>Save as</FieldLabel>
          <Tabs value={saveAs} onValueChange={(v) => chooseSaveAs(String(v) as SaveAs)}>
            <TabsList>
              {SAVE_AS.map((o) => (
                <TabsTrigger key={o.value} value={o.value}>
                  {o.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <FieldDescription>It goes into the project's {SAVE_AS.find((o) => o.value === saveAs)?.folder} folder, where it is listed with the others.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="render-dir">Save in</FieldLabel>
          <div className="flex gap-2">
            <Input id="render-dir" value={dir} autoComplete="off" onChange={(e) => setDir(e.target.value)} />
            <Button type="button" variant="outline" onClick={() => void chooseFolder()}>
              Choose…
            </Button>
          </div>
          <FieldDescription>The folder must already exist.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="render-file">File name</FieldLabel>
          <Input id="render-file" value={fileName} maxLength={150} autoComplete="off" onChange={(e) => setFileName(e.target.value)} />
          <FieldDescription>
            The format comes from the After Effects output module, so use the matching extension. An existing file is never overwritten.
          </FieldDescription>
        </Field>
        {installs.length > 1 && (
          <Field>
            <FieldLabel htmlFor="render-ae">After Effects version</FieldLabel>
            <select
              id="render-ae"
              value={aePath}
              onChange={(e) => setAePath(e.target.value)}
              className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
            >
              <option value="">
                Automatic{ae?.active ? ` (${installs.find((i) => i.path === ae.active?.path)?.label ?? "newest found"})` : ""}
              </option>
              {installs.map((i) => (
                <option key={i.path} value={i.path}>
                  {installName(i)}
                </option>
              ))}
            </select>
            <FieldDescription>
              A project saved in a newer After Effects (a beta, for example) can only be rendered by that version or a newer one.
            </FieldDescription>
          </Field>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Render settings and output module templates (optional)</summary>
          <div className="mt-3 flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="render-rs">Render settings template</FieldLabel>
              <Input id="render-rs" value={rs} placeholder="Leave empty for the default" autoComplete="off" onChange={(e) => setRs(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="render-om">Output module template</FieldLabel>
              <Input id="render-om" value={om} placeholder="Leave empty for the default" autoComplete="off" onChange={(e) => setOm(e.target.value)} />
              <FieldDescription>Use the exact name of a template that exists in After Effects, or the render will fail.</FieldDescription>
            </Field>
          </div>
        </details>
      </FieldGroup>

      {error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" disabled={starting} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={starting || !dir.trim() || !fileName.trim()}>
          {starting ? "Starting…" : "Start render"}
        </Button>
      </DialogFooter>
    </form>
  )
}
