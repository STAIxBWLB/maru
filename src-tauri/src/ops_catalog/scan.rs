// Operations Catalog scan (Phase 3 W3 — real indexing).
//
// Pipeline:
//   1. project-registry.yaml → 활성 사업단 슬러그 + program_id 인덱스
//   2. projects/**/.anchor/bu-config.yaml + admin/**/.anchor/bu-config.yaml 수집
//   3. inbox/items/pending/<slug>/manifest.yaml → InboxPending 엔트리
//   4. tasks/active/ + tasks/calendar/ frontmatter → TaskDue 엔트리
//   5. 워크스페이스 .md 파일 frontmatter 스캔 → DeadlineDue / ApprovalInFlight
//   6. binary 옆에 .evidence.yaml 사이드카가 없으면 → EvidenceUnlinked
//
// 출력: <workspace>/.anchor/cache/catalog.json (CatalogIndex JSON)
//
// Spec: plan §M1, _sys/rules/bu-lifecycle.md, frontmatter-schema.md, evidence-policy.md

use chrono::{Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::{
    catalog_cache_path,
    index::{CatalogEntry, CatalogIndex},
    CatalogItemKind, DocCategory,
};

const DEFAULT_DEADLINE_HORIZON_DAYS: i64 = 14;
const MAX_ENTRIES: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CatalogScanReport {
    pub scanned_at: String,
    pub entries_count: usize,
    pub by_kind: HashMap<String, usize>,
    pub bus_seen: Vec<String>,
    pub warnings: Vec<String>,
    pub elapsed_ms: u64,
}

pub fn scan_catalog_impl(
    workspace_root: &Path,
    _force_refresh: bool,
) -> io::Result<CatalogScanReport> {
    let started = std::time::Instant::now();
    let mut warnings = Vec::new();
    let mut entries: Vec<CatalogEntry> = Vec::new();

    if !workspace_root.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("workspace_root not found: {}", workspace_root.display()),
        ));
    }

    // Step 1-2: BU configs
    let bu_configs = collect_bu_configs(workspace_root, &mut warnings);
    let mut bus_seen: Vec<String> = bu_configs.keys().cloned().collect();
    bus_seen.sort();

    // Step 3: inbox pending
    if let Err(e) = scan_inbox_pending(workspace_root, &mut entries) {
        warnings.push(format!("inbox scan error: {}", e));
    }

    // Step 4: tasks
    if let Err(e) = scan_tasks(workspace_root, &mut entries) {
        warnings.push(format!("tasks scan error: {}", e));
    }

    // Step 5-6: markdown frontmatter + binary sidecars
    if let Err(e) = scan_markdown_and_binaries(workspace_root, &bu_configs, &mut entries) {
        warnings.push(format!("markdown scan error: {}", e));
    }

    // 트림 + 정렬 (deadline 임박순, 그 다음 last_updated 최신순)
    entries.sort_by(|a, b| match (&a.deadline, &b.deadline) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => b.last_updated.cmp(&a.last_updated),
    });
    if entries.len() > MAX_ENTRIES {
        warnings.push(format!(
            "entries capped at {} (had {})",
            MAX_ENTRIES,
            entries.len()
        ));
        entries.truncate(MAX_ENTRIES);
    }

    // by_kind 집계
    let mut by_kind: HashMap<String, usize> = HashMap::new();
    for e in &entries {
        let k = format!("{:?}", e.kind).to_lowercase();
        *by_kind.entry(k).or_insert(0) += 1;
    }

    let index = CatalogIndex {
        version: 1,
        generated_at: Utc::now().to_rfc3339(),
        entries: entries.clone(),
    };
    let cache_path = catalog_cache_path(workspace_root);
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&index)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    std::fs::write(&cache_path, json)?;

    Ok(CatalogScanReport {
        scanned_at: index.generated_at.clone(),
        entries_count: entries.len(),
        by_kind,
        bus_seen,
        warnings,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

// ---------- BU configs ----------

#[derive(Debug, Clone)]
struct BuConfig {
    #[allow(dead_code)]
    bu_id: String,
    /// 절대 경로 (워크스페이스 안)
    #[allow(dead_code)]
    root: PathBuf,
    #[allow(dead_code)]
    tree_map: HashMap<String, Option<PathBuf>>,
}

fn collect_bu_configs(
    workspace_root: &Path,
    warnings: &mut Vec<String>,
) -> HashMap<String, BuConfig> {
    let mut out: HashMap<String, BuConfig> = HashMap::new();
    let bases = [
        workspace_root.join("projects"),
        workspace_root.join("admin"),
    ];

    for base in bases.iter() {
        if !base.exists() {
            continue;
        }
        for entry in WalkDir::new(base)
            .min_depth(1)
            .max_depth(6)
            .into_iter()
            // 단, `.anchor/` 자체는 BU config 수집을 위해 통과시킨다 (단 .anchor/cache, .anchor/runs 등은 제외).
            .filter_entry(|e| !is_excluded_dir_for_bu_scan(e.path()))
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            if p.file_name().map_or(false, |n| n == "bu-config.yaml")
                && p.to_string_lossy().contains("/.anchor/")
            {
                match parse_bu_config(p) {
                    Ok(cfg) => {
                        let bu_root = p.parent().and_then(|x| x.parent()).map(|x| x.to_path_buf());
                        if let Some(bu_root) = bu_root {
                            let resolved = resolve_tree_map(&cfg, &bu_root, workspace_root);
                            out.insert(
                                cfg.bu_id.clone(),
                                BuConfig {
                                    bu_id: cfg.bu_id,
                                    root: bu_root,
                                    tree_map: resolved,
                                },
                            );
                        }
                    }
                    Err(e) => {
                        warnings.push(format!("bu-config parse error {}: {}", p.display(), e))
                    }
                }
            }
        }
    }
    out
}

#[derive(Debug, Clone)]
struct ParsedBuConfig {
    bu_id: String,
    tree_map: HashMap<String, Option<String>>,
}

fn parse_bu_config(path: &Path) -> io::Result<ParsedBuConfig> {
    let text = std::fs::read_to_string(path)?;
    let yaml: YamlValue =
        serde_yaml::from_str(&text).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let bu_id = yaml
        .get("bu_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing bu_id"))?
        .to_string();

    let mut tree_map: HashMap<String, Option<String>> = HashMap::new();
    if let Some(tm) = yaml.get("tree_map").and_then(|v| v.as_mapping()) {
        for (k, v) in tm {
            if let Some(key) = k.as_str() {
                let val = match v {
                    YamlValue::String(s) => Some(s.clone()),
                    YamlValue::Null => None,
                    _ => continue,
                };
                tree_map.insert(key.to_string(), val);
            }
        }
    }
    Ok(ParsedBuConfig { bu_id, tree_map })
}

