
## Menu bar behaviour

- Closing the window (red button, Cmd+W) hides it and, on macOS, removes the Dock icon; Murre keeps running from the menu bar. Cmd+Q or "Quit Murre" in the menu bar icon's right-click menu really quits. Left-clicking the menu bar icon reopens the window.
- Because the window hides instead of closing, running renders and the companion link keep going. Quitting stops them.
- The menu bar icon is a placeholder "S" (`src-tauri/icons/tray.png`, template image). Replace it with a final black-on-transparent icon.
- Window translucency uses `macOSPrivateApi`, which the Mac App Store does not accept. Fine for direct downloads.

## "Open After Effects and start using" (project file made by After Effects itself)

- There are no bundled starter `.aep` files any more. New Project has one checkbox, ticked by default. When it is ticked, creating a project makes the folder and then After Effects creates and saves `01 AE Workfile/<ProjectName>-v1.aep` with one comp (`Main Comp`, 1920×1080, 30 fps, 30 s). That file is marked as the current AEP and After Effects stays open on it. Because After Effects saves it, there is no "made in an older version" prompt. The comp settings are fixed in `create_starter_in_after_effects` (`lib.rs`).
- Before anything is created the app asks After Effects what is open (`check_after_effects`):
  - not running: it is launched (the chosen version) and the app waits up to 2 minutes for the Companion to connect;
  - running with nothing open, or an empty never-saved project: that blank project is reused;
  - running with a saved project: a confirm dialog, then the project is saved and closed, and the new one is created;
  - running with a project that was never saved: a confirm dialog, then it is saved to the Desktop as `Untitled-<date-time>.aep`, closed, and the new project is created. A toast says where it went;
  - running but the Companion is not connected: nothing is created and the message says to restart After Effects once.
- The Companion is required. Onboarding has a last step that installs it (Finish stays disabled until it is installed; "Install it later from Settings" appears only if the install itself failed). Settings has an "After Effects Companion" section, and New Project disables the checkbox and shows the install button when it is missing.
- Installing copies the Companion shipped in the app into `~/Library/Application Support/Adobe/CEP/extensions/com.murre.cep` (no administrator password) and sets `PlayerDebugMode` for CSXS 9–13 with `defaults write`, because the extension is not signed. A symlink in that folder (the developer link made by `npm run symlink`) is never replaced. A signed ZXP would remove the debug setting; that is not done.
- Shipping the Companion: run `npm run bundle` in `murre-ae/`. It builds and copies the extension to `src-tauri/companion-bundle/`, which `tauri.conf.json` ships as a resource. Run it again whenever the Companion changes (and bump its version so installed copies update). Without the folder the install button says the build has no Companion.
- The Companion has a hidden background extension (`com.murre.cep.background`, type Custom, starts on `ApplicationInitialized`, no window). It keeps the link to the app while the panel is closed. The open panel announces itself every 3 s (`murre.panel.alive` CEP event); while it is heard the helper drops its connection so the two never fight over the link, and it takes over about 9 s after the panel goes away.
- The hidden helper does everything the panel does for the app (scan, copy and relink, cancel, create a project, say what is open), so nothing needs the panel docked. It reports which Murre project is open every ~4 s. Per-project options live in the project's Settings tab (see below).
- Not verified: the helper's scans on a real project, and that two extensions do not both write `.murre` files at once (they never run together: the helper drops its link while the panel is open).
- Not verified on a real Mac with After Effects (this was built without one): that After Effects loads the hidden Custom extension on start, that the cross-extension event arrives, that `open -a <After Effects.app>` launches the right version, that `app.project.close()` works with no dialog in the way, and that the `ps` check recognises your After Effects process. After installing or updating the Companion, restart After Effects once.
- ExtendScript has no reliable "unsaved changes" flag, so a saved project is always saved before it is closed; the dialog does not say whether it had changes.
- If a different After Effects version is already running than the one chosen in the dropdown, the running one is used.
- Old build leftovers: `get_starter_options` and `add_starter_file` are gone (now `get_ae_installs`); onboarding asks for the After Effects version only when more than one is found.


## Project Settings tab

- Stored per project in `.murre/settings.json` (`copyRelinkOnScan`, `trashOriginals`, `autoScanMinutes`). The Companion reads the file before each scan, so changes apply to the next scan. The old global `companion-settings.json` is no longer used.
- **Move originals to the Trash** is off by default and only works with copy and relink on. An original is moved only after its copy is checked, through Finder (`osascript`), so it can be put back. Other projects using the same file lose it until it is restored.
- **Auto scan** (Off/5/10/20 min, the same list as the panel menu; a project saved earlier with 15 or 30 keeps working and still shows) runs from the app (`start_auto_scan`) while the project is open in After Effects and the Companion is connected. The UI warns that huge footage can interrupt work.
- Not verified against real After Effects: Trash via Finder, and timing of auto scans on large projects.

## Send to After Effects (reference images)

- Right-click an image on a reference board → "Send to After Effects". The Companion (panel or hidden helper) imports it into the active composition and centres the layer; with no active composition it makes a 1920×1080, 30 fps, 10 s one named after the image. One undo step.
- If a project has comps but none is active (for example the Project panel is focused), a new comp is made rather than guessing which one to use.
- Needs After Effects running with the Companion connected. After Effects cannot import WebP, so those images report an error from After Effects.
- Not verified against real After Effects.

## Add an existing project to Murre

- Two entries, one implementation (`add_project.rs`): the Companion panel's "Add this project to Murre" card (shown when the open project is not in Murre), and "From After Effects" on the Projects page.
- Flow: ask the Companion what is open → create the Murre project folder → Companion does a Save As into `01 AE Workfile` (keeps the original file name; the original `.aep` is never written to) → wait for the Companion to report the new file → scan → copy and relink. Progress goes to the app (toast, `add-project-progress` event) and to the panel.
- Default name is the file name without extension and version suffix; the person can edit it. Never-saved projects are saved as `<name>-v1.aep`.
- If a step after the save fails, the project still exists and the message says which step failed; scan or relink can be run again from the panel or app.
- Limits: opening the original is not involved (the project must already be open in After Effects). No cancel while it runs. Image sequences are not copied (same as relink). The copy step has no size prompt yet (projects are expected to be small). Not verified against real After Effects: Save As via `app.project.save(File)`, the folder dialog in the panel (`cep.fs.showOpenDialogEx`).

