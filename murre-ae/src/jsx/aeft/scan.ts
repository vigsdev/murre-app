/**
 * Read-only scanners that run inside After Effects.
 *
 * Nothing here changes the project: no property is set, no item is created, moved or
 * renamed, and nothing is written to disk. The panel decides what to do with the data.
 *
 * Keep this file in plain ES3-friendly style (loops and functions, no spread or
 * for..of, no Object.keys): it is compiled for ExtendScript, not for a browser.
 */

import type {
  RawEffect,
  AepInfo,
  CompScan,
  ScannedComp,
  RawColor,
  RawExpression,
  RawFont,
  FontScan,
} from "../../shared/scan-types";

const MAX_DEPTH = 32;

/**
 * Which colors count. Only colors that are actually in use are collected, not every color
 * property a layer happens to have:
 *  - anything switched off (a layer's video switch, a shape group, a Fill or Stroke, a layer
 *    style, an effect) contributes no colors, nor does anything inside it;
 *  - in the Effects group only the effects listed below contribute (their colors are what you
 *    see), and other effects' colors are ignored;
 *  - a 3D layer's Material Options (shadow color and so on) are ignored.
 * Expressions are not affected by these rules.
 */
const COLOR_EFFECT_MATCH_NAMES = ["ADBE Fill", "ADBE Ramp", "ADBE 4ColorGradient"];
const COLOR_EFFECT_NAMES = ["Fill", "Gradient Ramp", "4-Color Gradient"];
const EFFECTS_GROUP = "ADBE Effect Parade";
const IGNORED_COLOR_GROUPS = ["ADBE Material Options Group"];

const inList = (list: string[], value: any): boolean => {
  for (let i = 0; i < list.length; i++) if (list[i] === value) return true;
  return false;
};

/** The group's own on/off switch (effect, shape group, Fill, Stroke, layer style). */
const isSwitchedOff = (prop: any): boolean => {
  try {
    return prop.enabled === false;
  } catch (e) {
    return false;
  }
};

const isColorEffect = (effect: any): boolean => {
  try {
    return inList(COLOR_EFFECT_MATCH_NAMES, effect.matchName) || inList(COLOR_EFFECT_NAMES, effect.name);
  } catch (e) {
    return false;
  }
};

export const getAepInfo = (): AepInfo => {
  const file = app.project.file;
  return {
    saved: file !== null,
    name: file ? file.displayName : null,
    path: file ? file.fsName : null,
    appVersion: app.version,
    numItems: app.project.numItems,
  };
};

const folderPathOf = (item: Item): string => {
  const names: string[] = [];
  try {
    let folder: FolderItem | null = item.parentFolder;
    let guard = 0;
    while (folder && folder !== app.project.rootFolder && guard < 64) {
      names.unshift(folder.name);
      folder = folder.parentFolder;
      guard++;
    }
  } catch (e) {
    // A folder we cannot read just means a shorter path.
  }
  return names.join("/");
};

export const listComps = (): ScannedComp[] => {
  const out: ScannedComp[] = [];
  const count = app.project.numItems;
  for (let i = 1; i <= count; i++) {
    const item = app.project.item(i);
    if (item instanceof CompItem) {
      out.push({
        id: item.id,
        name: item.name,
        width: item.width,
        height: item.height,
        pixelAspect: item.pixelAspect,
        frameRate: item.frameRate,
        duration: item.duration,
        folder: folderPathOf(item),
        usedIn: item.usedIn.length,
      });
    }
  }
  return out;
};

const findComp = (compId: number): CompItem | null => {
  const count = app.project.numItems;
  for (let i = 1; i <= count; i++) {
    const item = app.project.item(i);
    if (item instanceof CompItem && item.id === compId) return item;
  }
  return null;
};

const copyColor = (value: any): number[] | null => {
  if (!value || typeof value.length !== "number" || value.length < 3) return null;
  const out = [value[0], value[1], value[2]];
  if (value.length > 3) out.push(value[3]);
  return out;
};

interface Collector {
  layer: string;
  layerIndex: number;
  colors: RawColor[];
  expressions: RawExpression[];
  effects: RawEffect[];
  skipped: number;
}

const addColor = (c: Collector, value: any, property: string) => {
  const color = copyColor(value);
  if (color) c.colors.push({ color: color, layer: c.layer, layerIndex: c.layerIndex, property: property });
};

