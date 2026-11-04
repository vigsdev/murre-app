import { TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { api, errorMessage, type ProjectSettings } from "@/lib/tauri"

const INTERVALS = [
  { value: "0", label: "Off" },
  { value: "5", label: "Every 5 minutes" },
  { value: "10", label: "Every 10 minutes" },
  { value: "20", label: "Every 20 minutes" },
]

/** Companion settings for this project. They are saved in the project folder and apply to the next scan. */
export function SettingsTab({ projectId }: { projectId: string }) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The Companion panel's right-click menu changes the same settings file, so look again when the window comes back into focus.
  useEffect(() => {
    let live = true
    const load = () =>
      api
        .getProjectSettings(projectId)
        .then((s) => live && setSettings(s))
        .catch((e) => live && setError(errorMessage(e)))
    void load()
    window.addEventListener("focus", load)
    return () => {
      live = false
      window.removeEventListener("focus", load)
    }
  }, [projectId])

  async function change(patch: Partial<ProjectSettings>) {
    if (!settings) return
    const before = settings
    const next = { ...settings, ...patch }
    if (!next.copyRelinkOnScan) next.trashOriginals = false
    setSettings(next)
    try {
      setSettings(await api.saveProjectSettings(projectId, next))
    } catch (e) {
      setSettings(before)
      toast.error(errorMessage(e))
    }
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn’t read this project's settings.</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }
  if (!settings) return <Skeleton className="h-48 max-w-2xl" />
  // A project saved with an older choice (15 or 30 minutes) keeps showing it until a new one is picked.
  const intervals = INTERVALS.some((o) => o.value === String(settings.autoScanMinutes))
    ? INTERVALS
    : [...INTERVALS, { value: String(settings.autoScanMinutes), label: `Every ${settings.autoScanMinutes} minutes` }]

  return (
    <div className="flex max-w-2xl flex-col gap-6" data-testid="settings-tab">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">After Effects Companion</h3>
        <p className="text-sm text-muted-foreground">
          These apply to this project only and are saved inside its folder. They are used the next time it is scanned.
        </p>
      </div>

      <Field orientation="horizontal">
        <Checkbox
          id="copy-relink"
          checked={settings.copyRelinkOnScan}
          onCheckedChange={(v) => void change({ copyRelinkOnScan: v === true })}
        />
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor="copy-relink" className="font-normal">
            Copy and relink automatically on every scan
          </FieldLabel>
          <FieldDescription>
            Files the project uses from outside its folder (Downloads, for example) are copied into “02 Assets”, and After Effects
            is pointed at the copies. Save the project in After Effects afterwards.
          </FieldDescription>
        </div>
      </Field>

      <Field orientation="horizontal">
        <Checkbox
          id="trash-originals"
          checked={settings.trashOriginals}
          disabled={!settings.copyRelinkOnScan}
          onCheckedChange={(v) => void change({ trashOriginals: v === true })}
        />
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor="trash-originals" className="font-normal">
            Move the original files to the Trash after they are copied
          </FieldLabel>
          <FieldDescription>
            Each original is moved only after its copy in the project is checked. They go to the Trash, not deleted, so you can
            put them back. Other projects that use the same file will lose it until you do.
            {!settings.copyRelinkOnScan && " Turn on automatic copying first."}
          </FieldDescription>
        </div>
      </Field>

      <Field>
        <FieldLabel htmlFor="auto-scan">Auto-scan (less babysitting)</FieldLabel>
        <Select
          items={intervals}
          value={String(settings.autoScanMinutes)}
          onValueChange={(v) => v && void change({ autoScanMinutes: Number(v) })}
        >
          <SelectTrigger id="auto-scan" className="w-full max-w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {intervals.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          Scans this project while it is open in After Effects and Murre is running. The first scan comes after the interval.
        </FieldDescription>
      </Field>

      <Alert>
        <TriangleAlert />
        <AlertTitle>Working with huge footage?</AlertTitle>
        <AlertDescription>
          Scanning and copying large files can interrupt your work in After Effects for a while. For heavy projects, keep these
          off and scan by hand once in a while to keep the app up to date.
        </AlertDescription>
      </Alert>
    </div>
  )
}
