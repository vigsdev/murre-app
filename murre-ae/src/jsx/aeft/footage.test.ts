import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listFootage, relinkFootage } from "./footage";

/** Fake After Effects objects: checks our logic only; real behaviour must be confirmed inside After Effects. */
class Item { id = 0; name = ""; }
class FileSource { constructor(public missingFootagePath = "") {} }
class SolidSource {}
class FootageItem extends Item {
  footageMissing = false; file: { fsName: string } | null = null; replaced: any = null; throwOnReplace = false; renameOnReplace = false;
  constructor(public mainSource: any) { super(); }
  replace(f: any) { if (this.throwOnReplace) throw new Error("no"); this.replaced = f; this.file = { fsName: f.fsName }; if (this.renameOnReplace) this.name = f.fsName.split("/").pop()!; }
}
class CompItem extends Item {}

const g = globalThis as any;
let items: Item[];
const footage = (id: number, name: string, path: string | null, src: any = new FileSource()) => {
  const f = new FootageItem(src); f.id = id; f.name = name; f.file = path ? { fsName: path } : null; items.push(f); return f;
};

beforeEach(() => {
  items = [];
  g.FootageItem = FootageItem; g.FileSource = FileSource; g.CompItem = CompItem;
  g.File = class { exists: boolean; fsName: string; constructor(public p: string) { this.fsName = p; this.exists = !p.includes("gone"); } };
  g.app = { project: { get numItems() { return items.length; }, item: (i: number) => items[i - 1] } };
});
afterEach(() => { for (const k of ["FootageItem", "FileSource", "CompItem", "File", "app"]) delete g[k]; });

describe("listFootage", () => {
  it("lists file-backed footage only, flags missing files and sequences", () => {
    footage(1, "photo.jpg", "/dl/photo.jpg");
    footage(2, "Solid", null, new SolidSource());
    const missing = footage(3, "old.png", null, new FileSource("/dl/old.png")); missing.footageMissing = true;
    footage(4, "frames_[0001-0010].png", "/dl/frames_0001.png");
    items.push(new CompItem());
    expect(listFootage()).toEqual([
      { id: 1, name: "photo.jpg", path: "/dl/photo.jpg", kind: "file", missing: false },
      { id: 3, name: "old.png", path: "/dl/old.png", kind: "file", missing: true },
      { id: 4, name: "frames_[0001-0010].png", path: "/dl/frames_0001.png", kind: "sequence", missing: false },
    ]);
  });
});

describe("relinkFootage", () => {
  it("replaces the source with the new file and keeps the item's name", () => {
    const f = footage(1, "Hero shot", "/dl/hero.jpg"); f.renameOnReplace = true;
    expect(relinkFootage(1, "/p/hero.jpg")).toEqual({ ok: true, message: "" });
    expect(f.replaced.fsName).toBe("/p/hero.jpg");
    expect(f.name).toBe("Hero shot");
  });
  it("fails clearly for unknown items, missing files and AE errors, changing nothing", () => {
    const f = footage(1, "a", "/dl/a.jpg");
    expect(relinkFootage(9, "/p/a.jpg").ok).toBe(false);
    expect(relinkFootage(1, "/p/gone.jpg").message).toContain("not there any more");
    expect(f.replaced).toBeNull();
    f.throwOnReplace = true;
    expect(relinkFootage(1, "/p/a.jpg").message).toContain("could not relink");
  });
});
