//! Browsing of rendered media (pre-renders, renders, deliverables), media
//! metadata via ffprobe, thumbnails via ffmpeg, and approvals.
//!
//! Rules this module keeps:
//! - Media files are only ever read. Nothing is moved, renamed or deleted.
//! - Thumbnails live in the app data directory, never inside the project.
//! - External tools run through `Command` with an argument list (no shell)
//!   and a timeout.
//! - An approval records the file's size and modified time. If the file later
//!   changes, the approval is reported as `changed` and is kept as it was
//!   until the user explicitly re-approves or removes it.

use crate::assets::{resolve_inside, safe_components};
use crate::error::{AppError, AppResult};
use crate::project::{invalid, now};
use crate::safe_fs;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, hash_map::DefaultHasher};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

pub const FOLDERS: [&str; 3] = ["05 Pre-Renders", "06 Renders", "07 Deliverables"];

const RENDERS_JSON: &str = ".murre/renders.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_DEPTH: usize = 4;
const MAX_ENTRIES: usize = 2000;
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const THUMB_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PROBE_OUTPUT: u64 = 4_000_000;

static APPROVAL_LOCK: Mutex<()> = Mutex::new(());

const VIDEO_EXT: &[&str] = &["mov", "mp4", "m4v", "mxf", "avi", "webm", "mkv"];
const IMAGE_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "tif", "tiff", "webp", "gif", "exr", "dpx", "bmp",
];
const AUDIO_EXT: &[&str] = &["wav", "mp3", "aif", "aiff", "m4a", "aac"];

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Video,
    Image,
    Audio,
}

fn kind_of(ext: &str) -> Option<MediaKind> {
    if VIDEO_EXT.contains(&ext) {
        Some(MediaKind::Video)
    } else if IMAGE_EXT.contains(&ext) {
        Some(MediaKind::Image)
    } else if AUDIO_EXT.contains(&ext) {
        Some(MediaKind::Audio)
    } else {
        None
    }
}

