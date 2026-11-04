//! Finding Adobe's `aerender` and planning a render safely.
//!
//! Only options that Adobe documents for `aerender` are used (https://helpx.adobe.com/en/after-effects/using/automated-rendering-network-rendering.html):
//! `-project`, `-comp`, `-output`, `-RStemplate`, `-OMtemplate`, `-v ERRORS_AND_PROGRESS`,
//! `-close DO_NOT_SAVE_CHANGES` and `-version`. Commands are built as an argument list and run
//! without a shell (see `render_job.rs`).
//!
//! Rules this module keeps:
//! - The render never overwrites an existing file, and never writes into `.murre/`.
//! - The AEP is opened with `-close DO_NOT_SAVE_CHANGES`, so aerender cannot save over it.
//! - Only a Main Comp that is listed exactly once (by name) in the last scan can be rendered,
//!   because aerender selects a composition by name.

use crate::comps::{self, CompEntry};
use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, UNIX_EPOCH};

const SETTING_KEY: &str = "aerender_path";
const VERSION_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_FILE_NAME_BYTES: usize = 150;
const MAX_TEMPLATE_CHARS: usize = 100;

fn invalid<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Invalid(msg.into()))
}

// ---------------------------------------------------------------- finding aerender

/// An `aerender` executable found in a standard After Effects install folder.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    pub path: String,
    /// The install folder's name, e.g. "Adobe After Effects 2025".
    pub label: String,
    /// The app's own version (from its `Info.plist` on macOS), e.g. "27.1". Beta builds have no
    /// year in their folder name, so the version is what tells them apart.
    pub version: Option<String>,
}

/// `CFBundleShortVersionString` (or `CFBundleVersion`) from an `Info.plist` in XML form.
pub fn version_from_plist(xml: &str) -> Option<String> {
    for key in ["CFBundleShortVersionString", "CFBundleVersion"] {
        let tag = format!("<key>{key}</key>");
        if let Some(at) = xml.find(&tag) {
            let rest = &xml[at + tag.len()..];
            if let (Some(a), Some(b)) = (rest.find("<string>"), rest.find("</string>")) {
                if a < b {
                    let v = rest[a + 8..b].trim();
                    if !v.is_empty() {
                        return Some(v.to_string());
                    }
                }
            }
        }
    }
    None
}

