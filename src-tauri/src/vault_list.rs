// Workspace registry. Maru stores registered document roots in
// `<config>/com.maru.app/workspaces.json`. Older builds wrote the same
// concept to `vaults.json`; the loader migrates that shape on first use
// and keeps the old file untouched.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const APP_CONFIG_DIR: &str = "com.maru.app";
const WORKSPACE_REGISTRY_FILE: &str = "workspaces.json";
const LEGACY_VAULTS_FILE: &str = "vaults.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCapabilities {
    pub can_read: bool,
    pub can_create: bool,
    pub can_modify: bool,
    pub can_delete: bool,
    pub can_rename_move: bool,
    pub can_share: bool,
    pub can_manage_members: bool,
}

impl WorkspaceCapabilities {
    fn read_only(can_read: bool) -> Self {
        Self {
            can_read,
            can_create: false,
            can_modify: false,
            can_delete: false,
            can_rename_move: false,
            can_share: false,
            can_manage_members: false,
        }
    }

    fn full(can_read: bool, writable: bool) -> Self {
        Self {
            can_read,
            can_create: can_read && writable,
            can_modify: can_read && writable,
            can_delete: can_read && writable,
            can_rename_move: can_read && writable,
            can_share: can_read && writable,
            can_manage_members: can_read && writable,
        }
    }

    fn intersect(&self, other: &Self) -> Self {
        Self {
            can_read: self.can_read && other.can_read,
            can_create: self.can_create && other.can_create,
            can_modify: self.can_modify && other.can_modify,
            can_delete: self.can_delete && other.can_delete,
            can_rename_move: self.can_rename_move && other.can_rename_move,
            can_share: self.can_share && other.can_share,
            can_manage_members: self.can_manage_members && other.can_manage_members,
        }
    }
}

