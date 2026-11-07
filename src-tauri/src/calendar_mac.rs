//! Apple Calendar through EventKit (macOS only). See `calendar_sync` for what is synced and why.
//!
//! Every call makes its own `EKEventStore`, so nothing is shared between threads, and a store made after access was
//! granted always sees the calendars.

use crate::calendar_sync::{self, Existing, Item, Plan, CALENDAR_TITLE};
use crate::error::{AppError, AppResult};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObjectProtocol};
use objc2::sel;
use objc2_event_kit::{
    EKAuthorizationStatus, EKCalendar, EKEntityType, EKEvent, EKEventStore, EKSource, EKSourceType, EKSpan,
};
use objc2_foundation::{NSArray, NSDate, NSError, NSString, NSURL};
use std::sync::mpsc;
use std::time::Duration;

/// How long to wait for the person to answer macOS's "allow Calendar access?" question.
const ASK_FOR: Duration = Duration::from_secs(300);

pub fn access() -> &'static str {
    // SAFETY: a class method with no arguments besides a plain enum.
    let s = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) };
    match s {
        EKAuthorizationStatus::FullAccess => "full",
        EKAuthorizationStatus::WriteOnly => "writeOnly",
        EKAuthorizationStatus::Denied => "denied",
        EKAuthorizationStatus::Restricted => "restricted",
        _ => "notDetermined",
    }
}

fn err(prefix: &str, e: Retained<NSError>) -> AppError {
    AppError::Invalid(format!("{prefix}: {}", e.localizedDescription()))
}

/// Ask macOS for full Calendar access (macOS shows its own question the first time). Returns whether it was given.
pub fn request_access() -> bool {
    let store = unsafe { EKEventStore::new() };
    let (tx, rx) = mpsc::channel::<bool>();
    let block = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        let _ = tx.send(granted.as_bool());
    });
    // macOS 14 split calendar access into full and write-only; older systems only have the one request.
    let modern = store.respondsToSelector(sel!(requestFullAccessToEventsWithCompletion:));
    // SAFETY: the block lives until the completion handler has run (EventKit copies it).
    unsafe {
        if modern {
            store.requestFullAccessToEventsWithCompletion(RcBlock::as_ptr(&block));
        } else {
            #[allow(deprecated)]
            store.requestAccessToEntityType_completion(EKEntityType::Event, RcBlock::as_ptr(&block));
        }
    }
    rx.recv_timeout(ASK_FOR).unwrap_or(false)
}

