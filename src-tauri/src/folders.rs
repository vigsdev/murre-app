//! The folder setup for new projects: which sub-folders `02 Assets` gets and which file types go into each.
//!
//! One setup is kept for the whole app (in the settings table). When a project is created, a resolved copy is written to
//! its `.murre/folders.json`; that copy is what the After Effects Companion reads, so changing the setup later only
//! affects new projects. Projects without the file (made before this, or brought in) use the default folders.

use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

const KEY: &str = "folder_template";
pub const SCHEMA_VERSION: u32 = 1;
const MAX_FOLDERS: usize = 30;
const MAX_NAME_CHARS: usize = 60;
const MAX_EXTRA_EXTS: usize = 40;

/// A kind of file the editor offers as a chip. The file types behind it live here, so the app and the Companion's copy agree.
pub struct Kind {
    pub id: &'static str,
    pub label: &'static str,
    pub exts: &'static [&'static str],
}

pub const KINDS: &[Kind] = &[
    Kind {
        id: "image",
        label: "Images",
        exts: &["jpg", "jpeg", "png", "gif", "tif", "tiff", "bmp", "webp", "heic", "heif", "exr", "hdr", "dpx", "tga", "svg", "jp2"],
    },
    Kind { id: "audio", label: "Audio", exts: &["wav", "mp3", "aif", "aiff", "m4a", "aac", "flac", "ogg", "wma"] },
    Kind {
        id: "video",
        label: "Videos",
        exts: &["mp4", "mov", "m4v", "avi", "mkv", "webm", "mxf", "wmv", "mpg", "mpeg", "mts", "m2ts", "flv", "3gp"],
    },
    Kind { id: "photoshop", label: "Photoshop", exts: &["psd", "psb"] },
    Kind { id: "illustrator", label: "Illustrator", exts: &["ai", "eps"] },
];

/// One sub-folder of `02 Assets`: the kinds of file that go into it, plus any extra file types typed in by hand.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub name: String,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub extras: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub folders: Vec<Folder>,
}

fn folder(name: &str, kinds: &[&str]) -> Folder {
    Folder { name: name.into(), kinds: kinds.iter().map(|k| k.to_string()).collect(), extras: Vec::new() }
}

/// The setup Murre ships with.
pub fn default_template() -> Template {
    Template {
        folders: vec![
            folder("01 Images", &["image"]),
            folder("02 Audios", &["audio"]),
            folder("03 PSD Files", &["photoshop"]),
            folder("04 Illustrator Files", &["illustrator"]),
            folder("05 Templates", &[]),
            folder("06 SoundFX", &[]),
            folder("07 Videos", &["video"]),
        ],
    }
}

fn invalid<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Invalid(msg.into()))
}

fn clean_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return invalid("A folder needs a name.");
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return invalid(format!("“{name}” is too long. Keep folder names under {MAX_NAME_CHARS} characters."));
    }
    if name == "." || name == ".." || name.starts_with('.') {
        return invalid(format!("“{name}” can’t start with a dot."));
    }
    if name.chars().any(|c| c.is_control() || "/\\:*?\"<>|".contains(c)) {
        return invalid(format!("“{name}” has a character that folder names can’t use (/ \\ : * ? \" < > |)."));
    }
    // After Effects keeps solids in a bin of this name inside the assets bin.
    if name.eq_ignore_ascii_case("solids") {
        return invalid("“Solids” is used by the After Effects project bins. Pick another name.");
    }
    Ok(name.to_string())
}

fn clean_ext(raw: &str) -> AppResult<String> {
    let ext = raw.trim().trim_start_matches('.').trim_start_matches('*').trim_start_matches('.').to_lowercase();
    if ext.is_empty() || ext.len() > 10 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return invalid(format!("“{raw}” isn’t a file type. Use letters and digits, like mp4."));
    }
    Ok(ext)
}

/// Check a setup and tidy it: trimmed names, lower-case extensions, no repeats. A file type may belong to only one folder.
pub fn validate(t: &Template) -> AppResult<Template> {
    if t.folders.len() > MAX_FOLDERS {
        return invalid(format!("That’s a lot of folders. The limit is {MAX_FOLDERS}."));
    }
    let mut names: HashMap<String, String> = HashMap::new();
    let mut owners: HashMap<String, String> = HashMap::new();
    let mut out = Vec::new();
    for f in &t.folders {
        let name = clean_name(&f.name)?;
        if names.insert(name.to_lowercase(), name.clone()).is_some() {
            return invalid(format!("Two folders are named “{name}”."));
        }
        let mut kinds = Vec::new();
        for k in &f.kinds {
            if !KINDS.iter().any(|x| x.id == k) {
                return invalid(format!("Unknown file kind “{k}”."));
            }
            if !kinds.contains(k) {
                kinds.push(k.clone());
            }
        }
        if f.extras.len() > MAX_EXTRA_EXTS {
            return invalid(format!("“{name}” has too many file types. The limit is {MAX_EXTRA_EXTS}."));
        }
        let mut extras: Vec<String> = Vec::new();
        for e in &f.extras {
            let e = clean_ext(e)?;
            if !extras.contains(&e) {
                extras.push(e);
            }
        }
        let folder = Folder { name: name.clone(), kinds, extras };
        for ext in exts_of(&folder) {
            if let Some(other) = owners.insert(ext.clone(), name.clone()) {
                return invalid(format!(".{ext} files can only go to one folder, but both “{other}” and “{name}” take them."));
            }
        }
        out.push(folder);
    }
    Ok(Template { folders: out })
}

