//! The per-project to-do list, stored in `.murre/tasks.json`.
//!
//! Every operation is a read-modify-write of the whole file through
//! [`safe_fs`], and returns the full updated list. Callers must serialize
//! operations per project (the app does so by holding the database lock).

use crate::error::{AppError, AppResult};
use crate::project::{invalid, now};
use crate::safe_fs;
use serde::{Deserialize, Serialize};
use std::path::Path;

const TASKS_JSON: &str = ".murre/tasks.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_TITLE_CHARS: usize = 200;
const MAX_TASKS: usize = 1000;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub done: bool,
    pub created_at: u64,
    pub completed_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct TasksFile {
    schema_version: u32,
    tasks: Vec<Task>,
}

fn load(root: &Path) -> AppResult<TasksFile> {
    let path = root.join(TASKS_JSON);
    if !path.exists() && !safe_fs::backup_path(&path).exists() {
        return Ok(TasksFile {
            schema_version: SCHEMA_VERSION,
            tasks: vec![],
        });
    }
    let (file, _): (TasksFile, _) = safe_fs::read_json(&path)?;
    if file.schema_version > SCHEMA_VERSION {
        return invalid("These tasks were saved by a newer version of Murre.");
    }
    Ok(file)
}

fn store(root: &Path, file: &TasksFile) -> AppResult<()> {
    safe_fs::write_json(&root.join(TASKS_JSON), file)
}

pub fn validate_title(raw: &str) -> AppResult<String> {
    let t = raw.trim();
    if t.is_empty() {
        return invalid("Please enter a task.");
    }
    if t.chars().count() > MAX_TITLE_CHARS {
        return invalid(format!(
            "A task must be {MAX_TITLE_CHARS} characters or fewer."
        ));
    }
    if t.chars().any(|c| c.is_control()) {
        return invalid("The task contains invalid characters.");
    }
    Ok(t.to_string())
}

pub fn list(root: &Path) -> AppResult<Vec<Task>> {
    Ok(load(root)?.tasks)
}

pub fn add(root: &Path, title: &str) -> AppResult<Vec<Task>> {
    let title = validate_title(title)?;
    let mut file = load(root)?;
    if file.tasks.len() >= MAX_TASKS {
        return invalid(format!("A project can have at most {MAX_TASKS} tasks."));
    }
    file.tasks.push(Task {
        id: uuid::Uuid::new_v4().to_string(),
        title,
        done: false,
        created_at: now(),
        completed_at: None,
    });
    store(root, &file)?;
    Ok(file.tasks)
}

pub fn set_done(root: &Path, id: &str, done: bool) -> AppResult<Vec<Task>> {
    let mut file = load(root)?;
    let task = file
        .tasks
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| AppError::Invalid("Task not found.".into()))?;
    if task.done != done {
        task.done = done;
        task.completed_at = done.then(now);
        store(root, &file)?;
    }
    Ok(file.tasks)
}

pub fn delete(root: &Path, id: &str) -> AppResult<Vec<Task>> {
    let mut file = load(root)?;
    let before = file.tasks.len();
    file.tasks.retain(|t| t.id != id);
    if file.tasks.len() == before {
        return invalid("Task not found.");
    }
    store(root, &file)?;
    Ok(file.tasks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join(".murre")).unwrap();
        d
    }

    #[test]
    fn missing_file_means_empty_list() {
        let d = project();
        assert_eq!(list(d.path()).unwrap(), vec![]);
    }

    #[test]
    fn add_toggle_delete_round_trip_and_persist() {
        let d = project();
        add(d.path(), "  Block out scene 1 ").unwrap();
        let tasks = add(d.path(), "Export previews").unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].title, "Block out scene 1");
        assert_ne!(tasks[0].id, tasks[1].id);
        assert!(!tasks[0].done && tasks[0].completed_at.is_none());

        let id = tasks[0].id.clone();
        let tasks = set_done(d.path(), &id, true).unwrap();
        assert!(tasks[0].done && tasks[0].completed_at.is_some());
        assert_eq!(list(d.path()).unwrap(), tasks, "persisted to disk");
        let tasks = set_done(d.path(), &id, false).unwrap();
        assert!(!tasks[0].done && tasks[0].completed_at.is_none());

        let tasks = delete(d.path(), &id).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "Export previews");
    }

    #[test]
    fn validation_and_unknown_ids() {
        let d = project();
        assert!(add(d.path(), "   ").is_err());
        assert!(add(d.path(), &"x".repeat(201)).is_err());
        assert!(add(d.path(), "a\nb").is_err());
        assert!(add(d.path(), &"é".repeat(200)).is_ok());
        assert!(set_done(d.path(), "nope", true).is_err());
        assert!(delete(d.path(), "nope").is_err());
        assert_eq!(list(d.path()).unwrap().len(), 1);
    }

    #[test]
    fn task_limit_is_enforced() {
        let d = project();
        let tasks: Vec<Task> = (0..MAX_TASKS)
            .map(|i| Task {
                id: i.to_string(),
                title: "t".into(),
                done: false,
                created_at: 0,
                completed_at: None,
            })
            .collect();
        store(
            d.path(),
            &TasksFile {
                schema_version: 1,
                tasks,
            },
        )
        .unwrap();
        assert!(add(d.path(), "one more").is_err());
    }

    #[test]
    fn corrupt_file_is_never_overwritten_and_backup_recovers() {
        let d = project();
        add(d.path(), "first").unwrap();
        add(d.path(), "second").unwrap();
        fs::write(d.path().join(TASKS_JSON), b"{broken").unwrap();
        // Recovers the previous good version (one task) instead of dropping data.
        assert_eq!(list(d.path()).unwrap().len(), 1);

        let d2 = project();
        fs::write(d2.path().join(TASKS_JSON), b"{broken").unwrap();
        assert!(matches!(add(d2.path(), "x"), Err(AppError::Corrupt { .. })));
        assert_eq!(fs::read(d2.path().join(TASKS_JSON)).unwrap(), b"{broken");
    }

    #[test]
    fn newer_schema_is_refused() {
        let d = project();
        fs::write(
            d.path().join(TASKS_JSON),
            br#"{"schemaVersion":99,"tasks":[]}"#,
        )
        .unwrap();
        assert!(add(d.path(), "x").is_err());
    }
}
