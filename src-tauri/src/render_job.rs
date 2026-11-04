//! Running one `aerender` render: starting it without a shell, reading its output live,
//! keeping a log, estimating progress, and cancelling safely.
//!
//! What this does *not* assume: Adobe documents `-v ERRORS_AND_PROGRESS` but not the exact format
//! of the progress lines or the exit codes. Progress is therefore a best-effort estimate read from
//! lines that start with `PROGRESS:` and carry a frame number in parentheses; if no such lines
//! appear the render still runs and the last line of output is shown instead. Success means
//! "aerender exited with status 0 *and* the output file exists".
//!
//! Safety rules:
//! - One render at a time for the whole app.
//! - Nothing is ever deleted or moved: a cancelled or failed render may leave a partial file,
//!   and that file is reported, not removed.
//! - Logs are kept in the app data folder (never in the project) and capped in size and number.
//! - aerender runs in its own process group, so cancelling stops it and anything it started
//!   in that group. If After Effects was started some other way it may need to be quit by hand
//!   (the cancel message says so).

use crate::aerender::Plan;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_LINES: usize = 2000;
const MAX_LINE_BYTES: usize = 4000;
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const KEEP_LOGS: usize = 50;
const EMIT_EVERY: Duration = Duration::from_millis(150);

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: String,
    pub project_id: String,
    pub comp_name: String,
    pub output: String,
    /// `running`, `finished`, `failed` or `cancelled`.
    pub state: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub frame: Option<u64>,
    pub total_frames: u64,
    /// 0–1 estimate from the frame number in aerender's progress lines, if they were seen.
    pub percent: Option<f64>,
    pub last_line: Option<String>,
    /// Explanation for `failed` and `cancelled`.
    pub message: Option<String>,
    pub log_path: String,
    pub output_exists: bool,
    pub warnings: Vec<String>,
}

pub type Notify = Arc<dyn Fn(&JobSnapshot) + Send + Sync>;

#[derive(Default)]
struct Slot {
    job: Option<JobSnapshot>,
    lines: VecDeque<String>,
    pid: Option<u32>,
    cancel_requested: bool,
    log: Option<LogFile>,
    last_emit: Option<Instant>,
}

struct LogFile {
    file: fs::File,
    bytes: u64,
    capped: bool,
}

impl LogFile {
    fn write_line(&mut self, line: &str) {
        if self.capped {
            return;
        }
        let add = line.len() as u64 + 1;
        if self.bytes + add > MAX_LOG_BYTES {
            let _ = writeln!(self.file, "[log is full; further output is not saved here]");
            self.capped = true;
            return;
        }
        if writeln!(self.file, "{line}").is_ok() {
            self.bytes += add;
        }
    }
}

struct Inner {
    slot: Mutex<Slot>,
    notify: Notify,
    logs_dir: PathBuf,
    kill_grace: Duration,
}

#[derive(Clone)]
pub struct Runner {
    inner: Arc<Inner>,
}

/// After Effects takes the file format (and so the extension) from the output module, so the file it
/// writes can have a different extension than the one asked for (`Comp 1.mov` → `Comp 1.mp4`).
/// Returns the single file in the folder that has the same name apart from the extension and was
/// written since the render started.
fn written_with_other_extension(wanted: &Path, since: u64) -> Option<PathBuf> {
    let dir = wanted.parent()?;
    let stem = wanted.file_stem()?.to_string_lossy().to_lowercase();
    let mut hits = Vec::new();
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.file_stem().map(|n| n.to_string_lossy().to_lowercase()) != Some(stem.clone()) || !p.is_file() {
            continue;
        }
        let modified = e.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
        if modified + 2 >= since {
            hits.push(p);
        }
    }
    if hits.len() == 1 { hits.pop() } else { None }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `PROGRESS:  0:00:00:01 (2): 0 Seconds` → 2. Anything else → `None`.
pub fn parse_frame(line: &str) -> Option<u64> {
    let rest = line.trim_start().strip_prefix("PROGRESS:")?;
    let open = rest.rfind('(')?;
    let close = open + rest[open..].find(')')?;
    let inside = &rest[open + 1..close];
    if inside.is_empty() || !inside.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    inside.parse().ok()
}

