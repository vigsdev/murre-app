//! Expressions collected by the After Effects Companion, read from
//! `.murre/expressions.json`. Display only: the desktop app never writes
//! this file.
//!
//! Expected shape (the Companion owns the file; unknown keys are ignored):
//!
//! ```json
//! { "schemaVersion": 1, "lastScanAt": "2026-10-26T12:00:00Z",
//!   "expressions": [ { "expression": "wiggle(2, 30)", "comp": "Main",
//!                      "layer": "Title", "property": "Transform > Position",
//!                      "enabled": true } ] }
//! ```
//!
//! Entries without expression text are skipped and counted, not fatal.

use crate::error::AppResult;
use crate::project::invalid;
use crate::safe_fs;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

const EXPRESSIONS_JSON: &str = ".murre/expressions.json";
const SUPPORTED_SCHEMA: u64 = 1;
const MAX_ENTRIES: usize = 20_000;
const MAX_LABEL: usize = 300;
const MAX_EXPRESSION: usize = 100_000;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpressionEntry {
    pub expression: String,
    pub comp: Option<String>,
    /// After Effects item id of the composition, to jump to it. Missing in scans from older Companions.
    pub comp_id: Option<i64>,
    pub layer: Option<String>,
    /// Position of the layer in its composition (1 = top).
    pub layer_index: Option<u32>,
    pub property: Option<String>,
    /// `false` when After Effects has the expression switched off.
    pub enabled: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExpressionsView {
    /// Passed through as written (ISO string or epoch number), or `null`.
    pub last_scan_at: Option<Value>,
    pub expressions: Vec<ExpressionEntry>,
    /// Entries in the file that could not be read.
    pub skipped: usize,
    /// Entries beyond the display limit.
    pub truncated: usize,
}

fn label(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(MAX_LABEL).collect())
}

/// `\r\n` and a lone `\r` become `\n`.
fn normalize_newlines(code: &str) -> String {
    code.replace("\r\n", "\n").replace('\r', "\n")
}

fn parse_entry(v: &Value) -> Option<ExpressionEntry> {
    if !v.is_object() {
        return None;
    }
    // Keep the expression as written (whitespace matters when copying), but ignore blank ones.
    // After Effects separates lines with a bare carriage return (`\r`), which a web page does
    // not show as a line break, so line endings are normalised to `\n`.
    let code = v.get("expression")?.as_str()?;
    if code.trim().is_empty() {
        return None;
    }
    Some(ExpressionEntry {
        expression: normalize_newlines(code).chars().take(MAX_EXPRESSION).collect(),
        comp: label(v, &["comp", "compName"]),
        comp_id: v.get("compId").and_then(Value::as_i64),
        layer_index: v.get("layerIndex").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).filter(|n| *n >= 1),
        layer: label(v, &["layer", "layerName"]),
        property: label(v, &["property", "propertyPath"]),
        enabled: v.get("enabled").and_then(Value::as_bool).unwrap_or(true),
    })
}

