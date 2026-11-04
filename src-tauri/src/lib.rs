mod activity;
mod app_data;
mod aerender;
mod assets;
mod bridge;
mod colors;
mod comps;
mod footage;
mod db;
mod error;
mod events;
mod environment;
mod expressions;
mod folders;
mod fonts;
mod greeting;
mod notes;
mod package;
mod open_ae;
mod profile;
mod project;
mod project_settings;
mod project_store;
mod recent;
mod reconcile;
mod add_project;
mod applog;
mod premiere;
mod versions;
mod ae_project;
mod companion_install;
mod render_job;
mod references;
mod renders;
mod safe_fs;
mod spaces;
mod startup;
mod tasks;
mod updater;
mod watcher;
mod workfiles;

use app_data::AppPaths;
use error::{AppError, AppResult};
use rusqlite::Connection;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

/// Closing the window leaves the app running in the menu bar. On macOS the Dock icon goes away too.
fn hide_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

fn show_main(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let open = MenuItem::with_id(app, "open", "Open Murre", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Murre", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Murre")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// The menu bar menu. Settings and "Check for updates" live here; there is no Close Window item on purpose, so
/// Cmd+W stays free for closing a tab.
fn install_app_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
    let check = MenuItemBuilder::with_id("updater.check", "Check for updates…").build(app)?;
    let settings = MenuItemBuilder::with_id("settings.open", "Settings…").accelerator("CmdOrCtrl+,").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Murre")
        .item(&PredefinedMenuItem::about(app, Some("About Murre"), None)?)
        .separator()
        .item(&check)
        .item(&settings)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().build()?;
    let menu = MenuBuilder::new(app).item(&app_menu).item(&edit).item(&window).build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "updater.check" => updater::check(app.clone(), true),
        "settings.open" => {
            show_main(app);
            let _ = app.emit("menu:open-settings", ());
        }
        _ => {}
    });
    Ok(())
}

#[tauri::command]
fn check_for_updates(app: tauri::AppHandle) {
    updater::check(app, true);
}

pub struct AppState {
    paths: AppPaths,
    db: Mutex<Connection>,
    /// Watcher for the project that is currently open, if any.
    watch: Mutex<Option<ActiveWatch>>,
    /// Live link to the After Effects Companion; `None` if it could not start.
    bridge: Option<bridge::Bridge>,
    /// The one render that may run at a time.
    render: render_job::Runner,
}

/// Dropping this stops the watcher.
struct ActiveWatch {
    project_id: String,
    _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    data_dir: String,
    schema_version: u32,
}

#[tauri::command]
fn get_app_info(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<AppInfo> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: state.paths.root.display().to_string(),
        schema_version: db::current_version(&conn)?,
    })
}

#[tauri::command]
fn get_profile(state: State<'_, AppState>) -> AppResult<Option<profile::ProfileView>> {
    profile::load(&state.paths.root)
}

/// `avatar_base64`: base64 image bytes to set/replace the avatar, or `null` to keep the current one.
#[tauri::command]
fn save_profile(
    state: State<'_, AppState>,
    name: String,
    role: Option<String>,
    avatar_base64: Option<String>,
) -> AppResult<profile::ProfileView> {
    let bytes = match avatar_base64 {
        Some(b64) => Some(
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64.as_bytes())
                .map_err(|_| AppError::Invalid("The avatar image could not be read.".into()))?,
        ),
        None => None,
    };
    profile::save(
        &state.paths.root,
        &name,
        role.as_deref().unwrap_or(""),
        bytes.as_deref(),
    )
}

// Commands below are `async` so they run off the main thread and never block the UI.
// They hold the database lock only for the duration of one synchronous call.

#[tauri::command]
async fn create_project(
    state: State<'_, AppState>,
    input: project::NewProject,
) -> AppResult<project::ProjectRecord> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project::create(&conn, input)
}

/// Remember that a project was just opened, for Home's "Pick up where you left off".
#[tauri::command]
fn mark_project_opened(state: State<'_, AppState>, project_id: String) -> AppResult<()> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    recent::mark_opened(&conn, &project_id)
}

/// Ids of the projects opened most recently, newest first.
#[tauri::command]
fn recent_projects(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    recent::list(&conn)
}

/// How long After Effects was open on each Murre project between two times (ms since the epoch).
#[tauri::command]
fn time_per_project(state: State<'_, AppState>, from: i64, to: i64) -> AppResult<Vec<activity::ProjectTime>> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    activity::timeline(&conn, from, to)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderKind {
    id: &'static str,
    label: &'static str,
    exts: Vec<&'static str>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderSetup {
    template: folders::Template,
    /// The kinds of file the editor offers, with the file types behind each.
    kinds: Vec<FolderKind>,
    is_default: bool,
}

fn folder_setup(template: folders::Template) -> FolderSetup {
    FolderSetup {
        is_default: folders::is_default(&template),
        kinds: folders::KINDS.iter().map(|k| FolderKind { id: k.id, label: k.label, exts: k.exts.to_vec() }).collect(),
        template,
    }
}

/// The folder setup new projects are made with.
#[tauri::command]
fn get_folder_setup(state: State<'_, AppState>) -> AppResult<FolderSetup> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    Ok(folder_setup(folders::load(&conn)?))
}

/// Save the folder setup. It applies to projects made from now on; existing projects keep their folders.
#[tauri::command]
fn save_folder_setup(state: State<'_, AppState>, template: folders::Template) -> AppResult<FolderSetup> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    Ok(folder_setup(folders::save(&conn, &template)?))
}

/// Go back to the folders Murre ships with.
#[tauri::command]
fn reset_folder_setup(state: State<'_, AppState>) -> AppResult<FolderSetup> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    Ok(folder_setup(folders::reset(&conn)?))
}

/// The greeting's saved state (JSON text), or nothing before the first launch.
#[tauri::command]
fn get_greeting_state(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    greeting::load(&conn)
}

#[tauri::command]
fn save_greeting_state(state: State<'_, AppState>, json: String) -> AppResult<()> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    greeting::save(&conn, &json)
}

#[tauri::command]
async fn list_projects(state: State<'_, AppState>) -> AppResult<Vec<project::ProjectRecord>> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project_store::list(&conn)
}

#[tauri::command]
async fn update_project(
    state: State<'_, AppState>,
    input: project_store::UpdateProject,
) -> AppResult<project::ProjectRecord> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project_store::update(&conn, input)
}

