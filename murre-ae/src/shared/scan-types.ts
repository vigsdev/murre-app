/**
 * Plain data passed from the ExtendScript side (inside After Effects) to the panel.
 * Types only, so it is safe to import from both sides.
 */

export interface AepInfo {
  /** The project has been saved to a file. Unsaved projects cannot be linked. */
  saved: boolean;
  name: string | null;
  /** Absolute path of the .aep file, in the operating system's own format. */
  path: string | null;
  appVersion: string;
  numItems: number;
}

export interface CompInfo {
  /** After Effects' item id: stable inside one project, but not unique across projects. */
  id: number;
  name: string;
  width: number;
  height: number;
  pixelAspect: number;
  frameRate: number;
  /** Seconds. */
  duration: number;
  /** Project-panel folder, e.g. "Comps/Final". Empty at the top level. */
  folder: string;
}

/** A composition as listed by a scan: its details plus how many other compositions use it. */
export interface ScannedComp extends CompInfo {
  /** Compositions that contain this one as a layer. 0 means nothing uses it: a candidate for a Main Comp. */
  usedIn: number;
}

/** A color as After Effects reports it: channels in 0–1, `[r, g, b]` or `[r, g, b, a]`. */
export type RawColorValue = number[];

export interface RawColor {
  color: RawColorValue;
  layer: string;
  /** Position of the layer in its composition (1 = top), so the app can jump to it. */
  layerIndex?: number;
  /** Path below the layer, e.g. "Contents > Rectangle 1 > Fill 1 > Color". */
  property: string;
}

export interface RawExpression {
  expression: string;
  layer: string;
  /** Position of the layer in its composition (1 = top). */
  layerIndex?: number;
  property: string;
  /** False when the expression is switched off. */
  enabled: boolean;
  /** After Effects' own error text for the expression, if it has one. */
  error: string | null;
}

/** A font used in the project, with the layers that use it. */
export interface RawFont {
  /** PostScript name, e.g. "Helvetica-Bold". The identity of a font. */
  postScriptName: string;
  family: string;
  style: string;
  /** Path of the font file; empty for some kinds of font (for example Adobe Fonts). */
  location: string;
  adobeFonts: boolean;
  /** The font was not installed when the project was opened, so After Effects is using a stand-in. */
  missing: boolean;
  /** How many layers use it. */
  layerCount: number;
  /** Some of those layers (the first ones found). */
  layers: { comp: string; layer: string; compId?: number; layerIndex?: number }[];
}

/**
 * The fonts of the whole project.
 *  - `project`: After Effects 24.5 and newer list every font in use, including several fonts inside one text layer.
 *  - `layers`: older versions only report the first font of each text layer, so a layer that mixes fonts shows just one.
 */
export interface FontScan {
  method: "project" | "layers";
  fonts: RawFont[];
  /** Layers or fonts that could not be read. */
  skipped: number;
}

/** Everything collected from one composition. */
/** One effect applied to a layer. Only the identity is read, never its settings. */
export interface RawEffect {
  /** After Effects' internal name, e.g. "ADBE Gaussian Blur 2" or a plugin's own name. The identity of an effect. */
  matchName: string;
  /** The name shown in the Effects panel (the user may have renamed this instance). */
  name: string;
  layer: string;
}

export interface CompScan {
  compId: number;
  compName: string;
  colors: RawColor[];
  expressions: RawExpression[];
  /** Effects on this composition's layers. Missing in scans from an older Companion. */
  effects?: RawEffect[];
  /** Layers or properties that could not be read (they are skipped, not guessed). */
  skipped: number;
}

/** What kind of file a footage item points at. Only plain `file`s are ever copied and relinked. */
export type FootageKind = "file" | "sequence";

/** A footage item in the project panel that is backed by a file on disk (solids and placeholders are not listed). */
export interface FootageInfo {
  /** After Effects' item id (stable inside one project). */
  id: number;
  name: string;
  /** Absolute path in the operating system's own format; null when After Effects has no path for it. */
  path: string | null;
  kind: FootageKind;
  /** After Effects reports the file as missing. */
  missing: boolean;
}

export interface RelinkOutcome {
  ok: boolean;
  /** Why it failed, in plain words. */
  message: string;
}

/** What tidying the project panel into bins did. */
export interface OrganizeResult {
  /** Items moved into a bin. */
  moved: number;
  /** Items After Effects would not move (locked, for example). They stay where they were. */
  failed: number;
}
