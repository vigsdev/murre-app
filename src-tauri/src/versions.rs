//! Other versions of the project that is open in After Effects: `.aep` files saved next to it.
//!
//! "Add this project to Murre" saves a copy of the open file. People usually keep `Film_v1.aep`, `Film_v2.aep` and so
//! on in the same folder, so this lists those files and, for the ones the person picks, copies them into the new
//! project's workfile folder. The originals are only read. Only the same folder is looked at; auto-save and hidden
//! files are skipped; nothing is overwritten.

use crate::workfiles::{normalize_base, parse_version, strip_notes};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// The most files one import copies, and the most listed.
pub const MAX_VERSIONS: usize = 30;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// File name only.
    pub name: String,
    pub size: u64,
    /// Seconds since 1970, when known.
    pub modified: Option<i64>,
    /// Same base name as the open project (`Film_v2` next to `Film_v3`), so it is probably another version of it.
    pub suggested: bool,
}

fn key(stem: &str) -> String {
    parse_version(stem).map(|(base, _)| base).unwrap_or_else(|| normalize_base(&strip_notes(stem)))
}

fn skipped(name: &str) -> bool {
    let l = name.to_lowercase();
    name.starts_with('.') || name.starts_with('~') || l.contains("auto-save") || l.contains("autosave") || !l.ends_with(".aep")
}

/// `.aep` files in the same folder as `open_path`, other than that file. Files that look like versions of it come first.
pub fn find(open_path: &Path) -> Vec<Candidate> {
    let (Some(dir), Some(open_name)) = (open_path.parent(), open_path.file_name().and_then(|n| n.to_str())) else {
        return Vec::new();
    };
    let open_key = key(Path::new(open_name).file_stem().and_then(|s| s.to_str()).unwrap_or(open_name));
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<Candidate> = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if name == open_name || skipped(&name) {
            continue;
        }
        // Real files only: a link could point anywhere.
        let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
        if !meta.is_file() {
            continue;
        }
        let stem = Path::new(&name).file_stem().and_then(|s| s.to_str()).unwrap_or(&name).to_string();
        let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64);
        out.push(Candidate { suggested: key(&stem) == open_key, name, size: meta.len(), modified });
    }
    // Suggested first, then newest first, then by name so the order is stable.
    out.sort_by(|a, b| b.suggested.cmp(&a.suggested).then(b.modified.cmp(&a.modified)).then(a.name.cmp(&b.name)));
    out.truncate(MAX_VERSIONS);
    out
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CopyReport {
    pub copied: Vec<String>,
    /// File name and why it was not copied.
    pub failed: Vec<(String, String)>,
}

