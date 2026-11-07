import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, MantineProvider, Text, Tooltip } from "@mantine/core";
// Mantine's component styles. Everything except `@mantine/hooks` needs this import.
import "@mantine/core/styles.css";
import { shadcnCssVariableResolver } from "./cssVariablesResolver";
import { panelTheme as theme } from "./panel-theme";
import "./style.css";
import "./main.scss";
import { suggestName } from "../lib/murre/starter-flow";
import type { RelinkSummary } from "../lib/murre/assets-flow";
import type { ScanSummary } from "../lib/murre/scanner";
import { RENDER_LETTERS, nextRenderKind, type RenderKind } from "../../shared/render-folders";
import { useCompanion, type LinkState, type QueueState, type RelinkState, type ScanState } from "./use-companion";
import { CheckIcon, LinkIcon, PackageIcon, QueueIcon, ScanIcon, UnlinkIcon } from "./icons";
import murreIcon from "../assets/murre-icon.png";
import { csi } from "../lib/utils/bolt";
import { CSEvent } from "../lib/cep/csinterface";
import { ADD_DIALOG_ID, ADD_EVENTS, parseAddChoice } from "../lib/murre/add-dialog";


/** The colour behind the panel for each project status, the same hues as the Murre app. Files outside Murre get "Not started". */
const STATUS_COLOR: Record<string, string> = {
  not_started: "#64748b",
  in_progress: "#1d4ed8",
  in_review: "#c2610c",
  quality_check: "#6d28d9",
  completed: "#15803d",
  archived: "#525252",
};

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const KIND_KEY = "murre.renderKind";
const readKind = (): RenderKind => {
  try {
    const v = localStorage.getItem(KIND_KEY);
    return v === "pre" || v === "render" || v === "deliverable" ? v : "render";
  } catch {
    return "render";
  }
};

/** `null`: nothing running; a number from 0 to 1: how far; `"spin"`: running, amount unknown. */
type Progress = number | "spin" | null;

/** One square button of the row. Progress is drawn as a ring around its edge; a problem as a red dot, explained in the tooltip. */
function Tile({
  label,
  onClick,
  disabled,
  dim,
  progress = null,
  error,
  done,
  children,
  testId,
}: {
  label: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Drawn faded but still explains itself on hover. */
  dim?: boolean;
  progress?: Progress;
  error?: string | null;
  /** Show a tick instead of the icon for a moment. */
  done?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Tooltip label={error || label} multiline maw={240} openDelay={250} withArrow color={error ? "red" : "dark"} styles={{ tooltip: { whiteSpace: "pre-line" } }}>
      <button
        type="button"
        className="tile"
        data-dim={dim || undefined}
        aria-disabled={disabled || undefined}
        aria-label={typeof (error || label) === "string" ? (error || label) as string : undefined}
        onClick={disabled ? undefined : onClick}
        data-testid={testId}
      >
        {done ? <CheckIcon /> : children}
        {progress !== null && (
          <svg className="tile-ring" data-spin={progress === "spin" || undefined} viewBox="0 0 48 48" aria-hidden>
            <rect x="1" y="1" width="46" height="46" rx="11" pathLength={100} strokeDasharray={progress === "spin" ? "22 78" : `${Math.max(2, progress * 100)} 100`} />
          </svg>
        )}
        {error && <span className="tile-error" aria-hidden />}
      </button>
    </Tooltip>
  );
}

/** True for a few seconds after `at`. */
function useRecent(at: number | null, ms = 1600) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (at === null) return;
    setOn(true);
    const t = window.setTimeout(() => setOn(false), ms);
    return () => window.clearTimeout(t);
  }, [at, ms]);
  return on;
}

const scanSummary = (s: ScanSummary): string =>
  [
    `${plural(s.counts.comps, "comp")} · ${plural(s.counts.colors, "color")} · ${plural(s.counts.expressions, "expression")}`,
    s.organized > 0 ? `${plural(s.organized, "item")} organized · save to keep` : "",
    s.unmatchedMain.length > 0 ? `Unmarked: ${s.unmatchedMain.map((m) => m.name).join(", ")}` : "",
    ...s.warnings,
  ]
    .filter(Boolean)
    .join("\n");

const counter = (done: number, total: number) => `${Math.min(done + 1, total)} of ${total}`;

function scanTile(scan: ScanState): { label: string; progress: Progress; error: string | null } {
  if (scan.kind === "running") {
    if (scan.cancelling) return { label: "Cancelling…", progress: "spin", error: null };
    const p = scan.progress;
    if (!p || p.total === 0) return { label: "Scanning… · click to cancel", progress: "spin", error: null };
    return { label: `Scanning ${counter(p.done, p.total)} · click to cancel`, progress: p.done / p.total, error: null };
  }
  if (scan.kind === "failed") return { label: "Scan", progress: null, error: scan.message };
  if (scan.kind === "done") return { label: `Scan\n${scanSummary(scan.summary)}`, progress: null, error: null };
  return { label: "Scan", progress: null, error: null };
}

