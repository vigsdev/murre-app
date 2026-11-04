import { describe, expect, it, vi } from "vitest";
import { backgroundShouldConnect, handleCreateStarter, handleImportImage, handleReveal, handleSaveAs, suggestName, handleInspect, PANEL_GONE_MS } from "./starter-flow";
import { parseCommand, type StarterCommand } from "./bridge-client";

const cmd: StarterCommand = { kind: "createStarter", requestId: "r1", path: "/p/a.aep", compName: "Main Comp", width: 1920, height: 1080, fps: 30, seconds: 30, rescueDir: "/Users/x/Desktop" };

const reply = () => {
  const log: string[] = [];
  return { log, r: { sendStarterDone: (id: string, p: string, prev?: string) => log.push(`done ${id} ${p}${prev ? " prev " + prev : ""}`), sendStarterFailed: (id: string, m: string) => log.push(`fail ${id} ${m}`) } };
};

describe("handleCreateStarter", () => {
  it("reports success with the saved path", async () => {
    const { log, r } = reply();
    await handleCreateStarter(cmd, async () => ({ ok: true, path: "/saved.aep", message: "" }), r);
    expect(log).toEqual(["done r1 /saved.aep"]);
    const b = reply();
    await handleCreateStarter(cmd, async () => ({ ok: true, path: "/s.aep", message: "", previous: "/old.aep" }), b.r);
    expect(b.log).toEqual(["done r1 /s.aep prev /old.aep"]);
  });
  it("reports a failure and a thrown error, never throwing itself", async () => {
    const a = reply();
    await handleCreateStarter(cmd, async () => ({ ok: false, path: "", message: "no" }), a.r);
    expect(a.log).toEqual(["fail r1 no"]);
    const b = reply();
    await handleCreateStarter(cmd, async () => { throw new Error("boom"); }, b.r);
    expect(b.log).toEqual(["fail r1 boom"]);
  });
});

describe("backgroundShouldConnect", () => {
  it("connects when no panel was ever heard or it went quiet", () => {
    expect(backgroundShouldConnect(1000, null)).toBe(true);
    expect(backgroundShouldConnect(1000 + PANEL_GONE_MS + 1, 1000)).toBe(true);
    expect(backgroundShouldConnect(1000 + 3000, 1000)).toBe(false);
  });
});

describe("parseCommand createStarter", () => {
  const msg = (o: object) => JSON.stringify({ v: 1, type: "createStarter", requestId: "r", path: "/a/b.aep", compName: "Main Comp", width: 1920, height: 1080, fps: 30, seconds: 30, ...o });
  it("accepts a valid request", () => {
    expect(parseCommand(msg({ rescueDir: "/Users/x/Desktop" }))).toMatchObject({ kind: "createStarter", width: 1920, fps: 30, seconds: 30, rescueDir: "/Users/x/Desktop" });
  });
  it("parses an inspect request", () => {
    expect(parseCommand(JSON.stringify({ v: 1, type: "inspect", requestId: "q" }))).toEqual({ kind: "inspect", requestId: "q" });
    expect(parseCommand(JSON.stringify({ v: 1, type: "inspect" }))).toBeNull();
  });
  it("rejects bad paths and sizes", () => {
    expect(parseCommand(msg({ path: "/a/b.txt" }))).toBeNull();
    expect(parseCommand(msg({ width: 0 }))).toBeNull();
    expect(parseCommand(msg({ fps: 1000 }))).toBeNull();
    expect(parseCommand(msg({ requestId: "" }))).toBeNull();
  });
});

describe("handleInspect", () => {
  it("answers with the project kind, or unknown when After Effects cannot be read", async () => {
    const seen: string[] = [];
    const r = { sendInspected: (id: string, k: string, n: string, p: string) => seen.push([id, k, n, p].join("|")) };
    await handleInspect("i1", async () => ({ kind: "saved", name: "a.aep", path: "/a.aep" }), r);
    await handleInspect("i2", async () => { throw new Error("x"); }, r);
    expect(seen).toEqual(["i1|saved|a.aep|/a.aep", "i2|unknown||"]);
  });
});

describe("handleImportImage", () => {
  const mk = () => ({ sendImportDone: vi.fn(), sendImportFailed: vi.fn() });
  it("reports success", async () => {
    const r = mk();
    await handleImportImage("a", "/x.png", async () => ({ ok: true, message: "", comp: "C", created: true }), r);
    expect(r.sendImportDone).toHaveBeenCalledWith("a", "C", true);
  });
  it("reports a failure and a throw", async () => {
    const r = mk();
    await handleImportImage("a", "/x.png", async () => ({ ok: false, message: "no", comp: "", created: false }), r);
    await handleImportImage("b", "/x.png", async () => { throw new Error("boom"); }, r);
    expect(r.sendImportFailed).toHaveBeenCalledWith("a", "no");
    expect(r.sendImportFailed).toHaveBeenCalledWith("b", "boom");
  });
});

