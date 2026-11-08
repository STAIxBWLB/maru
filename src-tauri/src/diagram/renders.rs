//! Immutable, receipt-bound diagram renders stored beside report assets.
//!
//! Paths are derived only from validated document/render IDs. Artifact names
//! are fixed by the receipt MIME type, and the asset protocol receives one
//! verified file at a time.

use crate::archify::{ArchifyRenderArtifact, ArchifyRenderReceipt};
use crate::atomic_file::{
    with_path_transactions, write_atomic_create, PathTransactionLease, PathTransactionRequest,
};
use crate::vault::{lexical_normalize, normalize_existing_dir};
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;
use uuid::Uuid;

const RENDER_ROOT: &str = "attachments/diagrams";
const DIAGRAMS_ROOT: &str = "diagrams";
const DIAGRAM_SUFFIX: &str = ".cmd.json";
const RENDERS_DIR: &str = "renders";
const RECEIPT_FILE: &str = "receipt.json";
const HTML_FILE: &str = "index.html";
const SVG_FILE: &str = "index.svg";
const PNG_FILE: &str = "index.png";
const MAX_DOCUMENTS: usize = 5_000;
const MAX_RENDER_GROUPS: usize = 5_000;
const MAX_RENDERS_PER_WORKSPACE: usize = 20_000;
const MAX_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_RECEIPT_BYTES: u64 = 512 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 24 * 1024 * 1024;
const MAX_DISPLAY_NAME_BYTES: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderDocumentContext {
    pub(crate) doc_id: String,
    pub(crate) document_name: String,
    pub(crate) document_revision: String,
    pub(crate) diagram_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) dataset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramRenderReceipt {
    #[serde(flatten)]
    pub render: ArchifyRenderReceipt,
    pub doc_id: String,
    pub document_name: String,
    pub document_revision: String,
    pub rendered_at: String,
    pub diagram_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredRender {
    pub render_id: String,
    pub artifact_name: String,
    pub receipt: DiagramRenderReceipt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderEntry {
    pub doc_id: String,
    pub render_id: String,
    pub receipt: Option<DiagramRenderReceipt>,
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderGroup {
    pub doc_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_name: Option<String>,
    pub orphaned: bool,
    pub renders: Vec<RenderEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderView {
    pub path: String,
    pub mime_type: String,
    pub receipt: DiagramRenderReceipt,
}

#[derive(Debug, Clone)]
struct DocumentIdentity {
    name: String,
}

fn operation_error(
    action: &str,
    workspace: &Path,
    path: &Path,
    cause: impl std::fmt::Display,
    next: &str,
) -> String {
    let shown = path
        .strip_prefix(workspace)
        .map(|relative| relative.to_string_lossy().to_string())
        .unwrap_or_else(|_| "workspace render store".to_string());
    format!("Cannot {action} {shown}: {cause}; {next}")
}

fn validate_doc_id(doc_id: &str) -> Result<&str, String> {
    if doc_id.is_empty()
        || doc_id.len() > 160
        || doc_id.starts_with('.')
        || doc_id.contains("..")
        || !doc_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Invalid diagram document ID; select a saved diagram and retry".into());
    }
    Ok(doc_id)
}

fn validate_render_id(render_id: &str) -> Result<&str, String> {
    if render_id.len() != 32
        || !render_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Invalid render ID; refresh the Renders list and retry".into());
    }
    Ok(render_id)
}

fn validate_diagram_type(diagram_type: &str) -> Result<(), String> {
    if matches!(
        diagram_type,
        "architecture" | "workflow" | "sequence" | "dataflow" | "lifecycle"
    ) {
        Ok(())
    } else {
        Err("Unsupported diagram type in render receipt; regenerate from a supported semantic diagram".into())
    }
}

fn validate_display_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_DISPLAY_NAME_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return Err("Render document name is empty, too long, or contains control characters; save the diagram with a shorter title".into());
    }
    Ok(trimmed.to_string())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn artifact_for_mime(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "text/html" => Some(HTML_FILE),
        "image/svg+xml" => Some(SVG_FILE),
        "image/png" => Some(PNG_FILE),
        _ => None,
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_base_receipt(receipt: &ArchifyRenderReceipt) -> Result<&'static str, String> {
    if receipt.schema_version != 1 {
        return Err("Render receipt schema is unsupported; regenerate the render with the current Maru version".into());
    }
    if receipt.engine_pin.name != "archify"
        || receipt.engine_pin.version.trim().is_empty()
        || receipt.engine_pin.revision.trim().is_empty()
    {
        return Err("Render receipt engine identity is incomplete; regenerate the render with the pinned Archify engine".into());
    }
    if !valid_sha256(&receipt.input_spec_sha256) || !valid_sha256(&receipt.output_sha256) {
        return Err(
            "Render receipt contains an invalid SHA-256 value; regenerate the render and receipt"
                .into(),
        );
    }
    if receipt.gates.schema.status != "passed" || receipt.gates.artifact.status != "passed" {
        return Err("Render receipt is missing a passed schema or artifact gate; regenerate the render before viewing it".into());
    }
    let Some(artifact_name) = artifact_for_mime(&receipt.output_mime_type) else {
        return Err(
            "Render receipt MIME type is unsupported; use an HTML, SVG, or PNG render".into(),
        );
    };
    Ok(artifact_name)
}

fn validate_extended_receipt(receipt: &DiagramRenderReceipt) -> Result<&'static str, String> {
    validate_doc_id(&receipt.doc_id)?;
    validate_display_name(&receipt.document_name)?;
    validate_diagram_type(&receipt.diagram_type)?;
    if receipt
        .dataset_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
    {
        return Err("Render source dataset ID is invalid; select a semantic dataset in Export and render again".into());
    }
    if !valid_sha256(&receipt.document_revision) {
        return Err(
            "Render receipt document revision is invalid; reload the saved diagram and rerender it"
                .into(),
        );
    }
    if receipt.rendered_at.trim().is_empty()
        || receipt.rendered_at.len() > 96
        || receipt.rendered_at.chars().any(char::is_control)
    {
        return Err(
            "Render receipt timestamp is invalid; rerender the diagram to create a valid receipt"
                .into(),
        );
    }
    validate_base_receipt(&receipt.render)
}

