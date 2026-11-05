//! Looking for a newer Murre, and installing it when the person says so.
//!
//! The update feed lives in `tauri.conf.json` (`plugins.updater`: public key and the address of `latest.json`). Until
//! that is filled in, nothing here runs: the plugin does not start, and "Check for updates" says so plainly. The
//! dialogs are native, so there is no page to build.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogBuilder, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::{applog, AppState};

const DISMISSED_FILE: &str = "updater-dismissed-version.txt";
const DAILY: Duration = Duration::from_secs(24 * 60 * 60);

/// The plugin started, so the feed is configured.
static READY: AtomicBool = AtomicBool::new(false);
/// A check or a prompt is already open.
static BUSY: AtomicBool = AtomicBool::new(false);

/// Starts the updater plugin. A build with no feed configured is normal, so a failure is only logged.
pub fn register(app: &AppHandle) {
    match app.plugin(tauri_plugin_updater::Builder::new().build()) {
        Ok(()) => READY.store(true, Ordering::SeqCst),
        Err(e) => applog::info("updater", &format!("Updates are not set up in this build: {e}")),
    }
}

/// Checks now and then, once a day, for as long as the app runs.
pub fn spawn_daily_checks(app: AppHandle) {
    if !READY.load(Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_secs(8)).await;
        loop {
            check(app.clone(), false);
            tokio_sleep(DAILY).await;
        }
    });
}

async fn tokio_sleep(d: Duration) {
    // `tauri::async_runtime` has no sleep of its own; a blocking sleep on the blocking pool keeps this dependency-free.
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

fn dismissed_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.state::<AppState>().paths.root.join(DISMISSED_FILE))
}

fn read_dismissed(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let v = text.trim();
    (!v.is_empty()).then(|| v.to_string())
}

fn write_dismissed(path: &Path, version: Option<&str>) {
    match version {
        Some(v) => {
            let _ = std::fs::write(path, v);
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn prompt_text(version: &str, notes: Option<&str>) -> String {
    match notes.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => format!("Murre {version} is ready.\n\n{n}"),
        None => format!("Murre {version} is ready."),
    }
}

/// Where the full error ends up, for the messages below.
const DETAILS: &str = "If it keeps happening, Settings → About → Copy report has the details.";

/// What a failed check says. The raw error goes to the log; people get a plain sentence.
fn check_failed_text(e: &tauri_plugin_updater::Error, current: &str) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        // Every address answered without an update file: none is published yet, or the site is having a moment.
        E::ReleaseNotFound => format!("Couldn’t find a newer Murre online. You have Murre {current}.\n\nIf you were expecting an update, try again later."),
        E::Reqwest(_) | E::Network(_) => "Couldn’t reach the update server. Check your internet connection, then try again.".into(),
        E::TargetNotFound(_) | E::TargetsNotFound(_) => "There’s a newer Murre, but not for this computer yet.".into(),
        E::Serialization(_) | E::Semver(_) => format!("The update information online couldn’t be read, so nothing was changed.\n\n{DETAILS}"),
        _ => format!("Couldn’t check for updates right now. Murre is fine as it is.\n\n{DETAILS}"),
    }
}

/// What a failed install says. Murre replaces itself only after the download is checked, so the current copy stays.
fn install_failed_text(e: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    let reason = match e {
        E::Reqwest(_) | E::Network(_) => "The download stopped. Check your internet connection, then try again.".to_string(),
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => {
            "The download didn’t pass Murre’s safety check, so it wasn’t installed.".to_string()
        }
        _ => DETAILS.to_string(),
    };
    format!("The update didn’t install. Your current Murre is untouched.\n\n{reason}")
}

fn parent(app: &AppHandle) -> Option<WebviewWindow> {
    // With a parent window the alert shows Murre's icon, not a generic one.
    app.get_webview_window("main")
}

fn dialog(app: &AppHandle, kind: MessageDialogKind, title: &str, text: String) -> MessageDialogBuilder<tauri::Wry> {
    let mut b = app.dialog().message(text).kind(kind).title(title);
    if let Some(w) = parent(app) {
        b = b.parent(&w);
    }
    b
}

fn main_visible(app: &AppHandle) -> bool {
    parent(app).map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false)
}

