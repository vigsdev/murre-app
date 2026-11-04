//! After Effects workfiles (`.aep`) inside a project: discovery, version
//! detection from filenames, and the user's explicit "current AEP" choice.
//!
//! * Files are only ever read (metadata); nothing in the project is modified
//!   except `.murre/workfiles.json`.
//! * Discovery scans the project folder (not just `01 AE Workfile`) so imported
//!   projects with their own layout work too. Hidden folders and After Effects
//!   auto-save folders are skipped, symlinks are not followed.
//! * The current AEP is never guessed. It is whatever the user marked, stored
//!   as a path relative to the project folder.

use crate::error::{AppError, AppResult};
use crate::project::{invalid, now};
use crate::safe_fs;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_FILES: usize = 1000;
const MAX_DEPTH: usize = 5;
const WORKFILES_JSON: &str = ".murre/workfiles.json";
const MAX_NOTE_CHARS: usize = 280;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Workfile {
    /// Path relative to the project folder, `/`-separated.
    pub path: String,
    pub absolute_path: String,
    pub name: String,
    pub size_bytes: u64,
    /// Unix seconds.
    pub modified_at: u64,
    /// Version number detected from the filename (`v03`, `_07`), if any.
    pub version: Option<u32>,
    /// Highest detected version among files with the same base name.
    pub is_latest_version: bool,
    pub is_current: bool,
    /// The one-line note the designer wrote for this version, if any.
    pub note: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentAep {
    pub path: String,
    pub marked_at: u64,
    /// False if the marked file is no longer on disk (renamed, moved or deleted).
    pub exists: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkfileScan {
    /// Newest modification first.
    pub workfiles: Vec<Workfile>,
    pub current_aep: Option<CurrentAep>,
    /// More than the scan limit exist; the list is incomplete.
    pub truncated: bool,
}

// ------------------------------------------------------------ versions

fn is_sep(c: char) -> bool {
    matches!(c, '_' | '-' | ' ' | '.')
}

/// Lowercase and collapse separators, so `Film_v03_final` and `Film v04 final`
/// share the base `film_final`.
pub(crate) fn normalize_base(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if is_sep(c) {
            if !out.ends_with('_') && !out.is_empty() {
                out.push('_');
            }
        } else {
            out.extend(c.to_lowercase());
        }
    }
    out.trim_end_matches('_').to_string()
}

/// Drop notes in brackets at the end of a name, such as `Film 6 (converted)` or `Film_v2 [final]`, so that they do not hide
/// the version before them. A name that is only a bracket is left as it is.
pub(crate) fn strip_notes(stem: &str) -> String {
    let mut cur = stem.trim_end();
    loop {
        let closer = if cur.ends_with(')') { '(' } else if cur.ends_with(']') { '[' } else { break };
        match cur.rfind(closer) {
            Some(i) if !cur[..i].trim().is_empty() => cur = cur[..i].trim_end(),
            _ => break,
        }
    }
    cur.to_string()
}

/// Detect a version in a filename stem. Returns `(normalized base name, version)`.
///
/// A note in brackets at the end (`Film 6 (converted)`) is ignored. Recognized: a `v`/`V` followed by 1–4 digits as its own token (`Film_v03`,
/// `Film v12 final`), otherwise a 1–3 digit number after a separator at the very
/// end (`Cut_07`). Four-digit numbers such as years are not treated as versions.
pub fn parse_version(stem: &str) -> Option<(String, u32)> {
    let chars: Vec<char> = strip_notes(stem).chars().collect();

    // Last standalone `v<digits>` token.
    let mut found: Option<(usize, usize)> = None;
    let mut i = 0;
    while i < chars.len() {
        if matches!(chars[i], 'v' | 'V') && (i == 0 || !chars[i - 1].is_alphanumeric()) {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            let digits = j - (i + 1);
            if (1..=4).contains(&digits) && (j == chars.len() || !chars[j].is_alphanumeric()) {
                found = Some((i, j));
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    if let Some((s, e)) = found {
        let n: u32 = chars[s + 1..e].iter().collect::<String>().parse().ok()?;
        let base: String = chars[..s].iter().chain(chars[e..].iter()).collect();
        return Some((normalize_base(&base), n));
    }

    // Trailing number after a separator.
    let mut start = chars.len();
    while start > 0 && chars[start - 1].is_ascii_digit() {
        start -= 1;
    }
    let digits = chars.len() - start;
    if (1..=3).contains(&digits) && start >= 2 && is_sep(chars[start - 1]) {
        let n: u32 = chars[start..].iter().collect::<String>().parse().ok()?;
        let base: String = chars[..start - 1].iter().collect();
        return Some((normalize_base(&base), n));
    }
    None
}

// ---------------------------------------------------------------- scan

fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules" || name.to_lowercase().contains("auto-save")
}

fn walk(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<(PathBuf, fs::Metadata)>,
    truncated: &mut bool,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if *truncated {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            if depth < MAX_DEPTH && !skip_dir(&name) {
                walk(root, &path, depth + 1, out, truncated);
            }
        } else if ft.is_file()
            && !name.starts_with('.')
            && path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("aep"))
        {
            if out.len() >= MAX_FILES {
                *truncated = true;
                return;
            }
            if let Ok(meta) = entry.metadata() {
                out.push((path, meta));
            }
        }
    }
}

fn relative_slash(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn read_state(root: &Path) -> AppResult<Value> {
    let path = root.join(WORKFILES_JSON);
    if !path.exists() && !safe_fs::backup_path(&path).exists() {
        return Ok(json!({ "schemaVersion": 1, "currentAep": null, "workfiles": [] }));
    }
    Ok(safe_fs::read_json::<Value>(&path)?.0)
}

/// The note saved for a version (by project-relative path), if it has one.
fn note_from_state(state: &Value, rel: &str) -> Option<String> {
    state
        .get("notes")?
        .get(rel)?
        .get("text")?
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

fn current_from_state(state: &Value) -> Option<(String, u64)> {
    let c = state.get("currentAep")?.as_object()?;
    Some((
        c.get("path")?.as_str()?.to_string(),
        c.get("markedAt")?.as_u64()?,
    ))
}

pub fn scan(root: &Path) -> AppResult<WorkfileScan> {
    let mut found = Vec::new();
    let mut truncated = false;
    walk(root, root, 0, &mut found, &mut truncated);

    let state = read_state(root)?;
    let current = current_from_state(&state);

    struct Row {
        wf: Workfile,
        base: Option<String>,
    }
    let mut rows: Vec<Row> = found
        .into_iter()
        .map(|(path, meta)| {
            let rel = relative_slash(root, &path);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let stem = path
                .file_stem()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let parsed = parse_version(&stem);
            Row {
                wf: Workfile {
                    is_current: current.as_ref().is_some_and(|(p, _)| *p == rel),
                    note: note_from_state(&state, &rel),
                    path: rel,
                    absolute_path: path.to_string_lossy().into_owned(),
                    name,
                    size_bytes: meta.len(),
                    modified_at: meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                    version: parsed.as_ref().map(|(_, v)| *v),
                    is_latest_version: false,
                },
                // Versions only compare within the same folder and base name.
                base: parsed.map(|(b, _)| {
                    format!(
                        "{}\u{0}{b}",
                        path.parent()
                            .map(|p| relative_slash(root, p))
                            .unwrap_or_default()
                    )
                }),
            }
        })
        .collect();

    let mut max: HashMap<String, u32> = HashMap::new();
    for r in &rows {
        if let (Some(b), Some(v)) = (&r.base, r.wf.version) {
            let e = max.entry(b.clone()).or_insert(v);
            *e = (*e).max(v);
        }
    }
    for r in &mut rows {
        if let (Some(b), Some(v)) = (&r.base, r.wf.version) {
            r.wf.is_latest_version = max.get(b) == Some(&v);
        }
    }

    let mut workfiles: Vec<Workfile> = rows.into_iter().map(|r| r.wf).collect();
    workfiles.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| a.path.cmp(&b.path))
    });

    let current_aep = current.map(|(path, marked_at)| {
        let exists = workfiles.iter().any(|w| w.path == path) || root.join(&path).is_file();
        CurrentAep {
            path,
            marked_at,
            exists,
        }
    });
    Ok(WorkfileScan {
        workfiles,
        current_aep,
        truncated,
    })
}

