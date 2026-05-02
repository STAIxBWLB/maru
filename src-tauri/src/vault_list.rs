// Multi-vault registry. anchor stores known vault roots in
// `<config>/com.anchor.app/vaults.json`. The user's existing
// ~/workspace/work and ~/workspace/vault can be registered as anchor
// vaults; fresh anchor-only vaults work the same way.
//
// Anchor extension: each vault carries an `external_writer` hint —
// e.g. "mcp-obsidian" for vaults managed by an Obsidian instance, in
// which case anchor reads but defers writes to the Obsidian MCP. v1
// Phase 0 stores the field but does not yet enforce write delegation;
// Phase 2 wires it up.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const APP_CONFIG_DIR: &str = "com.anchor.app";

/// We serialize to/from camelCase JSON because the React layer
/// consumes the response shape directly via Tauri IPC. Snake_case
/// aliases are kept on the previously-existing fields so a vaults.json
/// written by an earlier build still loads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultRegistryEntry {
    pub label: String,
    pub path: String,
    /// Optional hint for which external system (if any) owns writes to
    /// this vault. Unset = anchor owns writes. "mcp-obsidian" = anchor
    /// reads, Obsidian MCP handles writes (planned Phase 2).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "external_writer"
    )]
    pub external_writer: Option<String>,
    /// Workspace pairing — set when this entry was registered as part of
    /// a (work, vault) workspace pair. Both halves point at the work
    /// path so the UI can find the partner half. None = standalone vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    /// "work" | "vault" — the entry's role within its workspace pair.
    /// None = standalone (legacy single-folder vault).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultList {
    pub vaults: Vec<VaultRegistryEntry>,
    #[serde(alias = "active_vault")]
    pub active_vault: Option<String>,
    #[serde(default, alias = "hidden_defaults")]
    pub hidden_defaults: Vec<String>,
}

fn app_config_dir() -> Result<PathBuf, String> {
    dirs::config_dir().ok_or_else(|| "Could not determine config directory".to_string())
}

fn preferred_app_config_path(file_name: &str) -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join(APP_CONFIG_DIR).join(file_name))
}

fn vault_list_path() -> Result<PathBuf, String> {
    preferred_app_config_path("vaults.json")
}

fn load_at(path: &PathBuf) -> Result<VaultList, String> {
    if !path.exists() {
        return Ok(VaultList::default());
    }
    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read vault list: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse vault list: {}", e))
}

fn save_at(path: &PathBuf, list: &VaultList) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(list)
        .map_err(|e| format!("Failed to serialize vault list: {}", e))?;
    fs::write(path, json).map_err(|e| format!("Failed to write vault list: {}", e))
}

#[tauri::command]
pub fn list_vaults() -> Result<VaultList, String> {
    load_at(&vault_list_path()?)
}

pub fn assert_anchor_owns_writes(vault_path: &str) -> Result<(), String> {
    let list = load_at(&vault_list_path()?)?;
    if let Some(writer) = external_writer_for_path(&list, vault_path) {
        return Err(format!(
            "Vault writes are delegated to {writer}; anchor will not write directly."
        ));
    }
    Ok(())
}

fn external_writer_for_path(list: &VaultList, vault_path: &str) -> Option<String> {
    list.vaults
        .iter()
        .find(|vault| vault.path == vault_path)
        .and_then(|vault| vault.external_writer.clone())
}

#[tauri::command]
pub fn add_vault(
    label: String,
    path: String,
    external_writer: Option<String>,
) -> Result<VaultList, String> {
    add_vault_internal(VaultRegistryEntry {
        label,
        path,
        external_writer,
        workspace_root: None,
        role: None,
    })
}

/// Lower-level add that accepts the full entry shape. Used by the
/// workspace pairing flow to register a `work + vault` pair in one
/// transaction; `add_vault` is the thin frontend-facing wrapper.
pub fn add_vault_internal(entry: VaultRegistryEntry) -> Result<VaultList, String> {
    let mut list = load_at(&vault_list_path()?)?;
    if list.vaults.iter().any(|v| v.path == entry.path) {
        return Err("Vault is already registered".to_string());
    }
    let path = entry.path.clone();
    list.vaults.push(entry);
    if list.active_vault.is_none() {
        list.active_vault = Some(path);
    }
    save_at(&vault_list_path()?, &list)?;
    Ok(list)
}

/// Idempotent upsert. Used by `register_workspace_pair` so re-running on
/// an already-registered workspace does not error; existing entries are
/// patched in place (label / external_writer / role / workspace_root)
/// while the path stays the unique key.
pub fn upsert_vault(entry: VaultRegistryEntry) -> Result<VaultList, String> {
    let path_to_check = entry.path.clone();
    let mut list = load_at(&vault_list_path()?)?;
    if let Some(existing) = list.vaults.iter_mut().find(|v| v.path == entry.path) {
        existing.label = entry.label;
        existing.external_writer = entry.external_writer;
        existing.workspace_root = entry.workspace_root;
        existing.role = entry.role;
    } else {
        list.vaults.push(entry);
    }
    if list.active_vault.is_none() {
        list.active_vault = Some(path_to_check);
    }
    save_at(&vault_list_path()?, &list)?;
    Ok(list)
}