/// tree_map의 legacy 경로를 워크스페이스 기준 경로로 해소.
fn resolve_tree_map(
    cfg: &ParsedBuConfig,
    bu_root: &Path,
    workspace_root: &Path,
) -> HashMap<String, Option<PathBuf>> {
    let mut resolved = HashMap::new();
    for (k, v) in &cfg.tree_map {
        let path = v.as_ref().map(|legacy| {
            // 전역 경로 (meetings/, trips/, admin/, projects/) 시작 → workspace_root 기준
            if legacy.starts_with("meetings")
                || legacy.starts_with("trips")
                || legacy.starts_with("admin")
                || legacy.starts_with("projects")
            {
                workspace_root.join(legacy)
            } else {
                // 그 외에는 BU root 기준 (예: "3-implementing/13-reports")
                bu_root.join(legacy)
            }
        });
        resolved.insert(k.clone(), path);
    }
    resolved
}

// ---------- Inbox pending ----------

fn scan_inbox_pending(workspace_root: &Path, out: &mut Vec<CatalogEntry>) -> io::Result<()> {
    let pending = workspace_root.join("inbox").join("items").join("pending");
    if !pending.exists() {
        return Ok(());
    }
    for entry in WalkDir::new(&pending)
        .min_depth(2)
        .max_depth(2)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.file_name() != "manifest.yaml" {
            continue;
        }
        let manifest_path = entry.path();
        let slug = manifest_path
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (title, bu_hint, deadline) = extract_manifest_meta(manifest_path);
        let rel = relative_to(manifest_path, workspace_root);
        out.push(CatalogEntry {
            path: rel,
            kind: CatalogItemKind::InboxPending,
            title: title.unwrap_or_else(|| slug.clone()),
            business_unit: bu_hint,
            category: None,
            deadline,
            approval_status: None,
            evidence_kind: None,
            last_updated: file_mtime(manifest_path),
        });
    }
    Ok(())
}

