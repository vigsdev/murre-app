/**
 * Per-project settings, in `<project>/.murre/settings.json`. The Murre app owns this file and shows
 * it in the project's Settings tab. The Companion reads it before each scan, so a change in the app applies
 * to the next scan however it is started, and its right-click menu changes the same two settings
 * (`copyRelinkOnScan`, `autoScanMinutes`), so the menu and the app always agree.
 */
import type { Io } from "./io";
import { readSnapshot, writeSnapshot } from "./snapshot-store";

/** Minutes between automatic scans offered by both the app and the panel's menu; 0 is off. */
export const AUTO_SCAN_CHOICES = [5, 10, 20] as const;

export interface ProjectSettings {
  /** Copy files from outside the project into it and relink them on every scan. */
  copyRelinkOnScan: boolean;
  /** After a verified copy, move the original to the Trash. Only with `copyRelinkOnScan`. */
  trashOriginals: boolean;
  /** Minutes between automatic scans while the project is open (0 = off). */
  autoScanMinutes: number;
}

export const DEFAULT_SETTINGS: ProjectSettings = { copyRelinkOnScan: false, trashOriginals: false, autoScanMinutes: 0 };

export function parseSettings(text: string | null): ProjectSettings {
  if (!text) return { ...DEFAULT_SETTINGS };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object") return { ...DEFAULT_SETTINGS };
    const copy = v.copyRelinkOnScan === true;
    const minutes = typeof v.autoScanMinutes === "number" && isFinite(v.autoScanMinutes) && v.autoScanMinutes > 0 ? v.autoScanMinutes : 0;
    return { copyRelinkOnScan: copy, trashOriginals: copy && v.trashOriginals === true, autoScanMinutes: minutes };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** The project's settings; anything missing or unreadable means "everything off". */
export function readProjectSettings(io: Io, root: string): ProjectSettings {
  try {
    return parseSettings(io.fs.readFileSync(io.path.join(root, ".murre", "settings.json"), { encoding: "utf-8" }));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Change one or both menu settings, keeping everything else in the file as it is (including fields this
 * version does not know). Moving originals to the Trash is switched off together with automatic copying,
 * as the app does. Throws if the file is damaged or from a newer version, leaving it alone.
 */
export function writeProjectSettings(io: Io, root: string, patch: Partial<Pick<ProjectSettings, "copyRelinkOnScan" | "autoScanMinutes">>): ProjectSettings {
  const raw = readSnapshot(io, root, "settings.json");
  const base: Record<string, unknown> = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
  const next = { ...parseSettings(JSON.stringify(base)), ...patch };
  if (!next.copyRelinkOnScan) next.trashOriginals = false;
  writeSnapshot(io, root, "settings.json", { ...base, schemaVersion: typeof base.schemaVersion === "number" ? base.schemaVersion : 1, ...next });
  return next;
}
