# Murre

A Mac app for After Effects projects.

You come back to a project six months later. There are four `.aep` files, two of them called `final`. The client's notes are in an email somewhere. A font is gone.

Murre keeps all of that next to the project, so you know where you left off.

It runs on your Mac only. No account, no cloud, works offline.

## What it does

- **Projects.** Makes a tidy folder for each new project, or adds one you already have without moving anything.
- **Versions.** Lists every `.aep` in the project, newest first. You mark which one is current. Murre never guesses.
- **Notes, to-dos and references.** Kept inside the project folder, so they move with it.
- **Renders.** Shows pre-renders, renders and deliverables with thumbnails. Mark the one the client approved. Render Main Comps with `aerender` without opening After Effects.
- **Colors, expressions and fonts.** Collected from the project by the Companion, so you can find them without digging through layers.
- **Footage.** Finds footage that lives outside the project folder and copies it in, then relinks it. Originals stay where they are.
- **Home, Calendar and Spaces.** What's due, what's in progress, and your own groups of projects.

## How it's put together

| Folder | What's in it |
|---|---|
| `src/` | The app's interface: React, TypeScript, Tailwind, shadcn/ui, Tiptap |
| `src-tauri/` | The native side: Tauri 2 and Rust. Files, SQLite, file watching, `aerender`, FFmpeg |
| `murre-ae/` | The After Effects Companion: a CEP panel and a hidden helper, built with Bolt CEP |
| `scripts/` | Build helpers for FFmpeg, credits and releases |

Each project keeps its own data in a hidden `.murre/` folder: project details, to-dos, notes, versions, renders, comps, colors, expressions and reference boards. Those files are the source of truth. The app's database is only an index, so a project still opens on another Mac.

The Companion and the app talk over a local connection on `127.0.0.1` only.

## Getting started

You need:

- macOS 12 or later. Apple Silicon for now (see Known limits).
- Node.js 24 and npm
- Rust (stable) and the Xcode command line tools: `xcode-select --install`
- After Effects, for the Companion and for rendering

Install the packages for the app and the Companion:

```bash
npm install
```

```bash
cd murre-ae && npm install
```

Build FFmpeg and FFprobe once. They ship inside the app and aren't kept in git. It takes a few minutes:

```bash
scripts/make-ffmpeg.sh
```

Run the app:

```bash
npm run tauri dev
```

### The Companion while developing

Link the Companion into After Effects, then restart After Effects:

```bash
cd murre-ae && npm run symlink
```

The panel is under Window → Extensions → Murre. Rebuild it with `npm run build` in `murre-ae`. Restart After Effects to load the new build.

## Checks

```bash
npx tsc --noEmit
```

```bash
cd src-tauri && cargo test
```

```bash
cd murre-ae && npm test
```

## Releases and updates

Push a tag and GitHub Actions builds Murre into a draft release. Installed copies update themselves once you publish it.

```bash
npm run release -- 0.2.0 "What changed."
```

[RELEASING.md](RELEASING.md) has the one-time setup (signing key, GitHub secrets) and every step.

After changing dependencies, refresh the credits list shown in Settings with `node scripts/gen-credits.mjs`.

## Known limits

- **Apple Silicon only, for now.** The Intel and universal FFmpeg files in `src-tauri/binaries/` are placeholders. Run `scripts/make-ffmpeg.sh --both` to build them.
- **The app isn't signed by Apple.** macOS will warn on first open. It also uses a private macOS feature for the translucent window, which rules out the Mac App Store.
- **The release Companion still opens debug ports** (8860, 8861). Turn off the debug file in its build config before shipping.
- **Not everything has been checked in a real After Effects.** [FROM-CLAUDE.md](FROM-CLAUDE.md) says which parts have been and which haven't.

## More reading

- [MURRE-PRODUCT-BRIEF.md](MURRE-PRODUCT-BRIEF.md): what Murre is, who it's for, and what works today
- [FROM-CLAUDE.md](FROM-CLAUDE.md): notes on each feature, how it behaves, and what's unverified
- [RELEASING.md](RELEASING.md): making a release and how updates reach people
- [TESTER-GUIDE.md](TESTER-GUIDE.md): for people trying a build
- [THIRD-PARTY.md](THIRD-PARTY.md): third-party data and FFmpeg licensing
- [murre-ae/MURRE-COMPANION.md](murre-ae/MURRE-COMPANION.md): how the Companion works
