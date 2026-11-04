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

// The macOS window has an overlay title bar: the traffic lights sit on top of the page.
// This class lets the layout leave room for them (it does nothing on other systems).
if (/Mac/i.test(navigator.platform || navigator.userAgent)) document.documentElement.classList.add("is-mac")

applyAppearance()

// A file dropped anywhere that does not take it must not make the window open that file.
for (const ev of ["dragover", "drop"] as const) {
  window.addEventListener(ev, (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault()
  })
}

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
