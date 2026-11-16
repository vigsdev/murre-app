import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { addTask, cleanTitle, deleteTask, placeFor, readTasks, setDone } from "./tasks";
import { listDir, makeProject, readJson, realIo } from "./test-helpers";

describe("to-dos of a Murre project", () => {
  it("use the project's own tasks.json, in the app's format", () => {
    const p = makeProject();
    const place = placeFor(realIo, p.aep);
    expect(place).toEqual({ root: p.root, inMurre: true, name: "Brand Film" });

    addTask(realIo, place, "  Block out scene 1 ");
    const [t] = addTask(realIo, place, "Export previews").slice(1);
    setDone(realIo, place, t.id, true);

    const file = readJson(p.meta("tasks.json"));
    expect(file.schemaVersion).toBe(1);
    expect(file.tasks.map((x: any) => [x.title, x.done])).toEqual([
      ["Block out scene 1", false],
      ["Export previews", true],
    ]);
    expect(file.tasks[1].completedAt).toBeGreaterThan(0);
    expect(file.tasks[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keep changes made by the app in between", () => {
    const p = makeProject();
    const place = placeFor(realIo, p.aep);
    addTask(realIo, place, "From the panel");
    // The app adds one meanwhile.
    const file = readJson(p.meta("tasks.json"));
    file.tasks.push({ id: "app-1", title: "From the app", done: false, createdAt: 1, completedAt: null });
    fs.writeFileSync(p.meta("tasks.json"), JSON.stringify(file));

    const after = addTask(realIo, place, "Another from the panel");
    expect(after.map((t) => t.title)).toEqual(["From the panel", "From the app", "Another from the panel"]);
    expect(deleteTask(realIo, place, "app-1").map((t) => t.title)).toEqual(["From the panel", "Another from the panel"]);
  });

  it("refuse a list from a newer Murre", () => {
    const p = makeProject();
    fs.writeFileSync(p.meta("tasks.json"), JSON.stringify({ schemaVersion: 9, tasks: [] }));
    expect(() => readTasks(realIo, p.root)).toThrow(/newer version/);
  });
});

describe("to-dos of a file that isn't in Murre", () => {
  it("live in a .murre folder next to the file, made on the first task", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loose-"));
    const aep = path.join(dir, "Ad_v3.aep");
    fs.writeFileSync(aep, "AEP");
    const place = placeFor(realIo, aep);
    expect(place).toEqual({ root: dir, inMurre: false, name: "Ad_v3" });
    expect(readTasks(realIo, dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, ".murre")), "nothing is made just by looking").toBe(false);

    addTask(realIo, place, "Fix the logo");
    expect(listDir(path.join(dir, ".murre"))).toEqual(["tasks.json"]);
    // Still not a Murre project: there's no project.json.
    expect(placeFor(realIo, aep).inMurre).toBe(false);
  });
});

describe("cleanTitle", () => {
  it("trims and refuses empty, long or odd text", () => {
    expect(cleanTitle("  Render v2 ")).toBe("Render v2");
    expect(() => cleanTitle("   ")).toThrow();
    expect(() => cleanTitle("x".repeat(201))).toThrow();
    expect(() => cleanTitle("a\u0007b")).toThrow();
  });
});
