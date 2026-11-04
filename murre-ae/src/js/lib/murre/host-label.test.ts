import { describe, expect, it } from "vitest";
import { hostLabelOf } from "./host-label";

describe("hostLabelOf", () => {
  it("names the year from the version", () => {
    expect(hostLabelOf("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app", "26.0.1")).toBe("After Effects 2026");
    expect(hostLabelOf("/x", "25.2")).toBe("After Effects 2025");
  });
  it("says Beta when the application is the beta", () => {
    expect(hostLabelOf("/Applications/Adobe After Effects (Beta)/Adobe After Effects (Beta).app", "26.6.0")).toBe("After Effects 2026 Beta");
  });
  it("falls back to a plain name", () => {
    expect(hostLabelOf(null, undefined)).toBe("After Effects");
    expect(hostLabelOf("", "abc")).toBe("After Effects");
  });
});