## Notes pages (global Notes and each project's Notes tab)
- Page 1 is the original note and cannot be deleted. A round `+` on the right adds the next page (up to 20); `<` and `>` move between pages; `×` at the top right deletes any page except the first, with a confirmation only when the page has text. Numbered chips at the top left jump to a page (hover shows its first words).
- Stored in the same `.murre/notes.json`: page 1 stays in `content`, the others in `pages`. Files from before this change load unchanged.
- Switching, adding or deleting a page first saves what you typed. If that save fails or conflicts, the page change waits.
- Limitation: undo history is per page and is lost when you switch pages.

## Other versions when adding a project
- When a project is added from After Effects (the app's "From After Effects" dialog or the Companion panel's card), other `.aep` files saved in the **same folder** as the open file are listed with a checkbox each. The dialog and the panel show one tick, "Copy all N other versions (size)", which is **on by default** (most folders hold one project's versions, and an extra small file is easy to delete). "Choose which…" opens the list with Select all / Select none and a tick per file; unticking everything copies none. Files whose names look like versions of the open one are listed first.
- Ticked files are copied into `01 AE Workfile` with their own names (the version list reads them from the names). Existing files are never replaced, links and hidden/auto-save files are skipped, and at most 30 are listed or copied (`versions.rs`). The originals are only read.
- Limits: only the same folder is searched (not subfolders or other folders). Date is shown but never used to decide whether a file is a version, because dates change when folders are copied.
- The copied older versions are **not relinked**: only the project open in After Effects can be. They keep pointing at their original footage, so they open fine while that footage is still in place. To bring an older version's footage in, open it in After Effects and use copy and relink (the new project's "move originals to the Trash" setting is off by default, so nothing is trashed in the meantime).
- Version detection ignores a note in brackets at the end of a name (`Band 6 (converted)` is v6 of `Band`; `Film (2)` is not a version). A number only counts as a version after a separator and with 1–3 digits. The suggested project name drops the same notes and numbers.
- Not verified against real After Effects projects with many versions.

## Companion panel: organize, main comps, menu
- Every scan first sorts the After Effects project panel into bins that mirror the Murre folders (`01 Comps`, `01 Comps/Precomps`, `02 Assets/...`, `Solids`). It moves items only, adds no undo step when nothing needs moving, and does not save the project. Items in the person's own bins are moved out of them (by design).
- Main comps are picked by default: a comp not used by any other comp. Existing choices are kept; only comps never seen before get the default, and a project with no Main Comp at all gets it for every comp on the next scan (so unticking the only main comp in the app brings it back on the next scan).
- Right-click menu in the panel: "Relink assets manually" and "Scan every 5/10/20 min" (one at a time). They are not separate preferences: they read and write the linked project's `.murre/settings.json`, the same file as the app's Settings tab. "Relink assets manually" is ticked when "Copy and relink automatically on every scan" is off (ticking it turns that off; unticking turns it on, and the Trash option is switched off with it, as in the app). The Relink button shows only while it is ticked. With no linked project the items are greyed out. The panel re-reads the file every few seconds, and the app's Settings tab re-reads it when the window gets focus.
- Auto scan: the app's timer does the scanning while it is connected. When the app is not running, the panel runs the same interval itself, so nothing scans twice.
- Not verified against real After Effects: the bin sorting on big projects, the context menu check marks, and how long a timed scan freezes the interface.

## Renders tab: choosing what to render
- The Main Comps are picked from a drop-down (with a **Render…** button beside it) instead of a list, so a project with many Main Comps stays compact. The chosen comp's size, frame rate and length show underneath.
- The render dialog asks **Save as: Pre-render, Render or Deliverable** (default Render). That points "Save in" at `05 Pre-Renders`, `06 Renders` or `07 Deliverables`; the folder can still be changed with "Choose…". Picking a type again resets the folder to that type's.
- A finished, failed or cancelled render has a **Clear** button on its card. It only removes the card (and the in-memory output tail); the rendered file and the log file stay on disk. A render that is still running cannot be cleared (cancel it first). There is no queue: one render runs at a time.

## Open at login, quietly in the menu bar

- **What it does.** A login item (a macOS Launch Agent written by `tauri-plugin-autostart`) starts Murre with `--hidden`. In that case the window stays hidden, there is no Dock icon, and only the menu bar icon shows. Started any other way, the window opens as before (`tauri.conf.json` now has `"visible": false`; `setup` shows or hides it).
- **Off by default.** After the profile exists, a one-time dialog asks "Open Murre when I log in?" (Open at login / Not now). The answer is remembered (`login_item_asked` in the `settings` table), so it is never asked twice. Settings → Startup has the checkbox to change it any time.
- **Development builds can't enable it.** `available` is false when built with debug assertions (`yarn tauri dev`), because a login item pointing at a dev binary would be useless. Test it with the installed app in `/Applications`.
- **Unsigned app.** macOS may show a "Background item added" notice, and the item appears under System Settings → General → Login Items. If the person turns it off there, the checkbox follows (it reads the real state).
- **After the rename.** The login item is tied to the app name and identifier (now `com.vigs.murre`). A login item made by a build with the old name stays in System Settings → General → Login Items; turn it off there.

## Premiere Pro projects when adding from After Effects

