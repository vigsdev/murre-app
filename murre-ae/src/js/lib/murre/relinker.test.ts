import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import type { AepInfo, FootageInfo } from "../../../shared/scan-types";
import { destFolderFor, parseAssetsFile } from "./assets-model";
import { runRelink } from "./assets-flow";
import { copyAndRelink, RelinkCancelled, type RelinkHost } from "./relinker";
import { runScan, type ScanHost } from "./scanner";
import { readSnapshot } from "./snapshot-store";
import { listDir, makeProject, realIo } from "./test-helpers";

/** A fake After Effects project whose footage items point at real files. */
function fakeAe(aep: string, items: { id: number; name: string; path: string; kind?: "file" | "sequence"; failRelink?: string }[]) {
  const state = items.map((i) => ({ ...i }));
  const relinked: [number, string][] = [];
  const host: RelinkHost & ScanHost = {
    getAepInfo: async (): Promise<AepInfo> => ({ saved: true, name: "film_v01.aep", path: aep, appVersion: "25", numItems: state.length }),
    listComps: async () => [],
    scanComp: async () => { throw new Error("none"); },
    listFootage: async (): Promise<FootageInfo[]> =>
      state.map((i) => ({ id: i.id, name: i.name, path: i.path, kind: i.kind ?? "file", missing: !fs.existsSync(i.path) })),
    relinkFootage: async (id, newPath) => {
      const it = state.find((i) => i.id === id)!;
      if (it.failRelink) return { ok: false, message: it.failRelink };
      it.path = newPath;
      relinked.push([id, newPath]);
      return { ok: true, message: "" };
    },
  };
  return { host, state, relinked };
}

const outsideDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "downloads-"));
const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const NOW = () => new Date("2026-10-26T12:00:00Z");

describe("destination folder by file type", () => {
  it("maps types to the project's asset folders", () => {
    expect(destFolderFor("a.JPG")).toBe("02 Assets/01 Images");
    expect(destFolderFor("a.wav")).toBe("02 Assets/02 Audios");
    expect(destFolderFor("a.psd")).toBe("02 Assets/03 PSD Files");
    expect(destFolderFor("a.ai")).toBe("02 Assets/04 Illustrator Files");
    expect(destFolderFor("clip.mov")).toBe("02 Assets/07 Videos");
    expect(destFolderFor("TR.MP4")).toBe("02 Assets/07 Videos");
    expect(destFolderFor("notes.txt")).toBe("02 Assets");
    expect(destFolderFor("noext")).toBe("02 Assets");
  });
});

