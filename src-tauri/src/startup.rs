//! Opening Murre when the person logs in, and the one-time question about it.
//!
//! The login item itself is the operating system's (a macOS Launch Agent written by the autostart plugin); this module only
//! remembers that the person has been asked, so the question is never repeated, and knows how a login launch looks.

use crate::error::AppResult;
use rusqlite::{Connection, OptionalExtension};

/// The argument the login item starts the app with: stay in the menu bar, show no window.
pub const HIDDEN_ARG: &str = "--hidden";

const ASKED_KEY: &str = "login_item_asked";

/// The app was started by the login item (or by hand with `--hidden`).
pub fn launched_hidden<I: IntoIterator<Item = String>>(args: I) -> bool {
    args.into_iter().any(|a| a == HIDDEN_ARG)
}

/// The person has already answered the "open at login?" question (either way).
pub fn asked(conn: &Connection) -> AppResult<bool> {
    let v: Option<String> = conn.query_row("SELECT value FROM settings WHERE key = ?1", [ASKED_KEY], |r| r.get(0)).optional()?;
    Ok(v.is_some())
}

pub fn mark_asked(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [ASKED_KEY],
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
    fn the_question_is_remembered() {
        let c = conn();
        assert!(!asked(&c).unwrap());
        mark_asked(&c).unwrap();
        mark_asked(&c).unwrap(); // asking twice is harmless
        assert!(asked(&c).unwrap());
    }

    #[test]
    fn a_login_launch_is_recognised_by_its_argument() {
        assert!(launched_hidden(["Murre".to_string(), "--hidden".to_string()]));
        assert!(!launched_hidden(["Murre".to_string()]));
        assert!(!launched_hidden(["--hidden-ish".to_string()]));
    }
}