- **When it shows.** "From After Effects" also looks for `.prproj` files in the same folder as the open `.aep`, in its direct subfolders (a `PR` folder, say; not deeper) and in the folder one level above. If any are found, the dialog lists them (footage count, size, how many files are not found). **Nothing is ticked by default**, because collecting copies the footage.
- **What collecting does** (`premiere.rs`), for each ticked project, inside `04 Premiere & SFX`:
  - `Original/<name>.prproj`: the untouched file, byte for byte.
  - `Footage/…`: the footage the project uses, copied (the file's date is kept; a clash becomes `name (2).ext`; two projects using the same clip share one copy).
  - `<name>.prproj`: a copy whose `ActualMediaFilePath`, `FilePath` and `RelativePath` (inside `<Media>` elements only) point at the copies. Everything else in the XML is kept as it was. The file the person picked is never changed.
- **Left alone:** footage that is not found on this Mac (its path is kept), footage already inside the new project folder, and clips that are another project (After Effects links, `.aep`). Premiere's cache and peak files are not touched; Premiere rebuilds them.
- **Verified in Premiere (small project).** A real project with a Premiere file beside the `.aep` (2 footage files) was collected and the saved copy opened in Premiere with its clips online. Reading and rewriting were also checked on a 26-clip project and with unit tests. The cases in the list below are still to be tested.
- **Known limits:**
  - Image sequences: only the first frame's file is copied, so a sequence would stay incomplete.
  - Projects made on Windows: their paths are not found here, so they are reported as not found.
  - Footage is copied flat into `Footage/` (folder structure is not kept).
  - Only the "From After Effects" button in the app offers this. The Companion panel's "Add project" does not ask about Premiere.
  - The format is not documented by Adobe; a future Premiere version that moves these tags would show as "not found"/unchanged rather than breaking the file.

### The Premiere card on the Project tab

- A "Premiere Pro projects" card sits under "After Effects versions" **only when** `04 Premiere & SFX` holds at least one `.prproj` (directly inside it: the untouched copies in `Original/` are not listed). Projects without Premiere files look as before.
- Each row: name, date, size, number of footage files found, "N not found" when some are missing, and "N linked projects" for After Effects links. A file that cannot be read as a Premiere project shows "Could not read".
- The menu has **Open** (the Mac's default app for `.prproj`, which is not necessarily Premiere) and **Show in Finder**. Nothing in the card changes a file. The refresh button re-reads the files; it also refreshes with the rest of the Project tab.
- Only `04 Premiere & SFX` is looked at, so a `.prproj` saved elsewhere in the project is not listed.

### Still to test with a bigger test project (the person is making one)

What I expect from each, so a different result is worth reporting:

1. **Image sequence as footage, in both After Effects and Premiere.** Expected to fail in Premiere: only the first frame's file is copied, so the sequence stays incomplete. After Effects is the existing "image sequences" item in the deferred list. Needs a sample to see how each stores a sequence before fixing.
2. **Offline clips.** Expected to be fine: a clip whose file is not found keeps its old path, is counted as "not found", and shows offline in Premiere as it did before.
3. **Dynamic Link.**
   - *After Effects comp linked in Premiere:* the clip is not copied and keeps pointing at the original `.aep`. Its own footage is not known without opening it in After Effects, so it is not collected. Needs a sample `.prproj` with a linked comp.
   - *Premiere project linked in After Effects:* not handled anywhere yet. We do not know how the After Effects scan treats it; test what it does today.
4. **Same file name from different folders.** Expected: second copy becomes `name (2).ext`, both clips stay online. Unit-tested, not tried in Premiere.

## The log and "Copy report"

- **What is logged** (`applog.rs`): app start and version, each step of "add project from After Effects" and its outcome, Premiere collect counts (copied, already inside, linked, not found, failed), render outcomes (finished/failed/cancelled and exit code), login item changes, a failure to start the Companion link, and **panics** (with their location). It is a plain text file in the app's data folder under `logs/` (`murre.log`, rotated at 1 MB, 5 files kept). Nothing is sent anywhere.
- **No names.** Files are logged as extension and size only (for example `.mp4 file, 2.5 MB` or `.mov file, not found`), and project names are not logged. On top of that, **Settings → About → Copy report** removes anything that still looks like a path (`/Users/…`, `/Volumes/…`, `~/…`, from there to the end of the line) before copying. The report starts with the app version, macOS version and CPU type.
- **Not logged yet:** scans and relinks done from the Companion panel, the auto-scan, and notes/colors/expressions changes. Add them as problems show up.
- **Later, with the launch work:** an opt-in checkbox (off by default, separate from marketing consent) could send this same redacted report after a crash or a failure the person confirms. Not built: it needs a server, a privacy page and a retention decision. It is the same item as the opt-in usage ping on the deferred list.

## A project whose folder has gone

- The app already noticed missing folders (the check runs at start-up, when the window is focused and every minute) and showed "Folder not found" on the card, with **Locate folder…** in its menu. Now it also **asks**: a dialog, one project at a time, says "Can't find “Project-01”", where it used to be, and offers **Relink…** (opens the folder picker; the chosen folder must hold the same project, matched by the ID in `.murre/project.json`), **Yes, remove from Murre** (forgets the project in the app only, nothing on disk is deleted) and **Not now**.
- **Not now** is there on purpose: a project on a drive that is not plugged in looks the same as a deleted one. It is skipped until the app is opened again. The dialog's close button counts as Not now.
- **Archived projects are not asked about.** They stay as before: "Folder not found" on the card.
- A project whose folder was moved *and* that has no `.murre/project.json` any more cannot be relinked (there is nothing to match its ID against). It can only be removed, then added again as a new project.
- The app does not search the disk for a moved folder. The person points at it.

## Text rewrite (copy deck)

- The person's rewritten wording (`murre-copy-deck.csv`, 118 rows changed) is applied across the app, the engine's messages and the After Effects panel.
- Tests that checked exact wording were updated (`already rendering`, `not inside a Murre project`, `changed mid-scan`).
- `murre-copy-deck.csv` was made by a script from the code, so new text added later is not in it. Strings built from several pieces may be missing.

## Rename from Sequenxe to Murre

- **Everything people can see says Murre**, and so do the code, file names and identifiers: product name, bundle identifier `com.vigs.murre`, crate `murre` / `murre_lib`, the Companion's extension id `com.murre.cep` (version 0.0.3), the hidden project folder **`.murre`** (it was `.sequenxe`), the log file, the database file (`murre.db`), the Companion's folder `src/js/lib/murre`, and the brief and Companion docs (`MURRE-PRODUCT-BRIEF.md`, `MURRE-COMPANION.md`).
- **Project folders must be renamed by hand**: in every existing project, rename the hidden folder `.sequenxe` to `.murre`. Until then the app shows that project as "Can't find…" (it looks for `.murre/project.json`). Do it before opening the new build.
- **App data moves by itself** (`app_data::migrate_legacy`): the first start renames the old data folder `com.vigs.sequenxe` to `com.vigs.murre`, and `sequenxe.db` to `murre.db`. Nothing is copied or deleted, and nothing happens if the new folder already exists. The profile, project list, notes and settings carry over.
- **The old Companion panel is removed on install** (`companion_install::remove_legacy`): the install deletes a folder named `com.sequenxe.cep` in After Effects' extensions folder, only if its manifest says it is ours. Otherwise After Effects would list two panels. The panel text in the window menu is now "Murre".
- **Kept as they were, on purpose**, because they are written inside people's files and not shown anywhere: the board format tag `sequenxe-board` and the older image link prefix `asset:sequenxe-ref/` (renaming them would stop existing reference boards opening). The names of the folders `sequenxe` (the repository) and `murre-ae` were not changed either.
- **Small things that reset**: the remembered open/closed state of Spaces in the sidebar and the "open with After Effects" choice (their stored names changed).
- **Still to do by hand**: the old `src-tauri/companion-bundle/` is rebuilt by `npm run bundle` in `murre-ae/`, so run it before the next app build.

## Fonts tab

- The Fonts tab lists the fonts the Companion found in the project, read from `.murre/fonts.json`. The Companion writes the file during a scan (after `comps.json`), so existing projects need one rescan before fonts appear. Companion version is now 0.0.4: run `yarn build` in `murre-ae` and restart After Effects.
- After Effects 24.5 and newer lists every font in the project (`app.project.usedFonts`). Older versions only report the first font of each text layer, so the tab shows a "may be incomplete" notice (`method: "layers"`). Not yet tried inside a real After Effects: the `usedFonts` path is tested against a fake only.
- "Not on this Mac" and "Show in Finder" are worked out each time the tab is read, from the font's file location. Adobe Fonts and fonts with no reported location are never flagged. "Missing when scanned" means After Effects had substituted the font at scan time.
- Per font, at most 200 layers are listed; the count beyond that is shown as "and N more". At most 2,000 fonts are kept.
- Font previews: each card draws a sample line with the font through the web view's own `local("PostScriptName")` lookup (no files are read or copied). If the web view can't find the font (not installed, or an Adobe Fonts font not activated), the card says "No preview". Not yet tried in the real app.

## "What this project needs" card and version notes

- The Project tab's **What this project needs** card combines `.murre/environment.json` (written by the Companion on every scan: third-party effects and the After Effects version) with `fonts.json`. Needs a rescan with Companion 0.0.5 (`yarn build`, restart After Effects).
- Plugins = effects whose internal name does not start with `ADBE`, `Pseudo/` (preset effects that live inside the project, e.g. Animation Composer, Duik) or `CC ` (Cycore, ships with After Effects; also matched by the displayed name starting with "CC ", and the older Cycore internal prefix `CS `), switched on or off. The filter is also applied when the app reads the file, so no rescan is needed. A preset effect whose internal name does not start with `Pseudo/` would still be listed (hover a plugin to see its internal name). Other bundled plugins (Cineware and similar) may still appear. Whether a plugin is installed here is a soft guess from file and folder names in the Adobe plug-in folders: the card says "Found here" or "Can't confirm it's installed", never "missing". How After Effects flags a missing effect when a project is opened has not been tested.
- The After Effects version shown is the one that had the project open during the last scan, not the version the file was saved in (After Effects doesn't expose that to scripts; it could be read from the `.aep` header later). "Newest here is 20xx" appears only when every `Adobe After Effects 20xx` folder in /Applications is older than that version.
- Version notes are stored in `.murre/workfiles.json` under `notes`, keyed by the file's project-relative path (max 280 characters, one line). Renaming or moving a `.aep` leaves its note behind under the old path. The newest version asks "What changed in vN?" until it has a note; there is no pop-up when a new version appears.

## Jump to After Effects, and tidier usage lines

- Colors, Expressions and Fonts now list each place as "layer name" with "comp · readable path" underneath ("Contents" groups are dropped: `Group 4 / Stroke 1 / Color`). The arrow button on a place opens that composition in After Effects, selects the layer and, where it can, the property.
- It needs: the Companion connected, this project open in After Effects, and a scan made with Companion 0.0.6 (older scans don't record the composition id and layer position, so the button is greyed out with "Scan this project again to jump to it").
- If layers were reordered since the scan, the layer is found by name instead (and a note says so). If the property can't be found (renamed since), only the layer is selected. If the layer or composition is gone, it says so. Nothing in the project is changed except which comp is showing and what is selected.
- Not tried in a real After Effects yet: whether selecting a deeply nested property expands it in the timeline, whether `app.activate()` brings the window to the front from the panel, and that two layers with the same name in one comp are told apart by position only (the name check stops it jumping to the wrong layer if it moved).
- Fonts: on After Effects 24.5+ the places come from the project's own font list and include the layer position; older After Effects reads text layers directly, so the same applies. No property is selected for fonts (only the layer).

## Package for delivery

- **Package** button in the project header. It checks first, then copies. The project is only read, never changed.
- What goes in: the current workfile (the one marked current, else the newest), the footage the last scan found inside the project folder (same relative folders, so After Effects finds it), the Premiere Pro folder when it holds a `.prproj` (without `Original/`), optionally the other versions, optionally the fonts installed on this Mac in `Fonts/`, and a `READ ME - what this project needs.txt` (After Effects version, fonts, plugins, footage, anything missing).
- Footage outside the project folder can't be packaged so that it still links, and missing footage can't be packaged at all. Both are listed and block the button until "Package it anyway" is ticked. Fix outside footage with copy-and-relink first (Assets tab).
- It relies on the last scan: unscanned projects ask for a scan; a workfile saved after the last scan shows "scan again" (compared with the scan time, 5 s of slack).
- Fonts: bundled only when installed on this Mac. Not bundled: Adobe Fonts, anything under `/System/` (comes with macOS), fonts not found on disk. Font licenses are the designer's call; the dialog says so. The `.ttc` collections are copied whole.
- Zip uses macOS `ditto -c -k --keepParent` (the zip opens fine on Windows). "Zip" alone makes the folder first, zips it, then removes that folder (our own). A failed build removes its half-made folder.
- Default location is the project's `07 Deliverables` (made if missing). Names never overwrite: "X - Delivery", "X - Delivery 2"…
- Not done / not tried: cancelling a long copy, hard links or reflinks instead of copies for big footage, image sequences from outside the project, expressions that read files by path, Windows recipients with different path habits, and a real run on a big project (only tested with small fake ones; `ditto` itself is untested here because the test machine has no macOS).

## Recent projects on Home
- Opening a project's page saves its id in Murre's own settings (`recent_projects`, newest first, up to 12). Home shows the last four. Nothing in a project folder changes.
- A project that has never been opened here is not in that list. Until four have been opened, the rest are filled with the most recently changed projects.
- Needs the app rebuilt (new Tauri commands `mark_project_opened` and `recent_projects`).

## Home greeting (from the greeting spec)
- Home's top line is now chosen by rules, with no AI and no network (`src/features/home/greetings/`). It picks the most important thing that applies, picks a line for it, and keeps that line all day. The saved choice and the last 14 days live in Murre's settings (`greeting_state`).
- All 166 lines come straight from the spec (`greetings-data.ts`). Importance order follows the spec: just finished or packaged / due today / overdue, then first launch / first project / all completed, then due tomorrow or within three days, then away for 5+ days, then how many projects are active, then After Effects, then time of day. Contexts of the same rank take turns by date.
- Repeat rules: a line is not reused within three days when there is another; "overdue", "due tomorrow" and "due within three days" are not shown a third day in a row. Lines that need a project name or number are skipped when it is not known.
- Events from other pages are saved as they happen and get their greeting the next time Home is shown: a project moved to or saved as Completed, a package built, a scan finished.
- Not built: "Project has issues" (needs scan results from every project) and the birthday greetings (Murre does not ask for a birthday). The After Effects connected / not connected lines appear on about one day in four.
- The greeting is worked out when Home opens, so a project finished while Home is on screen gets its line the next time Home opens.
- The rule engine was tested with a throwaway script (16 cases). The app has no test runner, so those tests are not in the repo.
- Needs the app rebuilt (new commands `get_greeting_state` and `save_greeting_state`).

## Motion

Murre uses the `motion` package for movement that CSS can't do well. Timings and easings live in `src/lib/motion.ts`; use those instead of new numbers. `MotionConfig reducedMotion="user"` in `main.tsx` turns movement off for anyone with Reduce Motion on.

Where it is used: the tab underline (Base UI's own indicator, CSS), the sidebar highlight sliding between Home, Projects, Notes, Calendar and Referenxe, cards on the Projects grid fading in, gliding and fading out, and kanban cards gliding into place. Kanban cards do not fade: dnd-kit hides the dropped card while its drop animation plays and then restores it, which left a moved card invisible when it also had a fade of its own.

Known limits: only checked in a browser, not in the app. Settings and Help in the sidebar footer keep a plain highlight. Cards leaving a list finish their quick fade before the others close the gap. Run `npm install` after pulling this, since it adds a package.

Also moving: switching a project's tabs fades the content in (about 0.15s), rows in the workfile timeline, the Home lists and the calendar day sheet fade and glide like the cards, and buttons shrink 2% while pressed. Dialogs, sheets, menus and popovers already had enter and exit animation, so those are unchanged.

## Known issue: calendar swipe sticks (not fixed)

On a Mac trackpad, a two-finger sideways swipe on the Calendar changes the month once. A second swipe with the cursor held still does nothing until the mouse moves. It was not reproduced in a browser test, where three swipes in a row worked.

Tried, without success: keeping the same grid and cell elements when the month changes (the slide now animates the existing grid instead of replacing it), clipping the horizontal overflow, and cancelling sideways wheel events with a non-passive listener.

Next things to look at: the swipe lock in `onWheel` in `calendar-page.tsx` (`lockedUntil` keeps extending while the trackpad's coasting events arrive, and may never expire on a real trackpad), and whether the Tauri webview handles the gesture differently from a browser. Logging `deltaX` and `timeStamp` from a real swipe would show which.

## Shapes on the Referenxe board

The board has four shapes: rectangle, ellipse, line and arrow. They are added from the shapes button at the bottom of the board (no drawing tool, no shortcut yet) and appear in the middle of the view, selected.

One fixed look: a 3px outline in the text colour. No fill, no colour, no corner or line options. Rectangles and ellipses are outlines: until selected, only their line can be clicked, so the empty inside lets clicks through to whatever is underneath. Once selected, dragging anywhere inside moves them.

Rectangles and ellipses stretch freely from the corners (resizing several things at once still keeps proportions). Lines and arrows have a handle at each end instead of corners; the arrowhead is at the end the second handle controls. Boards with shapes saved by this version show nothing for them in an older version of Murre.

Not done: shortcuts for adding shapes, drawing a shape by dragging, colours, filled shapes, text inside a shape, Shift to keep proportions while resizing a rectangle. Only checked in a browser.

## Companion ships as a signed package

The app now ships the Companion as the signed `com.murre.cep.zxp` (in `src-tauri/companion-bundle`, copied into the app's resources) instead of a loose folder. Installing unpacks it into After Effects' extension folder exactly as it is, because the signature covers every file. For a signed package the app no longer turns on `PlayerDebugMode`; it only does that for the unsigned development folder.

To make a release: `npm run bundle:signed` in `murre-ae` (builds, signs with the details in `cep.config.ts`, copies the package in), then `tauri build`. `npm run bundle` still ships the unsigned folder, for development.

Not checked on a real Mac: that After Effects accepts the self-signed package with `PlayerDebugMode` off. Turn it off first to test (`defaults delete com.adobe.CSXS.12 PlayerDebugMode`, repeat for 9 to 13), remove the installed `com.murre.cep` folder, install from the app, restart After Effects. If the panel does not load, the signature is the first suspect.

The package contains a `.debug` file that opens remote-debugging ports (8860, 8861) for the panel. Fine while developing; for a release, turn the debug file off in the Companion's build config and sign again.

Settings > After Effects Companion has a checkbox, "Companion not showing up?", that turns `PlayerDebugMode` on or off for CSXS 9 to 13 (turning it off removes the setting). It is a system-wide Adobe setting: it lets After Effects load every panel it can't verify, not only Murre. It shows as on only when all five versions are on. After a change the row says to restart After Effects. Mac only; elsewhere it reads as off and does nothing.

## Tabs and the bottom fade

- The tab strip sits in the title-bar row of the page card (`src/features/tabs/`). Any page can be a tab. Cmd/Ctrl-click or middle-click on an in-app link, or the `+` button, opens a new tab. Back and forward arrows follow the router history.
- Opening a page from a project tab adds a new tab; from any other tab it replaces that tab. Tabs are remembered in `localStorage` (`murre.tabs`) and dropped when their project is deleted.
- Limits: each tab keeps only its page, not its scroll position or the inner project tab. No keyboard shortcuts yet. Checked in the browser only, not in the Mac app.
- The soft blur (`edge-blur.tsx`) is only at the top edge: a few pixels of backdrop blur faded out with a mask, shown once a page has scrolled. There is no bottom blur (tried and removed). Tabs that overflow the strip fade at the edges.
- Page headers now start below the strip (`--tabstrip-h`); the sidebar button moved into the strip. Settings, New project and the coming-soon pages have no title row or line any more (`PageTop`); the tab names the page.

## Switcher (Cmd+K or Cmd+P)

- `src/features/switcher/`. Jump to a project, space or page, or run an action (new project, new tab, close tab, show or hide the sidebar). Empty box shows recent projects first. Matching is in-order letters, no library (`match.ts`).
- Enter opens it by the usual tab rules; Cmd+Enter opens it in a new tab.
- Not built: searching note text, project files or expressions; the list is names only.

## Accent color and translucent sidebar

- Settings → Appearance. Accent: neutral (default) or six colors; it sets `--primary`, the focus ring and the sidebar primary through `html[data-accent]` in `App.css`. Status colors are untouched. Translucent sidebar: off adds `solid-window` on `<html>`, which makes the window and sidebar background solid. No Rust change; the native blur is still applied underneath.
- Both are stored in `localStorage` (`murre.accent`, `murre.translucent`), applied before first paint from `main.tsx`. Not synced and not per project.
- Not built: custom colors, a translucency amount slider, a contrast slider. Checked in the browser only; the translucent toggle only does anything on the Mac.

## Updates and the app menu

- `src-tauri/src/updater.rs`: checks on launch (after 8 s) and once a day while the window is showing, asks with a native dialog (Install and restart / Later; "Later" is remembered for that version), and says so if a render is running. Open notes and the reference canvas are saved first (`flush-before-restart`). Menu: Murre → Check for updates…, and Settings → About → Check for updates.
- App menu (`install_app_menu` in `lib.rs`): Murre (About, Check for updates…, Settings… Cmd+,, Hide, Quit), Edit, Window (Minimize only). No Close Window item, so Cmd+W is free for closing a tab.
- **Set up for GitHub releases** (see `RELEASING.md`). `tauri.conf.json` has `createUpdaterArtifacts`, an ad-hoc signature (`macOS.signingIdentity: "-"`) and `plugins.updater` pointing at `https://github.com/vigsdev/murre-app/releases/latest/download/latest.json`. The public key is in (minisign key ID `5FE0E25CECF708CC`; private key at `~/.tauri/murre.key` on the owner's Mac).
- `.github/workflows/release.yml` runs on a `v*.*.*` tag: checks the tag matches the app version, builds FFmpeg (cached), builds with `tauri-apps/tauri-action@v1`, and makes a draft release with the `.dmg`, `Murre.app.tar.gz`, its `.sig` and `latest.json`. The tag message becomes the release notes. Apple Silicon only.
- `npm run release -- 0.2.0 "notes"` (`scripts/release.mjs`) sets the version in `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, `package.json` and `package-lock.json`, commits and tags. It doesn't push. `scripts/make-update-feed.mjs` is gone; tauri-action writes `latest.json`.
- Limits: the repo must be public (the updater fetches without signing in). A local `npm run tauri build` now needs the signing key in the environment. A build made before the key is added can’t update itself, so testers need one manual install first. Not yet run on GitHub or tested end to end.
- The first paid-download flow (Lemon Squeezy for the dmg) is separate: it delivers the first install; the updater takes over after that. Unsigned or un-notarized builds still show Gatekeeper’s warning on first open.

## Companion link: panel and helper no longer fight

- Symptom: the app said "Companion connected", then "After Effects has another project open", over and over; the panel flipped between "App is connected" and "App not connected".
- Likely cause (not seen on the Mac, worked out from the code): the panel and the hidden background helper are both clients of the app's link, and a newer connection used to replace the older one. If the helper doesn’t hear the panel’s heartbeat, it takes the link, the panel takes it back, and so on.
- Fix (`bridge.rs`): a connection takes over only after its first message says who it is, and a helper (`source: "background"`) is turned away while a panel has been heard in the last 25 s. A panel still replaces a helper, and anything replaces a connection that went quiet. Three new tests cover it.
- Not changed: the helper’s own heartbeat logic in the Companion. If the loop continues, check for two copies of the Companion installed (a dev copy and the zxp one) and look in `~/Library/Logs/CSXS/CEP12-AEFT.log`.

## Two After Effects at once (2026 and a beta)

- The link now keeps one connection per After Effects instead of one in total. The Companion sends the application's path (`host`) and a name (`hostLabel`, such as "After Effects 2026 Beta") with its state; a newer connection from the same After Effects replaces its older one (panel before helper, as before), and connections from different ones stay side by side, so the panels no longer fight.
- The app talks to one at a time (the active one). The first to connect is active; if it closes, another takes over (a panel before a helper). Everything in `PanelState` still describes the active one, plus `connections` and `activeId`.
- Choosing: the picker appears in the project header only when two or more are connected ("After Effects 2026 ▾", with the open file under each name). Opening a project page, or pressing Scan or Copy & relink, switches to the After Effects that has that project open, if the active one has another. A hand-picked choice is not undone just by staying on the page.
- Commands: `companion_switch(id)`, `companion_prefer_project(projectId)`. Tests in `bridge.rs`: four new ones for side-by-side, switching, routing by project and fallback.
- Not checked on a real Mac: how the Beta's application path and version look from CEP. The name is "After Effects <year from version>", plus " Beta" if the path contains "Beta". If the Beta reports something else, the label will just read "After Effects 2026" for both; the two are still told apart by path.
- The Companion has to be rebuilt and reinstalled (Settings → Companion) for it to send the host. An old Companion still works: with no host it counts as one "unknown" After Effects, so two old ones would replace each other as before.

## Dropping files on the Referenxe board

- Tauri turns on its own file-drop handling for a window by default, and on macOS that stops the page from seeing dropped files at all. The window now has `dragDropEnabled: false` (`tauri.conf.json`), so the board's normal drop handler gets them. `main.tsx` also stops a file dropped outside the board from opening in the window.
- Not run in the real app. Needs a full restart of `tauri dev` (the config is read at start).

## Shape color and line (Referenxe)

- Select a shape and use the brush button in the toolbar: line color, fill (rectangles and ellipses), thickness (thin to heavy) and line style (solid, dashed, dotted). It works on several shapes at once; "default" goes back to the text color and no fill.
- Saved on each item as `color`, `fill` (`#rrggbb`), `stroke` and `dash`; older boards open as before. A filled shape can be picked up by its inside.
- Not included: a freehand brush for drawing. Say if that is what you meant.

## Package: notes, to-do and references; dialog width

- New option "Include the notes, to-do and references", off by default. It adds a `Project notes` folder to the package: `Notes.txt` (all note pages as plain text), `To-do.txt` (`[ ]` / `[x]` lines) and `References/` (the images, videos and PDFs placed on the board, under their stored names, which are not the original file names). Only the parts the project has are written; with none of them the option is greyed out. The project's own files are not touched.
- Text from notes is plain: headings get `#`, list items `-`; formatting such as bold and links is dropped, and the reference board's layout is not included (only its files).
- The dialog's content column could grow past the dialog with a long path or sentence and cut it off on the right; it now shrinks to fit and the folder path is cut with "…".

## FFmpeg ships inside the app

- `tauri.conf.json` now has `bundle.externalBin: ["binaries/ffmpeg", "binaries/ffprobe"]`, so the real programs sit next to Murre's own program in `Murre.app/Contents/MacOS`. `renders.rs` uses them first (checked once with `-version`), then falls back to Homebrew/MacPorts/PATH as before. Nobody has to install anything; one `xattr -cr` on the app clears the quarantine flag for everything inside it.
- To make them: run `scripts/make-ffmpeg.sh` once on the Mac (`--both` for Apple Silicon and Intel plus a universal one for a universal `tauri build`). It downloads FFmpeg 7.1.1, builds a small LGPL-only static copy, strips and ad-hoc signs it into `src-tauri/binaries/`. Not run by me: the container is Linux. It needs the Xcode command line tools, and `brew install nasm` for an Intel build on Apple Silicon.
- `build.rs` writes do-nothing stand-ins for any missing file in `src-tauri/binaries/` (the build refuses to run without them). The app sees that they exit with an error and falls back to a system ffmpeg, so a checkout without the real ones still works, but a release built without running the script would ship stand-ins. Check the dmg's `Contents/MacOS/ffmpeg` is 15 MB or more.
- The binaries are in `.gitignore` (too big to commit). Notarization later: they must be signed with the same Developer ID and hardened runtime as the app (Tauri does this for sidecars when `APPLE_SIGNING_IDENTITY` is set).
- LGPL: `THIRD-PARTY.md` has the notice and says how the build is made again. Don't use the common "static ffmpeg" downloads for this: most are GPL builds.
- Not verified: the script itself (can't run macOS builds here, only `bash -n`), and that `tauri dev` copies the sidecars next to the dev program (it should; if thumbnails still say "wouldn't start" in dev, run the script and restart).

## SVG icons on the Referenxe board

- SVG files can be added to the board (drop, paste or "Add file"). They are stored as they are in `.murre/references/media/` and shown through an `<img>`, which never runs scripts; they are never opened as a page. A file counts as SVG only if it starts with an `<svg` element (after an optional XML line, comments and doctype) and is closed. New SVGs start 200 px on the long side, since icons are often 24 px.
- Right-click an SVG: "Send to After Effects as shapes" (imports it, then runs Layer > Create > Create Shapes from Vector Layer, and switches the original vector layer off so nothing is lost) or "as a layer" (plain footage layer, as for any image).
- The Companion does the work, so it needs the Companion rebuilt (`npm run bundle:signed` in `murre-ae`). The shapes step finds the menu command by its English name and falls back to command 3973; with another menu language the name is not found. If After Effects will not make the shapes, the SVG stays in the comp as a layer and the message says to use the menu by hand.
- Not tried in After Effects (I can't run it here). Worth a look: a few SVGs with gradients, strokes or text, because After Effects' own conversion decides how those turn out.
- Pasting SVG code onto the board (for example "Copy as SVG" from Figma) adds it as an SVG file, not as a text box. It must start with an `<svg` element and be closed; anything else pastes as text as before. Pasting while editing a text box still pastes text.
- Packages include SVG references like other reference files.

## Companion updates merged

The Companion changes that used to wait in `companion-updates/` are now in `murre-ae/src/` and the folder is gone. Run `npm run bundle:signed` in `murre-ae` before the next app build so the shipped package includes them.

## Time in After Effects (Home)

- Home has a "Time in After Effects" card: bars per project for today, and shaded day cells for 7 and 30 days.
- A session starts when a connected After Effects reports a project that is in Murre, and ends when it disconnects or opens something else. Projects that aren't in Murre are never recorded. Sessions live in the app's own database (table `sessions`), not in any project folder.
- **It is time open, not time worked.** After Effects gives the Companion no sign of activity, so a project left open overnight counts. Idle detection would need a new signal from the Companion (for example saves or edits); not built.
- Time while Murre is closed isn't seen. If Murre quits or crashes, the session ends at the last time it was seen alive (up to 30 seconds earlier).
- A project that reopens within 2 minutes (After Effects restarting, the panel reloading) continues its session. Stretches under 1 minute aren't shown.
- A project removed from Murre drops out of the card; its old rows stay in the database and come back if the same project id is added again.
- Needs no Companion update: it uses the project id the Companion already sends.

## Look and feel (Linear-style pass)

- Font is Inter Variable only (SF Pro is no longer first), with `ss01, ss02, cv01, cv03` on. Weights: 510 for headings and labels (`font-medium` and `font-semibold` are both 510), 400 for body.
- The root stays 15px, so type sizes are set in `App.css`: xs 12, sm 14, base 15, lg 16, xl 20, 2xl 24 px. Body is tightened slightly; small text has no tracking.
- Dark mode uses a surface ladder: page `#08090a`, card `#0f1011`, raised `#141516`, with 8% white hairlines. Light mode only got the font and shape changes.
- All `Button`s are pills, with a faint top highlight on primary, secondary and outline in dark mode. `Card` is 8px with 22px padding (was 19px).
- Not done: the 44px touch height and the large marketing type from the Linear file. Hand-built boxes outside `Card` keep their own radius and padding.

## Videos folder

- New projects get `02 Assets/07 Videos`. Video files (mp4, mov, m4v, avi, mkv, webm, mxf, wmv, mpg, mpeg, mts, m2ts, flv, 3gp) are copied there by "copy and relink", and the Companion's organize step puts video footage in a matching `02 Assets/07 Videos` bin in After Effects.
- Existing projects don't get the folder until the first video is copied in (the Companion creates it then). Files already sitting in `02 Assets` are not moved on disk.
- On the first scan after the Companion update, After Effects will move video items from `02 Assets` into the new bin (one undo step, project not saved, as before).
- Needs the rebuilt Companion (`npm run bundle:signed` in `murre-ae`).

## Folder setup (Settings > Folders)

- One folder setup for the whole app, kept in the settings table (`folder_template`). It lists the sub-folders of `02 Assets` and, for each, the kinds of file that go into it (Images, Audio, Videos, Photoshop, Illustrator) plus any file types typed by hand. Edits save by themselves a moment after the last change. Presets: Minimal, No sub-folders, and Reset to default.
- When a project is created, a resolved copy is written to `.murre/folders.json`. The Companion reads that copy (copy and relink, and the After Effects bins), so changing the setup only affects new projects. Projects without the file (made before this, or brought in) use the default folders.
- The top-level folders (`01 AE Workfile`, `02 Assets`, `03`–`07`) and `.murre` are fixed: renders, packaging and the Assets tab depend on them.
- Sub-folders are one level deep. A file type can go to one folder only (the editor and the app both refuse overlaps). Names can't use `/ \ : * ? " < > |`, can't start with a dot, and can't be "Solids" (After Effects bin).
- Files that match no folder go straight into `02 Assets`, as before.
- Needs the rebuilt Companion (`npm run bundle:signed` in `murre-ae`). An installed Companion older than that keeps using the default folders.

## Credits and licenses

- Settings ends with a short thank-you line and a "View licenses" link. The sheet lists every package that ships in the app (446 at the time of writing), with version, license and copyright line, searchable.
- The list is a file, `src/assets/credits.json`, made by `node scripts/gen-credits.mjs`. Run it again whenever dependencies change. It needs network access (cargo may download crate metadata).
- It covers web packages that ship (build tools such as Tailwind's compiler and the shadcn CLI are left out) and native crates for the Apple Silicon build. If you add a Windows build, run it for that target too.
- A few packages have no copyright line in their license file, so only the license name shows. MPL-2.0 packages (lightningcss, a few Rust crates) are used unmodified.
- The names thanked on the page are typed by hand in `src/features/settings/credits.tsx`.

## Calendar: side panel

- A side panel on the left shows the next six deadlines (overdue ones first, completed and archived ones left out) and a small month with a dot under days that have something on them. Clicking either opens that day. It shows by itself when the window is at least 1100px wide and hides when it is narrower. There is no button for it.
- The month changes with the arrows, Today, the small month, or a click on an upcoming deadline. Scrolling does not change the month, and the colour key under the grid was removed.
- Not built: Day, Week and Year views. Murre's items have no times, so Day and Week would be mostly empty.

## Time card: live animation

- While After Effects has a project open, its row on the Time card is "live": the dot beside the name pulses a soft ring, light sweeps along the bar, a small dot sits at the end of the bar, and the bar, the "now" line and the total keep counting up every second. In the 7 and 30 day views today's cell pulses instead.
- The card reads the log again about a second and a half after a project opens or closes in After Effects, so it no longer waits up to 30 seconds. It still refreshes every 30 seconds.
- With "reduce motion" turned on in macOS, the pulsing and the sweep are switched off.
- On a day-long scale the bar grows too slowly to see (a few seconds is a fraction of a pixel). The pulse, the sweep and the end dot are what show that it is counting.
- Needs a rebuild of the app (a new `live` field comes from the Rust side). Checked in a browser preview with made-up data and in unit tests, not with real After Effects.
