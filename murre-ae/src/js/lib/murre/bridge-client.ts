/**
 * Live link to the Murre desktop app.
 *
 * The app listens on a localhost WebSocket and writes its port and a token to
 * `companion-bridge.json` in its data folder. This client reads that file, connects, and keeps
 * reconnecting while the app is not running. The socket carries only commands from the app
 * ("scan", "relink", "cancel") and state/progress from here. Scan results are still written to the
 * project's `.murre` files by the scanner, so nothing depends on the socket being up.
 */

export const PROTOCOL = 1;
export const BRIDGE_FILE = "companion-bridge.json";
export const APP_IDENTIFIER = "com.vigs.murre";

/** Where the app keeps `companion-bridge.json` (Tauri's app data directory). */
export function bridgeFilePath(
  platform: string,
  env: Record<string, string | undefined>,
  home: string,
  join: (...parts: string[]) => string,
): string | null {
  if (platform === "darwin") return join(home, "Library", "Application Support", APP_IDENTIFIER, BRIDGE_FILE);
  if (platform === "win32") return env.APPDATA ? join(env.APPDATA, APP_IDENTIFIER, BRIDGE_FILE) : null;
  return null;
}

export interface BridgeInfo {
  port: number;
  token: string;
}

/** Parse the app's bridge file; anything unexpected means "not available". */
export function parseBridgeFile(text: string): BridgeInfo | null {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || v.v !== PROTOCOL) return null;
    if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) return null;
    if (typeof v.token !== "string" || !/^[0-9a-f]{16,128}$/i.test(v.token)) return null;
    return { port: v.port, token: v.token };
  } catch {
    return null;
  }
}

/** The state the app wants to know about. */
export interface PanelStateMsg {
  aepPath: string | null;
  projectId: string | null;
  /** True while a scan or a copy-and-relink is running. */
  scanning: boolean;
  /** Which one, while `scanning`. */
  activity?: "scan" | "relink" | null;
  /** Who is talking: the panel (can scan) or the hidden background helper (cannot). */
  source?: "panel" | "background";
}

export interface StarterCommand {
  kind: "createStarter";
  requestId: string;
  path: string;
  compName: string;
  width: number;
  height: number;
  fps: number;
  seconds: number;
  /** Where a project that was never saved is saved before it is closed (the Desktop). */
  rescueDir: string;
}

export interface ImportImageCommand {
  kind: "importImage";
  requestId: string;
  /** Absolute path of the image. */
  path: string;
  /** An SVG: turn the layer into shape layers (Layer > Create > Create Shapes from Vector Layer). */
  asShapes?: boolean;
}

export interface SaveAsCommand {
  kind: "saveAs";
  requestId: string;
  path: string;
}

/** How the app's "add this project to Murre" work is going, for the panel to show. */
export interface AddProjectStatus {
  kind: "addProjectStatus";
  requestId: string;
  text: string;
  done: boolean;
  ok: boolean;
}

/** Another `.aep` saved next to the open project, which the app found for the panel to offer. */
export interface VersionFile {
  name: string;
  size: number;
  modified: number | null;
  /** Same base name as the open project, so probably another version of it. */
  suggested: boolean;
}

/** The app's answer to "which other versions are next to the open project?". */
export interface VersionsAnswer {
  kind: "versions";
  requestId: string;
  files: VersionFile[];
}

export interface RevealCommand {
  kind: "reveal";
  requestId: string;
  compId: number;
  compName: string;
  /** 0 when unknown (then the layer is found by name). */
  layerIndex: number;
  layerName: string;
  /** Path below the layer, names joined with " > "; empty to select only the layer. */
  propertyPath: string;
}

export type AppCommand =
  | { kind: "scan"; projectId: string }
  | { kind: "relink"; projectId: string }
  | { kind: "cancel" }
  | { kind: "inspect"; requestId: string }
  | StarterCommand
  | ImportImageCommand
  | RevealCommand
  | SaveAsCommand
  | AddProjectStatus
  | VersionsAnswer;