describe("copyAndRelink", () => {
  it("copies an outside jpg into 02 Assets/01 Images, relinks it and leaves the original alone", async () => {
    const p = makeProject();
    const src = write(path.join(outsideDir(), "photo.jpg"), "JPGDATA");
    const { host, state, relinked } = fakeAe(p.aep, [{ id: 7, name: "photo.jpg", path: src }]);
    const r = await copyAndRelink(host, realIo, p.root, { now: NOW });
    const dest = path.join(p.root, "02 Assets", "01 Images", "photo.jpg");
    expect(fs.readFileSync(dest, "utf-8")).toBe("JPGDATA");
    expect(fs.existsSync(src)).toBe(true); // never deleted
    expect(relinked).toEqual([[7, dest]]);
    expect(state[0].path).toBe(dest);
    expect(r.copied).toEqual([{ from: src, to: "02 Assets/01 Images/photo.jpg", at: "2026-10-26T12:00:00.000Z" }]);
    expect(r.failed).toEqual([]);
  });

  it("leaves files already inside the project alone", async () => {
    const p = makeProject();
    const inside = write(path.join(p.root, "02 Assets", "01 Images", "in.png"), "x");
    const { host, relinked } = fakeAe(p.aep, [{ id: 1, name: "in.png", path: inside }]);
    const r = await copyAndRelink(host, realIo, p.root);
    expect(relinked).toEqual([]);
    expect(r.copied).toEqual([]);
  });

  it("copies a file used by several items once and relinks all of them", async () => {
    const p = makeProject();
    const src = write(path.join(outsideDir(), "a.png"), "A");
    const { host, relinked } = fakeAe(p.aep, [{ id: 1, name: "a.png", path: src }, { id: 2, name: "a copy", path: src }]);
    const r = await copyAndRelink(host, realIo, p.root);
    expect(r.copied).toHaveLength(1);
    expect(r.relinkedItems).toBe(2);
    expect(relinked.map((x) => x[0])).toEqual([1, 2]);
    expect(listDir(path.join(p.root, "02 Assets", "01 Images"))).toEqual(["a.png"]);
  });

  it("never overwrites: a different file with the same name gets a numbered name", async () => {
    const p = makeProject();
    write(path.join(p.root, "02 Assets", "01 Images", "photo.jpg"), "EXISTING");
    const src = write(path.join(outsideDir(), "photo.jpg"), "NEW");
    const { host } = fakeAe(p.aep, [{ id: 1, name: "photo.jpg", path: src }]);
    const r = await copyAndRelink(host, realIo, p.root);
    expect(fs.readFileSync(path.join(p.root, "02 Assets/01 Images/photo.jpg"), "utf-8")).toBe("EXISTING");
    expect(fs.readFileSync(path.join(p.root, "02 Assets/01 Images/photo (2).jpg"), "utf-8")).toBe("NEW");
    expect(r.copied[0].to).toBe("02 Assets/01 Images/photo (2).jpg");
  });

  it("reuses an identical file that is already in the project instead of copying again", async () => {
    const p = makeProject();
    write(path.join(p.root, "02 Assets", "01 Images", "same.jpg"), "SAME");
    const src = write(path.join(outsideDir(), "same.jpg"), "SAME");
    const { host, relinked } = fakeAe(p.aep, [{ id: 1, name: "same.jpg", path: src }]);
    const r = await copyAndRelink(host, realIo, p.root);
    expect(r.reused).toHaveLength(1);
    expect(r.copied).toHaveLength(0);
    expect(relinked[0][1]).toBe(path.join(p.root, "02 Assets/01 Images/same.jpg"));
    expect(listDir(path.join(p.root, "02 Assets", "01 Images"))).toEqual(["same.jpg"]);
  });

  it("skips missing files and image sequences", async () => {
    const p = makeProject();
    const { host, relinked } = fakeAe(p.aep, [
      { id: 1, name: "gone.png", path: path.join(outsideDir(), "gone.png") },
      { id: 2, name: "seq_[0001-0010].png", path: write(path.join(outsideDir(), "seq_0001.png"), "x"), kind: "sequence" },
    ]);
    const r = await copyAndRelink(host, realIo, p.root);
    expect(relinked).toEqual([]);
    expect(r.copied).toEqual([]);
    expect(fs.existsSync(path.join(p.root, "02 Assets"))).toBe(false); // nothing was created
  });

  it("reports a relink failure but keeps going with the other files and keeps the copy", async () => {
    const p = makeProject();
    const a = write(path.join(outsideDir(), "a.png"), "A");
    const b = write(path.join(outsideDir(), "b.png"), "B");
    const { host } = fakeAe(p.aep, [{ id: 1, name: "a", path: a, failRelink: "locked" }, { id: 2, name: "b", path: b }]);
    const r = await copyAndRelink(host, realIo, p.root);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].message).toContain("Copied, but not relinked: locked");
    expect(r.copied.map((c) => c.to)).toEqual(["02 Assets/01 Images/b.png"]);
    expect(fs.existsSync(path.join(p.root, "02 Assets/01 Images/a.png"))).toBe(true);
  });

  it("stops when cancelled and keeps what was done", async () => {
    const p = makeProject();
    const a = write(path.join(outsideDir(), "a.png"), "A");
    const b = write(path.join(outsideDir(), "b.png"), "B");
    const { host } = fakeAe(p.aep, [{ id: 1, name: "a", path: a }, { id: 2, name: "b", path: b }]);
    let n = 0;
    await expect(copyAndRelink(host, realIo, p.root, { isCancelled: () => ++n > 1 })).rejects.toBeInstanceOf(RelinkCancelled);
    expect(listDir(path.join(p.root, "02 Assets/01 Images"))).toEqual(["a.png"]);
  });

  it("does not follow a symlink out of the project: such a file still counts as outside", async () => {
    const p = makeProject();
    const real = write(path.join(outsideDir(), "linked.png"), "L");
    fs.mkdirSync(path.join(p.root, "02 Assets"), { recursive: true });
    fs.symlinkSync(real, path.join(p.root, "02 Assets", "linked.png"));
    const { host } = fakeAe(p.aep, [{ id: 1, name: "linked.png", path: path.join(p.root, "02 Assets", "linked.png") }]);
    const r = await copyAndRelink(host, realIo, p.root);
    expect(r.copied).toHaveLength(1); // a real copy now replaces the symlink target in the item
  });
});

