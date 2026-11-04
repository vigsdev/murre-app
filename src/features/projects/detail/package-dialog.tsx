import { recordGreetingEvent } from "@/features/home/greetings/events"
import { listen } from "@tauri-apps/api/event"
import { open as pickFolder } from "@tauri-apps/plugin-dialog"
import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { Check, FolderSearch, PackageOpen, TriangleAlert } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes } from "@/lib/format"
import { api, errorMessage, type PackageCheck, type PackageProgress, type PackageReport } from "@/lib/tauri"
import { cn } from "@/lib/utils"

type Format = "folder" | "zip" | "both"

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; check: PackageCheck }

function Row({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />}
      <span className="min-w-0 break-words">{children}</span>
    </li>
  )
}

function names(list: string[], total: number) {
  return list.join(", ") + (total > list.length ? ` and ${total - list.length} more` : "")
}

/**
 * Package for delivery: checks the project for what would show up as color bars on the other side, then copies the
 * workfile, the footage it uses and (if asked) the fonts into a clean folder and/or zip. Nothing in the project changes.
 */
export function PackageDialog({ projectId, projectName, open, onOpenChange }: { projectId: string; projectName: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [format, setFormat] = useState<Format>("folder")
  const [fonts, setFonts] = useState(true)
  const [versions, setVersions] = useState(false)
  const [projectNotes, setProjectNotes] = useState(false)
  const [anyway, setAnyway] = useState(false)
  const [dest, setDest] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<PackageProgress | null>(null)
  const [report, setReport] = useState<PackageReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoad({ status: "loading" })
    setReport(null)
    setError(null)
    setAnyway(false)
    setDest(null)
    api
      .packageCheck(projectId)
      .then((check) => !cancelled && setLoad({ status: "ready", check }))
      .catch((e) => !cancelled && setLoad({ status: "error", message: errorMessage(e) }))
    return () => {
      cancelled = true
    }
  }, [open, projectId])

  useEffect(() => {
    if (!running) return
    let off: (() => void) | null = null
    let cancelled = false
    void listen<PackageProgress>("package-progress", (e) => setProgress(e.payload))
      .then((fn) => (cancelled ? fn() : (off = fn)))
      .catch(() => {})
    return () => {
      cancelled = true
      off?.()
    }
  }, [running])

  const check = load.status === "ready" ? load.check : null
  const problems = check ? check.footageMissingTotal + check.footageOutsideTotal : 0
  const bundleable = check ? check.fonts.filter((f) => f.bundle).length : 0
  const pn = check?.projectNotes
  const hasProjectNotes = !!pn && pn.notePages + pn.todos + pn.referenceFiles > 0
  const destination = dest ?? check?.defaultDestination ?? ""
  const size = useMemo(() => {
    if (!check) return 0
    return check.totalBytes + (projectNotes ? check.projectNotes.referenceBytes : 0) + (fonts ? check.fontsBytes : 0) + (versions ? check.otherVersions.reduce((n, v) => n + v.sizeBytes, 0) : 0)
  }, [check, fonts, versions, projectNotes])
  const canRun = !!check?.workfile && !running && (problems === 0 || anyway)

  async function choose() {
    const picked = await pickFolder({ directory: true, multiple: false, defaultPath: destination || undefined })
    if (typeof picked === "string") setDest(picked)
  }

  async function run() {
    if (!check) return
    setRunning(true)
    setError(null)
    setProgress({ doneBytes: 0, totalBytes: size, step: "Getting ready" })
    try {
      const built = await api.packageBuild(projectId, {
        destination,
        includeFonts: fonts,
        includeOtherVersions: versions,
        includeProjectNotes: projectNotes && hasProjectNotes,
        format,
        allowProblems: anyway,
      })
      setReport(built)
      recordGreetingEvent("packaged", projectName)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRunning(false)
    }
  }

  const pct = progress && progress.totalBytes > 0 ? Math.min(100, Math.round((progress.doneBytes / progress.totalBytes) * 100)) : 0

  return (
    <Dialog open={open} onOpenChange={(v) => !running && onOpenChange(v)}>
      <DialogContent className="max-h-[90svh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Package for delivery</DialogTitle>
          <DialogDescription>A clean folder with the current workfile, the footage it uses and a note on what it needs. Your project isn’t touched.</DialogDescription>
        </DialogHeader>

        {load.status === "loading" && <Skeleton className="h-48" />}
        {load.status === "error" && (
          <Alert variant="destructive">
            <AlertDescription>{load.message}</AlertDescription>
          </Alert>
        )}

        {check && !report && (
          <div className="flex flex-col gap-4">
            {!check.workfile ? (
              <Alert variant="destructive">
                <AlertDescription>There’s no After Effects file in this project yet. Nothing to package.</AlertDescription>
              </Alert>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="package-checks">
                <Row ok>
                  Packing <strong>{check.workfile.name}</strong> ({formatBytes(check.workfile.sizeBytes)}).
                </Row>
                {!check.scanned ? (
                  <Row ok={false}>This project hasn’t been scanned, so Murre doesn’t know which footage it uses. Scan it first.</Row>
                ) : (
                  <>
                    {check.stale && <Row ok={false}>The workfile was saved after the last scan. Scan again so this list is current.</Row>}
                    <Row ok>
                      {check.footageInside} footage {check.footageInside === 1 ? "file" : "files"} inside the project ({formatBytes(check.footageInsideBytes)}).
                    </Row>
                    {check.footageMissingTotal > 0 && (
                      <Row ok={false}>
                        {check.footageMissingTotal} footage {check.footageMissingTotal === 1 ? "file" : "files"} can’t be found: {names(check.footageMissing, check.footageMissingTotal)}. Expect color bars.
                      </Row>
                    )}
                    {check.footageOutsideTotal > 0 && (
                      <Row ok={false}>
                        {check.footageOutsideTotal} {check.footageOutsideTotal === 1 ? "file lives" : "files live"} outside the project folder: {names(check.footageOutside, check.footageOutsideTotal)}.
                        Copy {check.footageOutsideTotal === 1 ? "it" : "them"} in from the Assets tab first.
                      </Row>
                    )}
                  </>
                )}
                {check.premiereFiles.length > 0 && <Row ok>Premiere Pro comes along: {check.premiereFiles.join(", ")}.</Row>}
                {check.fonts.length > 0 && (
                  <Row ok>
                    {check.fonts.length} {check.fonts.length === 1 ? "font" : "fonts"}: {bundleable} can come along.
                    {check.fonts.length > bundleable && " The rest are Adobe Fonts, come with macOS, or aren’t on this Mac. They’re listed in the note."}
                  </Row>
                )}
                {check.plugins.length > 0 && <Row ok>The other person needs these plugins: {check.plugins.join(", ")}. They go in the note.</Row>}
                {check.aeVersion && <Row ok>Last scanned in After Effects {check.aeVersion}. That goes in the note too.</Row>}
              </ul>
            )}

            {check.workfile && (
              <>
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Make a</p>
                  <div className="flex gap-2" role="radiogroup" aria-label="Package format">
                    {(
                      [
                        ["folder", "Folder"],
                        ["zip", "Zip"],
                        ["both", "Both"],
                      ] as const
                    ).map(([v, label]) => (
                      <Button key={v} type="button" role="radio" aria-checked={format === v} size="sm" variant={format === v ? "default" : "outline"} onClick={() => setFormat(v)}>
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>

                <label className={cn("flex cursor-pointer items-start gap-2 text-sm", bundleable === 0 && "opacity-50")}>
                  <Checkbox checked={fonts && bundleable > 0} disabled={bundleable === 0} onCheckedChange={(c) => setFonts(!!c)} />
                  <span>
                    Include the fonts installed on this Mac ({bundleable})
                    <span className="block text-xs text-muted-foreground">Check that each font’s license lets you share it.</span>
                  </span>
                </label>
                {check.otherVersions.length > 0 && (
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox checked={versions} onCheckedChange={(c) => setVersions(!!c)} />
                    Include the {check.otherVersions.length} older {check.otherVersions.length === 1 ? "version" : "versions"}
                  </label>
                )}
                <label className={cn("flex cursor-pointer items-start gap-2 text-sm", !hasProjectNotes && "opacity-50")}>
                  <Checkbox checked={projectNotes && hasProjectNotes} disabled={!hasProjectNotes} onCheckedChange={(c) => setProjectNotes(!!c)} />
                  <span>
                    Include the notes, to-do and references
                    <span className="block text-xs text-muted-foreground">
                      {hasProjectNotes && pn
                        ? [
                            pn.notePages > 0 && `${pn.notePages} note ${pn.notePages === 1 ? "page" : "pages"}`,
                            pn.todos > 0 && `${pn.todos} ${pn.todos === 1 ? "to-do" : "to-dos"}`,
                            pn.referenceFiles > 0 && `${pn.referenceFiles} reference ${pn.referenceFiles === 1 ? "file" : "files"}`,
                          ]
                            .filter(Boolean)
                            .join(", ") + ". They go in a Project notes folder as plain text and files."
                        : "This project has none yet."}
                    </span>
                  </span>
                </label>
                {problems > 0 && (
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox checked={anyway} onCheckedChange={(c) => setAnyway(!!c)} />
                    Package it anyway, I know about the missing footage
                  </label>
                )}

                <div className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm">
                  <span className="min-w-0 truncate" title={destination}>
                    Save in <span className="text-muted-foreground">{destination}</span>
                  </span>
                  <Button type="button" size="xs" variant="outline" disabled={running} onClick={() => void choose()}>
                    Change…
                  </Button>
                </div>
              </>
            )}

            {running && progress && (
              <div className="flex flex-col gap-1" role="status">
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {progress.step} · {formatBytes(progress.doneBytes)} of {formatBytes(progress.totalBytes)}
                </p>
              </div>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {report && (
          <div className="flex flex-col gap-3" role="status">
            <p className="flex items-center gap-2 text-sm font-medium">
              <PackageOpen className="size-4" /> Packed {report.files} {report.files === 1 ? "file" : "files"} ({formatBytes(report.bytes)}).
            </p>
            <p className="text-sm text-muted-foreground break-all">{report.zip ?? report.folder}</p>
            {report.fontsIncluded > 0 && <p className="text-xs text-muted-foreground">{report.fontsIncluded} {report.fontsIncluded === 1 ? "font" : "fonts"} are in the Fonts folder. The other person installs them before opening the project.</p>}
          </div>
        )}

        <DialogFooter>
          {report ? (
            <>
              <Button
                variant="outline"
                onClick={() => void revealItemInDir((report.zip ?? report.folder)!).catch((e) => toast.error(errorMessage(e)))}
              >
                <FolderSearch /> Show in Finder
              </Button>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={running} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={!canRun} onClick={() => void run()}>
                {running ? "Packing…" : `Make package${size ? ` (${formatBytes(size)})` : ""}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
