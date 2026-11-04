import type { CompScan, FontScan } from "../../../shared/scan-types";

export const SNAPSHOT_SCHEMA = 1;
/** Same limits as the desktop app's readers; beyond these it would not show the entries. */
export const MAX_COLORS = 50_000;
export const MAX_EXPRESSIONS = 20_000;

export interface ColorsFile {
  schemaVersion: number;
  lastScanAt: string;
  colors: {
    color: number[];
    comp: string;
    compId: number;
    layer: string;
    /** Position of the layer in its composition (1 = top). Missing in files from older scans. */
    layerIndex?: number;
    property: string;
  }[];
}

export interface ExpressionsFile {
  schemaVersion: number;
  lastScanAt: string;
  expressions: {
    expression: string;
    comp: string;
    compId: number;
    layer: string;
    layerIndex?: number;
    property: string;
    enabled: boolean;
    error?: string;
  }[];
}

export const MAX_FONTS = 2000;
export const MAX_PLUGINS = 500;
const MAX_PLUGIN_USES = 50;

export interface EnvironmentFile {
  schemaVersion: number;
  lastScanAt: string;
  /** The After Effects version that had the project open during this scan. */
  aeVersion: string;
  /** Effects that are not After Effects' own (their internal name does not start with "ADBE"). */
  plugins: {
    matchName: string;
    name: string;
    /** How many layers use it. */
    layerCount: number;
    uses: { comp: string; layer: string }[];
  }[];
}

/**
 * Effects that are not separate plugins: After Effects' own ("ADBE"), preset "pseudo" effects that live inside the project
 * (Animation Composer, Duik and similar), and Cycore "CC" effects, which ship with After Effects.
 */
export function isBundledEffect(matchName: string, name = ""): boolean {
  return matchName.indexOf("ADBE") === 0 || matchName.indexOf("Pseudo/") === 0 || matchName.indexOf("CC ") === 0 || name.indexOf("CC ") === 0 || matchName.indexOf("CS ") === 0 || name.indexOf("CS ") === 0;
}

/** Effects from other makers, one entry per effect with the places it is used. Adobe's own effects are left out. */
export function buildEnvironmentFile(scans: CompScan[], aeVersion: string, scannedAt: string): EnvironmentFile {
  const byName = new Map<string, EnvironmentFile["plugins"][number]>();
  for (const sc of scans) {
    for (const e of sc.effects ?? []) {
      if (!e.matchName || isBundledEffect(e.matchName, e.name)) continue;
      let p = byName.get(e.matchName);
      if (!p) {
        if (byName.size >= MAX_PLUGINS) continue;
        p = { matchName: e.matchName, name: e.name || e.matchName, layerCount: 0, uses: [] };
        byName.set(e.matchName, p);
      }
      p.layerCount++;
      if (p.uses.length < MAX_PLUGIN_USES) p.uses.push({ comp: sc.compName, layer: e.layer });
    }
  }
  const plugins = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { schemaVersion: SNAPSHOT_SCHEMA, lastScanAt: scannedAt, aeVersion, plugins };
}

export interface FontsFile {
  schemaVersion: number;
  lastScanAt: string;
  /** How the list was made: "project" lists every font in use; "layers" is the first font of each text layer. */
  method: "project" | "layers";
  fonts: {
    postScriptName: string;
    family: string;
    style: string;
    location: string;
    adobeFonts: boolean;
    missing: boolean;
    layerCount: number;
    uses: { comp: string; layer: string; compId?: number; layerIndex?: number }[];
  }[];
}

/** The fonts snapshot, sorted by family and style. A font without any name is left out. */
export function buildFontsFile(scan: FontScan, scannedAt: string): FontsFile {
  const fonts: FontsFile["fonts"] = [];
  for (const f of scan.fonts) {
    if (!f.postScriptName && !f.family) continue;
    if (fonts.length >= MAX_FONTS) break;
    fonts.push({
      postScriptName: f.postScriptName,
      family: f.family || f.postScriptName,
      style: f.style,
      location: f.location,
      adobeFonts: f.adobeFonts,
      missing: f.missing,
      layerCount: f.layerCount,
      uses: f.layers.map((u) => (u.compId !== undefined && u.layerIndex !== undefined ? { comp: u.comp, layer: u.layer, compId: u.compId, layerIndex: u.layerIndex } : { comp: u.comp, layer: u.layer })),
    });
  }
  fonts.sort((a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style));
  return { schemaVersion: SNAPSHOT_SCHEMA, lastScanAt: scannedAt, method: scan.method, fonts };
}

export interface ScanCounts {
  comps: number;
  colors: number;
  expressions: number;
  /** Colors left out because a channel was outside 0–1 (for example 32-bit HDR values). */
  colorsOutOfRange: number;
  /** Entries left out because the file limit was reached. */
  colorsOverLimit: number;
  expressionsOverLimit: number;
  /** Layers or properties After Effects would not let us read. */
  unreadable: number;
}

const inRange = (n: unknown) => typeof n === "number" && isFinite(n) && n >= 0 && n <= 1;

export interface ScanSnapshots {
  colors: ColorsFile;
  expressions: ExpressionsFile;
  counts: ScanCounts;
}

/** Turn the per-composition scans into complete colors.json and expressions.json snapshots. */
export function buildSnapshots(scans: CompScan[], scannedAt: string): ScanSnapshots {
  const colors: ColorsFile["colors"] = [];
  const expressions: ExpressionsFile["expressions"] = [];
  const seen = new Set<string>();
  const counts: ScanCounts = {
    comps: scans.length,
    colors: 0,
    expressions: 0,
    colorsOutOfRange: 0,
    colorsOverLimit: 0,
    expressionsOverLimit: 0,
    unreadable: 0,
  };

  for (const scan of scans) {
    counts.unreadable += scan.skipped;
    for (const c of scan.colors) {
      if (!c.color.every(inRange) || c.color.length < 3 || c.color.length > 4) {
        counts.colorsOutOfRange++;
        continue;
      }
      // A keyframed color that holds the same value many times is listed once.
      const key = `${scan.compId}|${c.layer}|${c.property}|${c.color.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (colors.length >= MAX_COLORS) {
        counts.colorsOverLimit++;
        continue;
      }
      const entry: ColorsFile["colors"][number] = { color: c.color, comp: scan.compName, compId: scan.compId, layer: c.layer, property: c.property };
      if (c.layerIndex !== undefined) entry.layerIndex = c.layerIndex;
      colors.push(entry);
    }
    for (const e of scan.expressions) {
      if (expressions.length >= MAX_EXPRESSIONS) {
        counts.expressionsOverLimit++;
        continue;
      }
      const entry: ExpressionsFile["expressions"][number] = {
        // After Effects separates lines with a bare carriage return; store ordinary line breaks.
        expression: e.expression.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
        comp: scan.compName,
        compId: scan.compId,
        layer: e.layer,
        property: e.property,
        enabled: e.enabled,
      };
      if (e.layerIndex !== undefined) entry.layerIndex = e.layerIndex;
      if (e.error) entry.error = e.error;
      expressions.push(entry);
    }
  }
  counts.colors = colors.length;
  counts.expressions = expressions.length;
  return {
    colors: { schemaVersion: SNAPSHOT_SCHEMA, lastScanAt: scannedAt, colors },
    expressions: { schemaVersion: SNAPSHOT_SCHEMA, lastScanAt: scannedAt, expressions },
    counts,
  };
}
