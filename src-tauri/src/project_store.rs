//! Reading and managing projects that are already known to Murre: list,
//! edit, remove from the app, and import existing folders.
//!
//! Rules of this module:
//! * `.murre/project.json` is authoritative; SQLite is the indexed copy.
//!   Edits write the JSON first, then update the index.
//! * Removing a project only deletes its index row. Files on disk are never touched.
//! * Importing never moves or reorganizes existing files. For a folder that has
//!   no Murre metadata yet, only a hidden `.murre/` folder is added.

use crate::error::{AppError, AppResult};
use crate::project::{
    Priority, Project, ProjectRecord, SCHEMA_VERSION, Status, clean_optional, ensure_metadata,
    insert_index, invalid, now, validate_deadline,
};
use crate::safe_fs;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_NAME_CHARS: usize = 100;
const MAX_CLIENT_CHARS: usize = 100;
const MAX_DESCRIPTION_CHARS: usize = 2000;

const COLUMNS: &str = "id, name, path, client, deadline, priority, description, status, space_id, created_at, updated_at";

pub(crate) fn project_json(root: &Path) -> PathBuf {
    root.join(".murre").join("project.json")
}

pub(crate) fn has_project_json(root: &Path) -> bool {
    let p = project_json(root);
    p.exists() || safe_fs::backup_path(&p).exists()
}

fn parse_enum<T: DeserializeOwned>(idx: usize, s: String) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(s)).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn row_to_record(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRecord> {
    let path: String = r.get(2)?;
    let available = has_project_json(Path::new(&path));
    Ok(ProjectRecord {
        project: Project {
            schema_version: SCHEMA_VERSION,
            id: r.get(0)?,
            name: r.get(1)?,
            client: r.get(3)?,
            deadline: r.get(4)?,
            priority: parse_enum(5, r.get(5)?)?,
            description: r.get(6)?,
            status: parse_enum(7, r.get(7)?)?,
            space_id: r.get(8)?,
            created_at: r.get::<_, i64>(9)? as u64,
            updated_at: r.get::<_, i64>(10)? as u64,
        },
        path,
        available,
    })
}

pub(crate) fn find_by_id(conn: &Connection, id: &str) -> AppResult<Option<ProjectRecord>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM projects WHERE id = ?1"),
            [id],
            row_to_record,
        )
        .optional()?)
}

pub(crate) fn find_by_path(conn: &Connection, path: &Path) -> AppResult<Option<ProjectRecord>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM projects WHERE path = ?1"),
            [path.to_string_lossy()],
            row_to_record,
        )
        .optional()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<ProjectRecord> {
    find_by_id(conn, id)?.ok_or_else(|| AppError::Invalid("Project not found.".into()))
}

/// The project's folder, for operations that read or write inside it. Fails with a
/// clear message when the folder is unavailable (e.g. a disconnected drive).
pub fn available_root(conn: &Connection, id: &str) -> AppResult<PathBuf> {
    let record = get(conn, id)?;
    if !record.available {
        return invalid(
            "The project folder is not available. Reconnect the drive or restore the folder, then try again.",
        );
    }
    let root = PathBuf::from(&record.path);
    // The folder must still hold *this* project (a different project may have been put there).
    if let Ok((p, _)) = safe_fs::read_json::<Project>(&project_json(&root))
        && p.id != id
    {
        return invalid(
            "That folder now contains a different project, so it was left untouched. Use Locate folder to point this project at its real folder.",
        );
    }
    Ok(root)
}

/// All projects known to the app, most recently updated first.
pub fn list(conn: &Connection) -> AppResult<Vec<ProjectRecord>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM projects ORDER BY updated_at DESC, name"
    ))?;
    let rows = stmt
        .query_map([], row_to_record)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------- edit

/// The editable fields. The project's folder, id and Space are not changed here.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProject {
    pub id: String,
    pub name: String,
    pub client: Option<String>,
    pub deadline: Option<String>,
    pub priority: Priority,
    pub description: Option<String>,
    pub status: Status,
}