fn extended_receipt(
    context: &RenderDocumentContext,
    receipt: ArchifyRenderReceipt,
) -> Result<DiagramRenderReceipt, String> {
    validate_doc_id(&context.doc_id)?;
    validate_diagram_type(&context.diagram_type)?;
    if !valid_sha256(&context.document_revision) {
        return Err(
            "Document revision is not a SHA-256 value; reload the saved diagram and retry".into(),
        );
    }
    validate_base_receipt(&receipt)?;
    let extended = DiagramRenderReceipt {
        render: receipt,
        doc_id: context.doc_id.clone(),
        document_name: validate_display_name(&context.document_name)?,
        document_revision: context.document_revision.clone(),
        rendered_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        diagram_type: context.diagram_type.clone(),
        dataset_id: context.dataset_id.clone(),
    };
    validate_extended_receipt(&extended)?;
    Ok(extended)
}

fn render_directory(workspace: &Path, doc_id: &str, render_id: &str) -> Result<PathBuf, String> {
    validate_doc_id(doc_id)?;
    validate_render_id(render_id)?;
    let path = lexical_normalize(
        &workspace
            .join(RENDER_ROOT)
            .join(doc_id)
            .join(RENDERS_DIR)
            .join(render_id),
    );
    if !path.starts_with(workspace) {
        return Err("Render path escapes the workspace; refresh the diagram and retry".into());
    }
    Ok(path)
}

fn ensure_directory_chain(
    workspace: &Path,
    target: &Path,
    create: Option<&PathTransactionLease>,
) -> Result<bool, String> {
    if !target.starts_with(workspace) {
        return Err(
            "Render directory escapes the workspace; choose a valid diagram and retry".into(),
        );
    }
    let relative = target.strip_prefix(workspace).map_err(|error| {
        operation_error(
            "resolve render directory",
            workspace,
            target,
            error,
            "refresh the workspace and retry",
        )
    })?;
    let mut current = workspace.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(operation_error(
                "resolve render directory",
                workspace,
                target,
                "path contains a non-normal component",
                "refresh the render list and retry",
            ));
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(operation_error(
                    "use render directory",
                    workspace,
                    &current,
                    "a symlink is present in the render store",
                    "remove the symlink and restore the render directory before retrying",
                ));
            }
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(operation_error(
                    "use render directory",
                    workspace,
                    &current,
                    "a path component is not a directory",
                    "repair the render store and retry",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(lease) = create else {
                    return Ok(false);
                };
                lease.ensure_covered([current.clone()])?;
                lease.before_effect()?;
                match fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(create_error)
                        if create_error.kind() == std::io::ErrorKind::AlreadyExists =>
                    {
                        let metadata =
                            fs::symlink_metadata(&current).map_err(|metadata_error| {
                                operation_error(
                                    "verify render directory",
                                    workspace,
                                    &current,
                                    metadata_error,
                                    "repair the render store and retry",
                                )
                            })?;
                        if metadata.file_type().is_symlink() || !metadata.is_dir() {
                            return Err(operation_error(
                                "create render directory",
                                workspace,
                                &current,
                                "a concurrent creator installed a non-directory path",
                                "repair the render store and retry",
                            ));
                        }
                    }
                    Err(create_error) => {
                        return Err(operation_error(
                            "create render directory",
                            workspace,
                            &current,
                            create_error,
                            "check workspace permissions and retry",
                        ));
                    }
                }
            }

            Err(error) => {
                return Err(operation_error(
                    "inspect render directory",
                    workspace,
                    &current,
                    error,
                    "repair workspace permissions and retry",
                ));
            }
        }
    }
    let canonical = target.canonicalize().map_err(|error| {
        operation_error(
            "resolve render directory",
            workspace,
            target,
            error,
            "repair the render store and retry",
        )
    })?;
    if !canonical.starts_with(workspace) {
        return Err(operation_error(
            "use render directory",
            workspace,
            target,
            "canonical path escapes the workspace",
            "repair the render store and retry",
        ));
    }
    Ok(true)
}

fn ensure_regular_file(workspace: &Path, path: &Path) -> Result<bool, String> {
    if !path.starts_with(workspace) {
        return Err(
            "Render artifact path escapes the workspace; refresh the Renders list and retry".into(),
        );
    }
    let parent = path.parent().ok_or_else(|| {
        operation_error(
            "resolve render artifact",
            workspace,
            path,
            "file has no parent directory",
            "refresh the Renders list and retry",
        )
    })?;
    if !ensure_directory_chain(workspace, parent, None)? {
        return Ok(false);
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(operation_error(
                "inspect render artifact",
                workspace,
                path,
                error,
                "repair file permissions and retry",
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(operation_error(
            "use render artifact",
            workspace,
            path,
            "artifact is a symlink or non-file",
            "restore a regular artifact file before retrying",
        ));
    }
    if !path
        .canonicalize()
        .map_err(|error| {
            operation_error(
                "resolve render artifact",
                workspace,
                path,
                error,
                "repair the render store and retry",
            )
        })?
        .starts_with(workspace)
    {
        return Err(operation_error(
            "use render artifact",
            workspace,
            path,
            "canonical artifact escapes the workspace",
            "repair the render store and retry",
        ));
    }
    Ok(true)
}

fn read_bounded_file(workspace: &Path, path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    if !ensure_regular_file(workspace, path)? {
        return Err(operation_error(
            "read render file",
            workspace,
            path,
            "file is missing",
            "restore the file or rerender the diagram",
        ));
    }
    let mut file = File::open(path).map_err(|error| {
        operation_error(
            "open render file",
            workspace,
            path,
            error,
            "check file permissions and retry",
        )
    })?;
    let canonical = path.canonicalize().map_err(|error| {
        operation_error(
            "resolve render file",
            workspace,
            path,
            error,
            "repair the render store and retry",
        )
    })?;
    if !canonical.starts_with(workspace) {
        return Err(operation_error(
            "read render file",
            workspace,
            path,
            "canonical file escapes the workspace",
            "repair the render store and retry",
        ));
    }
    let metadata = file.metadata().map_err(|error| {
        operation_error(
            "inspect render file",
            workspace,
            path,
            error,
            "check file permissions and retry",
        )
    })?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(operation_error(
            "read render file",
            workspace,
            path,
            format!("file is not regular or exceeds the {limit}-byte limit"),
            "restore a valid bounded render file or rerender the diagram",
        ));
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            operation_error(
                "read render file",
                workspace,
                path,
                error,
                "check file permissions and retry",
            )
        })?;
    if bytes.len() as u64 > limit {
        return Err(operation_error(
            "read render file",
            workspace,
            path,
            format!("file grew beyond the {limit}-byte limit while reading"),
            "restore a valid bounded render file or rerender the diagram",
        ));
    }
    Ok(bytes)
}

