use crate::atomic_file::write_atomic;
use crate::kordoc_lite::{self, DocumentFormat, KordocLiteCheck};
use crate::vault::normalize_existing_dir;
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use walkdir::WalkDir;

const BINDER_SCHEMA_VERSION: u32 = 2;
const MAX_CANDIDATES: usize = 200;
const MAX_TARGETS_PER_CATEGORY: usize = 50;
const MAX_TARGET_LENGTH: usize = 200;
const MAX_NOTE_LENGTH: usize = 2_000;
static BINDER_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceBinding {
    pub binding_id: String,
    #[serde(default)]
    pub candidate_id: Option<String>,
    #[serde(default)]
    pub evidence_sha256: Option<String>,
    pub rel_path: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub section_bindings: Vec<String>,
    #[serde(default)]
    pub kpi_bindings: Vec<String>,
    #[serde(default)]
    pub submission_checklist_bindings: Vec<String>,
    pub local_verification_status: LocalVerificationStatus,
    #[serde(default)]
    pub verified_at: Option<String>,
    pub include_in_submission: bool,
    #[serde(default)]
    pub submission_selected_at: Option<String>,
    pub linked_at: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalVerificationStatus {
    #[default]
    Unverified,
    Verified,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceBinderState {
    pub schema_version: u32,
    pub doc_id: String,
    #[serde(default)]
    pub document_path: Option<String>,
    #[serde(default)]
    pub bindings: Vec<EvidenceBinding>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceBinderCandidate {
    pub id: String,
    pub source: String,
    pub path: String,
    pub rel_path: String,
    pub title: String,
    pub evidence_kind: Option<String>,
    pub business_unit: Option<String>,
    pub size_bytes: u64,
    pub updated_at: Option<String>,
    pub detected_format: DocumentFormat,
    pub validation_checks: Vec<KordocLiteCheck>,
    pub hwp_field_count: u32,
    pub hwp_field_labels: Vec<String>,
    pub sidecar_path: Option<String>,
    pub sidecar_status: SidecarStatus,
    pub sidecar_sha256: Option<String>,
    pub companion_for: Option<String>,
    pub inbox_item_id: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SidecarStatus {
    #[default]
    None,
    Unverified,
    Verified,
    Rejected,
    Retired,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceBinderResponse {
    pub state: EvidenceBinderState,
    pub candidates: Vec<EvidenceBinderCandidate>,
    pub revision: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceBinderReadRequest {
    pub work_path: String,
    pub doc_id: String,
    #[serde(default)]
    pub document_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceBinderMutateRequest {
    pub work_path: String,
    pub doc_id: String,
    #[serde(default)]
    pub document_path: Option<String>,
    pub expected_revision: String,
    pub mutation: EvidenceBinderMutation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EvidenceBinderMutation {
    Link {
        candidate_id: String,
    },
    Unlink {
        binding_id: String,
    },
    SetTargets {
        binding_id: String,
        section_bindings: Vec<String>,
        kpi_bindings: Vec<String>,
        submission_checklist_bindings: Vec<String>,
    },
    SetNote {
        binding_id: String,
        #[serde(default)]
        note: Option<String>,
    },
    SetLocalVerified {
        binding_id: String,
        verified: bool,
    },
    SetIncludeInSubmission {
        binding_id: String,
        include: bool,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceBinderStateV1 {
    #[allow(dead_code)]
    schema_version: u32,
    #[allow(dead_code)]
    doc_id: String,
    #[serde(default)]
    document_path: Option<String>,
    #[serde(default)]
    bindings: Vec<EvidenceBindingV1>,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceBindingV1 {
    candidate_id: String,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    linked_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProcessedManifest {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default, alias = "businessUnit", alias = "project")]
    business_unit: Option<String>,
    #[serde(default)]
    files: Vec<ProcessedManifestFile>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ProcessedManifestFile {
    Path(String),
    Object {
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        original_name: Option<String>,
        #[serde(default)]
        name: Option<String>,
    },
}

impl ProcessedManifestFile {
    fn path(&self) -> Option<&str> {
        match self {
            Self::Path(path) => Some(path.as_str()),
            Self::Object { path, .. } => path.as_deref(),
        }
    }

    fn display_name(&self) -> Option<&str> {
        match self {
            Self::Path(_) => None,
            Self::Object {
                original_name,
                name,
                ..
            } => original_name.as_deref().or(name.as_deref()),
        }
    }
}

#[tauri::command]
pub fn evidence_binder_read(
    req: EvidenceBinderReadRequest,
) -> Result<EvidenceBinderResponse, String> {
    let work = normalize_existing_dir(&req.work_path)?;
    let doc_id = sanitize_doc_id(&req.doc_id)?;
    let candidates = discover_candidates(&work, req.document_path.as_deref())?;
    let state = read_or_create_state(&work, &doc_id, req.document_path.clone(), &candidates)?;
    let revision = state_revision(&state)?;
    Ok(EvidenceBinderResponse {
        state,
        candidates,
        revision,
    })
}

#[tauri::command]
pub fn evidence_binder_mutate(
    req: EvidenceBinderMutateRequest,
) -> Result<EvidenceBinderResponse, String> {
    let work = normalize_existing_dir(&req.work_path)?;
    assert_maru_can_write(&req.work_path, WorkspaceWriteAction::Modify)?;
    let doc_id = sanitize_doc_id(&req.doc_id)?;
    let _guard = BINDER_WRITE_LOCK
        .lock()
        .map_err(|_| "evidence_binder_lock_poisoned".to_string())?;
    let candidates = discover_candidates(&work, req.document_path.as_deref())?;
    let mut state = read_or_create_state(&work, &doc_id, req.document_path.clone(), &candidates)?;
    let actual_revision = state_revision(&state)?;
    if actual_revision != req.expected_revision {
        return Err("evidence_binder_revision_conflict".to_string());
    }
    apply_mutation(&work, &mut state, &candidates, req.mutation)?;
    state.schema_version = BINDER_SCHEMA_VERSION;
    state.doc_id = doc_id;
    if req.document_path.is_some() {
        state.document_path = req.document_path;
    }
    state.updated_at = chrono::Utc::now().to_rfc3339();
    write_state(&work, &state)?;
    let revision = state_revision(&state)?;
    Ok(EvidenceBinderResponse {
        state,
        candidates,
        revision,
    })
}

fn read_or_create_state(
    work: &Path,
    doc_id: &str,
    document_path: Option<String>,
    candidates: &[EvidenceBinderCandidate],
) -> Result<EvidenceBinderState, String> {
    let path = state_path(work, doc_id)?;
    if path.exists() {
        let text = fs::read_to_string(&path)
            .map_err(|err| format!("Cannot read evidence binder state: {err}"))?;
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|err| format!("Cannot parse evidence binder state: {err}"))?;
        let schema_version = value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "evidence_binder_schema_version_required".to_string())?;
        if schema_version > u64::from(BINDER_SCHEMA_VERSION) {
            return Err(format!("evidence_binder_future_schema: {schema_version}"));
        }
        let mut state = if schema_version == 1 {
            let legacy: EvidenceBinderStateV1 = serde_json::from_value(value)
                .map_err(|err| format!("Cannot parse evidence binder v1 state: {err}"))?;
            migrate_v1_state(doc_id, document_path.clone(), legacy, candidates)
        } else if schema_version == u64::from(BINDER_SCHEMA_VERSION) {
            serde_json::from_value(value)
                .map_err(|err| format!("Cannot parse evidence binder state: {err}"))?
        } else {
            return Err(format!(
                "evidence_binder_unsupported_schema: {schema_version}"
            ));
        };
        state.doc_id = doc_id.to_string();
        if document_path.is_some() {
            state.document_path = document_path;
        }
        return Ok(state);
    }
    Ok(EvidenceBinderState {
        schema_version: BINDER_SCHEMA_VERSION,
        doc_id: doc_id.to_string(),
        document_path,
        bindings: Vec::new(),
        updated_at: "1970-01-01T00:00:00Z".to_string(),
    })
}

fn write_state(work: &Path, state: &EvidenceBinderState) -> Result<(), String> {
    let path = state_path(work, &state.doc_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create evidence binder directory: {err}"))?;
    }
    let text = serde_json::to_string_pretty(state)
        .map_err(|err| format!("Cannot serialize evidence binder state: {err}"))?;
    write_atomic(&path, text.as_bytes())
        .map_err(|err| format!("Cannot save evidence binder state: {err}"))
}

fn migrate_v1_state(
    doc_id: &str,
    document_path: Option<String>,
    legacy: EvidenceBinderStateV1,
    candidates: &[EvidenceBinderCandidate],
) -> EvidenceBinderState {
    let migrated_at = legacy.updated_at.clone();
    let bindings = legacy
        .bindings
        .into_iter()
        .map(|binding| {
            let candidate = candidates
                .iter()
                .find(|candidate| candidate.id == binding.candidate_id);
            EvidenceBinding {
                binding_id: format!("legacy:{}", binding.candidate_id),
                candidate_id: Some(binding.candidate_id),
                evidence_sha256: None,
                rel_path: candidate
                    .map(|candidate| candidate.rel_path.clone())
                    .unwrap_or_default(),
                note: binding.note.and_then(|note| {
                    let note = note.trim().to_string();
                    (!note.is_empty()).then_some(note)
                }),
                section_bindings: Vec::new(),
                kpi_bindings: Vec::new(),
                submission_checklist_bindings: Vec::new(),
                local_verification_status: LocalVerificationStatus::Unverified,
                verified_at: None,
                include_in_submission: false,
                submission_selected_at: None,
                linked_at: binding.linked_at.unwrap_or_else(|| migrated_at.clone()),
            }
        })
        .collect();
    EvidenceBinderState {
        schema_version: BINDER_SCHEMA_VERSION,
        doc_id: doc_id.to_string(),
        document_path: document_path.or(legacy.document_path),
        bindings,
        updated_at: migrated_at,
    }
}

fn state_revision(state: &EvidenceBinderState) -> Result<String, String> {
    let bytes = serde_json::to_vec(state)
        .map_err(|err| format!("Cannot serialize evidence binder revision: {err}"))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn apply_mutation(
    work: &Path,
    state: &mut EvidenceBinderState,
    candidates: &[EvidenceBinderCandidate],
    mutation: EvidenceBinderMutation,
) -> Result<(), String> {
    match mutation {
        EvidenceBinderMutation::Link { candidate_id } => {
            let candidate = candidates
                .iter()
                .find(|candidate| candidate.id == candidate_id)
                .ok_or_else(|| "evidence_binder_candidate_not_found".to_string())?;
            let evidence_sha256 = hash_candidate_file(work, candidate)?;
            let binding_id = format!("sha256:{evidence_sha256}");
            if state
                .bindings
                .iter()
                .any(|binding| binding.binding_id == binding_id)
            {
                return Ok(());
            }
            let now = chrono::Utc::now().to_rfc3339();
            state.bindings.push(EvidenceBinding {
                binding_id,
                candidate_id: Some(candidate.id.clone()),
                evidence_sha256: Some(evidence_sha256),
                rel_path: candidate.rel_path.clone(),
                note: normalize_note(candidate.summary.clone())?,
                section_bindings: Vec::new(),
                kpi_bindings: Vec::new(),
                submission_checklist_bindings: Vec::new(),
                local_verification_status: LocalVerificationStatus::Unverified,
                verified_at: None,
                include_in_submission: false,
                submission_selected_at: None,
                linked_at: now,
            });
        }
        EvidenceBinderMutation::Unlink { binding_id } => {
            let old_len = state.bindings.len();
            state
                .bindings
                .retain(|binding| binding.binding_id != binding_id);
            if old_len == state.bindings.len() {
                return Err("evidence_binder_binding_not_found".to_string());
            }
        }
        EvidenceBinderMutation::SetTargets {
            binding_id,
            section_bindings,
            kpi_bindings,
            submission_checklist_bindings,
        } => {
            let binding = find_binding_mut(state, &binding_id)?;
            binding.section_bindings = normalize_targets(section_bindings)?;
            binding.kpi_bindings = normalize_targets(kpi_bindings)?;
            binding.submission_checklist_bindings =
                normalize_targets(submission_checklist_bindings)?;
        }
        EvidenceBinderMutation::SetNote { binding_id, note } => {
            find_binding_mut(state, &binding_id)?.note = normalize_note(note)?;
        }
        EvidenceBinderMutation::SetLocalVerified {
            binding_id,
            verified,
        } => {
            let binding = find_binding_mut(state, &binding_id)?;
            if verified {
                let candidate = candidate_for_binding(candidates, binding)
                    .ok_or_else(|| "evidence_binder_candidate_not_found".to_string())?;
                assert_candidate_can_be_verified(candidate)?;
                if !sidecar_hash_matches_binding(candidate, binding) {
                    return Err("evidence_binder_sidecar_hash_mismatch".to_string());
                }
                binding.local_verification_status = LocalVerificationStatus::Verified;
                binding.verified_at = Some(chrono::Utc::now().to_rfc3339());
            } else {
                binding.local_verification_status = LocalVerificationStatus::Unverified;
                binding.verified_at = None;
                if !binding_is_canonical(candidates, binding) {
                    binding.include_in_submission = false;
                    binding.submission_selected_at = None;
                }
            }
        }
        EvidenceBinderMutation::SetIncludeInSubmission {
            binding_id,
            include,
        } => {
            let binding = find_binding_mut(state, &binding_id)?;
            if include
                && binding.local_verification_status != LocalVerificationStatus::Verified
                && !binding_is_canonical(candidates, binding)
            {
                return Err("evidence_binder_submission_requires_verification".to_string());
            }
            binding.include_in_submission = include;
            binding.submission_selected_at = include.then(|| chrono::Utc::now().to_rfc3339());
        }
    }
    Ok(())
}

fn find_binding_mut<'a>(
    state: &'a mut EvidenceBinderState,
    binding_id: &str,
) -> Result<&'a mut EvidenceBinding, String> {
    state
        .bindings
        .iter_mut()
        .find(|binding| binding.binding_id == binding_id)
        .ok_or_else(|| "evidence_binder_binding_not_found".to_string())
}

fn candidate_for_binding<'a>(
    candidates: &'a [EvidenceBinderCandidate],
    binding: &EvidenceBinding,
) -> Option<&'a EvidenceBinderCandidate> {
    candidates.iter().find(|candidate| {
        binding
            .candidate_id
            .as_ref()
            .is_some_and(|id| id == &candidate.id)
            || candidate.rel_path == binding.rel_path
    })
}

fn binding_is_canonical(candidates: &[EvidenceBinderCandidate], binding: &EvidenceBinding) -> bool {
    candidate_for_binding(candidates, binding).is_some_and(|candidate| {
        candidate.sidecar_status == SidecarStatus::Verified
            && sidecar_hash_matches_binding(candidate, binding)
    })
}

fn sidecar_hash_matches_binding(
    candidate: &EvidenceBinderCandidate,
    binding: &EvidenceBinding,
) -> bool {
    match (
        candidate.sidecar_sha256.as_ref(),
        binding.evidence_sha256.as_ref(),
    ) {
        (Some(sidecar), Some(evidence)) => sidecar
            .strip_prefix("sha256:")
            .unwrap_or(sidecar)
            .eq_ignore_ascii_case(evidence.strip_prefix("sha256:").unwrap_or(evidence)),
        (Some(_), None) => false,
        (None, _) => true,
    }
}

fn assert_candidate_can_be_verified(candidate: &EvidenceBinderCandidate) -> Result<(), String> {
    if candidate
        .validation_checks
        .iter()
        .any(|check| check.status == "fail")
    {
        return Err("evidence_binder_structural_validation_failed".to_string());
    }
    if matches!(
        candidate.sidecar_status,
        SidecarStatus::Rejected | SidecarStatus::Retired
    ) {
        return Err("evidence_binder_sidecar_status_blocks_verification".to_string());
    }
    Ok(())
}

fn hash_candidate_file(work: &Path, candidate: &EvidenceBinderCandidate) -> Result<String, String> {
    let raw = PathBuf::from(&candidate.path);
    let metadata = fs::symlink_metadata(&raw)
        .map_err(|err| format!("Cannot inspect evidence candidate: {err}"))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err("evidence_binder_candidate_must_be_regular_file".to_string());
    }
    let canonical_work = work
        .canonicalize()
        .map_err(|err| format!("Cannot resolve workspace: {err}"))?;
    let canonical = raw
        .canonicalize()
        .map_err(|err| format!("Cannot resolve evidence candidate: {err}"))?;
    if !canonical.starts_with(&canonical_work) {
        return Err("evidence_binder_candidate_outside_workspace".to_string());
    }
    let mut file =
        File::open(&canonical).map_err(|err| format!("Cannot read evidence candidate: {err}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|err| format!("Cannot hash evidence candidate: {err}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn normalize_targets(values: Vec<String>) -> Result<Vec<String>, String> {
    if values.len() > MAX_TARGETS_PER_CATEGORY {
        return Err("evidence_binder_too_many_targets".to_string());
    }
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for raw in values {
        let value = collapse_whitespace(&raw);
        if value.is_empty() {
            continue;
        }
        if value.chars().count() > MAX_TARGET_LENGTH {
            return Err("evidence_binder_target_too_long".to_string());
        }
        if seen.insert(value.clone()) {
            normalized.push(value);
        }
    }
    Ok(normalized)
}

fn normalize_note(note: Option<String>) -> Result<Option<String>, String> {
    let Some(note) = note else {
        return Ok(None);
    };
    let note = note.trim().to_string();
    if note.chars().count() > MAX_NOTE_LENGTH {
        return Err("evidence_binder_note_too_long".to_string());
    }
    Ok((!note.is_empty()).then_some(note))
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

struct PendingRekey {
    source: PathBuf,
    target: PathBuf,
    original: Vec<u8>,
    updated: Vec<u8>,
}

pub(crate) fn rekey_document_states(
    work: &Path,
    old_path: &Path,
    new_path: &Path,
) -> Result<(), String> {
    let _guard = BINDER_WRITE_LOCK
        .lock()
        .map_err(|_| "evidence_binder_lock_poisoned".to_string())?;
    let binder_dir = work.join(".maru").join("binder");
    if !binder_dir.is_dir() {
        return Ok(());
    }
    let mut pending = Vec::<PendingRekey>::new();
    let old_workspace_rel = relative_to(old_path, work);
    let new_workspace_rel = relative_to(new_path, work);
    for entry in fs::read_dir(&binder_dir)
        .map_err(|err| format!("Cannot scan evidence binder states: {err}"))?
    {
        let path = entry
            .map_err(|err| format!("Cannot scan evidence binder state: {err}"))?
            .path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json")
            || fs::symlink_metadata(&path)
                .map(|metadata| !metadata.file_type().is_file())
                .unwrap_or(true)
        {
            continue;
        }
        let Ok(original) = fs::read(&path) else {
            continue;
        };
        let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&original) else {
            continue;
        };
        let Some(document_path) = value
            .get("documentPath")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string)
        else {
            continue;
        };
        let Some((replacement, old_rel, new_rel)) = rekeyed_document_path(
            &document_path,
            old_path,
            new_path,
            &old_workspace_rel,
            &new_workspace_rel,
        ) else {
            continue;
        };
        let old_path_doc_id = sanitize_path_derived_doc_id(&old_rel);
        let current_doc_id = value
            .get("docId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let next_doc_id = if current_doc_id == old_path_doc_id {
            sanitize_path_derived_doc_id(&new_rel)
        } else {
            current_doc_id
        };
        value["documentPath"] = serde_json::Value::String(replacement);
        value["docId"] = serde_json::Value::String(next_doc_id.clone());
        value["updatedAt"] = serde_json::Value::String(chrono::Utc::now().to_rfc3339());
        let target = state_path(work, &next_doc_id)?;
        if target != path && target.exists() {
            return Err("evidence_binder_rekey_target_exists".to_string());
        }
        let updated = serde_json::to_vec_pretty(&value)
            .map_err(|err| format!("Cannot serialize evidence binder state: {err}"))?;
        pending.push(PendingRekey {
            source: path,
            target,
            original,
            updated,
        });
    }

    let mut written = 0;
    for item in &pending {
        if let Err(err) = write_atomic(&item.target, &item.updated) {
            rollback_rekeys(&pending[..written]);
            return Err(format!("Cannot rekey evidence binder state: {err}"));
        }
        written += 1;
    }
    for item in &pending {
        if item.target == item.source {
            continue;
        }
        if let Err(err) = fs::remove_file(&item.source) {
            rollback_rekeys(&pending);
            return Err(format!("Cannot remove old evidence binder state: {err}"));
        }
    }
    Ok(())
}

fn rekeyed_document_path(
    document_path: &str,
    old_path: &Path,
    new_path: &Path,
    old_workspace_rel: &str,
    new_workspace_rel: &str,
) -> Option<(String, String, String)> {
    let document = document_path.replace('\\', "/");
    let old_absolute = path_string(old_path).replace('\\', "/");
    let new_absolute = path_string(new_path).replace('\\', "/");
    let old_rel = old_workspace_rel.trim_matches('/');
    let new_rel = new_workspace_rel.trim_matches('/');

    if !Path::new(document_path).is_absolute() {
        let suffix = path_suffix(&document, old_rel)?;
        return Some((
            format!("{new_rel}{suffix}"),
            format!("{old_rel}{suffix}"),
            format!("{new_rel}{suffix}"),
        ));
    }
    if let Some(suffix) = path_suffix(&document, &old_absolute) {
        return Some((
            format!("{new_absolute}{suffix}"),
            format!("{old_rel}{suffix}"),
            format!("{new_rel}{suffix}"),
        ));
    }

    // macOS can expose one workspace through aliases such as /var and
    // /private/var. Match the workspace-relative suffix without guessing a
    // different document outside the same stored workspace root.
    let marker = format!("/{old_rel}");
    let marker_index = document.rfind(&marker)?;
    let marker_end = marker_index + marker.len();
    if document
        .as_bytes()
        .get(marker_end)
        .is_some_and(|byte| *byte != b'/')
    {
        return None;
    }
    let root_prefix = &document[..marker_index];
    let suffix = &document[marker_end..];
    Some((
        format!("{root_prefix}/{new_rel}{suffix}"),
        format!("{old_rel}{suffix}"),
        format!("{new_rel}{suffix}"),
    ))
}

fn path_suffix<'a>(candidate: &'a str, prefix: &str) -> Option<&'a str> {
    let suffix = candidate.strip_prefix(prefix)?;
    if suffix.is_empty() || suffix.starts_with('/') {
        Some(suffix)
    } else {
        None
    }
}

fn rollback_rekeys(items: &[PendingRekey]) {
    for item in items.iter().rev() {
        let _ = write_atomic(&item.source, &item.original);
        if item.target != item.source {
            let _ = fs::remove_file(&item.target);
        }
    }
}

fn sanitize_path_derived_doc_id(input: &str) -> String {
    let without_extension = input
        .strip_suffix(".md")
        .or_else(|| input.strip_suffix(".MD"))
        .unwrap_or(input);
    let mut result = String::new();
    let mut previous_dot = false;
    let mut previous_dash = false;
    for ch in without_extension.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
            result.push(ch);
            previous_dot = false;
            previous_dash = ch == '-';
        } else if ch == '.' {
            if !previous_dot && !result.is_empty() {
                result.push('.');
            }
            previous_dot = true;
            previous_dash = false;
        } else if !previous_dash && !result.is_empty() {
            result.push('-');
            previous_dash = true;
            previous_dot = false;
        }
        if result.len() >= 120 {
            break;
        }
    }
    let result = result.trim_start_matches('.').trim_matches('-').to_string();
    if result.is_empty() {
        "studio-document".to_string()
    } else {
        result
    }
}

fn state_path(work: &Path, doc_id: &str) -> Result<PathBuf, String> {
    let doc_id = sanitize_doc_id(doc_id)?;
    Ok(work
        .join(".maru")
        .join("binder")
        .join(format!("{doc_id}.json")))
}

fn sanitize_doc_id(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("evidence_binder_doc_id_required".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("evidence_binder_doc_id_invalid".to_string());
    }
    let clean: String = trimmed
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches(['.', '-'])
        .chars()
        .take(120)
        .collect();
    if clean.is_empty() || clean.contains("..") || clean.starts_with('.') {
        return Err("evidence_binder_doc_id_invalid".to_string());
    }
    Ok(clean)
}

fn discover_candidates(
    work: &Path,
    document_path: Option<&str>,
) -> Result<Vec<EvidenceBinderCandidate>, String> {
    let scope = document_scope(work, document_path);
    let mut seen = BTreeSet::<String>::new();
    let mut candidates = Vec::new();

    for candidate in discover_sidecar_candidates(work, scope.as_ref())? {
        if seen.insert(candidate.rel_path.clone()) {
            candidates.push(candidate);
        }
    }
    for candidate in discover_processed_candidates(work, scope.as_ref())? {
        if seen.insert(candidate.rel_path.clone()) {
            candidates.push(candidate);
        }
    }

    candidates.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    candidates.truncate(MAX_CANDIDATES);
    Ok(candidates)
}

fn discover_sidecar_candidates(
    work: &Path,
    scope: Option<&DocumentScope>,
) -> Result<Vec<EvidenceBinderCandidate>, String> {
    let bases = scoped_bases(work, scope);
    let mut candidates = Vec::new();
    for base in bases {
        if !base.exists() {
            continue;
        }
        for entry in WalkDir::new(base)
            .into_iter()
            .filter_entry(|entry| !is_excluded_dir(entry.path()))
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".evidence.yaml"))
            {
                continue;
            }
            let Some(evidence_path) = evidence_path_for_sidecar(path) else {
                continue;
            };
            if !evidence_path.is_file() {
                continue;
            }
            let sidecar_yaml = fs::read_to_string(path)
                .ok()
                .and_then(|text| parse_sidecar_yaml(&text));
            let sidecar = sidecar_yaml
                .as_ref()
                .map(sidecar_metadata)
                .unwrap_or_default();
            candidates.push(build_candidate(
                work,
                &evidence_path,
                "sidecar",
                scope.and_then(|scope| scope.business_unit.clone()),
                Some(path_string(path)),
                None,
                sidecar_yaml
                    .as_ref()
                    .and_then(|yaml| sidecar_string(yaml, "summary")),
                sidecar.kind,
                sidecar.status,
                sidecar.sha256,
                sidecar.companion_for,
                None,
            )?);
        }
    }
    Ok(candidates)
}

