//! Premiere Pro projects that sit beside (or one folder above) the After Effects project being added.
//!
//! A `.prproj` is gzip-compressed XML. Each clip is a `<Media>` element whose `<ActualMediaFilePath>`, `<FilePath>` and
//! `<RelativePath>` say where the footage is. Collecting a project means: keep the original file untouched, copy the footage
//! it uses into the Murre project, and save a second copy of the project whose paths point at those copies.
//!
//! Adobe does not document the format, so this reads only the three tags above, inside `<Media>` elements, and leaves
//! everything else exactly as it was. The originals are only read. Nothing in the project is ever overwritten.

use crate::error::{AppError, AppResult};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The most `.prproj` files listed.
pub const MAX_PROJECTS: usize = 20;
/// The most unzipped XML read from one project. Real projects are a few MB; this stops a damaged file filling memory.
const MAX_XML_BYTES: u64 = 512 * 1024 * 1024;

/// Folder inside `04 Premiere & SFX` that holds the footage copied for Premiere projects.
pub const FOOTAGE_DIR: &str = "Footage";
/// Folder inside `04 Premiere & SFX` that holds the untouched copies of the projects.
pub const ORIGINAL_DIR: &str = "Original";

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub name: String,
    /// Full path, so the person's choice can be matched exactly.
    pub path: String,
    /// "beside" the After Effects project, "inside" a folder next to it, or in the folder "above" it.
    pub location: String,
    pub size: u64,
    pub modified: Option<i64>,
    /// Footage files the project uses that exist and would be copied.
    pub footage: usize,
    /// Footage files that cannot be found on this Mac.
    pub missing: usize,
    /// Total size of the footage that would be copied.
    pub bytes: u64,
}

// ---- reading and writing the file -------------------------------------------------------------------------------

/// The project's XML text.
pub fn read_xml(path: &Path) -> AppResult<String> {
    let file = fs::File::open(path).map_err(|e| AppError::io(path, e))?;
    let mut head = [0u8; 2];
    let mut reader = io::BufReader::new(file);
    {
        use io::BufRead;
        let buf = reader.fill_buf().map_err(|e| AppError::io(path, e))?;
        head[..buf.len().min(2)].copy_from_slice(&buf[..buf.len().min(2)]);
    }
    let mut bytes = Vec::new();
    let read = if head == [0x1f, 0x8b] {
        GzDecoder::new(reader).take(MAX_XML_BYTES + 1).read_to_end(&mut bytes)
    } else {
        reader.take(MAX_XML_BYTES + 1).read_to_end(&mut bytes)
    };
    read.map_err(|e| AppError::Invalid(format!("{} could not be read: {e}", file_name(path))))?;
    if bytes.len() as u64 > MAX_XML_BYTES {
        return Err(AppError::Invalid(format!("{} is too large to read.", file_name(path))));
    }
    let xml = String::from_utf8(bytes).map_err(|_| AppError::Invalid(format!("{} is not a Premiere Pro project.", file_name(path))))?;
    if !xml.contains("<PremiereData") {
        return Err(AppError::Invalid(format!("{} is not a Premiere Pro project.", file_name(path))));
    }
    Ok(xml)
}

fn gzip(xml: &str) -> io::Result<Vec<u8>> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(xml.as_bytes())?;
    enc.finish()
}

fn file_name(p: &Path) -> String {
    p.file_name().and_then(|n| n.to_str()).unwrap_or("The file").to_string()
}

// ---- finding clips in the XML -----------------------------------------------------------------------------------