// ---------------------------------------------------------------- approvals

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Approval {
    approved_at: u64,
    size_bytes: u64,
    modified_ms: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RendersFile {
    schema_version: u32,
    #[serde(default)]
    approvals: BTreeMap<String, Approval>,
    /// Unknown keys (including the initial empty `renders` list) are preserved.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

fn load(root: &Path) -> AppResult<RendersFile> {
    let path = root.join(RENDERS_JSON);
    if !path.exists() && !safe_fs::backup_path(&path).exists() {
        return Ok(RendersFile {
            schema_version: SCHEMA_VERSION,
            approvals: BTreeMap::new(),
            extra: Map::new(),
        });
    }
    let (file, _): (RendersFile, _) = safe_fs::read_json(&path)?;
    if file.schema_version > SCHEMA_VERSION {
        return invalid("The render records were saved by a newer version of Murre.");
    }
    Ok(file)
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalState {
    /// Approved, and the file is unchanged since.
    Current,
    /// Approved, but the file's size or modified time differs from approval.
    Changed,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalView {
    pub approved_at: u64,
    pub state: ApprovalState,
}

// ------------------------------------------------------------------ listing

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderEntry {
    /// Path relative to the project root, `/`-separated.
    pub path: String,
    pub absolute_path: String,
    pub name: String,
    /// One of the three top-level render folders.
    pub folder: String,
    pub kind: MediaKind,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: u64,
    pub approval: Option<ApprovalView>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RendersListing {
    pub entries: Vec<RenderEntry>,
    pub truncated: bool,
    /// Approved files that are no longer on disk. Their records are kept.
    pub missing_approved: Vec<String>,
}

fn millis(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct Walk<'a> {
    canon_root: &'a Path,
    approvals: &'a BTreeMap<String, Approval>,
    out: Vec<RenderEntry>,
    truncated: bool,
}

impl Walk<'_> {
    fn visit(&mut self, dir: &Path, rel: &str, folder: &str, depth: usize) {
        let Ok(read) = fs::read_dir(dir) else { return };
        for item in read.flatten() {
            if self.out.len() >= MAX_ENTRIES {
                self.truncated = true;
                return;
            }
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(item.path()) else {
                continue;
            };
            // Symlinks are never followed.
            let ft = meta.file_type();
            let child_rel = format!("{rel}/{name}");
            if ft.is_dir() {
                if depth < MAX_DEPTH {
                    self.visit(&item.path(), &child_rel, folder, depth + 1);
                }
            } else if ft.is_file() {
                let Some(ext) = Path::new(&name)
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                else {
                    continue;
                };
                let Some(kind) = kind_of(&ext) else { continue };
                let size = meta.len();
                let modified = millis(meta.modified());
                let approval = self.approvals.get(&child_rel).map(|a| ApprovalView {
                    approved_at: a.approved_at,
                    state: if a.size_bytes == size && a.modified_ms == modified {
                        ApprovalState::Current
                    } else {
                        ApprovalState::Changed
                    },
                });
                self.out.push(RenderEntry {
                    absolute_path: self
                        .canon_root
                        .join(&child_rel)
                        .to_string_lossy()
                        .into_owned(),
                    path: child_rel,
                    name,
                    folder: folder.to_string(),
                    kind,
                    extension: ext,
                    size_bytes: size,
                    modified_at: modified,
                    approval,
                });
            }
        }
    }
}

pub fn list(root: &Path) -> AppResult<RendersListing> {
    let canon_root = crate::platform::canonicalize(root).map_err(|e| AppError::io(root, e))?;
    let file = load(root)?;
    let mut walk = Walk {
        canon_root: &canon_root,
        approvals: &file.approvals,
        out: Vec::new(),
        truncated: false,
    };
    for folder in FOLDERS {
        let dir = canon_root.join(folder);
        // A missing folder is simply empty; it is not created here.
        if dir.is_dir() && !fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
            walk.visit(&dir, folder, folder, 1);
        }
    }
    let mut entries = walk.out;
    let truncated = walk.truncated;
    entries.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| crate::assets::natural_cmp(&a.path, &b.path))
    });
    let present: std::collections::HashSet<&str> =
        entries.iter().map(|e| e.path.as_str()).collect();
    // When the scan was cut short, absence proves nothing.
    let missing_approved = if truncated {
        Vec::new()
    } else {
        file.approvals
            .keys()
            .filter(|k| !present.contains(k.as_str()))
            .cloned()
            .collect()
    };
    Ok(RendersListing {
        entries,
        truncated,
        missing_approved,
    })
}

/// Validate that `rel` names a regular media file inside one of the render
/// folders. Returns `(normalized relative path, canonical absolute path, kind)`.
fn resolve_media(root: &Path, rel: &str) -> AppResult<(String, PathBuf, MediaKind)> {
    let parts = safe_components(rel)?;
    if parts.len() < 2 || !FOLDERS.contains(&parts[0].as_str()) {
        return invalid("That file is not in a render folder.");
    }
    if parts.iter().any(|p| p.starts_with('.')) {
        return invalid("That file is not a render.");
    }
    let (canon_root, lexical, parts) = resolve_inside(root, rel)?;
    let meta = fs::symlink_metadata(&lexical).map_err(|e| AppError::io(&lexical, e))?;
    if !meta.file_type().is_file() {
        return invalid("That is not a regular file.");
    }
    let ext = lexical
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let Some(kind) = kind_of(&ext) else {
        return invalid("That is not a supported media file.");
    };
    let _ = canon_root;
    Ok((parts.join("/"), lexical, kind))
}

/// Approve (or remove the approval of) a render. Approving records the file's
/// current size and modified time; it also re-approves a `changed` file, which
/// is an explicit user action.
pub fn set_approved(root: &Path, rel: &str, approved: bool) -> AppResult<RendersListing> {
    let _guard = APPROVAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load(root)?;
    if approved {
        let (key, abs, _) = resolve_media(root, rel)?;
        let meta = fs::metadata(&abs).map_err(|e| AppError::io(&abs, e))?;
        file.approvals.insert(
            key,
            Approval {
                approved_at: now(),
                size_bytes: meta.len(),
                modified_ms: millis(meta.modified()),
            },
        );
    } else {
        // Removal needs no file on disk (the file may be gone), but the key
        // must still be a well-formed render path.
        let parts = safe_components(rel)?;
        if parts.len() < 2 || !FOLDERS.contains(&parts[0].as_str()) {
            return invalid("That file is not in a render folder.");
        }
        if file.approvals.remove(&parts.join("/")).is_none() {
            return list(root);
        }
    }
    file.schema_version = SCHEMA_VERSION;
    safe_fs::write_json(&root.join(RENDERS_JSON), &file)?;
    list(root)
}

