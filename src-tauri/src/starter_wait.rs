//! Waiting for After Effects while Murre makes a project's first `.aep` ("Open After Effects and start").
//!
//! After Effects can stop at a dialog when it starts (a missing disk-cache drive, a crash notice, a licence box), and
//! nothing can run inside it until the person answers. So there is no fixed time limit while After Effects is open:
//! Murre says what it is waiting for, says when After Effects probably needs an answer, and stops only when the
//! person cancels or After Effects is gone (then it asks them to open After Effects themselves).
//!
//! The rules are plain functions so they can be tested; `lib.rs` runs the loop and talks to After Effects.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// After this long without the Companion, After Effects is probably showing something.
pub const HINT_AFTER: Duration = Duration::from_secs(15);
/// After this long with After Effects open but no Companion, the Companion may be missing.
pub const NO_COMPANION_AFTER: Duration = Duration::from_secs(90);
/// After Effects that was launched but never appears in this long didn't start.
pub const NOT_STARTED_AFTER: Duration = Duration::from_secs(30);
/// A create that hasn't answered in this long is probably behind a dialog too.
pub const CREATE_SLOW_AFTER: Duration = Duration::from_secs(8);

/// Why Murre asks the person to open After Effects themselves.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// macOS couldn't start it, or no install was found.
    LaunchFailed,
    /// It was started but never appeared.
    NotStarted,
    /// It quit or crashed while Murre was waiting.
    Closed,
}

/// What the screen shows. Sent to the app as the `starter-progress` event.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum Stage {
    /// After Effects is starting.
    Launching,
    /// After Effects is open, waiting for the Companion.
    Waiting,
    /// Waiting long enough that After Effects is probably showing a message.
    NeedsYou,
    /// After Effects is open but the Companion still hasn't connected.
    NoCompanion,
    /// Murre stopped trying: open After Effects yourself, then say so.
    OpenYourself { reason: Reason },
    /// Looking at what is open in After Effects before closing anything.
    Checking,
    /// Something is open in After Effects: may Murre save and close it?
    Confirm {
        /// `unsaved`, `saved` or `unknown`.
        kind: String,
        name: String,
        #[serde(rename = "desktopDir")]
        desktop_dir: Option<String>,
    },
    /// After Effects is making the file.
    Creating { file: String },
    /// It hasn't answered for a while: probably a dialog.
    CreatingSlow { file: String },
}

/// What to do while waiting for the Companion to connect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wait {
    Show(Stage),
    Ask(Reason),
}

/// `elapsed`: since Murre launched After Effects (or started waiting). `launched`: Murre started it this time.
/// `seen_running`: After Effects has been seen running since then. `running`: it is running now.
pub fn connect_wait(elapsed: Duration, launched: bool, seen_running: bool, running: bool) -> Wait {
    if seen_running && !running {
        return Wait::Ask(Reason::Closed);
    }
    if !running {
        // Not there (yet). Only something Murre launched is worth waiting for; otherwise ask straight away.
        return if launched && elapsed < NOT_STARTED_AFTER { Wait::Show(Stage::Launching) } else { Wait::Ask(Reason::NotStarted) };
    }
    if elapsed < HINT_AFTER {
        Wait::Show(Stage::Waiting)
    } else if elapsed < NO_COMPANION_AFTER {
        Wait::Show(Stage::NeedsYou)
    } else {
        Wait::Show(Stage::NoCompanion)
    }
}

pub fn create_wait(elapsed: Duration, file: &str) -> Stage {
    if elapsed < CREATE_SLOW_AFTER {
        Stage::Creating { file: file.to_string() }
    } else {
        Stage::CreatingSlow { file: file.to_string() }
    }
}

/// Buttons the person can press while Murre waits.
#[derive(Default)]
pub struct Control {
    active: AtomicBool,
    cancel: AtomicBool,
    opened: AtomicBool,
    answer: Mutex<Option<bool>>,
}

/// Held while one create is running; lets the next one start when dropped.
pub struct Running<'a>(&'a Control);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.active.store(false, Ordering::SeqCst);
    }
}

impl Control {
    /// Start a create, or `None` if one is already running.
    pub fn begin(&self) -> Option<Running<'_>> {
        if self.active.swap(true, Ordering::SeqCst) {
            return None;
        }
        self.cancel.store(false, Ordering::SeqCst);
        self.opened.store(false, Ordering::SeqCst);
        *self.answer.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Some(Running(self))
    }
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
    /// "I've opened After Effects".
    pub fn opened(&self) {
        self.opened.store(true, Ordering::SeqCst);
    }
    /// True once after the person pressed "I've opened After Effects".
    pub fn take_opened(&self) -> bool {
        self.opened.swap(false, Ordering::SeqCst)
    }
    pub fn answer(&self, ok: bool) {
        *self.answer.lock().unwrap_or_else(|e| e.into_inner()) = Some(ok);
    }
    pub fn take_answer(&self) -> Option<bool> {
        self.answer.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: fn(u64) -> Duration = Duration::from_secs;

    #[test]
    fn a_launched_after_effects_gets_time_to_start_then_a_hint() {
        assert_eq!(connect_wait(S(2), true, false, false), Wait::Show(Stage::Launching));
        assert_eq!(connect_wait(S(5), true, true, true), Wait::Show(Stage::Waiting));
        assert_eq!(connect_wait(S(20), true, true, true), Wait::Show(Stage::NeedsYou));
        // No time limit while it is open: a dialog may be waiting for the person.
        assert_eq!(connect_wait(S(60 * 60), true, true, true), Wait::Show(Stage::NoCompanion));
    }

    #[test]
    fn asks_to_open_it_by_hand_when_it_never_starts_or_goes_away() {
        assert_eq!(connect_wait(S(31), true, false, false), Wait::Ask(Reason::NotStarted));
        assert_eq!(connect_wait(S(40), true, true, false), Wait::Ask(Reason::Closed));
        // Murre didn't start it (the person said they opened it): if it isn't there, ask again at once.
        assert_eq!(connect_wait(S(1), false, false, false), Wait::Ask(Reason::NotStarted));
    }

    #[test]
    fn a_slow_create_says_after_effects_may_need_an_answer() {
        assert_eq!(create_wait(S(2), "a.aep"), Stage::Creating { file: "a.aep".into() });
        assert_eq!(create_wait(S(9), "a.aep"), Stage::CreatingSlow { file: "a.aep".into() });
    }

    #[test]
    fn only_one_create_at_a_time_and_buttons_reset_for_the_next() {
        let c = Control::default();
        let first = c.begin().unwrap();
        assert!(c.begin().is_none());
        c.cancel();
        c.opened();
        c.answer(true);
        assert!(c.cancelled() && c.take_opened() && !c.take_opened());
        assert_eq!(c.take_answer(), Some(true));
        drop(first);
        c.cancel();
        let _second = c.begin().unwrap();
        assert!(!c.cancelled(), "a new create starts fresh");
    }

    #[test]
    fn stages_reach_the_app_in_a_simple_shape() {
        let v = serde_json::to_value(Stage::OpenYourself { reason: Reason::Closed }).unwrap();
        assert_eq!(v, serde_json::json!({ "stage": "openYourself", "reason": "closed" }));
        let v = serde_json::to_value(Stage::Confirm { kind: "saved".into(), name: "A".into(), desktop_dir: None }).unwrap();
        assert_eq!(v, serde_json::json!({ "stage": "confirm", "kind": "saved", "name": "A", "desktopDir": null }));
    }
}