fn discover_processed_candidates(
    work: &Path,
    scope: Option<&DocumentScope>,
) -> Result<Vec<EvidenceBinderCandidate>, String> {
    let items = work.join("inbox").join("items");
    let mut candidates = Vec::new();
    for status in ["done", "failed", "duplicate"] {
        let root = items.join(status);
        if !root.exists() {
            continue;
        }
        for entry in fs::read_dir(&root).map_err(|err| format!("Cannot scan inbox items: {err}"))? {
            let item_dir = entry
                .map_err(|err| format!("Cannot scan inbox item: {err}"))?
                .path();
            if !item_dir.is_dir() {
                continue;
            }
            let manifest_path = item_dir.join("manifest.yaml");
            if !manifest_path.is_file() {
                continue;
            }
            let manifest_text = fs::read_to_string(&manifest_path)
                .map_err(|err| format!("Cannot read inbox manifest: {err}"))?;
            let manifest: ProcessedManifest = serde_yaml::from_str(&manifest_text)
                .map_err(|err| format!("Cannot parse inbox manifest: {err}"))?;
            if let Some(scope_business_unit) =
                scope.and_then(|scope| scope.business_unit.as_deref())
            {
                if manifest.business_unit.as_deref() != Some(scope_business_unit) {
                    continue;
                }
            }
            let mut paths = processed_manifest_paths(&item_dir, &manifest);
            if paths.is_empty() {
                paths = raw_files_under(&item_dir.join("raw"));
            }
            for path in paths {
                if !path.is_file() || !is_evidence_file(&path) {
                    continue;
                }
                let title = manifest_title_for_path(&manifest, &path);
                let candidate = build_candidate(
                    work,
                    &path,
                    "inboxProcessed",
                    manifest.business_unit.clone(),
                    None,
                    manifest.id.clone(),
                    Some(format!(
                        "{}{}",
                        manifest
                            .channel
                            .clone()
                            .unwrap_or_else(|| "inbox".to_string()),
                        status_prefix(status)
                    )),
                    None,
                    SidecarStatus::None,
                    None,
                    None,
                    Some(title),
                )?;
                candidates.push(candidate);
            }
        }
    }
    Ok(candidates)
}

