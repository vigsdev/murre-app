//! The local user profile (name + avatar), stored in the app data directory.
//!
//! * `profile.json`  – validated metadata, written with [`safe_fs`].
//! * `avatar.<ext>` – the avatar image, if any.
//!
//! The avatar file is written before `profile.json`, so the profile never
//! points at a file that does not exist.

use crate::error::{AppError, AppResult};
use crate::safe_fs;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PROFILE_FILE: &str = "profile.json";
const SCHEMA_VERSION: u32 = 1;
pub const MAX_NAME_CHARS: usize = 60;
pub const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredProfile {
    schema_version: u32,
    name: String,
    /// What the user does, e.g. "Motion Designer". Optional.
    #[serde(default)]
    role: Option<String>,
    /// File name (not a path) of the avatar inside the app data directory.
    avatar_file: Option<String>,
    created_at: u64,
    updated_at: u64,
}

/// What the frontend receives.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub name: String,
    pub role: Option<String>,
    pub avatar_data_url: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn profile_path(root: &Path) -> PathBuf {
    root.join(PROFILE_FILE)
}

/// Optional free text. Blank means "not set".
pub fn validate_role(raw: &str) -> AppResult<Option<String>> {
    let role = raw.trim();
    if role.is_empty() {
        return Ok(None);
    }
    if role.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::Invalid(format!(
            "Role must be {MAX_NAME_CHARS} characters or fewer."
        )));
    }
    if role.chars().any(|c| c.is_control()) {
        return Err(AppError::Invalid("Role cannot contain line breaks.".into()));
    }
    Ok(Some(role.to_string()))
}

pub fn validate_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("Please enter your name.".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::Invalid(format!(
            "Name must be {MAX_NAME_CHARS} characters or fewer."
        )));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(AppError::Invalid(
            "Name contains invalid characters.".into(),
        ));
    }
    Ok(name.to_string())
}

/// Identify an image by its magic bytes. Returns (extension, mime type).
fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("png", "image/png"))
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("jpg", "image/jpeg"))
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("webp", "image/webp"))
    } else {
        None
    }
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        _ => "image/webp",
    }
}

fn avatar_file_name_ok(name: &str) -> bool {
    matches!(name, "avatar.png" | "avatar.jpg" | "avatar.webp")
}

fn build_view(root: &Path, stored: &StoredProfile) -> ProfileView {
    // A missing or unreadable avatar must not block the app; fall back to initials.
    let avatar_data_url = stored
        .avatar_file
        .as_deref()
        .filter(|f| avatar_file_name_ok(f))
        .and_then(|f| {
            let ext = f.rsplit('.').next().unwrap_or("");
            fs::read(root.join(f))
                .ok()
                .map(|b| format!("data:{};base64,{}", mime_for_ext(ext), B64.encode(b)))
        });
    ProfileView {
        name: stored.name.clone(),
        role: stored.role.clone(),
        avatar_data_url,
    }
}

/// `Ok(None)` means no profile exists yet (first launch). A profile file that
/// exists but cannot be recovered is an error, never silently treated as
/// first launch.
pub fn load(root: &Path) -> AppResult<Option<ProfileView>> {
    let path = profile_path(root);
    if !path.exists() && !safe_fs::backup_path(&path).exists() {
        return Ok(None);
    }
    let (stored, _source): (StoredProfile, _) = safe_fs::read_json(&path)?;
    Ok(Some(build_view(root, &stored)))
}

