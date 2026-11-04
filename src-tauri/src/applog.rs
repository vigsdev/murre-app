//! The app's own log, and the report a person can copy from Settings when something goes wrong.
//!
//! The log is a few small files in the app's data folder (`logs/`), rotated so they never grow large. Nothing is sent
//! anywhere. The report is the end of that log plus the app and macOS versions, with file paths removed: a path holds a
//! user name and often a client or project name, so what is written to the log describes files by extension and size only
//! (see [`describe_file`]), and the report removes anything that still looks like a path as a second line of defence.
//!
//! Logging never fails the app: every error here is ignored.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// A log file is rotated when it grows past this.
const MAX_BYTES: u64 = 1_000_000;
/// The log file plus this many older ones are kept.
const OLDER_FILES: usize = 4;
/// Lines of recent log in a report.
const REPORT_LINES: usize = 300;

pub struct Logger {
    dir: PathBuf,
    file: Mutex<Option<File>>,
}

impl Logger {
    pub fn new(dir: &Path) -> Logger {
        let _ = fs::create_dir_all(dir);
        Logger { dir: dir.to_path_buf(), file: Mutex::new(None) }
    }

    fn path(&self, n: usize) -> PathBuf {
        self.dir.join(if n == 0 { "murre.log".to_string() } else { format!("murre.{n}.log") })
    }

    fn rotate(&self) {
        let _ = fs::remove_file(self.path(OLDER_FILES));
        for n in (0..OLDER_FILES).rev() {
            let _ = fs::rename(self.path(n), self.path(n + 1));
        }
    }

    pub fn write(&self, level: &str, area: &str, message: &str) {
        let line = format!("{} {level:<5} {area} {}\n", iso_utc(now_secs()), message.replace(['\r', '\n'], " ⏎ "));
        let mut guard = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().and_then(|f| f.metadata().ok()).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
            *guard = None;
            self.rotate();
        }
        if guard.is_none() {
            *guard = OpenOptions::new().create(true).append(true).open(self.path(0)).ok();
        }
        if let Some(f) = guard.as_mut() {
            let _ = f.write_all(line.as_bytes());
        }
    }

    /// The last `max` lines, oldest first, across the log files.
    pub fn recent(&self, max: usize) -> Vec<String> {
        let mut lines: Vec<String> = Vec::new();
        for n in (0..=OLDER_FILES).rev() {
            if let Ok(f) = File::open(self.path(n)) {
                lines.extend(BufReader::new(f).lines().map_while(Result::ok));
            }
        }
        let skip = lines.len().saturating_sub(max);
        lines.split_off(skip)
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `2026-10-31T14:30:00Z` for Unix seconds (UTC).
pub fn iso_utc(secs: u64) -> String {
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Remove anything that looks like a file path (the home folder, `/Users/…`, `/Volumes/…`, `~/…`): from there to the end of the line.
pub fn redact(line: &str, home: Option<&str>) -> String {
    let mut s = line.to_string();
    if let Some(h) = home.filter(|h| h.len() > 1) {
        s = s.replace(h, "~");
    }
    let cut = ["/Users/", "/Volumes/", "~/", "/private/", "/Applications/"].iter().filter_map(|m| s.find(m)).min();
    match cut {
        Some(i) => format!("{}<path removed>", &s[..i]),
        None => s,
    }
}

/// How a file is described in the log instead of its name: its extension and size, or that it is not there.
pub fn describe_file(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|e| format!(".{}", e.to_ascii_lowercase()))
        .unwrap_or_else(|| "(no extension)".into());
    match fs::metadata(path) {
        Ok(m) if m.is_file() => format!("{ext} file, {}", human(m.len())),
        Ok(_) => format!("{ext} (a folder)"),
        Err(_) => format!("{ext} file, not found"),
    }
}

fn human(n: u64) -> String {
    match n {
        0..=999 => format!("{n} B"),
        1_000..=999_999 => format!("{} KB", n / 1_000),
        1_000_000..=999_999_999 => format!("{:.1} MB", n as f64 / 1e6),
        _ => format!("{:.2} GB", n as f64 / 1e9),
    }
}

// ---- the app's one logger ---------------------------------------------------------------------------------------

static LOGGER: OnceLock<Logger> = OnceLock::new();

/// Start logging into `dir` and record panics. Safe to call once at startup; later calls do nothing.
pub fn init(dir: &Path) {
    if LOGGER.set(Logger::new(dir)).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let text = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "a panic".into());
        let at = info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
        error("panic", &format!("{text}{at}"));
        previous(info);
    }));
}

