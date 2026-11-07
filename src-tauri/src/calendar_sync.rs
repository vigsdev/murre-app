//! Showing Murre's deadlines and events in Apple Calendar.
//!
//! Murre keeps its own calendar there, named "Murre", and only ever changes events in it that it made itself (their
//! link starts with `murre://`). Murre is the source: a sync makes that calendar match Murre's data, so edits made
//! in Calendar to those events are replaced. Off by default; the setting lives in the app database.
//!
//! This file decides what should be in the calendar and what to change. `calendar_mac` does the talking to
//! Apple's EventKit. On other systems the feature reports itself as unsupported.

use crate::error::AppResult;
use crate::project::Status;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const SETTING_KEY: &str = "apple_calendar";
pub const CALENDAR_TITLE: &str = "Murre";
/// Events Murre made carry a link starting with this.
pub const LINK_PREFIX: &str = "murre://";
/// How often the calendar is brought up to date anyway (changes made outside the app, a project edited elsewhere).
const EVERY: Duration = Duration::from_secs(15 * 60);
/// Changes in a row (typing a deadline, dragging cards) are gathered into one sync.
const SETTLE: Duration = Duration::from_secs(2);

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    /// The identifier of the "Murre" calendar once it exists.
    pub calendar_id: Option<String>,
}

pub fn read_settings(conn: &Connection) -> AppResult<Settings> {
    let raw: Option<String> =
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [SETTING_KEY], |r| r.get(0)).optional()?;
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default())
}

pub fn write_settings(conn: &Connection, s: &Settings) -> AppResult<()> {
    let value = serde_json::to_string(s).map_err(|e| crate::error::AppError::Invalid(e.to_string()))?;
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", rusqlite::params![SETTING_KEY, value])?;
    Ok(())
}

/// One all-day event as Murre wants it in the calendar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// `murre://deadline/<project id>` or `murre://event/<event id>`: how a calendar event is matched to Murre's.
    pub link: String,
    pub title: String,
    /// `YYYY-MM-DD`
    pub date: String,
    pub notes: Option<String>,
}

/// An event found in the Murre calendar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Existing {
    /// EventKit's identifier for it.
    pub id: String,
    pub link: Option<String>,
    pub title: String,
    pub date: String,
    pub notes: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub create: Vec<Item>,
    /// EventKit identifier and what it should become.
    pub update: Vec<(String, Item)>,
    /// EventKit identifiers of Murre's own events that are no longer wanted.
    pub remove: Vec<String>,
}

fn status_label(s: Status) -> &'static str {
    match s {
        Status::NotStarted => "Not started",
        Status::InProgress => "In progress",
        Status::InReview => "In review",
        Status::QualityCheck => "Quality check",
        Status::Completed => "Completed",
        Status::Archived => "Archived",
    }
}

/// What Murre wants in the calendar: each project's deadline (archived projects left out) and every Murre event.
pub fn desired(conn: &Connection) -> AppResult<Vec<Item>> {
    let mut items = Vec::new();
    for rec in crate::project_store::list(conn)? {
        let p = rec.project;
        let Some(date) = p.deadline.clone() else { continue };
        if p.status == Status::Archived {
            continue;
        }
        let mut notes = Vec::new();
        if let Some(c) = p.client.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            notes.push(format!("Client: {c}"));
        }
        notes.push(format!("Status: {}", status_label(p.status)));
        let priority = p.priority.as_str();
        notes.push(format!("Priority: {}{}", priority[..1].to_uppercase(), &priority[1..]));
        items.push(Item {
            link: format!("{LINK_PREFIX}deadline/{}", p.id),
            title: format!("Deadline: {}", p.name),
            date,
            notes: Some(notes.join("\n")),
        });
    }
    for e in crate::events::all(conn)? {
        items.push(Item { link: format!("{LINK_PREFIX}event/{}", e.id), title: e.title, date: e.date, notes: e.notes });
    }
    Ok(items)
}

/// What to change so the calendar matches `desired`. Only events with a Murre link are ever updated or removed:
/// anything the person added to the Murre calendar themselves is left alone. Items outside `from..=to` (dates as
/// `YYYY-MM-DD`) are skipped, because the calendar is only read within that range.
pub fn plan(desired: &[Item], existing: &[Existing], from: &str, to: &str) -> Plan {
    let mut out = Plan::default();
    let mut by_link: HashMap<&str, Vec<&Existing>> = HashMap::new();
    for e in existing {
        if let Some(l) = e.link.as_deref().filter(|l| l.starts_with(LINK_PREFIX)) {
            by_link.entry(l).or_default().push(e);
        }
    }
    let mut wanted = HashSet::new();
    for item in desired {
        if item.date.as_str() < from || item.date.as_str() > to || !wanted.insert(item.link.as_str()) {
            continue;
        }
        match by_link.get(item.link.as_str()).and_then(|v| v.first()) {
            None => out.create.push(item.clone()),
            Some(e) => {
                if e.title != item.title || e.date != item.date || e.notes != item.notes {
                    out.update.push((e.id.clone(), item.clone()));
                }
            }
        }
    }
    for (link, events) in &by_link {
        // Not wanted any more: all of them go. Wanted: any copies beyond the first go (a crash mid-save, say).
        let keep = usize::from(wanted.contains(link));
        out.remove.extend(events.iter().skip(keep).map(|e| e.id.clone()));
    }
    out.remove.sort();
    out
}

