//! Safe file primitives for Murre metadata.
//!
//! * Writes are atomic: data goes to a temp file in the same directory, is
//!   fsynced, then renamed over the target.
//! * Before an existing file is replaced, its previous valid content is kept
//!   as `<name>.bak`.
//! * JSON is validated before it is written and before it is trusted on read;
//!   a corrupt primary file falls back to the backup.
//! * Writes to the same path are serialized within the process.

use crate::error::{AppError, AppResult};
use serde::{Serialize, de::DeserializeOwned};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn lock_for(path: &Path) -> Arc<Mutex<()>> {
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard.entry(path.to_path_buf()).or_default().clone()
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

pub fn backup_path(path: &Path) -> PathBuf {
    sibling(path, ".bak")
}

fn is_valid_json(path: &Path) -> bool {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some()
}

fn write_temp(path: &Path, bytes: &[u8]) -> AppResult<PathBuf> {
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = sibling(path, &format!(".tmp-{}-{n}", std::process::id()));
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| AppError::io(&tmp, e))?;
        f.write_all(bytes).map_err(|e| AppError::io(&tmp, e))?;
        f.sync_all().map_err(|e| AppError::io(&tmp, e))
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(tmp)
}

fn sync_parent_dir(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
}

/// Atomically create or replace `path` with `bytes`.
///
/// If `path` already exists, its content is first preserved as a `.bak` file
/// (only when the existing content is itself valid JSON, so a good backup is
/// never overwritten by a corrupt file).
pub fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let lock = lock_for(path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let tmp = write_temp(path, bytes)?;
    if path.exists() && is_valid_json(path) {
        let bak = backup_path(path);
        if let Err(e) = fs::copy(path, &bak) {
            let _ = fs::remove_file(&tmp);
            return Err(AppError::io(bak, e));
        }
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::io(path, e));
    }
    sync_parent_dir(path);
    Ok(())
}

/// Create `path` with `bytes`, failing if it already exists. Used for files
/// that must never be overwritten (e.g. scaffolding a new project).
pub fn create_new(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let lock = lock_for(path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    if path.exists() {
        return Err(AppError::AlreadyExists(path.to_path_buf()));
    }
    let tmp = write_temp(path, bytes)?;
    // hard_link fails if the target exists, so a racing creator cannot be clobbered.
    let linked = fs::hard_link(&tmp, path);
    let _ = fs::remove_file(&tmp);
    match linked {
        Ok(()) => {
            sync_parent_dir(path);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(AppError::AlreadyExists(path.to_path_buf()))
        }
        Err(e) => Err(AppError::io(path, e)),
    }
}

fn to_pretty_json<T: Serialize>(path: &Path, value: &T) -> AppResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|source| AppError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Serialize `value` and atomically write it. Serialization happens first, so
/// an unserializable value never touches the existing file.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let bytes = to_pretty_json(path, value)?;
    atomic_write(path, &bytes)
}

/// Like [`write_json`] but refuses to replace an existing file.
pub fn create_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let bytes = to_pretty_json(path, value)?;
    create_new(path, &bytes)
}

fn parse_file<T: DeserializeOwned>(path: &Path) -> AppResult<T> {
    let bytes = fs::read(path).map_err(|e| AppError::io(path, e))?;
    serde_json::from_slice(&bytes).map_err(|source| AppError::Json {
        path: path.to_path_buf(),
        source,
    })
}

/// Where a successfully read value came from.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Source {
    Primary,
    /// The primary file was unreadable or invalid; the value came from `.bak`
    /// and the primary was restored from it.
    Backup,
}

