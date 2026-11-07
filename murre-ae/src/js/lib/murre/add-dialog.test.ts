import { describe, expect, it } from "vitest";
import { parseAddChoice, parseInit, shortPath } from "./add-dialog";

describe("add dialog messages", () => {
  it("accepts a name and a folder", () => {
    expect(parseAddChoice(JSON.stringify({ name: "  Film  ", dir: "/Projects" }))).toEqual({ name: "Film", dir: "/Projects" });
  });

  it("refuses a missing name or folder, or junk", () => {
    expect(parseAddChoice(JSON.stringify({ name: " ", dir: "/p" }))).toBeNull();
    expect(parseAddChoice(JSON.stringify({ name: "Film" }))).toBeNull();
    expect(parseAddChoice(JSON.stringify({ name: "x".repeat(101), dir: "/p" }))).toBeNull();
    expect(parseAddChoice("not json")).toBeNull();
  });

  it("reads the suggested name", () => {
    expect(parseInit(JSON.stringify({ name: "Intro" }))).toBe("Intro");
    expect(parseInit("{")).toBe("");
  });

  it("shortens long paths in the middle", () => {
    expect(shortPath("/short")).toBe("/short");
    const p = "/Volumes/Work Drive/Clients/Big Client/2026/Campaign/Projects";
    const s = shortPath(p, 30);
    expect(s.length).toBe(30);
    expect(s.startsWith("/Volumes")).toBe(true);
    expect(s.endsWith("Projects")).toBe(true);
  });
});