fn build_candidate(
    work: &Path,
    path: &Path,
    source: &str,
    business_unit: Option<String>,
    sidecar_path: Option<String>,
    inbox_item_id: Option<String>,
    summary: Option<String>,
    evidence_kind: Option<String>,
    sidecar_status: SidecarStatus,
    sidecar_sha256: Option<String>,
    companion_for: Option<String>,
    title_override: Option<String>,
) -> Result<EvidenceBinderCandidate, String> {
    let metadata = fs::metadata(path).map_err(|err| format!("Cannot inspect evidence: {err}"))?;
    let detected_format =
        kordoc_lite::detect_document_format_path(path).unwrap_or(DocumentFormat::Unknown);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let validation_checks = if path.is_file() {
        kordoc_lite::validate_export_artifact(path, &extension)
    } else {
        Vec::new()
    };
    let (hwp_field_count, hwp_field_labels) = if detected_format == DocumentFormat::Hwpx {
        match kordoc_lite::scan_hwpx_fields(path) {
            Ok(scan) => {
                let labels = scan
                    .fields
                    .iter()
                    .take(8)
                    .map(|field| field.label.clone())
                    .collect::<Vec<_>>();
                (scan.fields.len() as u32, labels)
            }
            Err(_) => (0, Vec::new()),
        }
    } else {
        (0, Vec::new())
    };
    let rel_path = relative_to(path, work);
    let title = title_override.unwrap_or_else(|| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| rel_path.clone())
    });
    Ok(EvidenceBinderCandidate {
        id: candidate_id(&rel_path),
        source: source.to_string(),
        path: path_string(path),
        rel_path,
        title,
        evidence_kind: evidence_kind.or_else(|| guess_evidence_kind(path)),
        business_unit,
        size_bytes: metadata.len(),
        updated_at: file_mtime(path),
        detected_format,
        validation_checks,
        hwp_field_count,
        hwp_field_labels,
        sidecar_path,
        sidecar_status,
        sidecar_sha256,
        companion_for,
        inbox_item_id,
        summary,
    })
}

