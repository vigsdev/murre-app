//! "Add this project to Murre": takes the project that is open in After Effects and builds a Murre
//! project around it, without touching the original file.
//!
//! Steps: make the project folder, save the open project into its `01 AE Workfile` as a copy ("Save As", so the
//! original `.aep` stays as it was), scan it, then copy the files it uses from outside into the project and
//! relink them. Started either by the Companion panel or by the app; progress goes to both.

use crate::bridge::Bridge;
use crate::project::{self, NewProject, Priority, Status};
use crate::{AppState, ae_project, premiere, versions, workfiles};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

static RUNNING: AtomicBool = AtomicBool::new(false);

/// What the app window hears while this runs.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub text: String,
    pub done: bool,
    pub ok: bool,
    /// The new project, once it exists.
    pub project_id: Option<String>,
}

pub struct Spec {
    /// Set when the panel asked, so its answers can be matched.
    pub request_id: Option<String>,
    pub name: String,
    pub parent_dir: String,
    /// Other `.aep` file names from beside the open project, to copy into the new project too.
    pub versions: Vec<String>,
    /// Full paths of Premiere Pro projects (from `premiere::find`) to collect into the new project.
    pub premiere: Vec<String>,
}

struct Reporter<'a> {
    app: &'a tauri::AppHandle,
    bridge: &'a Bridge,
    request_id: String,
    project_id: Option<String>,
}

impl Reporter<'_> {
    fn say(&self, text: &str) {
        self.send(text, false, true);
    }
    fn end(&self, text: &str, ok: bool) {
        self.send(text, true, ok);
    }
    fn send(&self, text: &str, done: bool, ok: bool) {
        // The log says that a step happened, or why it failed. A finished summary names the project, so it is not logged.
        if !done {
            crate::applog::info("add-project", text);
        } else if ok {
            crate::applog::info("add-project", "Finished");
        } else {
            crate::applog::warn("add-project", text);
        }
        let _ = self.app.emit(
            "add-project-progress",
            Progress { text: text.to_string(), done, ok, project_id: self.project_id.clone() },
        );
        self.bridge.send_add_project_status(&self.request_id, text, done, ok);
    }
}

/// Runs in the background; returns at once. Only one can run at a time.
pub fn start(app: tauri::AppHandle, spec: Spec) -> Result<(), String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A project is already being added.".into());
    }
    std::thread::Builder::new()
        .name("add-project".into())
        .spawn(move || {
            run(&app, spec);
            RUNNING.store(false, Ordering::SeqCst);
        })
        .map_err(|e| {
            RUNNING.store(false, Ordering::SeqCst);
            e.to_string()
        })?;
    Ok(())
}

