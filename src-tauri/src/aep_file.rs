//! Reading an After Effects project file (`.aep`) directly, without After Effects or the Companion.
//!
//! Read-only: files are only ever opened for reading. The format is not documented by Adobe; what is read here was
//! worked out from real projects and checked against what the Companion records (`comps.json`, `assets.json`,
//! `fonts.json`). Anything that doesn't look as expected is skipped, so a future After Effects that moves things
//! makes this return less, never something wrong. The Companion's scan stays the main source when there is one.
//!
//! Layout: a RIFX container (big-endian `id, size, data` chunks; `LIST` chunks hold a 4-letter kind and children)
//! whose form type is `Egg!`, followed by an XMP packet.
//! - `head`: the After Effects version that saved the file, as bit fields (see [`version_of`]).
//! - `LIST:Item`: every project item. `idta` gives its kind (1 folder, 4 composition, 7 footage) and id, `Utf8` its
//!   name, `cdta` a composition's size, frame duration and duration.
//! - `alas`: a JSON object with a file's `fullpath` (footage, or a render queue output folder under `LRdr`).
//! - `LIST:EfDf` > `tdmn`: the match name of every effect the project uses.
//! - Text documents (`LIST:btdk`, whose body is text, not chunks) name their fonts as
//!   `/CoolTypeFont /0 << /0 (<UTF-16 name>)`.
//! - XMP: which program saved it, when, and the document ids that link a file to the one it was saved from.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

/// Bigger files are not read (the reader holds the whole file in memory).
const MAX_BYTES: u64 = 1024 * 1024 * 1024;
/// Guards against a damaged file that nests lists without end.
const MAX_DEPTH: usize = 96;
const MAX_LIST: usize = 20_000;
/// Fonts the text engine records in every project whether or not a layer uses them.
const TEXT_ENGINE_DEFAULTS: &[&str] = &["AdobeInvisFont", "Myriad-Roman", "MyriadPro-Regular"];

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AepComp {
    /// The id After Effects uses for the composition (the same one the Companion records).
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    /// Seconds.
    pub duration: f64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AepInfo {
    /// The After Effects version that saved the file, as "27.1".
    pub saved_with: Option<String>,
    pub major: Option<u32>,
    pub build: Option<u32>,
    /// Saved by a beta of After Effects.
    pub beta: bool,
    /// "Mac" or "Windows", from the program that saved it.
    pub platform: Option<String>,
    /// ISO 8601 times written into the file by After Effects (they survive copying, unlike file dates).
    pub created_at: Option<String>,
    pub saved_at: Option<String>,
    /// This file's own document id.
    pub document_id: Option<String>,
    /// The document the whole family started from: every "Save As" copy keeps it.
    pub original_document_id: Option<String>,
    /// The save this file was made from ("saved to new location"), when it was.
    pub derived_from: Option<String>,
    /// Every save recorded in this file's history (its own and its ancestors' in-file saves).
    pub saves: Vec<String>,
    pub comps: Vec<AepComp>,
    /// Absolute paths of footage files, as After Effects saved them.
    pub footage: Vec<String>,
    /// Match names of every effect used, e.g. "ADBE Gaussian Blur 2" or "CC Particle Systems II".
    pub effects: Vec<String>,
    /// PostScript names of the fonts text layers use.
    pub fonts: Vec<String>,
    /// Render queue output folders.
    pub render_outputs: Vec<String>,
}

/// Read `path` (an `.aep`). Results are kept for the session while the file's size and date stay the same.
pub fn read(path: &Path) -> AppResult<Arc<AepInfo>> {
    static CACHE: Mutex<Option<HashMap<PathBuf, (u64, u128, Arc<AepInfo>)>>> = Mutex::new(None);
    let meta = fs::metadata(path).map_err(|e| AppError::io(path, e))?;
    if !meta.is_file() {
        return Err(AppError::Invalid("That is not a file.".into()));
    }
    if meta.len() > MAX_BYTES {
        return Err(AppError::Invalid("That project file is too big to read here.".into()));
    }
    let stamp = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
    {
        let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((len, at, info)) = cache.as_ref().and_then(|c| c.get(path))
            && *len == meta.len()
            && *at == stamp
        {
            return Ok(info.clone());
        }
    }
    let bytes = fs::read(path).map_err(|e| AppError::io(path, e))?;
    let info = Arc::new(parse(&bytes)?);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let map = cache.get_or_insert_with(HashMap::new);
    if map.len() > 256 {
        map.clear();
    }
    map.insert(path.to_path_buf(), (meta.len(), stamp, info.clone()));
    Ok(info)
}

enum Node<'a> {
    Chunk([u8; 4], &'a [u8]),
    List([u8; 4], Vec<Node<'a>>),
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2).map(|s| u16::from_be_bytes([s[0], s[1]]))
}

fn chunks(b: &[u8], depth: usize) -> Vec<Node<'_>> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at + 8 <= b.len() && out.len() < MAX_LIST {
        let id = [b[at], b[at + 1], b[at + 2], b[at + 3]];
        let size = be32(b, at + 4).unwrap_or(0) as usize;
        let start = at + 8;
        let Some(data) = b.get(start..start.saturating_add(size)) else { break };
        if &id == b"LIST" && data.len() >= 4 && &data[0..4] == b"btdk" {
            // A text document: its body is text ("<< /0 << ... >> >>"), not chunks.
            out.push(Node::Chunk(*b"btdk", &data[4..]));
        } else if &id == b"LIST" && data.len() >= 4 && depth < MAX_DEPTH {
            out.push(Node::List([data[0], data[1], data[2], data[3]], chunks(&data[4..], depth + 1)));
        } else {
            out.push(Node::Chunk(id, data));
        }
        at = start + size + (size & 1);
    }
    out
}

