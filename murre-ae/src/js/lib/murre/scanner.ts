import type { AssetFolderRule } from "../../../shared/asset-folders";
import { readFolderRules } from "./folder-rules";
import type { AepInfo, CompScan, FontScan, FootageInfo, OrganizeResult, RelinkOutcome, ScannedComp } from "../../../shared/scan-types";
import { refreshAssets, runRelink, type AssetCounts, type RelinkSummary } from "./assets-flow";
import { buildCompsFile, mergeComps, parseCompsFile, type AepRef, type CompEntry } from "./comps-model";
import type { Io } from "./io";
import { findProject, type ProjectLink } from "./project-link";
import { buildEnvironmentFile, buildFontsFile, buildSnapshots, type ScanCounts } from "./scan-model";
import { readProjectSettings } from "./settings";
import { readSnapshot, writeSnapshot } from "./snapshot-store";
import type { TrashResult } from "./trash";

/** What the panel needs from After Effects (implemented with evalTS in the real panel). */
export interface ScanHost {
  getAepInfo(): Promise<AepInfo>;
  listComps(): Promise<ScannedComp[]>;
  /** Sort the project panel into the Murre bins. Optional so a host without it still scans. */
  organizeProject?(rules?: AssetFolderRule[]): Promise<OrganizeResult>;
  scanComp(compId: number): Promise<CompScan>;
  /** The fonts of the whole project. Optional so a host without it still scans. */
  scanFonts?(): Promise<FontScan>;
  listFootage(): Promise<FootageInfo[]>;
  relinkFootage(id: number, newPath: string): Promise<RelinkOutcome>;
}

export interface ScanProgress {
  done: number;
  total: number;
  compName: string;
}

