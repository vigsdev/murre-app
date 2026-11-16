import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/** Every source file of the panels, without tests. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

describe("environment variables in the panels", () => {
  // The build turns a written `process.env` into `{}`, so anything read that way is always missing inside After
  // Effects. On Windows that hid APPDATA and the panel never found the app. Use `window.cep_node.process.env`.
  it("are never read through process.env", () => {
    const root = path.resolve(__dirname, "../..");
    const offenders = sources(root).filter((f) => /\bprocess\.env\b/.test(fs.readFileSync(f, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
