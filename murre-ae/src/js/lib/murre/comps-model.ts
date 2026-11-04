import type { CompInfo, ScannedComp } from "../../../shared/scan-types";

export const COMPS_SCHEMA = 1;

export interface AepRef {
  projectId: string;
  /** Path of the .aep relative to the project folder, "/" separators. */
  path: string;
  name: string;
}

export interface CompEntry extends CompInfo {
  /** The user picked this as a Main Comp (one to render from the desktop app). */
  main: boolean;
}

export interface CompsFile {
  schemaVersion: number;
  aep: AepRef | null;
  /** ISO time of the last successful scan. */
  lastScanAt: string | null;
  comps: CompEntry[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && isFinite(v);

/**
 * Parse an existing comps.json leniently (so a hand edit or older file never blocks a scan).
 * Returns `null` for a missing/unusable file. Throws for a file from a newer schema.
 */
export function parseCompsFile(raw: unknown): CompsFile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;
  if (isNum(o.schemaVersion) && o.schemaVersion > COMPS_SCHEMA) {
    throw new Error("comps.json was written by a newer version of Murre, so it was left alone.");
  }
  const comps: CompEntry[] = [];
  if (Array.isArray(o.comps)) {
    for (const c of o.comps) {
      if (!c || typeof c !== "object" || !isNum(c.id) || typeof c.name !== "string") continue;
      comps.push({
        id: c.id,
        name: c.name,
        width: isNum(c.width) ? c.width : 0,
        height: isNum(c.height) ? c.height : 0,
        pixelAspect: isNum(c.pixelAspect) ? c.pixelAspect : 1,
        frameRate: isNum(c.frameRate) ? c.frameRate : 0,
        duration: isNum(c.duration) ? c.duration : 0,
        folder: typeof c.folder === "string" ? c.folder : "",
        main: c.main === true,
      });
    }
  }
  let aep: AepRef | null = null;
  const a = o.aep;
  if (a && typeof a === "object" && typeof a.projectId === "string" && typeof a.path === "string") {
    aep = { projectId: a.projectId, path: a.path, name: typeof a.name === "string" ? a.name : "" };
  }
  return {
    schemaVersion: COMPS_SCHEMA,
    aep,
    lastScanAt: typeof o.lastScanAt === "string" ? o.lastScanAt : null,
    comps,
  };
}

export function sameAep(a: AepRef | null, b: AepRef | null): boolean {
  return !!a && !!b && a.projectId === b.projectId && a.path === b.path;
}

const fingerprint = (c: CompInfo) => [c.name, c.width, c.height, c.frameRate, c.duration].join("|");

export interface MergeResult {
  comps: CompEntry[];
  /** Comps that were Main Comps before but could not be reliably matched in this scan. */
  unmatched: CompEntry[];
}

/**
 * Combine a fresh scan with the previous comps.json, keeping Main Comp choices only where a
 * comp can be reliably matched:
 *  - same AEP file: by After Effects' item id (ids are stable inside one project);
 *  - a different AEP file (e.g. a new version saved as): ids are NOT comparable between
 *    projects, so only a comp whose name, size, frame rate and duration are identical, and
 *    unique on both sides, carries its choice over.
 * Anything else is picked by default: a composition that no other composition uses is a Main Comp.
 * A previous Main Comp that could not be matched is reported in `unmatched` so it is never lost silently.
 */
export function mergeComps(previous: CompsFile | null, aep: AepRef, scanned: ScannedComp[]): MergeResult {
  const prev = previous ? previous.comps : [];
  // A project with no Main Comp yet gets the default pick for every composition. Once someone has chosen,
  // their choices are kept and only compositions never seen before get the default.
  const nobodyChose = !prev.some((c) => c.main);
  const same = !!previous && sameAep(previous.aep, aep);
  const carried = new Set<number>(); // previous ids that found a match
  const byId = new Map<number, CompEntry>();
  for (const c of prev) byId.set(c.id, c);

  const prevCount = new Map<string, number>();
  for (const c of prev) prevCount.set(fingerprint(c), (prevCount.get(fingerprint(c)) || 0) + 1);
  const newCount = new Map<string, number>();
  for (const c of scanned) newCount.set(fingerprint(c), (newCount.get(fingerprint(c)) || 0) + 1);
  const prevByPrint = new Map<string, CompEntry>();
  for (const c of prev) prevByPrint.set(fingerprint(c), c);

  const comps: CompEntry[] = scanned.map((c) => {
    let match: CompEntry | undefined;
    if (same) {
      match = byId.get(c.id);
    } else {
      const key = fingerprint(c);
      if (prevCount.get(key) === 1 && newCount.get(key) === 1) match = prevByPrint.get(key);
    }
    if (match) carried.add(match.id);
    return {
      id: c.id,
      name: c.name,
      width: c.width,
      height: c.height,
      pixelAspect: c.pixelAspect,
      frameRate: c.frameRate,
      duration: c.duration,
      folder: c.folder,
      main: match && !nobodyChose ? match.main : c.usedIn === 0,
    };
  });

  const unmatched = prev.filter((c) => c.main && !carried.has(c.id));
  return { comps, unmatched };
}

export function buildCompsFile(aep: AepRef, comps: CompEntry[], scannedAt: string): CompsFile {
  return { schemaVersion: COMPS_SCHEMA, aep, lastScanAt: scannedAt, comps };
}

/** A copy of `file` with one comp's Main flag changed. Throws if the comp is not in the file. */
export function withMain(file: CompsFile, compId: number, main: boolean): CompsFile {
  if (!file.comps.some((c) => c.id === compId)) throw new Error("That composition is not in the last scan.");
  return { ...file, comps: file.comps.map((c) => (c.id === compId ? { ...c, main } : c)) };
}
