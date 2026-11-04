# Windows port: plan

Status: **plan only, nothing implemented.** Waiting for approval before any code changes.

Goal: GitHub Actions builds a Windows installer (NSIS `.exe`, x86_64) alongside the existing Apple Silicon build, from one tag, into one draft release. The Mac build keeps working as it does now. Work happens on a branch with a pull request. Nothing is pushed to `main` and no tags are made.

There's no Windows PC with After Effects. GitHub's `windows-latest` runner is the only place the Windows build is compiled, tested and packaged. Throughout this plan:
- **Verified** means it compiles, its unit tests pass, or it packages, on CI.
- **Untested** means it still has to be tried with real After Effects on a real PC.

## Summary

- **The Rust code already compiles for Windows.** `cargo check --target x86_64-pc-windows-gnu --all-targets` (cross-checked from Linux, November 2026) finishes with no errors and two dead-code warnings (`notes::save`, `aerender::save_path`). The Mac-only parts are behind `cfg!(target_os = "macos")` checks, so on Windows they return "only supported on macOS" or quietly do nothing.
- So a Windows build today **would build and start**, but these would not work: opening files, Open in After Effects, the "is After Effects running" check, plug-in and version detection, Companion install (wrong folder, no `unzip`), the PlayerDebugMode toggle, Package as zip, moving originals to the Trash, and the bundled FFmpeg (wrong file names). Render cancel would only half-work, and every helper program would flash a console window.
- Most of the work is replacing about 20 `Command::new` call sites and a few hard-coded Mac paths with Windows equivalents. There is one real design change (render cancellation with a Windows Job Object), plus FFmpeg and the release pipeline.
- **Rough total:** about 2 weeks of focused work, plus a test pass on a Windows PC with After Effects. Much of it can't be confirmed without that PC (see the table near the end).

Sizes used below: **S** = under half a day, **M** = 1–2 days, **L** = 3 days or more.

## How this was checked

- Read every `Command::new`, every `cfg(...)`, and every hard-coded path in `src-tauri/src`, `murre-ae/src`, `src/`, `scripts/` and `.github/workflows`.
- Cross-compiled the Rust crate for `x86_64-pc-windows-gnu` (zig as the C compiler, `llvm-windres` for the resource file). It compiled after one problem, described in item 1.1. The release build would use `x86_64-pc-windows-msvc` on `windows-latest`. The `cfg` logic is the same, but that target was not linked here.
- Docs used:
  - Adobe CEP 12 HTML Extension Cookbook (on GitHub, `Adobe-CEP/CEP-Resources`): CEP folders and PlayerDebugMode.
  - The Tauri crate sources in this lockfile (tauri 2.12.5, tauri-utils 2.10.2, tauri-plugin-updater 2.14.1, tauri-plugin-opener 2.7.2, window-vibrancy 0.8.1): window config, platform config files, updater targets, opener API.
  - tauri-action README and `src/upload-version-json.ts`: how `latest.json` is merged.
  - BtbN/FFmpeg-Builds README: Windows LGPL builds.
- **Not reachable from this session:** `helpx.adobe.com` and `v2.tauri.app`. The Adobe install paths for Windows below (`Support Files\aerender.exe`, `AfterFX.exe`, plug-in folders) come from Adobe's help pages as I know them. They are marked **(confirm)** and have to be checked on a real install before relying on them. The existing detector already looks for `Support Files/aerender.exe`, which matches.

---

## 0. Groundwork (do first)

### 0.1 A small `platform` helper module (S)

One place for the few Windows details that every other item needs:

- **No console windows.** `main.rs` uses `windows_subsystem = "windows"` in release builds. A GUI program that starts a console program (ffprobe, ffmpeg, aerender, tasklist, reg) opens a console window for it unless the process is created with `CREATE_NO_WINDOW` (`0x08000000`, set through `std::os::windows::process::CommandExt::creation_flags`). Nothing in the code sets it today. Add a helper, `platform::command(path) -> Command`, that sets the flag on Windows and does nothing elsewhere, and use it at every call site.
- **Plain paths from `canonicalize`.** On Windows, `std::fs::canonicalize` returns verbatim paths (`\\?\C:\Users\…`). `assets::resolve_inside`, `renders`, `workfiles` and others canonicalize, and some of those paths reach the UI (`absolutePath`), `revealItemInDir`, aerender's `-project`/`-output`, and `.murre` JSON. Many programs, After Effects likely among them, don't accept `\\?\` paths. Use `dunce::canonicalize` (`dunce` 1.0.5 is already in `Cargo.lock` through Tauri, so this adds no new code). It returns the normal form when that form is safe, and is identical to std on macOS.
- **Program names.** Use `std::env::consts::EXE_SUFFIX` wherever a program is looked up by name (`ffmpeg` → `ffmpeg.exe`).

### 0.2 CI on every push, and a build-only Windows run (S)

There are two workflows. Neither makes a release.

- **New `ci.yml`**: runs on every push to a branch and on pull requests, as a matrix of `macos-latest` and `windows-latest`. Each job runs:
  - `cargo test` in `src-tauri`
  - `npx tsc --noEmit` and `npm run build` for the app
  - `npx tsc --noEmit` and `npm test` in `murre-ae`

  This is how "`cargo test` and `tsc` still pass on macOS" gets checked, since this work happens in a Linux cloud session, not on a Mac.
- **`release.yml` gets `workflow_dispatch`**: run by hand from the Actions tab, it builds both installers with the same steps as a release, but doesn't create a release. It uploads them as workflow artifacts to download and try, so the Windows installer can be checked without tagging. Tagged pushes behave as before, plus the Windows job (see 8.1).

Many existing tests are `#[cfg(unix)]` (symlinks, fake `aerender` shell scripts, `libc::kill`), so they skip themselves on Windows. Windows equivalents get added with each item below.

---

## 1. Building and packaging

### 1.1 FFmpeg stand-ins in `build.rs` (S)

**Found by the cross-compile:** Tauri wants `binaries/ffmpeg-<triple>.exe` on Windows, and `build.rs` writes stand-ins without `.exe`, so the build stops with `resource path binaries/ffmpeg-x86_64-pc-windows-gnu.exe doesn't exist`. Add `.exe` when the target contains `windows`. The stand-in content (`#!/bin/sh … exit 1`) is not a valid Windows program, which is fine: `renders::runs()` treats a program that fails to start as "not there".

### 1.2 Finding the bundled FFmpeg (S)

`renders::bundled_tool` looks for `current_exe().parent().join("ffmpeg")`. On Windows the sidecar is `ffmpeg.exe` next to `Murre.exe`. `find_tool` also searches Homebrew and MacPorts folders and joins `PATH` entries without `.exe`. Fix the program name. On Windows, search `PATH` only. Error messages say `brew install ffmpeg`, so give Windows its own wording.

### 1.3 A Windows FFmpeg build (M)

`scripts/make-ffmpeg.sh` can't run on Windows (`sysctl`, `codesign`, `lipo`, `-mmacosx-version-min`). There are two ways:

- **A. Build our own, same configure flags (recommended).** Write `scripts/make-ffmpeg-windows.sh` to run under MSYS2 (`msys2/setup-msys2` on `windows-latest`, MinGW-w64 toolchain). Use the same `--disable-gpl --disable-autodetect … --enable-encoder=mjpeg` flags, so the Windows binaries match the Mac ones: every decoder, LGPL, no outside libraries. Output: `ffmpeg-x86_64-pc-windows-msvc.exe` and `ffprobe-…`, cached in CI the same way as on the Mac. A MinGW-built `.exe` runs fine as a sidecar of an MSVC-built app, because they are separate processes.
- **B. Download BtbN's `win64-lgpl` static build.** It's quicker, but it includes many more libraries than ours (bigger download, a different set of codecs to list in `THIRD-PARTY.md`), and it's a third-party binary we didn't build. Use it only if A turns out to be hard.

Either way, `THIRD-PARTY.md` (it mentions `Murre.app/Contents/MacOS`) and `npm run credits` need a Windows pass. `FROM-CLAUDE.md` already notes the credits must be regenerated for a Windows target.

### 1.4 Window chrome: `tauri.windows.conf.json` (S)

Tauri merges a `tauri.windows.conf.json` over `tauri.conf.json` on Windows (confirmed in `tauri-utils` `config/parse.rs`). Put the Windows-only window settings there and leave the Mac config alone:

- `titleBarStyle`, `hiddenTitle` and `trafficLightPosition` are macOS-only and already ignored on Windows.
- `macOSPrivateApi` is a no-op since Tauri 2.12.1 (per its own doc comment) and only applies to macOS.
- `transparent: true`: set it to **false** on Windows. The translucent CSS is already limited to `html.is-mac`, so Windows pages are solid, but a transparent window with no blur behind it risks see-through edges and a white flash.
- Keep the **native Windows title bar** (`decorations: true`) to start. The `is-mac` CSS that leaves room for the traffic lights doesn't apply, so the layout simply starts below the title bar. A custom title bar (`decorations: false` plus our own minimise, maximise and close buttons) is a later, separate decision (M).
- Optional, later: `window_vibrancy::apply_mica` exists for Windows 11 (confirmed in window-vibrancy 0.8.1). It is purely cosmetic, so skip it for the first build.
- `bundle.windows`: NSIS installer, `installMode: "currentUser"` (no administrator password, matching how the Companion install works). WebView2 is part of Windows 11 and current Windows 10. The NSIS default bootstrapper covers machines without it.