pub fn info(area: &str, message: &str) {
    if let Some(l) = LOGGER.get() {
        l.write("INFO", area, message);
    }
}

pub fn warn(area: &str, message: &str) {
    if let Some(l) = LOGGER.get() {
        l.write("WARN", area, message);
    }
}

pub fn error(area: &str, message: &str) {
    if let Some(l) = LOGGER.get() {
        l.write("ERROR", area, message);
    }
}

fn macos_version() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".into())
}

/// The report to copy: versions, then the recent log, with paths removed.
pub fn report() -> String {
    let home = std::env::var("HOME").ok();
    let lines = LOGGER.get().map(|l| l.recent(REPORT_LINES)).unwrap_or_default();
    let mut out = format!(
        "Murre {} ({})\nmacOS {} · {}\nReport made {}\nFile paths and names are left out of this report.\n\n",
        env!("CARGO_PKG_VERSION"),
        if cfg!(debug_assertions) { "development build" } else { "release" },
        macos_version(),
        std::env::consts::ARCH,
        iso_utc(now_secs()),
    );
    if lines.is_empty() {
        out.push_str("(nothing has been logged yet)\n");
    }
    for l in lines {
        out.push_str(&redact(&l, home.as_deref()));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_lines_with_time_level_and_area_and_keeps_each_on_one_line() {
        let d = tempfile::tempdir().unwrap();
        let l = Logger::new(d.path());
        l.write("INFO", "app", "started");
        l.write("WARN", "premiere", "two\nlines");
        let r = l.recent(10);
        assert_eq!(r.len(), 2);
        assert!(r[0].ends_with("INFO  app started"), "{}", r[0]);
        assert!(r[1].ends_with("WARN  premiere two ⏎ lines"), "{}", r[1]);
        assert!(r[0].starts_with("20") && r[0].as_bytes()[10] == b'T');
    }

    #[test]
    fn rotates_and_keeps_only_a_few_files() {
        let d = tempfile::tempdir().unwrap();
        let l = Logger::new(d.path());
        let big = "x".repeat(200_000);
        for _ in 0..40 {
            l.write("INFO", "t", &big);
        }
        let files = fs::read_dir(d.path()).unwrap().count();
        assert!(files <= OLDER_FILES + 1 && files > 1, "{files} files");
        assert!(l.recent(1_000_000).len() <= 40);
        assert_eq!(l.recent(3).len(), 3);
    }

    #[test]
    fn dates_are_right() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso_utc(1_793_327_400), "2026-10-30T02:30:00Z");
    }

    #[test]
    fn paths_are_removed_from_a_report() {
        let h = Some("/Users/vignesh-20693");
        assert_eq!(redact("ERROR copy Could not open /Users/vignesh-20693/Desktop/Client X/a b.mp4: denied", h), "ERROR copy Could not open <path removed>");
        assert_eq!(redact("WARN x see /Volumes/Drive/Work/f.aep", None), "WARN x see <path removed>");
        assert_eq!(redact("INFO x copied 3 files, 1 not found", h), "INFO x copied 3 files, 1 not found");
        assert!(!redact("PANIC at /Users/vignesh-20693/.cargo/x.rs:1", h).contains("vignesh"));
    }

    #[test]
    fn files_are_described_without_their_names() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("Secret Client Film.MP4");
        fs::write(&f, vec![0u8; 2_500_000]).unwrap();
        assert_eq!(describe_file(&f.to_string_lossy()), ".mp4 file, 2.5 MB");
        assert_eq!(describe_file(&d.path().join("gone.mov").to_string_lossy()), ".mov file, not found");
        assert_eq!(describe_file("/x/noext"), "(no extension) file, not found");
        assert!(!describe_file(&f.to_string_lossy()).contains("Secret"));
    }
}
