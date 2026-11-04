import { CalendarIcon, X } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

interface Props {
  id?: string
  /** `YYYY-MM-DD`, or null for no date. */
  value: string | null
  onChange: (value: string | null) => void
  placeholder?: string
  /** Days before today cannot be picked. A date already set in the past still shows and can be cleared. */
  disablePast?: boolean
}

function parse(value: string | null): Date | undefined {
  if (!value) return undefined
  const [y, m, d] = value.split("-").map(Number)
  return new Date(y, m - 1, d)
}

function format(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export function DatePicker({ id, value, onChange, placeholder = "Pick a date", disablePast = false }: Props) {
  const [open, setOpen] = useState(false)
  const date = parse(value)

  return (
    <div className="flex gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              type="button"
              variant="outline"
              className={cn("flex-1 justify-start font-normal", !date && "text-muted-foreground")}
            />
          }
        >
          <CalendarIcon />
          {date ? date.toLocaleDateString(undefined, { dateStyle: "medium" }) : placeholder}
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            defaultMonth={date}
            disabled={disablePast ? { before: startOfToday() } : undefined}
            onSelect={(d) => {
              onChange(d ? format(d) : null)
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      {date && (
        <Button type="button" variant="ghost" size="icon" aria-label="Clear date" onClick={() => onChange(null)}>
          <X />
        </Button>
      )}
    </div>
  )
}