pub fn get(root: &Path) -> AppResult<ExpressionsView> {
    let path = root.join(EXPRESSIONS_JSON);
    if !path.exists() && !safe_fs::backup_path(&path).exists() {
        return Ok(ExpressionsView::default());
    }
    let (doc, _): (Value, _) = safe_fs::read_json(&path)?;
    if doc
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .is_some_and(|v| v > SUPPORTED_SCHEMA)
    {
        return invalid("These expressions were saved by a newer version of the Companion.");
    }
    let raw = match doc.get("expressions") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(a)) => a.as_slice(),
        Some(_) => return invalid("expressions.json has an unexpected format."),
    };
    let mut view = ExpressionsView {
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
            Some(e) => view.expressions.push(e),
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
        fs::write(d.path().join(EXPRESSIONS_JSON), doc).unwrap();
        d
    }

    #[test]
    fn missing_file_and_fresh_shell_are_empty() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(get(d.path()).unwrap(), ExpressionsView::default());
        let d = project_with(r#"{"schemaVersion":1,"lastScanAt":null,"expressions":[]}"#);
        let v = get(d.path()).unwrap();
        assert!(v.expressions.is_empty() && v.last_scan_at.is_none());
    }

    #[test]
    fn after_effects_carriage_returns_become_line_breaks() {
        let d = project_with(
            &json!({"schemaVersion":1,"expressions":[
                {"expression":"a = 1;\rb = 2;\r\nc = 3;\n\rd"}
            ]})
            .to_string(),
        );
        let v = get(d.path()).unwrap();
        assert_eq!(v.expressions[0].expression, "a = 1;\nb = 2;\nc = 3;\n\nd");
    }

    #[test]
    fn reads_entries_and_keeps_expression_text_exactly() {
        let code = "var a = 1;\n  wiggle(2, 30)\n";
        let d = project_with(
            &json!({"schemaVersion":1,"lastScanAt":1790000000,"expressions":[
                {"expression":code,"comp":"Main","layer":"Title","property":"Position"},
                {"expression":"time*10","compName":"B","layerName":"L","propertyPath":"Rotation","enabled":false},
            ]})
            .to_string(),
        );
        let v = get(d.path()).unwrap();
        assert_eq!(v.expressions.len(), 2);
        assert_eq!(v.expressions[0].expression, code);
        assert!(v.expressions[0].enabled);
        assert_eq!(v.expressions[1].comp.as_deref(), Some("B"));
        assert_eq!(v.expressions[1].property.as_deref(), Some("Rotation"));
        assert!(!v.expressions[1].enabled);
        assert_eq!(v.last_scan_at, Some(json!(1790000000)));
    }

    #[test]
    fn blank_and_malformed_entries_are_skipped_and_counted() {
        let d = project_with(
            &json!({"expressions":[
                {"expression":""}, {"expression":"   "}, {"expression":5}, {"comp":"x"},
                "x", null, {"expression":"ok"}
            ]})
            .to_string(),
        );
        let v = get(d.path()).unwrap();
        assert_eq!((v.expressions.len(), v.skipped), (1, 6));
    }

    #[test]
    fn newer_schema_and_wrong_shape_are_errors_not_silent() {
        let d = project_with(r#"{"schemaVersion":9,"expressions":[]}"#);
        assert!(get(d.path()).is_err());
        let d = project_with(r#"{"schemaVersion":1,"expressions":"x"}"#);
        assert!(get(d.path()).is_err());
        let d = project_with("not json");
        assert!(get(d.path()).is_err());
    }

    #[test]
    fn reading_never_modifies_the_file() {
        let doc = r#"{"schemaVersion":1,"extra":true,"expressions":[{"expression":"x"}]}"#;
        let d = project_with(doc);
        get(d.path()).unwrap();
        assert_eq!(
            fs::read_to_string(d.path().join(EXPRESSIONS_JSON)).unwrap(),
            doc
        );
    }

    /// A file exactly as written by the After Effects Companion (see murre-ae), so the
    /// two cannot drift apart without a test failing.
    #[test]
    fn reads_a_file_written_by_the_companion() {
        let d = project_with(include_str!("../tests/fixtures/companion/expressions.json"));
        let v = get(d.path()).unwrap();
        assert_eq!(v.skipped, 0);
        assert_eq!(v.expressions.len(), 2);
        assert_eq!(v.expressions[0].expression, "var a = 1;\n  wiggle(2, 30)\n");
        assert_eq!(v.expressions[0].comp.as_deref(), Some("Main"));
        assert_eq!(
            v.expressions[0].property.as_deref(),
            Some("Transform > Position")
        );
        assert!(v.expressions[0].enabled);
        assert!(!v.expressions[1].enabled);
    }

    #[test]
    fn reads_the_comp_id_and_layer_position_used_for_jumping() {
        let e = parse_entry(&json!({"expression":"x","comp":"Main","compId":7,"layer":"L","layerIndex":3})).unwrap();
        assert_eq!((e.comp_id, e.layer_index), (Some(7), Some(3)));
        let old = parse_entry(&json!({"expression":"x","layerIndex":-1})).unwrap();
        assert_eq!((old.comp_id, old.layer_index), (None, None));
    }
}
