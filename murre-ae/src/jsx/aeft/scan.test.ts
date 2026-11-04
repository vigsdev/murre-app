import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Runs the ExtendScript scanner against a small fake of After Effects' object model.
 * This checks our traversal logic and output shape; it cannot prove how a real After
 * Effects behaves, which has to be confirmed by trying the panel inside After Effects.
 */

class Item { id = 0; name = ""; parentFolder: any = null; }
class FolderItem extends Item {}
class SolidSource { constructor(public color: number[]) {} }
class FootageItem extends Item { constructor(public mainSource: any) { super(); } }
class Layer { name = ""; source: any = null; props: any[] = []; get numProperties() { return this.props.length; } property(i: number | string) { return typeof i === "string" ? this.props.find((p: any) => p.name === i) : this.props[i - 1]; } }
class AVLayer extends Layer {}
class TextLayer extends AVLayer { doc: any = {}; property(n: any) { return typeof n === "string" ? { value: this.doc } : super.property(n); } }
class CompItem extends Item {
  width = 1920; height = 1080; pixelAspect = 1; frameRate = 25; duration = 10;
  layers: Layer[] = [];
  usedIn: any[] = [];
  get numLayers() { return this.layers.length; }
  layer(i: number) { return this.layers[i - 1]; }
}

const PT = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
const PVT = { COLOR: 6418, TEXT_DOCUMENT: 6420, OneD: 6417 };

const group = (name: string, children: any[], extra: Record<string, any> = {}) => ({ name, propertyType: PT.NAMED_GROUP, ...extra, get numProperties() { return children.length; }, property: (i: number | string) => (typeof i === "string" ? children.find((c) => c.name === i) : children[i - 1]) });
const colorLeaf = (name: string, value: number[]) => leaf(name, { propertyValueType: PVT.COLOR, value });
/** A shape group like "Fill 1" / "Stroke 1" with its on/off switch. */
const shapeItem = (name: string, value: number[], enabled = true) => group(name, [colorLeaf("Color", value)], { enabled });
/** An effect with its fx switch. */
const effect = (name: string, matchName: string, children: any[], enabled = true) => group(name, children, { matchName, enabled });
const effects = (...list: any[]) => group("Effects", list, { matchName: "ADBE Effect Parade" });
const leaf = (name: string, o: Record<string, any> = {}) => ({ name, propertyType: PT.PROPERTY, propertyValueType: PVT.OneD, numKeys: 0, canSetExpression: true, expression: "", expressionEnabled: true, expressionError: "", ...o });

const g = globalThis as any;
let items: Item[];
let root: FolderItem;

beforeEach(() => {
  root = new FolderItem();
  items = [];
  g.CompItem = CompItem; g.AVLayer = AVLayer; g.TextLayer = TextLayer; g.FootageItem = FootageItem; g.SolidSource = SolidSource;
  g.PropertyType = PT; g.PropertyValueType = PVT;
  g.app = { version: "25.0x1", project: { get numItems() { return items.length; }, item: (i: number) => items[i - 1], rootFolder: root, file: null } };
});
afterEach(() => { for (const k of ["CompItem", "AVLayer", "TextLayer", "FootageItem", "SolidSource", "PropertyType", "PropertyValueType", "app"]) delete g[k]; });

const addComp = (id: number, name: string, layers: Layer[] = [], folder?: FolderItem) => {
  const c = new CompItem(); c.id = id; c.name = name; c.layers = layers; c.parentFolder = folder ?? root; items.push(c); return c;
};
const layer = (name: string, props: any[], cls: typeof Layer = AVLayer) => { const l = new cls(); l.name = name; l.props = props; return l; };

describe("getAepInfo", () => {
  it("reports an unsaved project", async () => {
    const { getAepInfo } = await import("./scan");
    expect(getAepInfo()).toMatchObject({ saved: false, name: null, path: null, appVersion: "25.0x1" });
  });
  it("reports the saved file's decoded name and OS path", async () => {
    const { getAepInfo } = await import("./scan");
    g.app.project.file = { displayName: "My Film v01.aep", fsName: "/Users/a/My Film/01 AE/My Film v01.aep" };
    expect(getAepInfo()).toMatchObject({ saved: true, name: "My Film v01.aep", path: "/Users/a/My Film/01 AE/My Film v01.aep" });
  });
});

