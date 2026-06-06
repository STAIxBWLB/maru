// Workspace detection: detect `workspace.config.yaml` and register private
// plus optional public workspace roots in one transaction.
//
// Standalone single-folder workspaces still work — this module is a no-op
// for any folder lacking the YAML.

use crate::anchor_dir::{ensure_anchor_dir, set_owner_name, set_paired_vault_path};
use crate::vault_list::{
    list_workspace_roots, set_active_workspace_root, upsert_workspace_root,
    ProviderPermissionSummary, WorkspaceCapabilities, WorkspaceRegistry, WorkspaceRootEntry,
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
    /// Absolute, canonicalized path to the directory containing the config.
    pub work_path: String,
    /// Absolute path to `workspace.config.yaml`.
    pub config_path: String,
    pub config: WorkspaceConfig,
    /// Resolved private workspace path. Tilde (`~/`) expansion is applied;
    /// if the resolved path doesn't exist we surface it anyway so the UI can warn.
    pub resolved_private_path: Option<String>,
    pub resolved_private_exists: bool,
    /// Resolved public workspace path. Public is optional; if absent, Anchor
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
    map.get(&Value::String(key.to_string()))
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

fn resolve_config_path(raw: Option<&str>) -> (Option<String>, bool) {
    match raw {
        Some(raw) if !raw.trim().is_empty() => {
            let expanded = expand_tilde(raw.trim());
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
    let (resolved_private_path, resolved_private_exists) = resolve_config_path(Some(&private_raw));
    let (resolved_public_path, resolved_public_exists) = resolve_config_path(public_raw.as_deref());
    let public_workspaces = public_specs
        .iter()
        .map(|spec| {
            let (path, exists) = resolve_config_path(Some(&spec.path));
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
/// 3. Bootstrap `<private>/.anchor/`.
/// 4. Upsert the private root.
/// 5. If a public root resolves to a real directory, upsert it.
/// 6. Stamp public path + owner_name into `.anchor/workspace.json`.
/// 7. Set the active private root.
///
/// Idempotent — re-running the same call yields the same registry state.
#[tauri::command]
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

    // Bootstrap .anchor/ before touching the registry — if it fails the
    // registry stays untouched.
    ensure_anchor_dir(&private_path)?;

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

    upsert_workspace_root(WorkspaceRootEntry {
        label: private_label,
        path: private.clone(),
        visibility: "private".to_string(),
        provider: "local".to_string(),
        provider_id: None,
        external_writer: None,
        write_policy: "direct".to_string(),
        permission_summary: None,
    })?;

    let mut registered_public_paths: Vec<String> = Vec::new();
    if let Some(detected) = detected.as_ref() {
        for public in detected
            .public_workspaces
            .iter()
            .filter(|workspace| workspace.exists)
        {
            let role = public.role.clone();
            upsert_workspace_root(WorkspaceRootEntry {
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
            })?;
            registered_public_paths.push(public.path.clone());
        }
    }
    if let Some(first_public) = registered_public_paths.first() {
        set_active_workspace_root(first_public.clone(), "public".to_string())?;
    }
    let public_workspace_path = registered_public_paths.first().cloned();

    // Stamp anchor's workspace meta with the optional public root + owner.
    set_paired_vault_path(&private_path, public_workspace_path.clone())?;
    if let Some(owner) = detected
        .as_ref()
        .and_then(|d| d.config.owner.as_ref())
        .and_then(|o| o.name.clone())
    {
        set_owner_name(&private_path, Some(owner))?;
    }

    let workspace_registry = set_active_workspace_root(private.clone(), "private".to_string())?;

    Ok(RegisterOutcome {
        workspace_registry,
        private_workspace_path: private,
        public_workspace_path,
    })
}

/// Surface workspace-shaped registry data for settings and diagnostics.
#[tauri::command]
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
