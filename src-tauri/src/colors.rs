//! Colors collected by the After Effects Companion, read from
//! `.murre/colors.json`. The desktop app only displays this file; it never
//! writes it, so there is nothing here that can overwrite the Companion's scan.
//!
//! Expected shape (the Companion owns the file; unknown keys are ignored):
//!
//! ```json
//! { "schemaVersion": 1, "lastScanAt": "2026-10-26T12:00:00Z",
//!   "colors": [ { "color": [1, 0.5, 0, 1], "comp": "Main", "layer": "Title",
//!                 "property": "Effects > Fill > Color" } ] }
//! ```
//!
//! `color` is After Effects' native `[r, g, b]` or `[r, g, b, a]` in 0–1.
//! A `"hex": "#RRGGBB"` string is accepted instead. Entries that cannot be
//! understood are skipped and counted, not fatal.

use crate::error::AppResult;
use crate::project::invalid;
use crate::safe_fs;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

const COLORS_JSON: &str = ".murre/colors.json";
const SUPPORTED_SCHEMA: u64 = 1;
const MAX_ENTRIES: usize = 50_000;
const MAX_TEXT: usize = 300;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColorEntry {
    /// Uppercase `#RRGGBB`.
    pub hex: String,
    pub alpha: f64,
    pub comp: Option<String>,
    /// After Effects item id of the composition, to jump to it. Missing in scans from older Companions.
    pub comp_id: Option<i64>,
    pub layer: Option<String>,
    /// Position of the layer in its composition (1 = top).
    pub layer_index: Option<u32>,
    pub property: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColorsView {
    /// Passed through as written (ISO string or epoch number), or `null`.
    pub last_scan_at: Option<Value>,
    pub colors: Vec<ColorEntry>,
    /// Entries in the file that could not be read.
    pub skipped: usize,
    /// Entries beyond the display limit.
    pub truncated: usize,
}

fn text(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(MAX_TEXT).collect())
}

fn channel(v: &Value) -> Option<u8> {
    let f = v.as_f64()?;
    if !f.is_finite() || !(0.0..=1.0).contains(&f) {
        return None;
    }
    Some((f * 255.0).round() as u8)
}

fn parse_hex(s: &str) -> Option<String> {
    let h = s.trim().trim_start_matches('#');
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", h.to_ascii_uppercase()))
}

fn parse_entry(v: &Value) -> Option<ColorEntry> {
    if !v.is_object() {
        return None;
    }
    let (hex, alpha) = if let Some(arr) = v.get("color").and_then(Value::as_array) {
        if arr.len() != 3 && arr.len() != 4 {
            return None;
        }
        let r = channel(&arr[0])?;
        let g = channel(&arr[1])?;
        let b = channel(&arr[2])?;
        let a = match arr.get(3) {
            Some(x) => x.as_f64().filter(|a| (0.0..=1.0).contains(a))?,
            None => 1.0,
        };
        (format!("#{r:02X}{g:02X}{b:02X}"), a)
    } else {
        (parse_hex(v.get("hex")?.as_str()?)?, 1.0)
    };
    Some(ColorEntry {
        hex,
        alpha,
        comp: text(v, &["comp", "compName"]),
        comp_id: v.get("compId").and_then(Value::as_i64),
        layer_index: v.get("layerIndex").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).filter(|n| *n >= 1),
        layer: text(v, &["layer", "layerName"]),
        property: text(v, &["property", "propertyPath"]),
    })
}