const positive = (n: unknown, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= max;

/** Reads the app's message; unknown or malformed messages give `null` and are ignored. */
export function parseCommand(text: string): AppCommand | null {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || v.v !== PROTOCOL) return null;
    if (v.type === "scan" && typeof v.projectId === "string" && v.projectId) return { kind: "scan", projectId: v.projectId };
    if (v.type === "relink" && typeof v.projectId === "string" && v.projectId) return { kind: "relink", projectId: v.projectId };
    if (v.type === "cancel") return { kind: "cancel" };
    if (v.type === "inspect" && typeof v.requestId === "string" && v.requestId) return { kind: "inspect", requestId: v.requestId };
    if (v.type === "importImage" && typeof v.requestId === "string" && v.requestId && typeof v.path === "string" && v.path) {
      return v.asShapes === true ? { kind: "importImage", requestId: v.requestId, path: v.path, asShapes: true } : { kind: "importImage", requestId: v.requestId, path: v.path };
    }
    if (v.type === "reveal" && typeof v.requestId === "string" && v.requestId && Number.isInteger(v.compId) && typeof v.layerName === "string") {
      return {
        kind: "reveal",
        requestId: v.requestId,
        compId: v.compId,
        compName: typeof v.compName === "string" ? v.compName.slice(0, 300) : "",
        layerIndex: Number.isInteger(v.layerIndex) && v.layerIndex >= 0 && v.layerIndex < 100000 ? v.layerIndex : 0,
        layerName: v.layerName.slice(0, 300),
        propertyPath: typeof v.propertyPath === "string" ? v.propertyPath.slice(0, 2000) : "",
      };
    }
    if (v.type === "saveAs" && typeof v.requestId === "string" && v.requestId && typeof v.path === "string" && /\.aep$/i.test(v.path)) {
      return { kind: "saveAs", requestId: v.requestId, path: v.path };
    }
    if (v.type === "addProjectStatus" && typeof v.requestId === "string" && typeof v.text === "string") {
      return { kind: "addProjectStatus", requestId: v.requestId, text: v.text.slice(0, 300), done: v.done === true, ok: v.ok !== false };
    }
    if (v.type === "versions" && typeof v.requestId === "string" && v.requestId && Array.isArray(v.files)) {
      const files: VersionFile[] = [];
      for (const f of v.files.slice(0, 30)) {
        if (!f || typeof f.name !== "string" || !f.name || f.name.length > 255 || typeof f.size !== "number") continue;
        files.push({ name: f.name, size: f.size, modified: typeof f.modified === "number" ? f.modified : null, suggested: f.suggested === true });
      }
      return { kind: "versions", requestId: v.requestId, files };
    }
    if (v.type === "createStarter") {
      if (typeof v.requestId !== "string" || !v.requestId || typeof v.path !== "string" || !/\.aep$/i.test(v.path)) return null;
      if (!positive(v.width, 30000) || !positive(v.height, 30000) || !positive(v.fps, 120) || !positive(v.seconds, 10800)) return null;
      const compName = typeof v.compName === "string" && v.compName.trim() ? v.compName.slice(0, 100) : "Main Comp";
      return { kind: "createStarter", requestId: v.requestId, path: v.path, compName, width: v.width, height: v.height, fps: v.fps, seconds: v.seconds, rescueDir: typeof v.rescueDir === "string" ? v.rescueDir : "" };
    }
    return null;
  } catch {
    return null;
  }
}

/** The slice of the browser WebSocket that this client uses. */
export interface SocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface BridgeDeps {
  /** Where the bridge file is expected, for messages. */
  bridgePath: string;
  /** Contents of the bridge file, or null if it does not exist. */
  readBridgeFile: () => string | null;
  openSocket: (url: string) => SocketLike;
  /** Which After Effects this is (its application path and a name), so the app can tell two apart. */
  hostInfo?: () => { host: string; hostLabel: string } | null;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface BridgeEvents {
  onConnection: (connected: boolean) => void;
  onCommand: (cmd: AppCommand) => void;
  /** Called on every (re)connection: the state to greet the app with. */
  currentState: () => PanelStateMsg;
  /** A short sentence saying what the link is doing or why it is not up. */
  onDetail?: (text: string) => void;
}

const OPEN = 1;
const RETRY_MS = [1000, 2000, 5000, 10000];

export class BridgeClient {
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private running = false;
  private connected = false;
  private lastState = "";
  private detail = "";

  constructor(
    private deps: BridgeDeps,
    private events: BridgeEvents,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
    this.setConnected(false);
  }

  /** Tell the app the state, but only when it changed. */
  sendState(state: PanelStateMsg) {
    const text = JSON.stringify({ v: PROTOCOL, type: "state", ...state, ...this.hostFields() });
    if (text === this.lastState) return;
    if (this.write(text)) this.lastState = text;
  }

  private hostFields(): { host?: string; hostLabel?: string } {
    try {
      return this.deps.hostInfo?.() ?? {};
    } catch {
      return {};
    }
  }

  sendProgress(done: number, total: number, compName: string, activity: "scan" | "relink" = "scan") {
    this.write(JSON.stringify({ type: "progress", done, total, compName, activity }));
  }

