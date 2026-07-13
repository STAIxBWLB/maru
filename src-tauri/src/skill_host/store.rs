use chrono::Utc;
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use walkdir::WalkDir;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::cli_path::merge_path_env;
use crate::skill_host::bundle_update as bundle;
use crate::skill_host::bundle_update::{BundleState, SkillBundleRef, SwapJournal};
use crate::skill_host::fs as host_fs;
use crate::vault::{parse_frontmatter, title_from_content};
use crate::win_process::NoWindow;

const REGISTRY_VERSION: u32 = 3;
const REGISTRY_FILE: &str = "registry.json";
const BUILTIN_SOURCE_ID: &str = "maru-builtin";
const BUILTIN_DIR_NAME: &str = "_builtin";
const BUILTIN_HASHES_FILE: &str = ".maru-builtin-hashes.json";
const MANAGED_SOURCE_ID: &str = "maru-managed";
const IMPORTED_SOURCE_ID: &str = "maru-imported";
const STAI_PUBLIC_SOURCE_ID: &str = "stai-public";
const STAI_PRIVATE_SOURCE_ID: &str = "stai-private";
const AGENTS_EXTERNAL_SOURCE_ID: &str = "agents-external";
const CODEX_NATIVE_SOURCE_ID: &str = "codex-tool-native";
const INSTALL_MARKER_FILE: &str = ".maru-install.json";

// Frozen offline-bootstrap snapshot (src-tauri/skills-bootstrap), used only
// for fresh installs with no bundle state. Live skill updates ship as signed
// bundles from the skills-channel release; editing skills/ must not rebuild
// or re-embed anything.
static BUILTIN_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/skills-bootstrap");

static REGISTRY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub ownership_class: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_url: Option<String>,
    #[serde(default = "default_skills_subdir")]
    pub skills_subdir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    pub id: String,
    pub source_id: String,
    pub name: String,
    pub rel_path: String,
    pub abs_path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default = "default_skill_tier")]
    pub tier: String,
    #[serde(default = "default_true")]
    pub valid: bool,
    #[serde(default)]
    pub validation_errors: Vec<String>,
    #[serde(default)]
    pub editable: bool,
    #[serde(default)]
    pub dirty: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstall {
    pub skill_id: String,
    pub target: String,
    pub installed_as: String,
    pub managed_by: String,
    pub entrypoint_path: String,
    pub target_path: String,
    #[serde(default = "default_install_mode")]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsRegistry {
    pub version: u32,
    #[serde(default)]
    pub sources: Vec<SkillSource>,
    #[serde(default)]
    pub skills: Vec<SkillRecord>,
    #[serde(default)]
    pub installs: Vec<SkillInstall>,
    #[serde(default)]
    pub removed_source_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDocument {
    pub skill: SkillRecord,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub install: SkillInstall,
    pub maru_entrypoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptOutcome {
    pub adopted: usize,
    pub skipped: usize,
    pub installs: Vec<SkillInstall>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSourceResult {
    pub source_id: String,
    pub kind: String,
    pub ok: bool,
    pub skills: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAllOutcome {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub results: Vec<SyncSourceResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillToolSyncAction {
    pub action: String,
    pub skill_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillToolSyncReport {
    pub applied: bool,
    pub tools: Vec<String>,
    pub desired_skills: usize,
    pub desired_installs: usize,
    pub actions: Vec<SkillToolSyncAction>,
}

/// Provenance marker written into a copy-mode install directory
/// (`<tool>/skills/<name>/.maru-install.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallMarker {
    maru_managed: bool,
    skill_id: String,
    installed_as: String,
    mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_abs_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetOutcome {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    pub sources: usize,
    pub skills: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirtyRecord {
    pub skill_id: String,
    pub name: String,
    pub source_id: String,
    pub source_kind: String,
    pub tier: String,
    pub rel_path: String,
    pub abs_path: String,
    pub git_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_repo_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileOutcome {
    pub skill_id: String,
    pub name: String,
    pub action: String,
    pub dry_run: bool,
    pub committed: bool,
    pub pushed: bool,
    pub hash_updated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_repo_root: Option<String>,
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands_shell: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub skill: SkillRecord,
    pub mode: String,
    pub imported_path: String,
    pub maru_entrypoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportUnmanageOutcome {
    pub name: String,
    pub removed_installs: usize,
    pub removed_entrypoint: bool,
    pub deleted_files: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDoctorIssue {
    pub severity: String,
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_name: Option<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDoctorReport {
    pub ok: bool,
    pub sources: usize,
    pub skills: usize,
    pub installs: usize,
    pub issues: Vec<SkillDoctorIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillProgressEvent {
    progress_id: String,
    level: String,
    message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completed: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    total: Option<usize>,
}

#[derive(Debug, Clone)]
struct ManifestSkillRoot {
    path: PathBuf,
    tier: Option<String>,
}

#[derive(Clone, Copy)]
struct ProgressReporter<'a> {
    app: Option<&'a AppHandle>,
    progress_id: Option<&'a str>,
}

fn default_skills_subdir() -> String {
    "skills".to_string()
}

fn source_ownership_class(id: &str, kind: &str) -> String {
    match kind {
        "builtin" => "bundled",
        "imported" => "imported",
        "adopted" | "external-managed" => "external-managed",
        "tool-native" => "tool-native",
        _ if id == IMPORTED_SOURCE_ID => "imported",
        _ => "owned-catalog",
    }
    .to_string()
}

fn default_true() -> bool {
    true
}

fn default_skill_tier() -> String {
    "managed".to_string()
}

fn default_install_mode() -> String {
    "symlink".to_string()
}

impl Default for SkillsRegistry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            sources: Vec::new(),
            skills: Vec::new(),
            installs: Vec::new(),
            removed_source_ids: Vec::new(),
        }
    }
}

impl<'a> ProgressReporter<'a> {
    fn new(app: &'a AppHandle, progress_id: Option<&'a str>) -> Self {
        Self {
            app: Some(app),
            progress_id,
        }
    }

    fn noop() -> Self {
        Self {
            app: None,
            progress_id: None,
        }
    }

    fn emit(
        self,
        level: &str,
        message: impl Into<String>,
        completed: Option<usize>,
        total: Option<usize>,
    ) {
        let (Some(app), Some(progress_id)) = (self.app, self.progress_id) else {
            return;
        };
        let _ = app.emit(
            "skills-op://progress",
            SkillProgressEvent {
                progress_id: progress_id.to_string(),
                level: level.to_string(),
                message: message.into(),
                completed,
                total,
            },
        );
    }

    fn info(self, message: impl Into<String>) {
        self.emit("info", message, None, None);
    }

    fn success(self, message: impl Into<String>) {
        self.emit("success", message, None, None);
    }

    fn progress(self, level: &str, message: impl Into<String>, completed: usize, total: usize) {
        self.emit(level, message, Some(completed), Some(total));
    }
}

#[tauri::command]
pub fn skills_list_sources(work_path: Option<String>) -> Result<Vec<SkillSource>, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    ensure_default_sources(&mut registry, work_path.as_deref())?;
    save_registry_unlocked(&registry)?;
    Ok(registry.sources)
}

#[tauri::command]
pub fn skills_add_source(
    id: String,
    kind: String,
    path: Option<String>,
    repo_url: Option<String>,
    skills_subdir: Option<String>,
) -> Result<SkillSource, String> {
    let id = normalize_source_id(&id)?;
    let kind = normalize_source_kind(&kind)?;
    if matches!(
        id.as_str(),
        BUILTIN_SOURCE_ID
            | MANAGED_SOURCE_ID
            | IMPORTED_SOURCE_ID
            | STAI_PUBLIC_SOURCE_ID
            | STAI_PRIVATE_SOURCE_ID
            | AGENTS_EXTERNAL_SOURCE_ID
            | CODEX_NATIVE_SOURCE_ID
    ) {
        return Err(format!("source_id_reserved: {id}"));
    }
    if kind == "managed" {
        return Err("source_kind_reserved: managed".to_string());
    }
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    if registry.sources.iter().any(|source| source.id == id) {
        return Err(format!("source_exists: {id}"));
    }

    let source_path = match kind.as_str() {
        "linked" | "external-managed" | "tool-native" => {
            let raw = path.ok_or_else(|| "source_path_required".to_string())?;
            let p = host_fs::expand_tilde(&raw);
            if !p.is_dir() {
                return Err(format!(
                    "source_path_invalid: {}",
                    host_fs::display_path(&p)
                ));
            }
            Some(host_fs::display_path(&canonicalize_or_self(&p)))
        }
        "cloned" => {
            let url = repo_url
                .clone()
                .ok_or_else(|| "source_repo_url_required".to_string())?;
            let checkout = host_fs::skills_root()?.join("_sources").join(&id);
            if checkout.exists() {
                return Err(format!(
                    "source_checkout_exists: {}",
                    host_fs::display_path(&checkout)
                ));
            }
            host_fs::ensure_dir(checkout.parent().unwrap())?;
            run_command(Command::new("git").arg("clone").arg(&url).arg(&checkout))?;
            Some(host_fs::display_path(&checkout))
        }
        "imported" | "managed" | "adopted" => {
            path.map(|raw| host_fs::display_path(&host_fs::expand_tilde(&raw)))
        }
        other => return Err(format!("unsupported_source_kind: {other}")),
    };

    let ownership_class = source_ownership_class(&id, &kind);
    let source = SkillSource {
        id,
        kind,
        ownership_class,
        path: source_path,
        repo_url,
        skills_subdir: skills_subdir
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(default_skills_subdir),
        branch: None,
        last_synced_at: None,
    };
    clear_removed_source(&mut registry, &source.id);
    registry.sources.push(source.clone());
    rescan_source_in_registry(&mut registry, &source.id)?;
    save_registry_unlocked(&registry)?;
    Ok(source)
}

#[tauri::command]
pub fn skills_remove_source(source_id: String) -> Result<(), String> {
    let source_id = normalize_source_id(&source_id)?;
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    remove_source_from_registry(&mut registry, &source_id)?;
    save_registry_unlocked(&registry)
}

#[tauri::command]
pub fn skills_sync_source(
    app: AppHandle,
    source_id: String,
    progress_id: Option<String>,
) -> Result<Vec<SkillRecord>, String> {
    skills_sync_source_impl(
        source_id,
        ProgressReporter::new(&app, progress_id.as_deref()),
    )
}

fn skills_sync_source_impl(
    source_id: String,
    progress: ProgressReporter<'_>,
) -> Result<Vec<SkillRecord>, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    progress.info(format!("Resolving source {source_id}"));
    let source = registry
        .sources
        .iter()
        .find(|source| source.id == source_id)
        .cloned()
        .ok_or_else(|| format!("unknown_source: {source_id}"))?;
    let skills = sync_one_source_in_registry(&mut registry, &source, progress)?;
    save_registry_unlocked(&registry)?;
    progress.success(format!(
        "Sync complete for {source_id}: {} skill(s)",
        skills.len()
    ));
    Ok(skills)
}

/// Pull (if `cloned`) then rescan a single source, operating on the
/// already-loaded registry under a guard the caller holds. Never re-enters
/// `registry_guard()` (the lock is not reentrant) and never saves — callers
/// save once after they are done mutating.
fn sync_one_source_in_registry(
    registry: &mut SkillsRegistry,
    source: &SkillSource,
    progress: ProgressReporter<'_>,
) -> Result<Vec<SkillRecord>, String> {
    if source.kind == "cloned" {
        let path = source_path(source)?;
        progress.info(format!("Pulling latest changes for {}", source.id));
        run_command(
            Command::new("git")
                .arg("-C")
                .arg(path)
                .arg("pull")
                .arg("--ff-only"),
        )?;
        progress.success(format!("Git pull complete for {}", source.id));
    } else {
        progress.info(format!("Source {} is linked; skipping git pull", source.id));
    }
    rescan_source_in_registry_with_progress(registry, &source.id, progress)
}

#[tauri::command]
pub fn skills_sync_all_sources(
    app: AppHandle,
    work_path: Option<String>,
    progress_id: Option<String>,
) -> Result<SyncAllOutcome, String> {
    skills_sync_all_sources_impl(
        work_path,
        ProgressReporter::new(&app, progress_id.as_deref()),
    )
}

fn skills_sync_all_sources_impl(
    work_path: Option<String>,
    progress: ProgressReporter<'_>,
) -> Result<SyncAllOutcome, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    ensure_default_sources(&mut registry, work_path.as_deref())?;
    let ids = source_ids(&registry);
    let total = ids.len();
    let mut results: Vec<SyncSourceResult> = Vec::new();
    for (index, source_id) in ids.into_iter().enumerate() {
        progress.progress("info", format!("Syncing {source_id}"), index, total);
        let Some(source) = registry
            .sources
            .iter()
            .find(|source| source.id == source_id)
            .cloned()
        else {
            continue;
        };
        match sync_one_source_in_registry(&mut registry, &source, progress) {
            Ok(skills) => {
                let last_synced_at = registry
                    .sources
                    .iter()
                    .find(|item| item.id == source_id)
                    .and_then(|item| item.last_synced_at.clone());
                results.push(SyncSourceResult {
                    source_id: source_id.clone(),
                    kind: source.kind.clone(),
                    ok: true,
                    skills: skills.len(),
                    last_synced_at,
                    error: None,
                });
                progress.progress("success", format!("Synced {source_id}"), index + 1, total);
            }
            Err(error) => {
                progress.progress(
                    "error",
                    format!("Failed {source_id}: {error}"),
                    index + 1,
                    total,
                );
                results.push(SyncSourceResult {
                    source_id: source_id.clone(),
                    kind: source.kind.clone(),
                    ok: false,
                    skills: 0,
                    last_synced_at: None,
                    error: Some(error),
                });
            }
        }
    }
    save_registry_unlocked(&registry)?;
    let failed = results.iter().filter(|result| !result.ok).count();
    let succeeded = results.len() - failed;
    progress.success(format!(
        "Sync all complete: {succeeded} ok, {failed} failed"
    ));
    Ok(SyncAllOutcome {
        total,
        succeeded,
        failed,
        results,
    })
}

#[tauri::command]
pub fn skills_rescan_source(
    app: AppHandle,
    source_id: String,
    progress_id: Option<String>,
) -> Result<Vec<SkillRecord>, String> {
    skills_rescan_source_impl(
        source_id,
        ProgressReporter::new(&app, progress_id.as_deref()),
    )
}

fn skills_rescan_source_impl(
    source_id: String,
    progress: ProgressReporter<'_>,
) -> Result<Vec<SkillRecord>, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    let skills = rescan_source_in_registry_with_progress(&mut registry, &source_id, progress)?;
    save_registry_unlocked(&registry)?;
    progress.success(format!(
        "Rescan complete for {source_id}: {} skill(s)",
        skills.len()
    ));
    Ok(skills)
}

#[tauri::command]
pub fn skills_list_skills(
    work_path: Option<String>,
    refresh: Option<bool>,
) -> Result<Vec<SkillRecord>, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    if refresh.unwrap_or(false) {
        ensure_default_sources(&mut registry, work_path.as_deref())?;
        let source_ids: Vec<String> = registry
            .sources
            .iter()
            .map(|source| source.id.clone())
            .collect();
        for source_id in source_ids {
            let _ = rescan_source_in_registry(&mut registry, &source_id);
        }
        save_registry_unlocked(&registry)?;
    }
    Ok(registry.skills)
}

#[tauri::command]
pub fn skills_read_skill(skill_id: String) -> Result<SkillDocument, String> {
    let registry = load_registry()?;
    let skill = registry
        .skills
        .iter()
        .find(|skill| skill.id == skill_id)
        .cloned()
        .ok_or_else(|| format!("unknown_skill: {skill_id}"))?;
    let content = fs::read_to_string(Path::new(&skill.abs_path).join("SKILL.md"))
        .map_err(|err| format!("Cannot read SKILL.md for {}: {err}", skill.name))?;
    Ok(SkillDocument { skill, content })
}

#[tauri::command]
pub fn skills_read_skill_file(skill_id: String, file_path: String) -> Result<String, String> {
    let path = resolve_skill_file(&skill_id, &file_path)?;
    fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&path)))
}

#[tauri::command]
pub fn skills_save_skill_file(
    skill_id: String,
    file_path: String,
    content: String,
) -> Result<SkillRecord, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    let skill = registry
        .skills
        .iter()
        .find(|skill| skill.id == skill_id)
        .cloned()
        .ok_or_else(|| format!("unknown_skill: {skill_id}"))?;
    let source = registry
        .sources
        .iter()
        .find(|source| source.id == skill.source_id)
        .ok_or_else(|| format!("unknown_source: {}", skill.source_id))?;
    let source_kind = source.kind.clone();
    let path = resolve_skill_file_from_record(&skill, &file_path)?;
    fs::write(&path, content)
        .map_err(|err| format!("Cannot write {}: {err}", host_fs::display_path(&path)))?;
    let mut refreshed = rescan_source_in_registry(&mut registry, &skill.source_id)?
        .into_iter()
        .find(|next| next.id == skill_id)
        .ok_or_else(|| format!("skill_missing_after_save: {skill_id}"))?;
    mark_record_saved_after_user_write(&mut refreshed, &source_kind);
    if let Some(stored) = registry
        .skills
        .iter_mut()
        .find(|stored| stored.id == refreshed.id)
    {
        *stored = refreshed.clone();
    }
    save_registry_unlocked(&registry)?;
    Ok(refreshed)
}

#[tauri::command]
pub fn skills_save_skill_as(
    skill_id: String,
    name: String,
    content: String,
) -> Result<SkillRecord, String> {
    let name = host_fs::safe_entry_name(&name)?;
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    ensure_managed_source(&mut registry)?;
    let skill = registry
        .skills
        .iter()
        .find(|skill| skill.id == skill_id)
        .cloned()
        .ok_or_else(|| format!("unknown_skill: {skill_id}"))?;
    let root = host_fs::skills_root()?.join("_managed").join(&name);
    if root.exists() || fs::symlink_metadata(&root).is_ok() {
        return Err(format!("managed_skill_exists: {name}"));
    }
    copy_dir_all(Path::new(&skill.abs_path), &root)?;
    fs::write(root.join("SKILL.md"), content)
        .map_err(|err| format!("Cannot write managed skill {name}: {err}"))?;
    let mut created = rescan_source_in_registry(&mut registry, MANAGED_SOURCE_ID)?
        .into_iter()
        .find(|skill| skill.name == name)
        .ok_or_else(|| "managed_skill_scan_failed".to_string())?;
    mark_record_saved_after_user_write(&mut created, "managed");
    if let Some(stored) = registry
        .skills
        .iter_mut()
        .find(|stored| stored.id == created.id)
    {
        *stored = created.clone();
    }
    save_registry_unlocked(&registry)?;
    Ok(created)
}

#[tauri::command]
pub fn skills_create_skill(name: String, title: Option<String>) -> Result<SkillRecord, String> {
    let name = host_fs::safe_entry_name(&name)?;
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    ensure_managed_source(&mut registry)?;
    let root = host_fs::skills_root()?.join("_managed").join(&name);
    if root.exists() {
        return Err(format!("managed_skill_exists: {name}"));
    }
    host_fs::ensure_dir(&root)?;
    let title = title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| name.clone());
    let body = format!(
        "---\nname: {name}\ndescription: {title}\nruntime: generic\n---\n\n# {title}\n\nUse this skill when the selected context should be processed with the `{name}` workflow.\n"
    );
    fs::write(root.join("SKILL.md"), body)
        .map_err(|err| format!("Cannot create managed skill {name}: {err}"))?;
    let skills = rescan_source_in_registry(&mut registry, MANAGED_SOURCE_ID)?;
    let created = skills
        .into_iter()
        .find(|skill| skill.name == name)
        .ok_or_else(|| "managed_skill_scan_failed".to_string())?;
    save_registry_unlocked(&registry)?;
    Ok(created)
}

#[tauri::command]
pub fn skills_delete_skill(skill_id: String) -> Result<(), String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    let skill = registry
        .skills
        .iter()
        .find(|skill| skill.id == skill_id)
        .cloned()
        .ok_or_else(|| format!("unknown_skill: {skill_id}"))?;
    if skill.source_id != MANAGED_SOURCE_ID {
        return Err("delete_only_managed_skills".to_string());
    }
    if registry
        .installs
        .iter()
        .any(|install| install.skill_id == skill_id)
    {
        return Err("skill_is_installed".to_string());
    }
    fs::remove_dir_all(&skill.abs_path)
        .map_err(|err| format!("Cannot delete {}: {err}", skill.abs_path))?;
    let _ = rescan_source_in_registry(&mut registry, MANAGED_SOURCE_ID)?;
    save_registry_unlocked(&registry)
}

#[tauri::command]
pub fn skills_list_installs(work_path: Option<String>) -> Result<Vec<SkillInstall>, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    ensure_default_sources(&mut registry, work_path.as_deref())?;
    save_registry_unlocked(&registry)?;
    Ok(registry.installs)
}

#[tauri::command]
pub fn skills_install_skill(
    skill_id: String,
    target: String,
    installed_as: Option<String>,
    mode: Option<String>,
) -> Result<InstallOutcome, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    let skill = registry
        .skills
        .iter()
        .find(|skill| skill.id == skill_id)
        .cloned()
        .ok_or_else(|| format!("unknown_skill: {skill_id}"))?;
    let source = registry
        .sources
        .iter()
        .find(|source| source.id == skill.source_id)
        .ok_or_else(|| format!("unknown_source: {}", skill.source_id))?;
    if matches!(source.kind.as_str(), "external-managed" | "tool-native") {
        return Err(format!("source_not_maru_installable: {}", source.id));
    }
    if !skill.valid {
        return Err(format!(
            "skill_invalid: {}",
            skill.validation_errors.join("; ")
        ));
    }
    let target = normalize_install_target(&target)?;
    let mode = normalize_install_mode(mode.as_deref())?;
    let installed_as = host_fs::safe_entry_name(installed_as.as_deref().unwrap_or(&skill.name))?;
    let skill_path = PathBuf::from(&skill.abs_path);
    let tool_target = install_target_path(&target, &installed_as)?;

    // entrypoint_path: for symlink installs it is the maru entry that the tool
    // target points at; for copy installs there is no maru entry, so it records
    // the source skill dir (origin, for drift comparison). maru_entrypoint is the
    // path surfaced to the UI.
    let (entrypoint_path, maru_entrypoint) = if mode == "copy" {
        install_copy(&tool_target, &skill_path, &skill_id, &installed_as)?;
        (
            host_fs::display_path(&skill_path),
            host_fs::display_path(&tool_target),
        )
    } else {
        let maru_entry = host_fs::skills_root()?.join(&installed_as);
        create_maru_entry_symlink(&maru_entry, &skill_path, &installed_as)?;
        create_install_target_symlink(&tool_target, &maru_entry, &skill_path, &installed_as)?;
        let display = host_fs::display_path(&maru_entry);
        (display.clone(), display)
    };

    let install = SkillInstall {
        skill_id,
        target: target.clone(),
        installed_as,
        managed_by: "maru".to_string(),
        entrypoint_path,
        target_path: host_fs::display_path(&tool_target),
        mode: mode.clone(),
        created_at: Some(Utc::now().to_rfc3339()),
    };
    registry.installs.retain(|existing| {
        !(existing.target == install.target && existing.installed_as == install.installed_as)
    });
    registry.installs.push(install.clone());
    save_registry_unlocked(&registry)?;
    Ok(InstallOutcome {
        install,
        maru_entrypoint,
    })
}

#[tauri::command]
pub fn skills_uninstall_skill(target: String, installed_as: String) -> Result<(), String> {
    let target = normalize_install_target(&target)?;
    let installed_as = host_fs::safe_entry_name(&installed_as)?;
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    let install = registry
        .installs
        .iter()
        .find(|install| install.target == target && install.installed_as == installed_as)
        .cloned()
        .ok_or_else(|| "install_not_registered".to_string())?;
    if install.managed_by != "maru" {
        return Err("external_install_not_removed".to_string());
    }
    if install.mode == "copy" {
        let tool_target = PathBuf::from(&install.target_path);
        // Refuse to delete anything that is not unambiguously our own copy.
        if !copy_install_is_maru_managed(&tool_target, &installed_as) {
            return Err("install_not_maru_managed".to_string());
        }
        fs::remove_dir_all(&tool_target).map_err(|err| {
            format!(
                "Cannot remove {}: {err}",
                host_fs::display_path(&tool_target)
            )
        })?;
    } else {
        let tool_target = PathBuf::from(&install.target_path);
        let maru_entry = PathBuf::from(&install.entrypoint_path);
        let removed_target = host_fs::remove_if_matching_symlink(&tool_target, &maru_entry)?;
        if !removed_target {
            return Err(format!(
                "install_target_changed: {} no longer points to {}",
                install.target_path, install.entrypoint_path
            ));
        }
        let still_used = registry.installs.iter().any(|other| {
            !(other.target == target && other.installed_as == installed_as)
                && other.entrypoint_path == install.entrypoint_path
        });
        if !still_used {
            let skill_target = registry
                .skills
                .iter()
                .find(|skill| skill.id == install.skill_id)
                .map(|skill| PathBuf::from(&skill.abs_path));
            if let Some(skill_target) = skill_target {
                let _ = host_fs::remove_if_matching_symlink(&maru_entry, &skill_target);
            }
        }
    }
    registry
        .installs
        .retain(|other| !(other.target == target && other.installed_as == installed_as));
    save_registry_unlocked(&registry)
}

#[tauri::command]
pub fn skills_adopt_external_links(
    app: AppHandle,
    progress_id: Option<String>,
) -> Result<AdoptOutcome, String> {
    skills_adopt_external_links_impl(ProgressReporter::new(&app, progress_id.as_deref()))
}