/// The program version in a `head` chunk. Bits of the u32 at offset 4, from the top: the major version is bits 1–5
/// followed by bits 10–12, the minor bits 13–16, and the low byte is the build. Checked against files saved by
/// After Effects 23 to 27.
pub fn version_of(head: &[u8]) -> Option<(u32, u32, u32)> {
    let v = be32(head, 4)?;
    let major = ((v >> 26) & 0x1f) << 3 | ((v >> 19) & 0x7);
    let minor = (v >> 15) & 0xf;
    let build = v & 0xff;
    (major >= 5).then_some((major, minor, build))
}

/// The text between `<tag>` and `</tag>` in the XMP packet.
fn xmp_tag<'a>(xmp: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = xmp.find(&open)? + open.len();
    let end = xmp[start..].find('<')? + start;
    Some(xmp[start..end].trim()).filter(|s| !s.is_empty())
}

fn read_xmp(bytes: &[u8], info: &mut AepInfo) {
    let Some(start) = find_last(bytes, b"<x:xmpmeta") else { return };
    let Some(len) = find(&bytes[start..], b"</x:xmpmeta>") else { return };
    let Ok(xmp) = std::str::from_utf8(&bytes[start..start + len]) else { return };
    if let Some(tool) = xmp_tag(xmp, "xmp:CreatorTool") {
        info.beta = tool.contains("(Beta)");
        info.platform = if tool.contains("Macintosh") {
            Some("Mac".into())
        } else if tool.contains("Windows") {
            Some("Windows".into())
        } else {
            None
        };
    }
    info.created_at = xmp_tag(xmp, "xmp:CreateDate").map(str::to_string);
    info.saved_at = xmp_tag(xmp, "xmp:ModifyDate").map(str::to_string);
    info.document_id = xmp_tag(xmp, "xmpMM:DocumentID").map(str::to_string);
    info.original_document_id = xmp_tag(xmp, "xmpMM:OriginalDocumentID").map(str::to_string);
    if let Some(derived) = xmp.find("<xmpMM:DerivedFrom") {
        info.derived_from = xmp_tag(&xmp[derived..], "stRef:instanceID").map(str::to_string);
    }
    let mut rest = xmp;
    while let Some(i) = rest.find("<stEvt:instanceID>") {
        if let Some(id) = xmp_tag(&rest[i..], "stEvt:instanceID") {
            info.saves.push(id.to_string());
        }
        rest = &rest[i + 18..];
    }
    if let Some(own) = xmp_tag(xmp, "xmpMM:InstanceID")
        && !info.saves.iter().any(|s| s == own)
    {
        info.saves.push(own.to_string());
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn find_last(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).rposition(|w| w == needle)
}

/// Font names in a text document: `/CoolTypeFont /0 << /0 (` then a UTF-16 string (with a BOM) up to `)`.
fn fonts_in(data: &[u8], out: &mut BTreeSet<String>) {
    const MARK: &[u8] = b"/CoolTypeFont /0 << /0 (\xfe\xff";
    let mut at = 0;
    while let Some(i) = find(&data[at..], MARK) {
        let start = at + i + MARK.len();
        let mut units = Vec::new();
        let mut j = start;
        while j + 1 < data.len() && units.len() < 128 {
            let (hi, lo) = (data[j], data[j + 1]);
            // A backslash escapes the next byte; a lone ")" ends the string.
            if hi == b'\\' {
                j += 1;
                continue;
            }
            if hi == b')' {
                break;
            }
            units.push(u16::from_be_bytes([hi, lo]));
            j += 2;
        }
        if let Ok(name) = String::from_utf16(&units)
            && !name.is_empty()
            && name.chars().all(|c| !c.is_control())
        {
            out.insert(name);
        }
        at = j.max(start);
    }
}

#[derive(Default)]
struct Walk {
    comps: Vec<AepComp>,
    footage: BTreeSet<String>,
    effects: Vec<String>,
    fonts: BTreeSet<String>,
    outputs: BTreeSet<String>,
}

fn text(data: &[u8]) -> String {
    String::from_utf8_lossy(data.split(|b| *b == 0).next().unwrap_or(&[])).into_owned()
}

fn comp_of(idta: &[u8], name: Option<&[u8]>, cdta: &[u8]) -> Option<AepComp> {
    let id = be32(idta, 16)?;
    let (step, scale) = (be32(cdta, 4)?, be32(cdta, 8)?);
    let (length, length_scale) = (be32(cdta, 44)?, be32(cdta, 48)?);
    let (width, height) = (be16(cdta, 140)? as u32, be16(cdta, 142)? as u32);
    if step == 0 || length_scale == 0 || width == 0 || height == 0 {
        return None;
    }
    Some(AepComp {
        id,
        name: name.map(|n| String::from_utf8_lossy(n).into_owned()).unwrap_or_default(),
        width,
        height,
        frame_rate: scale as f64 / step as f64,
        duration: length as f64 / length_scale as f64,
    })
}

fn walk(nodes: &[Node], parents: &mut Vec<[u8; 4]>, w: &mut Walk) {
    for node in nodes {
        match node {
            Node::List(kind, children) => {
                if kind == b"Item" {
                    let direct = |id: &[u8; 4]| {
                        children.iter().find_map(|c| match c {
                            Node::Chunk(cid, d) if cid == id => Some(*d),
                            _ => None,
                        })
                    };
                    if let (Some(idta), Some(cdta)) = (direct(b"idta"), direct(b"cdta"))
                        && be16(idta, 0) == Some(4)
                        && let Some(c) = comp_of(idta, direct(b"Utf8"), cdta)
                    {
                        w.comps.push(c);
                    }
                }
                if kind == b"EfDf" {
                    for c in children {
                        if let Node::Chunk(id, d) = c
                            && id == b"tdmn"
                        {
                            let name = text(d);
                            if !name.is_empty() && !w.effects.contains(&name) {
                                w.effects.push(name);
                            }
                        }
                    }
                }
                parents.push(*kind);
                walk(children, parents, w);
                parents.pop();
            }
            Node::Chunk(id, data) => {
                if id == b"alas" {
                    let Ok(v) = serde_json::from_slice::<serde_json::Value>(data) else { continue };
                    let Some(p) = v.get("fullpath").and_then(|p| p.as_str()).filter(|p| !p.is_empty()) else { continue };
                    if parents.iter().any(|k| k == b"LRdr") {
                        w.outputs.insert(p.to_string());
                    } else if v.get("target_is_folder").and_then(|f| f.as_bool()) != Some(true) {
                        w.footage.insert(p.to_string());
                    }
                } else if id == b"btdk" {
                    fonts_in(data, &mut w.fonts);
                }
            }
        }
    }
}

/// Read an `.aep` held in memory.
pub fn parse(bytes: &[u8]) -> AppResult<AepInfo> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFX" || &bytes[8..12] != b"Egg!" {
        return Err(AppError::Invalid("That is not an After Effects project file.".into()));
    }
    let size = be32(bytes, 4).unwrap_or(0) as usize;
    let body = &bytes[12..(8 + size).min(bytes.len()).max(12)];
    let nodes = chunks(body, 0);
    let mut info = AepInfo::default();
    if let Some(Node::Chunk(_, head)) = nodes.iter().find(|n| matches!(n, Node::Chunk(id, _) if id == b"head"))
        && let Some((major, minor, build)) = version_of(head)
    {
        info.saved_with = Some(format!("{major}.{minor}"));
        info.major = Some(major);
        info.build = Some(build);
    }
    let mut w = Walk::default();
    walk(&nodes, &mut Vec::new(), &mut w);
    info.comps = w.comps;
    info.footage = w.footage.into_iter().collect();
    info.effects = w.effects;
    info.fonts = w.fonts.into_iter().filter(|f| !TEXT_ENGINE_DEFAULTS.contains(&f.as_str())).collect();
    info.render_outputs = w.outputs.into_iter().collect();
    read_xmp(bytes, &mut info);
    Ok(info)
}

