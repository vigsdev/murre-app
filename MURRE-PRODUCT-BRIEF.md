# Murre: Product Brief

*For another AI assistant (or a person) who has never seen Murre and has no access to the repository.*

**How to read this document.** It was written by reading the actual source: the desktop app (`murre/`, Tauri 2 + React 19) and the After Effects extension (`companion/`, a CEP panel). Statements are tagged:

- **[Code]** is a fact seen in the implementation, with a file path as evidence.
- **[Owner]** is something the product owner told me during development (for example "it worked on a real project").
- **[Interpretation]** is my reading, not a fact in the code.
- **Unknown** means it could not be confirmed.

Status labels used throughout: **Verified** (the owner reported it working on a real project), **Implemented, not verified** (code and tests exist, but nobody has confirmed it against a real After Effects), **Partial**, **Planned**.

The app's name is "Murre" and is a working name. The brief does not propose a different one.

---

## 1. Product Identity

### What it is
Murre is a **local-first macOS desktop app for After Effects motion designers**. It creates and organizes a standard folder structure for each motion-design project, tracks the project's After Effects file versions, notes, references, to-dos, renders and deadlines, and uses a small extension running inside After Effects (the "Companion") to read what's in the project (footage, colors, expressions, compositions) and tidy it. Everything is stored in files next to the project, with no account and no server.

### The problem it solves
A freelance or studio motion designer finishes a project, moves on, and returns months later for a revision. They then have to reconstruct: where the files are, which `.aep` is the latest, what the client said, what was left to do, which fonts, colors and expressions were used, which render was approved, and whether any footage is missing or lives on another drive. After Effects projects commonly point at files scattered across the disk, so moving or archiving a project breaks it. [Interpretation] The owner's stated goal is that the app "should reduce the cognitive load if a user reopens the same project after a bunch of months" [Owner].

### Primary user
A solo or small-team **After Effects motion designer** on macOS. [Owner] The owner's own work is "heavy with shapes, not video footage", and projects rarely exceed ~2–3 GB. That affects design decisions (for example, copying footage into the project is acceptable). Not designed for: Windows/Linux users, video editors working mainly in Premiere, large teams, or pipelines with huge footage libraries (see section 8).

### How it differs from what people use today

| Tool | What it does | What Murre adds |
|---|---|---|
| **Finder** | Shows folders and files, with no knowledge of After Effects | A fixed project structure, `.aep` version detection, an "approved render" marker, and links between files and what's inside them |
| **After Effects** | Edits the project; the Project panel shows the footage list | A view of the project *outside* AE: colors, expressions, versions, notes, to-dos, references, and copy-and-relink of footage into one folder. It reads AE through the Companion and does not replace it |
| **Generic project tools (Notion, Trello, Asana)** | Tasks, boards, calendars | They have no idea what's in the AE file. Murre has the same surface (kanban, calendar, to-dos), but it is tied to real folders and to data extracted from AE |

### Central value proposition
*"Open any old project and immediately know where everything is and what state it's in."* The product does this by combining a predictable folder layout, a version list, collected facts from the AE file, and short notes and to-dos kept with the project.

### What users would lose without it
Nothing is locked in. The files are normal folders, `.aep` files, JSON and images. Without the app, a user loses the organized overview, the collected colors and expressions, and the safe copy-and-relink step. The project files themselves stay usable.

---

## 2. Complete User Journey

Status labels per step: **Works** = implemented; **Verified** = owner reported working on a real project; **Not verified** = no confirmation against real After Effects.

### 2.1 First launch and onboarding
- **Works [Code `src/features/profile/onboarding-page.tsx`]**. Welcome screen: name and an avatar (uploaded or one of the presets). If more than one After Effects version is installed, a second step asks which one to use by default. A last step installs the Companion; **Finish stays disabled until it's installed** (a "later" link appears only if the install itself failed).
- The Companion install copies the extension bundled in the app into `~/Library/Application Support/Adobe/CEP/extensions/com.murre.cep` (no admin password) and sets `PlayerDebugMode` for CEP versions 9–13 via `defaults write`, because the extension is unsigned [Code `companion_install.rs`].
- Status: **Not verified** against a clean Mac [FROM-CLAUDE.md]. [Owner] The owner uses the Companion daily, so the install path has worked for them at least once.

### 2.2 Creating a project
- **Works [Code `new-project-page.tsx`, `project.rs`]**. Fields: name, location (folder picker), client, deadline, priority (Low/Medium/High), status (6 values), Space, description, After Effects version, and one checkbox "open After Effects and start using".
- Creating makes the folder structure (section 5) and a hidden `.murre/` folder with `project.json`. Creation never touches a folder that already exists, and removes only what it created if a later step fails [Code `project.rs`].
- With the checkbox on: the app asks After Effects what's open, launches AE if needed (waiting up to 2 minutes for the Companion), saves/closes any open project after a confirmation, and has After Effects create `01 AE Workfile/<Name>-v1.aep` with one comp ("Main Comp", 1920×1080, 30 fps, 30 s). That file is marked "current" [FROM-CLAUDE.md, `open_ae.rs`, `starter.ts`]. Status: **Not verified** against a real AE, per FROM-CLAUDE.md (the owner may have tested since; **Unknown**).

