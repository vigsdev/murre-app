import type { FootageInfo } from "../../../shared/scan-types";
import { ASSETS_DIR, assetSubfolder, type AssetFolderRule } from "../../../shared/asset-folders";
import { readFolderRules } from "./folder-rules";
import type { Io } from "./io";

export const ASSETS_SCHEMA = 1;
const MAX_ASSETS = 20_000;
const MAX_MOVED = 500;

/** The project-relative folder (with "/") a file of this name is copied into. */
export function destFolderFor(fileName: string, rules?: AssetFolderRule[]): string {
  const sub = assetSubfolder(fileName, rules);
  return sub ? ASSETS_DIR + "/" + sub : ASSETS_DIR;
}

export type AssetStatus = "inside" | "outside" | "missing" | "sequence";

export interface AssetEntry {
  /** The file's path as After Effects reports it. */
  path: string;
  /** Footage item names that use it. */
  names: string[];
  /** After Effects item ids that use it. */
  ids: number[];
  status: AssetStatus;
  /** Project-relative folder it would be copied into (outside files only). */
  destFolder: string | null;
}

export interface MovedEntry {
  from: string;
  /** Path relative to the project folder, "/" separators. */
  to: string;
  at: string;
}

export interface AssetsFile {
  schemaVersion: number;
  lastScanAt: string;
  assets: AssetEntry[];
  /** Files copied into the project by the Companion (newest last). The originals were not touched. */
  moved: MovedEntry[];
}

function realOf(io: Io, p: string): string {
  try {
    return io.fs.realpathSync(p);
  } catch {
    // A file that is not there: resolve through its folder so symlinked parents still match.
    try {
      return io.path.join(io.fs.realpathSync(io.path.dirname(p)), io.path.basename(p));
    } catch {
      return io.path.resolve(p);
    }
  }
}

/** True when `file` is somewhere inside `root` (following symlinks). */
export function isInside(io: Io, root: string, file: string): boolean {
  const rel = io.path.relative(realOf(io, root), realOf(io, file));
  if (rel === "" || rel === ".." || rel.startsWith(".." + io.path.sep) || io.path.isAbsolute(rel)) return false;
  return true;
}

/** Group footage items by file and say where each file stands relative to the project folder. */
export function classifyFootage(io: Io, root: string, footage: FootageInfo[]): AssetEntry[] {
  const byPath = new Map<string, AssetEntry>();
  const order: AssetEntry[] = [];
  const rules = readFolderRules(io, root);
  for (const f of footage) {
    if (!f.path) continue;
    const key = f.kind === "sequence" ? "seq:" + f.id : realOf(io, f.path);
    let entry = byPath.get(key);
    if (!entry) {
      let status: AssetStatus;
      if (f.kind === "sequence") status = "sequence";
      else if (f.missing) status = "missing";
      else status = isInside(io, root, f.path) ? "inside" : "outside";
      entry = {
        path: f.path,
        names: [],
        ids: [],
        status,
        destFolder: status === "outside" ? destFolderFor(io.path.basename(f.path), rules) : null,
      };
      byPath.set(key, entry);
      order.push(entry);
    }
    if (entry.names.indexOf(f.name) < 0) entry.names.push(f.name);
    entry.ids.push(f.id);
  }
  return order.slice(0, MAX_ASSETS);
}

export function buildAssetsFile(assets: AssetEntry[], moved: MovedEntry[], scannedAt: string): AssetsFile {
  return { schemaVersion: ASSETS_SCHEMA, lastScanAt: scannedAt, assets, moved: moved.slice(-MAX_MOVED) };
}

/** Read an assets.json the Companion wrote earlier; anything unusable is treated as "no history". */
export function parseAssetsFile(raw: unknown): AssetsFile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.schemaVersion === "number" && o.schemaVersion > ASSETS_SCHEMA) throw new Error("assets.json was written by a newer version of Murre.");
  if (!Array.isArray(o.assets)) return null;
  const assets = (o.assets as unknown[]).filter(
    (a): a is AssetEntry =>
      !!a && typeof a === "object" && typeof (a as AssetEntry).path === "string" && Array.isArray((a as AssetEntry).ids) && typeof (a as AssetEntry).status === "string",
  );
  const moved = Array.isArray(o.moved)
    ? (o.moved as unknown[]).filter((m): m is MovedEntry => !!m && typeof (m as MovedEntry).from === "string" && typeof (m as MovedEntry).to === "string")
    : [];
  return { schemaVersion: ASSETS_SCHEMA, lastScanAt: typeof o.lastScanAt === "string" ? o.lastScanAt : "", assets, moved };
}
