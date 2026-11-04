use std::path::Path;

/// The app ships ffmpeg and ffprobe next to its own program (`bundle.externalBin`), and the build refuses to run when
/// those files are missing. A checkout that has not made them yet gets stand-ins that do nothing, so the build and
/// `tauri dev` still work; the app notices they don't run and falls back to an ffmpeg installed on the computer. The
/// real ones come from `scripts/make-ffmpeg.sh`.
fn main() {
    let dir = Path::new("binaries");
    let _ = std::fs::create_dir_all(dir);
    for tool in ["ffmpeg", "ffprobe"] {
        let mut triples: Vec<String> = ["aarch64-apple-darwin", "x86_64-apple-darwin", "universal-apple-darwin"].map(String::from).to_vec();
        // Whatever this build is for (the tests also run on other systems).
        if let Ok(t) = std::env::var("TARGET") {
            triples.push(t);
        }
        for triple in triples {
            // Tauri looks for `<name>-<triple>.exe` when building for Windows.
            let ext = if triple.contains("windows") { ".exe" } else { "" };
            let path = dir.join(format!("{tool}-{triple}{ext}"));
            if !path.exists() {
                let _ = std::fs::write(&path, "#!/bin/sh\n# Stand-in. Run scripts/make-ffmpeg.sh for the real one.\nexit 1\n");
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
                }
            }
        }
    }
    println!("cargo:rerun-if-changed=binaries");
    tauri_build::build()
}