pub fn get(root: &Path) -> AppResult<ColorsView> {
    let path = root.join(COLORS_JSON);
    if !path.exists() && !safe_fs::backup_path(&path).exists() {
        return Ok(ColorsView::default());
    }
    let (doc, _): (Value, _) = safe_fs::read_json(&path)?;
    if doc
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .is_some_and(|v| v > SUPPORTED_SCHEMA)
    {
        return invalid("These colors were saved by a newer version of the Companion.");
    }
    let raw = match doc.get("colors") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(a)) => a.as_slice(),
        Some(_) => return invalid("colors.json has an unexpected format."),
    };
    let mut view = ColorsView {
        last_scan_at: doc
            .get("lastScanAt")
            .filter(|v| v.is_string() || v.is_number())
            .cloned(),
        ..Default::default()
    };
    for (i, item) in raw.iter().enumerate() {
        if i >= MAX_ENTRIES {
            view.truncated = raw.len() - MAX_ENTRIES;
            break;
        }
        match parse_entry(item) {
            Some(e) => view.colors.push(e),
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
        fs::write(d.path().join(COLORS_JSON), doc).unwrap();
        d
    }

    #[test]
    fn missing_file_and_fresh_shell_are_empty() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(get(d.path()).unwrap(), ColorsView::default());
        let d = project_with(r#"{"schemaVersion":1,"lastScanAt":null,"colors":[]}"#);
        let v = get(d.path()).unwrap();
        assert!(v.colors.is_empty() && v.last_scan_at.is_none());
    }

    #[test]
    fn reads_native_float_colors_and_hex() {
        let d = project_with(
            &json!({"schemaVersion":1,"lastScanAt":"2026-10-26T12:00:00Z","colors":[
                {"color":[1,0.5,0,1],"comp":"Main","layer":"Title","property":"Fill"},
                {"color":[0,0,0],"compName":"B"},
                {"hex":"#a1b2c3","layerName":"L"},
            ]})
            .to_string(),
        );
        let v = get(d.path()).unwrap();
        assert_eq!(v.colors.len(), 3);
        assert_eq!(v.colors[0].hex, "#FF8000");
        assert_eq!(v.colors[0].comp.as_deref(), Some("Main"));
        assert_eq!(v.colors[1].hex, "#000000");
        assert_eq!(v.colors[1].comp.as_deref(), Some("B"));
        assert_eq!(v.colors[2].hex, "#A1B2C3");
        assert_eq!(v.last_scan_at, Some(json!("2026-10-26T12:00:00Z")));
        assert_eq!(v.skipped, 0);
    }

    #[test]
    fn bad_entries_are_skipped_and_counted() {
        let d = project_with(
            &json!({"schemaVersion":1,"colors":[
                {"color":[2,0,0]}, {"color":[0,0]}, {"color":"red"}, {"hex":"#12"},
                "x", null, {"color":[0,0,0,5]}, {"color":[0,1,0]}
            ]})
            .to_string(),
        );
        let v = get(d.path()).unwrap();
        assert_eq!((v.colors.len(), v.skipped), (1, 7));
        assert_eq!(v.colors[0].hex, "#00FF00");
    }

    #[test]
    fn newer_schema_and_wrong_shape_are_errors_not_silent() {
        let d = project_with(r#"{"schemaVersion":9,"colors":[]}"#);
        assert!(get(d.path()).is_err());
        let d = project_with(r#"{"schemaVersion":1,"colors":{"a":1}}"#);
        assert!(get(d.path()).is_err());
        let d = project_with("not json");
        assert!(get(d.path()).is_err());
    }

    #[test]
    fn reading_never_modifies_the_file() {
        let doc = r##"{"schemaVersion":1,"extra":true,"colors":[{"hex":"#FFFFFF"}]}"##;
        let d = project_with(doc);
        get(d.path()).unwrap();
        assert_eq!(fs::read_to_string(d.path().join(COLORS_JSON)).unwrap(), doc);
    }

    #[test]
    fn long_text_is_clipped() {
        let long = "x".repeat(1000);
        let d = project_with(&json!({"colors":[{"hex":"#000000","layer":long}]}).to_string());
        assert_eq!(
            get(d.path()).unwrap().colors[0]
                .layer
                .as_ref()
                .unwrap()
                .len(),
            MAX_TEXT
        );
    }

    /// A file exactly as written by the After Effects Companion (see murre-ae), so the
    /// two cannot drift apart without a test failing.
    #[test]
    fn reads_a_file_written_by_the_companion() {
        let d = project_with(include_str!("../tests/fixtures/companion/colors.json"));
        let v = get(d.path()).unwrap();
        assert_eq!(v.skipped, 0);
        assert_eq!(v.colors.len(), 4);
        assert_eq!(v.colors[0].hex, "#FF8000");
        assert_eq!(v.colors[0].comp.as_deref(), Some("Main"));
        assert_eq!(v.colors[0].layer.as_deref(), Some("Title"));
        assert_eq!(
            v.colors[0].property.as_deref(),
            Some("Contents > Rectangle 1 > Fill 1 > Color")
        );
        assert_eq!(v.colors[1].hex, "#336699");
        assert_eq!(v.last_scan_at, Some(json!("2026-10-26T12:00:00.000Z")));
    }

    #[test]
    fn reads_the_comp_id_and_layer_position_used_for_jumping() {
        let e = parse_entry(&serde_json::json!({"color":[1,0,0],"comp":"Main","compId":7,"layer":"L","layerIndex":3,"property":"Fill"})).unwrap();
        assert_eq!((e.comp_id, e.layer_index), (Some(7), Some(3)));
        let old = parse_entry(&serde_json::json!({"color":[1,0,0],"layer":"L","layerIndex":0})).unwrap();
        assert_eq!((old.comp_id, old.layer_index), (None, None));
    }
}
