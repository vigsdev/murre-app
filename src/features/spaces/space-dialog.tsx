import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { Space } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { SPACE_ICON_KEYS, SpaceIcon } from "./space-icons"

interface Props {
  open: boolean
  /** The Space being edited, or null to create one. */
  space: Space | null
  onOpenChange: (open: boolean) => void
  /** Resolve to an error message to keep the dialog open, or null when saved. */
  onSubmit: (name: string, icon: string) => Promise<string | null>
}

export function SpaceDialog({ open, space, onOpenChange, onSubmit }: Props) {
  const [name, setName] = useState("")
  const [icon, setIcon] = useState("layers")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(space?.name ?? "")
    setIcon(space?.icon ?? "layers")
    setError(null)
    setBusy(false)
  }, [open, space])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    // The dialog can be opened from inside another form (New Project); React would pass this submit on to that form.
    e.stopPropagation()
    if (!name.trim()) return setError("Please enter a name for the Space.")
    setBusy(true)
    const message = await onSubmit(name, icon)
    setBusy(false)
    if (message) setError(message)
    else onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{space ? "Edit Space" : "New Space"}</DialogTitle>
          <DialogDescription>A Space groups projects inside Murre. It is not a folder, and your files are never moved.</DialogDescription>
        </DialogHeader>
        <form id="space-form" onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="space-name">Name</Label>
            <Input
              id="space-name"
              autoFocus
              autoComplete="off"
              maxLength={40}
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label id="space-icon-label">Icon</Label>
            <div role="group" aria-labelledby="space-icon-label" className="grid grid-cols-8 gap-1.5">
              {SPACE_ICON_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-label={key}
                  aria-pressed={icon === key}
                  onClick={() => setIcon(key)}
                  className={cn(
                    "flex aspect-square items-center justify-center rounded-lg border transition hover:bg-muted focus-visible:outline-none",
                    icon === key && "border-primary bg-primary/10",
                  )}
                >
                  <SpaceIcon icon={key} className="size-4" />
                </button>
              ))}
            </div>
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
          <Button type="submit" form="space-form" disabled={busy}>
            {space ? "Save" : "Create Space"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
