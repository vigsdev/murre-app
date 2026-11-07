import { open } from "@tauri-apps/plugin-dialog"
import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { FolderOpen } from "lucide-react"
import { useRef, useState, type FormEvent } from "react"
import { useNavigate, useSearchParams } from "react-router"
import { SpaceSelect } from "@/features/spaces/space-select"
import { useSpaces } from "@/features/spaces/spaces-context"
import { toast } from "sonner"
import { DatePicker } from "@/components/date-picker"
import { PageTop } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { api, errorMessage, type AeCheck, type ProjectPriority, type ProjectStatus } from "@/lib/tauri"
import { PrioritySelect, StatusSelect } from "./selects"
import { CompanionInstallCard, useCompanionInstall } from "@/features/companion/companion-install"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { defaultInstall, installName, useAeInstalls } from "./use-ae-installs"
import { showInFileBrowser, baseName } from "@/lib/platform"
import { StarterProgress, announceStarter, useStarter } from "./starter-progress"

type FieldErrors = Partial<Record<"name" | "parentDir", string>>

export function NewProjectPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { spaces } = useSpaces()
  const requestedSpace = params.get("space")
  // Opened from a Space: file the new project there (unless that Space is gone).
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [spacePrefilled, setSpacePrefilled] = useState(false)
  if (!spacePrefilled && requestedSpace && spaces.some((x) => x.id === requestedSpace)) {
    setSpacePrefilled(true)
    setSpaceId(requestedSpace)
  }
  const [name, setName] = useState("")
  const [parentDir, setParentDir] = useState<string | null>(null)
  const [client, setClient] = useState("")
  const [deadline, setDeadline] = useState<string | null>(null)
  const [priority, setPriority] = useState<ProjectPriority>("medium")
  const [description, setDescription] = useState("")
  const [status, setStatus] = useState<ProjectStatus>("not_started")
  const [errors, setErrors] = useState<FieldErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const ae = useAeInstalls()
  const companion = useCompanionInstall()
  const [aePath, setAePath] = useState<string | null>(null)
  const [startWorking, setStartWorking] = useState(true)
  const [stage, setStage] = useState<string | null>(null)
  const starter = useStarter()
  // Asked before anything is created, when After Effects has a project open that will be saved and closed.
  const [confirm, setConfirm] = useState<AeCheck | null>(null)
  const confirmAnswer = useRef<((ok: boolean) => void) | null>(null)
  const install = (aePath && ae?.installs.find((i) => i.path === aePath)) || defaultInstall(ae)
  const canStart = !!install && companion.ready
  const start = startWorking && canStart

  function askToReplace(check: AeCheck): Promise<boolean> {
    setConfirm(check)
    return new Promise((resolve) => {
      confirmAnswer.current = resolve
    })
  }

  function answerConfirm(ok: boolean) {
    setConfirm(null)
    confirmAnswer.current?.(ok)
    confirmAnswer.current = null
  }

  async function chooseFolder() {
    try {
      const picked = await open({ directory: true, multiple: false, title: "Choose where to create the project" })
      if (typeof picked === "string") {
        setParentDir(picked)
        setErrors((e) => ({ ...e, parentDir: undefined }))
      }
    } catch (e) {
      setSubmitError(errorMessage(e))
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const next: FieldErrors = {}
    if (!name.trim()) next.name = "Please enter a project name."
    if (!parentDir) next.parentDir = "Please choose a location."
    setErrors(next)
    setSubmitError(null)
    if (next.name || next.parentDir || !parentDir) return

    setSaving(true)
    try {
      if (start) {
        // Look before creating anything: a project open in After Effects will be saved and closed.
        setStage("Checking After Effects…")
        const check = await api.checkAfterEffects()
        if (check.running && !check.connected) {
          setSubmitError(
            "After Effects is running, but the Murre Companion is not connected. Restart After Effects once so it loads the Companion, or untick “Open After Effects and start using”.",
          )
          setSaving(false)
          setStage(null)
          return
        }
        if (check.kind === "saved" || check.kind === "unsaved" || check.kind === "unknown") {
          const ok = await askToReplace(check)
          if (!ok) {
            setSaving(false)
            setStage(null)
            return
          }
        }
      }
      const created = await api.createProject({
        name,
        parentDir,
        client: client.trim() || null,
        deadline,
        priority,
        description: description.trim() || null,
        status,
        spaceId,
      })
      toast.success(`“${created.name}” is ready. Let’s make something.`, {
        description: created.path,
        action: { label: showInFileBrowser, onClick: () => void revealItemInDir(created.path) },
      })
      // The project exists now; a problem with After Effects is reported but never undoes it.
      if (start && install) {
        setStage(null)
        try {
          // The open project was asked about just above.
          announceStarter(await starter.run(created.id, install.path, true), baseName)
        } catch (err) {
          toast.error(`Project made! After Effects couldn’t create the workfile, though: ${errorMessage(err)}`)
        }
      }
      navigate(`/projects/${created.id}`)
    } catch (err) {
      setSubmitError(errorMessage(err))
      setSaving(false)
      setStage(null)
    }
  }

  return (
    <>
      <PageTop />
      <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-6">
        <FieldGroup>
          <Field data-invalid={errors.name ? true : undefined}>
            <FieldLabel htmlFor="name">Project name</FieldLabel>
            <Input
              id="name"
              autoFocus
              autoComplete="off"
              value={name}
              maxLength={100}
              aria-invalid={errors.name ? true : undefined}
              onChange={(e) => {
                setName(e.target.value)
                setErrors((prev) => ({ ...prev, name: undefined }))
              }}
              placeholder="e.g. Brand Film 2026"
            />
            <FieldDescription>Also used as the project's folder name.</FieldDescription>
            {errors.name && <FieldError>{errors.name}</FieldError>}
          </Field>

          <Field data-invalid={errors.parentDir ? true : undefined}>
            <FieldLabel htmlFor="location">Location</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="location"
                readOnly
                value={parentDir ?? ""}
                placeholder="Pick a folder first. We need somewhere to live."
                aria-invalid={errors.parentDir ? true : undefined}
                className="flex-1"
              />
              <Button type="button" variant="outline" onClick={() => void chooseFolder()}>
                <FolderOpen />
                Choose…
              </Button>
            </div>
            <FieldDescription>
              {parentDir && name.trim()
                ? `Will create ${parentDir}/${name.trim()}`
                : "The project folder is created inside this location."}
            </FieldDescription>
            {errors.parentDir && <FieldError>{errors.parentDir}</FieldError>}
          </Field>

          <div className="grid gap-6 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="client">Client</FieldLabel>
              <Input
                id="client"
                autoComplete="off"
                value={client}
                maxLength={100}
                onChange={(e) => setClient(e.target.value)}
                placeholder="Optional"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="deadline">Deadline</FieldLabel>
              <DatePicker id="deadline" disablePast value={deadline} onChange={setDeadline} placeholder="No deadline. Lucky you." />
            </Field>
            <Field>
              <FieldLabel htmlFor="priority">Priority</FieldLabel>
              <PrioritySelect id="priority" value={priority} onChange={setPriority} />
            </Field>
            <Field>
              <FieldLabel htmlFor="status">Status</FieldLabel>
              <StatusSelect id="status" value={status} onChange={setStatus} />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="space">Space</FieldLabel>
            <SpaceSelect id="space" value={spaceId} onChange={setSpaceId} />
            <FieldDescription>Optional. Spaces only group projects inside Murre; no folders are created or moved.</FieldDescription>
          </Field>

          <FieldSet>
            <FieldLegend variant="label">After Effects</FieldLegend>
            {ae && ae.installs.length > 1 && (
              <Field>
                <FieldLabel htmlFor="ae-version">Version</FieldLabel>
                <select
                  id="ae-version"
                  value={install?.path ?? ""}
                  onChange={(e) => setAePath(e.target.value)}
                  className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
                >
                  {ae.installs.map((i) => (
                    <option key={i.path} value={i.path}>
                      {installName(i)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field orientation="horizontal">
              <Checkbox
                id="start-working"
                checked={start}
                disabled={!canStart}
                onCheckedChange={(v) => setStartWorking(v === true)}
              />
              <FieldLabel htmlFor="start-working" className="font-normal">
                Open After Effects and start using
              </FieldLabel>
            </Field>
            {start && install && (
              <FieldDescription>
                After Effects creates and saves the project file itself (1920×1080, 30 fps, 30 s) in the project folder. If a project
                is already open there, it is saved and closed first.
              </FieldDescription>
            )}
            {ae && !install && (
              <FieldDescription>No After Effects installation found. Murre made the folders, but couldn’t make an .aep file.</FieldDescription>
            )}
            {install && !companion.ready && companion.status && (
              <div className="flex flex-col gap-2">
                <FieldDescription>Install the Companion to let Murre create projects in After Effects.</FieldDescription>
                <CompanionInstallCard state={companion} />
              </div>
            )}
          </FieldSet>

          <Field>
            <FieldLabel htmlFor="description">Description</FieldLabel>
            <Textarea
              id="description"
              rows={4}
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </FieldGroup>

        {stage && (
          <p className="text-sm text-muted-foreground" role="status">
            {stage}
          </p>
        )}
        {starter.stage && <StarterProgress stage={starter.stage} aerenderPath={install?.path ?? null} />}
        {submitError && (
          <p role="alert" className="text-sm text-destructive">
            {submitError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={saving} onClick={() => navigate(-1)}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Creating…" : "Create project"}
          </Button>
        </div>
      </form>
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && answerConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.kind === "unsaved" ? "Save your open project?" : "Close your open project?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "saved"
                ? `After Effects has “${confirm.name}” open. Murre will save it and close it, then create your new project.`
                : confirm?.kind === "unsaved"
                  ? `After Effects has a project that was never saved. Murre will save it to your Desktop${confirm.desktopDir ? ` (${confirm.desktopDir})` : ""} as Untitled-….aep and close it, then create your new project.`
                  : "After Effects has a project open. Murre will save it and close it, then create your new project."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => answerConfirm(true)}>Save and continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
