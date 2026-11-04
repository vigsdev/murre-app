# Murre — Development Instructions

You are helping me build **Murre**, a local-first macOS desktop application for motion designers who use Adobe After Effects.

The project is already initialized with **Tauri 2, React, TypeScript, Vite, Tailwind CSS, and shadcn/ui**.

Do not reinitialize the project or replace the existing setup.

## 1. Product

Murre is a single source of truth for After Effects projects.

It helps motion designers organize project files, track AEP versions, manage assets and renders, maintain notes and references, and automate selected After Effects workflows through a companion extension.

The app must work offline, without login or cloud services.

**Core principle:** Murre manages the workflow. After Effects handles animation.

## 2. Architecture

Use:

- React + TypeScript + shadcn/ui for the interface.
- Tauri commands and Rust for filesystem operations and native functionality.
- SQLite for the local project index, Spaces, global notes, calendar events, and app-managed data.
- JSON files inside each project's `.murre` directory for portable project-specific data.
- Tiptap for rich-text notes.
- tldraw for reference boards.
- FFmpeg/FFprobe for render metadata and previews.
- Bolt CEP + ExtendScript for the After Effects Companion.
- Adobe `aerender` for command-line rendering.

Choose additional libraries only when necessary. Prefer existing dependencies and established solutions.

Keep frontend components separate from backend business logic.

## 3. Application workflow

### First launch

Ask for the user's name and avatar. Save the profile locally in the application data directory.

Subsequent launches open the dashboard directly.

### Navigation

Sidebar:

- User profile
- New Project
- Home
- Projects
- Notes
- Calendar
- Referenxe
- Spaces (user-created project collections)
- Settings
- Help (external website)

Spaces are virtual project collections, not physical Finder folders. Users can create, rename, reorder, and change their icons.

### Project creation

Form fields:

- Project name
- Parent location (native macOS folder picker)
- Client
- Deadline
- Priority
- Description
- Status
- Space

Statuses: Not started, In progress, In review, Quality check, Completed, Archived.

Create the following structure under the selected parent directory:

```text
ProjectName/
├── 01 AE Workfile/
├── 02 Assets/
│   ├── 01 Images/
│   ├── 02 Audios/
│   ├── 03 PSD Files/
│   ├── 04 Illustrator Files/
│   ├── 05 Templates/
│   └── 06 SoundFX/
├── 03 Scripts & Storyboard/
├── 04 Premiere & SFX/
├── 05 Pre-Renders/
├── 06 Renders/
├── 07 Deliverables/
└── .murre/
    ├── project.json
    ├── tasks.json
    ├── notes.json
    ├── workfiles.json
    ├── renders.json
    ├── comps.json
    ├── colors.json
    ├── expressions.json
    └── references/
        ├── references.json
        └── media/
```

Each project has a permanent unique ID.

`project.json` is the authoritative project metadata. SQLite holds an indexed copy for fast application queries.

Use safe writes, schema validation, and recovery mechanisms. Never overwrite existing project files.

### Home

Show recent projects, active projects, upcoming deadlines, and useful quick actions.

Provide a proper empty state for new users.

### Projects

Display projects as cards with name, client, deadline, priority, and status.

Support search, sorting, filtering, editing, archiving, and removing projects from the app without deleting their Finder folders.

Support importing existing projects without forcibly reorganizing their files.

### Project details

Each project has seven tabs:

**Project**
- AEP workfile timeline.
- Detect versions using filenames and modification data.
- Allow users to explicitly mark the current AEP.
- Project to-do list saved in `tasks.json`.

**Assets**
- Browse actual project files by folder.
- Open files and reveal them in Finder.
- Distinguish files on disk from assets actually referenced inside After Effects.

**Renders**
- Browse pre-renders, renders, and deliverables.
- Display thumbnails, metadata, and playback where supported.
- Mark renders as approved.
- Support rendering selected compositions through `aerender`.

**Notes**
- Tiptap rich-text editor.
- Persist structured content to `.murre/notes.json`.

**References**
- tldraw infinite canvas.
- Support images, links, PDFs, text, and supported video embeds.
- Save canvas JSON and imported assets inside `.murre/references/`.

**Colors**
- Display color properties collected by the Companion.
- Read `.murre/colors.json`.

**Expressions**
- Display expressions collected by the Companion.
- Read `.murre/expressions.json`.
- Support searching and copying expressions.

### Global pages

**Notes:** Same editor, but global notes stored in application data.

**Referenxe:** Global reference canvas stored in application data.

