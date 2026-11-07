import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { organizeProject } from "./organize";

/** Fake After Effects objects: checks our logic only; real behaviour must be confirmed inside After Effects. */
let nextId = 1;
class Item { id = nextId++; name = ""; parentFolder: any = null; }
class FolderItem extends Item {
  get numItems() { return items.filter((i) => i.parentFolder === this).length; }
  item(n: number) { return items.filter((i) => i.parentFolder === this)[n - 1]; }
  remove() { items.splice(items.indexOf(this), 1); }
}
class SolidSource {}
class FileSource {}
class PlaceholderSource {}
class FootageItem extends Item { constructor(public mainSource: any, public file: { name: string } | null = null) { super(); } }
class CompItem extends Item { usedIn: any[] = []; }

const g = globalThis as any;
let items: Item[];
let root: FolderItem;
let undoGroups: string[];
let moveFails: Item | null;

/** Items live in one flat list, so a parent change is just a field change; locked items refuse to move. */
const track = <T extends Item>(item: T): T => {
  let parent = item.parentFolder;
  Object.defineProperty(item, "parentFolder", {
    get: () => parent,
    set: (f) => { if (item === moveFails) throw new Error("locked"); parent = f; },
    configurable: true,
  });
  items.push(item);
  return item;
};

const comp = (name: string, usedBy = 0, folder: any = root) => { const c = new CompItem(); c.name = name; c.usedIn = new Array(usedBy).fill(0); c.parentFolder = folder; return track(c); };
const file = (name: string, folder: any = root) => { const f = new FootageItem(new FileSource(), { name }); f.name = name; f.parentFolder = folder; return track(f); };
const solid = (name: string) => { const f = new FootageItem(new SolidSource()); f.name = name; f.parentFolder = root; return track(f); };
const folder = (name: string, parent: any = root) => { const f = new FolderItem(); f.name = name; f.parentFolder = parent; return track(f); };
const pathOf = (item: Item) => { const names: string[] = []; let f: any = item.parentFolder; while (f && f !== root) { names.unshift(f.name); f = f.parentFolder; } return names.join("/"); };

beforeEach(() => {
  nextId = 1; items = []; undoGroups = []; moveFails = null;
  root = new FolderItem(); root.id = 0;
  g.FolderItem = FolderItem; g.FootageItem = FootageItem; g.CompItem = CompItem; g.SolidSource = SolidSource; g.FileSource = FileSource; g.PlaceholderSource = PlaceholderSource;
  g.app = {
    project: {
      get numItems() { return items.length; },
      item: (i: number) => items[i - 1],
      rootFolder: root,
      items: { addFolder: (name: string) => folder(name, root) },
    },
    beginUndoGroup: (n: string) => undoGroups.push(n),
    endUndoGroup: () => undoGroups.push("end"),
  };
});
afterEach(() => { for (const k of ["FolderItem", "FootageItem", "CompItem", "SolidSource", "FileSource", "PlaceholderSource", "app"]) delete g[k]; });