/// A display name (the folder is not renamed), so it need not be filename-safe.
pub(crate) fn validate_display_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return invalid("Please enter a project name.");
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return invalid(format!(
            "Project name must be {MAX_NAME_CHARS} characters or fewer."
        ));
    }
    if name.chars().any(|c| c.is_control()) {
        return invalid("Project name contains invalid characters.");
    }
    Ok(name.to_string())
}

pub fn update(conn: &Connection, input: UpdateProject) -> AppResult<ProjectRecord> {
    let name = validate_display_name(&input.name)?;
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

    let record = find_by_id(conn, &input.id)?
        .ok_or_else(|| AppError::Invalid("Project not found.".into()))?;
    let root = PathBuf::from(&record.path);
    if !has_project_json(&root) {
        return invalid(
            "The project folder is not available. Reconnect the drive or restore the folder, then try again.",
        );
    }

    // JSON is authoritative: start from what is really on disk.
    let (mut p, _): (Project, _) = safe_fs::read_json(&project_json(&root))?;
    if p.id != input.id {
        return invalid("That folder now contains a different project, so it was not modified.");
    }
    p.name = name;
    p.client = client;
    p.deadline = deadline;
    p.priority = input.priority;
    p.description = description;
    p.status = input.status;
    p.updated_at = now();
    safe_fs::write_json(&project_json(&root), &p)?;

    conn.execute(
        "UPDATE projects SET name=?2, client=?3, deadline=?4, priority=?5, description=?6, status=?7, updated_at=?8
         WHERE id=?1",
        params![
            p.id,
            p.name,
            p.client,
            p.deadline,
            p.priority.as_str(),
            p.description,
            p.status.as_str(),
            p.updated_at as i64
        ],
    )?;
    Ok(ProjectRecord {
        project: p,
        path: record.path,
        available: true,
    })
}

// ------------------------------------------------- narrow field changes

/// Change selected fields of a project without touching the rest. The JSON file
/// is authoritative: it is re-read, changed and written first, then the index
/// row is refreshed from it. Used by the calendar and by Spaces, so a stale list
/// on screen can never overwrite fields that were edited elsewhere.
fn modify(
    conn: &Connection,
    id: &str,
    change: impl FnOnce(&mut Project),
) -> AppResult<ProjectRecord> {
    let record =
        find_by_id(conn, id)?.ok_or_else(|| AppError::Invalid("Project not found.".into()))?;
    let root = PathBuf::from(&record.path);
    if !has_project_json(&root) {
        return invalid(
            "The project folder is not available. Reconnect the drive or restore the folder, then try again.",
        );
    }
    let (mut p, _): (Project, _) = safe_fs::read_json(&project_json(&root))?;
    if p.id != id {
        return invalid("That folder now contains a different project, so it was not modified.");
    }
    change(&mut p);
    p.updated_at = now();
    safe_fs::write_json(&project_json(&root), &p)?;
    conn.execute(
        "UPDATE projects SET deadline=?2, space_id=?3, updated_at=?4 WHERE id=?1",
        params![p.id, p.deadline, p.space_id, p.updated_at as i64],
    )?;
    Ok(ProjectRecord {
        project: p,
        path: record.path,
        available: true,
    })
}

/// Change only a project's deadline (`None` clears it).
pub fn set_deadline(
    conn: &Connection,
    id: &str,
    deadline: Option<&str>,
) -> AppResult<ProjectRecord> {
    let deadline = deadline
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(validate_deadline)
        .transpose()?;
    modify(conn, id, |p| p.deadline = deadline)
}

/// Move a project into a Space (`None` removes it from its Space).
pub fn set_space(conn: &Connection, id: &str, space_id: Option<&str>) -> AppResult<ProjectRecord> {
    if let Some(space) = space_id
        && !crate::spaces::exists(conn, space)?
    {
        return invalid("That Space no longer exists.");
    }
    modify(conn, id, |p| p.space_id = space_id.map(String::from))
}