fn skills_adopt_external_links_impl(
    progress: ProgressReporter<'_>,
) -> Result<AdoptOutcome, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    let mut adopted = 0;
    let mut skipped = 0;
    let mut installs = Vec::new();
    for target in ["claude", "codex"] {
        let dir = install_root(target)?;
        progress.info(format!("Scanning {target} install root"));
        if !dir.is_dir() {
            progress.info(format!("{target} install root does not exist; skipping"));
            continue;
        }
        let entries = fs::read_dir(&dir)
            .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&dir)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        let total = entries.len();
        for (index, entry) in entries.into_iter().enumerate() {
            let link_path = entry.path();
            let installed_as = entry.file_name().to_string_lossy().to_string();
            progress.progress(
                "info",
                format!("Checking {target}/{installed_as}"),
                index,
                total,
            );
            let raw_target = match host_fs::read_link_target(&link_path) {
                Some(raw_target) => raw_target,
                None => {
                    // Not a symlink. If it is an Maru-managed copy install that
                    // fell out of the registry, re-register it; otherwise leave the
                    // user's directory untouched.
                    if copy_install_is_maru_managed(&link_path, &installed_as) {
                        if registry.installs.iter().any(|install| {
                            install.target == target && install.installed_as == installed_as
                        }) {
                            skipped += 1;
                            progress.info(format!(
                                "Skipped {target}/{installed_as}: already registered"
                            ));
                            continue;
                        }
                        let marker = read_install_marker(&link_path);
                        let install = SkillInstall {
                            skill_id: marker
                                .as_ref()
                                .map(|m| m.skill_id.clone())
                                .unwrap_or_default(),
                            target: target.to_string(),
                            installed_as: installed_as.clone(),
                            managed_by: "maru".to_string(),
                            entrypoint_path: marker
                                .as_ref()
                                .and_then(|m| m.source_abs_path.clone())
                                .unwrap_or_else(|| host_fs::display_path(&link_path)),
                            target_path: host_fs::display_path(&link_path),
                            mode: "copy".to_string(),
                            created_at: Some(Utc::now().to_rfc3339()),
                        };
                        registry.installs.push(install.clone());
                        installs.push(install);
                        adopted += 1;
                        progress.progress(
                            "success",
                            format!("Adopted {target}/{installed_as} (copy)"),
                            index + 1,
                            total,
                        );
                        continue;
                    }
                    skipped += 1;
                    progress.info(format!("Skipped {target}/{installed_as}: not a symlink"));
                    continue;
                }
            };
            let abs_target = if raw_target.is_absolute() {
                raw_target
            } else {
                dir.join(raw_target)
            };
            if !abs_target.join("SKILL.md").is_file() {
                skipped += 1;
                progress.info(format!(
                    "Skipped {target}/{installed_as}: target has no SKILL.md"
                ));
                continue;
            }
            let source_id = adopted_source_id(&abs_target);
            if !registry.sources.iter().any(|source| source.id == source_id) {
                progress.info(format!("Registering adopted source {source_id}"));
                registry.sources.push(SkillSource {
                    id: source_id.clone(),
                    kind: "adopted".to_string(),
                    ownership_class: "external-managed".to_string(),
                    path: Some(host_fs::display_path(&abs_target)),
                    repo_url: None,
                    skills_subdir: ".".to_string(),
                    branch: None,
                    last_synced_at: None,
                });
            }
            let scanned =
                rescan_source_in_registry_with_progress(&mut registry, &source_id, progress)?;
            let Some(skill) = scanned.first() else {
                skipped += 1;
                progress.info(format!(
                    "Skipped {target}/{installed_as}: scan found no skill"
                ));
                continue;
            };
            if registry
                .installs
                .iter()
                .any(|install| install.target == target && install.installed_as == installed_as)
            {
                skipped += 1;
                progress.info(format!(
                    "Skipped {target}/{installed_as}: already registered"
                ));
                continue;
            }
            let install = SkillInstall {
                skill_id: skill.id.clone(),
                target: target.to_string(),
                installed_as: installed_as.clone(),
                managed_by: "external".to_string(),
                entrypoint_path: host_fs::display_path(&abs_target),
                target_path: host_fs::display_path(&link_path),
                mode: "symlink".to_string(),
                created_at: Some(Utc::now().to_rfc3339()),
            };
            registry.installs.push(install.clone());
            installs.push(install);
            adopted += 1;
            progress.progress(
                "success",
                format!("Adopted {target}/{installed_as}"),
                index + 1,
                total,
            );
        }
    }
    save_registry_unlocked(&registry)?;
    progress.success(format!(
        "Adopt complete: {adopted} registered, {skipped} skipped"
    ));
    Ok(AdoptOutcome {
        adopted,
        skipped,
        installs,
    })
}

#[tauri::command]
pub fn skills_reset_registry(
    app: AppHandle,
    work_path: Option<String>,
    progress_id: Option<String>,
) -> Result<ResetOutcome, String> {
    skills_reset_registry_impl(
        work_path,
        ProgressReporter::new(&app, progress_id.as_deref()),
    )
}

fn skills_reset_registry_impl(
    work_path: Option<String>,
    progress: ProgressReporter<'_>,
) -> Result<ResetOutcome, String> {
    let _guard = registry_guard()?;
    let root = host_fs::skills_root()?;
    progress.info(format!(
        "Ensuring skills root {}",
        host_fs::display_path(&root)
    ));
    host_fs::ensure_dir(&root)?;
    for name in ["_sources", "_managed", "_imported", "_cache"] {
        host_fs::ensure_dir(&root.join(name))?;
    }
    let path = registry_path()?;
    let backup_path = if path.is_file() {
        let backup = path.with_file_name(format!(
            "registry-{}.json.bak",
            Utc::now().format("%Y%m%d%H%M%S%.9f")
        ));
        progress.info(format!(
            "Backing up registry to {}",
            host_fs::display_path(&backup)
        ));
        fs::copy(&path, &backup).map_err(|err| {
            format!(
                "Cannot back up {} to {}: {err}",
                host_fs::display_path(&path),
                host_fs::display_path(&backup)
            )
        })?;
        Some(host_fs::display_path(&backup))
    } else {
        None
    };
    progress.info("Preserving intact install records");
    let preserved_installs = load_registry_unlocked()
        .map(preserved_installs_from_registry)
        .unwrap_or_default();
    progress.info(format!(
        "Preserved {} install record(s)",
        preserved_installs.len()
    ));
    let mut registry = SkillsRegistry {
        installs: preserved_installs,
        ..SkillsRegistry::default()
    };
    progress.info("Recreating default sources");
    ensure_default_sources(&mut registry, work_path.as_deref())?;
    let source_ids: Vec<String> = registry
        .sources
        .iter()
        .map(|source| source.id.clone())
        .collect();
    let total_sources = source_ids.len();
    for (index, source_id) in source_ids.into_iter().enumerate() {
        progress.progress(
            "info",
            format!("Rescanning source {source_id}"),
            index,
            total_sources,
        );
        let _ = rescan_source_in_registry_with_progress(&mut registry, &source_id, progress)?;
        progress.progress(
            "success",
            format!("Rescanned source {source_id}"),
            index + 1,
            total_sources,
        );
    }
    let outcome = ResetOutcome {
        backup_path,
        sources: registry.sources.len(),
        skills: registry.skills.len(),
    };
    save_registry_unlocked(&registry)?;
    progress.success(format!(
        "Registry reset complete: {} source(s), {} skill(s)",
        outcome.sources, outcome.skills
    ));
    Ok(outcome)
}

#[tauri::command]
pub fn skills_doctor(work_path: Option<String>) -> Result<SkillDoctorReport, String> {
    let _guard = registry_guard()?;
    // Doctor is a diagnostic command. It must never create directories,
    // materialize the bundled catalog, or persist an in-memory migration.
    let mut registry = load_registry_readonly_unlocked()?;
    add_default_sources_readonly(&mut registry, work_path.as_deref())?;
    let mut scan_issues = Vec::new();
    for source_id in source_ids(&registry) {
        if let Err(err) = rescan_source_in_registry_with_progress(
            &mut registry,
            &source_id,
            ProgressReporter::noop(),
        ) {
            scan_issues.push(doctor_issue(
                "error",
                "source_scan_failed",
                None,
                vec![source_id],
                err,
            ));
        }
    }
    apply_registry_validation(&mut registry);
    let mut report = build_doctor_report(&registry);
    if !scan_issues.is_empty() {
        report.issues.splice(0..0, scan_issues);
        report.ok = !report.issues.iter().any(|issue| issue.severity == "error");
    }
    Ok(report)
}

/// Reconcile the Maru-owned catalog into tool runtimes. `apply = false` is a
/// strict read-only preview: it does not materialize the builtin bundle, write
/// the registry, or touch any symlink.
pub fn skills_sync_tools(
    work_path: Option<String>,
    tools: Vec<String>,
    apply: bool,
) -> Result<SkillToolSyncReport, String> {
    let tools = normalize_sync_tools(tools)?;
    let _guard = registry_guard()?;
    let mut registry = if apply {
        let mut registry = load_registry_unlocked()?;
        ensure_default_sources(&mut registry, work_path.as_deref())?;
        registry
    } else {
        let mut registry = load_registry_readonly_unlocked()?;
        add_default_sources_readonly(&mut registry, work_path.as_deref())?;
        add_embedded_builtin_readonly(&mut registry)?;
        registry
    };

    for source_id in source_ids(&registry) {
        if !apply
            && source_id == BUILTIN_SOURCE_ID
            && !builtin_materialized_root()?.join("manifest.json").is_file()
        {
            continue;
        }
        if let Err(error) = rescan_source_in_registry_with_progress(
            &mut registry,
            &source_id,
            ProgressReporter::noop(),
        ) {
            return Err(format!("source_scan_failed: {source_id}: {error}"));
        }
    }

    let managed_source_ids: BTreeSet<String> = registry
        .sources
        .iter()
        .filter(|source| source_is_maru_owned(source))
        .map(|source| source.id.clone())
        .collect();
    let mut desired: Vec<SkillRecord> = registry
        .skills
        .iter()
        .filter(|skill| managed_source_ids.contains(&skill.source_id))
        .cloned()
        .collect();
    desired.sort_by(|a, b| a.name.cmp(&b.name));
    if let Some(skill) = desired.iter().find(|skill| !skill.valid) {
        return Err(format!(
            "skill_invalid: {}: {}",
            skill.name,
            skill.validation_errors.join("; ")
        ));
    }

    let mut actions = plan_tool_sync(&registry, &desired, &tools)?;
    if apply {
        preflight_tool_sync(&registry, &desired, &tools)?;
        let selected_tools: BTreeSet<String> = tools.iter().cloned().collect();
        let desired_keys: BTreeSet<(String, String)> = desired
            .iter()
            .flat_map(|skill| {
                tools
                    .iter()
                    .map(move |target| (target.clone(), skill.name.clone()))
            })
            .collect();
        let stale_installs: Vec<SkillInstall> = registry
            .installs
            .iter()
            .filter(|install| {
                install.managed_by == "maru"
                    && selected_tools.contains(&install.target)
                    && !desired_keys
                        .contains(&(install.target.clone(), install.installed_as.clone()))
            })
            .cloned()
            .collect();
        let retained_stale_copy_keys: BTreeSet<(String, String)> = stale_installs
            .iter()
            .filter(|install| {
                install.mode == "copy" && !stale_copy_has_exact_owned_install(install)
            })
            .map(|install| (install.target.clone(), install.installed_as.clone()))
            .collect();
        remove_exact_stale_install_links(&registry, &stale_installs, &desired_keys)?;
        registry.installs.retain(|install| {
            install.managed_by != "maru"
                || !selected_tools.contains(&install.target)
                || desired_keys.contains(&(install.target.clone(), install.installed_as.clone()))
                || retained_stale_copy_keys
                    .contains(&(install.target.clone(), install.installed_as.clone()))
        });

        for skill in &desired {
            let skill_path = PathBuf::from(&skill.abs_path);
            let maru_entry = host_fs::skills_root()?.join(&skill.name);
            create_maru_entry_symlink(&maru_entry, &skill_path, &skill.name)?;
            for target in &tools {
                let tool_target = install_target_path(target, &skill.name)?;
                create_install_target_symlink(&tool_target, &maru_entry, &skill_path, &skill.name)?;
                let created_at = registry
                    .installs
                    .iter()
                    .find(|install| install.target == *target && install.installed_as == skill.name)
                    .and_then(|install| install.created_at.clone())
                    .or_else(|| Some(Utc::now().to_rfc3339()));
                registry.installs.retain(|install| {
                    !(install.target == *target && install.installed_as == skill.name)
                });
                registry.installs.push(SkillInstall {
                    skill_id: skill.id.clone(),
                    target: target.clone(),
                    installed_as: skill.name.clone(),
                    managed_by: "maru".to_string(),
                    entrypoint_path: host_fs::display_path(&maru_entry),
                    target_path: host_fs::display_path(&tool_target),
                    mode: "symlink".to_string(),
                    created_at,
                });
            }
        }
        registry
            .installs
            .sort_by(|a, b| (&a.target, &a.installed_as).cmp(&(&b.target, &b.installed_as)));
        save_registry_unlocked(&registry)?;
        // Keep the report useful for idempotent apply calls.
        if actions.is_empty() {
            actions = Vec::new();
        }
    }

    Ok(SkillToolSyncReport {
        applied: apply,
        tools: tools.clone(),
        desired_skills: desired.len(),
        desired_installs: desired.len() * tools.len(),
        actions,
    })
}

fn normalize_sync_tools(tools: Vec<String>) -> Result<Vec<String>, String> {
    let mut normalized = BTreeSet::new();
    for tool in tools {
        normalized.insert(normalize_install_target(&tool)?);
    }
    if normalized.is_empty() {
        return Err("sync_tools_required".to_string());
    }
    Ok(normalized.into_iter().collect())
}

fn source_is_maru_owned(source: &SkillSource) -> bool {
    matches!(
        source.ownership_class.as_str(),
        "bundled" | "owned-catalog" | "imported"
    )
}

fn preflight_tool_sync(
    registry: &SkillsRegistry,
    desired: &[SkillRecord],
    tools: &[String],
) -> Result<(), String> {
    for skill in desired {
        let skill_path = PathBuf::from(&skill.abs_path);
        let maru_entry = host_fs::skills_root()?.join(&skill.name);
        if path_occupied(&maru_entry)
            && !symlink_target_resolves_to(&maru_entry, &skill_path)
            && !registry_proves_maru_entry(registry, &maru_entry, &skill.name)
        {
            return Err(format!(
                "install_target_exists: {} is not a proven Maru-owned canonical link",
                host_fs::display_path(&maru_entry)
            ));
        }
        for target in tools {
            let tool_target = install_target_path(target, &skill.name)?;
            if path_occupied(&tool_target)
                && !symlink_target_path_equals(&tool_target, &maru_entry)
                && !symlink_target_resolves_to(&tool_target, &skill_path)
                && !registry_proves_tool_install(
                    registry,
                    target,
                    &skill.name,
                    &tool_target,
                    &maru_entry,
                )
            {
                return Err(format!(
                    "install_target_exists: {} is not a proven Maru-owned install link",
                    host_fs::display_path(&tool_target)
                ));
            }
        }
    }
    Ok(())
}

fn path_occupied(path: &Path) -> bool {
    path.exists() || fs::symlink_metadata(path).is_ok()
}

fn registry_proves_maru_entry(
    registry: &SkillsRegistry,
    maru_entry: &Path,
    installed_as: &str,
) -> bool {
    is_symlink_path(maru_entry)
        && registry.installs.iter().any(|install| {
            install.managed_by == "maru"
                && install.mode == "symlink"
                && install.installed_as == installed_as
                && Path::new(&install.entrypoint_path) == maru_entry
                && symlink_target_path_equals(
                    Path::new(&install.target_path),
                    Path::new(&install.entrypoint_path),
                )
        })
}

fn registry_proves_tool_install(
    registry: &SkillsRegistry,
    target: &str,
    installed_as: &str,
    tool_target: &Path,
    maru_entry: &Path,
) -> bool {
    is_symlink_path(tool_target)
        && registry.installs.iter().any(|install| {
            install.managed_by == "maru"
                && install.mode == "symlink"
                && install.target == target
                && install.installed_as == installed_as
                && Path::new(&install.target_path) == tool_target
                && Path::new(&install.entrypoint_path) == maru_entry
                && symlink_target_path_equals(tool_target, maru_entry)
        })
}

fn stale_install_has_exact_owned_chain(install: &SkillInstall) -> bool {
    if install.managed_by != "maru" || install.mode != "symlink" {
        return false;
    }
    let Ok(installed_as) = host_fs::safe_entry_name(&install.installed_as) else {
        return false;
    };
    let Ok(expected_target) = install_target_path(&install.target, &installed_as) else {
        return false;
    };
    let Ok(expected_entry) = host_fs::skills_root().map(|root| root.join(&installed_as)) else {
        return false;
    };
    Path::new(&install.target_path) == expected_target
        && Path::new(&install.entrypoint_path) == expected_entry
        && is_symlink_path(&expected_target)
        && is_symlink_path(&expected_entry)
        && symlink_target_path_equals(&expected_target, &expected_entry)
}

fn stale_copy_has_exact_owned_install(install: &SkillInstall) -> bool {
    if install.managed_by != "maru" || install.mode != "copy" {
        return false;
    }
    let Ok(installed_as) = host_fs::safe_entry_name(&install.installed_as) else {
        return false;
    };
    let Ok(expected_target) = install_target_path(&install.target, &installed_as) else {
        return false;
    };
    Path::new(&install.target_path) == expected_target
        && copy_install_is_maru_managed(&expected_target, &installed_as)
}

fn remove_exact_stale_install_links(
    registry: &SkillsRegistry,
    stale_installs: &[SkillInstall],
    desired_keys: &BTreeSet<(String, String)>,
) -> Result<(), String> {
    for install in stale_installs
        .iter()
        .filter(|install| stale_copy_has_exact_owned_install(install))
    {
        fs::remove_dir_all(&install.target_path).map_err(|err| {
            format!(
                "Cannot remove stale Maru copy install {}: {err}",
                install.target_path
            )
        })?;
    }
    let removable: Vec<&SkillInstall> = stale_installs
        .iter()
        .filter(|install| stale_install_has_exact_owned_chain(install))
        .collect();
    for install in &removable {
        fs::remove_file(&install.target_path).map_err(|err| {
            format!(
                "Cannot remove stale Maru install {}: {err}",
                install.target_path
            )
        })?;
    }
    let stale_keys: BTreeSet<(String, String)> = stale_installs
        .iter()
        .map(|install| (install.target.clone(), install.installed_as.clone()))
        .collect();
    let mut entries = BTreeSet::new();
    for install in removable {
        let still_referenced = registry.installs.iter().any(|other| {
            other.entrypoint_path == install.entrypoint_path
                && (!stale_keys.contains(&(other.target.clone(), other.installed_as.clone()))
                    || desired_keys.contains(&(other.target.clone(), other.installed_as.clone())))
        });
        if !still_referenced {
            entries.insert(install.entrypoint_path.clone());
        }
    }
    for entry in entries {
        if is_symlink_path(Path::new(&entry)) {
            fs::remove_file(&entry)
                .map_err(|err| format!("Cannot remove stale Maru entry {entry}: {err}"))?;
        }
    }
    Ok(())
}

fn plan_tool_sync(
    registry: &SkillsRegistry,
    desired: &[SkillRecord],
    tools: &[String],
) -> Result<Vec<SkillToolSyncAction>, String> {
    let mut actions = Vec::new();
    let desired_keys: BTreeSet<(String, String)> = desired
        .iter()
        .flat_map(|skill| {
            tools
                .iter()
                .map(move |target| (target.clone(), skill.name.clone()))
        })
        .collect();
    for skill in desired {
        let skill_path = PathBuf::from(&skill.abs_path);
        let maru_entry = host_fs::skills_root()?.join(&skill.name);
        if !symlink_target_resolves_to(&maru_entry, &skill_path) {
            actions.push(SkillToolSyncAction {
                action: "link-canonical".to_string(),
                skill_name: skill.name.clone(),
                target: None,
                path: host_fs::display_path(&maru_entry),
                reason: "canonical entrypoint is missing or stale".to_string(),
            });
        }
        for target in tools {
            let tool_target = install_target_path(target, &skill.name)?;
            if !symlink_target_path_equals(&tool_target, &maru_entry) {
                actions.push(SkillToolSyncAction {
                    action: "link-tool".to_string(),
                    skill_name: skill.name.clone(),
                    target: Some(target.clone()),
                    path: host_fs::display_path(&tool_target),
                    reason: "tool entrypoint does not point to the canonical Maru link".to_string(),
                });
            }
            let record_ok = registry.installs.iter().any(|install| {
                install.skill_id == skill.id
                    && install.target == *target
                    && install.installed_as == skill.name
                    && install.managed_by == "maru"
                    && install.mode == "symlink"
                    && install.entrypoint_path == host_fs::display_path(&maru_entry)
                    && install.target_path == host_fs::display_path(&tool_target)
            });
            if !record_ok {
                actions.push(SkillToolSyncAction {
                    action: "record-install".to_string(),
                    skill_name: skill.name.clone(),
                    target: Some(target.clone()),
                    path: host_fs::display_path(&tool_target),
                    reason: "registry install record is missing or stale".to_string(),
                });
            }
        }
    }
    for install in registry.installs.iter().filter(|install| {
        install.managed_by == "maru"
            && tools.contains(&install.target)
            && !desired_keys.contains(&(install.target.clone(), install.installed_as.clone()))
    }) {
        let exact_owned = stale_install_has_exact_owned_chain(install)
            || stale_copy_has_exact_owned_install(install);
        let keep_unverified_copy = install.mode == "copy" && !exact_owned;
        actions.push(SkillToolSyncAction {
            action: if exact_owned {
                "remove-stale-install"
            } else if keep_unverified_copy {
                "keep-stale-record"
            } else {
                "remove-stale-record"
            }
            .to_string(),
            skill_name: install.installed_as.clone(),
            target: Some(install.target.clone()),
            path: install.target_path.clone(),
            reason: if exact_owned {
                "exact Maru-owned install is outside the current catalog".to_string()
            } else if keep_unverified_copy {
                "registry retained: copy install is not marker-verified".to_string()
            } else {
                "registry-only: filesystem chain is not exactly Maru-owned".to_string()
            },
        });
    }
    Ok(actions)
}

#[tauri::command]
pub fn skills_list_dirty(work_path: Option<String>) -> Result<Vec<DirtyRecord>, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    rescan_registry_sources(&mut registry, work_path.as_deref())?;
    let dirty = dirty_records_from_registry(&registry)?;
    save_registry_unlocked(&registry)?;
    Ok(dirty)
}

#[tauri::command]
pub fn skills_reconcile_skill(
    work_path: Option<String>,
    skill: String,
    action: String,
    message: Option<String>,
    dry_run: Option<bool>,
) -> Result<ReconcileOutcome, String> {
    let action = normalize_reconcile_action(&action)?;
    let dry_run = dry_run.unwrap_or(false);
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    rescan_registry_sources(&mut registry, work_path.as_deref())?;
    let skill_record = resolve_skill_selector(&registry, &skill)?;
    let source = registry
        .sources
        .iter()
        .find(|source| source.id == skill_record.source_id)
        .cloned()
        .ok_or_else(|| format!("unknown_source: {}", skill_record.source_id))?;
    let mut commands = Vec::new();
    let mut outcome = ReconcileOutcome {
        skill_id: skill_record.id.clone(),
        name: skill_record.name.clone(),
        action: action.clone(),
        dry_run,
        committed: false,
        pushed: false,
        hash_updated: false,
        git_repo_root: None,
        commands: Vec::new(),
        commands_shell: None,
        message: String::new(),
    };

    if let Some(repo_root) = source_git_repo_root(&source)? {
        outcome.git_repo_root = Some(host_fs::display_path(&repo_root));
        outcome.commands_shell = Some("posix".to_string());
        let skill_path = PathBuf::from(&skill_record.abs_path);
        let rel = skill_path
            .strip_prefix(&repo_root)
            .map_err(|_| "skill_not_inside_git_repo".to_string())?
            .to_string_lossy()
            .to_string();
        let repo_root_display = host_fs::display_path(&repo_root);
        let repo_root_quoted = shell_quote(&repo_root_display);
        let rel_quoted = shell_quote(&rel);
        if action == "accept" {
            let commit_message = message
                .clone()
                .unwrap_or_else(|| default_reconcile_message(&skill_record.name));
            commands.push(format!("git -C {} add -- {}", repo_root_quoted, rel_quoted));
            commands.push(format!(
                "git -C {} commit -m {} -- {}",
                repo_root_quoted,
                shell_quote(&commit_message),
                rel_quoted
            ));
            commands.push(format!("git -C {} push", repo_root_quoted));
            if !dry_run {
                run_git(&repo_root, &["add", "--", &rel])?;
                if !git_staged_changes_for_path(&repo_root, &rel)? {
                    outcome.message = "nothing_to_commit".to_string();
                } else {
                    run_git(&repo_root, &["commit", "-m", &commit_message, "--", &rel])?;
                    outcome.committed = true;
                    match run_git_capture(&repo_root, &["push"]) {
                        Ok(_) => {
                            outcome.pushed = true;
                            outcome.message = "committed_and_pushed".to_string();
                        }
                        Err(err) => {
                            outcome.message = format!("committed_push_failed: {err}");
                        }
                    }
                }
                mark_skill_saved(&mut registry, &skill_record.id)?;
                outcome.hash_updated = true;
            } else {
                outcome.message = "dry_run".to_string();
            }
        } else {
            commands.push(format!(
                "git -C {} checkout -- {}",
                repo_root_quoted, rel_quoted
            ));
            if !dry_run {
                run_git(&repo_root, &["checkout", "--", &rel])?;
                rescan_source_in_registry(&mut registry, &source.id)?;
                mark_skill_saved(&mut registry, &skill_record.id)?;
                outcome.hash_updated = true;
                outcome.message = "discarded".to_string();
            } else {
                outcome.message = "dry_run".to_string();
            }
        }
        outcome.commands = commands;
        save_registry_unlocked(&registry)?;
        return Ok(outcome);
    }

    match (source.kind.as_str(), action.as_str()) {
        ("builtin", "accept") => Err("builtin_accept_unsupported".to_string()),
        ("builtin", "discard") => {
            commands.push(format!("restore builtin skill {}", skill_record.name));
            if !dry_run {
                restore_builtin_skill(&skill_record.name)?;
                rescan_source_in_registry(&mut registry, BUILTIN_SOURCE_ID)?;
                mark_skill_saved(&mut registry, &skill_record.id)?;
                outcome.hash_updated = true;
                outcome.message = "builtin_restored".to_string();
            } else {
                outcome.message = "dry_run".to_string();
            }
            outcome.commands = commands;
            save_registry_unlocked(&registry)?;
            Ok(outcome)
        }
        ("managed" | "imported", "accept") => {
            commands.push("update saved hash".to_string());
            if !dry_run {
                mark_skill_saved(&mut registry, &skill_record.id)?;
                outcome.hash_updated = true;
                outcome.message = "hash_updated".to_string();
            } else {
                outcome.message = "dry_run".to_string();
            }
            outcome.commands = commands;
            save_registry_unlocked(&registry)?;
            Ok(outcome)
        }
        (_, "discard") => Err("discard_requires_git_or_builtin_source".to_string()),
        (_, "accept") => Err("accept_requires_git_or_managed_source".to_string()),
        _ => Err("unsupported_reconcile_action".to_string()),
    }
}

#[tauri::command]
pub fn skills_import_external(
    work_path: Option<String>,
    source_path: String,
    name: Option<String>,
    mode: Option<String>,
) -> Result<ImportOutcome, String> {
    let mode = normalize_import_mode(mode.as_deref())?;
    let source_path = host_fs::expand_tilde(&source_path);
    if !source_path.join("SKILL.md").is_file() {
        return Err(format!(
            "source_skill_missing: {}",
            host_fs::display_path(&source_path.join("SKILL.md"))
        ));
    }
    let source_path = fs::canonicalize(&source_path).map_err(|err| {
        format!(
            "source_skill_invalid: {}: {err}",
            host_fs::display_path(&source_path)
        )
    })?;
    let content = fs::read_to_string(source_path.join("SKILL.md"))
        .map_err(|err| format!("Cannot read source skill: {err}"))?;
    let parts = parse_frontmatter(&content);
    let name = name
        .or_else(|| yaml_meta_string(&parts.meta, "name"))
        .or_else(|| {
            source_path
                .file_name()
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
        })
        .ok_or_else(|| "skill_name_required".to_string())
        .and_then(|value| host_fs::safe_entry_name(&value))?;

    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    rescan_registry_sources(&mut registry, work_path.as_deref())?;
    if registry
        .skills
        .iter()
        .any(|skill| skill.name == name && skill.source_id != IMPORTED_SOURCE_ID)
    {
        return Err(format!("skill_name_exists: {name}"));
    }
    ensure_imported_source(&mut registry)?;
    let imported_skill = imported_root()?.join("skills").join(&name);
    if imported_skill.exists() || fs::symlink_metadata(&imported_skill).is_ok() {
        return Err(format!("imported_skill_exists: {name}"));
    }
    if mode == "copy" {
        copy_dir_all(&source_path, &imported_skill)?;
    } else {
        host_fs::create_symlink_no_clobber(&imported_skill, &canonicalize_or_self(&source_path))?;
    }
    upsert_imported_manifest_entry(&name, &source_path, &mode)?;
    let scanned = rescan_source_in_registry(&mut registry, IMPORTED_SOURCE_ID)?;
    let skill = scanned
        .into_iter()
        .find(|skill| skill.name == name)
        .ok_or_else(|| "imported_skill_scan_failed".to_string())?;
    let maru_entry = host_fs::skills_root()?.join(&name);
    create_maru_entry_symlink(&maru_entry, Path::new(&skill.abs_path), &name)?;
    save_registry_unlocked(&registry)?;
    Ok(ImportOutcome {
        skill,
        mode,
        imported_path: host_fs::display_path(&imported_skill),
        maru_entrypoint: host_fs::display_path(&maru_entry),
    })
}

