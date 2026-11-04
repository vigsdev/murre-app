import fs from "fs";
import os from "os";
import path from "path";
import type { Io } from "./io";

export const realIo: Io = { fs, path };

/** A temp Murre project: <tmp>/<name>/.murre/project.json, with an AEP inside. */
export function makeProject(opts: { id?: string; name?: string; schemaVersion?: number; aep?: string } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "companion-"));
  const root = path.join(base, opts.name ?? "Brand Film");
  fs.mkdirSync(path.join(root, ".murre"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".murre", "project.json"),
    JSON.stringify({ schemaVersion: opts.schemaVersion ?? 1, id: opts.id ?? "proj-1", name: opts.name ?? "Brand Film" }),
  );
  const aep = path.join(root, opts.aep ?? "01 AE/film_v01.aep");
  fs.mkdirSync(path.dirname(aep), { recursive: true });
  fs.writeFileSync(aep, "AEP");
  return { base, root, aep, meta: (f: string) => path.join(root, ".murre", f) };
}

export const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf-8"));
export const listDir = (p: string) => fs.readdirSync(p).sort();
