import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { api, errorMessage, type Space } from "@/lib/tauri"

interface SpacesValue {
  spaces: Space[]
  loaded: boolean
  error: string | null
  reload: () => Promise<void>
  setSpaces: (s: Space[]) => void
}

const SpacesContext = createContext<SpacesValue | null>(null)

export function SpacesProvider({ children }: { children: ReactNode }) {
  const [spaces, setSpaces] = useState<Space[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setSpaces(await api.listSpaces())
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const value = useMemo(() => ({ spaces, loaded, error, reload, setSpaces }), [spaces, loaded, error, reload])
  return <SpacesContext.Provider value={value}>{children}</SpacesContext.Provider>
}

export function useSpaces() {
  const ctx = useContext(SpacesContext)
  if (!ctx) throw new Error("useSpaces must be used inside SpacesProvider")
  return ctx
}
