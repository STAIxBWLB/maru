// Workspace detection: detect `workspace.config.yaml` and register private
// plus optional public workspace roots in one transaction.
//
// Standalone single-folder workspaces still work — this module is a no-op
// for any folder lacking the YAML.

use crate::atomic_file::{with_path_transactions, PathTransactionLease, PathTransactionRequest};
use crate::maru_dir::{ensure_maru_dir, set_owner_name, set_paired_vault_path};
use crate::vault_list::{
    legacy_vault_list_path, list_workspace_roots, set_active_workspace_root_in_transaction,
    upsert_workspace_root_in_transaction, workspace_registry_path, ProviderPermissionSummary,
    WorkspaceCapabilities, WorkspaceRegistry, WorkspaceRootEntry,
};
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
    #[serde(default)]
    pub private: Option<Value>,
    #[serde(default)]
    pub public: Option<Value>,
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

/// User's `workspace.config.yaml`. We only model the fields maru cares
/// about (paths, owner, ssot map, skills hint, inbox). Unknown keys are
/// captured in `extra` so future round-trips don't lose data — but
/// maru never writes back to this file (it's the user's SSOT).
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
    /// Absolute, canonicalized path to the directory containing the config.
    pub work_path: String,
    /// Absolute path to `workspace.config.yaml`.
    pub config_path: String,
    pub config: WorkspaceConfig,
    /// Resolved private workspace path. Tilde (`~/`) expansion is applied;
    /// if the resolved path doesn't exist we surface it anyway so the UI can warn.
    pub resolved_private_path: Option<String>,
    pub resolved_private_exists: bool,
    /// Resolved public workspace path. Public is optional; if absent, Maru
    /// still boots and edits the private workspace normally.
    /// If the resolved path doesn't exist
    /// we surface it anyway so the UI can warn.
    pub resolved_public_path: Option<String>,
    pub resolved_public_exists: bool,
    #[serde(default)]
    pub public_workspaces: Vec<DetectedPublicWorkspace>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedPublicWorkspace {
    pub label: String,
    pub path: String,
    pub exists: bool,
    pub provider: String,
    pub provider_id: Option<String>,
    pub external_writer: Option<String>,
    pub write_policy: String,
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterOutcome {
    pub workspace_registry: WorkspaceRegistry,
    pub private_workspace_path: String,
    pub public_workspace_path: Option<String>,
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

fn first_path_value(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(raw)) if !raw.trim().is_empty() => Some(raw.trim().to_string()),
        Some(Value::Sequence(items)) => items.iter().find_map(|item| match item {
            Value::String(raw) if !raw.trim().is_empty() => Some(raw.trim().to_string()),
            _ => None,
        }),
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct PublicWorkspaceSpec {
    label: Option<String>,
    path: String,
    provider: String,
    provider_id: Option<String>,
    external_writer: Option<String>,
    write_policy: String,
    role: Option<String>,
}

fn mapping_string(map: &serde_yaml::Mapping, key: &str) -> Option<String> {
    map.get(Value::String(key.to_string()))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn spec_from_public_value(value: &Value) -> Option<PublicWorkspaceSpec> {
    match value {
        Value::String(path) if !path.trim().is_empty() => Some(PublicWorkspaceSpec {
            label: None,
            path: path.trim().to_string(),
            provider: "local".to_string(),
            provider_id: None,
            external_writer: None,
            write_policy: "direct".to_string(),
            role: None,
        }),
        Value::Mapping(map) => {
            let path = mapping_string(map, "path")?;
            Some(PublicWorkspaceSpec {
                label: mapping_string(map, "label"),
                path,
                provider: mapping_string(map, "provider").unwrap_or_else(|| "unknown".to_string()),
                provider_id: mapping_string(map, "providerId")
                    .or_else(|| mapping_string(map, "provider_id")),
                external_writer: mapping_string(map, "externalWriter")
                    .or_else(|| mapping_string(map, "external_writer")),
                write_policy: mapping_string(map, "writePolicy")
                    .or_else(|| mapping_string(map, "write_policy"))
                    .unwrap_or_else(|| "direct".to_string()),
                role: mapping_string(map, "role"),
            })
        }
        _ => None,
    }
}

fn public_specs_from_config(config: &WorkspaceConfig) -> Vec<PublicWorkspaceSpec> {
    if let Some(public) = config.paths.public.as_ref() {
        return match public {
            Value::Sequence(items) => items.iter().filter_map(spec_from_public_value).collect(),
            other => spec_from_public_value(other).into_iter().collect(),
        };
    }
    config
        .paths
        .vault
        .as_ref()
        .map(|path| PublicWorkspaceSpec {
            label: Some("Public".to_string()),
            path: path.clone(),
            provider: "obsidian".to_string(),
            provider_id: None,
            external_writer: Some("mcp-obsidian".to_string()),
            write_policy: "delegated".to_string(),
            role: None,
        })
        .into_iter()
        .collect()
}

fn resolve_config_path(raw: Option<&str>, base: &Path) -> (Option<String>, bool) {
    match raw {
        Some(raw) if !raw.trim().is_empty() => {
            let expanded = expand_tilde(raw.trim());
            // Relative values (e.g. `vault`) are relative to the config file's
            // directory, not the process cwd (maru-vault-graph-spec §5.1).
            let expanded = if expanded.is_relative() {
                base.join(expanded)
            } else {
                expanded
            };
            let exists = expanded.exists();
            let canonical = if exists {
                canonicalize_or_self(&expanded)
            } else {
                expanded
            };
            (Some(canonical.to_string_lossy().to_string()), exists)
        }
        _ => (None, false),
    }
}

fn read_workspace_config_at(path: &Path) -> Result<WorkspaceConfig, String> {
    let content = fs::read_to_string(path)
        .map_err(|err| format!("Cannot read workspace.config.yaml: {err}"))?;
    let mut config: WorkspaceConfig = serde_yaml::from_str(&content)
        .map_err(|err| format!("Cannot parse workspace.config.yaml: {err}"))?;
    // Sanitize: strip known string path whitespace.
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
    let private_raw = first_path_value(config.paths.private.as_ref())
        .or_else(|| config.paths.primary.clone())
        .unwrap_or_else(|| work_path.to_string_lossy().to_string());
    let public_specs = public_specs_from_config(&config);
    let public_raw = public_specs.first().map(|spec| spec.path.clone());
    let (resolved_private_path, resolved_private_exists) =
        resolve_config_path(Some(&private_raw), work_path);
    let (resolved_public_path, resolved_public_exists) =
        resolve_config_path(public_raw.as_deref(), work_path);
    let public_workspaces = public_specs
        .iter()
        .map(|spec| {
            let (path, exists) = resolve_config_path(Some(&spec.path), work_path);
            let path = path.unwrap_or_else(|| spec.path.clone());
            let label = spec.label.clone().unwrap_or_else(|| {
                Path::new(&path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Public")
                    .to_string()
            });
            DetectedPublicWorkspace {
                label,
                path,
                exists,
                provider: spec.provider.clone(),
                provider_id: spec.provider_id.clone(),
                external_writer: spec.external_writer.clone(),
                write_policy: spec.write_policy.clone(),
                role: spec.role.clone(),
            }
        })
        .collect();
    Ok(Some(WorkspaceDetect {
        work_path: work_path.to_string_lossy().to_string(),
        config_path: config_path.to_string_lossy().to_string(),
        config,
        resolved_private_path,
        resolved_private_exists,
        resolved_public_path,
        resolved_public_exists,
        public_workspaces,
    }))
}

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
pub fn read_workspace_config(work_path: String) -> Result<WorkspaceConfig, String> {
    let work = canonicalize_or_self(&PathBuf::from(&work_path));
    let config_path = work.join(CONFIG_FILE);
    if !config_path.exists() {
        return Err(format!(
            "workspace.config.yaml not found at {}",
            config_path.display()
        ));
    }
    read_workspace_config_at(&config_path)
}

/// Register private plus optional public workspace roots atomically.
///
/// 1. Canonicalize the config directory. Required — must exist.
/// 2. If `workspace.config.yaml` is present, parse owner / paths.
/// 3. Bootstrap `<private>/.maru/`.
/// 4. Upsert the private root.
/// 5. If a public root resolves to a real directory, upsert it.
/// 6. Stamp public path + owner_name into `.maru/workspace.json`.
/// 7. Set the active private root.
///
/// Idempotent — re-running the same call yields the same registry state.
pub fn register_workspace_roots(work_path: String) -> Result<RegisterOutcome, String> {
    let raw = PathBuf::from(&work_path);
    if !raw.exists() {
        return Err(format!("Work path does not exist: {work_path}"));
    }
    let config_root = canonicalize_or_self(&raw);

    let detected = detect_at(&config_root)?;
    let private = detected
        .as_ref()
        .and_then(|d| {
            if d.resolved_private_exists {
                d.resolved_private_path.clone()
            } else {
                None
            }
        })
        .unwrap_or_else(|| config_root.to_string_lossy().to_string());
    let private_path = PathBuf::from(&private);

    // Admit the whole flow up front: the private `.maru/` skeleton, its
    // `.maruignore`, and the workspace registry the upserts rewrite. The
    // registry write set comes from the same resolution the upserts use, so
    // no nested mutation escapes the admitted set.
    let admission = PathTransactionRequest::new([
        private_path.join(".maru"),
        private_path.join(".maruignore"),
        workspace_registry_path()?,
        legacy_vault_list_path()?,
    ])?
    .require_parent(&private_path)?
    .with_workspace_registry()?;
    with_path_transactions(admission, |lease| {
        lease.ensure_workspace_registry()?;
        lease.ensure_covered([
            workspace_registry_path()?,
            private_path.join(".maru"),
            private_path.join(".maruignore"),
        ])?;
        lease.before_effect()?;
        register_workspace_roots_in_transaction(&private_path, detected, lease)
    })
}

fn register_workspace_roots_in_transaction(
    private_path: &Path,
    detected: Option<WorkspaceDetect>,
    lease: &PathTransactionLease,
) -> Result<RegisterOutcome, String> {
    lease.ensure_covered([
        workspace_registry_path()?,
        private_path.join(".maru"),
        private_path.join(".maruignore"),
    ])?;
    let private = private_path.to_string_lossy().to_string();

    // Bootstrap .maru/ before touching the registry — if it fails the
    // registry stays untouched.
    ensure_maru_dir(private_path)?;

    // Derive labels. Prefer config owner.name when registering the work
    // half (label tells the user which workspace it is); fall back to
    // the directory name.
    let private_label = detected
        .as_ref()
        .and_then(|d| d.config.owner.as_ref())
        .and_then(|o| o.name.clone())
        .unwrap_or_else(|| {
            private_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("workspace")
                .to_string()
        });

    upsert_workspace_root_in_transaction(
        WorkspaceRootEntry {
            label: private_label,
            path: private.clone(),
            visibility: "private".to_string(),
            provider: "local".to_string(),
            provider_id: None,
            external_writer: None,
            write_policy: "direct".to_string(),
            permission_summary: None,
        },
        lease,
    )?;

    let mut registered_public_paths: Vec<String> = Vec::new();
    if let Some(detected) = detected.as_ref() {
        for public in detected
            .public_workspaces
            .iter()
            .filter(|workspace| workspace.exists)
        {
            let role = public.role.clone();
            upsert_workspace_root_in_transaction(
                WorkspaceRootEntry {
                    label: public.label.clone(),
                    path: public.path.clone(),
                    visibility: "public".to_string(),
                    provider: public.provider.clone(),
                    provider_id: public.provider_id.clone(),
                    external_writer: public.external_writer.clone(),
                    write_policy: public.write_policy.clone(),
                    permission_summary: role.map(|role| ProviderPermissionSummary {
                        role: Some(role),
                        source: "manual".to_string(),
                        checked_at: None,
                        capabilities: WorkspaceCapabilities::default(),
                        warning: None,
                    }),
                },
                lease,
            )?;
            registered_public_paths.push(public.path.clone());
        }
    }
    if let Some(first_public) = registered_public_paths.first() {
        set_active_workspace_root_in_transaction(
            first_public.clone(),
            "public".to_string(),
            lease,
        )?;
    }
    let public_workspace_path = registered_public_paths.first().cloned();

    // Stamp maru's workspace meta with the optional public root + owner.
    set_paired_vault_path(private_path, public_workspace_path.clone())?;
    if let Some(owner) = detected
        .as_ref()
        .and_then(|d| d.config.owner.as_ref())
        .and_then(|o| o.name.clone())
    {
        set_owner_name(private_path, Some(owner))?;
    }

    let workspace_registry =
        set_active_workspace_root_in_transaction(private.clone(), "private".to_string(), lease)?;

    Ok(RegisterOutcome {
        workspace_registry,
        private_workspace_path: private,
        public_workspace_path,
    })
}

/// Surface workspace-shaped registry data for settings and diagnostics.
pub fn list_workspaces() -> Result<Vec<WorkspaceSummary>, String> {
    let registry = list_workspace_roots()?;
    let mut by_root: BTreeMap<String, WorkspaceSummary> = BTreeMap::new();
    for entry in registry.workspaces {
        let root = entry.path.clone();
        let summary = by_root
            .entry(root.clone())
            .or_insert_with(|| WorkspaceSummary {
                root: root.clone(),
                private_label: None,
                private_path: None,
                public_label: None,
                public_path: None,
            });
        match entry.visibility.as_str() {
            "private" => {
                summary.private_label = Some(entry.label.clone());
                summary.private_path = Some(entry.path.clone());
            }
            "public" => {
                summary.public_label = Some(entry.label.clone());
                summary.public_path = Some(entry.path.clone());
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
    pub private_label: Option<String>,
    pub private_path: Option<String>,
    pub public_label: Option<String>,
    pub public_path: Option<String>,
}

/// Owned IPC boundaries; the synchronous entry points remain available to
/// Rust callers.
pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn detect_workspace(path: String) -> Result<Option<WorkspaceDetect>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&path)], "worker:detect_workspace");
            super::detect_workspace(path)
        })
        .await
        .map_err(|err| format!("detect_workspace_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn read_workspace_config(work_path: String) -> Result<WorkspaceConfig, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:read_workspace_config",
            );
            super::read_workspace_config(work_path)
        })
        .await
        .map_err(|err| format!("read_workspace_config_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn register_workspace_roots(work_path: String) -> Result<RegisterOutcome, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:register_workspace_roots",
            );
            super::register_workspace_roots(work_path)
        })
        .await
        .map_err(|err| format!("register_workspace_roots_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn list_workspaces() -> Result<Vec<WorkspaceSummary>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            if let Ok(registry) = crate::vault_list::workspace_registry_path() {
                PathTransactionLease::test_stage(&[registry], "worker:list_workspaces");
            }
            super::list_workspaces()
        })
        .await
        .map_err(|err| format!("list_workspaces_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_minimal_config(work: &Path, public_path: Option<&Path>) {
        let public_line = match public_path {
            Some(v) => format!("  vault: {}\n", v.display()),
            None => String::new(),
        };
        let yaml = format!(
            "version: 1\nowner:\n  name: 이영준\npaths:\n  primary: {}\n{}ssot:\n  rules: {}/_sys/rules\n",
            work.display(),
            public_line,
            work.display()
        );
        fs::write(work.join("workspace.config.yaml"), yaml).unwrap();
    }

    #[test]
    fn detect_resolves_relative_vault_against_config_dir() {
        // Post-Wave-0 config uses `vault:` relative to the workspace root
        // (spec §5.1) — must join against the config-file dir, not cwd.
        let work_tmp = TempDir::new().unwrap();
        fs::create_dir_all(work_tmp.path().join("vault")).unwrap();
        let yaml = format!(
            "version: 1\npaths:\n  primary: {}\n  vault: vault\n",
            work_tmp.path().display()
        );
        fs::write(work_tmp.path().join("workspace.config.yaml"), yaml).unwrap();
        let detected = detect_workspace(work_tmp.path().to_string_lossy().to_string())
            .unwrap()
            .expect("config must be detected");
        assert!(detected.resolved_public_exists);
        let resolved = detected.resolved_public_path.expect("vault path resolved");
        assert!(
            resolved.ends_with("/vault") || resolved.ends_with("\\vault"),
            "resolved {resolved} should end with /vault"
        );
        assert!(Path::new(&resolved).is_absolute());
    }

    #[test]
    fn detect_returns_none_for_plain_folder() {
        let tmp = TempDir::new().unwrap();
        let result = detect_workspace(tmp.path().to_string_lossy().to_string()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn detect_returns_some_with_legacy_public_workspace() {
        let work_tmp = TempDir::new().unwrap();
        let public_tmp = TempDir::new().unwrap();
        write_minimal_config(work_tmp.path(), Some(public_tmp.path()));
        let detected = detect_workspace(work_tmp.path().to_string_lossy().to_string())
            .unwrap()
            .expect("workspace.config.yaml must be detected");
        assert_eq!(detected.config.version, 1);
        assert_eq!(
            detected
                .config
                .owner
                .as_ref()
                .and_then(|o| o.name.as_deref()),
            Some("이영준")
        );
        assert!(detected.resolved_private_exists);
        assert!(detected.resolved_private_path.is_some());
        assert!(detected.resolved_public_exists);
        assert!(detected.resolved_public_path.is_some());
    }

    #[test]
    fn detect_supports_optional_public_workspace() {
        let work_tmp = TempDir::new().unwrap();
        let yaml = format!(
            "version: 1\npaths:\n  private: {}\n",
            work_tmp.path().display()
        );
        fs::write(work_tmp.path().join("workspace.config.yaml"), yaml).unwrap();

        let detected = detect_workspace(work_tmp.path().to_string_lossy().to_string())
            .unwrap()
            .unwrap();

        assert!(detected.resolved_private_exists);
        assert!(detected.resolved_public_path.is_none());
        assert!(!detected.resolved_public_exists);
    }

    #[test]
    fn detect_parses_multiple_public_workspace_objects() {
        let work_tmp = TempDir::new().unwrap();
        let drive_tmp = TempDir::new().unwrap();
        let sharepoint_tmp = TempDir::new().unwrap();
        let yaml = format!(
            "version: 1\npaths:\n  private: {}\n  public:\n    - label: Drive Shared\n      path: {}\n      provider: googleDrive\n      providerId: drive-1\n      writePolicy: direct\n      role: contentManager\n    - label: Team Site\n      path: {}\n      provider: sharePoint\n      writePolicy: readOnly\n      role: Can view\n",
            work_tmp.path().display(),
            drive_tmp.path().display(),
            sharepoint_tmp.path().display(),
        );
        fs::write(work_tmp.path().join("workspace.config.yaml"), yaml).unwrap();

        let detected = detect_workspace(work_tmp.path().to_string_lossy().to_string())
            .unwrap()
            .unwrap();

        assert_eq!(detected.public_workspaces.len(), 2);
        let canonical_drive = drive_tmp.path().canonicalize().unwrap();
        assert_eq!(
            detected.resolved_public_path.as_deref(),
            Some(canonical_drive.to_str().unwrap())
        );
        assert_eq!(detected.public_workspaces[0].provider, "googleDrive");
        assert_eq!(
            detected.public_workspaces[0].provider_id.as_deref(),
            Some("drive-1")
        );
        assert_eq!(
            detected.public_workspaces[0].role.as_deref(),
            Some("contentManager")
        );
        assert_eq!(detected.public_workspaces[1].provider, "sharePoint");
        assert_eq!(detected.public_workspaces[1].write_policy, "readOnly");
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

#[cfg(test)]
mod phase08_22 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use std::sync::mpsc::Receiver;
    use std::time::Duration;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn write_minimal_config(work: &Path, public_path: Option<&Path>) {
        let public_line = match public_path {
            Some(v) => format!("  vault: {}\n", v.display()),
            None => String::new(),
        };
        let yaml = format!(
            "version: 1\nowner:\n  name: 이영준\npaths:\n  primary: {}\n{}ssot:\n  rules: {}/_sys/rules\n",
            work.display(),
            public_line,
            work.display()
        );
        fs::write(work.join("workspace.config.yaml"), yaml).unwrap();
    }

    fn start<F, T>(future: F) -> Receiver<T>
    where
        F: std::future::Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }

    fn done<T>(rx: Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("fixture completion")
    }

    #[test]
    fn phase08_22_workspace_wrappers_yield_same_poll_and_map_join_failure() {
        let home = Home::new();
        let work_path = home.root.path().join("boundary");
        fs::create_dir_all(&work_path).unwrap();
        let work = text(&work_path);
        let registry = workspace_registry_path().unwrap();
        boundary(
            work_path.clone().into(),
            "detect_workspace",
            ipc::detect_workspace(work.clone()),
        );
        boundary(
            work_path.clone().into(),
            "read_workspace_config",
            ipc::read_workspace_config(work.clone()),
        );
        boundary(
            work_path.clone().into(),
            "register_workspace_roots",
            ipc::register_workspace_roots(work),
        );
        boundary(registry.into(), "list_workspaces", ipc::list_workspaces());
    }

    #[test]
    fn phase08_22_workspace_real_fixture_results_and_rejections() {
        let home = Home::new();
        let work_path = home.root.path().join("fixture");
        let public_path = home.root.path().join("fixture-public");
        fs::create_dir_all(&work_path).unwrap();
        fs::create_dir_all(&public_path).unwrap();
        write_minimal_config(&work_path, Some(&public_path));
        let work = text(&work_path);

        let detected = run(ipc::detect_workspace(work.clone())).unwrap().unwrap();
        assert_eq!(detected.config.version, 1);
        assert!(detected.resolved_private_exists);
        assert!(detected.resolved_public_exists);

        let config = run(ipc::read_workspace_config(work.clone())).unwrap();
        assert_eq!(config.version, 1);

        let outcome = run(ipc::register_workspace_roots(work.clone())).unwrap();
        let private_canonical = text(&work_path.canonicalize().unwrap());
        let public_canonical = text(&public_path.canonicalize().unwrap());
        assert_eq!(outcome.private_workspace_path, private_canonical);
        assert_eq!(
            outcome.public_workspace_path.as_deref(),
            Some(public_canonical.as_str())
        );
        assert_eq!(
            outcome
                .workspace_registry
                .active_by_visibility
                .private
                .as_deref(),
            Some(private_canonical.as_str())
        );
        assert_eq!(
            outcome
                .workspace_registry
                .active_by_visibility
                .public
                .as_deref(),
            Some(public_canonical.as_str())
        );

        let meta = crate::maru_dir::ipc::read_maru_workspace(work.clone());
        let meta = run(meta).unwrap();
        assert_eq!(
            meta.paired_vault_path.as_deref(),
            Some(public_canonical.as_str())
        );
        assert_eq!(meta.owner_name.as_deref(), Some("이영준"));

        let summaries = run(ipc::list_workspaces()).unwrap();
        assert_eq!(summaries.len(), 2);
        assert!(summaries
            .iter()
            .any(|summary| summary.private_path.as_deref() == Some(private_canonical.as_str())));
        assert!(summaries
            .iter()
            .any(|summary| summary.public_path.as_deref() == Some(public_canonical.as_str())));

        // Unchanged rejections.
        let missing = text(&home.root.path().join("missing"));
        assert!(run(ipc::detect_workspace(missing))
            .unwrap_err()
            .contains("Path does not exist"));
        let plain = home.root.path().join("plain");
        fs::create_dir_all(&plain).unwrap();
        assert!(run(ipc::read_workspace_config(text(&plain)))
            .unwrap_err()
            .contains("workspace.config.yaml not found"));
        // Standalone folders keep their existing behavior: registration
        // bootstraps .maru/ and registers the folder as the private root.
        let standalone = run(ipc::register_workspace_roots(text(&plain))).unwrap();
        assert_eq!(
            standalone.private_workspace_path,
            text(&plain.canonicalize().unwrap())
        );
    }

    #[test]
    fn phase08_22_register_serializes_with_concurrent_add_both_orders() {
        let home = Home::new();
        for swap in [false, true] {
            let work_path = home.root.path().join(format!("reg-{swap}"));
            fs::create_dir_all(&work_path).unwrap();
            write_minimal_config(&work_path, None);
            let extra_root = home.root.path().join(format!("reg-extra-{swap}"));
            fs::create_dir_all(&extra_root).unwrap();
            let registry = workspace_registry_path().unwrap();
            let extra_entry = WorkspaceRootEntry {
                label: "Extra".to_string(),
                path: text(&extra_root),
                visibility: "private".to_string(),
                provider: "local".to_string(),
                provider_id: None,
                external_writer: None,
                write_policy: "direct".to_string(),
                permission_summary: None,
            };
            let work = text(&work_path);

            let admitted = Held::new(registry.clone(), "admitted");
            let first_work = work.clone();
            let first_extra = extra_entry.clone();
            let first: Receiver<Result<(), String>> = if swap {
                start(async move {
                    crate::vault_list::ipc::add_workspace_root(first_extra)
                        .await
                        .map(|_| ())
                })
            } else {
                start(async move { ipc::register_workspace_roots(first_work).await.map(|_| ()) })
            };
            admitted.wait();
            let waiting = Held::new(registry.clone(), "before-admission");
            let second: Receiver<Result<(), String>> = if swap {
                start(async move { ipc::register_workspace_roots(work).await.map(|_| ()) })
            } else {
                start(async move {
                    crate::vault_list::ipc::add_workspace_root(extra_entry)
                        .await
                        .map(|_| ())
                })
            };
            waiting.wait();
            waiting.release();
            assert!(
                second.recv_timeout(Duration::from_millis(30)).is_err(),
                "registry writer must wait while the other holds admission"
            );
            admitted.release();
            done(first).unwrap();
            done(second).unwrap();

            let listed = crate::vault_list::load_registry().unwrap();
            let paths: Vec<&str> = listed
                .workspaces
                .iter()
                .map(|entry| entry.path.as_str())
                .collect();
            let private_canonical = text(&work_path.canonicalize().unwrap());
            assert!(
                paths.contains(&private_canonical.as_str()),
                "registered private root must survive the concurrent add"
            );
            assert!(
                paths.contains(&text(&extra_root).as_str()),
                "concurrently added root must not be overwritten"
            );
        }
    }

    #[test]
    fn phase08_22_register_error_releases_admission_and_retry_recovers() {
        let home = Home::new();
        let work_path = home.root.path().join("reg-error");
        fs::create_dir_all(&work_path).unwrap();
        write_minimal_config(&work_path, None);
        // Block .maru bootstrap: the resolved private root is the work path
        // itself, so a file at <work>/.maru fails ensure_maru_dir.
        fs::write(work_path.join(".maru"), "not a directory").unwrap();
        let err = run(ipc::register_workspace_roots(text(&work_path))).unwrap_err();
        assert!(err.contains("Cannot create .maru"), "{err}");
        let registry = workspace_registry_path().unwrap();
        assert!(
            !registry.exists(),
            "registry must stay untouched when bootstrap fails"
        );
        fs::remove_file(work_path.join(".maru")).unwrap();
        run(ipc::register_workspace_roots(text(&work_path))).unwrap();
        assert!(work_path.join(".maru/workspace.json").exists());
    }
}