/// Every file type a folder takes, kinds first, without repeats.
pub fn exts_of(f: &Folder) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for k in &f.kinds {
        if let Some(kind) = KINDS.iter().find(|x| x.id == k) {
            for e in kind.exts {
                if !out.iter().any(|x| x == e) {
                    out.push((*e).to_string());
                }
            }
        }
    }
    for e in &f.extras {
        if !out.contains(e) {
            out.push(e.clone());
        }
    }
    out
}

/// The saved setup, or the default when none was saved (or the saved one can’t be read).
pub fn load(conn: &Connection) -> AppResult<Template> {
    let raw: Option<String> = conn.query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |r| r.get(0)).optional()?;
    Ok(raw
        .and_then(|s| serde_json::from_str::<Template>(&s).ok())
        .and_then(|t| validate(&t).ok())
        .unwrap_or_else(default_template))
}

pub fn is_default(t: &Template) -> bool {
    *t == default_template()
}

pub fn save(conn: &Connection, t: &Template) -> AppResult<Template> {
    let t = validate(t)?;
    let value = serde_json::to_string(&t).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [KEY, value.as_str()],
    )?;
    Ok(t)
}

pub fn reset(conn: &Connection) -> AppResult<Template> {
    conn.execute("DELETE FROM settings WHERE key = ?1", [KEY])?;
    Ok(default_template())
}

/// The folders to create under `02 Assets`, by name.
pub fn asset_dirs(t: &Template) -> Vec<String> {
    t.folders.iter().map(|f| format!("02 Assets/{}", f.name)).collect()
}

/// What goes into the project's `.murre/folders.json`, for the Companion.
pub fn snapshot(t: &Template) -> serde_json::Value {
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "folders": t.folders.iter().map(|f| json!({ "name": f.name, "exts": exts_of(f) })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let c = crate::db::open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        c
    }

    fn t(folders: Vec<Folder>) -> Template {
        Template { folders }
    }

    #[test]
    fn the_default_is_valid_and_matches_the_old_fixed_folders() {
        let d = default_template();
        assert_eq!(validate(&d).unwrap(), d);
        let mut expected: Vec<String> = crate::project::PROJECT_DIRS.iter().filter(|p| p.starts_with("02 Assets/")).map(|s| s.to_string()).collect();
        let mut got = asset_dirs(&d);
        expected.sort();
        got.sort();
        assert_eq!(got, expected);
    }

    #[test]
    fn names_are_tidied_and_unsafe_ones_refused() {
        let ok = validate(&t(vec![folder("  Footage  ", &["video"])])).unwrap();
        assert_eq!(ok.folders[0].name, "Footage");
        for bad in ["", "   ", "a/b", "a\\b", ".hidden", "..", "x:y", "Solids", "solids", &"n".repeat(61)] {
            assert!(validate(&t(vec![folder(bad, &[])])).is_err(), "{bad:?} should be refused");
        }
        assert!(validate(&t(vec![folder("A", &[]), folder("a", &[])])).is_err(), "names repeat ignoring case");
    }

    #[test]
    fn a_file_type_belongs_to_one_folder() {
        let err = validate(&t(vec![folder("Clips", &["video"]), Folder { name: "Other".into(), kinds: vec![], extras: vec![".MOV".into()] }])).unwrap_err();
        assert!(err.to_string().contains(".mov"), "{err}");
    }

    #[test]
    fn extra_types_are_cleaned_and_kinds_checked() {
        let ok = validate(&t(vec![Folder { name: "RAW".into(), kinds: vec![], extras: vec!["*.R3D".into(), " .braw ".into(), "r3d".into()] }])).unwrap();
        assert_eq!(ok.folders[0].extras, vec!["r3d", "braw"]);
        assert!(validate(&t(vec![Folder { name: "X".into(), kinds: vec!["nope".into()], extras: vec![] }])).is_err());
        assert!(validate(&t(vec![Folder { name: "X".into(), kinds: vec![], extras: vec!["a b".into()] }])).is_err());
    }

    #[test]
    fn it_is_saved_reset_and_a_damaged_copy_falls_back() {
        let c = conn();
        assert!(is_default(&load(&c).unwrap()));
        let custom = t(vec![folder("Footage", &["video"]), folder("Stills", &["image"])]);
        save(&c, &custom).unwrap();
        assert_eq!(load(&c).unwrap(), custom);
        c.execute("UPDATE settings SET value = '{broken' WHERE key = 'folder_template'", []).unwrap();
        assert!(is_default(&load(&c).unwrap()));
        save(&c, &custom).unwrap();
        reset(&c).unwrap();
        assert!(is_default(&load(&c).unwrap()));
    }

    #[test]
    fn the_snapshot_lists_every_file_type() {
        let s = snapshot(&t(vec![Folder { name: "Footage".into(), kinds: vec!["video".into()], extras: vec!["r3d".into()] }, folder("Notes", &[])]));
        assert_eq!(s["schemaVersion"], 1);
        assert_eq!(s["folders"][0]["name"], "Footage");
        assert!(s["folders"][0]["exts"].as_array().unwrap().iter().any(|e| e == "mp4"));
        assert!(s["folders"][0]["exts"].as_array().unwrap().iter().any(|e| e == "r3d"));
        assert_eq!(s["folders"][1]["exts"].as_array().unwrap().len(), 0);
    }
}
