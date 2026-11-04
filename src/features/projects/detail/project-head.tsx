import { CalendarDays, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CompanionStatusLine } from "@/features/companion/companion-control"
import type { ProjectPriority, ProjectRecord, ProjectStatus } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { PRIORITY_OPTIONS, STATUS_OPTIONS, STATUS_TONE } from "../constants"
import { formatDeadline, isOverdue, priorityLabel, statusLabel } from "../project-utils"

/** The fields that can be changed straight from the page. */
export type HeadPatch = Partial<Pick<ProjectRecord, "name" | "client" | "deadline" | "priority" | "status">>

/**
 * Every editable piece looks the same at rest as plain text. The padding is cancelled by a negative margin, so
 * hovering or editing never moves anything next to it.
 */
const HIT = "-mx-1.5 rounded-md px-1.5 py-0.5 outline-none transition-colors hover:bg-foreground/8 focus-visible:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:bg-foreground/8"

/** The project's name, large. Click to rename: Enter saves, Esc cancels, leaving the field saves. */
export function EditableTitle({ name, onSave }: { name: string; onSave: (name: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const input = useRef<HTMLInputElement>(null)
  // Enter and Esc finish editing before the field loses focus; this stops the blur from saving a second time.
  const done = useRef(false)

  useEffect(() => {
    if (editing) {
      done.current = false
      input.current?.focus()
      input.current?.select()
    }
  }, [editing])

  function finish(save: boolean) {
    if (done.current) return
    done.current = true
    const next = draft.trim()
    if (save && next && next !== name) onSave(next)
    setEditing(false)
  }

  const box = "-mx-2 h-10 max-w-full rounded-lg px-2 text-3xl font-semibold tracking-tight"
  if (editing) {
    return (
      <input
        ref={input}
        aria-label="Project name"
        value={draft}
        maxLength={100}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(true)
          if (e.key === "Escape") finish(false)
        }}
        className={cn(box, "w-full min-w-0 bg-foreground/8 outline-none ring-2 ring-ring/40")}
      />
    )
  }
  return (
    <button
      type="button"
      title="Rename"
      onClick={() => {
        setDraft(name)
        setEditing(true)
      }}
      className={cn(box, "block min-w-0 cursor-text truncate text-left outline-none transition-colors hover:bg-foreground/8 focus-visible:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring/50")}
    >
      {name}
    </button>
  )
}

function EditableClient({ client, onSave }: { client: string | null; onSave: (client: string | null) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(client ?? "")
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    if (editing) {
      done.current = false
      input.current?.focus()
      input.current?.select()
    }
  }, [editing])

  function finish(save: boolean) {
    if (done.current) return
    done.current = true
    const next = draft.trim() || null
    if (save && next !== (client || null)) onSave(next)
    setEditing(false)
  }

  if (editing) {
    return (
      // The hidden copy of the text gives the field exactly the width the text has, so nothing next to it moves.
      <span className={cn(HIT, "inline-grid max-w-64 bg-foreground/8 text-sm text-foreground ring-2 ring-ring/40 focus-within:bg-foreground/8")}>
        <span aria-hidden className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre">
          {draft || "Client"}
        </span>
        <input
          ref={input}
          aria-label="Client"
          value={draft}
          maxLength={100}
          autoComplete="off"
          placeholder="Client"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(true)
            if (e.key === "Escape") finish(false)
          }}
          className="col-start-1 row-start-1 w-0 min-w-full bg-transparent p-0 outline-none placeholder:text-muted-foreground"
        />
      </span>
    )
  }
  return (
    <button
      type="button"
      title="Change client"
      onClick={() => {
        setDraft(client ?? "")
        setEditing(true)
      }}
      className={cn(HIT, "min-w-0 max-w-64 cursor-text truncate", !client && "text-muted-foreground/70")}
    >
      {client || "Add client"}
    </button>
  )
}

function StatusMenu({ status, onSave }: { status: ProjectStatus; onSave: (s: ProjectStatus) => void }) {
  const tone = STATUS_TONE[status]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="Change status"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium outline-none transition-[filter] hover:brightness-125 focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:brightness-125",
          tone.chip,
        )}
      >
        <span aria-hidden className={cn("size-2 rounded-full", tone.dot)} />
        {statusLabel(status)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-44">
        <DropdownMenuRadioGroup value={status} onValueChange={(v) => v !== status && onSave(v as ProjectStatus)}>
          {STATUS_OPTIONS.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value} closeOnClick>
              <span aria-hidden className={cn("size-2 rounded-full", STATUS_TONE[o.value].dot)} />
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PriorityMenu({ priority, onSave }: { priority: ProjectPriority; onSave: (p: ProjectPriority) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger title="Change priority" className={cn(HIT, "whitespace-nowrap")}>
        {priorityLabel(priority)} priority
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-36">
        <DropdownMenuRadioGroup value={priority} onValueChange={(v) => v !== priority && onSave(v as ProjectPriority)}>
          {PRIORITY_OPTIONS.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value} closeOnClick>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function parseDay(value: string | null): Date | undefined {
  if (!value) return undefined
  const [y, m, d] = value.split("-").map(Number)
  return new Date(y, m - 1, d)
}

function toIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function DeadlinePicker({ project: p, onSave }: { project: ProjectRecord; onSave: (deadline: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const overdue = isOverdue(p)
  const date = parseDay(p.deadline)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger title="Change deadline" className={cn(HIT, "flex items-center gap-1.5 whitespace-nowrap", overdue && "text-destructive", !p.deadline && "text-muted-foreground/70")}>
        <CalendarDays className="size-4" aria-hidden />
        {p.deadline ? `${overdue ? "Overdue · " : "Due "}${formatDeadline(p.deadline)}` : "Add deadline"}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          defaultMonth={date}
          onSelect={(d) => {
            if (d) {
              const next = toIso(d)
              if (next !== p.deadline) onSave(next)
            }
            setOpen(false)
          }}
        />
        {p.deadline && (
          <div className="border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => {
                onSave(null)
                setOpen(false)
              }}
            >
              <X /> Clear deadline
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Under the project's name: who it is for, where it stands, when it is due and whether the Companion is connected. Each part can be changed in place. */
export function ProjectHead({ project: p, onChange }: { project: ProjectRecord; onChange: (patch: HeadPatch) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
        <EditableClient client={p.client} onSave={(client) => onChange({ client })} />
        <span aria-hidden className="h-4 w-px bg-border" />
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <StatusMenu status={p.status} onSave={(status) => onChange({ status })} />
          <PriorityMenu priority={p.priority} onSave={(priority) => onChange({ priority })} />
          <DeadlinePicker project={p} onSave={(deadline) => onChange({ deadline })} />
        </span>
        {p.available && (
          <>
            <span aria-hidden className="h-4 w-px bg-border" />
            <CompanionStatusLine projectId={p.id} />
          </>
        )}
      </div>
      {p.description && <p className="line-clamp-2 max-w-3xl text-sm text-muted-foreground">{p.description}</p>}
    </div>
  )
}
