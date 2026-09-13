//! Durable, reviewed input to meeting-note generation. Originals and checkpoints
//! are immutable; all mutable state is admitted and revision checked in Rust.
use crate::atomic_file::{
    with_path_transactions, write_atomic, write_atomic_create, PathTransactionLease,
    PathTransactionRequest,
};
use crate::ipc_error::{IpcError, MEETING_SOURCE_REVISION_CONFLICT};
use crate::vault::{lexical_normalize, normalize_existing_dir};
use crate::vault_list::{assert_document_owner, assert_maru_can_write, WorkspaceWriteAction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_BYTES: usize = 2 * 1024 * 1024;
const INVALID: &str = "meeting_source_invalid";

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceDraft {
    pub title: Option<String>,
    pub date: Option<String>,
    pub provider: Option<String>,
    pub context: Option<String>,
    #[serde(default)]
    pub sources: Vec<MeetingSource>,
    #[serde(default)]
    pub participants: Vec<Participant>,
    #[serde(default)]
    pub findings: Vec<Value>,
    #[serde(default)]
    pub suggestions: Vec<SourceSuggestion>,
    #[serde(default)]
    pub participants_reviewed: bool,
    #[serde(default)]
    pub note_reviewed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub id: String,
    pub name: String,
    pub affiliation: Option<String>,
    pub title: Option<String>,
    pub role: Option<String>,
    #[serde(default)]
    pub speaker_labels: Vec<String>,
    pub attendance: String,
    pub status: String,
    pub reference: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSuggestion {
    pub id: String,
    pub source_id: String,
    pub before: String,
    pub after: String,
    pub reason: String,
    pub category: String,
    pub evidence: String,
    pub status: String,
    pub required: bool,
    pub base_revision: String,
    pub run_id: Option<String>,
    pub base_text_hash: Option<String>,
    pub evidence_source_id: Option<String>,
    pub evidence_quote: Option<String>,
    pub context_hash: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSuggestionDecision {
    pub id: String,
    pub status: String,
    pub replacement: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub original_text: String,
    pub text: String,
    pub original_hash: String,
    pub imported_at: Option<String>,
    pub original_path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSession {
    pub id: String,
    pub revision: String,
    pub created_at: String,
    pub updated_at: String,
    pub draft: SourceDraft,
    pub versions: Vec<SourceVersion>,
    pub confirmed_version_id: Option<String>,
    pub output_links: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceVersion {
    pub id: String,
    pub revision: String,
    pub reason: String,
    pub created_at: String,
    pub actor: String,
    pub draft: SourceDraft,
    pub content_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedSourceReference {
    pub session_id: String,
    pub version_id: String,
    pub content_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSourceImportInput {
    pub name: String,
    pub kind: String,
    pub text: Option<String>,
    pub path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionScope {
    pub kind: String,
    pub value: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionExample {
    pub id: String,
    pub revision: Option<String>,
    pub before: String,
    pub after: String,
    pub reason: String,
    pub scope: CorrectionScope,
    pub enabled: bool,
    pub source_session_id: Option<String>,
    pub source_version_id: Option<String>,
}

fn invalid(message: impl Into<String>) -> IpcError {
    IpcError {
        code: INVALID.into(),
        message: message.into(),
    }
}
fn conflict() -> IpcError {
    IpcError {
        code: MEETING_SOURCE_REVISION_CONFLICT.into(),
        message:
            "The saved review changed. Reload it and compare your unsaved edits before retrying."
                .into(),
    }
}
fn io_error(error: impl std::fmt::Display) -> IpcError {
    IpcError::from(error.to_string())
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, IpcError> {
    serde_json::to_vec_pretty(value).map_err(io_error)
}
fn draft_hash(draft: &SourceDraft) -> Result<String, IpcError> {
    Ok(hash(&encode(draft)?))
}
fn context_hash(draft: &SourceDraft) -> Result<String, IpcError> {
    Ok(hash(&encode(&serde_json::json!({
        "title": draft.title, "date": draft.date, "provider": draft.provider,
        "context": draft.context, "participants": draft.participants,
        "sources": draft.sources.iter().map(|source| (&source.id, &source.text)).collect::<Vec<_>>(),
    }))?))
}
fn ensure_text(text: &str) -> Result<(), IpcError> {
    if text.len() > MAX_BYTES {
        Err(invalid("Each source must be at most 2 MiB."))
    } else {
        Ok(())
    }
}
fn safe_id(id: &str) -> Result<(), IpcError> {
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(invalid("Invalid source/session/version identifier."));
    }
    Ok(())
}
fn work_root(workspace: &str) -> Result<PathBuf, IpcError> {
    normalize_existing_dir(workspace).map_err(IpcError::from)
}
fn storage_root(workspace: &str) -> Result<PathBuf, IpcError> {
    Ok(work_root(workspace)?.join(".maru/meetings/source-reviews"))
}
fn session_dir(workspace: &str, id: &str) -> Result<PathBuf, IpcError> {
    safe_id(id)?;
    Ok(storage_root(workspace)?.join(id))
}
fn state_path(workspace: &str, id: &str) -> Result<PathBuf, IpcError> {
    Ok(session_dir(workspace, id)?.join("state.json"))
}

// The selected workspace may deliberately be an alias. Only managed components
// below its resolved root must remain ordinary files/directories.
fn check_managed_path(workspace: &str, path: &Path) -> Result<(), IpcError> {
    let root = work_root(workspace)?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| invalid("Managed source path escaped the workspace."))?;
    let mut current = root;
    for part in relative.components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err(invalid("Invalid managed source path."));
        }
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(invalid("Managed review storage cannot be a symlink."))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error(e)),
        }
    }
    Ok(())
}
fn read_json<T: for<'a> Deserialize<'a>>(workspace: &str, path: &Path) -> Result<T, IpcError> {
    check_managed_path(workspace, path)?;
    serde_json::from_slice(&fs::read(path).map_err(io_error)?).map_err(io_error)
}
fn admitted<T>(
    workspace: &str,
    action: WorkspaceWriteAction,
    operation: impl FnOnce(&PathTransactionLease) -> Result<T, IpcError>,
) -> Result<T, IpcError> {
    let work = work_root(workspace)?;
    let requested = lexical_normalize(&if Path::new(workspace).is_absolute() {
        PathBuf::from(workspace)
    } else {
        std::env::current_dir().map_err(io_error)?.join(workspace)
    });
    let managed = work.join(".maru");
    check_managed_path(workspace, &managed.join("meetings/source-reviews"))?;
    let request = PathTransactionRequest::new(vec![managed.clone(), requested.join(".maru")])
        .and_then(|r| r.require_parent(&work))
        .and_then(|r| r.with_workspace_registry())
        .map_err(IpcError::from)?;
    // Keep the domain's structured error inside the outer admission result.
    with_path_transactions(request, |lease| {
        lease.ensure_workspace_registry()?;
        lease.before_effect()?;
        if normalize_existing_dir(workspace)? != work {
            return Err("Workspace changed while the review write was waiting.".into());
        }
        assert_document_owner(workspace, &managed.join("meetings/source-reviews"))?;
        assert_maru_can_write(workspace, action)?;
        Ok(operation(lease))
    })
    .map_err(IpcError::from)?
}
fn write_json<T: Serialize>(
    workspace: &str,
    path: &Path,
    value: &T,
    create: bool,
    lease: &PathTransactionLease,
) -> Result<(), IpcError> {
    lease
        .ensure_covered([path.to_path_buf()])
        .map_err(IpcError::from)?;
    check_managed_path(workspace, path)?;
    lease.before_effect().map_err(IpcError::from)?;
    let bytes = encode(value)?;
    if create {
        write_atomic_create(path, &bytes)
    } else {
        write_atomic(path, &bytes)
    }
    .map_err(IpcError::from)
}
fn validate_draft(draft: &SourceDraft) -> Result<(), IpcError> {
    if draft.sources.is_empty() {
        return Err(invalid("Import at least one nonempty source."));
    }
    let mut ids = HashSet::new();
    for source in &draft.sources {
        safe_id(&source.id)?;
        if !ids.insert(&source.id) || !matches!(source.kind.as_str(), "note" | "transcript") {
            return Err(invalid("Invalid or duplicate source."));
        }
        ensure_text(&source.text)?;
        ensure_text(&source.original_text)?;
    }
    // Blank sources are allowed so a new note can be created before any text exists.
    let mut people = HashSet::new();
    for person in &draft.participants {
        if !people.insert(&person.id)
            || !matches!(person.attendance.as_str(), "attendee" | "mentioned")
            || !matches!(person.status.as_str(), "confirmed" | "uncertain")
        {
            return Err(invalid("Invalid participant identity or review status."));
        }
    }
    let mut suggestions = HashSet::new();
    for suggestion in &draft.suggestions {
        if !suggestions.insert(&suggestion.id)
            || !ids.contains(&suggestion.source_id)
            || !matches!(
                suggestion.status.as_str(),
                "pending" | "accepted" | "rejected" | "uncertain" | "edited"
            )
        {
            return Err(invalid("Invalid correction suggestion."));
        }
    }
    Ok(())
}
fn verify_originals(workspace: &str, session: &str, draft: &SourceDraft) -> Result<(), IpcError> {
    for source in &draft.sources {
        safe_id(&source.id)?;
        let path = session_dir(workspace, session)?
            .join("originals")
            .join(format!("{}.txt", source.id));
        check_managed_path(workspace, &path)?;
        let bytes = fs::read(path).map_err(io_error)?;
        if bytes != source.original_text.as_bytes() || hash(&bytes) != source.original_hash {
            return Err(invalid(
                "The preserved original changed on disk. Restore the original before continuing.",
            ));
        }
    }
    Ok(())
}
fn load(workspace: &str, id: &str) -> Result<SourceSession, IpcError> {
    let session: SourceSession = read_json(workspace, &state_path(workspace, id)?)?;
    if session.id != id {
        return Err(invalid("Review session identity mismatch."));
    }
    validate_draft(&session.draft)?;
    verify_originals(workspace, id, &session.draft)?;
    Ok(session)
}
fn persist(
    workspace: &str,
    mut session: SourceSession,
    lease: &PathTransactionLease,
) -> Result<SourceSession, IpcError> {
    session.revision = Uuid::new_v4().to_string();
    session.updated_at = now();
    write_json(
        workspace,
        &state_path(workspace, &session.id)?,
        &session,
        false,
        lease,
    )?;
    Ok(session)
}
fn expected(session: &SourceSession, revision: &str) -> Result<(), IpcError> {
    if session.revision != revision {
        return Err(conflict());
    }
    Ok(())
}
fn preserve_original(
    workspace: &str,
    session: &str,
    source: &mut MeetingSource,
    lease: &PathTransactionLease,
) -> Result<(), IpcError> {
    safe_id(&source.id)?;
    ensure_text(&source.text)?;
    source.original_text = source.text.clone();
    source.original_hash = hash(source.text.as_bytes());
    source.imported_at = Some(now());
    let path = session_dir(workspace, session)?
        .join("originals")
        .join(format!("{}.txt", source.id));
    lease
        .ensure_covered([path.clone()])
        .map_err(IpcError::from)?;
    check_managed_path(workspace, &path)?;
    lease.before_effect().map_err(IpcError::from)?;
    write_atomic_create(&path, source.text.as_bytes()).map_err(IpcError::from)
}
fn create_impl(
    workspace: &str,
    mut draft: SourceDraft,
    provider: Option<String>,
) -> Result<SourceSession, IpcError> {
    draft.provider = provider.or(draft.provider);
    draft.participants_reviewed = false;
    draft.note_reviewed = false;
    validate_draft(&draft)?;
    admitted(workspace, WorkspaceWriteAction::Create, |lease| {
        let id = Uuid::new_v4().to_string();
        for source in &mut draft.sources {
            preserve_original(workspace, &id, source, lease)?;
        }
        let timestamp = now();
        let session = SourceSession {
            id,
            revision: Uuid::new_v4().to_string(),
            created_at: timestamp.clone(),
            updated_at: timestamp,
            draft,
            versions: vec![],
            confirmed_version_id: None,
            output_links: vec![],
        };
        write_json(
            workspace,
            &state_path(workspace, &session.id)?,
            &session,
            true,
            lease,
        )?;
        Ok(session)
    })
}
fn delete_impl(workspace: &str, id: &str) -> Result<(), IpcError> {
    let dir = session_dir(workspace, id)?;
    check_managed_path(workspace, &dir)?;
    if !dir.join("state.json").exists() {
        return Err(invalid("Review session not found."));
    }
    admitted(workspace, WorkspaceWriteAction::Delete, |_lease| {
        fs::remove_dir_all(&dir).map_err(io_error)
    })
}
fn save_draft_impl(
    workspace: &str,
    id: &str,
    mut draft: SourceDraft,
    revision: &str,
) -> Result<SourceSession, IpcError> {
    validate_draft(&draft)?;
    admitted(workspace, WorkspaceWriteAction::Modify, |lease| {
        let mut session = load(workspace, id)?;
        expected(&session, revision)?;
        for prior in &session.draft.suggestions {
            if draft.suggestions.iter().find(|item| item.id == prior.id) != Some(prior) {
                return Err(invalid(
                    "Use the correction decision operation to change suggestion records.",
                ));
            }
        }
        let context = context_hash(&session.draft)?;
        let same_input = context == context_hash(&draft)? && session.draft.sources == draft.sources;
        for suggestion in &mut draft.suggestions {
            if session
                .draft
                .suggestions
                .iter()
                .any(|item| item.id == suggestion.id)
            {
                continue;
            }
            if suggestion.status != "pending"
                || suggestion.base_revision != session.revision
                || suggestion.before.is_empty()
                || suggestion.reason.trim().is_empty()
                || suggestion.category.trim().is_empty()
                || !same_input
            {
                return Err(invalid(
                    "The AI correction no longer matches the reviewed input.",
                ));
            }
            let source = session
                .draft
                .sources
                .iter()
                .find(|source| source.id == suggestion.source_id)
                .ok_or_else(|| invalid("Unknown correction source."))?;
            if source.text.matches(&suggestion.before).count() != 1 {
                return Err(invalid("The correction passage is missing or ambiguous."));
            }
            suggestion.context_hash = Some(context.clone());
        }
        if !same_input {
            for suggestion in &mut draft.suggestions {
                if suggestion.status == "pending" {
                    suggestion.context_hash = None;
                }
            }
        }
        if session.draft.sources.len() != draft.sources.len() {
            return Err(invalid("Use import to add a source."));
        }
        for source in &draft.sources {
            let original = session
                .draft
                .sources
                .iter()
                .find(|s| s.id == source.id)
                .ok_or_else(|| invalid("Unknown source."))?;
            if source.original_text != original.original_text
                || source.original_hash != original.original_hash
                || source.name != original.name
                || source.kind != original.kind
                || source.imported_at != original.imported_at
                || source.original_path != original.original_path
            {
                return Err(invalid("Original source metadata is immutable."));
            }
        }
        if session.draft == draft {
            return Ok(session);
        }
        session.draft = draft;
        session.confirmed_version_id = None;
        persist(workspace, session, lease)
    })
}
fn decide_impl(
    workspace: &str,
    id: &str,
    decision: SourceSuggestionDecision,
    revision: &str,
) -> Result<SourceSession, IpcError> {
    admitted(workspace, WorkspaceWriteAction::Modify, |lease| {
        let mut session = load(workspace, id)?;
        expected(&session, revision)?;
        let index = session
            .draft
            .suggestions
            .iter()
            .position(|s| s.id == decision.id)
            .ok_or_else(|| invalid("Unknown correction."))?;
        let suggestion = session.draft.suggestions[index].clone();
        if suggestion.status != "pending" {
            return Err(invalid("This correction was already reviewed."));
        }
        if !matches!(
            decision.status.as_str(),
            "accepted" | "edited" | "rejected" | "uncertain"
        ) {
            return Err(invalid("Invalid correction decision."));
        }
        if matches!(decision.status.as_str(), "accepted" | "edited") {
            if suggestion.context_hash.as_deref() != Some(&context_hash(&session.draft)?) {
                return Err(invalid(
                    "Participant/context information changed. Request a new AI review.",
                ));
            }
            let source = session
                .draft
                .sources
                .iter_mut()
                .find(|s| s.id == suggestion.source_id)
                .ok_or_else(|| invalid("Unknown correction source."))?;
            if suggestion.before.is_empty() || source.text.matches(&suggestion.before).count() != 1
            {
                return Err(invalid("The correction passage changed or is ambiguous."));
            }
            let after = if decision.status == "edited" {
                decision
                    .replacement
                    .ok_or_else(|| invalid("A replacement is required."))?
            } else {
                suggestion.after.clone()
            };
            let next = source.text.replacen(&suggestion.before, &after, 1);
            ensure_text(&next)?;
            source.text = next;
            session.draft.suggestions[index].after = after;
        }
        session.draft.suggestions[index].status = decision.status;
        // A user-approved member of the same proposal batch may safely advance
        // the remaining batch's baseline; arbitrary manual edits cannot.
        if matches!(
            session.draft.suggestions[index].status.as_str(),
            "accepted" | "edited"
        ) {
            let next_context = context_hash(&session.draft)?;
            for item in &mut session.draft.suggestions {
                if item.status == "pending" && item.context_hash == suggestion.context_hash {
                    item.context_hash = Some(next_context.clone());
                }
            }
        }
        session.draft.note_reviewed = false;
        session.confirmed_version_id = None;
        persist(workspace, session, lease)
    })
}
fn checkpoint_in_transaction(
    workspace: &str,
    session: &mut SourceSession,
    reason: &str,
    lease: &PathTransactionLease,
) -> Result<SourceVersion, IpcError> {
    if reason.trim().is_empty() {
        return Err(invalid("Enter a reason for this version."));
    }
    let content_hash = draft_hash(&session.draft)?;
    // Content-addressed parent/reason identity makes retrying an interrupted
    // checkpoint reuse the same immutable record instead of overwriting it.
    let id = hash(format!("{}\n{}\n{}", session.revision, content_hash, reason.trim()).as_bytes());
    let path = session_dir(workspace, &session.id)?
        .join("revisions")
        .join(format!("{id}.json"));
    let version = if path.exists() {
        let version: SourceVersion = read_json(workspace, &path)?;
        if version.content_hash != content_hash
            || version.revision != session.revision
            || version.reason != reason.trim()
        {
            return Err(invalid("Checkpoint identity mismatch."));
        }
        version
    } else {
        let version = SourceVersion {
            id,
            revision: session.revision.clone(),
            reason: reason.trim().into(),
            created_at: now(),
            actor: std::env::var("USER")
                .or_else(|_| std::env::var("USERNAME"))
                .unwrap_or_else(|_| "user".into()),
            draft: session.draft.clone(),
            content_hash,
        };
        write_json(workspace, &path, &version, true, lease)?;
        version
    };
    session.versions.push(version.clone());
    Ok(version)
}
fn checkpoint_impl(
    workspace: &str,
    id: &str,
    reason: &str,
    revision: &str,
) -> Result<SourceVersion, IpcError> {
    admitted(workspace, WorkspaceWriteAction::Modify, |lease| {
        let mut session = load(workspace, id)?;
        if session.revision != revision {
            if let Some(last) = session
                .versions
                .last()
                .filter(|v| v.revision == revision && v.reason == reason.trim())
            {
                return Ok(last.clone());
            }
            return Err(conflict());
        }
        let version = checkpoint_in_transaction(workspace, &mut session, reason, lease)?;
        persist(workspace, session, lease)?;
        Ok(version)
    })
}
fn confirm_impl(workspace: &str, id: &str, revision: &str) -> Result<SourceSession, IpcError> {
    admitted(workspace, WorkspaceWriteAction::Modify, |lease| {
        let mut session = load(workspace, id)?;
        if session.revision != revision {
            if session.versions.last().is_some_and(|v| {
                v.revision == revision && session.confirmed_version_id.as_deref() == Some(&v.id)
            }) {
                return Ok(session);
            }
            return Err(conflict());
        }
        if !session.draft.participants_reviewed || !session.draft.note_reviewed {
            return Err(invalid(
                "Confirm participant/context review and note review first.",
            ));
        }
        // Blank sources are valid while drafting, but a confirmed version must
        // carry real text so generation never starts from an empty source.
        if session
            .draft
            .sources
            .iter()
            .all(|s| s.text.trim().is_empty())
        {
            return Err(invalid("The review must contain some source text."));
        }
        if session
            .draft
            .suggestions
            .iter()
            .any(|s| s.required && s.status == "pending")
        {
            return Err(invalid(
                "Resolve required findings or explicitly retain them as uncertain.",
            ));
        }
        if session
            .draft
            .participants
            .iter()
            .any(|p| p.name.trim().is_empty())
        {
            return Err(invalid(
                "Name each participant or provide an unknown-speaker label.",
            ));
        }
        if session.confirmed_version_id.is_some() {
            return Ok(session);
        }
        let version =
            checkpoint_in_transaction(workspace, &mut session, "Review confirmed", lease)?;
        session.confirmed_version_id = Some(version.id);
        persist(workspace, session, lease)
    })
}
fn version_impl(workspace: &str, id: &str, version_id: &str) -> Result<SourceVersion, IpcError> {
    safe_id(version_id)?;
    let session = load(workspace, id)?;
    if !session.versions.iter().any(|v| v.id == version_id) {
        return Err(invalid("Version not found."));
    }
    let version: SourceVersion = read_json(
        workspace,
        &session_dir(workspace, id)?
            .join("revisions")
            .join(format!("{version_id}.json")),
    )?;
    if version.id != version_id || version.content_hash != draft_hash(&version.draft)? {
        return Err(invalid("Stored version content changed."));
    }
    verify_originals(workspace, id, &version.draft)?;
    Ok(version)
}
fn restore_impl(
    workspace: &str,
    id: &str,
    version_id: &str,
    revision: &str,
) -> Result<SourceSession, IpcError> {
    admitted(workspace, WorkspaceWriteAction::Modify, |lease| {
        let mut session = load(workspace, id)?;
        expected(&session, revision)?;
        session.draft = version_impl(workspace, id, version_id)?.draft;
        session.draft.participants_reviewed = false;
        session.draft.note_reviewed = false;
        session.confirmed_version_id = None;
        checkpoint_in_transaction(
            workspace,
            &mut session,
            &format!("Restored version {version_id}"),
            lease,
        )?;
        persist(workspace, session, lease)
    })
}
fn prepare_import(
    workspace: &str,
    input: MeetingSourceImportInput,
) -> Result<MeetingSource, IpcError> {
    if input.text.is_some() == input.path.is_some() {
        return Err(invalid("Provide exactly one pasted text or file path."));
    }
    let (name, text, original_path) = if let Some(path) = input.path {
        let path = crate::vault::resolve_inside_vault(workspace, &path).map_err(IpcError::from)?;
        assert_document_owner(workspace, &path).map_err(IpcError::from)?;
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(ext.as_str(), "txt" | "md" | "markdown") {
            return Err(invalid("Only TXT and Markdown files are supported."));
        }
        let file = fs::File::open(&path).map_err(io_error)?;
        if !file.metadata().map_err(io_error)?.is_file() {
            return Err(invalid("Select an ordinary text file."));
        }
        let mut bytes = vec![];
        file.take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() > MAX_BYTES {
            return Err(invalid("Each source must be at most 2 MiB."));
        }
        let text = String::from_utf8(bytes).map_err(|_| {
            invalid("The file is not valid UTF-8. Export UTF-8 text and try again.")
        })?;
        (
            path.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&input.name)
                .to_string(),
            text,
            Some(path.to_string_lossy().into_owned()),
        )
    } else {
        (input.name, input.text.unwrap_or_default(), None)
    };
    ensure_text(&text)?;
    if text.trim().is_empty() || !matches!(input.kind.as_str(), "note" | "transcript") {
        return Err(invalid("Import a nonempty note or transcript."));
    }
    let source = MeetingSource {
        id: Uuid::new_v4().to_string(),
        name,
        kind: input.kind,
        original_text: text.clone(),
        text,
        original_hash: String::new(),
        imported_at: None,
        original_path,
    };
    Ok(source)
}
fn import_impl(
    workspace: &str,
    id: &str,
    input: MeetingSourceImportInput,
    revision: &str,
) -> Result<SourceSession, IpcError> {
    let mut source = prepare_import(workspace, input)?;
    admitted(workspace, WorkspaceWriteAction::Modify, |lease| {
        let mut session = load(workspace, id)?;
        expected(&session, revision)?;
        preserve_original(workspace, id, &mut source, lease)?;
        session.draft.sources.push(source);
        session.draft.note_reviewed = false;
        session.confirmed_version_id = None;
        persist(workspace, session, lease)
    })
}
pub fn validate_reviewed_source(
    workspace: &str,
    reference: &ReviewedSourceReference,
) -> Result<SourceVersion, IpcError> {
    let session = load(workspace, &reference.session_id)?;
    if session.confirmed_version_id.as_deref() != Some(&reference.version_id) {
        return Err(invalid(
            "The source is no longer confirmed. Review it again.",
        ));
    }
    let version = version_impl(workspace, &reference.session_id, &reference.version_id)?;
    if version.content_hash != reference.content_hash
        || version.content_hash != draft_hash(&session.draft)?
    {
        return Err(invalid(
            "The reviewed source/context no longer matches this run.",
        ));
    }
    Ok(version)
}
pub(crate) fn record_source_output_provenance_in_transaction(
    workspace: &str,
    reference: &ReviewedSourceReference,
    output: &str,
    lease: &PathTransactionLease,
) -> Result<(), IpcError> {
    validate_reviewed_source(workspace, reference)?;
    let path = state_path(workspace, &reference.session_id)?;
    lease
        .ensure_covered([path.clone()])
        .map_err(IpcError::from)?;
    check_managed_path(workspace, &path)?;
    // Called inside proposal application after the owning write policy check.
    let mut session = load(workspace, &reference.session_id)?;
    if !session.output_links.iter().any(|p| p == output) {
        session.output_links.push(output.to_owned());
        write_json(workspace, &path, &session, false, lease)?;
    }
    Ok(())
}
fn examples_path(workspace: &str) -> Result<PathBuf, IpcError> {
    Ok(work_root(workspace)?.join(".maru/meetings/correction-examples.json"))
}
fn examples_impl(workspace: &str) -> Result<Vec<CorrectionExample>, IpcError> {
    let path = examples_path(workspace)?;
    check_managed_path(workspace, &path)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    read_json(workspace, &path)
}
fn save_example_impl(
    workspace: &str,
    mut example: CorrectionExample,
) -> Result<CorrectionExample, IpcError> {
    if example.before.trim().is_empty()
        || example.after.trim().is_empty()
        || example.reason.trim().is_empty()
    {
        return Err(invalid(
            "A reusable correction needs before/after text and a reason.",
        ));
    }
    ensure_text(&example.before)?;
    ensure_text(&example.after)?;
    if !matches!(
        example.scope.kind.as_str(),
        "general" | "person" | "institution" | "project"
    ) || (example.scope.kind != "general" && example.scope.value.trim().is_empty())
    {
        return Err(invalid("Specify the correction's applicability scope."));
    }
    admitted(workspace, WorkspaceWriteAction::Modify, |lease| {
        let mut examples = examples_impl(workspace)?;
        let source_id = example
            .source_session_id
            .as_deref()
            .ok_or_else(|| invalid("A saved source session is required."))?;
        let version_id = example
            .source_version_id
            .as_deref()
            .ok_or_else(|| invalid("A saved source version is required."))?;
        let version = version_impl(workspace, source_id, version_id)?;
        let source_session = load(workspace, source_id)?;
        let position = source_session
            .versions
            .iter()
            .position(|item| item.id == version_id)
            .ok_or_else(|| invalid("Version not found."))?;
        let after_present = version
            .draft
            .sources
            .iter()
            .any(|source| source.text.contains(&example.after));
        let before_present = version
            .draft
            .sources
            .iter()
            .any(|source| source.original_text.contains(&example.before))
            || source_session.versions[..=position].iter().any(|item| {
                item.draft
                    .sources
                    .iter()
                    .any(|source| source.text.contains(&example.before))
            })
            || version.draft.suggestions.iter().any(|item| {
                matches!(item.status.as_str(), "accepted" | "edited")
                    && item.before == example.before
                    && item.after == example.after
            });
        if !after_present || !before_present {
            return Err(invalid(
                "The correction does not occur in the referenced version and its original/history.",
            ));
        }
        if example.id.is_empty() {
            example.id = Uuid::new_v4().to_string();
        }
        safe_id(&example.id)?;
        if let Some(index) = examples.iter().position(|e| e.id == example.id) {
            if example.revision.is_none() || examples[index].revision != example.revision {
                return Err(conflict());
            }
            if examples[index].source_session_id != example.source_session_id
                || examples[index].source_version_id != example.source_version_id
            {
                return Err(invalid("Example provenance is immutable."));
            }
            example.revision = Some(Uuid::new_v4().to_string());
            examples[index] = example.clone();
        } else {
            let session_id = example
                .source_session_id
                .as_deref()
                .ok_or_else(|| invalid("Save a source version before promoting a correction."))?;
            let version_id = example
                .source_version_id
                .as_deref()
                .ok_or_else(|| invalid("A saved source version is required."))?;
            version_impl(workspace, session_id, version_id)?;
            example.revision = Some(Uuid::new_v4().to_string());
            examples.push(example.clone());
        }
        write_json(
            workspace,
            &examples_path(workspace)?,
            &examples,
            false,
            lease,
        )?;
        Ok(example)
    })
}

#[tauri::command]
pub async fn create_meeting_source_session(
    workspace: String,
    draft: SourceDraft,
    provider: Option<String>,
) -> Result<SourceSession, IpcError> {
    tauri::async_runtime::spawn_blocking(move || create_impl(&workspace, draft, provider))
        .await
        .map_err(io_error)?
}
#[tauri::command]
pub async fn import_meeting_source(
    workspace: String,
    session_id: Option<String>,
    input: MeetingSourceImportInput,
    expected_revision: Option<String>,
) -> Result<SourceSession, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(id) = session_id {
            import_impl(
                &workspace,
                &id,
                input,
                expected_revision
                    .as_deref()
                    .ok_or_else(|| invalid("Expected revision is required."))?,
            )
        } else {
            let source = prepare_import(&workspace, input)?;
            let draft = SourceDraft {
                title: Some(source.name.clone()),
                sources: vec![source],
                ..SourceDraft::default()
            };
            create_impl(&workspace, draft, None)
        }
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
pub async fn read_meeting_source_session(
    workspace: String,
    session_id: String,
) -> Result<SourceSession, IpcError> {
    tauri::async_runtime::spawn_blocking(move || load(&workspace, &session_id))
        .await
        .map_err(io_error)?
}
#[tauri::command]
pub async fn list_meeting_source_sessions(
    workspace: String,
) -> Result<Vec<SourceSession>, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = storage_root(&workspace)?;
        check_managed_path(&workspace, &root)?;
        if !root.exists() {
            return Ok(vec![]);
        }
        let mut sessions = vec![];
        for entry in fs::read_dir(root).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            if entry.file_type().map_err(io_error)?.is_dir()
                && entry.path().join("state.json").exists()
            {
                sessions.push(load(&workspace, &entry.file_name().to_string_lossy())?);
            }
        }
        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(sessions)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
pub async fn delete_meeting_source_session(
    workspace: String,
    session_id: String,
) -> Result<(), IpcError> {
    tauri::async_runtime::spawn_blocking(move || delete_impl(&workspace, &session_id))
        .await
        .map_err(io_error)?
}
#[tauri::command]
pub async fn save_meeting_source_draft(
    workspace: String,
    session_id: String,
    draft: Option<SourceDraft>,
    expected_revision: String,
    decision: Option<SourceSuggestionDecision>,
) -> Result<SourceSession, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(decision) = decision {
            decide_impl(&workspace, &session_id, decision, &expected_revision)
        } else {
            save_draft_impl(
                &workspace,
                &session_id,
                draft.ok_or_else(|| invalid("A draft is required."))?,
                &expected_revision,
            )
        }
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
pub async fn checkpoint_meeting_source(
    workspace: String,
    session_id: String,
    reason: String,
    expected_revision: String,
) -> Result<SourceVersion, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        checkpoint_impl(&workspace, &session_id, &reason, &expected_revision)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
pub async fn confirm_meeting_source(
    workspace: String,
    session_id: String,
    expected_revision: String,
) -> Result<SourceSession, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        confirm_impl(&workspace, &session_id, &expected_revision)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
pub async fn restore_meeting_source_version(
    workspace: String,
    session_id: String,
    version_id: String,
    expected_revision: String,
) -> Result<SourceSession, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        restore_impl(&workspace, &session_id, &version_id, &expected_revision)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
pub async fn read_meeting_source_version(
    workspace: String,
    session_id: String,
    version_id: String,
) -> Result<SourceVersion, IpcError> {
    tauri::async_runtime::spawn_blocking(move || version_impl(&workspace, &session_id, &version_id))
        .await
        .map_err(io_error)?
}
#[tauri::command]
pub async fn list_meeting_correction_examples(
    workspace: String,
) -> Result<Vec<CorrectionExample>, IpcError> {
    tauri::async_runtime::spawn_blocking(move || examples_impl(&workspace))
        .await
        .map_err(io_error)?
}
#[tauri::command]
pub async fn save_meeting_correction_example(
    workspace: String,
    example: CorrectionExample,
) -> Result<CorrectionExample, IpcError> {
    tauri::async_runtime::spawn_blocking(move || save_example_impl(&workspace, example))
        .await
        .map_err(io_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    fn workspace(tmp: &TempDir) -> String {
        tmp.path().to_string_lossy().into_owned()
    }
    fn draft(text: &str) -> SourceDraft {
        SourceDraft {
            title: Some("협력 회의".into()),
            sources: vec![MeetingSource {
                id: "source-one".into(),
                name: "meeting-note.md".into(),
                kind: "note".into(),
                original_text: text.into(),
                text: text.into(),
                original_hash: String::new(),
                imported_at: None,
                original_path: None,
            }],
            ..SourceDraft::default()
        }
    }
    fn ready(work: &str, session: &SourceSession) -> SourceSession {
        let mut draft = session.draft.clone();
        draft.participants_reviewed = true;
        draft.note_reviewed = true;
        let saved = save_draft_impl(work, &session.id, draft, &session.revision).unwrap();
        confirm_impl(work, &saved.id, &saved.revision).unwrap()
    }
    fn reference(session: &SourceSession) -> ReviewedSourceReference {
        let id = session.confirmed_version_id.clone().unwrap();
        let version = session.versions.iter().find(|v| v.id == id).unwrap();
        ReviewedSourceReference {
            session_id: session.id.clone(),
            version_id: id,
            content_hash: version.content_hash.clone(),
        }
    }
    #[test]
    fn originals_are_exact_immutable_and_survive_restart() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let original = "# 회의\r\n이영중 검토\r\n\n";
        let session = create_impl(&work, draft(original), Some("external".into())).unwrap();
        assert_eq!(
            session.draft.sources[0].original_hash,
            hash(original.as_bytes())
        );
        let mut corrected = session.draft.clone();
        corrected.sources[0].text = "# 회의\n이영준 검토".into();
        let saved = save_draft_impl(&work, &session.id, corrected, &session.revision).unwrap();
        let reopened = load(&work, &session.id).unwrap();
        assert_eq!(reopened, saved);
        assert_eq!(reopened.draft.sources[0].original_text, original);
        let mut tampered = reopened.draft.clone();
        tampered.sources[0].original_text = "rewrite".into();
        assert!(save_draft_impl(&work, &session.id, tampered, &saved.revision).is_err());
        assert_eq!(load(&work, &session.id).unwrap(), reopened);
    }
    #[test]
    fn concurrent_drafts_serialize_and_reject_stale_revision() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let session = create_impl(&work, draft("원문"), None).unwrap();
        let a = session.clone();
        let b = session.clone();
        let wa = work.clone();
        let wb = work.clone();
        let first = std::thread::spawn(move || {
            let mut d = a.draft;
            d.context = Some("first".into());
            save_draft_impl(&wa, &a.id, d, &a.revision)
        });
        let second = std::thread::spawn(move || {
            let mut d = b.draft;
            d.context = Some("second".into());
            save_draft_impl(&wb, &b.id, d, &b.revision)
        });
        let results = [first.join().unwrap(), second.join().unwrap()];
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results.iter().find_map(|r| r.as_ref().err()).unwrap().code,
            MEETING_SOURCE_REVISION_CONFLICT
        );
    }
    #[test]
    fn confirmation_requires_review_and_pins_full_context() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let session = create_impl(&work, draft("요약만 있는 회의록"), None).unwrap();
        assert!(confirm_impl(&work, &session.id, &session.revision).is_err());
        let confirmed = ready(&work, &session);
        let pin = reference(&confirmed);
        assert!(validate_reviewed_source(&work, &pin).is_ok());
        let noop = save_draft_impl(
            &work,
            &confirmed.id,
            confirmed.draft.clone(),
            &confirmed.revision,
        )
        .unwrap();
        assert_eq!(noop.revision, confirmed.revision);
        assert_eq!(noop.confirmed_version_id, confirmed.confirmed_version_id);
        let mut changed = confirmed.draft.clone();
        changed.context = Some("다른 역할로 참석".into());
        let saved = save_draft_impl(&work, &confirmed.id, changed, &confirmed.revision).unwrap();
        assert!(saved.confirmed_version_id.is_none());
        assert!(validate_reviewed_source(&work, &pin).is_err());
        let reconfirmed = confirm_impl(&work, &saved.id, &saved.revision).unwrap();
        assert_ne!(pin.content_hash, reference(&reconfirmed).content_hash);
    }
    #[test]
    fn required_findings_allow_explicit_uncertainty() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let session = create_impl(&work, draft("담당자 미확인"), None).unwrap();
        let mut d = session.draft.clone();
        d.note_reviewed = true;
        d.participants_reviewed = true;
        d.suggestions.push(SourceSuggestion {
            id: "question".into(),
            source_id: "source-one".into(),
            before: "담당자".into(),
            after: "담당자".into(),
            reason: "담당자 확인 필요".into(),
            category: "owner".into(),
            evidence: String::new(),
            status: "pending".into(),
            required: true,
            base_revision: session.revision.clone(),
            run_id: None,
            base_text_hash: None,
            evidence_source_id: None,
            evidence_quote: None,
            context_hash: None,
        });
        let pending = save_draft_impl(&work, &session.id, d, &session.revision).unwrap();
        assert!(confirm_impl(&work, &pending.id, &pending.revision).is_err());
        let pending = decide_impl(
            &work,
            &pending.id,
            SourceSuggestionDecision {
                id: "question".into(),
                status: "uncertain".into(),
                replacement: None,
            },
            &pending.revision,
        )
        .unwrap();
        let mut d = pending.draft.clone();
        d.note_reviewed = true;
        d.participants.push(Participant {
            id: "unknown".into(),
            name: "화자 1 (미확인)".into(),
            affiliation: None,
            title: None,
            role: None,
            speaker_labels: vec!["화자 1".into()],
            attendance: "attendee".into(),
            status: "uncertain".into(),
            reference: None,
        });
        let acknowledged = save_draft_impl(&work, &pending.id, d, &pending.revision).unwrap();
        assert!(confirm_impl(&work, &acknowledged.id, &acknowledged.revision).is_ok());
    }
    #[test]
    fn checkpoints_retry_without_duplicates_and_restore_full_context() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let session = create_impl(&work, draft("원문"), None).unwrap();
        let version = checkpoint_impl(&work, &session.id, "첫 검토", &session.revision).unwrap();
        let retry = checkpoint_impl(&work, &session.id, "첫 검토", &session.revision).unwrap();
        assert_eq!(version.id, retry.id);
        let latest = load(&work, &session.id).unwrap();
        assert_eq!(latest.versions.len(), 1);
        let mut d = latest.draft.clone();
        d.sources[0].text = "수정본".into();
        d.context = Some("수정된 맥락".into());
        let saved = save_draft_impl(&work, &latest.id, d, &latest.revision).unwrap();
        let restored = restore_impl(&work, &saved.id, &version.id, &saved.revision).unwrap();
        assert_eq!(restored.draft.sources[0].text, "원문");
        assert!(restored.draft.context.is_none());
        assert_eq!(restored.versions.len(), 2);
        assert!(restored.confirmed_version_id.is_none());
        assert_eq!(
            version_impl(&work, &session.id, &version.id).unwrap(),
            version
        );
    }
    #[test]
    fn import_bounds_utf8_paths_and_optional_transcript() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let session = create_impl(&work, draft("외부 요약"), None).unwrap();
        let file = tmp.path().join("reference.txt");
        fs::write(&file, "화자 1: 검토\r\n").unwrap();
        let with_transcript = import_impl(
            &work,
            &session.id,
            MeetingSourceImportInput {
                name: "reference".into(),
                kind: "transcript".into(),
                text: None,
                path: Some(file.to_string_lossy().into()),
            },
            &session.revision,
        )
        .unwrap();
        assert_eq!(with_transcript.draft.sources.len(), 2);
        fs::write(&file, [255, 254]).unwrap();
        assert!(import_impl(
            &work,
            &session.id,
            MeetingSourceImportInput {
                name: "bad".into(),
                kind: "transcript".into(),
                text: None,
                path: Some(file.to_string_lossy().into())
            },
            &with_transcript.revision
        )
        .is_err());
        assert!(create_impl(&work, draft(&"x".repeat(MAX_BYTES + 1)), None).is_err());
        assert!(load(&work, "../escape").is_err());
        let mut bad = draft("원문");
        bad.sources[0].id = "../escape".into();
        assert!(create_impl(&work, bad, None).is_err());
        let reopened = load(&work, &session.id).unwrap();
        assert_eq!(reopened.draft.sources[1].original_text, "화자 1: 검토\r\n");
    }
    #[cfg(unix)]
    #[test]
    fn workspace_alias_allowed_but_managed_symlinks_rejected() {
        let tmp = TempDir::new().unwrap();
        let alias_root = TempDir::new().unwrap();
        let alias = alias_root.path().join("work");
        std::os::unix::fs::symlink(tmp.path(), &alias).unwrap();
        let work = alias.to_string_lossy();
        let session = create_impl(&work, draft("원문"), None).unwrap();
        assert!(load(&work, &session.id).is_ok());
        let outside = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), other.path().join(".maru")).unwrap();
        assert!(create_impl(&workspace(&other), draft("원문"), None).is_err());
        assert!(!outside.path().join("meetings").exists());
    }
    #[test]
    fn examples_are_explicit_scoped_revision_checked_and_durable() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let session = create_impl(&work, draft("이영중"), None).unwrap();
        let mut corrected = session.draft.clone();
        corrected.sources[0].text = "이영준".into();
        let session = save_draft_impl(&work, &session.id, corrected, &session.revision).unwrap();
        let version = checkpoint_impl(&work, &session.id, "인명 확인", &session.revision).unwrap();
        let example = CorrectionExample {
            id: String::new(),
            revision: None,
            before: "이영중".into(),
            after: "이영준".into(),
            reason: "참석자가 확인한 이름".into(),
            scope: CorrectionScope {
                kind: "person".into(),
                value: "이영준".into(),
            },
            enabled: true,
            source_session_id: Some(session.id),
            source_version_id: Some(version.id),
        };
        let saved = save_example_impl(&work, example).unwrap();
        assert_eq!(examples_impl(&work).unwrap(), vec![saved.clone()]);
        let mut disabled = saved.clone();
        disabled.enabled = false;
        let next = save_example_impl(&work, disabled).unwrap();
        assert!(!next.enabled);
        assert_eq!(
            save_example_impl(&work, saved).unwrap_err().code,
            MEETING_SOURCE_REVISION_CONFLICT
        );
    }
    #[test]
    fn delete_removes_the_session_directory_and_rejects_unknown_ids() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let session = create_impl(&work, draft("원문"), None).unwrap();
        assert!(session_dir(&work, &session.id).unwrap().exists());
        delete_impl(&work, &session.id).unwrap();
        assert!(!session_dir(&work, &session.id).unwrap().exists());
        assert!(load(&work, &session.id).is_err());
        assert!(delete_impl(&work, &session.id).is_err());
        assert!(delete_impl(&work, "../escape").is_err());
        let other = create_impl(&work, draft("다른 회의"), None).unwrap();
        delete_impl(&work, &other.id).unwrap();
        assert!(!session_dir(&work, &other.id).unwrap().exists());
    }
    #[test]
    fn blank_note_sessions_are_allowed_and_editable() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let session = create_impl(&work, draft(""), None).unwrap();
        let reopened = load(&work, &session.id).unwrap();
        assert_eq!(reopened.draft.sources[0].text, "");
        let mut d = reopened.draft.clone();
        d.sources[0].text = "나중에 작성한 내용".into();
        let saved = save_draft_impl(&work, &session.id, d, &reopened.revision).unwrap();
        assert_eq!(saved.draft.sources[0].text, "나중에 작성한 내용");
    }
    #[test]
    fn confirmation_requires_nonempty_source_text() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let session = create_impl(&work, draft(""), None).unwrap();
        let mut d = session.draft.clone();
        d.participants_reviewed = true;
        d.note_reviewed = true;
        let reviewed = save_draft_impl(&work, &session.id, d, &session.revision).unwrap();
        assert!(confirm_impl(&work, &reviewed.id, &reviewed.revision).is_err());
        let mut filled = reviewed.draft.clone();
        filled.sources[0].text = "작성된 회의록".into();
        let filled = save_draft_impl(&work, &reviewed.id, filled, &reviewed.revision).unwrap();
        let confirmed = confirm_impl(&work, &filled.id, &filled.revision).unwrap();
        assert!(confirmed.confirmed_version_id.is_some());
    }
    #[test]
    fn all_ipc_wrappers_complete_the_native_source_workflow() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        tauri::async_runtime::block_on(async {
            let session = create_meeting_source_session(work.clone(), draft("회의록"), None)
                .await
                .unwrap();
            assert_eq!(
                list_meeting_source_sessions(work.clone())
                    .await
                    .unwrap()
                    .len(),
                1
            );
            let mut d = session.draft.clone();
            d.participants_reviewed = true;
            d.note_reviewed = true;
            let saved = save_meeting_source_draft(
                work.clone(),
                session.id.clone(),
                Some(d),
                session.revision,
                None,
            )
            .await
            .unwrap();
            let version = checkpoint_meeting_source(
                work.clone(),
                saved.id.clone(),
                "검토".into(),
                saved.revision,
            )
            .await
            .unwrap();
            assert_eq!(
                read_meeting_source_version(work.clone(), saved.id.clone(), version.id)
                    .await
                    .unwrap()
                    .reason,
                "검토"
            );
            let latest = read_meeting_source_session(work.clone(), saved.id.clone())
                .await
                .unwrap();
            let confirmed =
                confirm_meeting_source(work.clone(), latest.id.clone(), latest.revision)
                    .await
                    .unwrap();
            assert!(confirmed.confirmed_version_id.is_some());
            assert!(list_meeting_correction_examples(work)
                .await
                .unwrap()
                .is_empty());
        });
    }
    fn reviewed_run(work: &str, session: &SourceSession, run_id: &str) {
        crate::agent_host::event_store::append_run_event_payload(work, run_id, "run.started", "test", serde_json::json!({
            "request": { "metadata": { "origin": "meetingNotesExternalRefine", "provenanceRequired": true, "reviewedSource": reference(session) } }
        })).unwrap();
    }
    fn note_proposal(path: &str, operation: &str) -> crate::agent_host::proposal::SkillProposal {
        crate::agent_host::proposal::SkillProposal {
            schema_version: crate::agent_host::contracts::SKILL_PROPOSAL_SCHEMA_VERSION.into(),
            summary: "Reviewed note".into(),
            files: vec![crate::agent_host::proposal::SkillProposalFile {
                path: path.into(),
                operation: operation.into(),
                content: Some("검토한 최종 회의록\n".into()),
                expected_hash: None,
                diff: None,
            }],
            commands: vec![],
            risks: vec![],
            requires_approval: true,
        }
    }
    #[test]
    fn final_application_pins_review_and_records_links_without_invalidating_the_editor() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let initial = create_impl(&work, draft("외부 원문"), None).unwrap();
        let session = ready(&work, &initial);
        reviewed_run(&work, &session, "source-apply");
        crate::agent_host::proposal::apply_skill_proposal(
            &work,
            &note_proposal("final.md", "create"),
            Some("source-apply"),
        )
        .unwrap();
        let linked = load(&work, &session.id).unwrap();
        assert_eq!(linked.revision, session.revision);
        assert!(linked
            .output_links
            .iter()
            .any(|path| path.ends_with("final.md")));
        let mut changed = linked.draft.clone();
        changed.context = Some("회의 역할 변경".into());
        save_draft_impl(&work, &linked.id, changed, &linked.revision).unwrap();
        assert!(crate::agent_host::proposal::apply_skill_proposal(
            &work,
            &note_proposal("stale.md", "create"),
            Some("source-apply")
        )
        .is_err());
        assert!(!tmp.path().join("stale.md").exists());
    }
    #[cfg(unix)]
    #[test]
    fn provenance_failure_rolls_back_the_just_written_note() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let initial = create_impl(&work, draft("외부 원문"), None).unwrap();
        let session = ready(&work, &initial);
        reviewed_run(&work, &session, "source-rollback");
        let dir = session_dir(&work, &session.id).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        let result = crate::agent_host::proposal::apply_skill_proposal(
            &work,
            &note_proposal("rollback.md", "create"),
            Some("source-rollback"),
        );
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.unwrap_err().contains("output rolled back"));
        assert!(!tmp.path().join("rollback.md").exists());
        assert!(load(&work, &session.id).unwrap().output_links.is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn interrupted_checkpoint_keeps_current_state_and_reuses_the_immutable_record() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let initial = create_impl(&work, draft("원문"), None).unwrap();
        checkpoint_impl(&work, &initial.id, "initial", &initial.revision).unwrap();
        let session = load(&work, &initial.id).unwrap();
        let dir = session_dir(&work, &session.id).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        let failed = checkpoint_impl(&work, &session.id, "second", &session.revision);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(failed.is_err());
        assert_eq!(load(&work, &session.id).unwrap().revision, session.revision);
        let orphan_count = fs::read_dir(dir.join("revisions")).unwrap().count();
        assert_eq!(orphan_count, 2);
        checkpoint_impl(&work, &session.id, "second", &session.revision).unwrap();
        assert_eq!(fs::read_dir(dir.join("revisions")).unwrap().count(), 2);
        assert_eq!(load(&work, &session.id).unwrap().versions.len(), 2);
    }
    #[test]
    fn native_correction_decisions_reject_stale_context_and_forged_audit_updates() {
        let tmp = TempDir::new().unwrap();
        let work = workspace(&tmp);
        let session = create_impl(&work, draft("이영중 검토"), None).unwrap();
        let mut d = session.draft.clone();
        d.suggestions.push(SourceSuggestion {
            id: "fix-name".into(),
            source_id: "source-one".into(),
            before: "이영중".into(),
            after: "이영준".into(),
            reason: "이름 확인".into(),
            category: "person".into(),
            evidence: "참석자 확인".into(),
            status: "pending".into(),
            required: true,
            base_revision: session.revision.clone(),
            run_id: None,
            base_text_hash: None,
            evidence_source_id: None,
            evidence_quote: None,
            context_hash: None,
        });
        let proposed = save_draft_impl(&work, &session.id, d, &session.revision).unwrap();
        let mut forged = proposed.draft.clone();
        forged.suggestions[0].status = "accepted".into();
        assert!(save_draft_impl(&work, &proposed.id, forged, &proposed.revision).is_err());
        let accepted = decide_impl(
            &work,
            &proposed.id,
            SourceSuggestionDecision {
                id: "fix-name".into(),
                status: "accepted".into(),
                replacement: None,
            },
            &proposed.revision,
        )
        .unwrap();
        assert_eq!(accepted.draft.sources[0].text, "이영준 검토");
        assert_eq!(accepted.draft.sources[0].original_text, "이영중 검토");
        let fresh = create_impl(&work, draft("이영중 검토"), None).unwrap();
        let mut d = fresh.draft.clone();
        let mut suggestion = proposed.draft.suggestions[0].clone();
        suggestion.base_revision = fresh.revision.clone();
        d.suggestions.push(suggestion);
        let proposed = save_draft_impl(&work, &fresh.id, d, &fresh.revision).unwrap();
        let mut d = proposed.draft.clone();
        d.context = Some("동명이인 다른 회의".into());
        let changed = save_draft_impl(&work, &fresh.id, d, &proposed.revision).unwrap();
        assert!(decide_impl(
            &work,
            &fresh.id,
            SourceSuggestionDecision {
                id: "fix-name".into(),
                status: "accepted".into(),
                replacement: None
            },
            &changed.revision
        )
        .is_err());
    }
}
