/**
 * Footage helpers that run inside After Effects.
 *
 * `listFootage` only reads. `relinkFootage` is the one place the Companion changes the open
 * project: it points ONE existing footage item at a file that already exists. It never imports,
 * deletes or moves anything, and it does not save the project (the user decides when to save).
 *
 * Plain ES3-friendly style: this file is compiled for ExtendScript.
 */

import type { FootageInfo, RelinkOutcome } from "../../shared/scan-types";

/** After Effects names image sequences like "frame_[0001-0100].png". */
const SEQUENCE_NAME = /\[\d+-\d+\]/;

export const listFootage = (): FootageInfo[] => {
  const out: FootageInfo[] = [];
  const count = app.project.numItems;
  for (let i = 1; i <= count; i++) {
    const item = app.project.item(i);
    if (!(item instanceof FootageItem)) continue;
    try {
      // Solids, placeholders and the like have no file behind them.
      if (!(item.mainSource instanceof FileSource)) continue;
      let path: string | null = null;
      try {
        path = item.file ? item.file.fsName : null;
      } catch (e) {
        path = null;
      }
      let missing = false;
      try {
        missing = item.footageMissing === true;
      } catch (e) {
        missing = false;
      }
      if (path === null && !missing) continue;
      if (path === null) {
        try {
          path = (item.mainSource as FileSource).missingFootagePath || null;
        } catch (e) {
          path = null;
        }
      }
      const fileName = path ? path.split("/").pop()!.split("\\").pop()! : "";
      out.push({
        id: item.id,
        name: item.name,
        path: path,
        kind: SEQUENCE_NAME.test(item.name) || SEQUENCE_NAME.test(fileName) ? "sequence" : "file",
        missing: missing,
      });
    } catch (e) {
      // An item we cannot read is left out.
    }
  }
  return out;
};

const findFootage = (id: number): FootageItem | null => {
  const count = app.project.numItems;
  for (let i = 1; i <= count; i++) {
    const item = app.project.item(i);
    if (item.id === id && item instanceof FootageItem) return item;
  }
  return null;
};

export const relinkFootage = (id: number, newPath: string): RelinkOutcome => {
  const item = findFootage(id);
  if (!item) return { ok: false, message: "Footage item not found (id " + id + ")." };
  if (!(item.mainSource instanceof FileSource)) return { ok: false, message: "This item is not a file." };
  const target = new File(newPath);
  if (!target.exists) return { ok: false, message: "The copied file is not there any more: " + newPath };
  const name = item.name;
  try {
    item.replace(target);
  } catch (e) {
    return { ok: false, message: "After Effects could not relink it: " + (e as Error).message };
  }
  // Keep the name the user gave the item in the project panel.
  try {
    if (item.name !== name) item.name = name;
  } catch (e) {
    // The name is cosmetic.
  }
  if (item.footageMissing) return { ok: false, message: "After Effects still reports the footage as missing." };
  return { ok: true, message: "" };
};