### 2.3 Importing an existing After Effects project
Two entry points, both implemented:
1. **"Add this project to Murre"** (button in the Companion panel, or "From After Effects" on the Projects page). The project must already be open in AE. Flow: inspect, create the project folder, Save As a *copy* into `01 AE Workfile` (the original `.aep` is never written to), scan, copy outside footage into the project and relink it [Code `add_project.rs`]. **Verified [Owner]**: "it worked like magic" on a real project.
2. **Import an existing folder** (`import_project`, `inspect_import`): adds a hidden `.murre/` folder to a folder that already exists. It never moves or reorganizes files [Code `project_store.rs`]. Status: implemented; verification **Unknown**.

### 2.4 Automatic folder organization
- New projects get a fixed numbered structure. Importing an existing folder keeps its layout. Version discovery looks through the whole folder, not only `01 AE Workfile`, so imported projects with their own layout still work [Code `workfiles.rs`].
- Footage from outside the project is **copied** (never moved or overwritten) into the project's asset folders and relinked in After Effects. By default originals stay where they are. There is an opt-in setting to move originals to the Trash afterwards, but only after the copy is checked [Code `project_settings.rs`, FROM-CLAUDE.md]. Status of the Trash step: **Not verified**.

### 2.5 Working inside After Effects
- The Companion panel (Window → Extensions → Murre) links the open saved `.aep` to a Murre project by looking upward for `.murre/project.json`. A second hidden background helper keeps the link alive when the panel is closed [Code `companion/src/js/background/background.ts`].
- The Companion scans compositions and writes `colors.json`, `expressions.json`, `comps.json`, `assets.json` into the project's `.murre/` folder. It "only reads After Effects" for scanning [companion `MURRE-COMPANION.md`]. The relink step does change the AE project (it repoints footage), which then has unsaved changes [Code `footage-panel.tsx`].
- Status: scanning/relinking **Verified** for the add-project path [Owner]. Other scans: **Not verified** per FROM-CLAUDE.md; **Unknown** whether the owner has tested them since.

### 2.6 Managing assets, expressions, colors, renders
See section 3 for each tab. All read data the Companion collected, or files already on disk.

### 2.7 Notes and references
Project and global notes (with multiple pages) and a free-form reference board (project-level and global). See section 3.

### 2.8 Switching between projects
Sidebar → Projects (list with search, filter, sort), Home (kanban by status), a Space's page, or the Calendar. Each project opens on the **Project** tab.

### 2.9 Reopening a project months later
What exists today for this goal [Code]:
- The **Project tab** lists every `.aep` version, newest first, with a "Current" mark the user sets (never guessed), a "Highest version" badge, and a warning if the current file is missing.
- A to-do list sits next to it.
- Notes, references, colors, expressions, renders and approvals are one tab away.
- If the folder moved or a drive isn't connected: "Project folder not found" with "Locate folder…" [`project-detail-page.tsx`, `locate-folder.ts`].
- The app's data is validated on open: it reports projects whose folder points at a different project or needs attention [`sync-problems.tsx`, `reconcile.rs`].

**Planned and not built**: recorded project history ("what changed since I last opened it"), a "last worked on" line, a pinned "where I left off" note, global search. These were discussed but not implemented [Owner conversation].

### 2.10 Archiving or delivering a project
- A project can be marked **Archived** or **Completed** (status); archived projects are hidden from the default list [Code `project-utils.ts`: default filter `not_archived`].
- `05 Pre-Renders`, `06 Renders`, `07 Deliverables` exist as folders. The Renders tab lists media files in them and lets the user mark one as **approved**. The app moves nothing and packages nothing.
- **Planned / absent**: no export, zip, collect-files or hand-off bundle. "Delivering" is manual. **Unknown** whether the owner intends to add it.

---

## 3. Feature Inventory

Navigation (sidebar, [Code `components/app-sidebar.tsx`, `App.tsx`]): **New Project**, Home, Projects, Notes, Calendar, Referenxe, **Spaces** (user-created), Help (placeholder; `HELP_URL` is empty in `src/config.ts`), Settings.

