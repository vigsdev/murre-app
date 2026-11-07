/**
 * The "Add this Project to Murre" popup: a separate small window (a CEP modal dialog) that asks for the project's name and folder.
 * It talks to the panel with After Effects' extension events: when it opens it says it is ready, the panel answers with the
 * suggested name, and on Add it sends back the name and folder, then closes itself. The panel does the actual work.
 */

/** The popup's extension id: the bundle id plus the panel name in cep.config.ts. */
export const ADD_DIALOG_ID = "com.murre.cep.add";

export const ADD_EVENTS = {
  /** popup → panel: open and listening. */
  ready: "murre.add.ready",
  /** panel → popup: `{ name }`, the suggested project name. */
  init: "murre.add.init",
  /** popup → panel: `{ name, dir }`. */
  result: "murre.add.result",
} as const;

export interface AddChoice {
  name: string;
  dir: string;
}

export const MAX_NAME = 100;

/** Reads the popup's answer; anything malformed gives null and is ignored. */
export function parseAddChoice(data: unknown): AddChoice | null {
  try {
    const v = typeof data === "string" ? JSON.parse(data) : data;
    if (!v || typeof v !== "object") return null;
    const name = typeof v.name === "string" ? v.name.trim() : "";
    const dir = typeof v.dir === "string" ? v.dir : "";
    if (!name || name.length > MAX_NAME || !dir) return null;
    return { name, dir };
  } catch {
    return null;
  }
}

/** Reads the panel's suggested name. */
export function parseInit(data: unknown): string {
  try {
    const v = typeof data === "string" ? JSON.parse(data) : data;
    return v && typeof v.name === "string" ? v.name.slice(0, MAX_NAME) : "";
  } catch {
    return "";
  }
}

/** A long path, shortened in the middle so both the drive and the folder name stay visible. */
export function shortPath(p: string, max = 44): string {
  if (p.length <= max) return p;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.4);
  return p.slice(0, head) + "…" + p.slice(p.length - (keep - head));
}
