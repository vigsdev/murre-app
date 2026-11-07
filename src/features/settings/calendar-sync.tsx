import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { api, errorMessage, type CalendarSync, type CalendarSyncReport } from "@/lib/tauri"

/** How often Settings re-reads the sync while it is on, so "Last updated" stays honest. */
const REFRESH_MS = 10_000

export function useCalendarSync() {
  const [status, setStatus] = useState<CalendarSync | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getCalendarSync())
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!status?.enabled) return
    const timer = window.setInterval(() => void refresh(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [status?.enabled, refresh])

  const run = async (action: () => Promise<CalendarSync>) => {
    setBusy(true)
    try {
      setStatus(await action())
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return {
    status,
    busy,
    setEnabled: (on: boolean) => run(() => api.setCalendarSync(on)),
    remove: () => run(() => api.removeMurreCalendar()),
  }
}

function lastLine(last: CalendarSyncReport | null): string | null {
  if (!last) return null
  const time = new Date(last.at * 1000).toLocaleTimeString(undefined, { timeStyle: "short" })
  if (last.error) return `Last try at ${time} didn’t work: ${last.error}`
  const parts = [
    last.created && `${last.created} added`,
    last.updated && `${last.updated} changed`,
    last.removed && `${last.removed} removed`,
  ].filter(Boolean)
  return `Up to date as of ${time}${parts.length ? ` (${parts.join(", ")})` : ""}.`
}

/** What the switch row says, for each state macOS and Murre can be in. */
function describe(s: CalendarSync): string {
  if (s.access === "denied" || s.access === "restricted")
    return "macOS isn’t letting Murre use Calendar. Allow it in System Settings, then turn this on."
  if (s.access === "writeOnly")
    return "Murre can only add events, so it can’t keep them up to date. Give it full access in System Settings."
  if (s.enabled) return "Your deadlines and events are in a calendar called “Murre”. Changes show up there within a few seconds."
  return "Adds a calendar called “Murre” with your project deadlines and events. Murre only changes events in that calendar."
}

export function CalendarSyncRows({ state, Row }: { state: ReturnType<typeof useCalendarSync>; Row: RowComponent }) {
  const { status, busy, setEnabled, remove } = state
  const [confirming, setConfirming] = useState(false)
  if (!status) return null
  const blocked = status.access === "denied" || status.access === "restricted" || status.access === "writeOnly"
  const last = status.enabled ? lastLine(status.last) : null

  return (
    <>
      <Row
        title="Show in Apple Calendar"
        htmlFor="calendar-sync"
        description={
          <>
            {describe(status)}
            {last && <span className="block">{last}</span>}
            {blocked && (
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void api.openCalendarPrivacy()}>
                Open System Settings
              </Button>
            )}
          </>
        }
      >
        <Checkbox
          id="calendar-sync"
          checked={status.enabled}
          disabled={busy || (blocked && !status.enabled)}
          onCheckedChange={(v) => void setEnabled(v === true)}
        />
      </Row>
      <Row
        title="Remove the Murre calendar"
        description="Deletes the “Murre” calendar and its events from Calendar, and stops adding them. Your other calendars aren’t touched."
      >
        <Button type="button" variant="outline" size="sm" disabled={busy || status.access !== "full"} onClick={() => setConfirming(true)}>
          Remove
        </Button>
      </Row>

      <AlertDialog open={confirming} onOpenChange={(o) => !o && !busy && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the Murre calendar?</AlertDialogTitle>
            <AlertDialogDescription>
              The “Murre” calendar and every event in it are deleted from Calendar, on this Mac and anywhere it syncs.
              Your deadlines and events in Murre stay as they are, and you can turn this on again any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirming(false)
                void remove()
              }}
            >
              Remove calendar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

type RowComponent = (props: { title: string; description?: React.ReactNode; htmlFor?: string; children?: React.ReactNode }) => React.ReactNode