fn parse_document_index(workspace: &Path) -> Result<HashMap<String, DocumentIdentity>, String> {
    let diagrams = workspace.join(DIAGRAMS_ROOT);
    if !ensure_directory_chain(workspace, &diagrams, None)? {
        return Ok(HashMap::new());
    }
    let entries = fs::read_dir(&diagrams).map_err(|error| {
        operation_error(
            "list diagram documents",
            workspace,
            &diagrams,
            error,
            "repair the diagrams folder and retry",
        )
    })?;
    let mut documents = HashMap::new();
    let mut count = 0usize;
    for entry in entries {
        count += 1;
        if count > MAX_DOCUMENTS {
            return Err(operation_error(
                "list diagram documents",
                workspace,
                &diagrams,
                "the folder exceeds the document scan limit",
                "remove unrelated entries from the diagrams folder and retry",
            ));
        }
        let entry = entry.map_err(|error| {
            operation_error(
                "read diagram entry",
                workspace,
                &diagrams,
                error,
                "repair folder permissions and retry",
            )
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(document_name) = name.strip_suffix(DIAGRAM_SUFFIX) else {
            continue;
        };
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            operation_error(
                "inspect diagram document",
                workspace,
                &path,
                error,
                "repair the file and retry",
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(operation_error(
                "read diagram document",
                workspace,
                &path,
                "document path is a symlink",
                "restore a regular diagram document before listing its renders",
            ));
        }
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() > MAX_DOCUMENT_BYTES {
            return Err(operation_error(
                "read diagram document",
                workspace,
                &path,
                format!("document exceeds the {MAX_DOCUMENT_BYTES}-byte scan limit"),
                "reduce or repair the diagram document before listing renders",
            ));
        }
        let bytes = read_bounded_file(workspace, &path, MAX_DOCUMENT_BYTES)?;
        let parsed: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let Some(id) = parsed.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if validate_doc_id(id).is_err() {
            continue;
        }
        if documents
            .insert(
                id.to_string(),
                DocumentIdentity {
                    name: document_name.to_string(),
                },
            )
            .is_some()
        {
            return Err(operation_error(
                "match diagram document IDs",
                workspace,
                &path,
                "multiple saved documents share one ID",
                "repair the duplicate diagram IDs before listing renders",
            ));
        }
    }
    Ok(documents)
}

fn receipt_path(render_dir: &Path) -> PathBuf {
    render_dir.join(RECEIPT_FILE)
}

fn artifact_path(render_dir: &Path, name: &str) -> PathBuf {
    render_dir.join(name)
}

fn unverified_entry(
    doc_id: &str,
    render_id: &str,
    receipt: Option<DiagramRenderReceipt>,
    artifact_name: Option<String>,
    diagnostic: impl Into<String>,
) -> RenderEntry {
    RenderEntry {
        doc_id: doc_id.to_string(),
        render_id: render_id.to_string(),
        receipt,
        verified: false,
        diagnostic: Some(diagnostic.into()),
        artifact_name,
    }
}

fn inspect_render(workspace: &Path, doc_id: &str, render_id: &str) -> Result<RenderEntry, String> {
    let dir = render_directory(workspace, doc_id, render_id)?;
    if !ensure_directory_chain(workspace, &dir, None)? {
        return Ok(unverified_entry(
            doc_id,
            render_id,
            None,
            None,
            "render folder is missing; restore it or rerender the diagram",
        ));
    }
    let receipt_path = receipt_path(&dir);
    if !ensure_regular_file(workspace, &receipt_path).unwrap_or(false) {
        return Ok(unverified_entry(
            doc_id,
            render_id,
            None,
            None,
            "receipt is missing or unsafe; rerender the diagram to create a new verified receipt",
        ));
    }
    let receipt_bytes = match read_bounded_file(workspace, &receipt_path, MAX_RECEIPT_BYTES) {
        Ok(bytes) => bytes,
        Err(error) => return Ok(unverified_entry(doc_id, render_id, None, None, error)),
    };
    let receipt: DiagramRenderReceipt = match serde_json::from_slice(&receipt_bytes) {
        Ok(receipt) => receipt,
        Err(error) => {
            return Ok(unverified_entry(
                doc_id,
                render_id,
                None,
                None,
                format!("receipt JSON is invalid ({error}); rerender the diagram to repair it"),
            ))
        }
    };
    if receipt.doc_id != doc_id {
        return Ok(unverified_entry(
            doc_id,
            render_id,
            Some(receipt),
            None,
            "receipt document ID does not match its folder; restore the original render folder",
        ));
    }
    let artifact_name = match validate_extended_receipt(&receipt) {
        Ok(name) => name,
        Err(error) => {
            return Ok(unverified_entry(
                doc_id,
                render_id,
                Some(receipt),
                None,
                error,
            ))
        }
    };
    let path = artifact_path(&dir, artifact_name);
    let bytes = match read_bounded_file(workspace, &path, MAX_ARTIFACT_BYTES) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Ok(unverified_entry(
                doc_id,
                render_id,
                Some(receipt),
                Some(artifact_name.into()),
                error,
            ))
        }
    };
    if sha256(&bytes) != receipt.render.output_sha256 {
        return Ok(unverified_entry(
            doc_id,
            render_id,
            Some(receipt),
            Some(artifact_name.into()),
            "artifact bytes do not match the receipt hash; rerender the diagram before viewing",
        ));
    }
    Ok(RenderEntry {
        doc_id: doc_id.to_string(),
        render_id: render_id.to_string(),
        receipt: Some(receipt),
        verified: true,
        diagnostic: None,
        artifact_name: Some(artifact_name.into()),
    })
}

