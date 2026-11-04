//! Reconciliation scan: compare the app's index with what is really on disk.
//!
//! `.murre/project.json` is authoritative and the SQLite index is a copy, so
//! hand edits, restores from backup or changes made by other tools are picked up
//! here. The scan only ever updates the index; it never writes to project folders,
//! and it never relies on folder names or timestamps to decide which project a
//! folder holds (the stored project ID decides).
//!
//! Disk reads happen without holding the database lock, so a slow or
//! disconnected drive cannot freeze the rest of the app.

use crate::error::AppResult;
use crate::project::{Project, ProjectRecord, SCHEMA_VERSION, validate_deadline};
use crate::project_store::{
    find_by_id, has_project_json, list, project_json, validate_display_name,
};
use crate::safe_fs;
use rusqlite::{Connection, params};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProblemKind {
    /// The folder now holds a different project than the one registered here.
    Replaced,
    /// `project.json` is damaged, invalid or from a newer version.
    Unreadable,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub id: String,
    pub name: String,
    pub kind: ProblemKind,
    pub message: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub checked: usize,
    /// Projects whose index row was refreshed from their `project.json`.
    pub synced: Vec<String>,
    /// Projects whose folder (or `.murre/project.json`) is not there right now.
    pub unavailable: Vec<String>,
    pub problems: Vec<Problem>,
}

enum Observed {
    Missing,
    Present(Project),
    Problem(ProblemKind, String),
}

fn observe(record: &ProjectRecord) -> Observed {
    let root = Path::new(&record.path);
    if !has_project_json(root) {
        return Observed::Missing;
    }
    let p: Project = match safe_fs::read_json(&project_json(root)) {
        Ok((p, _)) => p,
        Err(e) => return Observed::Problem(ProblemKind::Unreadable, e.to_string()),
    };
    if p.id != record.project.id {
        return Observed::Problem(
            ProblemKind::Replaced,
            format!(
                "The folder {} now holds a different project (\"{}\"). It was left untouched. Use Locate folder to point \"{}\" at its real folder.",
                record.path, p.name, record.project.name
            ),
        );
    }
    if p.schema_version > SCHEMA_VERSION {
        return Observed::Problem(
            ProblemKind::Unreadable,
            "This project was saved by a newer version of Murre.".into(),
        );
    }
    let valid = validate_display_name(&p.name).is_ok()
        && p.deadline
            .as_deref()
            .is_none_or(|d| validate_deadline(d).is_ok());
    if !valid {
        return Observed::Problem(
            ProblemKind::Unreadable,
            "project.json has values Murre cannot use (name or deadline).".into(),
        );
    }
    Observed::Present(p)
}

fn differs(record: &ProjectRecord, p: &Project) -> bool {
    let r = &record.project;
    r.name != p.name
        || r.client != p.client
        || r.deadline != p.deadline
        || r.priority != p.priority
        || r.description != p.description
        || r.status != p.status
        || r.space_id != p.space_id
        || r.updated_at != p.updated_at
}

