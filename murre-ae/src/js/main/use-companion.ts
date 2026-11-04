import { useCallback, useEffect, useRef, useState } from "react";
import type { AepInfo } from "../../shared/scan-types";
import { evalTS } from "../lib/utils/bolt";
import { parseCompsFile, sameAep, withMain, type CompsFile } from "../lib/murre/comps-model";
import { cepIo } from "../lib/murre/io";
import { findProject, type ProjectLink } from "../lib/murre/project-link";
import { parseAssetsFile, type AssetsFile } from "../lib/murre/assets-model";
import { runRelink, type RelinkSummary } from "../lib/murre/assets-flow";
import { aepRefOf, runScan, ScanCancelled, type ScanHost, type ScanProgress, type ScanSummary } from "../lib/murre/scanner";
import { readSnapshot, writeSnapshot } from "../lib/murre/snapshot-store";
import { readProjectSettings, writeProjectSettings, type ProjectSettings } from "../lib/murre/settings";
import { NO_PROJECT, setMenuHandler, setMenuState, type SettingsPatch } from "../lib/utils/panel-prefs";
import type { AppCommand, BridgeClient, VersionFile } from "../lib/murre/bridge-client";
import { createBridge, messageOf } from "./create-bridge";
import { host, trash } from "./host";
import { handleCreateStarter, handleImportImage, handleReveal, handleSaveAs, handleInspect, PANEL_BEAT_EVENT, PANEL_BEAT_MS } from "../lib/murre/starter-flow";
import { csi } from "../lib/utils/bolt";
import { CSEvent } from "../lib/cep/csinterface";

export type LinkState =
  | { kind: "checking" }
  /** Not running inside After Effects (e.g. the dev server opened in a browser). */
  | { kind: "outside" }
  | { kind: "unsaved" }
  | { kind: "none"; path: string }
  | { kind: "error"; message: string }
  | { kind: "linked"; info: AepInfo; link: ProjectLink };

export type ScanState =
  | { kind: "idle" }
  | { kind: "running"; progress: ScanProgress | null; cancelling: boolean }
  | { kind: "done"; summary: ScanSummary }
  | { kind: "failed"; message: string };

export type RelinkState =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number; name: string }
  | { kind: "done"; summary: RelinkSummary }
  | { kind: "failed"; message: string };

const POLL_MS = 4000;
const reportOf = (link: LinkState, scan: ScanState, relink: RelinkState) => ({
  source: "panel" as const,
  aepPath: link.kind === "linked" ? link.info.path : link.kind === "none" ? link.path : null,
  projectId: link.kind === "linked" ? link.link.projectId : null,
  scanning: scan.kind === "running" || relink.kind === "running",
  activity: scan.kind === "running" ? ("scan" as const) : relink.kind === "running" ? ("relink" as const) : null,
});

export interface AddProjectState {
  /** The request this panel sent, so answers to someone else's request are not mixed in. */
  requestId: string;
  text: string;
  done: boolean;
  ok: boolean;
}

