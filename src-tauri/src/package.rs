//! "Package for delivery": check a project for the things that would greet the person on the other end with
//! color bars, then copy what is needed into a clean folder (and optionally a zip).
//!
//! Nothing in the project is changed: files are only read and copied. What goes in the package:
//!  * the current `.aep` (and, if asked, the other versions), in the same folder it has in the project;
//!  * the footage the last scan found inside the project folder, in the same relative folders, so After Effects
//!    finds it next to the workfile;
//!  * the Premiere Pro folder, when the project has a `.prproj` (without the untouched `Original` copies);
//!  * the fonts that are installed on this Mac (if asked), in `Fonts`;
//!  * a plain-text note listing what the project needs.
//! Footage outside the project folder can't go into a package that still links correctly, so it is reported.

use crate::environment;
use crate::error::{AppError, AppResult};
use crate::fonts;
use crate::footage;
use crate::project::invalid;
use crate::workfiles;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::process::Command;

const PREMIERE_DIR: &str = "04 Premiere & SFX";
const MAX_LISTED: usize = 50;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackageWorkfile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub modified_at: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackageFont {
    pub label: String,
    /// Will be copied into `Fonts` when "include fonts" is on.
    pub bundle: bool,
    /// Why it can't be bundled, when `bundle` is false.
    pub reason: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNotesInfo {
    /// Notes pages that have some text.
    pub note_pages: usize,
    pub todos: usize,
    pub reference_files: usize,
    pub reference_bytes: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PackageCheck {
    pub workfile: Option<PackageWorkfile>,
    /// Other `.aep` versions that could come along.
    pub other_versions: Vec<PackageWorkfile>,
    /// The Companion has scanned this project at least once (footage and fonts are only known after that).
    pub scanned: bool,
    /// The workfile was saved after the last scan, so the lists below may be out of date.
    pub stale: bool,
    pub footage_inside: usize,
    pub footage_inside_bytes: u64,
    /// Footage that After Effects couldn't find. Shown by file name (up to 50).
    pub footage_missing: Vec<String>,
    pub footage_missing_total: usize,
    /// Footage that lives outside the project folder (up to 50 names).
    pub footage_outside: Vec<String>,
    pub footage_outside_total: usize,
    pub premiere_files: Vec<String>,
    pub premiere_bytes: u64,
    pub fonts: Vec<PackageFont>,
    pub fonts_bytes: u64,
    pub plugins: Vec<String>,
    pub ae_version: Option<String>,
    /// What the project has in its notes, to-do list and reference board (for the "include" option).
    pub project_notes: ProjectNotesInfo,
    /// Where the package goes unless the person picks another folder: the project's own `07 Deliverables`.
    pub default_destination: String,
    /// Total size of the workfile plus footage plus Premiere folder (not fonts, not other versions).
    pub total_bytes: u64,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BuildOptions {
    /// Folder the package is made in.
    pub destination: String,
    pub include_fonts: bool,
    pub include_other_versions: bool,
    /// The project's notes, to-do list and reference images, as readable files in `Project notes`.
    #[serde(default)]
    pub include_project_notes: bool,
    /// `folder`, `zip` or `both`.
    pub format: String,
    /// Package even though footage is missing or outside the project.
    #[serde(default)]
    pub allow_problems: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done_bytes: u64,
    pub total_bytes: u64,
    /// Short note on what is happening ("Copying footage", "Making the zip").
    pub step: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BuildReport {
    pub folder: Option<String>,
    pub zip: Option<String>,
    pub files: usize,
    pub bytes: u64,
    pub fonts_included: usize,
}

struct CopyItem {
    from: PathBuf,
    /// Path inside the package, `/`-separated.
    rel: String,
    bytes: u64,
}

struct Plan {
    check: PackageCheck,
    items: Vec<CopyItem>,
    font_items: Vec<CopyItem>,
    other_versions: Vec<CopyItem>,
    /// The notes, as plain text (`None` when there is nothing written).
    notes_text: Option<String>,
    /// The to-do list, as plain text.
    todo_text: Option<String>,
    /// The files on the reference board, to be put in `Project notes/References`.
    reference_items: Vec<CopyItem>,
}

fn rel_slash(root: &Path, p: &Path) -> Option<String> {
    let rel: PathBuf = match p.strip_prefix(root) {
        Ok(r) => r.to_path_buf(),
        Err(_) => {
            // The same folder reached through a link (for example /var vs /private/var).
            let (r, q) = (crate::platform::canonicalize(root).ok()?, crate::platform::canonicalize(p).ok()?);
            q.strip_prefix(&r).ok()?.to_path_buf()
        }
    };
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if parts.is_empty() { None } else { Some(parts.join("/")) }
}

/// Seconds since 1970 for `YYYY-MM-DDTHH:MM:SS` (optional fraction, `Z`), the form the Companion writes.
fn iso_secs(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Days from civil date (Howard Hinnant's algorithm).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + hh * 3600 + mm * 60 + ss).ok()
}

fn file_name(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

fn walk_files(dir: &Path, skip_dir: &dyn Fn(&str) -> bool, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 8 || out.len() > 50_000 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(m) = fs::symlink_metadata(e.path()) else { continue };
        if m.is_dir() {
            if !skip_dir(&name) {
                walk_files(&e.path(), skip_dir, out, depth + 1);
            }
        } else if m.is_file() {
            out.push(e.path());
        }
    }
}

fn plan(root: &Path) -> AppResult<Plan> {
    let mut check = PackageCheck::default();
    let mut items: Vec<CopyItem> = Vec::new();
    let mut other_versions: Vec<CopyItem> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();

    // The workfile: the one marked as current, or the most recently saved.
    let scan = workfiles::scan(root)?;
    let chosen = scan.workfiles.iter().find(|w| w.is_current).or_else(|| scan.workfiles.first()).cloned();
    if let Some(w) = &chosen {
        let from = root.join(&w.path);
        if from.is_file() {
            check.workfile = Some(PackageWorkfile { path: w.path.clone(), name: w.name.clone(), size_bytes: w.size_bytes, modified_at: w.modified_at });
            seen.insert(w.path.clone());
            items.push(CopyItem { from, rel: w.path.clone(), bytes: w.size_bytes });
        }
    }
    for w in scan.workfiles.iter().filter(|w| Some(&w.path) != chosen.as_ref().map(|c| &c.path)) {
        let from = root.join(&w.path);
        if !from.is_file() {
            continue;
        }
        check.other_versions.push(PackageWorkfile { path: w.path.clone(), name: w.name.clone(), size_bytes: w.size_bytes, modified_at: w.modified_at });
        other_versions.push(CopyItem { from, rel: w.path.clone(), bytes: w.size_bytes });
    }

    // Footage found by the last scan.
    let foot = footage::get(root)?;
    check.scanned = foot.last_scan_at.is_some();
    if let (Some(w), true) = (&check.workfile, check.scanned) {
        let scanned_at = foot
            .last_scan_at
            .as_ref()
            .and_then(|v| v.as_str().map(str::to_string))
            .and_then(|s| iso_secs(&s));
        if let Some(at) = scanned_at {
            check.stale = w.modified_at > at + 5;
        }
    }
    for a in &foot.assets {
        match a.status.as_str() {
            "missing" => {
                check.footage_missing_total += 1;
                if check.footage_missing.len() < MAX_LISTED {
                    check.footage_missing.push(file_name(&a.path));
                }
            }
            "outside" => {
                check.footage_outside_total += 1;
                if check.footage_outside.len() < MAX_LISTED {
                    check.footage_outside.push(file_name(&a.path));
                }
            }
            "inside" | "sequence" => {
                let p = Path::new(&a.path);
                if rel_slash(root, p).is_none() {
                    check.footage_outside_total += 1;
                    if check.footage_outside.len() < MAX_LISTED {
                        check.footage_outside.push(file_name(&a.path));
                    }
                    continue;
                }
                // An image sequence is a whole run of frames: take the files beside the first frame with the same extension.
                let files: Vec<PathBuf> = if a.status == "sequence" {
                    let ext = p.extension().map(|e| e.to_os_string());
                    p.parent()
                        .and_then(|d| fs::read_dir(d).ok())
                        .map(|rd| rd.flatten().map(|e| e.path()).filter(|q| q.is_file() && q.extension().map(|e| e.to_os_string()) == ext).collect())
                        .unwrap_or_default()
                } else if p.is_file() {
                    vec![p.to_path_buf()]
                } else {
                    check.footage_missing_total += 1;
                    if check.footage_missing.len() < MAX_LISTED {
                        check.footage_missing.push(file_name(&a.path));
                    }
                    continue;
                };
                for f in files {
                    let Some(r) = rel_slash(root, &f) else { continue };
                    if !seen.insert(r.clone()) {
                        continue;
                    }
                    let bytes = fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
                    check.footage_inside += 1;
                    check.footage_inside_bytes += bytes;
                    items.push(CopyItem { from: f, rel: r, bytes });
                }
            }
            _ => {}
        }
    }

    // Premiere Pro: the whole folder when it holds a project, minus the untouched originals.
    let pdir = root.join(PREMIERE_DIR);
    let mut pfiles = Vec::new();
    walk_files(&pdir, &|n| n == "Original", &mut pfiles, 0);
    if pfiles.iter().any(|f| f.extension().is_some_and(|e| e.eq_ignore_ascii_case("prproj"))) {
        for f in pfiles {
            let Some(r) = rel_slash(root, &f) else { continue };
            if !seen.insert(r.clone()) {
                continue;
            }
            let bytes = fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
            if f.extension().is_some_and(|e| e.eq_ignore_ascii_case("prproj")) {
                check.premiere_files.push(file_name(&r));
            }
            check.premiere_bytes += bytes;
            items.push(CopyItem { from: f, rel: r, bytes });
        }
    }

    // Fonts and plugins, from the last scan.
    let needs = environment::get(root)?;
    check.ae_version = needs.ae_version.clone();
    check.plugins = needs.plugins.iter().map(|p| p.name.clone()).collect();
    let fv = fonts::get(root)?;
    let mut font_items: Vec<CopyItem> = Vec::new();
    let mut font_seen: BTreeSet<String> = BTreeSet::new();
    for f in &fv.fonts {
        let label = match (&f.family, &f.style) {
            (Some(a), Some(b)) => format!("{a} {b}"),
            (Some(a), None) => a.clone(),
            _ => f.post_script_name.clone(),
        };
        let loc = f.location.clone().filter(|l| !l.is_empty());
        let (bundle, reason) = if f.adobe_fonts {
            (false, Some("Adobe Fonts: the other person turns it on in their own Creative Cloud".to_string()))
        } else if loc.as_deref().is_some_and(|l| l.starts_with("/System/")) {
            (false, Some("Comes with macOS".to_string()))
        } else if f.installed == Some(true) {
            (true, None)
        } else {
            (false, Some(format!("Not on {}", crate::platform::THIS_COMPUTER)))
        };
        if bundle {
            let l = loc.clone().unwrap_or_default();
            if font_seen.insert(l.clone()) {
                let from = PathBuf::from(&l);
                let bytes = fs::metadata(&from).map(|m| m.len()).unwrap_or(0);
                check.fonts_bytes += bytes;
                font_items.push(CopyItem { from, rel: format!("Fonts/{}", file_name(&l)), bytes });
            }
        }
        check.fonts.push(PackageFont { label, bundle, reason });
    }

    check.total_bytes = items.iter().map(|i| i.bytes).sum();

    // Notes, to-do and references. A damaged file here must not stop a delivery, so each part falls back to nothing.
    let (notes_text, note_pages) = notes_as_text(root);
    let (todo_text, todos) = todo_as_text(root);
    let reference_items = reference_files(root);
    check.project_notes = ProjectNotesInfo {
        note_pages,
        todos,
        reference_files: reference_items.len(),
        reference_bytes: reference_items.iter().map(|i| i.bytes).sum(),
    };
    Ok(Plan { check, items, font_items, other_versions, notes_text, todo_text, reference_items })
}

/// Folder inside the package for the notes, to-do list and references.
const NOTES_DIR: &str = "Project notes";

/// The plain text of a Tiptap/ProseMirror document: one line per paragraph, heading or list item.
fn doc_text(node: &serde_json::Value, out: &mut String) {
    let kind = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match kind {
        "text" => {
            if let Some(t) = node.get("text").and_then(|t| t.as_str()) {
                out.push_str(t);
            }
            return;
        }
        "hardBreak" => {
            out.push('\n');
            return;
        }
        "taskItem" => {
            let done = node.get("attrs").and_then(|a| a.get("checked")).and_then(|c| c.as_bool()).unwrap_or(false);
            out.push_str(if done { "[x] " } else { "[ ] " });
        }
        "bulletList" | "orderedList" | "taskList" => {
            // The items below add their own line breaks.
        }
        "listItem" => out.push_str("- "),
        "heading" => out.push_str("# "),
        _ => {}
    }
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for c in children {
            doc_text(c, out);
        }
    }
    if matches!(kind, "paragraph" | "heading" | "listItem" | "taskItem" | "codeBlock" | "blockquote") && !out.ends_with('\n') {
        out.push('\n');
    }
}

/// All note pages as one text, and how many pages had any text in them.
fn notes_as_text(root: &Path) -> (Option<String>, usize) {
    let Ok(view) = crate::notes::get(root) else { return (None, 0) };
    let mut pages: Vec<String> = Vec::new();
    for content in std::iter::once(&view.content).chain(view.pages.iter().map(|p| &p.content)) {
        let mut t = String::new();
        if let Some(c) = content {
            doc_text(c, &mut t);
        }
        let t = t.trim().to_string();
        if !t.is_empty() {
            pages.push(t);
        }
    }
    if pages.is_empty() {
        return (None, 0);
    }
    let n = pages.len();
    let text = if n == 1 {
        format!("{}\n", pages[0])
    } else {
        pages.iter().enumerate().map(|(i, p)| format!("Page {}\n\n{p}\n", i + 1)).collect::<Vec<_>>().join("\n----\n\n")
    };
    (Some(text), n)
}

fn todo_as_text(root: &Path) -> (Option<String>, usize) {
    let Ok(tasks) = crate::tasks::list(root) else { return (None, 0) };
    if tasks.is_empty() {
        return (None, 0);
    }
    let text: String = tasks.iter().map(|t| format!("{} {}\n", if t.done { "[x]" } else { "[ ]" }, t.title)).collect();
    (Some(text), tasks.len())
}

/// The images, videos and PDFs placed on the reference board, once each.
fn reference_files(root: &Path) -> Vec<CopyItem> {
    let Ok(view) = crate::references::get(root) else { return Vec::new() };
    let Some(items) = view.canvas.as_ref().and_then(|c| c.get("items")).and_then(|i| i.as_array()) else { return Vec::new() };
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for it in items {
        let Some(file) = it.get("file").and_then(|f| f.as_str()) else { continue };
        if !seen.insert(file.to_string()) {
            continue;
        }
        let Ok(from) = crate::references::media_path(root, file) else { continue };
        let bytes = fs::metadata(&from).map(|m| m.len()).unwrap_or(0);
        out.push(CopyItem { from, rel: format!("{NOTES_DIR}/References/{file}"), bytes });
    }
    out
}

pub const DELIVERABLES_DIR: &str = "07 Deliverables";

pub fn check(root: &Path) -> AppResult<PackageCheck> {
    let mut c = plan(root)?.check;
    c.default_destination = root.join(DELIVERABLES_DIR).to_string_lossy().into_owned();
    Ok(c)
}

fn unique_dir(dest: &Path, base: &str) -> PathBuf {
    let mut n = 1;
    loop {
        let name = if n == 1 { base.to_string() } else { format!("{base} {n}") };
        let p = dest.join(&name);
        if !p.exists() && !dest.join(format!("{name}.zip")).exists() {
            return p;
        }
        n += 1;
    }
}

fn clean_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '-' } else { c }).collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() { "Project".into() } else { s.chars().take(80).collect() }
}

fn kb(b: u64) -> String {
    if b >= 1 << 30 { format!("{:.1} GB", b as f64 / (1u64 << 30) as f64) } else if b >= 1 << 20 { format!("{:.0} MB", b as f64 / (1u64 << 20) as f64) } else { format!("{} KB", b.div_ceil(1024)) }
}

fn readme(name: &str, c: &PackageCheck, with_fonts: bool, with_versions: bool) -> String {
    let mut s = String::new();
    s.push_str(&format!("{name}\nWhat you need to open this project\n\n"));
    s.push_str("After Effects\n");
    match &c.ae_version {
        Some(v) => s.push_str(&format!("  Saved from version {v}. Use that version or newer.\n")),
        None => s.push_str("  We don't know which version this was made in.\n"),
    }
    s.push_str("\nFonts\n");
    if c.fonts.is_empty() {
        s.push_str("  None found.\n");
    }
    for f in &c.fonts {
        if f.bundle && with_fonts {
            s.push_str(&format!("  {}  (in the Fonts folder, install it first)\n", f.label));
        } else if let Some(r) = &f.reason {
            s.push_str(&format!("  {}  ({r})\n", f.label));
        } else {
            s.push_str(&format!("  {}\n", f.label));
        }
    }
    s.push_str("\nPlugins\n");
    if c.plugins.is_empty() {
        s.push_str("  None. Everything here ships with After Effects.\n");
    }
    for p in &c.plugins {
        s.push_str(&format!("  {p}  (install it before you open the project)\n"));
    }
    s.push_str("\nWhat's in this folder\n");
    if let Some(w) = &c.workfile {
        s.push_str(&format!("  {}  (open this one)\n", w.path));
    }
    if with_versions && !c.other_versions.is_empty() {
        s.push_str(&format!("  {} older version(s), same folder\n", c.other_versions.len()));
    }
    s.push_str(&format!("  {} footage file(s), {}\n", c.footage_inside, kb(c.footage_inside_bytes)));
    if !c.premiere_files.is_empty() {
        s.push_str(&format!("  Premiere Pro: {}\n", c.premiere_files.join(", ")));
    }
    if c.footage_missing_total > 0 || c.footage_outside_total > 0 {
        s.push_str("\nHeads up\n");
        if c.footage_missing_total > 0 {
            s.push_str(&format!("  {} footage file(s) couldn't be found when this was packed: {}\n", c.footage_missing_total, c.footage_missing.join(", ")));
        }
        if c.footage_outside_total > 0 {
            s.push_str(&format!("  {} footage file(s) lived outside the project folder and aren't included: {}\n", c.footage_outside_total, c.footage_outside.join(", ")));
        }
        s.push_str("  Expect color bars where they're used.\n");
    }
    s.push_str("\nPacked with Murre. Keep the folders as they are so After Effects finds everything.\n");
    s
}

fn copy_all(items: &[&CopyItem], dest: &Path, done: &mut u64, total: u64, step: &str, progress: &mut dyn FnMut(&Progress)) -> AppResult<()> {
    for it in items {
        let to = dest.join(&it.rel);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
        }
        fs::copy(&it.from, &to).map_err(|e| AppError::io(&it.from, e))?;
        *done += it.bytes;
        progress(&Progress { done_bytes: *done, total_bytes: total, step: step.into() });
    }
    Ok(())
}