// -------------------------------------------------------------------- tools

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaTools {
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
}

/// True when the program starts and answers `-version`. The stand-ins that a checkout without the real tools gets
/// exit with an error, so they count as "not there".
fn runs(path: &Path) -> bool {
    // Never start something that isn't a program: on Windows that pops up a system error box.
    if !crate::platform::is_program(path) {
        return false;
    }
    crate::platform::command(path)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// The copy that ships inside the app, next to its own program, if it works. Checked once.
fn bundled_tool(name: &str) -> Option<PathBuf> {
    static FFMPEG: OnceLock<Option<PathBuf>> = OnceLock::new();
    static FFPROBE: OnceLock<Option<PathBuf>> = OnceLock::new();
    let cell = match name {
        "ffmpeg" => &FFMPEG,
        "ffprobe" => &FFPROBE,
        _ => return None,
    };
    cell.get_or_init(|| {
        let path = std::env::current_exe().ok()?.parent()?.join(crate::platform::exe_name(name));
        runs(&path).then_some(path)
    })
    .clone()
}

/// What to say when neither Murre's own copy nor an installed FFmpeg can be started.
fn missing_tool_message(tool: &str) -> String {
    let install = if cfg!(windows) { "install FFmpeg and add it to PATH" } else { "install FFmpeg yourself (brew install ffmpeg)" };
    format!("Murre’s media tool ({tool}) wouldn’t start. Reinstall Murre, or {install}.")
}

/// The tool Murre ships with first, so nothing has to be installed. Failing that, GUI apps on macOS do not inherit
/// the shell PATH, so well-known install locations are checked (Homebrew, MacPorts), then PATH. Windows: PATH only.
pub fn find_tool(name: &str) -> Option<PathBuf> {
    if let Some(p) = bundled_tool(name) {
        return Some(p);
    }
    let file = crate::platform::exe_name(name);
    let mut dirs: Vec<PathBuf> = if cfg!(windows) {
        Vec::new()
    } else {
        ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"].iter().map(PathBuf::from).collect()
    };
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.into_iter()
        .map(|d| d.join(&file))
        .find(|p| crate::platform::is_program(p))
}

pub fn media_tools() -> MediaTools {
    let show = |n| find_tool(n).map(|p| p.display().to_string());
    MediaTools {
        ffmpeg: show("ffmpeg"),
        ffprobe: show("ffprobe"),
    }
}

/// Run a command with captured stdout, killing it after `timeout`.
fn run_capture(mut cmd: Command, timeout: Duration, limit: u64) -> AppResult<Vec<u8>> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Invalid(format!("Could not start the media tool: {e}")))?;
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stdout).take(limit).read_to_end(&mut buf);
        // Drain anything past the limit so the child never blocks on a full pipe.
        let _ = std::io::copy(&mut stdout, &mut std::io::sink());
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stderr).take(64_000).read_to_end(&mut buf);
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        buf
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return invalid("The media tool took too long and was stopped.");
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => return Err(AppError::Invalid(format!("Media tool failed: {e}"))),
        }
    };
    let out = out_thread.join().unwrap_or_default();
    let err = err_thread.join().unwrap_or_default();
    if !status.success() {
        let msg = String::from_utf8_lossy(&err);
        let first = msg.lines().next().unwrap_or("unknown error");
        return Err(AppError::Invalid(format!("Media tool error: {first}")));
    }
    Ok(out)
}

// ----------------------------------------------------------------- metadata

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f64>,
    pub pixel_format: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub codec: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub format_name: Option<String>,
    pub duration_secs: Option<f64>,
    pub bit_rate: Option<u64>,
    pub video: Option<VideoInfo>,
    pub audio: Option<AudioInfo>,
}