const visitLeaf = (c: Collector, prop: any, path: string, colorsOn: boolean) => {
  // Expressions
  try {
    if (prop.canSetExpression) {
      const text = prop.expression;
      if (typeof text === "string" && text.length > 0) {
        let error: string | null = null;
        try {
          error = prop.expressionError ? String(prop.expressionError) : null;
        } catch (e) {
          error = null;
        }
        c.expressions.push({
          expression: text,
          layer: c.layer,
          layerIndex: c.layerIndex,
          property: path,
          enabled: !!prop.expressionEnabled,
          error: error,
        });
      }
    }
  } catch (e) {
    c.skipped++;
  }

  // Colors (only where they are in use, see above)
  if (!colorsOn) return;
  try {
    const type = prop.propertyValueType;
    if (type === PropertyValueType.COLOR) {
      if (prop.numKeys > 0) {
        for (let k = 1; k <= prop.numKeys; k++) addColor(c, prop.keyValue(k), path);
      } else {
        addColor(c, prop.value, path);
      }
    } else if (type === PropertyValueType.TEXT_DOCUMENT) {
      const doc = prop.value;
      if (doc && doc.applyFill) addColor(c, doc.fillColor, path + " > Fill color");
      if (doc && doc.applyStroke) addColor(c, doc.strokeColor, path + " > Stroke color");
    }
  } catch (e) {
    c.skipped++;
  }
};

const walk = (c: Collector, group: any, path: string[], depth: number, colorsOn: boolean) => {
  let count = 0;
  let inEffects = false;
  try {
    count = group.numProperties;
    inEffects = group.matchName === EFFECTS_GROUP;
  } catch (e) {
    c.skipped++;
    return;
  }
  for (let i = 1; i <= count; i++) {
    try {
      const prop = group.property(i);
      if (!prop) continue;
      const here = path.concat([prop.name]);
      if (prop.propertyType === PropertyType.PROPERTY) {
        visitLeaf(c, prop, here.join(" > "), colorsOn);
      } else if (depth < MAX_DEPTH) {
        if (inEffects) {
          // Every effect counts, switched on or off: opening the project needs its plugin either way.
          c.effects.push({ matchName: String(prop.matchName || ""), name: String(prop.name || ""), layer: c.layer });
        }
        let childOn = colorsOn;
        if (childOn && (isSwitchedOff(prop) || inList(IGNORED_COLOR_GROUPS, prop.matchName))) childOn = false;
        if (childOn && inEffects && !isColorEffect(prop)) childOn = false;
        walk(c, prop, here, depth + 1, childOn);
      }
    } catch (e) {
      c.skipped++;
    }
  }
};

const visitSolid = (c: Collector, layer: Layer) => {
  try {
    if (layer instanceof AVLayer && layer.source instanceof FootageItem) {
      const main = layer.source.mainSource;
      if (main instanceof SolidSource) addColor(c, main.color, "Solid color");
    }
  } catch (e) {
    c.skipped++;
  }
};

/** Collect the colors and expressions of one composition, by After Effects item id. */
export const scanComp = (compId: number): CompScan => {
  const comp = findComp(compId);
  if (!comp) throw new Error("Composition not found (id " + compId + ").");

  const result: CompScan = {
    compId: compId,
    compName: comp.name,
    colors: [],
    expressions: [],
    effects: [],
    skipped: 0,
  };
  const layers = comp.numLayers;
  for (let l = 1; l <= layers; l++) {
    const collector: Collector = {
      layer: "",
      layerIndex: l,
      colors: result.colors,
      expressions: result.expressions,
      effects: result.effects,
      skipped: 0,
    };
    try {
      const layer = comp.layer(l);
      collector.layer = layer.name;
      // A layer whose video switch is off is not shown, so its colors do not count.
      const shown = !isSwitchedOff(layer);
      if (shown) visitSolid(collector, layer);
      walk(collector, layer, [], 0, shown);
    } catch (e) {
      collector.skipped++;
    }
    result.skipped += collector.skipped;
  }
  return result;
};

// ---- Fonts --------------------------------------------------------------------------------------------------------

/** The most layers kept per font. The count is always the true number. */
const MAX_FONT_LAYERS = 200;
const MAX_FONTS = 2000;

const textOf = (get: () => any): string => {
  try {
    const v = get();
    return typeof v === "string" ? v : "";
  } catch (e) {
    return "";
  }
};

const flagOf = (get: () => any): boolean => {
  try {
    return get() === true;
  } catch (e) {
    return false;
  }
};

/** Add one use of a font; creates the entry the first time. `seen` stops one layer being counted twice for a font. */
const addFontUse = (
  fonts: RawFont[],
  index: { [key: string]: RawFont },
  seen: { [key: string]: boolean },
  base: RawFont,
  comp: string,
  layer: string,
  layerKey: string,
  compId?: number,
  layerIndex?: number,
) => {
  const key = base.postScriptName || base.family + "|" + base.style;
  let f = index[key];
  if (!f) {
    if (fonts.length >= MAX_FONTS) return;
    f = base;
    index[key] = f;
    fonts.push(f);
  }
  const once = key + "#" + layerKey;
  if (seen[once]) return;
  seen[once] = true;
  f.layerCount++;
  if (f.layers.length < MAX_FONT_LAYERS) {
    const use: { comp: string; layer: string; compId?: number; layerIndex?: number } = { comp: comp, layer: layer };
    if (compId !== undefined && layerIndex !== undefined) {
      use.compId = compId;
      use.layerIndex = layerIndex;
    }
    f.layers.push(use);
  }
};