describe("runRelink and assets.json", () => {
  it("writes assets.json with what was copied, and keeps the history across runs", async () => {
    const p = makeProject();
    const a = write(path.join(outsideDir(), "a.png"), "A");
    const { host } = fakeAe(p.aep, [{ id: 1, name: "a.png", path: a }]);
    const s = await runRelink(host, realIo, { now: NOW });
    expect(s.needsSave).toBe(true);
    expect(s.counts.outside).toBe(0);
    const file = parseAssetsFile(readSnapshot(realIo, p.root, "assets.json"))!;
    expect(file.assets[0].status).toBe("inside");
    expect(file.moved).toHaveLength(1);
    expect(file.moved[0].from).toBe(a);
    const s2 = await runRelink(host, realIo, { now: NOW }); // nothing left to do
    expect(s2.needsSave).toBe(false);
    expect(parseAssetsFile(readSnapshot(realIo, p.root, "assets.json"))!.moved).toHaveLength(1);
  });

  it("refuses when the project is not in a Murre folder", async () => {
    const d = outsideDir();
    const aep = write(path.join(d, "x.aep"), "x");
    const { host } = fakeAe(aep, []);
    await expect(runRelink(host, realIo)).rejects.toThrow(/not inside a Murre project/);
  });
});

describe("scan with footage", () => {
  it("only lists outside files when automatic mode is off, and does not touch After Effects", async () => {
    const p = makeProject();
    const a = write(path.join(outsideDir(), "a.png"), "A");
    const { host, relinked } = fakeAe(p.aep, [{ id: 1, name: "a.png", path: a }]);
    const r = await runScan(host, realIo, { now: NOW });
    expect(r.assets).toEqual({ outside: 1, missing: 0, sequences: 0 });
    expect(r.relink).toBeNull();
    expect(relinked).toEqual([]);
    expect(listDir(path.join(p.root, ".murre"))).toContain("assets.json");
  });

  it("copies and relinks right after the scan when automatic mode is on", async () => {
    const p = makeProject();
    const a = write(path.join(outsideDir(), "a.png"), "A");
    const { host, relinked } = fakeAe(p.aep, [{ id: 1, name: "a.png", path: a }]);
    const r = await runScan(host, realIo, { now: NOW, autoRelink: true });
    expect(relinked).toHaveLength(1);
    expect(r.relink?.report.copied).toHaveLength(1);
    expect(r.assets).toEqual({ outside: 0, missing: 0, sequences: 0 });
  });

  it("a footage failure does not fail the scan", async () => {
    const p = makeProject();
    const { host } = fakeAe(p.aep, []);
    host.listFootage = async () => { throw new Error("AE busy"); };
    const r = await runScan(host, realIo);
    expect(r.assets).toBeNull();
    expect(r.warnings.join(" ")).toContain("Footage files were not checked: AE busy");
  });
});