describe("importImage as shapes", () => {
  it("passes the choice on to the run function and defaults to a plain layer", async () => {
    const seen: boolean[] = [];
    const r = { sendImportDone() {}, sendImportFailed() {} };
    const run = async (_p: string, shapes: boolean) => (seen.push(shapes), { ok: true, message: "", comp: "C", created: false });
    await handleImportImage("a", "/x.svg", run, r);
    await handleImportImage("b", "/x.svg", run, r, true);
    expect(seen).toEqual([false, true]);
  });
  it("reads asShapes from the command only when it is true", () => {
    expect(parseCommand('{"v":1,"type":"importImage","requestId":"r","path":"/a.svg","asShapes":true}')).toEqual({ kind: "importImage", requestId: "r", path: "/a.svg", asShapes: true });
    expect(parseCommand('{"v":1,"type":"importImage","requestId":"r","path":"/a.svg","asShapes":"yes"}')).toEqual({ kind: "importImage", requestId: "r", path: "/a.svg" });
  });
});

describe("importImage command", () => {
  it("parses and rejects", () => {
    expect(parseCommand('{"v":1,"type":"importImage","requestId":"r","path":"/a.png"}')).toEqual({ kind: "importImage", requestId: "r", path: "/a.png" });
    expect(parseCommand('{"v":1,"type":"importImage","requestId":"r"}')).toBeNull();
  });
});

describe("add project to Murre", () => {
  it("parses saveAs and status messages", () => {
    expect(parseCommand('{"v":1,"type":"saveAs","requestId":"r","path":"/p/a.aep"}')).toEqual({ kind: "saveAs", requestId: "r", path: "/p/a.aep" });
    expect(parseCommand('{"v":1,"type":"saveAs","requestId":"r","path":"/p/a.txt"}')).toBeNull();
    expect(parseCommand('{"v":1,"type":"addProjectStatus","requestId":"r","text":"Scanning","done":false}')).toEqual({ kind: "addProjectStatus", requestId: "r", text: "Scanning", done: false, ok: true });
  });
  it("answers a save like a starter", async () => {
    const r = { sendStarterDone: vi.fn(), sendStarterFailed: vi.fn() };
    await handleSaveAs("a", "/p/a.aep", async () => ({ ok: true, path: "/p/a.aep", message: "" }), r);
    await handleSaveAs("b", "/p/b.aep", async () => ({ ok: false, path: "", message: "no" }), r);
    expect(r.sendStarterDone).toHaveBeenCalledWith("a", "/p/a.aep", "");
    expect(r.sendStarterFailed).toHaveBeenCalledWith("b", "no");
  });
  it("suggests a name from the file", () => {
    expect(suggestName("/x/Film_v07.aep")).toBe("Film");
    expect(suggestName("C:\\x\\Logo reveal v3.aep")).toBe("Logo reveal");
    expect(suggestName("/x/Intro.aep")).toBe("Intro");
    expect(suggestName("/x/Finalised-TV-Band 6 (converted).aep")).toBe("Finalised-TV-Band");
    expect(suggestName("/x/Film_v2 [final].aep")).toBe("Film");
    expect(suggestName("/x/Promo 2026.aep")).toBe("Promo 2026");
    expect(suggestName("/x/(copy).aep")).toBe("(copy)");
    expect(suggestName(null)).toBe("Untitled project");
  });
});

describe("handleReveal", () => {
  const t = { compId: 3, compName: "Main", layerIndex: 2, layerName: "Title", propertyPath: "Transform > Position" };
  it("reports success (with a note) and failure", async () => {
    const r = { sendRevealDone: vi.fn(), sendRevealFailed: vi.fn() };
    await handleReveal("a", t, async () => ({ ok: true, message: "moved" }), r);
    await handleReveal("b", t, async () => ({ ok: false, message: "gone" }), r);
    await handleReveal("c", t, async () => { throw new Error("boom"); }, r);
    expect(r.sendRevealDone).toHaveBeenCalledWith("a", "moved");
    expect(r.sendRevealFailed).toHaveBeenCalledWith("b", "gone");
    expect(r.sendRevealFailed).toHaveBeenCalledWith("c", "boom");
  });
});