/// Resolve a project-relative path and make sure it really is a file inside the project.
fn resolve_workfile(root: &Path, rel: &str) -> AppResult<()> {
    let p = Path::new(rel);
    if rel.trim().is_empty()
        || p.is_absolute()
        || p.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return invalid("That file is not inside the project folder.");
    }
    if !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("aep")) {
        return invalid("Only .aep files can be marked as the current After Effects project.");
    }
    let full = root.join(p);
    let canon_root = crate::platform::canonicalize(root).map_err(|e| AppError::io(root, e))?;
    let canon = crate::platform::canonicalize(&full).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::Invalid("That file no longer exists.".into())
        } else {
            AppError::io(&full, e)
        }
    })?;
    if !canon.starts_with(&canon_root) {
        return invalid("That file is not inside the project folder.");
    }
    if !canon.is_file() {
        return invalid("That is not a file.");
    }
    Ok(())
}

/// Mark `rel` as the current AEP, or clear the mark with `None`. Other keys in
/// `workfiles.json` are preserved. Returns a fresh scan.
pub fn set_current(root: &Path, rel: Option<&str>) -> AppResult<WorkfileScan> {
    let mut state = read_state(root)?;
    let obj = state
        .as_object_mut()
        .ok_or_else(|| AppError::Invalid("workfiles.json has an unexpected format.".into()))?;
    match rel {
        Some(rel) => {
            resolve_workfile(root, rel)?;
            obj.insert(
                "currentAep".into(),
                json!({ "path": rel, "markedAt": now() }),
            );
        }
        None => {
            obj.insert("currentAep".into(), Value::Null);
        }
    }
    safe_fs::write_json(&root.join(WORKFILES_JSON), &state)?;
    scan(root)
}

