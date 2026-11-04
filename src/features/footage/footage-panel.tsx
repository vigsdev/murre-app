import { Loader2, Replace } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { modeOf } from "@/features/companion/companion-control"
import { useCompanionStatus } from "@/features/companion/use-companion-status"
import { api, errorMessage, type FootageView } from "@/lib/tauri"

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; view: FootageView }

const SHOWN = 8
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`
const base = (p: string) => p.split(/[\\/]/).pop() || p

/**
 * Files used by the After Effects project that sit outside the project folder, and the button that
 * asks the Companion to copy them in and relink them. The Companion does the work; this only
 * shows what it found. Originals are never moved or deleted.
 */
export function FootagePanel({ projectId, reloadToken = 0 }: { projectId: string; reloadToken?: number }) {
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [busy, setBusy] = useState(false)
  const { status } = useCompanionStatus()

  useEffect(() => {
    let cancelled = false
    api
      .getFootage(projectId)
      .then((view) => !cancelled && setLoad({ status: "ready", view }))
      .catch((e) => !cancelled && setLoad({ status: "error", message: errorMessage(e) }))
    return () => {
      cancelled = true
    }
  }, [projectId, reloadToken])

  if (load.status === "loading") return <Skeleton className="h-24" />
  if (load.status === "error") {
    return (
      <Alert variant="destructive" >
        <AlertTitle>Couldn’t read the footage list.</AlertTitle>
        <AlertDescription>{load.message}</AlertDescription>
      </Alert>
    )
  }

  const { view } = load
  // Nothing to say until the Companion has scanned the project.
  if (view.lastScanAt === null && view.assets.length === 0) return null

  const outside = view.assets.filter((a) => a.status === "outside")
  const missing = view.assets.filter((a) => a.status === "missing").length
  const sequences = view.assets.filter((a) => a.status === "sequence").length
  const mode = modeOf(status, projectId)
  const working = mode === "scanning"

  async function relink() {
    setBusy(true)
    try {
      await api.companionRelink(projectId)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const reason =
    mode === "offline"
      ? "Open After Effects. The Companion starts with it."
      : mode === "elsewhere"
        ? "Open this project's .aep file in After Effects."
        : working
          ? "The Companion is busy."
          : ""

  return (
    <section className="flex flex-col gap-2 rounded-xl border p-4" data-testid="footage-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Footage files</h3>
          <p className="text-sm text-muted-foreground">
            {outside.length === 0
              ? "Every file used by the project is already inside it."
              : `${plural(outside.length, "file")} used by the project ${outside.length === 1 ? "is" : "are"} outside the project folder.`}
            {missing > 0 && ` ${plural(missing, "file")} missing.`}
            {sequences > 0 && ` ${plural(sequences, "image sequence")} not moved (copy those by hand).`}
          </p>
        </div>
        {outside.length > 0 && (
          <Button size="sm" disabled={mode !== "ready" || busy} title={reason || undefined} onClick={() => void relink()}>
            {busy || working ? <Loader2 className="animate-spin" /> : <Replace />} Copy &amp; relink in After Effects
          </Button>
        )}
      </div>
      {outside.length > 0 && (
        <>
          <ul className="flex flex-col gap-0.5 text-sm">
            {outside.slice(0, SHOWN).map((a) => (
              <li key={a.path} className="flex min-w-0 gap-2" title={a.path}>
                <span className="min-w-0 truncate">{base(a.path)}</span>
                <span className="shrink-0 text-muted-foreground">→ {a.destFolder ?? "02 Assets"}</span>
              </li>
            ))}
            {outside.length > SHOWN && <li className="text-muted-foreground">…and {outside.length - SHOWN} more</li>}
          </ul>
          <p className="text-xs text-muted-foreground">
            Files are copied, never moved or overwritten, and the originals stay where they are. After Effects then has unsaved changes:
            save the project there to keep the new links.
          </p>
        </>
      )}
      {view.moved.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Copied into this project earlier ({view.moved.length})</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {view.moved
              .slice(-SHOWN)
              .reverse()
              .map((m, i) => (
                <li key={i} className="min-w-0 truncate" title={`${m.from} → ${m.to}`}>
                  {base(m.to)} <span className="text-muted-foreground">from {m.from}</span>
                </li>
              ))}
          </ul>
        </details>
      )}
    </section>
  )
}
