import { listen } from "@tauri-apps/api/event"
import { Loader2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { api, errorMessage, type CreateOutcome, type StarterStage } from "@/lib/tauri"

/**
 * Runs "make this project's first .aep in After Effects" and follows its progress. Used by New Project and by the
 * Project tab's "Create in After Effects".
 */
export function useStarter() {
  const [stage, setStage] = useState<StarterStage | null>(null)
  const [running, setRunning] = useState(false)
  const unlisten = useRef<(() => void) | null>(null)

  useEffect(() => () => unlisten.current?.(), [])

  const run = useCallback(async (projectId: string, aerenderPath: string | null, alreadyAsked = false): Promise<CreateOutcome> => {
    setRunning(true)
    setStage({ stage: "launching" })
    try {
      unlisten.current = await listen<StarterStage>("starter-progress", (e) => setStage(e.payload))
    } catch {
      // Without events it still works; the screen just shows the first stage.
    }
    try {
      return await api.createStarterInAfterEffects(projectId, aerenderPath, alreadyAsked)
    } finally {
      unlisten.current?.()
      unlisten.current = null
      setRunning(false)
      setStage(null)
    }
  }, [])

  return { stage, running, run }
}

const OPEN_YOURSELF: Record<"launchFailed" | "notStarted" | "closed", string> = {
  launchFailed: "Murre couldn’t start After Effects.",
  notStarted: "After Effects didn’t open.",
  closed: "After Effects closed before the project file was made.",
}

/** The line under the spinner for each stage. */
function line(s: StarterStage): string {
  switch (s.stage) {
    case "launching":
      return "Starting After Effects…"
    case "waiting":
      return "Waiting for After Effects to finish opening…"
    case "needsYou":
      return "After Effects may be showing a message, like a missing drive or a crash notice. Answer it in After Effects and Murre will carry on."
    case "noCompanion":
      return "After Effects is open, but the Murre Companion hasn’t connected. If After Effects is showing a message, answer it. Otherwise restart After Effects once, or check the Companion in Settings."
    case "openYourself":
      return `${OPEN_YOURSELF[s.reason]} Open it yourself, then come back and press “I’ve opened After Effects”.`
    case "checking":
      return "Checking what’s open in After Effects…"
    case "confirm":
      return "Waiting for your answer…"
    case "creating":
      return `Creating ${s.file}…`
    case "creatingSlow":
      return `Still creating ${s.file}. If After Effects is showing a message, answer it there.`
  }
}

/** Stages where After Effects is probably waiting for the person, so bringing it forward helps. */
const SHOW_AE = new Set<StarterStage["stage"]>(["waiting", "needsYou", "noCompanion", "creatingSlow"])

export function StarterProgress({ stage, aerenderPath }: { stage: StarterStage; aerenderPath: string | null }) {
  const [cancelling, setCancelling] = useState(false)
  const act = (fn: () => Promise<void>) => fn().catch((e) => toast.error(errorMessage(e)))
  const manual = stage.stage === "openYourself"
  const attention = manual || stage.stage === "needsYou" || stage.stage === "noCompanion" || stage.stage === "creatingSlow"

  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3 rounded-lg border p-4">
      <p className="flex items-start gap-2 text-sm">
        {!manual && <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
        <span className={attention ? "text-foreground" : "text-muted-foreground"}>{line(stage)}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        {manual && (
          <Button type="button" size="sm" onClick={() => void act(api.starterOpened)}>
            I’ve opened After Effects
          </Button>
        )}
        {SHOW_AE.has(stage.stage) && (
          <Button type="button" size="sm" variant="outline" onClick={() => void act(() => api.showAfterEffects(aerenderPath))}>
            Show After Effects
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={cancelling}
          onClick={() => {
            setCancelling(true)
            void act(api.starterCancel)
          }}
        >
          {cancelling ? "Stopping…" : "Cancel"}
        </Button>
      </div>

      <AlertDialog open={stage.stage === "confirm"} onOpenChange={(o) => !o && void act(() => api.starterAnswer(false))}>
        {stage.stage === "confirm" && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{stage.kind === "unsaved" ? "Save your open project?" : "Close your open project?"}</AlertDialogTitle>
              <AlertDialogDescription>
                {stage.kind === "saved"
                  ? `After Effects now has “${stage.name}” open. Murre will save it and close it, then create your new project.`
                  : stage.kind === "unsaved"
                    ? `After Effects now has a project that was never saved. Murre will save it to your Desktop${stage.desktopDir ? ` (${stage.desktopDir})` : ""} as Untitled-….aep and close it, then create your new project.`
                    : "After Effects may have a project open. Murre will save it and close it, then create your new project."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void act(() => api.starterAnswer(true))}>Save and continue</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  )
}

/** The toasts for how it ended. */
export function announceStarter(outcome: CreateOutcome, baseName: (p: string) => string) {
  if (outcome.added) toast.success(`Created ${baseName(outcome.added)} in After Effects`)
  else if (outcome.cancelled) toast.message(outcome.message ?? "Stopped.")
  else toast.error(outcome.message ?? "After Effects could not create the project.")
  if (outcome.previous) toast.message(`Your previous After Effects project was saved at ${outcome.previous}`)
}