impl Default for WorkspaceCapabilities {
    fn default() -> Self {
        Self::read_only(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPermissionSummary {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub checked_at: Option<String>,
    #[serde(default)]
    pub capabilities: WorkspaceCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub enum WorkspaceWriteAction {
    Create,
    Modify,
    Delete,
    RenameMove,
    Share,
    ManageMembers,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRootEntry {
    pub label: String,
    pub path: String,
    /// "private" | "public". Public workspaces are optional and may be
    /// read-only, but visibility and write policy stay independent.
    pub visibility: String,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "provider_id"
    )]
    pub provider_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "external_writer"
    )]
    pub external_writer: Option<String>,
    /// "direct" | "delegated" | "readOnly". Derived from external_writer
    /// for legacy imports and v1 add/upsert calls.
    #[serde(default)]
    pub write_policy: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_summary: Option<ProviderPermissionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveByVisibility {
    #[serde(default)]
    pub private: Option<String>,
    #[serde(default)]
    pub public: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRegistry {
    pub workspaces: Vec<WorkspaceRootEntry>,
    #[serde(default)]
    pub active_by_visibility: ActiveByVisibility,
    #[serde(default, alias = "hidden_defaults")]
    pub hidden_defaults: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LegacyVaultList {
    #[serde(default)]
    vaults: Vec<LegacyVaultRegistryEntry>,
    #[serde(default, alias = "active_vault")]
    active_vault: Option<String>,
    #[serde(default, alias = "hidden_defaults")]
    hidden_defaults: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LegacyVaultRegistryEntry {
    label: String,
    path: String,
    #[serde(default, alias = "external_writer")]
    external_writer: Option<String>,
    #[serde(default)]
    workspace_root: Option<String>,
    #[serde(default)]
    role: Option<String>,
}

fn app_config_dir() -> Result<PathBuf, String> {
    dirs::config_dir().ok_or_else(|| "Could not determine config directory".to_string())
}

fn preferred_app_config_path(file_name: &str) -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join(APP_CONFIG_DIR).join(file_name))
}

fn workspace_registry_path() -> Result<PathBuf, String> {
    preferred_app_config_path(WORKSPACE_REGISTRY_FILE)
}

fn legacy_vault_list_path() -> Result<PathBuf, String> {
    preferred_app_config_path(LEGACY_VAULTS_FILE)
}

fn load_registry_at(path: &Path, legacy_path: &Path) -> Result<WorkspaceRegistry, String> {
    if path.exists() {
        let content =
            fs::read_to_string(path).map_err(|e| format!("Failed to read workspace list: {e}"))?;
        let mut registry: WorkspaceRegistry = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse workspace list: {e}"))?;
        normalize_registry(&mut registry);
        return Ok(registry);
    }

    let legacy = load_legacy_at(legacy_path)?;
    let mut registry = migrate_legacy_vault_list(legacy);
    normalize_registry(&mut registry);
    if !registry.workspaces.is_empty() {
        save_registry_at(path, &registry)?;
    }
    Ok(registry)
}

fn load_legacy_at(path: &Path) -> Result<LegacyVaultList, String> {
    if !path.exists() {
        return Ok(LegacyVaultList::default());
    }
    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read legacy vault list: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse legacy vault list: {e}"))
}

fn save_registry_at(path: &Path, registry: &WorkspaceRegistry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(registry)
        .map_err(|e| format!("Failed to serialize workspace list: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Failed to write workspace list: {e}"))
}

pub(crate) fn load_registry() -> Result<WorkspaceRegistry, String> {
    load_registry_at(&workspace_registry_path()?, &legacy_vault_list_path()?)
}

fn comparable_root(path: &str) -> PathBuf {
    let raw = PathBuf::from(path);
    raw.canonicalize().unwrap_or(raw)
}

fn longest_registered_owner<'a>(
    registry: &'a WorkspaceRegistry,
    target: &Path,
) -> Option<&'a WorkspaceRootEntry> {
    registry
        .workspaces
        .iter()
        .filter(|workspace| target.starts_with(comparable_root(&workspace.path)))
        .max_by_key(|workspace| comparable_root(&workspace.path).components().count())
}

/// Reject a document mutation routed through a parent workspace when the
/// target belongs to a more-specific registered root. This is deliberately a
/// lexical/registered-root check: symlinks intentionally mounted inside a
/// workspace remain part of that workspace unless their lexical path is also
/// registered as a nested root (README invariant #5).
pub fn assert_document_owner(caller_root: &str, target: &Path) -> Result<(), String> {
    let registry = load_registry()?;
    assert_document_owner_in_registry(&registry, caller_root, target)
}

fn assert_document_owner_in_registry(
    registry: &WorkspaceRegistry,
    caller_root: &str,
    target: &Path,
) -> Result<(), String> {
    let caller = comparable_root(caller_root);
    let target = target.to_path_buf();
    let Some(owner) = longest_registered_owner(registry, &target) else {
        return Ok(());
    };
    let owner_root = comparable_root(&owner.path);
    if owner_root == caller {
        return Ok(());
    }
    Err(format!(
        "Document belongs to registered workspace '{}'; reopen it through that workspace before writing.",
        owner.path
    ))
}

pub fn registered_nested_roots(workspace_root: &Path) -> Vec<PathBuf> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    load_registry()
        .map(|registry| {
            registry
                .workspaces
                .iter()
                .map(|workspace| comparable_root(&workspace.path))
                .filter(|candidate| candidate != &root && candidate.starts_with(&root))
                .collect()
        })
        .unwrap_or_default()
}

fn save_registry(registry: &WorkspaceRegistry) -> Result<(), String> {
    save_registry_at(&workspace_registry_path()?, registry)
}

fn normalize_visibility(value: &str) -> String {
    if value == "public" {
        "public".to_string()
    } else {
        "private".to_string()
    }
}

fn default_provider() -> String {
    "local".to_string()
}

fn normalize_provider(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "local".to_string();
    }
    match trimmed {
        "local" => "local".to_string(),
        "googleDrive" | "gdrive" | "google-drive" => "googleDrive".to_string(),
        "oneDrive" | "onedrive" | "one-drive" => "oneDrive".to_string(),
        "sharePoint" | "sharepoint" | "share-point" => "sharePoint".to_string(),
        "nextcloud" | "nextCloud" => "nextcloud".to_string(),
        "obsidian" | "mcp-obsidian" => "obsidian".to_string(),
        "unknown" => "unknown".to_string(),
        _ => "unknown".to_string(),
    }
}

fn normalize_external_writer(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        match trimmed {
            "" | "none" => None,
            "googleDrive" | "google-drive" | "gdrive" => Some("gdrive".to_string()),
            "oneDrive" | "one-drive" | "onedrive" => Some("onedrive".to_string()),
            "sharePoint" | "share-point" | "sharepoint" => Some("sharepoint".to_string()),
            "nextCloud" | "nextcloud" => Some("nextcloud".to_string()),
            "obsidian" | "mcp-obsidian" => Some("mcp-obsidian".to_string()),
            other => Some(other.to_string()),
        }
    })
}

