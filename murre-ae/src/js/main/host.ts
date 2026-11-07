import { child_process, os } from "../lib/cep/node";
import { trashFiles } from "../lib/murre/trash";
import { evalTS } from "../lib/utils/bolt";
import type { ScanHost } from "../lib/murre/scanner";

/** What the scanner and relinker need from After Effects, reached through the extension's ExtendScript. */
export const host: ScanHost = {
  getAepInfo: () => evalTS("getAepInfo"),
  listComps: () => evalTS("listComps"),
  scanComp: (id: number) => evalTS("scanComp", id),
  scanFonts: () => evalTS("scanFonts"),
  organizeProject: (rules) => evalTS("organizeProject", rules),
  listFootage: () => evalTS("listFootage"),
  relinkFootage: (id: number, newPath: string) => evalTS("relinkFootage", id, newPath),
};

/** Moves files to the Trash (Finder on macOS) or the Recycle Bin (Windows). Used only when a project's settings turn it on. */
export const trash = (paths: string[]) =>
  trashFiles(
    os.platform(),
    (program, args) =>
      String(child_process.execFileSync(program, args, { stdio: "pipe", timeout: 60000, windowsHide: true, encoding: "utf8" })),
    paths,
  );
