/**
 * Creates the first project file for a new Murre project, inside After Effects, so the file is
 * saved by the After Effects version the person actually uses.
 *
 * Whatever project is open is dealt with first, and never thrown away:
 *  - a saved project is saved and closed;
 *  - a project that was never saved is saved to the folder the app names (the Desktop) and closed;
 *  - an empty, unsaved project is simply reused.
 *
 * Plain ES3-friendly style: this is compiled for ExtendScript.
 */

export interface StarterResult {
  ok: boolean;
  path: string;
  message: string;
  /** Where the previously open project was saved before it was closed, if there was one. */
  previous: string;
}

export interface InspectResult {
  /** `empty`: nothing in it and never saved. `unsaved`: has content but was never saved. `saved`: has a file. */
  kind: string;
  name: string;
  path: string;
}

const fail = (message: string, previous?: string): StarterResult => ({ ok: false, path: "", message, previous: previous || "" });

export const inspectAe = (): InspectResult => {
  try {
    const file = app.project.file;
    if (file) return { kind: "saved", name: String(file.displayName), path: String(file.fsName) };
    if (app.project.numItems > 0) return { kind: "unsaved", name: "Untitled project", path: "" };
  } catch (e) {
    /* treat as empty */
  }
  return { kind: "empty", name: "", path: "" };
};

const pad = (n: number): string => (n < 10 ? "0" + n : String(n));

/** `Untitled-2026-10-28-12-30.aep` in `dir`, numbered if that name is taken. */
const rescueFile = (dir: string): File => {
  const d = new Date();
  const stamp = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "-" + pad(d.getHours()) + "-" + pad(d.getMinutes());
  let f = new File(dir + "/Untitled-" + stamp + ".aep");
  let n = 2;
  while (f.exists && n < 100) {
    f = new File(dir + "/Untitled-" + stamp + "-" + n + ".aep");
    n++;
  }
  return f;
};

export const createStarter = (
  path: string,
  compName: string,
  width: number,
  height: number,
  fps: number,
  seconds: number,
  rescueDir: string,
): StarterResult => {
  let previous = "";
  try {
    if (!path || !/\.aep$/i.test(path)) return fail("The project file must end in .aep.");
    const target = new File(path);
    if (target.exists) return fail("That file already exists, so it was not replaced.");
    if (!target.parent || !target.parent.exists) return fail("The project folder does not exist.");
    if (!(width > 0 && height > 0 && fps > 0 && seconds > 0)) return fail("The composition settings are not valid.");

    const state = inspectAe();
    if (state.kind === "saved") {
      app.project.save(); // keeps the person's work before the project is closed
      previous = state.path;
    } else if (state.kind === "unsaved") {
      const rescue = rescueFile(rescueDir);
      if (!rescue.parent || !rescue.parent.exists) return fail("Could not find a place to save the open project.");
      app.project.save(rescue);
      if (!rescue.exists) return fail("The open project could not be saved, so it was left open.");
      previous = String(rescue.fsName);
    }
    if (state.kind !== "empty") {
      // Only closed after it was saved above.
      app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    }
    if (state.kind === "empty") {
      /* reuse the blank project */
    } else if (!app.newProject()) {
      return fail("After Effects did not open a new project.", previous);
    }
    const comp = app.project.items.addComp(compName || "Main Comp", width, height, 1, seconds, fps);
    try {
      comp.openInViewer();
    } catch (e) {
      /* the viewer is not needed */
    }
    app.project.save(target);
    if (!target.exists) return fail("After Effects could not save the project file.", previous);
    return { ok: true, path: String(target.fsName), message: "", previous };
  } catch (e) {
    return fail(String(e && (e as any).message ? (e as any).message : e), previous);
  }
};

export interface ImportImageResult {
  ok: boolean;
  message: string;
  /** Name of the composition the image was added to. */
  comp: string;
  /** True when no composition was active, so a new one was made. */
  created: boolean;
}

const importFail = (message: string): ImportImageResult => ({ ok: false, message, comp: "", created: false });

/**
 * Imports an image and puts it in the composition that is active, centred. When no composition is
 * active, a 1920x1080 one is made first. One undo step in After Effects.
 */
export const importImage = (path: string, asShapes?: boolean): ImportImageResult => {
  let opened = false;
  try {
    const file = new File(path);
    if (!path || !file.exists) return importFail("That image file could not be found.");
    app.beginUndoGroup("Send to After Effects (Murre)");
    opened = true;
    const io = new ImportOptions(file);
    if (!io.canImportAs(ImportAsType.FOOTAGE)) return importFail("After Effects cannot import this kind of image.");
    io.importAs = ImportAsType.FOOTAGE;
    const item = app.project.importFile(io);

    let comp: CompItem | null = null;
    let created = false;
    const active = app.project.activeItem;
    if (active && active instanceof CompItem) comp = active;
    if (!comp) {
      const base = String(file.displayName).replace(/\.[^.]*$/, "");
      comp = app.project.items.addComp(base || "Image comp", 1920, 1080, 1, 10, 30);
      created = true;
      try {
        comp.openInViewer();
      } catch (e) {
        /* the viewer is not needed */
      }
    }
    const layer = comp.layers.add(item);
    layer.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width / 2, comp.height / 2]);
    if (asShapes) {
      // Layer > Create > Create Shapes from Vector Layer works on the selected layer of the comp that is showing.
      // The name is looked up first (English menus); 3973 is the number it has had in recent versions.
      const before = comp.numLayers;
      let done = false;
      try {
        try {
          comp.openInViewer();
        } catch (e) {
          /* the viewer may already be open */
        }
        for (let i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
        layer.selected = true;
        const id = app.findMenuCommandId("Create Shapes from Vector Layer") || 3973;
        app.executeCommand(id);
        done = comp.numLayers > before;
      } catch (e) {
        done = false;
      }
      if (!done) {
        return importFail(
          "The SVG is in the composition as a layer, but After Effects would not turn it into shapes. Choose Layer > Create > Create Shapes from Vector Layer.",
        );
      }
      // Keep the original vector layer, switched off, so nothing is lost.
      try {
        layer.enabled = false;
      } catch (e) {
        /* leave it as it is */
      }
    }
    return { ok: true, message: "", comp: String(comp.name), created };
  } catch (e) {
    return importFail(String(e && (e as any).message ? (e as any).message : e));
  } finally {
    if (opened) {
      try {
        app.endUndoGroup();
      } catch (e) {
        /* nothing to close */
      }
    }
  }
};

export interface SaveAsResult {
  ok: boolean;
  path: string;
  message: string;
}

/** Saves the open project as a copy at `path` (a "Save As"). The file it came from is not changed. */
export const saveProjectAs = (path: string): SaveAsResult => {
  try {
    if (!path || !/\.aep$/i.test(path)) return { ok: false, path: "", message: "The project file must end in .aep." };
    const target = new File(path);
    if (target.exists) return { ok: false, path: "", message: "That file already exists. Murre left it alone." };
    if (!target.parent || !target.parent.exists) return { ok: false, path: "", message: "The project folder does not exist." };
    app.project.save(target);
    if (!target.exists) return { ok: false, path: "", message: "After Effects could not save the project file." };
    return { ok: true, path: String(target.fsName), message: "" };
  } catch (e) {
    return { ok: false, path: "", message: String(e && (e as any).message ? (e as any).message : e) };
  }
};
