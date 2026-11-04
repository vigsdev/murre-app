import { Pencil, Plus, Trash2 } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { listItem } from "@/lib/motion"
import { Link } from "react-router"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/date-picker"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { CalendarEvent, ProjectRecord } from "@/lib/tauri"
import { priorityLabel, statusLabel } from "../projects/project-utils"
import { parseIso } from "./date-utils"

interface Props {
  day: string | null
  deadlines: ProjectRecord[]
  events: CalendarEvent[]
  busyProjectId: string | null
  onClose: () => void
  onAddEvent: () => void
  onEditEvent: (e: CalendarEvent) => void
  onDeleteEvent: (e: CalendarEvent) => void
  onChangeDeadline: (p: ProjectRecord, deadline: string | null) => void
}

export function DaySheet({ day, deadlines, events, busyProjectId, onClose, onAddEvent, onEditEvent, onDeleteEvent, onChangeDeadline }: Props) {
  return (
    <Sheet open={day !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {day && (
          <>
            <SheetHeader>
              <SheetTitle>{parseIso(day).toLocaleDateString(undefined, { dateStyle: "full" })}</SheetTitle>
              <SheetDescription>Deadlines and your events for this day.</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-5 px-4 pb-4">
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Project deadlines</h3>
                {deadlines.length === 0 && <p className="text-sm text-muted-foreground">No deadlines today. Enjoy this rare moment.</p>}
                {deadlines.map((p) => (
                  <div key={p.id} className="flex flex-col gap-2 rounded-xl border p-3">
                    <div className="flex items-center gap-2">
                      {p.available ? (
                        <Link to={`/projects/${p.id}`} className="min-w-0 flex-1 truncate font-medium underline-offset-4 hover:underline">
                          {p.name}
                        </Link>
                      ) : (
                        <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                      )}
                      <Badge variant="secondary">{statusLabel(p.status)}</Badge>
                      <Badge variant="outline">{priorityLabel(p.priority)}</Badge>
                    </div>
                    {p.available ? (
                      <div aria-busy={busyProjectId === p.id}>
                        <DatePicker
                          disablePast
                          value={p.deadline}
                          placeholder="No deadline. Lucky you."
                          onChange={(v) => busyProjectId === null && onChangeDeadline(p, v)}
                        />
                        <p className="mt-1 text-xs text-muted-foreground">Changing the date updates the project's own metadata.</p>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">The project folder is not available, so its deadline can't be changed now.</p>
                    )}
                  </div>
                ))}
              </section>

              <section className="flex flex-col gap-2">
                <div className="flex items-center">
                  <h3 className="text-sm font-medium">Events</h3>
                  <Button size="xs" variant="outline" className="ml-auto" onClick={onAddEvent}>
                    <Plus data-icon="inline-start" /> Add event
                  </Button>
                </div>
                {events.length === 0 && <p className="text-sm text-muted-foreground">Nothing planned. Suspiciously peaceful.</p>}
                <AnimatePresence initial={false}>
                {events.map((e) => (
                  <motion.div key={e.id} {...listItem} className="flex items-start gap-2 rounded-xl border p-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words font-medium">{e.title}</p>
                      {e.notes && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{e.notes}</p>}
                    </div>
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${e.title}`} onClick={() => onEditEvent(e)}>
                      <Pencil />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${e.title}`} onClick={() => onDeleteEvent(e)}>
                      <Trash2 />
                    </Button>
                  </motion.div>
                ))}
                </AnimatePresence>
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
