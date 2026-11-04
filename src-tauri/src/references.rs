//! Reference board: the canvas (a list of positioned items) and its imported media.
//!
//! - The canvas document is stored in `.murre/references/references.json`
//!   with a revision number, exactly like notes: a save must name the revision
//!   it was based on and is rejected with `Conflict` if the file moved on.
//! - Imported files are copied into `.murre/references/media/` under a new
//!   random name (never overwriting anything). The content type is decided by
//!   sniffing the bytes, not by trusting the file name.
//! - Nothing in `media/` is ever deleted by the app, even when the shape that
//!   used it is removed from the canvas.

use crate::error::{AppError, AppResult};
use crate::project::{invalid, now};
use crate::safe_fs;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const REFERENCES_JSON: &str = ".murre/references/references.json";
const MEDIA_DIR: &str = ".murre/references/media";
const SCHEMA_VERSION: u32 = 1;
/// Copy of a board saved in the old tldraw format, written the first time the new format replaces it.
const LEGACY_BACKUP: &str = ".murre/references/references.tldraw-backup.json";
/// Written into saved boards, so it keeps its original value (it is not shown anywhere). Do not rename it.
pub const BOARD_FORMAT: &str = "sequenxe-board";
const MAX_CANVAS_BYTES: usize = 20_000_000;
pub const MAX_MEDIA_BYTES: usize = 40_000_000;

static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ReferencesFile {
    schema_version: u32,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    updated_at: Option<u64>,
    /// The board: `{ format: "sequenxe-board", version, items: [...], view }`. Boards saved by earlier versions
    /// (a tldraw snapshot with `store` and `schema`) can still be read; see `save` for how they are kept.
    #[serde(default)]
    canvas: Option<Value>,
    /// Unknown keys (including the scaffold's empty `items`) are preserved.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReferencesView {
    pub revision: u64,
    pub updated_at: Option<u64>,
    pub canvas: Option<Value>,
}

impl From<&ReferencesFile> for ReferencesView {
    fn from(f: &ReferencesFile) -> Self {
        Self {
            revision: f.revision,
            updated_at: f.updated_at,
            canvas: f.canvas.clone(),
        }
    }
}

fn load(root: &Path) -> AppResult<ReferencesFile> {
    let path = root.join(REFERENCES_JSON);
    if !path.exists() && !safe_fs::backup_path(&path).exists() {
        return Ok(ReferencesFile {
            schema_version: SCHEMA_VERSION,
            revision: 0,
            updated_at: None,
            canvas: None,
            extra: Map::new(),
        });
    }
    let (file, _): (ReferencesFile, _) = safe_fs::read_json(&path)?;
    if file.schema_version > SCHEMA_VERSION {
        return invalid("This reference board was saved by a newer version of Murre.");
    }
    Ok(file)
}

pub fn get(root: &Path) -> AppResult<ReferencesView> {
    Ok(ReferencesView::from(&load(root)?))
}

fn is_legacy_canvas(canvas: &Value) -> bool {
    canvas.as_object().is_some_and(|o| {
        o.get("store").is_some_and(Value::is_object) && o.get("schema").is_some_and(Value::is_object)
    })
}

fn validate_canvas(canvas: &Value) -> AppResult<()> {
    let bad = || AppError::Invalid("The reference board has an unexpected format.".into());
    let obj = canvas.as_object().ok_or_else(bad)?;
    let is_board = obj.get("format").and_then(Value::as_str) == Some(BOARD_FORMAT)
        && obj.get("items").is_some_and(Value::is_array);
    if !is_board && !is_legacy_canvas(canvas) {
        return Err(bad());
    }
    let size = serde_json::to_vec(canvas)
        .map(|b| b.len())
        .unwrap_or(usize::MAX);
    if size > MAX_CANVAS_BYTES {
        return invalid("This reference board is too large to save (over 20 MB of canvas data).");
    }
    Ok(())
}

