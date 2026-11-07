//! Installing the After Effects Companion (a CEP extension) for the person.
//!
//! The extension ships inside the app (`companion-bundle`), either as the signed package `com.murre.cep.zxp` or, for
//! development, as a plain folder. Installing puts it into the user's own CEP folder, which needs no administrator
//! password: `~/Library/Application Support/Adobe/CEP/extensions` on macOS, `%APPDATA%\Adobe\CEP\extensions` on Windows
//! (both from Adobe's CEP Cookbook). A signed package is unpacked exactly as it is (the signature covers every file, so
//! nothing may be left out). Only an unsigned folder also needs `PlayerDebugMode` turned on for the CSXS versions After
//! Effects uses: `defaults` on macOS, a string value under `HKEY_CURRENT_USER\Software\Adobe\CSXS.<N>` on Windows.
//! A folder that is a symlink there is a developer's link to a working copy and is never touched.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const EXTENSION_ID: &str = "com.murre.cep";
/// The signed package, when the app ships one.
pub const ZXP_NAME: &str = "com.murre.cep.zxp";
const CSXS_VERSIONS: &[u32] = &[9, 10, 11, 12, 13];

#[derive(Serialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionInstall {
    /// The extension is in the CEP folder.
    pub installed: bool,
    /// It is the same version as the one shipped with the app (or a developer's link).
    pub current: bool,
    /// The CEP folder entry is a symlink to a working copy.
    pub dev_link: bool,
    /// The app has a copy to install.
    pub bundle_available: bool,
    pub installed_version: Option<String>,
    pub bundled_version: Option<String>,
    pub path: String,
}

/// `ExtensionBundleVersion` from a CEP manifest.
pub fn read_version(manifest: &str) -> Option<String> {
    let at = manifest.find("ExtensionBundleVersion=\"")? + "ExtensionBundleVersion=\"".len();
    let end = manifest[at..].find('"')?;
    Some(manifest[at..at + end].to_string())
}

fn version_in(dir: &Path) -> Option<String> {
    read_version(&fs::read_to_string(dir.join("CSXS").join("manifest.xml")).ok()?)
}

/// Where the Companion goes for this user. `roaming` is the roaming app data folder (`%APPDATA%`), used on Windows.
pub fn target_dir(home: &Path, roaming: &Path) -> PathBuf {
    let extensions = if cfg!(windows) {
        roaming.join("Adobe").join("CEP").join("extensions")
    } else {
        home.join("Library/Application Support/Adobe/CEP/extensions")
    };
    extensions.join(EXTENSION_ID)
}

fn open_zip(zxp: &Path) -> AppResult<zip::ZipArchive<fs::File>> {
    let file = fs::File::open(zxp).map_err(|e| AppError::io(zxp, e))?;
    zip::ZipArchive::new(file).map_err(|e| AppError::Invalid(format!("Could not read the Companion package: {e}")))
}

/// The manifest inside a signed package.
fn manifest_in_zip(zxp: &Path) -> Option<String> {
    use std::io::Read;
    let mut archive = open_zip(zxp).ok()?;
    let mut entry = archive.by_name("CSXS/manifest.xml").ok()?;
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    Some(text)
}

/// The signed package inside a bundle folder, if there is one.
pub fn signed_package(bundle: &Path) -> Option<PathBuf> {
    let p = bundle.join(ZXP_NAME);
    p.is_file().then_some(p)
}

/// The shipped copy, if the app has one (a folder with a signed package or with a manifest).
pub fn find_bundle(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|c| signed_package(c).is_some() || c.join("CSXS").join("manifest.xml").is_file()).cloned()
}

/// Version of what the app ships, read from inside the package when it is signed.
fn bundled_version(bundle: &Path) -> Option<String> {
    if let Some(zxp) = signed_package(bundle) {
        return read_version(&manifest_in_zip(&zxp)?);
    }
    version_in(bundle)
}

/// Unpack a signed package as it is: every file, including ones a plain copy would skip. The zip library refuses
/// entries that would land outside `dst`.
fn unzip_to(zxp: &Path, dst: &Path) -> AppResult<()> {
    fs::create_dir_all(dst).map_err(|e| AppError::io(dst, e))?;
    let unpacked = open_zip(zxp).and_then(|mut a| {
        a.extract(dst).map_err(|e| AppError::Invalid(format!("Could not unpack the Companion package: {e}")))
    });
    if let Err(e) = unpacked {
        let _ = fs::remove_dir_all(dst);
        return Err(e);
    }
    if !dst.join("CSXS").join("manifest.xml").is_file() {
        let _ = fs::remove_dir_all(dst);
        return Err(AppError::Invalid("The Companion package has no manifest, so it wasn’t installed.".into()));
    }
    Ok(())
}

