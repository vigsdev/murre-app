import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api, errorMessage } from "@/lib/tauri"
import { useStartup } from "./use-startup"

/** Asked once, after the profile exists: open Murre at login and wait quietly in the menu bar? Off unless the person says yes. */
export function LoginOffer() {
  const { info } = useStartup()
  const [closed, setClosed] = useState(false)
  const [busy, setBusy] = useState(false)
  const open = !closed && info !== null && info.available && !info.asked && !info.enabled

  const answer = async (yes: boolean) => {
    setBusy(true)
    try {
      if (yes) await api.setLaunchAtLogin(true)
      else await api.dismissLoginOffer()
      setClosed(true)
    } catch (e) {
      toast.error(errorMessage(e))
      setClosed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && void answer(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open Murre when you log in?</DialogTitle>
          <DialogDescription>
            Murre will hang out quietly in your menu bar and keep projects ready. Change this any time in Settings.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void answer(false)}>
            Not now
          </Button>
          <Button disabled={busy} onClick={() => void answer(true)}>
            Open at login
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