#[tauri::command]
pub fn skills_import_unmanage(
    work_path: Option<String>,
    name: String,
    delete_files: Option<bool>,
) -> Result<ImportUnmanageOutcome, String> {
    let name = host_fs::safe_entry_name(&name)?;
    let delete_files = delete_files.unwrap_or(false);
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    rescan_registry_sources(&mut registry, work_path.as_deref())?;
    let skill = registry
        .skills
        .iter()
        .find(|skill| skill.source_id == IMPORTED_SOURCE_ID && skill.name == name)
        .cloned()
        .ok_or_else(|| format!("unknown_imported_skill: {name}"))?;
    let maru_entry = host_fs::skills_root()?.join(&name);
    let removed_entrypoint =
        host_fs::remove_if_matching_symlink(&maru_entry, Path::new(&skill.abs_path))?;
    let mut removed_installs = 0;
    let installs = std::mem::take(&mut registry.installs);
    registry.installs = installs
        .into_iter()
        .filter(|install| {
            if install.skill_id != skill.id {
                return true;
            }
            removed_installs += 1;
            if install.managed_by == "maru" {
                if install.mode == "copy" {
                    // Copy installs are real directories, not symlinks; remove the
                    // directory (gated on our marker so we never delete a dir Maru
                    // did not create), matching skills_uninstall_skill.
                    let tool_target = Path::new(&install.target_path);
                    if copy_install_is_maru_managed(tool_target, &install.installed_as) {
                        let _ = fs::remove_dir_all(tool_target);
                    }
                } else {
                    let _ = host_fs::remove_if_matching_symlink(
                        Path::new(&install.target_path),
                        &maru_entry,
                    );
                }
            }
            false
        })
        .collect();
    remove_imported_manifest_entry(&name)?;
    let imported_skill = imported_root()?.join("skills").join(&name);
    let mut deleted = false;
    if delete_files && (imported_skill.exists() || fs::symlink_metadata(&imported_skill).is_ok()) {
        let meta = fs::symlink_metadata(&imported_skill)
            .map_err(|err| format!("Cannot stat imported skill {name}: {err}"))?;
        if meta.file_type().is_symlink() || meta.is_file() {
            fs::remove_file(&imported_skill)
                .map_err(|err| format!("Cannot remove imported skill {name}: {err}"))?;
        } else {
            fs::remove_dir_all(&imported_skill)
                .map_err(|err| format!("Cannot remove imported skill {name}: {err}"))?;
        }
        deleted = true;
    }
    registry
        .skills
        .retain(|skill| !(skill.source_id == IMPORTED_SOURCE_ID && skill.name == name));
    let _ = rescan_source_in_registry(&mut registry, IMPORTED_SOURCE_ID);
    save_registry_unlocked(&registry)?;
    Ok(ImportUnmanageOutcome {
        name,
        removed_installs,
        removed_entrypoint,
        deleted_files: deleted,
    })
}

fn source_ids(registry: &SkillsRegistry) -> Vec<String> {
    registry
        .sources
        .iter()
        .map(|source| source.id.clone())
        .collect()
}

fn rescan_registry_sources(
    registry: &mut SkillsRegistry,
    work_path: Option<&str>,
) -> Result<(), String> {
    ensure_default_sources(registry, work_path)?;
    for source_id in source_ids(registry) {
        let _ = rescan_source_in_registry(registry, &source_id);
    }
    apply_registry_validation(registry);
    Ok(())
}

fn dirty_records_from_registry(registry: &SkillsRegistry) -> Result<Vec<DirtyRecord>, String> {
    let sources: BTreeMap<String, SkillSource> = registry
        .sources
        .iter()
        .map(|source| (source.id.clone(), source.clone()))
        .collect();
    registry
        .skills
        .iter()
        .filter(|skill| skill.dirty || skill.content_hash != skill.saved_hash)
        .map(|skill| {
            let source = sources
                .get(&skill.source_id)
                .ok_or_else(|| format!("unknown_source: {}", skill.source_id))?;
            let git_repo_root = source_git_repo_root(source)?;
            Ok(DirtyRecord {
                skill_id: skill.id.clone(),
                name: skill.name.clone(),
                source_id: skill.source_id.clone(),
                source_kind: source.kind.clone(),
                tier: skill.tier.clone(),
                rel_path: skill.rel_path.clone(),
                abs_path: skill.abs_path.clone(),
                git_available: git_repo_root.is_some(),
                git_repo_root: git_repo_root.map(|path| host_fs::display_path(&path)),
                content_hash: skill.content_hash.clone(),
                saved_hash: skill.saved_hash.clone(),
            })
        })
        .collect()
}

fn normalize_reconcile_action(action: &str) -> Result<String, String> {
    match action.trim().to_lowercase().as_str() {
        "accept" | "discard" => Ok(action.trim().to_lowercase()),
        other => Err(format!("unsupported_reconcile_action: {other}")),
    }
}

fn resolve_skill_selector(
    registry: &SkillsRegistry,
    selector: &str,
) -> Result<SkillRecord, String> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err("skill_required".to_string());
    }
    if let Some(skill) = registry.skills.iter().find(|skill| skill.id == selector) {
        return Ok(skill.clone());
    }
    let matches: Vec<SkillRecord> = registry
        .skills
        .iter()
        .filter(|skill| skill.name == selector)
        .cloned()
        .collect();
    match matches.len() {
        0 => Err(format!("unknown_skill: {selector}")),
        1 => Ok(matches.into_iter().next().unwrap()),
        _ => Err(format!("ambiguous_skill: {selector}")),
    }
}

fn source_git_repo_root(source: &SkillSource) -> Result<Option<PathBuf>, String> {
    let Some(path) = source.path.as_deref() else {
        return Ok(None);
    };
    let path = host_fs::expand_tilde(path);
    let sources_root = host_fs::skills_root()?.join("_sources");
    if !canonicalize_or_self(&path).starts_with(canonicalize_or_self(&sources_root)) {
        return Ok(None);
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&path)
        .arg("rev-parse")
        .arg("--show-toplevel")
        .no_window()
        .output();
    let Ok(output) = output else {
        return Ok(None);
    };
    if !output.status.success() {
        return Ok(None);
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(root)))
}

fn mark_skill_saved(registry: &mut SkillsRegistry, skill_id: &str) -> Result<(), String> {
    let source_id = registry
        .skills
        .iter()
        .find(|skill| skill.id == skill_id)
        .map(|skill| skill.source_id.clone())
        .ok_or_else(|| format!("unknown_skill: {skill_id}"))?;
    let _ = rescan_source_in_registry(registry, &source_id)?;
    let Some(skill) = registry
        .skills
        .iter_mut()
        .find(|skill| skill.id == skill_id)
    else {
        return Err(format!("unknown_skill: {skill_id}"));
    };
    skill.saved_hash = skill.content_hash.clone();
    skill.dirty = false;
    Ok(())
}

fn default_reconcile_message(name: &str) -> String {
    format!("maru: reconcile {name}")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn run_git(repo_root: &Path, args: &[&str]) -> Result<(), String> {
    run_git_capture(repo_root, args).map(|_| ())
}

fn run_git_capture(repo_root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(args)
        .no_window()
        .output()
        .map_err(|err| format!("command_failed_to_start: {err}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(stderr.trim().if_empty("unknown git error"))
}

fn git_staged_changes_for_path(repo_root: &Path, rel: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .arg("diff")
        .arg("--cached")
        .arg("--quiet")
        .arg("--")
        .arg(rel)
        .no_window()
        .output()
        .map_err(|err| format!("command_failed_to_start: {err}"))?;
    match output.status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(String::from_utf8_lossy(&output.stderr)
            .trim()
            .if_empty("git diff failed")),
    }
}

fn restore_builtin_skill(name: &str) -> Result<(), String> {
    let name = host_fs::safe_entry_name(name)?;
    let target = builtin_materialized_root()?.join("skills").join(&name);
    // Discard restores from the ACTIVE pristine baseline, not the embedded
    // snapshot: after an OTA bundle update the embedded copy is stale and
    // restoring it would silently downgrade the skill.
    if let Some(active) = bundle::read_state()?.and_then(|state| state.active) {
        let pristine = bundle::bundle_pristine_dir(&active.bundle_id)?
            .join("skills")
            .join(&name);
        if pristine.is_dir() {
            if target.exists() {
                fs::remove_dir_all(&target)
                    .map_err(|err| format!("Cannot remove builtin skill {name}: {err}"))?;
            }
            host_fs::ensure_dir(&target)?;
            return copy_dir_all(&pristine, &target);
        }
        if active.source == bundle::REMOTE_SOURCE {
            // Never downgrade a remote bundle to the embedded snapshot just
            // because its baseline vanished; refuse the unverifiable restore.
            return Err(format!(
                "bundle_pristine_missing: cannot restore {name} for {}",
                active.bundle_id
            ));
        }
    }
    let source = BUILTIN_DIR
        .get_dir(format!("skills/{name}"))
        .ok_or_else(|| format!("unknown_builtin_skill: {name}"))?;
    if target.exists() {
        fs::remove_dir_all(&target)
            .map_err(|err| format!("Cannot remove builtin skill {name}: {err}"))?;
    }
    host_fs::ensure_dir(&target)?;
    copy_include_dir_unconditional(source, &target, source.path())
}

fn copy_include_dir_unconditional(dir: &Dir<'_>, target: &Path, base: &Path) -> Result<(), String> {
    for child in dir.dirs() {
        let rel = child.path().strip_prefix(base).unwrap_or(child.path());
        let child_target = target.join(rel);
        host_fs::ensure_dir(&child_target)?;
        copy_include_dir_unconditional(child, target, base)?;
    }
    for file in dir.files() {
        let rel = file.path().strip_prefix(base).unwrap_or(file.path());
        let file_target = target.join(rel);
        if let Some(parent) = file_target.parent() {
            host_fs::ensure_dir(parent)?;
        }
        fs::write(&file_target, file.contents()).map_err(|err| {
            format!(
                "Cannot write builtin file {}: {err}",
                host_fs::display_path(&file_target)
            )
        })?;
        set_builtin_file_mode(&file_target, file.contents())?;
    }
    Ok(())
}

fn normalize_import_mode(mode: Option<&str>) -> Result<String, String> {
    match mode.unwrap_or("copy").trim().to_lowercase().as_str() {
        "copy" => Ok("copy".to_string()),
        "link" => Ok("link".to_string()),
        other => Err(format!("unsupported_import_mode: {other}")),
    }
}

fn imported_manifest_path() -> Result<PathBuf, String> {
    Ok(imported_root()?.join("manifest.json"))
}

fn read_imported_manifest() -> Result<serde_json::Value, String> {
    let path = imported_manifest_path()?;
    if !path.is_file() {
        return Ok(serde_json::json!({ "version": 1, "skills": [] }));
    }
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&path)))?;
    serde_json::from_str(&content)
        .map_err(|err| format!("Cannot parse {}: {err}", host_fs::display_path(&path)))
}

fn upsert_imported_manifest_entry(
    name: &str,
    source_path: &Path,
    mode: &str,
) -> Result<(), String> {
    let mut manifest = read_imported_manifest()?;
    if !manifest
        .get("skills")
        .is_some_and(serde_json::Value::is_array)
    {
        manifest["skills"] = serde_json::json!([]);
    }
    let skills = manifest["skills"].as_array_mut().unwrap();
    skills.retain(|item| item.get("name").and_then(serde_json::Value::as_str) != Some(name));
    skills.push(serde_json::json!({
        "name": name,
        "path": format!("skills/{name}"),
        "tier": "imported",
        "sourceOrigin": host_fs::display_path(source_path),
        "importedAt": Utc::now().to_rfc3339(),
        "mode": mode,
    }));
    host_fs::write_json_pretty(&imported_manifest_path()?, &manifest)
}

fn remove_imported_manifest_entry(name: &str) -> Result<(), String> {
    let mut manifest = read_imported_manifest()?;
    if let Some(skills) = manifest
        .get_mut("skills")
        .and_then(serde_json::Value::as_array_mut)
    {
        skills.retain(|item| item.get("name").and_then(serde_json::Value::as_str) != Some(name));
    }
    host_fs::write_json_pretty(&imported_manifest_path()?, &manifest)
}

fn preserved_installs_from_registry(registry: SkillsRegistry) -> Vec<SkillInstall> {
    registry
        .installs
        .into_iter()
        .filter(install_present)
        .collect()
}

fn install_links_are_intact(install: &SkillInstall) -> bool {
    let target_path = PathBuf::from(&install.target_path);
    let entrypoint_path = PathBuf::from(&install.entrypoint_path);
    host_fs::read_link_target(&target_path).as_deref() == Some(entrypoint_path.as_path())
}

/// Mode-aware "this install is still present and ours" check.
/// Symlink installs verify the two-level link chain; copy installs verify a
/// real (non-symlink) directory carrying our provenance marker.
fn install_present(install: &SkillInstall) -> bool {
    if install.mode == "copy" {
        copy_install_is_maru_managed(Path::new(&install.target_path), &install.installed_as)
    } else {
        install_links_are_intact(install)
    }
}

fn is_symlink_path(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn install_marker_path(dir: &Path) -> PathBuf {
    dir.join(INSTALL_MARKER_FILE)
}

fn read_install_marker(dir: &Path) -> Option<InstallMarker> {
    let data = fs::read(install_marker_path(dir)).ok()?;
    serde_json::from_slice::<InstallMarker>(&data).ok()
}

/// Write the `.maru-install.json` provenance marker into a copied skill dir.
/// The marker is the only reliable signal that Maru created a real directory
/// under a tool's skills root — it gates every destructive copy-mode operation.
fn write_install_marker(
    dir: &Path,
    skill_id: &str,
    installed_as: &str,
    source: &Path,
) -> Result<(), String> {
    let marker = InstallMarker {
        maru_managed: true,
        skill_id: skill_id.to_string(),
        installed_as: installed_as.to_string(),
        mode: "copy".to_string(),
        source_abs_path: Some(host_fs::display_path(source)),
        source_hash: hash_file(&source.join("SKILL.md")).ok(),
        created_at: Some(Utc::now().to_rfc3339()),
    };
    host_fs::write_json_pretty(&install_marker_path(dir), &marker)
}

/// True only when `dir` is a real directory (NOT a symlink) bearing our
/// `.maru-install.json` marker for this `installed_as`. Any uncertainty
/// (missing dir, symlink, absent/foreign marker) returns false so callers
/// never delete a directory Maru did not create.
fn copy_install_is_maru_managed(dir: &Path, installed_as: &str) -> bool {
    if is_symlink_path(dir) || !dir.is_dir() {
        return false;
    }
    read_install_marker(dir)
        .map(|marker| {
            marker.maru_managed && marker.mode == "copy" && marker.installed_as == installed_as
        })
        .unwrap_or(false)
}

/// Copy a skill directory directly into a tool target as a self-contained,
/// real directory (no symlink, no maru entry) and drop the provenance
/// marker. Refuses to overwrite anything Maru did not create.
fn install_copy(
    tool_target: &Path,
    skill_path: &Path,
    skill_id: &str,
    installed_as: &str,
) -> Result<(), String> {
    if is_symlink_path(tool_target) {
        return Err(format!(
            "install_target_exists: {} already exists as a symlink",
            host_fs::display_path(tool_target)
        ));
    }
    if tool_target.exists() {
        if copy_install_is_maru_managed(tool_target, installed_as) {
            fs::remove_dir_all(tool_target).map_err(|err| {
                format!(
                    "Cannot replace existing install {}: {err}",
                    host_fs::display_path(tool_target)
                )
            })?;
        } else {
            return Err(format!(
                "install_target_exists: {} already exists and is not Maru-managed",
                host_fs::display_path(tool_target)
            ));
        }
    }
    copy_dir_all(skill_path, tool_target)?;
    write_install_marker(tool_target, skill_id, installed_as, skill_path)
}

fn create_maru_entry_symlink(
    maru_entry: &Path,
    skill_path: &Path,
    installed_as: &str,
) -> Result<(), String> {
    if !maru_entry.exists() && fs::symlink_metadata(maru_entry).is_err() {
        return host_fs::create_symlink_no_clobber(maru_entry, skill_path);
    }
    if symlink_target_path_equals(maru_entry, skill_path)
        || symlink_target_resolves_to(maru_entry, skill_path)
    {
        return Ok(());
    }
    if symlink_target_is_skill_named(maru_entry, installed_as) {
        fs::remove_file(maru_entry).map_err(|err| {
            format!(
                "Cannot replace existing Maru skill link {}: {err}",
                host_fs::display_path(maru_entry)
            )
        })?;
        return host_fs::create_symlink_no_clobber(maru_entry, skill_path);
    }
    Err(format!(
        "install_target_exists: {} already exists and does not point to {}",
        host_fs::display_path(maru_entry),
        host_fs::display_path(skill_path)
    ))
}

fn create_install_target_symlink(
    tool_target: &Path,
    maru_entry: &Path,
    skill_path: &Path,
    installed_as: &str,
) -> Result<(), String> {
    if !tool_target.exists() && fs::symlink_metadata(tool_target).is_err() {
        return host_fs::create_symlink_no_clobber(tool_target, maru_entry);
    }
    if symlink_target_path_equals(tool_target, maru_entry) {
        return Ok(());
    }
    if symlink_target_resolves_to(tool_target, skill_path) {
        fs::remove_file(tool_target).map_err(|err| {
            format!(
                "Cannot replace existing install link {}: {err}",
                host_fs::display_path(tool_target)
            )
        })?;
        return host_fs::create_symlink_no_clobber(tool_target, maru_entry);
    }
    if symlink_target_is_skill_named(tool_target, installed_as) {
        fs::remove_file(tool_target).map_err(|err| {
            format!(
                "Cannot replace existing install link {}: {err}",
                host_fs::display_path(tool_target)
            )
        })?;
        return host_fs::create_symlink_no_clobber(tool_target, maru_entry);
    }
    Err(format!(
        "install_target_exists: {} already exists and does not point to {}",
        host_fs::display_path(tool_target),
        host_fs::display_path(maru_entry)
    ))
}

fn symlink_target_is_skill_named(link: &Path, expected_name: &str) -> bool {
    let Some(target) = host_fs::read_link_target(link) else {
        return false;
    };
    let resolved = resolve_link_target(link, target);
    resolved.join("SKILL.md").is_file()
        && resolved
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == expected_name)
}

fn symlink_target_path_equals(link: &Path, expected: &Path) -> bool {
    let Some(target) = host_fs::read_link_target(link) else {
        return false;
    };
    resolve_link_target(link, target) == expected
}

fn symlink_target_resolves_to(link: &Path, expected: &Path) -> bool {
    let Some(target) = host_fs::read_link_target(link) else {
        return false;
    };
    let resolved = resolve_link_target(link, target);
    canonicalize_or_self(&resolved) == canonicalize_or_self(expected)
}

fn resolve_link_target(link: &Path, target: PathBuf) -> PathBuf {
    if target.is_absolute() {
        return target;
    }
    link.parent().unwrap_or_else(|| Path::new("")).join(target)
}

fn registry_guard() -> Result<MutexGuard<'static, ()>, String> {
    REGISTRY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "skills_registry_lock_poisoned".to_string())
}

fn startup_profile_enabled() -> bool {
    std::env::var("MARU_STARTUP_PROFILE")
        .map(|value| {
            let value = value.trim();
            value == "1" || value.eq_ignore_ascii_case("true")
        })
        .unwrap_or(false)
}

fn profile_timing_result<T, E>(
    name: impl AsRef<str>,
    work: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    if !startup_profile_enabled() {
        return work();
    }
    let name = name.as_ref().to_string();
    let started = Instant::now();
    let result = work();
    eprintln!(
        "[maru-startup] {name}: {:.2}ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
    result
}

pub fn load_registry() -> Result<SkillsRegistry, String> {
    let _guard = registry_guard()?;
    load_registry_unlocked()
}

fn load_registry_unlocked() -> Result<SkillsRegistry, String> {
    let root = host_fs::skills_root()?;
    host_fs::ensure_dir(&root)?;
    for name in ["_sources", "_managed", "_imported", "_cache"] {
        host_fs::ensure_dir(&root.join(name))?;
    }
    let path = registry_path()?;
    if !path.is_file() {
        return Ok(SkillsRegistry::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&path)))?;
    if content.trim().is_empty() {
        return Ok(SkillsRegistry::default());
    }
    let mut registry: SkillsRegistry = serde_json::from_str(&content)
        .map_err(|err| format!("Cannot parse {}: {err}", host_fs::display_path(&path)))?;
    let loaded_version = registry.version;
    migrate_loaded_registry(&mut registry, loaded_version);
    normalize_removed_source_ids(&mut registry);
    apply_registry_validation(&mut registry);
    Ok(registry)
}

fn load_registry_readonly_unlocked() -> Result<SkillsRegistry, String> {
    let path = host_fs::skills_root()?.join(REGISTRY_FILE);
    if !path.is_file() {
        return Ok(SkillsRegistry::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&path)))?;
    if content.trim().is_empty() {
        return Ok(SkillsRegistry::default());
    }
    let mut registry: SkillsRegistry = serde_json::from_str(&content)
        .map_err(|err| format!("Cannot parse {}: {err}", host_fs::display_path(&path)))?;
    let loaded_version = registry.version;
    migrate_loaded_registry(&mut registry, loaded_version);
    normalize_removed_source_ids(&mut registry);
    apply_registry_validation(&mut registry);
    Ok(registry)
}

fn migrate_loaded_registry(registry: &mut SkillsRegistry, loaded_version: u32) {
    if loaded_version < 2 {
        migrate_legacy_skill_tiers(registry);
    }
    for source in &mut registry.sources {
        source.ownership_class = source_ownership_class(&source.id, &source.kind);
    }
    registry.version = REGISTRY_VERSION;
}

fn migrate_legacy_skill_tiers(registry: &mut SkillsRegistry) {
    let sources: BTreeMap<String, SkillSource> = registry
        .sources
        .iter()
        .map(|source| (source.id.clone(), source.clone()))
        .collect();
    for skill in &mut registry.skills {
        if normalize_skill_tier(&skill.tier).is_none() || skill.tier == default_skill_tier() {
            skill.tier = sources
                .get(&skill.source_id)
                .map(infer_skill_tier)
                .unwrap_or_else(|| infer_skill_tier_from_source_id(&skill.source_id));
        }
    }
}

fn save_registry_unlocked(registry: &SkillsRegistry) -> Result<(), String> {
    host_fs::write_json_pretty(&registry_path()?, registry)
}

pub fn get_skill(skill_id: &str) -> Result<SkillRecord, String> {
    let registry = load_registry()?;
    registry
        .skills
        .into_iter()
        .find(|skill| skill.id == skill_id)
        .ok_or_else(|| format!("unknown_skill: {skill_id}"))
}

pub fn env_vars_for_runs() -> Result<BTreeMap<String, String>, String> {
    let env_root = host_fs::env_root()?;
    let bin = env_root.join(".venv").join("bin");
    let node_modules = env_root.join("node_modules");
    let mut vars = BTreeMap::new();
    vars.insert(
        "MARU_SKILLS_ENV".to_string(),
        host_fs::display_path(&env_root),
    );
    vars.insert(
        "VIRTUAL_ENV".to_string(),
        host_fs::display_path(&env_root.join(".venv")),
    );
    let existing_path = std::env::var_os("PATH");
    let merged_path = merge_path_env(Some(bin.as_os_str()), existing_path.as_deref());
    vars.insert(
        "PATH".to_string(),
        merged_path.to_string_lossy().to_string(),
    );
    let existing_node_path = std::env::var_os("NODE_PATH");
    let merged_node_path = merge_path_env(
        Some(node_modules.as_os_str()),
        existing_node_path.as_deref(),
    );
    vars.insert(
        "NODE_PATH".to_string(),
        merged_node_path.to_string_lossy().to_string(),
    );
    Ok(vars)
}

pub fn default_public_env_setup(work_path: Option<&str>) -> Result<Option<PathBuf>, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    ensure_default_sources(&mut registry, work_path)?;
    save_registry_unlocked(&registry)?;
    builtin_env_setup_path()
}

fn registry_path() -> Result<PathBuf, String> {
    Ok(host_fs::skills_root()?.join(REGISTRY_FILE))
}

fn ensure_default_sources(
    registry: &mut SkillsRegistry,
    work_path: Option<&str>,
) -> Result<(), String> {
    ensure_builtin_source(registry)?;
    ensure_managed_source(registry)?;
    ensure_imported_source(registry)?;
    ensure_catalog_sources(registry);
    ensure_inventory_sources(registry);
    let Some(work_path) = work_path else {
        return Ok(());
    };
    let config_path = Path::new(work_path).join("workspace.config.yaml");
    if !config_path.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&config_path)))?;
    let yaml: YamlValue = serde_yaml::from_str(&content).map_err(|err| {
        format!(
            "Cannot parse {}: {err}",
            host_fs::display_path(&config_path)
        )
    })?;
    let Some(skills) = yaml.get("skills") else {
        return Ok(());
    };
    let public_root = yaml_string(skills, "public_root");
    let public_skills = yaml_string(skills, "public_skills");
    if let Some(root) = public_root {
        upsert_default_linked_source(
            registry,
            STAI_PUBLIC_SOURCE_ID,
            &root,
            skills_subdir_for(&root, public_skills.as_deref()),
        );
    }
    let private_root = yaml_string(skills, "private_root");
    let private_skills = yaml_string(skills, "private_skills");
    if let Some(root) = private_root {
        upsert_default_linked_source(
            registry,
            STAI_PRIVATE_SOURCE_ID,
            &root,
            skills_subdir_for(&root, private_skills.as_deref()),
        );
    }
    Ok(())
}

fn ensure_catalog_sources(registry: &mut SkillsRegistry) {
    let Ok(root) = host_fs::skills_root() else {
        return;
    };
    for (id, directory) in [
        (STAI_PUBLIC_SOURCE_ID, "skills-public"),
        (STAI_PRIVATE_SOURCE_ID, "skills-private"),
    ] {
        let path = root.join("_sources").join(directory);
        if path.is_dir() {
            clear_removed_source(registry, id);
            upsert_default_linked_source(
                registry,
                id,
                &host_fs::display_path(&path),
                "skills".to_string(),
            );
        }
    }
}

