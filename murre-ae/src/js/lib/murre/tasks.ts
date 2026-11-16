/**
 * The to-do list for the Murre To-do panel: the same `.murre/tasks.json` the Murre app shows on a project's Project tab,
 * in the same format, so a task ticked on one side is ticked on the other.
 *
 * Where the list lives:
 *  - the open `.aep` belongs to a Murre project: that project's `.murre/tasks.json`;
 *  - it doesn't: a `.murre/tasks.json` next to the `.aep` (made when the first task is added). Without a `project.json`
 *    that folder is not a Murre project, and when the project is added to Murre later its to-dos come along.
 *
 * Every change re-reads the file first and writes the whole list back safely, like the app does, so the two don't undo
 * each other's edits.
 */
import type { Io } from "./io";
import { findProject } from "./project-link";
import { readSnapshot, writeSnapshot } from "./snapshot-store";

export const SCHEMA_VERSION = 1;
export const MAX_TITLE = 200;
export const MAX_TASKS = 1000;

export interface Task {
  id: string;
  title: string;
  done: boolean;
  /** Unix seconds. */
  createdAt: number;
  completedAt: number | null;
}

export interface TaskPlace {
  /** The folder whose `.murre/tasks.json` holds the list. */
  root: string;
  /** The open file belongs to a Murre project (its name is `name`); otherwise `name` is the file's. */
  inMurre: boolean;
  name: string;
}

/** Where the to-dos of the open `.aep` live. Throws when the Murre project's data can't be read. */
export function placeFor(io: Io, aepPath: string): TaskPlace {
  const found = findProject(io, aepPath);
  if (found.kind === "linked") return { root: found.link.root, inMurre: true, name: found.link.projectName };
  if (found.kind === "error") throw new Error(found.message);
  return { root: io.path.dirname(aepPath), inMurre: false, name: io.path.basename(aepPath).replace(/\.aepx?$/i, "") };
}

const now = () => Math.floor(Date.now() / 1000);

function newId(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Older engines: a random version 4 UUID by hand.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Reads one task defensively; anything malformed is skipped. */
function parseTask(v: unknown): Task | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id || typeof o.title !== "string" || typeof o.done !== "boolean") return null;
  return {
    id: o.id,
    title: o.title,
    done: o.done,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
    completedAt: typeof o.completedAt === "number" ? o.completedAt : null,
  };
}

/** The list, oldest first. A missing file is an empty list; a damaged one falls back to its `.bak`, like the app. */
export function readTasks(io: Io, root: string): Task[] {
  let raw: unknown;
  try {
    raw = readSnapshot(io, root, "tasks.json");
  } catch (e) {
    raw = readSnapshot(io, root, "tasks.json", ".bak");
    if (raw === null) throw e;
  }
  if (raw === null) return [];
  const file = raw as Record<string, unknown>;
  if (typeof file.schemaVersion === "number" && file.schemaVersion > SCHEMA_VERSION) {
    throw new Error("These to-dos were saved by a newer version of Murre. Update the Companion.");
  }
  if (!Array.isArray(file.tasks)) return [];
  return file.tasks.map(parseTask).filter((t): t is Task => t !== null);
}

/** Checks a new task's text the way the app does, and returns it trimmed. */
export function cleanTitle(raw: string): string {
  const t = raw.trim();
  if (!t) throw new Error("Type a task first.");
  if (t.length > MAX_TITLE) throw new Error(`A task can be ${MAX_TITLE} characters at most.`);
  if (/[\u0000-\u001f\u007f]/.test(t)) throw new Error("The task has characters it can't keep.");
  return t;
}

/** Reads the newest list, changes it with `change`, and writes the whole list back. Returns the new list. */
function update(io: Io, place: TaskPlace, change: (tasks: Task[]) => Task[]): Task[] {
  const next = change(readTasks(io, place.root));
  // Next to a file that isn't in Murre, the `.murre` folder is made on the first write.
  const dir = io.path.join(place.root, ".murre");
  if (!place.inMurre && !io.fs.existsSync(dir)) io.fs.mkdirSync(dir);
  writeSnapshot(io, place.root, "tasks.json", { schemaVersion: SCHEMA_VERSION, tasks: next });
  return next;
}

export function addTask(io: Io, place: TaskPlace, title: string): Task[] {
  const clean = cleanTitle(title);
  return update(io, place, (tasks) => {
    if (tasks.length >= MAX_TASKS) throw new Error(`A list can have ${MAX_TASKS} tasks at most.`);
    return [...tasks, { id: newId(), title: clean, done: false, createdAt: now(), completedAt: null }];
  });
}

export function setDone(io: Io, place: TaskPlace, id: string, done: boolean): Task[] {
  return update(io, place, (tasks) => {
    if (!tasks.some((t) => t.id === id)) throw new Error("That task isn't there any more.");
    return tasks.map((t) => (t.id === id && t.done !== done ? { ...t, done, completedAt: done ? now() : null } : t));
  });
}

export function deleteTask(io: Io, place: TaskPlace, id: string): Task[] {
  return update(io, place, (tasks) => tasks.filter((t) => t.id !== id));
}
