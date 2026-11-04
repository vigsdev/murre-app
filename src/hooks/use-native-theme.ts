import { useEffect } from "react"
import { useTheme } from "next-themes"
import { getCurrentWindow } from "@tauri-apps/api/window"

/**
 * Keeps the native window's appearance in step with the theme chosen in Settings. On macOS the translucent
 * sidebar takes its light or dark blur from the window, so without this a Light app on a Dark Mac has dark glass.
 * "System" hands control back to macOS. It does nothing outside the desktop app.
 */
export function useNativeTheme() {
  const { theme } = useTheme()
  useEffect(() => {
    const native = theme === "light" || theme === "dark" ? theme : null
    try {
      getCurrentWindow()
        .setTheme(native)
        .catch(() => undefined)
    } catch {
      // Not running inside the desktop app.
    }
  }, [theme])
}