fn ensure_inventory_sources(registry: &mut SkillsRegistry) {
    let Ok(home) = host_fs::install_root_base() else {
        return;
    };
    let inventories = [
        (
            AGENTS_EXTERNAL_SOURCE_ID,
            "external-managed",
            home.join(".agents"),
            "skills",
        ),
        (
            CODEX_NATIVE_SOURCE_ID,
            "tool-native",
            home.join(".codex").join("skills").join(".system"),
            ".",
        ),
    ];
    for (id, kind, path, skills_subdir) in inventories {
        if !path.is_dir() {
            registry.sources.retain(|source| source.id != id);
            registry.skills.retain(|skill| skill.source_id != id);
            continue;
        }
        clear_removed_source(registry, id);
        let source = SkillSource {
            id: id.to_string(),
            kind: kind.to_string(),
            ownership_class: source_ownership_class(id, kind),
            path: Some(host_fs::display_path(&canonicalize_or_self(&path))),
            repo_url: None,
            skills_subdir: skills_subdir.to_string(),
            branch: None,
            last_synced_at: None,
        };
        if let Some(existing) = registry.sources.iter_mut().find(|source| source.id == id) {
            *existing = source;
        } else {
            registry.sources.push(source);
        }
    }
}

fn add_embedded_builtin_readonly(registry: &mut SkillsRegistry) -> Result<(), String> {
    let root = builtin_materialized_root()?;
    if root.join("manifest.json").is_file() || is_removed_source(registry, BUILTIN_SOURCE_ID) {
        return Ok(());
    }

    let source = SkillSource {
        id: BUILTIN_SOURCE_ID.to_string(),
        kind: "builtin".to_string(),
        ownership_class: source_ownership_class(BUILTIN_SOURCE_ID, "builtin"),
        path: Some(host_fs::display_path(&root)),
        repo_url: None,
        skills_subdir: "skills".to_string(),
        branch: None,
        last_synced_at: None,
    };
    if let Some(existing) = registry
        .sources
        .iter_mut()
        .find(|source| source.id == BUILTIN_SOURCE_ID)
    {
        *existing = source.clone();
    } else {
        registry.sources.push(source.clone());
    }

    let manifest = BUILTIN_DIR
        .get_file("manifest.json")
        .ok_or_else(|| "embedded_builtin_manifest_missing".to_string())?;
    let manifest: serde_json::Value = serde_json::from_slice(manifest.contents())
        .map_err(|err| format!("embedded_builtin_manifest_invalid: {err}"))?;
    let entries = manifest
        .get("skills")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "embedded_builtin_manifest_skills_missing".to_string())?;

    registry
        .skills
        .retain(|skill| skill.source_id != BUILTIN_SOURCE_ID);
    for entry in entries {
        let name = entry
            .get("name")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "embedded_builtin_name_missing".to_string())?;
        let name = host_fs::safe_entry_name(name)?;
        let rel_path = entry
            .get("path")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("embedded_builtin_path_missing: {name}"))?;
        let dir = BUILTIN_DIR
            .get_dir(rel_path)
            .ok_or_else(|| format!("embedded_builtin_dir_missing: {rel_path}"))?;
        let skill_md = BUILTIN_DIR
            .get_file(format!("{rel_path}/SKILL.md"))
            .ok_or_else(|| format!("embedded_builtin_skill_missing: {name}"))?;
        let content = skill_md
            .contents_utf8()
            .ok_or_else(|| format!("embedded_builtin_skill_not_utf8: {name}"))?;
        let parts = parse_frontmatter(content);
        let validation_errors = validate_skill_frontmatter(content, &parts.meta);
        let current_hash = hash_include_dir(dir);
        let manifest_tier = entry
            .get("tier")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string);
        let frontmatter_tier = yaml_meta_string(&parts.meta, "tier");
        let tier = manifest_tier
            .as_deref()
            .or(frontmatter_tier.as_deref())
            .and_then(normalize_skill_tier)
            .unwrap_or_else(|| infer_skill_tier(&source));
        registry.skills.push(SkillRecord {
            id: format!("{BUILTIN_SOURCE_ID}::{name}"),
            source_id: BUILTIN_SOURCE_ID.to_string(),
            name: name.clone(),
            rel_path: rel_path.to_string(),
            abs_path: host_fs::display_path(&root.join(rel_path)),
            title: yaml_meta_string(&parts.meta, "name")
                .or_else(|| yaml_meta_string(&parts.meta, "title"))
                .unwrap_or_else(|| title_from_content(content, &name)),
            description: yaml_meta_string(&parts.meta, "description"),
            runtime: yaml_meta_string(&parts.meta, "runtime"),
            category: yaml_meta_string(&parts.meta, "category"),
            tier,
            valid: validation_errors.is_empty(),
            validation_errors,
            editable: true,
            dirty: false,
            content_hash: Some(current_hash.clone()),
            saved_hash: Some(current_hash),
        });
    }
    registry.skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(())
}

fn add_default_sources_readonly(
    registry: &mut SkillsRegistry,
    work_path: Option<&str>,
) -> Result<(), String> {
    let root = host_fs::skills_root()?;
    let defaults = [
        (
            BUILTIN_SOURCE_ID,
            "builtin",
            root.join(BUILTIN_DIR_NAME),
            "skills",
        ),
        (MANAGED_SOURCE_ID, "managed", root.join("_managed"), "."),
        (
            IMPORTED_SOURCE_ID,
            "imported",
            root.join("_imported"),
            "skills",
        ),
        (
            STAI_PUBLIC_SOURCE_ID,
            "linked",
            root.join("_sources").join("skills-public"),
            "skills",
        ),
        (
            STAI_PRIVATE_SOURCE_ID,
            "linked",
            root.join("_sources").join("skills-private"),
            "skills",
        ),
    ];
    for (id, kind, path, skills_subdir) in defaults {
        if !path.is_dir() || is_removed_source(registry, id) {
            continue;
        }
        let source = SkillSource {
            id: id.to_string(),
            kind: kind.to_string(),
            ownership_class: source_ownership_class(id, kind),
            path: Some(host_fs::display_path(&canonicalize_or_self(&path))),
            repo_url: None,
            skills_subdir: skills_subdir.to_string(),
            branch: None,
            last_synced_at: None,
        };
        if let Some(existing) = registry.sources.iter_mut().find(|source| source.id == id) {
            *existing = source;
        } else {
            registry.sources.push(source);
        }
    }
    ensure_inventory_sources(registry);

    // Apply workspace catalog overrides in memory, while keeping this read
    // path free of filesystem writes. This mirrors `ensure_default_sources`
    // so `doctor` and `skills sync --check` inspect the same catalog as apply.
    let Some(work_path) = work_path else {
        return Ok(());
    };
    let config_path = Path::new(work_path).join("workspace.config.yaml");
    if !config_path.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&config_path)))?;
    let yaml: YamlValue = serde_yaml::from_str(&content).map_err(|err| {
        format!(
            "Cannot parse {}: {err}",
            host_fs::display_path(&config_path)
        )
    })?;
    if let Some(skills) = yaml.get("skills") {
        if let Some(root) = yaml_string(skills, "public_root") {
            upsert_default_linked_source(
                registry,
                STAI_PUBLIC_SOURCE_ID,
                &root,
                skills_subdir_for(&root, yaml_string(skills, "public_skills").as_deref()),
            );
        }
        if let Some(root) = yaml_string(skills, "private_root") {
            upsert_default_linked_source(
                registry,
                STAI_PRIVATE_SOURCE_ID,
                &root,
                skills_subdir_for(&root, yaml_string(skills, "private_skills").as_deref()),
            );
        }
    }
    Ok(())
}

fn ensure_builtin_source(registry: &mut SkillsRegistry) -> Result<(), String> {
    clear_removed_source(registry, BUILTIN_SOURCE_ID);
    let builtin = builtin_materialized_root()?;
    ensure_active_bundle(&builtin)?;
    let source = SkillSource {
        id: BUILTIN_SOURCE_ID.to_string(),
        kind: "builtin".to_string(),
        ownership_class: "bundled".to_string(),
        path: Some(host_fs::display_path(&builtin)),
        repo_url: None,
        skills_subdir: "skills".to_string(),
        branch: None,
        last_synced_at: None,
    };
    if let Some(existing) = registry
        .sources
        .iter_mut()
        .find(|source| source.id == BUILTIN_SOURCE_ID)
    {
        *existing = source;
    } else {
        registry.sources.insert(0, source);
    }
    Ok(())
}

fn ensure_managed_source(registry: &mut SkillsRegistry) -> Result<(), String> {
    clear_removed_source(registry, MANAGED_SOURCE_ID);
    let managed = host_fs::skills_root()?.join("_managed");
    host_fs::ensure_dir(&managed)?;
    if !registry
        .sources
        .iter()
        .any(|source| source.id == MANAGED_SOURCE_ID)
    {
        registry.sources.push(SkillSource {
            id: MANAGED_SOURCE_ID.to_string(),
            kind: "managed".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(host_fs::display_path(&managed)),
            repo_url: None,
            skills_subdir: ".".to_string(),
            branch: None,
            last_synced_at: None,
        });
    }
    Ok(())
}

fn ensure_imported_source(registry: &mut SkillsRegistry) -> Result<(), String> {
    clear_removed_source(registry, IMPORTED_SOURCE_ID);
    let imported = imported_root()?;
    host_fs::ensure_dir(&imported.join("skills"))?;
    if !registry
        .sources
        .iter()
        .any(|source| source.id == IMPORTED_SOURCE_ID)
    {
        registry.sources.push(SkillSource {
            id: IMPORTED_SOURCE_ID.to_string(),
            kind: "imported".to_string(),
            ownership_class: "imported".to_string(),
            path: Some(host_fs::display_path(&imported)),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });
    }
    Ok(())
}

fn imported_root() -> Result<PathBuf, String> {
    Ok(host_fs::skills_root()?.join("_imported"))
}

fn builtin_materialized_root() -> Result<PathBuf, String> {
    Ok(host_fs::skills_root()?.join(BUILTIN_DIR_NAME))
}

fn builtin_env_setup_path() -> Result<Option<PathBuf>, String> {
    let root = builtin_materialized_root()?;
    ensure_active_bundle(&root)?;
    let setup = root.join("envs").join("default").join("setup.sh");
    Ok(setup.is_file().then_some(setup))
}

fn materialize_builtin_bundle(root: &Path) -> Result<(), String> {
    host_fs::ensure_dir(root)?;
    let hashes_path = root.join(BUILTIN_HASHES_FILE);
    let mut stored_hashes: BTreeMap<String, String> = if hashes_path.is_file() {
        fs::read_to_string(&hashes_path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default()
    } else {
        BTreeMap::new()
    };
    let mut next_hashes = BTreeMap::new();
    materialize_include_dir(
        &BUILTIN_DIR,
        root,
        Path::new(""),
        &mut stored_hashes,
        &mut next_hashes,
    )?;
    remove_clean_obsolete_builtin_files(root, &stored_hashes, &next_hashes)?;
    host_fs::write_json_pretty(&hashes_path, &next_hashes)
}

fn materialize_include_dir(
    dir: &Dir<'_>,
    root: &Path,
    rel_base: &Path,
    stored_hashes: &mut BTreeMap<String, String>,
    next_hashes: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    for child in dir.dirs() {
        let rel = rel_base.join(child.path().file_name().unwrap_or_default());
        host_fs::ensure_dir(&root.join(&rel))?;
        materialize_include_dir(child, root, &rel, stored_hashes, next_hashes)?;
    }
    for file in dir.files() {
        let rel = rel_base.join(file.path().file_name().unwrap_or_default());
        let rel_key = rel.to_string_lossy().to_string();
        let contents = file.contents();
        let embedded_hash = sha256_hex(contents);
        let target = root.join(&rel);
        let current_hash = if target.is_file() {
            hash_file(&target).ok()
        } else {
            None
        };
        let should_write = match current_hash.as_deref() {
            None => true,
            Some(current) if current == embedded_hash => false,
            Some(current) => stored_hashes
                .get(&rel_key)
                .map(|stored| stored == current)
                .unwrap_or(false),
        };
        if should_write {
            if let Some(parent) = target.parent() {
                host_fs::ensure_dir(parent)?;
            }
            fs::write(&target, contents)
                .map_err(|err| format!("Cannot write {}: {err}", host_fs::display_path(&target)))?;
            set_builtin_file_mode(&target, contents)?;
        }
        next_hashes.insert(rel_key, embedded_hash);
    }
    Ok(())
}

fn remove_clean_obsolete_builtin_files(
    root: &Path,
    stored_hashes: &BTreeMap<String, String>,
    next_hashes: &BTreeMap<String, String>,
) -> Result<(), String> {
    for (rel, old_hash) in stored_hashes {
        if next_hashes.contains_key(rel) {
            continue;
        }
        let path = root.join(rel);
        if path.is_file() && hash_file(&path).as_deref() == Ok(old_hash.as_str()) {
            fs::remove_file(&path).map_err(|err| {
                format!(
                    "Cannot remove obsolete builtin file {}: {err}",
                    host_fs::display_path(&path)
                )
            })?;
        }
    }
    Ok(())
}

fn set_builtin_file_mode(path: &Path, contents: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mode = if contents.starts_with(b"#!") {
            0o755
        } else {
            0o644
        };
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|err| {
            format!(
                "Cannot set permissions for {}: {err}",
                host_fs::display_path(path)
            )
        })?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, contents);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// OTA skills bundle: state bootstrap, dirty detection, check/apply commands.
// Network/verification/zip plumbing lives in skill_host::bundle_update.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBundleAvailable {
    pub bundle_id: String,
    pub revision: u64,
    pub display_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    pub min_app_version: String,
    pub env_hash: String,
    pub archive_size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBundleStatus {
    pub app_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<SkillBundleRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<SkillBundleAvailable>,
    pub update_available: bool,
    /// Areas drifted from the active pristine baseline: builtin skill names,
    /// or top-level bundle areas ("envs", "lib", "manifest.json", ...).
    pub dirty_skills: Vec<String>,
    /// "target/installed_as" copy installs whose source skill moved on.
    pub stale_copy_installs: Vec<String>,
    pub env_update_required: bool,
    pub min_app_ok: bool,
    pub auto_applicable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBundleApplyOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<SkillBundleRef>,
    pub current: SkillBundleRef,
    pub added_skills: Vec<String>,
    pub updated_skills: Vec<String>,
    pub removed_skills: Vec<String>,
    pub stale_copy_installs: Vec<String>,
    pub removed_installs: usize,
    pub restart_required: bool,
}

fn embedded_channel() -> (String, String) {
    let repo_fallback = "STAIxBWLB/maru".to_string();
    let tag_fallback = "skills-channel".to_string();
    let Some(manifest) = BUILTIN_DIR.get_file("manifest.json") else {
        return (repo_fallback, tag_fallback);
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(manifest.contents()) else {
        return (repo_fallback, tag_fallback);
    };
    let repo = value
        .get("repoSlug")
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
        .unwrap_or(repo_fallback);
    let tag = value
        .get("channelTag")
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
        .unwrap_or(tag_fallback);
    (repo, tag)
}

fn bootstrap_bundle_ref() -> SkillBundleRef {
    let tree_hash = hash_include_dir(&BUILTIN_DIR);
    let mut env_files = Vec::new();
    if let Some(envs) = BUILTIN_DIR.get_dir("envs") {
        collect_include_files(envs, Path::new(""), &mut env_files);
    }
    let pairs = env_files
        .into_iter()
        .map(|(rel, contents)| (rel.replace('\\', "/"), sha256_hex(contents)))
        .collect();
    SkillBundleRef {
        bundle_id: format!("bootstrap-{}", &tree_hash[..12]),
        revision: 0,
        display_version: "bootstrap".to_string(),
        commit: None,
        source: bundle::BOOTSTRAP_SOURCE.to_string(),
        env_hash: bundle::hash_from_file_hashes(pairs),
        applied_at: Utc::now().to_rfc3339(),
    }
}

/// Materialize the embedded snapshot as a pristine baseline dir (write to a
/// sibling temp dir, then rename, so a crash never leaves a half baseline).
fn write_bootstrap_pristine(pristine: &Path) -> Result<(), String> {
    let parent = pristine
        .parent()
        .ok_or_else(|| "bundle_pristine_invalid".to_string())?;
    host_fs::ensure_dir(parent)?;
    let name = pristine
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("bootstrap");
    let tmp = parent.join(format!(".{name}.tmp"));
    if tmp.exists() {
        fs::remove_dir_all(&tmp)
            .map_err(|err| format!("Cannot clear {}: {err}", host_fs::display_path(&tmp)))?;
    }
    host_fs::ensure_dir(&tmp)?;
    copy_include_dir_unconditional(&BUILTIN_DIR, &tmp, BUILTIN_DIR.path())?;
    if pristine.exists() {
        fs::remove_dir_all(pristine)
            .map_err(|err| format!("Cannot clear {}: {err}", host_fs::display_path(pristine)))?;
    }
    fs::rename(&tmp, pristine).map_err(|err| {
        format!(
            "Cannot move {} to {}: {err}",
            host_fs::display_path(&tmp),
            host_fs::display_path(pristine)
        )
    })
}

/// Bootstrap or repair the active-bundle state. Never downgrades: once a
/// state file exists, `_builtin` is left alone (an applied remote bundle
/// always wins over the embedded snapshot); the embedded snapshot only seeds
/// fresh installs and self-heals a missing bootstrap pristine baseline.
/// Remove swap leftovers (orphaned backups, staged next-dirs) that a crash
/// between journal clear and cleanup can strand. Only safe with no journal
/// present, which recover_interrupted_swap guarantees before this runs.
fn sweep_swap_orphans() -> Result<(), String> {
    let root = host_fs::skills_root()?;
    if !root.is_dir() {
        return Ok(());
    }
    let cache = root.join("_cache");
    if cache.is_dir() {
        for entry in fs::read_dir(&cache).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("backup-") && entry.path().is_dir() {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    for entry in fs::read_dir(&root).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("_builtin.next-") && entry.path().is_dir() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

fn ensure_active_bundle(builtin_root: &Path) -> Result<BundleState, String> {
    bundle::recover_interrupted_swap(builtin_root)?;
    sweep_swap_orphans()?;
    if let Some(state) = bundle::read_state()? {
        if let Some(active) = &state.active {
            let pristine = bundle::bundle_pristine_dir(&active.bundle_id)?;
            if !pristine.is_dir() && active.source == bundle::BOOTSTRAP_SOURCE {
                write_bootstrap_pristine(&pristine)?;
            }
            // Self-heal a lost _builtin (interrupted swap whose backup was
            // externally cleaned): the pristine baseline is the exact active
            // bundle content.
            if !builtin_root.is_dir() && pristine.is_dir() {
                copy_dir_all(&pristine, builtin_root)?;
            }
            return Ok(state);
        }
    }
    // No state: fresh install, or first run after upgrading from an app that
    // shipped skills inside the binary. The legacy 3-way materialize
    // preserves user edits byte-identical; on a fresh install it writes all.
    let bootstrap = bootstrap_bundle_ref();
    let pristine = bundle::bundle_pristine_dir(&bootstrap.bundle_id)?;
    if !pristine.is_dir() {
        write_bootstrap_pristine(&pristine)?;
    }
    profile_timing_result("skills.materialize_builtin_bundle", || {
        materialize_builtin_bundle(builtin_root)
    })?;
    let state = BundleState {
        schema: 1,
        active: Some(bootstrap),
        previous: None,
    };
    bundle::write_state(&state)?;
    Ok(state)
}

/// Junk that appears inside `_builtin` from running skills (python caches,
/// Finder droppings) and must count neither as user edits nor bundle content.
fn is_bundle_junk(rel: &Path) -> bool {
    let junk_dirs = ["__pycache__", ".pytest_cache", "node_modules", ".venv"];
    if rel.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|value| junk_dirs.contains(&value))
            .unwrap_or(false)
    }) {
        return true;
    }
    match rel.file_name().and_then(|name| name.to_str()) {
        Some(".DS_Store") => true,
        Some(name) if name == BUILTIN_HASHES_FILE => true,
        Some(name) if name.ends_with(".pyc") => true,
        _ => false,
    }
}

fn hash_directory_filtered(path: &Path) -> Result<String, String> {
    let mut entries: Vec<PathBuf> = WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.path().to_path_buf())
        .filter(|file| {
            file.strip_prefix(path)
                .map(|rel| !is_bundle_junk(rel))
                .unwrap_or(true)
        })
        .collect();
    entries.sort();
    let mut hasher = Sha256::new();
    for file in entries {
        let rel = file.strip_prefix(path).unwrap_or(&file).to_string_lossy();
        hasher.update(rel.as_bytes());
        hasher.update(b"\0");
        let data = fs::read(&file)
            .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&file)))?;
        hasher.update(sha256_hex(&data).as_bytes());
        hasher.update(b"\0");
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn active_pristine_skill_hash(name: &str) -> Option<String> {
    let active = bundle::read_state().ok()??.active?;
    let dir = bundle::bundle_pristine_dir(&active.bundle_id)
        .ok()?
        .join("skills")
        .join(name);
    if !dir.is_dir() {
        return None;
    }
    hash_directory_filtered(&dir).ok()
}

fn collect_bundle_hashes(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut map = BTreeMap::new();
    if !root.is_dir() {
        return Ok(map);
    }
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|err| err.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .map_err(|err| err.to_string())?;
        if is_bundle_junk(rel) {
            continue;
        }
        let rel_str = rel
            .components()
            .map(|component| component.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");
        let data = fs::read(entry.path())
            .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(entry.path())))?;
        map.insert(rel_str, sha256_hex(&data));
    }
    Ok(map)
}

fn dirty_area(rel: &str) -> String {
    let parts: Vec<&str> = rel.splitn(3, '/').collect();
    match parts.as_slice() {
        ["skills", name, _rest] => (*name).to_string(),
        [first, ..] => (*first).to_string(),
        [] => rel.to_string(),
    }
}

/// Areas of `_builtin` that drifted from the pristine baseline (user edits,
/// user-added files, deletions). Junk is ignored on both sides.
fn bundle_dirty_areas(builtin_root: &Path, pristine: &Path) -> Result<Vec<String>, String> {
    let baseline = collect_bundle_hashes(pristine)?;
    let current = collect_bundle_hashes(builtin_root)?;
    let mut areas = BTreeSet::new();
    for (rel, sha) in &baseline {
        if current.get(rel) != Some(sha) {
            areas.insert(dirty_area(rel));
        }
    }
    for rel in current.keys() {
        if !baseline.contains_key(rel) {
            areas.insert(dirty_area(rel));
        }
    }
    Ok(areas.into_iter().collect())
}

fn pristine_skill_names(root: &Path) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let skills = root.join("skills");
    let Ok(entries) = fs::read_dir(&skills) else {
        return names;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("SKILL.md").is_file() {
            names.insert(entry.file_name().to_string_lossy().to_string());
        }
    }
    names
}

fn diff_bundle_skills(
    old_pristine: &Path,
    new_pristine: &Path,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let old_names = pristine_skill_names(old_pristine);
    let new_names = pristine_skill_names(new_pristine);
    let added: Vec<String> = new_names.difference(&old_names).cloned().collect();
    let removed: Vec<String> = old_names.difference(&new_names).cloned().collect();
    let mut updated = Vec::new();
    for name in old_names.intersection(&new_names) {
        let old_hash = hash_directory_filtered(&old_pristine.join("skills").join(name)).ok();
        let new_hash = hash_directory_filtered(&new_pristine.join("skills").join(name)).ok();
        if old_hash != new_hash {
            updated.push(name.clone());
        }
    }
    (added, updated, removed)
}

/// Copy-mode installs of builtin skills whose SKILL.md moved on since the
/// copy was made ("target/installed_as"). Copies are never auto-touched.
fn stale_copy_installs_report(registry: &SkillsRegistry) -> Vec<String> {
    let Ok(root) = builtin_materialized_root() else {
        return Vec::new();
    };
    let prefix = format!("{BUILTIN_SOURCE_ID}::");
    registry
        .installs
        .iter()
        .filter(|install| install.mode == "copy" && install.skill_id.starts_with(&prefix))
        .filter_map(|install| {
            let name = install.skill_id.strip_prefix(&prefix)?;
            let marker = read_install_marker(Path::new(&install.target_path))?;
            let source_hash = marker.source_hash?;
            let current = hash_file(&root.join("skills").join(name).join("SKILL.md")).ok();
            (current.as_deref() != Some(source_hash.as_str()))
                .then(|| format!("{}/{}", install.target, install.installed_as))
        })
        .collect()
}

/// Remove installs of skills the new bundle dropped — but only links that are
/// provably Maru-owned end to end. Foreign links and copy installs survive.
fn cleanup_removed_builtin_installs(
    registry: &mut SkillsRegistry,
    removed: &[String],
) -> Result<usize, String> {
    let builtin_prefix = builtin_materialized_root()?;
    let mut count = 0;
    for name in removed {
        let skill_id = format!("{BUILTIN_SOURCE_ID}::{name}");
        let matches: Vec<SkillInstall> = registry
            .installs
            .iter()
            .filter(|install| {
                install.skill_id == skill_id
                    && install.managed_by == "maru"
                    && install.mode == "symlink"
            })
            .cloned()
            .collect();
        for install in matches {
            let tool_target = PathBuf::from(&install.target_path);
            let maru_entry = PathBuf::from(&install.entrypoint_path);
            let _ = host_fs::remove_if_matching_symlink(&tool_target, &maru_entry);
            if let Some(link_target) = host_fs::read_link_target(&maru_entry) {
                if link_target.starts_with(&builtin_prefix) && !link_target.exists() {
                    let _ = fs::remove_file(&maru_entry);
                }
            }
            registry.installs.retain(|other| {
                !(other.target == install.target && other.installed_as == install.installed_as)
            });
            count += 1;
        }
    }
    Ok(count)
}

