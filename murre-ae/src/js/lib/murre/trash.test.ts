import { describe, expect, it } from "vitest";
import { encodeCommand, recycleScript, trashFiles, trashName } from "./trash";

describe("trashFiles on macOS", () => {
  it("passes paths as arguments after the script, in batches", () => {
    const calls: string[][] = [];
    const paths = Array.from({ length: 30 }, (_, i) => `/a/f${i}.mov`);
    const r = trashFiles("darwin", (p, a) => (calls.push([p, ...a]), ""), paths);
    expect(r.trashed).toHaveLength(30);
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe("osascript");
    expect(calls[0].slice(-25)).toEqual(paths.slice(0, 25));
    expect(calls[0].slice(1, 3)).toEqual(["-e", "on run argv"]);
    // the script text never contains a path
    expect(calls[0].filter((x) => x.includes("f0.mov"))).toHaveLength(1);
  });
  it("retries one by one when a batch fails and reports only the real failures", () => {
    const run = (_p: string, a: string[]) => {
      if (a.includes("/bad.mov") || a.length > 20) throw new Error("Finder got an error\nmore");
      return "";
    };
    const r = trashFiles("darwin", run, ["/a.mov", "/bad.mov", "/c.mov"]);
    expect(r.trashed).toEqual(["/a.mov", "/c.mov"]);
    expect(r.failed).toEqual([{ path: "/bad.mov", message: "Not moved to the Trash: Finder got an error" }]);
  });
});

describe("trashFiles on Windows", () => {
  const decode = (args: string[]) => Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");

  it("runs PowerShell with the paths as base64 data, never as script text", () => {
    const calls: { program: string; args: string[] }[] = [];
    const paths = [String.raw`C:\Footage\it's "odd"; $(rm).mov`, String.raw`D:\தமிழ்\clip.mp4`];
    const r = trashFiles("win32", (program, args) => (calls.push({ program, args }), "OK\t0\r\nOK\t1\r\n"), paths);
    expect(r).toEqual({ trashed: paths, failed: [] });
    expect(calls[0].program).toBe("powershell.exe");
    expect(calls[0].args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = decode(calls[0].args);
    expect(script).toContain("SendToRecycleBin");
    expect(script).not.toContain("odd");
    expect(script).not.toContain("தமிழ்");
    // each path is in the script exactly as base64 and decodes back to itself
    for (const p of paths) expect(script).toContain(`'${Buffer.from(p, "utf8").toString("base64")}'`);
  });

  it("reports each file on its own", () => {
    const r = trashFiles("win32", () => "OK\t0\nERR\t1\tThe process cannot access the file because it is being used\nnoise\n", ["a", "b", "c"]);
    expect(r.trashed).toEqual(["a"]);
    expect(r.failed).toEqual([
      { path: "b", message: "Not moved to the Recycle Bin: The process cannot access the file because it is being used" },
      { path: "c", message: "Not moved to the Recycle Bin." },
    ]);
  });

  it("keeps every file where it is when PowerShell can't run", () => {
    const r = trashFiles("win32", () => { throw new Error("spawn powershell.exe ENOENT"); }, ["a", "b"]);
    expect(r.trashed).toEqual([]);
    expect(r.failed.map((f) => f.message)).toEqual(["Not moved to the Recycle Bin: spawn powershell.exe ENOENT", "Not moved to the Recycle Bin: spawn powershell.exe ENOENT"]);
  });

  it("splits long lists so each command line stays short", () => {
    let calls = 0;
    const paths = Array.from({ length: 23 }, (_, i) => "C:\\Users\\someone\\Documents\\Client Work\\Footage\\" + "x".repeat(150) + `${i}.mov`);
    trashFiles("win32", (_p, args) => {
      calls++;
      // Windows command lines stop at 32767 characters.
      expect(args.join(" ").length).toBeLessThan(32000);
      const n = (decode(args).match(/'[A-Za-z0-9+/=]+'/g) ?? []).length;
      return Array.from({ length: n }, (_, i) => `OK\t${i}`).join("\n");
    }, paths);
    expect(calls).toBe(3);
  });

  it("encodes the command as UTF-16 the way PowerShell expects", () => {
    expect(Buffer.from(encodeCommand("ab"), "base64")).toEqual(Buffer.from([0x61, 0, 0x62, 0]));
    expect(recycleScript([])).toContain("$list = @()");
  });
});

describe("elsewhere", () => {
  it("does nothing on other systems", () => {
    const calls: string[] = [];
    const r = trashFiles("linux", (p) => (calls.push(p), ""), ["/a"]);
    expect(calls).toHaveLength(0);
    expect(r.failed).toHaveLength(1);
  });
  it("names the place after the system", () => {
    expect(trashName("darwin")).toBe("Trash");
    expect(trashName("win32")).toBe("Recycle Bin");
  });
});