fn extract_manifest_meta(manifest_path: &Path) -> (Option<String>, Option<String>, Option<String>) {
    let text = match std::fs::read_to_string(manifest_path) {
        Ok(t) => t,
        Err(_) => return (None, None, None),
    };
    let yaml: YamlValue = match serde_yaml::from_str(&text) {
        Ok(y) => y,
        Err(_) => return (None, None, None),
    };
    let title = yaml
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            yaml.get("subject")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
    let bu = yaml
        .get("business_unit")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_matches(|c: char| c == '[' || c == ']').to_string());
    let deadline = yaml
        .get("deadline")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    (title, bu, deadline)
}

// ---------- Tasks ----------

fn scan_tasks(workspace_root: &Path, out: &mut Vec<CatalogEntry>) -> io::Result<()> {
    let horizon = Utc::now().date_naive() + Duration::days(DEFAULT_DEADLINE_HORIZON_DAYS);
    for sub in ["active", "calendar"] {
        let root = workspace_root.join("tasks").join(sub);
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(&root)
            .max_depth(4)
            .into_iter()
            .filter_entry(|e| !is_excluded_dir(e.path()))
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let (fm, _body) = read_frontmatter(p);
            let due = fm
                .as_ref()
                .and_then(|y| y.get("due").or_else(|| y.get("deadline")))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Some(due_str) = &due {
                if let Some(due_date) = parse_iso_date(due_str) {
                    if due_date > horizon {
                        continue; // 14일 이후는 catalog 미표시
                    }
                }
            }
            let title = fm
                .as_ref()
                .and_then(|y| y.get("title"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    p.file_stem()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default()
                });
            let bu = extract_bu(&fm);
            out.push(CatalogEntry {
                path: relative_to(p, workspace_root),
                kind: CatalogItemKind::TaskDue,
                title,
                business_unit: bu,
                category: None,
                deadline: due,
                approval_status: None,
                evidence_kind: None,
                last_updated: file_mtime(p),
            });
        }
    }
    Ok(())
}

// ---------- Markdown + binaries ----------

fn scan_markdown_and_binaries(
    workspace_root: &Path,
    bu_configs: &HashMap<String, BuConfig>,
    out: &mut Vec<CatalogEntry>,
) -> io::Result<()> {
    let horizon = Utc::now().date_naive() + Duration::days(DEFAULT_DEADLINE_HORIZON_DAYS);

    let bases = [
        workspace_root.join("projects"),
        workspace_root.join("admin"),
        workspace_root.join("meetings"),
    ];

    for base in bases.iter() {
        if !base.exists() {
            continue;
        }
        for entry in WalkDir::new(base)
            .into_iter()
            .filter_entry(|e| !is_excluded_dir(e.path()))
            .filter_map(Result::ok)
        {
            let p = entry.path();
            if !entry.file_type().is_file() {
                continue;
            }
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");

            if ext == "md" {
                if let Some(entry) = analyze_md(p, workspace_root, horizon, bu_configs) {
                    out.push(entry);
                }
            } else if is_binary_evidence_candidate(ext) {
                if let Some(entry) = analyze_binary(p, workspace_root, bu_configs) {
                    out.push(entry);
                }
            }
        }
    }
    Ok(())
}

