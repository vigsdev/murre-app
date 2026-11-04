import type { Io } from "./io";

/** Newest `schemaVersion` of Murre's metadata files that this Companion understands. */
export const SUPPORTED_SCHEMA = 1;

export interface ProjectLink {
  /** Absolute path of the Murre project folder (the one holding `.murre/`). */
  root: string;
  projectId: string;
  projectName: string;
  /** The AEP's path relative to `root`, always with "/" separators. */
  aepPath: string;
}

export type LinkResult =
  | { kind: "linked"; link: ProjectLink }
  | { kind: "none" }
  | { kind: "error"; message: string };

const MAX_LEVELS = 30;
const MAX_JSON_BYTES = 1_000_000;

function readJson(io: Io, file: string): { ok: true; value: unknown } | { ok: false; reason: string } | null {
  let text: string;
  try {
    const stat = io.fs.statSync(file);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_JSON_BYTES) return { ok: false, reason: "is unexpectedly large" };
    text = io.fs.readFileSync(file, { encoding: "utf-8" });
  } catch (e: any) {
    if (e && e.code === "ENOENT") return null;
    return { ok: false, reason: "could not be read" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "is not valid JSON" };
  }
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/**
 * Find the Murre project that contains the given .aep file by walking up from its folder
 * to the nearest `.murre/project.json`. Read-only. The nearest project wins, and the
 * project's identity is the `id` stored in that file, never the folder name.
 */
export function findProject(io: Io, aepFile: string): LinkResult {
  const { path } = io;
  let dir = path.dirname(aepFile);
  for (let level = 0; level < MAX_LEVELS; level++) {
    const meta = path.join(dir, ".murre", "project.json");
    let found = readJson(io, meta);
    if (found && !found.ok) {
      // Same recovery order as the desktop app: fall back to the backup copy.
      const backup = readJson(io, meta + ".bak");
      if (backup && backup.ok) found = backup;
    }
    if (found) {
      if (!found.ok) {
        return { kind: "error", message: `The project data in ${dir} ${found.reason}. Open the project in Murre to repair it.` };
      }
      const v = found.value as Record<string, unknown> | null;
      if (!v || typeof v !== "object" || typeof v.id !== "string" || typeof v.name !== "string" || !v.id) {
        return { kind: "error", message: `The project data in ${dir} is not a Murre project file.` };
      }
      if (typeof v.schemaVersion === "number" && v.schemaVersion > SUPPORTED_SCHEMA) {
        return { kind: "error", message: "This project was created by a newer version of Murre. Update the Companion." };
      }
      return {
        kind: "linked",
        link: {
          root: dir,
          projectId: v.id,
          projectName: v.name,
          aepPath: toPosix(path.relative(dir, aepFile)),
        },
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { kind: "none" };
}
