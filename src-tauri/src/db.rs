//! SQLite setup and schema migrations.
//!
//! The schema version is stored in `PRAGMA user_version`. Each migration runs
//! in its own transaction, so a failed migration leaves the database at the
//! last good version. To change the schema, append a new entry to
//! [`MIGRATIONS`]; never edit an existing one.

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::path::Path;

const MIGRATIONS: &[&str] = &[
    // 1: app-level key/value preferences.
    "CREATE TABLE settings (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
    ) STRICT;",
    // 2: indexed copy of each project's `.murre/project.json` (the JSON file is authoritative).
    "CREATE TABLE projects (
        id          TEXT PRIMARY KEY NOT NULL,
        name        TEXT NOT NULL,
        path        TEXT NOT NULL UNIQUE,
        client      TEXT,
        deadline    TEXT,
        priority    TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL,
        space_id    TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX projects_status ON projects (status);
    CREATE INDEX projects_deadline ON projects (deadline);",
    // 3: user-created calendar events (project deadlines are not stored here; they come from projects).
    "CREATE TABLE events (
        id         TEXT PRIMARY KEY NOT NULL,
        title      TEXT NOT NULL,
        date       TEXT NOT NULL,
        notes      TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX events_date ON events (date);",
    // 4: Spaces, virtual project collections. A project's `space_id` (in project.json) points here.
    "CREATE TABLE spaces (
        id         TEXT PRIMARY KEY NOT NULL,
        name       TEXT NOT NULL,
        icon       TEXT NOT NULL,
        position   INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    ) STRICT;",
    // 5: time After Effects was open on a Murre project (times in ms since the epoch). `open` is 1 until the session ends.
    "CREATE TABLE sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER NOT NULL,
        open       INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE INDEX sessions_project ON sessions (project_id, started_at);
    CREATE INDEX sessions_started ON sessions (started_at);",
];

pub fn latest_version() -> u32 {
    MIGRATIONS.len() as u32
}

pub fn current_version(conn: &Connection) -> AppResult<u32> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

pub fn migrate(conn: &mut Connection) -> AppResult<u32> {
    let current = current_version(conn)?;
    if current > latest_version() {
        return Err(AppError::Invalid(format!(
            "The database was created by a newer version of Murre (schema {current}, this build supports {}).",
            latest_version()
        )));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        // user_version cannot be bound as a parameter.
        tx.execute_batch(&format!("PRAGMA user_version = {};", i + 1))?;
        tx.commit()?;
    }
    current_version(conn)
}

/// Open (creating if needed) the database at `path` and bring it up to date.
pub fn open(path: &Path) -> AppResult<Connection> {
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    migrate(&mut conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_is_migrated_to_latest() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        assert_eq!(current_version(&conn).unwrap(), latest_version());
        conn.execute("INSERT INTO settings (key, value) VALUES ('a', 'b')", [])
            .unwrap();
    }

    #[test]
    fn reopening_is_idempotent_and_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.db");
        {
            let conn = open(&p).unwrap();
            conn.execute("INSERT INTO settings (key, value) VALUES ('a', 'b')", [])
                .unwrap();
        }
        let conn = open(&p).unwrap();
        let v: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'a'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(v, "b");
        assert_eq!(current_version(&conn).unwrap(), latest_version());
    }

    #[test]
    fn newer_schema_is_rejected_not_modified() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.db");
        {
            let conn = Connection::open(&p).unwrap();
            conn.execute_batch(&format!("PRAGMA user_version = {};", latest_version() + 1))
                .unwrap();
        }
        assert!(matches!(open(&p), Err(AppError::Invalid(_))));
    }
}