/// Read and validate JSON at `path`. If the file is invalid, fall back to its
/// backup and restore the primary from it. Returns `Corrupt` if neither is
/// usable; the corrupt file is left in place for manual inspection.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> AppResult<(T, Source)> {
    let primary_err = match parse_file::<T>(path) {
        Ok(v) => return Ok((v, Source::Primary)),
        Err(e) => e,
    };
    let bak = backup_path(path);
    if bak.exists() {
        if let Ok(v) = parse_file::<T>(&bak) {
            let restored = fs::read(&bak).map_err(|e| AppError::io(&bak, e))?;
            // Keep the broken file around before restoring.
            if path.exists() {
                let _ = fs::copy(path, sibling(path, ".corrupt"));
            }
            let tmp = write_temp(path, &restored)?;
            fs::rename(&tmp, path).map_err(|e| {
                let _ = fs::remove_file(&tmp);
                AppError::io(path, e)
            })?;
            return Ok((v, Source::Backup));
        }
    }
    Err(AppError::Corrupt {
        path: path.to_path_buf(),
        detail: primary_err.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Doc {
        n: u32,
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        write_json(&p, &Doc { n: 1 }).unwrap();
        let (d, src): (Doc, _) = read_json(&p).unwrap();
        assert_eq!(d, Doc { n: 1 });
        assert_eq!(src, Source::Primary);
    }

    #[test]
    fn replacing_keeps_previous_version_as_backup() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        write_json(&p, &Doc { n: 1 }).unwrap();
        write_json(&p, &Doc { n: 2 }).unwrap();
        let (bak, _): (Doc, _) = read_json(&backup_path(&p)).unwrap();
        assert_eq!(bak, Doc { n: 1 });
    }

    #[test]
    fn corrupt_primary_recovers_from_backup() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        write_json(&p, &Doc { n: 1 }).unwrap();
        write_json(&p, &Doc { n: 2 }).unwrap();
        fs::write(&p, b"{ not json").unwrap();
        let (d, src): (Doc, _) = read_json(&p).unwrap();
        assert_eq!(d, Doc { n: 1 });
        assert_eq!(src, Source::Backup);
        // primary restored, broken copy preserved
        let (again, src2): (Doc, _) = read_json(&p).unwrap();
        assert_eq!((again, src2), (Doc { n: 1 }, Source::Primary));
        assert!(dir.path().join("a.json.corrupt").exists());
    }

    #[test]
    fn corrupt_file_never_overwrites_good_backup() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        write_json(&p, &Doc { n: 1 }).unwrap();
        write_json(&p, &Doc { n: 2 }).unwrap(); // bak = 1
        fs::write(&p, b"garbage").unwrap();
        write_json(&p, &Doc { n: 3 }).unwrap(); // must not copy garbage over bak
        let (bak, _): (Doc, _) = read_json(&backup_path(&p)).unwrap();
        assert_eq!(bak, Doc { n: 1 });
    }

    #[test]
    fn corrupt_without_backup_is_an_error_and_file_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        fs::write(&p, b"oops").unwrap();
        let err = read_json::<Doc>(&p).unwrap_err();
        assert!(matches!(err, AppError::Corrupt { .. }));
        assert_eq!(fs::read(&p).unwrap(), b"oops");
    }

    #[test]
    fn create_new_refuses_to_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("project.json");
        create_json(&p, &Doc { n: 1 }).unwrap();
        let err = create_json(&p, &Doc { n: 2 }).unwrap_err();
        assert!(matches!(err, AppError::AlreadyExists(_)));
        let (d, _): (Doc, _) = read_json(&p).unwrap();
        assert_eq!(d, Doc { n: 1 });
    }

    #[test]
    fn no_temp_files_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        write_json(&p, &Doc { n: 1 }).unwrap();
        write_json(&p, &Doc { n: 2 }).unwrap();
        create_json(&dir.path().join("b.json"), &Doc { n: 1 }).unwrap();
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn concurrent_writers_to_one_file_leave_valid_json() {
        let dir = tempfile::tempdir().unwrap();
        let p = Arc::new(dir.path().join("a.json"));
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let p = p.clone();
                std::thread::spawn(move || write_json(&p, &Doc { n: i }).unwrap())
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let (_d, src): (Doc, _) = read_json(&p).unwrap();
        assert_eq!(src, Source::Primary);
    }
}
