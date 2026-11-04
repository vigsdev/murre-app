//! Live link between the app and the After Effects Companion panel.
//!
//! The app listens on a WebSocket bound to `127.0.0.1` only. The panel finds the port and a
//! one-time token in `companion-bridge.json` (in the app data folder) and connects as a client.
//! The socket carries *commands and progress only*. The Companion still writes `colors.json`,
//! `expressions.json` and `comps.json` itself, so those files stay the source of truth and
//! everything keeps working when the socket is down.
//!
//! Safety: the token must be in the connection URL (so a web page open in a browser cannot drive
//! After Effects), browser origins are refused, messages are size-limited, one panel is served at a
//! time (a newer connection replaces the older), and silent connections are dropped.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{ErrorKind, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Error as WsError, Message};

/// Version of the message format. Both sides must agree.
pub const PROTOCOL: u32 = 1;
pub const BRIDGE_FILE: &str = "companion-bridge.json";

const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(100);
const PING_EVERY: Duration = Duration::from_secs(15);
const SILENCE_LIMIT: Duration = Duration::from_secs(45);

/// What the panel last told us, as shown in the UI.
#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PanelState {
    pub connected: bool,
    /// Absolute path of the AEP open in After Effects, if saved.
    pub aep_path: Option<String>,
    /// Id of the Murre project that AEP belongs to, if any.
    pub project_id: Option<String>,
    /// True while the panel is busy with a scan or a copy-and-relink (see `activity`).
    pub scanning: bool,
    /// `scan` or `relink` while busy.
    pub activity: Option<String>,
    pub progress: Option<Progress>,
    /// Who is connected: `panel` (can scan) or `background` (the hidden helper, which cannot).
    pub source: Option<String>,
    /// How the most recent scan or relink ended.
    pub last: Option<Outcome>,
    /// How the most recent "create the project file in After Effects" request ended.
    pub starter: Option<StarterOutcome>,
    /// The answer to the most recent "what is open in After Effects?" question.
    pub inspect: Option<InspectOutcome>,
    /// How the most recent "send this image to After Effects" request ended.
    pub import: Option<ImportOutcome>,
    /// How the most recent "show this layer in After Effects" request ended.
    pub reveal: Option<RevealOutcome>,
    /// The panel's latest "add this project to Murre" request.
    pub add_project: Option<AddProjectRequest>,
    /// Id of the panel's latest "which other versions are next to this project?" question.
    pub versions_request: Option<String>,
    /// Counts every finished scan or relink, so a caller can tell its own request ended.
    pub finished: u64,
    /// Every After Effects that is connected (the fields above describe the active one).
    pub connections: Vec<ConnectionInfo>,
    /// Id of the connection the fields above describe.
    pub active_id: Option<u64>,
}

