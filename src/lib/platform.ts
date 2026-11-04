/**
 * The few words and keys that differ between macOS and Windows. Read once from the web view's own platform string.
 */
const platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent || ""

export const isMac = /Mac/i.test(platform)
export const isWindows = /Win/i.test(platform)

/** "Finder" or "File Explorer". */
export const fileBrowser = isWindows ? "File Explorer" : "Finder"
/** "Show in Finder" or "Show in File Explorer". */
export const showInFileBrowser = `Show in ${fileBrowser}`
/** "this Mac" or "this PC". */
export const thisComputer = isWindows ? "this PC" : "this Mac"
/** The modifier key shown in shortcut hints. */
export const modKey = isMac ? "⌘" : "Ctrl+"
/** How to get FFmpeg when Murre's own copy won't start. */
export const installFfmpegHint = isWindows ? "install FFmpeg and add it to PATH" : "install FFmpeg yourself (brew install ffmpeg)"

/** The file name at the end of an absolute path, whichever separator the system uses. */
export const baseName = (path: string) => path.split(/[\\/]/).pop() || path
