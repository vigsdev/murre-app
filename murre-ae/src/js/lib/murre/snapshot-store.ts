import type { Io } from "./io";
import { SUPPORTED_SCHEMA } from "./project-link";

/**
 * The metadata files the Companion writes. The desktop app reads them, except `settings.json`: the app owns it,
 * and the Companion only changes the two settings its right-click menu shows (see settings.ts). `folders.json` is the same:
 * the app writes it when it creates the project, and the Companion only reads it (see folder-rules.ts).
 */
export type SnapshotFile = "colors.json" | "expressions.json" | "fonts.json" | "environment.json" | "comps.json" | "assets.json" | "settings.json" | "folders.json";

let tmpCounter = 0;

function target(io: Io, root: string, file: SnapshotFile): string {
  return io.path.join(root, ".murre", file);
}

/** Read a snapshot file (or its `.bak`). Returns `null` when it does not exist. Throws if it cannot be parsed. */
export function readSnapshot(io: Io, root: string, file: SnapshotFile, suffix = ""): unknown | null {
  const p = target(io, root, file) + suffix;
  let text: string;
  try {
    text = io.fs.readFileSync(p, { encoding: "utf-8" });
  } catch (e: any) {
    if (e && e.code === "ENOENT") return null;
    throw new Error(`Could not read ${file}: ${e && e.message ? e.message : e}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
}

function isValidJsonFile(io: Io, p: string): boolean {
  try {
    JSON.parse(io.fs.readFileSync(p, { encoding: "utf-8" }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace a snapshot file with a complete new snapshot, safely:
 *  - the project's `.murre` folder must already exist (it is never created here);
 *  - a file written by a newer schema version is never overwritten;
 *  - the new content is written to a temp file in the same folder, flushed to disk, and
 *    then renamed over the target, so a crash cannot leave a half-written file;
 *  - the previous content is kept as `<name>.bak` if it was valid JSON; a damaged previous
 *    file is kept as `<name>.corrupt` instead, so a good backup is never replaced by a bad one.
 */
export function writeSnapshot(io: Io, root: string, file: SnapshotFile, value: unknown): void {
  const { fs, path } = io;
  const dir = path.join(root, ".murre");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error("The project's .murre folder is missing, so nothing was written.");
  }
  const p = target(io, root, file);

  if (fs.existsSync(p) && isValidJsonFile(io, p)) {
    const existing = JSON.parse(fs.readFileSync(p, { encoding: "utf-8" }));
    if (existing && typeof existing === "object" && typeof existing.schemaVersion === "number" && existing.schemaVersion > SUPPORTED_SCHEMA) {
      throw new Error(`${file} was written by a newer version of Murre, so it was left alone.`);
    }
  }

  const text = JSON.stringify(value, null, 2) + "\n";
  JSON.parse(text); // never write something we could not read back

  const tmp = `${p}.tmp-${process.pid}-${++tmpCounter}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx");
    fs.writeSync(fd, text, undefined, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (fs.existsSync(p)) {
      // Keep the old content: as the backup if it was good, as `.corrupt` if it was damaged.
      fs.copyFileSync(p, p + (isValidJsonFile(io, p) ? ".bak" : ".corrupt"));
    }
    fs.renameSync(tmp, p);
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file may not exist */
    }
    throw e;
  }
}
