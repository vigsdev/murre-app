import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { ChevronDown, ChevronRight, FolderSearch, Search, Type } from "lucide-react"
import { useDeferredValue, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useFontPreviews } from "@/lib/preferences"
import { api, errorMessage, type FontEntry, type FontsView } from "@/lib/tauri"
import { UsageRow } from "./usage"

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; view: FontsView }

const PAGE = 60

function scanText(v: string | number | null) {
  if (v === null) return null
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function hay(f: FontEntry) {
  return [f.family, f.style, f.postScriptName, ...f.uses.map((u) => [u.comp, u.layer].filter(Boolean).join(" "))]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
}

const SAMPLE = "The quick brown fox jumps over the lazy dog 0123"

/** Fonts already asked of the system, so a card that re-renders does not ask again. */
const loaded = new Map<string, Promise<string | null>>()

/**
 * Asks the system for an installed font by its PostScript name and returns a CSS family that draws with it,
 * or `null` when this Mac doesn't have it. Nothing is read from disk by Murre: the web view finds the font itself.
 */
function loadSystemFont(postScriptName: string): Promise<string | null> {
  let p = loaded.get(postScriptName)
  if (!p) {
    const family = `murre-preview-${postScriptName}`
    const quoted = postScriptName.replace(/["\\]/g, "")
    p = new FontFace(family, `local("${quoted}")`)
      .load()
      .then((face) => {
        document.fonts.add(face)
        return `"${family}"`
      })
      .catch(() => null)
    loaded.set(postScriptName, p)
  }
  return p
}

function FontPreview({ font }: { font: FontEntry }) {
  const [family, setFamily] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    setFamily(undefined)
    void loadSystemFont(font.postScriptName).then((f) => !cancelled && setFamily(f))
    return () => {
      cancelled = true
    }
  }, [font.postScriptName])
  if (family === undefined) return <div className="h-8" aria-hidden />
  if (family === null) return <p className="text-xs text-muted-foreground">No preview: this font isn’t installed on this Mac.</p>
  return (
    <p className="line-clamp-2 break-words text-2xl leading-snug" style={{ fontFamily: family }} data-testid="font-preview">
      {SAMPLE}
    </p>
  )
}

function FontCard({ projectId, font }: { projectId: string; font: FontEntry }) {
  const [open, setOpen] = useState(false)
  const [previews] = useFontPreviews()
  const title = font.family ?? font.postScriptName
  return (
    <li className="flex flex-col gap-2 rounded-xl border p-4" data-testid="font-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-base font-medium" title={title}>
            {title}
            {font.style && <span className="font-normal text-muted-foreground"> · {font.style}</span>}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground" title={font.postScriptName}>
            {font.postScriptName}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {font.adobeFonts && <Badge variant="secondary">Adobe Fonts</Badge>}
          {font.missing && <Badge variant="destructive">Missing when scanned</Badge>}
          {font.installed === false && <Badge variant="outline">Not on this Mac</Badge>}
        </div>
      </div>
      {previews && <FontPreview font={font} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {font.uses.length > 0 ? (
          <Button variant="ghost" size="xs" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
            {open ? <ChevronDown /> : <ChevronRight />}
            Used on {font.layerCount} {font.layerCount === 1 ? "layer" : "layers"}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            Used on {font.layerCount} {font.layerCount === 1 ? "layer" : "layers"}
          </span>
        )}
        {font.installed && font.location && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => void revealItemInDir(font.location!).catch((e) => toast.error(errorMessage(e)))}
          >
            <FolderSearch /> Show in Finder
          </Button>
        )}
      </div>
      {open && (
        <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto border-t pt-2">
          {font.uses.map((u, i) => (
            <UsageRow key={i} projectId={projectId} spot={u} />
          ))}
          {font.layerCount > font.uses.length && (
            <li className="text-xs text-muted-foreground">and {font.layerCount - font.uses.length} more</li>
          )}
        </ul>
      )}
    </li>
  )
}

/** Shows the fonts the After Effects Companion found in the project. Read-only. */
export function FontsTab({ projectId, reloadToken = 0 }: { projectId: string; reloadToken?: number }) {
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [query, setQuery] = useState("")
  const [shown, setShown] = useState(PAGE)

  useEffect(() => {
    let cancelled = false
    if (reloadToken === 0) setLoad({ status: "loading" })
    api
      .getFonts(projectId)
      .then((view) => !cancelled && setLoad({ status: "ready", view }))
      .catch((e) => !cancelled && setLoad({ status: "error", message: errorMessage(e) }))
    return () => {
      cancelled = true
    }
  }, [projectId, reloadToken])

  const view = load.status === "ready" ? load.view : null
  const index = useMemo(() => (view ? view.fonts.map((f) => ({ f, h: hay(f) })) : []), [view])
  const deferredQuery = useDeferredValue(query)
  const matches = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    return (q ? index.filter((x) => x.h.includes(q)) : index).map((x) => x.f)
  }, [index, deferredQuery])

  if (load.status === "loading") return <Skeleton className="h-64" />
  if (load.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn’t read the fonts.</AlertTitle>
        <AlertDescription>{load.message}</AlertDescription>
      </Alert>
    )
  }

  const v = load.view
  if (v.fonts.length === 0 && v.skipped === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Type />
          </EmptyMedia>
          <EmptyTitle>No fonts yet. Give the project a scan first.</EmptyTitle>
          <EmptyDescription>
            Fonts appear here after the After Effects Companion scans this project. Murre only displays them; it never
            changes the scan.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const scanned = scanText(v.lastScanAt)
  const missing = v.fonts.filter((f) => f.missing || f.installed === false).length
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search fonts"
            className="pl-9"
            placeholder="Search font, comp or layer"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setShown(PAGE)
            }}
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {matches.length} {matches.length === 1 ? "font" : "fonts"}
          {missing > 0 && ` · ${missing} not available`}
          {scanned ? ` · scanned ${scanned}` : ""}
        </span>
      </div>

      {v.method === "layers" && (
        <Alert>
          <AlertTitle>This list may be incomplete</AlertTitle>
          <AlertDescription>
            This version of After Effects only reports the first font of each text layer. After Effects 24.5 and newer
            lists every font in the project.
          </AlertDescription>
        </Alert>
      )}

      {(v.skipped > 0 || v.truncated > 0) && (
        <Alert>
          <AlertTitle>Some entries are not shown</AlertTitle>
          <AlertDescription>
            {v.skipped > 0 && `${v.skipped} entries in fonts.json could not be understood. `}
            {v.truncated > 0 && `${v.truncated} entries beyond the first 2,000 are hidden.`}
          </AlertDescription>
        </Alert>
      )}

      {matches.length === 0 ? (
        <p className="text-sm text-muted-foreground">No fonts match “{query}”.</p>
      ) : (
        <>
          <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(22rem,1fr))]">
            {matches.slice(0, shown).map((f) => (
              <FontCard key={f.postScriptName} projectId={projectId} font={f} />
            ))}
          </ul>
          {matches.length > shown && (
            <Button variant="outline" className="self-center" onClick={() => setShown((n) => n + PAGE)}>
              Show more ({matches.length - shown} left)
            </Button>
          )}
        </>
      )}
    </div>
  )
}