/// Synchronous env repair used inside the apply transaction, running the
/// setup script from the STAGED new bundle BEFORE the swap: a failure means
/// nothing was applied and no rollback is needed. Mutations setup.sh makes
/// to the shared ~/.maru/env are idempotent by contract but not journaled.
// ponytail: no output streaming or env status.json update here — the env
// pane re-derives health from the venv; add streaming if repairs get long.
fn run_env_repair_blocking(
    progress: ProgressReporter<'_>,
    bundle_root: &Path,
) -> Result<(), String> {
    let setup = bundle_root.join("envs").join("default").join("setup.sh");
    if !setup.is_file() {
        progress.info("Bundle has no env setup script; skipping env repair");
        return Ok(());
    }
    let root = host_fs::env_root()?;
    host_fs::ensure_dir(&root)?;
    progress.info("Repairing skills environment (this can take a few minutes)");
    let output = Command::new("bash")
        .arg(&setup)
        .arg("--target")
        .arg(&root)
        .no_window()
        .output()
        .map_err(|err| format!("env_repair_spawn_failed: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let line = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("env repair failed")
            .to_string();
        return Err(format!("env_repair_failed: {line}"));
    }
    progress.success("Skills environment repaired");
    Ok(())
}

fn prune_bundle_dirs(keep: &[&str]) -> Result<(), String> {
    let dir = bundle::bundles_dir()?;
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(&dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !keep.contains(&name.as_str()) && entry.path().is_dir() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

fn bundle_id_for(metadata: &bundle::BundleMetadata) -> String {
    metadata
        .archive
        .name
        .trim_start_matches("maru-skills-")
        .trim_end_matches(".zip")
        .to_string()
}

#[tauri::command]
pub fn skills_bundle_status() -> Result<SkillBundleStatus, String> {
    skills_bundle_status_impl(None)
}

#[tauri::command]
pub fn skills_check_bundle_update(force: Option<bool>) -> Result<SkillBundleStatus, String> {
    // No response caching yet, so every check hits the channel; the flag is
    // accepted for API stability.
    let _ = force;
    // Check is the designated launch entry point, so it first settles any
    // interrupted swap (journal recovery + _builtin self-heal). Status and
    // doctor stay strictly read-only.
    {
        let _guard = registry_guard()?;
        ensure_active_bundle(&builtin_materialized_root()?)?;
    }
    let (repo, tag) = embedded_channel();
    let remote = bundle::discover_remote_bundle(&repo, &tag)?;
    skills_bundle_status_impl(remote.as_ref())
}

fn skills_bundle_status_impl(
    remote: Option<&bundle::RemoteBundle>,
) -> Result<SkillBundleStatus, String> {
    let builtin_root = builtin_materialized_root()?;
    let state = bundle::read_state()?.unwrap_or_default();
    let active = state.active;
    // pristine_ok=false means we cannot prove _builtin is clean (baseline
    // missing); auto-apply must not run in that state.
    let (dirty, pristine_ok) = match &active {
        Some(active) => {
            let pristine = bundle::bundle_pristine_dir(&active.bundle_id)?;
            if pristine.is_dir() {
                (bundle_dirty_areas(&builtin_root, &pristine)?, true)
            } else {
                (Vec::new(), false)
            }
        }
        None => (Vec::new(), true),
    };
    let registry = load_registry()?;
    let stale_copy_installs = stale_copy_installs_report(&registry);
    let (update_available, available, env_update_required, min_app_ok) = match remote {
        Some(remote) => {
            let metadata = &remote.metadata;
            let newer = active
                .as_ref()
                .map(|active| metadata.revision > active.revision)
                .unwrap_or(true);
            let env_changed = active
                .as_ref()
                .map(|active| metadata.env_hash != active.env_hash)
                .unwrap_or(false);
            let min_ok = bundle::app_version_satisfies(&metadata.min_app_version);
            let available = SkillBundleAvailable {
                bundle_id: bundle_id_for(metadata),
                revision: metadata.revision,
                display_version: metadata.display_version.clone(),
                commit: metadata.commit.clone(),
                published_at: metadata.published_at.clone(),
                min_app_version: metadata.min_app_version.clone(),
                env_hash: metadata.env_hash.clone(),
                archive_size: metadata.archive.size,
            };
            (newer, Some(available), newer && env_changed, min_ok)
        }
        None => (false, None, false, true),
    };
    let auto_applicable =
        update_available && min_app_ok && !env_update_required && dirty.is_empty() && pristine_ok;
    Ok(SkillBundleStatus {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        active,
        available,
        update_available,
        dirty_skills: dirty,
        stale_copy_installs,
        env_update_required,
        min_app_ok,
        auto_applicable,
    })
}

#[tauri::command]
pub fn skills_apply_bundle_update(
    app: AppHandle,
    bundle_id: Option<String>,
    repair_env: Option<bool>,
    progress_id: Option<String>,
) -> Result<SkillBundleApplyOutcome, String> {
    let outcome = skills_apply_bundle_update_impl(
        bundle_id,
        repair_env.unwrap_or(false),
        ProgressReporter::new(&app, progress_id.as_deref()),
    )?;
    let _ = app.emit("skills://updated", &outcome);
    Ok(outcome)
}

pub fn skills_apply_bundle_update_headless(
    bundle_id: Option<String>,
    repair_env: bool,
) -> Result<SkillBundleApplyOutcome, String> {
    skills_apply_bundle_update_impl(bundle_id, repair_env, ProgressReporter::noop())
}

fn skills_apply_bundle_update_impl(
    requested_bundle_id: Option<String>,
    repair_env: bool,
    progress: ProgressReporter<'_>,
) -> Result<SkillBundleApplyOutcome, String> {
    let builtin_root = builtin_materialized_root()?;
    let active = {
        let _guard = registry_guard()?;
        ensure_active_bundle(&builtin_root)?
            .active
            .ok_or_else(|| "bundle_state_missing".to_string())?
    };

    // Everything network-bound happens outside the registry lock.
    progress.info("Checking skills channel");
    let (repo, tag) = embedded_channel();
    let remote = bundle::discover_remote_bundle(&repo, &tag)?
        .ok_or_else(|| "bundle_update_not_available".to_string())?;
    let metadata = remote.metadata.clone();
    let new_bundle_id = bundle_id_for(&metadata);
    if let Some(requested) = &requested_bundle_id {
        if requested != &new_bundle_id {
            return Err(format!(
                "bundle_id_mismatch: requested {requested}, channel has {new_bundle_id}"
            ));
        }
    }
    if metadata.revision <= active.revision {
        return Err(format!(
            "bundle_not_newer: channel r{} <= active r{}",
            metadata.revision, active.revision
        ));
    }
    if !bundle::app_version_satisfies(&metadata.min_app_version) {
        return Err(format!(
            "bundle_requires_app: {} (running {})",
            metadata.min_app_version,
            env!("CARGO_PKG_VERSION")
        ));
    }
    let env_changed = metadata.env_hash != active.env_hash;
    if env_changed && !repair_env {
        return Err("bundle_env_update_required".to_string());
    }

    progress.info(format!(
        "Downloading skills bundle {} ({} bytes)",
        metadata.display_version, metadata.archive.size
    ));
    let archive = bundle::download_verified_archive(&remote)?;
    progress.info("Verifying and staging bundle");
    // Unique staging dir: a concurrent apply must never share (or clobber)
    // another request's staging tree.
    let staging = bundle::staging_root()?.join(format!("{new_bundle_id}-{}", Uuid::new_v4()));
    bundle::extract_bundle_to_staging(&archive, &metadata, &staging)?;

    // Swap under the registry lock.
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    // Fresh installs (e.g. CLI-first use) have an empty registry; the builtin
    // source must exist before the post-swap rescan.
    ensure_default_sources(&mut registry, None)?;
    // Re-read state under the lock: `active` was sampled before the network
    // phase, and a concurrent apply may have already applied this revision.
    // Without this, the loser would delete the winner's active pristine.
    let active = bundle::read_state()?
        .and_then(|state| state.active)
        .ok_or_else(|| "bundle_state_missing".to_string())?;
    if metadata.revision <= active.revision {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "bundle_not_newer: channel r{} <= active r{}",
            metadata.revision, active.revision
        ));
    }
    // Recompute the env gate against the just-read active ref.
    let env_changed = metadata.env_hash != active.env_hash;
    if env_changed && !repair_env {
        let _ = fs::remove_dir_all(&staging);
        return Err("bundle_env_update_required".to_string());
    }
    let old_pristine = bundle::bundle_pristine_dir(&active.bundle_id)?;
    let dirty = if old_pristine.is_dir() {
        bundle_dirty_areas(&builtin_root, &old_pristine)?
    } else {
        let _ = fs::remove_dir_all(&staging);
        return Err("bundle_pristine_missing: cannot prove _builtin is clean".to_string());
    };
    if !dirty.is_empty() {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "bundle_dirty_blocked: local edits in {}. Promote (Save As) or discard them, then retry.",
            dirty.join(", ")
        ));
    }

    let new_pristine = bundle::bundle_pristine_dir(&new_bundle_id)?;
    if new_pristine.exists() {
        fs::remove_dir_all(&new_pristine).map_err(|err| {
            format!(
                "Cannot clear {}: {err}",
                host_fs::display_path(&new_pristine)
            )
        })?;
    }
    host_fs::ensure_dir(new_pristine.parent().unwrap_or(Path::new("/")))?;
    fs::rename(&staging, &new_pristine).map_err(|err| {
        format!(
            "Cannot move staged bundle into {}: {err}",
            host_fs::display_path(&new_pristine)
        )
    })?;
    let (added_skills, updated_skills, removed_skills) =
        diff_bundle_skills(&old_pristine, &new_pristine);

    // Pre-build the complete new _builtin as a sibling dir and run the env
    // repair from it BEFORE any swap: failures up to here touch nothing, and
    // the actual swap shrinks to two renames instead of a full tree copy
    // (minimizing the window where ~/.claude/skills/* symlinks dangle).
    progress.info("Preparing bundle");
    let next_builtin = host_fs::skills_root()?.join(format!("_builtin.next-{}", Uuid::new_v4()));
    if let Err(err) = copy_dir_all(&new_pristine, &next_builtin) {
        let _ = fs::remove_dir_all(&next_builtin);
        let _ = fs::remove_dir_all(&new_pristine);
        return Err(format!("bundle_prepare_failed: {err}"));
    }
    if env_changed {
        // ponytail: setup.sh mutations to ~/.maru/env are NOT rolled back on
        // failure — the script is idempotent by contract and the next repair
        // reconverges; the bundle itself has not been applied yet.
        if let Err(err) = run_env_repair_blocking(progress, &next_builtin) {
            let _ = fs::remove_dir_all(&next_builtin);
            let _ = fs::remove_dir_all(&new_pristine);
            return Err(err);
        }
    }

    progress.info("Applying bundle");
    let backup = host_fs::skills_root()?.join("_cache").join(format!(
        "backup-{}",
        Utc::now().format("%Y%m%d%H%M%S%.9f")
    ));
    bundle::write_journal(&SwapJournal {
        schema: 1,
        new_bundle_id: new_bundle_id.clone(),
        backup_dir: host_fs::display_path(&backup),
        started_at: Utc::now().to_rfc3339(),
    })?;
    if let Err(err) = fs::rename(&builtin_root, &backup) {
        let _ = bundle::clear_journal();
        let _ = fs::remove_dir_all(&next_builtin);
        let _ = fs::remove_dir_all(&new_pristine);
        return Err(format!("bundle_swap_failed: {err}"));
    }
    let rollback = |reason: String| -> String {
        let _ = fs::remove_dir_all(&builtin_root);
        let _ = fs::rename(&backup, &builtin_root);
        let _ = bundle::clear_journal();
        let _ = fs::remove_dir_all(&next_builtin);
        let _ = fs::remove_dir_all(&new_pristine);
        reason
    };
    if let Err(err) = fs::rename(&next_builtin, &builtin_root) {
        return Err(rollback(format!("bundle_apply_failed: {err}")));
    }

    let current = SkillBundleRef {
        bundle_id: new_bundle_id.clone(),
        revision: metadata.revision,
        display_version: metadata.display_version.clone(),
        commit: metadata.commit.clone(),
        source: bundle::REMOTE_SOURCE.to_string(),
        env_hash: metadata.env_hash.clone(),
        applied_at: Utc::now().to_rfc3339(),
    };
    if let Err(err) = bundle::write_state(&BundleState {
        schema: 1,
        active: Some(current.clone()),
        previous: Some(active.clone()),
    }) {
        return Err(rollback(format!("bundle_state_write_failed: {err}")));
    }
    bundle::clear_journal()?;
    let _ = fs::remove_dir_all(&backup);
    prune_bundle_dirs(&[current.bundle_id.as_str(), active.bundle_id.as_str()])?;

    rescan_source_in_registry_with_progress(&mut registry, BUILTIN_SOURCE_ID, progress)?;
    let removed_installs = cleanup_removed_builtin_installs(&mut registry, &removed_skills)?;
    save_registry_unlocked(&registry)?;
    let stale_copy_installs = stale_copy_installs_report(&registry);

    progress.success(format!(
        "Skills bundle {} applied ({} added, {} updated, {} removed)",
        current.display_version,
        added_skills.len(),
        updated_skills.len(),
        removed_skills.len()
    ));
    Ok(SkillBundleApplyOutcome {
        previous: Some(active),
        current,
        added_skills,
        updated_skills,
        removed_skills,
        stale_copy_installs,
        removed_installs,
        restart_required: false,
    })
}

fn upsert_default_linked_source(
    registry: &mut SkillsRegistry,
    id: &str,
    raw_root: &str,
    skills_subdir: String,
) {
    if is_removed_source(registry, id) {
        return;
    }
    upsert_linked_source(registry, id, raw_root, skills_subdir);
}

fn upsert_linked_source(
    registry: &mut SkillsRegistry,
    id: &str,
    raw_root: &str,
    skills_subdir: String,
) {
    let root = host_fs::expand_tilde(raw_root);
    if !root.is_dir() {
        return;
    }
    let source = SkillSource {
        id: id.to_string(),
        kind: "linked".to_string(),
        ownership_class: "owned-catalog".to_string(),
        path: Some(host_fs::display_path(&canonicalize_or_self(&root))),
        repo_url: None,
        skills_subdir,
        branch: None,
        last_synced_at: None,
    };
    if let Some(existing) = registry.sources.iter_mut().find(|source| source.id == id) {
        *existing = source;
    } else {
        registry.sources.push(source);
    }
}

fn remove_source_from_registry(
    registry: &mut SkillsRegistry,
    source_id: &str,
) -> Result<(), String> {
    if matches!(
        source_id,
        MANAGED_SOURCE_ID
            | BUILTIN_SOURCE_ID
            | IMPORTED_SOURCE_ID
            | STAI_PUBLIC_SOURCE_ID
            | STAI_PRIVATE_SOURCE_ID
            | AGENTS_EXTERNAL_SOURCE_ID
            | CODEX_NATIVE_SOURCE_ID
    ) {
        return Err("source_not_removable".to_string());
    }
    let skill_ids: BTreeSet<String> = registry
        .skills
        .iter()
        .filter(|skill| skill.source_id == source_id)
        .map(|skill| skill.id.clone())
        .collect();
    if registry
        .installs
        .iter()
        .any(|install| skill_ids.contains(&install.skill_id))
    {
        return Err("source_has_installed_skills".to_string());
    }
    registry.sources.retain(|source| source.id != source_id);
    registry.skills.retain(|skill| skill.source_id != source_id);
    mark_source_removed(registry, source_id);
    Ok(())
}

fn is_removed_source(registry: &SkillsRegistry, source_id: &str) -> bool {
    registry
        .removed_source_ids
        .iter()
        .any(|removed| removed == source_id)
}

fn mark_source_removed(registry: &mut SkillsRegistry, source_id: &str) {
    if source_id.is_empty() || is_removed_source(registry, source_id) {
        return;
    }
    registry.removed_source_ids.push(source_id.to_string());
}

fn clear_removed_source(registry: &mut SkillsRegistry, source_id: &str) {
    registry
        .removed_source_ids
        .retain(|removed| removed != source_id);
}

fn normalize_removed_source_ids(registry: &mut SkillsRegistry) {
    let mut seen = BTreeSet::new();
    registry.removed_source_ids = std::mem::take(&mut registry.removed_source_ids)
        .into_iter()
        .filter_map(|source_id| {
            let trimmed = source_id.trim().to_string();
            if trimmed.is_empty() || !seen.insert(trimmed.clone()) {
                return None;
            }
            Some(trimmed)
        })
        .collect();
}

fn yaml_string(root: &YamlValue, key: &str) -> Option<String> {
    root.get(key)
        .and_then(YamlValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn skills_subdir_for(root: &str, skills_path: Option<&str>) -> String {
    let Some(skills_path) = skills_path else {
        return default_skills_subdir();
    };
    let root_path = host_fs::expand_tilde(root);
    let skills_path = host_fs::expand_tilde(skills_path);
    skills_path
        .strip_prefix(&root_path)
        .ok()
        .and_then(|rel| rel.to_str())
        .map(|rel| if rel.is_empty() { "." } else { rel })
        .unwrap_or("skills")
        .to_string()
}

fn rescan_source_in_registry(
    registry: &mut SkillsRegistry,
    source_id: &str,
) -> Result<Vec<SkillRecord>, String> {
    rescan_source_in_registry_with_progress(registry, source_id, ProgressReporter::noop())
}

fn rescan_source_in_registry_with_progress(
    registry: &mut SkillsRegistry,
    source_id: &str,
    progress: ProgressReporter<'_>,
) -> Result<Vec<SkillRecord>, String> {
    progress.info(format!("Resolving source {source_id}"));
    let source = registry
        .sources
        .iter()
        .find(|source| source.id == source_id)
        .cloned()
        .ok_or_else(|| format!("unknown_source: {source_id}"))?;
    progress.info(format!("Scanning source {source_id}"));
    let saved_hashes: BTreeMap<String, String> = registry
        .skills
        .iter()
        .filter(|skill| skill.source_id == source_id)
        .filter_map(|skill| {
            skill
                .saved_hash
                .as_ref()
                .map(|hash| (skill.id.clone(), hash.clone()))
        })
        .collect();
    let scanned = profile_timing_result(format!("skills.rescan_source.{source_id}"), || {
        scan_source_with_progress(&source, progress, &saved_hashes)
    })?;
    registry.skills.retain(|skill| skill.source_id != source_id);
    registry.skills.extend(scanned);
    apply_registry_validation(registry);
    if let Some(existing) = registry
        .sources
        .iter_mut()
        .find(|item| item.id == source_id)
    {
        existing.last_synced_at = Some(Utc::now().to_rfc3339());
    }
    let updated: Vec<SkillRecord> = registry
        .skills
        .iter()
        .filter(|skill| skill.source_id == source_id)
        .cloned()
        .collect();
    progress.success(format!(
        "Updated registry for {source_id}: {} skill(s)",
        updated.len()
    ));
    Ok(updated)
}

fn apply_registry_validation(registry: &mut SkillsRegistry) {
    for skill in &mut registry.skills {
        skill.validation_errors.retain(|error| {
            !error.starts_with("duplicate_source") && !error.starts_with("tier_misplaced")
        });
        skill.valid = skill.validation_errors.is_empty();
    }

    let mut by_name: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let owned_source_ids: BTreeSet<String> = registry
        .sources
        .iter()
        .filter(|source| source_is_maru_owned(source))
        .map(|source| source.id.clone())
        .collect();
    for skill in &registry.skills {
        if skill.name.trim().is_empty() || !owned_source_ids.contains(&skill.source_id) {
            continue;
        }
        by_name
            .entry(skill.name.clone())
            .or_default()
            .insert(skill.source_id.clone());
    }

    for (name, source_ids) in by_name {
        if source_ids.len() < 2 {
            continue;
        }
        let all_sources: Vec<String> = source_ids.into_iter().collect();
        for skill in registry
            .skills
            .iter_mut()
            .filter(|skill| skill.name == name && owned_source_ids.contains(&skill.source_id))
        {
            let others: Vec<String> = all_sources
                .iter()
                .filter(|source_id| *source_id != &skill.source_id)
                .cloned()
                .collect();
            skill.validation_errors.push(format!(
                "duplicate_source: {name} also found in {}",
                others.join(", ")
            ));
            skill.valid = false;
        }
    }

    let sources: BTreeMap<String, SkillSource> = registry
        .sources
        .iter()
        .map(|source| (source.id.clone(), source.clone()))
        .collect();
    for skill in &mut registry.skills {
        let Some(source) = sources.get(&skill.source_id) else {
            continue;
        };
        if let Some(message) = validate_tier_placement(skill, source) {
            skill
                .validation_errors
                .push(format!("tier_misplaced: {message}"));
            skill.valid = false;
        }
    }
}

fn validate_tier_placement(skill: &SkillRecord, source: &SkillSource) -> Option<String> {
    if !source_is_maru_owned(source) {
        return None;
    }
    if source.kind == "adopted" {
        return None;
    }
    let source_path = source.path.as_deref().map(host_fs::expand_tilde);
    let expected = match skill.tier.as_str() {
        "core" => {
            if skill.source_id == BUILTIN_SOURCE_ID {
                return None;
            }
            "_builtin"
        }
        "public" => {
            if source_path
                .as_deref()
                .is_some_and(|path| path_ends_with_components(path, &["_sources", "skills-public"]))
            {
                return None;
            }
            "_sources/skills-public"
        }
        "private" => {
            if source_path.as_deref().is_some_and(|path| {
                path_ends_with_components(path, &["_sources", "skills-private"])
            }) {
                return None;
            }
            "_sources/skills-private"
        }
        "imported" => {
            if skill.source_id == IMPORTED_SOURCE_ID
                || source_path
                    .as_deref()
                    .is_some_and(|path| path_ends_with_components(path, &["_imported"]))
            {
                return None;
            }
            "_imported"
        }
        "managed" => {
            if skill.source_id == MANAGED_SOURCE_ID {
                return None;
            }
            "_managed"
        }
        other => return Some(format!("unsupported tier {other}")),
    };
    Some(format!(
        "{} has tier {} but source {} is not under {}",
        skill.name, skill.tier, skill.source_id, expected
    ))
}

fn path_ends_with_components(path: &Path, suffix: &[&str]) -> bool {
    let components: Vec<String> = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    if components.len() < suffix.len() {
        return false;
    }
    components[components.len() - suffix.len()..]
        .iter()
        .map(String::as_str)
        .eq(suffix.iter().copied())
}

fn build_doctor_report(registry: &SkillsRegistry) -> SkillDoctorReport {
    let mut issues = Vec::new();
    for source in &registry.sources {
        if let Err(err) = source_path(source) {
            issues.push(doctor_issue(
                "error",
                "source_invalid",
                None,
                vec![source.id.clone()],
                err,
            ));
        }
    }
    for skill in &registry.skills {
        if !Path::new(&skill.abs_path).join("SKILL.md").is_file() {
            issues.push(doctor_issue(
                "error",
                "skill_missing",
                Some(skill.name.clone()),
                vec![skill.source_id.clone()],
                format!("SKILL.md missing at {}", skill.abs_path),
            ));
        }
        for error in &skill.validation_errors {
            let code = if error.starts_with("duplicate_source") {
                "duplicate_source"
            } else if error.starts_with("tier_misplaced") {
                "tier_misplaced"
            } else {
                "skill_invalid"
            };
            issues.push(doctor_issue(
                "error",
                code,
                Some(skill.name.clone()),
                vec![skill.source_id.clone()],
                error.clone(),
            ));
        }
        if skill.dirty {
            issues.push(doctor_issue(
                "warn",
                "skill_dirty",
                Some(skill.name.clone()),
                vec![skill.source_id.clone()],
                format!("{} differs from its saved content hash", skill.name),
            ));
        }
    }
    for install in &registry.installs {
        if !registry
            .skills
            .iter()
            .any(|skill| skill.id == install.skill_id)
        {
            issues.push(doctor_issue(
                "error",
                "install_skill_missing",
                Some(install.installed_as.clone()),
                Vec::new(),
                format!("install references unknown skill {}", install.skill_id),
            ));
        }
        if !install_present(install) {
            let message = if install.mode == "copy" {
                format!(
                    "{} copy install is missing or not Maru-managed",
                    install.target_path
                )
            } else {
                format!(
                    "{} install link does not point to {}",
                    install.target_path, install.entrypoint_path
                )
            };
            issues.push(doctor_issue(
                "error",
                "install_link_broken",
                Some(install.installed_as.clone()),
                Vec::new(),
                message,
            ));
        }
    }
    let ok = !issues.iter().any(|issue| issue.severity == "error");
    SkillDoctorReport {
        ok,
        sources: registry.sources.len(),
        skills: registry.skills.len(),
        installs: registry.installs.len(),
        issues,
    }
}

fn doctor_issue(
    severity: &str,
    code: &str,
    skill_name: Option<String>,
    source_ids: Vec<String>,
    message: impl Into<String>,
) -> SkillDoctorIssue {
    SkillDoctorIssue {
        severity: severity.to_string(),
        code: code.to_string(),
        skill_name,
        source_ids,
        message: message.into(),
    }
}

fn scan_source_with_progress(
    source: &SkillSource,
    progress: ProgressReporter<'_>,
    saved_hashes: &BTreeMap<String, String>,
) -> Result<Vec<SkillRecord>, String> {
    let base = source_path(source)?;
    progress.info(format!("Source base {}", host_fs::display_path(&base)));
    let skill_roots = manifest_skill_roots(&base, source)?.unwrap_or_else(|| {
        discover_skill_roots(&base, source)
            .into_iter()
            .map(|path| ManifestSkillRoot { path, tier: None })
            .collect()
    });
    let total = skill_roots.len();
    progress.progress(
        "info",
        format!("Found {total} skill root(s) in {}", source.id),
        0,
        total,
    );
    let mut skills = Vec::new();
    for (index, manifest_root) in skill_roots.into_iter().enumerate() {
        let skill_root = manifest_root.path;
        let skill_md = skill_root.join("SKILL.md");
        if !skill_md.is_file() {
            progress.progress(
                "info",
                format!(
                    "Skipped {}: missing SKILL.md",
                    host_fs::display_path(&skill_root)
                ),
                index + 1,
                total,
            );
            continue;
        }
        let name = skill_root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("skill")
            .to_string();
        progress.progress("info", format!("Scanning skill {name}"), index, total);
        let content = fs::read_to_string(&skill_md).unwrap_or_default();
        let parts = parse_frontmatter(&content);
        let rel_path = skill_root
            .strip_prefix(&base)
            .unwrap_or(&skill_root)
            .to_string_lossy()
            .to_string();
        let id = format!("{}::{}", source.id, name);
        let title = yaml_meta_string(&parts.meta, "name")
            .or_else(|| yaml_meta_string(&parts.meta, "title"))
            .unwrap_or_else(|| title_from_content(&content, &name));
        let dirty = git_dirty(&skill_root).unwrap_or(false);
        let current_hash = hash_directory(&skill_root)?;
        let saved_hash = saved_hashes
            .get(&id)
            .cloned()
            .unwrap_or_else(|| current_hash.clone());
        let dirty = match source.kind.as_str() {
            "linked" | "cloned" => dirty || saved_hash != current_hash,
            // Builtin dirty = drift from the ACTIVE pristine baseline (the
            // applied OTA bundle), not from the embedded snapshot — after a
            // bundle update the embedded copy is stale by design. Junk files
            // (__pycache__ etc.) are excluded on both sides.
            "builtin" => match active_pristine_skill_hash(&name) {
                Some(baseline) => hash_directory_filtered(&skill_root)
                    .map(|current| current != baseline)
                    .unwrap_or(false),
                None => builtin_skill_hash(&name)
                    .map(|baseline| baseline != current_hash)
                    .unwrap_or(false),
            },
            _ => saved_hash != current_hash,
        };
        let frontmatter_tier = yaml_meta_string(&parts.meta, "tier");
        let tier = manifest_root
            .tier
            .as_deref()
            .or(frontmatter_tier.as_deref())
            .and_then(normalize_skill_tier)
            .unwrap_or_else(|| infer_skill_tier(source));
        let validation_errors = validate_skill_frontmatter(&content, &parts.meta);
        let abs_path = if source.kind == "imported" {
            skill_root.clone()
        } else {
            canonicalize_or_self(&skill_root)
        };
        skills.push(SkillRecord {
            id,
            source_id: source.id.clone(),
            name: name.clone(),
            rel_path,
            abs_path: host_fs::display_path(&abs_path),
            title,
            description: yaml_meta_string(&parts.meta, "description"),
            runtime: yaml_meta_string(&parts.meta, "runtime"),
            category: yaml_meta_string(&parts.meta, "category"),
            tier,
            valid: validation_errors.is_empty(),
            validation_errors,
            editable: !matches!(source.kind.as_str(), "external-managed" | "tool-native"),
            dirty,
            content_hash: Some(current_hash),
            saved_hash: Some(saved_hash),
        });
        progress.progress("success", format!("Scanned skill {name}"), index + 1, total);
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

fn validate_skill_frontmatter(content: &str, meta: &BTreeMap<String, YamlValue>) -> Vec<String> {
    let mut errors = Vec::new();
    if !content.starts_with("---\n") {
        errors.push("frontmatter_missing".to_string());
        return errors;
    }
    if let Some(end) = content[4..].find("\n---") {
        let yaml_end = end + 4;
        let yaml = &content[4..yaml_end];
        if let Err(err) = serde_yaml::from_str::<BTreeMap<String, YamlValue>>(yaml) {
            errors.push(format!("frontmatter_yaml_invalid: {err}"));
            return errors;
        }
    } else {
        errors.push("frontmatter_unclosed".to_string());
        return errors;
    }
    if yaml_meta_string(meta, "name")
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        errors.push("name_required".to_string());
    }
    if yaml_meta_string(meta, "description")
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        errors.push("description_required".to_string());
    }
    if let Some(runtime) = yaml_meta_string(meta, "runtime") {
        match runtime.as_str() {
            "generic" | "claude" | "claude-code" | "codex" | "codex-cli" => {}
            other => errors.push(format!("runtime_unsupported: {other}")),
        }
    }
    if let Some(schema) = meta
        .get("schema_version")
        .or_else(|| meta.get("schemaVersion"))
    {
        match schema {
            YamlValue::Number(number) if number.as_i64() == Some(1) => {}
            YamlValue::String(value)
                if value == "maru_skill_frontmatter_v1"
                    || value == "agent_os_skill_frontmatter_v1" => {}
            _ => errors.push("schema_version_unsupported".to_string()),
        }
    }
    if let Some(allowed_tools) = meta
        .get("allowed-tools")
        .or_else(|| meta.get("allowed_tools"))
    {
        if !matches!(allowed_tools, YamlValue::Sequence(_) | YamlValue::String(_)) {
            errors.push("allowed_tools_invalid".to_string());
        }
    }
    if let Some(triggers) = meta.get("triggers") {
        if !matches!(triggers, YamlValue::Sequence(_) | YamlValue::String(_)) {
            errors.push("triggers_invalid".to_string());
        }
    }
    errors
}

fn normalize_skill_tier(value: &str) -> Option<String> {
    match value.trim().to_lowercase().as_str() {
        "core" | "public" | "private" | "imported" | "managed" => Some(value.trim().to_lowercase()),
        _ => None,
    }
}

fn infer_skill_tier(source: &SkillSource) -> String {
    if source.id == BUILTIN_SOURCE_ID {
        return "core".to_string();
    }
    if source.id == IMPORTED_SOURCE_ID || source.kind == "imported" {
        return "imported".to_string();
    }
    if source.id == MANAGED_SOURCE_ID || source.kind == "managed" || source.kind == "adopted" {
        return "managed".to_string();
    }
    if source_path_hint_ends_with(source, &["_sources", "skills-private"])
        || source.id.contains("private")
    {
        return "private".to_string();
    }
    if source_path_hint_ends_with(source, &["_sources", "skills-public"])
        || source.id.contains("public")
    {
        return "public".to_string();
    }
    "managed".to_string()
}

fn infer_skill_tier_from_source_id(source_id: &str) -> String {
    if source_id == BUILTIN_SOURCE_ID {
        return "core".to_string();
    }
    if source_id == IMPORTED_SOURCE_ID {
        return "imported".to_string();
    }
    if source_id == MANAGED_SOURCE_ID || source_id.contains("managed") {
        return "managed".to_string();
    }
    if source_id.contains("private") {
        return "private".to_string();
    }
    if source_id.contains("public") {
        return "public".to_string();
    }
    "managed".to_string()
}

fn source_path_hint_ends_with(source: &SkillSource, suffix: &[&str]) -> bool {
    source
        .path
        .as_deref()
        .map(host_fs::expand_tilde)
        .as_deref()
        .is_some_and(|path| path_ends_with_components(path, suffix))
}

fn manifest_skill_roots(
    base: &Path,
    source: &SkillSource,
) -> Result<Option<Vec<ManifestSkillRoot>>, String> {
    let path = base.join("manifest.json");
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&path)))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|err| format!("Cannot parse {}: {err}", host_fs::display_path(&path)))?;
    let Some(items) = value.get("skills").and_then(serde_json::Value::as_array) else {
        return Ok(None);
    };
    let mut roots = Vec::new();
    for item in items {
        let (rel, tier) = match item {
            serde_json::Value::String(name) => (
                validated_manifest_skill_root(base, source, name, true, None)?,
                None,
            ),
            serde_json::Value::Object(map) => {
                let tier = map
                    .get("tier")
                    .and_then(serde_json::Value::as_str)
                    .and_then(normalize_skill_tier);
                if let Some(path) = map.get("path").and_then(serde_json::Value::as_str) {
                    let link_origin = (map.get("mode").and_then(serde_json::Value::as_str)
                        == Some("link"))
                    .then(|| map.get("sourceOrigin").and_then(serde_json::Value::as_str))
                    .flatten();
                    (
                        validated_manifest_skill_root(base, source, path, false, link_origin)?,
                        tier,
                    )
                } else if let Some(name) = map.get("name").and_then(serde_json::Value::as_str) {
                    (
                        validated_manifest_skill_root(base, source, name, true, None)?,
                        tier,
                    )
                } else {
                    continue;
                }
            }
            _ => continue,
        };
        roots.push(ManifestSkillRoot { path: rel, tier });
    }
    Ok(Some(roots))
}

