//! How long After Effects was open on each Murre project.
//!
//! A session runs while a connected After Effects reports a project that is in Murre. It ends when that After Effects
//! disconnects or opens something else. After Effects gives no sign of whether anyone is working, so this is time
//! open, not time worked. Only projects added to Murre are ever recorded, and nothing is written next to project files.

use crate::error::AppResult;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// How often an open session's end time is moved forward, so a crash loses at most this much.
const TICK: Duration = Duration::from_secs(30);
/// A project that comes back within this long (After Effects restarting, the panel reloading) continues its session.
const REJOIN_MS: i64 = 2 * 60 * 1000;
/// Sessions shorter than this are not shown.
const MIN_SHOWN_MS: i64 = 60 * 1000;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Keeps the log in step with which projects are open.
#[derive(Default)]
pub struct Tracker {
    /// Project id → row id of its open session.
    open: HashMap<String, i64>,
}

impl Tracker {
    /// Sessions left open by a crash or a quit end at the last time they were seen alive.
    pub fn close_stale(conn: &Connection) -> AppResult<()> {
        conn.execute("UPDATE sessions SET open = 0 WHERE open = 1", [])?;
        Ok(())
    }

    /// `projects` is every project id After Effects currently has open. Ids that are not Murre projects are ignored.
    pub fn observe(&mut self, conn: &Connection, now: i64, projects: &HashSet<String>) -> AppResult<()> {
        // End what is no longer open.
        let gone: Vec<String> = self.open.keys().filter(|id| !projects.contains(*id)).cloned().collect();
        for id in gone {
            if let Some(row) = self.open.remove(&id) {
                conn.execute("UPDATE sessions SET ended_at = ?1, open = 0 WHERE id = ?2", params![now, row])?;
            }
        }
        for id in projects {
            if let Some(row) = self.open.get(id) {
                conn.execute("UPDATE sessions SET ended_at = ?1 WHERE id = ?2", params![now, row])?;
                continue;
            }
            let known: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)", [id], |r| r.get(0))?;
            if !known {
                continue;
            }
            // A short gap continues the last session instead of starting a new one.
            let last: Option<(i64, i64)> = conn
                .query_row(
                    "SELECT id, ended_at FROM sessions WHERE project_id = ?1 ORDER BY ended_at DESC LIMIT 1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            let row = match last {
                Some((row, ended)) if now - ended <= REJOIN_MS => {
                    conn.execute("UPDATE sessions SET ended_at = ?1, open = 1 WHERE id = ?2", params![now, row])?;
                    row
                }
                _ => {
                    conn.execute(
                        "INSERT INTO sessions (project_id, started_at, ended_at, open) VALUES (?1, ?2, ?2, 1)",
                        params![id, now],
                    )?;
                    conn.last_insert_rowid()
                }
            };
            self.open.insert(id.clone(), row);
        }
        Ok(())
    }

    /// End every open session (Murre is quitting).
    pub fn finish(&mut self, conn: &Connection, now: i64) -> AppResult<()> {
        self.observe(conn, now, &HashSet::new())
    }
}

/// Start the logger. Send it the ids that are open whenever they change; it also ticks on its own.
pub fn start(conn: Connection) -> mpsc::Sender<HashSet<String>> {
    let (tx, rx) = mpsc::channel::<HashSet<String>>();
    let _ = thread::Builder::new().name("activity-log".into()).spawn(move || {
        let _ = Tracker::close_stale(&conn);
        let mut tracker = Tracker::default();
        let mut current = HashSet::new();
        loop {
            match rx.recv_timeout(TICK) {
                Ok(set) => current = set,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = tracker.finish(&conn, now_ms());
                    break;
                }
            }
            let _ = tracker.observe(&conn, now_ms(), &current);
        }
    });
    tx
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start: i64,
    pub end: i64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTime {
    pub project_id: String,
    pub name: String,
    pub total_ms: i64,
    pub spans: Vec<Span>,
    /// After Effects has this project open right now (a session in the range is still open).
    pub live: bool,
}