fn clean(line: &str) -> String {
    line.chars().filter(|c| !c.is_control() || *c == '\t').collect::<String>().trim_end().to_string()
}

/// Quote an argument for *display* in the log only (the command itself never goes through a shell).
fn display_arg(a: &str) -> String {
    if a.is_empty() || a.chars().any(|c| c.is_whitespace() || "\"'\\$`".contains(c)) {
        format!("\"{}\"", a.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        a.to_string()
    }
}

/// Split a byte stream into lines on `\n` or `\r` (aerender may redraw progress with `\r`).
fn read_lines(mut src: impl Read, mut on_line: impl FnMut(String)) {
    let mut buf = [0u8; 4096];
    let mut cur: Vec<u8> = Vec::new();
    let flush = |cur: &mut Vec<u8>, on_line: &mut dyn FnMut(String)| {
        if !cur.is_empty() {
            on_line(clean(&String::from_utf8_lossy(cur)));
            cur.clear();
        }
    };
    loop {
        match src.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for &b in &buf[..n] {
                    if b == b'\n' || b == b'\r' {
                        flush(&mut cur, &mut on_line);
                    } else if cur.len() < MAX_LINE_BYTES {
                        cur.push(b);
                    }
                }
            }
        }
    }
    flush(&mut cur, &mut on_line);
}

impl Runner {
    pub fn new(logs_dir: PathBuf, notify: Notify) -> Runner {
        Runner::with_grace(logs_dir, notify, Duration::from_secs(10))
    }

    fn with_grace(logs_dir: PathBuf, notify: Notify, kill_grace: Duration) -> Runner {
        Runner { inner: Arc::new(Inner { slot: Mutex::new(Slot::default()), notify, logs_dir, kill_grace }) }
    }

    /// The running job, or the most recent one that ended.
    pub fn current(&self) -> Option<JobSnapshot> {
        self.inner.slot.lock().unwrap_or_else(|e| e.into_inner()).job.clone()
    }

    /// The last `n` lines of output of the current/most recent job.
    pub fn log_tail(&self, n: usize) -> Vec<String> {
        let s = self.inner.slot.lock().unwrap_or_else(|e| e.into_inner());
        let skip = s.lines.len().saturating_sub(n);
        s.lines.iter().skip(skip).cloned().collect()
    }

