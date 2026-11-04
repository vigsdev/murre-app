//! User-created calendar events, kept in the app database.
//!
//! Project deadlines are not events: they live in each project's `project.json`
//! (with an indexed copy) and are changed through `project_store::set_deadline`.

use crate::error::{AppError, AppResult};
use crate::project::{invalid, now, validate_deadline};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

const MAX_TITLE_CHARS: usize = 120;
const MAX_NOTES_CHARS: usize = 2000;
const MAX_RANGE_DAYS: i64 = 800;
const MAX_EVENTS: i64 = 20_000;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub title: String,
    /// `YYYY-MM-DD`
    pub date: String,
    pub notes: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub title: String,
    pub date: String,
    pub notes: Option<String>,
}

struct Clean {
    title: String,
    date: String,
    notes: Option<String>,
}

fn clean(input: &EventInput) -> AppResult<Clean> {
    let title = input.title.trim();
    if title.is_empty() {
        return invalid("Please enter a title for the event.");
    }
    if title.chars().count() > MAX_TITLE_CHARS || title.chars().any(char::is_control) {
        return invalid("The event title is too long or contains invalid characters.");
    }
    let date = validate_deadline(input.date.trim())
        .map_err(|_| AppError::Invalid("The event date must be a valid date.".into()))?;
    let notes = input
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    if notes.is_some_and(|n| n.chars().count() > MAX_NOTES_CHARS) {
        return invalid("The event notes are too long (limit 2000 characters).");
    }
    Ok(Clean {
        title: title.to_string(),
        date,
        notes: notes.map(String::from),
    })
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Event> {
    Ok(Event {
        id: r.get(0)?,
        title: r.get(1)?,
        date: r.get(2)?,
        notes: r.get(3)?,
        created_at: r.get::<_, i64>(4)? as u64,
        updated_at: r.get::<_, i64>(5)? as u64,
    })
}

const COLS: &str = "id, title, date, notes, created_at, updated_at";

/// Days since 1970-01-01 for a validated `YYYY-MM-DD` (civil-calendar arithmetic).
fn day_number(date: &str) -> i64 {
    let y: i64 = date[0..4].parse().unwrap();
    let m: i64 = date[5..7].parse().unwrap();
    let d: i64 = date[8..10].parse().unwrap();
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Events with `from <= date <= to` (inclusive), oldest first.
pub fn list(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<Event>> {
    let from = validate_deadline(from)?;
    let to = validate_deadline(to)?;
    let span = day_number(&to) - day_number(&from);
    if !(0..=MAX_RANGE_DAYS).contains(&span) {
        return invalid("That date range is not valid.");
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM events WHERE date >= ?1 AND date <= ?2 ORDER BY date, created_at, id"
    ))?;
    let rows = stmt.query_map(params![from, to], row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<Event>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM events WHERE id = ?1"),
            [id],
            row,
        )
        .optional()?)
}

pub fn add(conn: &Connection, input: &EventInput) -> AppResult<Event> {
    let c = clean(input)?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
    if count >= MAX_EVENTS {
        return invalid("Too many events. The calendar needs some breathing room. Delete one before adding more.");
    }
    let id = uuid::Uuid::new_v4().to_string();
    let t = now() as i64;
    conn.execute(
        "INSERT INTO events (id, title, date, notes, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, c.title, c.date, c.notes, t],
    )?;
    Ok(get(conn, &id)?.expect("just inserted"))
}

pub fn update(conn: &Connection, id: &str, input: &EventInput) -> AppResult<Event> {
    let c = clean(input)?;
    let n = conn.execute(
        "UPDATE events SET title=?2, date=?3, notes=?4, updated_at=?5 WHERE id=?1",
        params![id, c.title, c.date, c.notes, now() as i64],
    )?;
    if n == 0 {
        return invalid("That event no longer exists.");
    }
    Ok(get(conn, id)?.expect("just updated"))
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM events WHERE id = ?1", [id])?;
    if n == 0 {
        return invalid("That event no longer exists.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn conn() -> (tempfile::TempDir, Connection) {
        let d = tempfile::tempdir().unwrap();
        let c = db::open(&d.path().join("a.db")).unwrap();
        (d, c)
    }

    fn ev(title: &str, date: &str) -> EventInput {
        EventInput {
            title: title.into(),
            date: date.into(),
            notes: None,
        }
    }

    #[test]
    fn add_list_update_delete_roundtrip() {
        let (_d, c) = conn();
        let a = add(&c, &ev("  Client call ", "2026-11-05")).unwrap();
        assert_eq!(a.title, "Client call");
        add(&c, &ev("Later", "2026-12-01")).unwrap();
        add(&c, &ev("Earlier", "2026-10-31")).unwrap();
        let l = list(&c, "2026-11-01", "2026-11-30").unwrap();
        assert_eq!(l.len(), 1);
        let l = list(&c, "2026-10-31", "2026-12-01").unwrap();
        assert_eq!(
            l.iter().map(|e| e.title.as_str()).collect::<Vec<_>>(),
            ["Earlier", "Client call", "Later"]
        );
        let u = update(
            &c,
            &a.id,
            &EventInput {
                title: "Moved".into(),
                date: "2026-11-06".into(),
                notes: Some(" bring storyboard ".into()),
            },
        )
        .unwrap();
        assert_eq!(
            (u.date.as_str(), u.notes.as_deref()),
            ("2026-11-06", Some("bring storyboard"))
        );
        delete(&c, &a.id).unwrap();
        assert!(get(&c, &a.id).unwrap().is_none());
        assert!(delete(&c, &a.id).is_err());
        assert!(update(&c, &a.id, &ev("x", "2026-11-06")).is_err());
    }

    #[test]
    fn validation_rejects_bad_input_and_changes_nothing() {
        let (_d, c) = conn();
        for bad in [
            ev("", "2026-11-05"),
            ev("   ", "2026-11-05"),
            ev("ok", "2026-02-30"),
            ev("ok", "next week"),
            ev(&"x".repeat(121), "2026-11-05"),
            ev("bad\u{0}title", "2026-11-05"),
            EventInput {
                title: "ok".into(),
                date: "2026-11-05".into(),
                notes: Some("n".repeat(2001)),
            },
        ] {
            assert!(add(&c, &bad).is_err());
        }
        assert_eq!(list(&c, "2026-01-01", "2026-12-31").unwrap().len(), 0);
        let a = add(&c, &ev("keep", "2026-11-05")).unwrap();
        assert!(update(&c, &a.id, &ev("", "2026-11-05")).is_err());
        assert_eq!(get(&c, &a.id).unwrap().unwrap().title, "keep");
    }

    #[test]
    fn range_is_validated_and_bounded() {
        let (_d, c) = conn();
        assert!(list(&c, "2026-12-01", "2026-11-01").is_err());
        assert!(list(&c, "2020-01-01", "2026-01-01").is_err());
        assert!(list(&c, "nope", "2026-01-01").is_err());
        assert!(list(&c, "2026-01-01", "2027-03-01").is_ok());
        assert_eq!(day_number("1970-01-01"), 0);
        assert_eq!(day_number("2000-03-01") - day_number("2000-02-28"), 2);
        assert_eq!(day_number("2026-03-01") - day_number("2026-02-28"), 1);
    }
}
