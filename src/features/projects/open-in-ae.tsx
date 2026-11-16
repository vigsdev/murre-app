import { listen } from "@tauri-apps/api/event"
import { ChevronDown, Clapperboard } from "lucide-react"
import { useCallback, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { api, errorMessage, type AerenderInstall, type OpenOutcome, type StarterStage } from "@/lib/tauri"
import { baseName } from "@/lib/platform"
import { StarterProgress } from "./starter-progress"

const KEY = "murre.openWithAfterEffects"

function remembered(): string | null {
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function remember(path: string | null) {
  try {
    if (path) window.localStorage.setItem(KEY, path)
    else window.localStorage.removeItem(KEY)
  } catch {
    // remembering the version is only a convenience
  }
}

/** The Open in After Effects that is running, for the progress card. One at a time. */
interface OpenRun {
  stage: StarterStage | null
  aerenderPath: string | null
}
let run: OpenRun | null = null
const listeners = new Set<() => void>()
const setRun = (next: OpenRun | null) => {
  run = next
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/**
 * Opens `path` (or the project's current file) in After Effects and says how it went. While Murre waits for After
 * Effects to start, the progress card shows each step.
 */
async function runOpen(projectId: string, path: string | null | undefined, aerenderPath: string | null): Promise<OpenOutcome> {
  if (run) throw new Error("Murre is already opening a project in After Effects.")
  setRun({ stage: null, aerenderPath })
  let off: (() => void) | undefined
  try {
    off = await listen<StarterStage>("open-progress", (e) => run && setRun({ ...run, stage: e.payload }))
  } catch {
    // Without events it still works; the card just doesn't show.
  }
  try {
    return await api.openInAfterEffects(projectId, path, aerenderPath)
  } finally {
    off?.()
    setRun(null)
  }
}

function announce(o: OpenOutcome) {
  if (o.cancelled) toast.message(o.message ?? "Nothing was opened.")
  else toast.success(`Opened ${baseName(o.path)} in After Effects`)
}

/**
 * Opens a project's current .aep in After Effects with the version chosen earlier (or the newest), for places
 * without the version menu, such as project cards. A remembered version that is gone is forgotten and the
 * newest is used instead.
 */
export async function openProjectInAfterEffects(projectId: string): Promise<void> {
  try {
    announce(await runOpen(projectId, null, remembered()))
  } catch (e) {
    if (remembered() && /not one of the installed versions/i.test(errorMessage(e))) {
      remember(null)
      try {
        announce(await runOpen(projectId, null, null))
        return
      } catch (e2) {
        toast.error(errorMessage(e2))
        return
      }
    }
    toast.error(errorMessage(e))
  }
}

/** Where Open in After Effects is while it waits for After Effects. Mounted once, in the app shell. */
export function OpenProgressCard() {
  const current = useSyncExternalStore(subscribe, () => run)
  if (!current?.stage) return null
  return (
    <div className="fixed right-4 bottom-4 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-lg bg-popover text-popover-foreground shadow-lg">
      <StarterProgress stage={current.stage} aerenderPath={current.aerenderPath} task="open" />
    </div>
  )
}

const labelOf = (i: AerenderInstall) => (i.version ? `${i.label} (${i.version})` : i.label)

/**
 * Opens a project's After Effects file in the chosen After Effects version. The chosen version is remembered;
 * with no choice the newest installed version is used.
 */
export function useOpenInAfterEffects(projectId: string) {
  const [installs, setInstalls] = useState<AerenderInstall[] | null>(null)
  const [choice, setChoice] = useState<string | null>(remembered)

  const loadInstalls = useCallback(() => {
    if (installs) return
    api
      .getAerenderStatus()
      .then((s) => {
        setInstalls(s.detected)
        // a remembered version that was uninstalled is forgotten
        setChoice((c) => {
          if (c && !s.detected.some((i) => i.path === c) && s.saved !== c) {
            remember(null)
            return null
          }
          return c
        })
      })
      .catch(() => setInstalls([]))
  }, [installs])

  const open = useCallback(
    async (path?: string) => {
      try {
        announce(await runOpen(projectId, path, choice))
      } catch (e) {
        toast.error(errorMessage(e))
      }
    },
    [projectId, choice],
  )

  const choose = useCallback((path: string | null) => {
    setChoice(path)
    remember(path)
  }, [])

  return { installs, choice, choose, loadInstalls, open }
}

type Controller = ReturnType<typeof useOpenInAfterEffects>

/** "Open in After Effects" with a small menu to pick which installed version to use. */
export function OpenInAfterEffects({ controller: c, variant = "outline" }: { controller: Controller; variant?: "outline" | "default" }) {
  return (
    <div className="inline-flex">
      <Button variant={variant} size="sm" className="rounded-r-none" aria-label="Open in After Effects" onClick={() => void c.open()}>
        <Clapperboard /> <span className="hidden lg:inline">Open in After Effects</span><span className="lg:hidden">Open in AE</span>
      </Button>
      <DropdownMenu onOpenChange={(o) => o && c.loadInstalls()}>
        <DropdownMenuTrigger
          render={<Button variant={variant} size="icon-sm" className="-ml-px rounded-l-none" aria-label="Choose which After Effects to open with" />}
        >
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Open with</DropdownMenuLabel>
            {c.installs === null ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">Looking for After Effects…</p>
            ) : c.installs.length === 0 ? (
              <p className="max-w-56 px-2 py-1.5 text-xs text-muted-foreground">
                No After Effects was found in Applications. The system default for .aep files is used.
              </p>
            ) : (
              <DropdownMenuRadioGroup value={c.choice ?? ""} onValueChange={(v) => c.choose(v || null)}>
                <DropdownMenuRadioItem value="" closeOnClick>Newest installed</DropdownMenuRadioItem>
                {c.installs.map((i) => (
                  <DropdownMenuRadioItem key={i.path} value={i.path} closeOnClick>
                    {labelOf(i)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