const relinkLine = (r: RelinkSummary): string => {
  if (r.report.relinkedItems === 0 && r.report.failed.length === 0) return "Nothing to relink";
  const failed = r.report.failed.length ? ` · ${r.report.failed.length} failed` : "";
  return `Relinked ${plural(r.report.relinkedItems, "item")} · save to keep${failed}`;
};

/**
 * The Link button shows the project's relink setting: a white link when files are copied in and relinked on every scan, a grey broken
 * link when that is off ("Relink assets manually" in the panel menu). Either way, clicking it copies and relinks now when files are outside.
 */
function linkTile(relink: RelinkState, outside: number | null, autoOnScan: boolean, scanning: boolean) {
  const look = autoOnScan ? ("auto" as const) : ("manual" as const);
  if (relink.kind === "running") {
    const label = relink.total > 0 ? `Copying ${counter(relink.done, relink.total)} · click to cancel` : "Copying… · click to cancel";
    return { look, label, progress: (relink.total > 0 ? relink.done / relink.total : "spin") as Progress, error: null, clickable: true };
  }
  const error = relink.kind === "failed" ? relink.message : null;
  const lines = [autoOnScan ? "Auto relink on" : "Auto relink off"];
  if (!scanning && outside) lines.push(`Click to relink ${plural(outside, "file")}`);
  if (relink.kind === "done") lines.push(relinkLine(relink.summary));
  return { look, label: lines.join("\n"), progress: null, error, clickable: !scanning && !!outside };
}

const KIND_NAMES: Record<RenderKind, string> = { pre: "Pre-Renders", render: "Renders", deliverable: "Deliverables" };

function queueLabel(queue: QueueState, kind: RenderKind): { label: string; error: string | null } {
  if (queue.kind === "busy") return { label: "Adding…", error: null };
  if (queue.kind === "failed") return { label: "", error: queue.message };
  if (queue.kind === "done") return { label: `Added ${queue.comp}`, error: null };
  return { label: `Add to Render Queue → ${KIND_NAMES[kind]}`, error: null };
}

/** The row of buttons for a file that belongs to a Murre project. */
function Actions({ c }: { c: ReturnType<typeof useCompanion> }) {
  const { scan, relink, assets, settings, startScan, cancelScan, startRelink, queue, queueRender, showApp, notice, compsError } = c;
  const [kind, setKind] = useState<RenderKind>(readKind);
  const [appError, setAppError] = useState<{ which: "package" | "app"; text: string; at: number } | null>(null);
  const appErrorShown = useRecent(appError?.at ?? null, 6000);

  const scanning = scan.kind === "running";
  const relinking = relink.kind === "running";
  const s = scanTile(scan);
  const outside = assets ? assets.assets.filter((a) => a.status === "outside").length : null;
  const l = linkTile(relink, outside, settings?.copyRelinkOnScan !== false, scanning);
  const q = queueLabel(queue, kind);
  const queued = useRecent(queue.kind === "done" ? queue.at : null);

  const pickKind = () => {
    const next = nextRenderKind(kind);
    setKind(next);
    try {
      localStorage.setItem(KIND_KEY, next);
    } catch {
      /* remembered for this session only */
    }
  };
  const openApp = (which: "package" | "app") => {
    const problem = showApp(which === "package" ? "package" : null);
    setAppError(problem ? { which, text: problem, at: Date.now() } : null);
  };
  const appErr = (which: "package" | "app") => (appErrorShown && appError?.which === which ? appError.text : null);

  return (
    <div className="tiles">
      <Tile label={s.label} progress={s.progress} error={s.error || notice || compsError} disabled={relinking || (scanning && scan.cancelling)} onClick={() => (scanning ? cancelScan() : void startScan())} testId="scan">
        <ScanIcon />
      </Tile>
      <Tile
        label={l.label}
        progress={l.progress}
        error={l.error}
        dim={l.look === "manual"}
        disabled={!l.clickable}
        onClick={() => (relinking ? cancelScan() : void startRelink())}
        testId="relink"
      >
        {l.look === "manual" ? <UnlinkIcon /> : <LinkIcon />}
      </Tile>
      <Tile label={q.label} error={q.error} progress={queue.kind === "busy" ? "spin" : null} done={queued} disabled={queue.kind === "busy"} onClick={() => void queueRender(kind)} testId="queue">
        <QueueIcon />
      </Tile>
      <Tile label={`Render to ${KIND_NAMES[kind]}`} onClick={pickKind} testId="render-kind">
        <span className="tile-letter">{RENDER_LETTERS[kind]}</span>
      </Tile>
      <Tile label="Package" error={appErr("package")} onClick={() => openApp("package")} testId="package">
        <PackageIcon />
      </Tile>
      <Tooltip label={appErr("app") || "Open Murre"} color={appErr("app") ? "red" : "dark"} withArrow openDelay={250}>
        <button type="button" className="tile tile-app" aria-label="Open Murre" onClick={() => openApp("app")} data-testid="open-app">
          <img src={murreIcon} alt="" draggable={false} />
          {appErr("app") && <span className="tile-error" aria-hidden />}
        </button>
      </Tooltip>
    </div>
  );
}