#[derive(Debug, Clone)]
struct DocumentScope {
    business_unit: Option<String>,
    root: Option<PathBuf>,
}

fn document_scope(work: &Path, document_path: Option<&str>) -> Option<DocumentScope> {
    let document_path = document_path?;
    let path = PathBuf::from(document_path);
    let path = if path.is_absolute() {
        path
    } else {
        work.join(path)
    };
    let rel = path.strip_prefix(work).ok()?;
    let mut components = rel.components().filter_map(|c| c.as_os_str().to_str());
    let first = components.next()?;
    let second = components.next()?;
    if matches!(first, "projects" | "admin") {
        return Some(DocumentScope {
            business_unit: Some(second.to_string()),
            root: Some(work.join(first).join(second)),
        });
    }
    None
}

fn scoped_bases(work: &Path, scope: Option<&DocumentScope>) -> Vec<PathBuf> {
    if let Some(root) = scope.and_then(|scope| scope.root.clone()) {
        return vec![root];
    }
    vec![work.join("projects"), work.join("admin")]
}

fn processed_manifest_paths(item_dir: &Path, manifest: &ProcessedManifest) -> Vec<PathBuf> {
    let canonical_item_dir = item_dir.canonicalize().ok();
    manifest
        .files
        .iter()
        .filter_map(ProcessedManifestFile::path)
        .filter_map(|path| {
            safe_processed_manifest_path(item_dir, canonical_item_dir.as_deref(), path)
        })
        .collect()
}

