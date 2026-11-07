/**
 * Move files to the Trash or Recycle Bin (never a permanent delete), so they can be put back.
 * - macOS: asks Finder. Paths are passed as arguments to the script, never put into its text.
 * - Windows: PowerShell calls .NET's documented `FileSystem.DeleteFile(path, OnlyErrorDialogs, SendToRecycleBin)`.
 *   The script goes in as `-EncodedCommand` and each path inside it as base64 data, so no path is ever read as code.
 */

const SCRIPT = [
  "on run argv",
  'tell application "Finder"',
  "repeat with p in argv",
  "delete (POSIX file (contents of p) as alias)",
  "end repeat",
  "end tell",
  "end run",
];

/** Runs a program with arguments (no shell) and returns what it printed. Throws when it fails. */
export type RunProgram = (program: string, args: string[]) => string;

export interface TrashResult {
  trashed: string[];
  failed: { path: string; message: string }[];
}

/** What the place files go to is called on each system, for messages. */
export const trashName = (platform: string) => (platform === "win32" ? "Recycle Bin" : "Trash");

const firstLine = (e: any) => (e && e.message ? String(e.message).split("\n")[0].trim() : String(e));

export function trashFiles(platform: string, run: RunProgram, paths: string[]): TrashResult {
  if (platform === "darwin") return finderTrash(run, paths);
  if (platform === "win32") return recycle(run, paths);
  const result: TrashResult = { trashed: [], failed: [] };
  for (const path of paths) result.failed.push({ path, message: "Moving files to the Trash isn’t available on this system." });
  return result;
}

const BATCH = 25;

function finderTrash(run: RunProgram, paths: string[]): TrashResult {
  const result: TrashResult = { trashed: [], failed: [] };
  const args = (list: string[]) => SCRIPT.flatMap((line) => ["-e", line]).concat(list);
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    try {
      run("osascript", args(batch));
      result.trashed.push(...batch);
    } catch {
      // One bad file must not hold back the others: try them one at a time.
      for (const path of batch) {
        try {
          run("osascript", args([path]));
          result.trashed.push(path);
        } catch (e: any) {
          result.failed.push({ path, message: `Not moved to the Trash: ${firstLine(e)}` });
        }
      }
    }
  }
  return result;
}

/** Fewer per call on Windows: the whole script, paths included, has to fit on one command line. */
const WIN_BATCH = 10;

/** The PowerShell script for one batch. Each line it prints is `OK<tab>n` or `ERR<tab>n<tab>message`. */
export function recycleScript(paths: string[]): string {
  const list = paths.map((p) => `'${Buffer.from(p, "utf8").toString("base64")}'`).join(",");
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `$list = @(${list})`,
    "for ($i = 0; $i -lt $list.Count; $i++) {",
    "  try {",
    "    $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($list[$i]))",
    "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '    "OK`t$i"',
    "  } catch {",
    '    "ERR`t$i`t" + ($_.Exception.Message -split "`n")[0]',
    "  }",
    "}",
  ].join("\n");
}

/** `-EncodedCommand` takes the script as base64 of its UTF-16LE text. */
export const encodeCommand = (script: string) => Buffer.from(script, "utf16le").toString("base64");

function recycle(run: RunProgram, paths: string[]): TrashResult {
  const result: TrashResult = { trashed: [], failed: [] };
  for (let i = 0; i < paths.length; i += WIN_BATCH) {
    const batch = paths.slice(i, i + WIN_BATCH);
    let out: string;
    try {
      out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(recycleScript(batch))]);
    } catch (e: any) {
      for (const path of batch) result.failed.push({ path, message: `Not moved to the Recycle Bin: ${firstLine(e)}` });
      continue;
    }
    const done = new Map<number, string | null>();
    for (const line of out.split(/\r?\n/)) {
      const [kind, n, ...rest] = line.split("\t");
      const at = Number(n);
      if (!Number.isInteger(at)) continue;
      if (kind === "OK") done.set(at, null);
      else if (kind === "ERR") done.set(at, rest.join("\t").trim() || "unknown error");
    }
    batch.forEach((path, at) => {
      if (!done.has(at)) result.failed.push({ path, message: "Not moved to the Recycle Bin." });
      else if (done.get(at) === null) result.trashed.push(path);
      else result.failed.push({ path, message: `Not moved to the Recycle Bin: ${done.get(at)}` });
    });
  }
  return result;
}
