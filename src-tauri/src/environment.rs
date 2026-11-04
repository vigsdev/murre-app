//! What a project needs to open properly: its fonts, third-party effects (plugins) and the
//! After Effects version. Built from `.murre/environment.json` and `.murre/fonts.json`, which the
//! Companion writes. Display only: the desktop app never writes these files.
//!
//! Plugins can't be checked exactly (After Effects does not say where an effect came from), so the
//! check is a soft one: the plugin folders on this Mac are searched for a file or folder whose name
//! looks like the effect. A plugin is only ever reported as "seen" or "can't confirm", never "missing".

use crate::error::AppResult;
use crate::fonts;
use crate::project::invalid;
use crate::safe_fs;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const ENVIRONMENT_JSON: &str = ".murre/environment.json";
const SUPPORTED_SCHEMA: u64 = 1;
const MAX_PLUGINS: usize = 500;
const MAX_LABEL: usize = 300;
const MAX_SCAN_ENTRIES: usize = 20_000;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NeedFont {
    pub label: String,
    pub post_script_name: String,
    /// `ok`, `adobe` (Adobe Fonts, can't be checked), `notOnMac` or `missing` (After Effects had a stand-in).
    pub state: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NeedPlugin {
    pub name: String,
    pub match_name: String,
    pub layer_count: usize,
    /// A file or folder with a matching name was found in the plugin folders of this Mac.
    pub seen_installed: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NeedsView {
    /// False until the Companion has scanned this project once.
    pub scanned: bool,
    pub last_scan_at: Option<Value>,
    /// The version that had the project open during the scan, e.g. "25.0x1".
    pub ae_version: Option<String>,
    /// Years of the After Effects versions installed here, e.g. ["2024", "2025"]. Empty if none were found.
    pub ae_installed: Vec<String>,
    /// `Some(false)` only when every After Effects found here is older than the scanned version.
    pub ae_ok: Option<bool>,
    pub fonts_method: String,
    pub fonts: Vec<NeedFont>,
    pub plugins: Vec<NeedPlugin>,
}

/// Effects that are not separate plugins: After Effects' own, preset ("pseudo") effects that live inside the project
/// (Animation Composer, Duik and similar presets), and Cycore "CC" effects, which ship with After Effects.
/// Applied again when reading, so projects scanned earlier are corrected without a new scan.
pub fn is_bundled_effect(match_name: &str, name: &str) -> bool {
    match_name.starts_with("ADBE")
        || match_name.starts_with("Pseudo/")
        || match_name.starts_with("CC ")
        // Colorama and a few other effects that come with After Effects from Cycore use "APC " (internal name "APC Colorama").
        || match_name.starts_with("APC ")
        // Some Cycore effects have an internal name that doesn't start with "CC " but are shown as "CC …".
        || name.starts_with("CC ")
        // The internal name of a few Cycore effects, e.g. "CS Composite", which After Effects shows as "CC Composite".
        || match_name.starts_with("CS ")
        || name.starts_with("CS ")
}

fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Names (without extension, lower-cased and stripped) of everything in the plugin folders, a few levels deep.
fn plugin_names(dirs: &[PathBuf]) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut budget = MAX_SCAN_ENTRIES;
    let mut stack: Vec<(PathBuf, usize)> = dirs.iter().map(|d| (d.clone(), 0)).collect();
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            if budget == 0 {
                return out;
            }
            budget -= 1;
            let path = e.path();
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
            let n = norm(stem);
            if n.len() >= 4 {
                out.insert(n);
            }
            if path.is_dir() && depth < 4 {
                stack.push((path, depth + 1));
            }
        }
    }
    out
}

/// `true` when some installed name contains the effect's name (or the other way round), ignoring case and punctuation.
fn looks_installed(names: &HashSet<String>, name: &str, match_name: &str) -> bool {
    [norm(name), norm(match_name)]
        .iter()
        .filter(|c| c.len() >= 4)
        .any(|c| names.iter().any(|n| n.contains(c.as_str()) || c.contains(n.as_str())))
}

fn default_plugin_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/Library/Application Support/Adobe/Common/Plug-ins"),
        PathBuf::from("/Library/Application Support/Adobe/Plug-Ins"),
    ];
    if let Ok(apps) = fs::read_dir("/Applications") {
        for a in apps.flatten() {
            if a.file_name().to_string_lossy().starts_with("Adobe After Effects") {
                dirs.push(a.path().join("Plug-ins"));
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join("Library/Application Support/Adobe/Common/Plug-ins"));
    }
    dirs
}