export function useCompanion() {
  const [addState, setAddState] = useState<AddProjectState | null>(null);
  const [versions, setVersions] = useState<{ requestId: string; files: VersionFile[] } | null>(null);
  const versionsRequest = useRef<string | null>(null);
  const [link, setLink] = useState<LinkState>({ kind: "checking" });
  const [comps, setComps] = useState<CompsFile | null>(null);
  const [compsError, setCompsError] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanState>({ kind: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetsFile | null>(null);
  const [relink, setRelink] = useState<RelinkState>({ kind: "idle" });
  /** The linked project's settings (the app's Settings tab shows the same file); null when no project is linked. */
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const lastPath = useRef<string | null>(null);
  const cancelRequested = useRef(false);
  const scanning = useRef(false);
  const latest = useRef(0);
  const [appLinked, setAppLinked] = useState(false);
  const [appLinkDetail, setAppLinkDetail] = useState("");
  const bridge = useRef<BridgeClient | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const linkRef = useRef<LinkState>({ kind: "checking" });
  const scanRef = useRef<ScanState>({ kind: "idle" });
  const relinkRef = useRef<RelinkState>({ kind: "idle" });
  const actions = useRef<{ start: () => Promise<void>; relink: () => Promise<void>; cancel: () => void }>({ start: async () => {}, relink: async () => {}, cancel: () => {} });
  linkRef.current = link;
  scanRef.current = scan;
  relinkRef.current = relink;

  const loadComps = useCallback((root: string) => {
    // Looked at on every refresh, so a change made in the app shows up here within a few seconds.
    setSettings(readProjectSettings(cepIo(), root));
    try {
      setComps(parseCompsFile(readSnapshot(cepIo(), root, "comps.json")));
      setCompsError(null);
      try {
        setAssets(parseAssetsFile(readSnapshot(cepIo(), root, "assets.json")));
      } catch {
        setAssets(null);
      }
    } catch (e) {
      setComps(null);
      setCompsError(messageOf(e));
    }
  }, []);

  /** Look at the active After Effects project and find the Murre project it belongs to. */
  const refresh = useCallback(async () => {
    const ticket = ++latest.current;
    if (typeof window.cep === "undefined") {
      setLink({ kind: "outside" });
      return;
    }
    try {
      const info = await evalTS("getAepInfo");
      if (ticket !== latest.current) return;
      // A different file is now active: results of the previous one no longer apply.
      if (info.path !== lastPath.current) {
        lastPath.current = info.path;
        if (!scanning.current) {
          setScan({ kind: "idle" });
          setRelink({ kind: "idle" });
          setNotice(null);
        }
      }
      if (!info.saved || !info.path) {
        setLink({ kind: "unsaved" });
        setComps(null);
        return;
      }
      const found = findProject(cepIo(), info.path);
      if (found.kind === "linked") {
        setLink({ kind: "linked", info, link: found.link });
        loadComps(found.link.root);
      } else if (found.kind === "none") {
        setLink({ kind: "none", path: info.path });
        setComps(null);
      } else {
        setLink({ kind: "error", message: found.message });
        setComps(null);
      }
    } catch (e) {
      if (ticket === latest.current) setLink({ kind: "error", message: `Could not talk to After Effects: ${messageOf(e)}` });
    }
  }, [loadComps]);

  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    // The panel cannot be told when another project is opened, so look again now and then
    // (only while it is visible and no scan is running).
    const timer = window.setInterval(() => {
      // Keep looking while linked to the app even if the panel is hidden: the app relies on it.
      if ((document.visibilityState === "visible" || bridge.current !== null) && !scanning.current) void refresh();
    }, POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const startScan = useCallback(async () => {
    if (scanning.current) return;
    scanning.current = true;
    cancelRequested.current = false;
    setNotice(null);
    setScan({ kind: "running", progress: null, cancelling: false });
    try {
      const summary = await runScan(host, cepIo(), {
        isCancelled: () => cancelRequested.current,
        trash,
        onProgress: (progress) => {
          setScan({ kind: "running", progress, cancelling: cancelRequested.current });
          bridge.current?.sendProgress(progress.done, progress.total, progress.compName);
        },
      });
      setScan({ kind: "done", summary });
      bridge.current?.sendDone(summary.counts.colors, summary.counts.expressions, summary.counts.comps);
      loadComps(summary.link.root);
    } catch (e) {
      setScan(e instanceof ScanCancelled ? { kind: "idle" } : { kind: "failed", message: `Scan didn’t finish: ${messageOf(e)}` });
      if (e instanceof ScanCancelled) {
        setNotice(e.message);
        bridge.current?.sendCancelled();
      } else {
        bridge.current?.sendFailed(`Scan failed: ${messageOf(e)}`);
      }
    } finally {
      scanning.current = false;
    }
  }, [loadComps]);

  /** Manual "Copy & relink": copy outside files into the project and point After Effects at the copies. */
  const startRelink = useCallback(async () => {
    if (scanning.current) return;
    scanning.current = true;
    cancelRequested.current = false;
    setNotice(null);
    setRelink({ kind: "running", done: 0, total: 0, name: "" });
    bridge.current?.sendProgress(0, 0, "", "relink");
    try {
      const summary = await runRelink(
        { ...host, getAepInfo: host.getAepInfo },
        cepIo(),
        {
          isCancelled: () => cancelRequested.current,
          trash,
          onProgress: (done, total, name) => {
            setRelink({ kind: "running", done, total, name });
            bridge.current?.sendProgress(done, total, name, "relink");
          },
        },
      );
      setRelink({ kind: "done", summary });
      bridge.current?.sendRelinkDone(summary.report.copied.length, summary.report.reused.length, summary.report.failed.length, summary.report.relinkedItems, summary.report.trashed.length);
      loadComps(summary.link.root);
    } catch (e) {
      setRelink({ kind: "failed", message: messageOf(e) });
      bridge.current?.sendRelinkFailed(messageOf(e));
      const cur = linkRef.current;
      if (cur.kind === "linked") loadComps(cur.link.root);
    } finally {
      scanning.current = false;
    }
  }, [loadComps]);

  const cancelScan = useCallback(() => {
    cancelRequested.current = true;
    setScan((s) => (s.kind === "running" ? { ...s, cancelling: true } : s));
  }, []);

  actions.current = { start: startScan, relink: startRelink, cancel: cancelScan };

  // The project's "scan automatically" setting. While the Murre app is connected it runs the timer itself, so the panel only does it
  // when the app is not there (otherwise every scan would happen twice). Only a linked project is scanned, never on top of another scan or relink.
  const autoScanMinutes = settings?.autoScanMinutes ?? 0;
  useEffect(() => {
    if (autoScanMinutes <= 0 || appLinked) return;
    const t = window.setInterval(() => {
      if (scanning.current || linkRef.current.kind !== "linked") return;
      void actions.current.start();
    }, autoScanMinutes * 60_000);
    return () => window.clearInterval(t);
  }, [autoScanMinutes, appLinked]);

  /** Change a project setting from the right-click menu: written to the same file the app's Settings tab uses. */
  const changeSettings = useCallback((patch: SettingsPatch) => {
    const cur = linkRef.current;
    if (cur.kind !== "linked") return;
    try {
      setSettings(writeProjectSettings(cepIo(), cur.link.root, patch));
      setNotice(null);
    } catch (e) {
      setNotice(`Could not save the setting: ${messageOf(e)}`);
    }
  }, []);

  useEffect(() => {
    setMenuHandler(changeSettings);
  }, [changeSettings]);
  useEffect(() => {
    if (link.kind !== "linked") setSettings(null);
  }, [link.kind]);
  useEffect(() => {
    setMenuState(link.kind === "linked" && settings ? { enabled: true, manualRelink: !settings.copyRelinkOnScan, autoScan: settings.autoScanMinutes } : NO_PROJECT);
  }, [link.kind, settings]);

  const onCommand = useCallback((cmd: AppCommand) => {
    if (cmd.kind === "inspect") {
      const client = bridge.current;
      if (client) void handleInspect(cmd.requestId, () => evalTS("inspectAe"), client);
      return;
    }
    if (cmd.kind === "versions") {
      // Only the answer to the latest question counts.
      if (cmd.requestId === versionsRequest.current) setVersions({ requestId: cmd.requestId, files: cmd.files });
      return;
    }
    if (cmd.kind === "addProjectStatus") {
      setAddState({ requestId: cmd.requestId, text: cmd.text, done: cmd.done, ok: cmd.ok });
      if (cmd.done) void refreshRef.current();
      return;
    }
    if (cmd.kind === "saveAs") {
      const client = bridge.current;
      if (client) void handleSaveAs(cmd.requestId, cmd.path, (p) => evalTS("saveProjectAs", p), client).then(() => refreshRef.current());
      return;
    }
    if (cmd.kind === "reveal") {
      const client = bridge.current;
      if (client) void handleReveal(cmd.requestId, cmd, (t) => evalTS("revealUsage", t.compId, t.compName, t.layerIndex, t.layerName, t.propertyPath), client);
      return;
    }
    if (cmd.kind === "importImage") {
      const client = bridge.current;
      if (client) void handleImportImage(cmd.requestId, cmd.path, (p, shapes) => evalTS("importImage", p, shapes), client, cmd.asShapes === true);
      return;
    }
    if (cmd.kind === "createStarter") {
      const client = bridge.current;
      if (!client) return;
      if (scanning.current) {
        client.sendStarterFailed(cmd.requestId, "The Companion is busy with a scan.");
        return;
      }
      void handleCreateStarter(cmd, (c) => evalTS("createStarter", c.path, c.compName, c.width, c.height, c.fps, c.seconds, c.rescueDir), client);
      return;
    }
    if (cmd.kind === "cancel") {
      if (scanning.current) actions.current.cancel();
      return;
    }
    const current = linkRef.current;
    if (scanning.current) return; // the app checks this too; a second request is simply ignored
    if (current.kind !== "linked" || current.link.projectId !== cmd.projectId) {
      bridge.current?.sendFailed("After Effects does not have this Murre project open. Open its .aep file there, then try again.");
      return;
    }
    void (cmd.kind === "relink" ? actions.current.relink() : actions.current.start());
  }, []);

  // Tell the hidden background helper that this panel is open, so only one of them holds the app link.
  useEffect(() => {
    if (typeof window.cep === "undefined") return;
    const beat = () => {
      try {
        const ev = new CSEvent(PANEL_BEAT_EVENT, "APPLICATION", csi.getApplicationID() as string, csi.getExtensionID() as string);
        ev.data = String(Date.now());
        csi.dispatchEvent(ev);
      } catch {
        /* the helper simply keeps the link */
      }
    };
    beat();
    const t = window.setInterval(beat, PANEL_BEAT_MS);
    return () => window.clearInterval(t);
  }, []);

  // Connect to the desktop app (if it is running) and keep trying.
  useEffect(() => {
    const { client, why } = createBridge({
      onConnection: setAppLinked,
      onDetail: setAppLinkDetail,
      onCommand,
      currentState: () => reportOf(linkRef.current, scanRef.current, relinkRef.current),
    });
    bridge.current = client;
    if (client) client.start();
    else setAppLinkDetail(why);
    return () => {
      client?.stop();
      bridge.current = null;
    };
  }, [onCommand]);

  // Tell the app what is open and whether a scan is running.
  useEffect(() => {
    bridge.current?.sendState(reportOf(link, scan, relink));
  }, [link, scan, relink]);

  /** Mark or unmark a composition as a Main Comp, writing a complete comps.json. */
  const setMain = useCallback(
    (compId: number, main: boolean) => {
      if (link.kind !== "linked") return;
      try {
        const io = cepIo();
        const current = parseCompsFile(readSnapshot(io, link.link.root, "comps.json"));
        if (!current) throw new Error("Give the project a scan first.");
        if (!sameAep(current.aep, aepRefOf(link.link, link.info))) {
          throw new Error("These compositions are from a different project file. Scan this project first.");
        }
        writeSnapshot(io, link.link.root, "comps.json", withMain(current, compId, main));
        setNotice(null);
        loadComps(link.link.root);
      } catch (e) {
        setNotice(`Could not save the change: ${messageOf(e)}`);
      }
    },
    [link, loadComps],
  );

  /** Ask the app to build a Murre project around the project that is open in After Effects. */
  const addProject = useCallback((name: string, parentDir: string, versionNames: string[] = []) => {
    const client = bridge.current;
    if (!client) return false;
    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    setAddState({ requestId, text: "Sending to Murre…", done: false, ok: true });
    client.sendAddProject(requestId, name, parentDir, versionNames);
    return true;
  }, []);

  /** Ask the app which other versions are saved next to the open project. */
  const listVersions = useCallback(() => {
    const client = bridge.current;
    if (!client) return;
    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    versionsRequest.current = requestId;
    setVersions(null);
    client.sendListVersions(requestId);
  }, []);

  return { addState, addProject, versions: versions?.files ?? null, listVersions, link, comps, compsError, scan, notice, settings, appLinked, appLinkDetail, refresh, startScan, cancelScan, setMain, assets, relink, startRelink };
}
