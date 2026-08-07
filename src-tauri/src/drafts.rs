// Drafts unify AI-generated task drafts and ideation into a first-class,
// unconfirmed concept. Bodies live in the `drafts` scratchpad collection
// (<workspace>/scratchpad/drafts/*.md); metadata lives in a JSON index at
// <work>/.maru/drafts/index.json. Vault scanning already excludes the
// scratchpad root, so drafts never leak into confirmed vault data.
//
// Isolation invariant: nothing in this module writes outside
// <workspace>/scratchpad/drafts/, <work>/.maru/drafts/, and the explicit,
// approval-gated promote target.

use crate::atomic_file::{write_atomic, write_atomic_create};
use crate::approval::{require_approval, ApprovalState};
use crate::scratchpad::{
    assert_no_symlink_components, assert_scratchpad_workspace_access, move_to_system_trash,
    resolve_scratchpad_drafts_root, ScratchpadSource,
};
use crate::tasks::{CreateTaskDraft, TaskBucket};
use crate::vault::{is_document_extension, resolve_inside_vault, slugify};
use crate::vault_list::{assert_document_owner, assert_maru_can_write, WorkspaceWriteAction};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const DRAFT_MAX_BYTES: u64 = 2 * 1024 * 1024;
const DRAFTS_PROMOTE_KIND: &str = "drafts.promote";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DraftKind {
    Task,
    Idea,
    Implementation,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DraftStatus {
    New,
    InReview,
    Accepted,
    Discarded,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DraftImportance {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DraftPromoteTarget {
    Document,
    Task,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DraftEntry {
    pub id: String,
    pub kind: DraftKind,
    pub title: String,
    pub status: DraftStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub importance: Option<DraftImportance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    pub source: ScratchpadSource,
    #[serde(default)]
    pub origin_refs: Vec<String>,
    pub body_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promoted_to: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DraftDocument {
    #[serde(flatten)]
    pub entry: DraftEntry,
    pub content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftsChangedEvent {
    pub work_path: String,
    pub draft_id: Option<String>,
}

fn emit_drafts_changed(app: &AppHandle, work_path: &str, draft_id: Option<String>) {
    let _ = app.emit(
        "drafts://changed",
        DraftsChangedEvent {
            work_path: work_path.to_string(),
            draft_id,
        },
    );
}

fn index_path(work: &Path) -> PathBuf {
    work.join(".maru").join("drafts").join("index.json")
}

/// Load the draft index. A missing or corrupt index starts empty so a bad
/// file can never wedge the drafts workflow. Entries are salvaged one by one:
/// `save_index` rewrites the whole array, so a single unreadable record must
/// lose only itself instead of every other draft's metadata.
pub(crate) fn load_index(work: &Path) -> Result<Vec<DraftEntry>, String> {
    let path = index_path(work);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read {}: {err}", path.display()))?;
    let rows: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(rows
        .into_iter()
        .filter_map(|row| serde_json::from_value(row).ok())
        .collect())
}

fn save_index(work: &Path, entries: &[DraftEntry]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(entries)
        .map_err(|err| format!("Cannot serialize drafts index: {err}"))?;
    write_atomic(&index_path(work), &bytes)
}

/// Draft ids are server-generated (`draft-<uuid>`). Validate before using one
/// in a filesystem path (promote baselines live at .maru/drafts/<id>/).
pub(crate) fn validate_draft_id(id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty()
        || trimmed.len() > 128
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err("drafts_invalid_id".to_string());
    }
    Ok(())
}

/// Body paths are server-generated file names inside the drafts collection
/// root. Re-validate on every use so a hand-edited index cannot redirect a
/// read or write outside the collection.
fn normalize_body_path(raw: &str) -> Result<PathBuf, String> {
    if raw.contains('\0') {
        return Err("Draft body path contains a NUL byte".to_string());
    }
    let trimmed = raw.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Draft body path must be a safe relative path".to_string());
    }
    Ok(path.to_path_buf())
}

fn body_file_path(work: &Path, entry: &DraftEntry) -> Result<PathBuf, String> {
    let root = resolve_scratchpad_drafts_root(work)?;
    let relative = normalize_body_path(&entry.body_path)?;
    assert_no_symlink_components(&root, &relative)?;
    Ok(root.join(relative))
}

fn read_body(work: &Path, entry: &DraftEntry) -> Result<String, String> {
    let path = body_file_path(work, entry)?;
    fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read draft body {}: {err}", path.display()))
}

fn find_entry(entries: &[DraftEntry], id: &str) -> Option<usize> {
    entries.iter().position(|entry| entry.id == id)
}

fn path_slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[allow(clippy::too_many_arguments)]
fn create_impl(
    work_path: &str,
    kind: DraftKind,
    title: &str,
    source: ScratchpadSource,
    origin_refs: Vec<String>,
    importance: Option<DraftImportance>,
    confidence: Option<f32>,
    body: &str,
) -> Result<DraftEntry, String> {
    assert_scratchpad_workspace_access(Path::new(work_path))?;
    assert_maru_can_write(work_path, WorkspaceWriteAction::Create)?;
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("Draft title must not be empty".to_string());
    }
    if let Some(confidence) = confidence {
        if !(0.0..=1.0).contains(&confidence) {
            return Err("Draft confidence must be between 0.0 and 1.0".to_string());
        }
    }
    if body.len() as u64 > DRAFT_MAX_BYTES {
        return Err(format!(
            "drafts_too_large: content exceeds {DRAFT_MAX_BYTES} bytes"
        ));
    }
    let work = crate::vault::normalize_existing_dir(work_path)?;
    let root = resolve_scratchpad_drafts_root(&work)?;
    fs::create_dir_all(&root).map_err(|err| format!("Cannot create drafts directory: {err}"))?;

    // The body file name is derived only from the slugified title plus a
    // random suffix; caller-controlled strings never become path components.
    let id = format!("draft-{}", Uuid::new_v4());
    let slug = slugify(trimmed);
    let suffix = Uuid::new_v4().simple().to_string();
    let file_name = format!(
        "{}-{}-{}.md",
        Utc::now().format("%y%m%d"),
        slug,
        &suffix[..8]
    );
    let body_path = root.join(&file_name);
    write_atomic_create(&body_path, body.as_bytes())?;

    let now = Utc::now().to_rfc3339();
    let entry = DraftEntry {
        id,
        kind,
        title: trimmed.to_string(),
        status: DraftStatus::New,
        importance,
        confidence,
        source,
        origin_refs,
        body_path: file_name,
        promoted_to: None,
        created_at: now.clone(),
        updated_at: now,
    };
    let mut entries = load_index(&work)?;
    entries.push(entry.clone());
    save_index(&work, &entries)?;
    Ok(entry)
}

/// Frontmatter keys an adopted body may carry. Only these map onto `DraftEntry`;
/// every other key stays in the file untouched, which is where richer provenance
/// (run id, channel, message ids) lives for a human to read.
///
/// `runtime`, not `source`: `DraftEntry.source` is the AI runtime enum, and a
/// drop that wants to record an inbox channel would otherwise collide with it.
fn adopted_title(meta: &BTreeMap<String, serde_yaml::Value>, body: &str, file_stem: &str) -> String {
    if let Some(title) = meta.get("title").and_then(|v| v.as_str()) {
        let trimmed = title.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    for line in body.lines() {
        if let Some(heading) = line.trim().strip_prefix("# ") {
            let trimmed = heading.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    file_stem.to_string()
}

fn adopted_kind(meta: &BTreeMap<String, serde_yaml::Value>) -> DraftKind {
    match meta.get("kind").and_then(|v| v.as_str()).map(str::trim) {
        Some("task") => DraftKind::Task,
        Some("implementation") => DraftKind::Implementation,
        // A hand-dropped note is more likely to become a document than a task,
        // and `idea` is the kind whose promote dialog defaults that way.
        _ => DraftKind::Idea,
    }
}

fn adopted_status(meta: &BTreeMap<String, serde_yaml::Value>) -> DraftStatus {
    match meta.get("status").and_then(|v| v.as_str()).map(str::trim) {
        Some("in-review") => DraftStatus::InReview,
        Some("accepted") => DraftStatus::Accepted,
        Some("discarded") => DraftStatus::Discarded,
        // "draft" is what a writer naturally reaches for; it means the same as
        // the model's `new`.
        _ => DraftStatus::New,
    }
}

fn adopted_origin_refs(meta: &BTreeMap<String, serde_yaml::Value>) -> Vec<String> {
    meta.get("origin_refs")
        .or_else(|| meta.get("originRefs"))
        .and_then(|v| v.as_sequence())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn adopt_entry_for(file_name: &str, content: &str, modified: String) -> DraftEntry {
    let parts = crate::vault::parse_frontmatter(content);
    let meta = &parts.meta;
    let stem = file_name.strip_suffix(".md").unwrap_or(file_name);
    let importance = match meta.get("importance").and_then(|v| v.as_str()).map(str::trim) {
        Some("high") => Some(DraftImportance::High),
        Some("medium") => Some(DraftImportance::Medium),
        Some("low") => Some(DraftImportance::Low),
        _ => None,
    };
    let confidence = meta
        .get("confidence")
        .and_then(|v| v.as_f64())
        .map(|value| value.clamp(0.0, 1.0) as f32);
    let source = match meta.get("runtime").and_then(|v| v.as_str()).map(str::trim) {
        Some("claude") => ScratchpadSource::Claude,
        Some("codex") => ScratchpadSource::Codex,
        Some("kimi") => ScratchpadSource::Kimi,
        Some("kiro") => ScratchpadSource::Kiro,
        Some("maru") => ScratchpadSource::Maru,
        _ => ScratchpadSource::Manual,
    };
    DraftEntry {
        id: format!("draft-{}", Uuid::new_v4()),
        kind: adopted_kind(meta),
        title: adopted_title(meta, &parts.body, stem),
        status: adopted_status(meta),
        importance,
        confidence,
        source,
        origin_refs: adopted_origin_refs(meta),
        body_path: file_name.to_string(),
        // Only Maru fills promoted_to, at promote time. Trusting a dropped file
        // to claim it was already promoted would let it point the gap baseline
        // at an arbitrary path.
        promoted_to: None,
        created_at: modified.clone(),
        updated_at: modified,
    }
}

/// Adopt body files that exist on disk but no index entry points at.
///
/// The headless pipeline writes drafts into `scratchpad/drafts/` directly, and
/// `drafts_list` reads only the index, so without this those files are invisible
/// to the app. Everything degrades rather than fails: an unreadable or oversized
/// file is skipped, missing frontmatter falls back to the body's own heading, and
/// a malformed drop can never wedge the list.
///
/// Returns true when the index gained entries and needs saving.
fn adopt_orphan_bodies(work: &Path, entries: &mut Vec<DraftEntry>) -> Result<bool, String> {
    let Ok(root) = resolve_scratchpad_drafts_root(work) else {
        return Ok(false);
    };
    if !root.is_dir() {
        return Ok(false);
    }
    let known: std::collections::HashSet<String> =
        entries.iter().map(|entry| entry.body_path.clone()).collect();
    let mut orphans: Vec<String> = Vec::new();
    let read_dir = match fs::read_dir(&root) {
        Ok(read_dir) => read_dir,
        Err(_) => return Ok(false),
    };
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_ascii_lowercase().ends_with(".md") || known.contains(&name) {
            continue;
        }
        // Same guard the indexed read path applies: a symlink planted here must
        // not be adopted and then copied into a confirmed document by promote.
        if assert_no_symlink_components(&root, Path::new(&name)).is_err() {
            continue;
        }
        if !entry.path().is_file() {
            continue;
        }
        orphans.push(name);
    }
    // Deterministic adoption order, so two machines adopting the same directory
    // produce the same index ordering.
    orphans.sort();
    let mut adopted = false;
    for name in orphans {
        let path = root.join(&name);
        let too_large = fs::metadata(&path)
            .map(|meta| meta.len() > DRAFT_MAX_BYTES)
            .unwrap_or(true);
        if too_large {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let modified = fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .map(|time| chrono::DateTime::<Utc>::from(time).to_rfc3339())
            .unwrap_or_else(|_| Utc::now().to_rfc3339());
        entries.push(adopt_entry_for(&name, &content, modified));
        adopted = true;
    }
    Ok(adopted)
}

fn read_impl(work_path: &str, id: &str) -> Result<DraftDocument, String> {
    assert_scratchpad_workspace_access(Path::new(work_path))?;
    validate_draft_id(id)?;
    let work = crate::vault::normalize_existing_dir(work_path)?;
    let entries = load_index(&work)?;
    let index = find_entry(&entries, id).ok_or_else(|| "drafts_not_found".to_string())?;
    let entry = entries[index].clone();
    let content = read_body(&work, &entry)?;
    Ok(DraftDocument { entry, content })
}

fn save_impl(
    work_path: &str,
    id: &str,
    body: &str,
    expected_updated_at: &str,
) -> Result<DraftDocument, String> {
    assert_scratchpad_workspace_access(Path::new(work_path))?;
    assert_maru_can_write(work_path, WorkspaceWriteAction::Modify)?;
    validate_draft_id(id)?;
    if body.len() as u64 > DRAFT_MAX_BYTES {
        return Err(format!(
            "drafts_too_large: content exceeds {DRAFT_MAX_BYTES} bytes"
        ));
    }
    let work = crate::vault::normalize_existing_dir(work_path)?;
    let mut entries = load_index(&work)?;
    let index = find_entry(&entries, id).ok_or_else(|| "drafts_not_found".to_string())?;
    let entry = entries[index].clone();
    if entry.updated_at != expected_updated_at {
        return Err(format!(
            "drafts_conflict: expected updatedAt {expected_updated_at}, found {}",
            entry.updated_at
        ));
    }
    let path = body_file_path(&work, &entry)?;
    write_atomic(&path, body.as_bytes())?;
    entries[index].updated_at = Utc::now().to_rfc3339();
    save_index(&work, &entries)?;
    Ok(DraftDocument {
        entry: entries[index].clone(),
        content: body.to_string(),
    })
}

fn set_status_impl(work_path: &str, id: &str, status: DraftStatus) -> Result<DraftEntry, String> {
    assert_scratchpad_workspace_access(Path::new(work_path))?;
    assert_maru_can_write(work_path, WorkspaceWriteAction::Modify)?;
    validate_draft_id(id)?;
    let work = crate::vault::normalize_existing_dir(work_path)?;
    let mut entries = load_index(&work)?;
    let index = find_entry(&entries, id).ok_or_else(|| "drafts_not_found".to_string())?;
    entries[index].status = status;
    entries[index].updated_at = Utc::now().to_rfc3339();
    save_index(&work, &entries)?;
    Ok(entries[index].clone())
}

fn discard_impl(work_path: &str, id: &str) -> Result<DraftEntry, String> {
    assert_scratchpad_workspace_access(Path::new(work_path))?;
    assert_maru_can_write(work_path, WorkspaceWriteAction::Delete)?;
    validate_draft_id(id)?;
    let work = crate::vault::normalize_existing_dir(work_path)?;
    let mut entries = load_index(&work)?;
    let index = find_entry(&entries, id).ok_or_else(|| "drafts_not_found".to_string())?;
    let entry = entries[index].clone();
    let path = body_file_path(&work, &entry)?;
    if path.exists() {
        move_to_system_trash(&path)?;
    }
    entries[index].status = DraftStatus::Discarded;
    entries[index].updated_at = Utc::now().to_rfc3339();
    save_index(&work, &entries)?;
    Ok(entries[index].clone())
}

/// Resolve and validate the promote target for a vault document. The target
/// must be a relative markdown path inside the workspace, outside the
/// scratchpad and .maru managed areas, and must not already exist.
fn resolve_document_target(work_path: &str, target_path: &str) -> Result<(PathBuf, String), String> {
    let trimmed = target_path.trim();
    if trimmed.is_empty() {
        return Err("drafts_promote_target_required".to_string());
    }
    let raw = Path::new(trimmed);
    if raw.is_absolute() {
        return Err("drafts_promote_target_must_be_relative".to_string());
    }
    let relative = crate::vault::lexical_normalize(raw);
    let first = relative.components().next().and_then(|component| match component {
        Component::Normal(value) => value.to_str().map(str::to_string),
        _ => None,
    });
    match first.as_deref() {
        Some("scratchpad") | Some(".maru") => {
            return Err("drafts_promote_target_managed: target must be a vault document".to_string())
        }
        None => return Err("drafts_promote_target_required".to_string()),
        _ => {}
    }
    let extension = relative
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !is_document_extension(extension) || matches!(extension.to_ascii_lowercase().as_str(), "html" | "htm") {
        return Err("drafts_promote_target_must_be_markdown".to_string());
    }
    let dest = resolve_inside_vault(work_path, &path_slashes(&relative))?;
    assert_document_owner(work_path, &dest)?;
    if dest.exists() {
        return Err("drafts_promote_target_exists".to_string());
    }
    Ok((dest, path_slashes(&relative)))
}

fn promote_impl(
    work_path: &str,
    id: &str,
    target: DraftPromoteTarget,
    target_path: &str,
) -> Result<DraftEntry, String> {
    assert_scratchpad_workspace_access(Path::new(work_path))?;
    validate_draft_id(id)?;
    let work = crate::vault::normalize_existing_dir(work_path)?;
    let mut entries = load_index(&work)?;
    let index = find_entry(&entries, id).ok_or_else(|| "drafts_not_found".to_string())?;
    let entry = entries[index].clone();
    if entry.status == DraftStatus::Discarded {
        return Err("drafts_promote_discarded".to_string());
    }
    if entry.status == DraftStatus::Accepted {
        return Err("drafts_promote_already_accepted".to_string());
    }
    let body = read_body(&work, &entry)?;

    // The baseline must be the bytes that actually landed at the promote
    // target, not the draft body: the Task path routes through
    // `create_task_note`, which injects frontmatter, and freezing `body` there
    // makes every task promote report a phantom insert on first analysis.
    let (promoted_to, baseline_bytes) = match target {
        DraftPromoteTarget::Document => {
            assert_maru_can_write(work_path, WorkspaceWriteAction::Create)?;
            let (dest, relative) = resolve_document_target(work_path, target_path)?;
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("Cannot create promote target directory: {err}"))?;
            }
            write_atomic_create(&dest, body.as_bytes())?;
            (relative, body.as_bytes().to_vec())
        }
        DraftPromoteTarget::Task => {
            let slug = if target_path.trim().is_empty() {
                entry.title.as_str()
            } else {
                target_path.trim()
            };
            let row = crate::tasks::create_task_note(
                work_path.to_string(),
                CreateTaskDraft {
                    slug: slug.to_string(),
                    title: entry.title.clone(),
                    frontmatter: BTreeMap::new(),
                    body: body.clone(),
                    bucket: TaskBucket::Active,
                },
                None,
            )?;
            let created = work.join(&row.rel_path);
            let bytes = fs::read(&created).map_err(|err| {
                format!(
                    "Cannot read promoted task note {}: {err}",
                    created.display()
                )
            })?;
            (row.rel_path, bytes)
        }
    };

    // Frozen baseline for later gap analysis between the promoted artifact and
    // the human edits made to it afterwards.
    let baseline = work
        .join(".maru")
        .join("drafts")
        .join(&entry.id)
        .join("baseline.md");
    write_atomic(&baseline, &baseline_bytes)?;

    entries[index].status = DraftStatus::Accepted;
    entries[index].promoted_to = Some(promoted_to);
    entries[index].updated_at = Utc::now().to_rfc3339();
    save_index(&work, &entries)?;
    Ok(entries[index].clone())
}

#[tauri::command(async)]
pub fn drafts_list(work_path: String) -> Result<Vec<DraftEntry>, String> {
    assert_scratchpad_workspace_access(Path::new(&work_path))?;
    let work = crate::vault::normalize_existing_dir(&work_path)?;
    let mut entries = load_index(&work)?;
    // Pick up anything the headless pipeline dropped since the last listing.
    // Skipped on a read-only workspace: adoption persists to the index, and a
    // listing must not fail just because it cannot write.
    if assert_maru_can_write(&work_path, WorkspaceWriteAction::Create).is_ok()
        && adopt_orphan_bodies(&work, &mut entries)?
    {
        save_index(&work, &entries)?;
    }
    Ok(entries)
}

#[tauri::command(async)]
pub fn drafts_read(work_path: String, id: String) -> Result<DraftDocument, String> {
    read_impl(&work_path, &id)
}

#[tauri::command(async)]
pub fn drafts_save(
    app: AppHandle,
    work_path: String,
    id: String,
    body: String,
    expected_updated_at: String,
) -> Result<DraftDocument, String> {
    let document = save_impl(&work_path, &id, &body, &expected_updated_at)?;
    emit_drafts_changed(&app, &work_path, Some(id));
    Ok(document)
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn drafts_create(
    app: AppHandle,
    work_path: String,
    kind: DraftKind,
    title: String,
    source: ScratchpadSource,
    origin_refs: Option<Vec<String>>,
    importance: Option<DraftImportance>,
    confidence: Option<f32>,
    body: String,
) -> Result<DraftEntry, String> {
    let entry = create_impl(
        &work_path,
        kind,
        &title,
        source,
        origin_refs.unwrap_or_default(),
        importance,
        confidence,
        &body,
    )?;
    emit_drafts_changed(&app, &work_path, Some(entry.id.clone()));
    Ok(entry)
}

#[tauri::command(async)]
pub fn drafts_set_status(
    app: AppHandle,
    work_path: String,
    id: String,
    status: DraftStatus,
) -> Result<DraftEntry, String> {
    let entry = set_status_impl(&work_path, &id, status)?;
    emit_drafts_changed(&app, &work_path, Some(id));
    Ok(entry)
}

#[tauri::command(async)]
pub fn drafts_discard(
    app: AppHandle,
    work_path: String,
    id: String,
) -> Result<DraftEntry, String> {
    let entry = discard_impl(&work_path, &id)?;
    emit_drafts_changed(&app, &work_path, Some(id));
    Ok(entry)
}

#[tauri::command(async)]
pub fn drafts_promote(
    approvals: tauri::State<'_, ApprovalState>,
    app: AppHandle,
    work_path: String,
    id: String,
    target: DraftPromoteTarget,
    target_path: Option<String>,
    approval_id: Option<String>,
) -> Result<DraftEntry, String> {
    require_approval(&approvals, approval_id, DRAFTS_PROMOTE_KIND)?;
    let entry = promote_impl(&work_path, &id, target, target_path.as_deref().unwrap_or(""))?;
    emit_drafts_changed(&app, &work_path, Some(id));
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn workspace() -> (TempDir, String) {
        let temp = TempDir::new().unwrap();
        let work = temp.path().to_string_lossy().to_string();
        (temp, work)
    }

    fn drafts_root(work: &str) -> PathBuf {
        let root = resolve_scratchpad_drafts_root(Path::new(work)).unwrap();
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn drop_orphan(work: &str, name: &str, content: &str) -> PathBuf {
        let path = drafts_root(work).join(name);
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn adopts_a_dropped_body_with_its_frontmatter() {
        let (_temp, work) = workspace();
        drop_orphan(
            &work,
            "260801-reply-koica-budget.md",
            "---\ntitle: KOICA 예산 회신 초안\nkind: task\nstatus: draft\nimportance: high\nconfidence: 0.9\nruntime: claude\norigin_refs:\n  - inbox/items/pending/260801-gws-x/summary.md\n---\n# body\n",
        );
        let entries = drafts_list(work.clone()).unwrap();
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.title, "KOICA 예산 회신 초안");
        assert_eq!(entry.kind, DraftKind::Task);
        // "draft" is the word a writer reaches for; it maps onto the model's New.
        assert_eq!(entry.status, DraftStatus::New);
        assert_eq!(entry.importance, Some(DraftImportance::High));
        assert_eq!(entry.source, ScratchpadSource::Claude);
        assert_eq!(
            entry.origin_refs,
            vec!["inbox/items/pending/260801-gws-x/summary.md".to_string()]
        );
        assert_eq!(entry.body_path, "260801-reply-koica-budget.md");
        // The body must be readable through the normal path once adopted.
        let doc = read_impl(&work, &entry.id).unwrap();
        assert!(doc.content.contains("# body"));
    }

    #[test]
    fn adopts_a_body_with_no_frontmatter_using_its_heading() {
        let (_temp, work) = workspace();
        drop_orphan(&work, "loose-note.md", "# 손으로 쓴 초안\n\n본문\n");
        let entries = drafts_list(work).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "손으로 쓴 초안");
        assert_eq!(entries[0].kind, DraftKind::Idea);
        assert_eq!(entries[0].status, DraftStatus::New);
        assert_eq!(entries[0].source, ScratchpadSource::Manual);
        assert!(entries[0].importance.is_none());
    }

    #[test]
    fn falls_back_to_the_file_name_when_there_is_no_title_or_heading() {
        let (_temp, work) = workspace();
        drop_orphan(&work, "260801-plain.md", "just prose, no heading\n");
        let entries = drafts_list(work).unwrap();
        assert_eq!(entries[0].title, "260801-plain");
    }

    #[test]
    fn adopting_twice_creates_one_entry() {
        let (_temp, work) = workspace();
        drop_orphan(&work, "once.md", "# once\n");
        let first = drafts_list(work.clone()).unwrap();
        let second = drafts_list(work.clone()).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        // Same identity across listings, so the pane's selection survives.
        assert_eq!(first[0].id, second[0].id);
    }

    #[test]
    fn adoption_leaves_indexed_drafts_alone() {
        let (_temp, work) = workspace();
        let created = create_task_draft(&work, "이미 있는 초안");
        drop_orphan(&work, "dropped.md", "# 떨어진 초안\n");
        let entries = drafts_list(work).unwrap();
        assert_eq!(entries.len(), 2);
        // The pre-existing entry keeps its id and is not re-adopted as a copy.
        assert_eq!(
            entries.iter().filter(|e| e.id == created.id).count(),
            1
        );
        assert!(entries.iter().any(|e| e.title == "떨어진 초안"));
    }

    #[test]
    fn a_dropped_file_cannot_claim_it_was_already_promoted() {
        let (_temp, work) = workspace();
        drop_orphan(
            &work,
            "sneaky.md",
            "---\ntitle: sneaky\npromoted_to: ../../../etc/passwd\n---\nbody\n",
        );
        let entries = drafts_list(work).unwrap();
        assert_eq!(entries[0].promoted_to, None);
    }

    #[test]
    fn non_markdown_files_are_ignored() {
        let (_temp, work) = workspace();
        drop_orphan(&work, "notes.txt", "not a draft");
        drop_orphan(&work, "image.png", "binary-ish");
        assert!(drafts_list(work).unwrap().is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn a_symlinked_body_is_not_adopted() {
        let (_temp, work) = workspace();
        let outside = Path::new(&work).join("outside.md");
        fs::write(&outside, "# outside\n").unwrap();
        let link = drafts_root(&work).join("linked.md");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(drafts_list(work).unwrap().is_empty());
    }

    fn create_task_draft(work: &str, title: &str) -> DraftEntry {
        create_impl(
            work,
            DraftKind::Task,
            title,
            ScratchpadSource::Kimi,
            vec!["inbox/telegram/260730-note.md".to_string()],
            Some(DraftImportance::High),
            Some(0.8),
            "# Draft body\n\nDetails here.\n",
        )
        .unwrap()
    }

    #[test]
    fn create_list_read_save_round_trip() {
        let (_temp, work) = workspace();
        let entry = create_task_draft(&work, "Weekly report automation");
        assert_eq!(entry.status, DraftStatus::New);
        assert!(entry.body_path.ends_with(".md"));

        let listed = load_index(Path::new(&work)).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, entry.id);

        let document = read_impl(&work, &entry.id).unwrap();
        assert_eq!(document.content, "# Draft body\n\nDetails here.\n");
        assert_eq!(document.entry.title, "Weekly report automation");

        let saved = save_impl(&work, &entry.id, "updated body", &entry.updated_at).unwrap();
        assert_eq!(saved.content, "updated body");
        assert_ne!(saved.entry.updated_at, entry.updated_at);
        let reread = read_impl(&work, &entry.id).unwrap();
        assert_eq!(reread.content, "updated body");
    }

    #[test]
    fn save_rejects_stale_expected_updated_at() {
        let (_temp, work) = workspace();
        let entry = create_task_draft(&work, "Conflict check");
        let error = save_impl(&work, &entry.id, "x", "1999-01-01T00:00:00Z").unwrap_err();
        assert!(error.starts_with("drafts_conflict:"));
    }

    #[test]
    fn status_transitions_persist() {
        let (_temp, work) = workspace();
        let entry = create_task_draft(&work, "Status flow");
        let reviewed = set_status_impl(&work, &entry.id, DraftStatus::InReview).unwrap();
        assert_eq!(reviewed.status, DraftStatus::InReview);
        let listed = load_index(Path::new(&work)).unwrap();
        assert_eq!(listed[0].status, DraftStatus::InReview);
    }

    #[test]
    fn discard_trashes_body_and_marks_entry() {
        let (temp, work) = workspace();
        let entry = create_task_draft(&work, "Discard me");
        let body = temp.path().join("scratchpad/drafts").join(&entry.body_path);
        assert!(body.is_file());
        let discarded = discard_impl(&work, &entry.id).unwrap();
        assert_eq!(discarded.status, DraftStatus::Discarded);
        assert!(!body.exists());
        let listed = load_index(Path::new(&work)).unwrap();
        assert_eq!(listed[0].status, DraftStatus::Discarded);
    }

    #[test]
    fn promote_document_writes_target_and_baseline() {
        let (temp, work) = workspace();
        let entry = create_task_draft(&work, "Promote to doc");
        let promoted = promote_impl(&work, &entry.id, DraftPromoteTarget::Document, "notes/promoted.md").unwrap();
        assert_eq!(promoted.status, DraftStatus::Accepted);
        assert_eq!(promoted.promoted_to.as_deref(), Some("notes/promoted.md"));
        let target = temp.path().join("notes/promoted.md");
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "# Draft body\n\nDetails here.\n"
        );
        let baseline = temp
            .path()
            .join(".maru/drafts")
            .join(&entry.id)
            .join("baseline.md");
        assert_eq!(
            fs::read_to_string(&baseline).unwrap(),
            "# Draft body\n\nDetails here.\n"
        );
        // Re-promoting an accepted draft is rejected.
        assert!(promote_impl(&work, &entry.id, DraftPromoteTarget::Document, "notes/other.md").is_err());
        // Existing targets are never overwritten.
        let other = create_task_draft(&work, "Second draft");
        let error = promote_impl(&work, &other.id, DraftPromoteTarget::Document, "notes/promoted.md").unwrap_err();
        assert_eq!(error, "drafts_promote_target_exists");
    }

    #[test]
    fn promote_document_rejects_managed_and_traversal_targets() {
        let (_temp, work) = workspace();
        for bad in [
            "scratchpad/drafts/x.md",
            ".maru/x.md",
            "../escape.md",
            "/abs/path.md",
            "notes/page.html",
        ] {
            let entry = create_task_draft(&work, "Guard check");
            assert!(
                promote_impl(&work, &entry.id, DraftPromoteTarget::Document, bad).is_err(),
                "target {bad} must be rejected"
            );
        }
    }

    #[test]
    fn promote_task_creates_task_note() {
        let (temp, work) = workspace();
        let entry = create_task_draft(&work, "Promote to task");
        let promoted = promote_impl(&work, &entry.id, DraftPromoteTarget::Task, "").unwrap();
        assert_eq!(promoted.status, DraftStatus::Accepted);
        let rel = promoted.promoted_to.clone().unwrap();
        assert!(rel.starts_with("tasks/active/"), "unexpected rel path {rel}");
        let target = temp.path().join(&rel);
        let content = fs::read_to_string(&target).unwrap();
        assert!(content.contains("# Draft body"));
        let baseline = temp
            .path()
            .join(".maru/drafts")
            .join(&entry.id)
            .join("baseline.md");
        assert!(baseline.is_file());
    }

    #[test]
    fn promote_task_freezes_the_created_note_not_the_draft_body() {
        let (temp, work) = workspace();
        // A digit in the title lands in the injected frontmatter, which is what
        // used to trip the external-info heuristic on a zero-edit promote.
        let entry = create_task_draft(&work, "Ship 3 reports");
        let promoted = promote_impl(&work, &entry.id, DraftPromoteTarget::Task, "").unwrap();
        let rel = promoted.promoted_to.clone().unwrap();
        let baseline = temp
            .path()
            .join(".maru/drafts")
            .join(&entry.id)
            .join("baseline.md");
        assert_eq!(
            fs::read(&baseline).unwrap(),
            fs::read(temp.path().join(&rel)).unwrap(),
            "baseline must be the promoted artifact, byte for byte"
        );

        // With zero human edits the gap report must be empty.
        let report = crate::gap::gap_analyze(work.clone(), entry.id.clone()).unwrap();
        assert_eq!(report.summary.total_hunks, 0);
        assert_eq!(report.summary.added_lines, 0);
        assert!(report.hunks.is_empty());
    }

    #[test]
    fn one_corrupt_index_entry_does_not_erase_the_others() {
        let (temp, work) = workspace();
        let entry = create_task_draft(&work, "Keep me");
        let index = temp.path().join(".maru/drafts/index.json");
        let mut rows: Vec<serde_json::Value> =
            serde_json::from_str(&fs::read_to_string(&index).unwrap()).unwrap();
        rows.push(serde_json::json!({ "id": 42 }));
        fs::write(&index, serde_json::to_string_pretty(&rows).unwrap()).unwrap();

        let added = create_task_draft(&work, "New draft");
        let listed = load_index(Path::new(&work)).unwrap();
        let ids: Vec<&str> = listed.iter().map(|row| row.id.as_str()).collect();
        assert!(
            ids.contains(&entry.id.as_str()),
            "pre-existing entry lost, got {ids:?}"
        );
        assert!(ids.contains(&added.id.as_str()));
        assert_eq!(listed.len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_draft_body_is_rejected() {
        use std::os::unix::fs::symlink;
        let (temp, work) = workspace();
        let entry = create_task_draft(&work, "Symlink bait");
        let body = temp.path().join("scratchpad/drafts").join(&entry.body_path);
        fs::remove_file(&body).unwrap();
        fs::write(temp.path().join("outside.md"), "secret").unwrap();
        symlink(temp.path().join("outside.md"), &body).unwrap();
        let error = read_impl(&work, &entry.id).unwrap_err();
        assert!(error.contains("symlink"), "unexpected error {error}");
        // Promote must not copy an out-of-tree read into a confirmed document.
        assert!(
            promote_impl(&work, &entry.id, DraftPromoteTarget::Document, "notes/x.md").is_err()
        );
    }

    #[test]
    fn create_never_writes_outside_drafts_collection() {
        let (temp, work) = workspace();
        let entry = create_impl(
            &work,
            DraftKind::Idea,
            "../../../../etc/evil",
            ScratchpadSource::Claude,
            vec!["../../secret.md".to_string(), "C:\\abs\\path".to_string()],
            None,
            None,
            "body",
        )
        .unwrap();
        let body = temp.path().join("scratchpad/drafts").join(&entry.body_path);
        assert!(body.is_file(), "body must live under scratchpad/drafts");
        assert!(!Path::new(&entry.body_path).is_absolute());
        assert!(!entry.body_path.contains(".."));
        // Origin refs are stored as opaque data, never used as paths.
        assert_eq!(entry.origin_refs.len(), 2);
        // Nothing escaped into the workspace root or above it.
        assert!(!temp.path().join("etc").exists());
        assert_eq!(
            load_index(Path::new(&work)).unwrap()[0].body_path,
            entry.body_path
        );
    }

    #[test]
    fn corrupt_or_missing_index_starts_empty() {
        let (temp, _work) = workspace();
        assert!(load_index(temp.path()).unwrap().is_empty());
        let index = temp.path().join(".maru/drafts/index.json");
        fs::create_dir_all(index.parent().unwrap()).unwrap();
        fs::write(&index, "{not json").unwrap();
        assert!(load_index(temp.path()).unwrap().is_empty());
    }

    #[test]
    fn promote_requires_approval() {
        let state = ApprovalState::default();
        let error = require_approval(&state, None, DRAFTS_PROMOTE_KIND).unwrap_err();
        assert!(error.starts_with("approval_required"));
    }

    #[test]
    fn draft_id_validation_rejects_path_segments() {
        assert!(validate_draft_id("draft-abc-123").is_ok());
        assert!(validate_draft_id("../x").is_err());
        assert!(validate_draft_id("a/b").is_err());
        assert!(validate_draft_id("").is_err());
    }
}
