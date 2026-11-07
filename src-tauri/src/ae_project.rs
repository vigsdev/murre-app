//! Helpers for the project file that After Effects creates for a new project.
//!
//! The file itself is made by After Effects through the Companion; nothing is bundled.

use crate::aerender::Install;
use serde::Serialize;

/// The folder (inside a project) that holds After Effects projects.
pub const WORKFILE_DIR: &str = "01 AE Workfile";

fn file_stem(project_name: &str) -> String {
    let cleaned: String = project_name
        .chars()
        .map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':') { '-' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().to_string();
    if cleaned.is_empty() { "Project".into() } else { cleaned }
}

/// Where the project file for `project_name` goes, relative to the project folder.
pub fn target_rel(project_name: &str) -> String {
    format!("{WORKFILE_DIR}/{}-v1.aep", file_stem(project_name))
}

/// What happened when After Effects was asked to create the project file.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateOutcome {
    /// The new file, relative to the project folder.
    pub added: Option<String>,
    /// Where the project that was open before was saved (it is closed afterwards).
    pub previous: Option<String>,
    /// Why nothing was created.
    pub message: Option<String>,
    /// The person pressed Cancel while Murre waited.
    pub cancelled: bool,
}

/// A detected After Effects install.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallOption {
    /// The aerender path (identifies the install everywhere else in the app).
    pub path: String,
    pub label: String,
    pub version: Option<String>,
}

pub fn options_for(installs: &[Install]) -> Vec<InstallOption> {
    installs
        .iter()
        .map(|i| InstallOption { path: i.path.clone(), label: i.label.clone(), version: i.version.clone() })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_goes_in_the_workfile_folder_with_a_safe_name() {
        assert_eq!(target_rel("Spring Promo"), "01 AE Workfile/Spring Promo-v1.aep");
        assert_eq!(target_rel("a/b:c"), "01 AE Workfile/a-b-c-v1.aep");
        assert_eq!(target_rel("  "), "01 AE Workfile/Project-v1.aep");
        assert!(!target_rel("../x").contains("/../"));
    }

    #[test]
    fn installs_keep_their_path_label_and_version() {
        let i = Install { path: "/A/aerender".into(), label: "Adobe After Effects 2026".into(), version: Some("26.0".into()) };
        let o = options_for(&[i]);
        assert_eq!(o[0].path, "/A/aerender");
        assert_eq!(o[0].version.as_deref(), Some("26.0"));
    }
}
