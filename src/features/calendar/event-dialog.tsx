import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/date-picker"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { CalendarEvent, EventInput } from "@/lib/tauri"

interface Props {
  open: boolean
  /** The event being edited, or null to add a new one. */
  event: CalendarEvent | null
  defaultDate: string
  onOpenChange: (open: boolean) => void
  /** Resolve to an error message to keep the dialog open, or null when saved. */
  onSubmit: (input: EventInput) => Promise<string | null>
}

export function EventDialog({ open, event, defaultDate, onOpenChange, onSubmit }: Props) {
  const [title, setTitle] = useState("")
  const [date, setDate] = useState<string | null>(defaultDate)
  const [notes, setNotes] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle(event?.title ?? "")
    setDate(event?.date ?? defaultDate)
    setNotes(event?.notes ?? "")
    setError(null)
    setBusy(false)
  }, [open, event, defaultDate])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return setError("Please enter a title for the event.")
    if (!date) return setError("Please pick a date.")
    setBusy(true)
    const message = await onSubmit({ title, date, notes: notes.trim() ? notes : null })
    setBusy(false)
    if (message) setError(message)
    else onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{event ? "Edit event" : "Add event"}</DialogTitle>
          <DialogDescription>Events are your own reminders. Project deadlines are managed from the project.</DialogDescription>
        </DialogHeader>
        <form id="event-form" onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="event-title">Title</Label>
            <Input
              id="event-title"
              autoFocus
              maxLength={120}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                setError(null)
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="event-date">Date</Label>
            <DatePicker
              id="event-date"
              value={date}
              onChange={(v) => {
                setDate(v)
                setError(null)
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="event-notes">Notes (optional)</Label>
            <Textarea id="event-notes" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="event-form" disabled={busy}>
            {event ? "Save" : "Add event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