describe("listComps", () => {
  it("lists only compositions, with their settings and folder path", async () => {
    const { listComps } = await import("./scan");
    const comps = new FolderItem(); comps.name = "Comps"; comps.parentFolder = root;
    const final = new FolderItem(); final.name = "Final"; final.parentFolder = comps;
    items.push(new FootageItem(null));
    addComp(3, "Top");
    const c = addComp(7, "Deep", [], final); c.frameRate = 23.976; c.duration = 4.5; c.usedIn = [items[1]];
    expect(listComps()).toEqual([
      { id: 3, name: "Top", width: 1920, height: 1080, pixelAspect: 1, frameRate: 25, duration: 10, folder: "", usedIn: 0 },
      { id: 7, name: "Deep", width: 1920, height: 1080, pixelAspect: 1, frameRate: 23.976, duration: 4.5, folder: "Comps/Final", usedIn: 1 },
    ]);
  });
});

describe("scanComp", () => {
  it("collects colors (static and keyframed) from nested groups, with a readable property path", async () => {
    const { scanComp } = await import("./scan");
    const fill = leaf("Color", { propertyValueType: PVT.COLOR, value: [1, 0, 0, 1], canSetExpression: true });
    const keyed = leaf("Stroke Color", { propertyValueType: PVT.COLOR, numKeys: 2, keyValue: (k: number) => (k === 1 ? [0, 0, 1, 1] : [0, 1, 0, 1]), value: [0, 0, 1, 1] });
    addComp(1, "Main", [layer("Shape", [group("Contents", [group("Rectangle 1", [group("Fill 1", [fill]), group("Stroke 1", [keyed])])])])]);
    const r = scanComp(1);
    expect(r.compName).toBe("Main");
    expect(r.colors).toEqual([
      { color: [1, 0, 0, 1], layer: "Shape", layerIndex: 1, property: "Contents > Rectangle 1 > Fill 1 > Color" },
      { color: [0, 0, 1, 1], layer: "Shape", layerIndex: 1, property: "Contents > Rectangle 1 > Stroke 1 > Stroke Color" },
      { color: [0, 1, 0, 1], layer: "Shape", layerIndex: 1, property: "Contents > Rectangle 1 > Stroke 1 > Stroke Color" },
    ]);
    expect(r.skipped).toBe(0);
  });

  it("collects expressions with enabled state and error text, and ignores empty ones", async () => {
    const { scanComp } = await import("./scan");
    const pos = leaf("Position", { expression: "wiggle(2, 30)" });
    const off = leaf("Rotation", { expression: "time*10", expressionEnabled: false, expressionError: "undefined value used in expression" });
    const none = leaf("Scale", { expression: "" });
    const cannot = leaf("Source Text", { canSetExpression: false, expression: "ignored" });
    addComp(1, "Main", [layer("Title", [group("Transform", [pos, off, none, cannot])])]);
    expect(scanComp(1).expressions).toEqual([
      { expression: "wiggle(2, 30)", layer: "Title", layerIndex: 1, property: "Transform > Position", enabled: true, error: null },
      { expression: "time*10", layer: "Title", layerIndex: 1, property: "Transform > Rotation", enabled: false, error: "undefined value used in expression" },
    ]);
  });

  it("collects text fill/stroke colors only when they are applied, and solid layer colors", async () => {
    const { scanComp } = await import("./scan");
    const text = leaf("Source Text", { propertyValueType: PVT.TEXT_DOCUMENT, canSetExpression: true, value: { applyFill: true, fillColor: [1, 1, 1], applyStroke: false, strokeColor: [0, 0, 0] } });
    const solidLayer = layer("Red Solid", []);
    solidLayer.source = new FootageItem(new SolidSource([1, 0, 0]));
    addComp(1, "Main", [layer("Title", [group("Text", [text])]), solidLayer]);
    expect(scanComp(1).colors).toEqual([
      { color: [1, 1, 1], layer: "Title", layerIndex: 1, property: "Text > Source Text > Fill color" },
      { color: [1, 0, 0], layer: "Red Solid", layerIndex: 2, property: "Solid color" },
    ]);
  });

  it("counts what it cannot read instead of failing or guessing", async () => {
    const { scanComp } = await import("./scan");
    const broken = leaf("Broken", { propertyValueType: PVT.COLOR });
    Object.defineProperty(broken, "value", { get() { throw new Error("cannot read"); } });
    const angry = group("Weird", []);
    Object.defineProperty(angry, "numProperties", { get() { throw new Error("nope"); } });
    addComp(1, "Main", [layer("L", [broken, angry, leaf("Fine", { propertyValueType: PVT.COLOR, value: [0, 0, 0, 1] })])]);
    const r = scanComp(1);
    expect(r.colors).toHaveLength(1);
    expect(r.skipped).toBe(2);
  });

  it("does not change anything in the project", async () => {
    const { scanComp } = await import("./scan");
    const color = leaf("Color", { propertyValueType: PVT.COLOR, value: [1, 0, 0, 1] });
    const c = addComp(1, "Main", [layer("L", [group("G", [color])])]);
    const snapshot = JSON.stringify({ c: c.layers.length, v: color.value, e: color.expression, items: items.length });
    scanComp(1);
    expect(JSON.stringify({ c: c.layers.length, v: color.value, e: color.expression, items: items.length })).toBe(snapshot);
  });

  it("throws a clear error for an unknown composition id", async () => {
    const { scanComp } = await import("./scan");
    addComp(1, "Main");
    expect(() => scanComp(99)).toThrow(/Composition not found/);
  });
});