#[tauri::command]
pub fn remove_vault(path: String) -> Result<VaultList, String> {
    let mut list = load_at(&vault_list_path()?)?;
    list.vaults.retain(|v| v.path != path);
    if list.active_vault.as_deref() == Some(path.as_str()) {
        list.active_vault = list.vaults.first().map(|v| v.path.clone());
    }
    save_at(&vault_list_path()?, &list)?;
    Ok(list)
}

#[tauri::command]
pub fn set_active_vault(path: String) -> Result<VaultList, String> {
    let mut list = load_at(&vault_list_path()?)?;
    if !list.vaults.iter().any(|v| v.path == path) {
        return Err("Vault is not registered".to_string());
    }
    list.active_vault = Some(path);
    save_at(&vault_list_path()?, &list)?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save_and_reload(list: &VaultList) -> VaultList {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("vaults.json");
        save_at(&path, list).unwrap();
        load_at(&path).unwrap()
    }

    #[test]
    fn default_vault_list_is_empty() {
        let vl = VaultList::default();
        assert!(vl.vaults.is_empty());
        assert!(vl.active_vault.is_none());
    }

    #[test]
    fn roundtrip_preserves_data() {
        let list = VaultList {
            vaults: vec![
                VaultRegistryEntry {
                    label: "Work".to_string(),
                    path: "/Users/yj/workspace/work".to_string(),
                    external_writer: None,
                    workspace_root: Some("/Users/yj/workspace/work".to_string()),
                    role: Some("work".to_string()),
                },
                VaultRegistryEntry {
                    label: "Knowledge Vault".to_string(),
                    path: "/Users/yj/workspace/vault".to_string(),
                    external_writer: Some("mcp-obsidian".to_string()),
                    workspace_root: Some("/Users/yj/workspace/work".to_string()),
                    role: Some("vault".to_string()),
                },
            ],
            active_vault: Some("/Users/yj/workspace/work".to_string()),
            hidden_defaults: vec![],
        };
        let loaded = save_and_reload(&list);
        assert_eq!(loaded.vaults.len(), 2);
        assert_eq!(loaded.vaults[0].label, "Work");
        assert_eq!(
            loaded.vaults[1].external_writer.as_deref(),
            Some("mcp-obsidian"),
            "external_writer flag must round-trip"
        );
        assert_eq!(
            loaded.vaults[0].role.as_deref(),
            Some("work"),
            "workspace pair role must round-trip"
        );
        assert_eq!(
            loaded.vaults[1].workspace_root.as_deref(),
            Some("/Users/yj/workspace/work"),
            "vault half should point at its work partner"
        );
        assert_eq!(
            loaded.active_vault.as_deref(),
            Some("/Users/yj/workspace/work")
        );
    }

    #[test]
    fn load_returns_default_for_missing_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.json");
        let result = load_at(&path).unwrap();
        assert!(result.vaults.is_empty());
    }

    #[test]
    fn save_creates_parent_directories() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("nested").join("dir").join("vaults.json");
        let list = VaultList::default();
        save_at(&path, &list).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn anchor_namespace_used() {
        let result = preferred_app_config_path("vaults.json").unwrap();
        let path_str = result.to_str().unwrap();
        assert!(
            path_str.contains("com.anchor.app"),
            "config path must use anchor namespace, got: {path_str}"
        );
    }

    #[test]
    fn missing_external_writer_is_omitted_from_json() {
        let list = VaultList {
            vaults: vec![VaultRegistryEntry {
                label: "Plain".to_string(),
                path: "/tmp/v".to_string(),
                external_writer: None,
                workspace_root: None,
                role: None,
            }],
            active_vault: None,
            hidden_defaults: vec![],
        };
        let json = serde_json::to_string(&list).unwrap();
        assert!(
            !json.contains("external_writer"),
            "None external_writer should be omitted"
        );
        assert!(
            !json.contains("workspace_root"),
            "None workspace_root should be omitted"
        );
        assert!(!json.contains("\"role\""), "None role should be omitted");
    }

    #[test]
    fn external_writer_policy_blocks_registered_delegated_vault() {
        let list = VaultList {
            vaults: vec![VaultRegistryEntry {
                label: "Obsidian".to_string(),
                path: "/tmp/obsidian".to_string(),
                external_writer: Some("mcp-obsidian".to_string()),
                workspace_root: None,
                role: None,
            }],
            active_vault: None,
            hidden_defaults: vec![],
        };

        assert_eq!(
            external_writer_for_path(&list, "/tmp/obsidian").as_deref(),
            Some("mcp-obsidian")
        );
        assert!(external_writer_for_path(&list, "/tmp/plain").is_none());
    }
}
