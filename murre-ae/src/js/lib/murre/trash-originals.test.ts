import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { trashOriginals, type RelinkReport } from "./relinker";
import type { Io } from "./io";

const io = { fs, path } as unknown as Io;
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sx-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const report = (copied: RelinkReport["copied"]): RelinkReport => ({ copied, reused: [], failed: [], relinkedItems: copied.length, trashed: [] });
const entry = (from: string, to: string) => ({ from, to, at: "2026-01-01T00:00:00Z" });

describe("trashOriginals", () => {
  it("moves only originals whose copy is in the project with the same size", () => {
    const root = tmp();
    const out = tmp();
    fs.mkdirSync(path.join(root, "02 Assets"));
    const good = path.join(out, "good.mov");
    const short = path.join(out, "short.mov");
    const gone = path.join(out, "gone.mov");
    fs.writeFileSync(good, "12345");
    fs.writeFileSync(path.join(root, "02 Assets", "good.mov"), "12345");
    fs.writeFileSync(short, "12345");
    fs.writeFileSync(path.join(root, "02 Assets", "short.mov"), "123"); // copy is not the same size
    const r = report([entry(good, "02 Assets/good.mov"), entry(short, "02 Assets/short.mov"), entry(gone, "02 Assets/gone.mov")]);
    const asked: string[][] = [];
    trashOriginals(io, root, r, (p) => (asked.push(p), { trashed: p, failed: [] }));
    expect(asked).toEqual([[good]]);
    expect(r.trashed).toEqual([good]);
  });

  it("never touches a file that is inside the project", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "02 Assets"));
    const inside = path.join(root, "02 Assets", "a.mov");
    fs.writeFileSync(inside, "x");
    const r = report([entry(inside, "02 Assets/a.mov")]);
    let called = false;
    trashOriginals(io, root, r, () => ((called = true), { trashed: [], failed: [] }));
    expect(called).toBe(false);
  });

  it("reports files that could not be moved", () => {
    const root = tmp();
    const out = tmp();
    fs.mkdirSync(path.join(root, "02 Assets"));
    const f = path.join(out, "a.mov");
    fs.writeFileSync(f, "x");
    fs.writeFileSync(path.join(root, "02 Assets", "a.mov"), "x");
    const r = report([entry(f, "02 Assets/a.mov")]);
    trashOriginals(io, root, r, (p) => ({ trashed: [], failed: [{ path: p[0], message: "Not moved to the Trash: no" }] }));
    expect(r.trashed).toEqual([]);
    expect(r.failed).toEqual([{ path: f, message: "Not moved to the Trash: no" }]);
  });
});