describe("scanComp: only colors that are in use", () => {
  const colorsOf = async (props: any[], configure?: (l: Layer) => void) => {
    const { scanComp } = await import("./scan");
    items.length = 0; // each call is its own project
    const l = layer("L", props);
    configure?.(l);
    addComp(1, "Main", [l]);
    return scanComp(1).colors.map((c) => c.property + " = " + c.color.join(","));
  };
  const shape = (...items: any[]) => group("Contents", [group("Rectangle 1", items)]);

  it("shape layer with Stroke and Fill both on gives 2 colors", async () => {
    expect(await colorsOf([shape(shapeItem("Stroke 1", [0, 0, 0]), shapeItem("Fill 1", [1, 0, 0]))])).toEqual([
      "Contents > Rectangle 1 > Stroke 1 > Color = 0,0,0",
      "Contents > Rectangle 1 > Fill 1 > Color = 1,0,0",
    ]);
  });

  it("shape layer with only Fill on gives 1 color", async () => {
    expect(await colorsOf([shape(shapeItem("Stroke 1", [0, 0, 0], false), shapeItem("Fill 1", [1, 0, 0]))])).toEqual([
      "Contents > Rectangle 1 > Fill 1 > Color = 1,0,0",
    ]);
  });

  it("a switched-off shape group hides everything inside it", async () => {
    const off = group("Rectangle 1", [shapeItem("Fill 1", [1, 0, 0])], { enabled: false });
    const on = group("Ellipse 1", [shapeItem("Fill 1", [0, 1, 0])], { enabled: true });
    expect(await colorsOf([group("Contents", [off, on])])).toEqual(["Contents > Ellipse 1 > Fill 1 > Color = 0,1,0"]);
  });

  it("a layer with its video switch off gives no colors, but a switched-on one does", async () => {
    const props = () => [shape(shapeItem("Fill 1", [1, 0, 0]))];
    expect(await colorsOf(props(), (l) => ((l as any).enabled = false))).toEqual([]);
    expect(await colorsOf(props(), (l) => ((l as any).enabled = true))).toHaveLength(1);
  });

  it("a switched-off solid layer does not report its solid color", async () => {
    const { scanComp } = await import("./scan");
    const l = layer("Solid", []);
    l.source = new FootageItem(new SolidSource([1, 1, 1]));
    (l as any).enabled = false;
    addComp(1, "Main", [l]);
    expect(scanComp(1).colors).toEqual([]);
  });

  it("an enabled Fill effect gives its color", async () => {
    const fill = effect("Fill", "ADBE Fill", [colorLeaf("Color", [1, 0, 0, 1])]);
    expect(await colorsOf([effects(fill)])).toEqual(["Effects > Fill > Color = 1,0,0,1"]);
  });

  it("a switched-off Fill effect gives nothing", async () => {
    const fill = effect("Fill", "ADBE Fill", [colorLeaf("Color", [1, 0, 0, 1])], false);
    expect(await colorsOf([effects(fill)])).toEqual([]);
  });

  it("Gradient Ramp gives its start and end colors, and 4-Color Gradient gives its four", async () => {
    const ramp = effect("Gradient Ramp", "ADBE Ramp", [colorLeaf("Start Color", [0, 0, 0, 1]), colorLeaf("End Color", [1, 1, 1, 1]), leaf("Ramp Shape")]);
    const four = effect("4-Color Gradient", "ADBE 4ColorGradient", [1, 2, 3, 4].map((n) => group("Point & Color " + n, [leaf("Point " + n), colorLeaf("Color " + n, [n / 10, 0, 0, 1])])));
    expect(await colorsOf([effects(ramp, four)])).toEqual([
      "Effects > Gradient Ramp > Start Color = 0,0,0,1",
      "Effects > Gradient Ramp > End Color = 1,1,1,1",
      "Effects > 4-Color Gradient > Point & Color 1 > Color 1 = 0.1,0,0,1",
      "Effects > 4-Color Gradient > Point & Color 2 > Color 2 = 0.2,0,0,1",
      "Effects > 4-Color Gradient > Point & Color 3 > Color 3 = 0.3,0,0,1",
      "Effects > 4-Color Gradient > Point & Color 4 > Color 4 = 0.4,0,0,1",
    ]);
  });

  it("recognises the three effects by their English names too", async () => {
    const fill = effect("Fill", "SOMETHING ELSE", [colorLeaf("Color", [1, 0, 0, 1])]);
    expect(await colorsOf([effects(fill)])).toHaveLength(1);
  });

  it("ignores the colors of other effects, such as Tint or Drop Shadow", async () => {
    const tint = effect("Tint", "ADBE Tint", [colorLeaf("Map Black To", [0, 0, 0, 1]), colorLeaf("Map White To", [1, 1, 1, 1])]);
    const shadow = effect("Drop Shadow", "ADBE Drop Shadow", [colorLeaf("Shadow Color", [0, 0, 0, 1])]);
    expect(await colorsOf([effects(tint, shadow)])).toEqual([]);
  });

  it("layer styles count only when switched on, and the defaults of switched-off ones are ignored", async () => {
    const styles = group("Layer Styles", [
      group("Drop Shadow", [colorLeaf("Color", [0, 0, 0, 1])], { enabled: false }),
      group("Stroke", [colorLeaf("Color", [1, 0, 0, 1])], { enabled: true }),
      group("Inner Glow", [colorLeaf("Color", [1, 1, 0.7, 1])], { enabled: false }),
    ]);
    expect(await colorsOf([styles])).toEqual(["Layer Styles > Stroke > Color = 1,0,0,1"]);
  });

  it("ignores a 3D layer's Material Options colors", async () => {
    const mat = group("Material Options", [colorLeaf("Shadow Color", [0, 0, 0, 1])], { matchName: "ADBE Material Options Group" });
    expect(await colorsOf([mat])).toEqual([]);
  });

  it("does not change which expressions are collected (switched-off groups still report them)", async () => {
    const { scanComp } = await import("./scan");
    const off = group("Rectangle 1", [group("Fill 1", [leaf("Opacity", { expression: "wiggle(1,10)" })], { enabled: false })], { enabled: false });
    const l = layer("L", [group("Contents", [off])]);
    (l as any).enabled = false;
    addComp(1, "Main", [l]);
    expect(scanComp(1).expressions.map((e) => e.expression)).toEqual(["wiggle(1,10)"]);
  });
});