### 1.5 App menu, tray and close behaviour (S–M)

- `install_app_menu` calls `app.set_menu`. On Windows that puts a menu bar ("Murre ▸ About / Check for updates / Settings…") inside the window under the title bar, which looks wrong with this UI. **On Windows, skip the menu.** Then:
  - Add a frontend `Ctrl+,` handler that does what `menu:open-settings` does today.
  - Put **Check for updates** in Settings (and in the tray menu).
- `set_activation_policy` (Dock hiding) and `RunEvent::Reopen` are macOS-only and already behind `cfg`. No change needed.
- The tray icon works on Windows. `icon_as_template(true)` is macOS-only and harmless elsewhere. The tray PNG is designed as a black Mac template icon, so it would be nearly invisible on a dark Windows taskbar. **Add a Windows tray icon** (S).
- **Decision for you:** closing the window currently hides Murre to the tray. Windows users often expect the close button to quit. Keep the tray behaviour (it keeps the Companion link and render jobs alive), but show a one-time "Murre is still running in the tray" notice on Windows.
- Autostart: `MacosLauncher::LaunchAgent` is ignored on Windows. The plugin uses the registry Run key there. No change.

---

## 2. Opening files and "Show in Finder"

### 2.1 `assets::open_file` (S)

It uses macOS `open`. Replace it with `tauri-plugin-opener`'s Rust API `app.opener().open_path(path, None::<&str>)`, which exists in opener 2.7.2 and works on both systems. This drops the `cfg!(macos)` guard and keeps every existing safety check (`open_target`, blocked extensions). `revealItemInDir` (already used from the frontend) works on Windows and opens Explorer with the file selected.

Note: `BLOCKED_EXTENSIONS` must include Windows executables and scripts (`exe`, `bat`, `cmd`, `com`, `ps1`, `vbs`, `js`, `msi`, `lnk`, `scr`…) before `open_path` is enabled on Windows. Opening a `.bat` from a project folder would run it.

### 2.2 Wording (S)

There are 12 "Finder", 14 "this Mac" and 5 "macOS" strings in the frontend, plus about 10 in Rust error messages. Add one small helper (`fileManagerName()` → "Finder" or "File Explorer", `computerName()` → "this Mac" or "this PC") and switch the labels. Shortcut hints that say `Cmd+`/`⌘` become `Ctrl+` on Windows (the key handlers already accept `ctrlKey`). Use the Murre copy voice for the new strings.

---

## 3. Finding and opening After Effects

### 3.1 Install detection: `aerender.rs` (S)

`detect()` already also looks in `C:\Program Files\Adobe` and already tries `Support Files/aerender.exe`, so it should find a Windows install today **(confirm)**. Changes:

- Read the folder from `%ProgramFiles%` instead of hard-coding `C:\`.
- `app_version()` reads `*.app/Contents/Info.plist`, which doesn't exist on Windows, so Windows installs sort by the year in the folder name. That works for "Adobe After Effects 2026" but gives **no version for the Beta folder** (it has no year). On Windows, take the version from the `aerender -version` line that `validate()` already reads, and keep it on the `Install`.
- `validate()` already accepts `aerender.exe`. `is_executable` is already `true` on non-Unix systems.

### 3.2 Plug-in folders and installed versions: `environment.rs` (S)

`default_plugin_dirs()` and `installed_years()` use `/Library/...`, `/Applications` and `$HOME/Library`. Windows equivalents **(confirm on an install)**:

- `%ProgramFiles%\Adobe\Common\Plug-ins\7.0\MediaCore` (shared plug-ins).
- `%ProgramFiles%\Adobe\Adobe After Effects <ver>\Support Files\Plug-ins` (per version).
- `installed_years()` scans `%ProgramFiles%\Adobe`. For the Beta, use the aerender version from 3.1 instead of `Info.plist`.
- The `notOnMac` font state and "Not on this Mac" text need neutral names (see 2.2).

### 3.3 Open in After Effects and launch: `open_ae.rs` (M)

- `app_for_aerender()` looks for an `After Effects*.app`. On Windows the program is `AfterFX.exe` in the same `Support Files` folder as `aerender.exe` **(confirm)**.
- `launch(app)`: start `AfterFX.exe` directly with `platform::command`. No shell.
- `open(root, rel, app)`: start `AfterFX.exe <absolute .aep path>`. Windows' own `.aep` association does the same thing, but that it accepts a project path as its argument is **(confirm)**. If no install was found, fall back to `opener.open_path(aep, None)` (the system default for `.aep`), just as the Mac uses plain `open` today.
- Argument safety: the `.aep` path is absolute, so it can't be read as a flag. Rust passes arguments through `CreateProcessW` without a shell. Since Rust 1.77.2 it refuses to start a `.bat`/`.cmd` with arguments it can't escape safely, and we only start `.exe` files anyway.

### 3.4 "Is After Effects running?" (S)

`is_running()` uses `ps -axo command=`. On Windows, run `tasklist /FI "IMAGENAME eq AfterFX.exe" /FO CSV /NH` (fixed arguments, `CREATE_NO_WINDOW`) and look for `"AfterFX.exe"` in the output. aerender runs as `aerender.exe`, so the existing rule "not the render engine, not aerender" still holds. Whether a headless aerender render starts a separate `AfterFX` process on Windows is **(confirm)**. If it does, the check needs the parent process too.

---

## 4. Rendering with aerender

### 4.1 Cancel (M), the one real redesign

Today, Unix starts aerender in its own process group (`process_group(0)`) and cancels with `killpg(SIGTERM)`, then `SIGKILL` after a grace period. The non-Unix branch already exists, but it's weak:

- `taskkill /PID n /T` without `/F` asks the program to close its windows. aerender has no window, so the **polite step does nothing**, and only the forced `/F` step after the grace period works.
- `taskkill` finds children by walking parent IDs, so it can miss a child whose parent already exited, and it opens a console window (no `CREATE_NO_WINDOW`).

Plan: use a **Windows Job Object**, the documented Windows way to own a process tree.

1. After `spawn()`, `CreateJobObjectW` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then `AssignProcessToJobObject(job, child_handle)`. Every process aerender starts joins the job automatically.
2. Cancel calls `TerminateJobObject(job, 1)`, which stops the whole tree at once.
3. Because of KILL_ON_JOB_CLOSE, if Murre itself crashes or is closed, Windows stops the render with it, so no headless After Effects is left running.

The calls come from `windows-sys` (0.61 is already in `Cargo.lock`), with features `Win32_System_JobObjects`, `Win32_System_Threading` and `Win32_Foundation`. This is a small `unsafe` block with a `SAFETY` note, like the current `killpg`.

**Limitation to accept:** Windows has no equivalent of `SIGTERM` for a console program that has no console of its own, so cancel on Windows is **always immediate**. The render log should say so. The existing code already treats an output file from a cancelled render as unfinished. Check on Windows that a half-written `.mov` is handled the same way.

### 4.2 Starting the render (S)

Use `platform::command` so no console window appears. Arguments are already a `Vec` (no shell). `-output` gets a Windows path. Comp names with non-ASCII characters go through `CreateProcessW` as UTF-16, so they should arrive intact **(confirm with a non-ASCII comp name)**.

### 4.3 Progress parsing (testing only)

aerender's stdout format on Windows should be the same as on the Mac, but that is **(confirm)**. The parser in `render_job.rs` needs one real Windows log sample added as a test fixture.

### 4.4 Tests (S)

The render tests use a shell script as a fake aerender, so they are `#[cfg(unix)]`. For Windows, build a tiny fake-aerender test binary (a `[[bin]]` used only by the tests, or a `tests/fixtures` crate) that prints progress lines and sleeps. Then cancel is tested by checking that its child process is gone.

---

## 5. Installing the Companion

### 5.1 The CEP folder (S)

`target_dir()` is `~/Library/Application Support/Adobe/CEP/extensions/com.murre.cep`. Per the CEP 12 Cookbook, the per-user folder on Windows is `C:\Users\<USERNAME>\AppData\Roaming\Adobe\CEP\extensions`. Build it from Tauri's roaming app data base (`%APPDATA%`, which is the same folder), not by joining `home` + `AppData\Roaming`, so redirected profiles work. Like on the Mac, no administrator password is needed.