fn provider_from_external_writer(writer: &Option<String>) -> Option<String> {
    match writer.as_deref() {
        Some("gdrive") => Some("googleDrive".to_string()),
        Some("onedrive") => Some("oneDrive".to_string()),
        Some("sharepoint") => Some("sharePoint".to_string()),
        Some("nextcloud") => Some("nextcloud".to_string()),
        Some("mcp-obsidian") => Some("obsidian".to_string()),
        _ => None,
    }
}

fn normalize_write_policy(value: &str, external_writer: &Option<String>) -> String {
    // "managed" survives an external_writer (maru-vault-graph-spec §2.4):
    // Maru writes through the schema guard while MCP remains a co-writer.
    if value == "managed" {
        return "managed".to_string();
    }
    if external_writer.is_some() {
        return "delegated".to_string();
    }
    match value {
        "readOnly" | "read-only" | "readonly" => "readOnly".to_string(),
        "delegated" => "delegated".to_string(),
        _ => "direct".to_string(),
    }
}

fn infer_write_policy(external_writer: &Option<String>) -> String {
    normalize_write_policy("", external_writer)
}

fn normalize_registry(registry: &mut WorkspaceRegistry) {
    for entry in &mut registry.workspaces {
        entry.visibility = normalize_visibility(&entry.visibility);
        entry.external_writer = normalize_external_writer(entry.external_writer.clone());
        entry.provider = provider_from_external_writer(&entry.external_writer)
            .unwrap_or_else(|| normalize_provider(&entry.provider));
        entry.write_policy = normalize_write_policy(&entry.write_policy, &entry.external_writer);
        entry.permission_summary = Some(compute_permission_summary(entry, false));
        if entry.provider == "obsidian" && entry.external_writer.is_none() {
            entry.external_writer = Some("mcp-obsidian".to_string());
            // The managed opt-in (WorkspaceSwitcher toggle) is not demoted.
            if entry.write_policy != "managed" {
                entry.write_policy = "delegated".to_string();
            }
            entry.permission_summary = Some(compute_permission_summary(entry, false));
        }
    }

    if !active_path_is_valid(
        registry,
        "private",
        registry.active_by_visibility.private.as_deref(),
    ) {
        registry.active_by_visibility.private = first_path_for_visibility(registry, "private");
    }
    if !active_path_is_valid(
        registry,
        "public",
        registry.active_by_visibility.public.as_deref(),
    ) {
        registry.active_by_visibility.public = first_path_for_visibility(registry, "public");
    }
}

fn active_path_is_valid(
    registry: &WorkspaceRegistry,
    visibility: &str,
    active: Option<&str>,
) -> bool {
    let Some(active) = active else {
        return false;
    };
    registry
        .workspaces
        .iter()
        .any(|entry| entry.path == active && entry.visibility == visibility)
}

fn first_path_for_visibility(registry: &WorkspaceRegistry, visibility: &str) -> Option<String> {
    registry
        .workspaces
        .iter()
        .find(|entry| entry.visibility == visibility)
        .map(|entry| entry.path.clone())
}

fn active_slot<'a>(active: &'a mut ActiveByVisibility, visibility: &str) -> &'a mut Option<String> {
    if visibility == "public" {
        &mut active.public
    } else {
        &mut active.private
    }
}

fn migrate_legacy_vault_list(legacy: LegacyVaultList) -> WorkspaceRegistry {
    let mut registry = WorkspaceRegistry {
        hidden_defaults: legacy.hidden_defaults,
        ..WorkspaceRegistry::default()
    };

    for entry in legacy.vaults {
        let visibility =
            if entry.role.as_deref() == Some("vault") || entry.external_writer.is_some() {
                "public"
            } else {
                "private"
            };
        registry.workspaces.push(WorkspaceRootEntry {
            label: entry.label,
            path: entry.path,
            visibility: visibility.to_string(),
            external_writer: entry.external_writer.clone(),
            provider: provider_from_external_writer(&entry.external_writer)
                .unwrap_or_else(|| "local".to_string()),
            provider_id: None,
            write_policy: infer_write_policy(&entry.external_writer),
            permission_summary: None,
        });
    }

    if let Some(active) = legacy.active_vault {
        if let Some(active_entry) = registry
            .workspaces
            .iter()
            .find(|entry| entry.path == active)
        {
            *active_slot(&mut registry.active_by_visibility, &active_entry.visibility) =
                Some(active);
        }
    }
    registry
}

#[tauri::command]
pub fn list_workspace_roots() -> Result<WorkspaceRegistry, String> {
    load_registry()
}

#[allow(dead_code)]
pub fn assert_maru_owns_writes(workspace_path: &str) -> Result<(), String> {
    assert_maru_can_write(workspace_path, WorkspaceWriteAction::Modify)
}

