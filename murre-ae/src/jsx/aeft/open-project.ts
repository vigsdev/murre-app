/**
 * "Open in After Effects" from the Murre app: opens a project file from inside After Effects, once it is ready.
 * (Asking the operating system to open the file, like a double-click, gets lost while After Effects is still
 * showing a startup message.)
 *
 * Whatever project is open is closed the way After Effects always does it: it asks to save only if there are
 * unsaved changes, and pressing Cancel there leaves everything as it was.
 *
 * Plain ES3-friendly style: this is compiled for ExtendScript.
 */

export interface OpenProjectResult {
  ok: boolean;
  /** The person pressed Cancel in After Effects' "save changes?" prompt. */
  cancelled: boolean;
  message: string;
}

const result = (ok: boolean, message: string, cancelled?: boolean): OpenProjectResult => ({ ok: ok, cancelled: cancelled === true, message: message });

const bringForward = () => {
  try {
    app.activate();
  } catch (e) {
    /* the project is open either way */
  }
};

export const openProject = (path: string): OpenProjectResult => {
  try {
    if (!path || !/\.aepx?$/i.test(path)) return result(false, "Only After Effects projects (.aep) can be opened.");
    const target = new File(path);
    if (!target.exists) return result(false, "That project file isn’t there any more.");

    const current = app.project.file;
    if (current && String(current.fsName).toLowerCase() === String(target.fsName).toLowerCase()) {
      bringForward();
      return result(true, "");
    }
    // A blank project that was never saved is simply replaced; anything else is closed with After Effects' own prompt.
    if (current || app.project.numItems > 0) {
      if (!app.project.close(CloseOptions.PROMPT_TO_SAVE_CHANGES)) {
        return result(false, "Kept your open project, so the other one wasn’t opened.", true);
      }
    }
    const opened = app.open(target);
    if (!opened) return result(false, "After Effects couldn’t open the project.");
    bringForward();
    return result(true, "");
  } catch (e) {
    return result(false, String(e && (e as any).message ? (e as any).message : e));
  }
};
