//! Project notes, stored as a Tiptap/ProseMirror JSON document in
//! `.murre/notes.json`.
//!
//! Saves are revisioned: a save must name the revision it was based on, and is
//! rejected with `Conflict` if the file changed since (another window, a
//! hand edit, a future tool). That way a stale editor can never silently
//! overwrite newer notes.

use crate::error::{AppError, AppResult};
use crate::project::{invalid, now};
use crate::safe_fs;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::Path;
use std::sync::Mutex;

const NOTES_JSON: &str = ".murre/notes.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_BYTES: usize = 2_000_000;
/// Pages per notes area, the first one included.
pub const MAX_PAGES: usize = 20;

/// Serializes the read-compare-write sequence of saves within this process.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NotesFile {
    schema_version: u32,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    updated_at: Option<u64>,
    /// The first page. Older files only have this.
    #[serde(default)]
    content: Option<Value>,
    /// Pages after the first, in order.
    #[serde(default)]
    pages: Vec<ExtraPage>,
    /// Unknown keys are preserved.
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtraPage {
    pub id: String,
    #[serde(default)]
    pub content: Option<Value>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotesView {
    pub revision: u64,
    pub updated_at: Option<u64>,
    /// First page: a Tiptap JSON document, or `null` when nothing has been written yet.
    pub content: Option<Value>,
    /// The pages after the first.
    pub pages: Vec<ExtraPage>,
}

impl From<&NotesFile> for NotesView {
    fn from(f: &NotesFile) -> Self {
        NotesView {
            revision: f.revision,
            updated_at: f.updated_at,
            content: f.content.clone(),
            pages: f.pages.clone(),
        }
    }
}

fn load(root: &Path) -> AppResult<NotesFile> {
    let path = root.join(NOTES_JSON);
    if !path.exists() && !safe_fs::backup_path(&path).exists() {
        return Ok(NotesFile {
            schema_version: SCHEMA_VERSION,
            revision: 0,
            updated_at: None,
            content: None,
            pages: Vec::new(),
            extra: Map::new(),
        });
    }
    let (file, _): (NotesFile, _) = safe_fs::read_json(&path)?;
    if file.schema_version > SCHEMA_VERSION {
        return invalid("These notes were saved by a newer version of Murre.");
    }
    Ok(file)
}

pub fn get(root: &Path) -> AppResult<NotesView> {
    Ok(NotesView::from(&load(root)?))
}

fn validate_content(content: &Value) -> AppResult<()> {
    let obj = content
        .as_object()
        .ok_or_else(|| AppError::Invalid("The note has an unexpected format.".into()))?;
    if obj.get("type").and_then(Value::as_str) != Some("doc") {
        return invalid("The note has an unexpected format.");
    }
    if obj.get("content").is_some_and(|c| !c.is_array()) {
        return invalid("The note has an unexpected format.");
    }
    let size = serde_json::to_vec(content)
        .map(|b| b.len())
        .unwrap_or(usize::MAX);
    if size > MAX_BYTES {
        return invalid("This note is too large to save (over 2 MB).");
    }
    Ok(())
}

fn open_for_write(root: &Path, expected_revision: u64) -> AppResult<NotesFile> {
    let file = load(root)?;
    if file.revision != expected_revision {
        return Err(AppError::Conflict(
            "These notes were changed somewhere else since you opened them.".into(),
        ));
    }
    Ok(file)
}

fn commit(root: &Path, mut file: NotesFile) -> AppResult<NotesView> {
    file.schema_version = SCHEMA_VERSION;
    file.revision += 1;
    file.updated_at = Some(now());
    safe_fs::write_json(&root.join(NOTES_JSON), &file)?;
    Ok(NotesView::from(&file))
}

/// Save the first page if the stored revision is still `expected_revision`.
pub fn save(root: &Path, content: Value, expected_revision: u64) -> AppResult<NotesView> {
    save_page(root, None, content, expected_revision)
}

/// Save one page (`None` is the first) if the stored revision is still `expected_revision`.
pub fn save_page(root: &Path, page_id: Option<&str>, content: Value, expected_revision: u64) -> AppResult<NotesView> {
    validate_content(&content)?;
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = open_for_write(root, expected_revision)?;
    match page_id {
        None => file.content = Some(content),
        Some(id) => match file.pages.iter_mut().find(|p| p.id == id) {
            Some(page) => page.content = Some(content),
            None => return invalid("That page no longer exists."),
        },
    }
    commit(root, file)
}

/// Add an empty page at the end.
pub fn add_page(root: &Path, expected_revision: u64) -> AppResult<NotesView> {
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = open_for_write(root, expected_revision)?;
    if file.pages.len() + 1 >= MAX_PAGES {
        return invalid(format!("There can be at most {MAX_PAGES} pages."));
    }
    file.pages.push(ExtraPage { id: uuid::Uuid::new_v4().simple().to_string(), content: None });
    commit(root, file)
}

/// Remove a page. The first page cannot be removed.
pub fn delete_page(root: &Path, page_id: &str, expected_revision: u64) -> AppResult<NotesView> {
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = open_for_write(root, expected_revision)?;
    let before = file.pages.len();
    file.pages.retain(|p| p.id != page_id);
    if file.pages.len() == before {
        return invalid("That page no longer exists.");
    }
    commit(root, file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn project() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join(".murre")).unwrap();
        d
    }

    fn doc(text: &str) -> Value {
        json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }] })
    }

    #[test]
    fn empty_project_has_revision_zero_and_no_content() {
        let d = project();
        let v = get(d.path()).unwrap();
        assert_eq!((v.revision, v.updated_at, v.content), (0, None, None));
    }

    #[test]
    fn existing_shell_from_project_creation_is_readable() {
        let d = project();
        fs::write(
            d.path().join(NOTES_JSON),
            br#"{"schemaVersion":1,"content":null}"#,
        )
        .unwrap();
        let v = get(d.path()).unwrap();
        assert_eq!((v.revision, v.content), (0, None));
        assert_eq!(save(d.path(), doc("hi"), 0).unwrap().revision, 1);
    }

    #[test]
    fn pages_can_be_added_edited_and_deleted() {
        let d = project();
        save(d.path(), doc("first"), 0).unwrap();
        let v = add_page(d.path(), 1).unwrap();
        assert_eq!((v.revision, v.pages.len()), (2, 1));
        let id = v.pages[0].id.clone();
        assert_eq!(v.pages[0].content, None);
        let v = save_page(d.path(), Some(&id), doc("second"), 2).unwrap();
        assert_eq!(v.pages[0].content, Some(doc("second")));
        assert_eq!(v.content, Some(doc("first")), "page one is untouched");
        assert!(matches!(save_page(d.path(), Some("nope"), doc("x"), 3), Err(AppError::Invalid(_))));
        assert!(matches!(delete_page(d.path(), &id, 1), Err(AppError::Conflict(_))));
        let v = delete_page(d.path(), &id, 3).unwrap();
        assert!(v.pages.is_empty());
        assert_eq!(v.content, Some(doc("first")));
        assert!(matches!(delete_page(d.path(), &id, 4), Err(AppError::Invalid(_))));
    }

    #[test]
    fn page_count_is_limited() {
        let d = project();
        let mut rev = 0;
        for _ in 0..MAX_PAGES - 1 {
            rev = add_page(d.path(), rev).unwrap().revision;
        }
        assert!(matches!(add_page(d.path(), rev), Err(AppError::Invalid(_))));
    }

    #[test]
    fn old_files_without_pages_still_load() {
        let d = project();
        fs::write(d.path().join(NOTES_JSON), br#"{"schemaVersion":1,"revision":4,"content":{"type":"doc"}}"#).unwrap();
        let v = get(d.path()).unwrap();
        assert_eq!((v.revision, v.pages.len()), (4, 0));
    }

    #[test]
    fn save_persists_and_bumps_revision() {
        let d = project();
        let v1 = save(d.path(), doc("one"), 0).unwrap();
        assert_eq!(v1.revision, 1);
        assert!(v1.updated_at.is_some());
        let v2 = save(d.path(), doc("two"), 1).unwrap();
        assert_eq!(v2.revision, 2);
        let read = get(d.path()).unwrap();
        assert_eq!(read.content, Some(doc("two")));
        assert_eq!(read.revision, 2);
    }

    #[test]
    fn stale_revision_is_a_conflict_and_changes_nothing() {
        let d = project();
        save(d.path(), doc("one"), 0).unwrap();
        save(d.path(), doc("two"), 1).unwrap();
        let err = save(d.path(), doc("stale"), 1).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));
        assert_eq!(get(d.path()).unwrap().content, Some(doc("two")));
        assert!(matches!(
            save(d.path(), doc("future"), 9),
            Err(AppError::Conflict(_))
        ));
    }

    #[test]
    fn invalid_content_is_rejected() {
        let d = project();
        for bad in [
            json!(null),
            json!("text"),
            json!([]),
            json!({"type":"paragraph"}),
            json!({"type":"doc","content":"x"}),
        ] {
            assert!(
                matches!(save(d.path(), bad.clone(), 0), Err(AppError::Invalid(_))),
                "{bad}"
            );
        }
        let huge = json!({"type":"doc","content":[{"type":"text","text":"x".repeat(MAX_BYTES)}]});
        assert!(matches!(save(d.path(), huge, 0), Err(AppError::Invalid(_))));
        assert!(!d.path().join(NOTES_JSON).exists());
        assert!(
            save(d.path(), json!({"type":"doc"}), 0).is_ok(),
            "an empty doc is valid"
        );
    }

    #[test]
    fn unknown_keys_survive_a_save() {
        let d = project();
        fs::write(
            d.path().join(NOTES_JSON),
            br#"{"schemaVersion":1,"content":null,"extra":{"keep":1}}"#,
        )
        .unwrap();
        save(d.path(), doc("x"), 0).unwrap();
        let (v, _): (Value, _) = safe_fs::read_json(&d.path().join(NOTES_JSON)).unwrap();
        assert_eq!(v["extra"]["keep"], 1);
    }

    #[test]
    fn corrupt_file_is_untouched_and_backup_recovers() {
        let d = project();
        save(d.path(), doc("one"), 0).unwrap();
        save(d.path(), doc("two"), 1).unwrap();
        fs::write(d.path().join(NOTES_JSON), b"{broken").unwrap();
        assert_eq!(
            get(d.path()).unwrap().content,
            Some(doc("one")),
            "recovered previous good version"
        );

        let d2 = project();
        fs::write(d2.path().join(NOTES_JSON), b"{broken").unwrap();
        assert!(matches!(
            save(d2.path(), doc("x"), 0),
            Err(AppError::Corrupt { .. })
        ));
        assert_eq!(fs::read(d2.path().join(NOTES_JSON)).unwrap(), b"{broken");
    }

    #[test]
    fn newer_schema_is_refused() {
        let d = project();
        fs::write(
            d.path().join(NOTES_JSON),
            br#"{"schemaVersion":99,"content":null}"#,
        )
        .unwrap();
        assert!(get(d.path()).is_err());
        assert!(save(d.path(), doc("x"), 0).is_err());
    }

    #[test]
    fn concurrent_saves_from_the_same_revision_only_one_wins() {
        let d = project();
        let root = std::sync::Arc::new(d.path().to_path_buf());
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let root = root.clone();
                std::thread::spawn(move || save(&root, doc(&i.to_string()), 0).is_ok())
            })
            .collect();
        let wins = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|w| *w)
            .count();
        assert_eq!(wins, 1);
        assert_eq!(get(d.path()).unwrap().revision, 1);
    }
}
