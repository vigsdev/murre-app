import { recordGreetingEvent } from "@/features/home/greetings/events"
import { ChevronDown, Loader2, Radio, ScanLine, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { api, errorMessage, type CompanionStatus } from "@/lib/tauri"
import { useCompanionStatus } from "./use-companion-status"

type Mode = "offline" | "elsewhere" | "ready" | "scanning"

/** Where this project stands with the Companion. */
export function modeOf(status: CompanionStatus, projectId: string): Mode {
  if (!status.connected) return "offline"
  if (status.projectId !== projectId) return "elsewhere"
  return status.scanning ? "scanning" : "ready"
}

const LABEL: Record<Mode, string> = {
  offline: "Companion not connected",
  elsewhere: "After Effects has another project open",
  ready: "Companion connected",
  scanning: "Working…",
}

const HINT: Record<Mode, string> = {
  offline: "Open After Effects. The Companion starts with it (install it in Settings if needed).",
  elsewhere: "Open this project's .aep file in After Effects to scan it from here.",
  ready: "Reads this project's compositions, colors and expressions in After Effects.",
  scanning: "",
}

const fileName = (path: string | null) => (path ? path.split(/[\\/]/).pop() ?? path : "No project saved")

/**
 * Which After Effects Murre talks to. Only shown when two or more are connected (say, 2026 and a beta);
 * with one there is nothing to choose.
 */
export function ConnectionPicker({ status }: { status: CompanionStatus }) {
  const connections = status.connections ?? []
  if (connections.length < 2) return null
  const active = connections.find((c) => c.id === status.activeId) ?? connections[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Choose which After Effects to use"
      >
        {active.label}
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuRadioGroup
          value={String(active.id)}
          onValueChange={(v) => {
            api.companionSwitch(Number(v)).catch((e) => toast.error(errorMessage(e)))
          }}
        >
          {connections.map((c) => (
            <DropdownMenuRadioItem key={c.id} value={String(c.id)}>
              <span className="flex flex-col">
                <span>{c.label}</span>
                <span className="text-xs text-muted-foreground">{fileName(c.aepPath)}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A green dot and a few words: is the Companion connected? Shown in the project's header. */
export function CompanionStatusLine({ projectId }: { projectId: string }) {
  const { status } = useCompanionStatus()
  const mode = modeOf(status, projectId)
  const on = mode === "ready" || mode === "scanning"
  const many = (status.connections?.length ?? 0) >= 2

  // With two After Effects open, viewing a project talks to the one that has it open. Only a change in who has what
  // counts, so choosing the other one by hand on purpose is not undone straight away.
  const who = (status.connections ?? []).map((c) => `${c.id}:${c.projectId ?? ""}`).join("|")
  useEffect(() => {
    if (who.includes("|")) void api.companionPreferProject(projectId).catch(() => {})
  }, [projectId, who])

  return (
    <span className="flex items-center gap-1.5" role="status" title={HINT[mode] || undefined}>
      <span aria-hidden className={on ? "size-2 rounded-full bg-emerald-500" : "size-2 rounded-full bg-muted-foreground/50"} />
      {many ? (
        <>
          <ConnectionPicker status={status} />
          <span className="text-muted-foreground">{mode === "elsewhere" ? "· another project open" : ""}</span>
        </>
      ) : (
        LABEL[mode]
      )}
    </span>
  )
}

export function CompanionControl({ projectId, projectName, hideIdleLabel }: { projectId: string; projectName?: string; hideIdleLabel?: boolean }) {
  const { status, ready } = useCompanionStatus()
  // Between pressing Scan and the first sign of work from After Effects there is a short gap; show it.
  const [pending, setPending] = useState(false)
  const wasScanning = useRef(false)

  const mode = modeOf(status, projectId)

  // Tell the person how a scan they were watching ended (not one that finished before this page opened).
  useEffect(() => {
    if (!ready) return
    if (wasScanning.current && !status.scanning && status.last) {
      const l = status.last
      if (l.activity === "relink") {
        if (l.kind === "done") {
          const bad = l.failed ? ` ${l.failed} could not be moved.` : ""
          toast.success(`Copied ${(l.copied ?? 0) + (l.reused ?? 0)} files into the project and relinked ${l.items ?? 0} items.${l.trashed ? ` Moved ${l.trashed} originals to the Trash.` : ""} Save the project in After Effects.${bad}`)
        } else toast.error(l.message ?? "Copy & relink failed.")
      } else if (l.kind === "done") {
        recordGreetingEvent("scanned", projectName ?? null)
        toast.success(`Scan finished: ${l.comps ?? 0} compositions, ${l.colors ?? 0} colors, ${l.expressions ?? 0} expressions.`)
      }
      else if (l.kind === "cancelled") toast("Scan cancelled. Nothing touched. Promise.")
      else toast.error(l.message ?? "The scan failed.")
    }
    wasScanning.current = status.scanning && status.projectId === projectId
  }, [status, ready, projectId, projectName])

  // Work has started (or the request failed): the "starting" state is over.
  useEffect(() => {
    if (status.scanning) setPending(false)
  }, [status.scanning])
  useEffect(() => {
    if (!pending) return
    const t = window.setTimeout(() => {
      setPending(false)
      toast.error("After Effects went quiet. Make sure this project is open there, then try again.")
    }, 20000)
    return () => window.clearTimeout(t)
  }, [pending])

  async function scan() {
    if (pending) return
    setPending(true)
    try {
      await api.companionScan(projectId)
    } catch (e) {
      setPending(false)
      toast.error(errorMessage(e))
    }
  }

  async function cancel() {
    try {
      await api.companionCancel()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const p = status.progress
  const progress =
    mode === "scanning" && p && p.total > 0
      ? `${status.activity === "relink" ? "Copying" : "Scanning"} ${p.compName || "…"} (${Math.min(p.done + 1, p.total)} of ${p.total})`
      : mode === "scanning" && status.activity === "relink"
        ? "Copying files…"
        : mode === "scanning"
          ? "Scanning…"
          : LABEL[mode]

  return (
    <div className="flex items-center gap-2" title={HINT[mode] || undefined}>
      {!(hideIdleLabel && mode !== "scanning") && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Radio className={mode === "ready" || mode === "scanning" ? "size-3.5 text-emerald-500" : "size-3.5"} aria-hidden />
          {progress}
        </span>
      )}
      {mode === "scanning" ? (
        <Button variant="outline" size="sm" onClick={() => void cancel()}>
          <X /> {status.activity === "relink" ? "Cancel" : "Cancel scan"}
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled={mode !== "ready" || pending} onClick={() => void scan()}>
          {pending ? <Loader2 className="animate-spin" /> : <ScanLine />} {pending ? "Starting…" : "Scan"}
        </Button>
      )}
    </div>
  )
}