function dispatch(type: string, data: object) {
  const ev = new CSEvent(type, "APPLICATION", csi.getApplicationID() as string, csi.getExtensionID() as string);
  ev.data = JSON.stringify(data);
  csi.dispatchEvent(ev);
}

/** A file outside Murre: one button. Clicking it opens the "Add to Murre" popup, which asks for the project's name and folder. */
function AddToMurre({ c, link }: { c: ReturnType<typeof useCompanion>; link: Extract<LinkState, { kind: "none" } | { kind: "unsaved" }> }) {
  const { appLinked, addState, addProject, versions, listVersions } = c;
  const openPath = link.kind === "none" ? link.path : null;
  const busy = !!addState && !addState.done;
  const [openError, setOpenError] = useState<string | null>(null);
  // What the popup's events need, kept current without re-subscribing.
  const latest = useRef({ name: suggestName(openPath), versions: [] as string[], addProject });
  latest.current = { name: suggestName(openPath), versions: (versions ?? []).map((v) => v.name), addProject };

  // Other versions saved beside this file come along, as before (they were all ticked by default).
  useEffect(() => {
    if (appLinked && openPath) listVersions();
  }, [appLinked, openPath]);

  // The popup says it's ready (send it the suggested name), then sends back the name and folder.
  useEffect(() => {
    if (typeof window.cep === "undefined") return;
    const onReady = () => dispatch(ADD_EVENTS.init, { name: latest.current.name });
    const onResult = (e: { data?: unknown }) => {
      const choice = parseAddChoice(e.data);
      if (choice) latest.current.addProject(choice.name, choice.dir, latest.current.versions);
    };
    csi.addEventListener(ADD_EVENTS.ready, onReady);
    csi.addEventListener(ADD_EVENTS.result, onResult);
    return () => {
      csi.removeEventListener(ADD_EVENTS.ready, onReady, null);
      csi.removeEventListener(ADD_EVENTS.result, onResult, null);
    };
  }, []);

  const open = () => {
    setOpenError(null);
    try {
      csi.requestOpenExtension(ADD_DIALOG_ID, "");
    } catch (e) {
      setOpenError(`Couldn’t open the window: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (busy) {
    return (
      <Button fullWidth disabled data-testid="add-project">
        {addState.text}
      </Button>
    );
  }
  return (
    <div className="add">
      <Tooltip label="Open the Murre app first." disabled={appLinked} withArrow>
        <Button fullWidth onClick={() => appLinked && open()} data-disabled={!appLinked || undefined} data-testid="add-project">
          Add this Project to Murre
        </Button>
      </Tooltip>
      {openError && (
        <Text size="xs" c="red.4" role="alert">
          {openError}
        </Text>
      )}
      {addState?.done && !addState.ok && (
        <Text size="xs" c="red.4" role="alert">
          {addState.text}
        </Text>
      )}
    </div>
  );
}

/** The panel itself: everything the person sees, drawn from what the Companion hook reports. */
function Panel() {
  const c = useCompanion();
  const { link, appLinked, appLinkDetail } = c;
  const status = link.kind === "linked" ? link.link.status : "not_started";
  const color = STATUS_COLOR[status] ?? STATUS_COLOR.not_started;

  return (
    <div className="sx" style={{ backgroundImage: `linear-gradient(to top right, #1e1e1e 30%, ${color} 140%)` }}>
      <header className="sx-header" role="status" title={[link.kind === "linked" ? link.link.projectName : "", appLinkDetail].filter(Boolean).join("\n") || undefined}>
        <span className="sx-dot" data-on={appLinked} />
        <span>{appLinked ? "App Connected" : appLinkDetail ? "App Not Connected" : "Looking for the app…"}</span>
      </header>

      {link.kind === "linked" && <Actions c={c} />}
      {(link.kind === "none" || link.kind === "unsaved") && <AddToMurre c={c} link={link} />}
      {link.kind === "error" && (
        <Text size="xs" c="red.4" role="alert">
          {link.message}
        </Text>
      )}
    </div>
  );
}

export const App = () => {
  useEffect(() => {
    document.body.style.backgroundColor = "#1e1e1e";
  }, []);

  return (
    <MantineProvider theme={theme} cssVariablesResolver={shadcnCssVariableResolver} forceColorScheme="dark">
      <Panel />
    </MantineProvider>
  );
};
