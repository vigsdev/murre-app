import { APP_LOCATION_FILE, BridgeClient, bridgeFilePath, parseAppLocation } from "../lib/murre/bridge-client";
import { cepIo } from "../lib/murre/io";
import { child_process, os } from "../lib/cep/node";
import { csi } from "../lib/utils/bolt";
import { SystemPath } from "../lib/cep/csinterface";
import { hostLabelOf } from "../lib/murre/host-label";

/** The live link to the desktop app, wired to the real file system and WebSocket. */
export function createBridge(given: ConstructorParameters<typeof BridgeClient>[1]): { client: BridgeClient | null; why: string } {
  // Every step of the link goes to this extension's console too (panel or helper), so a link that won't connect can be
  // looked into with the CEP debugger.
  const who = (() => {
    try {
      return String(csi.getExtensionID()).split(".").pop();
    } catch {
      return "companion";
    }
  })();
  const log = (text: string) => console.info(`[Murre link · ${who}] ${text}`);
  const events: typeof given = {
    ...given,
    onDetail: (text) => {
      log(text);
      given.onDetail?.(text);
    },
  };
  const fail = (why: string) => {
    log(why);
    return { client: null, why };
  };
  if (typeof window.cep === "undefined") return fail("Not running inside After Effects.");
  if (typeof WebSocket === "undefined") return fail("This panel's browser has no WebSocket support.");
  let file: string | null = null;
  try {
    file = bridgeFilePath(os.platform(), nodeEnv(), os.homedir(), cepIo().path.join);
  } catch (e) {
    return fail(`Could not find the app's data folder: ${messageOf(e)}`);
  }
  if (!file) return fail("The app link is only supported on macOS and Windows.");
  log(`Looking for the app in ${file}`);
  const io = cepIo();
  const path = file;
  const client = new BridgeClient(
    {
      bridgePath: path,
      readBridgeFile: () => {
        try {
          return io.fs.readFileSync(path, { encoding: "utf-8" });
        } catch {
          return null;
        }
      },
      openSocket: (url) => new WebSocket(url) as unknown as ReturnType<ConstructorParameters<typeof BridgeClient>[0]["openSocket"]>,
      hostInfo: () => {
        const appPath = csi.getSystemPath(SystemPath.HOST_APPLICATION) as string;
        const env = csi.getHostEnvironment();
        return { host: appPath || "", hostLabel: hostLabelOf(appPath, env?.appVersion) };
      },
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
    },
    events,
  );
  return { client, why: "" };
}

/** Node's environment variables. `process` is a global in CEP's mixed context; `cep_node` is where CEP also puts it. */
function nodeEnv(): Record<string, string | undefined> {
  if (typeof process !== "undefined" && process.env) return process.env;
  const p = (window as unknown as { cep_node?: { process?: { env?: Record<string, string | undefined> } } }).cep_node?.process;
  return p?.env ?? {};
}

export const messageOf = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
};

/**
 * Windows: start Murre from where the app last said it is installed (`app-location.json`, next to the link file). A
 * Murre that is already running just comes forward. Returns a sentence when it can't be started.
 */
export function startMurreOnWindows(): string | null {
  const io = cepIo();
  const linkFile = bridgeFilePath("win32", nodeEnv(), os.homedir(), io.path.join);
  if (!linkFile) return "Open the Murre app first.";
  let exe: string | null = null;
  try {
    exe = parseAppLocation(io.fs.readFileSync(io.path.join(io.path.dirname(linkFile), APP_LOCATION_FILE), { encoding: "utf-8" }));
  } catch {
    exe = null;
  }
  if (!exe || !io.fs.existsSync(exe)) return "Open the Murre app first.";
  try {
    const child = child_process.spawn(exe, [], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return null;
  } catch (e) {
    return `Couldn't open Murre: ${messageOf(e)}`;
  }
}
