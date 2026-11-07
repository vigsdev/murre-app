//! "Open in After Effects": opens one of a project's `.aep` files in a chosen After Effects install.
//!
//! Only files inside the project are opened, only `.aep`/`.aepx`, and the After Effects app has to be one that
//! was found in a standard install folder (or the folder of the aerender the person chose in Settings), so a
//! request cannot make the app launch an arbitrary program. No shell is involved.

use crate::aerender::Install;
use crate::assets;
use crate::error::{AppError, AppResult};
use crate::project::invalid;
use crate::workfiles::{Workfile, WorkfileScan};
use std::fs;
use std::path::{Path, PathBuf};

/// Which file "Open in After Effects" opens when none is named: the one marked as current (if it still
/// exists), else the highest version, else the most recently changed.
pub fn pick(scan: &WorkfileScan) -> Option<&Workfile> {
    if scan.current_aep.as_ref().is_some_and(|c| c.exists) {
        if let Some(w) = scan.workfiles.iter().find(|w| w.is_current) {
            return Some(w);
        }
    }
    scan.workfiles
        .iter()
        .filter(|w| w.is_latest_version && w.version.is_some())
        .max_by_key(|w| (w.version, w.modified_at))
        .or_else(|| scan.workfiles.first())
}

/// The After Effects app bundle that belongs to an `aerender` path: the `.app` in the same install folder
/// (the Render Engine app is not the one to open projects with).
pub fn app_for_aerender(aerender: &Path) -> Option<PathBuf> {
    let mut dir = aerender.parent();
    for _ in 0..3 {
        let d = dir?;
        if let Ok(entries) = fs::read_dir(d) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.ends_with(".app") && name.contains("After Effects") && !name.contains("Render Engine") && e.path().is_dir() {
                    return Some(e.path());
                }
            }
        }
        dir = d.parent();
    }
    None
}

/// The app to open with. `wanted` is an `aerender` path from the list of installs; with none, the saved choice, else the newest
/// install, is used (a newer After Effects opens older projects, but never the other way round).
/// `Ok(None)` means no install was found, and the system's default for `.aep` files should be used.
pub fn choose_app(wanted: Option<&str>, saved: Option<&str>, detected: &[Install]) -> AppResult<Option<PathBuf>> {
    match wanted {
        Some(w) => {
            let known = detected.iter().any(|i| i.path == w) || saved == Some(w);
            if !known {
                return invalid("That After Effects is not one of the installed versions. Pick one from the list.");
            }
            match app_for_aerender(Path::new(w)) {
                Some(app) => Ok(Some(app)),
                None => invalid("The After Effects app for that version could not be found."),
            }
        }
        // The After Effects chosen during setup (or in Settings) comes first, then the newest install.
        None => Ok(saved
            .and_then(|s| app_for_aerender(Path::new(s)))
            .or_else(|| detected.iter().find_map(|i| app_for_aerender(Path::new(&i.path))))),
    }
}

/// Whether a line of `ps` output is the After Effects app (not the render engine or `aerender`).
fn is_ae_process(command: &str) -> bool {
    command.contains("/Contents/MacOS/After Effects") && !command.contains("Render") && !command.contains("aerender")
}

/// Whether After Effects (any version) is running.
pub fn is_running() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    match crate::platform::command("ps").args(["-axo", "command="]).output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).lines().any(is_ae_process),
        Err(_) => false,
    }
}

/// The `.app` of a running After Effects, from a line of `ps` output.
fn app_of(command: &str) -> Option<PathBuf> {
    if !is_ae_process(command) {
        return None;
    }
    let end = command.find(".app/Contents/MacOS/")? + ".app".len();
    Some(PathBuf::from(&command[..end]))
}

/// The After Effects that is running now, if any (the first one found).
pub fn running_app() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = crate::platform::command("ps").args(["-axo", "command="]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().find_map(app_of)
}

/// Start After Effects (or bring it forward) without opening a file.
pub fn launch(app: &Path) -> AppResult<()> {
    if !cfg!(target_os = "macos") {
        return invalid(format!("Opening After Effects from Murre isn’t available on {} yet.", crate::platform::OS_NAME));
    }
    let status = crate::platform::command("open").arg("-a").arg(app).status().map_err(|e| AppError::io(app, e))?;
    if status.success() {
        Ok(())
    } else {
        invalid("macOS could not start After Effects.")
    }
}

fn check_aep(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let target = assets::open_target(root, rel)?;
    let ext = target.extension().map(|e| e.to_string_lossy().to_lowercase());
    if !matches!(ext.as_deref(), Some("aep") | Some("aepx")) {
        return invalid("Only After Effects projects (.aep) can be opened in After Effects.");
    }
    Ok(target)
}