fn decode(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn encode(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The `<Media ObjectUID=…>…</Media>` elements: (start, end) byte ranges. References like `<Media ObjectRef="3"/>` are not clips.
fn media_blocks(xml: &str) -> Vec<(usize, usize)> {
    const OPEN: &str = "<Media ObjectUID=";
    const CLOSE: &str = "</Media>";
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = xml[at..].find(OPEN) {
        let start = at + i;
        let Some(j) = xml[start..].find(CLOSE) else { break };
        let end = start + j + CLOSE.len();
        out.push((start, end));
        at = end;
    }
    out
}

/// Byte ranges of the text inside every `<tag>text</tag>` in `block`.
fn tag_texts(block: &str, tag: &str) -> Vec<(usize, usize)> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = block[at..].find(&open) {
        let from = at + i + open.len();
        let Some(j) = block[from..].find(&close) else { break };
        out.push((from, from + j));
        at = from + j + close.len();
    }
    out
}

/// The file a clip points at, with entities decoded.
fn clip_path(block: &str) -> Option<String> {
    for tag in ["ActualMediaFilePath", "FilePath"] {
        if let Some(&(a, b)) = tag_texts(block, tag).first() {
            let p = decode(&block[a..b]);
            if !p.trim().is_empty() {
                return Some(p);
            }
        }
    }
    None
}

/// Every distinct file the project's clips point at, in project order.
pub fn clip_paths(xml: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (a, b) in media_blocks(xml) {
        if let Some(p) = clip_path(&xml[a..b]) {
            if seen.insert(p.clone()) {
                out.push(p);
            }
        }
    }
    out
}

/// Point the clips named in `map` (old path → new absolute path and new path relative to the project file) at their copies.
/// Everything else in the text is kept byte for byte.
pub fn rewrite(xml: &str, map: &HashMap<String, (String, String)>) -> String {
    let mut out = String::with_capacity(xml.len() + 1024);
    let mut last = 0;
    for (a, b) in media_blocks(xml) {
        let block = &xml[a..b];
        let Some((abs, rel)) = clip_path(block).and_then(|p| map.get(&p)) else { continue };
        out.push_str(&xml[last..a]);
        let mut edits: Vec<(usize, usize, String)> = Vec::new();
        for tag in ["ActualMediaFilePath", "FilePath"] {
            for (s, e) in tag_texts(block, tag) {
                edits.push((s, e, encode(abs)));
            }
        }
        for (s, e) in tag_texts(block, "RelativePath") {
            edits.push((s, e, encode(rel)));
        }
        edits.sort_by_key(|x| x.0);
        let mut at = 0;
        for (s, e, text) in edits {
            out.push_str(&block[at..s]);
            out.push_str(&text);
            at = e;
        }
        out.push_str(&block[at..]);
        last = b;
    }
    out.push_str(&xml[last..]);
    out
}

// ---- what is on disk --------------------------------------------------------------------------------------------

/// Footage that is not a copyable file: another project (a Dynamic Link to After Effects, say).
fn is_project_link(p: &str) -> bool {
    let l = p.to_lowercase();
    l.ends_with(".aep") || l.ends_with(".aepx") || l.ends_with(".prproj")
}

/// The size of the real file at `p`, or `None` if there is no such file here (missing, a folder, or a path from another system).
fn file_size(p: &str) -> Option<u64> {
    let path = Path::new(p);
    if !path.is_absolute() {
        return None;
    }
    let m = fs::metadata(path).ok()?;
    m.is_file().then_some(m.len())
}

/// What the project's clips look like on this Mac: files that exist, files that are missing, the size of those that exist,
/// and clips that are another project (not counted as footage).
fn footage_counts(xml: &str) -> (usize, usize, u64, usize) {
    let (mut footage, mut missing, mut bytes, mut linked) = (0usize, 0usize, 0u64, 0usize);
    for p in clip_paths(xml) {
        if is_project_link(&p) {
            linked += 1;
            continue;
        }
        match file_size(&p) {
            Some(n) => {
                footage += 1;
                bytes += n;
            }
            None => missing += 1,
        }
    }
    (footage, missing, bytes, linked)
}

fn skipped(name: &str) -> bool {
    let l = name.to_lowercase();
    name.starts_with('.') || name.starts_with('~') || l.contains("auto-save") || l.contains("autosave") || !l.ends_with(".prproj")
}

/// `.prproj` files in the same folder as the After Effects project, in its direct subfolders (a `PR` folder, say) and in the
/// folder above it. Read-only; a file that
/// cannot be read as a Premiere project is left out.
pub fn find(open_path: &Path) -> Vec<Candidate> {
    let Some(dir) = open_path.parent() else { return Vec::new() };
    let mut places: Vec<(PathBuf, &str)> = vec![(dir.to_path_buf(), "beside")];
    if let Ok(entries) = fs::read_dir(dir) {
        let mut subs: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_lowercase();
                // Real folders only, and not hidden ones or After Effects' auto-save.
                !name.starts_with('.') && !name.contains("auto-save") && fs::symlink_metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false)
            })
            .map(|e| e.path())
            .collect();
        subs.sort();
        places.extend(subs.into_iter().take(50).map(|p| (p, "inside")));
    }
    if let Some(up) = dir.parent().filter(|u| u.parent().is_some()) {
        places.push((up.to_path_buf(), "above"));
    }
    let mut out: Vec<Candidate> = Vec::new();
    for (folder, location) in places {
        let Ok(entries) = fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
            if skipped(&name) {
                continue;
            }
            // Real files only: a link could point anywhere.
            let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
            if !meta.is_file() {
                continue;
            }
            let Ok(xml) = read_xml(&entry.path()) else { continue };
            let (footage, missing, bytes, _) = footage_counts(&xml);
            let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64);
            out.push(Candidate {
                name,
                path: entry.path().to_string_lossy().into_owned(),
                location: location.to_string(),
                size: meta.len(),
                modified,
                footage,
                missing,
                bytes,
            });
        }
    }
    // Beside first, then newest first, then by name so the order is stable.
    let rank = |l: &str| match l { "beside" => 0, "inside" => 1, _ => 2 };
    out.sort_by(|a, b| rank(&a.location).cmp(&rank(&b.location)).then(b.modified.cmp(&a.modified)).then(a.name.cmp(&b.name)));
    out.truncate(MAX_PROJECTS);
    out
}