export interface ScanSummary {
  counts: ScanCounts;
  /** Things the user should know about that did not stop the scan. */
  warnings: string[];
  /** Main Comps from the previous scan that could not be matched in this one. */
  unmatchedMain: CompEntry[];
  scannedAt: string;
  link: ProjectLink;
  /** Footage files seen in this scan; null if they could not be listed (a warning says why). */
  assets: AssetCounts | null;
  /** Set when "copy and relink on every scan" was on and something was copied. */
  relink: RelinkSummary | null;
  /** Items moved into bins at the start of the scan (0 when the project was already tidy or could not be organized). */
  organized: number;
  /** Fonts found in the project; null if they could not be read (a warning says why). */
  fonts: number | null;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

export class ScanError extends Error {}
export class ScanCancelled extends Error {
  constructor() {
    super("Scan cancelled. Nothing was written.");
  }
}

export const aepRefOf = (link: ProjectLink, info: AepInfo): AepRef => ({
  projectId: link.projectId,
  path: link.aepPath,
  name: info.name ?? "",
});

/**
 * Scan the active After Effects project and write colors.json, expressions.json and
 * comps.json into its Murre project.
 *
 * The scan is all-or-nothing: files are only written after every composition was read
 * successfully and the active project is confirmed unchanged. A cancelled or failed scan
 * leaves the existing files exactly as they were. After Effects itself is only read.
 */
export async function runScan(
  host: ScanHost,
  io: Io,
  opts: {
    onProgress?: (p: ScanProgress) => void;
    isCancelled?: () => boolean;
    now?: () => Date;
    /** Copy outside files into the project and relink them right after the scan. Default: the project's setting. */
    autoRelink?: boolean;
    /** Moves files to the Trash when the project's settings ask for it. */
    trash?: (paths: string[]) => TrashResult;
  } = {},
): Promise<ScanSummary> {
  const info = await host.getAepInfo();
  if (!info.saved || !info.path) throw new ScanError("Save the After Effects project first, so it can be linked to a Murre project.");
  const linked = findProject(io, info.path);
  if (linked.kind === "none") throw new ScanError("This project file is not inside a Murre project folder.");
  if (linked.kind === "error") throw new ScanError(linked.message);
  const link = linked.link;

  // Read what is on disk before doing any slow work, so a bad file stops us early.
  const warnings: string[] = [];
  const previous = loadPreviousComps(io, link.root, warnings);

  // Tidy the bins first, so the folders recorded for each composition are the new ones. A failure only adds a warning.
  let organized = 0;
  try {
    if (host.organizeProject) {
      const r = await host.organizeProject(readFolderRules(io, link.root));
      organized = r.moved;
      if (r.failed > 0) warnings.push(`${plural(r.failed, "item")} could not be moved into the project bins.`);
    }
  } catch (e) {
    warnings.push(`The project panel was not organized: ${e instanceof Error ? e.message : String(e)}`);
  }

  const comps = await host.listComps();
  const scans: CompScan[] = [];
  for (let i = 0; i < comps.length; i++) {
    if (opts.isCancelled?.()) throw new ScanCancelled();
    opts.onProgress?.({ done: i, total: comps.length, compName: comps[i].name });
    scans.push(await host.scanComp(comps[i].id));
  }
  if (opts.isCancelled?.()) throw new ScanCancelled();
  opts.onProgress?.({ done: comps.length, total: comps.length, compName: "" });

  // The fonts of the whole project. A failure only adds a warning and keeps the previous fonts.json.
  let fontScan: FontScan | null = null;
  try {
    if (host.scanFonts) fontScan = await host.scanFonts();
  } catch (e) {
    warnings.push(`Fonts were not read: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (fontScan && fontScan.skipped > 0) warnings.push(`${plural(fontScan.skipped, "font or layer")} could not be read for the font list.`);

  // The user may have switched projects while we were reading.
  const after = await host.getAepInfo();
  if (after.path !== info.path) throw new ScanError("The open After Effects project changed mid-scan. Murre didn’t write anything.");

  const scannedAt = (opts.now?.() ?? new Date()).toISOString();
  const aep = aepRefOf(link, info);
  const merged = mergeComps(previous, aep, comps);
  const snapshots = buildSnapshots(scans, scannedAt);

  writeSnapshot(io, link.root, "colors.json", snapshots.colors);
  writeSnapshot(io, link.root, "expressions.json", snapshots.expressions);
  writeSnapshot(io, link.root, "comps.json", buildCompsFile(aep, merged.comps, scannedAt));
  writeSnapshot(io, link.root, "environment.json", buildEnvironmentFile(scans, info.appVersion, scannedAt));
  let fontCount: number | null = null;
  if (fontScan) {
    const fontsFile = buildFontsFile(fontScan, scannedAt);
    writeSnapshot(io, link.root, "fonts.json", fontsFile);
    fontCount = fontsFile.fonts.length;
  }

  // Footage files: a failure here must not undo a good scan, so it only adds a warning.
  let assets: AssetCounts | null = null;
  let relink: RelinkSummary | null = null;
  try {
    assets = await refreshAssets(host, io, link, scannedAt);
    const autoRelink = opts.autoRelink ?? readProjectSettings(io, link.root).copyRelinkOnScan;
    if (autoRelink && assets.outside > 0 && !opts.isCancelled?.()) {
      relink = await runRelink({ ...host }, io, { now: opts.now, isCancelled: opts.isCancelled, trash: opts.trash });
      assets = relink.counts;
    }
  } catch (e) {
    warnings.push(`Footage files were not checked: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { counts: snapshots.counts, warnings, unmatchedMain: merged.unmatched, scannedAt, link, assets, relink, organized, fonts: fontCount };
}

/**
 * The comps.json already on disk, used to keep Main Comp choices. A damaged file falls back to
 * its backup; if that is unusable too, the scan continues with no previous choices and says so.
 * A file from a newer schema stops the scan (it must not be overwritten).
 */
function loadPreviousComps(io: Io, root: string, warnings: string[]) {
  for (const suffix of ["", ".bak"]) {
    try {
      const raw = readSnapshot(io, root, "comps.json", suffix);
      if (raw !== null) return parseCompsFile(raw);
      if (suffix === "") return null; // never scanned: nothing to keep
    } catch (e) {
      if (e instanceof Error && e.message.includes("newer version")) throw new ScanError(e.message);
      // unreadable: try the backup
    }
  }
  warnings.push("The previous comps.json could not be read, so Main Comp choices were reset. The old file was kept as comps.json.corrupt.");
  return null;
}
