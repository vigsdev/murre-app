import { describe, expect, it } from "vitest";
import { buildCompsFile, mergeComps, parseCompsFile, sameAep, withMain, type AepRef, type CompEntry } from "./comps-model";

const aep = (path = "01 AE/v1.aep"): AepRef => ({ projectId: "p", path, name: "v1.aep" });
/** A scanned composition. `usedIn` defaults to 1 (used by another comp), so by default nothing is picked automatically. */
const info = (id: number, name: string, extra: Partial<CompEntry> & { usedIn?: number } = {}) => ({
  id, name, width: 1920, height: 1080, pixelAspect: 1, frameRate: 25, duration: 10, folder: "", usedIn: 1, ...extra,
});
const entry = (id: number, name: string, main: boolean, extra: Partial<CompEntry> = {}): CompEntry => {
  const { usedIn: _ignored, ...rest } = info(id, name, extra);
  return { ...rest, main };
};
const prevFile = (a: AepRef, comps: CompEntry[]) => buildCompsFile(a, comps, "2026-01-01T00:00:00.000Z");

describe("mergeComps", () => {
  it("picks compositions that no other composition uses as Main Comps on a first scan", () => {
    const r = mergeComps(null, aep(), [info(1, "Final", { usedIn: 0 }), info(2, "Pre", { usedIn: 2 }), info(3, "Other", { usedIn: 0 })]);
    expect(r.comps.map((c) => c.main)).toEqual([true, false, true]);
    expect(r.unmatched).toEqual([]);
  });

  it("keeps what someone chose, and only picks by default for compositions it has not seen", () => {
    const prev = prevFile(aep(), [entry(1, "Final", false), entry(2, "Alt", true)]);
    const r = mergeComps(prev, aep(), [info(1, "Final", { usedIn: 0 }), info(2, "Alt", { usedIn: 0 }), info(3, "New", { usedIn: 0 }), info(4, "NewPre", { usedIn: 1 })]);
    expect(r.comps.map((c) => c.main)).toEqual([false, true, true, false]);
  });

  it("applies the default to every composition while nothing has been chosen yet", () => {
    const prev = prevFile(aep(), [entry(1, "Final", false), entry(2, "Pre", false)]);
    const r = mergeComps(prev, aep(), [info(1, "Final", { usedIn: 0 }), info(2, "Pre", { usedIn: 3 })]);
    expect(r.comps.map((c) => c.main)).toEqual([true, false]);
  });

  it("keeps choices for the same AEP by item id, even if the comp was renamed", () => {
    const prev = prevFile(aep(), [entry(5, "Old name", true), entry(6, "B", false)]);
    const r = mergeComps(prev, aep(), [info(5, "Renamed"), info(6, "B"), info(7, "New")]);
    expect(r.comps.map((c) => [c.id, c.main])).toEqual([[5, true], [6, false], [7, false]]);
    expect(r.unmatched).toEqual([]);
  });

  it("reports a Main Comp that no longer exists instead of dropping it silently", () => {
    const prev = prevFile(aep(), [entry(5, "Gone", true)]);
    const r = mergeComps(prev, aep(), [info(6, "Other")]);
    expect(r.comps[0].main).toBe(false);
    expect(r.unmatched.map((c) => c.name)).toEqual(["Gone"]);
  });

  it("does NOT trust ids across different AEP files (ids collide between projects)", () => {
    const prev = prevFile(aep("01 AE/v1.aep"), [entry(1, "Final", true, { width: 3840 })]);
    // Same id 1 but a different comp in another file.
    const r = mergeComps(prev, aep("01 AE/v2.aep"), [info(1, "Teaser")]);
    expect(r.comps[0].main).toBe(false);
    expect(r.unmatched.map((c) => c.name)).toEqual(["Final"]);
  });

  it("carries a choice to a new AEP version only for an identical, unique comp", () => {
    const prev = prevFile(aep("01 AE/v1.aep"), [entry(1, "Final", true), entry(2, "Teaser", true)]);
    const r = mergeComps(prev, aep("01 AE/v2.aep"), [info(40, "Final"), info(41, "Teaser", { frameRate: 30 })]);
    expect(r.comps.map((c) => [c.name, c.main])).toEqual([["Final", true], ["Teaser", false]]);
    expect(r.unmatched.map((c) => c.name)).toEqual(["Teaser"]);
  });

  it("does not guess between look-alike comps", () => {
    const prev = prevFile(aep("a.aep"), [entry(1, "Same", true)]);
    const r = mergeComps(prev, aep("b.aep"), [info(8, "Same"), info(9, "Same")]);
    expect(r.comps.every((c) => !c.main)).toBe(true);
    expect(r.unmatched).toHaveLength(1);
  });
});

describe("parseCompsFile / withMain", () => {
  it("is lenient about junk entries and missing fields", () => {
    const f = parseCompsFile({ schemaVersion: 1, comps: [{ id: 1, name: "A", main: true }, { name: "no id" }, null, 5], aep: { projectId: "p", path: "x.aep" } });
    expect(f?.comps).toHaveLength(1);
    expect(f?.comps[0].main).toBe(true);
    expect(f?.comps[0].width).toBe(0);
    expect(sameAep(f!.aep, { projectId: "p", path: "x.aep", name: "" })).toBe(true);
  });

  it("returns null for non-objects and throws for a newer schema", () => {
    expect(parseCompsFile(null)).toBeNull();
    expect(parseCompsFile("x")).toBeNull();
    expect(() => parseCompsFile({ schemaVersion: 2, comps: [] })).toThrow(/newer version/);
  });

  it("withMain changes one comp only, and rejects unknown ids", () => {
    const f = prevFile(aep(), [entry(1, "A", false), entry(2, "B", false)]);
    const g = withMain(f, 2, true);
    expect(g.comps.map((c) => c.main)).toEqual([false, true]);
    expect(f.comps[1].main).toBe(false); // original untouched
    expect(() => withMain(f, 99, true)).toThrow(/not in the last scan/);
  });
});
