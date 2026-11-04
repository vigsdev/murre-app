/**
 * Hidden helper that After Effects starts by itself (no window). While the Companion panel is closed or
 * not docked it keeps the link to the Murre app and does everything the panel would do for the app:
 * scan, copy and relink, cancel, create a project, say what is open. While the panel is open it owns the
 * link and the helper drops its own, so the two never fight over it.
 */
import { initBolt, csi, evalTS } from "../lib/utils/bolt";
import { createBridge, messageOf } from "../main/create-bridge";
import { host, trash } from "../main/host";
import { handleCreateStarter, handleImportImage, handleReveal, handleSaveAs, handleInspect, backgroundShouldConnect, PANEL_BEAT_EVENT } from "../lib/murre/starter-flow";
import type { AppCommand, BridgeClient, PanelStateMsg } from "../lib/murre/bridge-client";
import { cepIo } from "../lib/murre/io";
import { findProject } from "../lib/murre/project-link";
import { runScan, ScanCancelled } from "../lib/murre/scanner";
import { runRelink } from "../lib/murre/assets-flow";

initBolt();

let lastBeat: number | null = null;
let client: BridgeClient | null = null;
let busy: "scan" | "relink" | null = null;
let cancelRequested = false;
let state: PanelStateMsg = { aepPath: null, projectId: null, scanning: false, activity: null, source: "background" };

const idle = (aepPath: string | null, projectId: string | null): PanelStateMsg => ({
  aepPath,
  projectId,
  scanning: busy !== null,
  activity: busy,
  source: "background",
});

/** Which Murre project is open in After Effects. */
async function currentProject(): Promise<{ aepPath: string | null; projectId: string | null }> {
  try {
    const info = await evalTS("getAepInfo");
    if (!info.saved || !info.path) return { aepPath: null, projectId: null };
    const found = findProject(cepIo(), info.path);
    return { aepPath: info.path, projectId: found.kind === "linked" ? found.link.projectId : null };
  } catch {
    return { aepPath: null, projectId: null };
  }
}

async function refreshState() {
  if (busy) return; // the state was already sent when the work started
  const p = await currentProject();
  state = idle(p.aepPath, p.projectId);
  client?.sendState(state);
}

function setBusy(kind: "scan" | "relink" | null) {
  busy = kind;
  state = { ...state, scanning: kind !== null, activity: kind };
  client?.sendState(state);
}

async function doScan(c: BridgeClient) {
  setBusy("scan");
  cancelRequested = false;
  try {
    // Copy-and-relink and "move originals" come from the project's own settings, read inside the scan.
    const summary = await runScan(host, cepIo(), {
      isCancelled: () => cancelRequested,
      trash,
      onProgress: (p) => c.sendProgress(p.done, p.total, p.compName),
    });
    c.sendDone(summary.counts.colors, summary.counts.expressions, summary.counts.comps);
  } catch (e) {
    if (e instanceof ScanCancelled) c.sendCancelled();
    else c.sendFailed(`Scan failed: ${messageOf(e)}`);
  } finally {
    setBusy(null);
    void refreshState();
  }
}

async function doRelink(c: BridgeClient) {
  setBusy("relink");
  cancelRequested = false;
  c.sendProgress(0, 0, "", "relink");
  try {
    const summary = await runRelink(host, cepIo(), {
      isCancelled: () => cancelRequested,
      trash,
      onProgress: (done, total, name) => c.sendProgress(done, total, name, "relink"),
    });
    c.sendRelinkDone(summary.report.copied.length, summary.report.reused.length, summary.report.failed.length, summary.report.relinkedItems, summary.report.trashed.length);
  } catch (e) {
    c.sendRelinkFailed(messageOf(e));
  } finally {
    setBusy(null);
    void refreshState();
  }
}

async function onCommand(cmd: AppCommand) {
  const c = client;
  if (!c) return;
  if (cmd.kind === "inspect") return void handleInspect(cmd.requestId, () => evalTS("inspectAe"), c);
  if (cmd.kind === "addProjectStatus" || cmd.kind === "versions") return;
  if (cmd.kind === "saveAs") {
    return void handleSaveAs(cmd.requestId, cmd.path, (p) => evalTS("saveProjectAs", p), c).then(() => refreshState());
  }
  if (cmd.kind === "reveal") {
    return void handleReveal(cmd.requestId, cmd, (t) => evalTS("revealUsage", t.compId, t.compName, t.layerIndex, t.layerName, t.propertyPath), c);
  }
  if (cmd.kind === "importImage") {
    return void handleImportImage(cmd.requestId, cmd.path, (p, shapes) => evalTS("importImage", p, shapes), c, cmd.asShapes === true);
  }
  if (cmd.kind === "cancel") {
    if (busy) cancelRequested = true;
    return;
  }
  if (cmd.kind === "createStarter") {
    if (busy) return c.sendStarterFailed(cmd.requestId, "The Companion is busy with a scan.");
    return void handleCreateStarter(cmd, (r) => evalTS("createStarter", r.path, r.compName, r.width, r.height, r.fps, r.seconds, r.rescueDir), c);
  }
  if (busy) return; // the app checks this too
  // Scan or relink: only for the project that is really open in After Effects.
  const open = await currentProject();
  if (open.projectId !== cmd.projectId) {
    c.sendFailed("After Effects does not have this Murre project open. Open its .aep file there, then try again.");
    return;
  }
  return void (cmd.kind === "relink" ? doRelink(c) : doScan(c));
}

csi.addEventListener(PANEL_BEAT_EVENT, () => {
  lastBeat = Date.now();
  stop(); // react at once: the panel is about to connect
});

function stop() {
  client?.stop();
  client = null;
  busy = null;
}

function start() {
  if (client) return;
  const made = createBridge({
    onConnection: () => {},
    onCommand: (cmd) => void onCommand(cmd),
    currentState: () => state,
  });
  client = made.client;
  client?.start();
  void refreshState();
}

let n = 0;
function tick() {
  if (backgroundShouldConnect(Date.now(), lastBeat)) {
    start();
    if (++n % 2 === 0) void refreshState(); // every 4 s
  } else stop();
}

tick();
setInterval(tick, 2000);
