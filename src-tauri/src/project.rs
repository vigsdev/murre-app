//! Project creation: validation, folder scaffold, `.murre` metadata and the
//! SQLite index entry.
//!
//! `project.json` is the authoritative record and is written last, so a folder
//! that contains it is a complete project. SQLite only holds an indexed copy.
//! Creation never touches an existing folder: the project directory is created
//! with `create_dir`, which fails if anything is already there. If a later
//! step fails, the directory created by this call (and only that one) is
//! removed again.

use crate::error::{AppError, AppResult};
use crate::safe_fs;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA_VERSION: u32 = 1;
const MAX_NAME_CHARS: usize = 100;
const MAX_CLIENT_CHARS: usize = 100;
const MAX_DESCRIPTION_CHARS: usize = 2000;

/// Folders created inside every new project, in creation order.
pub const PROJECT_DIRS: &[&str] = &[
    "01 AE Workfile",
    "02 Assets",
    "02 Assets/01 Images",
    "02 Assets/02 Audios",
    "02 Assets/03 PSD Files",
    "02 Assets/04 Illustrator Files",
    "02 Assets/05 Templates",
    "02 Assets/06 SoundFX",
    "02 Assets/07 Videos",
    "03 Scripts & Storyboard",
    "04 Premiere & SFX",
    "05 Pre-Renders",
    "06 Renders",
    "07 Deliverables",
    ".murre",
    ".murre/references",
    ".murre/references/media",
];

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    NotStarted,
    InProgress,
    InReview,
    QualityCheck,
    Completed,
    Archived,
}

impl Status {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Status::NotStarted => "not_started",
            Status::InProgress => "in_progress",
            Status::InReview => "in_review",
            Status::QualityCheck => "quality_check",
            Status::Completed => "completed",
            Status::Archived => "archived",
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Low,
    Medium,
    High,
}

impl Priority {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Priority::Low => "low",
            Priority::Medium => "medium",
            Priority::High => "high",
        }
    }
}

/// What the New Project form submits.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewProject {
    pub name: String,
    pub parent_dir: String,
    pub client: Option<String>,
    /// `YYYY-MM-DD`
    pub deadline: Option<String>,
    pub priority: Priority,
    pub description: Option<String>,
    pub status: Status,
    pub space_id: Option<String>,
}

/// Contents of `.murre/project.json`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub client: Option<String>,
    pub deadline: Option<String>,
    pub priority: Priority,
    pub description: Option<String>,
    pub status: Status,
    pub space_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// A project as the frontend sees it: its metadata plus where it lives.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    #[serde(flatten)]
    pub project: Project,
    /// Absolute path of the project folder.
    pub path: String,
    /// False when the folder (or its `.murre/project.json`) cannot be found,
    /// e.g. an external drive is disconnected.
    pub available: bool,
}

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) fn invalid<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Invalid(msg.into()))
}

/// Trim an optional text field; empty becomes `None`.
pub(crate) fn clean_optional(
    value: Option<&str>,
    max_chars: usize,
    label: &str,
) -> AppResult<Option<String>> {
    let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if v.chars().count() > max_chars {
        return invalid(format!("{label} must be {max_chars} characters or fewer."));
    }
    Ok(Some(v.to_string()))
}

/// The name becomes the project's folder name, so it must be a safe single path component.
pub fn validate_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return invalid("Please enter a project name.");
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return invalid(format!(
            "Project name must be {MAX_NAME_CHARS} characters or fewer."
        ));
    }
    if name == "." || name == ".." || name.starts_with('.') {
        return invalid("Project name cannot start with a dot.");
    }
    if let Some(c) = name
        .chars()
        .find(|c| matches!(c, '/' | '\\' | ':') || c.is_control())
    {
        let shown = if c.is_control() {
            "control characters".to_string()
        } else {
            format!("\"{c}\"")
        };
        return invalid(format!("Project name cannot contain {shown}."));
    }
    Ok(name.to_string())
}

/// Accepts a real calendar date formatted `YYYY-MM-DD`.
pub fn validate_deadline(raw: &str) -> AppResult<String> {
    let bad = || AppError::Invalid("Deadline must be a valid date (YYYY-MM-DD).".into());
    let b = raw.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return Err(bad());
    }
    let digits = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
    let (ys, ms, ds) = (&raw[0..4], &raw[5..7], &raw[8..10]);
    if !(digits(ys) && digits(ms) && digits(ds)) {
        return Err(bad());
    }
    let (y, m, d): (u32, u32, u32) = (
        ys.parse().unwrap(),
        ms.parse().unwrap(),
        ds.parse().unwrap(),
    );
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return Err(bad()),
    };
    if y < 1970 || d == 0 || d > days {
        return Err(bad());
    }
    Ok(raw.to_string())
}