// ---- the project's own Premiere files -----------------------------------------------------------------------------

/// A Premiere Pro project inside a Murre project's `04 Premiere & SFX` folder.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub name: String,
    /// Relative to the project folder, `/`-separated.
    pub path: String,
    pub absolute_path: String,
    pub size_bytes: u64,
    pub modified_at: u64,
    /// The file could be read as a Premiere project. If not, the counts are zero.
    pub readable: bool,
    /// Footage files that exist / are not found, and clips that link to another project.
    pub footage: usize,
    pub missing: usize,
    pub linked: usize,
}

/// The `.prproj` files directly inside `04 Premiere & SFX`, newest first. The untouched copies in `Original/` are not listed.
pub fn list_project(root: &Path) -> Vec<Listed> {
    let dir = root.join("04 Premiere & SFX");
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<Listed> = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if skipped(&name) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
        if !meta.is_file() {
            continue;
        }
        let (readable, footage, missing, linked) = match read_xml(&entry.path()) {
            Ok(xml) => {
                let (f, m, _, l) = footage_counts(&xml);
                (true, f, m, l)
            }
            Err(_) => (false, 0, 0, 0),
        };
        out.push(Listed {
            path: format!("04 Premiere & SFX/{name}"),
            absolute_path: entry.path().to_string_lossy().into_owned(),
            size_bytes: meta.len(),
            modified_at: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0),
            readable,
            footage,
            missing,
            linked,
            name,
        });
    }
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(a.name.cmp(&b.name)));
    out.truncate(100);
    out
}

// ---- collecting -------------------------------------------------------------------------------------------------

/// Copy `src` into `dir` under its own name, or `name (2).ext`, `name (3).ext`… if that is taken. Nothing is replaced.
fn copy_unique(src: &Path, dir: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.clone(), String::new()),
    };
    let mut from = fs::File::open(src)?;
    let modified = from.metadata().and_then(|m| m.modified()).ok();
    for n in 1..1000 {
        let candidate = if n == 1 { name.clone() } else { format!("{stem} ({n}){ext}") };
        let dest = dir.join(candidate);
        let mut to = match OpenOptions::new().write(true).create_new(true).open(&dest) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        if let Err(e) = io::copy(&mut from, &mut to).and_then(|_| to.sync_all()) {
            drop(to);
            let _ = fs::remove_file(&dest);
            return Err(e);
        }
        // Keep the date the file had, so Premiere still sees the same media.
        if let Some(t) = modified {
            let _ = to.set_modified(t);
        }
        return Ok(dest);
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "too many files with this name"))
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// Name of the saved project that points at the copies.
    pub project: Option<String>,
    pub copied: usize,
    /// Footage already inside the project folder: left where it is.
    pub inside: usize,
    /// Footage that is not on this Mac.
    pub missing: Vec<String>,
    /// Footage that is another project (After Effects links): not copied.
    pub linked: usize,
    pub failed: Vec<(String, String)>,
}

