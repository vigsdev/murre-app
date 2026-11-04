import fs from "fs";
import { describe, expect, it } from "vitest";
import type { AepInfo, CompScan, ScannedComp } from "../../../shared/scan-types";
import { withMain, parseCompsFile } from "./comps-model";
import { runScan, ScanCancelled, ScanError, type ScanHost } from "./scanner";
import { readSnapshot, writeSnapshot } from "./snapshot-store";
import { listDir, makeProject, readJson, realIo } from "./test-helpers";

const comp = (id: number, name: string, usedIn = 1): ScannedComp => ({ id, name, width: 1920, height: 1080, pixelAspect: 1, frameRate: 25, duration: 10, folder: "Comps", usedIn });

function host(aep: string | null, comps: ScannedComp[] = [comp(1, "Main"), comp(2, "Pre")], over: Partial<ScanHost> = {}): ScanHost & { calls: string[] } {
  const calls: string[] = [];
  const info = (): AepInfo => ({ saved: aep !== null, name: aep ? aep.split(/[\\/]/).pop()! : null, path: aep, appVersion: "25.0", numItems: comps.length });
  return {
    calls,
    getAepInfo: async () => info(),
    listComps: async () => comps,
    listFootage: async () => [],
    relinkFootage: async () => ({ ok: true, message: "" }),
    scanComp: async (id): Promise<CompScan> => {
      calls.push("scan:" + id);
      const c = comps.find((x) => x.id === id)!;
      return {
        compId: id, compName: c.name, skipped: 0,
        colors: [{ color: [1, 0.5, 0, 1], layer: "Title", property: "Fill" }],
        expressions: id === 1 ? [{ expression: "wiggle(2, 30)", layer: "Title", property: "Position", enabled: true, error: null }] : [],
      };
    },
    ...over,
  };
}

describe("runScan: organizing and Main Comps", () => {
  it("organizes the project before listing compositions, and reports how many items moved", async () => {
    const p = makeProject();
    const order: string[] = [];
    const h = host(p.aep, [comp(1, "Final", 0), comp(2, "Pre", 1)], {
      organizeProject: async () => { order.push("organize"); return { moved: 5, failed: 0 }; },
      listComps: async () => { order.push("list"); return [comp(1, "Final", 0), comp(2, "Pre", 1)]; },
    });
    const r = await runScan(h, realIo);
    expect(order).toEqual(["organize", "list"]);
    expect(r.organized).toBe(5);
    expect(readJson(p.meta("comps.json")).comps.map((c: any) => [c.name, c.main])).toEqual([["Final", true], ["Pre", false]]);
  });

  it("still scans, with a warning, when organizing fails or some items cannot move", async () => {
    const p = makeProject();
    const r = await runScan(host(p.aep, undefined, { organizeProject: async () => { throw new Error("locked project"); } }), realIo);
    expect(r.organized).toBe(0);
    expect(r.warnings.join(" ")).toContain("locked project");
    expect(r.counts.comps).toBe(2);
    const r2 = await runScan(host(p.aep, undefined, { organizeProject: async () => ({ moved: 1, failed: 2 }) }), realIo);
    expect(r2.warnings.join(" ")).toContain("2 items could not be moved");
  });

  it("scans without organizing when the host cannot", async () => {
    const p = makeProject();
    const r = await runScan(host(p.aep), realIo);
    expect(r.organized).toBe(0);
  });
});