pub fn assert_maru_can_write(
    workspace_path: &str,
    action: WorkspaceWriteAction,
) -> Result<(), String> {
    let registry = load_registry()?;
    let Some(workspace) = registry
        .workspaces
        .iter()
        .find(|workspace| workspace.path == workspace_path)
    else {
        return Ok(());
    };
    let summary = compute_permission_summary(workspace, false);
    if !capability_allows(&summary.capabilities, action) {
        let writer =
            workspace
                .external_writer
                .as_deref()
                .unwrap_or(match workspace.write_policy.as_str() {
                    "readOnly" => "read-only workspace",
                    "delegated" => "external writer",
                    _ => "provider capabilities",
                });
        return Err(format!(
            "Workspace writes are blocked by {writer}; Maru will not write directly."
        ));
    }
    Ok(())
}

fn capability_allows(capabilities: &WorkspaceCapabilities, action: WorkspaceWriteAction) -> bool {
    match action {
        WorkspaceWriteAction::Create => capabilities.can_create,
        WorkspaceWriteAction::Modify => capabilities.can_modify,
        WorkspaceWriteAction::Delete => capabilities.can_delete,
        WorkspaceWriteAction::RenameMove => capabilities.can_rename_move,
        WorkspaceWriteAction::Share => capabilities.can_share,
        WorkspaceWriteAction::ManageMembers => capabilities.can_manage_members,
    }
}

fn filesystem_capabilities(path: &str) -> WorkspaceCapabilities {
    let path = Path::new(path);
    let can_read = path.exists();
    let writable = fs::metadata(path)
        .map(|metadata| !metadata.permissions().readonly())
        .unwrap_or(false);
    WorkspaceCapabilities::full(can_read, writable)
}

fn role_capabilities(
    provider: &str,
    role: Option<&str>,
    can_read: bool,
) -> (WorkspaceCapabilities, Option<String>) {
    let Some(role) = role
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        if provider == "local" {
            return (WorkspaceCapabilities::full(can_read, true), None);
        }
        return (
            WorkspaceCapabilities::read_only(can_read),
            Some("Provider role is not set; public workspace is read-only until capabilities are refreshed.".to_string()),
        );
    };
    let normalized: String = role
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| !matches!(ch, ' ' | '_' | '-'))
        .collect();
    match provider {
        "googleDrive" => match normalized.as_str() {
            "organizer" | "manager" => (WorkspaceCapabilities::full(can_read, true), None),
            "fileorganizer" | "contentmanager" => {
                let mut caps = WorkspaceCapabilities::full(can_read, true);
                caps.can_manage_members = false;
                (caps, None)
            }
            "writer" | "contributor" => {
                let mut caps = WorkspaceCapabilities::read_only(can_read);
                caps.can_create = can_read;
                caps.can_modify = can_read;
                (caps, None)
            }
            "commenter" | "reader" | "viewer" => (WorkspaceCapabilities::read_only(can_read), None),
            _ => (
                WorkspaceCapabilities::read_only(can_read),
                Some(format!(
                    "Unknown Google Drive role '{role}' treated as read-only."
                )),
            ),
        },
        "oneDrive" | "sharePoint" => match normalized.as_str() {
            "owner" => (WorkspaceCapabilities::full(can_read, true), None),
            "write" | "canedit" | "edit" | "editor" => {
                let mut caps = WorkspaceCapabilities::full(can_read, true);
                caps.can_manage_members = false;
                (caps, None)
            }
            "read" | "canview" | "view" | "viewer" => {
                (WorkspaceCapabilities::read_only(can_read), None)
            }
            _ => (
                WorkspaceCapabilities::read_only(can_read),
                Some(format!(
                    "Unknown Microsoft role '{role}' treated as read-only."
                )),
            ),
        },
        "nextcloud" => {
            if let Ok(mask) = role.parse::<u32>() {
                let can_update = mask & 2 != 0;
                let can_create = mask & 4 != 0;
                let can_delete = mask & 8 != 0;
                let can_share = mask & 16 != 0;
                return (
                    WorkspaceCapabilities {
                        can_read: can_read && mask & 1 != 0,
                        can_create: can_read && can_create,
                        can_modify: can_read && can_update,
                        can_delete: can_read && can_delete,
                        can_rename_move: can_read && can_update && can_create && can_delete,
                        can_share: can_read && can_share,
                        can_manage_members: false,
                    },
                    None,
                );
            }
            (
                WorkspaceCapabilities::read_only(can_read),
                Some(format!(
                    "Unknown Nextcloud permissions '{role}' treated as read-only."
                )),
            )
        }
        "obsidian" => (WorkspaceCapabilities::read_only(can_read), None),
        _ => (
            WorkspaceCapabilities::read_only(can_read),
            Some("Unknown provider treated as read-only.".to_string()),
        ),
    }
}

