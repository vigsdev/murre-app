import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { findProject } from "./project-link";
import { makeProject, realIo } from "./test-helpers";

describe("findProject", () => {
  it("links an AEP to the project folder above it, by the id in project.json", () => {
    const p = makeProject({ id: "abc", name: "Brand Film" });
    const r = findProject(realIo, p.aep);
    expect(r.kind).toBe("linked");
    if (r.kind === "linked") {
      expect(r.link.projectId).toBe("abc");
      expect(r.link.projectName).toBe("Brand Film");
      expect(r.link.root).toBe(p.root);
      expect(r.link.aepPath).toBe("01 AE/film_v01.aep");
    }
  });

  it("uses the nearest project when projects are nested", () => {
    const outer = makeProject({ id: "outer" });
    const inner = path.join(outer.root, "Sub");
    fs.mkdirSync(path.join(inner, ".murre"), { recursive: true });
    fs.writeFileSync(path.join(inner, ".murre", "project.json"), JSON.stringify({ schemaVersion: 1, id: "inner", name: "Sub" }));
    const aep = path.join(inner, "x.aep");
    fs.writeFileSync(aep, "x");
    const r = findProject(realIo, aep);
    expect(r.kind === "linked" && r.link.projectId).toBe("inner");
  });

  it("reports 'none' for an AEP outside any Murre project", () => {
    const p = makeProject();
    fs.rmSync(p.meta("project.json"));
    expect(findProject(realIo, p.aep).kind).toBe("none");
  });

  it("falls back to project.json.bak when the main file is damaged", () => {
    const p = makeProject({ id: "good" });
    fs.copyFileSync(p.meta("project.json"), p.meta("project.json.bak"));
    fs.writeFileSync(p.meta("project.json"), "{broken");
    const r = findProject(realIo, p.aep);
    expect(r.kind === "linked" && r.link.projectId).toBe("good");
    expect(fs.readFileSync(p.meta("project.json"), "utf-8")).toBe("{broken"); // never repaired by the Companion
  });

  it("is an error (not 'none') when project data exists but cannot be used", () => {
    const p = makeProject();
    fs.writeFileSync(p.meta("project.json"), "{broken");
    expect(findProject(realIo, p.aep).kind).toBe("error");
    fs.writeFileSync(p.meta("project.json"), JSON.stringify({ schemaVersion: 1, name: "no id" }));
    expect(findProject(realIo, p.aep).kind).toBe("error");
  });

  it("refuses a project from a newer Murre", () => {
    const p = makeProject({ schemaVersion: 7 });
    const r = findProject(realIo, p.aep);
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.message).toMatch(/newer version/);
  });

  it("does not modify anything", () => {
    const p = makeProject();
    const before = fs.readdirSync(p.root + "/.murre");
    findProject(realIo, p.aep);
    expect(fs.readdirSync(p.root + "/.murre")).toEqual(before);
  });
});
