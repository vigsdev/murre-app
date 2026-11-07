/**
 * Tidies the project panel into the same bins the Murre project folder uses:
 *
 *   01 Comps            compositions that are not used inside another one
 *   01 Comps/Precomps   compositions that are
 *   02 Assets           footage that is not images, audio, Photoshop, Illustrator or video files
 *   02 Assets/<one bin per folder of the project's folder setup, default: 01 Images, 02 Audios, 03 PSD Files, 04 Illustrator Files, 07 Videos>
 *   02 Assets/Solids    solids
 *   02 Assets/05 Templates  bins of imported After Effects projects (named like "Paper Transition.aep"), moved whole
 *
 * An imported project keeps its own bins exactly as they are: nothing inside such a bin is sorted, and its empty
 * bins are never removed. Anything put into the templates bin by hand stays there too.
 *
 * It is the one place besides `relinkFootage` where the Companion changes the open project. It only
 * moves items between bins (and deletes bins left empty); no item is deleted, renamed or changed, and
 * the project is not saved. Items that already sit in the right bin are left alone, and when nothing
 * needs to move nothing at all happens: no undo step, so running it on every scan does not make the
 * project "changed" or fill the undo history. Placeholders are left where they are.
 *
 * Plain ES3-friendly style: this file is compiled for ExtendScript.
 */

import { ASSETS_DIR, COMPS_BIN, PRECOMPS_BIN, SOLIDS_BIN, assetSubfolder, templatesFolder, type AssetFolderRule } from "../../shared/asset-folders";
import type { OrganizeResult } from "../../shared/scan-types";

/** The bin path (outermost first) an item belongs in, or null to leave it alone. */
const binPathOf = (item: Item, rules?: AssetFolderRule[]): string[] | null => {
  try {
    if (item instanceof CompItem) return item.usedIn.length === 0 ? [COMPS_BIN] : [COMPS_BIN, PRECOMPS_BIN];
    if (item instanceof FootageItem) {
      const source = item.mainSource;
      if (source instanceof SolidSource) return [ASSETS_DIR, SOLIDS_BIN];
      if (source instanceof FileSource) {
        let name = item.name;
        try {
          if (item.file) name = item.file.name;
        } catch (e) {
          // A missing file has no path: the item's own name is the best guess.
        }
        const sub = assetSubfolder(name, rules);
        return sub ? [ASSETS_DIR, sub] : [ASSETS_DIR];
      }
    }
  } catch (e) {
    // Fall through: an item we cannot read is not touched.
  }
  return null;
};

/** After Effects names the bin of an imported project after its file. */
const isProjectBin = (item: Item): boolean => {
  try {
    return item instanceof FolderItem && /\.aepx?$/i.test(item.name);
  } catch (e) {
    return false;
  }
};

/** Whether `item` sits somewhere inside `bin`. */
const isInside = (item: Item, bin: FolderItem | null): boolean => {
  if (!bin) return false;
  let folder: FolderItem | null = null;
  try {
    folder = item.parentFolder;
  } catch (e) {
    return false;
  }
  let guard = 0;
  while (folder && guard < 100) {
    if (folder.id === bin.id) return true;
    try {
      folder = folder.parentFolder;
    } catch (e) {
      folder = null;
    }
    guard++;
  }
  return false;
};

/** The outermost imported-project bin that `item` sits inside, if any. */
const enclosingProjectBin = (item: Item): FolderItem | null => {
  const rootId = app.project.rootFolder.id;
  let found: FolderItem | null = null;
  let folder: FolderItem | null = null;
  try {
    folder = item.parentFolder;
  } catch (e) {
    return null;
  }
  let guard = 0;
  while (folder && folder.id !== rootId && guard < 100) {
    if (isProjectBin(folder)) found = folder;
    try {
      folder = folder.parentFolder;
    } catch (e) {
      folder = null;
    }
    guard++;
  }
  return found;
};

const childBin = (parent: FolderItem, name: string): FolderItem | null => {
  for (let i = 1; i <= parent.numItems; i++) {
    const child = parent.item(i);
    if (child instanceof FolderItem && child.name === name) return child;
  }
  return null;
};

/** The bin at this path if it already exists (nothing is created). */
const findBin = (path: string[]): FolderItem | null => {
  let folder: FolderItem | null = app.project.rootFolder;
  for (let i = 0; i < path.length && folder; i++) folder = childBin(folder, path[i]);
  return folder;
};

const ensureBin = (path: string[]): FolderItem => {
  let folder: FolderItem = app.project.rootFolder;
  for (let i = 0; i < path.length; i++) {
    let next = childBin(folder, path[i]);
    if (!next) {
      next = app.project.items.addFolder(path[i]);
      next.parentFolder = folder;
    }
    folder = next;
  }
  return folder;
};

const removeEmptyBins = (templatesBin: FolderItem | null) => {
  let removed = true;
  let guard = 0;
  while (removed && guard < 20) {
    removed = false;
    guard++;
    for (let i = app.project.numItems; i >= 1; i--) {
      const item = app.project.item(i);
      // An imported project's bins stay as its author made them, empty ones included.
      if (item instanceof FolderItem && item.numItems === 0 && !isProjectBin(item) && !enclosingProjectBin(item) && !isInside(item, templatesBin)) {
        try {
          item.remove();
          removed = true;
        } catch (e) {
          // A bin that will not go away is harmless.
        }
      }
    }
  }
};

/** `rules` is the project's own folder setup; without it the default folders are used. */
export const organizeProject = (rules?: AssetFolderRule[]): OrganizeResult => {
  const result: OrganizeResult = { moved: 0, failed: 0 };
  const pending: { item: Item; path: string[] }[] = [];
  const count = app.project.numItems;
  const templates = [ASSETS_DIR, templatesFolder(rules)];
  const templatesBin = findBin(templates);
  for (let i = 1; i <= count; i++) {
    const item = app.project.item(i);
    // Anything inside an imported project stays where it is; the project's own bin moves as one piece.
    if (enclosingProjectBin(item)) continue;
    if (isInside(item, templatesBin)) continue;
    const path = isProjectBin(item) ? templates : binPathOf(item, rules);
    if (!path) continue;
    const bin = findBin(path);
    let parent: FolderItem | null = null;
    try {
      parent = item.parentFolder;
    } catch (e) {
      parent = null;
    }
    if (bin && parent && parent.id === bin.id) continue;
    pending.push({ item: item, path: path });
  }
  if (pending.length === 0) return result;

  app.beginUndoGroup("Murre: organize project");
  try {
    for (let i = 0; i < pending.length; i++) {
      try {
        pending[i].item.parentFolder = ensureBin(pending[i].path);
        result.moved++;
      } catch (e) {
        result.failed++;
      }
    }
    // Look it up again: it may have been made just now.
    removeEmptyBins(findBin(templates));
  } finally {
    app.endUndoGroup();
  }
  return result;
};
