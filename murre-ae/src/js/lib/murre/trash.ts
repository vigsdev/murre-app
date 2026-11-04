/**
 * Move files to the Trash (never a permanent delete). On macOS this asks Finder, so the files can be put
 * back from the Trash. Paths are passed as arguments to the script, never put into its text.
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

export type RunOsascript = (args: string[]) => void;

export interface TrashResult {
  trashed: string[];
  failed: { path: string; message: string }[];
}

const BATCH = 25;

export function trashFiles(platform: string, run: RunOsascript, paths: string[]): TrashResult {
  const result: TrashResult = { trashed: [], failed: [] };
  if (platform !== "darwin") {
    for (const path of paths) result.failed.push({ path, message: "Moving files to the Trash is only supported on macOS." });
    return result;
  }
  const args = (list: string[]) => SCRIPT.flatMap((line) => ["-e", line]).concat(list);
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    try {
      run(args(batch));
      result.trashed.push(...batch);
    } catch {
      // One bad file must not hold back the others: try them one at a time.
      for (const path of batch) {
        try {
          run(args([path]));
          result.trashed.push(path);
        } catch (e: any) {
          result.failed.push({ path, message: `Not moved to the Trash: ${e && e.message ? String(e.message).split("\n")[0] : e}` });
        }
      }
    }
  }
  return result;
}