fn compute_permission_summary(
    entry: &WorkspaceRootEntry,
    update_checked_at: bool,
) -> ProviderPermissionSummary {
    let local_caps = filesystem_capabilities(&entry.path);
    let prior = entry.permission_summary.as_ref();
    let role = prior.and_then(|summary| summary.role.clone());
    let source = prior
        .map(|summary| summary.source.clone())
        .filter(|value| matches!(value.as_str(), "manual" | "filesystem" | "api"))
        .unwrap_or_else(|| {
            if role.is_some() {
                "manual".to_string()
            } else if entry.provider == "local" {
                "filesystem".to_string()
            } else {
                "unknown".to_string()
            }
        });
    let (provider_caps, role_warning) =
        role_capabilities(&entry.provider, role.as_deref(), local_caps.can_read);
    let mut capabilities = provider_caps.intersect(&local_caps);
    let mut warning = role_warning.or_else(|| prior.and_then(|summary| summary.warning.clone()));
    let checked_at = if update_checked_at {
        Some(Utc::now().to_rfc3339())
    } else {
        prior.and_then(|summary| summary.checked_at.clone())
    };

    if entry.visibility == "public" && source == "unknown" && entry.provider != "local" {
        capabilities = WorkspaceCapabilities::read_only(local_caps.can_read);
        warning = Some("Capabilities are unverified; public workspace is read-only.".to_string());
    }
    if entry.visibility == "public" && entry.provider != "local" && checked_at.is_none() {
        capabilities = WorkspaceCapabilities::read_only(local_caps.can_read);
        warning = Some("Capabilities are stale; refresh before direct writes.".to_string());
    }
    if entry.write_policy == "managed" {
        // Managed vault (maru-vault-graph-spec §2.4 / capability matrix §5.3):
        // create + modify through the vault_guard schema gate; delete stays
        // MCP-only, rename/move out of V2 scope.
        capabilities = WorkspaceCapabilities {
            can_read: local_caps.can_read,
            can_create: true,
            can_modify: true,
            can_delete: false,
            can_rename_move: false,
            can_share: false,
            can_manage_members: false,
        };
    } else if entry.write_policy == "readOnly"
        || entry.write_policy == "delegated"
        || entry.external_writer.is_some()
    {
        capabilities = WorkspaceCapabilities::read_only(local_caps.can_read);
    }

    ProviderPermissionSummary {
        role,
        source,
        checked_at,
        capabilities,
        warning,
    }
}

#[tauri::command]
pub fn add_workspace_root(entry: WorkspaceRootEntry) -> Result<WorkspaceRegistry, String> {
    upsert_workspace_root(entry)
}

pub fn upsert_workspace_root(entry: WorkspaceRootEntry) -> Result<WorkspaceRegistry, String> {
    let mut registry = load_registry()?;
    let mut normalized = entry;
    normalized.visibility = normalize_visibility(&normalized.visibility);
    normalized.external_writer = normalize_external_writer(normalized.external_writer.clone());
    normalized.provider = provider_from_external_writer(&normalized.external_writer)
        .unwrap_or_else(|| normalize_provider(&normalized.provider));
    normalized.write_policy =
        normalize_write_policy(&normalized.write_policy, &normalized.external_writer);
    normalized.permission_summary = Some(compute_permission_summary(&normalized, true));
    let active_path = normalized.path.clone();
    let active_visibility = normalized.visibility.clone();

    if let Some(existing) = registry
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.path == normalized.path)
    {
        *existing = normalized;
    } else {
        registry.workspaces.push(normalized);
    }
    *active_slot(&mut registry.active_by_visibility, &active_visibility) = Some(active_path);
    normalize_registry(&mut registry);
    save_registry(&registry)?;
    Ok(registry)
}

#[tauri::command]
pub fn refresh_workspace_capabilities(path: String) -> Result<WorkspaceRegistry, String> {
    let mut registry = load_registry()?;
    let Some(entry) = registry
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.path == path)
    else {
        return Err("Workspace is not registered".to_string());
    };
    entry.permission_summary = Some(compute_permission_summary(entry, true));
    normalize_registry(&mut registry);
    save_registry(&registry)?;
    Ok(registry)
}