fn safe_processed_manifest_path(
    item_dir: &Path,
    canonical_item_dir: Option<&Path>,
    raw_path: &str,
) -> Option<PathBuf> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() || trimmed.contains('\\') {
        return None;
    }

    let rel_path = Path::new(trimmed);
    let mut is_first_component = true;
    for component in rel_path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => return None,
            Component::Normal(part)
                if is_first_component && part.to_string_lossy().ends_with(':') =>
            {
                return None;
            }
            _ => {}
        }
        is_first_component = false;
    }

    let candidate = item_dir.join(rel_path);
    let Some(canonical_item_dir) = canonical_item_dir else {
        return Some(candidate);
    };
    let canonical_candidate = candidate.canonicalize().ok()?;
    if canonical_candidate.starts_with(canonical_item_dir) {
        Some(canonical_candidate)
    } else {
        None
    }
}

fn raw_files_under(raw_dir: &Path) -> Vec<PathBuf> {
    if !raw_dir.exists() {
        return Vec::new();
    }
    WalkDir::new(raw_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.path().to_path_buf())
        .collect()
}

fn manifest_title_for_path(manifest: &ProcessedManifest, path: &Path) -> String {
    let path_name = path.file_name().and_then(|name| name.to_str());
    manifest
        .files
        .iter()
        .find(|file| {
            file.path()
                .and_then(|value| Path::new(value).file_name())
                .and_then(|name| name.to_str())
                == path_name
        })
        .and_then(ProcessedManifestFile::display_name)
        .map(ToString::to_string)
        .or_else(|| path_name.map(ToString::to_string))
        .unwrap_or_else(|| "inbox evidence".to_string())
}