describe("runScan", () => {
  it("writes colors, expressions and comps into the linked project", async () => {
    const p = makeProject({ id: "pid-9" });
    const progress: string[] = [];
    const r = await runScan(host(p.aep), realIo, { onProgress: (x) => progress.push(`${x.done}/${x.total}`), now: () => new Date("2026-10-26T12:00:00Z") });
    expect(r.counts).toMatchObject({ comps: 2, colors: 2, expressions: 1 });
    expect(r.scannedAt).toBe("2026-10-26T12:00:00.000Z");
    expect(progress).toEqual(["0/2", "1/2", "2/2"]);

    expect(readJson(p.meta("colors.json")).colors).toHaveLength(2);
    expect(readJson(p.meta("expressions.json")).expressions[0].expression).toBe("wiggle(2, 30)");
    const comps = readJson(p.meta("comps.json"));
    expect(comps).toMatchObject({ schemaVersion: 1, lastScanAt: "2026-10-26T12:00:00.000Z", aep: { projectId: "pid-9", path: "01 AE/film_v01.aep", name: "film_v01.aep" } });
    expect(comps.comps.map((c: any) => [c.id, c.name, c.main])).toEqual([[1, "Main", false], [2, "Pre", false]]);
    expect(listDir(p.root + "/.murre").filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("writes fonts.json when the host can scan fonts, and warns (still scanning) when it fails", async () => {
    const p = makeProject();
    const fonts = { method: "project" as const, skipped: 0, fonts: [{ postScriptName: "Inter-Bold", family: "Inter", style: "Bold", location: "", adobeFonts: false, missing: false, layerCount: 1, layers: [{ comp: "Main", layer: "Title" }] }] };
    const r = await runScan(host(p.aep, undefined, { scanFonts: async () => fonts }), realIo);
    expect(r.fonts).toBe(1);
    expect(readJson(p.meta("fonts.json")).fonts[0]).toMatchObject({ postScriptName: "Inter-Bold", uses: [{ comp: "Main", layer: "Title" }] });
    const q = makeProject();
    const r2 = await runScan(host(q.aep, undefined, { scanFonts: async () => { throw new Error("boom"); } }), realIo);
    expect(r2.fonts).toBeNull();
    expect(r2.warnings.join(" ")).toMatch(/Fonts were not read/);
    expect(readJson(q.meta("comps.json")).comps).toHaveLength(2);
  });

  it("writes environment.json with the plugins found and the After Effects version", async () => {
    const p = makeProject();
    const h = host(p.aep);
    const base = h.scanComp;
    h.scanComp = async (id) => ({ ...(await base(id)), effects: [{ matchName: "ADBE Gaussian Blur 2", name: "Gaussian Blur", layer: "Title" }, { matchName: "VIDEOCOPILOT Deep Glow", name: "Deep Glow", layer: "Title" }] });
    await runScan(h, realIo);
    const env = readJson(p.meta("environment.json"));
    expect(env.aeVersion).toBe("25.0");
    expect(env.plugins).toEqual([{ matchName: "VIDEOCOPILOT Deep Glow", name: "Deep Glow", layerCount: 2, uses: [{ comp: "Main", layer: "Title" }, { comp: "Pre", layer: "Title" }] }]);
  });

  it("keeps Main Comp choices when scanning again", async () => {
    const p = makeProject();
    await runScan(host(p.aep), realIo);
    const file = parseCompsFile(readSnapshot(realIo, p.root, "comps.json"))!;
    writeSnapshot(realIo, p.root, "comps.json", withMain(file, 2, true));
    const r = await runScan(host(p.aep, [comp(1, "Main"), comp(2, "Pre"), comp(3, "New")]), realIo);
    expect(readJson(p.meta("comps.json")).comps.map((c: any) => c.main)).toEqual([false, true, false]);
    expect(r.unmatchedMain).toEqual([]);
  });

  it("refuses an unsaved project and one outside any Murre folder, writing nothing", async () => {
    const p = makeProject();
    await expect(runScan(host(null), realIo)).rejects.toThrow(/Save the After Effects project/);
    fs.rmSync(p.meta("project.json"));
    await expect(runScan(host(p.aep), realIo)).rejects.toBeInstanceOf(ScanError);
    expect(fs.existsSync(p.meta("colors.json"))).toBe(false);
  });

  it("a cancelled scan writes nothing and leaves existing files as they were", async () => {
    const p = makeProject();
    await runScan(host(p.aep), realIo);
    const before = fs.readFileSync(p.meta("colors.json"), "utf-8");
    let n = 0;
    await expect(runScan(host(p.aep), realIo, { isCancelled: () => ++n > 2 })).rejects.toBeInstanceOf(ScanCancelled);
    expect(fs.readFileSync(p.meta("colors.json"), "utf-8")).toBe(before);
    expect(fs.existsSync(p.meta("colors.json.bak"))).toBe(false);
  });

  it("a failure partway through writes nothing (no half-finished snapshot)", async () => {
    const p = makeProject();
    const h = host(p.aep, undefined, { scanComp: async (id) => { if (id === 2) throw new Error("AE busy"); return { compId: id, compName: "x", colors: [], expressions: [], skipped: 0 }; } });
    await expect(runScan(h, realIo)).rejects.toThrow(/AE busy/);
    expect(listDir(p.root + "/.murre")).toEqual(["project.json"]);
  });

  it("stops without writing if the active project changed during the scan", async () => {
    const p = makeProject();
    const h = host(p.aep);
    let calls = 0;
    h.getAepInfo = async () => ({ saved: true, name: "x.aep", path: ++calls === 1 ? p.aep : p.aep + "-other", appVersion: "25", numItems: 2 });
    await expect(runScan(h, realIo)).rejects.toThrow(/changed mid-scan/);
    expect(fs.existsSync(p.meta("colors.json"))).toBe(false);
  });

  it("recovers Main Comp choices from comps.json.bak when comps.json is damaged", async () => {
    const p = makeProject();
    await runScan(host(p.aep), realIo);
    writeSnapshot(realIo, p.root, "comps.json", withMain(parseCompsFile(readSnapshot(realIo, p.root, "comps.json"))!, 1, true));
    await runScan(host(p.aep), realIo); // makes .bak hold the main=true file
    fs.writeFileSync(p.meta("comps.json"), "{broken");
    const r = await runScan(host(p.aep), realIo);
    expect(readJson(p.meta("comps.json")).comps[0].main).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("warns, and keeps the damaged file, when neither comps.json nor its backup is usable", async () => {
    const p = makeProject();
    fs.writeFileSync(p.meta("comps.json"), "{broken");
    const r = await runScan(host(p.aep), realIo);
    expect(r.warnings[0]).toMatch(/could not be read/);
    expect(fs.readFileSync(p.meta("comps.json.corrupt"), "utf-8")).toBe("{broken");
  });

  it("refuses to scan over a comps.json from a newer Murre", async () => {
    const p = makeProject();
    fs.writeFileSync(p.meta("comps.json"), JSON.stringify({ schemaVersion: 5, comps: [] }));
    await expect(runScan(host(p.aep), realIo)).rejects.toThrow(/newer version/);
    expect(fs.existsSync(p.meta("colors.json"))).toBe(false);
  });

  it("only ever writes the three Companion files (project.json and others are untouched)", async () => {
    const p = makeProject();
    fs.writeFileSync(p.meta("notes.json"), '{"keep":1}');
    const proj = fs.readFileSync(p.meta("project.json"), "utf-8");
    await runScan(host(p.aep), realIo);
    expect(fs.readFileSync(p.meta("project.json"), "utf-8")).toBe(proj);
    expect(fs.readFileSync(p.meta("notes.json"), "utf-8")).toBe('{"keep":1}');
    expect(listDir(p.root + "/.murre")).toEqual(["assets.json", "colors.json", "comps.json", "environment.json", "expressions.json", "notes.json", "project.json"]);
    expect(fs.readFileSync(p.aep, "utf-8")).toBe("AEP");
  });
});
