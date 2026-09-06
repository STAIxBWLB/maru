use crate::atomic_file::{
    with_path_transactions, write_atomic, write_atomic_create, PathTransactionLease,
    PathTransactionRequest,
};
use crate::inbox_settings::{expand_tilde, lexical_normalize_path};
#[cfg(not(test))]
use crate::vault_list::assert_primary_private_workspace;
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};
use walkdir::WalkDir;

const DEFAULT_EDITABLE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const PREVIEW_LIMIT_BYTES: usize = 64 * 1024;
const DEFAULT_TEMP_STALE_DAYS: u64 = 7;
const DEFAULT_IDEATION_REVIEW_DAYS: u64 = 90;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScratchpadCollection {
    Ideation,
    Memos,
    Temp,
    Drafts,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScratchpadFormat {
    Plain,
    Markdown,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScratchpadSource {
    Maru,
    Claude,
    Codex,
    Kiro,
    Kimi,
    Manual,
    Other,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IdeationStage {
    Seed,
    Developing,
    Proposal,
    Archive,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScratchpadEntry {
    pub collection: ScratchpadCollection,
    pub relative_path: String,
    pub name: String,
    pub source: ScratchpadSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ideation_stage: Option<IdeationStage>,
    pub format: ScratchpadFormat,
    pub updated_at: Option<String>,
    pub size_bytes: u64,
    pub preview: String,
    pub revision: String,
    pub stale: bool,
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScratchpadDocument {
    #[serde(flatten)]
    pub entry: ScratchpadEntry,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TempCleanupCandidate {
    pub relative_path: String,
    pub size_bytes: u64,
    pub updated_at: Option<String>,
    pub revision: String,
    pub stale: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TempCleanupSelection {
    pub relative_path: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TempCleanupSkip {
    pub relative_path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TempCleanupResult {
    pub trashed: Vec<String>,
    pub skipped: Vec<TempCleanupSkip>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScratchpadMigrationResult {
    pub migrated: Vec<String>,
    pub skipped: Vec<TempCleanupSkip>,
    pub marker_path: String,
}

#[derive(Debug, Default, Deserialize)]
struct WorkspaceConfig {
    #[serde(default)]
    paths: WorkspacePaths,
    #[serde(default)]
    scratchpad: ScratchpadConfigFile,
}

#[derive(Debug, Default, Deserialize)]
struct WorkspacePaths {
    scratchpad: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ScratchpadConfigFile {
    #[serde(default = "default_ideation_subdir")]
    ideation_subdir: String,
    #[serde(default = "default_memos_subdir")]
    memos_subdir: String,
    #[serde(default = "default_temp_subdir")]
    temp_subdir: String,
    #[serde(default = "default_drafts_subdir")]
    drafts_subdir: String,
    #[serde(default = "default_editable_extensions", alias = "allowed_extensions")]
    editable_extensions: Vec<String>,
    #[serde(default = "default_temp_stale_days", alias = "stale_days")]
    temp_stale_days: u64,
    #[serde(default = "default_ideation_review_days")]
    ideation_review_days: u64,
    #[serde(default = "default_editable_max_bytes")]
    editable_max_bytes: u64,
}

impl Default for ScratchpadConfigFile {
    fn default() -> Self {
        Self {
            ideation_subdir: default_ideation_subdir(),
            memos_subdir: default_memos_subdir(),
            temp_subdir: default_temp_subdir(),
            drafts_subdir: default_drafts_subdir(),
            editable_extensions: default_editable_extensions(),
            temp_stale_days: default_temp_stale_days(),
            ideation_review_days: default_ideation_review_days(),
            editable_max_bytes: default_editable_max_bytes(),
        }
    }
}

fn default_ideation_subdir() -> String {
    "ideation".to_string()
}

fn default_memos_subdir() -> String {
    "memos".to_string()
}

fn default_temp_subdir() -> String {
    "temp".to_string()
}

fn default_drafts_subdir() -> String {
    "drafts".to_string()
}

fn default_editable_extensions() -> Vec<String> {
    vec!["md".to_string(), "markdown".to_string(), "txt".to_string()]
}

fn default_temp_stale_days() -> u64 {
    DEFAULT_TEMP_STALE_DAYS
}

fn default_ideation_review_days() -> u64 {
    DEFAULT_IDEATION_REVIEW_DAYS
}

fn default_editable_max_bytes() -> u64 {
    DEFAULT_EDITABLE_MAX_BYTES
}

fn load_config(work_path: &Path) -> Result<WorkspaceConfig, String> {
    let path = work_path.join("workspace.config.yaml");
    if !path.is_file() {
        return Ok(WorkspaceConfig::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read {}: {err}", path.display()))?;
    serde_yaml::from_str(&raw).map_err(|err| format!("Cannot parse {}: {err}", path.display()))
}

fn absolute_work_path(work_path: &Path) -> Result<PathBuf, String> {
    if !work_path.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    Ok(if work_path.exists() {
        work_path
            .canonicalize()
            .map_err(|err| format!("Cannot resolve workPath: {err}"))?
    } else {
        lexical_normalize_path(work_path)
    })
}

fn normalize_absolute_with_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let normalized = lexical_normalize_path(path);
    if normalized.exists() {
        return normalized
            .canonicalize()
            .map_err(|err| format!("Cannot resolve {}: {err}", normalized.display()));
    }
    let mut ancestor = normalized.as_path();
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        let name = ancestor
            .file_name()
            .ok_or_else(|| format!("Cannot resolve {}", normalized.display()))?;
        suffix.push(name.to_os_string());
        ancestor = ancestor
            .parent()
            .ok_or_else(|| format!("Cannot resolve {}", normalized.display()))?;
    }
    let mut resolved = ancestor
        .canonicalize()
        .map_err(|err| format!("Cannot resolve {}: {err}", ancestor.display()))?;
    for component in suffix.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

/// Resolve the canonical Scratchpad root from the work workspace config.
/// Runtime environment integration uses this helper so every launch path has
/// exactly the same config/fallback semantics as storage commands.
pub(crate) fn resolve_scratchpad_root(work_path: &Path) -> Result<PathBuf, String> {
    let input_work = lexical_normalize_path(work_path);
    let work = absolute_work_path(work_path)?;
    let config = load_config(&work)?;
    let configured = config
        .paths
        .scratchpad
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let root = match configured {
        Some(value) => {
            let expanded = expand_tilde(value);
            if !expanded.is_absolute() {
                return Err("paths.scratchpad must be an absolute path".to_string());
            }
            lexical_normalize_path(&expanded)
        }
        None => work.join("scratchpad"),
    };
    let resolved_for_containment = normalize_absolute_with_existing_ancestor(&root)?;
    if !resolved_for_containment.starts_with(&work) {
        return Err("paths.scratchpad must stay inside workPath".to_string());
    }
    if fs::symlink_metadata(&root)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Scratchpad root contains a symlink: {}",
            root.display()
        ));
    }
    // Reject user-created symlink hops below the work root. System aliases
    // that precede the work root (for example macOS /var -> /private/var) are
    // deliberately outside this check.
    if let Ok(relative) = root.strip_prefix(&input_work) {
        let mut current = input_work;
        for component in relative.components() {
            current.push(component.as_os_str());
            match fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(format!(
                        "Scratchpad root contains a symlink: {}",
                        current.display()
                    ));
                }
                Ok(_) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => break,
                Err(err) => {
                    return Err(format!("Cannot inspect {}: {err}", current.display()));
                }
            }
        }
    }
    Ok(root)
}

pub(crate) fn resolve_scratchpad_temp_root(work_path: &Path) -> Result<PathBuf, String> {
    resolve_collection_root(work_path, ScratchpadCollection::Temp)
}

pub(crate) fn resolve_scratchpad_memos_root(work_path: &Path) -> Result<PathBuf, String> {
    resolve_collection_root(work_path, ScratchpadCollection::Memos)
}

pub(crate) fn resolve_scratchpad_drafts_root(work_path: &Path) -> Result<PathBuf, String> {
    resolve_collection_root(work_path, ScratchpadCollection::Drafts)
}

pub(crate) fn assert_scratchpad_workspace_access(work_path: &Path) -> Result<(), String> {
    #[cfg(test)]
    {
        // Legacy fixtures retain their isolated-workspace setup. Scoped
        // phase08 fixtures opt into the production guard through actual IPC.
        if phase08_08::enforce_workspace_access(work_path) {
            return crate::vault_list::assert_primary_private_workspace(work_path);
        }
        Ok(())
    }
    #[cfg(not(test))]
    {
        assert_primary_private_workspace(work_path)
    }
}

fn safe_config_subdir(raw: &str, key: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("scratchpad.{key} must be a safe relative path"));
    }
    // Rebuild from normal components so spelling aliases such as `foo/bar`
    // and `foo//bar` resolve to one collection root before overlap checks.
    let mut normalized = PathBuf::new();
    for component in path.components() {
        if let Component::Normal(value) = component {
            normalized.push(value);
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(format!("scratchpad.{key} must be a safe relative path"));
    }
    Ok(normalized)
}

fn resolve_collection_root(
    work_path: &Path,
    collection: ScratchpadCollection,
) -> Result<PathBuf, String> {
    let work = absolute_work_path(work_path)?;
    let config = load_config(&work)?;
    let root = resolve_scratchpad_root(&work)?;
    let roots = all_collection_roots(&root, &config.scratchpad)?;
    validate_collection_roots(&root, &roots)?;
    Ok(match collection {
        ScratchpadCollection::Ideation => roots[0].clone(),
        ScratchpadCollection::Memos => roots[1].clone(),
        ScratchpadCollection::Temp => roots[2].clone(),
        ScratchpadCollection::Drafts => roots[3].clone(),
    })
}

fn collection_roots(root: &Path, config: &ScratchpadConfigFile) -> Result<[PathBuf; 3], String> {
    Ok([
        root.join(safe_config_subdir(
            &config.ideation_subdir,
            "ideation_subdir",
        )?),
        root.join(safe_config_subdir(&config.memos_subdir, "memos_subdir")?),
        root.join(safe_config_subdir(&config.temp_subdir, "temp_subdir")?),
    ])
}

fn all_collection_roots(
    root: &Path,
    config: &ScratchpadConfigFile,
) -> Result<[PathBuf; 4], String> {
    let [ideation, memos, temp] = collection_roots(root, config)?;
    let drafts = root.join(safe_config_subdir(&config.drafts_subdir, "drafts_subdir")?);
    Ok([ideation, memos, temp, drafts])
}

fn comparable_collection_path(path: &Path) -> String {
    let value = path_slashes(path);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        value.to_ascii_lowercase()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        value
    }
}

fn validate_collection_roots(root: &Path, roots: &[PathBuf]) -> Result<(), String> {
    for left in 0..roots.len() {
        for right in (left + 1)..roots.len() {
            let left_comparable = comparable_collection_path(&roots[left]);
            let right_comparable = comparable_collection_path(&roots[right]);
            let separator = "/";
            if left_comparable == right_comparable
                || left_comparable.starts_with(&format!("{right_comparable}{separator}"))
                || right_comparable.starts_with(&format!("{left_comparable}{separator}"))
            {
                return Err(format!(
                    "scratchpad_config_invalid: collection roots overlap ({} and {})",
                    roots[left].display(),
                    roots[right].display()
                ));
            }
        }
    }
    for collection_root in roots {
        let relative = collection_root
            .strip_prefix(root)
            .map_err(|_| "scratchpad_config_invalid: collection escaped root".to_string())?;
        assert_no_symlink_components(root, relative)?;
    }
    Ok(())
}

pub(crate) fn validate_scratchpad_layout(work_path: &Path) -> Result<(), String> {
    let work = absolute_work_path(work_path)?;
    let config = load_config(&work)?;
    let root = resolve_scratchpad_root(&work)?;
    validate_collection_roots(&root, &all_collection_roots(&root, &config.scratchpad)?)
}

fn config_for(work_path: &Path) -> Result<(PathBuf, ScratchpadConfigFile), String> {
    let work = absolute_work_path(work_path)?;
    let config = load_config(&work)?;
    let root = resolve_scratchpad_root(&work)?;
    validate_collection_roots(&root, &all_collection_roots(&root, &config.scratchpad)?)?;
    Ok((work, config.scratchpad))
}

fn normalize_relative_path(raw: &str) -> Result<PathBuf, String> {
    if raw.contains('\0') {
        return Err("Scratchpad path contains a NUL byte".to_string());
    }
    let trimmed = raw.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Scratchpad path must be a safe relative path".to_string());
    }
    Ok(path.to_path_buf())
}

pub(crate) fn assert_no_symlink_components(root: &Path, relative: &Path) -> Result<(), String> {
    if root.exists() {
        let metadata = fs::symlink_metadata(root)
            .map_err(|err| format!("Cannot inspect Scratchpad root: {err}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Scratchpad root must not be a symlink".to_string());
        }
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "Scratchpad path contains a symlink: {}",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!("Cannot inspect {}: {err}", current.display()));
            }
        }
    }
    Ok(())
}

/// Re-resolve the publish path through canonicalized directories immediately
/// before committing bytes. A parent component swapped for a symlink after the
/// earlier lexical checks changes the canonical form and is rejected here, so
/// the subsequent rename happens against the verified directory identity.
/// The residual exposure is the OS-level window between this check and the
/// rename itself, which cannot be closed without openat-style directory
/// handles (e.g. cap-std); every publish stays inside one collection root and
/// non-create writes still re-verify the destination revision at this point.
fn pin_commit_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|err| format!("Cannot resolve Scratchpad root: {err}"))?;
    let parent = root
        .join(relative)
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Scratchpad path is missing a parent directory".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|err| format!("Cannot resolve Scratchpad directory: {err}"))?;
    let expected_parent = canonical_root
        .join(relative)
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Scratchpad path is missing a parent directory".to_string())?;
    if comparable_collection_path(&canonical_parent) != comparable_collection_path(&expected_parent)
    {
        return Err(format!(
            "Scratchpad path contains a symlink: {}",
            parent.display()
        ));
    }
    let name = relative
        .file_name()
        .ok_or_else(|| "Scratchpad path is missing a file name".to_string())?;
    Ok(canonical_parent.join(name))
}

