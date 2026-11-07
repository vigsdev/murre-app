import { describe, expect, it } from "vitest";
import { freeFileName, nextRenderKind, RENDER_FOLDERS } from "./render-folders";

describe("render folders", () => {
  it("cycles P, R, D", () => {
    expect(nextRenderKind("pre")).toBe("render");
    expect(nextRenderKind("render")).toBe("deliverable");
    expect(nextRenderKind("deliverable")).toBe("pre");
    expect(RENDER_FOLDERS.render).toBe("06 Renders");
  });

  it("keeps a free name and numbers a taken one", () => {
    const taken = new Set(["Main.mov", "Main 2.mov"]);
    expect(freeFileName("Intro.mov", (n) => taken.has(n))).toBe("Intro.mov");
    expect(freeFileName("Main.mov", (n) => taken.has(n))).toBe("Main 3.mov");
    expect(freeFileName("Main", (n) => n === "Main")).toBe("Main 2");
  });

  it("leaves image sequence names alone", () => {
    expect(freeFileName("Main_[#####].png", () => true)).toBe("Main_[#####].png");
  });
});