fn validated_manifest_skill_root(
    base: &Path,
    source: &SkillSource,
    raw: &str,
    relative_to_skills_base: bool,
    imported_link_source_origin: Option<&str>,
) -> Result<PathBuf, String> {
    let relative = Path::new(raw);
    if raw.trim().is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("manifest_skill_path_invalid: {raw}"));
    }
    let allowed = source_skill_base(base, source);
    let candidate = if relative_to_skills_base {
        allowed.join(relative)
    } else {
        base.join(relative)
    };
    if !candidate.starts_with(&allowed) {
        return Err(format!("manifest_skill_path_outside_source: {raw}"));
    }
    if fs::symlink_metadata(&candidate).is_ok() {
        let allowed_canonical = fs::canonicalize(&allowed).map_err(|err| {
            format!(
                "manifest_skills_base_invalid: {}: {err}",
                host_fs::display_path(&allowed)
            )
        })?;
        let candidate_canonical = fs::canonicalize(&candidate).map_err(|err| {
            format!(
                "manifest_skill_path_invalid: {}: {err}",
                host_fs::display_path(&candidate)
            )
        })?;
        let containment_root = if candidate_canonical.starts_with(&allowed_canonical) {
            allowed_canonical.clone()
        } else {
            validated_import_link_origin(
                source,
                &candidate,
                &candidate_canonical,
                imported_link_source_origin,
            )?
            .ok_or_else(|| format!("manifest_skill_path_symlink_escape: {raw}"))?
        };
        let skill_file = candidate.join("SKILL.md");
        if fs::symlink_metadata(&skill_file).is_ok() {
            let skill_file_canonical = fs::canonicalize(&skill_file).map_err(|err| {
                format!(
                    "manifest_skill_file_invalid: {}: {err}",
                    host_fs::display_path(&skill_file)
                )
            })?;
            if !skill_file_canonical.starts_with(&containment_root) {
                return Err(format!("manifest_skill_file_symlink_escape: {raw}"));
            }
        }
    }
    Ok(candidate)
}

fn validated_import_link_origin(
    source: &SkillSource,
    candidate: &Path,
    candidate_canonical: &Path,
    raw_origin: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    if source.id != IMPORTED_SOURCE_ID || source.kind != "imported" || !is_symlink_path(candidate) {
        return Ok(None);
    }
    let Some(raw_origin) = raw_origin else {
        return Ok(None);
    };
    let origin = Path::new(raw_origin);
    if !origin.is_absolute() {
        return Err("import_link_source_origin_not_absolute".to_string());
    }
    let canonical_origin = fs::canonicalize(origin).map_err(|err| {
        format!(
            "import_link_source_origin_invalid: {}: {err}",
            host_fs::display_path(origin)
        )
    })?;
    if origin != canonical_origin {
        return Err("import_link_source_origin_not_canonical".to_string());
    }
    if canonical_origin != candidate_canonical || !canonical_origin.join("SKILL.md").is_file() {
        return Err("import_link_source_origin_mismatch".to_string());
    }
    Ok(Some(canonical_origin))
}

fn discover_skill_roots(base: &Path, source: &SkillSource) -> Vec<PathBuf> {
    let skills_base = source_skill_base(base, source);
    if source.skills_subdir == "." && skills_base.join("SKILL.md").is_file() {
        return vec![skills_base];
    }
    if !skills_base.is_dir() {
        return Vec::new();
    }
    let mut roots: Vec<PathBuf> = WalkDir::new(&skills_base)
        .follow_links(false)
        .min_depth(1)
        .max_depth(2)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
        .filter_map(|entry| entry.path().parent().map(Path::to_path_buf))
        .collect();
    roots.sort();
    roots
}

fn source_skill_base(base: &Path, source: &SkillSource) -> PathBuf {
    if source.skills_subdir == "." {
        base.to_path_buf()
    } else {
        base.join(&source.skills_subdir)
    }
}

fn source_path(source: &SkillSource) -> Result<PathBuf, String> {
    let path = source
        .path
        .as_ref()
        .ok_or_else(|| format!("source_path_missing: {}", source.id))?;
    let p = host_fs::expand_tilde(path);
    if !p.is_dir() {
        return Err(format!(
            "source_path_invalid: {}",
            host_fs::display_path(&p)
        ));
    }
    Ok(canonicalize_or_self(&p))
}

fn resolve_skill_file(skill_id: &str, file_path: &str) -> Result<PathBuf, String> {
    let skill = get_skill(skill_id)?;
    resolve_skill_file_from_record(&skill, file_path)
}

fn resolve_skill_file_from_record(skill: &SkillRecord, file_path: &str) -> Result<PathBuf, String> {
    let base = PathBuf::from(&skill.abs_path);
    let rel = safe_relative_path(file_path)?;
    let candidate = base.join(rel);
    let normalized = lexical_normalize(&candidate);
    if !normalized.starts_with(&base) {
        return Err("skill_file_escapes_skill_root".to_string());
    }
    Ok(normalized)
}

fn safe_relative_path(file_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(file_path.trim());
    if path.is_absolute() {
        return Err("skill_file_path_must_be_relative".to_string());
    }
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err("skill_file_path_invalid".to_string());
        }
    }
    Ok(path.to_path_buf())
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn yaml_meta_string(map: &BTreeMap<String, YamlValue>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(YamlValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn git_dirty(path: &Path) -> Result<bool, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("status")
        .arg("--porcelain")
        .no_window()
        .output();
    let Ok(output) = output else {
        return Ok(false);
    };
    if !output.status.success() {
        return Ok(false);
    }
    Ok(!output.stdout.is_empty())
}

fn hash_directory(path: &Path) -> Result<String, String> {
    profile_timing_result(
        format!("skills.hash_directory.{}", host_fs::display_path(path)),
        || {
            let mut entries: Vec<PathBuf> = WalkDir::new(path)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file())
                .map(|entry| entry.path().to_path_buf())
                .collect();
            entries.sort();
            let mut hasher = Sha256::new();
            for file in entries {
                if file.file_name().and_then(|name| name.to_str()) == Some(BUILTIN_HASHES_FILE) {
                    continue;
                }
                let rel = file.strip_prefix(path).unwrap_or(&file).to_string_lossy();
                hasher.update(rel.as_bytes());
                hasher.update(b"\0");
                let data = fs::read(&file).map_err(|err| {
                    format!("Cannot read {}: {err}", host_fs::display_path(&file))
                })?;
                hasher.update(sha256_hex(&data).as_bytes());
                hasher.update(b"\0");
            }
            Ok(format!("{:x}", hasher.finalize()))
        },
    )
}

fn hash_file(path: &Path) -> Result<String, String> {
    fs::read(path)
        .map(|bytes| sha256_hex(&bytes))
        .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(path)))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn builtin_skill_hash(name: &str) -> Option<String> {
    let dir = BUILTIN_DIR.get_dir(format!("skills/{name}"))?;
    Some(hash_include_dir(dir))
}

fn hash_include_dir(dir: &Dir<'_>) -> String {
    let mut files = Vec::new();
    collect_include_files(dir, dir.path(), &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (rel, contents) in files {
        hasher.update(rel.as_bytes());
        hasher.update(b"\0");
        hasher.update(sha256_hex(contents).as_bytes());
        hasher.update(b"\0");
    }
    format!("{:x}", hasher.finalize())
}

fn collect_include_files<'a>(dir: &'a Dir<'a>, base: &Path, files: &mut Vec<(String, &'a [u8])>) {
    for child in dir.dirs() {
        collect_include_files(child, base, files);
    }
    for file in dir.files() {
        let rel = file
            .path()
            .strip_prefix(base)
            .unwrap_or(file.path())
            .to_string_lossy()
            .to_string();
        files.push((rel, file.contents()));
    }
}

fn mark_record_saved_after_user_write(record: &mut SkillRecord, source_kind: &str) {
    if matches!(source_kind, "managed" | "imported" | "adopted") {
        record.saved_hash = record.content_hash.clone();
        record.dirty = false;
    }
}

fn copy_dir_all(from: &Path, to: &Path) -> Result<(), String> {
    if !from.is_dir() {
        return Err(format!(
            "source_path_invalid: {}",
            host_fs::display_path(from)
        ));
    }
    host_fs::ensure_dir(to)?;
    for entry in WalkDir::new(from).follow_links(false).into_iter() {
        let entry = entry.map_err(|err| err.to_string())?;
        let rel = entry.path().strip_prefix(from).unwrap_or(entry.path());
        if rel.as_os_str().is_empty() {
            continue;
        }
        let target = to.join(rel);
        if entry.file_type().is_dir() {
            host_fs::ensure_dir(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                host_fs::ensure_dir(parent)?;
            }
            fs::copy(entry.path(), &target).map_err(|err| {
                format!(
                    "Cannot copy {} to {}: {err}",
                    host_fs::display_path(entry.path()),
                    host_fs::display_path(&target)
                )
            })?;
        }
    }
    Ok(())
}

fn install_root(target: &str) -> Result<PathBuf, String> {
    match target {
        "claude" => Ok(host_fs::install_root_base()?.join(".claude").join("skills")),
        "codex" => Ok(host_fs::install_root_base()?.join(".codex").join("skills")),
        other => Err(format!("unsupported_install_target: {other}")),
    }
}

fn install_target_path(target: &str, installed_as: &str) -> Result<PathBuf, String> {
    let installed_as = host_fs::safe_entry_name(installed_as)?;
    Ok(install_root(target)?.join(installed_as))
}

fn normalize_install_target(target: &str) -> Result<String, String> {
    let target = target.trim().to_lowercase();
    match target.as_str() {
        "claude" | "codex" => Ok(target),
        _ => Err(format!("unsupported_install_target: {target}")),
    }
}

fn normalize_install_mode(mode: Option<&str>) -> Result<String, String> {
    match mode.unwrap_or("symlink").trim().to_lowercase().as_str() {
        "" | "symlink" => Ok("symlink".to_string()),
        "copy" => Ok("copy".to_string()),
        other => Err(format!("unsupported_install_mode: {other}")),
    }
}

fn normalize_source_id(id: &str) -> Result<String, String> {
    let value = id.trim();
    if value.is_empty() {
        return Err("source_id_required".to_string());
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(format!("invalid_source_id: {value}"));
    }
    Ok(value.to_string())
}

fn normalize_source_kind(kind: &str) -> Result<String, String> {
    let value = kind.trim().to_lowercase();
    match value.as_str() {
        "linked" | "cloned" | "imported" | "managed" | "adopted" | "builtin"
        | "external-managed" | "tool-native" => Ok(value),
        _ => Err(format!("unsupported_source_kind: {value}")),
    }
}

fn adopted_source_id(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(host_fs::display_path(path).as_bytes());
    let digest = hasher.finalize();
    format!("adopted-{:x}", digest)[..24].to_string()
}

fn canonicalize_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn run_command(cmd: &mut Command) -> Result<(), String> {
    let output = cmd
        .no_window()
        .output()
        .map_err(|err| format!("command_failed_to_start: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "command_failed: {}",
        stderr.trim().if_empty("unknown error")
    ))
}

trait IfEmpty {
    fn if_empty(&self, fallback: &str) -> String;
}

impl IfEmpty for str {
    fn if_empty(&self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use tempfile::TempDir;

    // Field order is load-bearing: Rust drops fields in declaration order, so
    // `_guard` MUST be last. That keeps the home lock held until AFTER the env
    // var is restored and the TempDir is removed, so the next test never starts
    // (and never observes/mutates the process-global MARU_TEST_HOME) while
    // this one is still cleaning up. (Matches e2e_flow::tests::TestHome.)
    struct TestHome {
        _dir: TempDir,
        previous: Option<OsString>,
        _guard: MutexGuard<'static, ()>,
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.as_ref() {
                std::env::set_var("MARU_TEST_HOME", previous);
            } else {
                std::env::remove_var("MARU_TEST_HOME");
            }
        }
    }

    fn test_home() -> TestHome {
        let guard = host_fs::test_maru_home_lock();
        let dir = TempDir::new().unwrap();
        let previous = std::env::var_os("MARU_TEST_HOME");
        std::env::set_var("MARU_TEST_HOME", dir.path());
        TestHome {
            _dir: dir,
            previous,
            _guard: guard,
        }
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn env_vars_for_runs_exposes_python_and_node_runtime_paths() {
        let home = test_home();
        let env_root = home._dir.path().join(".maru").join("env");

        let vars = env_vars_for_runs().unwrap();

        assert_eq!(
            vars.get("MARU_SKILLS_ENV").unwrap(),
            &path_string(&env_root)
        );
        assert_eq!(
            vars.get("VIRTUAL_ENV").unwrap(),
            &path_string(&env_root.join(".venv"))
        );
        let path_entries: Vec<_> = std::env::split_paths(vars.get("PATH").unwrap()).collect();
        assert_eq!(
            path_entries.first(),
            Some(&env_root.join(".venv").join("bin"))
        );
        let node_path_entries: Vec<_> =
            std::env::split_paths(vars.get("NODE_PATH").unwrap()).collect();
        assert_eq!(
            node_path_entries.first(),
            Some(&env_root.join("node_modules"))
        );
    }

    fn write_workspace_config(work: &Path, public_root: &Path, private_root: &Path) {
        fs::create_dir_all(public_root.join("skills")).unwrap();
        fs::create_dir_all(private_root.join("skills")).unwrap();
        fs::write(
            work.join("workspace.config.yaml"),
            format!(
                "skills:\n  public_root: {}\n  public_skills: {}/skills\n  private_root: {}\n  private_skills: {}/skills\n",
                path_string(public_root),
                path_string(public_root),
                path_string(private_root),
                path_string(private_root),
            ),
        )
        .unwrap();
    }

    fn has_source(sources: &[SkillSource], id: &str) -> bool {
        sources.iter().any(|source| source.id == id)
    }

    fn write_skill(root: &Path, name: &str) -> PathBuf {
        let skill = root.join("skills").join(name);
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: test\n---\n\n# {name}\n"),
        )
        .unwrap();
        skill
    }

