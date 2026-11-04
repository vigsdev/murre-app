import { describe, expect, it } from "vitest";
import type { CompScan } from "../../../shared/scan-types";
import { buildEnvironmentFile, buildFontsFile, buildSnapshots, MAX_COLORS, MAX_EXPRESSIONS } from "./scan-model";

const scan = (over: Partial<CompScan> = {}): CompScan => ({ compId: 1, compName: "Main", colors: [], expressions: [], skipped: 0, ...over });
const AT = "2026-10-26T12:00:00.000Z";

describe("buildSnapshots", () => {
  it("flattens comps into colors and expressions with the comp name and id", () => {
    const s = buildSnapshots([
      scan({
        colors: [{ color: [1, 0.5, 0, 1], layer: "Title", property: "Fill" }],
        expressions: [{ expression: "wiggle(2,30)", layer: "Title", property: "Position", enabled: true, error: null }],
      }),
    ], AT);
    expect(s.colors).toEqual({ schemaVersion: 1, lastScanAt: AT, colors: [{ color: [1, 0.5, 0, 1], comp: "Main", compId: 1, layer: "Title", property: "Fill" }] });
    expect(s.expressions.expressions[0]).toEqual({ expression: "wiggle(2,30)", comp: "Main", compId: 1, layer: "Title", property: "Position", enabled: true });
    expect(s.counts).toMatchObject({ comps: 1, colors: 1, expressions: 1 });
  });

  it("turns After Effects' carriage-return line breaks into newlines", () => {
    const s = buildSnapshots([scan({ expressions: [{ expression: "a;\rb;\r\nc;", layer: "L", property: "P", enabled: true, error: null }] })], AT);
    expect(s.expressions.expressions[0].expression).toBe("a;\nb;\nc;");
  });

  it("includes After Effects' error text and the disabled flag", () => {
    const s = buildSnapshots([scan({ expressions: [{ expression: "x", layer: "L", property: "P", enabled: false, error: "bad" }] })], AT);
    expect(s.expressions.expressions[0]).toMatchObject({ enabled: false, error: "bad" });
  });

  it("leaves out colors outside 0-1 (e.g. HDR) and counts them", () => {
    const s = buildSnapshots([scan({ colors: [
      { color: [2, 0, 0], layer: "L", property: "P" },
      { color: [0, -0.1, 0], layer: "L", property: "P" },
      { color: [NaN, 0, 0], layer: "L", property: "P" },
      { color: [0, 0], layer: "L", property: "P" },
      { color: [0, 0, 0], layer: "L", property: "ok" },
    ] })], AT);
    expect(s.colors.colors).toHaveLength(1);
    expect(s.counts.colorsOutOfRange).toBe(4);
  });

  it("lists a repeated keyframe value once, but keeps different values and different layers", () => {
    const c = { color: [1, 1, 1], layer: "L", property: "Fill" };
    const s = buildSnapshots([scan({ colors: [c, c, { ...c, color: [0, 0, 0] }, { ...c, layer: "L2" }] })], AT);
    expect(s.colors.colors).toHaveLength(3);
  });

  it("keeps same-named comps apart by id", () => {
    const c = { color: [1, 1, 1], layer: "L", property: "Fill" };
    const s = buildSnapshots([scan({ compId: 1, colors: [c] }), scan({ compId: 2, colors: [c] })], AT);
    expect(s.colors.colors).toHaveLength(2);
  });

  it("caps at the desktop app's limits and says how many were left out", () => {
    const colors = Array.from({ length: MAX_COLORS + 5 }, (_, i) => ({ color: [(i % 1000) / 1000, Math.floor(i / 1000) / 100, 0], layer: "L", property: "P" + i }));
    const expressions = Array.from({ length: MAX_EXPRESSIONS + 3 }, (_, i) => ({ expression: "e" + i, layer: "L", property: "P", enabled: true, error: null }));
    const s = buildSnapshots([scan({ colors, expressions })], AT);
    expect(s.colors.colors).toHaveLength(MAX_COLORS);
    expect(s.counts.colorsOverLimit).toBe(5);
    expect(s.expressions.expressions).toHaveLength(MAX_EXPRESSIONS);
    expect(s.counts.expressionsOverLimit).toBe(3);
  });

  it("adds up unreadable properties", () => {
    expect(buildSnapshots([scan({ skipped: 2 }), scan({ compId: 2, skipped: 3 })], AT).counts.unreadable).toBe(5);
  });
});

describe("buildFontsFile", () => {
  const f = (family: string, style: string, over: Record<string, any> = {}) => ({ postScriptName: `${family}-${style}`, family, style, location: "", adobeFonts: false, missing: false, layerCount: 1, layers: [{ comp: "Main", layer: "T" }], ...over });
  it("sorts by family then style, keeps uses, and drops nameless fonts", () => {
    const file = buildFontsFile({ method: "project", skipped: 0, fonts: [f("Zed", "Bold"), f("Inter", "Regular"), f("Inter", "Bold"), f("", "", { postScriptName: "" })] }, AT);
    expect(file.method).toBe("project");
    expect(file.lastScanAt).toBe(AT);
    expect(file.fonts.map((x) => x.postScriptName)).toEqual(["Inter-Bold", "Inter-Regular", "Zed-Bold"]);
    expect(file.fonts[0].uses).toEqual([{ comp: "Main", layer: "T" }]);
  });
});

describe("buildEnvironmentFile", () => {
  it("keeps only non-Adobe effects, counts layers and sorts by name", () => {
    const e = (matchName: string, name: string, layer = "L") => ({ matchName, name, layer });
    const file = buildEnvironmentFile([
      scan({ compName: "A", effects: [e("ADBE Glo2", "Glow"), e("Pseudo/AC IN", "AC IN [IDE] Controls"), e("CC Jaws", "CC Jaws"), e("ZZ Plug", "Zeta"), e("AA Plug", "Alpha")] }),
      scan({ compName: "B", effects: [e("ZZ Plug", "Zeta", "L2")] }),
      scan({ compName: "C" }),
    ], "25.1", AT);
    expect(file.aeVersion).toBe("25.1");
    expect(file.plugins.map((p) => [p.name, p.layerCount])).toEqual([["Alpha", 1], ["Zeta", 2]]);
    expect(file.plugins[1].uses).toEqual([{ comp: "A", layer: "L" }, { comp: "B", layer: "L2" }]);
  });
});