/// One connected After Effects, as listed in the picker.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: u64,
    /// For example "After Effects 2026" or "After Effects 2026 Beta".
    pub label: String,
    pub project_id: Option<String>,
    pub aep_path: Option<String>,
    pub source: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddProjectRequest {
    pub request_id: String,
    pub name: String,
    /// Folder the new project folder is made in.
    pub parent_dir: String,
    /// Other `.aep` files from beside the open project to bring along (file names).
    pub versions: Vec<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub request_id: String,
    pub ok: bool,
    /// The composition the image went into, when `ok`.
    pub comp: Option<String>,
    /// True when a new composition had to be made.
    pub created: bool,
    pub message: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RevealOutcome {
    pub request_id: String,
    pub ok: bool,
    /// Why it failed, or what could not be matched exactly when it went as far as it could.
    pub message: Option<String>,
}

/// Where to jump to in After Effects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevealTarget {
    pub comp_id: i64,
    pub comp_name: String,
    /// Position of the layer in its composition (1 = top); 0 when unknown.
    pub layer_index: u32,
    pub layer_name: String,
    /// Names below the layer joined with " > "; empty to select only the layer.
    pub property_path: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InspectOutcome {
    pub request_id: String,
    /// `empty`, `unsaved`, `saved` or `unknown`.
    pub kind: String,
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StarterOutcome {
    /// The request this answers.
    pub request_id: String,
    pub ok: bool,
    /// Where the file was saved, when `ok`.
    pub path: Option<String>,
    pub message: Option<String>,
    /// Where the project that was open before was saved, when there was one.
    pub previous: Option<String>,
}

/// What the new project file should contain.
#[derive(Debug, Clone, PartialEq)]
pub struct StarterSpec {
    pub request_id: String,
    /// Absolute path of the `.aep` to create.
    pub path: String,
    pub comp_name: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub seconds: f64,
    /// Where a project that was never saved is saved before it is closed.
    pub rescue_dir: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u32,
    pub total: u32,
    pub comp_name: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// `scan` or `relink`.
    pub activity: String,
    /// `done`, `failed` or `cancelled`.
    pub kind: String,
    pub message: Option<String>,
    /// Relink only: files copied into the project, files already there that were reused, files that
    /// failed, and footage items now pointing into the project.
    pub copied: Option<u32>,
    pub reused: Option<u32>,
    pub failed: Option<u32>,
    pub items: Option<u32>,
    /// Originals moved to the Trash after being copied.
    pub trashed: Option<u32>,
    pub colors: Option<u32>,
    pub expressions: Option<u32>,
    pub comps: Option<u32>,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Incoming {
    State {
        v: u32,
        aep_path: Option<String>,
        project_id: Option<String>,
        scanning: bool,
        #[serde(default)]
        activity: Option<String>,
        #[serde(default)]
        source: Option<String>,
        /// Which After Effects this is (its application path); one connection is kept per host.
        #[serde(default)]
        host: Option<String>,
        /// A name for it, such as "After Effects 2026 Beta".
        #[serde(default)]
        host_label: Option<String>,
    },
    Progress {
        done: u32,
        total: u32,
        comp_name: String,
        #[serde(default)]
        activity: Option<String>,
    },
    RelinkDone {
        copied: u32,
        reused: u32,
        failed: u32,
        items: u32,
        #[serde(default)]
        trashed: u32,
    },
    RelinkFailed {
        message: String,
    },
    ScanDone {
        colors: u32,
        expressions: u32,
        comps: u32,
    },
    ScanFailed {
        message: String,
    },
    ScanCancelled,
    StarterDone {
        request_id: String,
        path: String,
        #[serde(default)]
        previous: Option<String>,
    },
    InspectResult {
        request_id: String,
        kind: String,
        name: String,
        path: String,
    },
    StarterFailed {
        request_id: String,
        message: String,
    },
    AddProject {
        request_id: String,
        name: String,
        parent_dir: String,
        #[serde(default)]
        versions: Vec<String>,
    },
    ListVersions {
        request_id: String,
    },
    ImportDone {
        request_id: String,
        #[serde(default)]
        comp: String,
        #[serde(default)]
        created: bool,
    },
    ImportFailed {
        request_id: String,
        message: String,
    },
    RevealDone {
        request_id: String,
        #[serde(default)]
        message: String,
    },
    RevealFailed {
        request_id: String,
        message: String,
    },
    Pong,
}

#[derive(Debug, Clone, PartialEq)]
enum Outgoing {
    /// Scan the open project, which the panel must still find to be this Murre project.
    Scan { project_id: String },
    /// Copy files used by the open project into it and relink them.
    Relink { project_id: String },
    Cancel,
    /// Make a new project in After Effects and save it at the given path.
    CreateStarter(StarterSpec),
    /// Ask what is open in After Effects.
    Inspect { request_id: String },
    /// Add an image to the active composition (or a new one).
    ImportImage { request_id: String, path: String, as_shapes: bool },
    /// Open a composition, select a layer and, if given, a property.
    Reveal { request_id: String, target: RevealTarget },
    /// Save the open project to `path` (a "Save As": the original file is left alone).
    SaveAs { request_id: String, path: String },
    /// Progress of an "add this project to Murre" request, for the panel to show.
    AddProjectStatus { request_id: String, text: String, done: bool, ok: bool },
    /// The other versions found next to the open project, for the panel to offer.
    Versions { request_id: String, files: Vec<crate::versions::Candidate> },
}

impl Outgoing {
    fn json(&self) -> String {
        match self {
            Outgoing::Scan { project_id } => {
                serde_json::json!({"v": PROTOCOL, "type": "scan", "projectId": project_id})
            }
            Outgoing::Relink { project_id } => {
                serde_json::json!({"v": PROTOCOL, "type": "relink", "projectId": project_id})
            }
            Outgoing::Cancel => serde_json::json!({"v": PROTOCOL, "type": "cancel"}),
            Outgoing::CreateStarter(c) => serde_json::json!({
                "v": PROTOCOL, "type": "createStarter", "requestId": c.request_id, "path": c.path,
                "compName": c.comp_name, "width": c.width, "height": c.height,
                "fps": c.fps, "seconds": c.seconds, "rescueDir": c.rescue_dir
            }),
            Outgoing::ImportImage { request_id, path, as_shapes } => {
                let mut m = serde_json::json!({"v": PROTOCOL, "type": "importImage", "requestId": request_id, "path": path});
                if *as_shapes {
                    m["asShapes"] = serde_json::Value::Bool(true);
                }
                m
            }
            Outgoing::Reveal { request_id, target } => serde_json::json!({
                "v": PROTOCOL, "type": "reveal", "requestId": request_id, "compId": target.comp_id,
                "compName": target.comp_name, "layerIndex": target.layer_index, "layerName": target.layer_name,
                "propertyPath": target.property_path
            }),
            Outgoing::SaveAs { request_id, path } => {
                serde_json::json!({"v": PROTOCOL, "type": "saveAs", "requestId": request_id, "path": path})
            }
            Outgoing::AddProjectStatus { request_id, text, done, ok } => serde_json::json!({
                "v": PROTOCOL, "type": "addProjectStatus", "requestId": request_id, "text": text, "done": done, "ok": ok
            }),
            Outgoing::Versions { request_id, files } => {
                serde_json::json!({"v": PROTOCOL, "type": "versions", "requestId": request_id, "files": files})
            }
            Outgoing::Inspect { request_id } => {
                serde_json::json!({"v": PROTOCOL, "type": "inspect", "requestId": request_id})
            }
        }
        .to_string()
    }
}

type Notify = Arc<dyn Fn(&PanelState) + Send + Sync>;

struct Conn {
    id: u64,
    /// Which After Effects (its application path, or empty when the Companion did not say).
    host: String,
    label: Option<String>,
    tx: mpsc::Sender<Outgoing>,
    last_heard: Instant,
    state: PanelState,
}

#[derive(Default)]
struct Inner {
    conns: Vec<Conn>,
    /// The connection the app is talking to.
    active: Option<u64>,
    next_id: u64,
}

struct Shared {
    token: String,
    inner: Mutex<Inner>,
    notify: Notify,
}

/// A panel that has been heard this recently is considered to be there.
const PANEL_FRESH: Duration = Duration::from_secs(25);

impl Inner {
    fn view(&self) -> PanelState {
        let mut s = self
            .active
            .and_then(|id| self.conns.iter().find(|c| c.id == id))
            .map(|c| c.state.clone())
            .unwrap_or_default();
        s.active_id = self.active;
        s.connections = self
            .conns
            .iter()
            .map(|c| ConnectionInfo {
                id: c.id,
                label: c.label.clone().unwrap_or_else(|| "After Effects".into()),
                project_id: c.state.project_id.clone(),
                aep_path: c.state.aep_path.clone(),
                source: c.state.source.clone(),
            })
            .collect();
        s
    }

    /// The connection to use when the active one goes away: a panel before a helper.
    fn fallback(&self) -> Option<u64> {
        self.conns
            .iter()
            .find(|c| c.state.source.as_deref() != Some("background"))
            .or_else(|| self.conns.first())
            .map(|c| c.id)
    }
}

impl Shared {
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn publish(&self, snapshot: PanelState) {
        (self.notify)(&snapshot);
    }

    fn snapshot(&self) -> PanelState {
        self.inner().view()
    }

    /// Takes a place for a connection that has just said who it is. There is one connection per After Effects: a
    /// newer one replaces the older one of the same host, except that the hidden background helper never takes the
    /// place of a panel that is there (two clients taking it from each other shows up as a connection that keeps
    /// dropping). Connections from different After Effects live side by side.
    fn claim(&self, host: Option<&str>, label: Option<&str>, source: Option<&str>, tx: mpsc::Sender<Outgoing>) -> Option<u64> {
        let host = host.unwrap_or("").to_string();
        let mut inner = self.inner();
        let existing = inner.conns.iter().position(|c| c.host == host);
        if let Some(i) = existing {
            let c = &inner.conns[i];
            if source == Some("background")
                && c.state.source.as_deref() != Some("background")
                && c.last_heard.elapsed() < PANEL_FRESH
            {
                return None;
            }
        }
        inner.next_id += 1;
        let id = inner.next_id;
        let was_active = existing.map(|i| inner.conns[i].id) == inner.active && inner.active.is_some();
        if let Some(i) = existing {
            inner.conns.remove(i);
        }
        let state = PanelState { source: source.map(str::to_string), ..PanelState::default() };
        inner.conns.push(Conn { id, host, label: label.map(str::to_string), tx, last_heard: Instant::now(), state });
        if was_active || inner.active.is_none() {
            inner.active = Some(id);
        }
        Some(id)
    }

    fn alive(&self, id: u64) -> bool {
        self.inner().conns.iter().any(|c| c.id == id)
    }

    fn touch(&self, id: u64) {
        if let Some(c) = self.inner().conns.iter_mut().find(|c| c.id == id) {
            c.last_heard = Instant::now();
        }
    }

    /// Changes what one connection told us and tells the app (messages from a connection that is not active only
    /// change its own entry; the app sees them if it switches to it).
    fn update(&self, id: u64, f: impl FnOnce(&mut PanelState)) {
        let snapshot = {
            let mut inner = self.inner();
            let Some(c) = inner.conns.iter_mut().find(|c| c.id == id) else {
                return;
            };
            c.last_heard = Instant::now();
            f(&mut c.state);
            inner.view()
        };
        self.publish(snapshot);
    }

    fn remove(&self, id: u64) {
        let snapshot = {
            let mut inner = self.inner();
            let before = inner.conns.len();
            inner.conns.retain(|c| c.id != id);
            if inner.conns.len() == before {
                return; // replaced earlier: the newer connection owns the entry
            }
            if inner.active == Some(id) {
                inner.active = inner.fallback();
            }
            inner.view()
        };
        self.publish(snapshot);
    }

    fn switch_to(&self, id: u64) -> bool {
        let snapshot = {
            let mut inner = self.inner();
            if !inner.conns.iter().any(|c| c.id == id) {
                return false;
            }
            if inner.active == Some(id) {
                return true;
            }
            inner.active = Some(id);
            inner.view()
        };
        self.publish(snapshot);
        true
    }

    /// Makes the After Effects that has this Murre project open the active one, if the active one has another.
    fn prefer_project(&self, project_id: &str) {
        let snapshot = {
            let mut inner = self.inner();
            let active_has = inner
                .active
                .and_then(|id| inner.conns.iter().find(|c| c.id == id))
                .is_some_and(|c| c.state.project_id.as_deref() == Some(project_id));
            if active_has {
                return;
            }
            let Some(id) = inner
                .conns
                .iter()
                .filter(|c| c.state.project_id.as_deref() == Some(project_id))
                .min_by_key(|c| c.state.source.as_deref() == Some("background"))
                .map(|c| c.id)
            else {
                return;
            };
            inner.active = Some(id);
            inner.view()
        };
        self.publish(snapshot);
    }
}

pub struct Bridge {
    shared: Arc<Shared>,
    #[cfg_attr(not(test), allow(dead_code))]
    port: u16,
    file: PathBuf,
}

impl Bridge {
    /// Start listening and publish the port and token for the panel.
    /// `notify` is called (from a background thread) whenever the panel state changes.
    pub fn start(dir: &Path, notify: Notify) -> AppResult<Bridge> {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).map_err(|e| AppError::io(dir, e))?;
        let port = listener.local_addr().map_err(|e| AppError::io(dir, e))?.port();
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let shared = Arc::new(Shared {
            token,
            inner: Mutex::new(Inner::default()),
            notify,
        });
        let file = dir.join(BRIDGE_FILE);
        write_bridge_file(&file, port, &shared.token)?;

        let accept_shared = shared.clone();
        thread::Builder::new()
            .name("companion-bridge".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let shared = accept_shared.clone();
                    let _ = thread::Builder::new()
                        .name("companion-conn".into())
                        .spawn(move || serve(stream, shared));
                }
            })
            .map_err(|e| AppError::io(dir, e))?;
        Ok(Bridge { shared, port, file })
    }

    pub fn status(&self) -> PanelState {
        self.shared.snapshot()
    }

    #[cfg(test)]
    fn port(&self) -> u16 {
        self.port
    }

    #[cfg(test)]
    fn token(&self) -> String {
        self.shared.token.clone()
    }

    fn check_ready(&self, project_id: &str) -> AppResult<()> {
        let s = self.status();
        if !s.connected {
            return Err(AppError::Invalid(
                "The After Effects Companion is not connected. Open After Effects and the Murre Companion panel.".into(),
            ));
        }
        match s.project_id.as_deref() {
            Some(id) if id == project_id => {}
            Some(_) => {
                return Err(AppError::Invalid(
                    "After Effects has a different Murre project open. Open this project's AEP file there first.".into(),
                ))
            }
            None => {
                return Err(AppError::Invalid(
                    "The project open in After Effects is not linked to a Murre project. Open this project's AEP file there first.".into(),
                ))
            }
        }
        if s.scanning {
            return Err(AppError::Invalid(match s.activity.as_deref() {
                Some("relink") => "Files are already being copied into the project.".into(),
                _ => "A scan is already running.".into(),
            }));
        }
        Ok(())
    }

    /// Ask the panel to scan the project that is open in After Effects, which must be `project_id`.
    pub fn request_scan(&self, project_id: &str) -> AppResult<()> {
        self.shared.prefer_project(project_id);
        self.check_ready(project_id)?;
        self.send(Outgoing::Scan { project_id: project_id.to_string() })
    }

    /// Ask the panel to copy the project's outside files into it and relink them in After Effects.
    pub fn request_relink(&self, project_id: &str) -> AppResult<()> {
        self.shared.prefer_project(project_id);
        self.check_ready(project_id)?;
        self.send(Outgoing::Relink { project_id: project_id.to_string() })
    }

    /// Ask the panel to stop the scan that is running.
    pub fn request_cancel(&self) -> AppResult<()> {
        self.send(Outgoing::Cancel)
    }

    /// Whether a Companion (panel or background) is connected.
    pub fn is_connected(&self) -> bool {
        self.status().connected
    }

    /// Ask the Companion what is open in After Effects.
    pub fn request_inspect(&self, request_id: &str) -> AppResult<()> {
        self.send(Outgoing::Inspect { request_id: request_id.to_string() })
    }

    /// Ask the Companion to save the open project to `path`. It answers like a starter (`status().starter`).
    pub fn request_save_as(&self, request_id: &str, path: &str) -> AppResult<()> {
        self.send(Outgoing::SaveAs { request_id: request_id.to_string(), path: path.to_string() })
    }

    /// Tell the panel how its "add this project" request is going.
    pub fn send_add_project_status(&self, request_id: &str, text: &str, done: bool, ok: bool) {
        let _ = self.send(Outgoing::AddProjectStatus {
            request_id: request_id.to_string(),
            text: text.chars().take(300).collect(),
            done,
            ok,
        });
    }

    /// Answer the panel's question about other versions next to the open project.
    pub fn send_versions(&self, request_id: &str, files: &[crate::versions::Candidate]) {
        let _ = self.send(Outgoing::Versions { request_id: request_id.to_string(), files: files.to_vec() });
    }

    /// Ask the Companion to put the image at `path` in After Effects' active composition.
    /// With `as_shapes` (for an SVG), the layer is turned into shape layers.
    pub fn request_import_image(&self, request_id: &str, path: &str, as_shapes: bool) -> AppResult<()> {
        self.send(Outgoing::ImportImage { request_id: request_id.to_string(), path: path.to_string(), as_shapes })
    }

    /// Ask the Companion to show a layer (and property) in After Effects.
    pub fn request_reveal(&self, request_id: &str, target: RevealTarget) -> AppResult<()> {
        self.send(Outgoing::Reveal { request_id: request_id.to_string(), target })
    }

    /// Ask the Companion to create a new project in After Effects and save it at `spec.path`.
    pub fn request_create_starter(&self, spec: StarterSpec) -> AppResult<()> {
        if self.status().scanning {
            return Err(AppError::Invalid("The Companion is busy with a scan.".into()));
        }
        self.send(Outgoing::CreateStarter(spec))
    }

    /// Talk to this After Effects from now on (the picker).
    pub fn switch_to(&self, id: u64) -> AppResult<()> {
        if self.shared.switch_to(id) {
            Ok(())
        } else {
            Err(AppError::Invalid("That After Effects is not connected any more.".into()))
        }
    }

    /// If another connected After Effects has this project open, talk to that one.
    pub fn prefer_project(&self, project_id: &str) {
        self.shared.prefer_project(project_id);
    }

    fn send(&self, msg: Outgoing) -> AppResult<()> {
        let inner = self.shared.inner();
        let tx = inner.active.and_then(|id| inner.conns.iter().find(|c| c.id == id)).map(|c| &c.tx);
        match tx {
            Some(tx) if tx.send(msg).is_ok() => Ok(()),
            _ => Err(AppError::Invalid(
                "The After Effects Companion is not connected.".into(),
            )),
        }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // The port stops existing with the app; do not leave a file pointing at it.
        let _ = fs::remove_file(&self.file);
    }
}