/// What the versions list shows for one `.aep`, read from the file.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VersionDetail {
    /// Project-relative path, as in the versions list.
    pub path: String,
    pub saved_with: Option<String>,
    pub build: Option<u32>,
    pub beta: bool,
    pub platform: Option<String>,
    pub saved_at: Option<String>,
    pub comps: usize,
    pub footage: usize,
    /// The version this one was saved from, when it is in the list.
    pub parent: Option<String>,
    /// `false` when it started as a different document from the project's current file (a template, or another
    /// project's file saved here). `None` when that can't be told.
    pub same_project: Option<bool>,
    /// Saved by an After Effects newer than any installed here, so this computer can't open it.
    pub too_new: bool,
    /// Couldn't be read (not an After Effects binary project, damaged, or too big).
    pub unreadable: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveDetail {
    pub path: String,
    pub saved_at: Option<String>,
    /// The version in the list it belongs to (the same document family, saved from it).
    pub parent: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VersionDetails {
    pub versions: Vec<VersionDetail>,
    pub auto_saves: Vec<AutoSaveDetail>,
    /// The newest After Effects installed here (26 for 2026).
    pub installed_major: Option<u32>,
}

/// `.aep` files in the project's auto-save folders (After Effects names them "Auto-Save" or
/// "Adobe After Effects Auto-Save"), a few levels deep, newest first by name order.
fn auto_save_files(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize, false)];
    while let Some((dir, rel, depth, inside)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(e.path()) else { continue };
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if meta.is_dir() && depth < 4 {
                let auto = inside || name.to_lowercase().contains("auto-save");
                stack.push((e.path(), child, depth + 1, auto));
            } else if inside && meta.is_file() && name.to_lowercase().ends_with(".aep") && found.len() < 200 {
                found.push(child);
            }
        }
    }
    found.sort();
    found
}