/// Run a scan. `db` is locked only to read the index and to apply updates.
pub fn run(db: &Mutex<Connection>) -> AppResult<Report> {
    let records = {
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        list(&conn)?
    };

    let mut report = Report {
        checked: records.len(),
        ..Default::default()
    };
    let mut to_sync: Vec<String> = Vec::new();
    for record in &records {
        match observe(record) {
            Observed::Missing => report.unavailable.push(record.project.id.clone()),
            Observed::Problem(kind, message) => report.problems.push(Problem {
                id: record.project.id.clone(),
                name: record.project.name.clone(),
                kind,
                message,
            }),
            Observed::Present(p) => {
                if differs(record, &p) {
                    to_sync.push(record.project.id.clone());
                }
            }
        }
    }

    if !to_sync.is_empty() {
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        for id in to_sync {
            // Edits hold this lock across their JSON write and index update, so
            // re-reading under it cannot see a half-finished edit.
            let Some(current) = find_by_id(&conn, &id)? else {
                continue;
            };
            let Observed::Present(p) = observe(&current) else {
                continue;
            };
            if !differs(&current, &p) {
                continue;
            }
            conn.execute(
                "UPDATE projects SET name=?2, client=?3, deadline=?4, priority=?5, description=?6,
                 status=?7, space_id=?8, updated_at=?9 WHERE id=?1",
                params![
                    p.id,
                    p.name,
                    p.client,
                    p.deadline,
                    p.priority.as_str(),
                    p.description,
                    p.status.as_str(),
                    p.space_id,
                    p.updated_at as i64
                ],
            )?;
            report.synced.push(id);
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::project::{NewProject, Priority, Status, create};
    use crate::project_store;
    use std::fs;
    use std::path::PathBuf;

    struct Env {
        _dir: tempfile::TempDir,
        db: Mutex<Connection>,
        work: PathBuf,
    }

    fn env() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("app.db")).unwrap();
        let work = dir.path().join("work");
        fs::create_dir(&work).unwrap();
        Env {
            _dir: dir,
            db: Mutex::new(conn),
            work,
        }
    }

    fn make(e: &Env, name: &str) -> ProjectRecord {
        let conn = e.db.lock().unwrap();
        create(
            &conn,
            NewProject {
                name: name.into(),
                parent_dir: e.work.to_string_lossy().into_owned(),
                client: None,
                deadline: None,
                priority: Priority::Medium,
                description: None,
                status: Status::NotStarted,
                space_id: None,
            },
        )
        .unwrap()
    }

    fn json_path(r: &ProjectRecord) -> PathBuf {
        Path::new(&r.path).join(".murre/project.json")
    }

    #[test]
    fn clean_projects_report_nothing() {
        let e = env();
        make(&e, "One");
        let r = run(&e.db).unwrap();
        assert_eq!(r.checked, 1);
        assert!(r.synced.is_empty() && r.unavailable.is_empty() && r.problems.is_empty());
    }

    #[test]
    fn hand_edit_of_project_json_refreshes_the_index() {
        let e = env();
        let rec = make(&e, "One");
        let mut v: serde_json::Value =
            serde_json::from_slice(&fs::read(json_path(&rec)).unwrap()).unwrap();
        v["status"] = "completed".into();
        v["deadline"] = "2031-02-03".into();
        v["name"] = "Renamed".into();
        fs::write(json_path(&rec), serde_json::to_vec(&v).unwrap()).unwrap();

        let r = run(&e.db).unwrap();
        assert_eq!(r.synced, vec![rec.project.id.clone()]);
        let conn = e.db.lock().unwrap();
        let now = project_store::get(&conn, &rec.project.id).unwrap();
        assert_eq!(now.project.name, "Renamed");
        assert_eq!(now.project.deadline.as_deref(), Some("2031-02-03"));
        assert_eq!(now.project.status, Status::Completed);
        drop(conn);
        assert!(
            run(&e.db).unwrap().synced.is_empty(),
            "second scan is a no-op"
        );
    }

    #[test]
    fn missing_folder_is_unavailable_and_nothing_is_deleted() {
        let e = env();
        let rec = make(&e, "One");
        let moved = e.work.join("elsewhere");
        fs::rename(&rec.path, &moved).unwrap();
        let r = run(&e.db).unwrap();
        assert_eq!(r.unavailable, vec![rec.project.id.clone()]);
        let conn = e.db.lock().unwrap();
        assert!(
            project_store::get(&conn, &rec.project.id).is_ok(),
            "row kept"
        );
        assert!(moved.join(".murre/project.json").exists());
    }

    #[test]
    fn a_different_project_in_the_folder_is_flagged_not_adopted() {
        let e = env();
        let a = make(&e, "Alpha");
        let b = make(&e, "Beta");
        // Put Beta's metadata where Alpha lives.
        fs::copy(json_path(&b), json_path(&a)).unwrap();
        let r = run(&e.db).unwrap();
        let p = r
            .problems
            .iter()
            .find(|p| p.id == a.project.id)
            .expect("alpha flagged");
        assert_eq!(p.kind, ProblemKind::Replaced);
        let conn = e.db.lock().unwrap();
        assert_eq!(
            project_store::get(&conn, &a.project.id)
                .unwrap()
                .project
                .name,
            "Alpha",
            "index not overwritten"
        );
    }

    #[test]
    fn damaged_json_is_a_problem_and_the_index_is_kept() {
        let e = env();
        let rec = make(&e, "One");
        fs::write(json_path(&rec), "not json").unwrap();
        fs::remove_file(crate::safe_fs::backup_path(&json_path(&rec))).ok();
        let r = run(&e.db).unwrap();
        assert_eq!(r.problems.len(), 1);
        assert_eq!(r.problems[0].kind, ProblemKind::Unreadable);
        let conn = e.db.lock().unwrap();
        assert_eq!(
            project_store::get(&conn, &rec.project.id)
                .unwrap()
                .project
                .name,
            "One"
        );
    }

    #[test]
    fn invalid_values_in_json_are_not_copied_into_the_index() {
        let e = env();
        let rec = make(&e, "One");
        let mut v: serde_json::Value =
            serde_json::from_slice(&fs::read(json_path(&rec)).unwrap()).unwrap();
        v["deadline"] = "not-a-date".into();
        fs::write(json_path(&rec), serde_json::to_vec(&v).unwrap()).unwrap();
        let r = run(&e.db).unwrap();
        assert_eq!(r.problems.len(), 1);
        assert!(r.synced.is_empty());
    }
}
