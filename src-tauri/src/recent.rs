//! Which projects were opened most recently in Murre, newest first. Home shows the last four.
//!
//! Only project ids are kept, in the app's own settings. A project that has since been removed is simply skipped when the
//! list is read, so nothing needs cleaning up. No project file is touched.

use crate::error::AppResult;
use rusqlite::{Connection, OptionalExtension};

const KEY: &str = "recent_projects";
/// Plenty to fill Home even after a few projects have been removed.
const KEEP: usize = 12;

fn read(conn: &Connection) -> AppResult<Vec<String>> {
    let raw: Option<String> = conn.query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |r| r.get(0)).optional()?;
    // A damaged value is not worth failing for: the list just starts again.
    Ok(raw.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok()).unwrap_or_default())
}

/// Ids, most recently opened first.
pub fn list(conn: &Connection) -> AppResult<Vec<String>> {
    read(conn)
}

/// Put a project at the front of the list.
pub fn mark_opened(conn: &Connection, id: &str) -> AppResult<()> {
    let mut ids = read(conn)?;
    ids.retain(|x| x != id);
    ids.insert(0, id.to_string());
    ids.truncate(KEEP);
    let value = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [KEY, value.as_str()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;").unwrap();
        c
    }

    #[test]
    fn newest_first_and_no_repeats() {
        let c = conn();
        assert!(list(&c).unwrap().is_empty());
        for id in ["a", "b", "c", "a"] {
            mark_opened(&c, id).unwrap();
        }
        assert_eq!(list(&c).unwrap(), ["a", "c", "b"]);
    }

    #[test]
    fn the_list_is_capped() {
        let c = conn();
        for i in 0..30 {
            mark_opened(&c, &format!("p{i}")).unwrap();
        }
        let ids = list(&c).unwrap();
        assert_eq!(ids.len(), KEEP);
        assert_eq!(ids[0], "p29");
    }

    #[test]
    fn a_damaged_value_starts_a_fresh_list() {
        let c = conn();
        c.execute("INSERT INTO settings (key, value) VALUES (?1, 'not json')", [KEY]).unwrap();
        assert!(list(&c).unwrap().is_empty());
        mark_opened(&c, "x").unwrap();
        assert_eq!(list(&c).unwrap(), ["x"]);
    }
}