fn validate_parent(raw: &str) -> AppResult<PathBuf> {
    let p = Path::new(raw);
    if raw.trim().is_empty() || !p.is_absolute() {
        return invalid("Please choose a location for the project.");
    }
    match fs::metadata(p) {
        Ok(m) if m.is_dir() => fs::canonicalize(p).map_err(|e| AppError::io(p, e)),
        Ok(_) => invalid("The chosen location is not a folder."),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            invalid("The chosen location does not exist. Is the drive connected?")
        }
        Err(e) => Err(AppError::io(p, e)),
    }
}

pub(crate) fn metadata_files(project: &Project) -> Vec<(&'static str, serde_json::Value)> {
    let v = SCHEMA_VERSION;
    vec![
        (
            ".murre/tasks.json",
            json!({ "schemaVersion": v, "tasks": [] }),
        ),
        (
            ".murre/notes.json",
            json!({ "schemaVersion": v, "content": null }),
        ),
        (
            ".murre/workfiles.json",
            json!({ "schemaVersion": v, "currentAep": null, "workfiles": [] }),
        ),
        (
            ".murre/renders.json",
            json!({ "schemaVersion": v, "renders": [] }),
        ),
        (
            ".murre/comps.json",
            json!({ "schemaVersion": v, "aep": null, "lastScanAt": null, "comps": [] }),
        ),
        (
            ".murre/colors.json",
            json!({ "schemaVersion": v, "lastScanAt": null, "colors": [] }),
        ),
        (
            ".murre/expressions.json",
            json!({ "schemaVersion": v, "lastScanAt": null, "expressions": [] }),
        ),
        (
            ".murre/fonts.json",
            json!({ "schemaVersion": v, "lastScanAt": null, "method": "layers", "fonts": [] }),
        ),
        (
            ".murre/environment.json",
            json!({ "schemaVersion": v, "lastScanAt": null, "aeVersion": null, "plugins": [] }),
        ),
        (
            ".murre/references/references.json",
            json!({ "schemaVersion": v, "canvas": null, "items": [] }),
        ),
        // Written last: its presence marks the project as completely created.
        (
            ".murre/project.json",
            serde_json::to_value(project).expect("project serializes"),
        ),
    ]
}