/// Time per project between `from` and `to` (ms), longest first. Sessions are cut to the range. Projects that are no
/// longer in Murre are left out.
pub fn timeline(conn: &Connection, from: i64, to: i64) -> AppResult<Vec<ProjectTime>> {
    let mut stmt = conn.prepare(
        "SELECT s.project_id, p.name, s.started_at, s.ended_at, s.open
         FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE s.ended_at > ?1 AND s.started_at < ?2
         ORDER BY s.started_at",
    )?;
    let rows = stmt.query_map(params![from, to], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)? != 0))
    })?;
    let mut order: Vec<String> = Vec::new();
    let mut by: HashMap<String, ProjectTime> = HashMap::new();
    for row in rows {
        let (id, name, start, end, open) = row?;
        let (start, end) = (start.max(from), end.min(to));
        if end - start < MIN_SHOWN_MS {
            continue;
        }
        let entry = by.entry(id.clone()).or_insert_with(|| {
            order.push(id.clone());
            ProjectTime { project_id: id.clone(), name, total_ms: 0, spans: Vec::new(), live: false }
        });
        entry.total_ms += end - start;
        entry.spans.push(Span { start, end });
        entry.live |= open;
    }
    let mut out: Vec<ProjectTime> = order.into_iter().filter_map(|id| by.remove(&id)).collect();
    out.sort_by(|a, b| b.total_ms.cmp(&a.total_ms).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        for (id, name) in [("a", "Alpha"), ("b", "Beta")] {
            conn.execute(
                "INSERT INTO projects (id,name,path,priority,status,created_at,updated_at) VALUES (?1,?2,?3,'medium','in_progress',0,0)",
                params![id, name, format!("/p/{id}")],
            )
            .unwrap();
        }
        conn
    }

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_session_runs_from_open_to_close() {
        let conn = db();
        let mut t = Tracker::default();
        t.observe(&conn, 0, &set(&["a"])).unwrap();
        t.observe(&conn, 30 * MIN, &set(&["a"])).unwrap();
        t.observe(&conn, 60 * MIN, &set(&[])).unwrap();
        let out = timeline(&conn, 0, 24 * 60 * MIN).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].total_ms, 60 * MIN);
        assert_eq!(out[0].spans, vec![Span { start: 0, end: 60 * MIN }]);
    }

    #[test]
    fn two_projects_open_at_once_are_both_counted() {
        let conn = db();
        let mut t = Tracker::default();
        t.observe(&conn, 0, &set(&["a", "b"])).unwrap();
        t.observe(&conn, 10 * MIN, &set(&["a"])).unwrap();
        t.observe(&conn, 30 * MIN, &set(&[])).unwrap();
        let out = timeline(&conn, 0, 24 * 60 * MIN).unwrap();
        assert_eq!(out[0].project_id, "a");
        assert_eq!(out[0].total_ms, 30 * MIN);
        assert_eq!(out[1].total_ms, 10 * MIN);
    }

    #[test]
    fn a_project_that_is_not_in_murre_is_never_recorded() {
        let conn = db();
        let mut t = Tracker::default();
        t.observe(&conn, 0, &set(&["stranger"])).unwrap();
        t.observe(&conn, 20 * MIN, &set(&[])).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn a_short_gap_continues_the_session_and_a_long_one_starts_a_new_one() {
        let conn = db();
        let mut t = Tracker::default();
        t.observe(&conn, 0, &set(&["a"])).unwrap();
        t.observe(&conn, 10 * MIN, &set(&[])).unwrap();
        t.observe(&conn, 11 * MIN, &set(&["a"])).unwrap(); // back after 1 minute
        t.observe(&conn, 20 * MIN, &set(&[])).unwrap();
        t.observe(&conn, 60 * MIN, &set(&["a"])).unwrap(); // back after 40 minutes
        t.observe(&conn, 70 * MIN, &set(&[])).unwrap();
        let out = timeline(&conn, 0, 24 * 60 * MIN).unwrap();
        assert_eq!(out[0].spans.len(), 2);
        assert_eq!(out[0].total_ms, 30 * MIN);
    }

    #[test]
    fn a_session_left_open_by_a_crash_ends_when_it_was_last_seen() {
        let conn = db();
        let mut t = Tracker::default();
        t.observe(&conn, 0, &set(&["a"])).unwrap();
        t.observe(&conn, 10 * MIN, &set(&["a"])).unwrap();
        // Murre dies here. On the next start:
        Tracker::close_stale(&conn).unwrap();
        let mut again = Tracker::default();
        again.observe(&conn, 500 * MIN, &set(&["a"])).unwrap();
        let out = timeline(&conn, 0, 24 * 60 * MIN).unwrap();
        assert_eq!(out[0].spans[0], Span { start: 0, end: 10 * MIN });
    }

    #[test]
    fn sessions_are_cut_to_the_range_and_blips_are_left_out() {
        let conn = db();
        let mut t = Tracker::default();
        t.observe(&conn, 0, &set(&["a"])).unwrap();
        t.observe(&conn, 60 * MIN, &set(&[])).unwrap();
        t.observe(&conn, 600 * MIN, &set(&["b"])).unwrap();
        t.observe(&conn, 600 * MIN + 20_000, &set(&[])).unwrap(); // 20 seconds
        let out = timeline(&conn, 30 * MIN, 24 * 60 * MIN).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].total_ms, 30 * MIN);
        assert_eq!(out[0].spans[0].start, 30 * MIN);
    }

    #[test]
    fn a_project_is_live_only_while_its_session_is_open() {
        let conn = db();
        let mut t = Tracker::default();
        t.observe(&conn, 0, &set(&["a"])).unwrap();
        t.observe(&conn, 10 * MIN, &set(&["a"])).unwrap();
        assert!(timeline(&conn, 0, 24 * 60 * MIN).unwrap()[0].live);
        t.observe(&conn, 11 * MIN, &set(&[])).unwrap();
        assert!(!timeline(&conn, 0, 24 * 60 * MIN).unwrap()[0].live);
    }

    #[test]
    fn a_removed_project_drops_out_of_the_timeline() {
        let conn = db();
        let mut t = Tracker::default();
        t.observe(&conn, 0, &set(&["a"])).unwrap();
        t.observe(&conn, 30 * MIN, &set(&[])).unwrap();
        conn.execute("DELETE FROM projects WHERE id = 'a'", []).unwrap();
        assert!(timeline(&conn, 0, 24 * 60 * MIN).unwrap().is_empty());
    }
}
