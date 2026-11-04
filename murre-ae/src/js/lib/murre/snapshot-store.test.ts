import fs from "fs";
import { describe, expect, it } from "vitest";
import type { Io } from "./io";
import { readSnapshot, writeSnapshot } from "./snapshot-store";
import { listDir, makeProject, readJson, realIo } from "./test-helpers";

describe("writeSnapshot", () => {
  it("writes valid pretty JSON and leaves no temp files", () => {
    const p = makeProject();
    writeSnapshot(realIo, p.root, "colors.json", { schemaVersion: 1, colors: [{ hex: "#FFFFFF" }] });
    expect(readJson(p.meta("colors.json")).colors).toHaveLength(1);
    expect(fs.readFileSync(p.meta("colors.json"), "utf-8").endsWith("\n")).toBe(true);
    expect(listDir(p.root + "/.murre").filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("keeps the previous good content as .bak when replacing", () => {
    const p = makeProject();
    writeSnapshot(realIo, p.root, "colors.json", { schemaVersion: 1, n: 1 });
    writeSnapshot(realIo, p.root, "colors.json", { schemaVersion: 1, n: 2 });
    expect(readJson(p.meta("colors.json")).n).toBe(2);
    expect(readJson(p.meta("colors.json.bak")).n).toBe(1);
  });

  it("keeps a damaged previous file as .corrupt and does not touch a good .bak", () => {
    const p = makeProject();
    writeSnapshot(realIo, p.root, "colors.json", { schemaVersion: 1, n: 1 });
    writeSnapshot(realIo, p.root, "colors.json", { schemaVersion: 1, n: 2 }); // .bak = n1
    fs.writeFileSync(p.meta("colors.json"), "{broken");
    writeSnapshot(realIo, p.root, "colors.json", { schemaVersion: 1, n: 3 });
    expect(readJson(p.meta("colors.json")).n).toBe(3);
    expect(readJson(p.meta("colors.json.bak")).n).toBe(1);
    expect(fs.readFileSync(p.meta("colors.json.corrupt"), "utf-8")).toBe("{broken");
  });

  it("never overwrites a file written by a newer schema", () => {
    const p = makeProject();
    fs.writeFileSync(p.meta("comps.json"), JSON.stringify({ schemaVersion: 9, keep: true }));
    expect(() => writeSnapshot(realIo, p.root, "comps.json", { schemaVersion: 1 })).toThrow(/newer version/);
    expect(readJson(p.meta("comps.json")).keep).toBe(true);
  });

  it("does not create the .murre folder", () => {
    const p = makeProject();
    fs.rmSync(p.root + "/.murre", { recursive: true });
    expect(() => writeSnapshot(realIo, p.root, "colors.json", { schemaVersion: 1 })).toThrow(/\.murre folder is missing/);
    expect(fs.existsSync(p.root + "/.murre")).toBe(false);
  });

  it("leaves the existing file untouched and cleans up when the rename fails", () => {
    const p = makeProject();
    writeSnapshot(realIo, p.root, "colors.json", { schemaVersion: 1, n: 1 });
    const failing: Io = {
      path: realIo.path,
      fs: { ...fs, renameSync: () => { throw new Error("disk full"); } } as unknown as typeof fs,
    };
    expect(() => writeSnapshot(failing, p.root, "colors.json", { schemaVersion: 1, n: 2 })).toThrow(/disk full/);
    expect(readJson(p.meta("colors.json")).n).toBe(1);
    expect(listDir(p.root + "/.murre").filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("refuses values that cannot be serialised without touching the file", () => {
    const p = makeProject();
    writeSnapshot(realIo, p.root, "colors.json", { schemaVersion: 1, n: 1 });
    const circular: any = { schemaVersion: 1 };
    circular.self = circular;
    expect(() => writeSnapshot(realIo, p.root, "colors.json", circular)).toThrow();
    expect(readJson(p.meta("colors.json")).n).toBe(1);
  });
});

describe("readSnapshot", () => {
  it("returns null when missing and throws on invalid JSON", () => {
    const p = makeProject();
    expect(readSnapshot(realIo, p.root, "comps.json")).toBeNull();
    fs.writeFileSync(p.meta("comps.json"), "nope");
    expect(() => readSnapshot(realIo, p.root, "comps.json")).toThrow(/not valid JSON/);
  });
});
