import { BridgeClient, bridgeFilePath } from "../lib/murre/bridge-client";
import { cepIo } from "../lib/murre/io";
import { os } from "../lib/cep/node";
import { csi } from "../lib/utils/bolt";
import { SystemPath } from "../lib/cep/csinterface";
import { hostLabelOf } from "../lib/murre/host-label";

/** The live link to the desktop app, wired to the real file system and WebSocket. */
export function createBridge(events: ConstructorParameters<typeof BridgeClient>[1]): { client: BridgeClient | null; why: string } {
  if (typeof window.cep === "undefined") return { client: null, why: "Not running inside After Effects." };
  if (typeof WebSocket === "undefined") return { client: null, why: "This panel's browser has no WebSocket support." };
  let file: string | null = null;
  try {
    file = bridgeFilePath(os.platform(), process.env, os.homedir(), cepIo().path.join);
  } catch (e) {
    return { client: null, why: `Could not find the app's data folder: ${messageOf(e)}` };
  }
  if (!file) return { client: null, why: "The app link is only supported on macOS and Windows." };
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

export const messageOf = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
};