fn evidence_path_for_sidecar(sidecar: &Path) -> Option<PathBuf> {
    let name = sidecar.file_name()?.to_str()?;
    let source_name = name.strip_suffix(".evidence.yaml")?;
    Some(sidecar.with_file_name(source_name))
}

fn parse_sidecar_yaml(text: &str) -> Option<serde_yaml::Value> {
    serde_yaml::from_str(text).ok()
}

fn sidecar_string(yaml: &serde_yaml::Value, key: &str) -> Option<String> {
    yaml.get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Default)]
struct SidecarMetadata {
    kind: Option<String>,
    status: SidecarStatus,
    sha256: Option<String>,
    companion_for: Option<String>,
}

fn sidecar_metadata(yaml: &serde_yaml::Value) -> SidecarMetadata {
    let raw_status = sidecar_string(yaml, "status");
    let explicitly_verified = yaml
        .get("verified")
        .and_then(serde_yaml::Value::as_bool)
        .unwrap_or(false);
    let status = match raw_status
        .as_deref()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("verified" | "accepted" | "approved") => SidecarStatus::Verified,
        Some("rejected") => SidecarStatus::Rejected,
        Some("retired") => SidecarStatus::Retired,
        Some("draft" | "pending" | "unverified") => SidecarStatus::Unverified,
        Some(_) => SidecarStatus::Unknown,
        None if explicitly_verified => SidecarStatus::Verified,
        None => SidecarStatus::Unverified,
    };
    SidecarMetadata {
        kind: sidecar_string(yaml, "kind").or_else(|| sidecar_string(yaml, "evidence_kind")),
        status,
        sha256: sidecar_string(yaml, "sha256"),
        companion_for: sidecar_string(yaml, "companion_for")
            .or_else(|| sidecar_string(yaml, "companionFor")),
    }
}

fn candidate_id(rel_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(rel_path.as_bytes());
    format!("ev_{}", &format!("{:x}", hasher.finalize())[..16])
}

fn is_evidence_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "pdf" | "hwp" | "hwpx" | "doc" | "docx" | "xls" | "xlsx" | "png" | "jpg" | "jpeg"
            )
        })
        .unwrap_or(false)
}

fn guess_evidence_kind(path: &Path) -> Option<String> {
    let lower = path.to_string_lossy().to_lowercase();
    let kind = if lower.contains("receipt") || lower.contains("영수") {
        "receipt"
    } else if lower.contains("invoice") || lower.contains("세금") {
        "invoice"
    } else if lower.contains("contract") || lower.contains("계약") {
        "contract"
    } else if lower.contains("payment") || lower.contains("지출") {
        "payment"
    } else if lower.contains("attendance") || lower.contains("참석") {
        "attendance"
    } else if lower.contains("certificate") || lower.contains("수료") {
        "certificate"
    } else {
        return None;
    };
    Some(kind.to_string())
}

fn status_prefix(status: &str) -> &'static str {
    match status {
        "done" => " · done",
        "failed" => " · failed",
        "duplicate" => " · duplicate",
        _ => "",
    }
}

fn is_excluded_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name, ".git" | "node_modules" | "target" | "dist" | ".maru"))
}