/// The version of the After Effects app inside an install folder (macOS: `*.app/Contents/Info.plist`).
pub fn app_version(folder: &Path) -> Option<String> {
    for e in fs::read_dir(folder).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.ends_with(".app") && name.contains("After Effects") && !name.contains("Render Engine") {
            if let Ok(xml) = fs::read_to_string(e.path().join("Contents/Info.plist")) {
                if let Some(v) = version_from_plist(&xml) {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// Numeric parts of a version or a year in a folder name, for ordering.
fn sort_key(i: &Install) -> Vec<u64> {
    let from = |t: &str| -> Vec<u64> { t.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).filter_map(|p| p.parse().ok()).collect() };
    match &i.version {
        Some(v) => from(v),
        None => from(&i.label),
    }
}

/// Look for `aerender` in `Adobe After Effects*` folders directly inside `base`.
/// Newest version first.
pub fn detect_in(base: &Path) -> Vec<Install> {
    let Ok(entries) = fs::read_dir(base) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let label = entry.file_name().to_string_lossy().into_owned();
        if !label.starts_with("Adobe After Effects") || !entry.path().is_dir() {
            continue;
        }
        for rel in ["aerender", "aerender.exe", "Support Files/aerender.exe", "Support Files/aerender"] {
            let candidate = entry.path().join(rel);
            if candidate.is_file() {
                found.push(Install {
                    path: candidate.to_string_lossy().into_owned(),
                    label: label.clone(),
                    version: app_version(&entry.path()),
                });
                break;
            }
        }
    }
    // Newest first. A newer After Effects opens older projects, but never the other way round.
    found.sort_by(|a, b| sort_key(b).cmp(&sort_key(a)).then_with(|| b.label.cmp(&a.label)));
    found
}

/// Standard install locations: `/Applications` on macOS, `Program Files\Adobe` on Windows.
pub fn detect() -> Vec<Install> {
    let mut all = detect_in(Path::new("/Applications"));
    all.extend(detect_in(Path::new(r"C:\Program Files\Adobe")));
    all
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        true
    }
}

/// Check that `path` is a real `aerender` by running `aerender -version` (which Adobe documents as
/// "does not render") and return the first line it prints. Never runs anything else.
pub fn validate(path: &Path) -> AppResult<String> {
    if !path.is_absolute() {
        return invalid("Choose the aerender file with its full path.");
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if name != "aerender" && name != "aerender.exe" {
        return invalid("That file is not named aerender. Choose the aerender file inside your After Effects folder.");
    }
    if !path.is_file() {
        return invalid(format!("{} does not exist.", path.display()));
    }
    if !is_executable(path) {
        return invalid(format!("{} is not executable.", path.display()));
    }
    let mut child = Command::new(path)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::io(path, e))?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| AppError::io(path, e))? {
            Some(s) => break s,
            None if start.elapsed() > VERSION_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return invalid("aerender did not answer in time. Check that After Effects is installed and licensed.");
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    // Some builds (beta ones included) print the version on stderr, or exit with a non-zero code
    // after printing it, so both streams are read and the exit code alone is not decisive.
    let mut out = String::new();
    if let Some(mut s) = child.stdout.take() {
        let _ = s.by_ref().take(64 * 1024).read_to_string(&mut out);
    }
    let mut err = String::new();
    if let Some(mut s) = child.stderr.take() {
        let _ = s.by_ref().take(64 * 1024).read_to_string(&mut err);
    }
    let lines = |t: &str| -> Vec<String> { t.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect() };
    let all: Vec<String> = lines(&out).into_iter().chain(lines(&err)).collect();
    let first = all
        .iter()
        .find(|l| l.to_ascii_lowercase().contains("version"))
        .or_else(|| if status.success() { all.first() } else { None });
    let Some(first) = first else {
        let seen = all.first().map(|l| format!(" It printed: “{}”.", l.chars().take(120).collect::<String>())).unwrap_or_default();
        let code = status.code().map(|c| format!(" (exit code {c})")).unwrap_or_default();
        return invalid(format!("aerender did not report a version{code}, so it does not look usable.{seen}"));
    };
    Ok(first.chars().take(200).collect())
}

pub fn saved_path(conn: &Connection) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [SETTING_KEY], |r| r.get(0))
        .optional()?)
}

/// Validate, then remember (or forget) the aerender the user chose. The app itself validates first
/// and then calls [`store`], so this is the one-step form used by the tests.
#[cfg(test)]
pub fn save_path(conn: &Connection, path: Option<&str>) -> AppResult<()> {
    if let Some(p) = path {
        validate(Path::new(p))?;
    }
    store(conn, path)
}

/// Write the choice without checking it (the caller has already run [`validate`], so the
/// database is not held while aerender runs).
pub fn store(conn: &Connection, path: Option<&str>) -> AppResult<()> {
    match path {
        None => {
            conn.execute("DELETE FROM settings WHERE key = ?1", [SETTING_KEY])?;
        }
        Some(p) => {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [SETTING_KEY, p],
            )?;
        }
    }
    Ok(())
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Active {
    pub path: String,
    pub version: String,
    /// `true` when the person chose it, `false` when it was found automatically.
    pub chosen: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub saved: Option<String>,
    pub detected: Vec<Install>,
    pub active: Option<Active>,
    /// Why nothing usable was found (e.g. the chosen file is gone).
    pub problem: Option<String>,
}