/// "Check for updates" from the menu or Settings (`manual`), or the quiet daily check. The quiet one says nothing
/// unless there is something new, and waits while the window is hidden in the menu bar.
pub fn check(app: AppHandle, manual: bool) {
    if !READY.load(Ordering::SeqCst) {
        if manual {
            dialog(&app, MessageDialogKind::Info, "Murre", "Updates aren’t set up in this build.".into()).show(|_| {});
        }
        return;
    }
    if !manual && !main_visible(&app) {
        return;
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let found = match app.updater() {
            Ok(u) => u.check().await,
            Err(e) => Err(e),
        };
        match found {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let path = dismissed_path(&app);
                if !manual && path.as_deref().and_then(read_dismissed).as_deref() == Some(version.as_str()) {
                    BUSY.store(false, Ordering::SeqCst);
                    return;
                }
                let text = prompt_text(&version, update.body.as_deref());
                let app2 = app.clone();
                dialog(&app, MessageDialogKind::Info, "Update ready", text)
                    .buttons(MessageDialogButtons::OkCancelCustom("Install and restart".into(), "Later".into()))
                    .show(move |install| {
                        if install {
                            tauri::async_runtime::spawn(install_update(app2, update));
                        } else {
                            if let Some(p) = &path {
                                write_dismissed(p, Some(&version));
                            }
                            BUSY.store(false, Ordering::SeqCst);
                        }
                    });
            }
            Ok(None) => {
                BUSY.store(false, Ordering::SeqCst);
                if manual {
                    let text = format!("You’re up to date. Murre {} is the latest.", app.package_info().version);
                    dialog(&app, MessageDialogKind::Info, "Murre", text).show(|_| {});
                }
            }
            Err(e) => {
                BUSY.store(false, Ordering::SeqCst);
                applog::warn("updater", &format!("Update check failed: {e}"));
                if manual {
                    let current = app.package_info().version.to_string();
                    // Not finding a newer release isn't a fault, so it gets the calm icon.
                    let kind = if matches!(e, tauri_plugin_updater::Error::ReleaseNotFound) {
                        MessageDialogKind::Info
                    } else {
                        MessageDialogKind::Warning
                    };
                    dialog(&app, kind, "Murre", check_failed_text(&e, &current)).show(|_| {});
                }
            }
        }
    });
}

async fn install_update(app: AppHandle, update: tauri_plugin_updater::Update) {
    // A render is a long job that the restart would cut off. Better to wait than to lose it.
    let rendering = app
        .state::<AppState>()
        .render
        .current()
        .map(|j| j.state == "running")
        .unwrap_or(false);
    if rendering {
        BUSY.store(false, Ordering::SeqCst);
        dialog(&app, MessageDialogKind::Info, "Murre", "A render is running. Update when it finishes.".into()).show(|_| {});
        return;
    }
    // Let open notes and the reference canvas save before the restart.
    let _ = app.emit("flush-before-restart", ());
    tokio_sleep(Duration::from_millis(1200)).await;

    let result = update.download_and_install(|_, _| {}, || {}).await;
    match result {
        Ok(()) => {
            if let Some(p) = dismissed_path(&app) {
                write_dismissed(&p, None);
            }
            applog::info("updater", "Update installed, restarting");
            app.restart();
        }
        Err(e) => {
            BUSY.store(false, Ordering::SeqCst);
            applog::warn("updater", &format!("Update failed: {e}"));
            dialog(&app, MessageDialogKind::Error, "Murre", install_failed_text(&e)).show(|_| {});
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_with_and_without_notes() {
        assert_eq!(prompt_text("0.2.0", None), "Murre 0.2.0 is ready.");
        assert_eq!(prompt_text("0.2.0", Some("  \n ")), "Murre 0.2.0 is ready.");
        assert_eq!(prompt_text("0.2.0", Some(" Fixes the calendar. ")), "Murre 0.2.0 is ready.\n\nFixes the calendar.");
    }

    #[test]
    fn failures_get_plain_sentences_not_raw_errors() {
        use tauri_plugin_updater::Error as E;
        let none = check_failed_text(&E::ReleaseNotFound, "0.1.1");
        assert!(none.contains("Couldn’t find a newer Murre online") && none.contains("Murre 0.1.1"), "{none}");
        assert!(!none.contains("JSON"));
        assert!(check_failed_text(&E::Network("timed out".into()), "0.1.1").contains("internet connection"));
        assert!(check_failed_text(&E::TargetNotFound("darwin-aarch64".into()), "0.1.1").contains("not for this computer"));
        assert!(check_failed_text(&E::EmptyEndpoints, "0.1.1").contains("Copy report"));

        let bad_sig = install_failed_text(&E::SignatureUtf8("x".into()));
        assert!(bad_sig.starts_with("The update didn’t install. Your current Murre is untouched.") && bad_sig.contains("safety check"));
        assert!(install_failed_text(&E::Network("reset".into())).contains("download stopped"));
    }

    #[test]
    fn a_dismissed_version_is_remembered_and_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(DISMISSED_FILE);
        assert_eq!(read_dismissed(&p), None);
        write_dismissed(&p, Some("0.2.0"));
        assert_eq!(read_dismissed(&p).as_deref(), Some("0.2.0"));
        write_dismissed(&p, None);
        assert_eq!(read_dismissed(&p), None);
    }
}