    fn update(&self, force: bool, f: impl FnOnce(&mut Slot)) {
        let snapshot = {
            let mut s = self.inner.slot.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut s);
            let due = force || s.last_emit.map(|t| t.elapsed() >= EMIT_EVERY).unwrap_or(true);
            if due { s.last_emit = Some(Instant::now()) }
            if due { s.job.clone() } else { None }
        };
        if let Some(j) = snapshot {
            (self.inner.notify)(&j);
        }
    }

    /// Start aerender with the planned arguments. Fails (and changes nothing) if a render is
    /// already running, the log cannot be created, or aerender cannot be started.
    pub fn start(&self, aerender: &Path, plan: &Plan, project_id: &str) -> AppResult<JobSnapshot> {
        let id: String = uuid::Uuid::new_v4().simple().to_string().chars().take(8).collect();
        let started = now();
        {
            let s = self.inner.slot.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(j) = s.job.as_ref().filter(|j| j.state == "running") {
                return Err(AppError::Invalid(format!(
                    "“{}” is already rendering. Let it finish or cancel it first.",
                    j.comp_name
                )));
            }
        }
        fs::create_dir_all(&self.inner.logs_dir).map_err(|e| AppError::io(&self.inner.logs_dir, e))?;
        let log_path = self.inner.logs_dir.join(format!("render-{started}-{id}.log"));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&log_path)
            .map_err(|e| AppError::io(&log_path, e))?;
        let cmd_line = std::iter::once(display_arg(&aerender.to_string_lossy()))
            .chain(plan.args.iter().map(|a| display_arg(a)))
            .collect::<Vec<_>>()
            .join(" ");
        let _ = writeln!(file, "Murre render log\nStarted (unix time): {started}\nCommand: {cmd_line}\n");

        let mut cmd = Command::new(aerender);
        cmd.args(&plan.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| {
            let _ = fs::remove_file(&log_path); // our own empty log, nothing of the user's
            AppError::io(aerender, e)
        })?;

        let job = JobSnapshot {
            id,
            project_id: project_id.to_string(),
            comp_name: plan.comp_name.clone(),
            output: plan.output.to_string_lossy().into_owned(),
            state: "running".into(),
            started_at: started,
            ended_at: None,
            exit_code: None,
            frame: None,
            total_frames: plan.total_frames,
            percent: None,
            last_line: None,
            message: None,
            log_path: log_path.to_string_lossy().into_owned(),
            output_exists: false,
            warnings: plan.warnings.clone(),
        };
        {
            let mut s = self.inner.slot.lock().unwrap_or_else(|e| e.into_inner());
            *s = Slot {
                job: Some(job.clone()),
                pid: Some(child.id()),
                log: Some(LogFile { file, bytes: 0, capped: false }),
                ..Default::default()
            };
        }
        (self.inner.notify)(&job);

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let runner = self.clone();
        let output = plan.output.clone();
        thread::Builder::new()
            .name("render-wait".into())
            .spawn(move || {
                let readers: Vec<_> = [stdout.map(|s| Box::new(s) as Box<dyn Read + Send>), stderr.map(|s| Box::new(s) as Box<dyn Read + Send>)]
                    .into_iter()
                    .flatten()
                    .map(|src| {
                        let r = runner.clone();
                        thread::spawn(move || read_lines(src, |line| r.on_line(line)))
                    })
                    .collect();
                let status = child.wait();
                for h in readers {
                    let _ = h.join();
                }
                runner.finish(status, &output);
            })
            .map_err(|e| AppError::io(&log_path, e))?;
        Ok(job)
    }

    fn on_line(&self, line: String) {
        if line.is_empty() {
            return;
        }
        self.update(false, |s| {
            if let Some(log) = s.log.as_mut() {
                log.write_line(&line);
            }
            if s.lines.len() >= MAX_LINES {
                s.lines.pop_front();
            }
            s.lines.push_back(line.clone());
            if let Some(j) = s.job.as_mut() {
                if let Some(frame) = parse_frame(&line) {
                    j.frame = Some(frame);
                    j.percent = Some((frame as f64 / j.total_frames.max(1) as f64).clamp(0.0, 1.0));
                }
                j.last_line = Some(line);
            }
        });
    }

    fn finish(&self, status: std::io::Result<std::process::ExitStatus>, output: &Path) {
        let mut output_exists = output.symlink_metadata().is_ok();
        let mut actual: Option<PathBuf> = None;
        if !output_exists && status.as_ref().map(|s| s.success()).unwrap_or(false) {
            let since = self.current().map(|j| j.started_at).unwrap_or(0);
            if let Some(p) = written_with_other_extension(output, since) {
                output_exists = true;
                actual = Some(p);
            }
        }
        let code = status.as_ref().ok().and_then(|s| s.code());
        let success = status.as_ref().map(|s| s.success()).unwrap_or(false);
        self.update(true, |s| {
            let cancelled = s.cancel_requested;
            let explicit_error = s
                .lines
                .iter()
                .rev()
                .find(|l| l.to_ascii_lowercase().contains("error"))
                .cloned();
            let error_line = s
                .lines
                .iter()
                .rev()
                .find(|l| l.to_ascii_lowercase().contains("error"))
                .or_else(|| s.lines.back())
                .cloned();
            let Some(j) = s.job.as_mut() else { return };
            j.ended_at = Some(now());
            j.exit_code = code;
            j.output_exists = output_exists;
            let (state, message) = if cancelled {
                let partial = if output_exists {
                    format!(" A partly written file may remain at {} (it was not deleted).", j.output)
                } else {
                    String::new()
                };
                ("cancelled", Some(format!(
                    "Cancelled.{partial} If After Effects is still busy rendering, quit it from the Dock or Activity Monitor."
                )))
            } else if success && output_exists {
                j.percent = Some(1.0);
                let note = actual.as_ref().map(|p| {
                    j.output = p.to_string_lossy().into_owned();
                    format!(
                        "After Effects saved it as {} because the output module decides the format.",
                        p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
                    )
                });
                ("finished", note)
            } else if success {
                // aerender can exit with 0 after printing an error (for example a project saved by a
                // newer After Effects), so show what it said instead of a vague message.
                let said = explicit_error.map(|l| format!(" It reported: {l}")).unwrap_or_default();
                let hint = if said.contains("cannot be opened with this version") {
                    " Choose a newer After Effects for this render (or in Settings)."
                } else {
                    ""
                };
                ("failed", Some(format!(
                    "aerender finished but no file appeared at {}.{said}{hint} Check the log.",
                    j.output
                )))
            } else {
                let how = match code {
                    Some(c) => format!("aerender stopped with exit code {c}."),
                    None => "aerender was stopped by the system.".to_string(),
                };
                let detail = error_line.map(|l| format!(" Last message: {l}")).unwrap_or_default();
                ("failed", Some(format!("{how}{detail}")))
            };
            j.state = state.into();
            j.message = message;
            let footer = format!("\n[{}] exit code: {}", state, code.map(|c| c.to_string()).unwrap_or_else(|| "none".into()));
            if let Some(log) = s.log.as_mut() {
                log.write_line(&footer);
            }
            s.log = None;
            s.pid = None;
        });
        if let Some(j) = self.current() {
            let how = if j.state == "finished" { "INFO" } else { "WARN" };
            let msg = format!("Render {} (exit code {})", j.state, j.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "none".into()));
            if how == "INFO" { crate::applog::info("render", &msg) } else { crate::applog::warn("render", &msg) }
        }
        prune_logs(&self.inner.logs_dir, KEEP_LOGS);
    }

    /// Forget the finished, failed or cancelled job (its card in the app), so the panel starts clean. Nothing on disk is touched:
    /// the rendered file and the log file stay where they are. A render that is still running cannot be cleared.
    pub fn clear(&self) -> AppResult<()> {
        let mut s = self.inner.slot.lock().unwrap_or_else(|e| e.into_inner());
        if s.job.as_ref().map(|j| j.state == "running").unwrap_or(false) {
            return Err(AppError::Invalid("A render is still running. Cancel it first.".into()));
        }
        s.job = None;
        s.lines.clear();
        s.cancel_requested = false;
        Ok(())
    }

    /// Ask the running render to stop. Returns at once; the job turns `cancelled` when aerender has exited.
    pub fn cancel(&self) -> AppResult<()> {
        let pid = {
            let mut s = self.inner.slot.lock().unwrap_or_else(|e| e.into_inner());
            match (s.job.as_ref().map(|j| j.state.as_str()), s.pid) {
                (Some("running"), Some(pid)) => {
                    s.cancel_requested = true;
                    pid
                }
                _ => return Err(AppError::Invalid("No render running. Nothing to stop.".into())),
            }
        };
        terminate(pid, false);
        let runner = self.clone();
        let grace = self.inner.kill_grace;
        thread::spawn(move || {
            let start = Instant::now();
            while start.elapsed() < grace {
                thread::sleep(Duration::from_millis(100));
                if runner.current().map(|j| j.state != "running").unwrap_or(true) {
                    return;
                }
            }
            terminate(pid, true);
        });
        Ok(())
    }
}