The "developer symlink is never replaced" rule still works on Windows (`symlink_metadata` reports a symlink). Windows developers usually make **junctions** instead, which Rust's `symlink_metadata` doesn't report as symlinks. Treat a reparse point (`FILE_ATTRIBUTE_REPARSE_POINT` from `std::os::windows::fs::MetadataExt::file_attributes`) as a developer link too, so a junction is never deleted.

### 5.2 Unpacking the signed `.zxp` (S)

`bundled_version()` and `unzip_to()` start `unzip`, which Windows doesn't have. Options considered:

- **`tar.exe`**, which has shipped in `%SystemRoot%\System32` since Windows 10 1803 and reads zip files (`tar -xf pkg.zxp -C dst`, and `tar -xOf pkg.zxp CSXS/manifest.xml` for the version). No new dependency. Call it by absolute path.
- **The `zip` crate** for all platforms. It adds one dependency and is the more predictable choice if `tar.exe` gives trouble with the ZXP signature files.

**Decision: the `zip` crate, on every system.** It replaces both `unzip` calls with one small Rust function (open the archive, read `CSXS/manifest.xml`, extract every entry). The crate is already in `Cargo.lock` (zip 9.3.0, used by the updater on Windows). Murre would depend on it directly with `default-features = false, features = ["deflate-flate2"]`, which uses the `flate2` Murre already has. No new code enters the build.

The extract must refuse entries that would land outside the target folder (`..` or absolute names). The crate's `enclosed_name()` gives the safe name, and entries without one are skipped and the install fails. That's tested with a hand-made bad archive on all platforms. `tar.exe` is no longer needed.

The ZXP itself works on both systems. The signature in it covers the files, not the OS, so **the same `com.murre.cep.zxp` should load on Windows** **(confirm)**.

### 5.3 PlayerDebugMode (S)

Per the CEP 12 Cookbook, on Windows this is a **string** value `PlayerDebugMode` = `"1"` under `HKEY_CURRENT_USER\Software\Adobe\CSXS.<N>`. Map the existing three functions directly:

- enable: `reg add HKCU\Software\Adobe\CSXS.<N> /v PlayerDebugMode /t REG_SZ /d 1 /f`
- read: `reg query HKCU\Software\Adobe\CSXS.<N> /v PlayerDebugMode` (parse the `REG_SZ    1` line)
- disable: `reg delete HKCU\Software\Adobe\CSXS.<N> /v PlayerDebugMode /f`

These use fixed arguments, `%SystemRoot%\System32\reg.exe` by absolute path and `CREATE_NO_WINDOW`, the same pattern as `defaults` on the Mac. (Calling the registry API through `windows-sys` is the alternative. `reg.exe` keeps the code parallel to the Mac version and adds nothing.) This is needed only for an unsigned developer build. A signed release doesn't touch it.

### 5.4 The Companion's link to the app (already handled)

`bridge-client.ts` already looks for `%APPDATA%\com.vigs.murre\companion-bridge.json` on `win32`. That is where Tauri's `app_data_dir()` points on Windows. The bridge binds to `127.0.0.1` only. Loopback-only listeners don't normally trigger a Windows Firewall prompt **(confirm)**. The `0o600` file mode is Unix-only. On Windows, `%APPDATA%` is already per-user by its permissions, so no change is needed.

---

## 6. Paths, logs and the other Mac assumptions

### 6.1 Log redaction: `applog.rs` (S)