fn resolve_entry_path(
    work_path: &Path,
    collection: ScratchpadCollection,
    relative_path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = resolve_collection_root(work_path, collection)?;
    let relative = normalize_relative_path(relative_path)?;
    assert_no_symlink_components(&root, &relative)?;
    Ok((root.join(&relative), relative))
}

fn lower_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
}

fn format_for_path(path: &Path, editable_extensions: &[String]) -> Option<ScratchpadFormat> {
    let extension = lower_extension(path)?;
    if !editable_extensions
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(&extension))
    {
        return None;
    }
    match extension.as_str() {
        "txt" => Some(ScratchpadFormat::Plain),
        "md" | "markdown" => Some(ScratchpadFormat::Markdown),
        _ => None,
    }
}

fn assert_format_matches_path(
    path: &Path,
    format: ScratchpadFormat,
    editable_extensions: &[String],
) -> Result<(), String> {
    let actual = format_for_path(path, editable_extensions)
        .ok_or_else(|| "Unsupported Scratchpad file extension".to_string())?;
    if actual != format {
        return Err("Scratchpad format does not match the file extension".to_string());
    }
    Ok(())
}

fn path_slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn source_for(collection: ScratchpadCollection, relative: &Path) -> ScratchpadSource {
    match collection {
        ScratchpadCollection::Memos => ScratchpadSource::Maru,
        ScratchpadCollection::Ideation | ScratchpadCollection::Drafts => ScratchpadSource::Manual,
        ScratchpadCollection::Temp => {
            let mut parts = relative
                .components()
                .filter_map(|component| match component {
                    Component::Normal(value) => value.to_str().map(str::to_ascii_lowercase),
                    _ => None,
                });
            let first = parts.next().unwrap_or_default();
            let provider = if first == "runtime" {
                parts.next().unwrap_or_default()
            } else {
                first
            };
            match provider.as_str() {
                "claude" => ScratchpadSource::Claude,
                "codex" => ScratchpadSource::Codex,
                "kiro" => ScratchpadSource::Kiro,
                "kimi" => ScratchpadSource::Kimi,
                _ => ScratchpadSource::Other,
            }
        }
    }
}

fn stage_for(relative: &Path) -> Option<IdeationStage> {
    let first = relative.components().next()?.as_os_str().to_str()?;
    match first {
        "seeds" => Some(IdeationStage::Seed),
        "developing" => Some(IdeationStage::Developing),
        "proposals" => Some(IdeationStage::Proposal),
        "_archive" => Some(IdeationStage::Archive),
        _ => None,
    }
}

fn stage_dir(stage: IdeationStage) -> &'static str {
    match stage {
        IdeationStage::Seed => "seeds",
        IdeationStage::Developing => "developing",
        IdeationStage::Proposal => "proposals",
        IdeationStage::Archive => "_archive",
    }
}

fn stage_from_dir(value: &str) -> Option<IdeationStage> {
    match value {
        "seeds" => Some(IdeationStage::Seed),
        "developing" => Some(IdeationStage::Developing),
        "proposals" => Some(IdeationStage::Proposal),
        "_archive" => Some(IdeationStage::Archive),
        _ => None,
    }
}

fn transition_allowed(from: IdeationStage, to: IdeationStage) -> bool {
    matches!(
        (from, to),
        (IdeationStage::Seed, IdeationStage::Developing)
            | (IdeationStage::Seed, IdeationStage::Archive)
            | (IdeationStage::Developing, IdeationStage::Proposal)
            | (IdeationStage::Developing, IdeationStage::Archive)
            | (IdeationStage::Proposal, IdeationStage::Archive)
            | (IdeationStage::Archive, IdeationStage::Seed)
    )
}

fn system_time_rfc3339(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339()
}

fn stale_for(
    collection: ScratchpadCollection,
    modified: Option<SystemTime>,
    config: &ScratchpadConfigFile,
) -> bool {
    let days = match collection {
        ScratchpadCollection::Temp => config.temp_stale_days,
        ScratchpadCollection::Ideation => config.ideation_review_days,
        ScratchpadCollection::Memos | ScratchpadCollection::Drafts => return false,
    };
    modified
        .and_then(|value| SystemTime::now().duration_since(value).ok())
        .map(|age| age > Duration::from_secs(days.saturating_mul(24 * 60 * 60)))
        .unwrap_or(false)
}

fn hash_reader(reader: &mut impl Read) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|err| format!("Cannot read Scratchpad file: {err}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn revision_for_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|err| format!("Cannot open {} for revision: {err}", path.display()))?;
    hash_reader(&mut file)
}

fn preview_for_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|err| format!("Cannot open {} for preview: {err}", path.display()))?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(PREVIEW_LIMIT_BYTES as u64)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("Cannot read {} preview: {err}", path.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .chars()
        .take(160)
        .collect())
}

fn entry_for_path(
    path: &Path,
    relative: &Path,
    collection: ScratchpadCollection,
    config: &ScratchpadConfigFile,
) -> Result<ScratchpadEntry, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("Cannot read {} metadata: {err}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Scratchpad entry is not a regular file".to_string());
    }
    let format = format_for_path(path, &config.editable_extensions)
        .ok_or_else(|| "Unsupported Scratchpad file extension".to_string())?;
    let modified = metadata.modified().ok();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Scratchpad file name is not valid UTF-8".to_string())?
        .to_string();
    Ok(ScratchpadEntry {
        collection,
        relative_path: path_slashes(relative),
        name,
        source: source_for(collection, relative),
        ideation_stage: if collection == ScratchpadCollection::Ideation {
            stage_for(relative)
        } else {
            None
        },
        format,
        updated_at: modified.map(system_time_rfc3339),
        size_bytes: metadata.len(),
        preview: preview_for_file(path)?,
        revision: revision_for_file(path)?,
        stale: stale_for(collection, modified, config),
        editable: metadata.len() <= config.editable_max_bytes,
    })
}

fn assert_revision(path: &Path, expected: &str) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!(
            "scratchpad_conflict: expected revision {expected}, file is missing"
        ));
    }
    let actual = revision_for_file(path)?;
    if actual != expected {
        return Err(format!(
            "scratchpad_conflict: expected revision {expected}, found {actual}"
        ));
    }
    Ok(())
}

pub fn scratchpad_list(work_path: String) -> Result<Vec<ScratchpadEntry>, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        scratchpad_list_in_transaction(lease, work_path)
    })
}

pub(crate) fn scratchpad_list_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
) -> Result<Vec<ScratchpadEntry>, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    // The access guard can migrate legacy registry state, even for reads.
    lease.before_effect()?;

    let work = PathBuf::from(&work_path);
    assert_scratchpad_workspace_access(&work)?;
    let (_, config) = config_for(&work)?;
    let mut entries = Vec::new();
    for collection in [
        ScratchpadCollection::Ideation,
        ScratchpadCollection::Memos,
        ScratchpadCollection::Temp,
        ScratchpadCollection::Drafts,
    ] {
        let root = resolve_collection_root(&work, collection)?;
        if !root.exists() {
            continue;
        }
        assert_no_symlink_components(&root, Path::new("placeholder"))?;
        for item in WalkDir::new(&root).follow_links(false).into_iter() {
            let item = item.map_err(|err| format!("Cannot scan {}: {err}", root.display()))?;
            if item.file_type().is_symlink() || !item.file_type().is_file() {
                continue;
            }
            let path = item.path();
            if format_for_path(path, &config.editable_extensions).is_none() {
                continue;
            }
            let relative = path
                .strip_prefix(&root)
                .map_err(|_| "Scratchpad entry escaped its collection root".to_string())?;
            entries.push(entry_for_path(path, relative, collection, &config)?);
        }
    }
    entries.sort_by(|a, b| {
        collection_rank(a.collection)
            .cmp(&collection_rank(b.collection))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.relative_path.cmp(&b.relative_path))
    });
    Ok(entries)
}

fn collection_rank(collection: ScratchpadCollection) -> u8 {
    match collection {
        ScratchpadCollection::Ideation => 0,
        ScratchpadCollection::Memos => 1,
        ScratchpadCollection::Temp => 2,
        ScratchpadCollection::Drafts => 3,
    }
}

pub fn scratchpad_read(
    work_path: String,
    collection: ScratchpadCollection,
    relative_path: String,
) -> Result<ScratchpadDocument, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    paths.push(resolve_entry_path(&work, collection, &relative_path)?.0);
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        scratchpad_read_in_transaction(lease, work_path, collection, relative_path)
    })
}

pub(crate) fn scratchpad_read_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    collection: ScratchpadCollection,
    relative_path: String,
) -> Result<ScratchpadDocument, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    paths.push(resolve_entry_path(&work, collection, &relative_path)?.0);
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    // The access guard can migrate legacy registry state, even for reads.
    lease.before_effect()?;

    let work = PathBuf::from(&work_path);
    assert_scratchpad_workspace_access(&work)?;
    let (_, config) = config_for(&work)?;
    let (path, relative) = resolve_entry_path(&work, collection, &relative_path)?;
    let entry = entry_for_path(&path, &relative, collection, &config)?;
    if !entry.editable {
        return Err(format!(
            "scratchpad_too_large: file exceeds {} bytes; use the bounded list preview",
            config.editable_max_bytes
        ));
    }
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read Scratchpad file as UTF-8: {err}"))?;
    Ok(ScratchpadDocument { entry, content })
}

#[allow(clippy::too_many_arguments)]
pub fn scratchpad_save(
    work_path: String,
    collection: ScratchpadCollection,
    relative_path: String,
    format: ScratchpadFormat,
    content: String,
    expected_revision: Option<String>,
    force: bool,
) -> Result<ScratchpadDocument, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    paths.push(resolve_entry_path(&work, collection, &relative_path)?.0);
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        scratchpad_save_in_transaction(
            lease,
            work_path,
            collection,
            relative_path,
            format,
            content,
            expected_revision,
            force,
        )
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn scratchpad_save_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    collection: ScratchpadCollection,
    relative_path: String,
    format: ScratchpadFormat,
    content: String,
    expected_revision: Option<String>,
    force: bool,
) -> Result<ScratchpadDocument, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    paths.push(resolve_entry_path(&work, collection, &relative_path)?.0);
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    // The access guard can migrate legacy registry state, even for reads.
    lease.before_effect()?;

    let work = PathBuf::from(&work_path);
    assert_scratchpad_workspace_access(&work)?;
    let (_, config) = config_for(&work)?;
    let root = resolve_collection_root(&work, collection)?;
    let (path, relative) = resolve_entry_path(&work, collection, &relative_path)?;
    assert_format_matches_path(&path, format, &config.editable_extensions)?;
    if content.len() as u64 > config.editable_max_bytes {
        return Err(format!(
            "scratchpad_too_large: content exceeds {} bytes",
            config.editable_max_bytes
        ));
    }
    if path.exists() {
        assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
        let expected = expected_revision.as_deref().ok_or_else(|| {
            "scratchpad_conflict: expectedRevision is required for an existing file, including forced saves"
                .to_string()
        })?;
        // `force` records an explicit UI overwrite choice, but never bypasses
        // revision safety. The caller must first obtain the current revision.
        let _explicit_overwrite = force;
        assert_revision(&path, expected)?;
        assert_no_symlink_components(&root, &relative)?;
        let pinned = pin_commit_path(&root, &relative)?;
        assert_revision(&pinned, expected)?;
        write_atomic(&pinned, content.as_bytes())?;
    } else {
        assert_maru_can_write(&work_path, WorkspaceWriteAction::Create)?;
        if let Some(expected) = expected_revision.as_deref() {
            return Err(format!(
                "scratchpad_conflict: expected revision {expected}, file is missing"
            ));
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Cannot create Scratchpad directory: {err}"))?;
        }
        assert_no_symlink_components(&root, &relative)?;
        let pinned = pin_commit_path(&root, &relative)?;
        write_atomic_create(&pinned, content.as_bytes())?;
    }
    scratchpad_read_in_transaction(lease, work_path, collection, relative_path)
}

pub fn scratchpad_rename(
    work_path: String,
    collection: ScratchpadCollection,
    relative_path: String,
    new_relative_path: String,
    expected_revision: String,
) -> Result<ScratchpadDocument, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    paths.push(resolve_entry_path(&work, collection, &relative_path)?.0);
    paths.push(resolve_entry_path(&work, collection, &new_relative_path)?.0);
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        scratchpad_rename_in_transaction(
            lease,
            work_path,
            collection,
            relative_path,
            new_relative_path,
            expected_revision,
        )
    })
}