/// Make `out` from the folder `src` (the folder itself is the top level inside the zip).
pub fn make_zip(src: &Path, out: &Path) -> AppResult<()> {
    let parent = src.parent().ok_or_else(|| AppError::Invalid("Can't zip that folder.".into()))?;
    let name = src.file_name().ok_or_else(|| AppError::Invalid("Can't zip that folder.".into()))?;
    let status = if cfg!(target_os = "macos") {
        crate::platform::command("/usr/bin/ditto").arg("-c").arg("-k").arg("--keepParent").arg(src).arg(out).status()
    } else if cfg!(windows) {
        return invalid("Making a zip isn’t available on Windows yet. The folder is still there.");
    } else {
        crate::platform::command("zip").arg("-rq").arg(out).arg(name).current_dir(parent).status()
    };
    match status {
        Ok(s) if s.success() && out.is_file() => Ok(()),
        _ => {
            let _ = fs::remove_file(out);
            invalid("The zip couldn't be made. The folder is still there.")
        }
    }
}

/// Make the package. Refuses when there is no workfile, or when footage is missing or outside the project and
/// `allow_problems` is off. A failure part-way removes the half-made package.
pub fn build(root: &Path, name: &str, opts: &BuildOptions, progress: &mut dyn FnMut(&Progress)) -> AppResult<BuildReport> {
    if !["folder", "zip", "both"].contains(&opts.format.as_str()) {
        return invalid("Choose folder, zip or both.");
    }
    let p = plan(root)?;
    if p.check.workfile.is_none() {
        return invalid("This project has no After Effects file to package.");
    }
    if !opts.allow_problems && (p.check.footage_missing_total > 0 || p.check.footage_outside_total > 0) {
        return invalid("Some footage is missing or outside the project folder. Fix it, or choose to package anyway.");
    }
    let dest = PathBuf::from(&opts.destination);
    // The project's own deliverables folder is made on the spot if it was removed; any other folder must already exist.
    if !dest.exists() && dest == root.join(DELIVERABLES_DIR) {
        fs::create_dir_all(&dest).map_err(|e| AppError::io(&dest, e))?;
    }
    if !dest.is_dir() {
        return invalid("The folder to save the package in doesn't exist.");
    }
    let base = format!("{} - Delivery", clean_name(name));
    let folder = unique_dir(&dest, &base);

    let mut list: Vec<&CopyItem> = p.items.iter().collect();
    if opts.include_other_versions {
        list.extend(p.other_versions.iter());
    }
    if opts.include_fonts {
        list.extend(p.font_items.iter());
    }
    if opts.include_project_notes {
        list.extend(p.reference_items.iter());
    }
    let total: u64 = list.iter().map(|i| i.bytes).sum();
    let mut done = 0u64;
    progress(&Progress { done_bytes: 0, total_bytes: total, step: "Copying files".into() });

    let result = (|| -> AppResult<BuildReport> {
        fs::create_dir_all(&folder).map_err(|e| AppError::io(&folder, e))?;
        copy_all(&list, &folder, &mut done, total, "Copying files", progress)?;
        let note = readme(name, &p.check, opts.include_fonts, opts.include_other_versions);
        let note_path = folder.join("READ ME - what this project needs.txt");
        fs::write(&note_path, note).map_err(|e| AppError::io(&note_path, e))?;
        let mut written = 1usize;
        if opts.include_project_notes {
            let dir = folder.join(NOTES_DIR);
            for (name, text) in [("Notes.txt", &p.notes_text), ("To-do.txt", &p.todo_text)] {
                if let Some(t) = text {
                    fs::create_dir_all(&dir).map_err(|e| AppError::io(&dir, e))?;
                    let path = dir.join(name);
                    fs::write(&path, t).map_err(|e| AppError::io(&path, e))?;
                    written += 1;
                }
            }
        }
        let mut report = BuildReport {
            files: list.len() + written,
            bytes: total,
            fonts_included: if opts.include_fonts { p.font_items.len() } else { 0 },
            ..Default::default()
        };
        if opts.format != "folder" {
            progress(&Progress { done_bytes: total, total_bytes: total, step: "Making the zip".into() });
            let zip = dest.join(format!("{}.zip", folder.file_name().unwrap_or_default().to_string_lossy()));
            make_zip(&folder, &zip)?;
            report.zip = Some(zip.to_string_lossy().into_owned());
        }
        if opts.format == "zip" {
            // The folder was only a stepping stone; it is ours, so tidy it away.
            let _ = fs::remove_dir_all(&folder);
        } else {
            report.folder = Some(folder.to_string_lossy().into_owned());
        }
        Ok(report)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&folder);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(p: &Path, bytes: &[u8]) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    /// A project with a workfile, one footage file inside, one outside, one missing, a font on disk and a plugin.
    fn project() -> (tempfile::TempDir, tempfile::TempDir) {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let r = d.path();
        write(&r.join("01 AE Workfile/film_v02.aep"), b"AEP2");
        write(&r.join("01 AE Workfile/film_v01.aep"), b"AEP1");
        write(&r.join("02 Assets/01 Images/logo.png"), b"PNG");
        write(&r.join("02 Assets/01 Images/unused.png"), b"UNUSED");
        write(&outside.path().join("stock.mov"), b"MOV");
        write(&outside.path().join("Inter.ttf"), b"FONT");
        fs::create_dir_all(r.join(".murre")).unwrap();
        let assets = json!({"schemaVersion":1,"lastScanAt":"2099-01-01T00:00:00Z","assets":[
            {"path": r.join("02 Assets/01 Images/logo.png").to_string_lossy(), "names":["logo.png"], "status":"inside"},
            {"path": outside.path().join("stock.mov").to_string_lossy(), "names":["stock.mov"], "status":"outside"},
            {"path": "/gone/lost.mov", "names":["lost.mov"], "status":"missing"}]});
        fs::write(r.join(".murre/assets.json"), assets.to_string()).unwrap();
        let fonts = json!({"schemaVersion":1,"lastScanAt":"x","method":"project","fonts":[
            {"postScriptName":"Inter-Bold","family":"Inter","style":"Bold","location": outside.path().join("Inter.ttf").to_string_lossy()},
            {"postScriptName":"Arial","family":"Arial","location":"/System/Library/Fonts/Arial.ttf"},
            {"postScriptName":"Adobe-One","family":"Adobe One","adobeFonts":true}]});
        fs::write(r.join(".murre/fonts.json"), fonts.to_string()).unwrap();
        let env = json!({"schemaVersion":1,"lastScanAt":"x","aeVersion":"25.1","plugins":[{"matchName":"VC Deep Glow","name":"Deep Glow","layerCount":2}]});
        fs::write(r.join(".murre/environment.json"), env.to_string()).unwrap();
        // The designer marked v02 as the current one.
        workfiles::set_current(r, Some("01 AE Workfile/film_v02.aep")).unwrap();
        (d, outside)
    }

    fn opts(dest: &Path, format: &str) -> BuildOptions {
        BuildOptions { destination: dest.to_string_lossy().into(), include_fonts: true, include_other_versions: false, include_project_notes: false, format: format.into(), allow_problems: true }
    }

    #[test]
    fn check_reports_workfile_footage_fonts_and_plugins() {
        let (d, _o) = project();
        let c = check(d.path()).unwrap();
        assert!(c.scanned);
        assert_eq!(c.workfile.as_ref().unwrap().path, "01 AE Workfile/film_v02.aep");
        assert_eq!(c.footage_inside, 1);
        assert_eq!((c.footage_outside_total, c.footage_missing_total), (1, 1));
        assert_eq!(c.footage_missing, vec!["lost.mov"]);
        assert_eq!(c.plugins, vec!["Deep Glow"]);
        assert_eq!(c.ae_version.as_deref(), Some("25.1"));
        let bundled: Vec<_> = c.fonts.iter().map(|f| (f.label.as_str(), f.bundle)).collect();
        assert_eq!(bundled, vec![("Inter Bold", true), ("Arial", false), ("Adobe One", false)]);
        assert_eq!(c.fonts[1].reason.as_deref(), Some("Comes with macOS"));
        assert_eq!(c.other_versions.len(), 1);
    }

    #[test]
    fn building_copies_only_what_is_needed_and_leaves_the_project_alone() {
        let (d, _o) = project();
        let dest = tempfile::tempdir().unwrap();
        let before = fs::read_dir(d.path().join("01 AE Workfile")).unwrap().count();
        let mut seen = 0;
        let r = build(d.path(), "My Film", &opts(dest.path(), "folder"), &mut |_| seen += 1).unwrap();
        assert!(seen >= 2);
        let f = PathBuf::from(r.folder.unwrap());
        assert!(f.ends_with("My Film - Delivery"));
        assert_eq!(fs::read(f.join("01 AE Workfile/film_v02.aep")).unwrap(), b"AEP2");
        assert!(!f.join("01 AE Workfile/film_v01.aep").exists(), "other versions only when asked");
        assert!(f.join("02 Assets/01 Images/logo.png").is_file());
        assert!(!f.join("02 Assets/01 Images/unused.png").exists(), "unused files stay behind");
        assert_eq!(fs::read(f.join("Fonts/Inter.ttf")).unwrap(), b"FONT");
        let note = fs::read_to_string(f.join("READ ME - what this project needs.txt")).unwrap();
        assert!(note.contains("Deep Glow") && note.contains("Inter Bold") && note.contains("lost.mov") && note.contains("color bars"));
        assert!(note.contains("Comes with macOS"));
        assert!(d.path().join("02 Assets/01 Images/unused.png").is_file());
        assert_eq!(fs::read_dir(d.path().join("01 AE Workfile")).unwrap().count(), before);
        // A second package doesn't overwrite the first.
        let r2 = build(d.path(), "My Film", &opts(dest.path(), "folder"), &mut |_| {}).unwrap();
        assert!(PathBuf::from(r2.folder.unwrap()).ends_with("My Film - Delivery 2"));
    }

    #[test]
    fn options_for_versions_and_fonts_are_respected() {
        let (d, _o) = project();
        let dest = tempfile::tempdir().unwrap();
        let mut o = opts(dest.path(), "folder");
        o.include_fonts = false;
        o.include_other_versions = true;
        let f = PathBuf::from(build(d.path(), "A", &o, &mut |_| {}).unwrap().folder.unwrap());
        assert!(f.join("01 AE Workfile/film_v01.aep").is_file());
        assert!(!f.join("Fonts").exists());
    }

    #[test]
    fn notes_todo_and_references_come_along_only_when_asked() {
        let (d, _o) = project();
        let r = d.path();
        write(
            &r.join(".murre/notes.json"),
            br#"{"schemaVersion":1,"revision":1,"content":{"type":"doc","content":[
              {"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Brief"}]},
              {"type":"paragraph","content":[{"type":"text","text":"Keep it "},{"type":"text","text":"calm."}]},
              {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Logo first"}]}]}]}]},
              "pages":[{"id":"p2","content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Second page"}]}]}}]}"#,
        );
        write(&r.join(".murre/tasks.json"), br#"{"schemaVersion":1,"tasks":[{"id":"a","title":"Send frames","done":false,"createdAt":1,"completedAt":null},{"id":"b","title":"Pick music","done":true,"createdAt":2,"completedAt":3}]}"#);
        write(&r.join(".murre/references/media/abc123.png"), b"REFPNG");
        write(
            &r.join(".murre/references/references.json"),
            br#"{"schemaVersion":1,"revision":1,"canvas":{"format":"sequenxe-board","version":1,"items":[
              {"id":"1","type":"image","x":0,"y":0,"w":10,"h":10,"file":"abc123.png"},
              {"id":"2","type":"image","x":0,"y":0,"w":10,"h":10,"file":"abc123.png"},
              {"id":"3","type":"text","x":0,"y":0,"w":10,"h":10,"text":"hi"}]}}"#,
        );
        let check = check(r).unwrap();
        assert_eq!((check.project_notes.note_pages, check.project_notes.todos, check.project_notes.reference_files), (2, 2, 1));

        let dest = tempfile::tempdir().unwrap();
        let off = PathBuf::from(build(r, "A", &opts(dest.path(), "folder"), &mut |_| {}).unwrap().folder.unwrap());
        assert!(!off.join("Project notes").exists(), "off by default");

        let mut o = opts(dest.path(), "folder");
        o.include_project_notes = true;
        let on = PathBuf::from(build(r, "A", &o, &mut |_| {}).unwrap().folder.unwrap());
        let notes = fs::read_to_string(on.join("Project notes/Notes.txt")).unwrap();
        assert!(notes.contains("# Brief") && notes.contains("Keep it calm.") && notes.contains("- Logo first") && notes.contains("Second page"));
        let todo = fs::read_to_string(on.join("Project notes/To-do.txt")).unwrap();
        assert_eq!(todo, "[ ] Send frames\n[x] Pick music\n");
        assert_eq!(fs::read(on.join("Project notes/References/abc123.png")).unwrap(), b"REFPNG");
        // The project itself is untouched.
        assert!(r.join(".murre/notes.json").is_file());
    }

    #[test]
    fn a_project_with_no_notes_gets_no_notes_folder_even_when_asked() {
        let (d, _o) = project();
        let dest = tempfile::tempdir().unwrap();
        let mut o = opts(dest.path(), "folder");
        o.include_project_notes = true;
        let f = PathBuf::from(build(d.path(), "A", &o, &mut |_| {}).unwrap().folder.unwrap());
        assert!(!f.join("Project notes").exists());
    }

    #[test]
    fn problems_stop_the_build_unless_allowed() {
        let (d, _o) = project();
        let dest = tempfile::tempdir().unwrap();
        let mut o = opts(dest.path(), "folder");
        o.allow_problems = false;
        assert!(build(d.path(), "A", &o, &mut |_| {}).is_err());
        assert_eq!(fs::read_dir(dest.path()).unwrap().count(), 0, "nothing is left behind");
        let mut bad = opts(dest.path(), "folder");
        bad.destination = d.path().join("nope").to_string_lossy().into();
        assert!(build(d.path(), "A", &bad, &mut |_| {}).is_err());
        let mut fmt = opts(dest.path(), "tar");
        fmt.allow_problems = true;
        assert!(build(d.path(), "A", &fmt, &mut |_| {}).is_err());
    }

    #[test]
    fn zip_and_both_formats() {
        if Command::new("zip").arg("-v").output().is_err() && !cfg!(target_os = "macos") {
            return; // no zip tool in this environment
        }
        let (d, _o) = project();
        let dest = tempfile::tempdir().unwrap();
        let z = build(d.path(), "Z", &opts(dest.path(), "zip"), &mut |_| {}).unwrap();
        assert!(z.folder.is_none() && PathBuf::from(z.zip.unwrap()).is_file());
        assert!(!dest.path().join("Z - Delivery").exists(), "zip only leaves just the zip");
        let b = build(d.path(), "B", &opts(dest.path(), "both"), &mut |_| {}).unwrap();
        assert!(PathBuf::from(b.folder.unwrap()).is_dir() && PathBuf::from(b.zip.unwrap()).is_file());
    }

    #[test]
    fn no_workfile_means_nothing_to_package() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join(".murre")).unwrap();
        let dest = tempfile::tempdir().unwrap();
        assert!(build(d.path(), "A", &opts(dest.path(), "folder"), &mut |_| {}).is_err());
    }

    #[test]
    fn premiere_folder_comes_along_without_the_untouched_originals() {
        let (d, _o) = project();
        write(&d.path().join("04 Premiere & SFX/cut.prproj"), b"PR");
        write(&d.path().join("04 Premiere & SFX/Footage/clip.mov"), b"CLIP");
        write(&d.path().join("04 Premiere & SFX/Original/cut.prproj"), b"OLD");
        let dest = tempfile::tempdir().unwrap();
        let f = PathBuf::from(build(d.path(), "P", &opts(dest.path(), "folder"), &mut |_| {}).unwrap().folder.unwrap());
        assert!(f.join("04 Premiere & SFX/cut.prproj").is_file() && f.join("04 Premiere & SFX/Footage/clip.mov").is_file());
        assert!(!f.join("04 Premiere & SFX/Original").exists());
    }
}

#[cfg(test)]
mod date_tests {
    use super::iso_secs;
    #[test]
    fn reads_the_companions_timestamps() {
        assert_eq!(iso_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_secs("2026-10-26T12:00:00.000Z"), Some(1_793_016_000));
        assert_eq!(iso_secs("nonsense"), None);
        assert_eq!(iso_secs("2026-13-01T00:00:00Z"), None);
    }
}
