//! Footage files listed by the After Effects Companion, read from `.murre/assets.json`.
//! The desktop app only reads this file; the Companion owns it and does the copying and relinking.

use crate::error::AppResult;
use crate::project::invalid;
use crate::safe_fs;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

const ASSETS_JSON: &str = ".murre/assets.json";
const SUPPORTED_SCHEMA: u64 = 1;
const MAX_ENTRIES: usize = 20_000;
const MAX_MOVED: usize = 500;
const MAX_TEXT: usize = 1000;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FootageEntry {
    /// The file's path as After Effects reports it.
    pub path: String,
    /// Footage item names that use it.
    pub names: Vec<String>,
    /// `inside`, `outside`, `missing` or `sequence`.
    pub status: String,
    /// Project-relative folder an outside file would be copied into.
    pub dest_folder: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MovedEntry {
    pub from: String,
    /// Relative to the project folder.
    pub to: String,
    pub at: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FootageView {
    /// `None` until the Companion has scanned this project.
    pub last_scan_at: Option<Value>,
    pub assets: Vec<FootageEntry>,
    /// Files the Companion copied into the project (newest last). Originals were left where they were.
    pub moved: Vec<MovedEntry>,
    pub skipped: usize,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(|s| s.chars().take(MAX_TEXT).collect())
}

fn parse_entry(v: &Value) -> Option<FootageEntry> {
    let path = text(v, "path").filter(|p| !p.trim().is_empty())?;
    let status = text(v, "status").filter(|s| ["inside", "outside", "missing", "sequence"].contains(&s.as_str()))?;
    let names = v
        .get("names")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|n| n.as_str().map(|s| s.chars().take(MAX_TEXT).collect())).collect())
        .unwrap_or_default();
    Some(FootageEntry { path, names, status, dest_folder: text(v, "destFolder") })
}

pub fn get(root: &Path) -> AppResult<FootageView> {
    let path = root.join(ASSETS_JSON);
    if !path.exists() && !safe_fs::backup_path(&path).exists() {
        return Ok(FootageView::default());
    }
    let (doc, _): (Value, _) = safe_fs::read_json(&path)?;
    if doc.get("schemaVersion").and_then(Value::as_u64).is_some_and(|v| v > SUPPORTED_SCHEMA) {
        return invalid("These footage files were saved by a newer version of the Companion.");
    }
    let raw = match doc.get("assets") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(a)) => a.as_slice(),
        Some(_) => return invalid("assets.json has an unexpected format."),
    };
    let mut view = FootageView {
        last_scan_at: doc.get("lastScanAt").filter(|v| v.is_string() || v.is_number()).cloned(),
        ..Default::default()
    };
    for (i, item) in raw.iter().enumerate() {
        if i >= MAX_ENTRIES {
            view.skipped += raw.len() - MAX_ENTRIES;
            break;
        }
        match parse_entry(item) {
            Some(e) => view.assets.push(e),
            None => view.skipped += 1,
        }
    }
    if let Some(Value::Array(moved)) = doc.get("moved") {
        let start = moved.len().saturating_sub(MAX_MOVED);
        for m in &moved[start..] {
            if let (Some(from), Some(to)) = (text(m, "from"), text(m, "to")) {
                view.moved.push(MovedEntry { from, to, at: text(m, "at").unwrap_or_default() });
            }
        }
    }
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project_with(doc: &str) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join(".murre")).unwrap();
        fs::write(d.path().join(ASSETS_JSON), doc).unwrap();
        d
    }

    #[test]
    fn no_file_means_not_scanned_yet() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(get(d.path()).unwrap(), FootageView::default());
    }

    #[test]
    fn reads_what_the_companion_wrote() {
        let d = project_with(
            r#"{"schemaVersion":1,"lastScanAt":"2026-10-26T12:00:00Z","assets":[
              {"path":"/dl/a.png","names":["a.png","a copy"],"ids":[1,2],"status":"outside","destFolder":"02 Assets/01 Images"},
              {"path":"/p/02 Assets/b.wav","names":["b.wav"],"ids":[3],"status":"inside","destFolder":null},
              {"path":"/x/gone.mov","names":["gone"],"ids":[4],"status":"missing","destFolder":null},
              {"path":"/x/s_0001.png","names":["s_[0001-0010].png"],"ids":[5],"status":"sequence","destFolder":null},
              {"path":"","status":"inside"}, {"path":"/x","status":"weird"}, "text"],
              "moved":[{"from":"/dl/old.jpg","to":"02 Assets/01 Images/old.jpg","at":"2026-10-25T10:00:00Z"},{"from":1}]}"#,
        );
        let v = get(d.path()).unwrap();
        assert_eq!(v.assets.len(), 4);
        assert_eq!(v.assets[0].names, ["a.png", "a copy"]);
        assert_eq!(v.assets[0].dest_folder.as_deref(), Some("02 Assets/01 Images"));
        assert_eq!(v.assets[3].status, "sequence");
        assert_eq!(v.skipped, 3);
        assert_eq!(v.moved.len(), 1);
        assert_eq!(v.moved[0].to, "02 Assets/01 Images/old.jpg");
    }

    #[test]
    fn newer_schema_and_damaged_files_are_errors() {
        assert!(get(project_with(r#"{"schemaVersion":2,"assets":[]}"#).path()).unwrap_err().to_string().contains("newer version"));
        assert!(get(project_with("not json").path()).is_err());
        assert!(get(project_with(r#"{"schemaVersion":1,"assets":"x"}"#).path()).is_err());
    }
}