pub(crate) fn scratchpad_rename_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    collection: ScratchpadCollection,
    relative_path: String,
    new_relative_path: String,
    expected_revision: String,
) -> Result<ScratchpadDocument, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    paths.push(resolve_entry_path(&work, collection, &relative_path)?.0);
    paths.push(resolve_entry_path(&work, collection, &new_relative_path)?.0);
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    // The access guard can migrate legacy registry state, even for reads.
    lease.before_effect()?;

    assert_scratchpad_workspace_access(Path::new(&work_path))?;
    assert_maru_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
    let work = PathBuf::from(&work_path);
    let (_, config) = config_for(&work)?;
    let root = resolve_collection_root(&work, collection)?;
    let (source, source_relative) = resolve_entry_path(&work, collection, &relative_path)?;
    let (target, target_relative) = resolve_entry_path(&work, collection, &new_relative_path)?;
    let source_format = format_for_path(&source, &config.editable_extensions)
        .ok_or_else(|| "Unsupported Scratchpad source extension".to_string())?;
    let source_size = fs::symlink_metadata(&source)
        .map_err(|err| format!("Cannot inspect Scratchpad source: {err}"))?
        .len();
    if source_size > config.editable_max_bytes {
        return Err(format!(
            "scratchpad_too_large: file exceeds {} bytes and cannot be renamed in the editor",
            config.editable_max_bytes
        ));
    }
    assert_format_matches_path(&target, source_format, &config.editable_extensions)?;
    assert_revision(&source, &expected_revision)?;
    if target.exists() {
        return Err("scratchpad_conflict: rename target already exists".to_string());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create Scratchpad directory: {err}"))?;
    }
    assert_no_symlink_components(&root, &source_relative)?;
    assert_no_symlink_components(&root, &target_relative)?;
    assert_revision(&source, &expected_revision)?;
    let pinned_target = pin_commit_path(&root, &target_relative)?;
    fs::hard_link(&source, &pinned_target).map_err(|err| {
        if err.kind() == std::io::ErrorKind::AlreadyExists {
            "scratchpad_conflict: rename target already exists".to_string()
        } else {
            format!("Cannot publish renamed Scratchpad file: {err}")
        }
    })?;
    // The link pins the published bytes; verify them before the source is
    // removed so a source swapped mid-flight can never publish foreign content.
    if let Err(err) = assert_revision(&pinned_target, &expected_revision) {
        let _ = fs::remove_file(&pinned_target);
        return Err(err);
    }
    // The source path must still be the linked inode: a writer that atomically
    // replaced the source after the link would otherwise have its new file
    // deleted here. On mismatch the concurrent writer wins and the rename
    // aborts as a conflict.
    if !paths_are_same_file(&source, &pinned_target) {
        let _ = fs::remove_file(&pinned_target);
        return Err(
            "scratchpad_conflict: source was replaced while renaming; rename aborted".to_string(),
        );
    }
    if let Err(err) = fs::remove_file(&source) {
        let _ = fs::remove_file(&pinned_target);
        return Err(format!(
            "Cannot remove Scratchpad source after safe rename: {err}"
        ));
    }
    scratchpad_read_in_transaction(lease, work_path, collection, new_relative_path)
}

pub fn scratchpad_trash(
    work_path: String,
    collection: ScratchpadCollection,
    relative_path: String,
    expected_revision: String,
) -> Result<(), String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    paths.push(resolve_entry_path(&work, collection, &relative_path)?.0);
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        scratchpad_trash_in_transaction(
            lease,
            work_path,
            collection,
            relative_path,
            expected_revision,
        )
    })
}

pub(crate) fn scratchpad_trash_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    collection: ScratchpadCollection,
    relative_path: String,
    expected_revision: String,
) -> Result<(), String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    paths.push(resolve_entry_path(&work, collection, &relative_path)?.0);
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    // The access guard can migrate legacy registry state, even for reads.
    lease.before_effect()?;

    assert_scratchpad_workspace_access(Path::new(&work_path))?;
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Delete)?;
    let work = PathBuf::from(&work_path);
    let root = resolve_collection_root(&work, collection)?;
    let (path, relative) = resolve_entry_path(&work, collection, &relative_path)?;
    assert_revision(&path, &expected_revision)?;
    assert_no_symlink_components(&root, &relative)?;
    assert_revision(&path, &expected_revision)?;
    move_to_system_trash(&path)
}

/// Whether two paths currently name the same file. Used after `hard_link` to
/// confirm the source entry still points at the linked inode before deleting
/// it. Windows std exposes no stable file identity, so the check degrades to
/// the pre-existing pathname behavior there.
fn paths_are_same_file(left: &Path, right: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::symlink_metadata(left), fs::symlink_metadata(right)) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (left, right);
        true
    }
}

fn idea_slug(title: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for ch in title.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(ch.to_ascii_lowercase());
            separator = false;
        } else {
            separator = true;
        }
    }
    if slug.is_empty() {
        "untitled".to_string()
    } else {
        slug
    }
}

fn unique_relative_path(root: &Path, candidate: PathBuf) -> PathBuf {
    if !root.join(&candidate).exists() {
        return candidate;
    }
    let parent = candidate.parent().unwrap_or(Path::new(""));
    let stem = candidate
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("idea");
    let extension = candidate
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("md");
    for index in 2_u32.. {
        let next = parent.join(format!("{stem}-{index}.{extension}"));
        if !root.join(&next).exists() {
            return next;
        }
    }
    unreachable!()
}

pub fn scratchpad_create_idea(
    work_path: String,
    title: String,
) -> Result<ScratchpadDocument, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    paths.push(resolve_collection_root(&work, ScratchpadCollection::Ideation)?.join("seeds"));
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        scratchpad_create_idea_in_transaction(lease, work_path, title)
    })
}

pub(crate) fn scratchpad_create_idea_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    title: String,
) -> Result<ScratchpadDocument, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    paths.push(resolve_collection_root(&work, ScratchpadCollection::Ideation)?.join("seeds"));
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    // The access guard can migrate legacy registry state, even for reads.
    lease.before_effect()?;

    assert_scratchpad_workspace_access(Path::new(&work_path))?;
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("Idea title must not be empty".to_string());
    }
    let work = PathBuf::from(&work_path);
    let root = resolve_collection_root(&work, ScratchpadCollection::Ideation)?;
    let dated = format!(
        "{}-idea-{}.md",
        Utc::now().format("%y%m%d"),
        idea_slug(trimmed)
    );
    let relative = unique_relative_path(&root, Path::new("seeds").join(dated));
    let relative_string = path_slashes(&relative);
    let content = format!(
        "# {trimmed}\n\n- **Origin**: manual\n- **Source**: \n- **Date**: {}\n- **Domain**: \n- **Vault**: \n\n## Core Idea\n\n\n## Why It Matters\n\n\n## Next Steps\n- [ ] \n",
        Utc::now().format("%Y-%m-%d")
    );
    scratchpad_save_in_transaction(
        lease,
        work_path,
        ScratchpadCollection::Ideation,
        relative_string,
        ScratchpadFormat::Markdown,
        content,
        None,
        false,
    )
}

#[derive(Debug)]
struct DirectoryMoveFile {
    source: PathBuf,
    target: PathBuf,
    revision: String,
}

fn rollback_published_directory(files: &[PathBuf], directories: &[PathBuf], target_root: &Path) {
    for file in files.iter().rev() {
        let _ = fs::remove_file(file);
    }
    for directory in directories.iter().rev() {
        let _ = fs::remove_dir(directory);
    }
    let _ = fs::remove_dir(target_root);
}

fn move_idea_directory_noreplace(
    root: &Path,
    source_relative: &Path,
    target_relative: &Path,
    selected_source: &Path,
    expected_revision: &str,
) -> Result<(), String> {
    let source_root = root.join(source_relative);
    let target_root = root.join(target_relative);
    assert_no_symlink_components(root, source_relative)?;
    assert_no_symlink_components(root, target_relative)?;
    assert_revision(selected_source, expected_revision)?;
    if !source_root.is_dir() {
        return Err(
            "scratchpad_idea_directory_missing: source slug directory is missing".to_string(),
        );
    }
    if target_root.exists() {
        return Err(
            "scratchpad_conflict: idea transition target directory already exists".to_string(),
        );
    }

    let mut source_directories = Vec::new();
    let mut relative_directories = Vec::new();
    let mut files = Vec::new();
    for item in WalkDir::new(&source_root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
    {
        let entry = item.map_err(|err| format!("Cannot scan idea directory: {err}"))?;
        if entry.file_type().is_symlink() {
            return Err(format!(
                "scratchpad_symlink_denied: idea directory contains {}",
                entry.path().display()
            ));
        }
        let relative = entry
            .path()
            .strip_prefix(&source_root)
            .map_err(|_| "Idea directory entry escaped its source".to_string())?;
        if entry.file_type().is_dir() {
            source_directories.push(entry.path().to_path_buf());
            relative_directories.push(relative.to_path_buf());
        } else if entry.file_type().is_file() {
            files.push(DirectoryMoveFile {
                source: entry.path().to_path_buf(),
                target: target_root.join(relative),
                revision: revision_for_file(entry.path())?,
            });
        } else {
            return Err(format!(
                "scratchpad_file_type_denied: unsupported idea asset {}",
                entry.path().display()
            ));
        }
    }

    if let Some(parent) = target_root.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create idea stage directory: {err}"))?;
    }
    assert_no_symlink_components(root, target_relative)?;
    fs::create_dir(&target_root).map_err(|err| {
        if err.kind() == std::io::ErrorKind::AlreadyExists {
            "scratchpad_conflict: idea transition target directory already exists".to_string()
        } else {
            format!("Cannot reserve idea transition target: {err}")
        }
    })?;

    relative_directories.sort_by_key(|path| path.components().count());
    let mut created_directories = Vec::new();
    let mut created_files = Vec::new();
    let publication = (|| -> Result<(), String> {
        for relative in &relative_directories {
            let target = target_root.join(relative);
            fs::create_dir(&target)
                .map_err(|err| format!("Cannot create idea asset directory: {err}"))?;
            created_directories.push(target);
        }
        for file in &files {
            fs::hard_link(&file.source, &file.target).map_err(|err| {
                if err.kind() == std::io::ErrorKind::AlreadyExists {
                    "scratchpad_conflict: idea asset target already exists".to_string()
                } else {
                    format!("Cannot publish idea asset safely: {err}")
                }
            })?;
            created_files.push(file.target.clone());
        }
        assert_revision(selected_source, expected_revision)?;
        for file in &files {
            assert_revision(&file.source, &file.revision)?;
        }
        Ok(())
    })();
    if let Err(error) = publication {
        rollback_published_directory(&created_files, &created_directories, &target_root);
        return Err(error);
    }

    // Remove exactly the inventory that was safely published. Never use
    // remove_dir_all: a concurrent new source file must survive and make the
    // final directory removal fail instead of being deleted.
    for file in &files {
        fs::remove_file(&file.source).map_err(|err| {
            format!("scratchpad_idea_move_partial: cannot remove source asset: {err}")
        })?;
    }
    source_directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in source_directories {
        fs::remove_dir(&directory).map_err(|err| {
            format!("scratchpad_idea_move_partial: cannot remove source directory: {err}")
        })?;
    }
    fs::remove_dir(&source_root).map_err(|err| {
        format!("scratchpad_idea_move_partial: cannot remove source slug directory: {err}")
    })?;
    Ok(())
}

fn lineage_update_failed(error: String, rollback: Result<(), String>) -> String {
    match rollback {
        Ok(()) => format!(
            "scratchpad_transition_lineage_failed: {error}; filesystem move rolled back"
        ),
        Err(rollback_error) => format!(
            "scratchpad_transition_lineage_failed: {error}; filesystem rollback failed: {rollback_error}"
        ),
    }
}

pub fn scratchpad_transition_idea(
    work_path: String,
    relative_path: String,
    stage: IdeationStage,
    expected_revision: String,
) -> Result<ScratchpadDocument, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    paths.push(work.join(".maru/drafts"));
    paths.push(resolve_entry_path(&work, ScratchpadCollection::Ideation, &relative_path)?.0);
    let relative = normalize_relative_path(&relative_path)?;
    let remainder: PathBuf = relative.components().skip(1).collect();
    paths.push(
        resolve_collection_root(&work, ScratchpadCollection::Ideation)?
            .join(stage_dir(stage))
            .join(remainder),
    );
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        scratchpad_transition_idea_in_transaction(
            lease,
            work_path,
            relative_path,
            stage,
            expected_revision,
        )
    })
}