/// The After Effects versions found in `apps`, oldest first: "2025" for an "Adobe After Effects 2025" folder, and
/// "2027 Beta" for a beta (its folder has no year, so the year comes from the app's own version: 27.x is 2027).
fn installed_years(apps: &Path) -> Vec<String> {
    let mut found: Vec<(u32, String)> = fs::read_dir(apps)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    let rest = n.strip_prefix("Adobe After Effects")?.trim();
                    let first = rest.split_whitespace().next().unwrap_or("");
                    if first.len() == 4 && first.chars().all(|c| c.is_ascii_digit()) {
                        return Some((first.parse().ok()?, first.to_string()));
                    }
                    if rest.to_ascii_lowercase().contains("beta") {
                        let m = major(&crate::aerender::app_version(&e.path())?)?;
                        return Some((2000 + m, format!("{} Beta", 2000 + m)));
                    }
                    None
                })
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    found.dedup();
    found.into_iter().map(|(_, label)| label).collect()
}

/// "25.0x1" → 25.
fn major(version: &str) -> Option<u32> {
    version.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

fn label(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(MAX_LABEL).collect())
}

pub fn get(root: &Path) -> AppResult<NeedsView> {
    get_with(root, &default_plugin_dirs(), Path::new("/Applications"))
}

pub fn get_with(root: &Path, plugin_dirs: &[PathBuf], apps: &Path) -> AppResult<NeedsView> {
    let mut view = NeedsView { fonts_method: "layers".into(), ..Default::default() };

    let path = root.join(ENVIRONMENT_JSON);
    let mut raw_plugins: Vec<(String, String, usize)> = Vec::new();
    if path.exists() || safe_fs::backup_path(&path).exists() {
        let (doc, _): (Value, _) = safe_fs::read_json(&path)?;
        if doc.get("schemaVersion").and_then(Value::as_u64).is_some_and(|v| v > SUPPORTED_SCHEMA) {
            return invalid("This project's environment was saved by a newer version of the Companion.");
        }
        match doc.get("plugins") {
            None | Some(Value::Null) => {}
            Some(Value::Array(a)) => {
                for p in a.iter().take(MAX_PLUGINS) {
                    let Some(match_name) = label(p, "matchName") else { continue };
                    let name = label(p, "name").unwrap_or_else(|| match_name.clone());
                    if is_bundled_effect(&match_name, &name) {
                        continue;
                    }
                    let n = p.get("layerCount").and_then(Value::as_u64).unwrap_or(1) as usize;
                    raw_plugins.push((name, match_name, n));
                }
            }
            Some(_) => return invalid("environment.json has an unexpected format."),
        }
        view.last_scan_at = doc.get("lastScanAt").filter(|v| v.is_string() || v.is_number()).cloned();
        view.ae_version = label(&doc, "aeVersion");
        view.scanned = view.last_scan_at.is_some();
    }

    let f = fonts::get(root)?;
    view.fonts_method = f.method.clone();
    view.scanned = view.scanned || f.last_scan_at.is_some();
    view.fonts = f
        .fonts
        .iter()
        .map(|x| NeedFont {
            label: match (&x.family, &x.style) {
                (Some(fam), Some(st)) => format!("{fam} {st}"),
                (Some(fam), None) => fam.clone(),
                _ => x.post_script_name.clone(),
            },
            post_script_name: x.post_script_name.clone(),
            state: if x.missing {
                "missing"
            } else if x.installed == Some(false) {
                "notOnMac"
            } else if x.adobe_fonts {
                "adobe"
            } else {
                "ok"
            }
            .into(),
        })
        .collect();

    if !raw_plugins.is_empty() {
        let names = plugin_names(plugin_dirs);
        view.plugins = raw_plugins
            .into_iter()
            .map(|(name, match_name, layer_count)| NeedPlugin {
                seen_installed: looks_installed(&names, &name, &match_name),
                name,
                match_name,
                layer_count,
            })
            .collect();
    }

    view.ae_installed = installed_years(apps);
    if let (Some(v), false) = (view.ae_version.as_deref().and_then(major), view.ae_installed.is_empty()) {
        let newest = view
            .ae_installed
            .iter()
            .filter_map(|y| y.split_whitespace().next()?.parse::<u32>().ok())
            .map(|y| y.saturating_sub(2000))
            .max();
        view.ae_ok = newest.map(|n| n >= v);
    }
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project(env: Option<Value>, fonts: Option<Value>) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join(".murre")).unwrap();
        if let Some(e) = env {
            fs::write(d.path().join(ENVIRONMENT_JSON), e.to_string()).unwrap();
        }
        if let Some(f) = fonts {
            fs::write(d.path().join(".murre/fonts.json"), f.to_string()).unwrap();
        }
        d
    }

    #[test]
    fn unscanned_project_is_empty() {
        let d = project(None, None);
        let v = get_with(d.path(), &[], d.path()).unwrap();
        assert!(!v.scanned && v.fonts.is_empty() && v.plugins.is_empty() && v.ae_version.is_none());
    }

    #[test]
    fn combines_fonts_plugins_and_version() {
        let plugins = tempfile::tempdir().unwrap();
        fs::create_dir_all(plugins.path().join("Video Copilot")).unwrap();
        fs::write(plugins.path().join("Video Copilot/DeepGlow.aex"), "").unwrap();
        let apps = tempfile::tempdir().unwrap();
        fs::create_dir_all(apps.path().join("Adobe After Effects 2024")).unwrap();
        let d = project(
            Some(json!({"schemaVersion":1,"lastScanAt":"2026-10-26T12:00:00Z","aeVersion":"25.0x1","plugins":[
                {"matchName":"VIDEOCOPILOT Deep Glow","name":"Deep Glow","layerCount":3},
                {"matchName":"ZZ Unknown","name":"Mystery Blur","layerCount":1},
                {"matchName":"Pseudo/AC IN","name":"AC IN [IDE] Controls","layerCount":30},
                {"matchName":"CC Ball Action","name":"CC Ball Action","layerCount":2},
                {"matchName":"Composite","name":"CC Composite","layerCount":1},
                {"matchName":"CS Composite","name":"CS Composite","layerCount":1},
                {"matchName":"ADBE Glo2","name":"Glow","layerCount":1},{"matchName":"APC Colorama","name":"Colorama","layerCount":4}]})),
            Some(json!({"schemaVersion":1,"lastScanAt":"x","method":"project","fonts":[
                {"postScriptName":"A-Bold","family":"A","style":"Bold","location":"/nowhere/a.ttf"},
                {"postScriptName":"B-Reg","family":"B","style":"Regular","missing":true},
                {"postScriptName":"C","family":"C","adobeFonts":true}]})),
        );
        let v = get_with(d.path(), &[plugins.path().to_path_buf()], apps.path()).unwrap();
        assert!(v.scanned);
        assert_eq!(v.ae_version.as_deref(), Some("25.0x1"));
        assert_eq!(v.ae_installed, vec!["2024"]);
        assert_eq!(v.ae_ok, Some(false)); // 2024 = 24 < 25
        assert_eq!(v.fonts.iter().map(|f| f.state.as_str()).collect::<Vec<_>>(), ["notOnMac", "missing", "adobe"]);
        assert_eq!(v.fonts[0].label, "A Bold");
        assert_eq!(v.plugins.len(), 2);
        assert!(v.plugins[0].seen_installed && v.plugins[0].layer_count == 3);
        assert!(!v.plugins[1].seen_installed);
    }

    #[test]
    fn version_is_ok_when_a_new_enough_after_effects_is_installed() {
        let apps = tempfile::tempdir().unwrap();
        fs::create_dir_all(apps.path().join("Adobe After Effects 2025")).unwrap();
        fs::create_dir_all(apps.path().join("Adobe After Effects (Beta)")).unwrap();
        let d = project(Some(json!({"schemaVersion":1,"lastScanAt":"x","aeVersion":"25.2","plugins":[]})), None);
        let v = get_with(d.path(), &[], apps.path()).unwrap();
        assert_eq!(v.ae_ok, Some(true));
        assert_eq!(v.ae_installed, vec!["2025"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_beta_counts_as_installed_under_its_own_version() {
        let apps = tempfile::tempdir().unwrap();
        fs::create_dir_all(apps.path().join("Adobe After Effects 2026")).unwrap();
        let c = apps.path().join("Adobe After Effects (Beta)/Adobe After Effects (Beta).app/Contents");
        fs::create_dir_all(&c).unwrap();
        fs::write(c.join("Info.plist"), "<key>CFBundleShortVersionString</key><string>27.1.0</string>").unwrap();
        let d = project(Some(json!({"schemaVersion":1,"lastScanAt":"x","aeVersion":"27.1x30","plugins":[]})), None);
        let v = get_with(d.path(), &[], apps.path()).unwrap();
        assert_eq!(v.ae_installed, vec!["2026", "2027 Beta"]);
        assert_eq!(v.ae_ok, Some(true));
    }

    #[test]
    fn newer_schema_and_bad_shape_are_refused() {
        let d = project(Some(json!({"schemaVersion":2})), None);
        assert!(get_with(d.path(), &[], d.path()).is_err());
        let d = project(Some(json!({"schemaVersion":1,"plugins":{}})), None);
        assert!(get_with(d.path(), &[], d.path()).is_err());
    }

    #[test]
    fn short_names_never_match_by_accident() {
        let names: HashSet<String> = ["glow".to_string()].into();
        assert!(!looks_installed(&names, "Fx", "ZZ"));
    }
}
