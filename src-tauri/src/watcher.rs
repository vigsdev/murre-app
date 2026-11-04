//! Live updates for the project that is open on screen.
//!
//! Only one project is watched at a time (the one in the detail view), so a
//! large library of footage on many drives never costs anything in the
//! background. Raw file events are debounced, filtered and turned into a small
//! "something changed" message; the UI decides what to re-read. The watcher only
//! observes: it never writes to the project folder.

use serde::Serialize;
use std::path::{Component, Path};

/// What changed in a watched project, as sent to the UI.
#[derive(Serialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub project_id: String,
    /// Names of metadata files directly inside `.murre/` that changed (e.g. `colors.json`).
    pub metadata: Vec<String>,
    /// Something outside `.murre/` changed (assets, renders, AEP files).
    pub files: bool,
    /// The project folder itself was removed or renamed.
    pub root_changed: bool,
}

impl Change {
    pub fn is_empty(&self) -> bool {
        self.metadata.is_empty() && !self.files && !self.root_changed
    }
}

/// Files that are noise rather than project changes.
fn is_ignored_name(name: &str) -> bool {
    name == ".DS_Store" || name.starts_with("._") || name.ends_with('~')
}

/// Sort changed paths into a [`Change`]. Pure, so it can be tested without a watcher.
pub fn classify<'a>(
    project_id: &str,
    root: &Path,
    paths: impl IntoIterator<Item = &'a Path>,
) -> Change {
    let mut change = Change {
        project_id: project_id.to_string(),
        ..Default::default()
    };
    for path in paths {
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let parts: Vec<_> = rel
            .components()
            .filter_map(|c| match c {
                Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        let Some(first) = parts.first() else {
            change.root_changed = true;
            continue;
        };
        if parts.last().is_some_and(|n| is_ignored_name(n)) {
            continue;
        }
        if first == ".murre" {
            // Only top-level metadata files matter; our own temp/backup files and the
            // references media folder are not changes worth reacting to.
            if parts.len() == 2 {
                let name = &parts[1];
                if name.ends_with(".json") && !name.contains(".tmp-") {
                    if !change.metadata.contains(name) {
                        change.metadata.push(name.clone());
                    }
                }
            }
        } else {
            change.files = true;
        }
    }
    change
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn run(paths: &[&str]) -> Change {
        let root = PathBuf::from("/p/Proj");
        let owned: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        classify("id1", &root, owned.iter().map(|p| p.as_path()))
    }

    #[test]
    fn companion_files_are_reported_by_name_once() {
        let c = run(&[
            "/p/Proj/.murre/colors.json",
            "/p/Proj/.murre/colors.json",
            "/p/Proj/.murre/expressions.json",
        ]);
        assert_eq!(c.metadata, vec!["colors.json", "expressions.json"]);
        assert!(!c.files && !c.root_changed);
        assert_eq!(c.project_id, "id1");
    }

    #[test]
    fn our_own_temp_backup_and_media_files_are_ignored() {
        let c = run(&[
            "/p/Proj/.murre/colors.json.tmp-123-4",
            "/p/Proj/.murre/colors.json.bak",
            "/p/Proj/.murre/colors.json.corrupt",
            "/p/Proj/.murre/references/media/abc.png",
            "/p/Proj/.murre/references/references.json",
        ]);
        assert!(c.is_empty(), "{c:?}");
    }

    #[test]
    fn project_files_outside_metadata_set_the_files_flag() {
        let c = run(&["/p/Proj/06 Renders/final.mov"]);
        assert!(c.files && c.metadata.is_empty());
    }

    #[test]
    fn finder_noise_is_ignored() {
        assert!(
            run(&[
                "/p/Proj/.DS_Store",
                "/p/Proj/01 AE/._x.aep",
                "/p/Proj/a.txt~"
            ])
            .is_empty()
        );
    }

    #[test]
    fn the_root_itself_changing_is_reported() {
        let c = run(&["/p/Proj"]);
        assert!(c.root_changed);
    }

    #[test]
    fn paths_outside_the_project_are_ignored() {
        assert!(run(&["/elsewhere/file.txt"]).is_empty());
    }

    #[test]
    fn a_real_watcher_reports_companion_and_project_file_changes() {
        use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode};
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join(".murre")).unwrap();
        std::fs::create_dir_all(root.join("06 Renders")).unwrap();

        let (tx, rx) = mpsc::channel();
        let watch_root = root.clone();
        let mut d = new_debouncer(
            Duration::from_millis(100),
            move |res: notify_debouncer_mini::DebounceEventResult| {
                if let Ok(events) = res {
                    let _ = tx.send(classify(
                        "p",
                        &watch_root,
                        events.iter().map(|e| e.path.as_path()),
                    ));
                }
            },
        )
        .unwrap();
        d.watcher().watch(&root, RecursiveMode::Recursive).unwrap();

        std::fs::write(root.join(".murre/colors.json"), "{}").unwrap();
        std::fs::write(root.join("06 Renders/out.mov"), "x").unwrap();

        let mut seen = Change::default();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline && !(seen.files && !seen.metadata.is_empty()) {
            if let Ok(c) = rx.recv_timeout(Duration::from_millis(200)) {
                seen.files |= c.files;
                for m in c.metadata {
                    if !seen.metadata.contains(&m) {
                        seen.metadata.push(m);
                    }
                }
            }
        }
        assert_eq!(seen.metadata, vec!["colors.json"]);
        assert!(seen.files);
    }
}
