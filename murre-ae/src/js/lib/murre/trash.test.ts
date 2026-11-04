import { describe, expect, it } from "vitest";
import { trashFiles } from "./trash";

describe("trashFiles", () => {
  it("passes paths as arguments after the script, in batches", () => {
    const calls: string[][] = [];
    const paths = Array.from({ length: 30 }, (_, i) => `/a/f${i}.mov`);
    const r = trashFiles("darwin", (a) => void calls.push(a), paths);
    expect(r.trashed).toHaveLength(30);
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(-25)).toEqual(paths.slice(0, 25));
    expect(calls[0].slice(0, 2)).toEqual(["-e", "on run argv"]);
    // the script text never contains a path
    expect(calls[0].filter((x) => x.includes("f0.mov"))).toHaveLength(1);
  });
  it("retries one by one when a batch fails and reports only the real failures", () => {
    const run = (a: string[]) => {
      if (a.includes("/bad.mov") || a.length > 20) throw new Error("Finder got an error\nmore");
    };
    const r = trashFiles("darwin", run, ["/a.mov", "/bad.mov", "/c.mov"]);
    expect(r.trashed).toEqual(["/a.mov", "/c.mov"]);
    expect(r.failed).toEqual([{ path: "/bad.mov", message: "Not moved to the Trash: Finder got an error" }]);
  });
  it("does nothing outside macOS", () => {
    const calls: string[][] = [];
    const r = trashFiles("win32", (a) => void calls.push(a), ["/a"]);
    expect(calls).toHaveLength(0);
    expect(r.failed).toHaveLength(1);
  });
});