fn relative_to(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn file_mtime(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(id: &str, rel_path: &str) -> EvidenceBinding {
        EvidenceBinding {
            binding_id: id.to_string(),
            candidate_id: Some("ev_a".to_string()),
            evidence_sha256: None,
            rel_path: rel_path.to_string(),
            note: Some("checked".to_string()),
            section_bindings: Vec::new(),
            kpi_bindings: Vec::new(),
            submission_checklist_bindings: Vec::new(),
            local_verification_status: LocalVerificationStatus::Unverified,
            verified_at: None,
            include_in_submission: false,
            submission_selected_at: None,
            linked_at: "2026-05-24T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn v2_state_round_trips_under_maru_binder() {
        let tmp = tempfile::tempdir().unwrap();
        let mut state =
            read_or_create_state(tmp.path(), "doc-1", Some("a.md".to_string()), &[]).unwrap();
        state.bindings.push(binding("legacy:ev_a", "receipt.pdf"));
        write_state(tmp.path(), &state).unwrap();
        let read = read_or_create_state(tmp.path(), "doc-1", None, &[]).unwrap();
        assert_eq!(read.bindings.len(), 1);
        assert_eq!(read.schema_version, 2);
        assert!(tmp.path().join(".maru/binder/doc-1.json").exists());
    }

    #[test]
    fn migrates_v1_in_memory_and_resets_derived_verification() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join(".maru/binder")).unwrap();
        fs::write(
            tmp.path().join(".maru/binder/doc-1.json"),
            r#"{
  "schemaVersion": 1,
  "docId": "doc-1",
  "documentPath": "old.md",
  "bindings": [{
    "candidateId": "ev_missing",
    "note": "legacy",
    "verified": true,
    "linkedAt": "2026-05-24T00:00:00Z"
  }],
  "updatedAt": "2026-05-24T00:00:00Z"
}"#,
        )
        .unwrap();

        let state =
            read_or_create_state(tmp.path(), "doc-1", Some("new.md".to_string()), &[]).unwrap();
        assert_eq!(state.schema_version, 2);
        assert_eq!(state.document_path.as_deref(), Some("new.md"));
        assert_eq!(state.bindings[0].binding_id, "legacy:ev_missing");
        assert_eq!(
            state.bindings[0].local_verification_status,
            LocalVerificationStatus::Unverified
        );
        assert!(!state.bindings[0].include_in_submission);
        let reread =
            read_or_create_state(tmp.path(), "doc-1", Some("new.md".to_string()), &[]).unwrap();
        assert_eq!(
            state_revision(&state).unwrap(),
            state_revision(&reread).unwrap()
        );
        let stored = fs::read_to_string(tmp.path().join(".maru/binder/doc-1.json")).unwrap();
        assert!(stored.contains("\"schemaVersion\": 1"));
        let migrated = evidence_binder_mutate(EvidenceBinderMutateRequest {
            work_path: path_string(tmp.path()),
            doc_id: "doc-1".into(),
            document_path: Some("new.md".into()),
            expected_revision: state_revision(&state).unwrap(),
            mutation: EvidenceBinderMutation::SetNote {
                binding_id: "legacy:ev_missing".into(),
                note: Some("migrated".into()),
            },
        })
        .unwrap();
        assert_eq!(migrated.state.bindings[0].note.as_deref(), Some("migrated"));
        let stored = fs::read_to_string(tmp.path().join(".maru/binder/doc-1.json")).unwrap();
        assert!(stored.contains("\"schemaVersion\": 2"));
    }

    #[test]
    fn rejects_future_schema_without_rewriting_it() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join(".maru/binder")).unwrap();
        let path = tmp.path().join(".maru/binder/doc-1.json");
        fs::write(&path, r#"{"schemaVersion":99}"#).unwrap();
        let error = read_or_create_state(tmp.path(), "doc-1", None, &[]).unwrap_err();
        assert!(error.contains("future_schema"));
        assert_eq!(fs::read_to_string(path).unwrap(), r#"{"schemaVersion":99}"#);
    }

    #[test]
    fn discovers_typed_sidecar_and_only_matching_processed_business_unit() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path();
        fs::create_dir_all(work.join("projects/bu-a/03-evidence-cert")).unwrap();
        fs::write(
            work.join("projects/bu-a/03-evidence-cert/receipt.pdf"),
            b"%PDF-1.4\n%%EOF",
        )
        .unwrap();
        fs::write(
            work.join("projects/bu-a/03-evidence-cert/receipt.pdf.evidence.yaml"),
            "summary: receipt ok\nkind: receipt\nstatus: verified\nsha256: abc123\ncompanion_for: report.md\n",
        )
        .unwrap();
        for business_unit in ["bu-a", "bu-b"] {
            let item = work.join(format!("inbox/items/done/item-{business_unit}"));
            fs::create_dir_all(item.join("raw")).unwrap();
            fs::write(item.join("raw/form.hwpx"), b"PK\x03\x04").unwrap();
            fs::write(
                item.join("manifest.yaml"),
                format!(
                    "id: item-{business_unit}\nchannel: kakao\nbusiness_unit: {business_unit}\nfiles:\n  - path: raw/form.hwpx\n    original_name: form.hwpx\n"
                ),
            )
            .unwrap();
        }

        let candidates =
            discover_candidates(work, Some("projects/bu-a/02-admin-approvals/doc.md")).unwrap();
        assert_eq!(candidates.len(), 2);
        let sidecar = candidates
            .iter()
            .find(|item| item.source == "sidecar")
            .unwrap();
        assert_eq!(sidecar.evidence_kind.as_deref(), Some("receipt"));
        assert_eq!(sidecar.sidecar_status, SidecarStatus::Verified);
        assert_eq!(sidecar.sidecar_sha256.as_deref(), Some("abc123"));
        assert_eq!(sidecar.companion_for.as_deref(), Some("report.md"));
        let processed = candidates
            .iter()
            .find(|item| item.source == "inboxProcessed")
            .unwrap();
        assert_eq!(processed.business_unit.as_deref(), Some("bu-a"));
    }

    #[test]
    fn discovers_processed_candidate_from_string_manifest_file_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path();
        let item = work.join("inbox/items/done/item-a");
        fs::create_dir_all(item.join("source")).unwrap();
        fs::write(item.join("source/form.hwpx"), b"PK\x03\x04").unwrap();
        fs::write(
            item.join("manifest.yaml"),
            "id: item-a\nchannel: kakao\nfiles:\n  - source/form.hwpx\n",
        )
        .unwrap();

        let candidates = discover_candidates(work, None).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].source, "inboxProcessed");
        assert_eq!(candidates[0].inbox_item_id.as_deref(), Some("item-a"));
        assert_eq!(candidates[0].title, "form.hwpx");
    }

    #[test]
    fn rejects_unsafe_doc_ids() {
        assert!(sanitize_doc_id("../x").is_err());
        assert!(sanitize_doc_id("doc x").is_ok());
    }

    #[test]
    fn processed_manifest_paths_reject_escape_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let item = tmp.path().join("inbox/items/done/item-a");
        fs::create_dir_all(item.join("raw")).unwrap();
        fs::write(item.join("raw/ok.pdf"), b"%PDF-1.4\n%%EOF").unwrap();

        let manifest: ProcessedManifest = serde_yaml::from_str(
            r#"
id: item-a
files:
  - path: raw/ok.pdf
  - path: /etc/passwd
  - path: ../escape.pdf
  - path: C:\Users\x\secret.pdf
  - path: C:/Users/x/secret.pdf
"#,
        )
        .unwrap();

        let paths = processed_manifest_paths(&item, &manifest);
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("raw/ok.pdf"));
    }

    #[test]
    fn link_hashes_the_binary_lazily_and_uses_full_sha_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path();
        fs::create_dir_all(work.join("projects/bu-a")).unwrap();
        fs::write(work.join("projects/bu-a/receipt.pdf"), b"evidence-bytes").unwrap();
        let candidates = discover_candidates(work, Some("projects/bu-a/report.md")).unwrap();
        assert_eq!(
            candidates.len(),
            0,
            "files without sidecars are not scanned"
        );
        fs::write(
            work.join("projects/bu-a/receipt.pdf.evidence.yaml"),
            "kind: receipt\n",
        )
        .unwrap();
        let candidates = discover_candidates(work, Some("projects/bu-a/report.md")).unwrap();
        let candidate = candidates.first().unwrap();
        assert!(candidate.id.starts_with("ev_"));
        let mut state = read_or_create_state(
            work,
            "doc-1",
            Some("projects/bu-a/report.md".into()),
            &candidates,
        )
        .unwrap();
        apply_mutation(
            work,
            &mut state,
            &candidates,
            EvidenceBinderMutation::Link {
                candidate_id: candidate.id.clone(),
            },
        )
        .unwrap();
        let expected = format!("{:x}", Sha256::digest(b"evidence-bytes"));
        assert_eq!(
            state.bindings[0].evidence_sha256.as_deref(),
            Some(expected.as_str())
        );
        assert_eq!(state.bindings[0].binding_id, format!("sha256:{expected}"));
    }

    #[test]
    fn target_and_submission_mutations_enforce_invariants() {
        let tmp = tempfile::tempdir().unwrap();
        let mut state =
            read_or_create_state(tmp.path(), "doc-1", Some("report.md".into()), &[]).unwrap();
        state.bindings.push(binding("legacy:ev_a", "receipt.pdf"));

        apply_mutation(
            tmp.path(),
            &mut state,
            &[],
            EvidenceBinderMutation::SetTargets {
                binding_id: "legacy:ev_a".into(),
                section_bindings: vec!["  Section   One ".into(), "Section One".into()],
                kpi_bindings: vec!["KPI 1".into()],
                submission_checklist_bindings: vec![],
            },
        )
        .unwrap();
        assert_eq!(state.bindings[0].section_bindings, ["Section One"]);

        let error = apply_mutation(
            tmp.path(),
            &mut state,
            &[],
            EvidenceBinderMutation::SetIncludeInSubmission {
                binding_id: "legacy:ev_a".into(),
                include: true,
            },
        )
        .unwrap_err();
        assert_eq!(error, "evidence_binder_submission_requires_verification");
    }

    #[cfg(unix)]
    #[test]
    fn link_rejects_symlink_candidates() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path();
        fs::write(work.join("target.pdf"), b"data").unwrap();
        symlink(work.join("target.pdf"), work.join("link.pdf")).unwrap();
        let candidate = EvidenceBinderCandidate {
            id: "ev_link".into(),
            source: "sidecar".into(),
            path: path_string(&work.join("link.pdf")),
            rel_path: "link.pdf".into(),
            title: "link.pdf".into(),
            evidence_kind: None,
            business_unit: None,
            size_bytes: 4,
            updated_at: None,
            detected_format: DocumentFormat::Pdf,
            validation_checks: Vec::new(),
            hwp_field_count: 0,
            hwp_field_labels: Vec::new(),
            sidecar_path: None,
            sidecar_status: SidecarStatus::None,
            sidecar_sha256: None,
            companion_for: None,
            inbox_item_id: None,
            summary: None,
        };
        let error = hash_candidate_file(work, &candidate).unwrap_err();
        assert_eq!(error, "evidence_binder_candidate_must_be_regular_file");
    }

    #[test]
    fn revisions_change_with_state_and_are_stable_for_same_state() {
        let tmp = tempfile::tempdir().unwrap();
        let mut state = read_or_create_state(tmp.path(), "doc-1", None, &[]).unwrap();
        let first = state_revision(&state).unwrap();
        assert_eq!(first, state_revision(&state).unwrap());
        let reread = read_or_create_state(tmp.path(), "doc-1", None, &[]).unwrap();
        assert_eq!(first, state_revision(&reread).unwrap());
        state.bindings.push(binding("legacy:ev_a", "receipt.pdf"));
        assert_ne!(first, state_revision(&state).unwrap());
    }

    #[test]
    fn mutation_command_guards_revision_and_persists_v2_atomically() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path();
        fs::create_dir_all(work.join("projects/bu-a")).unwrap();
        fs::write(work.join("projects/bu-a/receipt.pdf"), b"evidence").unwrap();
        fs::write(
            work.join("projects/bu-a/receipt.pdf.evidence.yaml"),
            "kind: receipt\n",
        )
        .unwrap();
        let read = evidence_binder_read(EvidenceBinderReadRequest {
            work_path: path_string(work),
            doc_id: "doc-1".into(),
            document_path: Some("projects/bu-a/report.md".into()),
        })
        .unwrap();
        let candidate_id = read.candidates[0].id.clone();
        let saved = evidence_binder_mutate(EvidenceBinderMutateRequest {
            work_path: path_string(work),
            doc_id: "doc-1".into(),
            document_path: Some("projects/bu-a/report.md".into()),
            expected_revision: read.revision.clone(),
            mutation: EvidenceBinderMutation::Link { candidate_id },
        })
        .unwrap();
        assert_eq!(saved.state.bindings.len(), 1);
        let stored = fs::read_to_string(work.join(".maru/binder/doc-1.json")).unwrap();
        assert!(stored.contains("\"schemaVersion\": 2"));

        let error = evidence_binder_mutate(EvidenceBinderMutateRequest {
            work_path: path_string(work),
            doc_id: "doc-1".into(),
            document_path: Some("projects/bu-a/report.md".into()),
            expected_revision: read.revision,
            mutation: EvidenceBinderMutation::SetNote {
                binding_id: saved.state.bindings[0].binding_id.clone(),
                note: Some("stale".into()),
            },
        })
        .unwrap_err();
        assert_eq!(error, "evidence_binder_revision_conflict");
    }

    #[test]
    fn maru_owned_rename_rekeys_path_identity_but_preserves_stable_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path();
        let old_path = work.join("projects/bu-a/old.md");
        let new_path = work.join("projects/bu-a/new.md");
        fs::create_dir_all(old_path.parent().unwrap()).unwrap();
        fs::write(&old_path, "# old").unwrap();

        let path_id = sanitize_path_derived_doc_id("projects/bu-a/old.md");
        let mut path_state =
            read_or_create_state(work, &path_id, Some(path_string(&old_path)), &[]).unwrap();
        path_state
            .bindings
            .push(binding("legacy:path", "receipt.pdf"));
        write_state(work, &path_state).unwrap();
        let stable_state =
            read_or_create_state(work, "stable-id", Some("projects/bu-a/old.md".into()), &[])
                .unwrap();
        write_state(work, &stable_state).unwrap();
        fs::write(work.join(".maru/binder/corrupt.json"), b"{broken").unwrap();

        fs::rename(&old_path, &new_path).unwrap();
        rekey_document_states(work, &old_path, &new_path).unwrap();

        let new_path_id = sanitize_path_derived_doc_id("projects/bu-a/new.md");
        assert!(!state_path(work, &path_id).unwrap().exists());
        let rekeyed =
            read_or_create_state(work, &new_path_id, Some(path_string(&new_path)), &[]).unwrap();
        assert_eq!(rekeyed.bindings.len(), 1);
        let stable = read_or_create_state(work, "stable-id", None, &[]).unwrap();
        assert_eq!(stable.doc_id, "stable-id");
        assert_eq!(
            stable.document_path.as_deref(),
            Some("projects/bu-a/new.md")
        );
        assert_eq!(
            fs::read_to_string(work.join(".maru/binder/corrupt.json")).unwrap(),
            "{broken"
        );
    }
}
