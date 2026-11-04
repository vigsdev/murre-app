//! Spaces: virtual project collections kept in the app database.
//!
//! A Space is only a label. It never corresponds to a folder, and deleting one
//! never touches a project's files. A project's membership is its `space_id`
//! in `project.json` (with an indexed copy); the Space itself lives here.

use crate::error::AppResult;
use crate::project::{invalid, now};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

const MAX_NAME_CHARS: usize = 40;
const MAX_SPACES: i64 = 200;

/// Icons a Space may use (lucide icon keys; the interface maps them to pictures).
pub const ICONS: &[&str] = &[
    "layers",
    "folder",
    "briefcase",
    "star",
    "heart",
    "film",
    "clapperboard",
    "music",
    "camera",
    "palette",
    "rocket",
    "flag",
    "zap",
    "bookmark",
    "globe",
    "tv",
];

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub position: i64,
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Space> {
    Ok(Space {
        id: r.get(0)?,
        name: r.get(1)?,
        icon: r.get(2)?,
        position: r.get(3)?,
    })
}

fn clean(name: &str, icon: &str) -> AppResult<(String, String)> {
    let name = name.trim();
    if name.is_empty() {
        return invalid("Please enter a name for the Space.");
    }
    if name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return invalid("The Space name is too long or contains invalid characters.");
    }
    if !ICONS.contains(&icon) {
        return invalid("That icon is not available.");
    }
    Ok((name.to_string(), icon.to_string()))
}

pub fn list(conn: &Connection) -> AppResult<Vec<Space>> {
    let mut stmt = conn
        .prepare("SELECT id, name, icon, position FROM spaces ORDER BY position, created_at, id")?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn exists(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM spaces WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}

fn name_taken(conn: &Connection, name: &str, except: Option<&str>) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM spaces WHERE lower(name) = lower(?1) AND id != ?2",
            params![name, except.unwrap_or("")],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

pub fn create(conn: &Connection, name: &str, icon: &str) -> AppResult<Space> {
    let (name, icon) = clean(name, icon)?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM spaces", [], |r| r.get(0))?;
    if count >= MAX_SPACES {
        return invalid("There are too many Spaces.");
    }
    if name_taken(conn, &name, None)? {
        return invalid("A Space with that name already exists.");
    }
    let id = uuid::Uuid::new_v4().to_string();
    let position: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM spaces",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO spaces (id, name, icon, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, icon, position, now() as i64],
    )?;
    Ok(Space {
        id,
        name,
        icon,
        position,
    })
}

pub fn update(conn: &Connection, id: &str, name: &str, icon: &str) -> AppResult<Space> {
    let (name, icon) = clean(name, icon)?;
    if name_taken(conn, &name, Some(id))? {
        return invalid("A Space with that name already exists.");
    }
    let n = conn.execute(
        "UPDATE spaces SET name = ?2, icon = ?3 WHERE id = ?1",
        params![id, name, icon],
    )?;
    if n == 0 {
        return invalid("That Space no longer exists.");
    }
    Ok(list(conn)?
        .into_iter()
        .find(|s| s.id == id)
        .expect("exists"))
}

/// `ids` must be exactly the current set of Spaces, in the new order.
pub fn reorder(conn: &mut Connection, ids: &[String]) -> AppResult<Vec<Space>> {
    let current = list(conn)?;
    let mut want: Vec<&str> = ids.iter().map(String::as_str).collect();
    let mut have: Vec<&str> = current.iter().map(|s| s.id.as_str()).collect();
    want.sort_unstable();
    have.sort_unstable();
    if want != have {
        return invalid("The list of Spaces changed. Please try again.");
    }
    let tx = conn.transaction()?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE spaces SET position = ?2 WHERE id = ?1",
            params![id, i as i64],
        )?;
    }
    tx.commit()?;
    list(conn)
}

/// Remove the Space row only. Callers first take member projects out of it.
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM spaces WHERE id = ?1", [id])?;
    if n == 0 {
        return invalid("That Space no longer exists.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn conn() -> ((), Connection) {
        let mut c = Connection::open_in_memory().unwrap();
        db::migrate(&mut c).unwrap();
        ((), c)
    }

    #[test]
    fn create_list_update_delete() {
        let (_d, mut c) = conn();
        let a = create(&c, "  Clients ", "folder").unwrap();
        let b = create(&c, "Personal", "heart").unwrap();
        assert_eq!((a.position, b.position), (0, 1));
        assert_eq!(a.name, "Clients");
        assert!(exists(&c, &a.id).unwrap());
        let u = update(&c, &a.id, "Agencies", "briefcase").unwrap();
        assert_eq!(
            (u.name.as_str(), u.icon.as_str()),
            ("Agencies", "briefcase")
        );
        let order = reorder(&mut c, &[b.id.clone(), a.id.clone()]).unwrap();
        assert_eq!(
            order.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["Personal", "Agencies"]
        );
        // New Spaces go to the end.
        let n = create(&c, "New", "star").unwrap();
        assert_eq!(n.position, 2);
        delete(&c, &a.id).unwrap();
        assert!(!exists(&c, &a.id).unwrap());
        assert!(delete(&c, &a.id).is_err());
        assert!(update(&c, &a.id, "x", "star").is_err());
    }

    #[test]
    fn validation() {
        let (_d, mut c) = conn();
        for (n, i) in [
            ("", "folder"),
            ("  ", "folder"),
            ("ok", "skull"),
            ("bad\u{7}", "folder"),
        ] {
            assert!(create(&c, n, i).is_err(), "{n:?} {i}");
        }
        assert!(create(&c, &"x".repeat(41), "folder").is_err());
        let a = create(&c, "Work", "folder").unwrap();
        assert!(
            create(&c, "work", "star").is_err(),
            "names are unique ignoring case"
        );
        let b = create(&c, "Home", "star").unwrap();
        assert!(update(&c, &b.id, "WORK", "star").is_err());
        assert!(
            update(&c, &a.id, "Work", "star").is_ok(),
            "keeping own name is fine"
        );
        // Reorder must be exactly the current set.
        assert!(reorder(&mut c, &[a.id.clone()]).is_err());
        assert!(reorder(&mut c, &[a.id.clone(), a.id.clone()]).is_err());
        assert!(reorder(&mut c, &[a.id.clone(), "ghost".into()]).is_err());
        assert_eq!(list(&c).unwrap().len(), 2);
    }

    #[test]
    fn every_icon_is_accepted() {
        let (_d, c) = conn();
        for (i, icon) in ICONS.iter().enumerate() {
            create(&c, &format!("S{i}"), icon).unwrap();
        }
    }
}
