import { ArrowUpRight } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/tauri"

/** "Contents > Group 4 > Contents > Stroke 1 > Color" → "Group 4 / Stroke 1 / Color": the filler groups are dropped. */
export function prettyPath(property: string | null): string {
  if (!property) return ""
  return property
    .split(" > ")
    .filter((p) => p !== "Contents")
    .join(" / ")
}

export interface UsageSpot {
  comp: string | null
  compId: number | null
  layer: string | null
  layerIndex: number | null
  property?: string | null
}

/** The line shown for a place in the project: layer name first, then the composition and the readable path. */
export function usageTitle(u: UsageSpot) {
  return u.layer || u.comp || "Unknown location"
}

export function usageSubtitle(u: UsageSpot) {
  const path = prettyPath(u.property ?? null)
  return [u.layer ? u.comp : null, path].filter(Boolean).join(" · ")
}

/** Opens this place in After Effects. Greyed out for scans made before jumping existed (a new scan fixes that). */
export function JumpButton({ projectId, spot, className }: { projectId: string; spot: UsageSpot; className?: string }) {
  const [busy, setBusy] = useState(false)
  const ready = spot.compId !== null && !!spot.layer
  async function go() {
    if (spot.compId === null || !spot.layer) return
    setBusy(true)
    try {
      const note = await api.revealInAfterEffects(projectId, {
        compId: spot.compId,
        comp: spot.comp ?? "",
        layerIndex: spot.layerIndex,
        layer: spot.layer,
        property: spot.property ?? null,
      })
      if (note) toast.message(note)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={className}
      disabled={!ready || busy}
      aria-label="Show in After Effects"
      title={ready ? "Show in After Effects" : "Scan this project again to jump to it"}
      onClick={() => void go()}
    >
      <ArrowUpRight />
    </Button>
  )
}

/** One place in the project: title, readable path, and the jump button. */
export function UsageRow({ projectId, spot, extra }: { projectId: string; spot: UsageSpot; extra?: React.ReactNode }) {
  const subtitle = usageSubtitle(spot)
  return (
    <li className="flex items-start justify-between gap-2" data-testid="usage-row">
      <div className="min-w-0">
        <p className="break-words text-xs font-medium">{usageTitle(spot)}</p>
        {subtitle && <p className="break-words text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {extra}
        <JumpButton projectId={projectId} spot={spot} />
      </div>
    </li>
  )
}
