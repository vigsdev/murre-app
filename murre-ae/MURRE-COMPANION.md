# Murre Companion (After Effects panel)

A CEP panel, built on the Bolt CEP starter, that links the open After Effects project to its
Murre project and saves what it finds for the Murre desktop app. **It only reads After
Effects.** It does not change, move, rename or create anything in your AE project.

## What it does

1. **Links the active, saved `.aep` to a Murre project.** It looks upward from the file for
   the nearest `.murre/project.json`; the project's `id` inside it is its identity.
2. **Scans** every composition for colors and expressions, and lists the compositions.
   Colors are collected only where they are actually in use (see "Which colors count").
3. **Picks Main Comps** (the compositions to render later from the desktop app): every
   composition that no other composition uses is marked on its first appearance. The panel lists
   them (read-only); changing the choice is done in the desktop app. A choice someone made is kept.
   A project with no Main Comp at all gets the default for every composition on the next scan.
4. **Organizes the project panel on every scan** (`src/jsx/aeft/organize.ts`) into the same bins the
   Murre folder uses: `01 Comps` (+ `Precomps`), `02 Assets` with `01 Images`, `02 Audios`,
   `03 PSD Files`, `04 Illustrator Files` and `Solids`. Names come from `src/shared/asset-folders.ts`,
   shared with the code that copies files into the project folder. It only moves items (and removes
   bins it empties): nothing is deleted or renamed, items already in the right bin are left alone,
   and when nothing needs moving it does nothing and adds no undo step. Items in the person's own
   bins are moved out of them. The project is not saved.
5. **Right-click menu** (next to Reload and Force Reload) with two checkboxes that are the linked project's own
   settings in `.murre/settings.json`, shared with the desktop app's Settings tab: "Relink assets
   manually" (ticked = "copy and relink automatically on every scan" is off; shows the Relink button) and
   "Scan every 5 / 10 / 20 min" (one at a time; choosing the active one again turns it off). The menu
   changes only those two fields and keeps the rest of the file. The desktop app runs the timer while it
   is connected; the panel runs it only when the app is not, so nothing scans twice.

It writes only these files, always as a complete snapshot, and only into the linked project's
`.murre/` folder: `colors.json`, `expressions.json`, `comps.json` (and `assets.json`), plus two fields of
`settings.json` when the right-click menu changes them. Writes are atomic (temp
file, then rename); the previous good file is kept as `<name>.bak`, a damaged one as
`<name>.corrupt`. A file written by a newer schema version is never overwritten. A scan is
all-or-nothing: if it fails, is cancelled, or the active project changes midway, nothing is
written.

## Running it

```
yarn            # install (first time, and after pulling these changes: adds vitest)
yarn build      # builds the panel and links it into After Effects' extensions folder
yarn test       # unit tests (no After Effects needed)
yarn dev        # hot-reload while developing
```

Unsigned panels need CEP's PlayerDebugMode turned on (see `README.md`, "Enable PlayerDebugMode").
Restart After Effects, then open **Window → Extensions → Murre**.

## Which colors count

Only colors that are in use, not every color property a layer happens to have:

- **Switched-off things give nothing**: a layer whose video switch is off, a shape group, a
  Fill or Stroke, a layer style, an effect. Nothing inside a switched-off group counts either.
- **Shape layers**: a switched-on Fill and Stroke give 2 colors; only Fill on gives 1.
- **Effects**: only an enabled **Fill**, **Gradient Ramp** (start and end colors) and
  **4-Color Gradient** (its four colors). Other effects (Tint, Drop Shadow, Glow and so on) are
  ignored. To add one, extend `COLOR_EFFECT_MATCH_NAMES` / `COLOR_EFFECT_NAMES` in `scan.ts`.
- **Layer styles**: only the ones switched on.
- **Text**: the fill and stroke color, when applied. **Solid layers**: the solid's color.
- **Ignored**: a 3D layer's Material Options (shadow color and so on).

Expressions are not filtered this way: every expression is collected, with its on/off state.

## Live link to the desktop app

When the Murre app is running, the panel connects to it over a WebSocket on `127.0.0.1` so the
app can start and cancel a scan and show progress. The app writes its port and a one-time token to
`companion-bridge.json` in its data folder (`~/Library/Application Support/com.vigs.murre/` on
macOS); the panel reads that file, connects to `ws://127.0.0.1:<port>/?token=<token>`, and keeps
retrying (1, 2, 5, then every 10 seconds) while the app is not running.

- Panel to app: `state` (open `.aep`, linked project id, scanning or not), `progress`, `scanDone`,
  `scanFailed`, `scanCancelled`. App to panel: `scan` (with the project id) and `cancel`. Every
  message has `"v": 1`; unknown messages are ignored.
- The socket carries commands and progress only. Results still go to `colors.json`,
  `expressions.json` and `comps.json` as before, so the files stay the source of truth and a
  scan started inside the panel works exactly the same with or without the app.
- The panel refuses a `scan` command if its open project is not the one the app named.
- Code: `src/js/lib/murre/bridge-client.ts` (tested with a fake socket), wired in
  `src/js/main/use-companion.ts`.

## File formats (the contract with the desktop app)

All three have `schemaVersion: 1` and `lastScanAt` (ISO time). Unknown keys are ignored by the app.

`colors.json`
`{ "colors": [ { "color": [r, g, b, a?], "comp", "compId", "layer", "property" } ] }`
Channels are After Effects' own 0–1 values. Colors outside 0–1 (32-bit HDR) are left out and
counted in the panel.

`expressions.json`
`{ "expressions": [ { "expression", "comp", "compId", "layer", "property", "enabled", "error"? } ] }`

`comps.json`
`{ "aep": { "projectId", "path", "name" }, "comps": [ { "id", "name", "width", "height",
"pixelAspect", "frameRate", "duration", "folder", "main" } ] }`
`aep.path` is relative to the project folder, with `/` separators. `id` is After Effects' item
id. It is stable inside one project file but **not unique across files**, so Main Comp choices
are carried over by id only for the same `.aep`; for a different file (e.g. a new version) only
an identical, unique comp (name, size, frame rate, duration) keeps its choice. Anything that
cannot be matched is unmarked and reported, never dropped silently.

## Layout

- `src/jsx/aeft/scan.ts` — read-only scanners that run inside After Effects (ES3-style code). `organize.ts` and `footage.ts` are the only files that change the open project.
- `src/js/lib/murre/` — project linking, safe file writes, snapshot building, scan runner, link to the app.
- `src/js/main/` — the panel UI.
- `src/shared/scan-types.ts` — data passed from After Effects to the panel.
