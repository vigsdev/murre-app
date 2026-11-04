import { describe, expect, it } from "vitest";
import {
  BridgeClient,
  bridgeFilePath,
  parseBridgeFile,
  parseCommand,
  type AppCommand,
  type BridgeDeps,
  type PanelStateMsg,
  type SocketLike,
} from "./bridge-client";

const TOKEN = "a".repeat(32);
const FILE = JSON.stringify({ v: 1, port: 5555, token: TOKEN });

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {}
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function setup(file: string | null = FILE) {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;
  const state = { file, connected: [] as boolean[], commands: [] as AppCommand[], details: [] as string[], panel: { aepPath: "/a.aep", projectId: "p1", scanning: false } as PanelStateMsg };
  const deps: BridgeDeps = {
    bridgePath: "/app/companion-bridge.json",
    readBridgeFile: () => state.file,
    openSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const client = new BridgeClient(deps, {
    onConnection: (c) => state.connected.push(c),
    onCommand: (c) => state.commands.push(c),
    currentState: () => state.panel,
    onDetail: (d) => state.details.push(d),
  });
  const fire = () => timers.shift()!.fn();
  return { client, sockets, timers, state, fire };
}

describe("bridge file", () => {
  it("finds the app data folder per platform", () => {
    const join = (...p: string[]) => p.join("/");
    expect(bridgeFilePath("darwin", {}, "/Users/me", join)).toBe("/Users/me/Library/Application Support/com.vigs.murre/companion-bridge.json");
    expect(bridgeFilePath("win32", { APPDATA: "C:/Users/me/AppData/Roaming" }, "C:/Users/me", join)).toBe("C:/Users/me/AppData/Roaming/com.vigs.murre/companion-bridge.json");
    expect(bridgeFilePath("win32", {}, "C:/Users/me", join)).toBeNull();
    expect(bridgeFilePath("linux", {}, "/home/me", join)).toBeNull();
  });

  it("accepts only a well-formed file", () => {
    expect(parseBridgeFile(FILE)).toEqual({ port: 5555, token: TOKEN });
    for (const bad of ["", "nope", "null", "[]", JSON.stringify({ v: 2, port: 1, token: TOKEN }), JSON.stringify({ v: 1, port: 0, token: TOKEN }), JSON.stringify({ v: 1, port: 70000, token: TOKEN }), JSON.stringify({ v: 1, port: 80.5, token: TOKEN }), JSON.stringify({ v: 1, port: 80, token: "short" }), JSON.stringify({ v: 1, port: 80, token: "x&y=z".repeat(8) })]) {
      expect(parseBridgeFile(bad)).toBeNull();
    }
  });
});

describe("parseCommand: reveal", () => {
  it("reads a reveal request and rejects a malformed one", () => {
    expect(parseCommand('{"v":1,"type":"reveal","requestId":"r","compId":3,"compName":"Main","layerIndex":2,"layerName":"Title","propertyPath":"A > B"}')).toEqual({
      kind: "reveal", requestId: "r", compId: 3, compName: "Main", layerIndex: 2, layerName: "Title", propertyPath: "A > B",
    });
    expect(parseCommand('{"v":1,"type":"reveal","requestId":"r","compId":"x","layerName":"T"}')).toBeNull();
    expect(parseCommand('{"v":1,"type":"reveal","compId":1,"layerName":"T"}')).toBeNull();
  });
});

describe("parseCommand", () => {
  it("understands scan and cancel and ignores everything else", () => {
    expect(parseCommand('{"v":1,"type":"scan","projectId":"p1"}')).toEqual({ kind: "scan", projectId: "p1" });
    expect(parseCommand('{"v":1,"type":"cancel"}')).toEqual({ kind: "cancel" });
    expect(parseCommand('{"v":1,"type":"relink","projectId":"p1"}')).toEqual({ kind: "relink", projectId: "p1" });
    expect(parseCommand('{"v":1,"type":"relink"}')).toBeNull();
    for (const bad of ["x", "null", '{"v":1,"type":"scan"}', '{"v":1,"type":"scan","projectId":""}', '{"v":2,"type":"cancel"}', '{"v":1,"type":"launch"}']) {
      expect(parseCommand(bad)).toBeNull();
    }
  });
});

describe("other versions", () => {
  it("reads the app's list of files and drops malformed entries", () => {
    const text = JSON.stringify({
      v: 1,
      type: "versions",
      requestId: "r1",
      files: [{ name: "Film_v2.aep", size: 10, modified: 5, suggested: true }, { name: "", size: 1 }, { size: 3 }, { name: "Other.aep", size: 7, modified: null }],
    });
    expect(parseCommand(text)).toEqual({
      kind: "versions",
      requestId: "r1",
      files: [
        { name: "Film_v2.aep", size: 10, modified: 5, suggested: true },
        { name: "Other.aep", size: 7, modified: null, suggested: false },
      ],
    });
    expect(parseCommand('{"v":1,"type":"versions","files":[]}')).toBeNull();
  });

  it("asks for the list and sends the chosen names with the add request", () => {
    const t = setup();
    t.client.start();
    t.sockets[0].open();
    t.client.sendListVersions("r1");
    t.client.sendAddProject("a1", "Film", "/p", ["Film_v1.aep", "Film_v2.aep"]);
    const [ask, add] = t.sockets[0].sent.slice(1).map((x) => JSON.parse(x));
    expect(ask).toEqual({ type: "listVersions", requestId: "r1" });
    expect(add).toEqual({ type: "addProject", requestId: "a1", name: "Film", parentDir: "/p", versions: ["Film_v1.aep", "Film_v2.aep"] });
  });
});

describe("BridgeClient", () => {
  it("connects with the token and greets the app with the current state", () => {
    const t = setup();
    t.client.start();
    expect(t.sockets[0].url).toBe(`ws://127.0.0.1:5555/?token=${TOKEN}`);
    expect(t.state.connected).toEqual([]);
    t.sockets[0].open();
    expect(t.state.connected).toEqual([true]);
    expect(JSON.parse(t.sockets[0].sent[0])).toEqual({ v: 1, type: "state", aepPath: "/a.aep", projectId: "p1", scanning: false });
  });

  it("sends state only when it changed", () => {
    const t = setup();
    t.client.start();
    t.sockets[0].open();
    t.client.sendState(t.state.panel);
    t.client.sendState({ ...t.state.panel });
    expect(t.sockets[0].sent).toHaveLength(1);
    t.client.sendState({ ...t.state.panel, scanning: true });
    expect(t.sockets[0].sent).toHaveLength(2);
  });

  it("passes commands on and ignores junk", () => {
    const t = setup();
    t.client.start();
    t.sockets[0].open();
    t.sockets[0].receive('{"v":1,"type":"scan","projectId":"p1"}');
    t.sockets[0].receive("garbage");
    t.sockets[0].receive(new ArrayBuffer(4));
    t.sockets[0].receive('{"v":1,"type":"cancel"}');
    expect(t.state.commands).toEqual([{ kind: "scan", projectId: "p1" }, { kind: "cancel" }]);
  });

  it("sends progress and results", () => {
    const t = setup();
    t.client.start();
    t.sockets[0].open();
    t.client.sendProgress(1, 4, "Main");
    t.client.sendDone(3, 2, 4);
    t.client.sendFailed("x".repeat(900));
    t.client.sendCancelled();
    t.client.sendProgress(0, 2, "a.png", "relink");
    t.client.sendRelinkDone(1, 1, 0, 3);
    t.client.sendRelinkFailed("y".repeat(900));
    const msgs = t.sockets[0].sent.slice(1).map((s) => JSON.parse(s));
    expect(msgs[0]).toEqual({ type: "progress", done: 1, total: 4, compName: "Main", activity: "scan" });
    expect(msgs[1]).toEqual({ type: "scanDone", colors: 3, expressions: 2, comps: 4 });
    expect(msgs[2].message).toHaveLength(500);
    expect(msgs[3]).toEqual({ type: "scanCancelled" });
    expect(msgs[4]).toEqual({ type: "progress", done: 0, total: 2, compName: "a.png", activity: "relink" });
    expect(msgs[5]).toEqual({ type: "relinkDone", trashed: 0, copied: 1, reused: 1, failed: 0, items: 3 });
    expect(msgs[6].message).toHaveLength(500);
  });

  it("sends nothing while not connected, without throwing", () => {
    const t = setup(null);
    t.client.start();
    expect(() => {
      t.client.sendProgress(1, 2, "A");
      t.client.sendState(t.state.panel);
    }).not.toThrow();
    expect(t.sockets).toHaveLength(0);
  });

  it("retries with growing waits while the app is not running, then connects when it appears", () => {
    const t = setup(null);
    t.client.start();
    expect(t.timers.map((x) => x.ms)).toEqual([1000]);
    t.fire();
    expect(t.timers.map((x) => x.ms)).toEqual([2000]);
    t.fire();
    t.fire();
    t.fire();
    t.fire();
    expect(t.timers[0].ms).toBe(10000); // capped
    t.state.file = FILE;
    t.fire();
    expect(t.sockets).toHaveLength(1);
  });

  it("says why it is not connected", () => {
    const missing = setup(null);
    missing.client.start();
    expect(missing.state.details[0]).toContain("/app/companion-bridge.json");
    const bad = setup("nope");
    bad.client.start();
    expect(bad.state.details[0]).toContain("could not be read");
    const t = setup();
    t.client.start();
    expect(t.state.details).toEqual(["Connecting to the app on port 5555…"]);
    t.sockets[0].drop(); // closed before it ever opened
    expect(t.state.details[1]).toContain("did not accept");
    t.fire();
    t.sockets[1].open();
    expect(t.state.details.at(-1)).toBe("Connected to the app.");
    t.sockets[1].drop();
    expect(t.state.details.at(-1)).toContain("closed the connection");
  });

  it("treats a bad bridge file like a missing one", () => {
    const t = setup("not json");
    t.client.start();
    expect(t.sockets).toHaveLength(0);
    expect(t.timers).toHaveLength(1);
  });

  it("reconnects after the app goes away and greets again with the latest state", () => {
    const t = setup();
    t.client.start();
    t.sockets[0].open();
    t.sockets[0].drop();
    expect(t.state.connected).toEqual([true, false]);
    expect(t.timers).toHaveLength(1);
    t.state.panel = { aepPath: "/b.aep", projectId: null, scanning: false };
    t.fire();
    t.sockets[1].open();
    expect(JSON.parse(t.sockets[1].sent[0]).aepPath).toBe("/b.aep");
    expect(t.state.connected).toEqual([true, false, true]);
  });

  it("a refused connection (wrong token, app restarted) just retries", () => {
    const t = setup();
    t.client.start();
    t.sockets[0].onerror?.();
    t.sockets[0].drop(); // late close after the error must not double-schedule
    expect(t.state.connected).toEqual([]);
    expect(t.timers).toHaveLength(1);
  });

  it("stop closes the socket, cancels retries and reports disconnected", () => {
    const t = setup();
    t.client.start();
    t.sockets[0].open();
    t.client.stop();
    expect(t.sockets[0].closed).toBe(true);
    expect(t.state.connected).toEqual([true, false]);
    t.sockets[0].receive('{"v":1,"type":"cancel"}');
    expect(t.state.commands).toEqual([]);
    expect(t.timers).toHaveLength(0);
  });

  it("start is idempotent", () => {
    const t = setup();
    t.client.start();
    t.client.start();
    expect(t.sockets).toHaveLength(1);
  });
});