fn parse_fraction(s: &str) -> Option<f64> {
    let (n, d) = s.split_once('/')?;
    let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
    (d > 0.0 && n > 0.0).then(|| n / d)
}

fn num_str<T: std::str::FromStr>(v: &Value) -> Option<T> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.to_string().parse().ok(),
        _ => None,
    }
}

pub fn parse_probe(json: &[u8]) -> AppResult<MediaInfo> {
    let v: Value = serde_json::from_slice(json)
        .map_err(|_| AppError::Invalid("ffprobe returned unreadable output.".into()))?;
    let mut info = MediaInfo::default();
    if let Some(f) = v.get("format") {
        info.format_name = f
            .get("format_name")
            .and_then(Value::as_str)
            .map(String::from);
        info.duration_secs = f
            .get("duration")
            .and_then(num_str::<f64>)
            .filter(|d| d.is_finite() && *d >= 0.0);
        info.bit_rate = f.get("bit_rate").and_then(num_str::<u64>);
    }
    for s in v
        .get("streams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let codec = s
            .get("codec_name")
            .and_then(Value::as_str)
            .map(String::from);
        match s.get("codec_type").and_then(Value::as_str) {
            Some("video") if info.video.is_none() => {
                // Cover art in audio files shows up as an attached picture.
                if s.pointer("/disposition/attached_pic")
                    .and_then(Value::as_u64)
                    == Some(1)
                {
                    continue;
                }
                let fps = s
                    .get("avg_frame_rate")
                    .and_then(Value::as_str)
                    .and_then(parse_fraction)
                    .or_else(|| {
                        s.get("r_frame_rate")
                            .and_then(Value::as_str)
                            .and_then(parse_fraction)
                    });
                info.video = Some(VideoInfo {
                    codec,
                    width: s.get("width").and_then(num_str::<u32>),
                    height: s.get("height").and_then(num_str::<u32>),
                    frame_rate: fps,
                    pixel_format: s.get("pix_fmt").and_then(Value::as_str).map(String::from),
                });
            }
            Some("audio") if info.audio.is_none() => {
                info.audio = Some(AudioInfo {
                    codec,
                    sample_rate: s.get("sample_rate").and_then(num_str::<u32>),
                    channels: s.get("channels").and_then(num_str::<u32>),
                });
            }
            _ => {}
        }
    }
    Ok(info)
}

pub fn probe(root: &Path, rel: &str) -> AppResult<MediaInfo> {
    let (_, abs, _) = resolve_media(root, rel)?;
    let tool = find_tool("ffprobe").ok_or_else(|| {
        AppError::Invalid(missing_tool_message("ffprobe"))
    })?;
    let mut cmd = crate::platform::command(tool);
    cmd.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ])
    .arg(&abs);
    let out = run_capture(cmd, PROBE_TIMEOUT, MAX_PROBE_OUTPUT)?;
    parse_probe(&out)
}

// --------------------------------------------------------------- thumbnails

fn thumb_cache_path(cache_dir: &Path, abs: &Path, size: u64, modified: u64) -> PathBuf {
    let mut h = DefaultHasher::new();
    abs.hash(&mut h);
    size.hash(&mut h);
    modified.hash(&mut h);
    cache_dir.join(format!("{:016x}.jpg", h.finish()))
}