describe("scanFonts", () => {
  const fo = (ps: string, family: string, style: string, extra: any = {}) => ({ postScriptName: ps, familyName: family, styleName: style, location: "", isFromAdobeFonts: false, isSubstitute: false, ...extra });

  it("uses project.usedFonts (AE 24.5+) and resolves layers by id", async () => {
    const { scanFonts } = await import("./scan");
    const comp = addComp(1, "Main");
    const t1 = layer("Title", [], AVLayer) as any; t1.containingComp = comp; t1.index = 1;
    const t2 = layer("Sub", [], AVLayer) as any; t2.containingComp = comp; t2.index = 2;
    const byId: any = { 10: t1, 11: t2 };
    g.app.project.layerByID = (id: number) => byId[id];
    g.app.project.usedFonts = [
      { font: fo("Inter-Bold", "Inter", "Bold", { location: "/f/Inter.ttf" }), usedAt: [{ layerID: 10, layerTimeD: 0 }, { layerID: 11, layerTimeD: 0 }] },
      { font: fo("Gone-Regular", "Gone", "Regular", { isSubstitute: true }), usedAt: [] },
    ];
    const r = scanFonts();
    expect(r.method).toBe("project");
    expect(r.fonts).toHaveLength(2);
    expect(r.fonts[0]).toMatchObject({ postScriptName: "Inter-Bold", family: "Inter", style: "Bold", location: "/f/Inter.ttf", layerCount: 2 });
    expect(r.fonts[0].layers).toEqual([{ comp: "Main", layer: "Title", compId: 1, layerIndex: 1 }, { comp: "Main", layer: "Sub", compId: 1, layerIndex: 2 }]);
    expect(r.fonts[1]).toMatchObject({ postScriptName: "Gone-Regular", missing: true });
  });

  it("finds each layer's comp and position by layer id, without relying on containingComp", async () => {
    const { scanFonts } = await import("./scan");
    const a = layer("Title", [], AVLayer) as any; a.id = 101;
    const b = layer("Sub", [], AVLayer) as any; b.id = 102;
    addComp(8, "Intro", [a, b]);
    g.app.project.layerByID = () => { throw new Error("should not be needed"); };
    g.app.project.usedFonts = [{ font: fo("Inter-Bold", "Inter", "Bold"), usedAt: [{ layerID: 102, layerTimeD: 0 }] }];
    const r = scanFonts();
    expect(r.fonts[0].layers).toEqual([{ comp: "Intro", layer: "Sub", compId: 8, layerIndex: 2 }]);
  });

  it("falls back to each text layer's first font on older After Effects", async () => {
    const { scanFonts } = await import("./scan");
    const t = layer("Title", [], TextLayer as any) as any;
    t.doc = { font: "Arial-BoldMT", fontFamily: "Arial", fontStyle: "Bold", fontLocation: "/f/Arial.ttf" };
    const u = layer("Other", [], TextLayer as any) as any;
    u.doc = { font: "Arial-BoldMT", fontFamily: "Arial", fontStyle: "Bold" };
    addComp(1, "Main", [t, u, layer("Shape", [])]);
    const r = scanFonts();
    expect(r.method).toBe("layers");
    expect(r.fonts).toHaveLength(1);
    expect(r.fonts[0]).toMatchObject({ postScriptName: "Arial-BoldMT", family: "Arial", style: "Bold", layerCount: 2 });
    expect(r.fonts[0].layers).toEqual([{ comp: "Main", layer: "Title", compId: 1, layerIndex: 1 }, { comp: "Main", layer: "Other", compId: 1, layerIndex: 2 }]);
  });
});

