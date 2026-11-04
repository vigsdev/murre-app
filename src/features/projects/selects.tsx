import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ProjectPriority, ProjectStatus } from "@/lib/tauri"
import { PRIORITY_OPTIONS, STATUS_OPTIONS } from "./constants"

interface Props<T extends string> {
  id?: string
  value: T
  onChange: (value: T) => void
}

export function PrioritySelect({ id, value, onChange }: Props<ProjectPriority>) {
  return (
    <Select items={PRIORITY_OPTIONS} value={value} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PRIORITY_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function StatusSelect({ id, value, onChange }: Props<ProjectStatus>) {
  return (
    <Select items={STATUS_OPTIONS} value={value} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUS_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
