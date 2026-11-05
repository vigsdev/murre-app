import { CheckCircle2, CircleAlert } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { api, errorMessage, type CompanionInstall } from "@/lib/tauri"
import { isWindows } from "@/lib/platform"

/** Murre can install the Companion itself only on macOS for now. */
export const canInstallCompanion = !isWindows

/** Whether the Companion is in After Effects' extension folder, and installing it. */
export function useCompanionInstall() {
  const [status, setStatus] = useState<CompanionInstall | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    api
      .getCompanionInstall()
      .then(setStatus)
      .catch((e) => setError(errorMessage(e)))
  }, [])
  useEffect(refresh, [refresh])

  const install = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await api.installCompanion())
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [])

  return { status, error, busy, install, refresh, ready: !!status?.installed && status.current }
}

/** The install button and what it did; shown in setup and in Settings. */
export function CompanionInstallCard({ state, bare }: { state: ReturnType<typeof useCompanionInstall>; bare?: boolean }) {
  const { status, error, busy, install, ready } = state
  const needsUpdate = !!status?.installed && !status.current
  if (!canInstallCompanion) {
    return (
      <div className={bare ? "flex flex-col gap-3 p-4" : "flex flex-col gap-3 rounded-lg border p-4"} data-testid="companion-card">
        <p className="flex items-start gap-2 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            Murre can’t install the Companion on Windows yet.
            <span className="block text-muted-foreground">
              Projects, notes, renders and everything else in Murre work without it. Installing it from here is coming in a
              later version.
            </span>
          </span>
        </p>
      </div>
    )
  }
  return (
    <div className={bare ? "flex flex-col gap-3 p-4" : "flex flex-col gap-3 rounded-lg border p-4"} data-testid="companion-card">
      {ready ? (
        <p className="flex items-start gap-2 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-hidden />
          <span>
            Companion installed{status?.devLink ? " (linked to your working copy)" : status?.installedVersion ? ` (version ${status.installedVersion})` : ""}.
            <span className="block text-muted-foreground">
              Restart After Effects once so it loads the Companion. If it is closed, nothing else is needed.
            </span>
          </span>
        </p>
      ) : (
        <p className="flex items-start gap-2 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
          <span>
            {needsUpdate ? "A newer Companion is available." : "The Companion is not installed."}
            <span className="block text-muted-foreground">
              It lets Murre create projects in After Effects, scan them and copy their files. It is copied to your own
              Adobe extensions folder; no administrator password is needed.
            </span>
          </span>
        </p>
      )}
      {status && !status.bundleAvailable && !ready && (
        <p className="text-sm text-destructive" role="alert">
          This version of Murre doesn’t have the Companion yet.
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {!ready && (
        <div>
          <Button type="button" disabled={busy || !status?.bundleAvailable} onClick={() => void install()}>
            {busy ? "Installing…" : needsUpdate ? "Update Companion" : "Install Companion"}
          </Button>
        </div>
      )}
    </div>
  )
}