**Calendar:** Display project deadlines and user-created events. Changes to project deadlines must update the corresponding project metadata.

**Settings:** Change name, avatar, and basic preferences.

## 4. After Effects Companion

Build this as a separate module after the core desktop application works.

Responsibilities:

1. Link the active saved AEP file to a Murre project.
2. Organize the After Effects Project panel into appropriate bins.
3. Detect imported assets located outside the project directory.
4. Offer safe Copy and Relink operations before introducing automatic organization.
5. Collect supported color properties and save structured scan data.
6. Collect expressions and their composition, layer, and property information.
7. Detect compositions and synchronize their metadata into `.murre/comps.json`.

### Composition synchronization

The Companion should scan compositions in the active AEP and record:

- Stable composition identifier where supported.
- Composition name.
- Width and height.
- Frame rate.
- Duration.
- Whether it is selected for desktop rendering.
- Last successful scan time.
- Associated AEP identity.

Users must be able to select which compositions are considered **Main Comps**. Do not automatically assume every composition is a final render composition.

Preserve manually selected Main Comps across scans where they can be reliably matched.

Write complete, validated snapshots rather than partial JSON updates.

### Desktop rendering using aerender

The desktop app reads `comps.json` and displays available Main Comps.

Users can select a composition, choose an output destination, and start a render using Adobe After Effects' `aerender` executable.

Requirements:

- Detect and validate the installed `aerender` path.
- Verify that the linked AEP exists and is saved.
- Verify that the selected composition still exists in the current AEP before rendering where possible.
- Use the exact composition name required by `aerender`.
- Validate output paths and render settings.
- Execute through Rust's process APIs, not a dynamically assembled shell command.
- Display progress or meaningful live status from process output.
- Capture logs and error messages.
- Support safe cancellation.
- Refresh render files after completion.
- Handle rendering failures without damaging project data.

Do not assume `comps.json` alone can render a composition. It is an index; the actual AEP and After Effects installation are still required.

Rendering must work with the Murre desktop app even when the Companion panel is closed, provided the required After Effects installation, project files, dependencies, and render configuration are available.

Do not invent unsupported aerender flags, progress APIs, or After Effects scripting capabilities.

## 5. File synchronization and reliability

- Use filesystem watchers plus reconciliation scans.
- Never rely only on modification timestamps to determine project identity.
- Handle renamed or moved project folders.
- Handle external drives being disconnected.
- Use atomic writes where supported.
- Validate JSON before reading or replacing existing data.
- Preserve backups for recovery.
- Avoid concurrent writes to the same metadata file.
- Do not delete or move original assets automatically.
- Preserve existing After Effects project dependencies.
- Do not silently overwrite approved render metadata when the underlying file changes.
- Keep the UI responsive during filesystem scans and media processing.

A project must remain usable without the Companion extension installed.

## 6. Development rules

These rules are important.

1. **Inspect the existing repository before modifying anything.**
2. Don't rebuild or replace working project configuration.
3. Implement one feature or closely related group of features at a time.
4. Don't generate the entire application in one attempt.
5. Use real Tauri commands and persistence, not fake data or simulated backend behavior.
6. Never silently substitute mocks for unfinished functionality.
7. Don't invent library APIs, Adobe APIs, or Tauri permissions.
8. Check installed versions and relevant documentation before implementing unfamiliar APIs.
9. Use TypeScript types and validate data at system boundaries.
10. Keep components small, reusable, and maintainable.
11. Avoid unnecessary abstractions, dependencies, and premature optimization.
12. Don't implement features that haven't been requested.
13. Handle loading, empty, error, and success states.
14. Protect user files above all else.
15. After each milestone, run relevant checks and tests, fix errors, and explain what is actually working.
16. If a technical limitation exists, explain it instead of inventing a workaround.

## 7. How we will work

We will build Murre incrementally.

For every phase:

1. Inspect the relevant existing code.
2. Briefly explain the implementation approach.
3. Identify any important technical limitations.
4. Implement the requested functionality.
5. Test the changes.
6. Summarize the files changed, features completed, and any remaining limitations.

Do not start the next phase until I explicitly request it.

## 8. First task

Start by inspecting the current repository.

Report:

- Existing technologies and versions.
- Current directory structure.
- Existing components and configuration.
- Missing dependencies needed for the foundation.
- Recommended implementation order.
- Any architectural issues worth fixing before development.

**Do not write or modify code yet.**

Wait for my instruction to begin Phase 1.
