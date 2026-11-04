import type { AepInfo } from "../../../shared/scan-types";
import { buildAssetsFile, classifyFootage, parseAssetsFile, type AssetEntry, type MovedEntry } from "./assets-model";
import type { Io } from "./io";
import { findProject, type ProjectLink } from "./project-link";
import { copyAndRelink, RelinkCancelled, trashOriginals, type RelinkHost, type RelinkReport } from "./relinker";
import { readProjectSettings } from "./settings";
import type { TrashResult } from "./trash";
import { readSnapshot, writeSnapshot } from "./snapshot-store";

export interface AssetCounts {
  /** Files used by the project that sit outside the project folder. */
  outside: number;
  missing: number;
  sequences: number;
}

export const countAssets = (assets: AssetEntry[]): AssetCounts => ({
  outside: assets.filter((a) => a.status === "outside").length,
  missing: assets.filter((a) => a.status === "missing").length,
  sequences: assets.filter((a) => a.status === "sequence").length,
});

function previousMoved(io: Io, root: string): MovedEntry[] {
  try {
    return parseAssetsFile(readSnapshot(io, root, "assets.json"))?.moved ?? [];
  } catch {
    return [];
  }
}

/** Look at the project's footage files and write assets.json (read-only in After Effects). */
export async function refreshAssets(host: RelinkHost, io: Io, link: ProjectLink, scannedAt: string, newlyMoved: MovedEntry[] = []): Promise<AssetCounts> {
  const footage = await host.listFootage();
  const assets = classifyFootage(io, link.root, footage);
  writeSnapshot(io, link.root, "assets.json", buildAssetsFile(assets, previousMoved(io, link.root).concat(newlyMoved), scannedAt));
  return countAssets(assets);
}

export interface RelinkSummary {
  report: RelinkReport;
  counts: AssetCounts;
  link: ProjectLink;
  /** Always true after a relink: After Effects now has unsaved changes. */
  needsSave: boolean;
}

/** The manual "Copy & relink" action (also used after a scan when automatic mode is on). */
export async function runRelink(
  host: RelinkHost & { getAepInfo(): Promise<AepInfo> },
  io: Io,
  opts: {
    onProgress?: (done: number, total: number, name: string) => void;
    isCancelled?: () => boolean;
    now?: () => Date;
    /** Moves files to the Trash. Used only when the project's settings turn "move originals" on. */
    trash?: (paths: string[]) => TrashResult;
  } = {},
): Promise<RelinkSummary> {
  const info = await host.getAepInfo();
  if (!info.saved || !info.path) throw new Error("Save the After Effects project first, so it can be linked to a Murre project.");
  const linked = findProject(io, info.path);
  if (linked.kind === "none") throw new Error("This project file is not inside a Murre project folder.");
  if (linked.kind === "error") throw new Error(linked.message);
  const link = linked.link;

  let report: RelinkReport;
  try {
    report = await copyAndRelink(host, io, link.root, opts);
  } catch (e) {
    // Keep a record of what was done before the stop.
    const partial = e instanceof RelinkCancelled ? (e as RelinkCancelled & { report?: RelinkReport }).report : undefined;
    if (partial) await refreshAssets(host, io, link, (opts.now?.() ?? new Date()).toISOString(), partial.copied.concat(partial.reused));
    throw e;
  }
  const after = await host.getAepInfo();
  // Only after every item was relinked: the originals go to the Trash (never deleted), if the project says so.
  if (opts.trash && after.path === info.path && readProjectSettings(io, link.root).trashOriginals) {
    trashOriginals(io, link.root, report, opts.trash);
  }
  const counts = await refreshAssets(host, io, link, (opts.now?.() ?? new Date()).toISOString(), report.copied.concat(report.reused));
  if (after.path !== info.path) report.failed.push({ path: "", message: "The active After Effects project changed while relinking; check both projects." });
  return { report, counts, link, needsSave: report.relinkedItems > 0 };
}
