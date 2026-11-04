import { useEffect, useState } from "react"
import { api, type AeInstall, type AeInstalls } from "@/lib/tauri"

/** "Adobe After Effects 2026 (26.0)". */
export const installName = (i: AeInstall) => (i.version ? `${i.label} (${i.version})` : i.label)

/**
 * The detected After Effects installs. `null` while loading; if they cannot be read, an empty list, so the
 * screens that use this keep working without them.
 */
export function useAeInstalls(): AeInstalls | null {
  const [installs, setInstalls] = useState<AeInstalls | null>(null)
  useEffect(() => {
    let live = true
    api
      .getAeInstalls()
      .then((o) => live && setInstalls(o))
      .catch(() => live && setInstalls({ installs: [], savedPath: null }))
    return () => {
      live = false
    }
  }, [])
  return installs
}

/** The install to preselect: the one chosen earlier, else the newest found. */
export function defaultInstall(o: AeInstalls | null): AeInstall | null {
  if (!o) return null
  return o.installs.find((i) => i.path === o.savedPath) ?? o.installs[0] ?? null
}
