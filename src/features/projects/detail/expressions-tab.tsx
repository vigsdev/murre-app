import { ChevronDown, ChevronRight, Code, Search } from "lucide-react"
import { memo, useDeferredValue, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import { api, errorMessage, type ExpressionEntry, type ExpressionsView } from "@/lib/tauri"
import { JumpButton, prettyPath, UsageRow } from "./usage"

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; view: ExpressionsView }

const PAGE = 50

/** The same code used in several places is shown once, with the places listed under it. */
interface Group {
  /** Stable identity, so a card keeps its state and colouring while the search narrows or widens. */
  key: string
  expression: string
  uses: ExpressionEntry[]
  /** Everything searchable, lower-cased once. */
  hay: string
}

function groupByCode(entries: ExpressionEntry[]): Group[] {
  const map = new Map<string, Group>()
  for (const e of entries) {
    const key = e.expression.replace(/\r\n?/g, "\n").trim()
    const g = map.get(key) ?? { key, expression: e.expression, uses: [], hay: "" }
    g.uses.push(e)
    map.set(key, g)
  }
  for (const g of map.values()) {
    g.hay = [g.expression, ...g.uses.map((e) => [e.comp, e.layer, e.property].filter(Boolean).join("\n"))].join("\n").toLowerCase()
  }
  // Most reused first; groups used equally often keep the order they were scanned in.
  return [...map.values()].sort((a, b) => b.uses.length - a.uses.length)
}

function where(e: ExpressionEntry) {
  return [e.comp, e.layer, prettyPath(e.property)].filter(Boolean).join(" › ") || "Unknown location"
}

