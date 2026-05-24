use crate::kordoc_lite::{self, DocumentFormat, KordocLiteCheck};
use crate::vault::normalize_existing_dir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

const BINDER_SCHEMA_VERSION: u32 = 1;
const MAX_CANDIDATES: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceBinding {
    pub candidate_id: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub linked_at: Option<String>,
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
    pub inbox_item_id: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceBinderResponse {
    pub state: EvidenceBinderState,
    pub candidates: Vec<EvidenceBinderCandidate>,
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
pub struct EvidenceBinderSaveRequest {
    pub work_path: String,
    pub state: EvidenceBinderState,
}

#[derive(Debug, Deserialize)]
struct ProcessedManifest {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    files: Vec<ProcessedManifestFile>,
}

#[derive(Debug, Deserialize)]
struct ProcessedManifestFile {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    original_name: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[tauri::command]
pub fn evidence_binder_read(
    req: EvidenceBinderReadRequest,
) -> Result<EvidenceBinderResponse, String> {
    let work = normalize_existing_dir(&req.work_path)?;
    let doc_id = sanitize_doc_id(&req.doc_id)?;
    let state = read_or_create_state(&work, &doc_id, req.document_path.clone())?;
    let candidates = discover_candidates(&work, req.document_path.as_deref())?;
    Ok(EvidenceBinderResponse { state, candidates })
}

#[tauri::command]
pub fn evidence_binder_save(req: EvidenceBinderSaveRequest) -> Result<EvidenceBinderState, String> {
    let work = normalize_existing_dir(&req.work_path)?;
    let doc_id = sanitize_doc_id(&req.state.doc_id)?;
    let mut state = req.state;
    state.schema_version = BINDER_SCHEMA_VERSION;
    state.doc_id = doc_id;
    state.updated_at = chrono::Utc::now().to_rfc3339();
    write_state(&work, &state)?;
    Ok(state)
}

fn read_or_create_state(
    work: &Path,
    doc_id: &str,
    document_path: Option<String>,
) -> Result<EvidenceBinderState, String> {
    let path = state_path(work, doc_id)?;
    if path.exists() {
        let text = fs::read_to_string(&path)
            .map_err(|err| format!("Cannot read evidence binder state: {err}"))?;
        let mut state: EvidenceBinderState = serde_json::from_str(&text)
            .map_err(|err| format!("Cannot parse evidence binder state: {err}"))?;
        state.schema_version = BINDER_SCHEMA_VERSION;
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
        updated_at: chrono::Utc::now().to_rfc3339(),
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
    fs::write(&path, text).map_err(|err| format!("Cannot save evidence binder state: {err}"))
}

fn state_path(work: &Path, doc_id: &str) -> Result<PathBuf, String> {
    let doc_id = sanitize_doc_id(doc_id)?;
    Ok(work
        .join(".anchor")
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
    for candidate in discover_processed_candidates(work)? {
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
                sidecar_yaml
                    .as_ref()
                    .and_then(|yaml| sidecar_string(yaml, "evidence_kind")),
                None,
            )?);
        }
    }
    Ok(candidates)
}

fn discover_processed_candidates(work: &Path) -> Result<Vec<EvidenceBinderCandidate>, String> {
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
                    None,
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
        .filter_map(|file| file.path.as_deref())
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
            file.path
                .as_deref()
                .and_then(|value| Path::new(value).file_name())
                .and_then(|name| name.to_str())
                == path_name
        })
        .and_then(|file| file.original_name.as_ref().or(file.name.as_ref()))
        .cloned()
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
        .is_some_and(|name| {
            matches!(
                name,
                ".git" | "node_modules" | "target" | "dist" | ".anchor"
            )
        })
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

    #[test]
    fn state_round_trips_under_anchor_binder() {
        let tmp = tempfile::tempdir().unwrap();
        let mut state =
            read_or_create_state(tmp.path(), "doc-1", Some("a.md".to_string())).unwrap();
        state.bindings.push(EvidenceBinding {
            candidate_id: "ev_a".to_string(),
            note: Some("checked".to_string()),
            verified: true,
            linked_at: Some("2026-05-24T00:00:00Z".to_string()),
        });
        write_state(tmp.path(), &state).unwrap();
        let read = read_or_create_state(tmp.path(), "doc-1", None).unwrap();
        assert_eq!(read.bindings.len(), 1);
        assert!(tmp.path().join(".anchor/binder/doc-1.json").exists());
    }

    #[test]
    fn discovers_sidecar_and_processed_candidates() {
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
            "summary: receipt ok\nevidence_kind: receipt\n",
        )
        .unwrap();
        let item = work.join("inbox/items/done/item-a");
        fs::create_dir_all(item.join("raw")).unwrap();
        fs::write(item.join("raw/form.hwpx"), b"PK\x03\x04").unwrap();
        fs::write(
            item.join("manifest.yaml"),
            "id: item-a\nchannel: kakao\nfiles:\n  - path: raw/form.hwpx\n    original_name: form.hwpx\n",
        )
        .unwrap();

        let candidates =
            discover_candidates(work, Some("projects/bu-a/02-admin-approvals/doc.md")).unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(candidates.iter().any(|item| item.source == "sidecar"));
        assert!(candidates
            .iter()
            .any(|item| item.source == "inboxProcessed"));
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
}
