/**
 * "Add to Render Queue" from the panel: queues the active composition and points its output into one of the Murre
 * project's render folders. Only the new queue item is touched; everything else in the queue stays as it is.
 *
 * Plain ES3-friendly style, like the other files here (it is compiled for ExtendScript).
 */
import { freeFileName } from "../../shared/render-folders";

export interface QueueResult {
  ok: boolean;
  /** Why it failed. */
  message: string;
  comp: string;
  /** Where the render will be written. */
  file: string;
}

const failed = (message: string): QueueResult => ({ ok: false, message: message, comp: "", file: "" });

/** Every output file already in the queue, so two items don't write to the same file. */
const queuedFiles = (): string[] => {
  const files: string[] = [];
  const rq = app.project.renderQueue;
  for (let i = 1; i <= rq.numItems; i++) {
    const item = rq.item(i);
    for (let j = 1; j <= item.numOutputModules; j++) {
      try {
        const f = item.outputModule(j).file;
        if (f) files.push(f.fsName.toLowerCase());
      } catch (e) {
        /* an output module without a file */
      }
    }
  }
  return files;
};

const contains = (list: string[], value: string) => {
  for (let i = 0; i < list.length; i++) if (list[i] === value) return true;
  return false;
};

/** Queue the active composition, rendering into `folderPath` (created if missing). The output module and its format are After Effects' default. */
export const addActiveCompToQueue = (folderPath: string): QueueResult => {
  const comp = app.project.activeItem;
  if (!(comp instanceof CompItem)) return failed("Select a composition or open one in the timeline first.");
  const rq = app.project.renderQueue;
  if (rq.rendering) return failed("After Effects is rendering. Add it when the render is done.");
  const folder = new Folder(folderPath);
  if (!folder.exists && !folder.create()) return failed("Couldn't create the folder " + folder.fsName + ".");

  const queued = queuedFiles();
  app.beginUndoGroup("Murre: Add to Render Queue");
  try {
    const item = rq.items.add(comp);
    const om = item.outputModule(1);
    // Keep the name and extension After Effects chose for its default output; only the folder changes.
    const current = om.file;
    const name = current ? File.decode(current.name) : comp.name.replace(/[\\\/:*?"<>|]/g, "_");
    const free = freeFileName(name, (c) => {
      const f = new File(folder.fsName + "/" + c);
      return f.exists || contains(queued, f.fsName.toLowerCase());
    });
    om.file = new File(folder.fsName + "/" + free);
    return { ok: true, message: "", comp: comp.name, file: om.file ? om.file.fsName : folder.fsName + "/" + free };
  } catch (e) {
    return failed("Couldn't add it to the Render Queue: " + String(e));
  } finally {
    app.endUndoGroup();
  }
};
