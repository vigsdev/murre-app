# Changelog

What changed in each version of Murre. The newest is at the top.

The version of the After Effects Companion is in brackets where it changed. Murre installs and updates the Companion itself.

## 0.3.1 (2026-11-17)

Companion 0.0.10.

### Windows

- **The Companion connects to Murre.** The panel couldn’t find the app on Windows: it never saw the folder Murre keeps its link in. Fixed. The panel’s Murre button can start Murre too.

### New

- **Murre reads your .aep files.** Without After Effects open, and without changing them:
  - Each version says which After Effects saved it (“AE 27.1 Beta”) and which version it was saved from, and warns when it was saved in an After Effects newer than the one you have.
  - Auto-saves show under the version they came from.
  - **What changed since v1** (in a version’s menu): comps added, removed or resized, new footage, effects and fonts.
  - A file that started as another project (a template, say) is marked “Other project file”.
  - Before a render starts, Murre checks the comp is still in the saved file, and uses its new name if you renamed it.
  - Projects that haven’t been scanned yet still show their fonts, plugins, After Effects version and footage.
  - Project cards show the format: “1920×1080 · 30 fps · 155 comps”.
  - ⌘K finds footage files, fonts and effects inside every project.
- **Assets tab, redone.** How much space each kind of file takes, a folder tree with sizes, thumbnails for images and video, a list or grid, search, and which files the project actually uses in After Effects.
- **Notes pages in a list** on the left, named by their first line. A small bar for bold, italic and the rest when you select text. Undo now survives switching pages.
- **Moodboard tools float over the board**: a rail on the left, the selection bar under what you selected, **Send to AE** right in it. R, O, L and A add shapes; Shift keeps a shape’s proportions.
- **Tabs:** ⌘T for a new tab, Ctrl+Tab to move between tabs, ⌘1–9 to jump to one.
- **Package** can be stopped while it copies. The half-made package is removed.

### Changed

- Quieter look: no coloured wash behind a project’s title, covers without a render show the project’s initials, and the quick switcher is a plain panel.
- Archiving a project warns when some of its files live outside its folder, since they aren’t archived with it.

## 0.3.0 (2026-11-16)

Companion 0.0.9.

### New

- **Murre To-do in After Effects.** A second panel (Window → Extensions → Murre To-do) shows the open project’s to-do list. Tick something off in After Effects and it’s ticked in Murre too.
- **To-dos for files that aren’t in Murre.** They’re kept in a `.murre` folder next to the `.aep`, and they come along if you add the project to Murre later.
- **Link previews on the Moodboard.** A link shows its picture, title and site. Referenxe is now called Moodboard.
- **Update progress.** Checking, downloading (with a percentage) and installing each show while they happen, and the update dialog shows what’s new.

### Changed

- **Open in After Effects** waits for After Effects to start, then opens the project inside it. No more clicking twice.
- Closing the Companion panel hands the link to Murre over straight away, so the app doesn’t show “not connected” for a few seconds.
- `.aep` files inside `02 Assets` (templates, mostly) no longer show up as versions, unless you marked one as current.
- Home: the date as the title, the greeting under it, and recent projects in a tidy grid.

### Windows

None of this has been tried on a real Windows PC with After Effects yet. Please tell us what breaks.

- **The Companion connects.** If Windows says the panel closed when it didn’t, the panel connects again. If the panel still can’t get through, the hidden helper keeps Murre connected meanwhile.
- **Open in After Effects** works, including starting After Effects first.
- **Cancel** stops a render and everything it started.
- Render thumbnails and details work without installing anything: Murre comes with FFmpeg for Windows.
- **Package** makes a `.zip`.
- Opening Murre while it’s already running shows the open window instead of starting a second copy.
- The Companion’s Murre button starts Murre when it isn’t running.
- Murre’s log notes when the Companion connects, disconnects or is turned away, and why.

## 0.2.0 (2026-11-07)

Companion 0.0.7.

### New

- **A new Companion panel.** One row of buttons: Scan, Link, Add to Render Queue, the render folder (P, R or D), Package and Open Murre. The background takes the colour of the project's status.
- **Add to Render Queue.** Adds the active comp to the Render Queue and sets its output to the project's `05 Pre-Renders`, `06 Renders` or `07 Deliverables` folder. Click P / R / D to choose which one.
- **Package and Open Murre from After Effects.** Package brings Murre forward on the open project with its Package window open.
- **Add this Project to Murre** opens a small window that asks for the project's name and folder.
- **Apple Calendar.** Murre can write project deadlines and your events into a "Murre" calendar (Settings → Calendar).
- **Create in After Effects** on a project's Project tab when it has no `.aep` yet.

### Changed

- Making a project's first `.aep` now waits for After Effects to finish starting, including any messages it shows at startup. You can cancel, or open After Effects yourself and tell Murre when it's ready.
- Organizing the Project panel keeps imported `.aep` bins whole inside `05 Templates`.
- Messages are plainer when checking for or installing an update fails.
- The browser's right-click menu no longer appears outside text fields.

### Windows

- The Companion installs from Murre, as on the Mac.
- Updating the Companion while After Effects has it open leaves the working copy in place.
- "Move originals" sends files to the Recycle Bin.
- No system error boxes from the FFmpeg stand-ins.

### Fixed

- The Companion no longer fails inside After Effects with "process is undefined".

## 0.1.1 (2026-11-04)

The first build made by the release workflow. It wasn't published.

- Projects: a tidy folder for each new project, or add an existing one without moving files.
- Versions of the `.aep`, with the current one marked by you.
- Notes, to-dos and reference boards kept inside each project.
- Renders with thumbnails, approval, and rendering Main Comps with `aerender`.
- Colors, expressions and fonts collected by the Companion.
- Copy footage from outside the project into it and relink.
- Home, Calendar and Spaces.
- Updates through GitHub releases.
- A first Windows build.
