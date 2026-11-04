//! Fonts collected by the After Effects Companion, read from
//! `.murre/fonts.json`. Display only: the desktop app never writes this file.
//!
//! Expected shape (the Companion owns the file; unknown keys are ignored):
//!
//! ```json
//! { "schemaVersion": 1, "lastScanAt": "2026-10-26T12:00:00Z", "method": "project",
//!   "fonts": [ { "postScriptName": "Inter-Bold", "family": "Inter", "style": "Bold",
//!                "location": "/Library/Fonts/Inter.ttc", "adobeFonts": false,
//!                "missing": false, "layerCount": 3,
//!                "uses": [ { "comp": "Main", "layer": "Title" } ] } ] }
//! ```
//!
//! `installed` is worked out when the file is read, so it reflects this Mac today.
//! Entries without any name are skipped and counted, not fatal.

use crate::error::AppResult;
use crate::project::invalid;
use crate::safe_fs;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

const FONTS_JSON: &str = ".murre/fonts.json";
const SUPPORTED_SCHEMA: u64 = 1;
const MAX_FONTS: usize = 2_000;
const MAX_USES: usize = 200;
const MAX_LABEL: usize = 300;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FontUse {
    pub comp: Option<String>,
    pub comp_id: Option<i64>,
    pub layer: Option<String>,
    pub layer_index: Option<u32>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FontEntry {
    pub post_script_name: String,
    pub family: Option<String>,
    pub style: Option<String>,
    pub location: Option<String>,
    pub adobe_fonts: bool,
    /// After Effects had to substitute this font when the project was scanned.
    pub missing: bool,
    pub layer_count: usize,
    pub uses: Vec<FontUse>,
    /// Whether the font file is on this Mac now. `None` when that can't be known
    /// (an Adobe Fonts font, or no file location was reported).
    pub installed: Option<bool>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FontsView {
    /// Passed through as written (ISO string or epoch number), or `null`.
    pub last_scan_at: Option<Value>,
    /// `"project"` (After Effects 24.5+, every font) or `"layers"` (first font of each text layer).
    pub method: String,
    pub fonts: Vec<FontEntry>,
    /// Entries in the file that could not be read.
    pub skipped: usize,
    /// Entries beyond the display limit.
    pub truncated: usize,
}

impl Default for FontsView {
    fn default() -> Self {
        FontsView {
            last_scan_at: None,
            method: "layers".into(),
            fonts: Vec::new(),
            skipped: 0,
            truncated: 0,
        }
    }
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(MAX_LABEL).collect())
}

fn parse_entry(v: &Value) -> Option<FontEntry> {
    if !v.is_object() {
        return None;
    }
    let family = text(v, "family");
    let style = text(v, "style");
    let post = text(v, "postScriptName")
        .or_else(|| family.as_ref().map(|f| format!("{f} {}", style.clone().unwrap_or_default()).trim().to_string()))?;
    let location = text(v, "location");
    let adobe_fonts = v.get("adobeFonts").and_then(Value::as_bool).unwrap_or(false);
    let installed = match (&location, adobe_fonts) {
        (Some(p), false) => Some(Path::new(p).exists()),
        _ => None,
    };
    let uses: Vec<FontUse> = v
        .get("uses")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .take(MAX_USES)
                .filter(|u| u.is_object())
                .map(|u| FontUse {
                    comp: text(u, "comp"),
                    comp_id: u.get("compId").and_then(Value::as_i64),
                    layer: text(u, "layer"),
                    layer_index: u.get("layerIndex").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).filter(|n| *n >= 1),
                })
                .collect()
        })
        .unwrap_or_default();
    let layer_count = v
        .get("layerCount")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(uses.len())
        .max(uses.len());
    Some(FontEntry {
        post_script_name: post,
        family,
        style,
        location,
        adobe_fonts,
        missing: v.get("missing").and_then(Value::as_bool).unwrap_or(false),
        layer_count,
        uses,
        installed,
    })
}