### 3.1 Home (`features/home`)
- **What**: greeting, quick actions (New project, All projects, Calendar, Notes), a **kanban board** with one column per status, "Coming up" (deadlines and events in the next days, plus overdue), and "Recently updated".
- **Why**: the quick "what's on my plate" view.
- **Interaction**: drag a card between columns to change status (unavailable projects can't be dragged).
- **Status**: Implemented. Verification by owner: **Unknown**; it's the main page so it has been seen.

### 3.2 Projects list (`features/projects`)
- Cards with a cover, search, a filter (status, priority), a sort (Recently updated, Deadline, Name, Priority), edit and remove-from-app. Removing from the app only deletes the index row; **files are never touched** [`project_store.rs`].
- A "From After Effects" button (section 2.3) and "New Project".
- **Planned**: a Cards/List toggle [Owner].

### 3.3 Spaces (`features/spaces`, `spaces.rs`)
- Virtual collections with an icon, reorderable, shown in the sidebar. A Space is **only a label**; it never corresponds to a folder, and deleting one keeps its projects. Status: Implemented.

### 3.4 Calendar (`features/calendar`)
- Month view of project deadlines and user-made events. Deadline chips are **colored by project status** with a legend. Day sheet; add/edit/delete events. Deadlines come from each project; events live in the app database [`events.rs`]. Status: Implemented.

### 3.5 Global Notes page and project Notes tab (`notes-tab.tsx`, `notes.rs`)
- Rich-text editor (bold, italic, underline, strike, code, H1–H3, lists, quote, code block, rule, undo/redo), autosaved ~0.8 s after typing, with a "Saved at …" status.
- **Multiple pages**: page 1 can't be deleted; `+` adds a page (max 20), `<`/`>` navigate, `×` deletes (asks for confirmation only when the page has text), numbered chips jump to a page. Switching/adding/deleting first saves.
- **Safety**: saves carry a revision number; if the file changed elsewhere, a conflict banner offers "Load version from disk" or "Overwrite with my version". Unsupported content shows a banner and is not overwritten.
- Limitation: undo history is lost when you switch pages. Notes can't link to other notes (planned fix in FROM-CLAUDE.md "notes links").
- Status: Implemented. Page-switching delete bug was found and fixed by the owner's testing; the owner then said "everything looks fine".

### 3.6 Project tab (`project-tab.tsx`, `workfile-timeline.tsx`, `task-list.tsx`)
- **After Effects versions**: every `.aep` found in the project (auto-save folders and hidden folders skipped), newest first, with version numbers parsed from filenames like `Name-v3.aep`. The user marks one "Current" and can open any in a chosen AE install ("Open in After Effects" with an AE-version dropdown).
- **To-do list** (`tasks.json`): add, tick, delete.
- Status: Implemented.

### 3.7 Assets tab (`assets-tab.tsx`, `assets.rs`, `footage-panel.tsx`)
- A file browser rooted in the project folder (read-only; opens a file with the system app). Paths from the UI can't escape the project folder (`..`, absolute paths, symlinks are rejected).
- A **footage panel** (from the Companion's `assets.json`): lists the footage the AE project uses, counts missing files, and offers "copy and relink". It states that files are copied, never moved or overwritten, and lists "copied into this project earlier".
- Status: browser Implemented; footage panel depends on the Companion (see section 4).

### 3.8 Renders tab (`renders-tab.tsx`, `renders.rs`, `render_job.rs`, `aerender.rs`)
- Lists media in the pre-render, render and deliverable folders with thumbnails (ffmpeg), metadata (ffprobe), in-app playback, and an **Approve** toggle. An approval records the file's size and modified time; if the file later changes the UI says **"Changed since approval"** and keeps the old approval until the user re-approves or removes it. Missing approved files are reported.
- **Render Main Comps**: Main Comps are chosen in the Companion panel; the app runs Adobe's `aerender` from a given path (found in standard install folders or set in Settings), without a shell, with live progress, a log and Cancel. One render at a time. It never overwrites an existing output file, never writes into `.murre/`, and opens the AEP with "do not save changes". A comp can be rendered only if its name appears exactly once in the last scan.
- Progress is a best-effort estimate because Adobe doesn't document the progress line format [Code `render_job.rs`].
- ffmpeg/ffprobe are optional: without them files can still be listed, approved, opened and played. [Code `renders-tab.tsx` text]
- Status: Implemented; real-AE rendering **Not verified** (**Unknown** if the owner has tried it).

### 3.9 References tab and Referenxe page (`features/references`, `references.rs`)
- A free-form **board** (infinite canvas): images, videos, text, PDF cards, links. Drag/drop, paste, resize, multi-select, align/distribute, bring to front/send to back, duplicate, delete, zoom, fit-all. Keyboard shortcuts `I` (import) and `K` (link).
- Two scopes: per project (inside the project's `.murre/references/`) and global ("Referenxe" page in the app data folder).
- Imported media is copied under a random name; **nothing in `media/` is ever deleted by the app**. Type is decided by sniffing bytes, not file extension. A board saved with the older tldraw library can be migrated.
- **Right-click an image → "Send to After Effects"**: the Companion imports it into the active comp and centres it, or creates a 1920×1080/30 fps/10 s comp named after the image if none is active. One undo step. AE can't import WebP. Status: **Not verified** in real AE.
- **Planned**: a video play control on the board [Owner].

### 3.10 Colors tab (`colors-tab.tsx`, `colors.rs`)
- Swatches of colors **actually in use** in the AE project, with the nearest color name (from a name list), "used N times", and where each use is (comp › layer › property). Copy actions. Responsive grid.
- Which colors count: switched-on fills/strokes in shape layers, solids, text fill/stroke, enabled Fill / Gradient Ramp / 4-Color Gradient effects, layer styles that are on. Switched-off layers/groups give nothing. Other effects (Tint, Glow, Drop Shadow) are ignored by design [companion `MURRE-COMPANION.md`].
- Read-only in the desktop app; the Companion writes `colors.json`.

### 3.11 Expressions tab (`expressions-tab.tsx`, `expressions.rs`)
- Every expression in the AE project, syntax-highlighted, grouped when identical code is used in many places ("×N" badge, "Used N times" list showing each location), long code collapsed with "show more", disabled expressions flagged, and a fast search over code, comp, layer and property. Masonry layout. Copy button.
- Tested on a real project with **242 expressions** (the owner said search felt instant after a performance fix) [Owner].
- Capped at 20,000 entries; extra ones are reported as hidden.

### 3.12 Project Settings tab (`settings-tab.tsx`, `project_settings.rs`)
- Per project: copy and relink on scan, move originals to Trash (off by default), auto-scan interval (Off/5/10/15/30 min) with a warning about huge footage. Stored in `.murre/settings.json` so the settings travel with the project.

### 3.13 App Settings (`pages/settings-page.tsx`)
- Profile (name, avatar), Appearance (light/dark/system), After Effects Companion (install/status), After Effects (versions, `aerender` path), About.

### 3.14 Companion control and status
- A bar on every project page shows whether the Companion is connected, and has a Scan button and cancel. Progress and results come back live.

### 3.15 Smaller behaviors worth knowing
- **Menu bar app**: closing the window hides it and removes the Dock icon; the app keeps running from the menu bar (so renders and the Companion link continue). Quit via Cmd+Q or the tray menu [FROM-CLAUDE.md]. The tray icon is a placeholder "S".
- **Live updates**: the project that's open on screen is watched for file changes and the UI refreshes (one project at a time) [`watcher.rs`].
- **Reconciliation**: the app compares its database to what's on disk (triggered from the sync context; exact timing **Unknown**) [`reconcile.rs`, `sync-context.tsx`].
- **Window**: translucent macOS window (uses a private API that the Mac App Store would reject).
- **Placeholder pages**: a "Coming soon" component exists, but no current route uses it other than "Not found".

---

## 4. After Effects Integration

### What the Companion is
A **CEP extension** (Adobe's older panel technology) built from the Bolt CEP starter (React + TypeScript + Vite). It has two parts:
- a **visible panel** (Window → Extensions → Murre), and
- a **hidden background helper** (`com.murre.cep.background`, starts with After Effects, no window) that keeps working when the panel is closed. When the panel is open, the helper drops its link so the two don't compete.

Everything touching After Effects itself runs as **ExtendScript** in `companion/src/jsx/aeft/` (`scan.ts`, `footage.ts`, `starter.ts`).

### How the app and the Companion talk
- The app listens on a **WebSocket bound to `127.0.0.1`**. It writes the port and a one-time token to `companion-bridge.json` in its data folder; the Companion reads that and connects (retrying 1, 2, 5, then every 10 s) [`bridge.rs`].
- Safety: the token must be in the URL (so a web page can't drive After Effects), browser origins are refused, messages are size-limited, one connection at a time, silent connections are dropped. Protocol version 1.
- Commands and progress go over the socket: scan, cancel, relink, create a project, add-project, import an image, Save As, and state/progress/done/failed replies. **Results are never sent over the socket**: the Companion writes JSON files into the project's `.murre/` folder, and the app reads them. So the files stay the source of truth and a scan started inside the panel works with or without the app.

### What can be extracted from AE
- The open project's path and whether it's saved; the list of compositions with sizes/durations (`comps.json`); colors in use; every expression with its location and on/off state; footage items and their on-disk paths with a missing/ok status (`assets.json`) [Code].
- **Not extracted**: fonts, plugins/effects used (except the specific color effects), layer counts, render queue contents, markers, or the layer structure of the project. **Unknown** whether any is planned.

### Asset scanning, copying, relinking
1. Scan lists footage and finds files outside the project folder.
2. If "copy and relink on scan" is on (project setting), each outside file is **copied** into the project's asset folders, checked, and the AE footage item is repointed to the copy. Originals aren't touched unless the opt-in Trash setting is on, and then only after the copy is verified, through Finder so it can be undone.
3. After Effects then shows unsaved changes; the user saves.
- Not copied: image sequences (FROM-CLAUDE.md "limits"). exFAT drives need a hard-link fallback that isn't built yet. There's no size prompt before copying (projects are expected to be small).

### Importing an existing AE project
See 2.3. The Save As uses `app.project.save(new File(path))`, saving a copy so the original stays as it was. Never-saved projects are saved as `<name>-v1.aep`. If a step after the save fails, the project still exists and the message says which step failed; scan or relink can be rerun.

### What still needs manual interaction
- Installing the Companion (guided, but unsigned, so After Effects must be restarted once and debug mode is set).
- **Choosing Main Comps** in the panel before rendering.
- Opening the project in AE for the add-project flow; saving after relink.
- Marking the "current" `.aep`.

### Known limitations and unverified behaviors
From FROM-CLAUDE.md and the code:
- Unverified in real After Effects (as of the notes): the hidden helper loading on start, cross-extension events, `open -a <AE>` launching the chosen version, `app.project.close()` without a dialog, the `ps` check recognizing AE, Trash via Finder, auto-scan timing on large projects, image import via right-click, the panel's folder picker. The add-project flow **was** confirmed on a real project [Owner].
- ExtendScript has no reliable "unsaved changes" flag, so a saved project is always saved before it's closed; the confirm dialog doesn't say whether it had changes.
- If a different AE version than the chosen one is running, the running one is used.
- The extension is unsigned; a signed ZXP would remove the need for PlayerDebugMode.
- macOS only (uses `osascript`, `defaults`, `open -a`, `ps`). Windows: **Unknown / not supported**.

---

## 5. Data, Privacy, and Architecture

### Local-first
- No cloud, no account, no telemetry in the code. **I found no HTTP client dependency** in the Rust crate (`Cargo.toml` has `tungstenite` for the local socket only) and no `fetch` to remote servers in the UI other than loading the bundled avatar presets. The only network socket is the localhost WebSocket. The Content-Security-Policy is `null`; this isn't a privacy issue by itself but is a hardening gap. An "opt-in usage ping" is **planned** [Owner], not implemented.
- Fully usable offline. The `HELP_URL` is empty, so the Help button has no destination yet.

### On-disk project structure [Code `project.rs`]
```
<ProjectName>/
  01 AE Workfile/
  02 Assets/
    01 Images  02 Audios  03 PSD Files  04 Illustrator Files  05 Templates  06 SoundFX
  03 Scripts & Storyboard/
  04 Premiere & SFX/
  05 Pre-Renders/
  06 Renders/
  07 Deliverables/
  .murre/            (hidden)
    project.json        (authoritative record)
    notes.json  tasks.json  settings.json  workfiles.json
    colors.json  expressions.json  comps.json  assets.json   (written by the Companion)
    references/references.json + references/media/
    *.bak, *.corrupt    (backups and quarantined damaged files)
```

### The `.murre` directory
Holds everything the app knows about that project. **`project.json` is authoritative**; the SQLite database is only an indexed copy, which a reconciliation scan brings back in line with what is on disk (it only updates the index, never the project folders). `project.json` is written last during creation, so a folder that contains it is a complete project.

### App-wide data
In the app data folder (`~/Library/Application Support/com.vigs.murre/` on macOS [companion docs]): profile and avatar, the SQLite database (projects index, Spaces, calendar events; versioned migrations, one transaction each), global notes, the global reference board, render thumbnails (kept outside projects), and `companion-bridge.json`.

### Persistence and recovery
- Writes are **atomic** (temp file in the same folder, fsync, rename). The previous valid content is kept as `<name>.bak`. JSON is validated before it's written and before it's trusted on read, with a fallback to the backup if the primary is corrupt. Writes to one path are serialized [`safe_fs.rs`].
- Notes and the reference board use **revisioned saves**: a stale editor gets a conflict instead of silently overwriting.
- The Companion also writes whole snapshots atomically, keeps `.bak`/`.corrupt`, never overwrites a file from a newer schema, and discards a scan that fails or is cancelled midway.

### File monitoring
Only the project open on screen is watched, with debounced events turned into a "something changed" message, so large libraries on many drives cost nothing in the background. The watcher never writes [`watcher.rs`].

### Safety mechanisms (collected)
- Removing a project from the app never touches files. Spaces never touch files.
- Folder creation uses `create_dir` so it can't merge into or damage an existing folder.
- Asset browsing is confined to the project folder.
- External programs (`aerender`, `ffmpeg`, `ffprobe`, AE) run with argument lists, no shell, with timeouts; only `.aep/.aepx` inside a project can be opened, and only in AE installs found in standard folders.
- Renders never overwrite, move or delete.
- Copy-and-relink copies only; originals untouched by default.

### External dependencies
After Effects (for the Companion, rendering via `aerender`); optional ffmpeg/ffprobe for render thumbnails/metadata (**Unknown** whether the app bundles them; the code looks for them and degrades without them); the system's "open" for files. Bundled: SQLite.

### Uninstalling the app, or moving a project folder
- **Uninstall**: project folders and their `.murre` data are plain files and stay. App-level data (profile, database, global notes and board) is in the app data folder; whether macOS removes it on uninstall is **Unknown** (a drag-to-Trash uninstall normally leaves it). The Companion stays installed in AE's CEP folder until removed; there's no uninstall action in the app (**Unknown / not seen**).
- **Moving a project folder**: the project's identity is the ID inside `project.json`, not its path. If the folder moves, the app shows "Project folder not found" with **Locate folder…**, which re-links without changing the folder. If a folder at the old path now holds a *different* project, the app warns that it "points at a different project". Moving the whole project folder keeps the Companion's data and notes with it, because they live inside it. Absolute paths inside a `.aep` that still point outside the folder are what the relink step exists to fix.

---

## 6. User Experience and Design

### Information architecture
Left sidebar (New Project button, Home, Projects, Notes, Calendar, Referenxe, a Spaces section, Help, Settings). Inside a project: a header banner (name, client, status/priority chips, deadline), then eight tabs: **Project, Assets, Renders, Notes, References, Colors, Expressions, Settings**. The Companion status/scan control sits beside the tabs.

### Visual language [Code]
React 19 + Tailwind 4 + shadcn (Base UI primitives), Inter font, Lucide icons, light/dark/system, translucent macOS window, rounded cards, a dotted canvas background on notes and boards, sonner toasts, small status chips with color per status (slate / blue / amber / violet / green / grey). A shiki code theme for expressions. [Interpretation] It looks like a modern, quiet, native-feeling Mac app.

### Interaction patterns
- Autosave everywhere (notes, board) with a visible status line; no "Save" buttons.
- Honest empty states, with text that says what will appear and what produces it (for example "Expressions appear here after the After Effects Companion scans this project").
- Destructive actions are rare: deletes are confirmed only when content would be lost.
- Banners with explicit actions for problems (conflicts, missing folder, changed approvals, Companion not connected).
- Right-click on board items, drag between kanban columns, keyboard shortcuts on the board.

### Friction points I can see
1. **The Companion is required and unsigned**: onboarding ends with an install, AE must be restarted, and debug mode is turned on. This is the biggest first-run hurdle.
2. **Two places to act**: some things (Main Comps, add-project) are in the AE panel, others in the app. The split is deliberate but a new user must learn which is which.
3. **"Current" `.aep` is manual**; the app never guesses.
4. **No global search** and no cross-project view of colors/expressions.
5. **Name**: "Murre" is auto-corrected to "sequence" by Google (owner's screenshot), which hurts discovery.
6. **Help button has no destination yet.**
7. **No export/archive/hand-off flow.**

### Specific to motion designers vs generic project management
- **Specific**: `.aep` version timeline; Main Comps and `aerender`; colors-in-use with comp›layer›property locations; expressions grouped by identical code; copy-and-relink of footage; Send image to After Effects; reference board with video and PDF; numbered AE-style folder scaffold; render approval that notices the file changed.
- **Generic**: kanban by status, calendar, to-do list, notes, Spaces, priority/client/deadline fields.
- [Interpretation] The generic layer is the way in; the AE-specific layer is the reason to stay.

---

## 7. Product Differentiation: the five strongest capabilities

### 1. Add an existing, running AE project in one click
- **Problem**: bringing a month-old project into any organizing system means manual folder building and broken file links.
- **Solution**: "Add this project to Murre" from the AE panel or app: new folder structure, a *copy* of the `.aep` saved into `01 AE Workfile`, footage scanned, copied in and relinked, progress shown in both places.
- **Benefit**: a messy project becomes an organized one without ever editing the original file.
- **Why it matters**: it's the on-ramp for everyone who isn't starting from zero.
- **Evidence**: `src-tauri/src/add_project.rs`, `companion/src/js/lib/murre/starter-flow.ts`, `bridge.rs`. **Verified [Owner]** on a real project.

### 2. Colors and expressions "in use", extracted from the file
- **Problem**: reusing a palette or an expression from an old project means opening it and hunting.
- **Solution**: the Companion collects only colors actually in use and every expression, with locations; the app groups identical ones and searches them instantly.
- **Benefit**: copy a hex/expression from a past project without opening After Effects.
- **Why it matters**: motion designers re-use their own code and palettes constantly.
- **Evidence**: `companion/src/jsx/aeft/scan.ts`, `colors.rs`, `expressions.rs`, `colors-tab.tsx`, `expressions-tab.tsx`. Tested with 242 expressions on a real project [Owner]. Which-colors-count rules are documented in `MURRE-COMPANION.md`.

### 3. AEP version timeline with an explicit "current"
- **Problem**: `final_v3_FINAL2.aep`: which one is current?
- **Solution**: parse versions from filenames, show them newest first, let the user mark "Current", warn if it's missing or if a newer-saved file isn't current.
- **Benefit**: reopen the right file in the right AE version.
- **Why it matters**: it addresses the commonest reopen-after-months confusion.
- **Evidence**: `workfiles.rs`, `workfile-timeline.tsx`, `open_ae.rs`.

### 4. Safe by construction, with files that outlive the app
- **Problem**: organizing tools that hold your data hostage, or that can lose it.
- **Solution**: plain files in the project, atomic writes with backups, revisioned saves, no deletions of user media, no shell execution, localhost-only token-protected socket, no network.
- **Benefit**: trust. The project folder is usable without Murre.
- **Why it matters**: for client work, losing or leaking files is unacceptable.
- **Evidence**: `safe_fs.rs`, `notes.rs`, `references.rs`, `renders.rs`, `aerender.rs`, `bridge.rs`, `Cargo.toml` (no HTTP client). Extensive Rust unit tests (210 passing at last run) and 119 Companion unit tests.

### 5. Everything about a project in one place, fed by the file itself
- **Problem**: notes, references, to-dos, renders, deadlines and AE facts live in six apps.
- **Solution**: one project page with versions, to-dos, notes (multi-page), a reference board, colors, expressions, renders with approvals, and per-project settings, plus send-to-AE for references.
- **Benefit**: one place to look when reopening.
- **Why it matters**: the cognitive-load goal.
- **Evidence**: `project-detail-page.tsx` and its tab components.
- [Interpretation] None of these pieces is unique alone; the combination plus the AE-derived data is.

---

## 8. Product Maturity

### Implemented and verified (owner reported on a real setup)
- Add-project-from-AE flow including Save As, scan, copy and relink [Owner].
- Expressions tab on a real project (242 expressions) and its search performance [Owner].
- Colors tab, Notes (multi-page, delete flow), calendar status chips, project-tab layouts, board right-click menu: the owner reviewed them in the running app and gave feedback that was fixed. This confirms the UI, not necessarily AE-dependent data.
- Companion install and linking in the owner's own environment (they use it daily).

### Implemented but not verified in real After Effects (per FROM-CLAUDE.md; the owner may have tested some since: Unknown)
- "Open After Effects and start using" starter-project creation (launch AE, close/save logic, `open -a`, `ps` detection).
- Hidden background helper behaviors (loading on start, handing the link to the panel, scans from the helper).
- Move originals to Trash through Finder; auto-scan timing on large projects.
- Send image to After Effects (right-click).
- `aerender` rendering end to end and the progress estimate.
- Panel's folder picker (`cep.fs.showOpenDialogEx`).
- Import of an existing folder with `.murre` added.

### Partial
- Rendering: only Main Comps with unique names; progress estimated.
- Copy and relink: no image sequences; no exFAT hard-link fallback; no size prompt.
- Notes: no links between notes; undo per page.
- Help button: no destination.
- Tray icon: placeholder.

### Planned (from the owner's list; none built)
Video play control on the board; Companion "bins" organization; recorded project history; global search; project rename; opt-in usage ping; Cards/List toggle; stray `yarn.lock` and template leftovers cleanup; image sequences; notes links; a final docs pass; possibly a rename of the app; offered but not requested: a "last worked on" line and a "where I left off" pinned note.

### Known bugs and technical limitations
- macOS only; needs After Effects; unsigned Companion (PlayerDebugMode). A Mac App Store release isn't possible with the private window API.
- CSP is disabled (`csp: null`).
- 20,000 expression cap; 20 pages per notes document.
- Notes undo history resets on page switch.
- AE can't import WebP via the image-send feature.
- One render at a time; one Companion connection at a time; one project watched at a time.
- Closing the AE project mid-scan discards the scan (by design).
- No automated end-to-end test against a real After Effects; tests are Rust unit tests, Companion unit tests with a fake socket, and browser tests with stubbed Tauri commands.

---

## 9. Brand and Positioning Insights

### What the product fundamentally represents
**[Interpretation]** Continuity. It is a *project memory* for motion designers: it holds the context around an After Effects file so the file can be picked up again later. It's closer to a **logbook** or a well-labelled **studio shelf** than to a task manager.

### Personality (from the implemented experience)
Quiet, careful, honest. The copy is plain and cautious ("Files are copied, never moved or overwritten", "The current project is never guessed", "Murre only displays them; it never changes the scan"). It refuses to guess, preserves originals, and tells you when something is unverified. [Interpretation] That reads as *trustworthy craftsperson's tool*, not as a flashy productivity product.

### Emotional benefit
**Relief and confidence on reopening**: "I know where everything is, nothing was lost, and I know what I was doing." Secondary: calm (fewer file-hunting detours) and ownership (files are yours).

### Concepts and metaphors naturally associated
Memory / recall; a logbook; a studio shelf or binder; an index; bookmarks and "where I left off"; version timeline; safe-keeping; a copy rather than a move; infrastructure that stays out of the way.

### Which identity fits best
Ranked by how well the *implemented product* supports them:
1. **Continuity / memory**: reopening-after-months is the stated goal, and version timeline, notes, to-dos and extracted facts all serve it.
2. **Organization**: the numbered folder scaffold, Spaces, kanban.
3. **Creative infrastructure**: the Companion, bridge and safe file handling are plumbing.
4. **Workflow**: the weakest fit. It doesn't automate a motion-design pipeline beyond rendering and relinking.

### What the brand should communicate in the first five seconds
That this is **for After Effects projects**, that **it remembers the project for you**, and that **your files stay yours** (local, on disk). The first impression should *not* be "task manager" or "sequence/timeline editor".

*(Facts vs interpretation: the rankings and personality words above are interpretation; the quoted UI strings and file behaviors are from the code.)*

---

## 10. Product in Plain English

### One sentence
Murre is a Mac app that keeps every After Effects project organized and explained, so you can reopen it months later and know where everything is.

### 30-second elevator pitch
Motion designers lose time reconstructing old projects: which file is current, where the footage went, what the client asked for. Murre gives each project a standard folder layout and a hidden memory folder, and a small After Effects panel feeds it the colors, expressions, comps and footage from the real project file. You get one page per project with versions, notes, to-dos, references and approved renders, and when you bring in an old project it copies the footage in and relinks it without touching your original. Everything stays on your disk.

### Detailed overview (about 400 words)
Murre is a desktop app for macOS aimed at After Effects motion designers. It does two jobs. First, it gives every project a predictable home: a numbered folder structure (workfile, assets, scripts, pre-renders, renders, deliverables) and a hidden `.murre` folder that stores the project's record, notes, to-dos, settings and reference board. Second, it reads the After Effects project itself through a small extension called the Companion, which runs inside After Effects and reports compositions, footage, colors in use and every expression.

In the app, each project has a page with eight tabs. The Project tab lists every `.aep` version found in the folder and lets you mark the current one and open it in the right After Effects install, next to a to-do list. Assets is a safe browser of the folder plus a panel that copies outside footage into the project and relinks it. Renders lists rendered media, shows thumbnails, lets you approve a file (and warns if it changes afterwards), and can run Adobe's `aerender` on chosen Main Comps. Notes are multi-page rich text. References is a free-form board for images, video, PDFs, links and text, and an image can be sent straight into the active composition. Colors and Expressions show what's actually used, grouped and searchable. Settings control copy-and-relink, moving originals to the Trash, and automatic rescans.

Around that sit a Home page with a status kanban and upcoming deadlines, a calendar colored by status, user-made Spaces, and global notes and reference boards.

Its defining move is adoption: with a project already open in After Effects, one click creates a Murre project, saves a copy of the file into it, and copies and relinks footage, leaving the original untouched.

The design is conservative. Data is stored as ordinary files with atomic writes and backups; saves detect conflicts; user media is never deleted; and the app has no network features, communicating with the Companion over a token-protected localhost socket. It's a macOS-only, single-user tool at version 0.1.0; much of the After Effects integration has been built and unit tested but only partly verified against real projects.

### Three strongest user benefits
1. **Faster re-entry**: versions, notes, to-dos and approvals in one place, with the current file marked.
2. **Reuse what you've made**: colors and expressions from the project, searchable without opening After Effects.
3. **Safe organizing**: bring in messy projects without touching the original, with footage copied rather than moved, and files that stay yours.

### Most compelling real-world use case
A freelancer gets a revision request for a project finished eight months ago. They open Murre, see the project in the status board, open its page, and the Project tab shows the version they marked current and the to-dos they left. The Notes tab has the client's feedback, the Renders tab shows the approved cut, and Colors and Expressions list the palette and code they can copy into the new work. They open the `.aep` in the right After Effects version, with the footage inside the project folder, so nothing is missing.

### What Murre is NOT
- Not a cloud or collaboration service: no accounts, sync or sharing.
- Not a replacement for After Effects, a render farm, or a version-control system. It reads and organizes; it doesn't edit your composition (apart from the optional relink).
- Not a team project-management suite or time tracker.
- Not cross-platform: macOS only today.
- Not an asset library or DAM for large footage collections.
- Not a backup tool: it keeps `.bak` copies of its own metadata, not of your media.
- Not an app that guesses: it doesn't pick the "current" file, delete your media, or choose renders for you.
- Not (yet) a delivery or archiving tool: there's no export or hand-off bundle.

---

## Appendix: where to look in the code (for verification)

| Topic | Path |
|---|---|
| App routes and shell | `murre/src/App.tsx`, `src/components/app-sidebar.tsx` |
| Project tabs | `src/features/projects/detail/*` |
| Frontend ↔ backend API | `src/lib/tauri.ts` |
| Backend commands | `src-tauri/src/lib.rs` |
| Folder scaffold | `src-tauri/src/project.rs` (`PROJECT_DIRS`) |
| Safe file writes | `src-tauri/src/safe_fs.rs` |
| Companion bridge | `src-tauri/src/bridge.rs` |
| Add-project flow | `src-tauri/src/add_project.rs` |
| Render pipeline | `src-tauri/src/aerender.rs`, `render_job.rs`, `renders.rs` |
| Known limitations | `FROM-CLAUDE.md` |
| Companion scan logic | `companion/src/jsx/aeft/scan.ts`, `footage.ts`, `starter.ts` |
| Companion docs | `companion/MURRE-COMPANION.md` |
