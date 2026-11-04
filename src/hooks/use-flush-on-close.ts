import { getCurrentWindow } from "@tauri-apps/api/window"
import { useEffect } from "react"
import { flushAll } from "@/lib/flush-registry"

/** How long closing the window waits for pending saves before it closes anyway. */
const MAX_WAIT_MS = 3000

/**
 * Closing the window (it only hides; the app stays in the menu bar) while a note or the reference canvas has unsaved edits writes them first.
 * (Hiding the window or switching tabs already saves; closing the window did not wait for the save.)
 */
export function useFlushOnClose() {
  useEffect(() => {
    let off: (() => void) | undefined
    let cancelled = false
    try {
      const win = getCurrentWindow()
      void win
        .onCloseRequested(async (event) => {
          event.preventDefault()
          await Promise.race([flushAll(), new Promise((r) => window.setTimeout(r, MAX_WAIT_MS))])
          // The app hides itself to the menu bar; it keeps running until the user quits.
        })
        .then((unlisten) => {
          if (cancelled) unlisten()
          else off = unlisten
        })
        .catch(() => {})
    } catch {
      // not running inside the app window (for example in a browser): nothing to do
    }
    return () => {
      cancelled = true
      off?.()
    }
  }, [])
}
