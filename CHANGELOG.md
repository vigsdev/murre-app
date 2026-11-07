# Changelog

What changed in each version of Murre. The newest is at the top.

The version of the After Effects Companion is in brackets where it changed. Murre installs and updates the Companion itself.

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