/// Make sure `.murre/` and its metadata files exist inside an *existing* folder,
/// creating only what is missing and never replacing anything. `project.json` is
/// written last.
pub(crate) fn ensure_metadata(root: &Path, project: &Project) -> AppResult<()> {
    for dir in [
        ".murre",
        ".murre/references",
        ".murre/references/media",
    ] {
        let p = root.join(dir);
        fs::create_dir_all(&p).map_err(|e| AppError::io(&p, e))?;
    }
    for (rel, value) in metadata_files(project) {
        match safe_fs::create_json(&root.join(rel), &value) {
            Ok(()) | Err(AppError::AlreadyExists(_)) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// The folders of a new project: the fixed ones, with the sub-folders of `02 Assets` taken from the folder setup.
fn dirs_for(setup: &crate::folders::Template) -> Vec<String> {
    let mut dirs = Vec::new();
    for dir in PROJECT_DIRS {
        if dir.starts_with("02 Assets/") {
            continue; // replaced by the setup's folders just below
        }
        dirs.push((*dir).to_string());
        if *dir == "02 Assets" {
            dirs.extend(crate::folders::asset_dirs(setup));
        }
    }
    dirs
}

fn scaffold(root: &Path, project: &Project, setup: &crate::folders::Template) -> AppResult<()> {
    for dir in dirs_for(setup) {
        let p = root.join(&dir);
        fs::create_dir(&p).map_err(|e| AppError::io(&p, e))?;
    }
    // The Companion reads this copy, so the project keeps its layout whatever the app's setup becomes later.
    safe_fs::create_json(&root.join(".murre/folders.json"), &crate::folders::snapshot(setup))?;
    for (rel, value) in metadata_files(project) {
        safe_fs::create_json(&root.join(rel), &value)?;
    }
    Ok(())
}

pub(crate) fn insert_index(conn: &Connection, p: &Project, path: &Path) -> AppResult<()> {
    conn.execute(
        "INSERT INTO projects
            (id, name, path, client, deadline, priority, description, status, space_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            p.id,
            p.name,
            path.to_string_lossy(),
            p.client,
            p.deadline,
            p.priority.as_str(),
            p.description,
            p.status.as_str(),
            p.space_id,
            p.created_at as i64,
            p.updated_at as i64,
        ],
    )?;
    Ok(())
}

/// Create a project folder with its full structure and register it in the index.
pub fn create(conn: &Connection, input: NewProject) -> AppResult<ProjectRecord> {
    let name = validate_name(&input.name)?;
    let parent = validate_parent(&input.parent_dir)?;
    let deadline = input
        .deadline
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(validate_deadline)
        .transpose()?;
    let client = clean_optional(input.client.as_deref(), MAX_CLIENT_CHARS, "Client")?;
    let description = clean_optional(
        input.description.as_deref(),
        MAX_DESCRIPTION_CHARS,
        "Description",
    )?;

    if let Some(space) = &input.space_id
        && !crate::spaces::exists(conn, space)?
    {
        return invalid("That Space no longer exists.");
    }

    let ts = now();
    let project = Project {
        schema_version: SCHEMA_VERSION,
        id: uuid::Uuid::new_v4().to_string(),
        name: name.clone(),
        client,
        deadline,
        priority: input.priority,
        description,
        status: input.status,
        space_id: input.space_id,
        created_at: ts,
        updated_at: ts,
    };

    let setup = crate::folders::load(conn)?;
    let root = parent.join(&name);
    // Fails if anything (file or folder) already exists there; never merges into existing work.
    fs::create_dir(&root).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::Invalid(format!(
                "A folder named \"{name}\" already exists in that location."
            ))
        } else {
            AppError::io(&root, e)
        }
    })?;

    let result = scaffold(&root, &project, &setup).and_then(|_| insert_index(conn, &project, &root));
    if let Err(e) = result {
        // `root` was created by this call and holds only what this call wrote.
        let _ = fs::remove_dir_all(&root);
        return Err(e);
    }
    Ok(ProjectRecord {
        project,
        path: root.to_string_lossy().into_owned(),
        available: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn input(parent: &Path, name: &str) -> NewProject {
        NewProject {
            name: name.into(),
            parent_dir: parent.to_string_lossy().into_owned(),
            client: Some(" Acme ".into()),
            deadline: Some("2026-12-31".into()),
            priority: Priority::High,
            description: Some("".into()),
            status: Status::NotStarted,
            space_id: None,
        }
    }

    fn setup() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("app.db")).unwrap();
        fs::create_dir(dir.path().join("work")).unwrap();
        (dir, conn)
    }

    #[test]
    fn a_new_project_gets_the_folders_of_the_current_setup_and_keeps_a_copy() {
        use crate::folders::{save, Folder, Template};
        let (dir, conn) = setup();
        let work = dir.path().join("work");
        save(
            &conn,
            &Template {
                folders: vec![
                    Folder { name: "Footage".into(), kinds: vec!["video".into()], extras: vec![] },
                    Folder { name: "Stills".into(), kinds: vec!["image".into()], extras: vec!["raw".into()] },
                ],
            },
        )
        .unwrap();
        let created = create(&conn, input(&work, "Custom")).unwrap();
        let root = std::path::PathBuf::from(&created.path);
        assert!(root.join("02 Assets/Footage").is_dir());
        assert!(root.join("02 Assets/Stills").is_dir());
        assert!(!root.join("02 Assets/01 Images").exists(), "the default sub-folders are not made");
        for d in ["01 AE Workfile", "03 Scripts & Storyboard", "06 Renders", "07 Deliverables", ".murre/references/media"] {
            assert!(root.join(d).is_dir(), "fixed folder {d} is still made");
        }
        let copy: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join(".murre/folders.json")).unwrap()).unwrap();
        assert_eq!(copy["folders"][1]["name"], "Stills");
        assert!(copy["folders"][1]["exts"].as_array().unwrap().iter().any(|e| e == "raw"));
        // Changing the setup afterwards does not touch this project.
        crate::folders::reset(&conn).unwrap();
        let again: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join(".murre/folders.json")).unwrap()).unwrap();
        assert_eq!(again, copy);
    }

    #[test]
    fn creates_the_full_structure() {
        let (dir, conn) = setup();
        let work = dir.path().join("work");
        let created = create(&conn, input(&work, "My Project")).unwrap();
        let root = work.canonicalize().unwrap().join("My Project");
        assert_eq!(created.path, root.to_string_lossy());
        assert!(created.available);
        for d in PROJECT_DIRS {
            assert!(root.join(d).is_dir(), "missing dir {d}");
        }
        for f in [
            "project.json",
            "tasks.json",
            "notes.json",
            "workfiles.json",
            "renders.json",
            "comps.json",
            "colors.json",
            "expressions.json",
            "fonts.json",
            "environment.json",
            "references/references.json",
        ] {
            let (_v, _): (serde_json::Value, _) =
                safe_fs::read_json(&root.join(".murre").join(f)).unwrap();
        }
    }

    #[test]
    fn project_json_is_authoritative_and_matches_input() {
        let (dir, conn) = setup();
        let work = dir.path().join("work");
        let created = create(&conn, input(&work, "P1")).unwrap();
        let (p, _): (Project, _) =
            safe_fs::read_json(&Path::new(&created.path).join(".murre/project.json")).unwrap();
        assert_eq!(p, created.project);
        assert_eq!(p.client.as_deref(), Some("Acme"));
        assert_eq!(p.description, None);
        assert_eq!(p.deadline.as_deref(), Some("2026-12-31"));
        assert_eq!(p.priority, Priority::High);
        assert_eq!(p.status, Status::NotStarted);
    }

    #[test]
    fn ids_are_unique_and_index_row_is_written() {
        let (dir, conn) = setup();
        let work = dir.path().join("work");
        let a = create(&conn, input(&work, "A")).unwrap();
        let b = create(&conn, input(&work, "B")).unwrap();
        assert_ne!(a.project.id, b.project.id);
        let (name, path, status, priority): (String, String, String, String) = conn
            .query_row(
                "SELECT name, path, status, priority FROM projects WHERE id = ?1",
                [&a.project.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (name.as_str(), status.as_str(), priority.as_str()),
            ("A", "not_started", "high")
        );
        assert_eq!(path, a.path);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn existing_folder_is_never_touched() {
        let (dir, conn) = setup();
        let work = dir.path().join("work");
        let existing = work.join("Taken");
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("keep.txt"), b"mine").unwrap();
        let err = create(&conn, input(&work, "Taken")).unwrap_err();
        assert!(matches!(err, AppError::Invalid(m) if m.contains("already exists")));
        assert_eq!(fs::read(existing.join("keep.txt")).unwrap(), b"mine");
        assert_eq!(fs::read_dir(&existing).unwrap().count(), 1);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn failed_index_insert_rolls_back_the_new_folder_only() {
        let (dir, conn) = setup();
        let work = dir.path().join("work");
        let sibling = work.join("Other");
        fs::create_dir(&sibling).unwrap();
        // Pre-register the path the new project would use so the index insert fails.
        let target = work.canonicalize().unwrap().join("Clash");
        conn.execute(
            "INSERT INTO projects (id, name, path, priority, status, created_at, updated_at)
             VALUES ('x', 'Clash', ?1, 'low', 'not_started', 0, 0)",
            [target.to_string_lossy()],
        )
        .unwrap();
        assert!(matches!(
            create(&conn, input(&work, "Clash")),
            Err(AppError::Database(_))
        ));
        assert!(!target.exists());
        assert!(sibling.exists());
    }

    #[test]
    fn name_validation() {
        for bad in [
            "",
            "   ",
            ".hidden",
            "..",
            "a/b",
            "a\\b",
            "a:b",
            "a\nb",
            &"x".repeat(101),
        ] {
            assert!(validate_name(bad).is_err(), "{bad:?} should be rejected");
        }
        assert_eq!(
            validate_name("  Brand Film 2026 – v2 ").unwrap(),
            "Brand Film 2026 – v2"
        );
        assert!(validate_name(&"é".repeat(100)).is_ok());
    }

    #[test]
    fn deadline_validation() {
        for ok in ["2026-10-26", "2028-02-29", "2000-02-29"] {
            assert!(validate_deadline(ok).is_ok(), "{ok}");
        }
        for bad in [
            "2026-02-29",
            "2026-13-01",
            "2026-00-10",
            "2026-04-31",
            "26-01-01",
            "2026/01/01",
            "2026-1-01",
            "abcd-ef-gh",
            "1969-12-31",
            "",
        ] {
            assert!(validate_deadline(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn bad_input_creates_nothing() {
        let (dir, conn) = setup();
        let work = dir.path().join("work");
        let mut i = input(&work, "Ok");
        i.deadline = Some("2026-02-30".into());
        assert!(create(&conn, i).is_err());
        let mut i = input(&work, "Ok");
        i.parent_dir = work.join("missing").to_string_lossy().into_owned();
        assert!(matches!(create(&conn, i), Err(AppError::Invalid(_))));
        let mut i = input(&work, "Ok");
        i.parent_dir = "relative/path".into();
        assert!(create(&conn, i).is_err());
        let mut i = input(&work, "Ok");
        i.client = Some("c".repeat(101));
        assert!(create(&conn, i).is_err());
        assert_eq!(fs::read_dir(&work).unwrap().count(), 0);
    }

    #[test]
    fn parent_that_is_a_file_is_rejected() {
        let (dir, conn) = setup();
        let f = dir.path().join("file.txt");
        fs::write(&f, b"x").unwrap();
        assert!(matches!(
            create(&conn, input(&f, "P")),
            Err(AppError::Invalid(_))
        ));
    }
}
