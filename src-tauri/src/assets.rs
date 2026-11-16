//! Browsing and opening real files inside a project folder.
//!
//! Everything here is read-only except launching the system "open" command for
//! one file. All paths coming from the UI are project-relative and are checked
//! so they cannot escape the project folder (`..`, absolute paths, or symlinks
//! pointing elsewhere).

use crate::error::{AppError, AppResult};
use crate::project::invalid;
use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_ENTRIES: usize = 5000;

/// Files that would run code when opened. They can still be revealed in Finder.
const BLOCKED_EXTENSIONS: &[&str] = &[
    "app", "command", "sh", "zsh", "bash", "tool", "pkg", "mpkg", "dmg", "scpt", "scptd",
    "workflow", "terminal", "jar", "exe", "bat", "cmd", "msi", "vbs", "ps1", "action", "service",
    "webloc", "url",
];

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Directory,
    File,
    /// Shown, but never followed or opened from the app.
    Symlink,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetEntry {
    pub name: String,
    /// Project-relative, `/`-separated.
    pub path: String,
    pub absolute_path: String,
    pub kind: EntryKind,
    pub size_bytes: Option<u64>,
    /// Unix seconds.
    pub modified_at: u64,
    /// Lowercase extension without the dot.
    pub extension: Option<String>,
    /// Whether the app will open it (regular file with a non-executable type).
    pub openable: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetListing {
    /// Project-relative folder being listed; empty for the project root.
    pub path: String,
    pub entries: Vec<AssetEntry>,
    /// The folder has more than the entry limit; the list is incomplete.
    pub truncated: bool,
}

/// Split a relative path into safe components. Rejects absolute paths, `..`, and prefixes.
pub(crate) fn safe_components(rel: &str) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(n) => out.push(n.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return invalid("That path is not inside the project folder."),
        }
    }
    Ok(out)
}

/// Resolve `rel` under `root`, following symlinks, and verify the result is still inside `root`.
pub(crate) fn resolve_inside(root: &Path, rel: &str) -> AppResult<(PathBuf, PathBuf, Vec<String>)> {
    let parts = safe_components(rel)?;
    let canon_root = crate::platform::canonicalize(root).map_err(|e| AppError::io(root, e))?;
    let lexical = parts.iter().fold(canon_root.clone(), |p, c| p.join(c));
    let canon = crate::platform::canonicalize(&lexical).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::Invalid("That file or folder no longer exists.".into())
        } else {
            AppError::io(&lexical, e)
        }
    })?;
    if !canon.starts_with(&canon_root) {
        return invalid("That path is not inside the project folder.");
    }
    Ok((canon_root, lexical, parts))
}

fn extension_of(name: &str) -> Option<String> {
    let ext = Path::new(name)
        .extension()?
        .to_string_lossy()
        .to_lowercase();
    (!ext.is_empty()).then_some(ext)
}

/// More files that Windows would run instead of open: programs, scripts, shortcuts, installers, registry files.
const BLOCKED_ON_WINDOWS: &[&str] = &[
    "com", "scr", "pif", "cpl", "msc", "msp", "msix", "msixbundle", "appx", "appxbundle", "appref-ms", "application",
    "lnk", "js", "jse", "vbe", "wsf", "wsh", "hta", "psm1", "psd1", "reg", "inf", "gadget", "diagcab", "library-ms",
    "settingcontent-ms", "sys", "dll",
];

fn is_blocked(ext: Option<&str>) -> bool {
    ext.is_some_and(|e| BLOCKED_EXTENSIONS.contains(&e) || (cfg!(windows) && BLOCKED_ON_WINDOWS.contains(&e)))
}

/// Case-insensitive comparison that orders digit runs numerically ("2" < "10").
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (a, b): (Vec<char>, Vec<char>) = (
        a.to_lowercase().chars().collect(),
        b.to_lowercase().chars().collect(),
    );
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let (si, sj) = (i, j);
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let na: String = a[si..i]
                .iter()
                .collect::<String>()
                .trim_start_matches('0')
                .into();
            let nb: String = b[sj..j]
                .iter()
                .collect::<String>()
                .trim_start_matches('0')
                .into();
            let ord = na.len().cmp(&nb.len()).then_with(|| na.cmp(&nb));
            if ord != Ordering::Equal {
                return ord;
            }
        } else {
            let ord = a[i].cmp(&b[j]);
            if ord != Ordering::Equal {
                return ord;
            }
            i += 1;
            j += 1;
        }
    }
    (a.len() - i).cmp(&(b.len() - j))
}

pub fn list(root: &Path, rel: &str) -> AppResult<AssetListing> {
    list_with_limit(root, rel, MAX_ENTRIES)
}