pub(crate) fn scratchpad_transition_idea_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    relative_path: String,
    stage: IdeationStage,
    expected_revision: String,
) -> Result<ScratchpadDocument, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    paths.push(work.join(".maru/drafts"));
    paths.push(resolve_entry_path(&work, ScratchpadCollection::Ideation, &relative_path)?.0);
    let relative = normalize_relative_path(&relative_path)?;
    let remainder: PathBuf = relative.components().skip(1).collect();
    paths.push(
        resolve_collection_root(&work, ScratchpadCollection::Ideation)?
            .join(stage_dir(stage))
            .join(remainder),
    );
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    // The access guard can migrate legacy registry state, even for reads.
    lease.before_effect()?;

    assert_scratchpad_workspace_access(Path::new(&work_path))?;
    let relative = normalize_relative_path(&relative_path)?;
    let mut components = relative.components();
    let current_stage_component = components
        .next()
        .ok_or_else(|| "Idea path is missing a stage".to_string())?;
    let current_stage_name = current_stage_component
        .as_os_str()
        .to_str()
        .ok_or_else(|| "Idea stage is not valid UTF-8".to_string())?;
    let current_stage = stage_from_dir(current_stage_name)
        .ok_or_else(|| "Idea path is not inside a lifecycle stage".to_string())?;
    if !transition_allowed(current_stage, stage) {
        return Err(format!(
            "scratchpad_transition_invalid: {} -> {} is not allowed",
            stage_dir(current_stage),
            stage_dir(stage)
        ));
    }
    let remainder: PathBuf = components.collect();
    if remainder.as_os_str().is_empty() {
        return Err("Idea path is missing a file name".to_string());
    }
    let target = Path::new(stage_dir(stage)).join(&remainder);
    let old_relative = path_slashes(&relative);
    let new_relative = path_slashes(&target);
    let remainder_path = target
        .strip_prefix(stage_dir(stage))
        .map_err(|_| "Cannot resolve idea transition target".to_string())?;
    if remainder_path.components().count() > 1 {
        assert_maru_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
        let work = PathBuf::from(&work_path);
        let root = resolve_collection_root(&work, ScratchpadCollection::Ideation)?;
        let slug = remainder_path
            .components()
            .next()
            .ok_or_else(|| "Idea path is missing its slug directory".to_string())?;
        let source_slug = Path::new(current_stage_name).join(slug.as_os_str());
        let target_slug = Path::new(stage_dir(stage)).join(slug.as_os_str());
        let (selected_source, _) =
            resolve_entry_path(&work, ScratchpadCollection::Ideation, &relative_path)?;
        let (_, config) = config_for(&work)?;
        let selected_metadata = fs::symlink_metadata(&selected_source)
            .map_err(|err| format!("Cannot inspect selected idea: {err}"))?;
        if !selected_metadata.is_file() || selected_metadata.file_type().is_symlink() {
            return Err(
                "scratchpad_idea_document_invalid: selected idea is not a regular file".to_string(),
            );
        }
        if format_for_path(&selected_source, &config.editable_extensions).is_none() {
            return Err(
                "scratchpad_idea_document_invalid: selected idea must be editable Markdown or text"
                    .to_string(),
            );
        }
        if selected_metadata.len() > config.editable_max_bytes {
            return Err(format!(
                "scratchpad_too_large: selected idea exceeds {} bytes",
                config.editable_max_bytes
            ));
        }
        move_idea_directory_noreplace(
            &root,
            &source_slug,
            &target_slug,
            &selected_source,
            &expected_revision,
        )?;
        if let Err(error) = crate::drafts::update_idea_origin_refs_in_transaction(
            lease,
            &work,
            &old_relative,
            &new_relative,
        ) {
            let moved_source = root.join(&new_relative);
            let rollback = move_idea_directory_noreplace(
                &root,
                &target_slug,
                &source_slug,
                &moved_source,
                &expected_revision,
            );
            return Err(lineage_update_failed(error, rollback));
        }
        return scratchpad_read_in_transaction(
            lease,
            work_path,
            ScratchpadCollection::Ideation,
            new_relative,
        );
    }
    let document = scratchpad_rename_in_transaction(
        lease,
        work_path.clone(),
        ScratchpadCollection::Ideation,
        relative_path.clone(),
        new_relative.clone(),
        expected_revision.clone(),
    )?;
    if let Err(error) = crate::drafts::update_idea_origin_refs_in_transaction(
        lease,
        Path::new(&work_path),
        &old_relative,
        &new_relative,
    ) {
        let rollback = scratchpad_rename_in_transaction(
            lease,
            work_path.clone(),
            ScratchpadCollection::Ideation,
            new_relative.clone(),
            old_relative.clone(),
            expected_revision,
        )
        .map(|_| ());
        return Err(lineage_update_failed(error, rollback));
    }
    Ok(document)
}

pub fn scratchpad_cleanup_plan(work_path: String) -> Result<Vec<TempCleanupCandidate>, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        scratchpad_cleanup_plan_in_transaction(lease, work_path)
    })
}

pub(crate) fn scratchpad_cleanup_plan_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
) -> Result<Vec<TempCleanupCandidate>, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    // The access guard can migrate legacy registry state, even for reads.
    lease.before_effect()?;

    let work = PathBuf::from(&work_path);
    assert_scratchpad_workspace_access(&work)?;
    let (_, config) = config_for(&work)?;
    let root = resolve_collection_root(&work, ScratchpadCollection::Temp)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    assert_no_symlink_components(&root, Path::new("placeholder"))?;
    let mut candidates = Vec::new();
    for item in WalkDir::new(&root).follow_links(false).into_iter() {
        let item = item.map_err(|err| format!("Cannot scan temp files: {err}"))?;
        if item.file_type().is_symlink() || !item.file_type().is_file() {
            continue;
        }
        let path = item.path();
        let metadata = fs::symlink_metadata(path)
            .map_err(|err| format!("Cannot inspect {}: {err}", path.display()))?;
        let modified = metadata.modified().ok();
        if !stale_for(ScratchpadCollection::Temp, modified, &config) {
            continue;
        }
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| "Temp file escaped Scratchpad root".to_string())?;
        candidates.push(TempCleanupCandidate {
            relative_path: path_slashes(relative),
            size_bytes: metadata.len(),
            updated_at: modified.map(system_time_rfc3339),
            revision: revision_for_file(path)?,
            stale: true,
        });
    }
    candidates.sort_by(|a, b| {
        a.updated_at
            .cmp(&b.updated_at)
            .then_with(|| a.relative_path.cmp(&b.relative_path))
    });
    Ok(candidates)
}

pub fn scratchpad_cleanup_apply(
    work_path: String,
    selections: Vec<TempCleanupSelection>,
) -> Result<TempCleanupResult, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    for selection in &selections {
        // Invalid selections retain their per-item skipped result.
        if let Ok((path, _)) =
            resolve_entry_path(&work, ScratchpadCollection::Temp, &selection.relative_path)
        {
            paths.push(path);
        }
    }
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        scratchpad_cleanup_apply_in_transaction(lease, work_path, selections)
    })
}

pub(crate) fn scratchpad_cleanup_apply_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    selections: Vec<TempCleanupSelection>,
) -> Result<TempCleanupResult, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    for selection in &selections {
        // Invalid selections retain their per-item skipped result.
        if let Ok((path, _)) =
            resolve_entry_path(&work, ScratchpadCollection::Temp, &selection.relative_path)
        {
            paths.push(path);
        }
    }
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    // The access guard can migrate legacy registry state, even for reads.
    lease.before_effect()?;

    assert_scratchpad_workspace_access(Path::new(&work_path))?;
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Delete)?;
    let work = PathBuf::from(&work_path);
    let (_, config) = config_for(&work)?;
    let mut result = TempCleanupResult {
        trashed: Vec::new(),
        skipped: Vec::new(),
    };
    for selection in selections {
        let resolved =
            resolve_entry_path(&work, ScratchpadCollection::Temp, &selection.relative_path);
        let (path, relative) = match resolved {
            Ok(value) => value,
            Err(reason) => {
                result.skipped.push(TempCleanupSkip {
                    relative_path: selection.relative_path,
                    reason,
                });
                continue;
            }
        };
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
            Ok(_) => {
                result.skipped.push(TempCleanupSkip {
                    relative_path: selection.relative_path,
                    reason: "Temp selection is not a regular file".to_string(),
                });
                continue;
            }
            Err(err) => {
                result.skipped.push(TempCleanupSkip {
                    relative_path: selection.relative_path,
                    reason: format!("Cannot inspect temp selection: {err}"),
                });
                continue;
            }
        };
        if !stale_for(
            ScratchpadCollection::Temp,
            metadata.modified().ok(),
            &config,
        ) {
            result.skipped.push(TempCleanupSkip {
                relative_path: selection.relative_path,
                reason: "Temp file is no longer stale".to_string(),
            });
            continue;
        }
        if let Err(reason) = assert_revision(&path, &selection.revision) {
            result.skipped.push(TempCleanupSkip {
                relative_path: selection.relative_path,
                reason,
            });
            continue;
        }
        let temp_root = resolve_collection_root(&work, ScratchpadCollection::Temp)?;
        if let Err(reason) = assert_no_symlink_components(&temp_root, &relative)
            .and_then(|_| assert_revision(&path, &selection.revision))
        {
            result.skipped.push(TempCleanupSkip {
                relative_path: selection.relative_path,
                reason,
            });
            continue;
        }
        match move_to_system_trash(&path) {
            Ok(()) => result.trashed.push(selection.relative_path),
            Err(reason) => result.skipped.push(TempCleanupSkip {
                relative_path: selection.relative_path,
                reason,
            }),
        }
    }
    Ok(result)
}

pub fn scratchpad_migrate_legacy_memos(
    work_path: String,
) -> Result<ScratchpadMigrationResult, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    // Unique staging directories and marker publication share .maru.
    paths.extend([
        work.join(".maru"),
        work.join(".maru/memos"),
        resolve_scratchpad_memos_root(&work)?,
    ]);
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        scratchpad_migrate_legacy_memos_in_transaction(lease, work_path)
    })
}

pub(crate) fn scratchpad_migrate_legacy_memos_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
) -> Result<ScratchpadMigrationResult, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_absolute() {
        return Err("workPath must be absolute".to_string());
    }
    let mut paths = vec![
        resolve_scratchpad_root(&work)?,
        work.join("workspace.config.yaml"),
    ];
    // Unique staging directories and marker publication share .maru.
    paths.extend([
        work.join(".maru"),
        work.join(".maru/memos"),
        resolve_scratchpad_memos_root(&work)?,
    ]);
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    // The access guard can migrate legacy registry state, even for reads.
    lease.before_effect()?;

    assert_scratchpad_workspace_access(Path::new(&work_path))?;
    let work = absolute_work_path(Path::new(&work_path))?;
    let legacy_root = work.join(".maru/memos");
    let target_root = resolve_scratchpad_memos_root(&work)?;
    let marker = work.join(".maru/scratchpad-migration-v1.json");
    let mut result = ScratchpadMigrationResult {
        migrated: Vec::new(),
        skipped: Vec::new(),
        marker_path: marker.to_string_lossy().to_string(),
    };
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Create)?;
    if legacy_root.exists() {
        assert_maru_can_write(&work_path, WorkspaceWriteAction::Delete)?;
        fs::create_dir_all(&target_root)
            .map_err(|err| format!("Cannot create memo target: {err}"))?;
        // A fresh unique directory per invocation: a rerun after a failure (or
        // a concurrent invocation) must never rename over the recovery copies
        // a previous run intentionally left behind.
        let staging_parent = work.join(".maru");
        fs::create_dir_all(&staging_parent)
            .map_err(|err| format!("Cannot create migration staging parent: {err}"))?;
        let staging_root = tempfile::Builder::new()
            .prefix("scratchpad-migration-staging-")
            .tempdir_in(&staging_parent)
            .map_err(|err| format!("Cannot create migration staging directory: {err}"))?
            .keep();
        let mut staged_index = 0_u32;
        for item in WalkDir::new(&legacy_root)
            .min_depth(1)
            .follow_links(false)
            .into_iter()
        {
            let item = match item {
                Ok(item) => item,
                Err(err) => {
                    result.skipped.push(TempCleanupSkip {
                        relative_path: "<scan>".to_string(),
                        reason: err.to_string(),
                    });
                    continue;
                }
            };
            if item.file_type().is_symlink() || !item.file_type().is_file() {
                continue;
            }
            let source = item.path();
            if !matches!(
                lower_extension(source).as_deref(),
                Some("md" | "markdown" | "txt")
            ) {
                continue;
            }
            let relative = source
                .strip_prefix(&legacy_root)
                .map_err(|_| "Legacy memo escaped its root".to_string())?;
            let file_name = source
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "memo".to_string());
            let staged = staging_root.join(format!("{staged_index}-{file_name}"));
            staged_index += 1;
            let migration = (|| -> Result<String, String> {
                // Claim the exact source inode first: a same-filesystem rename
                // is atomic, so a concurrent writer that updates or recreates
                // the legacy memo afterward keeps its own file untouched (it
                // is simply picked up by the next migration run).
                fs::rename(source, &staged)
                    .map_err(|err| format!("Cannot claim legacy memo for migration: {err}"))?;
                let staged_hash = revision_for_file(&staged)?;
                let candidate = if target_root.join(relative).is_file()
                    && revision_for_file(&target_root.join(relative))? == staged_hash
                {
                    relative.to_path_buf()
                } else {
                    unique_relative_path(&target_root, relative.to_path_buf())
                };
                let target = target_root.join(&candidate);
                if !target.is_file() {
                    let bytes = fs::read(&staged)
                        .map_err(|err| format!("Cannot read legacy memo: {err}"))?;
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|err| format!("Cannot create migrated memo parent: {err}"))?;
                    }
                    assert_no_symlink_components(&target_root, &candidate)?;
                    write_atomic_create(&target, &bytes)?;
                }
                let target_hash = revision_for_file(&target)?;
                if staged_hash != target_hash {
                    return Err("Migrated memo hash verification failed".to_string());
                }
                fs::remove_file(&staged)
                    .map_err(|err| format!("Cannot remove verified legacy memo: {err}"))?;
                Ok(path_slashes(&candidate))
            })();
            match migration {
                Ok(migrated) => result.migrated.push(migrated),
                Err(reason) => {
                    // Never rename the claimed copy back over the source slot:
                    // a concurrent writer may have recreated it. Keep the
                    // claimed bytes in staging and report where they live.
                    let reason = if staged.is_file() {
                        format!("{reason} (claimed copy kept at {})", staged.display())
                    } else {
                        reason
                    };
                    result.skipped.push(TempCleanupSkip {
                        relative_path: path_slashes(relative),
                        reason,
                    });
                }
            }
        }
        let _ = fs::remove_dir(&staging_root);
    }
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create migration marker parent: {err}"))?;
    }
    let marker_bytes = serde_json::to_vec_pretty(&result)
        .map_err(|err| format!("Cannot serialize migration marker: {err}"))?;
    write_atomic(&marker, &marker_bytes)?;
    Ok(result)
}