fn wait<T>(timeout: Duration, bridge: &Bridge, mut check: impl FnMut() -> Option<T>) -> Result<T, &'static str> {
    let until = Instant::now() + timeout;
    loop {
        if let Some(v) = check() {
            return Ok(v);
        }
        if !bridge.is_connected() {
            return Err("After Effects closed the connection.");
        }
        if Instant::now() >= until {
            return Err("After Effects did not answer in time.");
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn run(app: &tauri::AppHandle, spec: Spec) {
    let state = app.state::<AppState>();
    let request_id = spec.request_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let Some(bridge) = state.bridge.as_ref() else {
        let _ = app.emit("add-project-progress", Progress { text: "The link to the After Effects Companion is not available.".into(), done: true, ok: false, project_id: None });
        return;
    };
    let mut rep = Reporter { app, bridge, request_id: request_id.clone(), project_id: None };
    if !bridge.is_connected() {
        return rep.end("After Effects is not connected. Open After Effects and the project you want to add.", false);
    }

    // What is open in After Effects?
    let id = uuid::Uuid::new_v4().simple().to_string();
    if bridge.request_inspect(&id).is_err() {
        return rep.end("The After Effects Companion is not connected.", false);
    }
    let open = match wait(Duration::from_secs(8), bridge, || bridge.status().inspect.filter(|r| r.request_id == id)) {
        Ok(r) => r,
        Err(m) => return rep.end(m, false),
    };
    if open.kind == "empty" {
        return rep.end("There is nothing open in After Effects. Open the project you want to add first.", false);
    }
    let file_name = if open.kind == "saved" && open.name.to_lowercase().ends_with(".aep") {
        open.name.clone()
    } else {
        ae_project::target_rel(&spec.name).rsplit('/').next().unwrap_or("Project-v1.aep").to_string()
    };

    // The Murre project.
    rep.say("Creating the project folders…");
    let record = {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        project::create(
            &conn,
            NewProject {
                name: spec.name.clone(),
                parent_dir: spec.parent_dir.clone(),
                client: None,
                deadline: None,
                priority: Priority::Medium,
                description: None,
                status: Status::InProgress,
                space_id: None,
            },
        )
    };
    let record = match record {
        Ok(r) => r,
        Err(e) => return rep.end(&e.to_string(), false),
    };
    rep.project_id = Some(record.project.id.clone());
    let root = std::path::PathBuf::from(&record.path);
    let rel = format!("{}/{}", ae_project::WORKFILE_DIR, file_name);
    let target = root.join(&rel);

    // Save a copy of the open project into it.
    rep.say("Saving the project into the new folder…");
    let sid = uuid::Uuid::new_v4().simple().to_string();
    if let Err(e) = bridge.request_save_as(&sid, &target.to_string_lossy()) {
        return rep.end(&format!("The project folder was made, but {e}"), false);
    }
    let saved = match wait(Duration::from_secs(90), bridge, || bridge.status().starter.filter(|r| r.request_id == sid)) {
        Ok(r) => r,
        Err(m) => return rep.end(&format!("The project folder was made, but {m} If After Effects is showing a dialog, close it."), false),
    };
    if !saved.ok || !target.is_file() {
        let why = saved.message.unwrap_or_else(|| "After Effects could not save the project.".into());
        return rep.end(&format!("The project folder was made, but the project was not saved into it. {why}"), false);
    }
    let _ = workfiles::set_current(&root, Some(&rel));

    // Bring along the older versions the person chose. They are copied as they are: not relinked, because only the project
    // that is open in After Effects can be.
    let mut note = String::new();
    if open.kind == "saved" && !spec.versions.is_empty() {
        rep.say("Copying the other versions…");
        let report = versions::copy_selected(std::path::Path::new(&open.path), &spec.versions, &root.join(ae_project::WORKFILE_DIR));
        note = match (report.copied.len(), report.failed.len()) {
            (0, 0) => String::new(),
            (n, 0) => format!(" {n} other {} copied.", if n == 1 { "version was" } else { "versions were" }),
            (n, f) => format!(" {n} other versions copied, {f} could not be."),
        };
    }

    // Premiere Pro projects the person chose: each is collected on its own, and a problem with one never stops the add.
    if open.kind == "saved" && !spec.premiere.is_empty() {
        rep.say("Collecting the Premiere Pro projects…");
        note.push_str(&collect_premiere(&root, std::path::Path::new(&open.path), &spec.premiere));
    }

    // Wait until the Companion reports the new file as the open project.
    let pid = record.project.id.clone();
    if wait(Duration::from_secs(30), bridge, || (bridge.status().project_id.as_deref() == Some(pid.as_str())).then_some(())).is_err() {
        return rep.end(&format!("The project was added.{note} Scan it from the Companion panel to fill Colors, Expressions and the rest."), true);
    }

    // Scan, then copy and relink.
    for (activity, verb) in [("scan", "Scanning the project…"), ("relink", "Copying files into the project…")] {
        rep.say(verb);
        let before = bridge.status().finished;
        let sent = if activity == "scan" { bridge.request_scan(&pid) } else { bridge.request_relink(&pid) };
        if let Err(e) = sent {
            return rep.end(&format!("The project was added, but the {activity} did not start: {e}"), true);
        }
        let ended = wait(Duration::from_secs(60 * 20), bridge, || (bridge.status().finished > before).then_some(()));
        if ended.is_err() {
            return rep.end(&format!("The project was added, but the {activity} did not finish."), true);
        }
        if let Some(last) = bridge.status().last.filter(|l| l.kind != "done") {
            let why = last.message.unwrap_or_default();
            return rep.end(&format!("The project was added, but the {activity} {}. {why}", last.kind), true);
        }
    }

    if let Some(l) = bridge.status().last.as_ref() {
        crate::applog::info("add-project", &format!("After Effects files: {} copied, {} already inside, {} failed", l.copied.unwrap_or(0), l.reused.unwrap_or(0), l.failed.unwrap_or(0)));
    }
    let summary = match bridge.status().last {
        Some(l) => format!(
            "Added “{}”. Copied {} files into the project, {} were already inside{}.{note}",
            record.project.name,
            l.copied.unwrap_or(0),
            l.reused.unwrap_or(0),
            match l.failed.unwrap_or(0) {
                0 => String::new(),
                n => format!(", {n} could not be copied"),
            }
        ),
        None => format!("Added “{}”.{note}", record.project.name),
    };
    rep.end(&summary, true);
}

/// Collect the chosen Premiere Pro projects into `04 Premiere & SFX`. Only files that `premiere::find` lists for this
/// After Effects project are accepted, whatever the caller sent. Returns a sentence for the summary.
fn collect_premiere(root: &std::path::Path, open_path: &std::path::Path, chosen: &[String]) -> String {
    let allowed = premiere::find(open_path);
    let dir = root.join("04 Premiere & SFX");
    let mut done = std::collections::HashMap::new();
    let (mut projects, mut copied, mut missing, mut failed) = (0usize, 0usize, 0usize, 0usize);
    for path in chosen.iter().take(premiere::MAX_PROJECTS) {
        if !allowed.iter().any(|c| &c.path == path) {
            failed += 1;
            continue;
        }
        match premiere::collect(std::path::Path::new(path), &dir, root, &mut done) {
            Ok(r) => {
                projects += 1;
                copied += r.copied;
                missing += r.missing.len();
                failed += r.failed.len();
            }
            Err(_) => {
                crate::applog::warn("premiere", "A Premiere project could not be collected");
                failed += 1;
            }
        }
    }
    if projects == 0 && failed == 0 {
        return String::new();
    }
    let mut s = format!(" {projects} Premiere Pro {} collected ({copied} files copied", if projects == 1 { "project" } else { "projects" });
    if missing > 0 {
        s.push_str(&format!(", {missing} not found"));
    }
    if failed > 0 {
        s.push_str(&format!(", {failed} could not be copied"));
    }
    s.push_str(").");
    s
}