/// Read every listed version (and the project's auto-saves) and work out how they relate. `current` is the file the
/// project treats as current; its family decides which files belong to the project.
pub fn version_details(root: &Path, rels: &[String], current: Option<&str>, installed_major: Option<u32>) -> VersionDetails {
    let read_rel = |rel: &str| -> Option<Arc<AepInfo>> {
        let (_, path, _) = crate::assets::resolve_inside(root, rel).ok()?;
        read(&path).ok()
    };
    let infos: Vec<(String, Option<Arc<AepInfo>>)> = rels.iter().map(|r| (r.clone(), read_rel(r))).collect();
    let family_of = |i: &AepInfo| i.original_document_id.clone().or_else(|| i.document_id.clone());
    let main_family = current
        .and_then(|c| infos.iter().find(|(r, _)| r == c))
        .or_else(|| infos.first())
        .and_then(|(_, i)| i.as_ref().and_then(|i| family_of(i)));
    // The listed file `info` was saved from: one whose history holds the save it derives from, else the family's
    // first document.
    let parent_of = |me: &str, info: &AepInfo| -> Option<String> {
        let from = info.derived_from.as_deref();
        infos
            .iter()
            .filter(|(r, _)| r != me)
            .find(|(_, o)| o.as_ref().is_some_and(|o| from.is_some_and(|f| o.saves.iter().any(|s| s == f))))
            .or_else(|| {
                infos.iter().filter(|(r, _)| r != me).find(|(_, o)| {
                    o.as_ref().is_some_and(|o| o.document_id.is_some() && o.document_id == info.original_document_id && o.document_id != info.document_id)
                })
            })
            .map(|(r, _)| r.clone())
    };
    let versions = infos
        .iter()
        .map(|(rel, info)| match info {
            None => VersionDetail { path: rel.clone(), unreadable: true, ..Default::default() },
            Some(i) => VersionDetail {
                path: rel.clone(),
                saved_with: i.saved_with.clone(),
                build: i.build,
                beta: i.beta,
                platform: i.platform.clone(),
                saved_at: i.saved_at.clone(),
                comps: i.comps.len(),
                footage: i.footage.len(),
                parent: parent_of(rel, i),
                same_project: match (&main_family, family_of(i)) {
                    (Some(m), Some(f)) => Some(*m == f),
                    _ => None,
                },
                too_new: matches!((i.major, installed_major), (Some(m), Some(have)) if m > have),
                unreadable: false,
            },
        })
        .collect();
    let auto_saves = auto_save_files(root)
        .into_iter()
        .filter_map(|rel| {
            let i = read_rel(&rel)?;
            let parent = parent_of(&rel, &i).or_else(|| {
                infos
                    .iter()
                    .find(|(_, o)| o.as_ref().is_some_and(|o| o.document_id.is_some() && o.document_id == family_of(&i)))
                    .map(|(r, _)| r.clone())
            });
            Some(AutoSaveDetail { path: rel, saved_at: i.saved_at.clone(), parent })
        })
        .collect();
    VersionDetails { versions, auto_saves, installed_major }
}

/// What changed from one version of a project to another, read from the two files.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VersionDiff {
    pub comps_added: Vec<String>,
    pub comps_removed: Vec<String>,
    /// "Main Comp: 1920×1080 → 3840×2160, 30 s → 45 s".
    pub comps_changed: Vec<String>,
    /// File names.
    pub footage_added: Vec<String>,
    pub footage_removed: Vec<String>,
    pub effects_added: Vec<String>,
    pub fonts_added: Vec<String>,
    pub fonts_removed: Vec<String>,
}

fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

fn seconds(s: f64) -> String {
    if (s - s.round()).abs() < 0.005 { format!("{} s", s.round()) } else { format!("{s:.2} s") }
}