pub(crate) fn move_to_system_trash(path: &Path) -> Result<(), String> {
    #[cfg(test)]
    {
        fs::remove_file(path).map_err(|err| format!("Cannot remove test Scratchpad file: {err}"))
    }
    #[cfg(all(not(test), target_os = "macos"))]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut context = trash::TrashContext::new();
        context.set_delete_method(DeleteMethod::NsFileManager);
        context
            .delete(path)
            .map_err(|err| format!("Cannot move Scratchpad file to system Trash: {err}"))
    }
    #[cfg(all(not(test), not(target_os = "macos")))]
    {
        trash::delete(path)
            .map_err(|err| format!("Cannot move Scratchpad file to system Trash: {err}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use tempfile::TempDir;

    fn workspace() -> (TempDir, String, std::sync::MutexGuard<'static, ()>) {
        // The workspace registry lives in the ambient config dir, and the
        // phase08 Home fixtures rewrite it mid-transaction on purpose. Hold
        // the shared home lock so this test's admission window cannot race
        // their legacy-registry writes ("Nested mutation exceeds the admitted
        // path set").
        let guard = crate::skill_host::fs::test_maru_home_lock();
        let temp = TempDir::new().unwrap();
        fs::write(
            temp.path().join("workspace.config.yaml"),
            "paths:\n  scratchpad: SCRATCHPAD\nscratchpad:\n  temp_stale_days: 7\n",
        )
        .unwrap();
        let configured = temp.path().join("scratchpad");
        let raw = fs::read_to_string(temp.path().join("workspace.config.yaml")).unwrap();
        fs::write(
            temp.path().join("workspace.config.yaml"),
            raw.replace("SCRATCHPAD", &configured.to_string_lossy()),
        )
        .unwrap();
        let work = temp.path().to_string_lossy().to_string();
        (temp, work, guard)
    }

    fn set_stale(path: &Path) {
        let stale = SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60);
        let times = fs::FileTimes::new().set_modified(stale);
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(times)
            .unwrap();
    }

    #[test]
    fn root_config_requires_absolute_inside_work() {
        let (temp, work, _home_guard) = workspace();
        assert_eq!(
            resolve_scratchpad_root(Path::new(&work)).unwrap(),
            temp.path().join("scratchpad")
        );
        fs::write(
            temp.path().join("workspace.config.yaml"),
            "paths:\n  scratchpad: ../escape\n",
        )
        .unwrap();
        assert!(resolve_scratchpad_root(Path::new(&work))
            .unwrap_err()
            .contains("absolute"));
    }

    #[test]
    fn configured_drafts_subdir_resolves_the_drafts_collection() {
        let (temp, work, _home_guard) = workspace();
        let scratchpad = temp.path().join("scratchpad");
        fs::write(
            temp.path().join("workspace.config.yaml"),
            format!(
                "paths:\n  scratchpad: {}\nscratchpad:\n  drafts_subdir: generated-drafts\n",
                scratchpad.display()
            ),
        )
        .unwrap();

        assert_eq!(
            resolve_scratchpad_drafts_root(Path::new(&work)).unwrap(),
            scratchpad.join("generated-drafts")
        );
    }

    #[test]
    fn drafts_subdir_must_be_safe_relative() {
        let (temp, work, _home_guard) = workspace();
        let scratchpad = temp.path().join("scratchpad");
        fs::write(
            temp.path().join("workspace.config.yaml"),
            format!(
                "paths:\n  scratchpad: {}\nscratchpad:\n  drafts_subdir: ../outside\n",
                scratchpad.display()
            ),
        )
        .unwrap();

        let error = resolve_scratchpad_drafts_root(Path::new(&work)).unwrap_err();
        assert!(error.contains("scratchpad.drafts_subdir must be a safe relative path"));
    }

    #[test]
    fn drafts_subdir_overlap_with_ideation_is_rejected() {
        let (temp, work, _home_guard) = workspace();
        let scratchpad = temp.path().join("scratchpad");
        fs::write(
            temp.path().join("workspace.config.yaml"),
            format!(
                "paths:\n  scratchpad: {}\nscratchpad:\n  ideation_subdir: ideation\n  drafts_subdir: ideation\n",
                scratchpad.display()
            ),
        )
        .unwrap();

        let error = validate_scratchpad_layout(Path::new(&work)).unwrap_err();
        assert!(error.contains("collection roots overlap"));
    }

    #[test]
    fn drafts_subdir_spelling_aliases_cannot_bypass_overlap_validation() {
        let (temp, work, _home_guard) = workspace();
        let scratchpad = temp.path().join("scratchpad");
        fs::write(
            temp.path().join("workspace.config.yaml"),
            format!(
                "paths:\n  scratchpad: {}\nscratchpad:\n  ideation_subdir: foo/bar\n  drafts_subdir: foo//bar\n",
                scratchpad.display()
            ),
        )
        .unwrap();

        let error = validate_scratchpad_layout(Path::new(&work)).unwrap_err();
        assert!(error.contains("collection roots overlap"));
    }

    #[test]
    fn list_is_recursive_and_classifies_sources_and_stages() {
        let (temp, work, _home_guard) = workspace();
        fs::create_dir_all(temp.path().join("scratchpad/temp/runtime/claude/run")).unwrap();
        fs::create_dir_all(temp.path().join("scratchpad/ideation/seeds")).unwrap();
        fs::write(
            temp.path()
                .join("scratchpad/temp/runtime/claude/run/note.MD"),
            "# Claude\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("scratchpad/ideation/seeds/idea.txt"),
            "idea",
        )
        .unwrap();
        fs::write(temp.path().join("scratchpad/temp/runtime/data.bin"), b"x").unwrap();

        let list = scratchpad_list(work.clone()).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|entry| {
            entry.source == ScratchpadSource::Claude
                && entry.relative_path == "runtime/claude/run/note.MD"
        }));
        assert!(list.iter().any(|entry| {
            entry.ideation_stage == Some(IdeationStage::Seed)
                && entry.collection == ScratchpadCollection::Ideation
        }));
    }

    #[test]
    fn save_is_revision_checked_and_atomic() {
        let (_temp, work, _home_guard) = workspace();
        let created = scratchpad_save(
            work.clone(),
            ScratchpadCollection::Memos,
            "daily.md".to_string(),
            ScratchpadFormat::Markdown,
            "one".to_string(),
            None,
            false,
        )
        .unwrap();
        let error = scratchpad_save(
            work.clone(),
            ScratchpadCollection::Memos,
            "daily.md".to_string(),
            ScratchpadFormat::Markdown,
            "two".to_string(),
            Some("stale".to_string()),
            false,
        )
        .unwrap_err();
        assert!(error.contains("scratchpad_conflict"));
        let saved = scratchpad_save(
            work,
            ScratchpadCollection::Memos,
            "daily.md".to_string(),
            ScratchpadFormat::Markdown,
            "two".to_string(),
            Some(created.entry.revision),
            false,
        )
        .unwrap();
        assert_eq!(saved.content, "two");
    }

    #[test]
    fn forced_save_still_requires_the_current_revision() {
        let (_temp, work, _home_guard) = workspace();
        let created = scratchpad_save(
            work.clone(),
            ScratchpadCollection::Memos,
            "force.md".to_string(),
            ScratchpadFormat::Markdown,
            "one".to_string(),
            None,
            false,
        )
        .unwrap();

        let missing = scratchpad_save(
            work.clone(),
            ScratchpadCollection::Memos,
            "force.md".to_string(),
            ScratchpadFormat::Markdown,
            "unsafe".to_string(),
            None,
            true,
        )
        .unwrap_err();
        assert!(missing.contains("expectedRevision"));
        let stale = scratchpad_save(
            work.clone(),
            ScratchpadCollection::Memos,
            "force.md".to_string(),
            ScratchpadFormat::Markdown,
            "unsafe".to_string(),
            Some("stale".to_string()),
            true,
        )
        .unwrap_err();
        assert!(stale.contains("scratchpad_conflict"));
        let saved = scratchpad_save(
            work,
            ScratchpadCollection::Memos,
            "force.md".to_string(),
            ScratchpadFormat::Markdown,
            "safe".to_string(),
            Some(created.entry.revision),
            true,
        )
        .unwrap();
        assert_eq!(saved.content, "safe");
    }

    #[test]
    fn overlapping_collection_roots_block_cleanup_before_touching_durable_files() {
        let (temp, work, _home_guard) = workspace();
        let root = temp.path().join("scratchpad");
        fs::create_dir_all(root.join("ideation/seeds")).unwrap();
        fs::create_dir_all(root.join("memos")).unwrap();
        let idea = root.join("ideation/seeds/keep.md");
        let memo = root.join("memos/keep.txt");
        fs::write(&idea, "idea").unwrap();
        fs::write(&memo, "memo").unwrap();
        fs::write(
            temp.path().join("workspace.config.yaml"),
            format!(
                "paths:\n  scratchpad: {}\nscratchpad:\n  ideation_subdir: ideation\n  memos_subdir: memos\n  temp_subdir: ideation\n",
                root.display()
            ),
        )
        .unwrap();

        let plan_error = scratchpad_cleanup_plan(work.clone()).unwrap_err();
        assert!(plan_error.contains("collection roots overlap"));
        let apply_error = scratchpad_cleanup_apply(work, Vec::new()).unwrap_err();
        assert!(apply_error.contains("collection roots overlap"));
        assert_eq!(fs::read_to_string(idea).unwrap(), "idea");
        assert_eq!(fs::read_to_string(memo).unwrap(), "memo");
    }

    #[test]
    fn traversal_and_symlinks_are_rejected() {
        let (temp, work, _home_guard) = workspace();
        let error = scratchpad_read(
            work.clone(),
            ScratchpadCollection::Memos,
            "../outside.md".to_string(),
        )
        .unwrap_err();
        assert!(error.contains("safe relative"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let root = temp.path().join("scratchpad/memos");
            fs::create_dir_all(&root).unwrap();
            fs::write(temp.path().join("outside.md"), "secret").unwrap();
            symlink(temp.path().join("outside.md"), root.join("link.md")).unwrap();
            let error = scratchpad_read(work, ScratchpadCollection::Memos, "link.md".to_string())
                .unwrap_err();
            assert!(error.contains("symlink"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn configured_root_symlink_is_rejected_even_when_target_stays_inside_work() {
        use std::os::unix::fs::symlink;
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("actual-scratchpad")).unwrap();
        symlink(
            temp.path().join("actual-scratchpad"),
            temp.path().join("scratchpad"),
        )
        .unwrap();
        let error = resolve_scratchpad_root(temp.path()).unwrap_err();
        assert!(error.contains("symlink"));
    }

    #[test]
    fn idea_creation_and_transition_are_safe() {
        let (_temp, work, _home_guard) = workspace();
        let idea = scratchpad_create_idea(work.clone(), "Agent Governance".to_string()).unwrap();
        assert_eq!(idea.entry.ideation_stage, Some(IdeationStage::Seed));
        assert!(idea
            .entry
            .relative_path
            .contains("idea-agent-governance.md"));
        let moved = scratchpad_transition_idea(
            work,
            idea.entry.relative_path,
            IdeationStage::Developing,
            idea.entry.revision,
        )
        .unwrap();
        assert_eq!(moved.entry.ideation_stage, Some(IdeationStage::Developing));
        assert!(moved.entry.relative_path.starts_with("developing/"));
    }

    #[test]
    fn idea_transition_updates_linked_implementation_lineage() {
        let (temp, work, _home_guard) = workspace();
        let idea = scratchpad_create_idea(work.clone(), "Lineage update".to_string()).unwrap();
        let old_path = idea.entry.relative_path.clone();
        let new_path = old_path.replacen("seeds/", "developing/", 1);
        let index = temp.path().join(".maru/drafts/index.json");
        fs::create_dir_all(index.parent().unwrap()).unwrap();
        fs::write(
            &index,
            serde_json::to_vec_pretty(&[serde_json::json!({
                "id": "draft-lineage",
                "kind": "implementation",
                "title": "Lineage draft",
                "status": "new",
                "source": "manual",
                "originRefs": [old_path.clone(), new_path.clone(), old_path.clone()],
                "bodyPath": "lineage.md",
                "createdAt": "2026-08-08T00:00:00Z",
                "updatedAt": "2026-08-08T00:00:00Z"
            })])
            .unwrap(),
        )
        .unwrap();

        let moved = scratchpad_transition_idea(
            work.clone(),
            idea.entry.relative_path,
            IdeationStage::Developing,
            idea.entry.revision,
        )
        .unwrap();
        assert_eq!(moved.entry.relative_path, new_path);

        let entries = crate::drafts::load_index(Path::new(&work)).unwrap();
        assert_eq!(entries[0].origin_refs, vec![new_path.clone()]);
    }

    #[test]
    fn file_idea_transition_rolls_back_when_lineage_index_read_fails() {
        let (temp, work, _home_guard) = workspace();
        let idea = scratchpad_create_idea(work.clone(), "Read rollback".to_string()).unwrap();
        let old_path = idea.entry.relative_path.clone();
        let new_path = old_path.replacen("seeds/", "developing/", 1);
        let index = temp.path().join(".maru/drafts/index.json");
        fs::create_dir_all(index.parent().unwrap()).unwrap();
        fs::write(
            &index,
            serde_json::to_vec_pretty(&[serde_json::json!({
                "id": "draft-read-rollback",
                "kind": "implementation",
                "title": "Read rollback draft",
                "status": "new",
                "source": "manual",
                "originRefs": [old_path.clone()],
                "bodyPath": "read-rollback.md",
                "createdAt": "2026-08-08T00:00:00Z",
                "updatedAt": "2026-08-08T00:00:00Z"
            })])
            .unwrap(),
        )
        .unwrap();

        crate::drafts::fail_next_index_read();
        let error = scratchpad_transition_idea(
            work.clone(),
            old_path.clone(),
            IdeationStage::Developing,
            idea.entry.revision,
        )
        .unwrap_err();
        assert!(error.contains("filesystem move rolled back"));

        let root = temp.path().join("scratchpad/ideation");
        assert!(root.join(&old_path).is_file());
        assert!(!root.join(&new_path).exists());
        let entries = crate::drafts::load_index(Path::new(&work)).unwrap();
        assert_eq!(entries[0].origin_refs, vec![old_path]);
    }

    #[test]
    fn file_idea_transition_rolls_back_when_lineage_index_write_fails() {
        let (temp, work, _home_guard) = workspace();
        let idea = scratchpad_create_idea(work.clone(), "File rollback".to_string()).unwrap();
        let old_path = idea.entry.relative_path.clone();
        let new_path = old_path.replacen("seeds/", "developing/", 1);
        let index = temp.path().join(".maru/drafts/index.json");
        fs::create_dir_all(index.parent().unwrap()).unwrap();
        fs::write(
            &index,
            serde_json::to_vec_pretty(&[serde_json::json!({
                "id": "draft-file-rollback",
                "kind": "implementation",
                "title": "File rollback draft",
                "status": "new",
                "source": "manual",
                "originRefs": [old_path.clone()],
                "bodyPath": "file-rollback.md",
                "createdAt": "2026-08-08T00:00:00Z",
                "updatedAt": "2026-08-08T00:00:00Z"
            })])
            .unwrap(),
        )
        .unwrap();

        crate::drafts::fail_next_index_write();
        let error = scratchpad_transition_idea(
            work.clone(),
            old_path.clone(),
            IdeationStage::Developing,
            idea.entry.revision,
        )
        .unwrap_err();
        assert!(error.contains("filesystem move rolled back"));

        let root = temp.path().join("scratchpad/ideation");
        assert!(root.join(&old_path).is_file());
        assert!(!root.join(&new_path).exists());
        let entries = crate::drafts::load_index(Path::new(&work)).unwrap();
        assert_eq!(entries[0].origin_refs, vec![old_path]);
    }

    #[test]
    fn directory_idea_transition_rolls_back_when_lineage_index_write_fails() {
        let (temp, work, _home_guard) = workspace();
        let root = temp.path().join("scratchpad/ideation");
        fs::create_dir_all(root.join("seeds/rollback/assets")).unwrap();
        fs::write(root.join("seeds/rollback/main.md"), "main").unwrap();
        fs::write(root.join("seeds/rollback/evidence.md"), "evidence").unwrap();
        fs::write(root.join("seeds/rollback/assets/image.bin"), b"image").unwrap();
        let old_path = "seeds/rollback/main.md".to_string();
        let index = temp.path().join(".maru/drafts/index.json");
        fs::create_dir_all(index.parent().unwrap()).unwrap();
        fs::write(
            &index,
            serde_json::to_vec_pretty(&[serde_json::json!({
                "id": "draft-directory-rollback",
                "kind": "implementation",
                "title": "Directory rollback draft",
                "status": "new",
                "source": "manual",
                "originRefs": [old_path.clone()],
                "bodyPath": "directory-rollback.md",
                "createdAt": "2026-08-08T00:00:00Z",
                "updatedAt": "2026-08-08T00:00:00Z"
            })])
            .unwrap(),
        )
        .unwrap();
        let revision = revision_for_file(&root.join(&old_path)).unwrap();

        crate::drafts::fail_next_index_write();
        let error = scratchpad_transition_idea(
            work.clone(),
            old_path.clone(),
            IdeationStage::Developing,
            revision,
        )
        .unwrap_err();
        assert!(error.contains("filesystem move rolled back"));

        assert!(root.join("seeds/rollback/main.md").is_file());
        assert!(root.join("seeds/rollback/evidence.md").is_file());
        assert!(root.join("seeds/rollback/assets/image.bin").is_file());
        assert!(!root.join("developing/rollback").exists());
        let entries = crate::drafts::load_index(Path::new(&work)).unwrap();
        assert_eq!(entries[0].origin_refs, vec![old_path]);
    }

    #[test]
    fn ideation_transition_matrix_matches_ui() {
        assert!(transition_allowed(
            IdeationStage::Seed,
            IdeationStage::Developing
        ));
        assert!(transition_allowed(
            IdeationStage::Seed,
            IdeationStage::Archive
        ));
        assert!(transition_allowed(
            IdeationStage::Developing,
            IdeationStage::Proposal
        ));
        assert!(transition_allowed(
            IdeationStage::Developing,
            IdeationStage::Archive
        ));
        assert!(transition_allowed(
            IdeationStage::Proposal,
            IdeationStage::Archive
        ));
        assert!(transition_allowed(
            IdeationStage::Archive,
            IdeationStage::Seed
        ));
        assert!(!transition_allowed(
            IdeationStage::Seed,
            IdeationStage::Proposal
        ));
        assert!(!transition_allowed(
            IdeationStage::Developing,
            IdeationStage::Seed
        ));
        assert!(!transition_allowed(
            IdeationStage::Proposal,
            IdeationStage::Developing
        ));
        assert!(!transition_allowed(
            IdeationStage::Archive,
            IdeationStage::Developing
        ));
    }

    #[test]
    fn directory_idea_moves_all_siblings_and_assets_without_overwrite() {
        let (temp, work, _home_guard) = workspace();
        let root = temp.path().join("scratchpad/ideation");
        fs::create_dir_all(root.join("seeds/slug/assets")).unwrap();
        fs::write(root.join("seeds/slug/main.md"), "main").unwrap();
        fs::write(root.join("seeds/slug/evidence.md"), "evidence").unwrap();
        fs::write(root.join("seeds/slug/assets/image.bin"), b"image").unwrap();
        let index = temp.path().join(".maru/drafts/index.json");
        fs::create_dir_all(index.parent().unwrap()).unwrap();
        fs::write(
            &index,
            serde_json::to_vec_pretty(&[serde_json::json!({
                "id": "draft-directory-lineage",
                "kind": "implementation",
                "title": "Directory lineage draft",
                "status": "new",
                "source": "manual",
                "originRefs": ["seeds/slug/main.md"],
                "bodyPath": "directory-lineage.md",
                "createdAt": "2026-08-08T00:00:00Z",
                "updatedAt": "2026-08-08T00:00:00Z"
            })])
            .unwrap(),
        )
        .unwrap();
        let revision = revision_for_file(&root.join("seeds/slug/main.md")).unwrap();

        let image_revision = revision_for_file(&root.join("seeds/slug/assets/image.bin")).unwrap();
        let image_error = scratchpad_transition_idea(
            work.clone(),
            "seeds/slug/assets/image.bin".to_string(),
            IdeationStage::Developing,
            image_revision,
        )
        .unwrap_err();
        assert!(image_error.contains("scratchpad_idea_document_invalid"));
        assert!(root.join("seeds/slug/assets/image.bin").exists());
        assert!(!root.join("developing/slug").exists());

        let invalid = scratchpad_transition_idea(
            work.clone(),
            "seeds/slug/main.md".to_string(),
            IdeationStage::Proposal,
            revision.clone(),
        )
        .unwrap_err();
        assert!(invalid.contains("scratchpad_transition_invalid"));
        fs::create_dir_all(root.join("developing/slug")).unwrap();
        fs::write(root.join("developing/slug/existing.txt"), "keep").unwrap();
        let collision = scratchpad_transition_idea(
            work.clone(),
            "seeds/slug/main.md".to_string(),
            IdeationStage::Developing,
            revision.clone(),
        )
        .unwrap_err();
        assert!(collision.contains("target directory already exists"));
        assert!(root.join("seeds/slug/main.md").exists());
        assert!(root.join("seeds/slug/evidence.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("developing/slug/existing.txt")).unwrap(),
            "keep"
        );

        fs::remove_dir_all(root.join("developing/slug")).unwrap();
        let moved = scratchpad_transition_idea(
            work,
            "seeds/slug/main.md".to_string(),
            IdeationStage::Developing,
            revision,
        )
        .unwrap();
        assert_eq!(moved.entry.relative_path, "developing/slug/main.md");
        assert!(!root.join("seeds/slug").exists());
        assert_eq!(
            fs::read_to_string(root.join("developing/slug/evidence.md")).unwrap(),
            "evidence"
        );
        assert_eq!(
            fs::read(root.join("developing/slug/assets/image.bin")).unwrap(),
            b"image"
        );
        let entries = crate::drafts::load_index(&temp.path().to_path_buf()).unwrap();
        assert_eq!(entries[0].origin_refs, vec!["developing/slug/main.md"]);
    }

    #[test]
    fn rename_never_overwrites_an_existing_target() {
        let (temp, work, _home_guard) = workspace();
        let root = temp.path().join("scratchpad/memos");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("source.md"), "source").unwrap();
        fs::write(root.join("target.md"), "target").unwrap();
        let revision = revision_for_file(&root.join("source.md")).unwrap();

        let error = scratchpad_rename(
            work,
            ScratchpadCollection::Memos,
            "source.md".to_string(),
            "target.md".to_string(),
            revision,
        )
        .unwrap_err();

        assert!(error.contains("target already exists"));
        assert_eq!(
            fs::read_to_string(root.join("source.md")).unwrap(),
            "source"
        );
        assert_eq!(
            fs::read_to_string(root.join("target.md")).unwrap(),
            "target"
        );
    }

    #[test]
    fn legacy_migration_verifies_and_removes_sources() {
        let (temp, work, _home_guard) = workspace();
        let legacy = temp.path().join(".maru/memos");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("memo.txt"), "legacy").unwrap();
        let result = scratchpad_migrate_legacy_memos(work.clone()).unwrap();
        assert_eq!(result.migrated, vec!["memo.txt"]);
        assert!(!legacy.join("memo.txt").exists());
        assert_eq!(
            scratchpad_read(work, ScratchpadCollection::Memos, "memo.txt".to_string())
                .unwrap()
                .content,
            "legacy"
        );
    }

    #[test]
    fn legacy_migration_reuses_identical_verified_target() {
        let (temp, work, _home_guard) = workspace();
        let legacy = temp.path().join(".maru/memos");
        let target = temp.path().join("scratchpad/memos");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(legacy.join("memo.txt"), "same").unwrap();
        fs::write(target.join("memo.txt"), "same").unwrap();

        let result = scratchpad_migrate_legacy_memos(work).unwrap();

        assert_eq!(result.migrated, vec!["memo.txt"]);
        assert!(!legacy.join("memo.txt").exists());
        assert!(!target.join("memo-2.txt").exists());
    }

    #[test]
    fn rerun_migration_never_reuses_a_previous_staging_path() {
        let (temp, work, _home_guard) = workspace();
        let legacy = temp.path().join(".maru/memos");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("memo.txt"), "first run").unwrap();
        scratchpad_migrate_legacy_memos(work.clone()).unwrap();
        // A concurrent writer recreates the legacy memo between runs.
        fs::write(legacy.join("memo.txt"), "second run").unwrap();

        let result = scratchpad_migrate_legacy_memos(work.clone()).unwrap();

        assert_eq!(result.migrated, vec!["memo-2.txt"]);
        assert_eq!(
            scratchpad_read(
                work.clone(),
                ScratchpadCollection::Memos,
                "memo.txt".to_string()
            )
            .unwrap()
            .content,
            "first run"
        );
        assert_eq!(
            scratchpad_read(work, ScratchpadCollection::Memos, "memo-2.txt".to_string())
                .unwrap()
                .content,
            "second run"
        );
    }

    #[test]
    fn cleanup_plan_includes_unsupported_files() {
        let (temp, work, _home_guard) = workspace();
        let root = temp.path().join("scratchpad/temp/codex");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("artifact.bin");
        fs::write(&path, b"binary").unwrap();
        set_stale(&path);
        let plan = scratchpad_cleanup_plan(work).unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].relative_path, "codex/artifact.bin");
    }

    #[test]
    fn cleanup_apply_revision_checks_every_selection() {
        let (temp, work, _home_guard) = workspace();
        let root = temp.path().join("scratchpad/temp/codex");
        fs::create_dir_all(&root).unwrap();
        let trashed = root.join("old.bin");
        let changed = root.join("changed.bin");
        fs::write(&trashed, b"old").unwrap();
        fs::write(&changed, b"before").unwrap();
        set_stale(&trashed);
        set_stale(&changed);
        let plan = scratchpad_cleanup_plan(work.clone()).unwrap();
        fs::write(&changed, b"after").unwrap();
        set_stale(&changed);

        let result = scratchpad_cleanup_apply(
            work,
            plan.into_iter()
                .map(|candidate| TempCleanupSelection {
                    relative_path: candidate.relative_path,
                    revision: candidate.revision,
                })
                .collect(),
        )
        .unwrap();

        assert_eq!(result.trashed, vec!["codex/old.bin"]);
        assert_eq!(result.skipped.len(), 1);
        assert_eq!(result.skipped[0].relative_path, "codex/changed.bin");
        assert!(result.skipped[0].reason.contains("scratchpad_conflict"));
        assert!(!trashed.exists());
        assert!(changed.exists());
    }

    #[test]
    fn edit_limit_marks_large_file_read_only() {
        let (temp, work, _home_guard) = workspace();
        let root = temp.path().join("scratchpad/memos");
        fs::create_dir_all(&root).unwrap();
        let mut file = File::create(root.join("large.md")).unwrap();
        file.write_all(&vec![b'x'; (DEFAULT_EDITABLE_MAX_BYTES + 1) as usize])
            .unwrap();
        let list = scratchpad_list(work.clone()).unwrap();
        assert_eq!(list.len(), 1);
        assert!(!list[0].editable);
        let error =
            scratchpad_read(work, ScratchpadCollection::Memos, "large.md".to_string()).unwrap_err();
        assert!(error.contains("scratchpad_too_large"));
    }
}