/// Put the shipped extension into `dst`.
fn fill(bundle: &Path, dst: &Path) -> AppResult<()> {
    match signed_package(bundle) {
        Some(zxp) => unzip_to(&zxp, dst),
        None => copy_dir(bundle, dst),
    }
}

pub fn status(bundle: Option<&Path>, target: &Path) -> CompanionInstall {
    let meta = fs::symlink_metadata(target).ok();
    let dev_link = meta.as_ref().is_some_and(|m| m.file_type().is_symlink());
    let installed_version = version_in(target);
    let installed = installed_version.is_some();
    let bundled_version = bundle.and_then(bundled_version);
    CompanionInstall {
        installed,
        current: installed && (dev_link || installed_version == bundled_version),
        dev_link,
        bundle_available: bundle.is_some(),
        installed_version,
        bundled_version,
        path: target.to_string_lossy().into_owned(),
    }
}

/// Copy the extension, leaving out source maps, the developer `.debug` file and symlinks.
fn copy_dir(src: &Path, dst: &Path) -> AppResult<()> {
    fs::create_dir_all(dst).map_err(|e| AppError::io(dst, e))?;
    for entry in fs::read_dir(src).map_err(|e| AppError::io(src, e))? {
        let entry = entry.map_err(|e| AppError::io(src, e))?;
        let name = entry.file_name();
        let n = name.to_string_lossy();
        if n == ".debug" || n == ".DS_Store" || n.ends_with(".map") {
            continue;
        }
        let ty = entry.file_type().map_err(|e| AppError::io(&entry.path(), e))?;
        let to = dst.join(&name);
        if ty.is_symlink() {
            continue;
        } else if ty.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to).map_err(|e| AppError::io(&to, e))?;
        }
    }
    Ok(())
}

/// The Companion used to be installed as `com.sequenxe.cep`. Remove that old copy (our own earlier install, recognised by its
/// manifest) so After Effects does not list two panels. Anything else with that name, and any symlink, is left alone.
fn remove_legacy(target: &Path) {
    const OLD_ID: &str = "com.sequenxe.cep";
    let old = target.with_file_name(OLD_ID);
    let Ok(meta) = fs::symlink_metadata(&old) else { return };
    if !meta.is_dir() {
        return;
    }
    let ours = fs::read_to_string(old.join("CSXS/manifest.xml")).map(|m| m.contains(OLD_ID)).unwrap_or(false);
    if ours {
        let _ = fs::remove_dir_all(&old);
    }
}

/// A folder next to the extensions folder (not inside it, so After Effects never loads it as a second panel), on the
/// same disk, so moving between the two is a rename.
fn beside(target: &Path, what: &str) -> PathBuf {
    let name = format!(".{EXTENSION_ID}.{what}");
    match target.parent().and_then(Path::parent) {
        Some(cep) => cep.join(name),
        None => target.with_file_name(name),
    }
}

/// Put the shipped extension at `target`, replacing an older copy of it. A symlink is left alone.
///
/// An update never deletes the working copy first. The new one is unpacked beside it, the old one is moved aside
/// with a rename and the new one moved in; only then is the old one deleted. A rename either happens or it doesn't,
/// so when After Effects has the files open (Windows refuses to move them), nothing is touched and the person is
/// told to quit After Effects first.
pub fn install_to(bundle: &Path, target: &Path) -> AppResult<()> {
    if target.file_name().map(|n| n != EXTENSION_ID).unwrap_or(true) {
        return Err(AppError::Invalid("Unexpected Companion install folder.".into()));
    }
    remove_legacy(target);
    let Ok(m) = fs::symlink_metadata(target) else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
        }
        return fill(bundle, target);
    };
    if m.file_type().is_symlink() {
        return Ok(());
    }
    let staging = beside(target, "new");
    let old = beside(target, "old");
    // Leftovers of an update that was interrupted.
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&old);
    fill(bundle, &staging)?;
    if fs::rename(target, &old).is_err() {
        let _ = fs::remove_dir_all(&staging);
        return Err(AppError::Invalid(
            "Couldn’t update the Companion, probably because After Effects is using it. Quit After Effects, then try again. Your current Companion is unchanged.".into(),
        ));
    }
    if let Err(e) = fs::rename(&staging, target) {
        // Put the old one back, so the person still has a working Companion.
        let _ = fs::rename(&old, target);
        let _ = fs::remove_dir_all(&staging);
        return Err(AppError::io(target, e));
    }
    // The update is in place; a copy that can't be deleted now is cleaned up next time.
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

