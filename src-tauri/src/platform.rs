//! The few things that differ between macOS and Windows and are needed all over the app.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A `Command` for a helper program (ffprobe, aerender, tasklist…). On Windows it is started without a console
/// window: Murre is a windowed app, and Windows would otherwise open a console for every console program it starts.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// `fs::canonicalize`, but on Windows in the normal `C:\…` form instead of `\\?\C:\…` where that is safe.
/// Those paths are stored, shown and handed to other programs (After Effects among them), which often do not accept
/// the `\\?\` form. Identical to `fs::canonicalize` on other systems.
pub fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// Whether `path` looks like a program this system can start. On Windows a file must begin with the `MZ` header of
/// a Windows program: starting anything else makes Windows show an "Unsupported 16-Bit Application" message box,
/// which is what Murre's own FFmpeg stand-ins (plain text) did. Elsewhere: it is a file.
pub fn is_program(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    if cfg!(windows) {
        use std::io::Read;
        let mut head = [0u8; 2];
        return std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == b"MZ";
    }
    true
}

/// A program's file name on this system: `ffmpeg` on macOS, `ffmpeg.exe` on Windows.
pub fn exe_name(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

/// What the system's file browser is called, for messages.
pub const FILE_BROWSER: &str = if cfg!(windows) { "File Explorer" } else { "Finder" };

/// What this computer is called in messages ("this Mac", "this PC").
pub const THIS_COMPUTER: &str = if cfg!(windows) { "this PC" } else { "this Mac" };

/// The name of this system, for messages such as "isn't available on Windows yet".
pub const OS_NAME: &str = if cfg!(windows) { "Windows" } else if cfg!(target_os = "macos") { "macOS" } else { "this system" };

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_paths_have_no_verbatim_prefix() {
        let d = tempfile::tempdir().unwrap();
        let p = canonicalize(d.path()).unwrap();
        assert!(!p.to_string_lossy().starts_with(r"\\?\"), "{}", p.display());
        assert!(p.is_absolute());
    }

    #[test]
    fn text_files_are_not_programs_on_windows() {
        let d = tempfile::tempdir().unwrap();
        let stand_in = d.path().join("ffmpeg.exe");
        std::fs::write(&stand_in, "#!/bin/sh\nexit 1\n").unwrap();
        assert_eq!(is_program(&stand_in), !cfg!(windows));
        assert!(!is_program(&d.path().join("missing.exe")));
        assert!(!is_program(d.path()), "a folder is not a program");
        // The test binary itself is a real program on every system.
        assert!(is_program(&std::env::current_exe().unwrap()));
    }

    #[test]
    fn exe_names_follow_the_system() {
        if cfg!(windows) {
            assert_eq!(exe_name("ffmpeg"), "ffmpeg.exe");
        } else {
            assert_eq!(exe_name("ffmpeg"), "ffmpeg");
        }
    }

    #[test]
    fn commands_still_run() {
        // The no-console flag must not stop a program from starting.
        let ok = if cfg!(windows) {
            command("cmd").args(["/C", "exit 0"]).status()
        } else {
            command("true").status()
        };
        assert!(ok.unwrap().success());
    }
}