/// Copy the named files from beside `open_path` into `dest_dir`. A name must be a plain `.aep` file name that is in that
/// folder as a real file; an existing file in `dest_dir` is never replaced.
pub fn copy_selected(open_path: &Path, names: &[String], dest_dir: &Path) -> CopyReport {
    let mut report = CopyReport::default();
    let Some(src_dir) = open_path.parent() else { return report };
    let open_name = open_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    for name in names.iter().take(MAX_VERSIONS) {
        let mut fail = |why: &str| report.failed.push((name.clone(), why.to_string()));
        if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." || skipped(name) || name == open_name {
            fail("not a version file");
            continue;
        }
        let src = src_dir.join(name);
        match fs::symlink_metadata(&src) {
            Ok(m) if m.is_file() => {}
            _ => {
                fail("not found");
                continue;
            }
        }
        let dest = dest_dir.join(name);
        let result = (|| -> io::Result<()> {
            let mut from = fs::File::open(&src)?;
            let modified = from.metadata().and_then(|m| m.modified()).ok();
            // `create_new` fails if the file exists, so nothing is replaced.
            let mut to = OpenOptions::new().write(true).create_new(true).open(&dest)?;
            if let Err(e) = io::copy(&mut from, &mut to) {
                drop(to);
                let _ = fs::remove_file(&dest);
                return Err(e);
            }
            to.sync_all()?;
            // Keep the date the version was saved, so the version list still tells which one is newest. A failure here only
            // leaves the copy's own date, which is not worth failing the copy for.
            if let Some(t) = modified {
                let _ = to.set_modified(t);
            }
            Ok(())
        })();
        match result {
            Ok(()) => report.copied.push(name.clone()),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => fail("a file with this name is already there"),
            Err(e) => fail(&e.to_string()),
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str, body: &str) {
        fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn lists_siblings_and_suggests_same_base_name() {
        let d = tempfile::tempdir().unwrap();
        for n in ["Film_v1.aep", "Film_v2.aep", "Film_v3.aep", "Other.aep", "notes.txt", ".hidden.aep", "Film_v2-autosave.aep"] {
            touch(d.path(), n, "x");
        }
        fs::create_dir(d.path().join("Adobe After Effects Auto-Save")).unwrap();
        let found = find(&d.path().join("Film_v3.aep"));
        let names: Vec<_> = found.iter().map(|c| (c.name.as_str(), c.suggested)).collect();
        assert!(names.contains(&("Film_v1.aep", true)));
        assert!(names.contains(&("Film_v2.aep", true)));
        assert!(names.contains(&("Other.aep", false)));
        assert_eq!(found.len(), 3, "the open file, hidden, auto-save and non-aep files are left out: {names:?}");
        assert!(found[0].suggested && found[1].suggested && !found[2].suggested, "suggested files come first");
    }

    #[test]
    fn a_note_in_brackets_does_not_hide_the_family() {
        let d = tempfile::tempdir().unwrap();
        for n in ["Band 5.aep", "Band 6 (converted).aep", "Band.aep", "Other.aep"] {
            touch(d.path(), n, "x");
        }
        let found = find(&d.path().join("Band 6 (converted).aep"));
        let mut same: Vec<_> = found.iter().filter(|c| c.suggested).map(|c| c.name.as_str()).collect();
        same.sort();
        assert_eq!(same, vec!["Band 5.aep", "Band.aep"]);
    }

    #[test]
    fn an_unversioned_open_file_matches_versioned_siblings() {
        let d = tempfile::tempdir().unwrap();
        touch(d.path(), "Film.aep", "x");
        touch(d.path(), "Film_v1.aep", "x");
        touch(d.path(), "Logo_v1.aep", "x");
        let found = find(&d.path().join("Film.aep"));
        assert_eq!(found.iter().filter(|c| c.suggested).map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["Film_v1.aep"]);
    }

    #[test]
    fn copies_only_what_is_asked_and_never_overwrites() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        touch(src.path(), "Film_v1.aep", "one");
        touch(src.path(), "Film_v2.aep", "two");
        touch(src.path(), "Film_v3.aep", "three");
        touch(dst.path(), "Film_v2.aep", "already here");
        let names = vec!["Film_v1.aep".to_string(), "Film_v2.aep".to_string(), "../x.aep".to_string(), "Film_v3.aep".to_string(), "missing.aep".to_string()];
        let r = copy_selected(&src.path().join("Film_v3.aep"), &names, dst.path());
        assert_eq!(r.copied, vec!["Film_v1.aep"]);
        assert_eq!(fs::read_to_string(dst.path().join("Film_v1.aep")).unwrap(), "one");
        assert_eq!(fs::read_to_string(dst.path().join("Film_v2.aep")).unwrap(), "already here");
        assert_eq!(r.failed.len(), 4);
        assert!(!dst.path().join("Film_v3.aep").exists(), "the open file is saved by After Effects, not copied here");
        assert_eq!(fs::read_to_string(src.path().join("Film_v1.aep")).unwrap(), "one", "originals are untouched");
    }

    #[test]
    fn a_copy_keeps_the_original_modified_date() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        touch(src.path(), "Film_v1.aep", "one");
        touch(src.path(), "Film_v2.aep", "two");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60 * 60 * 24 * 90);
        fs::OpenOptions::new().write(true).open(src.path().join("Film_v1.aep")).unwrap().set_modified(old).unwrap();
        let r = copy_selected(&src.path().join("Film_v2.aep"), &["Film_v1.aep".to_string()], dst.path());
        assert_eq!(r.copied, vec!["Film_v1.aep"]);
        let got = fs::metadata(dst.path().join("Film_v1.aep")).unwrap().modified().unwrap();
        let diff = old.duration_since(got).or_else(|e| Ok::<_, ()>(e.duration())).unwrap();
        assert!(diff < std::time::Duration::from_secs(2), "the copy has the original date, not today's");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_not_copied() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        touch(outside.path(), "secret.aep", "s");
        touch(src.path(), "Film_v2.aep", "x");
        std::os::unix::fs::symlink(outside.path().join("secret.aep"), src.path().join("Film_v1.aep")).unwrap();
        assert!(find(&src.path().join("Film_v2.aep")).is_empty());
        let r = copy_selected(&src.path().join("Film_v2.aep"), &["Film_v1.aep".to_string()], dst.path());
        assert!(r.copied.is_empty());
    }
}