/// Work out which aerender will be used: the saved choice if there is one, otherwise the newest
/// that was found. The choice is checked by running `-version`.
pub fn status(saved: Option<String>, detected: Vec<Install>) -> Status {
    let mut s = Status { saved: saved.clone(), detected: detected.clone(), ..Default::default() };
    if let Some(p) = saved {
        match validate(Path::new(&p)) {
            Ok(version) => s.active = Some(Active { path: p, version, chosen: true }),
            Err(e) => s.problem = Some(format!("The aerender you chose cannot be used: {e}")),
        }
        return s;
    }
    let mut last_err = None;
    for install in detected {
        match validate(Path::new(&install.path)) {
            Ok(version) => {
                s.active = Some(Active { path: install.path, version, chosen: false });
                return s;
            }
            Err(e) => last_err = Some(format!("{}: {e}", install.label)),
        }
    }
    s.problem = Some(last_err.unwrap_or_else(|| {
        "aerender was not found. Install After Effects, or choose the aerender file in Settings.".into()
    }));
    s
}

/// The aerender to run now, or an explanation. A per-render choice from the dialog wins. The choice must be an
/// aerender that was found or saved, so a request cannot make the app run an arbitrary program.
pub fn resolve_with(wanted: Option<&str>, saved: Option<String>, detected: Vec<Install>) -> AppResult<Active> {
    if let Some(w) = wanted {
        let known = detected.iter().any(|i| i.path == w) || saved.as_deref() == Some(w);
        if !known {
            return invalid("That After Effects is not one of the installed versions. Pick one from the list.");
        }
        let version = validate(Path::new(w))?;
        return Ok(Active { path: w.to_string(), version, chosen: true });
    }
    let s = status(saved, detected);
    match (s.active, s.problem) {
        (Some(a), _) => Ok(a),
        (None, Some(p)) => invalid(p),
        (None, None) => invalid("aerender was not found."),
    }
}

// ---------------------------------------------------------------- planning a render

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub project_id: String,
    /// After Effects' item id of the composition, from the last scan.
    pub comp_id: i64,
    /// Absolute path of an existing folder.
    pub output_dir: String,
    /// File name with an extension, e.g. `Main_v01.mov`.
    pub file_name: String,
    /// Optional names of templates that exist in After Effects.
    pub rs_template: Option<String>,
    pub om_template: Option<String>,
    /// Which aerender to use instead of the automatic choice. Must be one that was detected (or the
    /// one saved in Settings).
    #[serde(default)]
    pub aerender_path: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub aep: PathBuf,
    pub comp_id: i64,
    pub comp_name: String,
    pub output: PathBuf,
    /// Arguments for aerender, in order (no shell is involved).
    pub args: Vec<String>,
    /// Things to know that do not stop the render.
    pub warnings: Vec<String>,
    /// Frames in the comp, used for an estimated progress bar.
    pub total_frames: u64,
}

/// A file name that is safe to create and makes sense for a single rendered movie or image.
pub fn validate_file_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return invalid("Enter a file name for the render.");
    }
    if name.len() > MAX_FILE_NAME_BYTES {
        return invalid("That file name is too long.");
    }
    if name.starts_with('.') || name.ends_with('.') || name.contains("..") {
        return invalid("The file name cannot start or end with a dot.");
    }
    if let Some(c) = name
        .chars()
        .find(|c| c.is_control() || "/\\:*?\"<>|[]#%".contains(*c))
    {
        let shown = if c.is_control() { "a control character".to_string() } else { format!("“{c}”") };
        return invalid(format!(
            "The file name cannot contain {shown}. (Frame-number sequences such as [####] are not supported yet.)"
        ));
    }
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    if ext.is_empty() || ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return invalid("Add a file extension that matches the After Effects output format, for example .mov.");
    }
    Ok(name.to_string())
}

fn validate_template(raw: &Option<String>, what: &str) -> AppResult<Option<String>> {
    let Some(t) = raw.as_deref().map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if t.chars().count() > MAX_TEMPLATE_CHARS || t.chars().any(char::is_control) {
        return invalid(format!("The {what} template name is not valid."));
    }
    Ok(Some(t.to_string()))
}

