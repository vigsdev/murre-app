import { ASSET_FOLDERS, type AssetFolderRule } from "../../../shared/asset-folders";
import type { Io } from "./io";
import { readSnapshot } from "./snapshot-store";

/** The newest `folders.json` layout this Companion understands. */
export const FOLDERS_SCHEMA = 1;

const unsafeName = (name: string): boolean =>
  name === "" || name.length > 80 || name === "." || name === ".." || name.charAt(0) === "." || /[\\/:\u0000-\u001f]/.test(name);

/**
 * Read the folder setup out of a parsed `.murre/folders.json` (written by the desktop app when the project was made).
 * Anything unusable gives `null`, so the caller falls back to the default folders and a damaged file never stops a scan.
 */
export function parseFolderRules(raw: unknown): AssetFolderRule[] | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.schemaVersion === "number" && o.schemaVersion > FOLDERS_SCHEMA) return null;
  if (!Array.isArray(o.folders)) return null;
  const seen = new Set<string>();
  const rules: AssetFolderRule[] = [];
  for (const f of o.folders as unknown[]) {
    if (!f || typeof f !== "object") return null;
    const name = (f as { name?: unknown }).name;
    const exts = (f as { exts?: unknown }).exts;
    if (typeof name !== "string" || unsafeName(name.trim())) return null;
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    const list: string[] = [];
    if (exts !== undefined) {
      if (!Array.isArray(exts)) return null;
      for (const e of exts) if (typeof e === "string" && /^[a-z0-9]{1,10}$/.test(e.toLowerCase())) list.push(e.toLowerCase());
    }
    rules.push({ folder: name.trim(), exts: list });
  }
  return rules;
}

/** This project's folder setup, or the default one when it has none (projects made before folders were customisable). */
export function readFolderRules(io: Io, root: string): AssetFolderRule[] {
  try {
    return parseFolderRules(readSnapshot(io, root, "folders.json")) ?? ASSET_FOLDERS;
  } catch {
    return ASSET_FOLDERS;
  }
}