/// Create or update the profile.
///
/// `avatar`: `Some(bytes)` sets/replaces the avatar; `None` leaves any existing
/// avatar unchanged.
pub fn save(
    root: &Path,
    name: &str,
    role: &str,
    avatar: Option<&[u8]>,
) -> AppResult<ProfileView> {
    let name = validate_name(name)?;
    let role = validate_role(role)?;
    let path = profile_path(root);

    let existing: Option<StoredProfile> = if path.exists() || safe_fs::backup_path(&path).exists() {
        Some(safe_fs::read_json::<StoredProfile>(&path)?.0)
    } else {
        None
    };

    let mut avatar_file = existing.as_ref().and_then(|p| p.avatar_file.clone());
    if let Some(bytes) = avatar {
        if bytes.len() > MAX_AVATAR_BYTES {
            return Err(AppError::Invalid(
                "The avatar image is too large (max 2 MB).".into(),
            ));
        }
        let (ext, _) = sniff_image(bytes).ok_or_else(|| {
            AppError::Invalid("The avatar must be a PNG, JPEG or WebP image.".into())
        })?;
        let new_name = format!("avatar.{ext}");
        safe_fs::atomic_write(&root.join(&new_name), bytes)?;
        // The profile is saved below; only then is an avatar with a different extension stale.
        avatar_file = Some(new_name);
    }

    let ts = now();
    let stored = StoredProfile {
        schema_version: SCHEMA_VERSION,
        name,
        role,
        avatar_file: avatar_file.clone(),
        created_at: existing.as_ref().map(|p| p.created_at).unwrap_or(ts),
        updated_at: ts,
    };
    safe_fs::write_json(&path, &stored)?;

    // Remove app-managed avatars left over from a previous extension.
    for old in ["avatar.png", "avatar.jpg", "avatar.webp"] {
        if Some(old) != avatar_file.as_deref() {
            let _ = fs::remove_file(root.join(old));
        }
    }
    Ok(build_view(root, &stored))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest-of-file";
    const JPG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];

    #[test]
    fn no_profile_means_first_launch() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
    }

    #[test]
    fn save_then_load_round_trips_name_and_avatar() {
        let dir = tempfile::tempdir().unwrap();
        let saved = save(dir.path(), "  Vignesh  ", "  Motion Designer ", Some(PNG)).unwrap();
        assert_eq!(saved.name, "Vignesh");
        assert_eq!(saved.role.as_deref(), Some("Motion Designer"));
        assert!(
            saved
                .avatar_data_url
                .as_deref()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        assert_eq!(load(dir.path()).unwrap(), Some(saved));
    }

    #[test]
    fn role_is_optional_and_validated() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(save(dir.path(), "A", "   ", None).unwrap().role, None);
        assert!(matches!(
            save(dir.path(), "A", &"r".repeat(61), None),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            save(dir.path(), "A", "a\nb", None),
            Err(AppError::Invalid(_))
        ));
    }

    #[test]
    fn profile_saved_before_roles_existed_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            profile_path(dir.path()),
            br#"{"schemaVersion":1,"name":"Old","avatarFile":null,"createdAt":1,"updatedAt":1}"#,
        )
        .unwrap();
        let view = load(dir.path()).unwrap().unwrap();
        assert_eq!((view.name.as_str(), view.role), ("Old", None));
    }

    #[test]
    fn name_is_validated() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            save(dir.path(), "   ", "", None),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            save(dir.path(), &"a".repeat(61), "", None),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            save(dir.path(), "a\nb", "", None),
            Err(AppError::Invalid(_))
        ));
        assert!(save(dir.path(), &"é".repeat(60), "", None).is_ok());
        assert!(!profile_path(dir.path()).exists() || load(dir.path()).is_ok());
    }

    #[test]
    fn invalid_avatars_are_rejected_without_writing_anything() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            save(dir.path(), "A", "", Some(b"not an image")),
            Err(AppError::Invalid(_))
        ));
        let big = [PNG, &vec![0u8; MAX_AVATAR_BYTES][..]].concat();
        assert!(matches!(
            save(dir.path(), "A", "", Some(&big)),
            Err(AppError::Invalid(_))
        ));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn none_keeps_existing_avatar_and_created_at() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "A", "", Some(PNG)).unwrap();
        let before: StoredProfile = safe_fs::read_json(&profile_path(dir.path())).unwrap().0;
        let view = save(dir.path(), "B", "", None).unwrap();
        assert_eq!(view.name, "B");
        assert!(view.avatar_data_url.is_some());
        let after: StoredProfile = safe_fs::read_json(&profile_path(dir.path())).unwrap().0;
        assert_eq!(after.created_at, before.created_at);
    }

    #[test]
    fn replacing_avatar_with_other_format_removes_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "A", "", Some(PNG)).unwrap();
        save(dir.path(), "A", "", Some(JPG)).unwrap();
        assert!(!dir.path().join("avatar.png").exists());
        assert!(dir.path().join("avatar.jpg").exists());
    }

    #[test]
    fn missing_avatar_file_does_not_break_loading() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "A", "", Some(PNG)).unwrap();
        fs::remove_file(dir.path().join("avatar.png")).unwrap();
        let view = load(dir.path()).unwrap().unwrap();
        assert_eq!(view.avatar_data_url, None);
    }

    #[test]
    fn corrupt_profile_is_an_error_not_a_fresh_start() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(profile_path(dir.path()), b"{broken").unwrap();
        assert!(matches!(load(dir.path()), Err(AppError::Corrupt { .. })));
        assert!(matches!(
            save(dir.path(), "A", "", None),
            Err(AppError::Corrupt { .. })
        ));
        assert_eq!(fs::read(profile_path(dir.path())).unwrap(), b"{broken");
    }

    #[test]
    fn corrupt_profile_recovers_from_backup() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "First", "", None).unwrap();
        save(dir.path(), "Second", "", None).unwrap();
        fs::write(profile_path(dir.path()), b"{broken").unwrap();
        assert_eq!(load(dir.path()).unwrap().unwrap().name, "First");
    }
}