const fontFromObject = (font: any): RawFont => ({
  postScriptName: textOf(() => font.postScriptName),
  family: textOf(() => font.familyName),
  style: textOf(() => font.styleName),
  location: textOf(() => font.location),
  adobeFonts: flagOf(() => font.isFromAdobeFonts),
  missing: flagOf(() => font.isSubstitute),
  layerCount: 0,
  layers: [],
});

/**
 * The fonts of the whole project. After Effects 24.5+ reports them all (with the layers that use them); older versions are read
 * from each text layer's first font. Read-only.
 */
export const scanFonts = (): FontScan => {
  const out: FontScan = { method: "layers", fonts: [], skipped: 0 };
  const index: { [key: string]: RawFont } = {};
  const seen: { [key: string]: boolean } = {};

  let used: any = null;
  try {
    used = (app.project as any).usedFonts;
  } catch (e) {
    used = null;
  }

  if (used && typeof used.length === "number") {
    out.method = "project";
    // Where every layer lives, found by walking the compositions once (layer id -> composition and position).
    const places: { [id: string]: { compId: number; compName: string; layerIndex: number; layerName: string } } = {};
    try {
      const total = app.project.numItems;
      for (let i = 1; i <= total; i++) {
        const item: any = app.project.item(i);
        if (!(item instanceof CompItem)) continue;
        for (let l = 1; l <= item.numLayers; l++) {
          try {
            const ly: any = item.layer(l);
            places[String(ly.id)] = { compId: item.id, compName: item.name, layerIndex: l, layerName: ly.name };
          } catch (e) {
            /* a layer that cannot be read is found through layerByID below */
          }
        }
      }
    } catch (e) {
      /* fall back to layerByID for every layer */
    }
    for (let i = 0; i < used.length; i++) {
      try {
        const entry = used[i];
        const base = fontFromObject(entry.font);
        const at = entry.usedAt;
        let any = false;
        if (at && typeof at.length === "number") {
          for (let k = 0; k < at.length; k++) {
            try {
              const id = String(at[k].layerID);
              let comp = "";
              let layerName = "";
              let compId: number | undefined;
              let layerIndex: number | undefined;
              const known = places[id];
              if (known) {
                comp = known.compName;
                layerName = known.layerName;
                compId = known.compId;
                layerIndex = known.layerIndex;
              } else {
                // Not found by walking the compositions: ask After Effects for the layer directly.
                const layer = (app.project as any).layerByID(at[k].layerID);
                layerName = layer ? layer.name : "";
                try {
                  comp = layer.containingComp.name;
                  compId = layer.containingComp.id;
                  layerIndex = layer.index;
                } catch (e) {
                  /* the name alone is still listed */
                }
              }
              addFontUse(out.fonts, index, seen, base, comp, layerName, id, compId, layerIndex);
              any = true;
            } catch (e) {
              out.skipped++;
            }
          }
        }
        // A font with no readable layer is still part of the project.
        if (!any) addFontUse(out.fonts, index, seen, base, "", "", "none");
      } catch (e) {
        out.skipped++;
      }
    }
    return out;
  }

  // Older After Effects: the first font of every text layer.
  const count = app.project.numItems;
  for (let i = 1; i <= count; i++) {
    let item: any;
    try {
      item = app.project.item(i);
    } catch (e) {
      out.skipped++;
      continue;
    }
    if (!(item instanceof CompItem)) continue;
    for (let l = 1; l <= item.numLayers; l++) {
      try {
        const layer: any = item.layer(l);
        if (!(layer instanceof TextLayer)) continue;
        const doc: any = layer.property("Source Text").value;
        let base: RawFont;
        try {
          base = doc.fontObject ? fontFromObject(doc.fontObject) : fontFromObject(null);
        } catch (e) {
          base = fontFromObject(null);
        }
        if (!base.postScriptName) base.postScriptName = textOf(() => doc.font);
        if (!base.family) base.family = textOf(() => doc.fontFamily);
        if (!base.style) base.style = textOf(() => doc.fontStyle);
        if (!base.location) base.location = textOf(() => doc.fontLocation);
        addFontUse(out.fonts, index, seen, base, item.name, layer.name, String(item.id) + ":" + l, item.id, l);
      } catch (e) {
        out.skipped++;
      }
    }
  }
  return out;
};
