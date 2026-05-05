// Per-vault inbox configuration. Stored at `<vault>/.anchor/inbox.json`.
// Loaded by `scan_inbox_drop` and `start_inbox_watcher` so the user can
// retarget the inbox root (`inbox/downloads` by default) and restrict
// which subdirectories are recognized as classification sources.
//
// Schema is intentionally tiny — anything richer belongs in the broader
// layered settings model. Missing or unreadable file → defaults.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::vault::resolve_inside_vault;

pub const DEFAULT_INBOX_ROOT: &str = "inbox/downloads";

pub fn default_sources() -> Vec<String> {
    vec![
        "outlook".to_string(),
        "sharepoint".to_string(),
        "gmail".to_string(),
        "kakao".to_string(),
        "telegram".to_string(),
        "downloads".to_string(),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxSettings {
    pub inbox_root: String,
    pub sources: Vec<String>,
    /// Optional absolute path to the `gws` CLI binary. When None,
    /// `gmail_gws::resolve_gws_path` falls back to PATH lookup with a
    /// macOS-aware augmentation.
    #[serde(default)]
    pub gws_path: Option<String>,
}

impl Default for InboxSettings {
    fn default() -> Self {
        Self {
            inbox_root: DEFAULT_INBOX_ROOT.to_string(),
            sources: default_sources(),
            gws_path: None,
        }
    }
}

fn settings_path(vault: &Path) -> PathBuf {
    vault.join(".anchor").join("inbox.json")
}

fn ensure_anchor_dir(vault: &Path) -> Result<(), String> {
    let dir = vault.join(".anchor");
    fs::create_dir_all(&dir).map_err(|err| format!("Cannot create .anchor directory: {err}"))
}

pub fn load(vault: &Path) -> InboxSettings {
    let path = settings_path(vault);
    let Ok(content) = fs::read_to_string(&path) else {
        return InboxSettings::default();
    };
    serde_json::from_str::<InboxSettings>(&content).unwrap_or_default()
}

#[tauri::command]
pub fn read_inbox_settings(vault_path: String) -> Result<InboxSettings, String> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    Ok(load(&vault))
}

#[tauri::command]
pub fn save_inbox_settings(
    vault_path: String,
    settings: InboxSettings,
) -> Result<InboxSettings, String> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    ensure_anchor_dir(&vault)?;
    let serialized = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("Cannot serialize inbox settings: {err}"))?;
    fs::write(settings_path(&vault), format!("{serialized}\n"))
        .map_err(|err| format!("Cannot write inbox settings: {err}"))?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn load_returns_defaults_when_missing() {
        let tmp = TempDir::new().unwrap();
        let settings = load(tmp.path());
        assert_eq!(settings, InboxSettings::default());
        assert_eq!(settings.inbox_root, "inbox/downloads");
        assert!(settings.sources.contains(&"outlook".to_string()));
    }

    #[test]
    fn save_then_load_round_trips() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        let next = InboxSettings {
            inbox_root: "incoming/spool".to_string(),
            sources: vec!["alpha".to_string(), "beta".to_string()],
            gws_path: Some("/opt/homebrew/bin/gws".to_string()),
        };
        let saved = save_inbox_settings(path.clone(), next.clone()).unwrap();
        assert_eq!(saved, next);
        let reloaded = read_inbox_settings(path).unwrap();
        assert_eq!(reloaded, next);
    }

    #[test]
    fn save_creates_anchor_directory() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        save_inbox_settings(path, InboxSettings::default()).unwrap();
        assert!(tmp.path().join(".anchor/inbox.json").exists());
    }
}