/// Seconds since 1970 for local midnight of a `YYYY-MM-DD` date.
fn local_midnight(date: &str) -> Option<f64> {
    let mut parts = date.splitn(3, '-').map(|p| p.parse::<i32>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    // SAFETY: a zeroed `tm` is a valid starting value; mktime only reads and normalises it.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = y - 1900;
    tm.tm_mon = m - 1;
    tm.tm_mday = d;
    tm.tm_isdst = -1;
    let t = unsafe { libc::mktime(&mut tm) };
    (t != -1).then_some(t as f64)
}

/// The local `YYYY-MM-DD` of a moment.
fn local_date(secs: f64) -> String {
    let t = secs.floor() as libc::time_t;
    // SAFETY: localtime_r writes into the `tm` we own.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&t, &mut tm) };
    format!("{:04}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday)
}

fn date(date: &str) -> AppResult<Retained<NSDate>> {
    let secs = local_midnight(date).ok_or_else(|| AppError::Invalid(format!("{date} is not a date.")))?;
    Ok(NSDate::dateWithTimeIntervalSince1970(secs))
}

/// The range a sync reads and writes: a year back, three ahead (EventKit searches at most four years at once).
pub fn window() -> (String, String) {
    let now = NSDate::now().timeIntervalSince1970();
    let day = 86_400.0;
    (local_date(now - 365.0 * day), local_date(now + 3.0 * 365.0 * day))
}

/// Where to make the Murre calendar: the account of the default calendar (usually iCloud, so it reaches the iPhone),
/// else "On My Mac".
fn sources(store: &EKEventStore) -> Vec<Retained<EKSource>> {
    let mut out = Vec::new();
    // SAFETY: plain getters on a live store.
    unsafe {
        if let Some(s) = store.defaultCalendarForNewEvents().and_then(|c| c.source()) {
            out.push(s);
        }
        for s in store.sources().iter() {
            if s.sourceType() == EKSourceType::Local {
                out.push(s);
            }
        }
    }
    out
}

/// The Murre calendar, made if it doesn't exist (or was deleted in Calendar). Returns it and its identifier.
fn murre_calendar(store: &EKEventStore, known: Option<&str>) -> AppResult<(Retained<EKCalendar>, String)> {
    // SAFETY: plain EventKit calls on objects from this store.
    unsafe {
        if let Some(id) = known {
            if let Some(cal) = store.calendarWithIdentifier(&NSString::from_str(id)) {
                return Ok((cal, id.to_string()));
            }
        }
        let mut last = None;
        for source in sources(store) {
            let cal = EKCalendar::calendarForEntityType_eventStore(EKEntityType::Event, store);
            cal.setTitle(&NSString::from_str(CALENDAR_TITLE));
            cal.setSource(Some(&source));
            match store.saveCalendar_commit_error(&cal, true) {
                Ok(()) => {
                    let id = cal.calendarIdentifier().to_string();
                    return Ok((cal, id));
                }
                Err(e) => last = Some(err("Couldn’t make the Murre calendar", e)),
            }
        }
        Err(last.unwrap_or_else(|| AppError::Invalid("Couldn’t find a calendar account to put the Murre calendar in.".into())))
    }
}

fn read(event: &EKEvent) -> Option<Existing> {
    // SAFETY: plain getters on an event from this store.
    unsafe {
        Some(Existing {
            id: event.eventIdentifier()?.to_string(),
            link: event.URL().and_then(|u| u.absoluteString()).map(|s| s.to_string()),
            title: event.title().to_string(),
            date: local_date(event.startDate().timeIntervalSince1970()),
            notes: event.notes().map(|n| n.to_string()).filter(|n| !n.is_empty()),
        })
    }
}

fn fill(event: &EKEvent, cal: &EKCalendar, item: &Item) -> AppResult<()> {
    let day = date(&item.date)?;
    // SAFETY: plain setters on an event from this store.
    unsafe {
        event.setCalendar(Some(cal));
        event.setTitle(Some(&NSString::from_str(&item.title)));
        event.setNotes(item.notes.as_deref().map(NSString::from_str).as_deref());
        event.setAllDay(true);
        event.setStartDate(Some(&day));
        event.setEndDate(Some(&day));
        event.setURL(NSURL::URLWithString(&NSString::from_str(&item.link)).as_deref());
    }
    Ok(())
}

/// Bring the Murre calendar up to date with `desired`. Returns the calendar's identifier and the counts.
pub fn sync(known_calendar: Option<&str>, desired: &[Item]) -> AppResult<(String, calendar_sync::Report)> {
    if access() != "full" {
        return Err(AppError::Invalid("Murre isn’t allowed to use Calendar.".into()));
    }
    let store = unsafe { EKEventStore::new() };
    let (cal, cal_id) = murre_calendar(&store, known_calendar)?;
    let (from, to) = window();
    // SAFETY: plain EventKit calls on objects from this store.
    let existing: Vec<Existing> = unsafe {
        let one = NSArray::from_retained_slice(&[cal.clone()]);
        let (start, end) = (date(&from)?, date(&to)?);
        let pred = store.predicateForEventsWithStartDate_endDate_calendars(&start, &end, Some(&one));
        store.eventsMatchingPredicate(&pred).iter().filter_map(|e| read(&e)).collect()
    };
    let Plan { create, update, remove } = calendar_sync::plan(desired, &existing, &from, &to);
    let mut report = calendar_sync::Report { at: crate::project::now(), ..Default::default() };
    // SAFETY: plain EventKit calls on objects from this store; nothing is written until `commit`.
    unsafe {
        for item in &create {
            let ev = EKEvent::eventWithEventStore(&store);
            fill(&ev, &cal, item)?;
            store.saveEvent_span_commit_error(&ev, EKSpan::ThisEvent, false).map_err(|e| err("Couldn’t add an event", e))?;
            report.created += 1;
        }
        for (id, item) in &update {
            let Some(ev) = store.eventWithIdentifier(&NSString::from_str(id)) else { continue };
            fill(&ev, &cal, item)?;
            store.saveEvent_span_commit_error(&ev, EKSpan::ThisEvent, false).map_err(|e| err("Couldn’t change an event", e))?;
            report.updated += 1;
        }
        for id in &remove {
            let Some(ev) = store.eventWithIdentifier(&NSString::from_str(id)) else { continue };
            // Only ever an event in the Murre calendar with a Murre link: `plan` guarantees it, this checks again.
            let ours = ev.calendar().is_some_and(|c| c.calendarIdentifier().to_string() == cal_id)
                && ev.URL().and_then(|u| u.absoluteString()).is_some_and(|s| s.to_string().starts_with(calendar_sync::LINK_PREFIX));
            if !ours {
                continue;
            }
            store.removeEvent_span_commit_error(&ev, EKSpan::ThisEvent, false).map_err(|e| err("Couldn’t remove an event", e))?;
            report.removed += 1;
        }
        if report.created + report.updated + report.removed > 0 {
            store.commit().map_err(|e| err("Couldn’t save the changes to Calendar", e))?;
        }
    }
    Ok((cal_id, report))
}

/// Delete the Murre calendar and every event in it. Only the calendar Murre made (by its identifier) is touched.
pub fn remove_calendar(calendar_id: &str) -> AppResult<()> {
    let store = unsafe { EKEventStore::new() };
    // SAFETY: plain EventKit calls on objects from this store.
    unsafe {
        let Some(cal) = store.calendarWithIdentifier(&NSString::from_str(calendar_id)) else { return Ok(()) };
        if cal.title().to_string() != CALENDAR_TITLE {
            return Err(AppError::Invalid("That calendar isn’t the one Murre made, so it was left alone.".into()));
        }
        store.removeCalendar_commit_error(&cal, true).map_err(|e| err("Couldn’t remove the Murre calendar", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip_through_local_midnight() {
        for d in ["2026-01-01", "2026-03-29", "2026-10-25", "2026-12-31", "2028-02-29"] {
            assert_eq!(local_date(local_midnight(d).unwrap()), d);
        }
        assert!(local_midnight("nope").is_none());
    }

    #[test]
    fn the_window_is_a_year_back_and_three_ahead() {
        let (from, to) = window();
        assert!(from < to && from.len() == 10 && to.len() == 10);
    }
}