/// Ids of the projects currently filed in `space_id` (from the index).
pub fn ids_in_space(conn: &Connection, space_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id FROM projects WHERE space_id = ?1")?;
    let rows = stmt.query_map([space_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// -------------------------------------------------------------- remove

/// Remove a project from the app. Only the index row is deleted; the folder and
/// its `.murre` data stay on disk, so the project can be imported again later.
pub fn remove(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    if n == 0 {
        return invalid("Project not found.");
    }
    Ok(())
}

// -------------------------------------------------------------- relink

/// Point a known project at the folder it now lives in (after a rename or move).
///
/// Identity is the project ID stored in `.murre/project.json`, never the folder
/// name or timestamps: the chosen folder must hold the same ID. Nothing on disk is
/// modified, and this is refused while the project's current folder is still valid.
pub fn relink(conn: &Connection, id: &str, raw_path: &str) -> AppResult<ProjectRecord> {
    let record = get(conn, id)?;
    let current = PathBuf::from(&record.path);
    if let Ok((p, _)) = safe_fs::read_json::<Project>(&project_json(&current))
        && p.id == id
    {
        return invalid(format!(
            "This project's folder is available at {}. Remove the project from Murre first if you want to use a different folder.",
            record.path
        ));
    }

    let root = resolve_folder(raw_path)?;
    if !has_project_json(&root) {
        return invalid("That folder has no Murre project data (.murre/project.json).");
    }
    let (found, _): (Project, _) = safe_fs::read_json(&project_json(&root))?;
    if found.schema_version > SCHEMA_VERSION {
        return invalid("That project was created by a newer version of Murre.");
    }
    if found.id != id {
        return invalid(format!(
            "That folder holds a different project (\"{}\"), so it was not linked.",
            found.name
        ));
    }
    if let Some(other) = find_by_path(conn, &root)?
        && other.project.id != id
    {
        return invalid(format!(
            "That folder is already used by \"{}\".",
            other.project.name
        ));
    }
    conn.execute(
        "UPDATE projects SET path = ?2 WHERE id = ?1",
        params![id, root.to_string_lossy()],
    )?;
    get(conn, id)
}

// -------------------------------------------------------------- import

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportInspection {
    /// Folder name, used as the project name for folders without Murre data.
    pub name: String,
    /// The folder already has `.murre/project.json`.
    pub has_metadata: bool,
    pub already_imported: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum ImportOutcome {
    /// Existing Murre project registered.
    Imported,
    /// Known project found at a new location; its path was updated.
    Relinked,
    /// Plain folder adopted; a `.murre` folder was added to it.
    MetadataCreated,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub record: ProjectRecord,
    pub outcome: ImportOutcome,
}

pub(crate) fn resolve_folder(raw: &str) -> AppResult<PathBuf> {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return invalid("Please choose a folder.");
    }
    match fs::metadata(p) {
        Ok(m) if m.is_dir() => fs::canonicalize(p).map_err(|e| AppError::io(p, e)),
        Ok(_) => invalid("The chosen item is not a folder."),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            invalid("The chosen folder does not exist.")
        }
        Err(e) => Err(AppError::io(p, e)),
    }
}

pub fn inspect_import(conn: &Connection, raw_path: &str) -> AppResult<ImportInspection> {
    let root = resolve_folder(raw_path)?;
    Ok(ImportInspection {
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        has_metadata: has_project_json(&root),
        already_imported: find_by_path(conn, &root)?.is_some(),
    })
}

/// Register an existing folder.
///
/// * With `.murre/project.json`: the project is validated and registered, keeping its ID.
///   If that ID is already known at a path that no longer holds it (moved folder), the path
///   is updated instead.
/// * Without it: only if `create_metadata` is true, a `.murre` folder is added. Nothing
///   else in the folder is touched.
pub fn import(conn: &Connection, raw_path: &str, create_metadata: bool) -> AppResult<ImportResult> {
    let root = resolve_folder(raw_path)?;
    if let Some(existing) = find_by_path(conn, &root)? {
        return invalid(format!(
            "\"{}\" is already in Murre.",
            existing.project.name
        ));
    }

    if has_project_json(&root) {
        let (p, _): (Project, _) = safe_fs::read_json(&project_json(&root))?;
        if p.schema_version > SCHEMA_VERSION {
            return invalid("This project was created by a newer version of Murre.");
        }
        validate_display_name(&p.name)?;
        if let Some(d) = &p.deadline {
            validate_deadline(d)?;
        }

        if let Some(known) = find_by_id(conn, &p.id)? {
            // Same project ID is already indexed under another path.
            if known.available {
                return invalid(format!(
                    "A project with the same ID is already in Murre at {}. Remove it first if this is a copy you want to use instead.",
                    known.path
                ));
            }
            conn.execute(
                "UPDATE projects SET path = ?2 WHERE id = ?1",
                params![p.id, root.to_string_lossy()],
            )?;
            let record = find_by_id(conn, &p.id)?.expect("row exists");
            return Ok(ImportResult {
                record,
                outcome: ImportOutcome::Relinked,
            });
        }

        insert_index(conn, &p, &root)?;
        let record = ProjectRecord {
            project: p,
            path: root.to_string_lossy().into_owned(),
            available: true,
        };
        return Ok(ImportResult {
            record,
            outcome: ImportOutcome::Imported,
        });
    }

    if !create_metadata {
        return invalid(
            "This folder is not a Murre project yet. Confirm to add Murre metadata to it.",
        );
    }

    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| {
            AppError::Invalid("Cannot import a drive root. Choose a project folder.".into())
        })?;
    let name = validate_display_name(&name)?;
    let ts = now();
    let p = Project {
        schema_version: SCHEMA_VERSION,
        id: uuid::Uuid::new_v4().to_string(),
        name,
        client: None,
        deadline: None,
        priority: Priority::Medium,
        description: None,
        status: Status::InProgress,
        space_id: None,
        created_at: ts,
        updated_at: ts,
    };

    let metadata_dir = root.join(".murre");
    let fresh = !metadata_dir.exists();
    let result = ensure_metadata(&root, &p).and_then(|_| insert_index(conn, &p, &root));
    if let Err(e) = result {
        if fresh {
            // We created this directory a moment ago and it holds only our files.
            let _ = fs::remove_dir_all(&metadata_dir);
        }
        return Err(e);
    }
    let record = ProjectRecord {
        project: p,
        path: root.to_string_lossy().into_owned(),
        available: true,
    };
    Ok(ImportResult {
        record,
        outcome: ImportOutcome::MetadataCreated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::project::{NewProject, create};

    fn setup() -> (tempfile::TempDir, Connection, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("app.db")).unwrap();
        let work = dir.path().join("work");
        fs::create_dir(&work).unwrap();
        (dir, conn, work)
    }

    fn new(work: &Path, name: &str) -> NewProject {
        NewProject {
            name: name.into(),
            parent_dir: work.to_string_lossy().into_owned(),
            client: None,
            deadline: None,
            priority: Priority::Medium,
            description: None,
            status: Status::NotStarted,
            space_id: None,
        }
    }

    fn edit(id: &str) -> UpdateProject {
        UpdateProject {
            id: id.into(),
            name: "Renamed".into(),
            client: Some("Client".into()),
            deadline: Some("2027-01-15".into()),
            priority: Priority::Low,
            description: Some("desc".into()),
            status: Status::InReview,
        }
    }

    #[test]
    fn list_returns_created_projects_and_availability() {
        let (_d, conn, work) = setup();
        let a = create(&conn, new(&work, "A")).unwrap();
        create(&conn, new(&work, "B")).unwrap();
        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|r| r.available));
        fs::remove_dir_all(&a.path).unwrap(); // simulate a disconnected drive
        let all = list(&conn).unwrap();
        assert!(
            !all.iter()
                .find(|r| r.project.id == a.project.id)
                .unwrap()
                .available
        );
    }

    #[test]
    fn update_writes_json_and_index_without_renaming_folder() {
        let (_d, conn, work) = setup();
        let a = create(&conn, new(&work, "A")).unwrap();
        let rec = update(&conn, edit(&a.project.id)).unwrap();
        assert_eq!(rec.project.name, "Renamed");
        assert_eq!(rec.project.id, a.project.id);
        assert_eq!(rec.project.created_at, a.project.created_at);
        assert!(Path::new(&a.path).is_dir(), "folder must keep its name");
        let (on_disk, _): (Project, _) =
            safe_fs::read_json(&project_json(Path::new(&a.path))).unwrap();
        assert_eq!(on_disk, rec.project);
        let indexed = find_by_id(&conn, &a.project.id).unwrap().unwrap();
        assert_eq!(indexed.project, rec.project);
        assert_eq!(indexed.project.status, Status::InReview);
    }

    #[test]
    fn set_deadline_changes_only_the_deadline_in_json_and_index() {
        let (_d, conn, work) = setup();
        let a = create(&conn, new(&work, "A")).unwrap();
        let id = a.project.id.clone();
        update(&conn, edit(&id)).unwrap(); // name "Renamed", client, priority Low...
        let rec = set_deadline(&conn, &id, Some("2027-03-09")).unwrap();
        assert_eq!(rec.project.deadline.as_deref(), Some("2027-03-09"));
        let (on_disk, _): (Project, _) =
            safe_fs::read_json(&project_json(Path::new(&rec.path))).unwrap();
        assert_eq!(on_disk.deadline.as_deref(), Some("2027-03-09"));
        assert_eq!(on_disk.name, "Renamed");
        assert_eq!(on_disk.client.as_deref(), Some("Client"));
        assert_eq!(on_disk.priority, Priority::Low);
        assert_eq!(on_disk.status, Status::InReview);
        assert_eq!(
            get(&conn, &id).unwrap().project.deadline.as_deref(),
            Some("2027-03-09")
        );
        // Clearing.
        let rec = set_deadline(&conn, &id, None).unwrap();
        assert_eq!(rec.project.deadline, None);
        assert_eq!(get(&conn, &id).unwrap().project.deadline, None);
    }

    #[test]
    fn set_deadline_rejects_bad_dates_missing_folders_and_unknown_ids() {
        let (_d, conn, work) = setup();
        let a = create(&conn, new(&work, "A")).unwrap();
        let id = a.project.id.clone();
        set_deadline(&conn, &id, Some("2027-03-09")).unwrap();
        for bad in ["2027-02-30", "tomorrow", "2027-3-9", "1969-12-31"] {
            assert!(set_deadline(&conn, &id, Some(bad)).is_err(), "{bad}");
        }
        assert_eq!(
            get(&conn, &id).unwrap().project.deadline.as_deref(),
            Some("2027-03-09")
        );
        assert!(set_deadline(&conn, "nope", Some("2027-03-09")).is_err());
        fs::remove_dir_all(&a.path).unwrap();
        assert!(set_deadline(&conn, &id, Some("2027-04-01")).is_err());
        assert_eq!(
            get(&conn, &id).unwrap().project.deadline.as_deref(),
            Some("2027-03-09")
        );
    }

    #[test]
    fn set_space_changes_only_the_space_and_validates() {
        let (_d, conn, work) = setup();
        let a = create(&conn, new(&work, "A")).unwrap();
        let id = a.project.id.clone();
        update(&conn, edit(&id)).unwrap();
        let space = crate::spaces::create(&conn, "Clients", "folder").unwrap();
        let rec = set_space(&conn, &id, Some(&space.id)).unwrap();
        assert_eq!(rec.project.space_id.as_deref(), Some(space.id.as_str()));
        let (on_disk, _): (Project, _) =
            safe_fs::read_json(&project_json(Path::new(&rec.path))).unwrap();
        assert_eq!(on_disk.space_id.as_deref(), Some(space.id.as_str()));
        assert_eq!(on_disk.name, "Renamed");
        assert_eq!(on_disk.deadline.as_deref(), Some("2027-01-15"));
        assert_eq!(ids_in_space(&conn, &space.id).unwrap(), [id.clone()]);
        assert!(set_space(&conn, &id, Some("no-such-space")).is_err());
        assert_eq!(
            get(&conn, &id).unwrap().project.space_id.as_deref(),
            Some(space.id.as_str())
        );
        assert_eq!(set_space(&conn, &id, None).unwrap().project.space_id, None);
        assert!(ids_in_space(&conn, &space.id).unwrap().is_empty());
    }

    #[test]
    fn set_deadline_does_not_disturb_the_space() {
        let (_d, conn, work) = setup();
        let a = create(&conn, new(&work, "A")).unwrap();
        let space = crate::spaces::create(&conn, "S", "layers").unwrap();
        set_space(&conn, &a.project.id, Some(&space.id)).unwrap();
        let rec = set_deadline(&conn, &a.project.id, Some("2027-05-05")).unwrap();
        assert_eq!(rec.project.space_id.as_deref(), Some(space.id.as_str()));
    }

    #[test]
    fn create_with_unknown_space_is_refused_and_leaves_no_folder() {
        let (_d, conn, work) = setup();
        let mut input = new(&work, "Fresh");
        input.space_id = Some("ghost".into());
        assert!(create(&conn, input).is_err());
        assert!(!work.join("Fresh").exists());
        assert!(list(&conn).unwrap().is_empty());
        let space = crate::spaces::create(&conn, "Real", "star").unwrap();
        let mut ok = new(&work, "Fresh");
        ok.space_id = Some(space.id.clone());
        assert_eq!(create(&conn, ok).unwrap().project.space_id, Some(space.id));
    }

    #[test]
    fn update_validates_and_leaves_data_untouched_on_error() {
        let (_d, conn, work) = setup();
        let a = create(&conn, new(&work, "A")).unwrap();
        let before = fs::read(project_json(Path::new(&a.path))).unwrap();
        let mut bad = edit(&a.project.id);
        bad.deadline = Some("2027-02-30".into());
        assert!(update(&conn, bad).is_err());
        let mut bad = edit(&a.project.id);
        bad.name = "  ".into();
        assert!(update(&conn, bad).is_err());
        assert!(update(&conn, edit("missing")).is_err());
        assert_eq!(fs::read(project_json(Path::new(&a.path))).unwrap(), before);
    }

    #[test]
    fn update_refuses_unavailable_folder_and_foreign_project() {
        let (_d, conn, work) = setup();
        let a = create(&conn, new(&work, "A")).unwrap();
        let b = create(&conn, new(&work, "B")).unwrap();
        // B's folder now holds A's project.json (e.g. folders swapped on disk)
        fs::copy(
            project_json(Path::new(&a.path)),
            project_json(Path::new(&b.path)),
        )
        .unwrap();
        assert!(
            matches!(update(&conn, edit(&b.project.id)), Err(AppError::Invalid(m)) if m.contains("different project"))
        );
        fs::remove_dir_all(&a.path).unwrap();
        assert!(
            matches!(update(&conn, edit(&a.project.id)), Err(AppError::Invalid(m)) if m.contains("not available"))
        );
    }

    #[test]
    fn remove_only_deletes_the_index_row() {
        let (_d, conn, work) = setup();
        let a = create(&conn, new(&work, "A")).unwrap();
        fs::write(
            Path::new(&a.path).join("02 Assets/01 Images/keep.png"),
            b"x",
        )
        .unwrap();
        remove(&conn, &a.project.id).unwrap();
        assert!(list(&conn).unwrap().is_empty());
        assert!(
            Path::new(&a.path)
                .join("02 Assets/01 Images/keep.png")
                .exists()
        );
        assert!(project_json(Path::new(&a.path)).exists());
        assert!(remove(&conn, &a.project.id).is_err());
    }

    #[test]
    fn removed_project_can_be_imported_again_with_same_id() {
        let (_d, conn, work) = setup();
        let a = create(&conn, new(&work, "A")).unwrap();
        remove(&conn, &a.project.id).unwrap();
        let r = import(&conn, &a.path, false).unwrap();
        assert_eq!(r.outcome, ImportOutcome::Imported);
        assert_eq!(r.record.project, a.project);
        assert!(import(&conn, &a.path, false).is_err(), "already imported");
    }

    #[test]
    fn plain_folder_needs_confirmation_and_only_gains_dot_murre() {
        let (_d, conn, work) = setup();
        let folder = work.join("Old Job");
        fs::create_dir_all(folder.join("footage")).unwrap();
        fs::write(folder.join("final.aep"), b"aep").unwrap();
        fs::write(folder.join("footage/a.mov"), b"mov").unwrap();

        let info = inspect_import(&conn, folder.to_str().unwrap()).unwrap();
        assert_eq!(
            info,
            ImportInspection {
                name: "Old Job".into(),
                has_metadata: false,
                already_imported: false
            }
        );
        assert!(import(&conn, folder.to_str().unwrap(), false).is_err());
        assert!(!folder.join(".murre").exists());

        let r = import(&conn, folder.to_str().unwrap(), true).unwrap();
        assert_eq!(r.outcome, ImportOutcome::MetadataCreated);
        assert_eq!(r.record.project.name, "Old Job");
        assert!(project_json(&folder).exists());
        let mut names: Vec<_> = fs::read_dir(&folder)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, [".murre", "final.aep", "footage"]);
        assert_eq!(fs::read(folder.join("final.aep")).unwrap(), b"aep");
        assert!(
            !folder.join("01 AE Workfile").exists(),
            "must not impose the standard structure"
        );
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn already_indexed_plain_folder_is_refused_and_untouched() {
        let (_d, conn, work) = setup();
        let folder = work.join("Job");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("x.aep"), b"a").unwrap();
        // Pre-register this path so the import is refused.
        conn.execute(
            "INSERT INTO projects (id, name, path, priority, status, created_at, updated_at)
             VALUES ('other', 'Other', ?1, 'low', 'not_started', 0, 0)",
            [folder.canonicalize().unwrap().to_string_lossy()],
        )
        .unwrap();
        // already indexed -> refused before touching anything
        assert!(import(&conn, folder.to_str().unwrap(), true).is_err());
        assert!(!folder.join(".murre").exists());
        assert!(folder.join("x.aep").exists());
    }

    #[test]
    fn moved_project_is_relinked_not_duplicated() {
        let (_d, conn, work) = setup();
        let a = create(&conn, new(&work, "A")).unwrap();
        let moved = work.join("A-moved");
        fs::rename(&a.path, &moved).unwrap();
        let r = import(&conn, moved.to_str().unwrap(), false).unwrap();
        assert_eq!(r.outcome, ImportOutcome::Relinked);
        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].path, moved.canonicalize().unwrap().to_string_lossy());
        assert!(all[0].available);
    }

    #[test]
    fn copied_project_with_same_id_is_rejected_while_original_exists() {
        let (_d, conn, work) = setup();
        let a = create(&conn, new(&work, "A")).unwrap();
        let copy = work.join("A copy");
        fs::create_dir_all(copy.join(".murre")).unwrap();
        fs::copy(project_json(Path::new(&a.path)), project_json(&copy)).unwrap();
        let err = import(&conn, copy.to_str().unwrap(), false).unwrap_err();
        assert!(matches!(err, AppError::Invalid(m) if m.contains("same ID")));
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn corrupt_project_json_is_reported_and_left_alone() {
        let (_d, conn, work) = setup();
        let folder = work.join("Bad");
        fs::create_dir_all(folder.join(".murre")).unwrap();
        fs::write(project_json(&folder), b"{nope").unwrap();
        assert!(matches!(
            import(&conn, folder.to_str().unwrap(), true),
            Err(AppError::Corrupt { .. })
        ));
        assert_eq!(fs::read(project_json(&folder)).unwrap(), b"{nope");
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn import_rejects_bad_paths() {
        let (_d, conn, work) = setup();
        let f = work.join("file.txt");
        fs::write(&f, b"x").unwrap();
        assert!(import(&conn, f.to_str().unwrap(), true).is_err());
        assert!(import(&conn, work.join("nope").to_str().unwrap(), true).is_err());
        assert!(import(&conn, "relative", true).is_err());
    }

    // ---- relink / identity

    fn make(conn: &Connection, work: &Path, name: &str) -> ProjectRecord {
        create(conn, new(work, name)).unwrap()
    }

    #[test]
    fn relink_follows_a_renamed_folder_by_project_id() {
        let (_d, conn, work) = setup();
        let a = make(&conn, &work, "Alpha");
        let moved = work.join("Alpha (moved)");
        fs::rename(&a.path, &moved).unwrap();
        assert!(!get(&conn, &a.project.id).unwrap().available);

        let r = relink(&conn, &a.project.id, moved.to_str().unwrap()).unwrap();
        assert!(r.available);
        assert_eq!(r.project.id, a.project.id);
        assert_eq!(r.path, fs::canonicalize(&moved).unwrap().to_string_lossy());
        assert!(
            moved.join(".murre/project.json").exists(),
            "nothing moved or deleted"
        );
    }

    #[test]
    fn relink_refuses_a_folder_with_a_different_project() {
        let (_d, conn, work) = setup();
        let a = make(&conn, &work, "Alpha");
        let b = make(&conn, &work, "Beta");
        fs::rename(&a.path, work.join("gone")).unwrap();
        let err = relink(&conn, &a.project.id, &b.path).unwrap_err();
        assert!(matches!(err, AppError::Invalid(m) if m.contains("different project")));
        assert!(!get(&conn, &a.project.id).unwrap().available);
        // A plain folder with no metadata is refused too.
        let plain = work.join("plain");
        fs::create_dir(&plain).unwrap();
        assert!(relink(&conn, &a.project.id, plain.to_str().unwrap()).is_err());
    }

    #[test]
    fn relink_is_refused_while_the_current_folder_is_fine() {
        let (_d, conn, work) = setup();
        let a = make(&conn, &work, "Alpha");
        let other = work.join("copy");
        fs::create_dir_all(other.join(".murre")).unwrap();
        fs::copy(project_json(Path::new(&a.path)), project_json(&other)).unwrap();
        let err = relink(&conn, &a.project.id, other.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, AppError::Invalid(m) if m.contains("available")));
        assert_eq!(get(&conn, &a.project.id).unwrap().path, a.path);
    }

    #[test]
    fn available_root_refuses_a_folder_that_holds_another_project() {
        let (_d, conn, work) = setup();
        let a = make(&conn, &work, "Alpha");
        let b = make(&conn, &work, "Beta");
        assert!(available_root(&conn, &a.project.id).is_ok());
        fs::copy(
            project_json(Path::new(&b.path)),
            project_json(Path::new(&a.path)),
        )
        .unwrap();
        let err = available_root(&conn, &a.project.id).unwrap_err();
        assert!(matches!(err, AppError::Invalid(m) if m.contains("different project")));
        assert!(available_root(&conn, &b.project.id).is_ok());
    }
}