/// Save (or, with empty text, remove) the one-line note of a version. The file only needs to be inside the
/// project: a note may be written for a version that is not on disk right now. Other keys are preserved.
pub fn set_note(root: &Path, rel: &str, text: &str) -> AppResult<WorkfileScan> {
    let p = Path::new(rel);
    if rel.trim().is_empty() || p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return invalid("That file is not inside the project folder.");
    }
    let clean: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_NOTE_CHARS).collect();
    let mut state = read_state(root)?;
    let obj = state
        .as_object_mut()
        .ok_or_else(|| AppError::Invalid("workfiles.json has an unexpected format.".into()))?;
    let notes = obj.entry("notes").or_insert_with(|| json!({}));
    let Some(map) = notes.as_object_mut() else {
        return invalid("workfiles.json has an unexpected format.");
    };
    if clean.is_empty() {
        map.remove(rel);
    } else {
        map.insert(rel.to_string(), json!({ "text": clean, "updatedAt": now() }));
    }
    safe_fs::write_json(&root.join(WORKFILES_JSON), &state)?;
    scan(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::time::{Duration, SystemTime};

    fn touch(path: &Path, secs: u64) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"aep").unwrap();
        let f = File::options().write(true).open(path).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    fn project() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join(".murre")).unwrap();
        d
    }

    #[test]
    fn version_parsing() {
        let v = |s: &str| parse_version(s);
        assert_eq!(v("Film_v03"), Some(("film".into(), 3)));
        assert_eq!(v("Film v12 final"), Some(("film_final".into(), 12)));
        assert_eq!(v("film-V2"), Some(("film".into(), 2)));
        assert_eq!(v("Film_v03_final"), Some(("film_final".into(), 3)));
        assert_eq!(v("Cut_07"), Some(("cut".into(), 7)));
        assert_eq!(v("Cut 7"), Some(("cut".into(), 7)));
        assert_eq!(v("v2"), Some(("".into(), 2)));
        assert_eq!(v("Film_v1_v2"), Some(("film_v1".into(), 2)));
        // A note in brackets at the end does not hide the version.
        assert_eq!(v("Finalised-TV-Band 6 (converted)"), Some(("finalised_tv_band".into(), 6)));
        assert_eq!(v("Film_v2 [final]"), Some(("film".into(), 2)));
        assert_eq!(v("Film_v3 (copy) (old)"), Some(("film".into(), 3)));
        assert_eq!(v("Film (converted)"), None);
        assert_eq!(v("Film (2)"), None);
        for none in [
            "Revolver",
            "Promo_2026",
            "Movie2",
            "ver3",
            "Film_v3b",
            "Film",
            "Film_12345",
            "7",
        ] {
            assert_eq!(v(none), None, "{none}");
        }
    }

    #[test]
    fn scan_finds_aeps_skips_noise_and_detects_versions() {
        let d = project();
        let r = d.path();
        touch(&r.join("01 AE Workfile/Film_v1.aep"), 100);
        touch(&r.join("01 AE Workfile/Film_v2.aep"), 300);
        touch(&r.join("01 AE Workfile/Other_v5.aep"), 200);
        touch(&r.join("misc/Loose.AEP"), 50);
        touch(
            &r.join("01 AE Workfile/Adobe After Effects Auto-Save/Film_v2-auto.aep"),
            999,
        );
        touch(&r.join(".hidden/h.aep"), 999);
        touch(&r.join(".murre/z.aep"), 999);
        touch(&r.join("01 AE Workfile/._Film_v2.aep"), 999);
        touch(&r.join("notes.txt"), 999);
        touch(&r.join("a/b/c/d/e/f/too_deep.aep"), 999);

        let s = scan(r).unwrap();
        let names: Vec<_> = s.workfiles.iter().map(|w| w.path.as_str()).collect();
        assert_eq!(
            names,
            [
                "01 AE Workfile/Film_v2.aep",
                "01 AE Workfile/Other_v5.aep",
                "01 AE Workfile/Film_v1.aep",
                "misc/Loose.AEP"
            ]
        );
        let by = |p: &str| s.workfiles.iter().find(|w| w.path == p).unwrap();
        assert_eq!(by("01 AE Workfile/Film_v2.aep").version, Some(2));
        assert!(by("01 AE Workfile/Film_v2.aep").is_latest_version);
        assert!(!by("01 AE Workfile/Film_v1.aep").is_latest_version);
        assert!(by("01 AE Workfile/Other_v5.aep").is_latest_version);
        assert_eq!(by("misc/Loose.AEP").version, None);
        assert!(!by("misc/Loose.AEP").is_latest_version);
        assert_eq!(by("misc/Loose.AEP").modified_at, 50);
        assert_eq!(by("misc/Loose.AEP").size_bytes, 3);
        assert!(!s.truncated);
        assert_eq!(s.current_aep, None);
    }

    #[test]
    fn same_base_in_different_folders_is_not_compared() {
        let d = project();
        touch(&d.path().join("a/Film_v9.aep"), 10);
        touch(&d.path().join("b/Film_v1.aep"), 20);
        let s = scan(d.path()).unwrap();
        assert!(s.workfiles.iter().all(|w| w.is_latest_version));
    }

    #[test]
    fn mark_and_clear_current_aep() {
        let d = project();
        touch(&d.path().join("01 AE Workfile/Film_v1.aep"), 100);
        touch(&d.path().join("01 AE Workfile/Film_v2.aep"), 200);
        let s = set_current(d.path(), Some("01 AE Workfile/Film_v1.aep")).unwrap();
        let cur = s.current_aep.unwrap();
        assert_eq!(cur.path, "01 AE Workfile/Film_v1.aep");
        assert!(cur.exists);
        assert!(
            s.workfiles
                .iter()
                .find(|w| w.is_current)
                .unwrap()
                .path
                .ends_with("Film_v1.aep")
        );
        // persisted
        assert!(scan(d.path()).unwrap().current_aep.is_some());
        let s = set_current(d.path(), None).unwrap();
        assert_eq!(s.current_aep, None);
        assert!(s.workfiles.iter().all(|w| !w.is_current));
    }

    #[test]
    fn marking_preserves_other_keys_in_workfiles_json() {
        let d = project();
        touch(&d.path().join("x.aep"), 1);
        fs::write(
            d.path().join(WORKFILES_JSON),
            br#"{"schemaVersion":1,"currentAep":null,"workfiles":[],"extra":{"keep":true}}"#,
        )
        .unwrap();
        set_current(d.path(), Some("x.aep")).unwrap();
        let (v, _): (Value, _) = safe_fs::read_json(&d.path().join(WORKFILES_JSON)).unwrap();
        assert_eq!(v["extra"]["keep"], true);
        assert_eq!(v["currentAep"]["path"], "x.aep");
    }

    #[test]
    fn version_notes_are_saved_cleaned_cleared_and_keep_other_keys() {
        let d = project();
        touch(&d.path().join("01 AE/film_v04.aep"), 1);
        fs::write(
            d.path().join(WORKFILES_JSON),
            br#"{"schemaVersion":1,"currentAep":null,"workfiles":[],"extra":{"keep":true}}"#,
        )
        .unwrap();
        let s = set_note(d.path(), "01 AE/film_v04.aep", "  client wanted\n the logo   bigger ").unwrap();
        assert_eq!(s.workfiles[0].note.as_deref(), Some("client wanted the logo bigger"));
        let (v, _): (Value, _) = safe_fs::read_json(&d.path().join(WORKFILES_JSON)).unwrap();
        assert_eq!(v["extra"]["keep"], true);
        // Marking the current AEP afterwards keeps the note.
        set_current(d.path(), Some("01 AE/film_v04.aep")).unwrap();
        assert_eq!(scan(d.path()).unwrap().workfiles[0].note.as_deref(), Some("client wanted the logo bigger"));
        // Long notes are cut, blank ones remove the note.
        let long = "x".repeat(500);
        let s = set_note(d.path(), "01 AE/film_v04.aep", &long).unwrap();
        assert_eq!(s.workfiles[0].note.as_ref().unwrap().chars().count(), MAX_NOTE_CHARS);
        let s = set_note(d.path(), "01 AE/film_v04.aep", "   ").unwrap();
        assert_eq!(s.workfiles[0].note, None);
    }

    #[test]
    fn version_notes_refuse_paths_outside_the_project() {
        let d = project();
        assert!(set_note(d.path(), "../x.aep", "hi").is_err());
        assert!(set_note(d.path(), "/etc/x.aep", "hi").is_err());
        assert!(set_note(d.path(), "", "hi").is_err());
    }

    #[test]
    fn missing_marked_file_is_reported_not_hidden() {
        let d = project();
        touch(&d.path().join("x.aep"), 1);
        set_current(d.path(), Some("x.aep")).unwrap();
        fs::remove_file(d.path().join("x.aep")).unwrap();
        let s = scan(d.path()).unwrap();
        let cur = s.current_aep.unwrap();
        assert_eq!(cur.path, "x.aep");
        assert!(!cur.exists);
    }

    #[test]
    fn invalid_marks_are_rejected_and_change_nothing() {
        let d = project();
        touch(&d.path().join("ok.aep"), 1);
        touch(&d.path().join("notes.txt"), 1);
        fs::create_dir_all(d.path().join("dir.aep")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        touch(&outside.path().join("evil.aep"), 1);
        for bad in [
            "",
            "../evil.aep",
            "/etc/hosts.aep",
            "a/../ok.aep",
            "missing.aep",
            "notes.txt",
            "dir.aep",
        ] {
            assert!(set_current(d.path(), Some(bad)).is_err(), "{bad:?}");
        }
        assert!(!d.path().join(WORKFILES_JSON).exists());
        assert!(set_current(d.path(), Some("ok.aep")).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path().join("evil.aep"), d.path().join("link.aep"))
                .unwrap();
            assert!(
                set_current(d.path(), Some("link.aep")).is_err(),
                "symlink escaping the project"
            );
        }
    }

    #[test]
    fn corrupt_workfiles_json_is_an_error_and_untouched() {
        let d = project();
        touch(&d.path().join("x.aep"), 1);
        fs::write(d.path().join(WORKFILES_JSON), b"{oops").unwrap();
        assert!(matches!(scan(d.path()), Err(AppError::Corrupt { .. })));
        assert!(set_current(d.path(), Some("x.aep")).is_err());
        assert_eq!(fs::read(d.path().join(WORKFILES_JSON)).unwrap(), b"{oops");
    }
}