- `redact()` looks for `/Users/`, `/Volumes/`, `~/`, `/private/`, `/Applications/`. Add drive paths (`[A-Za-z]:\` and `:/`), UNC paths (`\\server\`) and `%USERPROFILE%`. The report uses `HOME` to replace the home folder, so use `USERPROFILE` on Windows. Add tests with Windows paths.
- `macos_version()` runs `sw_vers`. On Windows, report `Windows` plus the version from `cmd /c ver`, or skip the number. Label the line by OS.

### 6.2 Project names (S)

`project::validate_name` blocks `/ \ :` and control characters. Windows also forbids `< > " | ? *`, a trailing dot or space, and the reserved names `CON PRN AUX NUL COM1–9 LPT1–9` (with any extension). **Apply these on every platform**, so a project made on a Mac can still be opened from Windows over a shared drive.

### 6.3 Paths stored in `.murre` (no change, but test)

- Project-relative paths are already stored with `/` (`workfiles`, `assets`, `renders`, `project-link.ts` `toPosix`), and `safe_components` rejects drive prefixes and root components on Windows (`Component::Prefix`/`RootDir`). Good.
- The absolute project path lives only in SQLite (per machine), and project identity is the ID in `project.json`. So a project folder on an external drive that moves between a Mac and a PC should be found by `reconcile` as a moved project **(test)**.
- **Known limit, not fixed by this port:** footage paths inside an AEP, or Premiere project, are absolute for the system that saved them. Today Windows-made projects show "not found" on the Mac (`TESTER-GUIDE.md`, `FROM-CLAUDE.md`). On Windows the reverse happens: Mac-made projects show `/Volumes/…` footage as not found. After Effects relinks these itself when the folder layout matches. Murre should keep reporting them honestly and not try to translate paths. Update the tester guide wording to say "made on another kind of computer".
- **Absolute paths shown in the UI.** The frontend gets a file's name with `path.split("/").pop()` in `open-in-ae.tsx` (twice), `new-project-page.tsx` and `workfile-timeline.tsx`. On Windows that prints the whole `C:\…` path in the toast. Split on both separators, as `footage-panel.tsx` and `companion-control.tsx` already do. Paths relative to the project (breadcrumbs in `assets-tab.tsx`) always use `/` and stay as they are.
- **A project made on a Mac, opened on Windows:** project ID, metadata, tasks, notes and references are all relative or path-free, so they open normally. Absolute paths inside `.murre` files written by the Companion (footage locations, font locations) are shown as "not found on this PC" rather than crashing. The existing "not found" states already handle a missing file. Each reader of an absolute path from `.murre` gets a test with a `/Volumes/…` path on Windows, and a `C:\…` path on the Mac.
- Path length: Rust's std uses long-path forms internally, but After Effects and aerender may not handle paths over 260 characters **(confirm)**. Deep `02 Assets/…` trees from long project names are the likely case. Show a clear error if aerender fails on one.

### 6.4 Safe writes: `safe_fs.rs` (S, mostly tests)

- `fs::rename` over an existing file works on Windows (std uses `MoveFileExW` with replace). It **fails with a sharing violation** if another process has the file open, which is more common on Windows: antivirus scanning a just-written file, or the Companion reading `comps.json`. Add a short retry (a few attempts over about 200 ms) on `PermissionDenied`/sharing errors before reporting failure. The backup and validation logic stays the same.
- `create_new` uses `hard_link` so it can't overwrite, and that **fails on FAT32/exFAT**, the usual format for drives shared between a Mac and a PC. (This is true on the Mac too, so it's an existing bug that Windows users would hit more often.) Fall back to `OpenOptions::create_new(true)` (also atomic "fail if exists") when `hard_link` reports unsupported.
- `sync_parent_dir` opens a directory, which fails on Windows. The error is already ignored. NTFS doesn't need it.

### 6.5 Fonts and packages: `package.rs`, `fonts.rs` (S)

- "Comes with macOS" checks `location.starts_with("/System/")`. On Windows, the matching check is `%SystemRoot%\Fonts`. Fonts installed by the user live in `%LOCALAPPDATA%\Microsoft\Windows\Fonts` and should be bundled, like user fonts on the Mac.
- `make_zip`: `ditto` on the Mac, the `zip` program elsewhere. Windows has no `zip` program. **On Windows, use the `zip` crate from 5.2** to write the archive (UTF-8 names, the folder itself as the top level, as `ditto --keepParent` does). **The Mac keeps `ditto`**, which works and is known good, so Mac behaviour doesn't change. The Rust path gets unit tests that run on every CI system, including a non-ASCII file name and a round trip through the reader.

### 6.6 Watchers (no change, test)

`notify` uses `ReadDirectoryChangesW` on Windows. Network shares and some external drives report changes unreliably, but the reconciliation scans already cover missed events.

---

## 7. The Companion (`murre-ae/`)

Most of it is already written for both systems:

- ExtendScript uses `File`/`fsName` and `$.os` for the path separator. `footage.ts` splits on both `/` and `\`. `aeft.ts` uses `APPDATA` on Windows. `cep.ts`'s Mac keyboard workaround already skips Windows.
- Node-side code uses `path.join`, `path.relative` and `path.sep` (native on each system).

Changes:

### 7.1 Move originals to the Recycle Bin (M, or S to turn it off)

`trash.ts` asks Finder through `osascript` and refuses on other systems. Windows options:

- **A. Turn off for the first Windows version (S, chosen).** On Windows, the project setting "Move the original files to the Trash after they are copied" is shown switched off and can't be turned on, with a line saying "Not available on Windows yet. Originals stay where they are." `trash.ts` already refuses on non-Mac systems, so a project that has the setting on from a Mac still never deletes anything on Windows. It reports "not moved" instead. Copy and Relink still work. Originals stay where they are, which is the safer default anyway.
- **B. Later:** a `trash.ps1` shipped inside the signed extension, started as `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File trash.ps1 <paths…>`. `-File` passes the paths as real arguments, never inside the script text. The script calls the .NET `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(path, OnlyErrorDialogs, SendToRecycleBin)`. Caveat: a company Group Policy can block PowerShell scripts even with `-ExecutionPolicy Bypass`. That fails safely (nothing moved, error shown).

### 7.2 Path comparison is case-insensitive on Windows (S)

`relinker.ts` (`original.startsWith(rootReal + path.sep)`) and `assets-model.ts`'s "is this file inside the project" compare strings. On Windows, After Effects may report `c:\…` while Node's `realpathSync` gives `C:\…`. A file inside the project would then count as outside and **get copied again**. On `win32`, compare lower-cased paths. Add tests that simulate `win32` with Node's `path.win32`.

### 7.3 ZXP signing (no change)

`cep.config.ts` lists both timestamp servers. The ZXP is built and signed on the Mac as today and ships inside both builds.

---

## 8. Releases

### 8.1 Workflow (M)

Turn the single job into: a `create-release` job, then a two-entry build matrix (`macos-latest` for `aarch64-apple-darwin`, `windows-latest` for `x86_64-pc-windows-msvc`), then a check job. On `workflow_dispatch` the create-release and check jobs are skipped, and the matrix uploads artifacts instead (0.2).

- Why a create-release job first: tauri-action's README says that with `releaseId` set, `tagName`/`releaseName` are not used to find the release. Two parallel jobs that each try to create the draft from `tagName` can race and make two drafts. Creating it once and passing `releaseId` (**together with `tagName`**, or the updater URLs point at `releases/latest/download/…`) avoids that.
- `latest.json`: tauri-action downloads the existing `latest.json` from the release, keeps its `platforms`, adds its own and uploads it again (read in `src/upload-version-json.ts`). So the Mac job writes `darwin-aarch64` and the Windows job adds `windows-x86_64` plus `windows-x86_64-nsis`. Set `updaterJsonPreferNsis: true` (its default is `false` "for legacy reasons"), or build only NSIS, so `windows-x86_64` points at the NSIS installer. The two jobs could still overwrite each other's `latest.json` if they finish at the same moment. Run the jobs with `max-parallel: 1`, or add a final job that checks `latest.json` lists both platforms and fails otherwise.
- Windows job steps: checkout, Node, Rust (MSVC, the default on `windows-latest`), rust-cache, FFmpeg (MSYS2, cached on `hashFiles('scripts/make-ffmpeg-windows.sh')`), `npm ci`, tauri-action with `--bundles nsis`.
- The version and notes check is a bash script. Give it `shell: bash` on Windows (Git Bash is on `windows-latest`), or run it only in the create-release job.
- Updater signatures: the Windows job uses the same `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. With `createUpdaterArtifacts: true`, the NSIS bundle gets a `.sig` next to the `-setup.exe`, and tauri-action puts that into `latest.json`.
- The updater on Windows: the plugin's default `installMode` is `passive` (a progress bar, no questions). With `currentUser` NSIS, no administrator prompt is expected. When Murre restarts into the installer, the `flush-before-restart` event has to fire first, as it does on the Mac **(confirm)**.

### 8.2 SmartScreen without a code-signing certificate (decision for you)

The Tauri updater signature (minisign) only protects updates. Windows doesn't know about it. With no Authenticode signature:

- **First download from GitHub:** Microsoft Defender SmartScreen shows "Windows protected your PC". People click **More info → Run anyway**. This is the Windows version of the Mac's "Open Anyway", and `RELEASING.md` and the tester guide need the same kind of note.
- **Updates installed by Murre:** the updater downloads the installer itself, not through a browser, so the file shouldn't get the "downloaded from the internet" mark that triggers SmartScreen. That is likely, not confirmed: **(confirm on the first Windows update)**.
- **Removing the warning** needs code signing:
  - An OV/EV certificate from a CA (yearly cost, now usually stored on a hardware token or cloud HSM).
  - Microsoft's Azure Artifact (Trusted) Signing. A monthly fee, and it's only open to some countries and account types, so check eligibility.
  - Tauri supports both through `bundle.windows.signCommand` or a certificate thumbprint. Even signed, a new publisher builds SmartScreen reputation over time.
  - Recommendation: ship unsigned to testers first, as with the Mac.

### 8.3 Docs (S)

