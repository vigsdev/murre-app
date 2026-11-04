import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { api, errorMessage, type Profile } from "@/lib/tauri"

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; profile: Profile | null }

interface ProfileContextValue {
  state: State
  reload: () => void
  /** Pass `null` as `avatarBase64` to keep the existing avatar. Throws with a readable message on failure. */
  save: (name: string, role: string, avatarBase64: string | null) => Promise<void>
}

const ProfileContext = createContext<ProfileContextValue | null>(null)

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" })

  const reload = useCallback(() => {
    setState({ status: "loading" })
    api
      .getProfile()
      .then((profile) => setState({ status: "ready", profile }))
      .catch((e) => setState({ status: "error", message: errorMessage(e) }))
  }, [])

  useEffect(reload, [reload])

  const save = useCallback(async (name: string, role: string, avatarBase64: string | null) => {
    try {
      const profile = await api.saveProfile(name, role, avatarBase64)
      setState({ status: "ready", profile })
    } catch (e) {
      throw new Error(errorMessage(e))
    }
  }, [])

  const value = useMemo(() => ({ state, reload, save }), [state, reload, save])
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}

export function useProfileContext() {
  const ctx = useContext(ProfileContext)
  if (!ctx) throw new Error("useProfileContext must be used inside ProfileProvider")
  return ctx
}

/** The saved profile. Only call this below the first-launch gate, where a profile is guaranteed. */
export function useProfile(): Profile {
  const { state } = useProfileContext()
  if (state.status !== "ready" || !state.profile) throw new Error("No profile yet. Let’s fix that.")
  return state.profile
}
