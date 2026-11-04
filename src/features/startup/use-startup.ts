import { useCallback, useEffect, useState } from "react"
import { api, type StartupInfo } from "@/lib/tauri"

/** Whether Murre opens at login. `null` until the first answer arrives. */
export function useStartup() {
  const [info, setInfo] = useState<StartupInfo | null>(null)
  const refresh = useCallback(() => {
    api.getStartup().then(setInfo).catch(() => setInfo(null))
  }, [])
  useEffect(refresh, [refresh])
  return { info, refresh }
}
