//! Per-project Companion settings, stored in `.murre/settings.json`.
//!
//! The app writes this file and shows it in the project's Settings tab. The Companion reads it before each scan so the
//! settings travel with the project folder, and its right-click menu changes `copyRelinkOnScan` and `autoScanMinutes` in
//! the same file, so the menu and this tab always agree.

use crate::error::AppResult;
use crate::project::invalid;
use crate::safe_fs;
use serde::{Deserialize, Serialize};
use std::path::Path;

const SETTINGS_JSON: &str = ".murre/settings.json";
const SCHEMA_VERSION: u32 = 1;
/// Minutes between automatic scans; 0 is off.
/// The same list the Companion panel's right-click menu offers, so the two always agree.
pub const AUTO_SCAN_CHOICES: [u32; 4] = [0, 5, 10, 20];

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    #[serde(default = "schema")]
    pub schema_version: u32,
    /// Copy outside footage into the project and relink it on every scan.
    #[serde(default)]
    pub copy_relink_on_scan: bool,
    /// After a verified copy, move the original file to the Trash. Only with `copy_relink_on_scan`.
    #[serde(default)]
    pub trash_originals: bool,
    /// Scan automatically every this many minutes while the project is open in After Effects (0 = off).
    #[serde(default)]
    pub auto_scan_minutes: u32,
}

fn schema() -> u32 {
    SCHEMA_VERSION
}

impl Default for ProjectSettings {
    fn default() -> Self {
        ProjectSettings { schema_version: SCHEMA_VERSION, copy_relink_on_scan: false, trash_originals: false, auto_scan_minutes: 0 }
    }
}

/// The saved settings, or the defaults when there is no file yet.
pub fn get(root: &Path) -> AppResult<ProjectSettings> {
    let path = root.join(SETTINGS_JSON);
    if !path.exists() && !safe_fs::backup_path(&path).exists() {
        return Ok(ProjectSettings::default());
    }
    let (s, _): (ProjectSettings, _) = safe_fs::read_json(&path)?;
    if s.schema_version > SCHEMA_VERSION {
        return invalid("These settings were saved by a newer version of Murre.");
    }
    Ok(s)
}

pub fn save(root: &Path, mut s: ProjectSettings) -> AppResult<ProjectSettings> {
    if !AUTO_SCAN_CHOICES.contains(&s.auto_scan_minutes) {
        return invalid("Choose Off, 5, 10 or 20 minutes.");
    }
    // Originals are only moved after a copy, so the option means nothing without it.
    if !s.copy_relink_on_scan {
        s.trash_originals = false;
    }
    s.schema_version = SCHEMA_VERSION;
    safe_fs::write_json(&root.join(SETTINGS_JSON), &s)?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".murre")).unwrap();
        d
    }

    #[test]
    fn defaults_are_all_off_and_nothing_is_written_by_reading() {
        let d = project();
        assert_eq!(get(d.path()).unwrap(), ProjectSettings::default());
        assert!(!d.path().join(SETTINGS_JSON).exists());
    }

    #[test]
    fn saves_and_reads_back() {
        let d = project();
        let s = ProjectSettings { copy_relink_on_scan: true, trash_originals: true, auto_scan_minutes: 10, ..Default::default() };
        assert_eq!(save(d.path(), s.clone()).unwrap(), s);
        assert_eq!(get(d.path()).unwrap(), s);
        let text = std::fs::read_to_string(d.path().join(SETTINGS_JSON)).unwrap();
        assert!(text.contains("copyRelinkOnScan") && text.contains("autoScanMinutes"), "{text}");
    }

    #[test]
    fn moving_originals_needs_copy_and_relink() {
        let d = project();
        let s = ProjectSettings { trash_originals: true, ..Default::default() };
        assert!(!save(d.path(), s).unwrap().trash_originals);
    }

    #[test]
    fn only_the_offered_intervals_are_accepted() {
        let d = project();
        for bad in [1, 7, 60, 9999] {
            assert!(save(d.path(), ProjectSettings { auto_scan_minutes: bad, ..Default::default() }).is_err(), "{bad}");
        }
        for ok in AUTO_SCAN_CHOICES {
            assert!(save(d.path(), ProjectSettings { auto_scan_minutes: ok, ..Default::default() }).is_ok());
        }
    }

    #[test]
    fn a_file_from_a_newer_version_is_refused_and_left_alone() {
        let d = project();
        std::fs::write(d.path().join(SETTINGS_JSON), r#"{"schemaVersion":99}"#).unwrap();
        assert!(get(d.path()).is_err());
    }
}