/// Collect one Premiere project into `premiere_dir` (the project's `04 Premiere & SFX`).
///
/// - `Original/<name>.prproj`: the untouched file, byte for byte.
/// - `Footage/…`: the footage it uses that is outside `project_root`.
/// - `<name>.prproj`: the project with its paths pointing at the copies.
///
/// `done` remembers which source file went where, so two projects using the same clip share one copy.
pub fn collect(prproj: &Path, premiere_dir: &Path, project_root: &Path, done: &mut HashMap<String, PathBuf>) -> AppResult<Report> {
    let xml = read_xml(prproj)?;
    let name = file_name(prproj);
    let footage_dir = premiere_dir.join(FOOTAGE_DIR);
    let mut report = Report::default();
    let mut map: HashMap<String, (String, String)> = HashMap::new();

    for p in clip_paths(&xml) {
        if is_project_link(&p) {
            report.linked += 1;
            continue;
        }
        let Some(_) = file_size(&p) else {
            report.missing.push(p);
            continue;
        };
        let src = Path::new(&p);
        if src.starts_with(project_root) {
            report.inside += 1;
            continue;
        }
        let dest = match done.get(&p) {
            Some(d) => d.clone(),
            None => match copy_unique(src, &footage_dir) {
                Ok(d) => {
                    report.copied += 1;
                    done.insert(p.clone(), d.clone());
                    d
                }
                Err(e) => {
                    report.failed.push((p.clone(), e.to_string()));
                    continue;
                }
            },
        };
        let rel = format!("./{FOOTAGE_DIR}/{}", dest.file_name().and_then(|n| n.to_str()).unwrap_or(""));
        map.insert(p, (dest.to_string_lossy().into_owned(), rel));
    }

    // The untouched copy first, so there is always a way back.
    copy_unique(prproj, &premiere_dir.join(ORIGINAL_DIR)).map_err(|e| AppError::io(prproj, e))?;

    // Then the project that points at the copies.
    let bytes = gzip(&rewrite(&xml, &map)).map_err(|e| AppError::io(prproj, e))?;
    let stem = name.strip_suffix(".prproj").or_else(|| name.strip_suffix(".PRPROJ")).unwrap_or(&name).to_string();
    for n in 1..1000 {
        let candidate = if n == 1 { name.clone() } else { format!("{stem} ({n}).prproj") };
        match crate::safe_fs::create_new(&premiere_dir.join(&candidate), &bytes) {
            Ok(()) => {
                report.project = Some(candidate);
                break;
            }
            Err(AppError::AlreadyExists(_)) => continue,
            Err(e) => return Err(e),
        }
    }
    // For the log: counts, and the files that were not found or not copied described by extension and size, never by name.
    {
        use crate::applog::{describe_file, info, warn};
        info(
            "premiere",
            &format!(
                "Collected a project: {} footage files copied, {} already inside, {} linked projects, {} not found, {} failed",
                report.copied,
                report.inside,
                report.linked,
                report.missing.len(),
                report.failed.len()
            ),
        );
        for p in report.missing.iter().take(20) {
            warn("premiere", &format!("Not found: {}", describe_file(p)));
        }
        for (p, why) in report.failed.iter().take(20) {
            warn("premiere", &format!("Not copied: {} ({why})", describe_file(p)));
        }
    }
    if report.project.is_none() {
        return Err(AppError::Invalid(format!("Could not save a copy of {name}: too many files with this name.")));
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(uid: &str, path: &str, rel: &str) -> String {
        format!(
            "<Media ObjectUID=\"{uid}\" ClassID=\"x\" Version=\"30\">\n\t<RelativePath>{rel}</RelativePath>\n\t<ActualMediaFilePath>{path}</ActualMediaFilePath>\n\t<FilePath>{path}</FilePath>\n\t<Title>t</Title>\n\t<RelativePath>{rel}</RelativePath>\n</Media>\n"
        )
    }

    fn project(clips: &[String]) -> String {
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\" ?>\n<PremiereData Version=\"3\">\n<Media ObjectRef=\"9\"/>\n{}<Other><FilePath>/keep/me.txt</FilePath></Other>\n</PremiereData>\n", clips.concat())
    }

    fn write_prproj(path: &Path, xml: &str) {
        fs::write(path, gzip(xml).unwrap()).unwrap();
    }

    #[test]
    fn reads_distinct_clip_paths_and_ignores_references_and_other_tags() {
        let x = project(&[clip("a", "/m/one.mp4", "./one.mp4"), clip("b", "/m/two &amp; three.wav", "./x"), clip("c", "/m/one.mp4", "./one.mp4")]);
        assert_eq!(clip_paths(&x), vec!["/m/one.mp4".to_string(), "/m/two & three.wav".to_string()]);
    }

    #[test]
    fn rewrite_changes_only_the_named_clips_and_only_their_path_tags() {
        let x = project(&[clip("a", "/m/one.mp4", "./one.mp4"), clip("b", "/m/two.wav", "../two.wav")]);
        let mut map = HashMap::new();
        map.insert("/m/one.mp4".to_string(), ("/p/Footage/one & co.mp4".to_string(), "./Footage/one & co.mp4".to_string()));
        let y = rewrite(&x, &map);
        assert_eq!(y.matches("/p/Footage/one &amp; co.mp4").count(), 2);
        assert_eq!(y.matches("./Footage/one &amp; co.mp4").count(), 2);
        assert!(y.contains("/m/two.wav") && y.contains("../two.wav"), "an untouched clip keeps its paths");
        assert!(y.contains("<Other><FilePath>/keep/me.txt</FilePath></Other>"));
        assert!(y.contains("<Media ObjectRef=\"9\"/>"));
        // With nothing to change the text is identical.
        assert_eq!(rewrite(&x, &HashMap::new()), x);
        assert_eq!(clip_paths(&y), vec!["/p/Footage/one & co.mp4".to_string(), "/m/two.wav".to_string()]);
    }

    #[test]
    fn collecting_copies_footage_keeps_the_original_and_points_the_new_file_at_the_copies() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("elsewhere");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.mp4"), "AAAA").unwrap();
        fs::write(src.join("sub/a.mp4"), "BBBB").unwrap(); // same name, different file
        let root = d.path().join("Proj");
        let pdir = root.join("04 Premiere & SFX");
        fs::create_dir_all(&pdir).unwrap();
        fs::write(root.join("inside.wav"), "I").unwrap();
        let p = |s: &str| src.join(s).to_string_lossy().into_owned();
        let x = project(&[
            clip("1", &p("a.mp4"), "./a.mp4"),
            clip("2", &p("sub/a.mp4"), "./sub/a.mp4"),
            clip("3", &p("gone.mov"), "./gone.mov"),
            clip("4", &root.join("inside.wav").to_string_lossy(), "x"),
            clip("5", "/somewhere/comp.aep", "x"),
        ]);
        let prproj = src.join("Film.prproj");
        write_prproj(&prproj, &x);
        let before = fs::read(&prproj).unwrap();

        let found = find(&src.join("Film_v1.aep"));
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].footage, found[0].missing, found[0].bytes, found[0].location.as_str()), (3, 1, 9, "beside"));

        let mut done = HashMap::new();
        let r = collect(&prproj, &pdir, &root, &mut done).unwrap();
        assert_eq!((r.copied, r.inside, r.linked, r.missing.len(), r.failed.len()), (2, 1, 1, 1, 0));
        assert_eq!(r.project.as_deref(), Some("Film.prproj"));
        assert_eq!(fs::read(&prproj).unwrap(), before, "the original is not touched");
        assert_eq!(fs::read(pdir.join("Original/Film.prproj")).unwrap(), before);
        assert_eq!(fs::read_to_string(pdir.join("Footage/a.mp4")).unwrap(), "AAAA");
        assert_eq!(fs::read_to_string(pdir.join("Footage/a (2).mp4")).unwrap(), "BBBB");

        let new = read_xml(&pdir.join("Film.prproj")).unwrap();
        let paths = clip_paths(&new);
        assert_eq!(paths[0], pdir.join("Footage/a.mp4").to_string_lossy());
        assert_eq!(paths[1], pdir.join("Footage/a (2).mp4").to_string_lossy());
        assert_eq!(paths[2], p("gone.mov"), "missing footage keeps its path");
        assert!(new.contains("<RelativePath>./Footage/a (2).mp4</RelativePath>"));

        // A second project using the same clip reuses the copy, and a repeat never replaces a saved project.
        let again = collect(&prproj, &pdir, &root, &mut done).unwrap();
        assert_eq!(again.copied, 0);
        assert_eq!(again.project.as_deref(), Some("Film (2).prproj"));
        assert!(pdir.join("Original/Film (2).prproj").is_file());
    }

    #[test]
    fn finds_projects_beside_and_above_and_skips_what_is_not_a_project() {
        let d = tempfile::tempdir().unwrap();
        let up = d.path().join("Work");
        let here = up.join("Film");
        fs::create_dir_all(&here).unwrap();
        write_prproj(&here.join("Cut.prproj"), &project(&[clip("1", "/nope/x.mp4", "x")]));
        write_prproj(&up.join("Other.prproj"), &project(&[]));
        fs::create_dir_all(here.join("PR")).unwrap();
        write_prproj(&here.join("PR/Deep.prproj"), &project(&[]));
        write_prproj(&here.join("Cut-autosave.prproj"), &project(&[]));
        fs::write(here.join("Broken.prproj"), "not a project").unwrap();
        let found = find(&here.join("Film.aep"));
        let names: Vec<_> = found.iter().map(|c| (c.name.as_str(), c.location.as_str(), c.missing)).collect();
        assert!(names.contains(&("Cut.prproj", "beside", 1)) && names.contains(&("Other.prproj", "above", 0)));
        assert!(names.contains(&("Deep.prproj", "inside", 0)));
        assert_eq!(names.len(), 3);
    }

    #[test]
    fn lists_a_projects_own_premiere_files_without_the_originals() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("04 Premiere & SFX");
        fs::create_dir_all(dir.join("Original")).unwrap();
        fs::create_dir_all(dir.join("Footage")).unwrap();
        let real = d.path().join("real.mp4");
        fs::write(&real, "x").unwrap();
        write_prproj(
            &dir.join("Cut.prproj"),
            &project(&[clip("1", &real.to_string_lossy(), "x"), clip("2", "/gone.mov", "x"), clip("3", "/c/comp.aep", "x")]),
        );
        write_prproj(&dir.join("Original/Cut.prproj"), &project(&[]));
        fs::write(dir.join("Odd.prproj"), "nope").unwrap();
        fs::write(dir.join("notes.txt"), "x").unwrap();
        let l = list_project(d.path());
        let names: Vec<_> = l.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(l.len(), 2, "{names:?}");
        let cut = l.iter().find(|x| x.name == "Cut.prproj").unwrap();
        assert_eq!((cut.readable, cut.footage, cut.missing, cut.linked), (true, 1, 1, 1));
        assert_eq!(cut.path, "04 Premiere & SFX/Cut.prproj");
        assert!(!l.iter().find(|x| x.name == "Odd.prproj").unwrap().readable);
        assert!(list_project(&d.path().join("nothing")).is_empty());
    }

    #[test]
    fn an_unzipped_project_is_also_read() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("Plain.prproj");
        fs::write(&f, project(&[clip("1", "/m/a.mp4", "x")])).unwrap();
        assert_eq!(clip_paths(&read_xml(&f).unwrap()), vec!["/m/a.mp4".to_string()]);
    }
}