describe("scanComp effects", () => {
  it("lists every effect on a layer, switched on or off, by its internal name", async () => {
    const { scanComp } = await import("./scan");
    const fx = effects(
      group("Gaussian Blur", [leaf("Blurriness")], { matchName: "ADBE Gaussian Blur 2" }),
      group("My Glow", [leaf("Radius")], { matchName: "VIDEOCOPILOT Deep Glow", enabled: false }),
    );
    addComp(1, "Main", [layer("Title", [fx])]);
    expect(scanComp(1).effects).toEqual([
      { matchName: "ADBE Gaussian Blur 2", name: "Gaussian Blur", layer: "Title" },
      { matchName: "VIDEOCOPILOT Deep Glow", name: "My Glow", layer: "Title" },
    ]);
  });
});

describe("revealUsage", () => {
  const mkLayer = (name: string, props: any[] = []) => { const l = layer(name, props) as any; l.selected = false; return l; };
  const mkComp = (id: number, name: string, layers: any[]) => { const c = addComp(id, name, layers) as any; c.openInViewer = () => { c.opened = true; }; Object.defineProperty(c, "selectedLayers", { get: () => c.layers.filter((l: any) => l.selected) }); c.selectedProperties = []; return c; };

  it("opens the comp, selects the layer and the property", async () => {
    const { revealUsage } = await import("./reveal");
    const pos: any = leaf("Position"); pos.selected = false;
    const t = mkLayer("Title", [group("Transform", [pos])]);
    const other = mkLayer("Other"); other.selected = true;
    const c = mkComp(4, "Main", [other, t]);
    g.app.activate = () => { c.activated = true; };
    expect(revealUsage(4, "Main", 2, "Title", "Transform > Position")).toEqual({ ok: true, message: "" });
    expect(c.opened && c.activated).toBe(true);
    expect([other.selected, t.selected, pos.selected]).toEqual([false, true, true]);
  });

  it("finds a moved layer by name, says so, and keeps going when the property is gone", async () => {
    const { revealUsage } = await import("./reveal");
    const t = mkLayer("Title");
    mkComp(4, "Main", [mkLayer("New"), t]);
    const r = revealUsage(4, "Main", 1, "Title", "Transform > Gone");
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/reordered/);
    expect(t.selected).toBe(true);
  });

  it("fails clearly when the comp or the layer is gone", async () => {
    const { revealUsage } = await import("./reveal");
    mkComp(4, "Main", [mkLayer("A")]);
    expect(revealUsage(99, "Nope", 1, "A", "")).toMatchObject({ ok: false, message: expect.stringMatching(/not in the open project/) });
    expect(revealUsage(4, "Main", 1, "Missing", "")).toMatchObject({ ok: false, message: expect.stringMatching(/Scan again/) });
  });
});