    fn embedded_builtin_skill_count() -> usize {
        BUILTIN_DIR
            .dirs()
            .find(|dir| {
                dir.path()
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name == "skills")
            })
            .map(|skills_dir| {
                skills_dir
                    .dirs()
                    .filter(|skill_dir| {
                        skill_dir.files().any(|file| {
                            file.path()
                                .file_name()
                                .and_then(|name| name.to_str())
                                .is_some_and(|name| name == "SKILL.md")
                        }) && skill_dir
                            .path()
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| !name.starts_with("design-"))
                    })
                    .count()
            })
            .unwrap_or(0)
    }

    #[test]
    fn source_id_validation_rejects_path_like_values() {
        assert!(normalize_source_id("stai-public").is_ok());
        assert!(normalize_source_id("../x").is_err());
        assert!(normalize_source_id("x/y").is_err());
    }

    #[test]
    fn skill_frontmatter_validation_reports_invalid_state() {
        let content = "---\nname: demo\nruntime: unknown\n---\n\n# Demo\n";
        let parts = parse_frontmatter(content);
        let errors = validate_skill_frontmatter(content, &parts.meta);
        assert!(errors.contains(&"description_required".to_string()));
        assert!(errors.contains(&"runtime_unsupported: unknown".to_string()));
    }

    #[test]
    fn safe_relative_path_rejects_escape() {
        assert!(safe_relative_path("SKILL.md").is_ok());
        assert!(safe_relative_path("../SKILL.md").is_err());
        assert!(safe_relative_path("/tmp/SKILL.md").is_err());
    }

    #[test]
    fn skill_host_store_does_not_target_dotfiles_owned_claude_files() {
        let source = include_str!("store.rs");
        let forbidden_paths = [
            format!("{}{}", ".claude/", "CLAUDE.md"),
            format!("{}{}", ".claude/", "settings.json"),
            format!("{}{}", ".claude/", "settings.local.json"),
            format!("{}{}", ".claude/", "hooks"),
        ];
        for forbidden in forbidden_paths {
            assert!(
                !source.contains(&forbidden),
                "skill_host store must not manage {forbidden}"
            );
        }
    }

    #[test]
    fn duplicate_skill_names_across_sources_are_invalid() {
        let _home = test_home();
        let alpha = TempDir::new().unwrap();
        let beta = TempDir::new().unwrap();
        write_skill(alpha.path(), "shared");
        write_skill(beta.path(), "shared");

        let mut registry = SkillsRegistry::default();
        registry.sources.push(SkillSource {
            id: "alpha".to_string(),
            kind: "linked".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(alpha.path())),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });
        registry.sources.push(SkillSource {
            id: "beta".to_string(),
            kind: "linked".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(beta.path())),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });

        rescan_source_in_registry(&mut registry, "alpha").unwrap();
        rescan_source_in_registry(&mut registry, "beta").unwrap();

        let duplicates: Vec<_> = registry
            .skills
            .iter()
            .filter(|skill| skill.name == "shared")
            .collect();
        assert_eq!(duplicates.len(), 2);
        assert!(duplicates.iter().all(|skill| !skill.valid));
        assert!(duplicates.iter().all(|skill| skill
            .validation_errors
            .iter()
            .any(|error| error.starts_with("duplicate_source"))));
    }

    #[test]
    fn doctor_reports_duplicate_sources() {
        let _home = test_home();
        let alpha = TempDir::new().unwrap();
        let beta = TempDir::new().unwrap();
        write_skill(alpha.path(), "shared");
        write_skill(beta.path(), "shared");

        let mut registry = SkillsRegistry::default();
        registry.sources.push(SkillSource {
            id: "alpha".to_string(),
            kind: "linked".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(alpha.path())),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });
        registry.sources.push(SkillSource {
            id: "beta".to_string(),
            kind: "linked".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(beta.path())),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });
        save_registry_unlocked(&registry).unwrap();

        let report = skills_doctor(None).unwrap();

        assert!(!report.ok);
        assert!(report.issues.iter().any(|issue| {
            issue.code == "duplicate_source"
                && issue.skill_name.as_deref() == Some("shared")
                && issue.message.contains("duplicate_source")
        }));
    }

    #[test]
    fn tier_misplaced_from_manifest_is_invalid() {
        let _home = test_home();
        let root = TempDir::new().unwrap();
        write_skill(root.path(), "misplaced");
        fs::write(
            root.path().join("manifest.json"),
            r#"{"version":1,"skills":[{"name":"misplaced","path":"skills/misplaced","tier":"core"}]}"#,
        )
        .unwrap();
        let mut registry = SkillsRegistry::default();
        registry.sources.push(SkillSource {
            id: "team-public".to_string(),
            kind: "linked".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(root.path())),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });

        rescan_source_in_registry(&mut registry, "team-public").unwrap();

        let skill = registry
            .skills
            .iter()
            .find(|skill| skill.name == "misplaced")
            .unwrap();
        assert_eq!(skill.tier, "core");
        assert!(!skill.valid);
        assert!(skill
            .validation_errors
            .iter()
            .any(|error| error.starts_with("tier_misplaced")));
    }

    #[test]
    fn legacy_registry_infers_missing_tiers_before_validation() {
        let home = test_home();
        let private_root = home
            ._dir
            .path()
            .join(".maru")
            .join("skills")
            .join("_sources")
            .join("skills-private");
        let private_skill = write_skill(&private_root, "legacy-private");
        host_fs::write_json_pretty(
            &registry_path().unwrap(),
            &serde_json::json!({
                "version": 1,
                "sources": [{
                    "id": "team-private",
                    "kind": "linked",
                    "path": path_string(&private_root),
                    "skillsSubdir": "skills"
                }],
                "skills": [{
                    "id": "team-private::legacy-private",
                    "sourceId": "team-private",
                    "name": "legacy-private",
                    "relPath": "skills/legacy-private",
                    "absPath": path_string(&private_skill)
                }],
                "installs": [],
                "removedSourceIds": []
            }),
        )
        .unwrap();

        let registry = load_registry_unlocked().unwrap();
        let skill = registry
            .skills
            .iter()
            .find(|skill| skill.name == "legacy-private")
            .unwrap();

        assert_eq!(registry.version, REGISTRY_VERSION);
        assert_eq!(skill.tier, "private");
        assert!(skill.valid);
        assert!(!skill
            .validation_errors
            .iter()
            .any(|error| error.starts_with("tier_misplaced")));
    }

    #[test]
    fn invalid_skill_install_is_rejected() {
        let _home = test_home();
        let alpha = TempDir::new().unwrap();
        let beta = TempDir::new().unwrap();
        write_skill(alpha.path(), "shared");
        write_skill(beta.path(), "shared");
        let mut registry = SkillsRegistry::default();
        registry.sources.push(SkillSource {
            id: "alpha".to_string(),
            kind: "linked".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(alpha.path())),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });
        registry.sources.push(SkillSource {
            id: "beta".to_string(),
            kind: "linked".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(beta.path())),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });
        rescan_source_in_registry(&mut registry, "alpha").unwrap();
        rescan_source_in_registry(&mut registry, "beta").unwrap();
        save_registry_unlocked(&registry).unwrap();

        let err = skills_install_skill(
            "alpha::shared".to_string(),
            "claude".to_string(),
            None,
            None,
        )
        .unwrap_err();

        assert!(err.contains("skill_invalid"));
    }

    #[test]
    fn dirty_list_and_managed_accept_update_saved_hash() {
        let _home = test_home();
        let created = skills_create_skill("managed-dirty".to_string(), None).unwrap();
        let skill_path = Path::new(&created.abs_path).join("SKILL.md");
        fs::write(
            &skill_path,
            "---\nname: managed-dirty\ndescription: changed\n---\n\n# Changed\n",
        )
        .unwrap();

        let dirty = skills_list_dirty(None).unwrap();
        assert!(dirty.iter().any(|record| record.name == "managed-dirty"));

        let outcome = skills_reconcile_skill(
            None,
            "managed-dirty".to_string(),
            "accept".to_string(),
            None,
            Some(false),
        )
        .unwrap();

        assert!(outcome.hash_updated);
        assert!(skills_list_dirty(None)
            .unwrap()
            .iter()
            .all(|record| record.name != "managed-dirty"));
    }

    #[test]
    fn git_backed_reconcile_accepts_and_discards_skill_changes() {
        let home = test_home();
        let repo = home
            ._dir
            .path()
            .join(".maru")
            .join("skills")
            .join("_sources")
            .join("skills-public");
        let skill = write_skill(&repo, "git-skill");
        run_git(&repo, &["init"]).unwrap();
        run_git(&repo, &["config", "user.email", "maru@example.invalid"]).unwrap();
        run_git(&repo, &["config", "user.name", "Maru Test"]).unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        run_git(&repo, &["commit", "-m", "initial"]).unwrap();
        // The conventional public checkout is a default v3 source. Refresh it
        // directly instead of registering a duplicate alias for the same path.
        skills_list_skills(None, Some(true)).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: git-skill\ndescription: changed\n---\n\n# Changed\n",
        )
        .unwrap();

        let accepted = skills_reconcile_skill(
            None,
            "git-skill".to_string(),
            "accept".to_string(),
            Some("test: reconcile git-skill".to_string()),
            Some(false),
        )
        .unwrap();

        assert!(accepted.committed);
        assert!(accepted.hash_updated);
        assert_eq!(accepted.commands_shell.as_deref(), Some("posix"));
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: git-skill\ndescription: discard\n---\n\n# Discard\n",
        )
        .unwrap();

        let discarded = skills_reconcile_skill(
            None,
            "git-skill".to_string(),
            "discard".to_string(),
            None,
            Some(false),
        )
        .unwrap();

        assert!(discarded.hash_updated);
        let content = fs::read_to_string(skill.join("SKILL.md")).unwrap();
        assert!(content.contains("description: changed"));
    }

    #[test]
    fn imported_copy_link_and_unmanage_work() {
        let _home = test_home();
        let copy_root = TempDir::new().unwrap();
        let link_root = TempDir::new().unwrap();
        let copy_source = write_skill(copy_root.path(), "copy-skill");
        let link_source = write_skill(link_root.path(), "link-skill");

        let copied = skills_import_external(
            None,
            path_string(&copy_source),
            None,
            Some("copy".to_string()),
        )
        .unwrap();
        assert_eq!(copied.skill.tier, "imported");
        assert!(Path::new(&copied.imported_path).join("SKILL.md").is_file());

        let linked = skills_import_external(
            None,
            path_string(&link_source),
            None,
            Some("link".to_string()),
        )
        .unwrap();
        assert_eq!(linked.skill.tier, "imported");
        assert!(fs::symlink_metadata(&linked.imported_path)
            .unwrap()
            .file_type()
            .is_symlink());
        let manifest = read_imported_manifest().unwrap();
        let linked_entry = manifest["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "link-skill")
            .unwrap();
        let source_origin = PathBuf::from(linked_entry["sourceOrigin"].as_str().unwrap());
        assert!(source_origin.is_absolute());
        assert_eq!(fs::canonicalize(&source_origin).unwrap(), source_origin);
        let mut registry = load_registry().unwrap();
        assert!(rescan_source_in_registry(&mut registry, IMPORTED_SOURCE_ID).is_ok());

        let removed = skills_import_unmanage(None, "copy-skill".to_string(), Some(true)).unwrap();
        assert!(removed.removed_entrypoint);
        assert!(removed.deleted_files);
        assert!(!Path::new(&copied.imported_path).exists());
    }

    #[test]
    fn imported_link_rejects_tampered_origin_and_redirected_symlink() {
        let _home = test_home();
        let source_root = TempDir::new().unwrap();
        let foreign_root = TempDir::new().unwrap();
        let source = write_skill(source_root.path(), "linked-securely");
        let foreign = write_skill(foreign_root.path(), "linked-securely");
        let imported =
            skills_import_external(None, path_string(&source), None, Some("link".to_string()))
                .unwrap();
        let canonical_source = fs::canonicalize(&source).unwrap();
        let canonical_foreign = fs::canonicalize(&foreign).unwrap();

        let mut manifest = read_imported_manifest().unwrap();
        manifest["skills"][0]["sourceOrigin"] =
            serde_json::Value::String(path_string(&canonical_foreign));
        host_fs::write_json_pretty(&imported_manifest_path().unwrap(), &manifest).unwrap();
        let mut registry = load_registry().unwrap();
        let error = rescan_source_in_registry(&mut registry, IMPORTED_SOURCE_ID).unwrap_err();
        assert!(error.contains("import_link_source_origin_mismatch"));

        manifest["skills"][0]["sourceOrigin"] =
            serde_json::Value::String(path_string(&canonical_source));
        host_fs::write_json_pretty(&imported_manifest_path().unwrap(), &manifest).unwrap();
        fs::remove_file(&imported.imported_path).unwrap();
        host_fs::create_symlink_no_clobber(Path::new(&imported.imported_path), &canonical_foreign)
            .unwrap();
        let error = rescan_source_in_registry(&mut registry, IMPORTED_SOURCE_ID).unwrap_err();
        assert!(error.contains("import_link_source_origin_mismatch"));
    }

    #[test]
    fn import_unmanage_removes_copy_install_directory() {
        let _home = test_home();
        let src_root = TempDir::new().unwrap();
        let source = write_skill(src_root.path(), "imp-copy");
        let imported =
            skills_import_external(None, path_string(&source), None, Some("copy".to_string()))
                .unwrap();

        // Install the imported skill to Claude in copy mode (a real directory).
        skills_install_skill(
            imported.skill.id,
            "claude".to_string(),
            None,
            Some("copy".to_string()),
        )
        .unwrap();
        let tool_target = install_target_path("claude", "imp-copy").unwrap();
        assert!(tool_target.is_dir());
        assert!(read_install_marker(&tool_target).unwrap().maru_managed);

        let removed = skills_import_unmanage(None, "imp-copy".to_string(), Some(true)).unwrap();
        assert_eq!(removed.removed_installs, 1);
        // The copy install directory must be deleted, not just the registry record.
        assert!(!tool_target.exists());
        let registry = load_registry().unwrap();
        assert!(!registry
            .installs
            .iter()
            .any(|install| install.installed_as == "imp-copy"));
    }

    #[test]
    fn skills_subdir_derives_relative_path() {
        let root = "/tmp/work/_sys/skills";
        let skills = "/tmp/work/_sys/skills/skills";
        assert_eq!(skills_subdir_for(root, Some(skills)), "skills");
    }

    #[test]
    fn default_sources_include_public_and_private_catalogs() {
        let _home = test_home();
        let work = TempDir::new().unwrap();
        let public_root = TempDir::new().unwrap();
        let private_root = TempDir::new().unwrap();
        write_workspace_config(work.path(), public_root.path(), private_root.path());
        let work_path = path_string(work.path());

        let sources = skills_list_sources(Some(work_path)).unwrap();
        assert!(has_source(&sources, BUILTIN_SOURCE_ID));
        assert!(has_source(&sources, MANAGED_SOURCE_ID));
        assert!(has_source(&sources, "stai-private"));
        assert!(has_source(&sources, STAI_PUBLIC_SOURCE_ID));
    }

    #[test]
    fn adopted_source_migration_stays_inventory_only_after_reload_and_sync() {
        let _home = test_home();
        let adopted_root = TempDir::new().unwrap();
        write_skill(adopted_root.path(), "adopted-only");
        let mut registry = SkillsRegistry::default();
        registry.version = 2;
        registry.sources.push(SkillSource {
            id: "adopted-legacy".to_string(),
            kind: "adopted".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(adopted_root.path())),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });
        save_registry_unlocked(&registry).unwrap();

        let reloaded = load_registry_readonly_unlocked().unwrap();
        assert_eq!(reloaded.sources[0].ownership_class, "external-managed");
        let report = skills_sync_tools(None, vec!["claude".to_string()], false).unwrap();
        assert_eq!(report.desired_skills, embedded_builtin_skill_count());
        assert!(report
            .actions
            .iter()
            .all(|action| action.skill_name != "adopted-only"));
    }

    #[test]
    fn manifest_paths_reject_absolute_parent_and_symlink_escape() {
        let _home = test_home();
        let source_root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::create_dir_all(source_root.path().join("skills")).unwrap();
        write_skill(outside.path(), "escaped");
        let source = SkillSource {
            id: "manifest-source".to_string(),
            kind: "linked".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(source_root.path())),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        };
        for malicious in [
            serde_json::json!({"skills": [{"path": "/tmp/absolute"}]}),
            serde_json::json!({"skills": [{"path": "skills/../outside"}]}),
        ] {
            fs::write(
                source_root.path().join("manifest.json"),
                serde_json::to_vec(&malicious).unwrap(),
            )
            .unwrap();
            assert!(manifest_skill_roots(source_root.path(), &source).is_err());
        }
        let escaped = outside.path().join("skills/escaped");
        host_fs::create_symlink_no_clobber(&source_root.path().join("skills/escaped"), &escaped)
            .unwrap();
        fs::write(
            source_root.path().join("manifest.json"),
            br#"{"skills":[{"path":"skills/escaped"}]}"#,
        )
        .unwrap();
        let error = manifest_skill_roots(source_root.path(), &source).unwrap_err();
        assert!(error.contains("manifest_skill_path_symlink_escape"));
    }

    #[test]
    fn readonly_default_sources_honor_public_and_private_workspace_overrides() {
        let _home = test_home();
        let work = TempDir::new().unwrap();
        let public_root = TempDir::new().unwrap();
        let private_root = TempDir::new().unwrap();
        write_workspace_config(work.path(), public_root.path(), private_root.path());
        let mut registry = SkillsRegistry::default();

        add_default_sources_readonly(&mut registry, Some(&path_string(work.path()))).unwrap();

        let public = registry
            .sources
            .iter()
            .find(|source| source.id == STAI_PUBLIC_SOURCE_ID)
            .unwrap();
        let private = registry
            .sources
            .iter()
            .find(|source| source.id == STAI_PRIVATE_SOURCE_ID)
            .unwrap();
        assert_eq!(
            public.path.as_deref(),
            Some(path_string(&canonicalize_or_self(public_root.path())).as_str())
        );
        assert_eq!(
            private.path.as_deref(),
            Some(path_string(&canonicalize_or_self(private_root.path())).as_str())
        );
        assert_eq!(public.skills_subdir, "skills");
        assert_eq!(private.skills_subdir, "skills");
        assert!(!registry_path().unwrap().exists());
    }

    #[test]
    fn reset_registry_restores_public_and_private_catalogs() {
        let _home = test_home();
        let work = TempDir::new().unwrap();
        let public_root = TempDir::new().unwrap();
        let private_root = TempDir::new().unwrap();
        write_workspace_config(work.path(), public_root.path(), private_root.path());
        let work_path = path_string(work.path());

        skills_reset_registry_impl(Some(work_path.clone()), ProgressReporter::noop()).unwrap();

        let refreshed = skills_list_sources(Some(work_path)).unwrap();
        assert!(has_source(&refreshed, BUILTIN_SOURCE_ID));
        assert!(has_source(&refreshed, "stai-private"));
        assert!(has_source(&refreshed, STAI_PUBLIC_SOURCE_ID));
        assert!(load_registry().unwrap().removed_source_ids.is_empty());
    }

    #[test]
    fn reset_registry_preserves_intact_installs() {
        let _home = test_home();
        let work = TempDir::new().unwrap();
        let public_root = TempDir::new().unwrap();
        let private_root = TempDir::new().unwrap();
        let links = TempDir::new().unwrap();
        write_workspace_config(work.path(), public_root.path(), private_root.path());
        let work_path = path_string(work.path());
        let skill_target = links.path().join("skill-alpha");
        let maru_entry = links.path().join("maru-alpha");
        let tool_target = links.path().join("tool-alpha");
        fs::create_dir_all(&skill_target).unwrap();
        fs::write(skill_target.join("SKILL.md"), "# alpha\n").unwrap();
        host_fs::create_symlink_no_clobber(&maru_entry, &skill_target).unwrap();
        host_fs::create_symlink_no_clobber(&tool_target, &maru_entry).unwrap();

        let mut registry = SkillsRegistry::default();
        registry.installs.push(SkillInstall {
            skill_id: "stai-public:alpha".to_string(),
            target: "claude".to_string(),
            installed_as: "alpha".to_string(),
            managed_by: "maru".to_string(),
            entrypoint_path: path_string(&maru_entry),
            target_path: path_string(&tool_target),
            mode: "symlink".to_string(),
            created_at: None,
        });
        registry.installs.push(SkillInstall {
            skill_id: "stai-public:stale".to_string(),
            target: "codex".to_string(),
            installed_as: "stale".to_string(),
            managed_by: "maru".to_string(),
            entrypoint_path: path_string(&links.path().join("missing-maru")),
            target_path: path_string(&links.path().join("missing-tool")),
            mode: "symlink".to_string(),
            created_at: None,
        });
        save_registry_unlocked(&registry).unwrap();

        skills_reset_registry_impl(Some(work_path), ProgressReporter::noop()).unwrap();

        let registry = load_registry().unwrap();
        assert_eq!(registry.installs.len(), 1);
        assert_eq!(registry.installs[0].installed_as, "alpha");
        assert_eq!(registry.installs[0].managed_by, "maru");
        assert_eq!(registry.installs[0].skill_id, "stai-public:alpha");
    }

    #[test]
    fn install_target_symlink_repoints_existing_direct_skill_link() {
        let links = TempDir::new().unwrap();
        let skill_target = links.path().join("skill-alpha");
        let maru_entry = links.path().join("maru-alpha");
        let tool_target = links.path().join("tool-alpha");
        fs::create_dir_all(&skill_target).unwrap();
        host_fs::create_symlink_no_clobber(&maru_entry, &skill_target).unwrap();
        host_fs::create_symlink_no_clobber(&tool_target, &skill_target).unwrap();

        create_install_target_symlink(&tool_target, &maru_entry, &skill_target, "skill-alpha")
            .unwrap();

        assert_eq!(
            host_fs::read_link_target(&tool_target).as_deref(),
            Some(maru_entry.as_path())
        );
    }

    #[test]
    fn install_target_symlink_rejects_unrelated_existing_link() {
        let links = TempDir::new().unwrap();
        let skill_target = links.path().join("skill-alpha");
        let maru_entry = links.path().join("maru-alpha");
        let tool_target = links.path().join("tool-alpha");
        let unrelated = links.path().join("unrelated");
        fs::create_dir_all(&skill_target).unwrap();
        fs::create_dir_all(&unrelated).unwrap();
        host_fs::create_symlink_no_clobber(&maru_entry, &skill_target).unwrap();
        host_fs::create_symlink_no_clobber(&tool_target, &unrelated).unwrap();

        let error =
            create_install_target_symlink(&tool_target, &maru_entry, &skill_target, "skill-alpha")
                .unwrap_err();

        assert!(error.contains("install_target_exists"));
        assert_eq!(
            host_fs::read_link_target(&tool_target).as_deref(),
            Some(unrelated.as_path())
        );
    }

    #[test]
    fn install_target_symlink_repoints_existing_same_named_skill_link() {
        let links = TempDir::new().unwrap();
        let old_skill = links.path().join("old").join("alpha");
        let new_skill = links.path().join("new").join("alpha");
        let maru_entry = links.path().join("maru-alpha");
        let tool_target = links.path().join("tool-alpha");
        fs::create_dir_all(&old_skill).unwrap();
        fs::create_dir_all(&new_skill).unwrap();
        fs::write(old_skill.join("SKILL.md"), "# old\n").unwrap();
        fs::write(new_skill.join("SKILL.md"), "# new\n").unwrap();
        host_fs::create_symlink_no_clobber(&maru_entry, &new_skill).unwrap();
        host_fs::create_symlink_no_clobber(&tool_target, &old_skill).unwrap();

        create_install_target_symlink(&tool_target, &maru_entry, &new_skill, "alpha").unwrap();

        assert_eq!(
            host_fs::read_link_target(&tool_target).as_deref(),
            Some(maru_entry.as_path())
        );
    }

    #[test]
    fn maru_entry_symlink_repoints_existing_same_named_skill_link() {
        let links = TempDir::new().unwrap();
        let old_skill = links.path().join("alpha");
        let new_skill = links.path().join("new").join("alpha");
        let maru_entry = links.path().join("maru-alpha");
        fs::create_dir_all(&old_skill).unwrap();
        fs::create_dir_all(&new_skill).unwrap();
        fs::write(old_skill.join("SKILL.md"), "# old\n").unwrap();
        fs::write(new_skill.join("SKILL.md"), "# new\n").unwrap();
        host_fs::create_symlink_no_clobber(&maru_entry, &old_skill).unwrap();

        create_maru_entry_symlink(&maru_entry, &new_skill, "alpha").unwrap();

        assert_eq!(
            host_fs::read_link_target(&maru_entry).as_deref(),
            Some(new_skill.as_path())
        );
    }

    #[test]
    fn maru_entry_symlink_rejects_different_named_skill_link() {
        let links = TempDir::new().unwrap();
        let old_skill = links.path().join("other");
        let new_skill = links.path().join("alpha");
        let maru_entry = links.path().join("maru-alpha");
        fs::create_dir_all(&old_skill).unwrap();
        fs::create_dir_all(&new_skill).unwrap();
        fs::write(old_skill.join("SKILL.md"), "# old\n").unwrap();
        fs::write(new_skill.join("SKILL.md"), "# new\n").unwrap();
        host_fs::create_symlink_no_clobber(&maru_entry, &old_skill).unwrap();

        let error = create_maru_entry_symlink(&maru_entry, &new_skill, "alpha").unwrap_err();

        assert!(error.contains("install_target_exists"));
        assert_eq!(
            host_fs::read_link_target(&maru_entry).as_deref(),
            Some(old_skill.as_path())
        );
    }

    #[test]
    fn managed_source_cannot_be_removed() {
        let _home = test_home();

        let error = skills_remove_source(MANAGED_SOURCE_ID.to_string()).unwrap_err();

        assert_eq!(error, "source_not_removable");
    }

    #[test]
    fn builtin_source_cannot_be_removed() {
        let _home = test_home();
        skills_list_sources(None).unwrap();

        let error = skills_remove_source(BUILTIN_SOURCE_ID.to_string()).unwrap_err();

        assert_eq!(error, "source_not_removable");
    }

    #[test]
    fn reserved_source_ids_cannot_be_added_manually() {
        let _home = test_home();
        let root = TempDir::new().unwrap();

        let error = skills_add_source(
            STAI_PUBLIC_SOURCE_ID.to_string(),
            "linked".to_string(),
            Some(path_string(root.path())),
            None,
            Some("skills".to_string()),
        )
        .unwrap_err();

        assert!(error.contains("source_id_reserved"));
    }

    #[test]
    fn managed_source_kind_cannot_be_added_manually() {
        let _home = test_home();

        let error = skills_add_source(
            "team-managed".to_string(),
            "managed".to_string(),
            None,
            None,
            Some("skills".to_string()),
        )
        .unwrap_err();

        assert_eq!(error, "source_kind_reserved: managed");
    }

    #[test]
    fn adding_source_clears_removed_source_tombstone() {
        let _home = test_home();
        let work = TempDir::new().unwrap();
        let team_root = TempDir::new().unwrap();
        let private_root = TempDir::new().unwrap();
        write_workspace_config(work.path(), team_root.path(), private_root.path());

        skills_add_source(
            "team-public".to_string(),
            "linked".to_string(),
            Some(path_string(team_root.path())),
            None,
            Some("skills".to_string()),
        )
        .unwrap();
        skills_remove_source("team-public".to_string()).unwrap();
        assert!(load_registry()
            .unwrap()
            .removed_source_ids
            .contains(&"team-public".to_string()));

        skills_add_source(
            "team-public".to_string(),
            "linked".to_string(),
            Some(path_string(team_root.path())),
            None,
            Some("skills".to_string()),
        )
        .unwrap();

        let registry = load_registry().unwrap();
        assert!(has_source(&registry.sources, "team-public"));
        assert!(!registry
            .removed_source_ids
            .contains(&"team-public".to_string()));
    }

    #[test]
    fn builtin_catalog_scans_public_skills_without_design_prefix() {
        let _home = test_home();

        let skills = skills_list_skills(None, Some(true)).unwrap();
        let builtin: Vec<_> = skills
            .iter()
            .filter(|skill| skill.source_id == BUILTIN_SOURCE_ID)
            .collect();
        assert_eq!(builtin.len(), embedded_builtin_skill_count());
        assert!(builtin
            .iter()
            .all(|skill| !skill.name.starts_with("design-")));
        assert!(builtin.iter().all(|skill| skill.editable));
    }

    #[test]
    fn cached_skill_list_does_not_materialize_builtin_bundle() {
        let _home = test_home();
        let skills_root = host_fs::skills_root().unwrap();
        let builtin_root = skills_root.join(BUILTIN_DIR_NAME);

        assert!(!builtin_root.exists());
        assert!(skills_list_skills(None, Some(false)).unwrap().is_empty());
        assert!(!builtin_root.exists());

        let mut registry = SkillsRegistry::default();
        registry.skills.push(SkillRecord {
            id: "cached-source::cached".to_string(),
            source_id: "cached-source".to_string(),
            name: "cached".to_string(),
            rel_path: "skills/cached".to_string(),
            abs_path: path_string(&skills_root.join("cached")),
            title: "Cached".to_string(),
            description: None,
            runtime: None,
            category: None,
            tier: "managed".to_string(),
            valid: true,
            validation_errors: Vec::new(),
            editable: true,
            dirty: false,
            content_hash: None,
            saved_hash: None,
        });
        save_registry_unlocked(&registry).unwrap();

        let skills = skills_list_skills(None, Some(false)).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "cached-source::cached");
        assert!(!builtin_root.exists());
    }

    #[test]
    fn doctor_is_strictly_read_only() {
        let _home = test_home();
        save_registry_unlocked(&SkillsRegistry::default()).unwrap();
        let registry_path = registry_path().unwrap();
        let before = fs::read(&registry_path).unwrap();
        let builtin_root = builtin_materialized_root().unwrap();
        assert!(!builtin_root.exists());

        let _ = skills_doctor(None).unwrap();

        assert_eq!(fs::read(&registry_path).unwrap(), before);
        assert!(!builtin_root.exists());
    }

    #[test]
    fn readonly_tool_sync_includes_embedded_builtins_without_materializing() {
        let _home = test_home();
        let builtin_root = builtin_materialized_root().unwrap();
        let registry_path = registry_path().unwrap();
        assert!(!builtin_root.exists());
        assert!(!registry_path.exists());

        let checked = skills_sync_tools(None, vec!["claude".to_string()], false).unwrap();

        assert!(!checked.applied);
        assert_eq!(checked.desired_skills, embedded_builtin_skill_count());
        assert_eq!(checked.desired_installs, checked.desired_skills);
        assert!(!checked.actions.is_empty());
        assert!(!builtin_root.exists());
        assert!(!registry_path.exists());
    }

    #[test]
    fn missing_inventory_source_is_pruned_before_rescan() {
        let home = test_home();
        let agents_root = home._dir.path().join(".agents");
        write_skill(&agents_root, "external-fixture");
        let mut registry = SkillsRegistry::default();
        ensure_inventory_sources(&mut registry);
        rescan_source_in_registry_with_progress(
            &mut registry,
            AGENTS_EXTERNAL_SOURCE_ID,
            ProgressReporter::noop(),
        )
        .unwrap();
        assert!(has_source(&registry.sources, AGENTS_EXTERNAL_SOURCE_ID));
        assert!(registry
            .skills
            .iter()
            .any(|skill| skill.source_id == AGENTS_EXTERNAL_SOURCE_ID));

        fs::remove_dir_all(&agents_root).unwrap();
        ensure_inventory_sources(&mut registry);

        assert!(!has_source(&registry.sources, AGENTS_EXTERNAL_SOURCE_ID));
        assert!(registry
            .skills
            .iter()
            .all(|skill| skill.source_id != AGENTS_EXTERNAL_SOURCE_ID));
    }

    #[test]
    fn tool_sync_apply_is_idempotent_and_records_both_tools() {
        let _home = test_home();
        let tools = vec!["claude".to_string(), "codex".to_string()];

        let applied = skills_sync_tools(None, tools.clone(), true).unwrap();
        assert!(applied.applied);
        assert!(applied.desired_skills > 0);
        assert_eq!(applied.desired_installs, applied.desired_skills * 2);

        let registry = load_registry().unwrap();
        assert_eq!(registry.installs.len(), applied.desired_installs);
        assert!(registry.installs.iter().all(|install| {
            install.managed_by == "maru"
                && install.mode == "symlink"
                && matches!(install.target.as_str(), "claude" | "codex")
        }));

        let checked = skills_sync_tools(None, tools, false).unwrap();
        assert!(!checked.applied);
        assert!(checked.actions.is_empty());
    }

    #[test]
    fn isolated_home_bootstraps_five_ownership_classes_and_43_by_86_catalog() {
        let home = test_home();
        let skills_root = host_fs::skills_root().unwrap();
        materialize_builtin_bundle(&skills_root.join(BUILTIN_DIR_NAME)).unwrap();
        assert_eq!(embedded_builtin_skill_count(), 34);

        let public_root = skills_root.join("_sources").join("skills-public");
        let private_root = skills_root.join("_sources").join("skills-private");
        for index in 0..5 {
            write_skill(&public_root, &format!("public-fixture-{index}"));
        }
        for index in 0..4 {
            write_skill(&private_root, &format!("private-fixture-{index}"));
        }
        write_skill(&home._dir.path().join(".agents"), "external-fixture");
        write_skill(&home._dir.path().join(".agents"), "public-fixture-0");
        let native = home
            ._dir
            .path()
            .join(".codex/skills/.system/native-fixture");
        fs::create_dir_all(&native).unwrap();
        fs::write(
            native.join("SKILL.md"),
            "---\nname: native-fixture\ndescription: native\n---\n",
        )
        .unwrap();
        let native_overlap = home
            ._dir
            .path()
            .join(".codex/skills/.system/private-fixture-0");
        fs::create_dir_all(&native_overlap).unwrap();
        fs::write(
            native_overlap.join("SKILL.md"),
            "---\nname: private-fixture-0\ndescription: native overlap\n---\n",
        )
        .unwrap();

        let tools = vec!["claude".to_string(), "codex".to_string()];
        let applied = skills_sync_tools(None, tools.clone(), true).unwrap();
        assert_eq!(applied.desired_skills, 43);
        assert_eq!(applied.desired_installs, 86);

        let registry = load_registry().unwrap();
        let classes: BTreeSet<_> = registry
            .sources
            .iter()
            .map(|source| source.ownership_class.as_str())
            .collect();
        assert_eq!(
            classes,
            BTreeSet::from([
                "bundled",
                "owned-catalog",
                "imported",
                "external-managed",
                "tool-native",
            ])
        );
        assert!(registry
            .skills
            .iter()
            .any(|skill| skill.name == "external-fixture"));
        assert!(registry
            .skills
            .iter()
            .any(|skill| skill.name == "native-fixture"));
        assert!(registry
            .skills
            .iter()
            .filter(|skill| matches!(
                skill.name.as_str(),
                "public-fixture-0" | "private-fixture-0"
            ))
            .all(|skill| {
                skill.valid
                    && !skill
                        .validation_errors
                        .iter()
                        .any(|error| error.starts_with("duplicate_source"))
            }));
        assert!(registry.installs.iter().all(|install| {
            install.installed_as != "external-fixture" && install.installed_as != "native-fixture"
        }));

        let registry_path = registry_path().unwrap();
        let before = fs::read(&registry_path).unwrap();
        let checked = skills_sync_tools(None, tools, false).unwrap();
        assert!(checked.actions.is_empty());
        assert_eq!(checked.desired_skills, 43);
        assert_eq!(checked.desired_installs, 86);
        assert_eq!(fs::read(&registry_path).unwrap(), before);
    }

    #[test]
    fn tool_install_path_rejects_registry_traversal_names() {
        let _home = test_home();
        assert!(install_target_path("claude", "../../escape").is_err());
        assert!(install_target_path("codex", "..\\escape").is_err());
    }

    #[test]
    fn tool_sync_collision_preflight_makes_zero_target_or_registry_changes() {
        let _home = test_home();
        let skills_root = host_fs::skills_root().unwrap();
        materialize_builtin_bundle(&skills_root.join(BUILTIN_DIR_NAME)).unwrap();
        let tools = vec!["claude".to_string()];
        skills_sync_tools(None, tools.clone(), true).unwrap();
        let registry = load_registry().unwrap();
        let mut names: Vec<_> = registry
            .skills
            .iter()
            .filter(|skill| skill.source_id == BUILTIN_SOURCE_ID)
            .map(|skill| skill.name.clone())
            .collect();
        names.sort();
        let first_target = install_target_path("claude", &names[0]).unwrap();
        fs::remove_file(&first_target).unwrap();
        let collision_name = names.last().unwrap();
        let collision_target = install_target_path("claude", collision_name).unwrap();
        fs::remove_file(&collision_target).unwrap();
        let unrelated = TempDir::new().unwrap();
        let unrelated_skill = unrelated.path().join(collision_name);
        fs::create_dir_all(&unrelated_skill).unwrap();
        fs::write(unrelated_skill.join("SKILL.md"), "# unmanaged\n").unwrap();
        host_fs::create_symlink_no_clobber(&collision_target, &unrelated_skill).unwrap();
        let registry_before = fs::read(registry_path().unwrap()).unwrap();

        let error = skills_sync_tools(None, tools, true).unwrap_err();

        assert!(error.contains("not a proven Maru-owned install link"));
        assert!(!path_occupied(&first_target));
        assert_eq!(
            host_fs::read_link_target(&collision_target).as_deref(),
            Some(unrelated_skill.as_path())
        );
        assert_eq!(fs::read(registry_path().unwrap()).unwrap(), registry_before);
    }

    #[test]
    fn stale_sync_unlinks_exact_owned_chain_but_registry_only_for_foreign_link() {
        let _home = test_home();
        let imported_root = host_fs::skills_root().unwrap().join("_imported");
        let safe_source = write_skill(&imported_root, "stale-safe");
        let unsafe_source = write_skill(&imported_root, "stale-unsafe");
        let tools = vec!["claude".to_string()];
        skills_sync_tools(None, tools.clone(), true).unwrap();
        let safe_target = install_target_path("claude", "stale-safe").unwrap();
        let unsafe_target = install_target_path("claude", "stale-unsafe").unwrap();
        fs::remove_file(&unsafe_target).unwrap();
        let unrelated = TempDir::new().unwrap();
        let foreign = unrelated.path().join("stale-unsafe");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("SKILL.md"), "# foreign\n").unwrap();
        host_fs::create_symlink_no_clobber(&unsafe_target, &foreign).unwrap();
        fs::remove_dir_all(safe_source).unwrap();
        fs::remove_dir_all(unsafe_source).unwrap();

        let checked = skills_sync_tools(None, tools.clone(), false).unwrap();
        assert!(checked.actions.iter().any(|action| {
            action.skill_name == "stale-safe" && action.action == "remove-stale-install"
        }));
        assert!(checked.actions.iter().any(|action| {
            action.skill_name == "stale-unsafe"
                && action.action == "remove-stale-record"
                && action.reason.starts_with("registry-only")
        }));
        skills_sync_tools(None, tools, true).unwrap();

        assert!(!path_occupied(&safe_target));
        assert!(!path_occupied(
            &host_fs::skills_root().unwrap().join("stale-safe")
        ));
        assert_eq!(
            host_fs::read_link_target(&unsafe_target).as_deref(),
            Some(foreign.as_path())
        );
        let registry = load_registry().unwrap();
        assert!(registry.installs.iter().all(|install| {
            !matches!(install.installed_as.as_str(), "stale-safe" | "stale-unsafe")
        }));
    }

    #[test]
    fn stale_sync_removes_owned_copy_but_retains_unverified_copy_record() {
        let _home = test_home();
        let sources = TempDir::new().unwrap();
        let safe_source = write_skill(sources.path(), "stale-copy-safe");
        let unsafe_source = write_skill(sources.path(), "stale-copy-unsafe");
        let safe_target = install_target_path("claude", "stale-copy-safe").unwrap();
        let unsafe_target = install_target_path("claude", "stale-copy-unsafe").unwrap();
        install_copy(
            &safe_target,
            &safe_source,
            "fixture::stale-copy-safe",
            "stale-copy-safe",
        )
        .unwrap();
        fs::create_dir_all(&unsafe_target).unwrap();
        fs::write(unsafe_target.join("SKILL.md"), "# foreign\n").unwrap();

        let mut registry = SkillsRegistry::default();
        registry.installs.push(SkillInstall {
            skill_id: "fixture::stale-copy-safe".to_string(),
            target: "claude".to_string(),
            installed_as: "stale-copy-safe".to_string(),
            managed_by: "maru".to_string(),
            entrypoint_path: path_string(&safe_source),
            target_path: path_string(&safe_target),
            mode: "copy".to_string(),
            created_at: None,
        });
        registry.installs.push(SkillInstall {
            skill_id: "fixture::stale-copy-unsafe".to_string(),
            target: "claude".to_string(),
            installed_as: "stale-copy-unsafe".to_string(),
            managed_by: "maru".to_string(),
            entrypoint_path: path_string(&unsafe_source),
            target_path: path_string(&unsafe_target),
            mode: "copy".to_string(),
            created_at: None,
        });
        save_registry_unlocked(&registry).unwrap();

        let checked = skills_sync_tools(None, vec!["claude".to_string()], false).unwrap();
        assert!(checked.actions.iter().any(|action| {
            action.skill_name == "stale-copy-safe" && action.action == "remove-stale-install"
        }));
        assert!(checked.actions.iter().any(|action| {
            action.skill_name == "stale-copy-unsafe" && action.action == "keep-stale-record"
        }));

        skills_sync_tools(None, vec!["claude".to_string()], true).unwrap();

        assert!(!safe_target.exists());
        assert!(unsafe_target.is_dir());
        let registry = load_registry().unwrap();
        assert!(registry
            .installs
            .iter()
            .all(|install| install.installed_as != "stale-copy-safe"));
        assert!(registry
            .installs
            .iter()
            .any(|install| install.installed_as == "stale-copy-unsafe"));
    }

    #[test]
    fn stai_public_install_remains_public_when_builtin_name_overlaps() {
        let _home = test_home();
        let public_root = TempDir::new().unwrap();
        let old_skill = write_skill(public_root.path(), "gaejosik");
        let links = TempDir::new().unwrap();
        let maru_entry = host_fs::skills_root().unwrap().join("gaejosik");
        let tool_target = links.path().join("gaejosik");
        host_fs::create_symlink_no_clobber(&maru_entry, &old_skill).unwrap();
        host_fs::create_symlink_no_clobber(&tool_target, &maru_entry).unwrap();

        let mut registry = SkillsRegistry::default();
        registry.sources.push(SkillSource {
            id: STAI_PUBLIC_SOURCE_ID.to_string(),
            kind: "linked".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(public_root.path())),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });
        registry.skills.push(SkillRecord {
            id: "stai-public::gaejosik".to_string(),
            source_id: STAI_PUBLIC_SOURCE_ID.to_string(),
            name: "gaejosik".to_string(),
            rel_path: "skills/gaejosik".to_string(),
            abs_path: path_string(&old_skill),
            title: "gaejosik".to_string(),
            description: None,
            runtime: None,
            category: None,
            tier: "public".to_string(),
            valid: true,
            validation_errors: Vec::new(),
            editable: true,
            dirty: false,
            content_hash: None,
            saved_hash: None,
        });
        registry.installs.push(SkillInstall {
            skill_id: "stai-public::gaejosik".to_string(),
            target: "claude".to_string(),
            installed_as: "gaejosik".to_string(),
            managed_by: "maru".to_string(),
            entrypoint_path: path_string(&maru_entry),
            target_path: path_string(&tool_target),
            mode: "symlink".to_string(),
            created_at: None,
        });
        save_registry_unlocked(&registry).unwrap();

        skills_list_sources(None).unwrap();

        let registry = load_registry().unwrap();
        assert!(has_source(&registry.sources, STAI_PUBLIC_SOURCE_ID));
        assert!(!registry
            .removed_source_ids
            .contains(&STAI_PUBLIC_SOURCE_ID.to_string()));
        assert_eq!(registry.installs[0].skill_id, "stai-public::gaejosik");
        assert_eq!(host_fs::read_link_target(&maru_entry).unwrap(), old_skill);
    }

    #[test]
    fn stai_public_install_is_not_copied_into_managed() {
        let _home = test_home();
        let public_root = TempDir::new().unwrap();
        let old_skill = write_skill(public_root.path(), "design-a11y");
        let links = TempDir::new().unwrap();
        let maru_entry = host_fs::skills_root().unwrap().join("design-a11y");
        let tool_target = links.path().join("design-a11y");
        host_fs::create_symlink_no_clobber(&maru_entry, &old_skill).unwrap();
        host_fs::create_symlink_no_clobber(&tool_target, &maru_entry).unwrap();

        let mut registry = SkillsRegistry::default();
        registry.sources.push(SkillSource {
            id: STAI_PUBLIC_SOURCE_ID.to_string(),
            kind: "linked".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(public_root.path())),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });
        registry.skills.push(SkillRecord {
            id: "stai-public::design-a11y".to_string(),
            source_id: STAI_PUBLIC_SOURCE_ID.to_string(),
            name: "design-a11y".to_string(),
            rel_path: "skills/design-a11y".to_string(),
            abs_path: path_string(&old_skill),
            title: "design-a11y".to_string(),
            description: None,
            runtime: None,
            category: None,
            tier: "public".to_string(),
            valid: true,
            validation_errors: Vec::new(),
            editable: true,
            dirty: false,
            content_hash: None,
            saved_hash: None,
        });
        registry.installs.push(SkillInstall {
            skill_id: "stai-public::design-a11y".to_string(),
            target: "claude".to_string(),
            installed_as: "design-a11y".to_string(),
            managed_by: "maru".to_string(),
            entrypoint_path: path_string(&maru_entry),
            target_path: path_string(&tool_target),
            mode: "symlink".to_string(),
            created_at: None,
        });
        save_registry_unlocked(&registry).unwrap();

        skills_list_sources(None).unwrap();

        let registry = load_registry().unwrap();
        assert_eq!(registry.installs[0].skill_id, "stai-public::design-a11y");
        assert!(registry
            .skills
            .iter()
            .any(|skill| skill.id == "stai-public::design-a11y"));
        assert_eq!(host_fs::read_link_target(&maru_entry).unwrap(), old_skill);
    }

    #[test]
    fn builtin_skill_save_persists_and_marks_customized_dirty() {
        let _home = test_home();
        let skills = skills_list_skills(None, Some(true)).unwrap();
        let skill = skills
            .into_iter()
            .find(|skill| skill.id == "maru-builtin::gaejosik")
            .unwrap();

        let content = fs::read_to_string(Path::new(&skill.abs_path).join("SKILL.md")).unwrap();
        let updated = format!("{content}\ncustomized\n");
        let saved =
            skills_save_skill_file(skill.id, "SKILL.md".to_string(), updated.clone()).unwrap();

        assert!(saved.dirty);
        let doc = skills_read_skill("maru-builtin::gaejosik".to_string()).unwrap();
        assert_eq!(doc.content, updated);
    }

    #[test]
    fn save_skill_as_creates_clean_managed_copy() {
        let _home = test_home();
        skills_list_skills(None, Some(true)).unwrap();

        let created = skills_save_skill_as(
            "maru-builtin::gaejosik".to_string(),
            "gaejosik-copy".to_string(),
            "# copied\n".to_string(),
        )
        .unwrap();

        assert_eq!(created.id, "maru-managed::gaejosik-copy");
        assert!(!created.dirty);
        let doc = skills_read_skill(created.id).unwrap();
        assert_eq!(doc.content, "# copied\n");
    }

    #[test]
    fn builtin_env_setup_does_not_require_workspace_config() {
        let _home = test_home();

        let setup = default_public_env_setup(None).unwrap().unwrap();

        assert!(setup.ends_with(Path::new("_builtin/envs/default/setup.sh")));
        assert!(setup.is_file());
    }

    #[test]
    fn serde_default_install_mode_is_symlink() {
        // Registry entries written before the `mode` field existed must load as symlink.
        let json = r#"{
            "skillId": "maru-managed::x",
            "target": "claude",
            "installedAs": "x",
            "managedBy": "maru",
            "entrypointPath": "/tmp/a",
            "targetPath": "/tmp/b"
        }"#;
        let install: SkillInstall = serde_json::from_str(json).unwrap();
        assert_eq!(install.mode, "symlink");
    }

    #[test]
    fn copy_install_creates_real_dir_with_marker() {
        let _home = test_home();
        let created = skills_create_skill("copytest".to_string(), None).unwrap();
        let outcome = skills_install_skill(
            created.id,
            "claude".to_string(),
            None,
            Some("copy".to_string()),
        )
        .unwrap();
        assert_eq!(outcome.install.mode, "copy");
        assert_eq!(outcome.install.managed_by, "maru");

        let tool_target = install_target_path("claude", "copytest").unwrap();
        let meta = fs::symlink_metadata(&tool_target).unwrap();
        assert!(meta.file_type().is_dir());
        assert!(!meta.file_type().is_symlink());
        assert!(tool_target.join("SKILL.md").is_file());

        let marker = read_install_marker(&tool_target).unwrap();
        assert!(marker.maru_managed);
        assert_eq!(marker.mode, "copy");
        assert_eq!(marker.installed_as, "copytest");

        // copy installs create no maru entry symlink
        let maru_entry = host_fs::skills_root().unwrap().join("copytest");
        assert!(host_fs::read_link_target(&maru_entry).is_none());

        let registry = load_registry().unwrap();
        assert!(registry
            .installs
            .iter()
            .any(|install| install.installed_as == "copytest" && install.mode == "copy"));
    }

    #[test]
    fn symlink_install_defaults_to_link_chain() {
        let _home = test_home();
        let created = skills_create_skill("linktest".to_string(), None).unwrap();
        let outcome = skills_install_skill(created.id, "claude".to_string(), None, None).unwrap();
        assert_eq!(outcome.install.mode, "symlink");

        let tool_target = install_target_path("claude", "linktest").unwrap();
        let maru_entry = host_fs::skills_root().unwrap().join("linktest");
        assert_eq!(
            host_fs::read_link_target(&tool_target).as_deref(),
            Some(maru_entry.as_path())
        );
        assert!(host_fs::read_link_target(&maru_entry).is_some());
    }

    #[test]
    fn uninstall_copy_removes_marked_dir() {
        let _home = test_home();
        let created = skills_create_skill("rmtest".to_string(), None).unwrap();
        skills_install_skill(
            created.id,
            "claude".to_string(),
            None,
            Some("copy".to_string()),
        )
        .unwrap();
        let tool_target = install_target_path("claude", "rmtest").unwrap();
        assert!(tool_target.is_dir());

        skills_uninstall_skill("claude".to_string(), "rmtest".to_string()).unwrap();
        assert!(!tool_target.exists());
        let registry = load_registry().unwrap();
        assert!(!registry
            .installs
            .iter()
            .any(|install| install.installed_as == "rmtest"));
    }

    #[test]
    fn uninstall_copy_refuses_unmarked_dir() {
        let _home = test_home();
        // A user-authored directory (no Maru marker) sitting at the tool target.
        let tool_target = install_target_path("claude", "userdir").unwrap();
        host_fs::ensure_dir(&tool_target).unwrap();
        fs::write(tool_target.join("SKILL.md"), "# user\n").unwrap();
        let mut registry = SkillsRegistry::default();
        registry.installs.push(SkillInstall {
            skill_id: "maru-managed::userdir".to_string(),
            target: "claude".to_string(),
            installed_as: "userdir".to_string(),
            managed_by: "maru".to_string(),
            entrypoint_path: path_string(&tool_target),
            target_path: path_string(&tool_target),
            mode: "copy".to_string(),
            created_at: None,
        });
        save_registry_unlocked(&registry).unwrap();

        let err = skills_uninstall_skill("claude".to_string(), "userdir".to_string()).unwrap_err();
        assert_eq!(err, "install_not_maru_managed");
        // The user's directory must survive.
        assert!(tool_target.join("SKILL.md").is_file());
    }

    #[test]
    fn copy_install_reinstall_overwrites_own_marked_dir() {
        let _home = test_home();
        let created = skills_create_skill("reinstall".to_string(), None).unwrap();
        skills_install_skill(
            created.id.clone(),
            "claude".to_string(),
            None,
            Some("copy".to_string()),
        )
        .unwrap();
        // A second copy install of the same name must succeed (our marker is present).
        let outcome = skills_install_skill(
            created.id,
            "claude".to_string(),
            None,
            Some("copy".to_string()),
        )
        .unwrap();
        assert_eq!(outcome.install.mode, "copy");
        let tool_target = install_target_path("claude", "reinstall").unwrap();
        assert!(tool_target.join("SKILL.md").is_file());
        assert!(read_install_marker(&tool_target).unwrap().maru_managed);
    }

    #[test]
    fn copy_install_errors_on_foreign_existing_dir() {
        let _home = test_home();
        let created = skills_create_skill("foreign".to_string(), None).unwrap();
        let tool_target = install_target_path("claude", "foreign").unwrap();
        host_fs::ensure_dir(&tool_target).unwrap();
        fs::write(tool_target.join("SKILL.md"), "# foreign\n").unwrap();

        let err = skills_install_skill(
            created.id,
            "claude".to_string(),
            None,
            Some("copy".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("install_target_exists"));
        // Foreign content untouched.
        assert_eq!(
            fs::read_to_string(tool_target.join("SKILL.md")).unwrap(),
            "# foreign\n"
        );
    }

    #[test]
    fn install_present_detects_copy_state() {
        let _home = test_home();
        let created = skills_create_skill("presence".to_string(), None).unwrap();
        skills_install_skill(
            created.id,
            "claude".to_string(),
            None,
            Some("copy".to_string()),
        )
        .unwrap();
        let registry = load_registry().unwrap();
        let install = registry
            .installs
            .iter()
            .find(|install| install.installed_as == "presence")
            .unwrap();
        assert!(install_present(install));

        let mut missing = install.clone();
        missing.installed_as = "ghost".to_string();
        missing.target_path = path_string(&install_target_path("claude", "ghost").unwrap());
        assert!(!install_present(&missing));
    }

    #[test]
    fn sync_all_aggregates_errors_without_aborting() {
        let _home = test_home();
        let good = TempDir::new().unwrap();
        write_skill(good.path(), "goodskill");
        let mut registry = SkillsRegistry::default();
        registry.sources.push(SkillSource {
            id: "goodsrc".to_string(),
            kind: "linked".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(good.path())),
            repo_url: None,
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });
        registry.sources.push(SkillSource {
            id: "badsrc".to_string(),
            kind: "cloned".to_string(),
            ownership_class: "owned-catalog".to_string(),
            path: Some(path_string(&good.path().join("does-not-exist"))),
            repo_url: Some("https://example.invalid/x.git".to_string()),
            skills_subdir: "skills".to_string(),
            branch: None,
            last_synced_at: None,
        });
        save_registry_unlocked(&registry).unwrap();

        let outcome = skills_sync_all_sources_impl(None, ProgressReporter::noop()).unwrap();
        let good_result = outcome
            .results
            .iter()
            .find(|result| result.source_id == "goodsrc")
            .unwrap();
        assert!(good_result.ok);
        assert!(good_result.last_synced_at.is_some());
        assert_eq!(good_result.skills, 1);

        let bad_result = outcome
            .results
            .iter()
            .find(|result| result.source_id == "badsrc")
            .unwrap();
        assert!(!bad_result.ok);
        assert!(bad_result.error.is_some());
        assert!(outcome.failed >= 1);
    }

    #[test]
    fn reset_registry_preserves_copy_install() {
        let _home = test_home();
        let work = TempDir::new().unwrap();
        let created = skills_create_skill("resetcopy".to_string(), None).unwrap();
        skills_install_skill(
            created.id,
            "claude".to_string(),
            None,
            Some("copy".to_string()),
        )
        .unwrap();

        skills_reset_registry_impl(Some(path_string(work.path())), ProgressReporter::noop())
            .unwrap();

        let registry = load_registry().unwrap();
        assert!(registry
            .installs
            .iter()
            .any(|install| install.installed_as == "resetcopy" && install.mode == "copy"));
    }

    // -----------------------------------------------------------------------
    // OTA bundle lifecycle
    // -----------------------------------------------------------------------

    #[test]
    fn fresh_install_writes_bootstrap_state_and_pristine() {
        let _home = test_home();
        let builtin = builtin_materialized_root().unwrap();

        let state = ensure_active_bundle(&builtin).unwrap();

        let active = state.active.expect("active bundle");
        assert_eq!(active.source, bundle::BOOTSTRAP_SOURCE);
        assert_eq!(active.revision, 0);
        assert!(builtin.join("manifest.json").is_file());
        let pristine = bundle::bundle_pristine_dir(&active.bundle_id).unwrap();
        assert!(pristine.join("manifest.json").is_file());
        assert!(pristine.join("skills/vault-sync/SKILL.md").is_file());
        // Idempotent: a second call keeps the same identity.
        let again = ensure_active_bundle(&builtin).unwrap();
        assert_eq!(again.active.unwrap().bundle_id, active.bundle_id);
    }

    #[test]
    fn remote_active_state_blocks_embedded_rematerialize() {
        let _home = test_home();
        let builtin = builtin_materialized_root().unwrap();
        ensure_active_bundle(&builtin).unwrap();

        // Simulate an applied OTA bundle newer than the embedded snapshot.
        bundle::write_state(&BundleState {
            schema: 1,
            active: Some(SkillBundleRef {
                bundle_id: "r9-abcdef0".to_string(),
                revision: 9,
                display_version: "r9".to_string(),
                commit: None,
                source: bundle::REMOTE_SOURCE.to_string(),
                env_hash: "e".to_string(),
                applied_at: "t".to_string(),
            }),
            previous: None,
        })
        .unwrap();
        let marker = builtin.join("skills/vault-sync/SKILL.md");
        fs::write(&marker, "remote bundle content").unwrap();

        let state = ensure_active_bundle(&builtin).unwrap();

        assert_eq!(state.active.unwrap().revision, 9);
        assert_eq!(
            fs::read_to_string(&marker).unwrap(),
            "remote bundle content",
            "embedded snapshot must not clobber an applied remote bundle"
        );
    }

    #[test]
    fn migration_from_pre_ota_install_preserves_user_edits() {
        let _home = test_home();
        let builtin = builtin_materialized_root().unwrap();
        // Legacy install: materialized _builtin, no bundle state.
        materialize_builtin_bundle(&builtin).unwrap();
        let edited = builtin.join("skills/gaejosik/SKILL.md");
        let user_content = "---\nname: gaejosik\ndescription: edited by user\n---\n";
        fs::write(&edited, user_content).unwrap();
        assert!(bundle::read_state().unwrap().is_none());

        let state = ensure_active_bundle(&builtin).unwrap();

        let active = state.active.expect("active bundle");
        assert_eq!(active.source, bundle::BOOTSTRAP_SOURCE);
        assert_eq!(
            fs::read_to_string(&edited).unwrap(),
            user_content,
            "migration must keep local edits byte-identical"
        );
        // The pristine baseline carries the ORIGINAL content, so the edit now
        // counts as dirty.
        let pristine_hash = active_pristine_skill_hash("gaejosik").expect("baseline");
        let current_hash =
            hash_directory_filtered(&builtin.join("skills/gaejosik")).unwrap();
        assert_ne!(pristine_hash, current_hash);
    }

    #[test]
    fn bundle_dirty_areas_reports_drift_and_ignores_junk() {
        let scratch = TempDir::new().unwrap();
        let pristine = scratch.path().join("pristine");
        let builtin = scratch.path().join("builtin");
        for root in [&pristine, &builtin] {
            fs::create_dir_all(root.join("skills/alpha")).unwrap();
            fs::create_dir_all(root.join("envs/default")).unwrap();
            fs::write(root.join("manifest.json"), "{}").unwrap();
            fs::write(root.join("skills/alpha/SKILL.md"), "same").unwrap();
            fs::write(root.join("envs/default/setup.sh"), "same").unwrap();
        }

        assert!(bundle_dirty_areas(&builtin, &pristine).unwrap().is_empty());

        // Edit, add, delete, plus junk that must not count.
        fs::write(builtin.join("skills/alpha/SKILL.md"), "edited").unwrap();
        fs::create_dir_all(builtin.join("skills/beta")).unwrap();
        fs::write(builtin.join("skills/beta/SKILL.md"), "user-added").unwrap();
        fs::remove_file(builtin.join("envs/default/setup.sh")).unwrap();
        fs::create_dir_all(builtin.join("skills/alpha/__pycache__")).unwrap();
        fs::write(builtin.join("skills/alpha/__pycache__/x.pyc"), "junk").unwrap();
        fs::write(builtin.join(".DS_Store"), "junk").unwrap();

        let areas = bundle_dirty_areas(&builtin, &pristine).unwrap();
        assert_eq!(areas, vec!["alpha", "beta", "envs"]);
    }

    #[test]
    fn restore_builtin_skill_uses_active_pristine_over_embedded() {
        let _home = test_home();
        let builtin = builtin_materialized_root().unwrap();
        ensure_active_bundle(&builtin).unwrap();

        // Fake an applied remote bundle whose gaejosik differs from embedded.
        let pristine = bundle::bundle_pristine_dir("r5-cafe000").unwrap();
        fs::create_dir_all(pristine.join("skills/gaejosik")).unwrap();
        let bundle_content = "---\nname: gaejosik\ndescription: from r5 bundle\n---\n";
        fs::write(pristine.join("skills/gaejosik/SKILL.md"), bundle_content).unwrap();
        bundle::write_state(&BundleState {
            schema: 1,
            active: Some(SkillBundleRef {
                bundle_id: "r5-cafe000".to_string(),
                revision: 5,
                display_version: "r5".to_string(),
                commit: None,
                source: bundle::REMOTE_SOURCE.to_string(),
                env_hash: "e".to_string(),
                applied_at: "t".to_string(),
            }),
            previous: None,
        })
        .unwrap();
        fs::write(
            builtin.join("skills/gaejosik/SKILL.md"),
            "user scribbles",
        )
        .unwrap();

        restore_builtin_skill("gaejosik").unwrap();

        assert_eq!(
            fs::read_to_string(builtin.join("skills/gaejosik/SKILL.md")).unwrap(),
            bundle_content,
            "discard must restore the ACTIVE bundle content, not the embedded snapshot"
        );
    }

    #[test]
    fn bundle_status_reports_clean_fresh_install() {
        let _home = test_home();
        let builtin = builtin_materialized_root().unwrap();
        ensure_active_bundle(&builtin).unwrap();

        let status = skills_bundle_status().unwrap();

        let active = status.active.expect("active bundle");
        assert_eq!(active.source, bundle::BOOTSTRAP_SOURCE);
        assert!(!status.update_available);
        assert!(status.available.is_none());
        assert!(status.dirty_skills.is_empty());
        assert!(!status.auto_applicable);
        assert!(status.min_app_ok);
    }
}
