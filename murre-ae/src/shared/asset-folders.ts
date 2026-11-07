/**
 * The folder names the Murre project uses for files, shared by the panel (copying files into the
 * project folder) and the ExtendScript side (the bins in After Effects' project panel), so the two
 * always match. Plain ES3-friendly code: it is compiled for ExtendScript as well.
 */

export const ASSETS_DIR = "02 Assets";
export const COMPS_BIN = "01 Comps";
export const PRECOMPS_BIN = "Precomps";
export const SOLIDS_BIN = "Solids";
/** Where imported After Effects projects go, inside the assets bin, when the folder setup has no templates folder. */
export const TEMPLATES_BIN = "05 Templates";

/** One sub-folder of the assets folder and the file types that go into it. */
export interface AssetFolderRule {
  folder: string;
  exts: string[];
}

/**
 * Where a file goes inside the assets folder, by file type, when a project has no `.murre/folders.json` of its own.
 * Anything else goes straight into the assets folder.
 */
export const ASSET_FOLDERS: AssetFolderRule[] = [
  { folder: "01 Images", exts: ["jpg", "jpeg", "png", "gif", "tif", "tiff", "bmp", "webp", "heic", "heif", "exr", "hdr", "dpx", "tga", "svg", "jp2"] },
  { folder: "02 Audios", exts: ["wav", "mp3", "aif", "aiff", "m4a", "aac", "flac", "ogg", "wma"] },
  { folder: "03 PSD Files", exts: ["psd", "psb"] },
  { folder: "04 Illustrator Files", exts: ["ai", "eps"] },
  { folder: "07 Videos", exts: ["mp4", "mov", "m4v", "avi", "mkv", "webm", "mxf", "wmv", "mpg", "mpeg", "mts", "m2ts", "flv", "3gp"] },
];

/** The sub-folder name for a file name, or null when it goes straight into the assets folder. The first matching rule wins. */
export function assetSubfolder(fileName: string, rules?: AssetFolderRule[] | null): string | null {
  const list = rules ? rules : ASSET_FOLDERS;
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  if (ext === "") return null;
  for (let i = 0; i < list.length; i++) {
    const exts = list[i].exts;
    for (let j = 0; j < exts.length; j++) if (exts[j] === ext) return list[i].folder;
  }
  return null;
}

/** The templates folder of a folder setup: the first one with "template" in its name, else the default. */
export function templatesFolder(rules?: AssetFolderRule[] | null): string {
  const list = rules ? rules : [];
  for (let i = 0; i < list.length; i++) if (/template/i.test(list[i].folder)) return list[i].folder;
  return TEMPLATES_BIN;
}
