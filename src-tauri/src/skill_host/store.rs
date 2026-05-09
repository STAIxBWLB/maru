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
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::cli_path::merge_path_env;
use crate::skill_host::fs as host_fs;
use crate::vault::{parse_frontmatter, title_from_content};

const REGISTRY_VERSION: u32 = 1;
const REGISTRY_FILE: &str = "registry.json";
const BUILTIN_SOURCE_ID: &str = "anchor-builtin";
const BUILTIN_DIR_NAME: &str = "_builtin";
const BUILTIN_HASHES_FILE: &str = ".anchor-builtin-hashes.json";
const MANAGED_SOURCE_ID: &str = "anchor-managed";
const STAI_PUBLIC_SOURCE_ID: &str = "stai-public";

static BUILTIN_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../skills");

static REGISTRY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    pub id: String,
    pub kind: String,
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
    pub anchor_entrypoint: String,
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
pub struct ResetOutcome {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    pub sources: usize,
    pub skills: usize,
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

#[derive(Clone, Copy)]
struct ProgressReporter<'a> {
    app: Option<&'a AppHandle>,
    progress_id: Option<&'a str>,
}

fn default_skills_subdir() -> String {
    "skills".to_string()
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
        BUILTIN_SOURCE_ID | MANAGED_SOURCE_ID | STAI_PUBLIC_SOURCE_ID
    ) {
        return Err(format!("source_id_reserved: {id}"));
    }
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    if registry.sources.iter().any(|source| source.id == id) {
        return Err(format!("source_exists: {id}"));
    }

    let source_path = match kind.as_str() {
        "linked" => {
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

    let source = SkillSource {
        id,
        kind,
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
    if source.kind == "cloned" {
        let path = source_path(&source)?;
        progress.info(format!("Pulling latest changes for {source_id}"));
        run_command(
            Command::new("git")
                .arg("-C")
                .arg(path)
                .arg("pull")
                .arg("--ff-only"),
        )?;
        progress.success(format!("Git pull complete for {source_id}"));
    } else {
        progress.info(format!("Source {source_id} is linked; skipping git pull"));
    }
    let skills = rescan_source_in_registry_with_progress(&mut registry, &source_id, progress)?;
    save_registry_unlocked(&registry)?;
    progress.success(format!(
        "Sync complete for {source_id}: {} skill(s)",
        skills.len()
    ));
    Ok(skills)
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
pub fn skills_list_skills(work_path: Option<String>) -> Result<Vec<SkillRecord>, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
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
) -> Result<InstallOutcome, String> {
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    let skill = registry
        .skills
        .iter()
        .find(|skill| skill.id == skill_id)
        .cloned()
        .ok_or_else(|| format!("unknown_skill: {skill_id}"))?;
    let target = normalize_install_target(&target)?;
    let installed_as = host_fs::safe_entry_name(installed_as.as_deref().unwrap_or(&skill.name))?;
    let anchor_entry = host_fs::skills_root()?.join(&installed_as);
    let skill_path = PathBuf::from(&skill.abs_path);
    create_anchor_entry_symlink(&anchor_entry, &skill_path, &installed_as)?;

    let tool_target = install_target_path(&target, &installed_as)?;
    create_install_target_symlink(&tool_target, &anchor_entry, &skill_path)?;

    let install = SkillInstall {
        skill_id,
        target: target.clone(),
        installed_as,
        managed_by: "anchor".to_string(),
        entrypoint_path: host_fs::display_path(&anchor_entry),
        target_path: host_fs::display_path(&tool_target),
        created_at: Some(Utc::now().to_rfc3339()),
    };
    registry.installs.retain(|existing| {
        !(existing.target == install.target && existing.installed_as == install.installed_as)
    });
    registry.installs.push(install.clone());
    save_registry_unlocked(&registry)?;
    Ok(InstallOutcome {
        install,
        anchor_entrypoint: host_fs::display_path(&anchor_entry),
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
    if install.managed_by != "anchor" {
        return Err("external_install_not_removed".to_string());
    }
    let tool_target = PathBuf::from(&install.target_path);
    let anchor_entry = PathBuf::from(&install.entrypoint_path);
    let removed_target = host_fs::remove_if_matching_symlink(&tool_target, &anchor_entry)?;
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
            let _ = host_fs::remove_if_matching_symlink(&anchor_entry, &skill_target);
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
            let Some(raw_target) = host_fs::read_link_target(&link_path) else {
                skipped += 1;
                progress.info(format!("Skipped {target}/{installed_as}: not a symlink"));
                continue;
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

fn preserved_installs_from_registry(registry: SkillsRegistry) -> Vec<SkillInstall> {
    registry
        .installs
        .into_iter()
        .filter(install_links_are_intact)
        .collect()
}

fn install_links_are_intact(install: &SkillInstall) -> bool {
    let target_path = PathBuf::from(&install.target_path);
    let entrypoint_path = PathBuf::from(&install.entrypoint_path);
    host_fs::read_link_target(&target_path).as_deref() == Some(entrypoint_path.as_path())
}

fn create_anchor_entry_symlink(
    anchor_entry: &Path,
    skill_path: &Path,
    installed_as: &str,
) -> Result<(), String> {
    if !anchor_entry.exists() && fs::symlink_metadata(anchor_entry).is_err() {
        return host_fs::create_symlink_no_clobber(anchor_entry, skill_path);
    }
    if symlink_target_path_equals(anchor_entry, skill_path)
        || symlink_target_resolves_to(anchor_entry, skill_path)
    {
        return Ok(());
    }
    if symlink_target_is_skill_named(anchor_entry, installed_as) {
        fs::remove_file(anchor_entry).map_err(|err| {
            format!(
                "Cannot replace existing Anchor skill link {}: {err}",
                host_fs::display_path(anchor_entry)
            )
        })?;
        return host_fs::create_symlink_no_clobber(anchor_entry, skill_path);
    }
    Err(format!(
        "install_target_exists: {} already exists and does not point to {}",
        host_fs::display_path(anchor_entry),
        host_fs::display_path(skill_path)
    ))
}

fn create_install_target_symlink(
    tool_target: &Path,
    anchor_entry: &Path,
    skill_path: &Path,
) -> Result<(), String> {
    if !tool_target.exists() && fs::symlink_metadata(tool_target).is_err() {
        return host_fs::create_symlink_no_clobber(tool_target, anchor_entry);
    }
    if symlink_target_path_equals(tool_target, anchor_entry) {
        return Ok(());
    }
    if symlink_target_resolves_to(tool_target, skill_path) {
        fs::remove_file(tool_target).map_err(|err| {
            format!(
                "Cannot replace existing install link {}: {err}",
                host_fs::display_path(tool_target)
            )
        })?;
        return host_fs::create_symlink_no_clobber(tool_target, anchor_entry);
    }
    Err(format!(
        "install_target_exists: {} already exists and does not point to {}",
        host_fs::display_path(tool_target),
        host_fs::display_path(anchor_entry)
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
    registry.version = REGISTRY_VERSION;
    normalize_removed_source_ids(&mut registry);
    Ok(registry)
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
    let mut vars = BTreeMap::new();
    vars.insert(
        "ANCHOR_SKILLS_ENV".to_string(),
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
    migrate_stai_public_source(registry)?;
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
    let private_root = yaml_string(skills, "private_root");
    let private_skills = yaml_string(skills, "private_skills");
    if let Some(root) = private_root {
        upsert_default_linked_source(
            registry,
            "stai-private",
            &root,
            skills_subdir_for(&root, private_skills.as_deref()),
        );
    }
    Ok(())
}

fn ensure_builtin_source(registry: &mut SkillsRegistry) -> Result<(), String> {
    clear_removed_source(registry, BUILTIN_SOURCE_ID);
    let builtin = builtin_materialized_root()?;
    materialize_builtin_bundle(&builtin)?;
    let source = SkillSource {
        id: BUILTIN_SOURCE_ID.to_string(),
        kind: "builtin".to_string(),
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
            path: Some(host_fs::display_path(&managed)),
            repo_url: None,
            skills_subdir: ".".to_string(),
            branch: None,
            last_synced_at: None,
        });
    }
    Ok(())
}

fn builtin_materialized_root() -> Result<PathBuf, String> {
    Ok(host_fs::skills_root()?.join(BUILTIN_DIR_NAME))
}

fn builtin_env_setup_path() -> Result<Option<PathBuf>, String> {
    let root = builtin_materialized_root()?;
    materialize_builtin_bundle(&root)?;
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

fn migrate_stai_public_source(registry: &mut SkillsRegistry) -> Result<(), String> {
    let has_public_source = registry
        .sources
        .iter()
        .any(|source| source.id == STAI_PUBLIC_SOURCE_ID);
    let has_public_skills = registry
        .skills
        .iter()
        .any(|skill| skill.source_id == STAI_PUBLIC_SOURCE_ID);
    let has_public_installs = registry
        .installs
        .iter()
        .any(|install| stai_public_skill_name(&install.skill_id).is_some());
    if !has_public_source && !has_public_skills && !has_public_installs {
        return Ok(());
    }

    let old_skill_paths: BTreeMap<String, PathBuf> = registry
        .skills
        .iter()
        .filter(|skill| skill.source_id == STAI_PUBLIC_SOURCE_ID)
        .map(|skill| (skill.name.clone(), PathBuf::from(&skill.abs_path)))
        .collect();

    let builtin_root = builtin_materialized_root()?;
    let mut needs_managed_rescan = false;
    for install in registry.installs.iter_mut() {
        let Some(name) = stai_public_skill_name(&install.skill_id).map(ToString::to_string) else {
            continue;
        };
        let builtin_skill = builtin_root.join("skills").join(&name);
        if builtin_skill.join("SKILL.md").is_file() {
            repoint_anchor_entry_if_matching_old_target(install, &old_skill_paths, &builtin_skill)?;
            install.skill_id = format!("{BUILTIN_SOURCE_ID}::{name}");
            continue;
        }

        let Some(old_path) = old_skill_paths
            .get(&name)
            .cloned()
            .or_else(|| resolve_install_entrypoint_target(install))
        else {
            continue;
        };
        if !old_path.join("SKILL.md").is_file() {
            continue;
        }
        let managed_name = unique_managed_skill_name(&name)?;
        let managed_root = host_fs::skills_root()?.join("_managed").join(&managed_name);
        copy_dir_all(&old_path, &managed_root)?;
        repoint_anchor_entry(install, &old_path, &managed_root)?;
        install.skill_id = format!("{MANAGED_SOURCE_ID}::{managed_name}");
        needs_managed_rescan = true;
    }

    registry
        .sources
        .retain(|source| source.id != STAI_PUBLIC_SOURCE_ID);
    registry
        .skills
        .retain(|skill| skill.source_id != STAI_PUBLIC_SOURCE_ID);
    mark_source_removed(registry, STAI_PUBLIC_SOURCE_ID);
    let _ = rescan_source_in_registry(registry, BUILTIN_SOURCE_ID)?;
    if needs_managed_rescan {
        let _ = rescan_source_in_registry(registry, MANAGED_SOURCE_ID)?;
    }
    Ok(())
}

fn stai_public_skill_name(skill_id: &str) -> Option<&str> {
    skill_id
        .strip_prefix("stai-public::")
        .or_else(|| skill_id.strip_prefix("stai-public:"))
}

fn resolve_install_entrypoint_target(install: &SkillInstall) -> Option<PathBuf> {
    let entry = PathBuf::from(&install.entrypoint_path);
    host_fs::read_link_target(&entry).map(|target| resolve_link_target(&entry, target))
}

fn repoint_anchor_entry_if_matching_old_target(
    install: &SkillInstall,
    old_skill_paths: &BTreeMap<String, PathBuf>,
    new_target: &Path,
) -> Result<(), String> {
    let Some(name) = stai_public_skill_name(&install.skill_id) else {
        return Ok(());
    };
    let Some(old_target) = old_skill_paths
        .get(name)
        .cloned()
        .or_else(|| resolve_install_entrypoint_target(install))
    else {
        return Ok(());
    };
    repoint_anchor_entry(install, &old_target, new_target)
}

fn repoint_anchor_entry(
    install: &SkillInstall,
    old_target: &Path,
    new_target: &Path,
) -> Result<(), String> {
    let entry = PathBuf::from(&install.entrypoint_path);
    if host_fs::read_link_target(&entry)
        .map(|target| canonicalize_or_self(&resolve_link_target(&entry, target)))
        .as_ref()
        == Some(&canonicalize_or_self(new_target))
    {
        return Ok(());
    }
    if !entry.exists() && fs::symlink_metadata(&entry).is_err() {
        return host_fs::create_symlink_no_clobber(&entry, new_target);
    }
    let points_to_old = host_fs::read_link_target(&entry)
        .map(|target| canonicalize_or_self(&resolve_link_target(&entry, target)))
        .as_ref()
        == Some(&canonicalize_or_self(old_target));
    if points_to_old {
        fs::remove_file(&entry)
            .map_err(|err| format!("Cannot replace {}: {err}", host_fs::display_path(&entry)))?;
        return host_fs::create_symlink_no_clobber(&entry, new_target);
    }
    Ok(())
}

fn unique_managed_skill_name(name: &str) -> Result<String, String> {
    let base = host_fs::safe_entry_name(name)?;
    let managed_root = host_fs::skills_root()?.join("_managed");
    if !managed_root.join(&base).exists() {
        return Ok(base);
    }
    for index in 1..1000 {
        let candidate = format!("{base}-migrated-{index}");
        if !managed_root.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Err(format!("managed_skill_name_exhausted: {base}"))
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
    if source_id == MANAGED_SOURCE_ID || source_id == BUILTIN_SOURCE_ID {
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
    let scanned = scan_source_with_progress(&source, progress, &saved_hashes)?;
    registry.skills.retain(|skill| skill.source_id != source_id);
    registry.skills.extend(scanned.clone());
    if let Some(existing) = registry
        .sources
        .iter_mut()
        .find(|item| item.id == source_id)
    {
        existing.last_synced_at = Some(Utc::now().to_rfc3339());
    }
    progress.success(format!(
        "Updated registry for {source_id}: {} skill(s)",
        scanned.len()
    ));
    Ok(scanned)
}

fn scan_source_with_progress(
    source: &SkillSource,
    progress: ProgressReporter<'_>,
    saved_hashes: &BTreeMap<String, String>,
) -> Result<Vec<SkillRecord>, String> {
    let base = source_path(source)?;
    progress.info(format!("Source base {}", host_fs::display_path(&base)));
    let skill_roots =
        manifest_skill_roots(&base, source)?.unwrap_or_else(|| discover_skill_roots(&base, source));
    let total = skill_roots.len();
    progress.progress(
        "info",
        format!("Found {total} skill root(s) in {}", source.id),
        0,
        total,
    );
    let mut skills = Vec::new();
    for (index, skill_root) in skill_roots.into_iter().enumerate() {
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
            "linked" | "cloned" => dirty,
            "builtin" => builtin_skill_hash(&name)
                .map(|baseline| baseline != current_hash)
                .unwrap_or(false),
            _ => saved_hash != current_hash,
        };
        skills.push(SkillRecord {
            id,
            source_id: source.id.clone(),
            name: name.clone(),
            rel_path,
            abs_path: host_fs::display_path(&canonicalize_or_self(&skill_root)),
            title,
            description: yaml_meta_string(&parts.meta, "description"),
            runtime: yaml_meta_string(&parts.meta, "runtime"),
            category: yaml_meta_string(&parts.meta, "category"),
            editable: true,
            dirty,
            content_hash: Some(current_hash),
            saved_hash: Some(saved_hash),
        });
        progress.progress("success", format!("Scanned skill {name}"), index + 1, total);
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

fn manifest_skill_roots(base: &Path, source: &SkillSource) -> Result<Option<Vec<PathBuf>>, String> {
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
        let rel = match item {
            serde_json::Value::String(name) => source_skill_base(base, source).join(name),
            serde_json::Value::Object(map) => {
                if let Some(path) = map.get("path").and_then(serde_json::Value::as_str) {
                    base.join(path)
                } else if let Some(name) = map.get("name").and_then(serde_json::Value::as_str) {
                    source_skill_base(base, source).join(name)
                } else {
                    continue;
                }
            }
            _ => continue,
        };
        roots.push(rel);
    }
    Ok(Some(roots))
}

fn discover_skill_roots(base: &Path, source: &SkillSource) -> Vec<PathBuf> {
    let skills_base = source_skill_base(base, source);
    if source.skills_subdir == "." && skills_base.join("SKILL.md").is_file() {
        return vec![skills_base];
    }
    if !skills_base.is_dir() {
        return Vec::new();
    }
    WalkDir::new(&skills_base)
        .follow_links(false)
        .min_depth(1)
        .max_depth(2)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
        .filter_map(|entry| entry.path().parent().map(Path::to_path_buf))
        .collect()
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
        let data = fs::read(&file)
            .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&file)))?;
        hasher.update(sha256_hex(&data).as_bytes());
        hasher.update(b"\0");
    }
    Ok(format!("{:x}", hasher.finalize()))
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
        "claude" => Ok(host_fs::home_dir()?.join(".claude").join("skills")),
        "codex" => Ok(host_fs::home_dir()?.join(".codex").join("skills")),
        other => Err(format!("unsupported_install_target: {other}")),
    }
}

fn install_target_path(target: &str, installed_as: &str) -> Result<PathBuf, String> {
    Ok(install_root(target)?.join(installed_as))
}

fn normalize_install_target(target: &str) -> Result<String, String> {
    let target = target.trim().to_lowercase();
    match target.as_str() {
        "claude" | "codex" => Ok(target),
        _ => Err(format!("unsupported_install_target: {target}")),
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
        "linked" | "cloned" | "imported" | "managed" | "adopted" | "builtin" => Ok(value),
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

    static TEST_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct TestHome {
        _guard: MutexGuard<'static, ()>,
        _dir: TempDir,
        previous: Option<OsString>,
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.as_ref() {
                std::env::set_var("ANCHOR_TEST_HOME", previous);
            } else {
                std::env::remove_var("ANCHOR_TEST_HOME");
            }
        }
    }

    fn test_home() -> TestHome {
        let guard = TEST_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = TempDir::new().unwrap();
        let previous = std::env::var_os("ANCHOR_TEST_HOME");
        std::env::set_var("ANCHOR_TEST_HOME", dir.path());
        TestHome {
            _guard: guard,
            _dir: dir,
            previous,
        }
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().to_string()
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

    #[test]
    fn source_id_validation_rejects_path_like_values() {
        assert!(normalize_source_id("stai-public").is_ok());
        assert!(normalize_source_id("../x").is_err());
        assert!(normalize_source_id("x/y").is_err());
    }

    #[test]
    fn safe_relative_path_rejects_escape() {
        assert!(safe_relative_path("SKILL.md").is_ok());
        assert!(safe_relative_path("../SKILL.md").is_err());
        assert!(safe_relative_path("/tmp/SKILL.md").is_err());
    }

    #[test]
    fn skills_subdir_derives_relative_path() {
        let root = "/tmp/work/_sys/skills";
        let skills = "/tmp/work/_sys/skills/skills";
        assert_eq!(skills_subdir_for(root, Some(skills)), "skills");
    }

    #[test]
    fn default_sources_use_builtin_and_private_only() {
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
        assert!(!has_source(&sources, STAI_PUBLIC_SOURCE_ID));
    }

    #[test]
    fn reset_registry_keeps_stai_public_removed() {
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
        assert!(!has_source(&refreshed, STAI_PUBLIC_SOURCE_ID));
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
        let anchor_entry = links.path().join("anchor-alpha");
        let tool_target = links.path().join("tool-alpha");
        fs::create_dir_all(&skill_target).unwrap();
        fs::write(skill_target.join("SKILL.md"), "# alpha\n").unwrap();
        host_fs::create_symlink_no_clobber(&anchor_entry, &skill_target).unwrap();
        host_fs::create_symlink_no_clobber(&tool_target, &anchor_entry).unwrap();

        let mut registry = SkillsRegistry::default();
        registry.installs.push(SkillInstall {
            skill_id: "stai-public:alpha".to_string(),
            target: "claude".to_string(),
            installed_as: "alpha".to_string(),
            managed_by: "anchor".to_string(),
            entrypoint_path: path_string(&anchor_entry),
            target_path: path_string(&tool_target),
            created_at: None,
        });
        registry.installs.push(SkillInstall {
            skill_id: "stai-public:stale".to_string(),
            target: "codex".to_string(),
            installed_as: "stale".to_string(),
            managed_by: "anchor".to_string(),
            entrypoint_path: path_string(&links.path().join("missing-anchor")),
            target_path: path_string(&links.path().join("missing-tool")),
            created_at: None,
        });
        save_registry_unlocked(&registry).unwrap();

        skills_reset_registry_impl(Some(work_path), ProgressReporter::noop()).unwrap();

        let registry = load_registry().unwrap();
        assert_eq!(registry.installs.len(), 1);
        assert_eq!(registry.installs[0].installed_as, "alpha");
        assert_eq!(registry.installs[0].managed_by, "anchor");
        assert!(registry.installs[0].skill_id.starts_with(MANAGED_SOURCE_ID));
    }

    #[test]
    fn install_target_symlink_repoints_existing_direct_skill_link() {
        let links = TempDir::new().unwrap();
        let skill_target = links.path().join("skill-alpha");
        let anchor_entry = links.path().join("anchor-alpha");
        let tool_target = links.path().join("tool-alpha");
        fs::create_dir_all(&skill_target).unwrap();
        host_fs::create_symlink_no_clobber(&anchor_entry, &skill_target).unwrap();
        host_fs::create_symlink_no_clobber(&tool_target, &skill_target).unwrap();

        create_install_target_symlink(&tool_target, &anchor_entry, &skill_target).unwrap();

        assert_eq!(
            host_fs::read_link_target(&tool_target).as_deref(),
            Some(anchor_entry.as_path())
        );
    }

    #[test]
    fn install_target_symlink_rejects_unrelated_existing_link() {
        let links = TempDir::new().unwrap();
        let skill_target = links.path().join("skill-alpha");
        let anchor_entry = links.path().join("anchor-alpha");
        let tool_target = links.path().join("tool-alpha");
        let unrelated = links.path().join("unrelated");
        fs::create_dir_all(&skill_target).unwrap();
        fs::create_dir_all(&unrelated).unwrap();
        host_fs::create_symlink_no_clobber(&anchor_entry, &skill_target).unwrap();
        host_fs::create_symlink_no_clobber(&tool_target, &unrelated).unwrap();

        let error =
            create_install_target_symlink(&tool_target, &anchor_entry, &skill_target).unwrap_err();

        assert!(error.contains("install_target_exists"));
        assert_eq!(
            host_fs::read_link_target(&tool_target).as_deref(),
            Some(unrelated.as_path())
        );
    }

    #[test]
    fn anchor_entry_symlink_repoints_existing_same_named_skill_link() {
        let links = TempDir::new().unwrap();
        let old_skill = links.path().join("alpha");
        let new_skill = links.path().join("new").join("alpha");
        let anchor_entry = links.path().join("anchor-alpha");
        fs::create_dir_all(&old_skill).unwrap();
        fs::create_dir_all(&new_skill).unwrap();
        fs::write(old_skill.join("SKILL.md"), "# old\n").unwrap();
        fs::write(new_skill.join("SKILL.md"), "# new\n").unwrap();
        host_fs::create_symlink_no_clobber(&anchor_entry, &old_skill).unwrap();

        create_anchor_entry_symlink(&anchor_entry, &new_skill, "alpha").unwrap();

        assert_eq!(
            host_fs::read_link_target(&anchor_entry).as_deref(),
            Some(new_skill.as_path())
        );
    }

    #[test]
    fn anchor_entry_symlink_rejects_different_named_skill_link() {
        let links = TempDir::new().unwrap();
        let old_skill = links.path().join("other");
        let new_skill = links.path().join("alpha");
        let anchor_entry = links.path().join("anchor-alpha");
        fs::create_dir_all(&old_skill).unwrap();
        fs::create_dir_all(&new_skill).unwrap();
        fs::write(old_skill.join("SKILL.md"), "# old\n").unwrap();
        fs::write(new_skill.join("SKILL.md"), "# new\n").unwrap();
        host_fs::create_symlink_no_clobber(&anchor_entry, &old_skill).unwrap();

        let error = create_anchor_entry_symlink(&anchor_entry, &new_skill, "alpha").unwrap_err();

        assert!(error.contains("install_target_exists"));
        assert_eq!(
            host_fs::read_link_target(&anchor_entry).as_deref(),
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

        let skills = skills_list_skills(None).unwrap();
        let builtin: Vec<_> = skills
            .iter()
            .filter(|skill| skill.source_id == BUILTIN_SOURCE_ID)
            .collect();

        assert_eq!(builtin.len(), 32);
        assert!(builtin
            .iter()
            .all(|skill| !skill.name.starts_with("design-")));
        assert!(builtin.iter().all(|skill| skill.editable));
    }

    #[test]
    fn stai_public_install_is_migrated_to_builtin_when_available() {
        let _home = test_home();
        let public_root = TempDir::new().unwrap();
        let old_skill = write_skill(public_root.path(), "gaejosik");
        let links = TempDir::new().unwrap();
        let anchor_entry = host_fs::skills_root().unwrap().join("gaejosik");
        let tool_target = links.path().join("gaejosik");
        host_fs::create_symlink_no_clobber(&anchor_entry, &old_skill).unwrap();
        host_fs::create_symlink_no_clobber(&tool_target, &anchor_entry).unwrap();

        let mut registry = SkillsRegistry::default();
        registry.sources.push(SkillSource {
            id: STAI_PUBLIC_SOURCE_ID.to_string(),
            kind: "linked".to_string(),
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
            editable: true,
            dirty: false,
            content_hash: None,
            saved_hash: None,
        });
        registry.installs.push(SkillInstall {
            skill_id: "stai-public::gaejosik".to_string(),
            target: "claude".to_string(),
            installed_as: "gaejosik".to_string(),
            managed_by: "anchor".to_string(),
            entrypoint_path: path_string(&anchor_entry),
            target_path: path_string(&tool_target),
            created_at: None,
        });
        save_registry_unlocked(&registry).unwrap();

        skills_list_sources(None).unwrap();

        let registry = load_registry().unwrap();
        assert!(!has_source(&registry.sources, STAI_PUBLIC_SOURCE_ID));
        assert!(registry
            .removed_source_ids
            .contains(&STAI_PUBLIC_SOURCE_ID.to_string()));
        assert_eq!(registry.installs[0].skill_id, "anchor-builtin::gaejosik");
        assert!(host_fs::read_link_target(&anchor_entry)
            .unwrap()
            .ends_with(Path::new("_builtin/skills/gaejosik")));
    }

    #[test]
    fn stai_public_install_missing_from_builtin_is_copied_to_managed() {
        let _home = test_home();
        let public_root = TempDir::new().unwrap();
        let old_skill = write_skill(public_root.path(), "design-a11y");
        let links = TempDir::new().unwrap();
        let anchor_entry = host_fs::skills_root().unwrap().join("design-a11y");
        let tool_target = links.path().join("design-a11y");
        host_fs::create_symlink_no_clobber(&anchor_entry, &old_skill).unwrap();
        host_fs::create_symlink_no_clobber(&tool_target, &anchor_entry).unwrap();

        let mut registry = SkillsRegistry::default();
        registry.sources.push(SkillSource {
            id: STAI_PUBLIC_SOURCE_ID.to_string(),
            kind: "linked".to_string(),
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
            editable: true,
            dirty: false,
            content_hash: None,
            saved_hash: None,
        });
        registry.installs.push(SkillInstall {
            skill_id: "stai-public::design-a11y".to_string(),
            target: "claude".to_string(),
            installed_as: "design-a11y".to_string(),
            managed_by: "anchor".to_string(),
            entrypoint_path: path_string(&anchor_entry),
            target_path: path_string(&tool_target),
            created_at: None,
        });
        save_registry_unlocked(&registry).unwrap();

        skills_list_sources(None).unwrap();

        let registry = load_registry().unwrap();
        assert_eq!(registry.installs[0].skill_id, "anchor-managed::design-a11y");
        assert!(registry
            .skills
            .iter()
            .any(|skill| skill.id == "anchor-managed::design-a11y"));
        assert!(host_fs::read_link_target(&anchor_entry)
            .unwrap()
            .ends_with(Path::new("_managed/design-a11y")));
    }

    #[test]
    fn builtin_skill_save_persists_and_marks_customized_dirty() {
        let _home = test_home();
        let skills = skills_list_skills(None).unwrap();
        let skill = skills
            .into_iter()
            .find(|skill| skill.id == "anchor-builtin::gaejosik")
            .unwrap();

        let content = fs::read_to_string(Path::new(&skill.abs_path).join("SKILL.md")).unwrap();
        let updated = format!("{content}\ncustomized\n");
        let saved =
            skills_save_skill_file(skill.id, "SKILL.md".to_string(), updated.clone()).unwrap();

        assert!(saved.dirty);
        let doc = skills_read_skill("anchor-builtin::gaejosik".to_string()).unwrap();
        assert_eq!(doc.content, updated);
    }

    #[test]
    fn save_skill_as_creates_clean_managed_copy() {
        let _home = test_home();
        skills_list_skills(None).unwrap();

        let created = skills_save_skill_as(
            "anchor-builtin::gaejosik".to_string(),
            "gaejosik-copy".to_string(),
            "# copied\n".to_string(),
        )
        .unwrap();

        assert_eq!(created.id, "anchor-managed::gaejosik-copy");
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
}