fn data_url(path: &Path) -> AppResult<String> {
    let bytes = fs::read(path).map_err(|e| AppError::io(path, e))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn run_ffmpeg_thumb(ffmpeg: &Path, abs: &Path, out: &Path, seek: bool) -> bool {
    let mut cmd = crate::platform::command(ffmpeg);
    cmd.args(["-nostdin", "-v", "error", "-y"]);
    if seek {
        cmd.args(["-ss", "1"]);
    }
    cmd.arg("-i")
        .arg(abs)
        .args([
            "-frames:v",
            "1",
            "-an",
            "-vf",
            "scale=320:-2",
            "-q:v",
            "4",
            "-f",
            "mjpeg",
        ])
        .arg(out);
    let ok = run_capture(cmd, THUMB_TIMEOUT, 1024).is_ok();
    ok && fs::metadata(out).is_ok_and(|m| m.len() > 0)
}

/// A 320px-wide JPEG data URL, or `None` for audio (no picture to show).
pub fn thumbnail(root: &Path, cache_dir: &Path, rel: &str) -> AppResult<Option<String>> {
    let (_, abs, kind) = resolve_media(root, rel)?;
    if kind == MediaKind::Audio {
        return Ok(None);
    }
    let meta = fs::metadata(&abs).map_err(|e| AppError::io(&abs, e))?;
    let cached = thumb_cache_path(cache_dir, &abs, meta.len(), millis(meta.modified()));
    if cached.is_file() {
        return data_url(&cached).map(Some);
    }
    let ffmpeg = find_tool("ffmpeg").ok_or_else(|| {
        AppError::Invalid(missing_tool_message("ffmpeg"))
    })?;
    fs::create_dir_all(cache_dir).map_err(|e| AppError::io(cache_dir, e))?;
    let tmp = cached.with_extension(format!("{}.part", std::process::id()));
    let _ = fs::remove_file(&tmp);
    // Seek one second in to skip black first frames; very short clips and
    // still images fall back to the first frame.
    let made = (kind == MediaKind::Video && run_ffmpeg_thumb(&ffmpeg, &abs, &tmp, true))
        || run_ffmpeg_thumb(&ffmpeg, &abs, &tmp, false);
    if !made {
        let _ = fs::remove_file(&tmp);
        return invalid("A thumbnail could not be made for this file.");
    }
    fs::rename(&tmp, &cached).map_err(|e| AppError::io(&cached, e))?;
    data_url(&cached).map(Some)
}

/// Canonical absolute path for in-app playback (the caller grants the webview
/// read access to exactly this file).
pub fn playback_path(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let (_, abs, kind) = resolve_media(root, rel)?;
    if kind == MediaKind::Image {
        return invalid("That’s an image. Nothing to play, but you can admire it.");
    }
    crate::platform::canonicalize(&abs).map_err(|e| AppError::io(&abs, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as C;

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for f in FOLDERS {
            fs::create_dir_all(dir.path().join(f)).unwrap();
        }
        fs::create_dir_all(dir.path().join(".murre")).unwrap();
        fs::write(
            dir.path().join(RENDERS_JSON),
            r#"{"schemaVersion":1,"renders":[]}"#,
        )
        .unwrap();
        dir
    }

    fn touch(dir: &Path, rel: &str, bytes: &[u8]) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    #[test]
    fn lists_only_media_in_render_folders() {
        let d = project();
        touch(d.path(), "06 Renders/a.mov", b"x");
        touch(d.path(), "06 Renders/sub/b.png", b"xx");
        touch(d.path(), "06 Renders/notes.txt", b"x");
        touch(d.path(), "06 Renders/.hidden.mov", b"x");
        touch(d.path(), "05 Pre-Renders/c.wav", b"x");
        touch(d.path(), "07 Deliverables/d.mp4", b"x");
        touch(d.path(), "01 Assets/e.mov", b"x");
        let l = list(d.path()).unwrap();
        let mut paths: Vec<_> = l.entries.iter().map(|e| e.path.as_str()).collect();
        paths.sort();
        assert_eq!(
            paths,
            [
                "05 Pre-Renders/c.wav",
                "06 Renders/a.mov",
                "06 Renders/sub/b.png",
                "07 Deliverables/d.mp4"
            ]
        );
        assert!(!l.truncated);
    }

    #[test]
    fn missing_folders_are_empty_and_not_created() {
        let dir = tempfile::tempdir().unwrap();
        let l = list(dir.path()).unwrap();
        assert!(l.entries.is_empty());
        assert!(!dir.path().join("06 Renders").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed() {
        let d = project();
        let outside = tempfile::tempdir().unwrap();
        touch(outside.path(), "secret.mov", b"x");
        std::os::unix::fs::symlink(
            outside.path().join("secret.mov"),
            d.path().join("06 Renders/link.mov"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join("06 Renders/dir")).unwrap();
        assert!(list(d.path()).unwrap().entries.is_empty());
        assert!(set_approved(d.path(), "06 Renders/link.mov", true).is_err());
    }

    #[test]
    fn approve_then_change_then_reapprove() {
        let d = project();
        touch(d.path(), "06 Renders/a.mov", b"one");
        let l = set_approved(d.path(), "06 Renders/a.mov", true).unwrap();
        assert_eq!(
            l.entries[0].approval.as_ref().unwrap().state,
            ApprovalState::Current
        );

        // The file changes underneath the approval.
        touch(d.path(), "06 Renders/a.mov", b"different length");
        let l = list(d.path()).unwrap();
        let a = l.entries[0].approval.as_ref().unwrap();
        assert_eq!(a.state, ApprovalState::Changed);
        // Listing alone must not have rewritten the record.
        let raw: RendersFile = safe_fs::read_json(&d.path().join(RENDERS_JSON)).unwrap().0;
        assert_eq!(raw.approvals["06 Renders/a.mov"].size_bytes, 3);

        let l = set_approved(d.path(), "06 Renders/a.mov", true).unwrap();
        assert_eq!(
            l.entries[0].approval.as_ref().unwrap().state,
            ApprovalState::Current
        );
        let l = set_approved(d.path(), "06 Renders/a.mov", false).unwrap();
        assert!(l.entries[0].approval.is_none());
    }

    #[test]
    fn approvals_survive_unknown_keys_and_missing_files() {
        let d = project();
        touch(d.path(), "06 Renders/a.mov", b"one");
        set_approved(d.path(), "06 Renders/a.mov", true).unwrap();
        let raw = fs::read_to_string(d.path().join(RENDERS_JSON)).unwrap();
        assert!(raw.contains("\"renders\""));
        fs::remove_file(d.path().join("06 Renders/a.mov")).unwrap();
        let l = list(d.path()).unwrap();
        assert!(l.entries.is_empty());
        assert_eq!(l.missing_approved, ["06 Renders/a.mov"]);
        // The record is still there, and can be cleared without the file.
        set_approved(d.path(), "06 Renders/a.mov", false).unwrap();
        assert!(list(d.path()).unwrap().missing_approved.is_empty());
    }

    #[test]
    fn rejects_paths_outside_render_folders() {
        let d = project();
        touch(d.path(), "01 Assets/x.mov", b"x");
        touch(d.path(), "06 Renders/a.mov", b"x");
        for bad in [
            "01 Assets/x.mov",
            "../x.mov",
            "/etc/passwd",
            "06 Renders/../01 Assets/x.mov",
            "06 Renders",
            "06 Renders/missing.mov",
            ".murre/renders.json",
        ] {
            assert!(set_approved(d.path(), bad, true).is_err(), "{bad}");
            assert!(probe(d.path(), bad).is_err(), "{bad}");
        }
        touch(d.path(), "06 Renders/readme.txt", b"x");
        assert!(set_approved(d.path(), "06 Renders/readme.txt", true).is_err());
    }

    #[test]
    fn corrupt_records_are_not_overwritten() {
        let d = project();
        touch(d.path(), "06 Renders/a.mov", b"x");
        fs::write(d.path().join(RENDERS_JSON), b"{not json").unwrap();
        assert!(set_approved(d.path(), "06 Renders/a.mov", true).is_err());
        assert_eq!(fs::read(d.path().join(RENDERS_JSON)).unwrap(), b"{not json");
    }

    #[cfg(unix)]
    #[test]
    fn a_stand_in_that_exits_with_an_error_does_not_count_as_a_tool() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let make = |name: &str, code: i32| {
            let p = d.path().join(name);
            fs::write(&p, format!("#!/bin/sh\nexit {code}\n")).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
            p
        };
        assert!(runs(&make("good", 0)));
        assert!(!runs(&make("stand-in", 1)));
        assert!(!runs(&d.path().join("missing")));
    }

    #[test]
    fn parses_ffprobe_output() {
        let json = br#"{"streams":[
          {"codec_type":"video","codec_name":"prores","width":1920,"height":1080,
           "avg_frame_rate":"30000/1001","pix_fmt":"yuv422p10le","disposition":{"attached_pic":0}},
          {"codec_type":"audio","codec_name":"pcm_s16le","sample_rate":"48000","channels":2}],
          "format":{"format_name":"mov,mp4","duration":"12.512000","bit_rate":"147000000"}}"#;
        let i = parse_probe(json).unwrap();
        assert_eq!(i.duration_secs, Some(12.512));
        assert_eq!(i.bit_rate, Some(147_000_000));
        let v = i.video.unwrap();
        assert_eq!((v.width, v.height), (Some(1920), Some(1080)));
        assert!((v.frame_rate.unwrap() - 29.97).abs() < 0.01);
        assert_eq!(i.audio.unwrap().sample_rate, Some(48000));
        assert!(parse_probe(b"nope").is_err());
        // "0/0" frame rates (stills) do not become NaN/inf.
        let still = parse_probe(
            br#"{"streams":[{"codec_type":"video","width":4,"height":4,"avg_frame_rate":"0/0","r_frame_rate":"25/1"}],"format":{}}"#,
        )
        .unwrap();
        assert_eq!(still.video.unwrap().frame_rate, Some(25.0));
    }

    #[test]
    fn timeout_kills_the_process() {
        let mut c = C::new("sleep");
        c.arg("5");
        let t = Instant::now();
        assert!(run_capture(c, Duration::from_millis(200), 100).is_err());
        assert!(t.elapsed() < Duration::from_secs(3));
    }

    fn have_ffmpeg() -> bool {
        // Found and actually starts (a stand-in or a broken copy on PATH counts as not installed).
        ["ffmpeg", "ffprobe"].iter().all(|t| find_tool(t).is_some_and(|p| runs(&p)))
    }

    fn make_clip(path: &Path, secs: &str) {
        let ok = C::new(find_tool("ffmpeg").unwrap())
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=640x360:rate=24",
            ])
            .args(["-t", secs, "-pix_fmt", "yuv420p"])
            .arg(path)
            .status()
            .unwrap()
            .success();
        assert!(ok);
    }

    #[test]
    fn probe_and_thumbnail_with_real_ffmpeg() {
        if !have_ffmpeg() {
            eprintln!("ffmpeg not installed; skipping");
            return;
        }
        let d = project();
        let cache = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("06 Renders")).unwrap();
        make_clip(&d.path().join("06 Renders/long.mp4"), "3");
        make_clip(&d.path().join("06 Renders/short.mp4"), "0.3");
        let info = probe(d.path(), "06 Renders/long.mp4").unwrap();
        assert_eq!(info.video.as_ref().unwrap().width, Some(640));
        assert!((info.duration_secs.unwrap() - 3.0).abs() < 0.2);
        for f in ["long", "short"] {
            let url = thumbnail(d.path(), cache.path(), &format!("06 Renders/{f}.mp4"))
                .unwrap()
                .unwrap();
            assert!(url.starts_with("data:image/jpeg;base64,"), "{f}");
        }
        // Second call is served from the cache.
        assert_eq!(fs::read_dir(cache.path()).unwrap().count(), 2);
        assert!(thumbnail(d.path(), cache.path(), "06 Renders/long.mp4").is_ok());
        assert_eq!(fs::read_dir(cache.path()).unwrap().count(), 2);
        // Originals untouched; nothing written into the project folders.
        assert_eq!(
            fs::read_dir(d.path().join("06 Renders")).unwrap().count(),
            2
        );
    }

    #[test]
    fn broken_media_gives_an_error_not_a_crash() {
        if !have_ffmpeg() {
            return;
        }
        let d = project();
        let cache = tempfile::tempdir().unwrap();
        touch(d.path(), "06 Renders/bad.mov", b"not a movie");
        assert!(probe(d.path(), "06 Renders/bad.mov").is_err());
        assert!(thumbnail(d.path(), cache.path(), "06 Renders/bad.mov").is_err());
        assert_eq!(fs::read_dir(cache.path()).unwrap().count(), 0);
    }

    #[test]
    fn playback_refuses_images_and_audio_is_allowed() {
        let d = project();
        touch(d.path(), "06 Renders/a.png", b"x");
        touch(d.path(), "06 Renders/a.wav", b"x");
        assert!(playback_path(d.path(), "06 Renders/a.png").is_err());
        assert!(playback_path(d.path(), "06 Renders/a.wav").is_ok());
    }
}