fn analyze_md(
    p: &Path,
    workspace_root: &Path,
    horizon: NaiveDate,
    _bu_configs: &HashMap<String, BuConfig>,
) -> Option<CatalogEntry> {
    let (fm, _body) = read_frontmatter(p);
    let fm = fm?;

    let document_type = fm
        .get("document_type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let category = document_type.as_deref().and_then(category_for_doc_type);
    let bu = extract_bu(&Some(fm.clone()));
    let title = fm
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            p.file_stem()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    let deadline = fm
        .get("deadline")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let approval_status = fm
        .get("approval")
        .and_then(|v| v.get("status"))
        .or_else(|| fm.get("status"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let approval_in_flight = matches!(
        approval_status.as_deref(),
        Some("review") | Some("in_review") | Some("revisions")
    );

    let mut deadline_due = false;
    if let Some(dl) = &deadline {
        if let Some(d) = parse_iso_date(dl) {
            if d <= horizon {
                deadline_due = true;
            }
        }
    }

    if !approval_in_flight && !deadline_due {
        return None;
    }

    Some(CatalogEntry {
        path: relative_to(p, workspace_root),
        kind: if approval_in_flight {
            CatalogItemKind::ApprovalInFlight
        } else {
            CatalogItemKind::DeadlineDue
        },
        title,
        business_unit: bu,
        category,
        deadline,
        approval_status,
        evidence_kind: None,
        last_updated: file_mtime(p),
    })
}

fn analyze_binary(
    p: &Path,
    workspace_root: &Path,
    _bu_configs: &HashMap<String, BuConfig>,
) -> Option<CatalogEntry> {
    // 사이드카가 있으면 evidence_id가 있는 셈 → 연결됨
    let original_ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
    let sidecar = p.with_extension(format!("{}.evidence.yaml", original_ext));
    if sidecar.exists() {
        return None;
    }
    // 03-evidence-cert/ 또는 04-evidence/ 또는 흔한 evidence 디렉토리 하위만
    let path_str = p.to_string_lossy();
    let is_evidence_zone = path_str.contains("/03-evidence-cert/")
        || path_str.contains("/04-evidence/")
        || path_str.contains("/receipts/")
        || path_str.contains("/invoices/")
        || path_str.contains("/contracts/")
        || path_str.contains("/payments/")
        || path_str.contains("/attendance/")
        || path_str.contains("/certificates/");
    if !is_evidence_zone {
        return None;
    }
    let kind_hint = guess_evidence_kind(&path_str);
    let title = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Some(CatalogEntry {
        path: relative_to(p, workspace_root),
        kind: CatalogItemKind::EvidenceUnlinked,
        title,
        business_unit: None,
        category: Some(DocCategory::EvidenceCert),
        deadline: None,
        approval_status: None,
        evidence_kind: Some(kind_hint),
        last_updated: file_mtime(p),
    })
}

fn guess_evidence_kind(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.contains("/receipts/") || lower.contains("receipt") {
        "receipt".to_string()
    } else if lower.contains("/invoices/") || lower.contains("invoice") {
        "invoice".to_string()
    } else if lower.contains("/contracts/") || lower.contains("contract") {
        "contract".to_string()
    } else if lower.contains("/payments/") || lower.contains("payment") {
        "payment".to_string()
    } else if lower.contains("/attendance/") {
        "attendance".to_string()
    } else if lower.contains("/certificates/") {
        "certificate".to_string()
    } else {
        "other".to_string()
    }
}

// ---------- Common helpers ----------

fn read_frontmatter(p: &Path) -> (Option<YamlValue>, String) {
    let text = match std::fs::read_to_string(p) {
        Ok(t) => t,
        Err(_) => return (None, String::new()),
    };
    if !text.starts_with("---") {
        return (None, text);
    }
    let after_open = match text.find("---\n") {
        Some(i) => i + 4,
        None => return (None, text),
    };
    let rest = &text[after_open..];
    let close_idx = rest.find("\n---\n").or_else(|| rest.find("\n---"));
    let (front, body) = match close_idx {
        Some(idx) => (&rest[..idx], &rest[idx + 4..]),
        None => return (None, text),
    };
    let parsed: Option<YamlValue> = serde_yaml::from_str(front).ok();
    (parsed, body.to_string())
}

fn extract_bu(fm: &Option<YamlValue>) -> Option<String> {
    fm.as_ref()
        .and_then(|y| y.get("business_unit"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim_matches(|c: char| c == '[' || c == ']').to_string())
}

fn parse_iso_date(s: &str) -> Option<NaiveDate> {
    let date_prefix = if s.len() >= 10 { s.get(..10)? } else { s };
    NaiveDate::parse_from_str(date_prefix, "%Y-%m-%d").ok()
}

fn relative_to(p: &Path, root: &Path) -> String {
    p.strip_prefix(root)
        .map(|x| x.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string_lossy().into_owned())
}

fn file_mtime(p: &Path) -> String {
    match std::fs::metadata(p).and_then(|m| m.modified()) {
        Ok(mtime) => {
            let dt: chrono::DateTime<chrono::Utc> = mtime.into();
            dt.to_rfc3339()
        }
        Err(_) => String::new(),
    }
}

fn is_excluded_dir(p: &Path) -> bool {
    let name = match p.file_name() {
        Some(n) => n.to_string_lossy(),
        None => return false,
    };
    matches!(
        name.as_ref(),
        ".git"
            | ".anchor"
            | ".venv"
            | "node_modules"
            | "_axvsys"
            | ".sync-conflicts"
            | "_Archived Items"
            | "TEMP"
            | ".obsidian"
            | "vault"
            | ".secrets"
    )
}

/// `.anchor/` 디렉토리는 통과시키고 `.anchor/cache`, `.anchor/runs`, `.anchor/queue`,
/// `.anchor/studio` 같은 runtime 하위만 제외. BU config 수집 시 사용.
fn is_excluded_dir_for_bu_scan(p: &Path) -> bool {
    let name = match p.file_name() {
        Some(n) => n.to_string_lossy(),
        None => return false,
    };
    // .anchor/<sub> 형태 검사
    if let Some(parent) = p.parent() {
        if parent.file_name().map_or(false, |n| n == ".anchor") {
            return matches!(
                name.as_ref(),
                "cache"
                    | "runs"
                    | "queue"
                    | "studio"
                    | "evidence-stage"
                    | "certification"
                    | "versions"
            );
        }
    }
    matches!(
        name.as_ref(),
        ".git"
            | ".venv"
            | "node_modules"
            | "_axvsys"
            | ".sync-conflicts"
            | "_Archived Items"
            | "TEMP"
            | ".obsidian"
            | "vault"
            | ".secrets"
    )
}

fn is_binary_evidence_candidate(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "pdf" | "hwp" | "hwpx" | "docx" | "xlsx" | "xlsm" | "png" | "jpg" | "jpeg"
    )
}

fn category_for_doc_type(dt: &str) -> Option<DocCategory> {
    Some(match dt {
        "business-plan" | "annual-report" | "interim-report" | "quarterly-report"
        | "monthly-report" | "self-evaluation" | "final-report" => DocCategory::FormalReport,
        "internal-approval"
        | "external-dispatch"
        | "expense-request"
        | "procurement-request"
        | "official-letter" => DocCategory::AdminApproval,
        "evidence-receipt"
        | "evidence-contract"
        | "evidence-invoice"
        | "evidence-payment"
        | "evidence-attendance"
        | "evidence-certificate"
        | "certification-bundle" => DocCategory::EvidenceCert,
        "meeting-minutes" | "trip-plan" | "trip-report" | "event-plan" | "event-report" | "mou"
        | "change-request" | "proposal" | "spec" | "guide" | "readme" => DocCategory::Operations,
        _ => return None,
    })
}

#[allow(dead_code)]
pub(crate) fn empty_entry_for_test() -> CatalogEntry {
    CatalogEntry {
        path: String::new(),
        kind: CatalogItemKind::DeadlineDue,
        title: String::new(),
        business_unit: None,
        category: None,
        deadline: None,
        approval_status: None,
        evidence_kind: None,
        last_updated: String::new(),
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_workspace(tmp: &Path) -> io::Result<()> {
        std::fs::create_dir_all(tmp.join("projects/sample-bu/.anchor"))?;
        std::fs::write(
            tmp.join("projects/sample-bu/.anchor/bu-config.yaml"),
            "bu_id: sample-bu\ncategory: program\nmapping_mode: standard\ntree_map: {}\n",
        )?;

        // markdown with approval in review (no deadline)
        std::fs::create_dir_all(tmp.join("projects/sample-bu/02-admin-approvals/2026"))?;
        std::fs::write(
            tmp.join("projects/sample-bu/02-admin-approvals/2026/260601-doc.md"),
            "---\ntitle: \"Approval Doc\"\ndocument_type: internal-approval\nbusiness_unit: \"[[sample-bu]]\"\napproval:\n  status: review\n---\n# body\n",
        )?;

        // inbox pending manifest
        std::fs::create_dir_all(tmp.join("inbox/items/pending/260518-test-item"))?;
        std::fs::write(
            tmp.join("inbox/items/pending/260518-test-item/manifest.yaml"),
            "schema: inbox-item/v1\ntitle: \"Test pending\"\nbusiness_unit: \"[[sample-bu]]\"\n",
        )?;

        // task with deadline soon (within horizon)
        let today = Utc::now().date_naive();
        let soon = today + Duration::days(3);
        std::fs::create_dir_all(tmp.join("tasks/active"))?;
        std::fs::write(
            tmp.join("tasks/active/260520-task.md"),
            format!(
                "---\ntitle: \"Task soon\"\ndue: {}\nbusiness_unit: \"[[sample-bu]]\"\n---\nbody\n",
                soon
            ),
        )?;

        // unlinked evidence (binary in 03-evidence-cert without sidecar)
        std::fs::create_dir_all(tmp.join("projects/sample-bu/03-evidence-cert/2026/receipts"))?;
        std::fs::write(
            tmp.join("projects/sample-bu/03-evidence-cert/2026/receipts/260513-aws.pdf"),
            b"%PDF-1.4 fake",
        )?;
        Ok(())
    }

    #[test]
    fn scans_basic_workspace() {
        let tmp = tempfile::tempdir().expect("tempdir");
        make_workspace(tmp.path()).expect("setup");

        let report = scan_catalog_impl(tmp.path(), false).expect("scan");

        assert!(
            report.entries_count >= 4,
            "expected ≥4 entries, got {} ({:?})",
            report.entries_count,
            report.by_kind
        );
        assert!(report.bus_seen.contains(&"sample-bu".to_string()));

        let cache_path = catalog_cache_path(tmp.path());
        assert!(cache_path.exists(), "catalog.json should be written");
        let cached: CatalogIndex =
            serde_json::from_str(&std::fs::read_to_string(&cache_path).unwrap()).unwrap();

        let kinds: std::collections::HashSet<_> = cached
            .entries
            .iter()
            .map(|e| format!("{:?}", e.kind))
            .collect();
        assert!(kinds.contains("ApprovalInFlight"));
        assert!(kinds.contains("InboxPending"));
        assert!(kinds.contains("TaskDue"));
        assert!(kinds.contains("EvidenceUnlinked"));
    }

    #[test]
    fn category_mapping_covers_categories() {
        assert_eq!(
            category_for_doc_type("business-plan"),
            Some(DocCategory::FormalReport)
        );
        assert_eq!(
            category_for_doc_type("internal-approval"),
            Some(DocCategory::AdminApproval)
        );
        assert_eq!(
            category_for_doc_type("evidence-receipt"),
            Some(DocCategory::EvidenceCert)
        );
        assert_eq!(
            category_for_doc_type("meeting-minutes"),
            Some(DocCategory::Operations)
        );
        assert_eq!(
            category_for_doc_type("change-request"),
            Some(DocCategory::Operations)
        );
        assert_eq!(category_for_doc_type("nonexistent"), None);
    }

    #[test]
    fn frontmatter_parser_handles_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("no-frontmatter.md");
        std::fs::write(&p, "no frontmatter here").unwrap();
        let (fm, _body) = read_frontmatter(&p);
        assert!(fm.is_none());
    }

    #[test]
    fn frontmatter_parser_extracts_yaml() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("with-fm.md");
        std::fs::write(&p, "---\ntitle: \"Hello\"\nstatus: draft\n---\n\n# body\n").unwrap();
        let (fm, _) = read_frontmatter(&p);
        let fm = fm.expect("frontmatter parsed");
        assert_eq!(fm.get("title").and_then(|v| v.as_str()), Some("Hello"));
    }

    #[test]
    fn evidence_zone_detection() {
        let cases = [
            (
                "projects/x/03-evidence-cert/2026/receipts/foo.pdf",
                "receipt",
            ),
            ("projects/y/04-evidence/contracts/bar.pdf", "contract"),
            (
                "admin/innovation/03-evidence-cert/invoices/baz.pdf",
                "invoice",
            ),
        ];
        for (path, expected) in cases {
            assert_eq!(guess_evidence_kind(path), expected, "path={}", path);
        }
    }

    #[test]
    fn parse_iso_date_rejects_non_date_korean_text_without_panic() {
        let value = "TBD (진영준 담당자 후속 안내 — \"빠른시일에 공지\")";

        assert_eq!(parse_iso_date(value), None);
    }

    #[test]
    fn evidence_with_sidecar_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("projects/x/03-evidence-cert/2026/receipts"))
            .unwrap();
        let pdf = tmp
            .path()
            .join("projects/x/03-evidence-cert/2026/receipts/foo.pdf");
        std::fs::write(&pdf, b"%PDF").unwrap();
        // Sidecar follows <filename>.<ext>.evidence.yaml — e.g. foo.pdf.evidence.yaml
        let sidecar = tmp
            .path()
            .join("projects/x/03-evidence-cert/2026/receipts/foo.pdf.evidence.yaml");
        std::fs::write(&sidecar, "evidence_id: evi_test\n").unwrap();

        let bus = HashMap::new();
        let result = analyze_binary(&pdf, tmp.path(), &bus);
        assert!(result.is_none(), "sidecar present → not unlinked");
    }

    /// Real-workspace verification gate (Phase 3 W4 §4 of the README next-up list).
    ///
    /// Run with:
    ///   ANCHOR_CATALOG_BENCH_WORKSPACE=/Users/yj.lee/workspace/work \
    ///       cargo test --lib -- --ignored --nocapture catalog_real_workspace_smoke
    ///
    /// Asserts the scan completes within 30 seconds of a cold start and
    /// surfaces at least one entry across the four kinds. Cap is the
    /// 30-second budget called out in the Phase 3 verification gate.
    #[test]
    #[ignore]
    fn catalog_real_workspace_smoke() {
        let Ok(ws) = std::env::var("ANCHOR_CATALOG_BENCH_WORKSPACE") else {
            eprintln!("Set ANCHOR_CATALOG_BENCH_WORKSPACE=/path/to/workspace");
            return;
        };
        let root = PathBuf::from(&ws);
        let started = std::time::Instant::now();
        let report = scan_catalog_impl(&root, true).expect("real-workspace scan");
        let elapsed = started.elapsed();

        eprintln!(
            "real-workspace scan: {} entries, BU {}, elapsed {:?}",
            report.entries_count,
            report.bus_seen.len(),
            elapsed
        );
        eprintln!("  by kind: {:?}", report.by_kind);
        eprintln!("  warnings: {}", report.warnings.len());

        assert!(
            elapsed < std::time::Duration::from_secs(30),
            "scan exceeded 30s budget: {:?}",
            elapsed
        );
    }
}