/// IPC owns every argument before filesystem work or transaction waits.
pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn scratchpad_list(work_path: String) -> Result<Vec<ScratchpadEntry>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scratchpad_list",
            );
            super::scratchpad_list(work_path)
        })
        .await
        .map_err(|error| format!("scratchpad_list_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn scratchpad_read(
        work_path: String,
        collection: ScratchpadCollection,
        relative_path: String,
    ) -> Result<ScratchpadDocument, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scratchpad_read",
            );
            super::scratchpad_read(work_path, collection, relative_path)
        })
        .await
        .map_err(|error| format!("scratchpad_read_task_failed: {error}"))?
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn scratchpad_save(
        work_path: String,
        collection: ScratchpadCollection,
        relative_path: String,
        format: ScratchpadFormat,
        content: String,
        expected_revision: Option<String>,
        force: bool,
    ) -> Result<ScratchpadDocument, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scratchpad_save",
            );
            super::scratchpad_save(
                work_path,
                collection,
                relative_path,
                format,
                content,
                expected_revision,
                force,
            )
        })
        .await
        .map_err(|error| format!("scratchpad_save_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn scratchpad_rename(
        work_path: String,
        collection: ScratchpadCollection,
        relative_path: String,
        new_relative_path: String,
        expected_revision: String,
    ) -> Result<ScratchpadDocument, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scratchpad_rename",
            );
            super::scratchpad_rename(
                work_path,
                collection,
                relative_path,
                new_relative_path,
                expected_revision,
            )
        })
        .await
        .map_err(|error| format!("scratchpad_rename_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn scratchpad_trash(
        work_path: String,
        collection: ScratchpadCollection,
        relative_path: String,
        expected_revision: String,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scratchpad_trash",
            );
            super::scratchpad_trash(work_path, collection, relative_path, expected_revision)
        })
        .await
        .map_err(|error| format!("scratchpad_trash_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn scratchpad_create_idea(
        work_path: String,
        title: String,
    ) -> Result<ScratchpadDocument, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scratchpad_create_idea",
            );
            super::scratchpad_create_idea(work_path, title)
        })
        .await
        .map_err(|error| format!("scratchpad_create_idea_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn scratchpad_transition_idea(
        work_path: String,
        relative_path: String,
        stage: IdeationStage,
        expected_revision: String,
    ) -> Result<ScratchpadDocument, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scratchpad_transition_idea",
            );
            super::scratchpad_transition_idea(work_path, relative_path, stage, expected_revision)
        })
        .await
        .map_err(|error| format!("scratchpad_transition_idea_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn scratchpad_cleanup_plan(
        work_path: String,
    ) -> Result<Vec<TempCleanupCandidate>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scratchpad_cleanup_plan",
            );
            super::scratchpad_cleanup_plan(work_path)
        })
        .await
        .map_err(|error| format!("scratchpad_cleanup_plan_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn scratchpad_cleanup_apply(
        work_path: String,
        selections: Vec<TempCleanupSelection>,
    ) -> Result<TempCleanupResult, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scratchpad_cleanup_apply",
            );
            super::scratchpad_cleanup_apply(work_path, selections)
        })
        .await
        .map_err(|error| format!("scratchpad_cleanup_apply_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn scratchpad_migrate_legacy_memos(
        work_path: String,
    ) -> Result<ScratchpadMigrationResult, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scratchpad_migrate_legacy_memos",
            );
            super::scratchpad_migrate_legacy_memos(work_path)
        })
        .await
        .map_err(|error| format!("scratchpad_migrate_legacy_memos_task_failed: {error}"))?
    }
}