fn list_with_limit(root: &Path, rel: &str, limit: usize) -> AppResult<AssetListing> {
    let (_canon_root, lexical, parts) = resolve_inside(root, rel)?;
    let dir = crate::platform::canonicalize(&lexical).map_err(|e| AppError::io(&lexical, e))?;
    if !dir.is_dir() {
        return invalid("That is not a folder.");
    }
    let rel_dir = parts.join("/");

    let mut entries = Vec::new();
    let mut truncated = false;
    let read = fs::read_dir(&dir).map_err(|e| AppError::io(&dir, e))?;
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        // Hidden files (.DS_Store, .murre, ...) are not project assets.
        if name.starts_with('.') {
            continue;
        }
        if entries.len() >= limit {
            truncated = true;
            break;
        }
        let Ok(meta) = fs::symlink_metadata(item.path()) else {
            continue;
        };
        let ft = meta.file_type();
        let kind = if ft.is_symlink() {
            EntryKind::Symlink
        } else if ft.is_dir() {
            EntryKind::Directory
        } else {
            EntryKind::File
        };
        let extension = if kind == EntryKind::File {
            extension_of(&name)
        } else {
            None
        };
        entries.push(AssetEntry {
            path: if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            },
            absolute_path: dir.join(&name).to_string_lossy().into_owned(),
            size_bytes: (kind == EntryKind::File).then(|| meta.len()),
            modified_at: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            openable: kind == EntryKind::File && !is_blocked(extension.as_deref()),
            extension,
            kind,
            name,
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != EntryKind::Directory)
            .cmp(&(b.kind != EntryKind::Directory))
            .then_with(|| natural_cmp(&a.name, &b.name))
    });
    Ok(AssetListing {
        path: rel_dir,
        entries,
        truncated,
    })
}

/// Validate that `rel` is a regular, non-executable file inside the project and return its path.
pub(crate) fn open_target(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let (_canon_root, lexical, _) = resolve_inside(root, rel)?;
    let meta = fs::symlink_metadata(&lexical).map_err(|e| AppError::io(&lexical, e))?;
    if meta.file_type().is_symlink() {
        return invalid(
            format!("Shortcuts (symbolic links) are not opened from Murre. Use Show in {}.", crate::platform::FILE_BROWSER),
        );
    }
    if !meta.is_file() {
        return invalid("Only files can be opened.");
    }
    let name = lexical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if is_blocked(extension_of(&name).as_deref()) {
        return invalid(
            format!("For safety, Murre does not open programs or scripts. Use Show in {} instead.", crate::platform::FILE_BROWSER),
        );
    }
    Ok(lexical)
}

/// Open a project file with its default application (macOS `open`). On Windows the caller opens the checked
/// `open_target` through the opener plugin instead.
pub fn open_file(root: &Path, rel: &str) -> AppResult<()> {
    let target = open_target(root, rel)?;
    if !cfg!(target_os = "macos") {
        return invalid(format!("Opening files isn’t available on {} yet.", crate::platform::OS_NAME));
    }
    // The path is absolute (starts with "/"), so it cannot be read as an option, and no shell is involved.
    let status = crate::platform::command("open")
        .arg(&target)
        .status()
        .map_err(|e| AppError::io(&target, e))?;
    if status.success() {
        Ok(())
    } else {
        invalid("macOS could not open that file.")
    }
}

/// The most files and folders a storage count looks at, so a huge or looping folder can't stall the app.
const STORAGE_MAX_ENTRIES: usize = 300_000;
const STORAGE_MAX_FOLDERS: usize = 5000;
const STORAGE_MAX_DEPTH: usize = 32;