/// Stop aerender and what it started in its process group: politely first, forcefully after the grace period.
fn terminate(pid: u32, force: bool) {
    #[cfg(unix)]
    {
        let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
        // SAFETY: plain signal to a process group we created with `process_group(0)`.
        unsafe {
            libc::killpg(pid as libc::pid_t, sig);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T"]).args(if force { vec!["/F"] } else { vec![] }).status();
    }
}

/// Keep the newest `keep` of our own `render-*.log` files; older ones are removed.
fn prune_logs(dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut logs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("render-") && n.ends_with(".log"))
                .unwrap_or(false)
        })
        .collect();
    // Names start with the start time in seconds, so a numeric-aware sort is chronological.
    logs.sort_by_key(|p| {
        let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        n.trim_start_matches("render-").split('-').next().and_then(|t| t.parse::<u64>().ok()).unwrap_or(0)
    });
    let excess = logs.len().saturating_sub(keep);
    for old in logs.into_iter().take(excess) {
        let _ = fs::remove_file(old);
    }
}

// Silence an unused-import warning on platforms where `Child` is not otherwise named.
#[allow(dead_code)]
fn _assert_types(_: Option<Child>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_numbers_are_read_only_from_progress_lines() {
        assert_eq!(parse_frame("PROGRESS:  0:00:00:01 (2): 0 Seconds"), Some(2));
        assert_eq!(parse_frame("  PROGRESS: 0:00:09:12 (237): 1 Seconds"), Some(237));
        for no in ["", "PROGRESS: Start: 12:00", "PROGRESS: x (a)", "PROGRESS: ()", "aerender Error: (5)", "Frame (3)", "PROGRESS:  Total Time Elapsed: 5 Seconds"] {
            assert_eq!(parse_frame(no), None, "{no}");
        }
    }

    #[test]
    fn lines_split_on_newline_and_carriage_return_and_are_cleaned() {
        let mut got = Vec::new();
        read_lines(&b"one\ntwo\rthree\r\nfour\x1b[0m\n\n\xff bad\nlast"[..], |l| got.push(l));
        assert_eq!(got, ["one", "two", "three", "four[0m", "\u{fffd} bad", "last"]);
        let long = vec![b'a'; MAX_LINE_BYTES * 3];
        let mut got = Vec::new();
        read_lines(&long[..], |l| got.push(l));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].len(), MAX_LINE_BYTES);
    }

    #[test]
    fn display_quoting_is_only_for_the_log() {
        assert_eq!(display_arg("a"), "a");
        assert_eq!(display_arg("a b"), "\"a b\"");
        assert_eq!(display_arg("a\"b"), "\"a\\\"b\"");
        assert_eq!(display_arg(""), "\"\"");
    }

    #[test]
    fn old_logs_are_pruned_by_start_time_and_other_files_are_left_alone() {
        let d = tempfile::tempdir().unwrap();
        for t in [5u64, 100, 20, 1000, 30] {
            fs::write(d.path().join(format!("render-{t}-abcd1234.log")), "x").unwrap();
        }
        fs::write(d.path().join("notes.txt"), "mine").unwrap();
        fs::write(d.path().join("render-9-x.txt"), "mine").unwrap();
        prune_logs(d.path(), 3);
        let mut left: Vec<_> = fs::read_dir(d.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["notes.txt", "render-100-abcd1234.log", "render-1000-abcd1234.log", "render-30-abcd1234.log", "render-9-x.txt"]);
    }

    #[test]
    fn log_file_stops_at_its_cap() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("l.log");
        let mut l = LogFile { file: fs::File::create(&p).unwrap(), bytes: MAX_LOG_BYTES - 10, capped: false };
        l.write_line("short");
        l.write_line(&"x".repeat(50));
        l.write_line("after");
        let text = fs::read_to_string(&p).unwrap();
        assert!(text.contains("short") && text.contains("log is full") && !text.contains("after"));
    }

    #[cfg(unix)]
    mod process {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        struct Env {
            dir: tempfile::TempDir,
            runner: Runner,
            events: Arc<Mutex<Vec<JobSnapshot>>>,
        }

        fn env(grace: Duration) -> Env {
            let dir = tempfile::tempdir().unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink = events.clone();
            let runner = Runner::with_grace(dir.path().join("logs"), Arc::new(move |j: &JobSnapshot| sink.lock().unwrap().push(j.clone())), grace);
            Env { dir, runner, events }
        }

        fn script(dir: &Path, body: &str) -> PathBuf {
            let p = dir.join("aerender");
            fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
            p
        }

        fn plan(dir: &Path) -> Plan {
            let output = dir.join("out.mov");
            Plan {
                aep: dir.join("a.aep"),
                comp_id: 1,
                comp_name: "Main".into(),
                output: output.clone(),
                args: vec!["-project".into(), "a.aep".into(), "-comp".into(), "Main".into(), "-output".into(), output.to_string_lossy().into_owned()],
                warnings: vec![],
                total_frames: 4,
            }
        }

        const FIND_OUT: &str = r#"while [ $# -gt 0 ]; do case "$1" in -output) out="$2";; esac; shift; done"#;

        fn wait_done(r: &Runner) -> JobSnapshot {
            for _ in 0..400 {
                if let Some(j) = r.current() {
                    if j.state != "running" {
                        return j;
                    }
                }
                thread::sleep(Duration::from_millis(25));
            }
            panic!("render did not end");
        }

        /// Running, not merely a zombie that nobody has collected yet.
        fn alive(pid: i32) -> bool {
            // SAFETY: signal 0 only checks that the process exists.
            if unsafe { libc::kill(pid, 0) } != 0 {
                return false;
            }
            match fs::read_to_string(format!("/proc/{pid}/stat")) {
                Ok(stat) => stat.rsplit(") ").next().map(|r| !r.starts_with('Z')).unwrap_or(true),
                Err(_) => true, // no /proc (macOS): the signal check is all we have
            }
        }

        #[test]
        fn a_file_saved_with_another_extension_counts_as_finished() {
            let e = env(Duration::from_secs(5));
            // asked for .mov, the output module writes .mp4
            let a = script(e.dir.path(), &format!("{FIND_OUT}\necho 'PROGRESS:  0:00:00:01 (2): 0 Seconds'\necho data > \"${{out%.*}}.mp4\""));
            let plan = plan(e.dir.path());
            e.runner.start(&a, &plan, "p1").unwrap();
            let done = wait_done(&e.runner);
            assert_eq!(done.state, "finished", "{done:?}");
            assert!(done.output_exists);
            assert!(done.output.ends_with(".mp4"), "{}", done.output);
            assert!(done.message.unwrap().contains("saved it as"));
        }

        #[test]
        fn exit_zero_with_an_error_and_no_file_shows_what_aerender_said() {
            let e = env(Duration::from_secs(5));
            let a = script(e.dir.path(), "echo 'aerender Error: After Effects error: The file you are attempting to open was created with After Effects version 27.1x23 and cannot be opened with this version.'\necho 'aerender version 26.5x89'");
            let plan = plan(e.dir.path());
            e.runner.start(&a, &plan, "p1").unwrap();
            let done = wait_done(&e.runner);
            assert_eq!(done.state, "failed");
            let m = done.message.unwrap();
            assert!(m.contains("It reported: aerender Error: After Effects error") && m.contains("Choose a newer After Effects"), "{m}");
        }

        #[test]
        fn a_successful_render_reports_progress_and_the_finished_file() {
            let e = env(Duration::from_secs(5));
            let a = script(e.dir.path(), &format!("{FIND_OUT}\necho 'PROGRESS:  Start: now'\necho 'PROGRESS:  0:00:00:00 (1): 0 Seconds'\necho 'PROGRESS:  0:00:00:01 (2): 0 Seconds'\necho warn-on-stderr >&2\necho 'PROGRESS:  0:00:00:03 (4): 0 Seconds'\necho data > \"$out\""));
            let plan = plan(e.dir.path());
            let started = e.runner.start(&a, &plan, "p1").unwrap();
            assert_eq!(started.state, "running");
            let done = wait_done(&e.runner);
            assert_eq!(done.state, "finished", "{done:?}");
            assert_eq!(done.exit_code, Some(0));
            assert!(done.output_exists);
            assert_eq!(done.frame, Some(4));
            assert_eq!(done.percent, Some(1.0));
            assert_eq!(done.project_id, "p1");
            let log = fs::read_to_string(&done.log_path).unwrap();
            assert!(log.contains("Command:") && log.contains("-comp Main") && log.contains("warn-on-stderr") && log.contains("[finished] exit code: 0"));
            assert!(e.runner.log_tail(2).len() == 2);
            let evs = e.events.lock().unwrap();
            assert_eq!(evs.first().unwrap().state, "running");
            assert_eq!(evs.last().unwrap().state, "finished");
        }

        #[test]
        fn a_failure_is_explained_and_leaves_files_alone() {
            let e = env(Duration::from_secs(5));
            let a = script(e.dir.path(), "echo 'aerender Error: Could not find comp' >&2\necho 'PROGRESS: done'\nexit 3");
            e.runner.start(&a, &plan(e.dir.path()), "p").unwrap();
            let done = wait_done(&e.runner);
            assert_eq!(done.state, "failed");
            assert_eq!(done.exit_code, Some(3));
            let m = done.message.unwrap();
            assert!(m.contains("exit code 3") && m.contains("Could not find comp"), "{m}");
            assert!(!done.output_exists);
        }

        #[test]
        fn exit_zero_without_a_file_is_not_a_success() {
            let e = env(Duration::from_secs(5));
            let a = script(e.dir.path(), "echo fine");
            e.runner.start(&a, &plan(e.dir.path()), "p").unwrap();
            let done = wait_done(&e.runner);
            assert_eq!(done.state, "failed");
            assert!(done.message.unwrap().contains("no file appeared"));
        }

        #[test]
        fn only_one_render_runs_at_a_time_and_a_new_one_can_follow() {
            let e = env(Duration::from_secs(5));
            let slow = script(e.dir.path(), "sleep 2");
            e.runner.start(&slow, &plan(e.dir.path()), "p").unwrap();
            let err = e.runner.start(&slow, &plan(e.dir.path()), "p").unwrap_err().to_string();
            assert!(err.contains("already rendering"), "{err}");
            e.runner.cancel().unwrap();
            wait_done(&e.runner);
            let quick = script(e.dir.path(), &format!("{FIND_OUT}\necho x > \"$out\""));
            e.runner.start(&quick, &plan(e.dir.path()), "p").unwrap();
            assert_eq!(wait_done(&e.runner).state, "finished");
        }

        #[test]
        fn a_program_that_cannot_start_changes_nothing() {
            let e = env(Duration::from_secs(5));
            let err = e.runner.start(&e.dir.path().join("missing"), &plan(e.dir.path()), "p");
            assert!(err.is_err());
            assert!(e.runner.current().is_none());
            let logs = fs::read_dir(e.dir.path().join("logs")).map(|d| d.count()).unwrap_or(0);
            assert_eq!(logs, 0, "no stray log");
        }

        #[test]
        fn cancel_stops_the_process_and_its_children_and_keeps_partial_output() {
            let e = env(Duration::from_secs(5));
            let pidfile = e.dir.path().join("child.pid");
            let a = script(e.dir.path(), &format!("{FIND_OUT}\necho partial > \"$out\"\nsleep 60 &\necho $! > '{}'\necho 'PROGRESS: 0:00:00:00 (1): 0 Seconds'\nwait", pidfile.display()));
            e.runner.start(&a, &plan(e.dir.path()), "p").unwrap();
            for _ in 0..200 {
                if pidfile.exists() && e.runner.current().unwrap().frame.is_some() {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            let child: i32 = fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
            assert!(alive(child));
            e.runner.cancel().unwrap();
            let done = wait_done(&e.runner);
            assert_eq!(done.state, "cancelled", "{done:?}");
            assert!(done.message.as_ref().unwrap().contains("not deleted"));
            assert!(done.output_exists);
            assert_eq!(fs::read_to_string(e.dir.path().join("out.mov")).unwrap().trim(), "partial");
            thread::sleep(Duration::from_millis(200));
            assert!(!alive(child), "the child process must be gone too");
            assert!(e.runner.cancel().is_err(), "nothing left to cancel");
        }

        #[test]
        fn clearing_forgets_an_ended_job_but_never_a_running_one_or_any_file() {
            let e = env(Duration::from_secs(5));
            assert!(e.runner.clear().is_ok(), "nothing to clear is fine");
            let a = script(e.dir.path(), &format!("{FIND_OUT}\necho done > \"$out\"\nexit 0"));
            e.runner.start(&a, &plan(e.dir.path()), "p").unwrap();
            let done = wait_done(&e.runner);
            assert_eq!(done.state, "finished");
            e.runner.clear().unwrap();
            assert!(e.runner.current().is_none());
            assert!(e.runner.log_tail(10).is_empty());
            assert!(e.dir.path().join("out.mov").exists(), "the rendered file stays");

            let slow = script(e.dir.path(), "sleep 30");
            e.runner.start(&slow, &plan(e.dir.path()), "p").unwrap();
            assert!(e.runner.clear().is_err(), "a running render cannot be cleared");
            assert_eq!(e.runner.current().unwrap().state, "running");
            e.runner.cancel().unwrap();
            wait_done(&e.runner);
        }

        #[test]
        fn a_process_that_ignores_the_polite_stop_is_force_killed() {
            let e = env(Duration::from_millis(400));
            let a = script(e.dir.path(), "trap '' TERM\nwhile true; do sleep 0.1; done");
            e.runner.start(&a, &plan(e.dir.path()), "p").unwrap();
            thread::sleep(Duration::from_millis(200));
            e.runner.cancel().unwrap();
            let done = wait_done(&e.runner);
            assert_eq!(done.state, "cancelled");
        }
    }
}