#[cfg(test)]
pub(crate) mod phase08_08 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::workspace_files::phase08_06::TrashFixture;
    use std::sync::mpsc;

    static ENFORCE_WORKSPACE_ACCESS: std::sync::Mutex<Vec<PathBuf>> =
        std::sync::Mutex::new(Vec::new());

    /// Opts only this disposable fixture into the production registry guard.
    /// Other legacy tests keep their existing isolated-fixture behavior.
    pub(crate) struct PrimaryWorkspaceAccessFixture(PathBuf);
    impl PrimaryWorkspaceAccessFixture {
        pub(crate) fn new(path: PathBuf) -> Self {
            ENFORCE_WORKSPACE_ACCESS.lock().unwrap().push(path.clone());
            Self(path)
        }
    }
    impl Drop for PrimaryWorkspaceAccessFixture {
        fn drop(&mut self) {
            ENFORCE_WORKSPACE_ACCESS
                .lock()
                .unwrap()
                .retain(|path| path != &self.0);
        }
    }
    pub(super) fn enforce_workspace_access(path: &Path) -> bool {
        ENFORCE_WORKSPACE_ACCESS
            .lock()
            .unwrap()
            .iter()
            .any(|value| value == path)
    }

    pub(crate) fn registry(primary: &Path, policy: &str) {
        let path = crate::vault_list::workspace_registry_path().unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        crate::atomic_file::write_atomic(
            &path,
            serde_json::json!({
                "workspaces": [{"label": "Fixture", "path": text(primary), "visibility": "private",
                    "provider": "local", "writePolicy": policy}],
                "activeByVisibility": {"private": text(primary)}
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn fixture(home: &Home) -> tempfile::TempDir {
        let fixture = tempfile::tempdir_in(home.root.path()).unwrap();
        let root = fixture.path();
        for (path, body) in [
            ("scratchpad/memos/note.md", "original"),
            ("scratchpad/ideation/seeds/idea.md", "idea"),
            ("scratchpad/temp/stale.txt", "stale"),
            (".maru/memos/legacy.md", "legacy"),
        ] {
            let path = root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        }
        File::options()
            .write(true)
            .open(root.join("scratchpad/temp/stale.txt"))
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60)),
            )
            .unwrap();
        fixture
    }

    fn start<F>(future: F) -> mpsc::Receiver<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }

    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("bounded scratchpad completion")
    }

    // Real IPC entry points, with the original revision deliberately retained
    // across contention. No installed CLI or native Trash can run in this module.
    async fn mutation(work: String, operation: &'static str) -> Result<(), String> {
        match operation {
            "save" => ipc::scratchpad_save(
                work,
                ScratchpadCollection::Memos,
                "note.md".into(),
                ScratchpadFormat::Markdown,
                "committed".into(),
                Some(crate::document::revision_for("original")),
                false,
            )
            .await
            .map(|_| ()),
            "rename" => ipc::scratchpad_rename(
                work,
                ScratchpadCollection::Memos,
                "note.md".into(),
                "renamed.md".into(),
                crate::document::revision_for("original"),
            )
            .await
            .map(|_| ()),
            "trash" => {
                ipc::scratchpad_trash(
                    work,
                    ScratchpadCollection::Memos,
                    "note.md".into(),
                    crate::document::revision_for("original"),
                )
                .await
            }
            "create" => ipc::scratchpad_create_idea(work, "Concurrent idea".into())
                .await
                .map(|_| ()),
            "transition" => ipc::scratchpad_transition_idea(
                work,
                "seeds/idea.md".into(),
                IdeationStage::Developing,
                crate::document::revision_for("idea"),
            )
            .await
            .map(|_| ()),
            "cleanup" => ipc::scratchpad_cleanup_apply(
                work,
                vec![TempCleanupSelection {
                    relative_path: "stale.txt".into(),
                    revision: crate::document::revision_for("stale"),
                }],
            )
            .await
            .map(|_| ()),
            "migration" => ipc::scratchpad_migrate_legacy_memos(work).await.map(|_| ()),
            _ => unreachable!(),
        }
    }

    #[test]
    fn phase08_08_scratchpad_all_ten_wrappers_yield_on_same_polling_task() {
        let home = Home::new();
        let root = home.root.path();
        let s = text(root);
        boundary(
            root.into(),
            "scratchpad_list",
            ipc::scratchpad_list(s.clone()),
        );
        boundary(
            root.into(),
            "scratchpad_read",
            ipc::scratchpad_read(s.clone(), ScratchpadCollection::Memos, "note.md".into()),
        );
        boundary(
            root.into(),
            "scratchpad_save",
            ipc::scratchpad_save(
                s.clone(),
                ScratchpadCollection::Memos,
                "note.md".into(),
                ScratchpadFormat::Markdown,
                "body".into(),
                None,
                false,
            ),
        );
        boundary(
            root.into(),
            "scratchpad_rename",
            ipc::scratchpad_rename(
                s.clone(),
                ScratchpadCollection::Memos,
                "note.md".into(),
                "renamed.md".into(),
                "revision".into(),
            ),
        );
        boundary(
            root.into(),
            "scratchpad_trash",
            ipc::scratchpad_trash(
                s.clone(),
                ScratchpadCollection::Memos,
                "note.md".into(),
                "revision".into(),
            ),
        );
        boundary(
            root.into(),
            "scratchpad_create_idea",
            ipc::scratchpad_create_idea(s.clone(), "title".into()),
        );
        boundary(
            root.into(),
            "scratchpad_transition_idea",
            ipc::scratchpad_transition_idea(
                s.clone(),
                "seeds/idea.md".into(),
                IdeationStage::Developing,
                "revision".into(),
            ),
        );
        boundary(
            root.into(),
            "scratchpad_cleanup_plan",
            ipc::scratchpad_cleanup_plan(s.clone()),
        );
        boundary(
            root.into(),
            "scratchpad_cleanup_apply",
            ipc::scratchpad_cleanup_apply(s.clone(), vec![]),
        );
        boundary(
            root.into(),
            "scratchpad_migrate_legacy_memos",
            ipc::scratchpad_migrate_legacy_memos(s),
        );
    }

    #[test]
    fn phase08_08_scratchpad_real_payloads_legacy_errors_and_all_mutations() {
        let home = Home::new();
        let fixture = fixture(&home);
        let root = fixture.path();
        let s = text(root);
        assert_eq!(run(ipc::scratchpad_list(s.clone())).unwrap().len(), 3);
        let read = run(ipc::scratchpad_read(
            s.clone(),
            ScratchpadCollection::Memos,
            "note.md".into(),
        ))
        .unwrap();
        assert_eq!(read.content, "original");
        let saved = run(ipc::scratchpad_save(
            s.clone(),
            ScratchpadCollection::Memos,
            "note.md".into(),
            ScratchpadFormat::Markdown,
            "saved".into(),
            Some(read.entry.revision.clone()),
            false,
        ))
        .unwrap();
        assert_eq!(saved.content, "saved");
        let error = run(ipc::scratchpad_save(
            s.clone(),
            ScratchpadCollection::Memos,
            "note.md".into(),
            ScratchpadFormat::Markdown,
            "rejected".into(),
            Some(read.entry.revision),
            true,
        ))
        .unwrap_err();
        assert!(error.starts_with("scratchpad_conflict:"));
        assert_eq!(
            run(ipc::scratchpad_read(
                s.clone(),
                ScratchpadCollection::Memos,
                "../escape.md".into()
            ))
            .unwrap_err(),
            "Scratchpad path must be a safe relative path"
        );
        let renamed = run(ipc::scratchpad_rename(
            s.clone(),
            ScratchpadCollection::Memos,
            "note.md".into(),
            "next.md".into(),
            saved.entry.revision,
        ))
        .unwrap();
        assert_eq!(renamed.content, "saved");
        run(ipc::scratchpad_trash(
            s.clone(),
            ScratchpadCollection::Memos,
            "next.md".into(),
            renamed.entry.revision,
        ))
        .unwrap();
        assert!(!root.join("scratchpad/memos/next.md").exists());
        let idea = run(ipc::scratchpad_create_idea(s.clone(), "Test idea".into())).unwrap();
        let moved = run(ipc::scratchpad_transition_idea(
            s.clone(),
            idea.entry.relative_path,
            IdeationStage::Developing,
            idea.entry.revision,
        ))
        .unwrap();
        assert_eq!(moved.entry.ideation_stage, Some(IdeationStage::Developing));
        let candidates = run(ipc::scratchpad_cleanup_plan(s.clone())).unwrap();
        assert_eq!(candidates.len(), 1);
        let result = run(ipc::scratchpad_cleanup_apply(
            s.clone(),
            candidates
                .into_iter()
                .map(|c| TempCleanupSelection {
                    relative_path: c.relative_path,
                    revision: c.revision,
                })
                .collect(),
        ))
        .unwrap();
        assert_eq!(result.trashed, vec!["stale.txt"]);
        let migrated = run(ipc::scratchpad_migrate_legacy_memos(s)).unwrap();
        assert_eq!(migrated.migrated, vec!["legacy.md"]);
        assert_eq!(
            fs::read_to_string(root.join("scratchpad/memos/legacy.md")).unwrap(),
            "legacy"
        );
        assert!(Path::new(&migrated.marker_path).is_file());
        assert!(!root.join(".maru/memos/legacy.md").exists());
    }

    #[test]
    fn phase08_08_scratchpad_every_mutation_contends_and_releases() {
        let home = Home::new();
        for operation in [
            "save",
            "rename",
            "trash",
            "create",
            "transition",
            "cleanup",
            "migration",
        ] {
            let fixture = fixture(&home);
            let root = fixture.path();
            let key = root.join("scratchpad");
            let held = Held::new(key.clone(), "admitted");
            let first = start(mutation(text(root), operation));
            held.wait();
            let waiting = Held::new(key, "before-admission");
            let second = start(mutation(text(root), operation));
            waiting.wait();
            waiting.release();
            assert!(
                second.recv_timeout(Duration::from_millis(30)).is_err(),
                "{operation} bypassed admission"
            );
            held.release();
            done(first).unwrap();
            let second_result = done(second);
            if matches!(operation, "save" | "rename" | "trash" | "transition") {
                assert!(
                    second_result.is_err(),
                    "{operation} ignored stale source/revision"
                );
            } else {
                second_result.unwrap();
            }
            let entries = run(ipc::scratchpad_list(text(root))).unwrap();
            assert!(!entries.is_empty(), "{operation} failed to release");
            if operation == "save" {
                assert_eq!(
                    fs::read_to_string(root.join("scratchpad/memos/note.md")).unwrap(),
                    "committed"
                );
            }
            if operation == "create" {
                assert_eq!(
                    entries
                        .iter()
                        .filter(|entry| entry.name.contains("concurrent-idea"))
                        .count(),
                    2
                );
            }
        }
    }

    #[test]
    fn phase08_08_scratchpad_reads_serialize_rename_delete_both_orders() {
        let home = Home::new();
        for operation in ["rename", "trash"] {
            for read_first in [false, true] {
                let fixture = fixture(&home);
                let root = fixture.path();
                let held = Held::new(root.join("scratchpad"), "admitted");
                let read =
                    ipc::scratchpad_read(text(root), ScratchpadCollection::Memos, "note.md".into());
                let write = mutation(text(root), operation);
                if read_first {
                    let a = start(read);
                    held.wait();
                    let waiting = Held::new(root.join("scratchpad"), "before-admission");
                    let b = start(write);
                    waiting.wait();
                    waiting.release();
                    assert!(b.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    assert_eq!(done(a).unwrap().content, "original");
                    done(b).unwrap();
                } else {
                    let a = start(write);
                    held.wait();
                    let waiting = Held::new(root.join("scratchpad"), "before-admission");
                    let b = start(read);
                    waiting.wait();
                    waiting.release();
                    assert!(b.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    done(a).unwrap();
                    assert!(done(b).is_err());
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_08_scratchpad_all_mutations_files_parent_pairs_both_orders_aliases() {
        let home = Home::new();
        for operation in [
            "save",
            "rename",
            "trash",
            "create",
            "transition",
            "cleanup",
            "migration",
        ] {
            for parent in ["rename", "trash"] {
                for parent_first in [false, true] {
                    for alias in [false, true] {
                        let fixture = fixture(&home);
                        let root = fixture.path();
                        let key = root.join("scratchpad");
                        let destination = root.join("moved");
                        let _trash = TrashFixture::new(key.clone(), destination.clone());
                        let alias_path = home
                            .root
                            .path()
                            .join(format!("alias-{}", uuid::Uuid::new_v4()));
                        let child_work = if alias {
                            std::os::unix::fs::symlink(root, &alias_path).unwrap();
                            text(&alias_path)
                        } else {
                            text(root)
                        };
                        // Config resolution canonicalizes the workspace alias; its
                        // physical scratchpad path is still the shared parent key.
                        let work = text(root);
                        let parent_future = async move {
                            if parent == "rename" {
                                crate::workspace_files::ipc::rename_workspace_entry(
                                    work,
                                    "scratchpad".into(),
                                    "moved".into(),
                                )
                                .await
                                .map(|r| assert!(r.error.is_none(), "{:?}", r.error))
                            } else {
                                crate::workspace_files::ipc::trash_workspace_entries(
                                    work,
                                    vec!["scratchpad".into()],
                                )
                                .await
                                .map(|r| assert!(r[0].error.is_none(), "{:?}", r[0].error))
                            }
                        };
                        let child = mutation(child_work, operation);
                        let held = Held::new(key.clone(), "admitted");
                        if parent_first {
                            let a = start(parent_future);
                            held.wait();
                            let waiting = Held::new(key, "before-admission");
                            let b = start(child);
                            waiting.wait();
                            waiting.release();
                            assert!(b.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(a).unwrap();
                            assert!(done(b).is_err(), "{operation}/{parent}/{alias}: parent replacement must reject child");
                        } else {
                            let a = start(child);
                            held.wait();
                            let waiting = Held::new(key, "before-admission");
                            let b = start(parent_future);
                            waiting.wait();
                            waiting.release();
                            assert!(b.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(a).unwrap();
                            done(b).unwrap();
                            match operation {
                                "save" => assert_eq!(
                                    fs::read_to_string(destination.join("memos/note.md")).unwrap(),
                                    "committed"
                                ),
                                "rename" => assert_eq!(
                                    fs::read_to_string(destination.join("memos/renamed.md"))
                                        .unwrap(),
                                    "original"
                                ),
                                "trash" => assert!(!destination.join("memos/note.md").exists()),
                                "transition" => assert_eq!(
                                    fs::read_to_string(
                                        destination.join("ideation/developing/idea.md")
                                    )
                                    .unwrap(),
                                    "idea"
                                ),
                                "cleanup" => assert!(!destination.join("temp/stale.txt").exists()),
                                "migration" => assert_eq!(
                                    fs::read_to_string(destination.join("memos/legacy.md"))
                                        .unwrap(),
                                    "legacy"
                                ),
                                _ => assert!(
                                    fs::read_dir(destination.join("ideation/seeds"))
                                        .unwrap()
                                        .count()
                                        >= 2
                                ),
                            }
                        }
                        assert!(!root.join("scratchpad").exists(), "old tree recreated");
                        if alias {
                            fs::remove_file(alias_path).unwrap();
                        }
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_08_scratchpad_document_save_both_orders_aliases_and_error_release() {
        let home = Home::new();
        for scratch_first in [false, true] {
            for alias in [false, true] {
                let fixture = fixture(&home);
                let root = fixture.path();
                let target = root.join("scratchpad/memos/note.md");
                let doc_rel = if alias {
                    std::os::unix::fs::symlink(root.join("scratchpad/memos"), root.join("alias"))
                        .unwrap();
                    "alias/note.md"
                } else {
                    "scratchpad/memos/note.md"
                };
                let scratch = mutation(text(root), "save");
                let work = text(root);
                let doc = async move {
                    crate::document::ipc::save_document(
                        work,
                        doc_rel.into(),
                        "document".into(),
                        Some(crate::document::revision_for("original")),
                    )
                    .await
                    .map(|_| ())
                    .map_err(|e| e.message)
                };
                // Use actual lexical target for each entry's stage hook.
                let doc_key = root.join(doc_rel);
                if scratch_first {
                    let held = Held::new(target.clone(), "admitted");
                    let a = start(scratch);
                    held.wait();
                    let waiting = Held::new(doc_key, "before-admission");
                    let b = start(doc);
                    waiting.wait();
                    waiting.release();
                    assert!(b.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    done(a).unwrap();
                    assert!(done(b).is_err());
                    assert_eq!(fs::read_to_string(&target).unwrap(), "committed");
                } else {
                    let held = Held::new(doc_key, "admitted");
                    let a = start(doc);
                    held.wait();
                    let waiting = Held::new(target.clone(), "before-admission");
                    let b = start(scratch);
                    waiting.wait();
                    waiting.release();
                    assert!(b.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    done(a).unwrap();
                    assert!(done(b).is_err());
                    assert_eq!(fs::read_to_string(&target).unwrap(), "document");
                }
                assert_eq!(
                    run(ipc::scratchpad_read(
                        text(root),
                        ScratchpadCollection::Memos,
                        "note.md".into()
                    ))
                    .unwrap()
                    .content,
                    fs::read_to_string(target).unwrap()
                );
            }
        }
    }
    #[test]
    fn phase08_08_scratchpad_actual_permission_denial_and_post_admission_recheck() {
        let home = Home::new();
        let fixture = fixture(&home);
        let root = fixture.path();
        let _guard = PrimaryWorkspaceAccessFixture::new(root.into());
        let before = fs::read(root.join("scratchpad/memos/note.md")).unwrap();
        registry(home.root.path(), "direct");
        assert!(run(ipc::scratchpad_list(text(root)))
            .unwrap_err()
            .starts_with("scratchpad_workspace_denied:"));
        for operation in [
            "save",
            "rename",
            "trash",
            "create",
            "transition",
            "cleanup",
            "migration",
        ] {
            assert!(run(mutation(text(root), operation))
                .unwrap_err()
                .starts_with("scratchpad_workspace_denied:"));
        }
        registry(root, "readOnly");
        assert!(!run(ipc::scratchpad_list(text(root))).unwrap().is_empty());
        for operation in [
            "save",
            "rename",
            "trash",
            "create",
            "transition",
            "cleanup",
            "migration",
        ] {
            assert!(run(mutation(text(root), operation))
                .unwrap_err()
                .contains("Workspace writes are blocked"));
        }
        for operation in [
            "save",
            "rename",
            "trash",
            "create",
            "transition",
            "cleanup",
            "migration",
        ] {
            for foreign in [false, true] {
                registry(root, "direct");
                let held = Held::new(root.join("scratchpad"), "admitted");
                let command = start(mutation(text(root), operation));
                held.wait();
                if foreign {
                    registry(home.root.path(), "direct");
                } else {
                    registry(root, "readOnly");
                }
                held.release();
                let error = done(command).unwrap_err();
                assert!(error.contains(if foreign {
                    "scratchpad_workspace_denied:"
                } else {
                    "Workspace writes are blocked"
                }));
                assert_eq!(
                    fs::read(root.join("scratchpad/memos/note.md")).unwrap(),
                    before
                );
            }
        }
        registry(root, "direct");
        run(mutation(text(root), "save")).unwrap();
    }
    #[test]
    fn phase08_08_scratchpad_nested_parent_missing_or_replaced_is_not_recreated() {
        let home = Home::new();
        for replace in [false, true] {
            let fixture = fixture(&home);
            let root = fixture.path();
            let selected = root.join("scratchpad/memos/note.md");
            let held = Held::new(selected, "before-admission");
            let pending = start(mutation(text(root), "save"));
            held.wait();
            let moved = run(crate::workspace_files::ipc::rename_workspace_entry(
                text(root),
                "scratchpad/memos".into(),
                "moved".into(),
            ))
            .unwrap();
            assert!(moved.error.is_none());
            if replace {
                fs::create_dir(root.join("scratchpad/memos")).unwrap();
            }
            held.release();
            let error = done(pending).unwrap_err();
            assert!(error.contains("Transaction parent"), "{error}");
            assert_eq!(
                fs::read_to_string(root.join("scratchpad/moved/note.md")).unwrap(),
                "original"
            );
            assert!(!root.join("scratchpad/memos/note.md").exists());
            assert_eq!(root.join("scratchpad/memos").exists(), replace);
            assert!(!run(ipc::scratchpad_list(text(root))).unwrap().is_empty());
        }
    }

    #[test]
    fn phase08_08_scratchpad_read_registry_migration_and_changed_condition_release() {
        let home = Home::new();
        let fixture = fixture(&home);
        let root = fixture.path();
        let _guard = PrimaryWorkspaceAccessFixture::new(root.into());
        let output = crate::vault_list::workspace_registry_path().unwrap();
        let legacy = crate::vault_list::legacy_vault_list_path().unwrap();
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let data = serde_json::json!({
            "vaults": [{"label": "Fixture", "path": text(root)}],
            "activeVault": text(root)
        })
        .to_string();
        let held = Held::new(root.join("scratchpad"), "before-admission");
        let pending = start(ipc::scratchpad_list(text(root)));
        held.wait();
        fs::write(&legacy, &data).unwrap();
        held.release();
        assert!(done(pending)
            .unwrap_err()
            .contains("Workspace registry migration changed"));
        assert!(!output.exists());
        assert!(!run(ipc::scratchpad_list(text(root))).unwrap().is_empty());
        assert!(output.is_file());
        assert_eq!(fs::read_to_string(legacy).unwrap(), data);
    }
}
