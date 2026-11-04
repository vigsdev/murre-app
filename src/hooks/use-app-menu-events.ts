import { listen } from "@tauri-apps/api/event"
import { useEffect } from "react"
import { useNavigate } from "react-router"
import { flushAll } from "@/lib/flush-registry"

/**
 * What the menu bar and the updater ask the page to do: open Settings (Cmd+,), and save open notes and the
 * reference canvas just before an update restarts the app.
 */
export function useAppMenuEvents() {
  const navigate = useNavigate()
  useEffect(() => {
    const offs: (() => void)[] = []
    let cancelled = false
    const on = (name: string, run: () => void) => {
      try {
        void listen(name, run)
          .then((off) => (cancelled ? off() : offs.push(off)))
          .catch(() => {})
      } catch {
        // Not running inside the app (a browser): nothing to listen to.
      }
    }
    on("menu:open-settings", () => navigate("/settings"))
    on("flush-before-restart", () => void flushAll())
    return () => {
      cancelled = true
      offs.forEach((off) => off())
    }
  }, [navigate])
}