pub fn get(root: &Path) -> AppResult<FontsView> {
    let path = root.join(FONTS_JSON);
    if !path.exists() && !safe_fs::backup_path(&path).exists() {
        return Ok(FontsView::default());
    }
    let (doc, _): (Value, _) = safe_fs::read_json(&path)?;
    if doc
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .is_some_and(|v| v > SUPPORTED_SCHEMA)
    {
        return invalid("These fonts were saved by a newer version of the Companion.");
    }
    let raw = match doc.get("fonts") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(a)) => a.as_slice(),
        Some(_) => return invalid("fonts.json has an unexpected format."),
    };
    let mut view = FontsView {
        last_scan_at: doc
            .get("lastScanAt")
            .filter(|v| v.is_string() || v.is_number())
            .cloned(),
        method: match doc.get("method").and_then(Value::as_str) {
            Some("project") => "project".into(),
            _ => "layers".into(),
        },
        ..Default::default()
    };
    for (i, item) in raw.iter().enumerate() {
        if i >= MAX_FONTS {
            view.truncated = raw.len() - MAX_FONTS;
            break;
        }
        match parse_entry(item) {
            Some(e) => view.fonts.push(e),
            None => view.skipped += 1,
        }
    }
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn project_with(doc: &str) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join(".murre")).unwrap();
        fs::write(d.path().join(FONTS_JSON), doc).unwrap();
        d
    }

    #[test]
    fn missing_file_and_fresh_shell_are_empty() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(get(d.path()).unwrap(), FontsView::default());
        let d = project_with(r#"{"schemaVersion":1,"lastScanAt":null,"method":"layers","fonts":[]}"#);
        let v = get(d.path()).unwrap();
        assert!(v.fonts.is_empty() && v.last_scan_at.is_none());
    }

    #[test]
    fn reads_fonts_and_checks_whether_the_file_is_on_this_mac() {
        let real = tempfile::NamedTempFile::new().unwrap();
        let d = project_with(
            &json!({"schemaVersion":1,"lastScanAt":"2026-10-26T12:00:00Z","method":"project","fonts":[
                {"postScriptName":"Inter-Bold","family":"Inter","style":"Bold","location":real.path().to_str().unwrap(),
                 "layerCount":2,"uses":[{"comp":"Main","layer":"Title","compId":4,"layerIndex":2}]},
                {"postScriptName":"Gone-Regular","family":"Gone","location":"/nowhere/Gone.otf","missing":true},
                {"postScriptName":"Adobe-One","family":"Adobe One","adobeFonts":true,"location":"/x"},
                {"postScriptName":"NoPath-Regular"}
            ]})
            .to_string(),
        );
        let v = get(d.path()).unwrap();
        assert_eq!(v.method, "project");
        assert_eq!(v.fonts.len(), 4);
        assert_eq!(v.fonts[0].installed, Some(true));
        assert_eq!(v.fonts[0].layer_count, 2);
        assert_eq!(v.fonts[0].uses[0].comp.as_deref(), Some("Main"));
        assert_eq!((v.fonts[0].uses[0].comp_id, v.fonts[0].uses[0].layer_index), (Some(4), Some(2)));
        assert_eq!(v.fonts[1].installed, Some(false));
        assert!(v.fonts[1].missing);
        assert_eq!(v.fonts[2].installed, None);
        assert_eq!(v.fonts[3].installed, None);
    }

    #[test]
    fn unnamed_entries_are_skipped_and_counted() {
        let d = project_with(r#"{"schemaVersion":1,"fonts":[{"layerCount":1},"x",{"family":"Solo"}]}"#);
        let v = get(d.path()).unwrap();
        assert_eq!(v.skipped, 2);
        assert_eq!(v.fonts[0].post_script_name, "Solo");
        assert_eq!(v.method, "layers");
    }

    #[test]
    fn refuses_a_newer_schema_and_a_bad_shape() {
        let d = project_with(r#"{"schemaVersion":2,"fonts":[]}"#);
        assert!(get(d.path()).is_err());
        let d = project_with(r#"{"schemaVersion":1,"fonts":{}}"#);
        assert!(get(d.path()).is_err());
    }
}