  sendRelinkDone(copied: number, reused: number, failed: number, items: number, trashed = 0) {
    this.write(JSON.stringify({ type: "relinkDone", copied, reused, failed, items, trashed }));
  }

  sendRelinkFailed(message: string) {
    this.write(JSON.stringify({ type: "relinkFailed", message: message.slice(0, 500) }));
  }

  sendDone(colors: number, expressions: number, comps: number) {
    this.write(JSON.stringify({ type: "scanDone", colors, expressions, comps }));
  }

  sendFailed(message: string) {
    this.write(JSON.stringify({ type: "scanFailed", message: message.slice(0, 500) }));
  }

  sendInspected(requestId: string, kind: string, name: string, path: string) {
    this.write(JSON.stringify({ type: "inspectResult", requestId, kind, name, path }));
  }

  sendStarterDone(requestId: string, path: string, previous = "") {
    this.write(JSON.stringify({ type: "starterDone", requestId, path, previous }));
  }

  sendStarterFailed(requestId: string, message: string) {
    this.write(JSON.stringify({ type: "starterFailed", requestId, message: message.slice(0, 500) }));
  }

  /** Ask the app to build a Murre project around the project that is open in After Effects. */
  sendAddProject(requestId: string, name: string, parentDir: string, versions: string[] = []) {
    this.write(JSON.stringify({ type: "addProject", requestId, name: name.slice(0, 100), parentDir, versions: versions.slice(0, 30) }));
  }

  /** Ask the app which other `.aep` files are saved next to the open project. */
  sendListVersions(requestId: string) {
    this.write(JSON.stringify({ type: "listVersions", requestId }));
  }

  sendImportDone(requestId: string, comp: string, created: boolean) {
    this.write(JSON.stringify({ type: "importDone", requestId, comp, created }));
  }

  sendRevealDone(requestId: string, message: string) {
    this.write(JSON.stringify({ type: "revealDone", requestId, message: message.slice(0, 500) }));
  }

  sendRevealFailed(requestId: string, message: string) {
    this.write(JSON.stringify({ type: "revealFailed", requestId, message: message.slice(0, 500) }));
  }

  sendImportFailed(requestId: string, message: string) {
    this.write(JSON.stringify({ type: "importFailed", requestId, message: message.slice(0, 500) }));
  }

  sendCancelled() {
    this.write(JSON.stringify({ type: "scanCancelled" }));
  }

  private write(text: string): boolean {
    const s = this.socket;
    if (!s || s.readyState !== OPEN || !this.connected) return false;
    try {
      s.send(text);
      return true;
    } catch {
      return false;
    }
  }

  private say(text: string) {
    if (text === this.detail) return;
    this.detail = text;
    this.events.onDetail?.(text);
  }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    if (!value) this.lastState = "";
    this.events.onConnection(value);
  }

  private retryLater() {
    if (!this.running || this.timer !== null) return;
    const wait = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt += 1;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.connect();
    }, wait);
  }

  private connect() {
    if (!this.running) return;
    let info: BridgeInfo | null = null;
    let text: string | null = null;
    try {
      text = this.deps.readBridgeFile();
      info = text === null ? null : parseBridgeFile(text);
    } catch {
      info = null;
    }
    if (!info) {
      this.say(
        text === null
          ? `The Murre app is not running (no ${this.deps.bridgePath}).`
          : "The app's link file could not be read, or it is from a different version.",
      );
      this.retryLater(); // the app is not running (or too old/new): look again later
      return;
    }
    let socket: SocketLike;
    try {
      socket = this.deps.openSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}`);
    } catch (e) {
      this.say(`Could not open a connection: ${e instanceof Error ? e.message : String(e)}`);
      this.retryLater();
      return;
    }
    this.say(`Connecting to the app on port ${info.port}…`);
    const port = info.port;
    let opened = false;
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      opened = true;
      this.say("Connected to the app.");
      this.attempt = 0;
      this.connected = true;
      this.lastState = "";
      this.events.onConnection(true);
      this.sendState(this.events.currentState());
    };
    socket.onmessage = (e) => {
      if (this.socket !== socket || typeof e.data !== "string") return;
      const cmd = parseCommand(e.data);
      if (cmd) this.events.onCommand(cmd);
    };
    const lost = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      this.say(
        opened
          ? "The app closed the connection. Trying again…"
          : `The app on port ${port} did not accept the connection (restart the app and the panel if this stays).`,
      );
      this.setConnected(false);
      this.retryLater();
    };
    socket.onclose = lost;
    socket.onerror = lost;
  }
}