#[derive(Serialize)]
struct BridgeFile<'a> {
    v: u32,
    port: u16,
    token: &'a str,
}

fn write_bridge_file(file: &Path, port: u16, token: &str) -> AppResult<()> {
    let bytes = serde_json::to_vec(&BridgeFile { v: PROTOCOL, port, token })
        .map_err(|e| AppError::Invalid(e.to_string()))?;
    let tmp = file.with_extension("json.tmp");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp).map_err(|e| AppError::io(&tmp, e))?;
    f.write_all(&bytes).map_err(|e| AppError::io(&tmp, e))?;
    f.sync_all().map_err(|e| AppError::io(&tmp, e))?;
    drop(f);
    fs::rename(&tmp, file).map_err(|e| AppError::io(file, e))
}

fn reject(status: StatusCode, why: &str) -> ErrorResponse {
    let mut r = ErrorResponse::new(Some(why.to_string()));
    *r.status_mut() = status;
    r
}

/// The panel is loaded from a file (`file://` or `null`) when built, or from a local dev server
/// (`http://localhost:<port>`) while it is being developed. Pages on any other site are refused.
/// This is a second line of defence; the token is what actually protects the link.
fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(o) = origin else { return true };
    if o == "null" || o.starts_with("file://") {
        return true;
    }
    let Some(rest) = o.strip_prefix("http://") else {
        return false;
    };
    let (host, port) = match rest.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (rest, None),
    };
    (host == "localhost" || host == "127.0.0.1")
        && port.map(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())).unwrap_or(true)
}