/// What the last sync did, for Settings.
#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub at: u64,
    pub created: usize,
    pub updated: usize,
    pub removed: usize,
    pub error: Option<String>,
}

/// What Settings shows.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// Calendar sync exists on this system (macOS).
    pub supported: bool,
    pub enabled: bool,
    /// `full`, `notDetermined`, `denied`, `restricted`, `writeOnly` or `unsupported`.
    pub access: String,
    pub last: Option<Report>,
}

/// The background worker: syncs soon after Murre's data changes, and every so often anyway.
pub struct CalendarSync {
    tx: Mutex<Sender<()>>,
    last: Arc<Mutex<Option<Report>>>,
}

impl CalendarSync {
    /// `run` does one sync and says what happened, or `None` when there was nothing to do (sync off, no access).
    pub fn start(run: impl Fn() -> Option<Report> + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel::<()>();
        let last = Arc::new(Mutex::new(None));
        let last_w = last.clone();
        let _ = std::thread::Builder::new().name("calendar-sync".into()).spawn(move || {
            // Let the app finish starting before the first look.
            std::thread::sleep(Duration::from_secs(5));
            loop {
                if let Some(r) = run() {
                    *last_w.lock().unwrap_or_else(|e| e.into_inner()) = Some(r);
                }
                match rx.recv_timeout(EVERY) {
                    Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                // Gather a burst of changes into one sync.
                while rx.recv_timeout(SETTLE).is_ok() {}
            }
        });
        CalendarSync { tx: Mutex::new(tx), last }
    }

    /// Murre's deadlines or events changed: bring the calendar up to date shortly.
    pub fn nudge(&self) {
        let _ = self.tx.lock().unwrap_or_else(|e| e.into_inner()).send(());
    }

    pub fn last(&self) -> Option<Report> {
        self.last.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(link: &str, date: &str) -> Item {
        Item { link: format!("{LINK_PREFIX}{link}"), title: format!("T {link}"), date: date.into(), notes: None }
    }
    fn found(id: &str, link: Option<&str>, date: &str, title: &str) -> Existing {
        Existing {
            id: id.into(),
            link: link.map(|l| format!("{LINK_PREFIX}{l}")),
            title: title.into(),
            date: date.into(),
            notes: None,
        }
    }

    #[test]
    fn creates_updates_and_removes_only_murres_own_events() {
        let desired = vec![item("deadline/a", "2026-12-01"), item("event/b", "2026-12-02"), item("deadline/c", "2026-12-03")];
        let existing = vec![
            found("1", Some("deadline/a"), "2026-12-01", "T deadline/a"), // unchanged
            found("2", Some("event/b"), "2026-11-30", "T event/b"),       // moved
            found("3", Some("deadline/gone"), "2026-12-05", "Old"),       // project removed
            found("4", None, "2026-12-01", "Lunch with Sam"),             // the person's own event: never touched
            Existing { link: Some("https://example.com".into()), ..found("5", None, "2026-12-01", "x") }, // not a Murre link: never touched
        ];
        let p = plan(&desired, &existing, "2025-11-06", "2029-11-06");
        assert_eq!(p.create, vec![item("deadline/c", "2026-12-03")]);
        assert_eq!(p.update, vec![("2".to_string(), item("event/b", "2026-12-02"))]);
        assert_eq!(p.remove, vec!["3".to_string()]);
    }

    #[test]
    fn nothing_to_do_when_it_already_matches() {
        let desired = vec![item("deadline/a", "2026-12-01")];
        let existing = vec![found("1", Some("deadline/a"), "2026-12-01", "T deadline/a")];
        assert_eq!(plan(&desired, &existing, "2025-01-01", "2030-01-01"), Plan::default());
    }

    #[test]
    fn duplicates_are_cleaned_up_and_dates_outside_the_range_are_skipped() {
        let desired = vec![item("deadline/a", "2026-12-01"), item("deadline/old", "2019-01-01"), item("deadline/a", "2026-12-01")];
        let existing = vec![
            found("1", Some("deadline/a"), "2026-12-01", "T deadline/a"),
            found("2", Some("deadline/a"), "2026-12-01", "T deadline/a"),
        ];
        let p = plan(&desired, &existing, "2025-01-01", "2030-01-01");
        assert!(p.create.is_empty() && p.update.is_empty(), "{p:?}");
        assert_eq!(p.remove, vec!["2".to_string()]);
    }

    #[test]
    fn deadlines_and_events_come_from_murres_data() {
        let d = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&d.path().join("a.db")).unwrap();
        crate::events::add(&conn, &crate::events::EventInput { title: "Client call".into(), date: "2026-12-10".into(), notes: None }).unwrap();
        let items = desired(&conn).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].link.starts_with("murre://event/"));
        assert_eq!((items[0].title.as_str(), items[0].date.as_str()), ("Client call", "2026-12-10"));
    }

    #[test]
    fn settings_round_trip_and_default_to_off() {
        let d = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&d.path().join("a.db")).unwrap();
        assert_eq!(read_settings(&conn).unwrap(), Settings::default());
        let s = Settings { enabled: true, calendar_id: Some("ABC".into()) };
        write_settings(&conn, &s).unwrap();
        assert_eq!(read_settings(&conn).unwrap(), s);
    }
}
