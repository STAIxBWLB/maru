// Workspace pairing: detect `workspace.config.yaml` and register
// `(work, vault)` as paired vault registry entries in one transaction.
//
// The user's `~/workspace/work/` is the SSOT root that pairs with
// `~/workspace/vault/` via `paths.vault` inside `workspace.config.yaml`.
// Standalone single-folder vaults still work — this module is a no-op
// for any folder lacking the YAML.

use crate::anchor_dir::{ensure_anchor_dir, set_owner_name, set_paired_vault_path};
use crate::vault_list::{list_vaults, set_active_vault, upsert_vault, VaultList, VaultRegistryEntry};
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const CONFIG_FILE: &str = "workspace.config.yaml";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkspacePaths {
    #[serde(default)]
    pub primary: Option<String>,
    #[serde(default)]
    pub vault: Option<String>,
    #[serde(default)]
    pub mirror: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkspaceOwner {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub affiliation: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<String>,
    #[serde(default)]
    pub emails: BTreeMap<String, String>,
    #[serde(default)]
    pub github: Option<String>,
}

/// User's `workspace.config.yaml`. We only model the fields anchor cares
/// about (paths, owner, ssot map, skills hint, inbox). Unknown keys are
/// captured in `extra` so future round-trips don't lose data — but
/// anchor never writes back to this file (it's the user's SSOT).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub version: u32,
    #[serde(default)]
    pub owner: Option<WorkspaceOwner>,
    pub paths: WorkspacePaths,
    #[serde(default)]
    pub ssot: BTreeMap<String, String>,
    #[serde(default)]
    pub skills: BTreeMap<String, Value>,
    #[serde(default)]
    pub inbox: BTreeMap<String, Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDetect {
    /// Absolute, canonicalized path to the work root.
    pub work_path: String,
    /// Absolute path to `workspace.config.yaml`.
    pub config_path: String,
    pub config: WorkspaceConfig,
    /// Resolved vault path if `paths.vault` is set and exists. Tilde
    /// (`~/`) expansion is applied; if the resolved path doesn't exist
    /// we surface it anyway so the UI can warn.
    pub resolved_vault_path: Option<String>,
    pub resolved_vault_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterOutcome {
    pub vault_list: VaultList,
    pub work_path: String,
    pub paired_vault_path: Option<String>,
}

fn expand_tilde(input: &str) -> PathBuf {
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if input == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(input)
}

fn canonicalize_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn read_workspace_config_at(path: &Path) -> Result<WorkspaceConfig, String> {
    let content =
        fs::read_to_string(path).map_err(|err| format!("Cannot read workspace.config.yaml: {err}"))?;
    let mut config: WorkspaceConfig =
        serde_yaml::from_str(&content).map_err(|err| format!("Cannot parse workspace.config.yaml: {err}"))?;
    // Sanitize: strip any `paths.primary`/`paths.vault` whitespace.
    if let Some(p) = config.paths.primary.as_mut() {
        *p = p.trim().to_string();
    }
    if let Some(v) = config.paths.vault.as_mut() {
        *v = v.trim().to_string();
    }
    if let Some(m) = config.paths.mirror.as_mut() {
        *m = m.trim().to_string();
    }
    Ok(config)
}

fn detect_at(work_path: &Path) -> Result<Option<WorkspaceDetect>, String> {
    let config_path = work_path.join(CONFIG_FILE);
    if !config_path.exists() {
        return Ok(None);
    }
    let config = read_workspace_config_at(&config_path)?;
    let (resolved_vault_path, resolved_vault_exists) = match config.paths.vault.as_deref() {
        Some(raw) if !raw.is_empty() => {
            let expanded = expand_tilde(raw);
            let exists = expanded.exists();
            let canonical = if exists {
                canonicalize_or_self(&expanded)
            } else {
                expanded
            };
            (Some(canonical.to_string_lossy().to_string()), exists)
        }
        _ => (None, false),
    };
    Ok(Some(WorkspaceDetect {
        work_path: work_path.to_string_lossy().to_string(),
        config_path: config_path.to_string_lossy().to_string(),
        config,
        resolved_vault_path,
        resolved_vault_exists,
    }))
}

#[tauri::command]
pub fn detect_workspace(path: String) -> Result<Option<WorkspaceDetect>, String> {
    let raw = PathBuf::from(&path);
    if !raw.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    let canonical = canonicalize_or_self(&raw);
    detect_at(&canonical)
}

/// Read `workspace.config.yaml` from a known work path. Errors if the
/// file is missing — used after `detect_workspace` returned Some, so
/// missing here means a race / external delete.
#[tauri::command]
pub fn read_workspace_config(work_path: String) -> Result<WorkspaceConfig, String> {
    let work = canonicalize_or_self(&PathBuf::from(&work_path));
    let config_path = work.join(CONFIG_FILE);
    if !config_path.exists() {
        return Err(format!("workspace.config.yaml not found at {}", config_path.display()));
    }
    read_workspace_config_at(&config_path)
}

/// Register a (work, vault) pair atomically.
///
/// 1. Canonicalize `work_path`. Required — must exist.
/// 2. If `workspace.config.yaml` is present, parse owner / paths.
/// 3. Bootstrap `<work>/.anchor/`.
/// 4. Upsert work-role entry into the vault list.
/// 5. If `paths.vault` resolves to a real directory, upsert vault-role
///    entry with `external_writer = "mcp-obsidian"`.
/// 6. Stamp paired_vault_path + owner_name into `.anchor/workspace.json`.
/// 7. Set active_vault = work.
///
/// Idempotent — re-running the same call yields the same registry state.
#[tauri::command]
pub fn register_workspace_pair(work_path: String) -> Result<RegisterOutcome, String> {
    let raw = PathBuf::from(&work_path);
    if !raw.exists() {
        return Err(format!("Work path does not exist: {work_path}"));
    }
    let work = canonicalize_or_self(&raw);
    let work_str = work.to_string_lossy().to_string();

    let detected = detect_at(&work)?;

    // Bootstrap .anchor/ before touching the registry — if it fails the
    // registry stays untouched.
    ensure_anchor_dir(&work)?;

    // Derive labels. Prefer config owner.name when registering the work
    // half (label tells the user which workspace it is); fall back to
    // the directory name.
    let work_label = detected
        .as_ref()
        .and_then(|d| d.config.owner.as_ref())
        .and_then(|o| o.name.clone())
        .unwrap_or_else(|| {
            work.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("workspace")
                .to_string()
        });

    upsert_vault(VaultRegistryEntry {
        label: work_label,
        path: work_str.clone(),
        external_writer: None,
        workspace_root: Some(work_str.clone()),
        role: Some("work".to_string()),
    })?;

    let paired_vault_path = detected
        .as_ref()
        .and_then(|d| {
            if d.resolved_vault_exists {
                d.resolved_vault_path.clone()
            } else {
                None
            }
        });

    if let Some(vault_path) = &paired_vault_path {
        upsert_vault(VaultRegistryEntry {
            label: "vault".to_string(),
            path: vault_path.clone(),
            external_writer: Some("mcp-obsidian".to_string()),
            workspace_root: Some(work_str.clone()),
            role: Some("vault".to_string()),
        })?;
    }

    // Stamp anchor's workspace meta with the paired vault + owner.
    set_paired_vault_path(&work, paired_vault_path.clone())?;
    if let Some(owner) = detected
        .as_ref()
        .and_then(|d| d.config.owner.as_ref())
        .and_then(|o| o.name.clone())
    {
        set_owner_name(&work, Some(owner))?;
    }

    let vault_list = set_active_vault(work_str.clone())?;

    Ok(RegisterOutcome {
        vault_list,
        work_path: work_str,
        paired_vault_path,
    })
}

/// Surface workspace-shaped registry data: which vault entry is the
/// "work" half of a pair, which is the "vault" half, etc. Used by the
/// frontend to decide whether to show System mode and which paired
/// path to display.
#[tauri::command]
pub fn list_workspaces() -> Result<Vec<WorkspaceSummary>, String> {
    let list = list_vaults()?;
    let mut by_root: BTreeMap<String, WorkspaceSummary> = BTreeMap::new();
    for entry in list.vaults {
        let Some(root) = entry.workspace_root.clone() else {
            continue;
        };
        let summary = by_root.entry(root.clone()).or_insert_with(|| {
            WorkspaceSummary {
                root: root.clone(),
                work_label: None,
                work_path: None,
                vault_label: None,
                vault_path: None,
            }
        });
        match entry.role.as_deref() {
            Some("work") => {
                summary.work_label = Some(entry.label.clone());
                summary.work_path = Some(entry.path.clone());
            }
            Some("vault") => {
                summary.vault_label = Some(entry.label.clone());
                summary.vault_path = Some(entry.path.clone());
            }
            _ => {}
        }
    }
    Ok(by_root.into_values().collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub root: String,
    pub work_label: Option<String>,
    pub work_path: Option<String>,
    pub vault_label: Option<String>,
    pub vault_path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_minimal_config(work: &Path, vault_path: Option<&Path>) {
        let vault_line = match vault_path {
            Some(v) => format!("  vault: {}\n", v.display()),
            None => String::new(),
        };
        let yaml = format!(
            "version: 1\nowner:\n  name: 이영준\npaths:\n  primary: {}\n{}ssot:\n  rules: {}/_sys/rules\n",
            work.display(),
            vault_line,
            work.display()
        );
        fs::write(work.join("workspace.config.yaml"), yaml).unwrap();
    }

    #[test]
    fn detect_returns_none_for_plain_folder() {
        let tmp = TempDir::new().unwrap();
        let result = detect_workspace(tmp.path().to_string_lossy().to_string()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn detect_returns_some_with_paired_vault() {
        let work_tmp = TempDir::new().unwrap();
        let vault_tmp = TempDir::new().unwrap();
        write_minimal_config(work_tmp.path(), Some(vault_tmp.path()));
        let detected = detect_workspace(work_tmp.path().to_string_lossy().to_string())
            .unwrap()
            .expect("workspace.config.yaml must be detected");
        assert_eq!(detected.config.version, 1);
        assert_eq!(
            detected.config.owner.as_ref().and_then(|o| o.name.as_deref()),
            Some("이영준")
        );
        assert!(detected.resolved_vault_exists);
        assert!(detected.resolved_vault_path.is_some());
    }

    #[test]
    fn detect_handles_unknown_keys_via_extra() {
        let tmp = TempDir::new().unwrap();
        let yaml = "version: 1\npaths:\n  primary: /tmp\nfuture_key: keepme\n";
        fs::write(tmp.path().join("workspace.config.yaml"), yaml).unwrap();
        let detected = detect_workspace(tmp.path().to_string_lossy().to_string())
            .unwrap()
            .unwrap();
        assert!(detected.config.extra.contains_key("future_key"));
    }
}