/// Open `rel` (a path inside `root`) in `app`, or with the system default when `app` is `None`.
pub fn open(root: &Path, rel: &str, app: Option<&Path>) -> AppResult<()> {
    if !cfg!(target_os = "macos") {
        return invalid(format!("Opening projects in After Effects from Murre isn’t available on {} yet.", crate::platform::OS_NAME));
    }
    let target = check_aep(root, rel)?;
    let mut cmd = crate::platform::command("open");
    if let Some(app) = app {
        cmd.arg("-a").arg(app);
    }
    // Both paths are absolute, so neither can be read as an option.
    let status = cmd.arg(&target).status().map_err(|e| AppError::io(&target, e))?;
    if status.success() {
        Ok(())
    } else {
        invalid("macOS could not open that project in After Effects.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workfiles::CurrentAep;

    #[test]
    fn only_the_after_effects_app_counts_as_running() {
        assert!(is_ae_process("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects"));
        assert!(is_ae_process("/Applications/Adobe After Effects (Beta)/Adobe After Effects (Beta).app/Contents/MacOS/After Effects (Beta)"));
        assert!(!is_ae_process("/Applications/Adobe After Effects 2026/aerender -project x"));
        assert_eq!(
            app_of("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects -psn_0"),
            Some(PathBuf::from("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"))
        );
        assert_eq!(app_of("/Applications/Adobe After Effects 2026/aerender -project x"), None);
        assert!(!is_ae_process("/Applications/Adobe After Effects 2026/Adobe After Effects Render Engine.app/Contents/MacOS/After Effects Render Engine"));
        assert!(!is_ae_process("/usr/bin/vim notes.txt"));
    }

    fn wf(path: &str, version: Option<u32>, latest: bool, current: bool, modified: u64) -> Workfile {
        Workfile {
            path: path.into(),
            absolute_path: format!("/p/{path}"),
            name: path.into(),
            size_bytes: 1,
            modified_at: modified,
            version,
            is_latest_version: latest,
            is_current: current,
            note: None,
        }
    }

    fn scan(files: Vec<Workfile>, current: Option<(&str, bool)>) -> WorkfileScan {
        WorkfileScan {
            workfiles: files,
            current_aep: current.map(|(p, exists)| CurrentAep { path: p.into(), marked_at: 1, exists }),
            truncated: false,
        }
    }

    #[test]
    fn current_file_wins_then_highest_version_then_newest() {
        let s = scan(
            vec![wf("a_v06.aep", Some(6), true, false, 9), wf("a_v05.aep", Some(5), false, true, 5)],
            Some(("a_v05.aep", true)),
        );
        assert_eq!(pick(&s).unwrap().path, "a_v05.aep");

        // the marked file is gone: fall back to the highest version
        let s = scan(
            vec![wf("a_v05.aep", Some(5), false, false, 9), wf("a_v06.aep", Some(6), true, false, 5)],
            Some(("gone.aep", false)),
        );
        assert_eq!(pick(&s).unwrap().path, "a_v06.aep");

        // no versions at all: the first (newest) file
        let s = scan(vec![wf("x.aep", None, false, false, 9), wf("y.aep", None, false, false, 5)], None);
        assert_eq!(pick(&s).unwrap().path, "x.aep");

        assert!(pick(&scan(vec![], None)).is_none());
    }

    #[test]
    fn app_is_found_next_to_aerender_and_render_engine_is_skipped() {
        let d = tempfile::tempdir().unwrap();
        let folder = d.path().join("Adobe After Effects 2026");
        fs::create_dir_all(folder.join("Adobe After Effects Render Engine.app")).unwrap();
        fs::create_dir_all(folder.join("Adobe After Effects 2026.app")).unwrap();
        fs::write(folder.join("aerender"), b"x").unwrap();
        let app = app_for_aerender(&folder.join("aerender")).unwrap();
        assert!(app.ends_with("Adobe After Effects 2026.app"));
        assert!(app_for_aerender(&d.path().join("nothing/aerender")).is_none());
    }

    #[test]
    fn only_known_installs_can_be_chosen() {
        let d = tempfile::tempdir().unwrap();
        let folder = d.path().join("Adobe After Effects 2025");
        fs::create_dir_all(folder.join("Adobe After Effects 2025.app")).unwrap();
        let path = folder.join("aerender").to_string_lossy().into_owned();
        let detected = vec![Install { path: path.clone(), label: "Adobe After Effects 2025".into(), version: None }];

        assert!(choose_app(Some(&path), None, &detected).unwrap().unwrap().ends_with("Adobe After Effects 2025.app"));
        assert!(choose_app(Some("/bin/sh"), None, &detected).is_err(), "arbitrary programs are refused");
        assert!(choose_app(None, None, &detected).unwrap().is_some(), "default is the newest install");
        assert!(choose_app(None, None, &[]).unwrap().is_none(), "none found: use the system default");
    }

    #[test]
    fn the_saved_choice_is_the_default_over_the_newest_install() {
        let d = tempfile::tempdir().unwrap();
        let mut installs = Vec::new();
        for label in ["Adobe After Effects 2026", "Adobe After Effects 2025"] {
            let folder = d.path().join(label);
            fs::create_dir_all(folder.join(format!("{label}.app"))).unwrap();
            installs.push(Install { path: folder.join("aerender").to_string_lossy().into_owned(), label: label.into(), version: None });
        }
        let saved = installs[1].path.clone();
        let app = choose_app(None, Some(&saved), &installs).unwrap().unwrap();
        assert!(app.ends_with("Adobe After Effects 2025.app"), "the saved 2025 wins over the newest 2026");
        let app = choose_app(None, None, &installs).unwrap().unwrap();
        assert!(app.ends_with("Adobe After Effects 2026.app"));
    }

    #[test]
    fn only_aep_files_inside_the_project_are_opened() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("a.aep"), b"x").unwrap();
        fs::write(d.path().join("notes.txt"), b"x").unwrap();
        assert!(check_aep(d.path(), "a.aep").is_ok());
        assert!(check_aep(d.path(), "notes.txt").is_err());
        assert!(check_aep(d.path(), "../a.aep").is_err());
        assert!(check_aep(d.path(), "missing.aep").is_err());
    }
}