/// The registry key for one CSXS version on Windows.
fn reg_key(v: u32) -> String {
    format!(r"HKCU\Software\Adobe\CSXS.{v}")
}

/// Allow unsigned extensions to load (each CSXS version has its own setting). Failures are ignored here and
/// reported by the caller as "restart After Effects", because the setting is only read at launch.
pub fn enable_debug_mode() {
    for v in CSXS_VERSIONS {
        if cfg!(target_os = "macos") {
            let _ = crate::platform::command("defaults")
                .args(["write", &format!("com.adobe.CSXS.{v}"), "PlayerDebugMode", "1"])
                .output();
        } else if cfg!(windows) {
            let _ = crate::platform::command("reg")
                .args(["add", &reg_key(*v), "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"])
                .output();
        }
    }
}

/// `defaults read` prints the value on its own line; 1 means on.
fn is_on(output: &str) -> bool {
    output.trim() == "1"
}

/// `reg query` prints `PlayerDebugMode    REG_SZ    1` under the key; 1 means on.
fn reg_is_on(output: &str) -> bool {
    output.lines().any(|l| l.split_whitespace().collect::<Vec<_>>() == ["PlayerDebugMode", "REG_SZ", "1"])
}

/// Whether `PlayerDebugMode` is on for every CSXS version After Effects uses.
pub fn debug_mode_enabled() -> bool {
    if cfg!(target_os = "macos") {
        CSXS_VERSIONS.iter().all(|v| {
            crate::platform::command("defaults")
                .args(["read", &format!("com.adobe.CSXS.{v}"), "PlayerDebugMode"])
                .output()
                .map(|o| o.status.success() && is_on(&String::from_utf8_lossy(&o.stdout)))
                .unwrap_or(false)
        })
    } else if cfg!(windows) {
        CSXS_VERSIONS.iter().all(|v| {
            crate::platform::command("reg")
                .args(["query", &reg_key(*v), "/v", "PlayerDebugMode"])
                .output()
                .map(|o| o.status.success() && reg_is_on(&String::from_utf8_lossy(&o.stdout)))
                .unwrap_or(false)
        })
    } else {
        false
    }
}