fn check_request(req: &Request, token: &str) -> Result<(), ErrorResponse> {
    let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
    if !origin_allowed(origin) {
        return Err(reject(StatusCode::FORBIDDEN, "origin not allowed"));
    }
    if req.uri().path() != "/" {
        return Err(reject(StatusCode::NOT_FOUND, "not found"));
    }
    let given = req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=")));
    if given != Some(token) {
        return Err(reject(StatusCode::UNAUTHORIZED, "bad token"));
    }
    Ok(())
}

fn serve(stream: TcpStream, shared: Arc<Shared>) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT));
    let token = shared.token.clone();
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES));
    let ws = tungstenite::accept_hdr_with_config(
        stream,
        move |req: &Request, resp: Response| {
            check_request(req, &token).map(|_| resp).inspect_err(|e| {
                // Visible in the terminal when running `tauri dev`; never includes the token.
                eprintln!("Companion link: refused a connection ({:?})", e.body());
            })
        },
        Some(config),
    );
    let Ok(mut ws) = ws else {
        return;
    };
    let _ = ws.get_ref().set_read_timeout(Some(POLL));

    // Nothing is taken over until the first message says who is connecting: a connection that only says hello
    // must not push out the one that is working.
    let mut id: u64 = 0;
    let mut rx: Option<mpsc::Receiver<Outgoing>> = None;
    let mut last_heard = Instant::now();
    let mut last_ping = Instant::now();

    'conn: loop {
        if id != 0 && !shared.alive(id) {
            let _ = ws.close(None);
            let _ = ws.flush();
            return; // replaced: the newer connection owns the state now
        }
        if let Some(rx) = &rx {
            while let Ok(cmd) = rx.try_recv() {
                if ws.send(Message::text(cmd.json())).is_err() {
                    break 'conn;
                }
            }
        }
        if last_ping.elapsed() >= PING_EVERY {
            last_ping = Instant::now();
            if ws.send(Message::Ping(Vec::new().into())).is_err() {
                break;
            }
        }
        if last_heard.elapsed() >= SILENCE_LIMIT {
            break;
        }
        match ws.read() {
            Ok(Message::Text(text)) => {
                last_heard = Instant::now();
                let Ok(msg) = serde_json::from_str::<Incoming>(&text) else {
                    continue; // unknown message types are ignored, so newer panels still work
                };
                if id == 0 {
                    // The first message must be the panel's state, with a matching version.
                    let (source, host, label) = match &msg {
                        Incoming::State { v, source, host, host_label, .. } if *v == PROTOCOL => {
                            (source.clone(), host.clone(), host_label.clone())
                        }
                        _ => break,
                    };
                    let (tx, r) = mpsc::channel::<Outgoing>();
                    let Some(claimed) = shared.claim(host.as_deref(), label.as_deref(), source.as_deref(), tx) else {
                        let _ = ws.close(None);
                        let _ = ws.flush();
                        return; // the panel has the link; the helper tries again later
                    };
                    id = claimed;
                    rx = Some(r);
                }
                apply(&shared, id, msg);
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {
                last_heard = Instant::now(); // ping/pong/binary
                if id != 0 {
                    shared.touch(id);
                }
            }
            Err(WsError::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
    }

    // A connection that was replaced is already gone from the list; only a live one clears its entry.
    if id != 0 {
        shared.remove(id);
    }
    let _ = ws.close(None);
    let _ = ws.flush();
}

fn apply(shared: &Shared, id: u64, msg: Incoming) {
    shared.update(id, |s| match msg {
        Incoming::State { aep_path, project_id, scanning, activity, source, .. } => {
            s.source = source;
            s.connected = true;
            s.aep_path = aep_path;
            s.project_id = project_id;
            s.scanning = scanning;
            s.activity = if scanning { Some(activity.unwrap_or_else(|| "scan".into())) } else { None };
            if !scanning {
                s.progress = None;
            }
        }
        Incoming::Progress { done, total, comp_name, activity } => {
            s.scanning = true;
            s.activity = Some(activity.unwrap_or_else(|| "scan".into()));
            s.progress = Some(Progress { done, total, comp_name });
        }
        Incoming::RelinkDone { copied, reused, failed, items, trashed } => {
            s.scanning = false;
            s.activity = None;
            s.progress = None;
            s.finished += 1;
            s.last = Some(Outcome {
                activity: "relink".into(),
                kind: "done".into(),
                message: None,
                colors: None,
                expressions: None,
                comps: None,
                copied: Some(copied),
                reused: Some(reused),
                failed: Some(failed),
                items: Some(items),
                trashed: Some(trashed),
            });
        }
        Incoming::RelinkFailed { message } => {
            s.scanning = false;
            s.activity = None;
            s.progress = None;
            s.finished += 1;
            s.last = Some(Outcome {
                activity: "relink".into(),
                kind: "failed".into(),
                message: Some(message.chars().take(500).collect()),
                colors: None,
                expressions: None,
                comps: None,
                copied: None,
                reused: None,
                failed: None,
                items: None,
                trashed: None,
            });
        }
        Incoming::ScanDone { colors, expressions, comps } => {
            s.scanning = false;
            s.progress = None;
            s.activity = None;
            s.finished += 1;
            s.last = Some(Outcome {
                activity: "scan".into(),
                kind: "done".into(),
                message: None,
                colors: Some(colors),
                expressions: Some(expressions),
                comps: Some(comps),
                copied: None,
                reused: None,
                failed: None,
                items: None,
                trashed: None,
            });
        }
        Incoming::ScanFailed { message } => {
            s.scanning = false;
            s.progress = None;
            s.activity = None;
            s.finished += 1;
            s.last = Some(Outcome {
                activity: "scan".into(),
                kind: "failed".into(),
                message: Some(message.chars().take(500).collect()),
                colors: None,
                expressions: None,
                comps: None,
                copied: None,
                reused: None,
                failed: None,
                items: None,
                trashed: None,
            });
        }
        Incoming::ScanCancelled => {
            s.scanning = false;
            s.progress = None;
            s.activity = None;
            s.finished += 1;
            s.last = Some(Outcome {
                activity: "scan".into(),
                kind: "cancelled".into(),
                message: None,
                colors: None,
                expressions: None,
                comps: None,
                copied: None,
                reused: None,
                failed: None,
                items: None,
                trashed: None,
            });
        }
        Incoming::InspectResult { request_id, kind, name, path } => {
            s.inspect = Some(InspectOutcome { request_id, kind, name, path });
        }
        Incoming::StarterDone { request_id, path, previous } => {
            s.starter = Some(StarterOutcome {
                request_id,
                ok: true,
                path: Some(path),
                message: None,
                previous: previous.filter(|p| !p.is_empty()),
            });
        }
        Incoming::StarterFailed { request_id, message } => {
            s.starter = Some(StarterOutcome {
                request_id,
                ok: false,
                path: None,
                message: Some(message.chars().take(500).collect()),
                previous: None,
            });
        }
        Incoming::AddProject { request_id, name, parent_dir, versions } => {
            s.add_project = Some(AddProjectRequest { request_id, name, parent_dir, versions });
        }
        Incoming::ListVersions { request_id } => {
            s.versions_request = Some(request_id);
        }
        Incoming::ImportDone { request_id, comp, created } => {
            s.import = Some(ImportOutcome { request_id, ok: true, comp: Some(comp), created, message: None });
        }
        Incoming::ImportFailed { request_id, message } => {
            s.import = Some(ImportOutcome {
                request_id,
                ok: false,
                comp: None,
                created: false,
                message: Some(message.chars().take(500).collect()),
            });
        }
        Incoming::RevealDone { request_id, message } => {
            let message = Some(message.chars().take(500).collect::<String>()).filter(|m| !m.is_empty());
            s.reveal = Some(RevealOutcome { request_id, ok: true, message });
        }
        Incoming::RevealFailed { request_id, message } => {
            s.reveal = Some(RevealOutcome { request_id, ok: false, message: Some(message.chars().take(500).collect()) });
        }
        Incoming::Pong => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tungstenite::client::IntoClientRequest;

    type Client = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>;

    fn start() -> (tempfile::TempDir, Bridge, Arc<Mutex<Vec<PanelState>>>) {
        let dir = tempfile::tempdir().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let bridge = Bridge::start(
            dir.path(),
            Arc::new(move |s: &PanelState| sink.lock().unwrap().push(s.clone())),
        )
        .unwrap();
        (dir, bridge, seen)
    }

    fn connect(url: &str, origin: Option<&str>) -> Result<Client, WsError> {
        let mut req = url.into_client_request().unwrap();
        if let Some(o) = origin {
            req.headers_mut().insert("origin", o.parse().unwrap());
        }
        let (ws, _) = tungstenite::connect(req)?;
        Ok(ws)
    }

    fn url(b: &Bridge) -> String {
        format!("ws://127.0.0.1:{}/?token={}", b.port(), b.token())
    }

    fn wait(mut cond: impl FnMut() -> bool) {
        for _ in 0..200 {
            if cond() {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("condition not met in time");
    }

    fn state_msg(project: Option<&str>, scanning: bool) -> Message {
        let p = project.map(|p| format!("\"{p}\"")).unwrap_or("null".into());
        Message::text(format!(
            r#"{{"v":1,"type":"state","aepPath":"/x/a.aep","projectId":{p},"scanning":{scanning}}}"#
        ))
    }

    fn read_text(ws: &mut Client) -> String {
        loop {
            match ws.read().unwrap() {
                Message::Text(t) => return t.to_string(),
                _ => continue,
            }
        }
    }

    #[test]
    fn publishes_port_and_token_in_a_private_file() {
        let (dir, bridge, _) = start();
        let text = fs::read_to_string(dir.path().join(BRIDGE_FILE)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["v"], 1);
        assert_eq!(v["port"], bridge.port());
        assert_eq!(v["token"], bridge.token());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(BRIDGE_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "token file must not be readable by others");
        }
        let file = dir.path().join(BRIDGE_FILE);
        drop(bridge);
        assert!(!file.exists(), "file is removed when the app stops");
    }

    #[test]
    fn refuses_wrong_token_browser_origin_and_other_paths() {
        let (_d, bridge, _) = start();
        let port = bridge.port();
        assert!(connect(&format!("ws://127.0.0.1:{port}/?token=nope"), None).is_err());
        assert!(connect(&format!("ws://127.0.0.1:{port}/"), None).is_err());
        assert!(connect(&format!("ws://127.0.0.1:{port}/other?token={}", bridge.token()), None).is_err());
        assert!(connect(&url(&bridge), Some("https://evil.example")).is_err());
        assert!(connect(&url(&bridge), Some("http://localhost.evil.example")).is_err());
        assert!(connect(&url(&bridge), Some("http://localhost:3000")).is_ok(), "the panel's dev server");
        assert!(connect(&url(&bridge), Some("file://")).is_ok());
        assert!(connect(&url(&bridge), None).is_ok());
        assert!(!bridge.status().connected, "a connection that never said hello is not 'connected'");
    }

    #[test]
    fn state_progress_and_results_reach_the_app() {
        let (_d, bridge, seen) = start();
        let mut ws = connect(&url(&bridge), None).unwrap();
        ws.send(state_msg(Some("p1"), false)).unwrap();
        wait(|| bridge.status().connected);
        let s = bridge.status();
        assert_eq!(s.project_id.as_deref(), Some("p1"));
        assert_eq!(s.aep_path.as_deref(), Some("/x/a.aep"));

        ws.send(Message::text(r#"{"type":"progress","done":2,"total":5,"compName":"Main"}"#)).unwrap();
        wait(|| bridge.status().progress.is_some());
        assert!(bridge.status().scanning);
        assert_eq!(bridge.status().progress.unwrap().total, 5);

        ws.send(Message::text(r#"{"type":"scanDone","colors":4,"expressions":2,"comps":3}"#)).unwrap();
        wait(|| bridge.status().last.is_some());
        let s = bridge.status();
        assert!(!s.scanning && s.progress.is_none());
        assert_eq!(s.last.unwrap().colors, Some(4));

        ws.send(Message::text(r#"{"type":"scanFailed","message":"boom"}"#)).unwrap();
        wait(|| bridge.status().last.as_ref().map(|o| o.kind == "failed").unwrap_or(false));
        assert!(seen.lock().unwrap().len() >= 4, "the UI is notified on every change");
    }

    #[test]
    fn scan_and_cancel_commands_reach_the_panel_only_for_the_matching_project() {
        let (_d, bridge, _) = start();
        assert!(bridge.request_scan("p1").is_err(), "no panel yet");

        let mut ws = connect(&url(&bridge), None).unwrap();
        ws.send(state_msg(Some("p1"), false)).unwrap();
        wait(|| bridge.status().connected);

        let other = bridge.request_scan("p2").unwrap_err().to_string();
        assert!(other.contains("different Murre project"), "{other}");

        bridge.request_scan("p1").unwrap();
        let got: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(got, serde_json::json!({"v": 1, "type": "scan", "projectId": "p1"}));

        ws.send(state_msg(Some("p1"), true)).unwrap();
        wait(|| bridge.status().scanning);
        assert!(bridge.request_scan("p1").unwrap_err().to_string().contains("already running"));
        bridge.request_cancel().unwrap();
        let got: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(got["type"], "cancel");
    }

    #[test]
    fn relink_command_and_results_use_the_same_checks_and_report_their_own_outcome() {
        let (_d, bridge, _) = start();
        assert!(bridge.request_relink("p1").is_err(), "no panel yet");
        let mut ws = connect(&url(&bridge), None).unwrap();
        ws.send(state_msg(Some("p1"), false)).unwrap();
        wait(|| bridge.status().connected);
        assert!(bridge.request_relink("p2").unwrap_err().to_string().contains("different Murre project"));

        bridge.request_relink("p1").unwrap();
        let got: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(got, serde_json::json!({"v": 1, "type": "relink", "projectId": "p1"}));

        // busy copying: neither a scan nor a second relink may start
        ws.send(Message::text(r#"{"type":"progress","done":1,"total":3,"compName":"a.png","activity":"relink"}"#)).unwrap();
        wait(|| bridge.status().scanning);
        assert_eq!(bridge.status().activity.as_deref(), Some("relink"));
        assert!(bridge.request_scan("p1").unwrap_err().to_string().contains("being copied"));
        assert!(bridge.request_relink("p1").is_err());

        ws.send(Message::text(r#"{"type":"relinkDone","copied":2,"reused":1,"failed":0,"items":4}"#)).unwrap();
        wait(|| !bridge.status().scanning);
        let s = bridge.status();
        let last = s.last.unwrap();
        assert_eq!((last.activity.as_str(), last.kind.as_str()), ("relink", "done"));
        assert_eq!((last.copied, last.reused, last.failed, last.items), (Some(2), Some(1), Some(0), Some(4)));
        assert!(s.activity.is_none());

        ws.send(Message::text(r#"{"type":"relinkFailed","message":"nope"}"#)).unwrap();
        wait(|| bridge.status().last.map(|l| l.kind == "failed").unwrap_or(false));
        assert_eq!(bridge.status().last.unwrap().message.as_deref(), Some("nope"));
    }

    #[test]
    fn unlinked_panel_cannot_be_asked_to_scan() {
        let (_d, bridge, _) = start();
        let mut ws = connect(&url(&bridge), None).unwrap();
        ws.send(state_msg(None, false)).unwrap();
        wait(|| bridge.status().connected);
        let e = bridge.request_scan("p1").unwrap_err().to_string();
        assert!(e.contains("not linked"), "{e}");
    }

    #[test]
    fn first_message_must_be_state_with_the_right_version() {
        let (_d, bridge, _) = start();
        let mut ws = connect(&url(&bridge), None).unwrap();
        ws.send(Message::text(r#"{"type":"scanDone","colors":1,"expressions":1,"comps":1}"#)).unwrap();
        thread::sleep(Duration::from_millis(300));
        assert!(!bridge.status().connected && bridge.status().last.is_none());

        let mut ws = connect(&url(&bridge), None).unwrap();
        ws.send(Message::text(r#"{"v":99,"type":"state","aepPath":null,"projectId":null,"scanning":false}"#)).unwrap();
        thread::sleep(Duration::from_millis(300));
        assert!(!bridge.status().connected);
    }

    #[test]
    fn ignores_unknown_and_malformed_messages_and_huge_ones() {
        let (_d, bridge, _) = start();
        let mut ws = connect(&url(&bridge), None).unwrap();
        ws.send(state_msg(Some("p1"), false)).unwrap();
        wait(|| bridge.status().connected);
        ws.send(Message::text(r#"{"type":"somethingNew","x":1}"#)).unwrap();
        ws.send(Message::text("not json")).unwrap();
        thread::sleep(Duration::from_millis(200));
        assert!(bridge.status().connected, "unknown messages do not drop the panel");

        let _ = ws.send(Message::text("x".repeat(MAX_MESSAGE_BYTES + 10)));
        wait(|| !bridge.status().connected);
    }

    #[test]
    fn disconnect_clears_the_state_and_a_newer_panel_replaces_an_older_one() {
        let (_d, bridge, _) = start();
        let mut first = connect(&url(&bridge), None).unwrap();
        first.send(state_msg(Some("p1"), false)).unwrap();
        wait(|| bridge.status().connected);

        let mut second = connect(&url(&bridge), None).unwrap();
        second.send(state_msg(Some("p2"), false)).unwrap();
        wait(|| bridge.status().project_id.as_deref() == Some("p2"));
        thread::sleep(Duration::from_millis(300));
        assert!(bridge.status().connected, "the older connection closing must not clear the newer state");
        bridge.request_scan("p2").unwrap();
        assert!(read_text(&mut second).contains("scan"));

        second.close(None).unwrap();
        let _ = second.flush();
        wait(|| !bridge.status().connected);
        assert_eq!(bridge.status(), PanelState::default());
        assert!(bridge.request_cancel().is_err());
    }

    const BACKGROUND: &str = r#"{"v":1,"type":"state","aepPath":"/x/a.aep","projectId":"p1","scanning":false,"source":"background"}"#;

    /// True once the app has closed this connection.
    fn closed_by_app(ws: &mut Client) -> bool {
        let end = Instant::now() + Duration::from_secs(3);
        while Instant::now() < end {
            match ws.read() {
                Ok(Message::Close(_)) | Err(_) => return true,
                Ok(_) => {}
            }
        }
        false
    }

    #[test]
    fn the_background_helper_does_not_take_the_link_from_a_panel_that_is_there() {
        let (_d, bridge, _) = start();
        let mut panel = connect(&url(&bridge), None).unwrap();
        panel.send(state_msg(Some("p1"), false)).unwrap();
        wait(|| bridge.status().connected);

        // Asks again and again, like the helper does; the panel must keep the link every time.
        for _ in 0..3 {
            let mut helper = connect(&url(&bridge), None).unwrap();
            helper.send(Message::text(BACKGROUND)).unwrap();
            assert!(closed_by_app(&mut helper), "the helper should be turned away");
            thread::sleep(Duration::from_millis(150));
            assert!(bridge.status().connected);
            assert_eq!(bridge.status().source, None, "state still comes from the panel");
        }
        bridge.request_scan("p1").unwrap();
        assert!(read_text(&mut panel).contains("scan"), "commands still reach the panel");
    }

    #[test]
    fn a_panel_replaces_the_helper_and_the_helper_gets_the_link_when_no_panel_is_there() {
        let (_d, bridge, _) = start();
        let mut helper = connect(&url(&bridge), None).unwrap();
        helper.send(Message::text(BACKGROUND)).unwrap();
        wait(|| bridge.status().source.as_deref() == Some("background"));

        let mut panel = connect(&url(&bridge), None).unwrap();
        panel.send(state_msg(Some("p1"), false)).unwrap();
        wait(|| bridge.status().source.is_none() && bridge.status().connected);
        assert!(closed_by_app(&mut helper), "the helper is closed when a panel arrives");

        // The panel goes away; the helper may take the link again.
        panel.close(None).unwrap();
        let _ = panel.flush();
        wait(|| !bridge.status().connected);
        let mut helper = connect(&url(&bridge), None).unwrap();
        helper.send(Message::text(BACKGROUND)).unwrap();
        wait(|| bridge.status().source.as_deref() == Some("background"));
    }

    #[test]
    fn a_connection_that_has_not_said_who_it_is_does_not_push_out_the_working_one() {
        let (_d, bridge, _) = start();
        let mut panel = connect(&url(&bridge), None).unwrap();
        panel.send(state_msg(Some("p1"), false)).unwrap();
        wait(|| bridge.status().connected);

        let _silent = connect(&url(&bridge), None).unwrap();
        thread::sleep(Duration::from_millis(400));
        assert!(bridge.status().connected);
        bridge.request_scan("p1").unwrap();
        assert!(read_text(&mut panel).contains("scan"));
    }

    #[test]
    fn the_background_helper_reports_its_project_and_is_asked_to_scan_like_the_panel() {
        let (_d, bridge, _) = start();
        let mut ws = connect(&url(&bridge), None).unwrap();
        ws.send(Message::text(r#"{"v":1,"type":"state","aepPath":"/x/a.aep","projectId":"p1","scanning":false,"source":"background"}"#)).unwrap();
        wait(|| bridge.status().connected);
        assert_eq!(bridge.status().project_id.as_deref(), Some("p1"));
        assert_eq!(bridge.status().source.as_deref(), Some("background"));
        bridge.request_scan("p1").unwrap();
        assert!(read_text(&mut ws).contains("\"scan\""));
        assert!(bridge.request_scan("p2").unwrap_err().to_string().contains("different Murre project"));
    }

    fn host_msg(host: &str, label: &str, project: &str) -> Message {
        Message::text(format!(
            r#"{{"v":1,"type":"state","aepPath":"/x/{project}.aep","projectId":"{project}","scanning":false,"source":"panel","host":"{host}","hostLabel":"{label}"}}"#
        ))
    }

    #[test]
    fn two_after_effects_stay_connected_side_by_side() {
        let (_d, bridge, _) = start();
        let mut a = connect(&url(&bridge), None).unwrap();
        a.send(host_msg("/Applications/AE26", "After Effects 2026", "p1")).unwrap();
        wait(|| bridge.status().connected);
        let mut b = connect(&url(&bridge), None).unwrap();
        b.send(host_msg("/Applications/AEBeta", "After Effects 2026 Beta", "p2")).unwrap();
        wait(|| bridge.status().connections.len() == 2);

        // The first one stays the active one; neither was closed by the other.
        let st = bridge.status();
        assert_eq!(st.project_id.as_deref(), Some("p1"));
        let labels: Vec<_> = st.connections.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, ["After Effects 2026", "After Effects 2026 Beta"]);
        assert!(!closed_by_app(&mut a));
        assert!(!closed_by_app(&mut b));

        // A newer connection from the same After Effects replaces its own older one only.
        let mut a2 = connect(&url(&bridge), None).unwrap();
        a2.send(host_msg("/Applications/AE26", "After Effects 2026", "p1")).unwrap();
        wait(|| closed_by_app(&mut a));
        assert_eq!(bridge.status().connections.len(), 2);
        assert!(!closed_by_app(&mut b));
    }

    #[test]
    fn commands_go_to_the_active_after_effects_and_switching_changes_which() {
        let (_d, bridge, _) = start();
        let mut a = connect(&url(&bridge), None).unwrap();
        a.send(host_msg("A", "After Effects 2026", "p1")).unwrap();
        wait(|| bridge.status().connected);
        let mut b = connect(&url(&bridge), None).unwrap();
        b.send(host_msg("B", "After Effects 2026 Beta", "p2")).unwrap();
        wait(|| bridge.status().connections.len() == 2);

        let beta = bridge.status().connections.iter().find(|c| c.project_id.as_deref() == Some("p2")).unwrap().id;
        bridge.switch_to(beta).unwrap();
        assert_eq!(bridge.status().project_id.as_deref(), Some("p2"));
        bridge.request_cancel().unwrap();
        assert!(read_text(&mut b).contains("cancel"));
        assert!(bridge.switch_to(9999).is_err());
    }

    #[test]
    fn asking_for_a_project_switches_to_the_after_effects_that_has_it_open() {
        let (_d, bridge, _) = start();
        let mut a = connect(&url(&bridge), None).unwrap();
        a.send(host_msg("A", "After Effects 2026", "p1")).unwrap();
        wait(|| bridge.status().connected);
        let mut b = connect(&url(&bridge), None).unwrap();
        b.send(host_msg("B", "After Effects 2026 Beta", "p2")).unwrap();
        wait(|| bridge.status().connections.len() == 2);

        bridge.request_scan("p2").unwrap();
        assert!(read_text(&mut b).contains("\"scan\""));
        assert_eq!(bridge.status().project_id.as_deref(), Some("p2"));
        // A project that neither has open keeps the current one and says so.
        assert!(bridge.request_scan("p3").unwrap_err().to_string().contains("different Murre project"));
        assert_eq!(bridge.status().project_id.as_deref(), Some("p2"));
    }

    #[test]
    fn when_the_active_after_effects_closes_the_other_becomes_active() {
        let (_d, bridge, _) = start();
        let mut a = connect(&url(&bridge), None).unwrap();
        a.send(host_msg("A", "After Effects 2026", "p1")).unwrap();
        wait(|| bridge.status().connected);
        let mut b = connect(&url(&bridge), None).unwrap();
        b.send(host_msg("B", "After Effects 2026 Beta", "p2")).unwrap();
        wait(|| bridge.status().connections.len() == 2);

        let _ = a.close(None);
        wait(|| bridge.status().connections.len() == 1);
        let st = bridge.status();
        assert!(st.connected);
        assert_eq!(st.project_id.as_deref(), Some("p2"));
        assert_eq!(st.connections.len(), 1);
    }

    #[test]
    fn add_project_request_save_as_and_finish_counter() {
        let (_d, bridge, _) = start();
        let mut ws = connect(&url(&bridge), None).unwrap();
        ws.send(state_msg(None, false)).unwrap();
        wait(|| bridge.status().connected);
        ws.send(Message::text(r#"{"type":"addProject","requestId":"a1","name":"Film","parentDir":"/p"}"#)).unwrap();
        wait(|| bridge.status().add_project.is_some());
        let req = bridge.status().add_project.unwrap();
        assert_eq!((req.name.as_str(), req.parent_dir.as_str()), ("Film", "/p"));
        bridge.request_save_as("s1", "/p/Film/01 AE Workfile/Film_v3.aep").unwrap();
        let got: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(got["type"], "saveAs");
        assert_eq!(got["path"], "/p/Film/01 AE Workfile/Film_v3.aep");
        bridge.send_add_project_status("a1", "Scanning", false, true);
        let got: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!((got["type"].as_str(), got["text"].as_str(), got["done"].as_bool()), (Some("addProjectStatus"), Some("Scanning"), Some(false)));
        assert_eq!(bridge.status().finished, 0);
        ws.send(Message::text(r#"{"type":"scanDone","colors":1,"expressions":2,"comps":3}"#)).unwrap();
        wait(|| bridge.status().finished == 1);
    }

    #[test]
    fn other_versions_question_answer_and_selection() {
        let (_d, bridge, _) = start();
        let mut ws = connect(&url(&bridge), None).unwrap();
        ws.send(state_msg(None, false)).unwrap();
        wait(|| bridge.status().connected);
        ws.send(Message::text(r#"{"type":"listVersions","requestId":"v1"}"#)).unwrap();
        wait(|| bridge.status().versions_request.is_some());
        assert_eq!(bridge.status().versions_request.as_deref(), Some("v1"));
        let files = vec![crate::versions::Candidate { name: "Film_v2.aep".into(), size: 10, modified: Some(5), suggested: true }];
        bridge.send_versions("v1", &files);
        let got: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(got["type"], "versions");
        assert_eq!(got["requestId"], "v1");
        assert_eq!(got["files"][0]["name"], "Film_v2.aep");
        assert_eq!(got["files"][0]["suggested"], true);
        ws.send(Message::text(r#"{"type":"addProject","requestId":"a2","name":"Film","parentDir":"/p","versions":["Film_v2.aep"]}"#)).unwrap();
        wait(|| bridge.status().add_project.is_some());
        assert_eq!(bridge.status().add_project.unwrap().versions, vec!["Film_v2.aep".to_string()]);
    }

    #[test]
    fn create_starter_request_and_answer() {
        let (_d, bridge, _) = start();
        let spec = |id: &str| StarterSpec {
            request_id: id.into(),
            path: "/p/01 AE Workfile/x-v1.aep".into(),
            comp_name: "Main Comp".into(),
            width: 1920,
            height: 1080,
            fps: 30.0,
            seconds: 30.0,
            rescue_dir: "/Users/x/Desktop".into(),
        };
        assert!(bridge.request_create_starter(spec("r0")).is_err(), "nobody connected");
        let mut ws = connect(&url(&bridge), None).unwrap();
        ws.send(state_msg(None, false)).unwrap();
        wait(|| bridge.is_connected());
        bridge.request_create_starter(spec("r1")).unwrap();
        let got: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(got["type"], "createStarter");
        assert_eq!(got["requestId"], "r1");
        assert_eq!(got["width"], 1920);
        assert_eq!(got["fps"], 30.0);
        assert_eq!(got["rescueDir"], "/Users/x/Desktop");
        ws.send(Message::text(r#"{"type":"starterDone","requestId":"r1","path":"/p/a.aep","previous":"/old.aep"}"#)).unwrap();
        wait(|| bridge.status().starter.is_some());
        let r = bridge.status().starter.unwrap();
        assert!(r.ok && r.request_id == "r1");
        assert_eq!(r.previous.as_deref(), Some("/old.aep"));

        bridge.request_inspect("q1").unwrap();
        let got: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(got, serde_json::json!({"v": 1, "type": "inspect", "requestId": "q1"}));
        ws.send(Message::text(r#"{"type":"inspectResult","requestId":"q1","kind":"saved","name":"a.aep","path":"/a.aep"}"#)).unwrap();
        wait(|| bridge.status().inspect.is_some());
        assert_eq!(bridge.status().inspect.unwrap().kind, "saved");
        bridge.request_import_image("i1", "/a.png", false).unwrap();
        let got: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(got, serde_json::json!({"v": 1, "type": "importImage", "requestId": "i1", "path": "/a.png"}));
        ws.send(Message::text(r#"{"type":"importDone","requestId":"i1","comp":"C","created":true}"#)).unwrap();
        wait(|| bridge.status().import.is_some());
        assert!(bridge.status().import.unwrap().created);
        bridge.request_import_image("i2", "/a.svg", true).unwrap();
        let got: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(got, serde_json::json!({"v": 1, "type": "importImage", "requestId": "i2", "path": "/a.svg", "asShapes": true}));
        bridge
            .request_reveal("v1", RevealTarget { comp_id: 3, comp_name: "Main".into(), layer_index: 2, layer_name: "Title".into(), property_path: "A > B".into() })
            .unwrap();
        let got: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(
            got,
            serde_json::json!({"v": 1, "type": "reveal", "requestId": "v1", "compId": 3, "compName": "Main", "layerIndex": 2, "layerName": "Title", "propertyPath": "A > B"})
        );
        ws.send(Message::text(r#"{"type":"revealDone","requestId":"v1","message":"moved"}"#)).unwrap();
        wait(|| bridge.status().reveal.is_some());
        let r = bridge.status().reveal.unwrap();
        assert!(r.ok && r.message.as_deref() == Some("moved"));
        ws.send(Message::text(r#"{"type":"revealFailed","requestId":"v2","message":"gone"}"#)).unwrap();
        wait(|| bridge.status().reveal.as_ref().map(|r| r.request_id == "v2").unwrap_or(false));
        assert!(!bridge.status().reveal.unwrap().ok);
        ws.send(Message::text(r#"{"type":"starterFailed","requestId":"r2","message":"nope"}"#)).unwrap();
        wait(|| bridge.status().starter.map(|r| r.request_id == "r2").unwrap_or(false));
        assert!(!bridge.status().starter.unwrap().ok);
    }

    #[test]
    fn origin_rules() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("null")));
        assert!(origin_allowed(Some("file://")));
        assert!(!origin_allowed(Some("https://example.com")));
        assert!(origin_allowed(Some("http://localhost:3000")));
        assert!(origin_allowed(Some("http://127.0.0.1:8080")));
        assert!(origin_allowed(Some("http://localhost")));
        assert!(!origin_allowed(Some("https://localhost:3000")));
        assert!(!origin_allowed(Some("http://localhost.evil.com")));
        assert!(!origin_allowed(Some("http://localhost:3000.evil.com")));
        assert!(!origin_allowed(Some("http://evil.com:3000")));
        assert!(!origin_allowed(Some("http://localhost:")));
    }
}