/// What kind of file this is, for the storage overview.
pub fn storage_kind(ext: Option<&str>) -> &'static str {
    match ext.unwrap_or("") {
        "mov" | "mp4" | "m4v" | "mxf" | "avi" | "webm" | "mkv" | "r3d" | "braw" | "mts" => "video",
        "png" | "jpg" | "jpeg" | "tif" | "tiff" | "webp" | "gif" | "exr" | "dpx" | "bmp" | "heic" | "tga" => "image",
        "wav" | "mp3" | "aif" | "aiff" | "m4a" | "aac" | "flac" | "ogg" => "audio",
        "psd" | "psb" | "ai" | "eps" | "svg" | "indd" => "design",
        "aep" | "aepx" | "aet" | "prproj" | "mogrt" | "c4d" | "blend" => "project",
        _ => "other",
    }
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub bytes: u64,
    pub files: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KindTotal {
    /// `video`, `image`, `audio`, `design`, `project` or `other`.
    pub kind: &'static str,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderTotal {
    /// Project-relative, `/`-separated.
    pub path: String,
    pub bytes: u64,
    /// Files anywhere inside it.
    pub files: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageView {
    pub total: Totals,
    /// Largest first; kinds with no files are left out.
    pub kinds: Vec<KindTotal>,
    /// Every folder in the project with what is inside it, in name order (parents before their children).
    pub folders: Vec<FolderTotal>,
    /// The project was too big to count completely; the numbers are a lower bound.
    pub truncated: bool,
}

/// How much space the project's files take, by kind and by folder. Hidden files and folders (`.murre`, `.DS_Store`)
/// are left out, and shortcuts are not followed. Read-only.
pub fn storage(root: &Path) -> AppResult<StorageView> {
    let (canon_root, _, _) = resolve_inside(root, "")?;
    let mut kinds: std::collections::HashMap<&'static str, (u64, u64)> = std::collections::HashMap::new();
    let mut folders: std::collections::BTreeMap<String, (u64, u64)> = std::collections::BTreeMap::new();
    let mut total = Totals { bytes: 0, files: 0 };
    let mut seen = 0usize;
    let mut truncated = false;
    // (absolute folder, its project-relative path, depth)
    let mut stack = vec![(canon_root.clone(), String::new(), 0usize)];
    'walk: while let Some((dir, rel, depth)) = stack.pop() {
        let Ok(read) = fs::read_dir(&dir) else { continue };
        for item in read.flatten() {
            seen += 1;
            if seen > STORAGE_MAX_ENTRIES {
                truncated = true;
                break 'walk;
            }
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(item.path()) else { continue };
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if meta.is_dir() {
                if folders.len() >= STORAGE_MAX_FOLDERS || depth + 1 > STORAGE_MAX_DEPTH {
                    truncated = true;
                    continue;
                }
                folders.entry(child.clone()).or_insert((0, 0));
                stack.push((item.path(), child, depth + 1));
            } else if meta.is_file() {
                let bytes = meta.len();
                total.bytes += bytes;
                total.files += 1;
                let k = kinds.entry(storage_kind(extension_of(&name).as_deref())).or_insert((0, 0));
                k.0 += bytes;
                k.1 += 1;
                // Count it in every folder above it.
                let mut at = rel.as_str();
                while !at.is_empty() {
                    if let Some(f) = folders.get_mut(at) {
                        f.0 += bytes;
                        f.1 += 1;
                    }
                    at = at.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
                }
            }
        }
    }
    let mut kinds: Vec<KindTotal> = kinds.into_iter().map(|(kind, (bytes, files))| KindTotal { kind, bytes, files }).collect();
    kinds.sort_by(|a, b| b.bytes.cmp(&a.bytes).then(a.kind.cmp(b.kind)));
    let mut folders: Vec<FolderTotal> = folders.into_iter().map(|(path, (bytes, files))| FolderTotal { path, bytes, files }).collect();
    folders.sort_by(|a, b| {
        let (ap, bp) = (a.path.split('/'), b.path.split('/'));
        ap.zip(bp)
            .map(|(x, y)| natural_cmp(x, y))
            .find(|o| *o != Ordering::Equal)
            .unwrap_or_else(|| a.path.matches('/').count().cmp(&b.path.matches('/').count()))
    });
    Ok(StorageView { total, kinds, folders, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        for dir in [
            "02 Assets/10 Late",
            "02 Assets/2 Early",
            "02 Assets/01 Images",
            "01 AE Workfile",
            ".murre",
        ] {
            fs::create_dir_all(r.join(dir)).unwrap();
        }
        fs::write(r.join("02 Assets/01 Images/Hero.PNG"), b"png").unwrap();
        fs::write(r.join("02 Assets/01 Images/.DS_Store"), b"x").unwrap();
        fs::write(r.join("readme.txt"), b"hello").unwrap();
        fs::write(r.join("run.command"), b"#!/bin/sh").unwrap();
        d
    }

    #[test]
    fn natural_sort() {
        let mut v = vec!["10 b", "2 a", "01 c", "File10", "file2", "Zed", "alpha"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            ["01 c", "2 a", "10 b", "alpha", "file2", "File10", "Zed"]
        );
        assert_eq!(natural_cmp("a", "A"), Ordering::Equal);
    }

    #[test]
    fn lists_root_folders_first_hidden_skipped() {
        let d = project();
        let l = list(d.path(), "").unwrap();
        assert_eq!(l.path, "");
        let names: Vec<_> = l.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            ["01 AE Workfile", "02 Assets", "readme.txt", "run.command"]
        );
        assert!(
            l.entries[..2]
                .iter()
                .all(|e| e.kind == EntryKind::Directory)
        );
        let txt = &l.entries[2];
        assert_eq!(
            (
                txt.kind,
                txt.size_bytes,
                txt.extension.as_deref(),
                txt.openable
            ),
            (EntryKind::File, Some(5), Some("txt"), true)
        );
        assert!(
            !l.entries[3].openable,
            "scripts are listed but not openable"
        );
        assert_eq!(l.entries[1].size_bytes, None);
    }

    #[test]
    fn lists_subfolder_with_relative_paths_and_natural_order() {
        let d = project();
        let l = list(d.path(), "02 Assets").unwrap();
        assert_eq!(l.path, "02 Assets");
        let names: Vec<_> = l.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            names,
            [
                "02 Assets/01 Images",
                "02 Assets/2 Early",
                "02 Assets/10 Late"
            ]
        );
        let imgs = list(d.path(), "02 Assets/01 Images").unwrap();
        assert_eq!(imgs.entries.len(), 1, ".DS_Store hidden");
        assert_eq!(imgs.entries[0].extension.as_deref(), Some("png"));
        assert!(
            Path::new(&imgs.entries[0].absolute_path)
                .ends_with("02 Assets/01 Images/Hero.PNG")
        );
        assert_eq!(list(d.path(), "./02 Assets/").unwrap().path, "02 Assets");
    }

    #[test]
    fn rejects_escapes_and_bad_targets() {
        let d = project();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), b"s").unwrap();
        for bad in ["..", "../x", "02 Assets/../..", "/etc", "02 Assets/../../x"] {
            assert!(list(d.path(), bad).is_err(), "{bad}");
        }
        assert!(list(d.path(), "nope").is_err());
        assert!(
            list(d.path(), "readme.txt").is_err(),
            "a file is not a folder"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), d.path().join("escape")).unwrap();
            assert!(
                list(d.path(), "escape").is_err(),
                "symlinked folder leading outside"
            );
            assert!(open_target(d.path(), "escape/secret.txt").is_err());
            // The link itself is listed (as a symlink), but cannot be followed or opened.
            let l = list(d.path(), "").unwrap();
            let link = l.entries.iter().find(|e| e.name == "escape").unwrap();
            assert_eq!(link.kind, EntryKind::Symlink);
            assert!(!link.openable);
            assert!(open_target(d.path(), "escape").is_err());
        }
    }

    #[test]
    fn open_target_allows_only_plain_safe_files() {
        let d = project();
        assert!(open_target(d.path(), "readme.txt").is_ok());
        assert!(open_target(d.path(), "02 Assets/01 Images/Hero.PNG").is_ok());
        assert!(open_target(d.path(), "run.command").is_err());
        assert!(
            open_target(d.path(), "02 Assets").is_err(),
            "folders are not opened"
        );
        assert!(open_target(d.path(), "missing.txt").is_err());
        assert!(open_target(d.path(), "../readme.txt").is_err());
    }

    #[test]
    fn large_folders_are_truncated() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..5 {
            fs::write(d.path().join(format!("f{i}.txt")), b"x").unwrap();
        }
        let l = list_with_limit(d.path(), "", 3).unwrap();
        assert_eq!(l.entries.len(), 3);
        assert!(l.truncated);
        assert!(!list_with_limit(d.path(), "", 5).unwrap().truncated);
    }

    #[test]
    fn windows_only_runnables_are_blocked_on_windows() {
        assert!(is_blocked(Some("exe")) && is_blocked(Some("ps1")));
        assert_eq!(is_blocked(Some("lnk")), cfg!(windows));
        assert_eq!(is_blocked(Some("js")), cfg!(windows));
        assert!(!is_blocked(Some("mov")) && !is_blocked(Some("aep")) && !is_blocked(Some("jsx")));
    }

    #[test]
    fn storage_counts_by_kind_and_folder() {
        let d = project();
        let r = d.path();
        fs::write(r.join("02 Assets/01 Images/b.jpg"), vec![0u8; 100]).unwrap();
        fs::write(r.join("01 AE Workfile/Film.aep"), vec![0u8; 50]).unwrap();
        fs::write(r.join(".murre/notes.json"), vec![0u8; 999]).unwrap();
        let v = storage(r).unwrap();
        // Hero.PNG (3) + b.jpg (100) are images; readme.txt (5) and run.command (9) are other; .DS_Store and .murre are skipped.
        assert_eq!(v.total, Totals { bytes: 3 + 100 + 50 + 5 + 9, files: 5 });
        assert_eq!(v.kinds[0], KindTotal { kind: "image", bytes: 103, files: 2 });
        let f = |p: &str| v.folders.iter().find(|f| f.path == p).cloned().unwrap();
        assert_eq!((f("02 Assets").bytes, f("02 Assets").files), (103, 2));
        assert_eq!((f("02 Assets/01 Images").bytes, f("02 Assets/01 Images").files), (103, 2));
        assert_eq!(f("02 Assets/2 Early").files, 0);
        assert!(!v.folders.iter().any(|f| f.path.starts_with(".murre")));
        let order: Vec<_> = v.folders.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(order, ["01 AE Workfile", "02 Assets", "02 Assets/01 Images", "02 Assets/2 Early", "02 Assets/10 Late"]);
        assert!(!v.truncated);
    }
}
