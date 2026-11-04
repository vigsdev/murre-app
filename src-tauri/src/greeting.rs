//! What Home needs to remember about its greeting: today's pick, the last few days' picks and which one-off
//! events have been seen. The page decides everything; this only keeps the text between launches, in the app's own
//! settings. Nothing in a project folder is read or written.

use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OptionalExtension};

const KEY: &str = "greeting_state";
/// Far more than the page ever writes (about two kilobytes); a limit so a bug cannot fill the settings table.
const MAX_BYTES: usize = 64 * 1024;

pub fn load(conn: &Connection) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |r| r.get(0)).optional()?)
}

pub fn save(conn: &Connection, json: &str) -> AppResult<()> {
    if json.len() > MAX_BYTES {
        return Err(AppError::Invalid("The greeting state is too large to save.".into()));
    }
    if serde_json::from_str::<serde_json::Value>(json).is_err() {
        return Err(AppError::Invalid("The greeting state is not valid JSON.".into()));
    }
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [KEY, json],
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
    fn nothing_saved_yet_is_none_and_a_save_round_trips() {
        let c = conn();
        assert_eq!(load(&c).unwrap(), None);
        save(&c, r#"{"v":1}"#).unwrap();
        save(&c, r#"{"v":2}"#).unwrap();
        assert_eq!(load(&c).unwrap().as_deref(), Some(r#"{"v":2}"#));
    }

    #[test]
    fn rubbish_and_oversized_values_are_refused_and_the_old_one_stays() {
        let c = conn();
        save(&c, r#"{"v":1}"#).unwrap();
        assert!(save(&c, "not json").is_err());
        assert!(save(&c, &format!("\"{}\"", "x".repeat(MAX_BYTES))).is_err());
        assert_eq!(load(&c).unwrap().as_deref(), Some(r#"{"v":1}"#));
    }
}