describe("organizeProject", () => {
  it("sorts comps, pre-comps, footage by type and solids into the Murre bins", () => {
    const main = comp("Main"); const pre = comp("Pre", 2);
    const img = file("hero.PNG"); const wav = file("music.wav"); const psd = file("bg.psd"); const ai = file("logo.ai"); const mov = file("clip.mov");
    const sol = solid("Red Solid");
    expect(organizeProject()).toEqual({ moved: 8, failed: 0 });
    expect(pathOf(main)).toBe("01 Comps");
    expect(pathOf(pre)).toBe("01 Comps/Precomps");
    expect(pathOf(img)).toBe("02 Assets/01 Images");
    expect(pathOf(wav)).toBe("02 Assets/02 Audios");
    expect(pathOf(psd)).toBe("02 Assets/03 PSD Files");
    expect(pathOf(ai)).toBe("02 Assets/04 Illustrator Files");
    expect(pathOf(mov)).toBe("02 Assets/07 Videos");
    expect(pathOf(sol)).toBe("02 Assets/Solids");
    expect(undoGroups).toEqual(["Murre: organize project", "end"]);
  });

  it("uses the project's own folder setup when it is given one", () => {
    const mov = file("clip.mov"); const png = file("a.png");
    organizeProject([{ folder: "Footage", exts: ["mov"] }]);
    expect(pathOf(mov)).toBe("02 Assets/Footage");
    expect(pathOf(png)).toBe("02 Assets"); // not in this setup, so it stays in the assets bin
  });

  it("does nothing, and opens no undo step, when everything is already in place", () => {
    comp("Main"); file("a.png"); solid("S");
    organizeProject();
    undoGroups.length = 0;
    const before = items.map((i) => [i.id, pathOf(i)]);
    expect(organizeProject()).toEqual({ moved: 0, failed: 0 });
    expect(undoGroups).toEqual([]);
    expect(items.map((i) => [i.id, pathOf(i)])).toEqual(before);
  });

  it("reuses existing bins instead of making copies, and removes bins it empties", () => {
    const comps = folder("01 Comps");
    const old = folder("Old stuff");
    const a = comp("A", 0, old);
    organizeProject();
    expect(items.filter((i) => i.name === "01 Comps")).toHaveLength(1);
    expect(a.parentFolder).toBe(comps);
    expect(items.includes(old)).toBe(false);
  });

  it("moves items out of the user's own bins and leaves placeholders and other bins' contents alone", () => {
    const mine = folder("Mine");
    const img = file("x.jpg", mine);
    const ph = new FootageItem(new PlaceholderSource()); ph.name = "Placeholder"; ph.parentFolder = mine; track(ph);
    organizeProject();
    expect(pathOf(img)).toBe("02 Assets/01 Images");
    expect(pathOf(ph)).toBe("Mine");
  });

  it("uses the item's name for a missing file, and counts items that refuse to move", () => {
    const missing = new FootageItem(new FileSource(), null); missing.name = "gone.wav"; missing.parentFolder = root; track(missing);
    const stuck = file("locked.png"); moveFails = stuck;
    expect(organizeProject()).toEqual({ moved: 1, failed: 1 });
    expect(pathOf(missing)).toBe("02 Assets/02 Audios");
    expect(pathOf(stuck)).toBe("");
  });
  it("moves an imported project's bin whole into Templates and sorts nothing inside it", () => {
    // Like importing "Paper Transition.aep": its own bins, comps, footage and an empty bin.
    const imported = folder("Paper Transition.aep");
    const transitions = folder("Transitions", imported);
    const t1 = folder("Transition 01", transitions);
    const tComp = comp("Transition 01", 0, t1);
    const pre = comp("Video Placeholder 01", 1, t1);
    const other = folder("Other", t1);
    const tex = file("paper.png", other);
    const empty = folder("Spare", imported);
    const empty2 = folder("Empty inside", other);
    const main = comp("00 Main");
    organizeProject();
    expect(pathOf(imported)).toBe("02 Assets/05 Templates");
    expect(pathOf(tComp)).toBe("02 Assets/05 Templates/Paper Transition.aep/Transitions/Transition 01");
    expect(pathOf(pre)).toBe("02 Assets/05 Templates/Paper Transition.aep/Transitions/Transition 01");
    expect(pathOf(tex)).toBe("02 Assets/05 Templates/Paper Transition.aep/Transitions/Transition 01/Other");
    expect(items.includes(empty) && items.includes(empty2)).toBe(true); // its empty bins are kept
    expect(pathOf(main)).toBe("01 Comps"); // the rest of the project is sorted as usual
  });

  it("does nothing the second time, and leaves things put into Templates by hand", () => {
    folder("Paper Transition.aep");
    comp("A", 0, folder("Inner", items[0] as any));
    organizeProject();
    const templates = items.find((i) => i.name === "05 Templates")!;
    const handPlaced = comp("Loose template comp", 0, templates);
    const handBin = folder("My presets", templates);
    undoGroups = [];
    expect(organizeProject()).toEqual({ moved: 0, failed: 0 });
    expect(undoGroups).toEqual([]); // nothing to do: no undo step
    expect(pathOf(handPlaced)).toBe("02 Assets/05 Templates");
    expect(items.includes(handBin)).toBe(true); // an empty bin in Templates is kept
  });

  it("uses the folder setup's templates folder, handles .aepx and keeps a project inside another together", () => {
    const outer = folder("Kit.AEPX");
    const inner = folder("Nested.aep", outer);
    const c = comp("C", 0, inner);
    organizeProject([{ folder: "01 Images", exts: ["png"] }, { folder: "Templates & Kits", exts: [] }]);
    expect(pathOf(outer)).toBe("02 Assets/Templates & Kits");
    expect(pathOf(inner)).toBe("02 Assets/Templates & Kits/Kit.AEPX");
    expect(pathOf(c)).toBe("02 Assets/Templates & Kits/Kit.AEPX/Nested.aep");
  });

  it("treats a bin that only mentions aep in its name as an ordinary bin", () => {
    const notImported = folder("aep notes");
    const c = comp("X", 0, notImported);
    organizeProject();
    expect(pathOf(c)).toBe("01 Comps");
  });
});