/// Changes only the deadline (`null` clears it) in the project's `project.json` and the index.
#[tauri::command]
async fn set_project_deadline(
    state: State<'_, AppState>,
    id: String,
    deadline: Option<String>,
) -> AppResult<project::ProjectRecord> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project_store::set_deadline(&conn, &id, deadline.as_deref())
}

/// Events with `from <= date <= to` (`YYYY-MM-DD`, at most about 800 days apart).
#[tauri::command]
async fn list_events(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> AppResult<Vec<events::Event>> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    events::list(&conn, &from, &to)
}

#[tauri::command]
async fn add_event(
    state: State<'_, AppState>,
    input: events::EventInput,
) -> AppResult<events::Event> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    events::add(&conn, &input)
}

#[tauri::command]
async fn update_event(
    state: State<'_, AppState>,
    id: String,
    input: events::EventInput,
) -> AppResult<events::Event> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    events::update(&conn, &id, &input)
}

#[tauri::command]
async fn delete_event(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    events::delete(&conn, &id)
}

#[tauri::command]
async fn list_spaces(state: State<'_, AppState>) -> AppResult<Vec<spaces::Space>> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    spaces::list(&conn)
}

#[tauri::command]
async fn create_space(
    state: State<'_, AppState>,
    name: String,
    icon: String,
) -> AppResult<spaces::Space> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    spaces::create(&conn, &name, &icon)
}

#[tauri::command]
async fn update_space(
    state: State<'_, AppState>,
    id: String,
    name: String,
    icon: String,
) -> AppResult<spaces::Space> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    spaces::update(&conn, &id, &name, &icon)
}

/// `ids`: every Space id, in the new order.
#[tauri::command]
async fn reorder_spaces(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<Vec<spaces::Space>> {
    let mut conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    spaces::reorder(&mut conn, &ids)
}

/// Deletes the Space only. Projects in it stay; they just no longer belong to a Space.
/// Projects whose folder is unavailable keep a dangling Space id, which is treated as "no Space".
#[tauri::command]
async fn delete_space(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    for project_id in project_store::ids_in_space(&conn, &id)? {
        // Best effort: an unavailable folder cannot be updated now.
        let _ = project_store::set_space(&conn, &project_id, None);
    }
    spaces::delete(&conn, &id)
}

/// Files a project into a Space (`null` removes it from its Space).
#[tauri::command]
async fn set_project_space(
    state: State<'_, AppState>,
    id: String,
    space_id: Option<String>,
) -> AppResult<project::ProjectRecord> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project_store::set_space(&conn, &id, space_id.as_deref())
}

/// Removes the project from Murre only. Files on disk are never deleted.
#[tauri::command]
async fn remove_project(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project_store::remove(&conn, &id)
}

#[tauri::command]
async fn inspect_import(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<project_store::ImportInspection> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project_store::inspect_import(&conn, &path)
}

#[tauri::command]
async fn import_project(
    state: State<'_, AppState>,
    path: String,
    create_metadata: bool,
) -> AppResult<project_store::ImportResult> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project_store::import(&conn, &path, create_metadata)
}

#[tauri::command]
async fn get_project(state: State<'_, AppState>, id: String) -> AppResult<project::ProjectRecord> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project_store::get(&conn, &id)
}

#[tauri::command]
async fn scan_workfiles(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<workfiles::WorkfileScan> {
    let root = {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        project_store::available_root(&conn, &project_id)?
    };
    workfiles::scan(&root)
}

/// `path` is relative to the project folder; `null` clears the current AEP.
#[tauri::command]
async fn set_current_aep(
    state: State<'_, AppState>,
    project_id: String,
    path: Option<String>,
) -> AppResult<workfiles::WorkfileScan> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let root = project_store::available_root(&conn, &project_id)?;
    workfiles::set_current(&root, path.as_deref())
}

/// `path` is relative to the project folder; empty `note` removes the note.
#[tauri::command]
async fn set_workfile_note(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    note: String,
) -> AppResult<workfiles::WorkfileScan> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let root = project_store::available_root(&conn, &project_id)?;
    workfiles::set_note(&root, &path, &note)
}

#[tauri::command]
async fn get_project_settings(state: State<'_, AppState>, project_id: String) -> AppResult<project_settings::ProjectSettings> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project_settings::get(&project_store::available_root(&conn, &project_id)?)
}

#[tauri::command]
async fn save_project_settings(
    state: State<'_, AppState>,
    project_id: String,
    settings: project_settings::ProjectSettings,
) -> AppResult<project_settings::ProjectSettings> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project_settings::save(&project_store::available_root(&conn, &project_id)?, settings)
}

/// Every minute or so: if the project open in After Effects has automatic scans on and the interval has passed,
/// ask the Companion to scan it. The first time a project is seen the clock starts then, so switching the
/// setting on never scans at once.
fn start_auto_scan(app: tauri::AppHandle) {
    use std::collections::HashMap;
    use std::time::{Duration, Instant};
    let _ = std::thread::Builder::new().name("auto-scan".into()).spawn(move || {
        let mut last: HashMap<String, (u32, Instant)> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_secs(20));
            let state = app.state::<AppState>();
            let Some(bridge) = state.bridge.as_ref() else { return };
            let status = bridge.status();
            let Some(pid) = status.project_id.clone().filter(|_| status.connected && !status.scanning) else { continue };
            let root = {
                let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
                match project_store::available_root(&conn, &pid) {
                    Ok(r) => r,
                    Err(_) => continue,
                }
            };
            let Ok(settings) = project_settings::get(&root) else { continue };
            let minutes = settings.auto_scan_minutes;
            if minutes == 0 {
                last.remove(&pid);
                continue;
            }
            let due = match last.get(&pid) {
                Some((m, at)) if *m == minutes => at.elapsed() >= Duration::from_secs(u64::from(minutes) * 60),
                _ => {
                    last.insert(pid.clone(), (minutes, Instant::now()));
                    false
                }
            };
            if due {
                let _ = bridge.request_scan(&pid);
                last.insert(pid, (minutes, Instant::now()));
            }
        }
    });
}

/// Add the project that is open in After Effects to Murre (the same thing the Companion panel's button does).
/// Returns at once; progress comes as `add-project-progress` events.
#[tauri::command]
async fn add_project_from_after_effects(
    app: tauri::AppHandle,
    name: String,
    parent_dir: String,
    versions: Vec<String>,
    premiere: Vec<String>,
) -> AppResult<()> {
    add_project::start(app, add_project::Spec { request_id: None, name, parent_dir, versions, premiere }).map_err(AppError::Invalid)
}

