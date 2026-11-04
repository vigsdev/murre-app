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

/** Moves files to the Trash through Finder (macOS). Used only when a project's settings turn it on. */
export const trash = (paths: string[]) =>
  trashFiles(os.platform(), (args) => void child_process.execFileSync("osascript", args, { stdio: "pipe", timeout: 60000 }), paths);
