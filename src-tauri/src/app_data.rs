//! Layout of the application data directory (profile, database, global notes
//! and reference canvas live here; per-project data lives in each project).

use crate::error::{AppError, AppResult};
use std::fs;
use std::path::{Path, PathBuf};

pub struct AppPaths {
    pub root: PathBuf,
    pub database: PathBuf,
}

impl AppPaths {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            database: root.join("murre.db"),
        }
    }

    pub fn ensure(&self) -> AppResult<()> {
        fs::create_dir_all(&self.root).map_err(|e| AppError::io(&self.root, e))
    }
}

/// The app used to be called Sequenxe: its data lived in `com.vigs.sequenxe` and the database was `sequenxe.db`. Before the
/// folder is used, move that data to the new name so the profile, project list and notes carry over. Nothing is copied or
/// deleted: the old folder is renamed, and only when the new one does not exist yet. Failures are ignored (the app then
/// starts empty, and the old folder is still there).
pub fn migrate_legacy(root: &Path) {
    if let Some(parent) = root.parent() {
        let old = parent.join("com.vigs.sequenxe");
        if !root.exists() && old.is_dir() {
            let _ = fs::rename(&old, root);
        }
    }
    if !root.join("murre.db").exists() {
        for suffix in ["", "-wal", "-shm"] {
            let from = root.join(format!("sequenxe.db{suffix}"));
            if from.is_file() {
                let _ = fs::rename(&from, root.join(format!("murre.db{suffix}")));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_sequenxe_data_moves_to_the_new_name_and_nothing_is_replaced() {
        let d = tempfile::tempdir().unwrap();
        let old = d.path().join("com.vigs.sequenxe");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("sequenxe.db"), "db").unwrap();
        fs::write(old.join("sequenxe.db-wal"), "wal").unwrap();
        fs::write(old.join("profile.json"), "p").unwrap();
        let root = d.path().join("com.vigs.murre");
        migrate_legacy(&root);
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(root.join("murre.db")).unwrap(), "db");
        assert_eq!(fs::read_to_string(root.join("murre.db-wal")).unwrap(), "wal");
        assert_eq!(fs::read_to_string(root.join("profile.json")).unwrap(), "p");
        // Running again changes nothing.
        migrate_legacy(&root);
        assert_eq!(fs::read_to_string(root.join("murre.db")).unwrap(), "db");

        // An existing new folder is never touched, and the old one stays where it is.
        let d2 = tempfile::tempdir().unwrap();
        fs::create_dir_all(d2.path().join("com.vigs.sequenxe")).unwrap();
        fs::create_dir_all(d2.path().join("com.vigs.murre")).unwrap();
        fs::write(d2.path().join("com.vigs.murre/murre.db"), "new").unwrap();
        migrate_legacy(&d2.path().join("com.vigs.murre"));
        assert!(d2.path().join("com.vigs.sequenxe").is_dir());
        assert_eq!(fs::read_to_string(d2.path().join("com.vigs.murre/murre.db")).unwrap(), "new");
    }

    #[test]
    fn ensure_creates_nested_root() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(&dir.path().join("a/b"));
        paths.ensure().unwrap();
        paths.ensure().unwrap();
        assert!(paths.root.is_dir());
        assert_eq!(paths.database, dir.path().join("a/b/murre.db"));
    }
}
