//! Compositions listed by the After Effects Companion, read from `.murre/comps.json`.
//! The desktop app only reads this file; the Companion owns it (including which comps are Main Comps).
//!
//! `comps.json` is an index, not a way to render: rendering still needs the real AEP and an
//! After Effects installation (see `aerender.rs`).

use crate::error::AppResult;
use crate::project::invalid;
use crate::safe_fs;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

const COMPS_JSON: &str = ".murre/comps.json";
const SUPPORTED_SCHEMA: u64 = 1;
const MAX_ENTRIES: usize = 20_000;
const MAX_TEXT: usize = 300;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompEntry {
    pub id: i64,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    /// Seconds.
    pub duration: f64,
    pub folder: String,
    pub main: bool,
}

/// The AEP the comp list belongs to.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AepRef {
    pub project_id: Option<String>,
    /// Relative to the project folder, with `/` separators.
    pub path: String,
    pub name: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompsView {
    /// `None` until the Companion has scanned this project.
    pub last_scan_at: Option<Value>,
    pub aep: Option<AepRef>,
    pub comps: Vec<CompEntry>,
    pub skipped: usize,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(|s| s.chars().take(MAX_TEXT).collect())
}

fn parse_entry(v: &Value) -> Option<CompEntry> {
    let name = text(v, "name").filter(|n| !n.trim().is_empty())?;
    let id = v.get("id").and_then(Value::as_i64)?;
    let dim = |k: &str| v.get(k).and_then(Value::as_u64).filter(|n| *n > 0 && *n <= 100_000);
    let positive = |k: &str| v.get(k).and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0);
    Some(CompEntry {
        id,
        name,
        width: dim("width")? as u32,
        height: dim("height")? as u32,
        frame_rate: positive("frameRate")?,
        duration: positive("duration")?,
        folder: text(v, "folder").unwrap_or_default(),
        main: v.get("main").and_then(Value::as_bool).unwrap_or(false),
    })
}

pub fn get(root: &Path) -> AppResult<CompsView> {
    let path = root.join(COMPS_JSON);
    if !path.exists() && !safe_fs::backup_path(&path).exists() {
        return Ok(CompsView::default());
    }
    let (doc, _): (Value, _) = safe_fs::read_json(&path)?;
    if doc
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .is_some_and(|v| v > SUPPORTED_SCHEMA)
    {
        return invalid("These compositions were saved by a newer version of the Companion.");
    }
    let raw = match doc.get("comps") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(a)) => a.as_slice(),
        Some(_) => return invalid("comps.json has an unexpected format."),
    };
    let aep = doc.get("aep").and_then(|a| {
        let path = text(a, "path").filter(|p| !p.trim().is_empty())?;
        Some(AepRef {
            project_id: text(a, "projectId"),
            path,
            name: text(a, "name"),
        })
    });
    let mut view = CompsView {
        last_scan_at: doc
            .get("lastScanAt")
            .filter(|v| v.is_string() || v.is_number())
            .cloned(),
        aep,
        ..Default::default()
    };
    for (i, item) in raw.iter().enumerate() {
        if i >= MAX_ENTRIES {
            view.skipped += raw.len() - MAX_ENTRIES;
            break;
        }
        match parse_entry(item) {
            Some(e) => view.comps.push(e),
            None => view.skipped += 1,
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
        fs::write(d.path().join(COMPS_JSON), doc).unwrap();
        d
    }

    #[test]
    fn no_file_means_not_scanned_yet() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(get(d.path()).unwrap(), CompsView::default());
    }

    #[test]
    fn reads_a_file_written_by_the_companion() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join(".murre")).unwrap();
        fs::write(
            d.path().join(COMPS_JSON),
            include_str!("../tests/fixtures/companion/comps.json"),
        )
        .unwrap();
        let v = get(d.path()).unwrap();
        assert_eq!(v.comps.len(), 2);
        assert_eq!(v.comps[0].name, "Main");
        assert_eq!(v.comps[0].frame_rate, 25.0);
        assert_eq!(v.comps[1].duration, 4.5);
        assert_eq!(v.aep.unwrap().path, "01 AE/film_v01.aep");
        assert_eq!(v.skipped, 0);
    }

    #[test]
    fn bad_entries_are_skipped_and_counted() {
        let d = project_with(
            r#"{"schemaVersion":1,"aep":{"path":"a.aep"},"comps":[
              {"id":1,"name":"Ok","width":10,"height":10,"frameRate":24,"duration":1,"main":true},
              {"id":2,"name":"","width":10,"height":10,"frameRate":24,"duration":1},
              {"id":3,"name":"NoSize","frameRate":24,"duration":1},
              {"id":4,"name":"Zero","width":10,"height":10,"frameRate":0,"duration":1},
              "text", {"name":"NoId","width":1,"height":1,"frameRate":1,"duration":1}]}"#,
        );
        let v = get(d.path()).unwrap();
        assert_eq!(v.comps.len(), 1);
        assert!(v.comps[0].main);
        assert_eq!(v.skipped, 5);
    }

    #[test]
    fn newer_schema_and_damaged_files_are_errors() {
        let d = project_with(r#"{"schemaVersion":2,"comps":[]}"#);
        assert!(get(d.path()).unwrap_err().to_string().contains("newer version"));
        let d = project_with("not json");
        assert!(get(d.path()).is_err());
        let d = project_with(r#"{"schemaVersion":1,"comps":"x"}"#);
        assert!(get(d.path()).is_err());
    }
}