/// Parse `YYYY-MM-DDTHH:MM:SS[.fff]Z` to epoch seconds. `None` for anything else.
fn parse_iso_utc(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Days from civil (Howard Hinnant).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

fn scan_time(v: &serde_json::Value) -> Option<i64> {
    match v {
        serde_json::Value::String(s) => parse_iso_utc(s),
        serde_json::Value::Number(n) => n.as_i64().map(|t| if t > 100_000_000_000 { t / 1000 } else { t }),
        _ => None,
    }
}

/// The AEP inside the project folder that the comp list belongs to.
fn aep_path(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || rel_path.components().any(|c| !matches!(c, Component::Normal(_))) {
        return invalid("The composition list points at a file outside the project folder. Scan the project again.");
    }
    let ext_ok = rel_path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("aep") || e.eq_ignore_ascii_case("aepx"))
        .unwrap_or(false);
    if !ext_ok {
        return invalid("The composition list does not point at an After Effects project file. Scan the project again.");
    }
    let full = root.join(rel_path);
    if !full.is_file() {
        return invalid(format!(
            "The After Effects project {rel} could not be found. If it was renamed or moved, scan the project again in After Effects."
        ));
    }
    Ok(full)
}

/// Check everything that can be checked before starting and produce the aerender arguments.
pub fn plan(root: &Path, req: &RenderRequest) -> AppResult<Plan> {
    let view = comps::get(root)?;
    let Some(aep_ref) = view.aep.as_ref().filter(|_| view.last_scan_at.is_some()) else {
        return invalid("This project has not been scanned yet. Scan it from the After Effects Companion first.");
    };
    let aep = aep_path(root, &aep_ref.path)?;

    let comp: &CompEntry = view
        .comps
        .iter()
        .find(|c| c.id == req.comp_id)
        .ok_or_else(|| AppError::Invalid("That composition is not in the last scan. Scan the project again in After Effects.".into()))?;
    if !comp.main {
        return invalid("Only Main Comps can be rendered. Mark it as a Main Comp in the Companion first.");
    }
    if view.comps.iter().filter(|c| c.name == comp.name).count() > 1 {
        return invalid(format!(
            "More than one composition is named “{}”, and aerender picks compositions by name. Rename one in After Effects and scan again.",
            comp.name
        ));
    }

    // Where the file goes.
    let dir = Path::new(&req.output_dir);
    if !dir.is_absolute() {
        return invalid("Choose the output folder with its full path.");
    }
    if !dir.is_dir() {
        return invalid(format!("The output folder {} does not exist.", dir.display()));
    }
    if dir.components().any(|c| c.as_os_str() == ".murre") {
        return invalid("Renders cannot be written inside a .murre folder.");
    }
    let file_name = validate_file_name(&req.file_name)?;
    let output = dir.join(&file_name);
    if output.symlink_metadata().is_ok() {
        return Err(AppError::AlreadyExists(output));
    }
    // After Effects takes the extension from the output module, so a file with the same name and
    // another extension would be overwritten by a render that "looks" new.
    if let (Some(stem), Ok(entries)) = (output.file_stem().map(|n| n.to_string_lossy().to_lowercase()), fs::read_dir(dir)) {
        for e in entries.flatten() {
            let p = e.path();
            if p.file_stem().map(|n| n.to_string_lossy().to_lowercase()) == Some(stem.clone()) {
                return invalid(format!(
                    "{} already exists, and After Effects may save this render under the same name with a different extension. Choose a different file name.",
                    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
                ));
            }
        }
    }
    if output == aep {
        return invalid("The output file cannot be the project file.");
    }

    let rs = validate_template(&req.rs_template, "render settings")?;
    let om = validate_template(&req.om_template, "output module")?;

    let mut warnings = Vec::new();
    let aep_modified = fs::metadata(&aep)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    if let (Some(modified), Some(scanned)) = (aep_modified, view.last_scan_at.as_ref().and_then(scan_time)) {
        if modified > scanned + 2 {
            warnings.push("The project file was saved after the last scan, so the composition list may be out of date.".into());
        }
    }

    let mut args: Vec<String> = vec![
        "-project".into(),
        aep.to_string_lossy().into_owned(),
        "-comp".into(),
        comp.name.clone(),
        "-output".into(),
        output.to_string_lossy().into_owned(),
    ];
    if let Some(t) = rs {
        args.push("-RStemplate".into());
        args.push(t);
    }
    if let Some(t) = om {
        args.push("-OMtemplate".into());
        args.push(t);
    }
    args.extend(["-v".into(), "ERRORS_AND_PROGRESS".into(), "-close".into(), "DO_NOT_SAVE_CHANGES".into()]);

    Ok(Plan {
        aep,
        comp_id: comp.id,
        comp_name: comp.name.clone(),
        output,
        args,
        warnings,
        total_frames: (comp.duration * comp.frame_rate).round().max(1.0) as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMPS: &str = r#"{"schemaVersion":1,"lastScanAt":"2099-01-01T00:00:00.000Z",
      "aep":{"projectId":"p","path":"01 AE/film_v01.aep","name":"film_v01.aep"},
      "comps":[
       {"id":1,"name":"Main","width":1920,"height":1080,"frameRate":25,"duration":10,"folder":"","main":true},
       {"id":2,"name":"Pre","width":1920,"height":1080,"frameRate":25,"duration":4,"folder":"","main":false},
       {"id":3,"name":"Dup","width":10,"height":10,"frameRate":24,"duration":1,"folder":"","main":true},
       {"id":4,"name":"Dup","width":10,"height":10,"frameRate":24,"duration":1,"folder":"x","main":true}]}"#;

    struct Fixture {
        dir: tempfile::TempDir,
        out: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            Self::with(COMPS)
        }
        fn with(comps: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            fs::create_dir_all(root.join(".murre")).unwrap();
            fs::create_dir_all(root.join("01 AE")).unwrap();
            fs::create_dir_all(root.join("06 Renders")).unwrap();
            fs::write(root.join("01 AE/film_v01.aep"), "AEP").unwrap();
            fs::write(root.join(".murre/comps.json"), comps).unwrap();
            let out = root.join("06 Renders");
            Fixture { dir, out }
        }
        fn req(&self) -> RenderRequest {
            RenderRequest {
                project_id: "p".into(),
                comp_id: 1,
                output_dir: self.out.to_string_lossy().into_owned(),
                file_name: "Main_v01.mov".into(),
                rs_template: None,
                om_template: None,
                aerender_path: None,
            }
        }
        fn root(&self) -> &Path {
            self.dir.path()
        }
    }

    fn err(f: &Fixture, req: &RenderRequest) -> String {
        plan(f.root(), req).unwrap_err().to_string()
    }

    #[test]
    fn a_good_request_gives_exactly_the_documented_arguments() {
        let f = Fixture::new();
        let p = plan(f.root(), &f.req()).unwrap();
        assert_eq!(p.comp_name, "Main");
        assert_eq!(p.total_frames, 250);
        assert_eq!(
            p.args,
            vec![
                "-project".to_string(),
                f.root().join("01 AE/film_v01.aep").to_string_lossy().into_owned(),
                "-comp".into(),
                "Main".into(),
                "-output".into(),
                f.out.join("Main_v01.mov").to_string_lossy().into_owned(),
                "-v".into(),
                "ERRORS_AND_PROGRESS".into(),
                "-close".into(),
                "DO_NOT_SAVE_CHANGES".into(),
            ]
        );
        assert!(p.warnings.is_empty());
    }

    #[test]
    fn templates_are_passed_only_when_given() {
        let f = Fixture::new();
        let mut r = f.req();
        r.rs_template = Some("  Best Settings ".into());
        r.om_template = Some("Lossless".into());
        let p = plan(f.root(), &r).unwrap();
        let i = p.args.iter().position(|a| a == "-RStemplate").unwrap();
        assert_eq!(p.args[i + 1], "Best Settings");
        let j = p.args.iter().position(|a| a == "-OMtemplate").unwrap();
        assert_eq!(p.args[j + 1], "Lossless");
        r.rs_template = Some("   ".into());
        r.om_template = None;
        let p = plan(f.root(), &r).unwrap();
        assert!(!p.args.iter().any(|a| a.ends_with("template")));
        r.rs_template = Some("bad\nname".into());
        assert!(err(&f, &r).contains("render settings"));
    }

    #[test]
    fn only_a_unique_main_comp_that_is_in_the_scan_can_be_rendered() {
        let f = Fixture::new();
        let mut r = f.req();
        r.comp_id = 2;
        assert!(err(&f, &r).contains("Only Main Comps"));
        r.comp_id = 99;
        assert!(err(&f, &r).contains("not in the last scan"));
        r.comp_id = 3;
        assert!(err(&f, &r).contains("More than one composition is named “Dup”"));
    }

    #[test]
    fn needs_a_scan_and_an_existing_aep_inside_the_project() {
        let d = tempfile::tempdir().unwrap();
        let f = Fixture { out: d.path().to_path_buf(), dir: d };
        assert!(err(&f, &f.req()).contains("not been scanned"));

        let f = Fixture::new();
        fs::remove_file(f.root().join("01 AE/film_v01.aep")).unwrap();
        assert!(err(&f, &f.req()).contains("could not be found"));

        for bad in ["../x.aep", "/etc/x.aep", "01 AE/../../x.aep", "01 AE/film.mov"] {
            let f = Fixture::with(&COMPS.replace("01 AE/film_v01.aep", bad));
            let e = err(&f, &f.req());
            assert!(e.contains("outside the project") || e.contains("does not point"), "{bad}: {e}");
        }
    }

    #[test]
    fn never_overwrites_and_never_writes_into_murre() {
        let f = Fixture::new();
        fs::write(f.out.join("Main_v01.mov"), "x").unwrap();
        let e = plan(f.root(), &f.req()).unwrap_err();
        assert!(matches!(e, AppError::AlreadyExists(_)), "{e}");
        assert_eq!(fs::read_to_string(f.out.join("Main_v01.mov")).unwrap(), "x");

        let f = Fixture::new();
        let mut r = f.req();
        r.output_dir = f.root().join(".murre").to_string_lossy().into_owned();
        assert!(err(&f, &r).contains(".murre"));
        r.output_dir = f.root().join("nope").to_string_lossy().into_owned();
        assert!(err(&f, &r).contains("does not exist"));
        r.output_dir = "relative/dir".into();
        assert!(err(&f, &r).contains("full path"));
    }

    #[test]
    fn a_file_with_the_same_name_and_another_extension_blocks_the_render() {
        let f = Fixture::new();
        fs::write(f.out.join("main_v01.MP4"), b"x").unwrap();
        let e = plan(f.root(), &f.req()).unwrap_err().to_string();
        assert!(e.contains("main_v01.MP4") && e.contains("different file name"), "{e}");
        fs::write(f.out.join("Other.mp4"), b"x").unwrap();
        fs::remove_file(f.out.join("main_v01.MP4")).unwrap();
        assert!(plan(f.root(), &f.req()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_counts_as_existing() {
        let f = Fixture::new();
        std::os::unix::fs::symlink("/nonexistent", f.out.join("Main_v01.mov")).unwrap();
        assert!(matches!(plan(f.root(), &f.req()).unwrap_err(), AppError::AlreadyExists(_)));
    }

    #[test]
    fn file_names() {
        for ok in ["Main.mov", "Main v01.mp4", "Ünï_1-2 (final).mxf", "a.png"] {
            assert!(validate_file_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", "  ", "Main", "Main.", ".mov", "a/b.mov", "a\\b.mov", "a:b.mov", "a*b.mov", "a[####].png", "a#.png", "a%b.mov", "a..b.mov", "a\n.mov", "x.toolong1", "x.m p4", &format!("{}.mov", "a".repeat(200))] {
            assert!(validate_file_name(bad).is_err(), "{bad:?}");
        }
        assert_eq!(validate_file_name("  Main.mov ").unwrap(), "Main.mov");
    }

    #[test]
    fn warns_when_the_aep_was_saved_after_the_scan() {
        let f = Fixture::with(&COMPS.replace("2099-01-01T00:00:00.000Z", "2001-01-01T00:00:00.000Z"));
        let p = plan(f.root(), &f.req()).unwrap();
        assert_eq!(p.warnings.len(), 1);
        assert!(p.warnings[0].contains("after the last scan"));
    }

    #[test]
    fn iso_parsing() {
        assert_eq!(parse_iso_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_utc("2026-10-26T12:00:00.000Z"), Some(1_793_016_000));
        assert_eq!(parse_iso_utc("2000-02-29T00:00:00Z"), Some(951_782_400));
        assert_eq!(parse_iso_utc("garbage"), None);
        assert_eq!(parse_iso_utc("2026-13-01T00:00:00Z"), None);
    }

    // ---- aerender discovery and validation (with a fake executable) ----

    #[cfg(unix)]
    fn fake(dir: &Path, rel: &str, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, script).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[cfg(unix)]
    #[test]
    fn finds_installs_newest_first_and_ignores_other_folders() {
        let d = tempfile::tempdir().unwrap();
        fake(d.path(), "Adobe After Effects 2024/aerender", "#!/bin/sh\n");
        fake(d.path(), "Adobe After Effects 2025/aerender", "#!/bin/sh\n");
        fs::create_dir_all(d.path().join("Adobe After Effects 2023")).unwrap(); // no aerender inside
        fake(d.path(), "Other App/aerender", "#!/bin/sh\n");
        let found = detect_in(d.path());
        assert_eq!(found.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(), ["Adobe After Effects 2025", "Adobe After Effects 2024"]);
        assert!(detect_in(&d.path().join("missing")).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn validate_runs_only_version_and_checks_the_file() {
        let d = tempfile::tempdir().unwrap();
        let marker = d.path().join("args.txt");
        let ok = fake(
            d.path(),
            "ae/aerender",
            &format!("#!/bin/sh\necho \"$@\" > '{}'\necho 'aerender version 25.0x1'\n", marker.display()),
        );
        assert_eq!(validate(&ok).unwrap(), "aerender version 25.0x1");
        assert_eq!(fs::read_to_string(&marker).unwrap().trim(), "-version");

        let silent = fake(d.path(), "silent/aerender", "#!/bin/sh\nexit 0\n");
        assert!(validate(&silent).unwrap_err().to_string().contains("did not report a version"));
        let failing = fake(d.path(), "failing/aerender", "#!/bin/sh\necho hi\nexit 3\n");
        assert!(validate(&failing).is_err());
        // Version on stderr, or a non-zero exit after printing it (seen with beta builds), is accepted.
        let on_stderr = fake(d.path(), "stderr/aerender", "#!/bin/sh\necho 'aerender version 26.0x5 (Beta)' >&2\nexit 1\n");
        assert_eq!(validate(&on_stderr).unwrap(), "aerender version 26.0x5 (Beta)");
        let msg = validate(&failing).unwrap_err().to_string();
        assert!(msg.contains("exit code 3") && msg.contains("printed: “hi”"), "{msg}");
        let wrong_name = fake(d.path(), "ae/notaerender", "#!/bin/sh\necho v\n");
        assert!(validate(&wrong_name).unwrap_err().to_string().contains("not named aerender"));
        assert!(validate(Path::new("aerender")).unwrap_err().to_string().contains("full path"));
        assert!(validate(&d.path().join("gone/aerender")).unwrap_err().to_string().contains("does not exist"));
        let not_exec = d.path().join("ne/aerender");
        fs::create_dir_all(not_exec.parent().unwrap()).unwrap();
        fs::write(&not_exec, "x").unwrap();
        assert!(validate(&not_exec).unwrap_err().to_string().contains("not executable"));
    }

    #[cfg(unix)]
    #[test]
    fn status_prefers_the_saved_choice_and_explains_failures() {
        let d = tempfile::tempdir().unwrap();
        let a = fake(d.path(), "Adobe After Effects 2025/aerender", "#!/bin/sh\necho v25\n");
        let b = fake(d.path(), "mine/aerender", "#!/bin/sh\necho vmine\n");
        let found = detect_in(d.path());
        let s = status(None, found.clone());
        assert_eq!(s.active.as_ref().unwrap().version, "v25");
        assert!(!s.active.as_ref().unwrap().chosen);
        assert_eq!(s.active.unwrap().path, a.to_string_lossy());

        let s = status(Some(b.to_string_lossy().into_owned()), found.clone());
        assert!(s.active.as_ref().unwrap().chosen);
        assert_eq!(s.active.unwrap().version, "vmine");

        let s = status(Some("/gone/aerender".into()), found);
        assert!(s.active.is_none());
        assert!(s.problem.unwrap().contains("you chose cannot be used"));

        let s = status(None, vec![]);
        assert!(s.problem.unwrap().contains("not found"));
        assert!(resolve_with(None, None, vec![]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_choice_is_saved_validated_and_can_be_cleared() {
        let d = tempfile::tempdir().unwrap();
        let ok = fake(d.path(), "ae/aerender", "#!/bin/sh\necho v1\n");
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;").unwrap();
        assert_eq!(saved_path(&conn).unwrap(), None);
        save_path(&conn, Some(ok.to_str().unwrap())).unwrap();
        save_path(&conn, Some(ok.to_str().unwrap())).unwrap(); // idempotent
        assert_eq!(saved_path(&conn).unwrap().as_deref(), ok.to_str());
        assert!(save_path(&conn, Some("/etc/passwd")).is_err());
        assert_eq!(saved_path(&conn).unwrap().as_deref(), ok.to_str(), "a rejected path changes nothing");
        save_path(&conn, None).unwrap();
        assert_eq!(saved_path(&conn).unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn newest_version_comes_first_and_a_beta_beats_an_older_year() {
        let d = tempfile::tempdir().unwrap();
        let plist = |v: &str| format!("<plist><dict><key>CFBundleShortVersionString</key>\n<string>{v}</string></dict></plist>");
        for (folder, app, v) in [
            ("Adobe After Effects 2026", "Adobe After Effects 2026.app", "26.5.0"),
            ("Adobe After Effects (Beta)", "Adobe After Effects (Beta).app", "27.1.0"),
            ("Adobe After Effects 2025", "Adobe After Effects 2025.app", "25.6.1"),
        ] {
            fake(d.path(), &format!("{folder}/aerender"), "#!/bin/sh\necho v\n");
            let c = d.path().join(folder).join(app).join("Contents");
            fs::create_dir_all(&c).unwrap();
            fs::write(c.join("Info.plist"), plist(v)).unwrap();
        }
        let found = detect_in(d.path());
        let labels: Vec<_> = found.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(labels, ["Adobe After Effects (Beta)", "Adobe After Effects 2026", "Adobe After Effects 2025"]);
        assert_eq!(found[0].version.as_deref(), Some("27.1.0"));
        assert_eq!(version_from_plist("<key>CFBundleVersion</key><string> 9.1 </string>").as_deref(), Some("9.1"));
        assert_eq!(version_from_plist("nothing"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_per_render_choice_must_be_a_known_install() {
        let d = tempfile::tempdir().unwrap();
        let a = fake(d.path(), "A/aerender", "#!/bin/sh\necho 'aerender version 25'\n");
        let other = fake(d.path(), "B/aerender", "#!/bin/sh\necho 'aerender version 26'\n");
        let installs = vec![Install { path: a.to_string_lossy().into(), label: "A".into(), version: None }];
        let got = resolve_with(Some(a.to_str().unwrap()), None, installs.clone()).unwrap();
        assert_eq!((got.version.as_str(), got.chosen), ("aerender version 25", true));
        assert!(resolve_with(Some(other.to_str().unwrap()), None, installs).is_err());
    }
}