/// Other `.aep` files saved next to the project that is open in After Effects (`path` is that project's file), so the
/// person can choose which ones to bring along. Read-only.
#[tauri::command]
async fn list_other_versions(path: String) -> AppResult<Vec<versions::Candidate>> {
    tauri::async_runtime::spawn_blocking(move || versions::find(std::path::Path::new(&path)))
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))
}

/// Premiere Pro projects beside the After Effects project (or one folder above), with how much footage each uses and how much
/// of it can be found. Read-only.
#[tauri::command]
async fn list_premiere_projects(path: String) -> AppResult<Vec<premiere::Candidate>> {
    tauri::async_runtime::spawn_blocking(move || premiere::find(std::path::Path::new(&path)))
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))
}

/// The text a person can copy from Settings when something goes wrong: versions and the recent log, with file paths removed.
#[tauri::command]
fn get_diagnostic_report() -> String {
    applog::report()
}

/// The Premiere Pro projects saved in this project's `04 Premiere & SFX` folder, with how much of their footage is found.
#[tauri::command]
async fn get_premiere_projects(state: State<'_, AppState>, project_id: String) -> AppResult<Vec<premiere::Listed>> {
    let root = {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        project_store::available_root(&conn, &project_id)?
    };
    tauri::async_runtime::spawn_blocking(move || premiere::list_project(&root))
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))
}

#[tauri::command]
async fn get_tasks(state: State<'_, AppState>, project_id: String) -> AppResult<Vec<tasks::Task>> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    tasks::list(&project_store::available_root(&conn, &project_id)?)
}

#[tauri::command]
async fn add_task(
    state: State<'_, AppState>,
    project_id: String,
    title: String,
) -> AppResult<Vec<tasks::Task>> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    tasks::add(&project_store::available_root(&conn, &project_id)?, &title)
}

#[tauri::command]
async fn set_task_done(
    state: State<'_, AppState>,
    project_id: String,
    task_id: String,
    done: bool,
) -> AppResult<Vec<tasks::Task>> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    tasks::set_done(
        &project_store::available_root(&conn, &project_id)?,
        &task_id,
        done,
    )
}

#[tauri::command]
async fn delete_task(
    state: State<'_, AppState>,
    project_id: String,
    task_id: String,
) -> AppResult<Vec<tasks::Task>> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    tasks::delete(
        &project_store::available_root(&conn, &project_id)?,
        &task_id,
    )
}

/// `path` is relative to the project folder; empty means the project root.
#[tauri::command]
async fn list_assets(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> AppResult<assets::AssetListing> {
    let root = {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        project_store::available_root(&conn, &project_id)?
    };
    assets::list(&root, &path)
}

#[tauri::command]
async fn open_asset(state: State<'_, AppState>, project_id: String, path: String) -> AppResult<()> {
    let root = {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        project_store::available_root(&conn, &project_id)?
    };
    assets::open_file(&root, &path)
}

/// Where the app's copy of the Companion can be (installed app first, then the source tree when running `tauri dev`).
fn companion_bundle(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(r) = app.path().resource_dir() {
        candidates.push(r.join("companion"));
        candidates.push(r.join("companion-bundle"));
    }
    candidates.push(std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/companion-bundle")));
    companion_install::find_bundle(&candidates)
}

#[tauri::command]
async fn get_companion_install(app: tauri::AppHandle) -> AppResult<companion_install::CompanionInstall> {
    let home = app.path().home_dir().map_err(|e| error::AppError::Invalid(e.to_string()))?;
    Ok(companion_install::status(companion_bundle(&app).as_deref(), &companion_install::target_dir(&home)))
}

/// Whether After Effects is set to load panels it cannot verify (the `PlayerDebugMode` setting).
#[tauri::command]
async fn get_companion_debug_mode() -> AppResult<bool> {
    tauri::async_runtime::spawn_blocking(|| Ok(companion_install::debug_mode_enabled()))
        .await
        .map_err(|e| error::AppError::Invalid(e.to_string()))?
}

/// Turns that setting on or off for every version After Effects uses; returns how it is now.
#[tauri::command]
async fn set_companion_debug_mode(enabled: bool) -> AppResult<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        if enabled {
            companion_install::enable_debug_mode();
        } else {
            companion_install::disable_debug_mode();
        }
        Ok(companion_install::debug_mode_enabled())
    })
    .await
    .map_err(|e| error::AppError::Invalid(e.to_string()))?
}

/// Copy the Companion into After Effects' extension folder (no administrator password needed).
#[tauri::command]
async fn install_companion(app: tauri::AppHandle) -> AppResult<companion_install::CompanionInstall> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = app.path().home_dir().map_err(|e| error::AppError::Invalid(e.to_string()))?;
        let Some(bundle) = companion_bundle(&app) else {
            return Err(error::AppError::Invalid(
                "This build of Murre does not include the Companion. Run `npm run bundle:signed` in murre-ae, then rebuild the app.".into(),
            ));
        };
        let target = companion_install::target_dir(&home);
        companion_install::install_to(&bundle, &target)?;
        // A signed package loads as it is. Only an unsigned folder needs the system-wide debug setting.
        if companion_install::signed_package(&bundle).is_none() {
            companion_install::enable_debug_mode();
        }
        Ok(companion_install::status(Some(&bundle), &target))
    })
    .await
    .map_err(|e| error::AppError::Invalid(e.to_string()))?
}

/// The detected After Effects installs and the install chosen earlier (the saved aerender), if any.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AeInstalls {
    installs: Vec<ae_project::InstallOption>,
    saved_path: Option<String>,
}

#[tauri::command]
async fn get_ae_installs(app: tauri::AppHandle) -> AppResult<AeInstalls> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let saved = {
            let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
            aerender::saved_path(&conn)?
        };
        Ok(AeInstalls { installs: ae_project::options_for(&aerender::detect()), saved_path: saved })
    })
    .await
    .map_err(|e| error::AppError::Invalid(e.to_string()))?
}

/// What is going on in After Effects right now, asked before a project is created.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AeCheck {
    /// After Effects is running.
    running: bool,
    /// The Companion is connected (needed when After Effects is already running).
    connected: bool,
    /// `none` (not running), `empty`, `unsaved`, `saved` or `unknown`.
    kind: String,
    name: String,
    path: String,
    /// Where an unsaved project would be saved.
    desktop_dir: Option<String>,
}

