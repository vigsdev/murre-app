/**
 * Handling of the app's "create the project file" request. Shared by the panel and the hidden
 * background extension, so it works whether or not the panel is open.
 */
import type { StarterCommand } from "./bridge-client";

export interface StarterResult {
  ok: boolean;
  path: string;
  message: string;
  previous?: string;
}

export interface InspectResult {
  kind: string;
  name: string;
  path: string;
}

export interface StarterReply {
  sendStarterDone(requestId: string, path: string, previous?: string): void;
  sendStarterFailed(requestId: string, message: string): void;
}

/** Runs the request in After Effects and tells the app how it went. Never throws. */
export async function handleCreateStarter(
  cmd: StarterCommand,
  run: (c: StarterCommand) => Promise<StarterResult>,
  reply: StarterReply,
): Promise<void> {
  try {
    const r = await run(cmd);
    if (r && r.ok) reply.sendStarterDone(cmd.requestId, r.path || cmd.path, r.previous || "");
    else reply.sendStarterFailed(cmd.requestId, (r && r.message) || "After Effects could not create the project.");
  } catch (e) {
    reply.sendStarterFailed(cmd.requestId, e instanceof Error ? e.message : String(e));
  }
}

/** The panel announces itself this often; the background helper stays off the app link while it hears it. */
export const PANEL_BEAT_EVENT = "murre.panel.alive";
export const PANEL_BEAT_MS = 3000;
export const PANEL_GONE_MS = 9000;

/** Whether the background helper should hold the link to the app. */
export function backgroundShouldConnect(now: number, lastBeat: number | null): boolean {
  return lastBeat === null || now - lastBeat > PANEL_GONE_MS;
}

/** Answers the app's "what is open in After Effects?" question. Never throws. */
export async function handleInspect(
  requestId: string,
  run: () => Promise<InspectResult>,
  reply: { sendInspected(requestId: string, kind: string, name: string, path: string): void },
): Promise<void> {
  try {
    const r = await run();
    reply.sendInspected(requestId, r.kind, r.name, r.path);
  } catch {
    reply.sendInspected(requestId, "unknown", "", "");
  }
}

export interface ImportResult {
  ok: boolean;
  message: string;
  comp: string;
  created: boolean;
}

/** Runs the app's "send this image to After Effects" request and reports how it went. Never throws. */
export async function handleImportImage(
  requestId: string,
  path: string,
  run: (path: string, asShapes: boolean) => Promise<ImportResult>,
  reply: {
    sendImportDone(requestId: string, comp: string, created: boolean): void;
    sendImportFailed(requestId: string, message: string): void;
  },
  asShapes = false,
): Promise<void> {
  try {
    const r = await run(path, asShapes);
    if (r && r.ok) reply.sendImportDone(requestId, r.comp, !!r.created);
    else reply.sendImportFailed(requestId, (r && r.message) || "After Effects could not import the image.");
  } catch (e) {
    reply.sendImportFailed(requestId, e instanceof Error ? e.message : String(e));
  }
}

export interface SaveAsResult {
  ok: boolean;
  path: string;
  message: string;
}

/** Runs the app's "save the open project here" request and reports how it went. Never throws. */
export async function handleSaveAs(
  requestId: string,
  path: string,
  run: (path: string) => Promise<SaveAsResult>,
  reply: StarterReply,
): Promise<void> {
  try {
    const r = await run(path);
    if (r && r.ok) reply.sendStarterDone(requestId, r.path || path, "");
    else reply.sendStarterFailed(requestId, (r && r.message) || "After Effects could not save the project.");
  } catch (e) {
    reply.sendStarterFailed(requestId, e instanceof Error ? e.message : String(e));
  }
}

/**
 * The name a project gets by default: the file name without its extension, any notes in brackets at the end
 * ("(converted)") and its version number ("v3", or a plain number after a separator, as in "Band 6").
 */
export const suggestName = (path: string | null): string => {
  const file = path ? path.split(/[\\/]/).pop() || "" : "";
  let stem = file.replace(/\.aep$/i, "").trim();
  stem = stem.replace(/(\s*[([][^)\]]*[)\]])+$/, "").trim() || stem;
  const cut = stem.replace(/[-_ ]*v\d+$/i, "").replace(/[-_ ]+\d{1,3}$/, "").trim();
  return cut || stem || "Untitled project";
};

export interface RevealTarget {
  compId: number;
  compName: string;
  layerIndex: number;
  layerName: string;
  propertyPath: string;
}

/** Runs the app's "show me this layer" request and reports how it went. Never throws. */
export async function handleReveal(
  requestId: string,
  target: RevealTarget,
  run: (t: RevealTarget) => Promise<{ ok: boolean; message: string }>,
  reply: {
    sendRevealDone(requestId: string, message: string): void;
    sendRevealFailed(requestId: string, message: string): void;
  },
): Promise<void> {
  try {
    const r = await run(target);
    if (r && r.ok) reply.sendRevealDone(requestId, r.message || "");
    else reply.sendRevealFailed(requestId, (r && r.message) || "After Effects could not show that layer.");
  } catch (e) {
    reply.sendRevealFailed(requestId, e instanceof Error ? e.message : String(e));
  }
}
