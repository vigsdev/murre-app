import { ChevronDown, Clapperboard } from "lucide-react"
import { useCallback, useState } from "react"
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
import { api, errorMessage, type AerenderInstall } from "@/lib/tauri"
import { baseName } from "@/lib/platform"

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

/**
 * Opens a project's current .aep in After Effects with the version chosen earlier (or the newest), for places
 * without the version menu, such as project cards. A remembered version that is gone is forgotten and the
 * newest is used instead.
 */
export async function openProjectInAfterEffects(projectId: string): Promise<void> {
  const show = (opened: string) => toast.success(`Opening ${baseName(opened)} in After Effects`)
  try {
    show(await api.openInAfterEffects(projectId, null, remembered()))
  } catch (e) {
    if (remembered() && /not one of the installed versions/i.test(errorMessage(e))) {
      remember(null)
      try {
        show(await api.openInAfterEffects(projectId, null, null))
        return
      } catch (e2) {
        toast.error(errorMessage(e2))
        return
      }
    }
    toast.error(errorMessage(e))
  }
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
        const opened = await api.openInAfterEffects(projectId, path, choice)
        toast.success(`Opening ${baseName(opened)} in After Effects`)
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