#[tauri::command]
async fn check_after_effects(app: tauri::AppHandle) -> AppResult<AeCheck> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::time::{Duration, Instant};
        let state = app.state::<AppState>();
        let desktop_dir = app.path().desktop_dir().ok().map(|p| p.to_string_lossy().into_owned());
        let connected = state.bridge.as_ref().is_some_and(|b| b.is_connected());
        let running = connected || open_ae::is_running();
        let mut check = AeCheck { running, connected, kind: "none".into(), name: String::new(), path: String::new(), desktop_dir };
        if !connected {
            return Ok(check);
        }
        let Some(bridge) = state.bridge.as_ref() else { return Ok(check) };
        let id = uuid::Uuid::new_v4().simple().to_string();
        check.kind = "unknown".into();
        if bridge.request_inspect(&id).is_err() {
            return Ok(check);
        }
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until {
            if let Some(r) = bridge.status().inspect.filter(|r| r.request_id == id) {
                check.kind = r.kind;
                check.name = r.name;
                check.path = r.path;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(check)
    })
    .await
    .map_err(|e| error::AppError::Invalid(e.to_string()))?
}

/// Make the project's first After Effects file with After Effects itself, so it is saved by the version the person
/// uses. Starts After Effects if it is not running and asks the Companion to create a 1920x1080, 30 fps, 30 s
/// project saved as `<name>-v1.aep` in the workfile folder. Whatever project was open is saved and closed first
/// (a never-saved one goes to the Desktop). A problem is reported in the result, not as an error, because the project
/// folder already exists and stays valid.
#[tauri::command]
async fn create_starter_in_after_effects(
    app: tauri::AppHandle,
    project_id: String,
    aerender_path: Option<String>,
) -> AppResult<ae_project::CreateOutcome> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::time::{Duration, Instant};
        let state = app.state::<AppState>();
        let (root, saved) = {
            let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
            (project_store::available_root(&conn, &project_id)?, aerender::saved_path(&conn)?)
        };
        let fail = |m: &str| Ok(ae_project::CreateOutcome { added: None, previous: None, message: Some(m.to_string()) });
        let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let rel = ae_project::target_rel(&name);
        let target = root.join(&rel);
        if target.exists() {
            return fail(&format!("{rel} already exists, so nothing was created."));
        }
        let Some(bridge) = state.bridge.as_ref() else {
            return fail("The link to the After Effects Companion is not available.");
        };
        if !bridge.is_connected() {
            if open_ae::is_running() {
                return fail("After Effects is running but the Murre Companion is not connected. Restart After Effects once so it loads the Companion, then try again.");
            }
            let chosen = open_ae::choose_app(aerender_path.as_deref(), saved.as_deref(), &aerender::detect())?;
            let Some(ae) = chosen.as_deref() else {
                return fail("No After Effects installation was found.");
            };
            open_ae::launch(ae)?;
            let until = Instant::now() + Duration::from_secs(120);
            while !bridge.is_connected() {
                if Instant::now() >= until {
                    return fail("After Effects did not connect in time. Check that the Murre Companion is installed (Settings).");
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        let rescue_dir = app.path().desktop_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let request_id = uuid::Uuid::new_v4().simple().to_string();
        bridge.request_create_starter(bridge::StarterSpec {
            request_id: request_id.clone(),
            path: target.to_string_lossy().into_owned(),
            comp_name: "Main Comp".into(),
            width: 1920,
            height: 1080,
            fps: 30.0,
            seconds: 30.0,
            rescue_dir,
        })?;
        let until = Instant::now() + Duration::from_secs(90);
        loop {
            if let Some(r) = bridge.status().starter.filter(|r| r.request_id == request_id) {
                if r.ok && target.is_file() {
                    workfiles::set_current(&root, Some(&rel))?;
                    return Ok(ae_project::CreateOutcome { added: Some(rel), previous: r.previous, message: None });
                }
                return Ok(ae_project::CreateOutcome {
                    added: None,
                    previous: r.previous,
                    message: Some(r.message.unwrap_or_else(|| "After Effects could not save the project.".into())),
                });
            }
            if !bridge.is_connected() {
                return fail("After Effects closed the connection before the project was saved.");
            }
            if Instant::now() >= until {
                return fail("After Effects did not answer in time. If it is showing a dialog, close it and try again.");
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    })
    .await
    .map_err(|e| error::AppError::Invalid(e.to_string()))?
}

/// Open a project's `.aep` in After Effects. `path` is relative to the project folder; without it the
/// current (or highest-version) file is used. `app` is an `aerender` path from `get_aerender_status`
/// that picks the After Effects version; without it the newest install is used.
#[tauri::command]
async fn open_in_after_effects(
    app: tauri::AppHandle,
    project_id: String,
    path: Option<String>,
    aerender_path: Option<String>,
) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (root, saved) = {
            let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
            (project_store::available_root(&conn, &project_id)?, aerender::saved_path(&conn)?)
        };
        let rel = match path {
            Some(p) => p,
            None => {
                let scan = workfiles::scan(&root)?;
                match open_ae::pick(&scan) {
                    Some(w) => w.path.clone(),
                    None => return Err(error::AppError::Invalid("This project has no After Effects project (.aep) yet.".into())),
                }
            }
        };
        let chosen = open_ae::choose_app(aerender_path.as_deref(), saved.as_deref(), &aerender::detect())?;
        open_ae::open(&root, &rel, chosen.as_deref())?;
        Ok(rel)
    })
    .await
    .map_err(|e| error::AppError::Invalid(e.to_string()))?
}