/// Compare `old` with `new`. Compositions are matched by their After Effects id, so a renamed comp shows as renamed.
pub fn compare(old: &AepInfo, new: &AepInfo) -> VersionDiff {
    let mut d = VersionDiff::default();
    for c in &new.comps {
        match old.comps.iter().find(|o| o.id == c.id) {
            None => d.comps_added.push(c.name.clone()),
            Some(o) => {
                let mut what = Vec::new();
                if o.name != c.name {
                    what.push(format!("renamed from “{}”", o.name));
                }
                if (o.width, o.height) != (c.width, c.height) {
                    what.push(format!("{}×{} → {}×{}", o.width, o.height, c.width, c.height));
                }
                if (o.frame_rate - c.frame_rate).abs() > 0.001 {
                    what.push(format!("{} → {} fps", (o.frame_rate * 100.0).round() / 100.0, (c.frame_rate * 100.0).round() / 100.0));
                }
                if (o.duration - c.duration).abs() > 0.005 {
                    what.push(format!("{} → {}", seconds(o.duration), seconds(c.duration)));
                }
                if !what.is_empty() {
                    d.comps_changed.push(format!("{}: {}", c.name, what.join(", ")));
                }
            }
        }
    }
    d.comps_removed = old.comps.iter().filter(|o| !new.comps.iter().any(|c| c.id == o.id)).map(|o| o.name.clone()).collect();
    d.footage_added = new.footage.iter().filter(|f| !old.footage.contains(f)).map(|f| file_name(f)).collect();
    d.footage_removed = old.footage.iter().filter(|f| !new.footage.contains(f)).map(|f| file_name(f)).collect();
    d.effects_added = new.effects.iter().filter(|e| !old.effects.contains(e)).cloned().collect();
    d.fonts_added = new.fonts.iter().filter(|f| !old.fonts.contains(f)).cloned().collect();
    d.fonts_removed = old.fonts.iter().filter(|f| !new.fonts.contains(f)).cloned().collect();
    d
}

/// The project's main `.aep`, read: the one marked current, else the most recently saved version. Used where the
/// Companion hasn't scanned the project yet.
pub fn project_aep(root: &Path) -> Option<(String, Arc<AepInfo>)> {
    let scan = crate::workfiles::scan(root).ok()?;
    let rel = scan
        .current_aep
        .filter(|c| c.exists)
        .map(|c| c.path)
        .or_else(|| scan.workfiles.iter().max_by_key(|w| w.modified_at).map(|w| w.path.clone()))?;
    let (_, path, _) = crate::assets::resolve_inside(root, &rel).ok()?;
    read(&path).ok().map(|i| (rel, i))
}

/// Whether `path` (as After Effects saved it) is inside the project folder `root`. Letter case is ignored on
/// Windows, where file names are not case-sensitive.
pub fn is_inside(root: &Path, path: &str) -> bool {
    let root = crate::platform::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let norm = |p: &str| {
        let p = p.replace('\\', "/");
        if cfg!(windows) { p.to_lowercase() } else { p }
    };
    let (r, p) = (norm(&root.to_string_lossy()), norm(path));
    p.starts_with(&format!("{}/", r.trim_end_matches('/')))
}

/// A line for a project card: the project's main format and how many comps it has, from its main `.aep`.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub comps: usize,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    pub saved_with: Option<String>,
    pub beta: bool,
}

/// The format of the comps marked Main (`main_ids`), else the most common one among comps longer than a second.
pub fn summary(info: &AepInfo, main_ids: &[i64]) -> Option<ProjectSummary> {
    let main = info.comps.iter().find(|c| main_ids.contains(&(c.id as i64)));
    let common = || {
        // Count each format, and how long its comps run in total to break ties (a long edit beats a short matte).
        let mut counts: Vec<((u32, u32, u64), usize, f64)> = Vec::new();
        for c in info.comps.iter().filter(|c| c.duration > 1.0) {
            let key = (c.width, c.height, (c.frame_rate * 1000.0).round() as u64);
            match counts.iter_mut().find(|(k, _, _)| *k == key) {
                Some((_, n, total)) => {
                    *n += 1;
                    *total += c.duration;
                }
                None => counts.push((key, 1, c.duration)),
            }
        }
        let best = counts.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(a.2.total_cmp(&b.2)))?.0;
        info.comps.iter().find(|c| (c.width, c.height, (c.frame_rate * 1000.0).round() as u64) == best)
    };
    let c = main.or_else(common)?;
    Some(ProjectSummary {
        comps: info.comps.len(),
        width: c.width,
        height: c.height,
        frame_rate: (c.frame_rate * 100.0).round() / 100.0,
        saved_with: info.saved_with.clone(),
        beta: info.beta,
    })
}

/// One thing found in a project's main `.aep` by a library search.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryHit {
    pub project_id: String,
    pub project_name: String,
    /// `footage`, `font` or `effect`.
    pub kind: &'static str,
    /// The file name, font or effect match name.
    pub value: String,
}

