import type { FootageInfo, RelinkOutcome } from "../../../shared/scan-types";
import { classifyFootage, type AssetEntry, type MovedEntry } from "./assets-model";
import type { Io } from "./io";

/** What the relinker needs from After Effects. */
export interface RelinkHost {
  listFootage(): Promise<FootageInfo[]>;
  relinkFootage(id: number, newPath: string): Promise<RelinkOutcome>;
}

export interface RelinkReport {
  /** Files copied into the project and relinked. */
  copied: MovedEntry[];
  /** Files that were already in the project folder (identical copy found), so only relinked. */
  reused: MovedEntry[];
  failed: { path: string; message: string }[];
  /** Footage items now pointing at the project copy. */
  relinkedItems: number;
  /** Originals moved to the Trash after their copy was checked (only when that setting is on). */
  trashed: string[];
}

export class RelinkCancelled extends Error {
  constructor() {
    super("Cancelled. Files already copied and relinked were kept.");
  }
}

const CHUNK = 1024 * 1024;

/** Same bytes? Checked by size first, then by reading both files. */
function sameContent(io: Io, a: string, b: string): boolean {
  const { fs } = io;
  if (fs.statSync(a).size !== fs.statSync(b).size) return false;
  const fa = fs.openSync(a, "r");
  const fb = fs.openSync(b, "r");
  try {
    const ba = Buffer.alloc(CHUNK);
    const bb = Buffer.alloc(CHUNK);
    for (;;) {
      const na = fs.readSync(fa, ba, 0, CHUNK, null);
      const nb = fs.readSync(fb, bb, 0, CHUNK, null);
      if (na !== nb) return false;
      if (na === 0) return true;
      if (ba.compare(bb, 0, nb, 0, na) !== 0) return false;
    }
  } finally {
    fs.closeSync(fa);
    fs.closeSync(fb);
  }
}

function numbered(io: Io, dir: string, fileName: string, n: number): string {
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  return io.path.join(dir, `${base} (${n})${ext}`);
}

/**
 * Copy one outside file into its project folder without ever overwriting anything.
 * Returns the destination and whether an identical file was already there.
 */
function copyInto(io: Io, root: string, entry: AssetEntry): { dest: string; reused: boolean } {
  const { fs, path } = io;
  const fileName = path.basename(entry.path);
  const dir = path.join(root, ...(entry.destFolder ?? "02 Assets").split("/"));
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const dest = n === 1 ? path.join(dir, fileName) : numbered(io, dir, fileName, n);
    if (fs.existsSync(dest)) {
      if (fs.statSync(dest).isFile() && sameContent(io, entry.path, dest)) return { dest, reused: true };
      continue; // a different file has this name: try the next number
    }
    try {
      fs.copyFileSync(entry.path, dest, fs.constants.COPYFILE_EXCL);
    } catch (e: any) {
      if (e && e.code === "EEXIST") continue; // lost a race: look again
      throw e;
    }
    if (fs.statSync(dest).size !== fs.statSync(entry.path).size) {
      try {
        fs.unlinkSync(dest); // our own incomplete copy
      } catch {
        // leave it; it is reported as a failure below
      }
      throw new Error("The copy has a different size than the original, so it was not used.");
    }
    return { dest, reused: false };
  }
  throw new Error("Could not find a free file name in the project folder.");
}

/**
 * For every file used by the project that lives outside the project folder: copy it into
 * `02 Assets/<type folder>`, check the copy, and point the After Effects items at the copy.
 * The originals are never changed or deleted, and nothing in the project folder is overwritten.
 * Files that fail are skipped and reported; the others carry on.
 */
export async function copyAndRelink(
  host: RelinkHost,
  io: Io,
  root: string,
  opts: { isCancelled?: () => boolean; onProgress?: (done: number, total: number, name: string) => void; now?: () => Date } = {},
): Promise<RelinkReport> {
  const footage = await host.listFootage();
  const outside = classifyFootage(io, root, footage).filter((a) => a.status === "outside");
  const report: RelinkReport = { copied: [], reused: [], failed: [], relinkedItems: 0, trashed: [] };
  for (let i = 0; i < outside.length; i++) {
    if (opts.isCancelled?.()) throw Object.assign(new RelinkCancelled(), { report });
    const entry = outside[i];
    opts.onProgress?.(i, outside.length, io.path.basename(entry.path));
    let copy: { dest: string; reused: boolean };
    try {
      if (!io.fs.statSync(entry.path).isFile()) throw new Error("It is not a file.");
      copy = copyInto(io, root, entry);
    } catch (e: any) {
      report.failed.push({ path: entry.path, message: `Not copied: ${e && e.message ? e.message : e}` });
      continue;
    }
    let allOk = true;
    for (const id of entry.ids) {
      const r = await host.relinkFootage(id, copy.dest);
      if (r.ok) report.relinkedItems++;
      else {
        allOk = false;
        report.failed.push({ path: entry.path, message: `Copied, but not relinked: ${r.message}` });
        break;
      }
    }
    if (allOk) {
      const rel = io.path.relative(root, copy.dest).split(io.path.sep).join("/");
      (copy.reused ? report.reused : report.copied).push({ from: entry.path, to: rel, at: (opts.now?.() ?? new Date()).toISOString() });
    }
  }
  opts.onProgress?.(outside.length, outside.length, "");
  return report;
}

/**
 * Move the originals of files that were copied (or already had an identical copy) and relinked to the Trash.
 * Each one is checked first: the original is a real file outside the project, and its copy in the project
 * has the same size. Anything that does not pass is left where it is. Failures are added to the report.
 */
export function trashOriginals(io: Io, root: string, report: RelinkReport, trash: (paths: string[]) => { trashed: string[]; failed: { path: string; message: string }[] }): void {
  const { fs, path } = io;
  const rootReal = (() => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  })();
  const safe: string[] = [];
  for (const m of report.copied.concat(report.reused)) {
    try {
      const original = fs.realpathSync(m.from);
      const copy = path.join(root, ...m.to.split("/"));
      if (original.startsWith(rootReal + path.sep)) continue; // already inside the project: never touch it
      if (!fs.statSync(original).isFile() || !fs.statSync(copy).isFile()) continue;
      if (fs.statSync(original).size !== fs.statSync(copy).size) continue;
      safe.push(m.from);
    } catch {
      // gone already, or unreadable: nothing to move
    }
  }
  if (safe.length === 0) return;
  const r = trash(safe);
  report.trashed.push(...r.trashed);
  for (const f of r.failed) report.failed.push({ path: f.path, message: f.message });
}