pub fn save(root: &Path, canvas: Value, expected_revision: u64) -> AppResult<ReferencesView> {
    validate_canvas(&canvas)?;
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load(root)?;
    if file.revision != expected_revision {
        return Err(AppError::Conflict(
            "This reference board was changed somewhere else since you opened it.".into(),
        ));
    }
    // The first save in the new format keeps a copy of the old tldraw board, so converting never loses it.
    if let Some(old) = file.canvas.as_ref().filter(|c| is_legacy_canvas(c)) {
        let backup = root.join(LEGACY_BACKUP);
        if !is_legacy_canvas(&canvas) && !backup.exists() {
            let bytes = serde_json::to_vec(old)
                .map_err(|e| AppError::Invalid(format!("Could not back up the old board: {e}")))?;
            safe_fs::atomic_write(&backup, &bytes)?;
        }
    }
    file.schema_version = SCHEMA_VERSION;
    file.revision += 1;
    file.updated_at = Some(now());
    file.canvas = Some(canvas);
    safe_fs::write_json(&root.join(REFERENCES_JSON), &file)?;
    Ok(ReferencesView::from(&file))
}

// ------------------------------------------------------------------- media

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaType {
    Image,
    Video,
    Pdf,
}

/// Decide the type and canonical extension from the file's leading bytes.
fn sniff(b: &[u8]) -> Option<(MediaType, &'static str)> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some((MediaType::Image, "png"))
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some((MediaType::Image, "jpg"))
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some((MediaType::Image, "gif"))
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some((MediaType::Image, "webp"))
    } else if b.len() >= 12 && &b[4..8] == b"ftyp" {
        // QuickTime brand is "qt  "; everything else in this family plays as mp4.
        let ext = if &b[8..12] == b"qt  " { "mov" } else { "mp4" };
        Some((MediaType::Video, ext))
    } else if b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some((MediaType::Video, "webm"))
    } else if b.starts_with(b"%PDF-") {
        Some((MediaType::Pdf, "pdf"))
    } else if looks_like_svg(b) {
        Some((MediaType::Image, "svg"))
    } else {
        None
    }
}

/// An SVG is text, so it is recognised by what it starts with: an optional BOM, XML declaration, comments and
/// doctype, then an `<svg` element that is closed somewhere. It is stored as it is and only ever shown through an
/// `<img>` (which never runs scripts) or imported by After Effects, never opened as a page.
fn looks_like_svg(b: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&b[..b.len().min(8192)]);
    let mut t: &str = head.trim_start_matches('\u{feff}').trim_start();
    loop {
        let skip = if t.starts_with("<?xml") {
            t.find("?>").map(|i| i + 2)
        } else if t.starts_with("<!--") {
            t.find("-->").map(|i| i + 3)
        } else if t.len() >= 9 && t[..9].eq_ignore_ascii_case("<!doctype") {
            t.find('>').map(|i| i + 1)
        } else {
            None
        };
        match skip {
            Some(n) => t = t[n..].trim_start(),
            None => break,
        }
    }
    let opens = t.starts_with("<svg") && t[4..].starts_with(|c: char| c.is_whitespace() || c == '>' || c == '/');
    opens && (b.windows(6).any(|w| w == b"</svg>") || String::from_utf8_lossy(b).trim_end().ends_with("/>"))
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMedia {
    /// Plain file name inside `.murre/references/media/`.
    pub file: String,
    pub media_type: MediaType,
    pub size_bytes: u64,
}

pub fn import_media(root: &Path, bytes: &[u8]) -> AppResult<ImportedMedia> {
    if bytes.is_empty() {
        return invalid("That file is empty. Like, actually empty.");
    }
    if bytes.len() > MAX_MEDIA_BYTES {
        return invalid("That file is too big for the reference board (40 MB max). Even moodboards have limits.");
    }
    let Some((media_type, ext)) = sniff(bytes) else {
        return invalid(
            "That file type is not supported. Use PNG, JPG, GIF, WebP, SVG, MP4, MOV, WebM or PDF.",
        );
    };
    let dir = root.join(MEDIA_DIR);
    fs::create_dir_all(&dir).map_err(|e| AppError::io(&dir, e))?;
    let file = format!("{}.{ext}", uuid::Uuid::new_v4().simple());
    // create_new refuses to replace an existing file.
    safe_fs::create_new(&dir.join(&file), bytes)?;
    Ok(ImportedMedia {
        file,
        media_type,
        size_bytes: bytes.len() as u64,
    })
}

/// Validate a media file name and return its path inside `media/`.
pub fn media_path(root: &Path, file: &str) -> AppResult<PathBuf> {
    let ok_name = !file.is_empty()
        && file.len() <= 64
        && file.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
        && !file.starts_with('.')
        && file.matches('.').count() == 1;
    if !ok_name {
        return invalid("That is not a reference file.");
    }
    let ext = file.rsplit('.').next().unwrap_or("");
    if !["png", "jpg", "gif", "webp", "svg", "mp4", "mov", "webm", "pdf"].contains(&ext) {
        return invalid("That is not a reference file.");
    }
    let path = root.join(MEDIA_DIR).join(file);
    let meta = fs::symlink_metadata(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::Invalid("That reference file is missing from the project.".into())
        } else {
            AppError::io(&path, e)
        }
    })?;
    if !meta.file_type().is_file() {
        return invalid("That is not a reference file.");
    }
    fs::canonicalize(&path).map_err(|e| AppError::io(&path, e))
}