/// Put the setting back to how the system has it by default (the value is removed, not set to 0).
pub fn disable_debug_mode() {
    for v in CSXS_VERSIONS {
        if cfg!(target_os = "macos") {
            let _ = crate::platform::command("defaults").args(["delete", &format!("com.adobe.CSXS.{v}"), "PlayerDebugMode"]).output();
        } else if cfg!(windows) {
            let _ = crate::platform::command("reg").args(["delete", &reg_key(*v), "/v", "PlayerDebugMode", "/f"]).output();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_debug_setting_output() {
        assert!(is_on("1\n"));
        assert!(!is_on("0\n"));
        assert!(!is_on(""));
        let on = "\r\nHKEY_CURRENT_USER\\Software\\Adobe\\CSXS.12\r\n    PlayerDebugMode    REG_SZ    1\r\n\r\n";
        assert!(reg_is_on(on));
        assert!(!reg_is_on(&on.replace("REG_SZ    1", "REG_SZ    0")));
        assert!(!reg_is_on(""));
        assert_eq!(reg_key(12), r"HKCU\Software\Adobe\CSXS.12");
    }

    #[test]
    fn the_install_folder_follows_the_system() {
        let (home, roaming) = (Path::new("/Users/me"), Path::new("/Users/me/AppData/Roaming"));
        let t = target_dir(home, roaming);
        assert!(t.ends_with(Path::new("CEP").join("extensions").join(EXTENSION_ID)));
        if cfg!(windows) {
            assert!(t.starts_with(roaming.join("Adobe")));
        } else {
            assert!(t.starts_with(home.join("Library")));
        }
    }

    fn bundle(dir: &Path, version: &str) {
        fs::create_dir_all(dir.join("CSXS")).unwrap();
        fs::create_dir_all(dir.join("main")).unwrap();
        fs::write(dir.join("CSXS/manifest.xml"), format!("<ExtensionManifest ExtensionBundleId=\"{EXTENSION_ID}\" ExtensionBundleVersion=\"{version}\">")).unwrap();
        fs::write(dir.join("main/index.html"), "x").unwrap();
        fs::write(dir.join("main/index.js.map"), "map").unwrap();
        fs::write(dir.join(".debug"), "d").unwrap();
    }

    #[test]
    fn reads_the_bundle_version() {
        assert_eq!(read_version("<M ExtensionBundleVersion=\"1.2.3\" a=\"b\">").as_deref(), Some("1.2.3"));
        assert_eq!(read_version("<M>"), None);
    }

    #[test]
    fn the_old_sequenxe_panel_is_removed_on_install_but_other_folders_are_not() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("bundle");
        fs::create_dir_all(bundle.join("CSXS")).unwrap();
        fs::write(bundle.join("CSXS/manifest.xml"), format!("<ExtensionManifest ExtensionBundleId=\"{EXTENSION_ID}\" ExtensionBundleVersion=\"1\">")).unwrap();
        let ext = root.path().join("extensions");
        let old = ext.join("com.sequenxe.cep");
        fs::create_dir_all(old.join("CSXS")).unwrap();
        fs::write(old.join("CSXS/manifest.xml"), "<ExtensionManifest ExtensionBundleId=\"com.sequenxe.cep\">").unwrap();
        install_to(&bundle, &ext.join(EXTENSION_ID)).unwrap();
        assert!(!old.exists() && ext.join(EXTENSION_ID).is_dir());
        // A folder with that name that is not our install is kept.
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("mine.txt"), "x").unwrap();
        install_to(&bundle, &ext.join(EXTENSION_ID)).unwrap();
        assert!(old.join("mine.txt").is_file());
    }

    #[test]
    fn installs_updates_and_reports_status() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("bundle");
        bundle(&src, "1.0.0");
        let target = target_dir(d.path(), d.path());

        let s = status(Some(&src), &target);
        assert!(!s.installed && s.bundle_available);

        install_to(&src, &target).unwrap();
        assert!(target.join("main/index.html").is_file());
        assert!(!target.join("main/index.js.map").exists(), "source maps are left out");
        assert!(!target.join(".debug").exists());
        let s = status(Some(&src), &target);
        assert!(s.installed && s.current && !s.dev_link);

        // a newer bundle replaces the older copy
        bundle(&src, "1.1.0");
        let s = status(Some(&src), &target);
        assert!(s.installed && !s.current);
        install_to(&src, &target).unwrap();
        let s = status(Some(&src), &target);
        assert!(s.current);
        assert_eq!(s.installed_version.as_deref(), Some("1.1.0"));
        assert!(!target.with_file_name(format!("{EXTENSION_ID}.new")).exists());
        assert!(!beside(&target, "new").exists() && !beside(&target, "old").exists(), "no copies left behind");
        // Nothing but the Companion itself is in the extensions folder, so After Effects can't load a second copy.
        let names: Vec<_> = fs::read_dir(target.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from(EXTENSION_ID)]);
    }

    /// When the old copy can't be moved (on Windows: After Effects has its files open), nothing is touched.
    #[cfg(unix)]
    #[test]
    fn an_update_that_cant_move_the_old_copy_leaves_it_working() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("bundle");
        bundle(&src, "1.0.0");
        let target = target_dir(d.path(), d.path());
        install_to(&src, &target).unwrap();
        bundle(&src, "2.0.0");
        let extensions = target.parent().unwrap().to_path_buf();
        // A folder whose entries can't be renamed stands in for files Windows has locked.
        fs::set_permissions(&extensions, fs::Permissions::from_mode(0o555)).unwrap();
        let result = install_to(&src, &target);
        fs::set_permissions(&extensions, fs::Permissions::from_mode(0o755)).unwrap();
        let message = result.unwrap_err().to_string();
        assert!(message.contains("Quit After Effects"), "{message}");
        assert_eq!(status(Some(&src), &target).installed_version.as_deref(), Some("1.0.0"), "the old copy still works");
        assert!(target.join("main/index.html").is_file());
        assert!(!beside(&target, "new").exists(), "the unpacked new copy is cleaned up");
    }

    /// Leftovers of an interrupted update don't stop the next one.
    #[test]
    fn leftovers_from_an_interrupted_update_are_cleared() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("bundle");
        bundle(&src, "1.0.0");
        let target = target_dir(d.path(), d.path());
        install_to(&src, &target).unwrap();
        for what in ["new", "old"] {
            fs::create_dir_all(beside(&target, what).join("CSXS")).unwrap();
        }
        bundle(&src, "1.1.0");
        install_to(&src, &target).unwrap();
        assert_eq!(status(Some(&src), &target).installed_version.as_deref(), Some("1.1.0"));
        assert!(!beside(&target, "new").exists() && !beside(&target, "old").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_developer_symlink_is_never_replaced() {
        let d = tempfile::tempdir().unwrap();
        let work = d.path().join("work");
        bundle(&work, "0.0.1");
        let src = d.path().join("bundle");
        bundle(&src, "9.9.9");
        let target = target_dir(d.path(), d.path());
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&work, &target).unwrap();
        install_to(&src, &target).unwrap();
        assert!(fs::symlink_metadata(&target).unwrap().file_type().is_symlink());
        let s = status(Some(&src), &target);
        assert!(s.installed && s.dev_link && s.current);
        assert_eq!(s.installed_version.as_deref(), Some("0.0.1"));
    }

    #[test]
    fn refuses_a_folder_that_is_not_the_extension() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("bundle");
        bundle(&src, "1.0.0");
        assert!(install_to(&src, &d.path().join("other")).is_err());
    }

    /// A signed package like the one the app ships: it holds files a plain copy would leave out (`.debug`), and
    /// the signature covers them, so they must all arrive.
    #[test]
    fn a_signed_package_is_unpacked_whole() {
        let d = tempfile::tempdir().unwrap();
        let build = d.path().join("build");
        bundle(&build, "2.0.0");
        fs::create_dir_all(build.join("META-INF")).unwrap();
        fs::write(build.join("META-INF/signatures.xml"), "<signatures/>").unwrap();
        let shipped = d.path().join("shipped");
        fs::create_dir_all(&shipped).unwrap();
        zip_dir(&build, &shipped.join(ZXP_NAME));
        assert_eq!(find_bundle(&[shipped.clone()]), Some(shipped.clone()));
        let target = target_dir(d.path(), d.path());
        let s = status(Some(&shipped), &target);
        assert!(s.bundle_available && !s.installed);
        assert_eq!(s.bundled_version.as_deref(), Some("2.0.0"));
        install_to(&shipped, &target).unwrap();
        assert!(target.join("META-INF/signatures.xml").is_file());
        assert!(target.join(".debug").is_file(), "the signature covers .debug, so it has to be there");
        assert!(target.join("main/index.js.map").is_file());
        assert!(status(Some(&shipped), &target).current);
        assert!(signed_package(&shipped).is_some() && signed_package(&build).is_none());
        // installing again replaces it without leaving a staging folder behind
        install_to(&shipped, &target).unwrap();
        assert!(!target.with_file_name(format!("{EXTENSION_ID}.new")).exists());
    }

    /// Zip every file under `src` into `out`, with `/` paths as in a real package.
    fn zip_dir(src: &Path, out: &Path) {
        use std::io::Write;
        fn walk(dir: &Path, base: &Path, w: &mut zip::ZipWriter<fs::File>) {
            for e in fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                let name = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                if p.is_dir() {
                    walk(&p, base, w);
                } else {
                    w.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
                    w.write_all(&fs::read(&p).unwrap()).unwrap();
                }
            }
        }
        let mut w = zip::ZipWriter::new(fs::File::create(out).unwrap());
        walk(src, src, &mut w);
        w.finish().unwrap();
    }

    /// The package the app really ships (made and signed by Adobe's tools), when this checkout has one.
    #[test]
    fn the_shipped_package_unpacks() {
        let shipped = Path::new(env!("CARGO_MANIFEST_DIR")).join("companion-bundle");
        if signed_package(&shipped).is_none() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let target = target_dir(d.path(), d.path());
        install_to(&shipped, &target).unwrap();
        assert!(target.join("META-INF").join("signatures.xml").is_file(), "the signature arrives with it");
        let s = status(Some(&shipped), &target);
        assert!(s.installed && s.current && s.bundled_version.is_some(), "{s:?}");
    }

    #[test]
    fn a_package_with_no_manifest_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let build = d.path().join("build");
        fs::create_dir_all(&build).unwrap();
        fs::write(build.join("readme.txt"), "x").unwrap();
        let shipped = d.path().join("shipped");
        fs::create_dir_all(&shipped).unwrap();
        zip_dir(&build, &shipped.join(ZXP_NAME));
        let target = target_dir(d.path(), d.path());
        assert!(install_to(&shipped, &target).is_err());
        assert!(!target.exists(), "nothing half-installed is left behind");
    }

    #[test]
    fn finds_the_bundle_only_when_it_has_a_manifest() {
        let d = tempfile::tempdir().unwrap();
        let empty = d.path().join("empty");
        fs::create_dir_all(&empty).unwrap();
        let ok = d.path().join("ok");
        bundle(&ok, "1.0.0");
        assert_eq!(find_bundle(&[empty, ok.clone()]), Some(ok));
        assert_eq!(find_bundle(&[]), None);
    }
}
