import React from "react"
import ReactDOM from "react-dom/client"
import { HashRouter } from "react-router"
import { ThemeProvider } from "next-themes"
import { MotionConfig } from "motion/react"
import App from "./App"
import { ProfileGate } from "@/features/profile/profile-gate"
import { ProfileProvider } from "@/features/profile/profile-context"
import { LoginOffer } from "@/features/startup/login-offer"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { applyAppearance } from "@/lib/preferences"
import "./App.css"
import { isMac } from "@/lib/platform"

// The macOS window has an overlay title bar: the traffic lights sit on top of the page.
// This class lets the layout leave room for them (it does nothing on other systems).
if (isMac) document.documentElement.classList.add("is-mac")

applyAppearance()

// A file dropped anywhere that does not take it must not make the window open that file.
for (const ev of ["dragover", "drop"] as const) {
  window.addEventListener(ev, (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault()
  })
}

// No browser right-click menu ("Open Link", "Download Linked File"…): this is an app, not a web page. Text fields
// keep theirs for Cut, Copy, Paste and spelling. Screens with their own menu (the reference board) handle it
// themselves. In a development build, hold Option (Alt) while right-clicking to get it back, for Inspect Element.
window.addEventListener("contextmenu", (e) => {
  if (import.meta.env.DEV && e.altKey) return
  const t = e.target
  if (t instanceof Element && t.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) return
  e.preventDefault()
})

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <HashRouter>
          <ProfileProvider>
            <ProfileGate>
              <App />
              <LoginOffer />
            </ProfileGate>
          </ProfileProvider>
        </HashRouter>
        <Toaster />
      </TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  </React.StrictMode>,
)
