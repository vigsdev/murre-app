import { ChevronDown, ChevronRight, Copy, Palette, Search } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { nameColor } from "@/lib/color-names"
import { api, errorMessage, type ColorEntry, type ColorsView } from "@/lib/tauri"
import { UsageRow } from "./usage"

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; view: ColorsView }

interface Group {
  hex: string
  uses: ColorEntry[]
}

function groupByHex(colors: ColorEntry[]): Group[] {
  const map = new Map<string, Group>()
  for (const c of colors) {
    const g = map.get(c.hex) ?? { hex: c.hex, uses: [] }
    g.uses.push(c)
    map.set(c.hex, g)
  }
  return [...map.values()].sort((a, b) => b.uses.length - a.uses.length || a.hex.localeCompare(b.hex))
}

function scanText(v: string | number | null) {
  if (v === null) return null
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`Copied ${text}`)
  } catch {
    toast.error("Could not copy to the clipboard.")
  }
}

/** Closest friendly name for a colour; "~" marks a near match rather than the same colour. */
function useColorName(hex: string) {
  const [label, setLabel] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void nameColor(hex).then((r) => live && setLabel(r ? `${r.approximate ? "~" : ""}${r.name}` : null))
    return () => {
      live = false
    }
  }, [hex])
  return label
}

function ColorCard({ projectId, g, expanded, onToggle }: { projectId: string; g: Group; expanded: boolean; onToggle: () => void }) {
  const label = useColorName(g.hex)
  return (
    <Card className="gap-0 py-0" data-testid="color-card">
      <div className="flex items-center gap-3 p-3">
        <div className="size-12 shrink-0 rounded-xl ring-1 ring-foreground/10" style={{ backgroundColor: g.hex }} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{label ?? "Color"}</p>
          <p className="font-mono text-xs text-muted-foreground">{g.hex}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={`Copy ${g.hex}`} onClick={() => void copy(g.hex)}>
          <Copy />
        </Button>
      </div>
      <div className="flex flex-col gap-2 border-t px-3 py-2">
        <button
          type="button"
          className="flex items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Used {g.uses.length} {g.uses.length === 1 ? "time" : "times"}
        </button>
        {expanded && (
          <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto pb-1">
            {g.uses.map((u, i) => (
              <UsageRow
                key={i}
                projectId={projectId}
                spot={u}
                extra={u.alpha < 1 ? <Badge variant="outline">{Math.round(u.alpha * 100)}%</Badge> : undefined}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

/** Shows the colors the After Effects Companion collected. Read-only. */
export function ColorsTab({ projectId, reloadToken = 0 }: { projectId: string; reloadToken?: number }) {
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    // Show the skeleton only on first load; a refresh swaps the data in place.
    if (reloadToken === 0) setLoad({ status: "loading" })
    api
      .getColors(projectId)
      .then((view) => !cancelled && setLoad({ status: "ready", view }))
      .catch((e) => !cancelled && setLoad({ status: "error", message: errorMessage(e) }))
    return () => {
      cancelled = true
    }
  }, [projectId, reloadToken])

  const view = load.status === "ready" ? load.view : null
  const groups = useMemo(() => {
    if (!view) return []
    const q = query.trim().toLowerCase()
    const matches = (c: ColorEntry) =>
      !q || [c.hex, c.comp, c.layer, c.property].some((x) => x?.toLowerCase().includes(q))
    return groupByHex(view.colors.filter(matches))
  }, [view, query])

  if (load.status === "loading") return <Skeleton className="h-64" />
  if (load.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn’t read the colors.</AlertTitle>
        <AlertDescription>{load.message}</AlertDescription>
      </Alert>
    )
  }

  const v = load.view
  if (v.colors.length === 0 && v.skipped === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Palette />
          </EmptyMedia>
          <EmptyTitle>No colors yet. Give the project a scan first.</EmptyTitle>
          <EmptyDescription>
            Colors appear here after the After Effects Companion scans this project. Murre only displays them; it never
            changes the scan.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const scanned = scanText(v.lastScanAt)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search colors"
            className="pl-9"
            placeholder="Search by hex, comp, layer or property"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {groups.length} {groups.length === 1 ? "color" : "colors"}
          {scanned ? ` · scanned ${scanned}` : ""}
        </span>
      </div>

      {(v.skipped > 0 || v.truncated > 0) && (
        <Alert>
          <AlertTitle>Some entries are not shown</AlertTitle>
          <AlertDescription>
            {v.skipped > 0 && `${v.skipped} entries in colors.json could not be understood. `}
            {v.truncated > 0 && `${v.truncated} entries beyond the first 50,000 are hidden.`}
          </AlertDescription>
        </Alert>
      )}

      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No colors match “{query}”.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] items-start gap-3">
          {groups.map((g) => (
            <ColorCard
              key={g.hex}
              projectId={projectId}
              g={g}
              expanded={open.has(g.hex)}
              onToggle={() =>
                setOpen((prev) => {
                  const next = new Set(prev)
                  if (!next.delete(g.hex)) next.add(g.hex)
                  return next
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}