Update `RELEASING.md` (both platforms, the draft has `Murre_x.y.z_x64-setup.exe` and its `.sig`, SmartScreen), `TESTER-GUIDE.md` (Windows install, tray, Explorer wording), `README.md`, and `MURRE-PRODUCT-BRIEF.md` / `CLAUDE.md`, which call Murre macOS-only.

---

## What can't be tested without a Windows PC with After Effects

| Area | What CI or tests can cover | Needs a real PC with AE |
|---|---|---|
| Build, installer, updater | `cargo check`/`test`, an NSIS build in CI | Installing, SmartScreen, updating from one version to the next, WebView2 on a clean machine |
| Console windows | That the flag is set | That no console window appears during scans, thumbnails or renders |
| AE detection | Fake folder layouts in tests | Real folder names, `AfterFX.exe` location, the Beta's folder name and version line |
| Open in AE / launch / running check | Argument building | That `AfterFX.exe <file.aep>` opens the project. Whether aerender starts an `AfterFX` process |
| Rendering | Fake aerender binary, the Job Object cancel | Real progress output, non-ASCII comp names, long paths, a cancelled render's partial file |
| Companion install | Folder and registry logic | That the signed ZXP loads in AE on Windows. PlayerDebugMode with an unsigned build |
| Companion ↔ app link | Already unit-tested | Firewall behaviour, `%APPDATA%` with a redirected profile |
| Paths | `path.win32` tests, Rust path tests | Drive-letter case from AE, a project drive shared between a Mac and a PC (exFAT), mapped network drives |
| FFmpeg | That the build runs `-version` in CI | Thumbnails and metadata for real renders (ProRes, H.264, PNG sequences) |
| Recycle Bin (if 7.1 B) | — | Real moves, Group Policy blocking PowerShell |
| Window look | — | Title bar, tray icon on light and dark taskbars, high-DPI scaling |

## Recommended order

The order follows the brief. All of it is on one branch with one pull request. Each step is its own commit (or a few), and after each step:
- `cargo test`, `npx tsc --noEmit` and the Companion tests pass on the CI macOS job.
- The CI Windows job is green.
- I report exactly what passed and what is still untested.

**(a) Compiles and packages on Windows, Mac-only features switched off with clear messages.** *M.*
- 0.1 platform helper (no console windows, `dunce`, `.exe` names), 0.2 CI and the build-only run.
- 1.1 `.exe` stand-ins and 1.2 tool lookup, so the installer can be packaged before the real FFmpeg exists. Until (d), thumbnails and render info say Murre's media tool isn't available.
- 1.4 `tauri.windows.conf.json`, 1.5 no menu bar on Windows, `Ctrl+,`, Check for updates in Settings, a Windows tray icon.
- 2.1 opening files through the opener plugin (with the larger blocked list), 2.2 Explorer and "this PC" wording.
- Every remaining Mac-only call (open in AE, Companion install, PlayerDebugMode, zip, Trash) says "not available on Windows yet" instead of failing oddly.
- 8.1 the Windows job in `release.yml`.
- Done when the build-only run produces a `-setup.exe` and CI is green on both systems.

**(b) After Effects detection, launch and aerender rendering.** *M.* 3.1–3.4, 4.1–4.4 (Job Object cancel, fake-aerender test binary).

**(c) Companion install.** *M.* 5.1–5.3 (`zip` crate, CEP folder, registry), 7.1 A, 7.2.

**(d) FFmpeg.** *M.* 1.3 option A (MSYS2 build with the same LGPL flags, cached in CI). `THIRD-PARTY.md` and credits updated.

**(e) Paths and the rest.** *M.* 3.2, 6.1–6.5, 7.2's tests, 8.2 and 8.3 (SmartScreen notes in `RELEASING.md` and `TESTER-GUIDE.md`, other docs).

**After the PR: a test pass on a Windows PC with After Effects**, using the table above. Only then publish a Windows build to testers.

Dependencies:
- `windows-sys` (Windows only, for the Job Object), `dunce`, and `zip` with `deflate-flate2`. All three are already in `Cargo.lock` through Tauri, so no new code enters the build.
- The build gains MSYS2 on the Windows runner (CI only) for FFmpeg.

## The ZXP signing password (done)

`murre-ae/cep.config.ts` used to have the ZXP certificate password written in it. It is now read from `MURRE_ZXP_PASSWORD`, and a signed build stops with a message when it is not set (see `RELEASING.md`). It was never a real secret: `vite-cep-plugin` makes a new self-signed certificate on every signed build, so the password only protects that throwaway file. Nothing changes for the Windows port, because the same signed ZXP ships in both builds (item 7.3).