#[tauri::command]
async fn get_notes(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> AppResult<notes::NotesView> {
    let root = scope_root(&state, &project_id)?;
    notes::get(&root)
}

/// Fails with a `conflict` error if the notes changed since `expected_revision`.
#[tauri::command]
async fn save_notes(
    state: State<'_, AppState>,
    project_id: Option<String>,
    content: serde_json::Value,
    expected_revision: u64,
    page_id: Option<String>,
) -> AppResult<notes::NotesView> {
    let root = scope_root(&state, &project_id)?;
    notes::save_page(&root, page_id.as_deref(), content, expected_revision)
}

/// Add an empty page after the last one.
#[tauri::command]
async fn add_notes_page(
    state: State<'_, AppState>,
    project_id: Option<String>,
    expected_revision: u64,
) -> AppResult<notes::NotesView> {
    let root = scope_root(&state, &project_id)?;
    notes::add_page(&root, expected_revision)
}

/// Remove a page (never the first).
#[tauri::command]
async fn delete_notes_page(
    state: State<'_, AppState>,
    project_id: Option<String>,
    page_id: String,
    expected_revision: u64,
) -> AppResult<notes::NotesView> {
    let root = scope_root(&state, &project_id)?;
    notes::delete_page(&root, &page_id, expected_revision)
}

#[tauri::command]
async fn get_colors(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<colors::ColorsView> {
    let root = project_root(&state, &project_id)?;
    colors::get(&root)
}

#[tauri::command]
async fn get_expressions(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<expressions::ExpressionsView> {
    let root = project_root(&state, &project_id)?;
    expressions::get(&root)
}

#[tauri::command]
async fn get_needs(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<environment::NeedsView> {
    let root = project_root(&state, &project_id)?;
    // Looks through plugin folders, so it runs off the main thread.
    tauri::async_runtime::spawn_blocking(move || environment::get(&root))
        .await
        .map_err(|e| crate::error::AppError::Invalid(e.to_string()))?
}

/// What would go in a delivery package, and what would greet the other person with color bars.
#[tauri::command]
async fn package_check(state: State<'_, AppState>, project_id: String) -> AppResult<package::PackageCheck> {
    let root = project_root(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || package::check(&root))
        .await
        .map_err(|e| crate::error::AppError::Invalid(e.to_string()))?
}

/// Make the delivery package. Progress is sent as `package-progress` events.
#[tauri::command]
async fn package_build(
    app: tauri::AppHandle,
    project_id: String,
    options: package::BuildOptions,
) -> AppResult<package::BuildReport> {
    let (root, name) = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let root = project_store::available_root(&conn, &project_id)?;
        let name = project_store::get(&conn, &project_id)?.project.name;
        (root, name)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        package::build(&root, &name, &options, &mut |p| {
            // Often enough to look alive, not so often that the window spends its time listening.
            if p.done_bytes == 0 || p.done_bytes >= p.total_bytes || last.elapsed() > std::time::Duration::from_millis(150) {
                last = std::time::Instant::now();
                let _ = app.emit("package-progress", p);
            }
        })
    })
    .await
    .map_err(|e| crate::error::AppError::Invalid(e.to_string()))?
}

#[tauri::command]
async fn get_fonts(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<fonts::FontsView> {
    let root = project_root(&state, &project_id)?;
    fonts::get(&root)
}

/// Compare the index with the project folders on disk. Safe to call often.
#[tauri::command]
async fn reconcile_projects(state: State<'_, AppState>) -> AppResult<reconcile::Report> {
    reconcile::run(&state.db)
}

/// Point a project whose folder was moved or renamed at its new folder.
#[tauri::command]
async fn relink_project(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> AppResult<project::ProjectRecord> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project_store::relink(&conn, &id, &path)
}

/// Start watching one project's folder (replacing any earlier watch). Changes are
/// sent to the UI as `project-files-changed` events.
#[tauri::command]
async fn watch_project(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<()> {
    use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode};

    let root = project_root(&state, &project_id)?;
    let id = project_id.clone();
    let watch_root = root.clone();
    let mut debouncer = new_debouncer(
        std::time::Duration::from_millis(500),
        move |result: notify_debouncer_mini::DebounceEventResult| {
            let Ok(events) = result else { return };
            let change =
                watcher::classify(&id, &watch_root, events.iter().map(|e| e.path.as_path()));
            if !change.is_empty() {
                let _ = app.emit("project-files-changed", change);
            }
        },
    )
    .map_err(|e| AppError::Invalid(format!("Could not start watching this project: {e}")))?;
    debouncer
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| AppError::Invalid(format!("Could not start watching this project: {e}")))?;

    *state.watch.lock().unwrap_or_else(|e| e.into_inner()) = Some(ActiveWatch {
        project_id,
        _debouncer: debouncer,
    });
    Ok(())
}

/// Stop watching `project_id`, unless another project has been watched since.
#[tauri::command]
async fn unwatch_project(state: State<'_, AppState>, project_id: String) -> AppResult<()> {
    let mut guard = state.watch.lock().unwrap_or_else(|e| e.into_inner());
    if guard.as_ref().is_some_and(|w| w.project_id == project_id) {
        *guard = None;
    }
    Ok(())
}

fn project_root(state: &State<'_, AppState>, project_id: &str) -> AppResult<std::path::PathBuf> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    project_store::available_root(&conn, project_id)
}

/// Notes and the reference board exist per project and once app-wide. `None`
/// selects the app-wide copy, which lives in `<app data>/global/` with the same
/// `.murre/` layout as a project, so the same validated code handles both.
fn scope_root(
    state: &State<'_, AppState>,
    project_id: &Option<String>,
) -> AppResult<std::path::PathBuf> {
    match project_id {
        Some(id) => project_root(state, id),
        None => global_root(&state.paths.root),
    }
}

fn global_root(app_root: &std::path::Path) -> AppResult<std::path::PathBuf> {
    let root = app_root.join("global");
    for dir in [".murre", ".murre/references/media"] {
        let p = root.join(dir);
        std::fs::create_dir_all(&p).map_err(|e| AppError::io(&p, e))?;
    }
    Ok(root)
}

#[tauri::command]
async fn get_media_tools() -> renders::MediaTools {
    renders::media_tools()
}

#[tauri::command]
async fn list_renders(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<renders::RendersListing> {
    let root = project_root(&state, &project_id)?;
    renders::list(&root)
}

#[tauri::command]
async fn set_render_approved(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    approved: bool,
) -> AppResult<renders::RendersListing> {
    let root = project_root(&state, &project_id)?;
    renders::set_approved(&root, &path, approved)
}

#[tauri::command]
async fn probe_render(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> AppResult<renders::MediaInfo> {
    let root = project_root(&state, &project_id)?;
    renders::probe(&root, &path)
}

/// JPEG data URL, or `null` for audio files.
#[tauri::command]
async fn render_thumbnail(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> AppResult<Option<String>> {
    let root = project_root(&state, &project_id)?;
    renders::thumbnail(&root, &state.paths.root.join("thumbnails"), &path)
}

/// Validates the file, lets the webview read exactly that one file through the
/// asset protocol, and returns its absolute path for `convertFileSrc`.
#[tauri::command]
async fn render_playback_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> AppResult<String> {
    let root = project_root(&state, &project_id)?;
    let abs = renders::playback_path(&root, &path)?;
    app.asset_protocol_scope()
        .allow_file(&abs)
        .map_err(|e| AppError::Invalid(format!("Playback could not be enabled: {e}")))?;
    Ok(abs.display().to_string())
}

#[tauri::command]
async fn get_references(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> AppResult<references::ReferencesView> {
    let root = scope_root(&state, &project_id)?;
    references::get(&root)
}

/// Fails with a `conflict` error if the board changed since `expected_revision`.
#[tauri::command]
async fn save_references(
    state: State<'_, AppState>,
    project_id: Option<String>,
    canvas: serde_json::Value,
    expected_revision: u64,
) -> AppResult<references::ReferencesView> {
    let root = scope_root(&state, &project_id)?;
    references::save(&root, canvas, expected_revision)
}

/// `data_base64`: the file's bytes. Copied into the project's reference media folder.
#[tauri::command]
async fn import_reference_media(
    state: State<'_, AppState>,
    project_id: Option<String>,
    data_base64: String,
) -> AppResult<references::ImportedMedia> {
    if data_base64.len() > references::MAX_MEDIA_BYTES / 3 * 4 + 16 {
        return Err(AppError::Invalid(
            "That file is too big for the reference board (40 MB max). Even moodboards have limits.".into(),
        ));
    }
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        data_base64.as_bytes(),
    )
    .map_err(|_| AppError::Invalid("That file could not be read.".into()))?;
    let root = scope_root(&state, &project_id)?;
    references::import_media(&root, &bytes)
}

/// Lets the webview read exactly this media file through the asset protocol
/// and returns its absolute path for `convertFileSrc`.
#[tauri::command]
async fn reference_media_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: Option<String>,
    file: String,
) -> AppResult<String> {
    let root = scope_root(&state, &project_id)?;
    let abs = references::media_path(&root, &file)?;
    app.asset_protocol_scope()
        .allow_file(&abs)
        .map_err(|e| AppError::Invalid(format!("Could not show that file: {e}")))?;
    Ok(abs.display().to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SentToAe {
    /// The composition the image went into.
    comp: String,
    /// True when no composition was active, so a new one was made.
    created: bool,
}

/// Put a reference image into After Effects: in the active composition, centred, or in a new one when none is
/// active. Needs the Companion to be connected (After Effects running).
#[tauri::command]
async fn send_reference_to_after_effects(
    app: tauri::AppHandle,
    project_id: Option<String>,
    file: String,
    as_shapes: Option<bool>,
) -> AppResult<SentToAe> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::time::{Duration, Instant};
        let state = app.state::<AppState>();
        let root = scope_root(&state, &project_id)?;
        let abs = references::media_path(&root, &file)?;
        let ext = file.rsplit('.').next().unwrap_or("");
        if !["png", "jpg", "gif", "webp", "svg"].contains(&ext) {
            return Err(AppError::Invalid("Only images can be sent to After Effects.".into()));
        }
        let bridge = state
            .bridge
            .as_ref()
            .filter(|b| b.is_connected())
            .ok_or_else(|| AppError::Invalid("After Effects is not connected. Open After Effects and check the Companion is running.".into()))?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        bridge.request_import_image(&id, &abs.to_string_lossy(), as_shapes.unwrap_or(false) && ext == "svg")?;
        let until = Instant::now() + Duration::from_secs(30);
        while Instant::now() < until {
            if let Some(r) = bridge.status().import.filter(|r| r.request_id == id) {
                return if r.ok {
                    Ok(SentToAe { comp: r.comp.unwrap_or_default(), created: r.created })
                } else {
                    Err(AppError::Invalid(r.message.unwrap_or_else(|| "After Effects could not import the image.".into())))
                };
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(AppError::Invalid("After Effects did not answer. It may be showing a dialog.".into()))
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?
}

/// Open a composition in After Effects, select a layer and (when given) a property. Needs the Companion to be connected
/// and this project to be the one open in After Effects. Returns a note when the jump went as far as it could but not
/// exactly (for example the layers were reordered since the scan).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn reveal_in_after_effects(
    app: tauri::AppHandle,
    project_id: String,
    comp_id: i64,
    comp_name: String,
    layer_index: Option<u32>,
    layer_name: String,
    property_path: Option<String>,
) -> AppResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::time::{Duration, Instant};
        let state = app.state::<AppState>();
        let bridge = state
            .bridge
            .as_ref()
            .filter(|b| b.is_connected())
            .ok_or_else(|| AppError::Invalid("After Effects is not connected. Open After Effects and check the Companion is running.".into()))?;
        let open = bridge.status();
        if open.project_id.as_deref() != Some(project_id.as_str()) {
            return Err(AppError::Invalid("This project isn't open in After Effects. Open it there first, then try again.".into()));
        }
        if open.scanning {
            return Err(AppError::Invalid("The Companion is busy with a scan. Try again in a moment.".into()));
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        bridge.request_reveal(
            &id,
            bridge::RevealTarget {
                comp_id,
                comp_name,
                layer_index: layer_index.unwrap_or(0),
                layer_name,
                property_path: property_path.unwrap_or_default(),
            },
        )?;
        let until = Instant::now() + Duration::from_secs(15);
        while Instant::now() < until {
            if let Some(r) = bridge.status().reveal.filter(|r| r.request_id == id) {
                return if r.ok {
                    Ok(r.message)
                } else {
                    Err(AppError::Invalid(r.message.unwrap_or_else(|| "After Effects could not show that layer.".into())))
                };
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(AppError::Invalid("After Effects did not answer. It may be showing a dialog.".into()))
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?
}

#[tauri::command]
async fn open_reference_media(
    state: State<'_, AppState>,
    project_id: Option<String>,
    file: String,
) -> AppResult<()> {
    let root = scope_root(&state, &project_id)?;
    references::media_path(&root, &file)?; // validates the name and that it exists
    assets::open_file(&root, &references::media_rel(&file))
}

fn bridge_of(state: &AppState) -> AppResult<&bridge::Bridge> {
    state.bridge.as_ref().ok_or_else(|| {
        AppError::Invalid("The live link to After Effects could not start when Murre opened. Restart Murre.".into())
    })
}

/// What the After Effects Companion last reported (connected, open project, scan progress).
#[tauri::command]
fn get_companion_status(state: State<'_, AppState>) -> bridge::PanelState {
    state.bridge.as_ref().map(|b| b.status()).unwrap_or_default()
}

/// Ask the Companion to scan the After Effects project. It must have this project open.
#[tauri::command]
fn companion_scan(state: State<'_, AppState>, project_id: String) -> AppResult<()> {
    bridge_of(&state)?.request_scan(&project_id)
}

#[tauri::command]
fn companion_relink(state: State<'_, AppState>, project_id: String) -> AppResult<()> {
    bridge_of(&state)?.request_relink(&project_id)
}

/// Talk to this connected After Effects from now on (only shown when two or more are connected).
#[tauri::command]
fn companion_switch(state: State<'_, AppState>, id: u64) -> AppResult<()> {
    bridge_of(&state)?.switch_to(id)
}

/// If another connected After Effects has this project open, make that one the active one.
#[tauri::command]
fn companion_prefer_project(state: State<'_, AppState>, project_id: String) {
    if let Some(b) = state.bridge.as_ref() {
        b.prefer_project(&project_id);
    }
}

#[tauri::command]
fn companion_cancel(state: State<'_, AppState>) -> AppResult<()> {
    bridge_of(&state)?.request_cancel()
}

/// Compositions from the last Companion scan (read-only).
#[tauri::command]
async fn get_comps(state: State<'_, AppState>, project_id: String) -> AppResult<comps::CompsView> {
    let root = project_root(&state, &project_id)?;
    comps::get(&root)
}

/// Footage files from the last Companion scan (read-only).
#[tauri::command]
async fn get_footage(state: State<'_, AppState>, project_id: String) -> AppResult<footage::FootageView> {
    let root = project_root(&state, &project_id)?;
    footage::get(&root)
}

fn aerender_status_now(state: &AppState) -> AppResult<aerender::Status> {
    let saved = {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        aerender::saved_path(&conn)?
    };
    // Running `aerender -version` can take a moment, so the database is not held meanwhile.
    Ok(aerender::status(saved, aerender::detect()))
}

/// Which aerender will be used, and what was found. Runs `aerender -version` to check it.
#[tauri::command]
async fn get_aerender_status(app: tauri::AppHandle) -> AppResult<aerender::Status> {
    tauri::async_runtime::spawn_blocking(move || aerender_status_now(&app.state::<AppState>()))
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))?
}

/// Choose an aerender file (checked first) or pass `None` to go back to automatic detection.
#[tauri::command]
async fn set_aerender_path(app: tauri::AppHandle, path: Option<String>) -> AppResult<aerender::Status> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if let Some(p) = path.as_deref() {
            aerender::validate(std::path::Path::new(p))?;
        }
        {
            let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
            aerender::store(&conn, path.as_deref())?;
        }
        aerender_status_now(&state)
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?
}

/// Check a render request without starting anything.
#[tauri::command]
async fn render_preflight(state: State<'_, AppState>, request: aerender::RenderRequest) -> AppResult<aerender::Plan> {
    let root = project_root(&state, &request.project_id)?;
    aerender::plan(&root, &request)
}

/// Start rendering a Main Comp with aerender. Works without the Companion panel being open.
#[tauri::command]
async fn start_render(app: tauri::AppHandle, request: aerender::RenderRequest) -> AppResult<render_job::JobSnapshot> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let root = project_root(&state, &request.project_id)?;
        let plan = aerender::plan(&root, &request)?;
        let saved = {
            let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
            aerender::saved_path(&conn)?
        };
        let active = aerender::resolve_with(request.aerender_path.as_deref(), saved, aerender::detect())?;
        state.render.start(std::path::Path::new(&active.path), &plan, &request.project_id)
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?
}

/// Whether Murre opens at login, and whether the person has been asked about it yet.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupInfo {
    /// The login item is on.
    enabled: bool,
    /// The one-time question has been answered.
    asked: bool,
    /// False in a development build: a login item that points at a dev binary would be useless, so it is not offered.
    available: bool,
}

#[tauri::command]
fn get_startup(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<StartupInfo> {
    use tauri_plugin_autostart::ManagerExt;
    let asked = startup::asked(&state.db.lock().unwrap_or_else(|e| e.into_inner()))?;
    Ok(StartupInfo { enabled: app.autolaunch().is_enabled().unwrap_or(false), asked, available: !cfg!(debug_assertions) })
}

/// Turn the login item on or off. Either way the question counts as answered.
#[tauri::command]
fn set_launch_at_login(app: tauri::AppHandle, state: State<'_, AppState>, enabled: bool) -> AppResult<()> {
    use tauri_plugin_autostart::ManagerExt;
    if cfg!(debug_assertions) {
        return Err(AppError::Invalid("Opening at login only works in the installed app, not in a development build.".into()));
    }
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    match &result {
        Ok(()) => applog::info("startup", if enabled { "Open at login turned on" } else { "Open at login turned off" }),
        Err(e) => applog::warn("startup", &format!("Could not change the login item: {e}")),
    }
    result.map_err(|e| AppError::Invalid(format!("Could not change the login item: {e}")))?;
    startup::mark_asked(&state.db.lock().unwrap_or_else(|e| e.into_inner()))
}

/// "Not now": remember the answer without changing anything.
#[tauri::command]
fn dismiss_login_offer(state: State<'_, AppState>) -> AppResult<()> {
    startup::mark_asked(&state.db.lock().unwrap_or_else(|e| e.into_inner()))
}

#[tauri::command]
fn cancel_render(state: State<'_, AppState>) -> AppResult<()> {
    state.render.cancel()
}

/// Clear the card of the render that ended (never one that is running; no file is touched).
#[tauri::command]
fn clear_render_job(state: State<'_, AppState>) -> AppResult<()> {
    state.render.clear()
}

/// The running render, or the most recent one that ended.
#[tauri::command]
fn get_render_job(state: State<'_, AppState>) -> Option<render_job::JobSnapshot> {
    state.render.current()
}

#[tauri::command]
fn get_render_log(state: State<'_, AppState>, lines: usize) -> Vec<String> {
    state.render.log_tail(lines.min(2000))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // The login item starts the app with `--hidden`, so it waits quietly in the menu bar instead of opening a window.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![startup::HIDDEN_ARG]),
        ))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_main(window.app_handle());
            }
        })
        .setup(|app| {
            setup_tray(app)?;
            install_app_menu(app.handle())?;
            updater::register(app.handle());
            updater::spawn_daily_checks(app.handle().clone());
            // macOS: the sidebar and window edge blur what is behind the window, like Apple's own apps.
            // Purely cosmetic, so a failure is ignored. The page CSS keeps the content area solid.
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                let _ = apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, Some(10.0));
            }
            let root = app.path().app_data_dir().map_err(|e| {
                AppError::Invalid(format!("Cannot resolve app data directory: {e}"))
            })?;
            app_data::migrate_legacy(&root);
            let paths = AppPaths::new(&root);
            paths.ensure()?;
            applog::init(&paths.root.join("logs"));
            applog::info("app", &format!("Started version {}", env!("CARGO_PKG_VERSION")));
            let conn = db::open(&paths.database)?;
            let handle = app.handle().clone();
            // The app works without the live link, so a failure here is not fatal.
            let seen_add = std::sync::Mutex::new(None::<String>);
            let seen_versions = std::sync::Mutex::new(None::<String>);
            // The time log gets its own connection, so it never waits on the app's.
            let time_log = db::open(&paths.database).ok().map(activity::start).map(std::sync::Mutex::new);
            let bridge = match bridge::Bridge::start(
                &paths.root,
                std::sync::Arc::new(move |state: &bridge::PanelState| {
                    let _ = handle.emit("companion-status", state);
                    if let Some(log) = &time_log {
                        let open = state.connections.iter().filter_map(|c| c.project_id.clone()).collect();
                        let _ = log.lock().unwrap_or_else(|e| e.into_inner()).send(open);
                    }
                    // The panel asked to add the open project to Murre (once per request).
                    if let Some(req) = &state.add_project {
                        let mut seen = seen_add.lock().unwrap_or_else(|e| e.into_inner());
                        if seen.as_deref() != Some(req.request_id.as_str()) {
                            *seen = Some(req.request_id.clone());
                            let _ = add_project::start(
                                handle.clone(),
                                add_project::Spec {
                                    request_id: Some(req.request_id.clone()),
                                    name: req.name.clone(),
                                    parent_dir: req.parent_dir.clone(),
                                    versions: req.versions.clone(),
                                    premiere: Vec::new(),
                                },
                            );
                        }
                    }
                    // The panel asked which other versions sit next to the open project (once per request).
                    if let Some(req) = &state.versions_request {
                        let mut seen = seen_versions.lock().unwrap_or_else(|e| e.into_inner());
                        if seen.as_deref() != Some(req.as_str()) {
                            *seen = Some(req.clone());
                            let (req, path, h) = (req.clone(), state.aep_path.clone(), handle.clone());
                            std::thread::spawn(move || {
                                let files = path.map(|p| versions::find(std::path::Path::new(&p))).unwrap_or_default();
                                if let Some(st) = h.try_state::<AppState>() {
                                    if let Some(b) = st.bridge.as_ref() {
                                        b.send_versions(&req, &files);
                                    }
                                }
                            });
                        }
                    }
                }),
            ) {
                Ok(b) => Some(b),
                Err(e) => {
                    eprintln!("Companion link did not start: {e}");
                    applog::warn("companion", &format!("The link to the Companion did not start: {e}"));
                    None
                }
            };
            let render_handle = app.handle().clone();
            let render = render_job::Runner::new(
                paths.root.join("render-logs"),
                std::sync::Arc::new(move |job: &render_job::JobSnapshot| {
                    let _ = render_handle.emit("render-update", job);
                }),
            );
            app.manage(AppState {
                paths,
                db: Mutex::new(conn),
                watch: Mutex::new(None),
                bridge,
                render,
            });
            start_auto_scan(app.handle().clone());
            // The window starts hidden (tauri.conf.json): show it, unless this is a login launch.
            if startup::launched_hidden(std::env::args()) {
                hide_main(app.handle());
            } else {
                show_main(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            check_for_updates,
            get_profile,
            save_profile,
            create_project,
            list_projects,
            mark_project_opened,
            recent_projects,
            time_per_project,
            get_folder_setup,
            save_folder_setup,
            reset_folder_setup,
            get_greeting_state,
            save_greeting_state,
            update_project,
            remove_project,
            inspect_import,
            send_reference_to_after_effects,
            reveal_in_after_effects,
            add_project_from_after_effects,
            list_premiere_projects,
            get_premiere_projects,
            get_diagnostic_report,
            list_other_versions,
            import_project,
            get_project,
            scan_workfiles,
            set_workfile_note,
            set_current_aep,
            get_tasks,
            get_project_settings,
            save_project_settings,
            add_task,
            set_task_done,
            delete_task,
            list_assets,
            open_asset,
            open_in_after_effects,
            get_ae_installs,
            get_companion_install,
            get_companion_debug_mode,
            set_companion_debug_mode,
            install_companion,
            check_after_effects,
            create_starter_in_after_effects,
            get_notes,
            get_colors,
            get_expressions,
            get_fonts,
            package_check,
            package_build,
            get_needs,
            reconcile_projects,
            relink_project,
            watch_project,
            unwatch_project,
            get_companion_status,
            companion_scan,
            companion_cancel,
            companion_switch,
            companion_prefer_project,
            companion_relink,
            get_comps,
            get_footage,
            get_aerender_status,
            set_aerender_path,
            render_preflight,
            start_render,
            get_startup,
            set_launch_at_login,
            dismiss_login_offer,
            cancel_render,
            clear_render_job,
            get_render_job,
            get_render_log,
            save_notes,
            add_notes_page,
            delete_notes_page,
            set_project_deadline,
            list_spaces,
            create_space,
            update_space,
            reorder_spaces,
            delete_space,
            set_project_space,
            list_events,
            add_event,
            update_event,
            delete_event,
            get_media_tools,
            list_renders,
            set_render_approved,
            probe_render,
            render_thumbnail,
            render_playback_path,
            get_references,
            save_references,
            import_reference_media,
            reference_media_path,
            open_reference_media
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| match event {
            // Closing the last window must not quit. Cmd+Q and the menu bar Quit still do.
            tauri::RunEvent::ExitRequested { code, api, .. } if code.is_none() => api.prevent_exit(),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(_app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_root_has_project_like_layout_and_works_with_notes_and_references() {
        let app = tempfile::tempdir().unwrap();
        let root = global_root(app.path()).unwrap();
        assert_eq!(root, app.path().join("global"));
        assert!(root.join(".murre/references/media").is_dir());
        // Idempotent.
        global_root(app.path()).unwrap();

        let doc = serde_json::json!({"type": "doc", "content": []});
        assert_eq!(notes::save(&root, doc.clone(), 0).unwrap().revision, 1);
        assert_eq!(notes::get(&root).unwrap().content, Some(doc));

        let canvas = serde_json::json!({"store": {}, "schema": {}});
        assert_eq!(references::save(&root, canvas, 0).unwrap().revision, 1);
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0];
        let m = references::import_media(&root, &png).unwrap();
        assert!(references::media_path(&root, &m.file).is_ok());
        // Global data stays inside <app data>/global.
        assert!(root.join(".murre/notes.json").is_file());
        assert!(root.join(".murre/references/references.json").is_file());
    }
}
