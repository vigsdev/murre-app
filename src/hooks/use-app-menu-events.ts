import { listen } from "@tauri-apps/api/event"
import { useEffect } from "react"
import { useNavigate } from "react-router"
import { flushAll } from "@/lib/flush-registry"
import { isMac } from "@/lib/platform"

/**
 * What the menu bar and the updater ask the page to do: open Settings (Cmd+,), and save open notes and the
 * reference canvas just before an update restarts the app. Windows has no app menu, so Ctrl+, is handled here.
 * The Companion panel's Package button also lands here: it opens that project with its Package window.
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
    try {
      void listen<{ projectId: string | null; open: string | null }>("companion-show", (e) => {
        const id = e.payload?.projectId
        if (id && e.payload.open === "package") navigate(`/projects/${encodeURIComponent(id)}?package=1`)
      })
        .then((off) => (cancelled ? off() : offs.push(off)))
        .catch(() => {})
    } catch {
      // Not running inside the app.
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key === ",") {
        e.preventDefault()
        navigate("/settings")
      }
    }
    if (!isMac) window.addEventListener("keydown", onKey)
    return () => {
      cancelled = true
      offs.forEach((off) => off())
      window.removeEventListener("keydown", onKey)
    }
  }, [navigate])
}