#[tauri::command]
pub fn remove_workspace_root(path: String) -> Result<WorkspaceRegistry, String> {
    let mut registry = load_registry()?;
    let removed_visibility = registry
        .workspaces
        .iter()
        .find(|workspace| workspace.path == path)
        .map(|workspace| workspace.visibility.clone());
    registry
        .workspaces
        .retain(|workspace| workspace.path != path);
    if let Some(visibility) = removed_visibility {
        let slot = active_slot(&mut registry.active_by_visibility, &visibility);
        if slot.as_deref() == Some(path.as_str()) {
            *slot = None;
        }
    }
    normalize_registry(&mut registry);
    save_registry(&registry)?;
    Ok(registry)
}

#[tauri::command]
pub fn set_active_workspace_root(
    path: String,
    visibility: String,
) -> Result<WorkspaceRegistry, String> {
    let visibility = normalize_visibility(&visibility);
    let mut registry = load_registry()?;
    if !registry
        .workspaces
        .iter()
        .any(|workspace| workspace.path == path && workspace.visibility == visibility)
    {
        return Err("Workspace is not registered for this visibility".to_string());
    }
    *active_slot(&mut registry.active_by_visibility, &visibility) = Some(path);
    normalize_registry(&mut registry);
    save_registry(&registry)?;
    Ok(registry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(label: &str, path: &str, visibility: &str) -> WorkspaceRootEntry {
        WorkspaceRootEntry {
            label: label.to_string(),
            path: path.to_string(),
            visibility: visibility.to_string(),
            provider: "local".to_string(),
            provider_id: None,
            external_writer: None,
            write_policy: "direct".to_string(),
            permission_summary: None,
        }
    }

    fn save_and_reload(registry: &WorkspaceRegistry) -> WorkspaceRegistry {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("workspaces.json");
        let legacy_path = dir.path().join("vaults.json");
        save_registry_at(&path, registry).unwrap();
        load_registry_at(&path, &legacy_path).unwrap()
    }

    #[test]
    fn default_workspace_registry_is_empty() {
        let registry = WorkspaceRegistry::default();
        assert!(registry.workspaces.is_empty());
        assert!(registry.active_by_visibility.private.is_none());
        assert!(registry.active_by_visibility.public.is_none());
    }

    #[test]
    fn nested_registered_workspace_owns_its_documents() {
        let tmp = tempfile::TempDir::new().unwrap();
        let parent = tmp.path().join("work");
        let nested = parent.join("vault");
        fs::create_dir_all(nested.join("notes")).unwrap();
        let target = nested.canonicalize().unwrap().join("notes/a.md");
        fs::write(&target, "# A\n").unwrap();
        let registry = WorkspaceRegistry {
            workspaces: vec![
                entry("Work", &parent.to_string_lossy(), "private"),
                entry("Vault", &nested.to_string_lossy(), "public"),
            ],
            ..Default::default()
        };

        assert!(
            assert_document_owner_in_registry(&registry, &parent.to_string_lossy(), &target)
                .is_err()
        );
        assert!(
            assert_document_owner_in_registry(&registry, &nested.to_string_lossy(), &target)
                .is_ok()
        );
    }

    #[test]
    fn roundtrip_preserves_workspace_data() {
        let registry = WorkspaceRegistry {
            workspaces: vec![
                entry("Private", "/Users/yj/workspace/work", "private"),
                WorkspaceRootEntry {
                    label: "Public".to_string(),
                    path: "/Users/yj/workspace/public".to_string(),
                    visibility: "public".to_string(),
                    provider: "obsidian".to_string(),
                    provider_id: None,
                    external_writer: Some("mcp-obsidian".to_string()),
                    write_policy: "delegated".to_string(),
                    permission_summary: None,
                },
            ],
            active_by_visibility: ActiveByVisibility {
                private: Some("/Users/yj/workspace/work".to_string()),
                public: Some("/Users/yj/workspace/public".to_string()),
            },
            hidden_defaults: vec![],
        };
        let loaded = save_and_reload(&registry);
        assert_eq!(loaded.workspaces.len(), 2);
        assert_eq!(loaded.workspaces[0].visibility, "private");
        assert_eq!(loaded.workspaces[1].visibility, "public");
        assert_eq!(loaded.workspaces[1].write_policy, "delegated");
        assert_eq!(loaded.workspaces[1].provider, "obsidian");
    }

    #[test]
    fn migrates_legacy_vaults_to_workspace_registry() {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_path = dir.path().join("workspaces.json");
        let legacy_path = dir.path().join("vaults.json");
        let legacy = LegacyVaultList {
            vaults: vec![
                LegacyVaultRegistryEntry {
                    label: "Work".to_string(),
                    path: "/work".to_string(),
                    external_writer: None,
                    workspace_root: Some("/work".to_string()),
                    role: Some("work".to_string()),
                },
                LegacyVaultRegistryEntry {
                    label: "Knowledge".to_string(),
                    path: "/knowledge".to_string(),
                    external_writer: Some("mcp-obsidian".to_string()),
                    workspace_root: Some("/work".to_string()),
                    role: Some("vault".to_string()),
                },
            ],
            active_vault: Some("/work".to_string()),
            hidden_defaults: vec![],
        };
        fs::write(&legacy_path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();

        let migrated = load_registry_at(&workspace_path, &legacy_path).unwrap();

        assert!(workspace_path.exists());
        assert_eq!(
            migrated.active_by_visibility.private.as_deref(),
            Some("/work")
        );
        assert_eq!(
            migrated.active_by_visibility.public.as_deref(),
            Some("/knowledge")
        );
        assert_eq!(migrated.workspaces[0].visibility, "private");
        assert_eq!(migrated.workspaces[1].visibility, "public");
        assert_eq!(migrated.workspaces[0].provider, "local");
        assert_eq!(migrated.workspaces[1].provider, "obsidian");
    }

    #[test]
    fn migrates_legacy_private_only_registry() {
        let legacy = LegacyVaultList {
            vaults: vec![LegacyVaultRegistryEntry {
                label: "Plain".to_string(),
                path: "/plain".to_string(),
                external_writer: None,
                workspace_root: None,
                role: None,
            }],
            active_vault: Some("/plain".to_string()),
            hidden_defaults: vec![],
        };

        let migrated = migrate_legacy_vault_list(legacy);

        assert_eq!(migrated.workspaces[0].visibility, "private");
        assert_eq!(
            migrated.active_by_visibility.private.as_deref(),
            Some("/plain")
        );
        assert!(migrated.active_by_visibility.public.is_none());
    }

    #[test]
    fn delegated_policy_blocks_registered_workspace() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut workspace = entry("Public", &dir.path().to_string_lossy(), "public");
        workspace.external_writer = Some("mcp-obsidian".to_string());
        workspace.write_policy = "delegated".to_string();
        workspace.provider = "obsidian".to_string();

        let summary = compute_permission_summary(&workspace, false);

        assert!(summary.capabilities.can_read);
        assert!(!summary.capabilities.can_modify);
        assert!(!summary.capabilities.can_create);
    }

    #[test]
    fn managed_policy_grants_create_modify_but_not_delete_or_move() {
        // maru-vault-graph-spec §5.3 capability matrix: managed keeps its
        // write caps even with an external_writer (MCP becomes a co-writer).
        let dir = tempfile::TempDir::new().unwrap();
        let mut workspace = entry("Public", &dir.path().to_string_lossy(), "public");
        workspace.external_writer = Some("mcp-obsidian".to_string());
        workspace.write_policy = "managed".to_string();
        workspace.provider = "obsidian".to_string();

        let summary = compute_permission_summary(&workspace, false);

        assert!(summary.capabilities.can_read);
        assert!(summary.capabilities.can_create);
        assert!(summary.capabilities.can_modify);
        assert!(!summary.capabilities.can_delete, "delete stays MCP-only");
        assert!(
            !summary.capabilities.can_rename_move,
            "rename/move out of V2 scope"
        );
    }

    #[test]
    fn managed_policy_survives_registry_normalization() {
        // normalize_write_policy must not demote managed to delegated, and
        // normalize_registry's obsidian branch must not force delegated.
        let dir = tempfile::TempDir::new().unwrap();
        let mut workspace = entry("Public", &dir.path().to_string_lossy(), "public");
        workspace.write_policy = "managed".to_string();
        workspace.provider = "obsidian".to_string();

        let mut registry = WorkspaceRegistry {
            workspaces: vec![workspace],
            ..Default::default()
        };
        normalize_registry(&mut registry);

        let entry = &registry.workspaces[0];
        assert_eq!(entry.write_policy, "managed");
        assert_eq!(entry.external_writer.as_deref(), Some("mcp-obsidian"));
        let caps = &entry.permission_summary.as_ref().unwrap().capabilities;
        assert!(caps.can_create && caps.can_modify);
        assert!(!caps.can_delete && !caps.can_rename_move);
    }

    #[test]
    fn delegated_policy_without_named_writer_still_blocks() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut workspace = entry("Public", &dir.path().to_string_lossy(), "public");
        workspace.write_policy = "delegated".to_string();

        let summary = compute_permission_summary(&workspace, false);

        assert!(summary.capabilities.can_read);
        assert!(!summary.capabilities.can_modify);
    }

    #[test]
    fn read_only_policy_blocks_direct_writes() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut workspace = entry("Reference", &dir.path().to_string_lossy(), "public");
        workspace.write_policy = "readOnly".to_string();

        let summary = compute_permission_summary(&workspace, false);

        assert!(summary.capabilities.can_read);
        assert!(!summary.capabilities.can_create);
        assert!(!summary.capabilities.can_modify);
        assert!(!summary.capabilities.can_delete);
    }

    #[test]
    fn direct_policy_still_blocks_when_filesystem_probe_denies_writes() {
        let missing = tempfile::TempDir::new()
            .unwrap()
            .path()
            .join("missing-root");
        let workspace = entry("Missing", &missing.to_string_lossy(), "private");

        let summary = compute_permission_summary(&workspace, false);

        assert!(!summary.capabilities.can_read);
        assert!(!summary.capabilities.can_create);
        assert!(!summary.capabilities.can_modify);
    }

    #[test]
    fn provider_roles_map_to_capabilities() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut google = entry("Drive", &dir.path().to_string_lossy(), "public");
        google.provider = "googleDrive".to_string();
        google.permission_summary = Some(ProviderPermissionSummary {
            role: Some("contentManager".to_string()),
            source: "manual".to_string(),
            checked_at: None,
            capabilities: WorkspaceCapabilities::default(),
            warning: None,
        });
        let drive = compute_permission_summary(&google, true);
        assert!(drive.capabilities.can_create);
        assert!(drive.capabilities.can_delete);
        assert!(drive.capabilities.can_share);
        assert!(!drive.capabilities.can_manage_members);

        let mut sharepoint = entry("SharePoint", &dir.path().to_string_lossy(), "public");
        sharepoint.provider = "sharePoint".to_string();
        sharepoint.permission_summary = Some(ProviderPermissionSummary {
            role: Some("Can edit".to_string()),
            source: "manual".to_string(),
            checked_at: None,
            capabilities: WorkspaceCapabilities::default(),
            warning: None,
        });
        let microsoft = compute_permission_summary(&sharepoint, true);
        assert!(microsoft.capabilities.can_modify);
        assert!(microsoft.capabilities.can_rename_move);
        assert!(!microsoft.capabilities.can_manage_members);
    }

    #[test]
    fn nextcloud_bitmask_maps_exact_permissions() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut nextcloud = entry("Nextcloud", &dir.path().to_string_lossy(), "public");
        nextcloud.provider = "nextcloud".to_string();
        nextcloud.permission_summary = Some(ProviderPermissionSummary {
            role: Some("7".to_string()),
            source: "manual".to_string(),
            checked_at: None,
            capabilities: WorkspaceCapabilities::default(),
            warning: None,
        });

        let summary = compute_permission_summary(&nextcloud, true);

        assert!(summary.capabilities.can_read);
        assert!(summary.capabilities.can_create);
        assert!(summary.capabilities.can_modify);
        assert!(!summary.capabilities.can_delete);
        assert!(!summary.capabilities.can_rename_move);
        assert!(!summary.capabilities.can_share);
    }

    #[test]
    fn unknown_public_provider_defaults_read_only() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut workspace = entry("Unknown", &dir.path().to_string_lossy(), "public");
        workspace.provider = "unknown".to_string();

        let summary = compute_permission_summary(&workspace, false);

        assert!(summary.capabilities.can_read);
        assert!(!summary.capabilities.can_modify);
        assert!(summary.warning.is_some());
    }

    #[test]
    fn stale_public_provider_summary_defaults_read_only() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut workspace = entry("Drive", &dir.path().to_string_lossy(), "public");
        workspace.provider = "googleDrive".to_string();
        workspace.permission_summary = Some(ProviderPermissionSummary {
            role: Some("contentManager".to_string()),
            source: "manual".to_string(),
            checked_at: None,
            capabilities: WorkspaceCapabilities::default(),
            warning: None,
        });

        let summary = compute_permission_summary(&workspace, false);

        assert!(summary.capabilities.can_read);
        assert!(!summary.capabilities.can_modify);
        assert!(summary.warning.as_deref().unwrap_or("").contains("stale"));
    }
}
