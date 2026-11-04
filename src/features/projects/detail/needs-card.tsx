import { Check, CircleHelp, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { api, type NeedsView } from "@/lib/tauri"
import { thisComputer } from "@/lib/platform"

/** "25.0x1" → "25", for a line people can read. */
function aeMajor(v: string) {
  return v.split(/[^0-9]/)[0] || v
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      {children}
    </div>
  )
}

/**
 * What the project needs to open properly on a machine: its fonts, plugins and After Effects version, with a warning
 * for anything this Mac doesn't seem to have. Read-only: it only shows what the last scan found.
 */
export function NeedsCard({ projectId, reloadToken = 0 }: { projectId: string; reloadToken?: number }) {
  const [view, setView] = useState<NeedsView | null>(null)
  const [failed, setFailed] = useState(false)
  const [all, setAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .getNeeds(projectId)
      .then((v) => !cancelled && (setView(v), setFailed(false)))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [projectId, reloadToken])

  if (failed || !view) return null

  if (!view.scanned) {
    return (
      <Card data-testid="needs-card">
        <CardHeader>
          <CardTitle>What this project needs</CardTitle>
          <CardDescription>Scan the project to list its fonts, plugins and After Effects version.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const badFonts = view.fonts.filter((f) => f.state === "missing" || f.state === "notOnMac")
  const unsure = view.plugins.filter((p) => !p.seenInstalled)
  const aeBad = view.aeOk === false
  const problems = badFonts.length + unsure.length + (aeBad ? 1 : 0)
  // Fonts with a problem come first and are never hidden behind "Show all".
  const orderedFonts = [...badFonts, ...view.fonts.filter((f) => !badFonts.includes(f))]
  const shownFonts = all ? orderedFonts : orderedFonts.slice(0, Math.max(8, badFonts.length))

  return (
    <Card data-testid="needs-card">
      <CardHeader>
        <CardTitle>What this project needs</CardTitle>
        <CardDescription>
          {problems === 0
            ? `Everything the last scan found looks available on ${thisComputer}.`
            : `${problems} ${problems === 1 ? "thing" : "things"} to check before opening this on ${thisComputer}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Row title="After Effects">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {view.aeVersion ? `Version ${aeMajor(view.aeVersion)} (last scanned in ${view.aeVersion})` : "Version unknown"}
            {aeBad && (
              <Badge variant="destructive">
                <TriangleAlert /> Newest here is {view.aeInstalled[view.aeInstalled.length - 1]}
              </Badge>
            )}
            {view.aeOk === true && (
              <Badge variant="secondary">
                <Check /> Installed here
              </Badge>
            )}
          </p>
        </Row>

        <Row title={`Fonts (${view.fonts.length})`}>
          {view.fonts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No fonts found.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {shownFonts.map((f) => (
                <li key={f.postScriptName}>
                  <Badge variant={f.state === "ok" || f.state === "adobe" ? "secondary" : "destructive"} title={f.postScriptName}>
                    {(f.state === "missing" || f.state === "notOnMac") && <TriangleAlert />}
                    {f.label}
                    {f.state === "notOnMac" && ` · not on ${thisComputer}`}
                    {f.state === "missing" && " · was missing"}
                  </Badge>
                </li>
              ))}
              {view.fonts.length > shownFonts.length || all ? (
                <li>
                  <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setAll((x) => !x)}>
                    {all ? "Show fewer" : `Show all ${view.fonts.length}`}
                  </button>
                </li>
              ) : null}
            </ul>
          )}
          {view.fontsMethod === "layers" && view.fonts.length > 0 && (
            <p className="text-xs text-muted-foreground">This After Effects only reports the first font of each text layer, so the list may be incomplete.</p>
          )}
        </Row>

        <Row title={`Plugins (${view.plugins.length})`}>
          {view.plugins.length === 0 ? (
            <p className="text-sm text-muted-foreground">No third-party effects found.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {view.plugins.map((p) => (
                <li key={p.matchName} className="flex flex-wrap items-center gap-2 text-sm">
                  <span title={p.matchName}>{p.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {p.layerCount} {p.layerCount === 1 ? "layer" : "layers"}
                  </span>
                  {p.seenInstalled ? (
                    <Badge variant="secondary">
                      <Check /> Found here
                    </Badge>
                  ) : (
                    <Badge variant="outline">
                      <CircleHelp /> Can’t confirm it’s installed
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Row>
      </CardContent>
    </Card>
  )
}
