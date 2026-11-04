import { describe, expect, it } from "vitest";
import fs from "fs";
import { parseSettings, readProjectSettings, writeProjectSettings } from "./settings";
import { makeProject, readJson, realIo } from "./test-helpers";
import type { Io } from "./io";

const io = (files: Record<string, string>): Io =>
  ({
    fs: {
      readFileSync: (f: string) => {
        if (!(f in files)) throw new Error("ENOENT");
        return files[f];
      },
    },
    path: { join: (...p: string[]) => p.join("/") },
  }) as unknown as Io;

describe("project settings", () => {
  it("everything is off for anything missing or odd", () => {
    expect(parseSettings(null)).toEqual({ copyRelinkOnScan: false, trashOriginals: false, autoScanMinutes: 0 });
    expect(parseSettings("nope")).toEqual({ copyRelinkOnScan: false, trashOriginals: false, autoScanMinutes: 0 });
    expect(parseSettings('{"copyRelinkOnScan":"yes","trashOriginals":true}')).toEqual({ copyRelinkOnScan: false, trashOriginals: false, autoScanMinutes: 0 });
  });
  it("moving originals only counts together with copy and relink", () => {
    expect(parseSettings('{"trashOriginals":true}').trashOriginals).toBe(false);
    expect(parseSettings('{"copyRelinkOnScan":true,"trashOriginals":true}')).toEqual({ copyRelinkOnScan: true, trashOriginals: true, autoScanMinutes: 0 });
  });
  it("reads the file in the project's .murre folder", () => {
    const files = { "/p/.murre/settings.json": '{"copyRelinkOnScan":true,"autoScanMinutes":10}' };
    expect(readProjectSettings(io(files), "/p")).toEqual({ copyRelinkOnScan: true, trashOriginals: false, autoScanMinutes: 10 });
    expect(readProjectSettings(io({}), "/p")).toEqual({ copyRelinkOnScan: false, trashOriginals: false, autoScanMinutes: 0 });
  });
});

describe("writeProjectSettings", () => {
  it("changes only the asked settings and keeps every other field, including unknown ones", () => {
    const p = makeProject();
    fs.writeFileSync(p.meta("settings.json"), JSON.stringify({ schemaVersion: 1, copyRelinkOnScan: true, trashOriginals: true, autoScanMinutes: 5, future: { a: 1 } }));
    expect(writeProjectSettings(realIo, p.root, { autoScanMinutes: 20 })).toEqual({ copyRelinkOnScan: true, trashOriginals: true, autoScanMinutes: 20 });
    expect(readJson(p.meta("settings.json"))).toEqual({ schemaVersion: 1, copyRelinkOnScan: true, trashOriginals: true, autoScanMinutes: 20, future: { a: 1 } });
  });

  it("creates the file when there is none, and turns the Trash option off with automatic copying", () => {
    const p = makeProject();
    expect(writeProjectSettings(realIo, p.root, { copyRelinkOnScan: false, autoScanMinutes: 10 })).toEqual({ copyRelinkOnScan: false, trashOriginals: false, autoScanMinutes: 10 });
    expect(readJson(p.meta("settings.json"))).toMatchObject({ schemaVersion: 1, copyRelinkOnScan: false, autoScanMinutes: 10 });
    fs.writeFileSync(p.meta("settings.json"), JSON.stringify({ copyRelinkOnScan: true, trashOriginals: true }));
    expect(writeProjectSettings(realIo, p.root, { copyRelinkOnScan: false }).trashOriginals).toBe(false);
  });

  it("refuses a damaged or newer file and leaves it as it was", () => {
    const p = makeProject();
    fs.writeFileSync(p.meta("settings.json"), "not json");
    expect(() => writeProjectSettings(realIo, p.root, { autoScanMinutes: 5 })).toThrow();
    expect(fs.readFileSync(p.meta("settings.json"), "utf-8")).toBe("not json");
    fs.writeFileSync(p.meta("settings.json"), JSON.stringify({ schemaVersion: 99 }));
    expect(() => writeProjectSettings(realIo, p.root, { autoScanMinutes: 5 })).toThrow();
  });
});