/// Relative path (from the project root) for use with the Open command.
pub fn media_rel(file: &str) -> String {
    format!("{MEDIA_DIR}/{file}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join(MEDIA_DIR)).unwrap();
        d
    }

    fn canvas(tag: &str) -> Value {
        json!({ "store": { "shape:a": { "id": "shape:a", "tag": tag } }, "schema": { "schemaVersion": 2 } })
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

    #[test]
    fn scaffold_shell_is_readable_and_items_are_preserved() {
        let d = project();
        fs::write(
            d.path().join(REFERENCES_JSON),
            br#"{"schemaVersion":1,"canvas":null,"items":[]}"#,
        )
        .unwrap();
        let v = get(d.path()).unwrap();
        assert_eq!((v.revision, v.canvas), (0, None));
        save(d.path(), canvas("one"), 0).unwrap();
        let raw = fs::read_to_string(d.path().join(REFERENCES_JSON)).unwrap();
        assert!(raw.contains("\"items\""));
    }

    #[test]
    fn save_bumps_revision_and_conflicts_on_stale() {
        let d = project();
        assert_eq!(save(d.path(), canvas("one"), 0).unwrap().revision, 1);
        assert_eq!(save(d.path(), canvas("two"), 1).unwrap().revision, 2);
        assert!(matches!(
            save(d.path(), canvas("stale"), 1).unwrap_err(),
            AppError::Conflict(_)
        ));
        assert!(matches!(
            save(d.path(), canvas("future"), 9).unwrap_err(),
            AppError::Conflict(_)
        ));
        assert_eq!(get(d.path()).unwrap().canvas, Some(canvas("two")));
    }

    #[test]
    fn malformed_canvas_is_rejected_without_touching_the_file() {
        let d = project();
        save(d.path(), canvas("keep"), 0).unwrap();
        for bad in [
            json!(null),
            json!([]),
            json!({"store": {}}),
            json!({"schema": {}, "store": 3}),
        ] {
            assert!(save(d.path(), bad, 1).is_err());
        }
        assert_eq!(get(d.path()).unwrap().canvas, Some(canvas("keep")));
        assert_eq!(get(d.path()).unwrap().revision, 1);
    }

    fn board(tag: &str) -> Value {
        json!({ "format": BOARD_FORMAT, "version": 1, "items": [{ "id": tag }] })
    }

    #[test]
    fn new_format_is_accepted_and_garbage_is_not() {
        let d = project();
        assert_eq!(save(d.path(), board("a"), 0).unwrap().revision, 1);
        for bad in [
            json!({"format": BOARD_FORMAT}),
            json!({"format": "other", "items": []}),
            json!({"format": BOARD_FORMAT, "items": 3}),
        ] {
            assert!(save(d.path(), bad, 1).is_err());
        }
        assert_eq!(get(d.path()).unwrap().canvas, Some(board("a")));
        assert!(!d.path().join(LEGACY_BACKUP).exists());
    }

    #[test]
    fn replacing_an_old_tldraw_board_keeps_a_backup_once() {
        let d = project();
        save(d.path(), canvas("old"), 0).unwrap();
        // Saving another old-format board does not count as converting.
        save(d.path(), canvas("old2"), 1).unwrap();
        assert!(!d.path().join(LEGACY_BACKUP).exists());
        save(d.path(), board("new"), 2).unwrap();
        let kept: Value =
            serde_json::from_slice(&fs::read(d.path().join(LEGACY_BACKUP)).unwrap()).unwrap();
        assert_eq!(kept, canvas("old2"));
        // Later saves never overwrite that backup.
        save(d.path(), board("newer"), 3).unwrap();
        let kept: Value =
            serde_json::from_slice(&fs::read(d.path().join(LEGACY_BACKUP)).unwrap()).unwrap();
        assert_eq!(kept, canvas("old2"));
    }

    #[test]
    fn corrupt_file_is_not_overwritten() {
        let d = project();
        fs::write(d.path().join(REFERENCES_JSON), b"{nope").unwrap();
        assert!(save(d.path(), canvas("x"), 0).is_err());
        assert_eq!(fs::read(d.path().join(REFERENCES_JSON)).unwrap(), b"{nope");
    }

    #[test]
    fn newer_schema_is_refused() {
        let d = project();
        fs::write(d.path().join(REFERENCES_JSON), br#"{"schemaVersion":99}"#).unwrap();
        assert!(get(d.path()).is_err());
        assert!(save(d.path(), canvas("x"), 0).is_err());
    }

    #[test]
    fn import_sniffs_type_and_never_trusts_names() {
        let d = project();
        let m = import_media(d.path(), PNG).unwrap();
        assert_eq!(m.media_type, MediaType::Image);
        assert!(m.file.ends_with(".png"));
        assert_eq!(
            fs::read(media_path(d.path(), &m.file).unwrap()).unwrap(),
            PNG
        );

        let mut mp4 = vec![0, 0, 0, 0x18];
        mp4.extend_from_slice(b"ftypisom");
        assert!(import_media(d.path(), &mp4).unwrap().file.ends_with(".mp4"));
        let mut mov = vec![0, 0, 0, 0x14];
        mov.extend_from_slice(b"ftypqt  ");
        assert!(import_media(d.path(), &mov).unwrap().file.ends_with(".mov"));
        assert_eq!(
            import_media(d.path(), b"%PDF-1.7 ...").unwrap().media_type,
            MediaType::Pdf
        );
        assert!(
            import_media(d.path(), &[0x1A, 0x45, 0xDF, 0xA3, 1])
                .unwrap()
                .file
                .ends_with(".webm")
        );
        let mut webp = b"RIFF\0\0\0\0WEBP".to_vec();
        webp.push(0);
        assert!(
            import_media(d.path(), &webp)
                .unwrap()
                .file
                .ends_with(".webp")
        );

        for bad in [
            &b""[..],
            b"#!/bin/sh\nrm -rf /",
            b"<svg onload=alert(1)>",
            b"<html><svg></svg></html>",
            b"MZ\x90\0",
        ] {
            assert!(import_media(d.path(), bad).is_err());
        }
        assert!(import_media(d.path(), &vec![0x25; MAX_MEDIA_BYTES + 1]).is_err());
    }

    #[test]
    fn svg_icons_are_accepted_as_images() {
        let d = tempfile::tempdir().unwrap();
        for ok in [
            &b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path d=\"M0 0h24v24H0z\"/></svg>"[..],
            b"\xEF\xBB\xBF<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- icon -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x.dtd\">\n<svg width=\"1\" height=\"1\"></svg>\n",
            b"<svg/>",
        ] {
            let m = import_media(d.path(), ok).unwrap();
            assert!(m.file.ends_with(".svg") && m.media_type == MediaType::Image);
            assert!(media_path(d.path(), &m.file).is_ok());
        }
        // Not an svg element, or never closed.
        for bad in [&b"<svgfoo></svgfoo>"[..], b"<svg><path>", b"<div><svg></svg></div>"] {
            assert!(import_media(d.path(), bad).is_err());
        }
    }

    #[test]
    fn two_imports_of_the_same_bytes_get_different_files() {
        let d = project();
        let a = import_media(d.path(), PNG).unwrap().file;
        let b = import_media(d.path(), PNG).unwrap().file;
        assert_ne!(a, b);
        assert_eq!(fs::read_dir(d.path().join(MEDIA_DIR)).unwrap().count(), 2);
    }

    #[test]
    fn media_path_only_accepts_plain_names_of_real_files() {
        let d = project();
        let f = import_media(d.path(), PNG).unwrap().file;
        assert!(media_path(d.path(), &f).is_ok());
        for bad in [
            "",
            "../x.png",
            "a/b.png",
            "/etc/passwd",
            ".hidden.png",
            "x.png.exe",
            "x.exe",
            "missing.png",
            &"a".repeat(80),
        ] {
            assert!(media_path(d.path(), bad).is_err(), "{bad}");
        }
        fs::create_dir(d.path().join(MEDIA_DIR).join("dir.png")).unwrap();
        assert!(media_path(d.path(), "dir.png").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_media_is_refused() {
        let d = project();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("s.png"), PNG).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("s.png"),
            d.path().join(MEDIA_DIR).join("link.png"),
        )
        .unwrap();
        assert!(media_path(d.path(), "link.png").is_err());
    }
}