fn list_child_directories(workspace: &Path, path: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    if !ensure_directory_chain(workspace, path, None)? {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(path).map_err(|error| {
        operation_error(
            "list render folders",
            workspace,
            path,
            error,
            "repair folder permissions and retry",
        )
    })?;
    let mut result = Vec::new();
    let mut scanned = 0usize;
    for entry in entries {
        scanned += 1;
        if scanned > MAX_RENDER_GROUPS {
            return Err(operation_error(
                "list render folders",
                workspace,
                path,
                "the folder exceeds the scan limit",
                "remove stale folders and retry",
            ));
        }
        let entry = entry.map_err(|error| {
            operation_error(
                "read render folder entry",
                workspace,
                path,
                error,
                "repair folder permissions and retry",
            )
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        let candidate = entry.path();
        let metadata = fs::symlink_metadata(&candidate).map_err(|error| {
            operation_error(
                "inspect render folder",
                workspace,
                &candidate,
                error,
                "repair the render store and retry",
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(operation_error(
                "list render folders",
                workspace,
                &candidate,
                "a render path is a symlink",
                "remove the symlink and restore the render folder before retrying",
            ));
        }
        if metadata.is_dir() {
            result.push((name, candidate));
        }
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(result)
}

pub fn list_renders(workspace: &str) -> Result<Vec<RenderGroup>, String> {
    let root = normalize_existing_dir(workspace).map_err(|error| {
        format!("Cannot list diagram renders: workspace is unavailable ({error}); open the workspace and retry")
    })?;
    let documents = parse_document_index(&root)?;
    let report_root = root.join(RENDER_ROOT);
    let doc_dirs = list_child_directories(&root, &report_root)?;
    let mut groups = Vec::new();
    let mut total = 0usize;
    for (doc_id, doc_dir) in doc_dirs {
        if validate_doc_id(&doc_id).is_err() {
            continue;
        }
        let renders_dir = doc_dir.join(RENDERS_DIR);
        let render_dirs = list_child_directories(&root, &renders_dir)?;
        if render_dirs.is_empty() {
            continue;
        }
        let mut renders = Vec::new();
        for (render_id, _) in render_dirs {
            total += 1;
            if total > MAX_RENDERS_PER_WORKSPACE {
                return Err(operation_error(
                    "list diagram renders",
                    &root,
                    &report_root,
                    "the workspace exceeds the render scan limit",
                    "remove old render folders and retry",
                ));
            }
            if validate_render_id(&render_id).is_err() {
                continue;
            }
            renders.push(inspect_render(&root, &doc_id, &render_id)?);
        }
        if !renders.is_empty() {
            let document = documents.get(&doc_id);
            let fallback_name = renders.iter().find_map(|render| {
                render
                    .receipt
                    .as_ref()
                    .map(|receipt| receipt.document_name.clone())
            });
            groups.push(RenderGroup {
                doc_id: doc_id.clone(),
                document_name: document.map(|doc| doc.name.clone()).or(fallback_name),
                orphaned: document.is_none(),
                renders,
            });
        }
    }
    groups.sort_by(|left, right| {
        left.document_name
            .as_deref()
            .unwrap_or(&left.doc_id)
            .cmp(right.document_name.as_deref().unwrap_or(&right.doc_id))
            .then_with(|| left.doc_id.cmp(&right.doc_id))
    });
    Ok(groups)
}

fn read_verified_render(
    workspace: &Path,
    doc_id: &str,
    render_id: &str,
) -> Result<(PathBuf, String, DiagramRenderReceipt), String> {
    let dir = render_directory(workspace, doc_id, render_id)?;
    if !ensure_directory_chain(workspace, &dir, None)? {
        return Err(operation_error(
            "open diagram render",
            workspace,
            &dir,
            "render folder is missing",
            "refresh the Renders list and rerender the diagram",
        ));
    }
    let receipt_file = receipt_path(&dir);
    let bytes = read_bounded_file(workspace, &receipt_file, MAX_RECEIPT_BYTES)?;
    let receipt: DiagramRenderReceipt = serde_json::from_slice(&bytes).map_err(|error| {
        operation_error(
            "read render receipt",
            workspace,
            &receipt_file,
            error,
            "rerender the diagram to repair its receipt",
        )
    })?;
    if receipt.doc_id != doc_id {
        return Err(operation_error(
            "verify render receipt",
            workspace,
            &receipt_file,
            "receipt document ID does not match its folder",
            "restore the original render folder and retry",
        ));
    }
    let artifact_name = validate_extended_receipt(&receipt)?;
    let artifact_file = artifact_path(&dir, artifact_name);
    let artifact_bytes = read_bounded_file(workspace, &artifact_file, MAX_ARTIFACT_BYTES)?;
    if sha256(&artifact_bytes) != receipt.render.output_sha256 {
        return Err(operation_error(
            "verify render artifact",
            workspace,
            &artifact_file,
            "artifact hash does not match the receipt",
            "rerender the diagram before viewing it",
        ));
    }
    let canonical = artifact_file.canonicalize().map_err(|error| {
        operation_error(
            "resolve render artifact",
            workspace,
            &artifact_file,
            error,
            "repair the render store and retry",
        )
    })?;
    if !canonical.starts_with(workspace) {
        return Err(operation_error(
            "open render artifact",
            workspace,
            &artifact_file,
            "canonical file escapes the workspace",
            "repair the render store and retry",
        ));
    }
    Ok((canonical, receipt.render.output_mime_type.clone(), receipt))
}

pub fn prepare_render_view<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace: &str,
    doc_id: &str,
    render_id: &str,
) -> Result<RenderView, String> {
    let root = normalize_existing_dir(workspace).map_err(|error| {
        format!("Cannot prepare diagram render: workspace is unavailable ({error}); open the workspace and retry")
    })?;
    let dir = render_directory(&root, doc_id, render_id)?;
    if !ensure_directory_chain(&root, &dir, None)? {
        return Err(operation_error(
            "prepare diagram render",
            &root,
            &dir,
            "render folder is missing",
            "refresh the Renders list and retry",
        ));
    }
    let receipt_file = receipt_path(&dir);
    let receipt_bytes = read_bounded_file(&root, &receipt_file, MAX_RECEIPT_BYTES)?;
    let receipt: DiagramRenderReceipt =
        serde_json::from_slice(&receipt_bytes).map_err(|error| {
            operation_error(
                "read render receipt",
                &root,
                &receipt_file,
                error,
                "rerender the diagram to repair its receipt",
            )
        })?;
    let artifact_name = validate_extended_receipt(&receipt).map_err(|error| {
        operation_error(
            "verify render receipt",
            &root,
            &receipt_file,
            error,
            "restore the original render folder or rerender the diagram",
        )
    })?;
    if receipt.doc_id != doc_id {
        return Err(operation_error(
            "verify render receipt",
            &root,
            &receipt_file,
            "receipt document ID does not match its folder",
            "restore the original render folder and retry",
        ));
    }
    let artifact_file = artifact_path(&dir, artifact_name);
    let request = PathTransactionRequest::new([receipt_file.clone(), artifact_file.clone()])
        .map_err(|error| {
            operation_error(
                "admit render view",
                &root,
                &dir,
                error,
                "refresh the Renders list and retry",
            )
        })?
        .require_parent(&root)
        .map_err(|error| {
            operation_error(
                "admit render view",
                &root,
                &dir,
                error,
                "refresh the workspace and retry",
            )
        })?;
    with_path_transactions(request, |lease| {
        lease
            .ensure_covered([receipt_file.clone(), artifact_file.clone()])
            .map_err(|error| {
                operation_error(
                    "admit render view",
                    &root,
                    &dir,
                    error,
                    "refresh the Renders list and retry",
                )
            })?;
        let (canonical, mime_type, verified) = read_verified_render(&root, doc_id, render_id)?;
        let current_name = validate_extended_receipt(&verified)?;
        if verified != receipt || artifact_path(&dir, current_name) != artifact_file {
            return Err(operation_error(
                "prepare diagram render",
                &root,
                &receipt_file,
                "receipt changed during verification",
                "refresh the Renders list and retry",
            ));
        }
        app.asset_protocol_scope()
            .allow_file(&canonical)
            .map_err(|error| {
                operation_error(
                    "grant the verified render file",
                    &root,
                    &canonical,
                    error,
                    "restart Maru and retry opening this render",
                )
            })?;
        Ok(RenderView {
            path: canonical.to_string_lossy().to_string(),
            mime_type,
            receipt: verified,
        })
    })
    .map_err(|error| {
        operation_error(
            "prepare diagram render",
            &root,
            &dir,
            error,
            "refresh the Renders list and retry",
        )
    })
}

fn remove_render_contents(workspace: &Path, dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !ensure_directory_chain(workspace, dir, None)? {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(dir).map_err(|error| {
        operation_error(
            "inspect render folder",
            workspace,
            dir,
            error,
            "repair folder permissions and retry",
        )
    })?;
    let mut paths = vec![dir.to_path_buf()];
    for entry in entries {
        if paths.len() > 16 {
            return Err(operation_error(
                "delete render",
                workspace,
                dir,
                "render folder contains too many entries",
                "remove unexpected entries manually and retry",
            ));
        }
        let entry = entry.map_err(|error| {
            operation_error(
                "inspect render entry",
                workspace,
                dir,
                error,
                "repair folder permissions and retry",
            )
        })?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            operation_error(
                "inspect render entry",
                workspace,
                &path,
                error,
                "repair the render folder and retry",
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(operation_error(
                "delete render",
                workspace,
                &path,
                "render folder contains a symlink",
                "remove the symlink and retry deletion",
            ));
        }
        if !metadata.is_file() {
            return Err(operation_error(
                "delete render",
                workspace,
                &path,
                "render folder contains a nested directory or non-file",
                "move unexpected content outside the render folder and retry",
            ));
        }
        paths.push(path);
    }
    paths[1..].sort();
    Ok(paths)
}

pub fn delete_render(workspace: &str, doc_id: &str, render_id: &str) -> Result<(), String> {
    let root = normalize_existing_dir(workspace).map_err(|error| {
        format!("Cannot delete diagram render: workspace is unavailable ({error}); open the workspace and retry")
    })?;
    let dir = render_directory(&root, doc_id, render_id)?;
    let paths = remove_render_contents(&root, &dir)?;
    if paths.is_empty() {
        return Ok(());
    }
    let request = PathTransactionRequest::new(paths.clone())
        .map_err(|error| {
            operation_error(
                "admit render deletion",
                &root,
                &dir,
                error,
                "refresh the Renders list and retry",
            )
        })?
        .require_parent(&root)
        .map_err(|error| {
            operation_error(
                "admit render deletion",
                &root,
                &dir,
                error,
                "refresh the workspace and retry",
            )
        })?
        .with_workspace_registry()
        .map_err(|error| {
            operation_error(
                "admit render deletion",
                &root,
                &dir,
                error,
                "repair workspace registry access and retry",
            )
        })?;
    with_path_transactions(request, |lease| {
        lease.ensure_workspace_registry().map_err(|error| {
            operation_error(
                "delete render",
                &root,
                &dir,
                error,
                "refresh the Renders list and retry",
            )
        })?;
        lease.ensure_covered(paths.clone()).map_err(|error| {
            operation_error(
                "delete render",
                &root,
                &dir,
                error,
                "refresh the Renders list and retry",
            )
        })?;
        let current_paths = remove_render_contents(&root, &dir)?;
        if current_paths != paths {
            return Err(operation_error(
                "delete render",
                &root,
                &dir,
                "render folder changed during deletion",
                "refresh the Renders list and retry",
            ));
        }
        assert_maru_can_write(workspace, WorkspaceWriteAction::Delete).map_err(|error| {
            operation_error(
                "delete render",
                &root,
                &dir,
                error,
                "enable workspace deletion and retry",
            )
        })?;
        lease.before_effect().map_err(|error| {
            operation_error(
                "delete render",
                &root,
                &dir,
                error,
                "refresh the workspace and retry",
            )
        })?;
        fs::remove_dir_all(&dir).map_err(|error| {
            operation_error(
                "delete render",
                &root,
                &dir,
                error,
                "repair render-folder permissions and retry",
            )
        })?;
        Ok(())
    })
    .map_err(|error| {
        operation_error(
            "delete render",
            &root,
            &dir,
            error,
            "refresh the Renders list and retry",
        )
    })
}

fn build_context_receipt(
    context: &RenderDocumentContext,
    base: ArchifyRenderReceipt,
) -> Result<DiagramRenderReceipt, String> {
    let mut context = context.clone();
    context.document_name = validate_display_name(&context.document_name)?;
    extended_receipt(&context, base)
}

pub(crate) fn store_render(
    workspace: &str,
    context: RenderDocumentContext,
    artifact: ArchifyRenderArtifact,
) -> Result<StoredRender, String> {
    let render_id = Uuid::new_v4().simple().to_string();
    store_render_with_id(workspace, context, artifact, &render_id)
}

fn store_render_with_id(
    workspace: &str,
    context: RenderDocumentContext,
    artifact: ArchifyRenderArtifact,
    render_id: &str,
) -> Result<StoredRender, String> {
    let root = normalize_existing_dir(workspace).map_err(|error| {
        format!("Cannot store diagram render: workspace is unavailable ({error}); open the workspace and retry")
    })?;
    let receipt = build_context_receipt(&context, artifact.receipt)?;
    let artifact_name = validate_base_receipt(&receipt.render)?;
    validate_render_id(render_id)?;
    if artifact.bytes.is_empty() || artifact.bytes.len() as u64 > MAX_ARTIFACT_BYTES {
        return Err(format!("Cannot store diagram render: artifact is empty or exceeds {MAX_ARTIFACT_BYTES} bytes; simplify the diagram and render it again"));
    }
    if sha256(&artifact.bytes) != receipt.render.output_sha256 {
        return Err("Cannot store diagram render: artifact bytes do not match the receipt hash; rerender the diagram and retry".into());
    }
    let dir = render_directory(&root, &receipt.doc_id, render_id)?;
    let artifact_path = artifact_path(&dir, artifact_name);
    let receipt_path = receipt_path(&dir);
    let mut publication_paths = vec![dir.clone(), artifact_path.clone(), receipt_path.clone()];
    // Claim only ancestors that may be created; steady-state renders do not
    // reserve the entire attachments tree. Recheck coverage at every mkdir.
    for parent in dir
        .ancestors()
        .skip(1)
        .take_while(|parent| *parent != root.as_path())
    {
        if fs::symlink_metadata(parent)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            publication_paths.push(parent.to_path_buf());
        }
    }
    let request = PathTransactionRequest::new(publication_paths)
        .map_err(|error| {
            operation_error(
                "admit render publication",
                &root,
                &dir,
                error,
                "refresh the workspace and retry",
            )
        })?
        .require_parent(&root)
        .map_err(|error| {
            operation_error(
                "admit render publication",
                &root,
                &dir,
                error,
                "refresh the workspace and retry",
            )
        })?
        .with_workspace_registry()
        .map_err(|error| {
            operation_error(
                "admit render publication",
                &root,
                &dir,
                error,
                "repair workspace registry access and retry",
            )
        })?;
    let receipt_bytes = serde_json::to_vec_pretty(&receipt).map_err(|error| {
        format!("Cannot encode diagram render receipt: {error}; retry the export")
    })?;
    with_path_transactions(request, |lease| {
        lease.ensure_workspace_registry()
            .map_err(|error| operation_error("store diagram render", &root, &dir, error, "repair workspace registry access and retry"))?;
        lease.ensure_covered([dir.clone(), artifact_path.clone(), receipt_path.clone()])
            .map_err(|error| operation_error("store diagram render", &root, &dir, error, "refresh the workspace and retry"))?;
        for target in [&artifact_path, &receipt_path, &dir] {
            if fs::symlink_metadata(target).is_ok() {
                return Err(operation_error("publish immutable render", &root, target, "destination already exists", "render again to a new immutable ID"));
            }
        }
        assert_maru_can_write(workspace, WorkspaceWriteAction::Create).map_err(|error| {
            operation_error("store diagram render", &root, &dir, error, "enable workspace creation and retry")
        })?;
        lease.before_effect()
            .map_err(|error| operation_error("store diagram render", &root, &dir, error, "refresh the workspace and retry"))?;
        ensure_directory_chain(&root, dir.parent().unwrap_or(&root), Some(lease))?;
        fs::create_dir(&dir).map_err(|error| {
            operation_error("create immutable render folder", &root, &dir, error, "refresh the render list and render again")
        })?;
        let write_result = (|| {
            write_atomic_create(&artifact_path, &artifact.bytes).map_err(|error| {
                operation_error("write render artifact", &root, &artifact_path, error, "check workspace permissions and retry")
            })?;
            write_atomic_create(&receipt_path, &receipt_bytes).map_err(|error| {
                operation_error("write render receipt", &root, &receipt_path, error, "check workspace permissions and retry")
            })?;
            Ok(())
        })();
        if let Err(error) = write_result {
            match fs::symlink_metadata(&dir) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    if let Err(cleanup_error) = fs::remove_dir_all(&dir) {
                        return Err(format!("{error}; cleanup of the newly created partial render folder also failed: {cleanup_error}; inspect the render store before retrying"));
                    }
                }
                Ok(_) => return Err(format!("{error}; the new render path changed type; inspect it before retrying")),
                Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => {}
                Err(cleanup_error) => return Err(format!("{error}; cannot inspect partial render folder: {cleanup_error}; inspect the render store before retrying")),
            }
            return Err(error);
        }
        Ok(())
    })
    .map_err(|error| operation_error("store diagram render", &root, &dir, error, "refresh the Renders list and retry"))?;
    Ok(StoredRender {
        render_id: render_id.to_string(),
        artifact_name: artifact_name.to_string(),
        receipt,
    })
}

pub mod ipc {
    use super::{delete_render, list_renders, prepare_render_view, RenderGroup, RenderView};
    #[cfg(test)]
    use std::path::PathBuf;

    #[tauri::command]
    pub async fn diagram_list_renders(workspace: String) -> Result<Vec<RenderGroup>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_list_renders",
            );
            list_renders(&workspace)
        })
        .await
        .map_err(|error| {
            format!("diagram_list_renders_task_failed: {error}; retry listing renders")
        })?
    }

    #[tauri::command]
    pub async fn diagram_prepare_render_view<R: tauri::Runtime>(
        app: tauri::AppHandle<R>,
        workspace: String,
        doc_id: String,
        render_id: String,
    ) -> Result<RenderView, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_prepare_render_view",
            );
            prepare_render_view(&app, &workspace, &doc_id, &render_id)
        })
        .await
        .map_err(|error| {
            format!(
                "diagram_prepare_render_view_task_failed: {error}; refresh the render and retry"
            )
        })?
    }

    #[tauri::command]
    pub async fn diagram_delete_render(
        workspace: String,
        doc_id: String,
        render_id: String,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_delete_render",
            );
            delete_render(&workspace, &doc_id, &render_id)
        })
        .await
        .map_err(|error| {
            format!("diagram_delete_render_task_failed: {error}; refresh the render list and retry")
        })?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_file::phase08_06::Home;
    use tauri::Manager;

    struct Fixture {
        _home: Home,
        work: PathBuf,
        doc_id: String,
    }

    impl Fixture {
        fn new() -> Self {
            let home = Home::new();
            let work = home.root.path().join("render-workspace");
            fs::create_dir_all(work.join(".maru")).unwrap();
            fs::create_dir_all(work.join(DIAGRAMS_ROOT)).unwrap();
            let doc_id = "doc-render-test".to_string();
            fs::write(
                work.join(DIAGRAMS_ROOT).join("render-test.cmd.json"),
                serde_json::json!({ "id": doc_id, "docTitle": "Native render fixture" })
                    .to_string(),
            )
            .unwrap();
            Self {
                _home: home,
                work,
                doc_id,
            }
        }

        fn context(&self) -> RenderDocumentContext {
            RenderDocumentContext {
                doc_id: self.doc_id.clone(),
                document_name: "Native render fixture".into(),
                document_revision: sha256(b"saved document revision"),
                diagram_type: "architecture".into(),
                dataset_id: None,
            }
        }

        fn artifact(&self, mime_type: &str, bytes: &[u8]) -> ArchifyRenderArtifact {
            ArchifyRenderArtifact {
                bytes: bytes.to_vec(),
                receipt: ArchifyRenderReceipt {
                    schema_version: 1,
                    input_spec_sha256: sha256(b"semantic input"),
                    engine_pin: crate::archify::ArchifyEnginePin {
                        name: "archify".into(),
                        version: "3.0.0".into(),
                        revision: "0123456789abcdef0123456789abcdef01234567".into(),
                    },
                    output_sha256: sha256(bytes),
                    output_mime_type: mime_type.into(),
                    gates: crate::archify::ArchifyRenderGates {
                        schema: crate::archify::ArchifyRenderGate {
                            status: "passed".into(),
                            scope: "pinned-engine-validation".into(),
                        },
                        artifact: crate::archify::ArchifyRenderGate {
                            status: "passed".into(),
                            scope: "pinned-engine-rendered-html".into(),
                        },
                        browser: crate::archify::ArchifyRenderGate {
                            status: "passed".into(),
                            scope: "verified-static-conversion".into(),
                        },
                        visual_review: crate::archify::ArchifyRenderGate {
                            status: "not-run".into(),
                            scope: "manual-visual-review".into(),
                        },
                    },
                },
            }
        }

        fn store(&self, id: &str, mime_type: &str, bytes: &[u8]) -> StoredRender {
            store_render_with_id(
                self.work.to_str().unwrap(),
                self.context(),
                self.artifact(mime_type, bytes),
                id,
            )
            .unwrap()
        }

        fn render_dir(&self, id: &str) -> PathBuf {
            self.work
                .join(RENDER_ROOT)
                .join(&self.doc_id)
                .join(RENDERS_DIR)
                .join(id)
        }
    }

    const RENDER_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const RENDER_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const RENDER_C: &str = "cccccccccccccccccccccccccccccccc";
    const RENDER_D: &str = "dddddddddddddddddddddddddddddddd";
    const HTML: &[u8] =
        b"<!doctype html><html><body><svg viewBox=\"0 0 10 10\"></svg></body></html>";
    const SVG: &[u8] = b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><text>fixture</text></svg>";

    #[test]
    fn stores_immutable_html_and_prepares_only_the_hash_verified_file() {
        let fixture = Fixture::new();
        let stored = fixture.store(RENDER_A, "text/html", HTML);
        assert_eq!(stored.artifact_name, HTML_FILE);
        assert_eq!(stored.receipt.doc_id, fixture.doc_id);
        let groups = list_renders(fixture.work.to_str().unwrap()).unwrap();
        assert_eq!(groups.len(), 1);
        // Rerender addresses the saved diagram by filename, not title.
        assert_eq!(groups[0].document_name.as_deref(), Some("render-test"));
        assert!(!groups[0].orphaned);
        assert_eq!(groups[0].renders.len(), 1);
        assert!(groups[0].renders[0].verified);

        let app = tauri::test::mock_app();
        let view = prepare_render_view(
            &app.handle().clone(),
            fixture.work.to_str().unwrap(),
            &fixture.doc_id,
            RENDER_A,
        )
        .unwrap();
        assert_eq!(view.mime_type, "text/html");
        assert_eq!(view.receipt, stored.receipt);
        assert!(view.path.ends_with("/index.html"));
        assert!(view.path.starts_with(fixture.work.to_str().unwrap()));
        assert!(app.asset_protocol_scope().is_allowed(Path::new(&view.path)));
        assert!(!app
            .asset_protocol_scope()
            .is_allowed(fixture.render_dir(RENDER_A).join(RECEIPT_FILE)));
        assert!(!app
            .asset_protocol_scope()
            .is_allowed(fixture.render_dir(RENDER_B).join(HTML_FILE)));

        let error = store_render_with_id(
            fixture.work.to_str().unwrap(),
            fixture.context(),
            fixture.artifact("text/html", b"different bytes"),
            RENDER_A,
        )
        .unwrap_err();
        assert!(error.contains("destination already exists"), "{error}");
        assert_eq!(
            fs::read(fixture.render_dir(RENDER_A).join(HTML_FILE)).unwrap(),
            HTML
        );
    }

    #[test]
    fn copied_receipt_is_listed_and_missing_or_bad_receipts_are_unverified() {
        let fixture = Fixture::new();
        let stored = fixture.store(RENDER_A, "image/svg+xml", SVG);
        let copied = fixture.render_dir(RENDER_B);
        fs::create_dir_all(&copied).unwrap();
        fs::copy(
            fixture.render_dir(RENDER_A).join(SVG_FILE),
            copied.join(SVG_FILE),
        )
        .unwrap();
        fs::copy(
            fixture.render_dir(RENDER_A).join(RECEIPT_FILE),
            copied.join(RECEIPT_FILE),
        )
        .unwrap();

        let missing = fixture.render_dir(RENDER_C);
        fs::create_dir_all(&missing).unwrap();
        fs::write(missing.join(SVG_FILE), SVG).unwrap();
        let bad = fixture.render_dir(RENDER_D);
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join(SVG_FILE), SVG).unwrap();
        fs::write(bad.join(RECEIPT_FILE), b"{ invalid json").unwrap();

        let group = list_renders(fixture.work.to_str().unwrap())
            .unwrap()
            .remove(0);
        assert_eq!(group.renders.len(), 4);
        let verified: Vec<_> = group
            .renders
            .iter()
            .filter(|render| render.verified)
            .collect();
        assert_eq!(verified.len(), 2, "original and copied receipt both verify");
        assert!(group.renders.iter().any(|render| {
            render.render_id == RENDER_C
                && !render.verified
                && render.receipt.is_none()
                && render
                    .diagnostic
                    .as_deref()
                    .is_some_and(|message| message.contains("receipt"))
        }));
        assert!(group.renders.iter().any(|render| {
            render.render_id == RENDER_D
                && !render.verified
                && render.receipt.is_none()
                && render
                    .diagnostic
                    .as_deref()
                    .is_some_and(|message| message.contains("JSON"))
        }));
        assert_eq!(
            verified[0].receipt.as_ref().unwrap().doc_id,
            stored.receipt.doc_id
        );
    }

    #[test]
    fn mismatched_artifact_filename_is_unverified_and_cannot_be_prepared() {
        let fixture = Fixture::new();
        fixture.store(RENDER_A, "image/svg+xml", SVG);
        fs::rename(
            fixture.render_dir(RENDER_A).join(SVG_FILE),
            fixture.render_dir(RENDER_A).join(PNG_FILE),
        )
        .unwrap();
        let group = list_renders(fixture.work.to_str().unwrap())
            .unwrap()
            .remove(0);
        assert!(!group.renders[0].verified);
        assert!(group.renders[0]
            .diagnostic
            .as_deref()
            .is_some_and(|message| message.contains("missing")));
        let app = tauri::test::mock_app();
        let error = prepare_render_view(
            &app.handle().clone(),
            fixture.work.to_str().unwrap(),
            &fixture.doc_id,
            RENDER_A,
        )
        .unwrap_err();
        assert!(error.contains("missing"), "{error}");
    }

    #[test]
    fn orphaned_renders_remain_listed_and_delete_removes_only_the_selected_folder() {
        let fixture = Fixture::new();
        fixture.store(RENDER_A, "text/html", HTML);
        fixture.store(RENDER_B, "image/svg+xml", SVG);
        let unrelated = fixture
            .work
            .join(RENDER_ROOT)
            .join(&fixture.doc_id)
            .join("report.svg");
        fs::write(&unrelated, b"existing report asset").unwrap();
        fs::remove_file(
            fixture
                .work
                .join(DIAGRAMS_ROOT)
                .join("render-test.cmd.json"),
        )
        .unwrap();

        let group = list_renders(fixture.work.to_str().unwrap())
            .unwrap()
            .remove(0);
        assert!(group.orphaned);
        assert_eq!(group.renders.len(), 2);
        assert!(group.renders.iter().all(|render| render.verified));

        delete_render(fixture.work.to_str().unwrap(), &fixture.doc_id, RENDER_A).unwrap();
        assert!(!fixture.render_dir(RENDER_A).exists());
        assert!(fixture.render_dir(RENDER_B).is_dir());
        assert_eq!(fs::read(unrelated).unwrap(), b"existing report asset");
        delete_render(fixture.work.to_str().unwrap(), &fixture.doc_id, RENDER_A).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_artifacts_without_granting_or_deleting_the_target() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fixture.store(RENDER_A, "image/svg+xml", SVG);
        let external = tempfile::tempdir().unwrap();
        let sentinel = external.path().join("outside.svg");
        fs::write(&sentinel, SVG).unwrap();
        fs::remove_file(fixture.render_dir(RENDER_A).join(SVG_FILE)).unwrap();
        symlink(&sentinel, fixture.render_dir(RENDER_A).join(SVG_FILE)).unwrap();

        let group = list_renders(fixture.work.to_str().unwrap())
            .unwrap()
            .remove(0);
        assert!(!group.renders[0].verified);
        let app = tauri::test::mock_app();
        assert!(prepare_render_view(
            &app.handle().clone(),
            fixture.work.to_str().unwrap(),
            &fixture.doc_id,
            RENDER_A,
        )
        .is_err());
        assert!(delete_render(fixture.work.to_str().unwrap(), &fixture.doc_id, RENDER_A).is_err());
        assert_eq!(fs::read(sentinel).unwrap(), SVG);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_render_directories_during_listing() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let render_root = fixture
            .work
            .join(RENDER_ROOT)
            .join(&fixture.doc_id)
            .join(RENDERS_DIR);
        fs::create_dir_all(&render_root).unwrap();
        let external = tempfile::tempdir().unwrap();
        let sentinel = external.path().join("kept");
        fs::write(&sentinel, b"keep").unwrap();
        symlink(external.path(), render_root.join(RENDER_A)).unwrap();
        assert!(list_renders(fixture.work.to_str().unwrap()).is_err());
        assert_eq!(fs::read(sentinel).unwrap(), b"keep");
    }
    #[test]
    fn list_command_yields_and_propagates_worker_failure() {
        let f = Fixture::new();
        crate::atomic_file::phase08_06::boundary(
            f.work.clone(),
            "diagram_list_renders",
            super::ipc::diagram_list_renders(f.work.to_string_lossy().into_owned()),
        );
    }
    #[test]
    fn prepare_command_yields_and_propagates_worker_failure() {
        let f = Fixture::new();
        let app = tauri::test::mock_app();
        crate::atomic_file::phase08_06::boundary(
            f.work.clone(),
            "diagram_prepare_render_view",
            super::ipc::diagram_prepare_render_view(
                app.handle().clone(),
                f.work.to_string_lossy().into_owned(),
                f.doc_id.clone(),
                RENDER_A.into(),
            ),
        );
    }
    #[test]
    fn delete_command_yields_and_propagates_worker_failure() {
        let f = Fixture::new();
        crate::atomic_file::phase08_06::boundary(
            f.work.clone(),
            "diagram_delete_render",
            super::ipc::diagram_delete_render(
                f.work.to_string_lossy().into_owned(),
                f.doc_id.clone(),
                RENDER_A.into(),
            ),
        );
    }
    #[test]
    fn modified_artifact_is_refused_without_an_asset_grant() {
        let f = Fixture::new();
        f.store(RENDER_A, "text/html", HTML);
        let artifact = f.render_dir(RENDER_A).join(HTML_FILE);
        fs::write(&artifact, b"changed after rendering").unwrap();
        let groups = list_renders(f.work.to_str().unwrap()).unwrap();
        assert!(!groups[0].renders[0].verified);
        let app = tauri::test::mock_app();
        let error =
            prepare_render_view(app.handle(), f.work.to_str().unwrap(), &f.doc_id, RENDER_A)
                .unwrap_err();
        assert!(
            error.contains("index.html") && error.contains("hash") && error.contains("rerender"),
            "{error}"
        );
        assert!(!app.asset_protocol_scope().is_allowed(&artifact));
    }
}
