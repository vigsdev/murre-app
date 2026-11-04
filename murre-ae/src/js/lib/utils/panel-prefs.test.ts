import { describe, expect, it } from "vitest";
import { menuChoice, type MenuState } from "./panel-prefs";

const on = (over: Partial<MenuState> = {}): MenuState => ({ enabled: true, manualRelink: true, autoScan: 0, ...over });

describe("menu choices", () => {
  it("changes nothing when no project is linked", () => {
    expect(menuChoice({ enabled: false, manualRelink: false, autoScan: 0 }, "auto-5")).toBeNull();
    expect(menuChoice({ enabled: false, manualRelink: false, autoScan: 0 }, "manual-relink")).toBeNull();
  });

  it("'Relink assets manually' is the opposite of copying and relinking on every scan", () => {
    expect(menuChoice(on({ manualRelink: true }), "manual-relink")).toEqual({ copyRelinkOnScan: true });
    expect(menuChoice(on({ manualRelink: false }), "manual-relink")).toEqual({ copyRelinkOnScan: false });
  });

  it("sets one scan interval, replacing whichever was on; choosing the active one turns it off", () => {
    expect(menuChoice(on({ autoScan: 5 }), "auto-20")).toEqual({ autoScanMinutes: 20 });
    expect(menuChoice(on({ autoScan: 20 }), "auto-20")).toEqual({ autoScanMinutes: 0 });
    expect(menuChoice(on(), "auto-10")).toEqual({ autoScanMinutes: 10 });
  });

  it("ignores items that are not settings", () => {
    expect(menuChoice(on(), "c-0")).toBeNull();
    expect(menuChoice(on(), "auto-7")).toBeNull();
  });
});
