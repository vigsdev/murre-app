import { Plus } from "lucide-react"
import { useState } from "react"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, errorMessage } from "@/lib/tauri"
import { SpaceDialog } from "./space-dialog"
import { useSpaces } from "./spaces-context"

const NONE = "__none__"
const ADD = "__add__"

/**
 * `value` is a Space id or null. An id that no longer exists is shown as "No Space".
 * The last entry, "Add Space", makes a new Space on the spot and selects it.
 */
export function SpaceSelect({ id, value, onChange }: { id?: string; value: string | null; onChange: (v: string | null) => void }) {
  const { spaces, reload } = useSpaces()
  const [creating, setCreating] = useState(false)
  const items = [{ value: NONE, label: "No Space selected" }, ...spaces.map((s) => ({ value: s.id, label: s.name })), { value: ADD, label: "Add Space" }]
  const current = value && spaces.some((s) => s.id === value) ? value : NONE

  async function create(name: string, icon: string): Promise<string | null> {
    try {
      const space = await api.createSpace(name, icon)
      await reload()
      onChange(space.id)
      return null
    } catch (e) {
      return errorMessage(e)
    }
  }

  return (
    <>
      <Select
        items={items}
        value={current}
        onValueChange={(v) => {
          if (!v) return
          if (v === ADD) setCreating(true)
          else onChange(v === NONE ? null : v)
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items
            .filter((o) => o.value !== ADD)
            .map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          <SelectSeparator />
          <SelectItem value={ADD}>
            <Plus className="size-4" /> Add Space
          </SelectItem>
        </SelectContent>
      </Select>
      <SpaceDialog open={creating} space={null} onOpenChange={setCreating} onSubmit={create} />
    </>
  )
}