function scanText(v: string | number | null) {
  if (v === null) return null
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

/** Long expressions are cut to this many lines until the person asks for the rest. */
const COLLAPSED_LINES = 3
const LONG_CHARS = 280
const PREVIEW_CHARS = 1200

/** One expression: numbered, syntax-highlighted lines, collapsed to a few lines when it is long. */
const ExpressionBlock = memo(function ExpressionBlock({ projectId, group }: { projectId: string; group: Group }) {
  const entry = group.uses[0]
  const [expanded, setExpanded] = useState(false)
  const [showUses, setShowUses] = useState(false)
  const count = group.uses.length
  // After Effects expressions are JavaScript. Until the highlighter has loaded the lines are plain text.
  // Colouring is the slow part, so a collapsed card only colours what it shows; the rest is coloured when it is opened.
  const totalLines = useMemo(() => entry.expression.split("\n").length, [entry.expression])
  const source = useMemo(
    () => (expanded ? entry.expression : entry.expression.split("\n").slice(0, COLLAPSED_LINES).join("\n").slice(0, PREVIEW_CHARS)),
    [expanded, entry.expression],
  )
  const lines = useHighlightedCode(source, "javascript")
  const hidden = Math.max(0, totalLines - COLLAPSED_LINES)
  const shownLines = lines
  // One very long line (minified code, for example) is also collapsed, so a single card cannot take over the page.
  const long = entry.expression.length > LONG_CHARS
  const collapsible = hidden > 0 || long
  return (
    <CodeBlock size="sm" data-testid="expression-card">
      <CodeBlockHeader>
        <CodeBlockTitle className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate" title={where(entry)}>
            {where(entry)}
          </span>
          {count === 1 && !entry.enabled && <Badge variant="outline">Disabled</Badge>}
          {count > 1 && <Badge variant="secondary">×{count}</Badge>}
        </CodeBlockTitle>
        <CodeBlockActions>
          {count === 1 && <JumpButton projectId={projectId} spot={entry} />}
          <CodeBlockCopyButton
            value={entry.expression}
            aria-label="Copy expression"
            onClick={() => toast.success("Expression copied")}
          />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers wrap className={expanded ? "max-h-[28rem]" : long ? "max-h-32 overflow-hidden" : undefined}>
        {shownLines.map((line, i) => (
          <CodeBlockLine key={i}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
      {(collapsible || count > 1) && (
        <CodeBlockFooter className="flex-wrap justify-between gap-1">
          {count > 1 ? (
            <Button variant="ghost" size="xs" aria-expanded={showUses} onClick={() => setShowUses((x) => !x)}>
              {showUses ? <ChevronDown /> : <ChevronRight />}
              Used {count} times
            </Button>
          ) : (
            <span />
          )}
          {collapsible && (
            <Button variant="ghost" size="xs" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
              {expanded ? "Show less" : hidden > 0 ? `Show ${hidden} more ${hidden === 1 ? "line" : "lines"}` : "Show all"}
            </Button>
          )}
        </CodeBlockFooter>
      )}
      {showUses && (
        <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto border-t px-3 py-2">
          {group.uses.map((u, i) => (
            <UsageRow key={i} projectId={projectId} spot={u} extra={!u.enabled ? <Badge variant="outline">Disabled</Badge> : undefined} />
          ))}
        </ul>
      )}
    </CodeBlock>
  )
})

/** Shows the expressions the After Effects Companion collected. Read-only. */
export function ExpressionsTab({ projectId, reloadToken = 0 }: { projectId: string; reloadToken?: number }) {
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [query, setQuery] = useState("")
  const [shown, setShown] = useState(PAGE)

  useEffect(() => {
    let cancelled = false
    // Show the skeleton only on first load; a refresh swaps the data in place.
    if (reloadToken === 0) setLoad({ status: "loading" })
    api
      .getExpressions(projectId)
      .then((view) => !cancelled && setLoad({ status: "ready", view }))
      .catch((e) => !cancelled && setLoad({ status: "error", message: errorMessage(e) }))
    return () => {
      cancelled = true
    }
  }, [projectId, reloadToken])

  const view = load.status === "ready" ? load.view : null
  const groups = useMemo(() => (view ? groupByCode(view.expressions) : []), [view])
  // Typing stays instant; the list catches up a moment later.
  const deferredQuery = useDeferredValue(query)
  const matches = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    if (!q) return groups
    // A group stays (with all of its places) when its code or any of its places matches.
    return groups.filter((g) => g.hay.includes(q))
  }, [groups, deferredQuery])

  if (load.status === "loading") return <Skeleton className="h-64" />
  if (load.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn’t read the expressions.</AlertTitle>
        <AlertDescription>{load.message}</AlertDescription>
      </Alert>
    )
  }

  const v = load.view
  if (v.expressions.length === 0 && v.skipped === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Code />
          </EmptyMedia>
          <EmptyTitle>No expressions yet. A rare moment of peace.</EmptyTitle>
          <EmptyDescription>
            Expressions appear here after the After Effects Companion scans this project. Murre only displays them; it
            never changes the scan.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const scanned = scanText(v.lastScanAt)
  const visible = matches.slice(0, shown)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search expressions"
            className="pl-9"
            placeholder="Search code, comp, layer or property"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setShown(PAGE)
            }}
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {matches.length} {matches.length === 1 ? "expression" : "expressions"}
          {matches.reduce((n, g) => n + g.uses.length, 0) !== matches.length &&
            ` used ${matches.reduce((n, g) => n + g.uses.length, 0)} times`}
          {scanned ? ` · scanned ${scanned}` : ""}
        </span>
      </div>

      {(v.skipped > 0 || v.truncated > 0) && (
        <Alert>
          <AlertTitle>Some entries are not shown</AlertTitle>
          <AlertDescription>
            {v.skipped > 0 && `${v.skipped} entries in expressions.json could not be understood. `}
            {v.truncated > 0 && `${v.truncated} entries beyond the first 20,000 are hidden.`}
          </AlertDescription>
        </Alert>
      )}

      {matches.length === 0 ? (
        <p className="text-sm text-muted-foreground">No expressions match “{query}”.</p>
      ) : (
        <>
          {/* Columns pack cards of different heights together without gaps. */}
          <div className="columns-[26rem] gap-3 [&>*]:mb-3 [&>*]:break-inside-avoid">
            {visible.map((e) => (
              <ExpressionBlock key={e.key} projectId={projectId} group={e} />
            ))}
          </div>
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