/// Footage file names, fonts and effects in `info` that contain `query` (ignoring case).
pub fn search(info: &AepInfo, query: &str, project_id: &str, project_name: &str, out: &mut Vec<LibraryHit>) {
    let q = query.to_lowercase();
    let mut push = |kind: &'static str, value: String| {
        if value.to_lowercase().contains(&q) && !out.iter().any(|h| h.project_id == project_id && h.kind == kind && h.value == value) {
            out.push(LibraryHit { project_id: project_id.into(), project_name: project_name.into(), kind, value });
        }
    };
    for f in &info.footage {
        push("footage", file_name(f));
    }
    for f in &info.fonts {
        push("font", f.clone());
    }
    for e in &info.effects {
        push("effect", e.clone());
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn chunk(id: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut v = id.to_vec();
        v.extend((data.len() as u32).to_be_bytes());
        v.extend(data);
        if data.len() % 2 == 1 {
            v.push(0);
        }
        v
    }

    fn list(kind: &[u8; 4], children: &[Vec<u8>]) -> Vec<u8> {
        let mut data = kind.to_vec();
        for c in children {
            data.extend(c);
        }
        chunk(b"LIST", &data)
    }

    fn comp_item(id: u32, name: &str, w: u16, h: u16, step: u32, scale: u32, length: u32) -> Vec<u8> {
        let mut idta = vec![0u8; 20];
        idta[0..2].copy_from_slice(&4u16.to_be_bytes());
        idta[16..20].copy_from_slice(&id.to_be_bytes());
        let mut cdta = vec![0u8; 204];
        cdta[4..8].copy_from_slice(&step.to_be_bytes());
        cdta[8..12].copy_from_slice(&scale.to_be_bytes());
        cdta[44..48].copy_from_slice(&length.to_be_bytes());
        cdta[48..52].copy_from_slice(&scale.to_be_bytes());
        cdta[140..142].copy_from_slice(&w.to_be_bytes());
        cdta[142..144].copy_from_slice(&h.to_be_bytes());
        list(b"Item", &[chunk(b"idta", &idta), chunk(b"Utf8", name.as_bytes()), chunk(b"cdta", &cdta)])
    }

    /// A small but real-shaped project: the head of a 27.1 build 45 file, one comp at 30 fps and one at 29.97,
    /// a footage file, a render output folder, two effects, a text document with fonts, and an XMP packet.
    pub(crate) fn sample(doc: &str, original: &str, derived_from: Option<&str>) -> Vec<u8> {
        let mut head = vec![0u8; 20];
        head[0..4].copy_from_slice(&[0x00, 0x62, 0x00, 0x07]);
        head[4..8].copy_from_slice(&[0x0f, 0x98, 0x84, 0x2d]);
        let footage = chunk(b"alas", br#"{"fullpath":"/p/02 Assets/logo.png","target_is_folder":false}"#);
        let output = list(b"LRdr", &[list(b"LItm", &[chunk(b"alas", br#"{"fullpath":"/p/05 Pre-Renders","target_is_folder":true}"#)])]);
        let effects = list(b"EfdG", &[list(b"EfDf", &[chunk(b"tdmn", b"ADBE Gaussian Blur 2\0\0\0")]), list(b"EfDf", &[chunk(b"tdmn", b"CC Bend It\0")])]);
        let mut doc_bytes = b"<< /0 << /99 /CoolTypeFont /0 << /0 (\xfe\xff".to_vec();
        doc_bytes.extend("Inter-Medium".encode_utf16().flat_map(|u| u.to_be_bytes()));
        doc_bytes.extend(b") >> >> /0 << /99 /CoolTypeFont /0 << /0 (\xfe\xff");
        doc_bytes.extend("MyriadPro-Regular".encode_utf16().flat_map(|u| u.to_be_bytes()));
        doc_bytes.extend(b") >>");
        let mut btdk = b"btdk".to_vec();
        btdk.extend(&doc_bytes);
        let text = list(b"Item", &[list(b"Layr", &[chunk(b"LIST", &btdk)])]);
        let mut body = b"Egg!".to_vec();
        for c in [
            chunk(b"head", &head),
            list(b"Fold", &[comp_item(1, "Main Comp", 1920, 1080, 1024, 30720, 921600), comp_item(9, "Matte", 3840, 2160, 1001, 30000, 43043), list(b"Item", &[list(b"Pin ", &[list(b"Als2", &[footage])])]), text]),
            effects,
            output,
        ] {
            body.extend(c);
        }
        let mut file = b"RIFX".to_vec();
        file.extend((body.len() as u32).to_be_bytes());
        file.extend(body);
        let derived = derived_from
            .map(|d| format!("<xmpMM:DerivedFrom rdf:parseType=\"Resource\"><stRef:instanceID>{d}</stRef:instanceID></xmpMM:DerivedFrom>"))
            .unwrap_or_default();
        file.extend(format!(
            "<x:xmpmeta><xmp:CreatorTool>Adobe After Effects (Beta) (Macintosh)</xmp:CreatorTool>\
             <xmp:CreateDate>2026-11-14T23:17:14+05:30</xmp:CreateDate><xmp:ModifyDate>2026-11-14T23:26:46+05:30</xmp:ModifyDate>\
             <xmpMM:InstanceID>iid:{doc}-last</xmpMM:InstanceID><xmpMM:DocumentID>{doc}</xmpMM:DocumentID>\
             <xmpMM:OriginalDocumentID>{original}</xmpMM:OriginalDocumentID>\
             <xmpMM:History><rdf:Seq><rdf:li><stEvt:instanceID>iid:{doc}-1</stEvt:instanceID></rdf:li></rdf:Seq></xmpMM:History>{derived}</x:xmpmeta>"
        ).as_bytes());
        file
    }

    #[test]
    fn reads_version_comps_footage_effects_fonts_and_lineage() {
        let info = parse(&sample("did:b", "did:a", Some("iid:did:a-1"))).unwrap();
        assert_eq!((info.saved_with.as_deref(), info.build), (Some("27.1"), Some(45)));
        assert!(info.beta);
        assert_eq!(info.platform.as_deref(), Some("Mac"));
        assert_eq!(info.saved_at.as_deref(), Some("2026-11-14T23:26:46+05:30"));
        assert_eq!(info.comps.len(), 2);
        assert_eq!((info.comps[0].id, info.comps[0].name.as_str(), info.comps[0].width, info.comps[0].height), (1, "Main Comp", 1920, 1080));
        assert_eq!((info.comps[0].frame_rate, info.comps[0].duration), (30.0, 30.0));
        assert!((info.comps[1].frame_rate - 29.97).abs() < 0.001);
        assert_eq!(info.footage, ["/p/02 Assets/logo.png"]);
        assert_eq!(info.render_outputs, ["/p/05 Pre-Renders"]);
        assert_eq!(info.effects, ["ADBE Gaussian Blur 2", "CC Bend It"]);
        assert_eq!(info.fonts, ["Inter-Medium"], "text-engine defaults are left out");
        assert_eq!((info.document_id.as_deref(), info.original_document_id.as_deref()), (Some("did:b"), Some("did:a")));
        assert_eq!(info.derived_from.as_deref(), Some("iid:did:a-1"));
        assert_eq!(info.saves, ["iid:did:b-1", "iid:did:b-last"]);
    }

    #[test]
    fn decodes_versions_of_real_files() {
        let v = |hex: u32| version_of(&[0, 0, 0, 0, (hex >> 24) as u8, (hex >> 16) as u8, (hex >> 8) as u8, hex as u8]).unwrap();
        assert_eq!(v(0x0f98842d), (27, 1, 45));
        assert_eq!(v(0x0f900417), (26, 0, 23));
        assert_eq!(v(0x0f8b0461).0, 25);
        assert_eq!(v(0x0f032603).0, 24);
        assert_eq!(v(0x0b3a8634).0, 23);
    }

    #[test]
    fn refuses_other_files_and_survives_damage() {
        assert!(parse(b"not an aep").is_err());
        let mut damaged = sample("d", "d", None);
        damaged.truncate(300);
        // A cut-off file still reads what is there and never panics.
        let info = parse(&damaged).unwrap();
        assert_eq!(info.saved_with.as_deref(), Some("27.1"));
    }

    /// Run with `MURRE_AEP=/path/to/copy.aep cargo test real_file -- --ignored --nocapture` to print what a real
    /// file holds. Use a copy: the file is only read, but a copy keeps the original out of it entirely.
    #[test]
    #[ignore]
    fn real_file() {
        let path = std::env::var("MURRE_AEP").expect("set MURRE_AEP");
        let info = read(Path::new(&path)).unwrap();
        println!("{} build {:?} beta {} comps {} footage {} effects {} fonts {:?}", info.saved_with.clone().unwrap_or_default(), info.build, info.beta, info.comps.len(), info.footage.len(), info.effects.len(), info.fonts);
    }

    #[test]
    fn versions_know_their_family_parent_and_auto_saves() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        fs::create_dir_all(r.join("01 AE Workfile/Auto-Save")).unwrap();
        fs::create_dir_all(r.join("02 Assets/05 Templates")).unwrap();
        // v1 is the first document; v2 was saved from v1's save "iid:did:a-1"; the template is another document.
        fs::write(r.join("01 AE Workfile/Film_v1.aep"), sample("did:a", "did:a", None)).unwrap();
        fs::write(r.join("01 AE Workfile/Film_v2.aep"), sample("did:b", "did:a", Some("iid:did:a-1"))).unwrap();
        fs::write(r.join("01 AE Workfile/Auto-Save/Film_v2 auto-save 1.aep"), sample("did:c", "did:a", Some("iid:did:b-1"))).unwrap();
        fs::write(r.join("02 Assets/05 Templates/Lower third.aep"), sample("did:t", "did:t", None)).unwrap();
        fs::write(r.join("01 AE Workfile/Broken.aep"), b"nope").unwrap();
        let rels: Vec<String> = ["01 AE Workfile/Film_v2.aep", "01 AE Workfile/Film_v1.aep", "02 Assets/05 Templates/Lower third.aep", "01 AE Workfile/Broken.aep"]
            .map(String::from)
            .to_vec();
        let v = version_details(r, &rels, Some("01 AE Workfile/Film_v2.aep"), Some(26));
        let by = |p: &str| v.versions.iter().find(|x| x.path.ends_with(p)).unwrap();
        assert_eq!(by("Film_v2.aep").parent.as_deref(), Some("01 AE Workfile/Film_v1.aep"));
        assert_eq!(by("Film_v1.aep").parent, None);
        assert_eq!(by("Film_v1.aep").same_project, Some(true));
        assert_eq!(by("Lower third.aep").same_project, Some(false));
        assert!(by("Film_v2.aep").too_new, "saved by 27, only 26 here");
        assert_eq!((by("Film_v2.aep").comps, by("Film_v2.aep").footage), (2, 1));
        assert!(by("Broken.aep").unreadable);
        assert_eq!(v.auto_saves.len(), 1);
        assert_eq!(v.auto_saves[0].parent.as_deref(), Some("01 AE Workfile/Film_v2.aep"));
        assert!(!version_details(r, &rels, None, Some(27)).versions[0].too_new);
    }

    #[test]
    fn compare_names_what_changed() {
        let old = parse(&sample("a", "a", None)).unwrap();
        let mut new = old.clone();
        new.comps[0].name = "Main".into();
        new.comps[0].width = 3840;
        new.comps[0].height = 2160;
        new.comps[0].duration = 45.0;
        new.comps.remove(1);
        new.comps.push(AepComp { id: 77, name: "Outro".into(), width: 1920, height: 1080, frame_rate: 30.0, duration: 5.0 });
        new.footage.push("/p/02 Assets/new.mov".into());
        new.fonts = vec!["Lato-Bold".into()];
        let d = compare(&old, &new);
        assert_eq!(d.comps_added, ["Outro"]);
        assert_eq!(d.comps_removed, ["Matte"]);
        assert_eq!(d.comps_changed, ["Main: renamed from “Main Comp”, 1920×1080 → 3840×2160, 30 s → 45 s"]);
        assert_eq!(d.footage_added, ["new.mov"]);
        assert_eq!((d.fonts_added.as_slice(), d.fonts_removed.as_slice()), (&["Lato-Bold".to_string()][..], &["Inter-Medium".to_string()][..]));
        assert_eq!(compare(&old, &old), VersionDiff::default());
    }

    #[test]
    fn summary_prefers_main_comps_then_the_common_format() {
        let info = parse(&sample("a", "a", None)).unwrap();
        let s = summary(&info, &[9]).unwrap();
        assert_eq!((s.width, s.height, s.frame_rate, s.comps), (3840, 2160, 29.97, 2));
        // Without a Main Comp: the most common format among comps longer than a second; a tie goes to the longer comps.
        let s = summary(&info, &[]).unwrap();
        assert_eq!((s.width, s.height), (1920, 1080));
    }

    #[test]
    fn search_finds_footage_fonts_and_effects() {
        let info = parse(&sample("a", "a", None)).unwrap();
        let mut hits = Vec::new();
        search(&info, "LOGO", "p1", "Film", &mut hits);
        search(&info, "inter", "p1", "Film", &mut hits);
        search(&info, "bend", "p1", "Film", &mut hits);
        let got: Vec<_> = hits.iter().map(|h| (h.kind, h.value.as_str())).collect();
        assert_eq!(got, [("footage", "logo.png"), ("font", "Inter-Medium"), ("effect", "CC Bend It")]);
    }
}

#[cfg(test)]
mod real_project {
    /// `MURRE_PROJECT=/path/to/a/copied/project cargo test real_project -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_project() {
        let root = std::path::PathBuf::from(std::env::var("MURRE_PROJECT").expect("set MURRE_PROJECT"));
        let scan = crate::workfiles::scan(&root).unwrap();
        let rels: Vec<String> = scan.workfiles.iter().map(|w| w.path.clone()).collect();
        let v = super::version_details(&root, &rels, None, crate::environment::newest_installed_major());
        for x in &v.versions { println!("V {} | parent {:?} | same {:?} | AE {:?} beta {} | too_new {}", x.path, x.parent, x.same_project, x.saved_with, x.beta, x.too_new); }
        for a in &v.auto_saves { println!("A {} -> {:?}", a.path, a.parent); }
        println!("installed {:?}", v.installed_major);
    }
}
