use crate::atomic_file::{
    with_path_transactions, write_atomic_private, PathTransactionLease, PathTransactionRequest,
};
use crate::paths::GENERATED_DIRS;
use crate::vault::lexical_normalize;
use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

const MARU_SECRETS_REL: &str = ".maru/secrets";
const LEGACY_SECRETS_REL: &str = ".secrets";

const GENERATED_SECRET_LEAF_FILES: &[&str] =
    &[".ds_store", ".localized", "thumbs.db", "desktop.ini"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsRootStatus {
    pub work_path: String,
    pub primary_root: String,
    pub primary_exists: bool,
    pub legacy_path: String,
    pub legacy_exists: bool,
    pub legacy_kind: String,
    pub legacy_target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretInventoryItem {
    pub rel_path: String,
    pub abs_path: String,
    pub root: String,
    pub kind: String,
    pub size_bytes: u64,
    pub mode: Option<String>,
    pub permissions_ok: bool,
    pub symlink_target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretCandidate {
    pub rel_path: String,
    pub abs_path: String,
    pub reason: String,
    pub recommended_rel_path: String,
    pub recommended_abs_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretIssue {
    pub severity: String,
    pub code: String,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsScanReport {
    pub ok: bool,
    pub root: SecretsRootStatus,
    pub managed: Vec<SecretInventoryItem>,
    pub candidates: Vec<SecretCandidate>,
    pub legacy_symlinks: Vec<SecretCandidate>,
    pub issues: Vec<SecretIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsMigrationAction {
    pub action: String,
    pub source_path: Option<String>,
    pub target_path: Option<String>,
    pub rel_path: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsMigrationReport {
    pub applied: bool,
    pub ok: bool,
    pub scan: SecretsScanReport,
    pub actions: Vec<SecretsMigrationAction>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretTextDocument {
    pub rel_path: String,
    pub abs_path: String,
    pub contents: String,
    pub size_bytes: u64,
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretTextWriteRequest {
    pub rel_path: String,
    pub contents: String,
}

#[derive(Debug, Clone)]
pub struct SecretsPaths {
    work: PathBuf,
    primary: PathBuf,
    legacy: PathBuf,
}

impl SecretsPaths {
    fn new(work: &Path) -> Self {
        Self {
            work: work.to_path_buf(),
            primary: work.join(MARU_SECRETS_REL),
            legacy: work.join(LEGACY_SECRETS_REL),
        }
    }
}

pub fn secrets_scan(work_path: String) -> Result<SecretsScanReport, String> {
    let work = normalize_work_path(&work_path)?;
    scan_at(&work)
}

pub fn secrets_doctor(work_path: String) -> Result<SecretsScanReport, String> {
    secrets_scan(work_path)
}

pub fn secrets_migrate(
    work_path: String,
    dry_run: Option<bool>,
    selected: Option<Vec<String>>,
) -> Result<SecretsMigrationReport, String> {
    let work = normalize_work_path(&work_path)?;
    migrate_at(&work, dry_run.unwrap_or(true), selected)
}

pub fn secrets_read_text(
    work_path: String,
    rel_path: String,
) -> Result<SecretTextDocument, String> {
    let work = normalize_work_path(&work_path)?;
    read_text_at(&work, &rel_path)
}

pub fn secrets_write_text(
    work_path: String,
    rel_path: String,
    contents: String,
) -> Result<SecretInventoryItem, String> {
    let work = normalize_work_path(&work_path)?;
    write_text_at(&work, SecretTextWriteRequest { rel_path, contents })
}

pub fn secrets_delete_text(
    work_path: String,
    rel_path: String,
) -> Result<SecretsScanReport, String> {
    let work = normalize_work_path(&work_path)?;
    delete_text_at(&work, &rel_path)
}

pub fn primary_root(work: &Path) -> PathBuf {
    work.join(MARU_SECRETS_REL)
}

pub fn legacy_root(work: &Path) -> PathBuf {
    work.join(LEGACY_SECRETS_REL)
}

pub fn default_telegram_monitor_config(work: &Path) -> PathBuf {
    primary_root(work)
        .join("services")
        .join("telegram-monitor.config.yaml")
}

pub fn is_managed_secret_path(work: &Path, path: &Path) -> bool {
    let normalized = canonical_or_lexical(path);
    let primary = canonical_or_lexical(&primary_root(work));
    let legacy = canonical_or_lexical(&legacy_root(work));
    normalized.starts_with(&primary) || normalized.starts_with(&legacy)
}

fn canonical_or_lexical(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return lexical_normalize(&canonical);
    }
    let mut ancestor = path.parent();
    while let Some(parent) = ancestor {
        if let Ok(canonical_parent) = parent.canonicalize() {
            if let Ok(suffix) = path.strip_prefix(parent) {
                return lexical_normalize(&canonical_parent.join(suffix));
            }
        }
        ancestor = parent.parent();
    }
    lexical_normalize(path)
}

fn migrate_at(
    work: &Path,
    dry_run: bool,
    selected: Option<Vec<String>>,
) -> Result<SecretsMigrationReport, String> {
    let paths = SecretsPaths::new(work);
    // The workspace root is deliberately part of the admitted set. Migration
    // discovers candidates dynamically, so reserving the root covers every
    // source, destination, generated parent and compatibility symlink even if
    // another writer adds a candidate while admission is pending.
    let before = scan_at(work)?;
    let mut transaction_paths = vec![
        paths.work.clone(),
        paths.primary.clone(),
        paths.legacy.clone(),
        paths.work.join(".maru"),
        paths.work.join("workspace.config.yaml"),
        paths.work.join(".gitignore"),
        paths.work.join(".maruignore"),
    ];
    for candidate in before
        .candidates
        .iter()
        .chain(before.legacy_symlinks.iter())
    {
        transaction_paths.push(PathBuf::from(&candidate.abs_path));
        transaction_paths.push(PathBuf::from(&candidate.recommended_abs_path));
    }
    let request = PathTransactionRequest::new(transaction_paths)?;
    with_path_transactions(request, |lease| {
        migrate_in_transaction(lease, work, dry_run, selected)
    })
}

fn migrate_in_transaction(
    lease: &PathTransactionLease,
    work: &Path,
    dry_run: bool,
    selected: Option<Vec<String>>,
) -> Result<SecretsMigrationReport, String> {
    let before = scan_at(work)?;
    let paths = SecretsPaths::new(work);
    let mut refreshed_paths = vec![
        paths.work.clone(),
        paths.primary.clone(),
        paths.legacy.clone(),
    ];
    for candidate in before
        .candidates
        .iter()
        .chain(before.legacy_symlinks.iter())
    {
        refreshed_paths.push(PathBuf::from(&candidate.abs_path));
        refreshed_paths.push(PathBuf::from(&candidate.recommended_abs_path));
    }
    // Re-scan inside admission, then cover every path discovered by that scan
    // before the first effect. This catches a newly introduced physical alias
    // that the initial planning snapshot could not have reserved.
    lease.ensure_covered(refreshed_paths)?;
    lease.before_effect()?;
    let selected = selected.unwrap_or_default();
    let selected_all = selected.is_empty();
    let mut actions = Vec::new();

    if !paths.primary.exists() {
        actions.push(action(
            "ensure-primary-root",
            None,
            Some(&paths.primary),
            None,
            "planned",
        ));
        if !dry_run {
            fs::create_dir_all(&paths.primary)
                .map_err(|err| format!("Cannot create .maru/secrets: {err}"))?;
            set_dir_private(&paths.primary)?;
            mark_action_applied(&mut actions);
        }
    }

    let legacy_meta = fs::symlink_metadata(&paths.legacy).ok();
    if let Some(meta) = legacy_meta {
        if meta.file_type().is_dir() && !meta.file_type().is_symlink() {
            if directory_empty_or_missing(&paths.primary)? {
                actions.push(action(
                    "move-legacy-root",
                    Some(&paths.legacy),
                    Some(&paths.primary),
                    Some(LEGACY_SECRETS_REL),
                    "planned",
                ));
                if !dry_run {
                    if paths.primary.exists() {
                        fs::remove_dir(&paths.primary)
                            .map_err(|err| format!("Cannot replace empty .maru/secrets: {err}"))?;
                    } else if let Some(parent) = paths.primary.parent() {
                        fs::create_dir_all(parent).map_err(|err| {
                            format!("Cannot create .maru directory for secrets: {err}")
                        })?;
                    }
                    fs::rename(&paths.legacy, &paths.primary)
                        .map_err(|err| format!("Cannot move .secrets to .maru/secrets: {err}"))?;
                    set_dir_private(&paths.primary)?;
                    mark_action_applied(&mut actions);
                }
            } else {
                actions.push(action(
                    "merge-legacy-root",
                    Some(&paths.legacy),
                    Some(&paths.primary),
                    Some(LEGACY_SECRETS_REL),
                    "blocked-target-exists",
                ));
            }
        } else if meta.file_type().is_symlink() && legacy_points_to_primary(&paths)? {
            actions.push(action(
                "legacy-symlink-ok",
                Some(&paths.legacy),
                Some(&paths.primary),
                Some(LEGACY_SECRETS_REL),
                "ok",
            ));
        }
    }

    if !legacy_points_to_primary(&paths)? && !paths.legacy.exists() {
        actions.push(action(
            "create-legacy-symlink",
            Some(&paths.legacy),
            Some(&paths.primary),
            Some(LEGACY_SECRETS_REL),
            "planned",
        ));
        if !dry_run {
            create_relative_symlink(&paths.primary, &paths.legacy)?;
            mark_action_applied(&mut actions);
        }
    }

    for candidate in &before.candidates {
        if !selected_all && !selected.iter().any(|item| item == &candidate.rel_path) {
            continue;
        }
        let source = PathBuf::from(&candidate.abs_path);
        let target = PathBuf::from(&candidate.recommended_abs_path);
        actions.push(action(
            "move-secret-file",
            Some(&source),
            Some(&target),
            Some(&candidate.rel_path),
            "planned",
        ));
        if !dry_run {
            if target.exists() && !same_file_hash(&source, &target)? {
                set_last_action_status(&mut actions, "blocked-target-exists");
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("Cannot create secret target directory: {err}"))?;
            }
            fs::rename(&source, &target)
                .map_err(|err| format!("Cannot move secret candidate: {err}"))?;
            set_file_private(&target)?;
            create_relative_symlink(&target, &source)?;
            set_last_action_status(&mut actions, "applied");
        }
    }

    for candidate in &before.legacy_symlinks {
        if !selected_all && !selected.iter().any(|item| item == &candidate.rel_path) {
            continue;
        }
        let link = PathBuf::from(&candidate.abs_path);
        let target = PathBuf::from(&candidate.recommended_abs_path);
        actions.push(action(
            "retarget-legacy-symlink",
            Some(&link),
            Some(&target),
            Some(&candidate.rel_path),
            "planned",
        ));
        if !dry_run {
            fs::remove_file(&link)
                .map_err(|err| format!("Cannot remove legacy symlink for retarget: {err}"))?;
            create_relative_symlink(&target, &link)?;
            set_last_action_status(&mut actions, "applied");
        }
    }

    if !dry_run && paths.primary.exists() {
        normalize_secret_permissions(&paths.primary)?;
    }

    let after = scan_at(work)?;
    Ok(SecretsMigrationReport {
        applied: !dry_run,
        ok: after.ok,
        scan: after,
        actions,
    })
}

fn read_text_at(work: &Path, rel_path: &str) -> Result<SecretTextDocument, String> {
    let paths = SecretsPaths::new(work);
    let (path, normalized_rel) = resolve_primary_secret_path(&paths, rel_path)?;
    ensure_text_secret_path(&normalized_rel)?;
    let meta = fs::symlink_metadata(&path)
        .map_err(|err| format!("Cannot inspect secret text file: {err}"))?;
    if meta.file_type().is_symlink() {
        return Err("secret_text_symlink_unsupported".to_string());
    }
    if !meta.is_file() {
        return Err("secret_text_file_required".to_string());
    }
    let bytes = fs::read(&path).map_err(|err| format!("Cannot read secret text file: {err}"))?;
    if looks_binary(&bytes) {
        return Err("secret_binary_unsupported".to_string());
    }
    let contents = String::from_utf8(bytes).map_err(|_| "secret_text_utf8_required".to_string())?;
    Ok(SecretTextDocument {
        rel_path: normalized_rel,
        abs_path: path.to_string_lossy().to_string(),
        size_bytes: meta.len(),
        mode: file_mode(&path),
        contents,
    })
}

fn write_text_at(
    work: &Path,
    request: SecretTextWriteRequest,
) -> Result<SecretInventoryItem, String> {
    let paths = SecretsPaths::new(work);
    let (path, normalized_rel) = resolve_primary_secret_path(&paths, &request.rel_path)?;
    let transaction = PathTransactionRequest::new(vec![
        paths.work.clone(),
        paths.primary.clone(),
        path.clone(),
    ])?;
    with_path_transactions(transaction, |lease| {
        write_text_in_transaction(lease, &paths, path, normalized_rel, request)
    })
}

fn write_text_in_transaction(
    lease: &PathTransactionLease,
    paths: &SecretsPaths,
    path: PathBuf,
    normalized_rel: String,
    request: SecretTextWriteRequest,
) -> Result<SecretInventoryItem, String> {
    lease.ensure_covered(vec![
        paths.work.clone(),
        paths.primary.clone(),
        path.clone(),
    ])?;
    lease.before_effect()?;
    ensure_text_secret_path(&normalized_rel)?;
    if looks_binary(request.contents.as_bytes()) {
        return Err("secret_binary_unsupported".to_string());
    }
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
            return Err("secret_text_symlink_unsupported".to_string());
        }
        if !meta.is_file() {
            return Err("secret_text_file_required".to_string());
        }
    }
    ensure_secret_parent_dirs(paths, &path)?;
    write_atomic_private(&path, request.contents.as_bytes())
        .map_err(|err| format!("Cannot write secret text file: {err}"))?;
    set_file_private(&path)?;
    inventory_item_for_path(&paths.primary, "primary", &path, normalized_rel)
}

fn delete_text_at(work: &Path, rel_path: &str) -> Result<SecretsScanReport, String> {
    let paths = SecretsPaths::new(work);
    let (path, normalized_rel) = resolve_primary_secret_path(&paths, rel_path)?;
    let transaction = PathTransactionRequest::new(vec![
        paths.work.clone(),
        paths.primary.clone(),
        path.clone(),
    ])?;
    with_path_transactions(transaction, |lease| {
        delete_text_in_transaction(lease, &paths, path, normalized_rel)?;
        scan_at(work)
    })
}

fn delete_text_in_transaction(
    lease: &PathTransactionLease,
    paths: &SecretsPaths,
    path: PathBuf,
    normalized_rel: String,
) -> Result<(), String> {
    lease.ensure_covered(vec![
        paths.work.clone(),
        paths.primary.clone(),
        path.clone(),
    ])?;
    lease.before_effect()?;
    ensure_text_secret_path(&normalized_rel)?;
    let meta = fs::symlink_metadata(&path)
        .map_err(|err| format!("Cannot inspect secret text file: {err}"))?;
    if meta.file_type().is_symlink() {
        return Err("secret_text_symlink_unsupported".to_string());
    }
    if !meta.is_file() {
        return Err("secret_text_file_required".to_string());
    }
    let bytes = fs::read(&path).map_err(|err| format!("Cannot read secret text file: {err}"))?;
    if looks_binary(&bytes) {
        return Err("secret_binary_unsupported".to_string());
    }
    fs::remove_file(&path).map_err(|err| format!("Cannot delete secret text file: {err}"))
}

fn scan_at(work: &Path) -> Result<SecretsScanReport, String> {
    let paths = SecretsPaths::new(work);
    let root = root_status(&paths)?;
    let mut issues = Vec::new();
    let mut managed = Vec::new();
    let mut candidates = Vec::new();
    let mut legacy_symlinks = Vec::new();

    collect_managed(&paths.primary, "primary", &mut managed, &mut issues)?;
    if paths.legacy.exists() && !legacy_points_to_primary(&paths)? {
        collect_managed(&paths.legacy, "legacy", &mut managed, &mut issues)?;
    }

    collect_candidates(&paths, &mut candidates, &mut legacy_symlinks, &mut issues)?;
    collect_config_issues(work, &mut issues);
    collect_ignore_issues(work, &mut issues);

    let ok = issues.iter().all(|issue| issue.severity != "error");
    Ok(SecretsScanReport {
        ok,
        root,
        managed,
        candidates,
        legacy_symlinks,
        issues,
    })
}

fn root_status(paths: &SecretsPaths) -> Result<SecretsRootStatus, String> {
    let legacy_meta = fs::symlink_metadata(&paths.legacy).ok();
    let (legacy_kind, legacy_target) = match legacy_meta {
        None => ("missing".to_string(), None),
        Some(meta) if meta.file_type().is_symlink() => {
            let target = fs::read_link(&paths.legacy)
                .ok()
                .map(|path| path.to_string_lossy().to_string());
            if legacy_points_to_primary(paths)? {
                ("symlink_to_primary".to_string(), target)
            } else {
                ("symlink_other".to_string(), target)
            }
        }
        Some(meta) if meta.is_dir() => ("directory".to_string(), None),
        Some(meta) if meta.is_file() => ("file".to_string(), None),
        Some(_) => ("other".to_string(), None),
    };

    Ok(SecretsRootStatus {
        work_path: paths.work.to_string_lossy().to_string(),
        primary_root: paths.primary.to_string_lossy().to_string(),
        primary_exists: paths.primary.exists(),
        legacy_path: paths.legacy.to_string_lossy().to_string(),
        legacy_exists: paths.legacy.exists(),
        legacy_kind,
        legacy_target,
    })
}

fn collect_managed(
    root: &Path,
    root_label: &str,
    out: &mut Vec<SecretInventoryItem>,
    issues: &mut Vec<SecretIssue>,
) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let root = lexical_normalize(root);
    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path == root {
            continue;
        }
        let rel = path
            .strip_prefix(&root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let Ok(meta) = fs::symlink_metadata(path) else {
            continue;
        };
        if meta.is_dir() {
            if !private_dir_mode_ok(path) {
                issues.push(issue(
                    "warn",
                    "secret_dir_permissions",
                    Some(path),
                    "Secret directory should not be group/world-readable",
                ));
            }
            continue;
        }
        if is_generated_secret_leaf(path) {
            continue;
        }
        let symlink_target = if meta.file_type().is_symlink() {
            fs::read_link(path)
                .ok()
                .map(|target| target.to_string_lossy().to_string())
        } else {
            None
        };
        let permissions_ok = if meta.file_type().is_symlink() {
            true
        } else {
            private_file_mode_ok(path)
        };
        if !permissions_ok {
            issues.push(issue(
                "warn",
                "secret_file_permissions",
                Some(path),
                "Secret file should not be group/world-readable",
            ));
        }
        out.push(SecretInventoryItem {
            rel_path: rel,
            abs_path: path.to_string_lossy().to_string(),
            root: root_label.to_string(),
            kind: if meta.file_type().is_symlink() {
                "symlink".to_string()
            } else if meta.is_file() {
                "file".to_string()
            } else {
                "other".to_string()
            },
            size_bytes: meta.len(),
            mode: file_mode(path),
            permissions_ok,
            symlink_target,
        });
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(())
}

fn inventory_item_for_path(
    root: &Path,
    root_label: &str,
    path: &Path,
    rel_path: String,
) -> Result<SecretInventoryItem, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|err| format!("Cannot inspect secret inventory item: {err}"))?;
    let symlink_target = if meta.file_type().is_symlink() {
        fs::read_link(path)
            .ok()
            .map(|target| target.to_string_lossy().to_string())
    } else {
        None
    };
    let permissions_ok = if meta.file_type().is_symlink() {
        true
    } else {
        private_file_mode_ok(path)
    };
    Ok(SecretInventoryItem {
        rel_path: if rel_path.is_empty() {
            path.strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/")
        } else {
            rel_path
        },
        abs_path: path.to_string_lossy().to_string(),
        root: root_label.to_string(),
        kind: if meta.file_type().is_symlink() {
            "symlink".to_string()
        } else if meta.is_file() {
            "file".to_string()
        } else {
            "other".to_string()
        },
        size_bytes: meta.len(),
        mode: file_mode(path),
        permissions_ok,
        symlink_target,
    })
}

fn collect_candidates(
    paths: &SecretsPaths,
    candidates: &mut Vec<SecretCandidate>,
    legacy_symlinks: &mut Vec<SecretCandidate>,
    issues: &mut Vec<SecretIssue>,
) -> Result<(), String> {
    for entry in WalkDir::new(&paths.work)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !should_prune(paths, entry.path()))
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path == paths.work {
            continue;
        }
        let rel_path = path
            .strip_prefix(&paths.work)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let Ok(meta) = fs::symlink_metadata(path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            if let Ok(target) = fs::read_link(path) {
                let target_text = target.to_string_lossy();
                if target_text.contains(".secrets") {
                    let target_abs = if target.is_absolute() {
                        lexical_normalize(&target)
                    } else {
                        lexical_normalize(&path.parent().unwrap_or(&paths.work).join(target))
                    };
                    let recommended = legacy_target_to_primary(paths, &target_abs);
                    legacy_symlinks.push(SecretCandidate {
                        rel_path,
                        abs_path: path.to_string_lossy().to_string(),
                        reason: "legacy .secrets symlink target".to_string(),
                        recommended_rel_path: recommended
                            .strip_prefix(&paths.primary)
                            .unwrap_or(&recommended)
                            .to_string_lossy()
                            .replace('\\', "/"),
                        recommended_abs_path: recommended.to_string_lossy().to_string(),
                    });
                }
            } else {
                issues.push(issue(
                    "warn",
                    "broken_symlink",
                    Some(path),
                    "Could not read symlink target",
                ));
            }
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let Some(reason) = secret_candidate_reason(path) else {
            continue;
        };
        let recommended = recommended_secret_target(paths, &rel_path);
        candidates.push(SecretCandidate {
            rel_path,
            abs_path: path.to_string_lossy().to_string(),
            reason,
            recommended_rel_path: recommended
                .strip_prefix(&paths.primary)
                .unwrap_or(&recommended)
                .to_string_lossy()
                .replace('\\', "/"),
            recommended_abs_path: recommended.to_string_lossy().to_string(),
        });
    }
    candidates.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    legacy_symlinks.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(())
}

fn should_prune(paths: &SecretsPaths, path: &Path) -> bool {
    let rel = path.strip_prefix(&paths.work).unwrap_or(path);
    if rel.as_os_str().is_empty() {
        return false;
    }
    if rel == Path::new("vault")
        || rel == Path::new(LEGACY_SECRETS_REL)
        || rel == Path::new(MARU_SECRETS_REL)
    {
        return true;
    }
    let rel_text = rel.to_string_lossy().replace('\\', "/");
    if rel_text.starts_with(".maru/secrets/") || rel_text.starts_with(".secrets/") {
        return true;
    }
    rel.components().any(|component| match component {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            GENERATED_DIRS
                .iter()
                .any(|generated| generated == &name.as_ref())
        }
        _ => false,
    })
}

fn is_generated_secret_leaf(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    name.starts_with("._")
        || GENERATED_SECRET_LEAF_FILES
            .iter()
            .any(|generated| generated == &name.as_str())
}

fn resolve_primary_secret_path(
    paths: &SecretsPaths,
    rel_path: &str,
) -> Result<(PathBuf, String), String> {
    let normalized_rel = normalize_secret_rel_path(rel_path)?;
    let primary = lexical_normalize(&paths.primary);
    let path = lexical_normalize(&primary.join(&normalized_rel));
    if !path.starts_with(&primary) {
        return Err("secret_path_outside_primary".to_string());
    }
    // Lexical containment alone would allow an existing symlinked directory
    // below .maru/secrets to redirect reads or writes outside the managed root.
    // Reserve and validate the physical endpoint as well.
    let physical_primary = canonical_or_lexical(&primary);
    let physical_path = canonical_or_lexical(&path);
    if !physical_path.starts_with(&physical_primary) {
        return Err("secret_path_outside_primary".to_string());
    }
    Ok((path, normalized_rel.to_string_lossy().replace('\\', "/")))
}

fn normalize_secret_rel_path(input: &str) -> Result<PathBuf, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("secret_path_required".to_string());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("secret_path_absolute_unsupported".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => normalized.push(name),
            Component::CurDir => {}
            Component::ParentDir => return Err("secret_path_traversal_unsupported".to_string()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("secret_path_absolute_unsupported".to_string())
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("secret_path_required".to_string());
    }
    Ok(normalized)
}

fn ensure_text_secret_path(rel_path: &str) -> Result<(), String> {
    let path = Path::new(rel_path);
    if is_generated_secret_leaf(path) {
        return Err("secret_text_extension_unsupported".to_string());
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    let unsupported = [
        "age", "bin", "cer", "crt", "db", "der", "gz", "key", "p12", "p8", "pdf", "pem", "sqlite",
        "tar", "zip",
    ];
    if unsupported.iter().any(|blocked| blocked == &ext.as_str()) {
        return Err("secret_text_extension_unsupported".to_string());
    }
    Ok(())
}

fn ensure_secret_parent_dirs(paths: &SecretsPaths, path: &Path) -> Result<(), String> {
    let primary = lexical_normalize(&paths.primary);
    let parent = path
        .parent()
        .ok_or_else(|| "secret_parent_missing".to_string())?;
    let parent = lexical_normalize(parent);
    if !parent.starts_with(&primary) {
        return Err("secret_path_outside_primary".to_string());
    }
    fs::create_dir_all(&parent).map_err(|err| format!("Cannot create secret directory: {err}"))?;
    let mut current = primary.clone();
    set_dir_private(&current)?;
    if let Ok(rel) = parent.strip_prefix(&primary) {
        for component in rel.components() {
            if let Component::Normal(name) = component {
                current.push(name);
                set_dir_private(&current)?;
            }
        }
    }
    Ok(())
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

fn secret_candidate_reason(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    if name.ends_with(".example")
        || name == ".env.example"
        || name.ends_with(".sample")
        || name.ends_with(".template")
    {
        return None;
    }
    if name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".env")
        || name.ends_with(".env.local")
    {
        return Some("environment file".to_string());
    }
    if name == "mcp.local.json" {
        return Some("local MCP config".to_string());
    }
    let secret_words = ["credential", "credentials", "secret", "secrets"];
    let secret_exts = [
        "env", "json", "yaml", "yml", "csv", "age", "key", "pem", "p8", "p12",
    ];
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if secret_exts.iter().any(|allowed| allowed == &ext.as_str())
        && secret_words.iter().any(|needle| name.contains(needle))
    {
        return Some("credential-like file name".to_string());
    }
    None
}

fn recommended_secret_target(paths: &SecretsPaths, rel_path: &str) -> PathBuf {
    let parts = rel_path.split('/').collect::<Vec<_>>();
    let filename = parts
        .last()
        .map(|value| normalized_secret_filename(value))
        .unwrap_or_else(|| "secret".to_string());
    if parts.first() == Some(&"sites") && parts.len() >= 2 {
        if parts.contains(&".vercel") {
            return paths
                .primary
                .join("sites")
                .join(parts[1])
                .join(format!("vercel.{filename}"));
        }
        return paths.primary.join("sites").join(parts[1]).join(filename);
    }
    if parts.first() == Some(&"projects") && parts.len() >= 2 {
        return paths.primary.join("projects").join(parts[1]).join(filename);
    }
    if parts.first() == Some(&"dev") && parts.len() >= 2 {
        return paths.primary.join("dev").join(parts[1]).join(filename);
    }
    paths
        .primary
        .join("workspace")
        .join(rel_path)
        .with_file_name(filename)
}

fn normalized_secret_filename(name: &str) -> String {
    match name {
        ".env" => "env".to_string(),
        ".env.local" => "local.env".to_string(),
        _ if name.starts_with(".env.") => {
            let rest = name.trim_start_matches(".env.");
            format!("{rest}.env")
        }
        _ => name.trim_start_matches('.').to_string(),
    }
}

fn legacy_target_to_primary(paths: &SecretsPaths, target_abs: &Path) -> PathBuf {
    if let Ok(rel) = target_abs.strip_prefix(&paths.legacy) {
        return paths.primary.join(rel);
    }
    target_abs.to_path_buf()
}

fn collect_config_issues(work: &Path, issues: &mut Vec<SecretIssue>) {
    let config_path = work.join("workspace.config.yaml");
    let Ok(raw) = fs::read_to_string(&config_path) else {
        return;
    };
    let Ok(yaml) = serde_yaml::from_str::<YamlValue>(&raw) else {
        return;
    };
    collect_legacy_config_refs(&yaml, "workspace.config.yaml".to_string(), issues);
}

fn collect_legacy_config_refs(value: &YamlValue, path: String, issues: &mut Vec<SecretIssue>) {
    match value {
        YamlValue::String(raw) if raw.contains(".secrets") => issues.push(SecretIssue {
            severity: "warn".to_string(),
            code: "legacy_config_ref".to_string(),
            path: Some(path),
            message: "workspace.config.yaml still references .secrets".to_string(),
        }),
        YamlValue::Mapping(map) => {
            for (key, value) in map {
                let key = key.as_str().unwrap_or("<key>");
                collect_legacy_config_refs(value, format!("{path}.{key}"), issues);
            }
        }
        YamlValue::Sequence(items) => {
            for (index, item) in items.iter().enumerate() {
                collect_legacy_config_refs(item, format!("{path}[{index}]"), issues);
            }
        }
        _ => {}
    }
}

fn collect_ignore_issues(work: &Path, issues: &mut Vec<SecretIssue>) {
    for (path, required) in [
        (work.join(".gitignore"), ".maru/secrets/"),
        (work.join(".maruignore"), ".maru/secrets"),
    ] {
        let Ok(raw) = fs::read_to_string(&path) else {
            issues.push(issue(
                "warn",
                "ignore_file_missing",
                Some(&path),
                "Ignore file is missing",
            ));
            continue;
        };
        if !raw.lines().any(|line| line.trim() == required) {
            issues.push(issue(
                "warn",
                "secret_ignore_missing",
                Some(&path),
                "Ignore file does not include .maru/secrets",
            ));
        }
    }
}

fn normalize_work_path(input: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(input);
    if !path.exists() {
        return Err(format!("Work path does not exist: {input}"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("Cannot resolve work path: {err}"))?;
    if !canonical.is_dir() {
        return Err("Work path is not a directory".to_string());
    }
    Ok(canonical)
}

fn legacy_points_to_primary(paths: &SecretsPaths) -> Result<bool, String> {
    let Ok(meta) = fs::symlink_metadata(&paths.legacy) else {
        return Ok(false);
    };
    if !meta.file_type().is_symlink() {
        return Ok(false);
    }
    let target = fs::read_link(&paths.legacy)
        .map_err(|err| format!("Cannot read legacy .secrets symlink: {err}"))?;
    let abs = if target.is_absolute() {
        lexical_normalize(&target)
    } else {
        lexical_normalize(&paths.legacy.parent().unwrap_or(&paths.work).join(target))
    };
    Ok(abs == lexical_normalize(&paths.primary))
}

fn directory_empty_or_missing(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(true);
    }
    if !path.is_dir() {
        return Ok(false);
    }
    let mut entries =
        fs::read_dir(path).map_err(|err| format!("Cannot inspect directory: {err}"))?;
    Ok(entries.next().is_none())
}

fn action(
    action: &str,
    source_path: Option<&Path>,
    target_path: Option<&Path>,
    rel_path: Option<&str>,
    status: &str,
) -> SecretsMigrationAction {
    SecretsMigrationAction {
        action: action.to_string(),
        source_path: source_path.map(|path| path.to_string_lossy().to_string()),
        target_path: target_path.map(|path| path.to_string_lossy().to_string()),
        rel_path: rel_path.map(ToString::to_string),
        status: status.to_string(),
    }
}

fn mark_action_applied(actions: &mut [SecretsMigrationAction]) {
    set_last_action_status(actions, "applied");
}

fn set_last_action_status(actions: &mut [SecretsMigrationAction], status: &str) {
    if let Some(action) = actions.last_mut() {
        action.status = status.to_string();
    }
}

fn issue(severity: &str, code: &str, path: Option<&Path>, message: &str) -> SecretIssue {
    SecretIssue {
        severity: severity.to_string(),
        code: code.to_string(),
        path: path.map(|path| path.to_string_lossy().to_string()),
        message: message.to_string(),
    }
}

fn same_file_hash(left: &Path, right: &Path) -> Result<bool, String> {
    Ok(file_hash(left)? == file_hash(right)?)
}

fn file_hash(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|err| format!("Cannot hash file: {err}"))?;
    Ok(Sha256::digest(bytes).to_vec())
}

fn create_relative_symlink(target: &Path, link: &Path) -> Result<(), String> {
    let parent = link
        .parent()
        .ok_or_else(|| "Symlink parent missing".to_string())?;
    let rel = relative_path(parent, target);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&rel, link)
            .map_err(|err| format!("Cannot create symlink {}: {err}", link.display()))?;
    }
    #[cfg(not(unix))]
    {
        std::os::windows::fs::symlink_file(&rel, link)
            .map_err(|err| format!("Cannot create symlink {}: {err}", link.display()))?;
    }
    Ok(())
}

fn relative_path(from_dir: &Path, to: &Path) -> PathBuf {
    let from = lexical_normalize(from_dir);
    let to = lexical_normalize(to);
    let from_parts = from.components().collect::<Vec<_>>();
    let to_parts = to.components().collect::<Vec<_>>();
    let mut common = 0;
    while common < from_parts.len()
        && common < to_parts.len()
        && from_parts[common] == to_parts[common]
    {
        common += 1;
    }
    let mut out = PathBuf::new();
    for _ in common..from_parts.len() {
        out.push("..");
    }
    for part in &to_parts[common..] {
        out.push(part.as_os_str());
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

fn normalize_secret_permissions(root: &Path) -> Result<(), String> {
    set_dir_private(root)?;
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            set_dir_private(path)?;
        } else if meta.is_file() {
            set_file_private(path)?;
        }
    }
    Ok(())
}

fn private_file_mode_ok(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .map(|meta| meta.permissions().mode() & 0o077 == 0)
            .unwrap_or(true)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        true
    }
}

fn private_dir_mode_ok(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .map(|meta| meta.permissions().mode() & 0o077 == 0)
            .unwrap_or(true)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        true
    }
}

fn set_file_private(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("Cannot set secret file permissions: {err}"))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn set_dir_private(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|err| format!("Cannot set secret directory permissions: {err}"))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn file_mode(path: &Path) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::symlink_metadata(path)
            .ok()
            .map(|meta| format!("{:04o}", meta.permissions().mode() & 0o777))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// IPC boundaries own their inputs; filesystem traversal, parsing and
/// transaction admission run on dedicated blocking workers. The synchronous
/// functions above remain available to the CLI and other Rust callers.
pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn secrets_scan(work_path: String) -> Result<SecretsScanReport, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:secrets_scan");
            super::secrets_scan(work_path)
        })
        .await
        .map_err(|error| format!("secrets_scan_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn secrets_doctor(work_path: String) -> Result<SecretsScanReport, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:secrets_doctor");
            super::secrets_doctor(work_path)
        })
        .await
        .map_err(|error| format!("secrets_doctor_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn secrets_migrate(
        work_path: String,
        dry_run: Option<bool>,
        selected: Option<Vec<String>>,
    ) -> Result<SecretsMigrationReport, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:secrets_migrate",
            );
            super::secrets_migrate(work_path, dry_run, selected)
        })
        .await
        .map_err(|error| format!("secrets_migrate_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn secrets_read_text(
        work_path: String,
        rel_path: String,
    ) -> Result<SecretTextDocument, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:secrets_read_text",
            );
            super::secrets_read_text(work_path, rel_path)
        })
        .await
        .map_err(|error| format!("secrets_read_text_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn secrets_write_text(
        work_path: String,
        rel_path: String,
        contents: String,
    ) -> Result<SecretInventoryItem, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:secrets_write_text",
            );
            super::secrets_write_text(work_path, rel_path, contents)
        })
        .await
        .map_err(|error| format!("secrets_write_text_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn secrets_delete_text(
        work_path: String,
        rel_path: String,
    ) -> Result<SecretsScanReport, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:secrets_delete_text",
            );
            super::secrets_delete_text(work_path, rel_path)
        })
        .await
        .map_err(|error| format!("secrets_delete_text_task_failed: {error}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn scan_finds_unmanaged_env_without_reading_examples() {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path();
        fs::create_dir_all(work.join("sites/demo")).unwrap();
        fs::write(work.join("sites/demo/.env.local"), "TOKEN=secret\n").unwrap();
        fs::write(work.join("sites/demo/.env.example"), "TOKEN=\n").unwrap();
        fs::write(
            work.join("workspace.config.yaml"),
            "version: 1\npaths:\n  primary: .\n",
        )
        .unwrap();
        fs::write(work.join(".gitignore"), ".maru/secrets/\n").unwrap();
        fs::write(work.join(".maruignore"), ".maru/secrets\n").unwrap();

        let report = scan_at(work).unwrap();

        assert_eq!(report.candidates.len(), 1);
        assert_eq!(report.candidates[0].rel_path, "sites/demo/.env.local");
        assert_eq!(
            report.candidates[0].recommended_rel_path,
            "sites/demo/local.env"
        );
    }

    #[test]
    fn managed_path_accepts_primary_and_legacy_roots() {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path();
        assert!(is_managed_secret_path(
            work,
            &work.join(".maru/secrets/services/config.yaml")
        ));
        assert!(is_managed_secret_path(
            work,
            &work.join(".secrets/services/config.yaml")
        ));
        assert!(!is_managed_secret_path(
            work,
            &work.join("outside/config.yaml")
        ));
    }

    #[test]
    fn scan_ignores_generated_managed_secret_files() {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path();
        let secrets = work.join(".maru/secrets");
        fs::create_dir_all(secrets.join("services")).unwrap();
        fs::write(secrets.join(".DS_Store"), "finder metadata\n").unwrap();
        fs::write(secrets.join("._token"), "appledouble metadata\n").unwrap();
        fs::write(secrets.join("desktop.ini"), "windows metadata\n").unwrap();
        fs::write(secrets.join(".localized"), "localized metadata\n").unwrap();
        fs::write(secrets.join("services/demo.env"), "TOKEN=secret\n").unwrap();

        let report = scan_at(work).unwrap();
        let managed_rel_paths = report
            .managed
            .iter()
            .map(|item| item.rel_path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(managed_rel_paths, vec!["services/demo.env"]);
    }

    #[test]
    fn migrate_moves_secret_and_leaves_runtime_symlink() {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path();
        fs::create_dir_all(work.join("sites/demo")).unwrap();
        fs::write(work.join("sites/demo/.env.local"), "TOKEN=secret\n").unwrap();
        fs::write(
            work.join("workspace.config.yaml"),
            "version: 1\npaths:\n  primary: .\n",
        )
        .unwrap();
        fs::write(work.join(".gitignore"), ".maru/secrets/\n").unwrap();
        fs::write(work.join(".maruignore"), ".maru/secrets\n").unwrap();

        let report = migrate_at(work, false, None).unwrap();

        assert!(report.applied);
        assert!(work.join(".maru/secrets/sites/demo/local.env").is_file());
        assert!(fs::symlink_metadata(work.join("sites/demo/.env.local"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(work.join(".secrets"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn selected_migration_only_moves_selected_candidates() {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path();
        fs::create_dir_all(work.join("sites/demo")).unwrap();
        fs::create_dir_all(work.join("sites/other")).unwrap();
        fs::write(work.join("sites/demo/.env.local"), "TOKEN=secret\n").unwrap();
        fs::write(work.join("sites/other/.env.local"), "TOKEN=other\n").unwrap();
        fs::write(
            work.join("workspace.config.yaml"),
            "version: 1\npaths:\n  primary: .\n",
        )
        .unwrap();
        fs::write(work.join(".gitignore"), ".maru/secrets/\n").unwrap();
        fs::write(work.join(".maruignore"), ".maru/secrets\n").unwrap();

        let report =
            migrate_at(work, false, Some(vec!["sites/demo/.env.local".to_string()])).unwrap();

        assert!(report.applied);
        assert!(work.join(".maru/secrets/sites/demo/local.env").is_file());
        assert!(!work.join(".maru/secrets/sites/other/local.env").exists());
        assert!(work.join("sites/other/.env.local").is_file());
    }

    #[test]
    fn text_secret_write_is_contained_and_private() {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path();

        let item = write_text_at(
            work,
            SecretTextWriteRequest {
                rel_path: "services/demo.env".to_string(),
                contents: "TOKEN=secret\n".to_string(),
            },
        )
        .unwrap();
        let doc = read_text_at(work, "services/demo.env").unwrap();

        assert_eq!(item.rel_path, "services/demo.env");
        assert_eq!(doc.contents, "TOKEN=secret\n");
        assert!(write_text_at(
            work,
            SecretTextWriteRequest {
                rel_path: "../outside.env".to_string(),
                contents: "TOKEN=bad\n".to_string(),
            },
        )
        .is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(work.join(".maru/secrets/services/demo.env"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn text_secret_rejects_binary_and_certificate_like_files() {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path();
        fs::create_dir_all(work.join(".maru/secrets/apple")).unwrap();
        fs::write(
            work.join(".maru/secrets/apple/certificate-password"),
            b"a\0b",
        )
        .unwrap();

        assert!(read_text_at(work, "apple/certificate-password").is_err());
        assert!(write_text_at(
            work,
            SecretTextWriteRequest {
                rel_path: "apple/AuthKey_ABC123.p8".to_string(),
                contents: "-----BEGIN PRIVATE KEY-----\n".to_string(),
            },
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn text_secret_rejects_symlink_targets() {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path();
        fs::create_dir_all(work.join(".maru/secrets/services")).unwrap();
        fs::write(work.join("outside.env"), "TOKEN=outside\n").unwrap();
        std::os::unix::fs::symlink(
            "../../outside.env",
            work.join(".maru/secrets/services/demo.env"),
        )
        .unwrap();

        assert!(read_text_at(work, "services/demo.env").is_err());
        assert!(write_text_at(
            work,
            SecretTextWriteRequest {
                rel_path: "services/demo.env".to_string(),
                contents: "TOKEN=next\n".to_string(),
            },
        )
        .is_err());
    }
}

#[cfg(test)]
mod phase08_10 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use crate::workspace_files::phase08_06::TrashFixture;
    use std::future::Future;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::Duration;
    use tempfile::TempDir;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn start<F, T>(future: F) -> mpsc::Receiver<T>
    where
        F: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }

    fn done<T>(receiver: mpsc::Receiver<T>) -> T {
        receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("secret fixture completion")
    }

    #[test]
    fn phase08_10_secrets_all_six_wrappers_yield_on_same_polling_task() {
        let home = Home::new();
        let root = home.root.path();
        let work = text(root);
        boundary(
            root.to_path_buf(),
            "secrets_scan",
            ipc::secrets_scan(work.clone()),
        );
        boundary(
            root.to_path_buf(),
            "secrets_doctor",
            ipc::secrets_doctor(work.clone()),
        );
        boundary(
            root.to_path_buf(),
            "secrets_migrate",
            ipc::secrets_migrate(work.clone(), Some(true), None),
        );
        boundary(
            root.to_path_buf(),
            "secrets_read_text",
            ipc::secrets_read_text(work.clone(), "services/demo.env".into()),
        );
        boundary(
            root.to_path_buf(),
            "secrets_write_text",
            ipc::secrets_write_text(work.clone(), "services/demo.env".into(), "fixture".into()),
        );
        boundary(
            root.to_path_buf(),
            "secrets_delete_text",
            ipc::secrets_delete_text(work, "services/demo.env".into()),
        );
    }

    #[test]
    fn phase08_10_secrets_real_fixture_payloads_and_legacy_errors() {
        let home = Home::new();
        let tmp = TempDir::new_in(home.root.path()).unwrap();
        let work = text(tmp.path());
        let item = run(ipc::secrets_write_text(
            work.clone(),
            "services/demo.env".into(),
            "TOKEN=fixture-value\n".into(),
        ))
        .unwrap();
        assert_eq!(item.rel_path, "services/demo.env");
        assert_eq!(
            run(ipc::secrets_read_text(
                work.clone(),
                "services/demo.env".into()
            ))
            .unwrap()
            .contents,
            "TOKEN=fixture-value\n"
        );
        assert!(run(ipc::secrets_scan(work.clone())).unwrap().ok);
        assert!(run(ipc::secrets_doctor(work.clone())).unwrap().ok);
        assert_eq!(
            run(ipc::secrets_write_text(
                work.clone(),
                "../outside.env".into(),
                "TOKEN=denied\n".into(),
            ))
            .unwrap_err(),
            "secret_path_traversal_unsupported"
        );
        assert!(run(ipc::secrets_read_text(
            work.clone(),
            "/tmp/outside.env".into(),
        ))
        .unwrap_err()
        .contains("secret_path_absolute_unsupported"));
        let migration = run(ipc::secrets_migrate(work.clone(), Some(true), None)).unwrap();
        assert!(!migration.applied);
        assert!(
            run(ipc::secrets_delete_text(
                work.clone(),
                "services/demo.env".into()
            ))
            .unwrap()
            .ok
        );
        assert_eq!(
            run(ipc::secrets_read_text(work, "services/demo.env".into())).unwrap_err(),
            "Cannot inspect secret text file: No such file or directory (os error 2)"
        );
    }

    #[test]
    fn phase08_10_secrets_writer_contention_and_error_release() {
        let home = Home::new();
        let tmp = TempDir::new_in(home.root.path()).unwrap();
        let root = tmp.path().to_path_buf();
        let work = text(&root);
        let held = Held::new(root.clone(), "admitted");
        let first = start(ipc::secrets_write_text(
            work.clone(),
            "services/contended.env".into(),
            "TOKEN=first\n".into(),
        ));
        held.wait();

        let waiting = Held::new(root.clone(), "before-admission");
        let second = start(ipc::secrets_write_text(
            work.clone(),
            "services/contended.env".into(),
            "TOKEN=second\n".into(),
        ));
        waiting.wait();
        waiting.release();
        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());

        let failed_once = AtomicBool::new(false);
        let injection = PathTransactionTestHook::new(root.clone(), "pre-effect", move || {
            if !failed_once.swap(true, Ordering::SeqCst) {
                panic!("fixture transaction failure");
            }
        });
        held.release();
        assert!(done(first)
            .unwrap_err()
            .starts_with("secrets_write_text_task_failed:"));
        done(second).unwrap();
        drop(injection);
        assert_eq!(
            fs::read_to_string(root.join(".maru/secrets/services/contended.env")).unwrap(),
            "TOKEN=second\n"
        );
    }

    #[test]
    fn phase08_10_secrets_migration_contention_and_error_release() {
        let home = Home::new();
        let tmp = TempDir::new_in(home.root.path()).unwrap();
        let root = tmp.path().to_path_buf();
        fs::create_dir_all(root.join("sites/demo")).unwrap();
        fs::write(
            root.join("sites/demo/.env.local"),
            "TOKEN=migration-fixture\n",
        )
        .unwrap();
        let work = text(&root);

        let held = Held::new(root.clone(), "admitted");
        let first = start(ipc::secrets_migrate(work.clone(), Some(false), None));
        held.wait();
        let waiting = Held::new(root.clone(), "before-admission");
        let second = start(ipc::secrets_migrate(work.clone(), Some(false), None));
        waiting.wait();
        waiting.release();
        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
        let failed_once = AtomicBool::new(false);
        let injection = PathTransactionTestHook::new(root.clone(), "pre-effect", move || {
            if !failed_once.swap(true, Ordering::SeqCst) {
                panic!("fixture migration failure");
            }
        });
        held.release();
        assert!(done(first)
            .unwrap_err()
            .starts_with("secrets_migrate_task_failed:"));
        done(second).unwrap();
        drop(injection);
        assert!(root.join(".maru/secrets/sites/demo/local.env").is_file());
        assert!(root.join("sites/demo/.env.local").is_symlink());
    }

    #[test]
    fn phase08_10_secrets_delete_contention_and_error_release() {
        let home = Home::new();
        let tmp = TempDir::new_in(home.root.path()).unwrap();
        let root = tmp.path().to_path_buf();
        let work = text(&root);
        run(ipc::secrets_write_text(
            work.clone(),
            "services/delete.env".into(),
            "TOKEN=delete-fixture\n".into(),
        ))
        .unwrap();

        let held = Held::new(root.clone(), "admitted");
        let first = start(ipc::secrets_delete_text(
            work.clone(),
            "services/delete.env".into(),
        ));
        held.wait();
        let waiting = Held::new(root.clone(), "before-admission");
        let second = start(ipc::secrets_delete_text(
            work.clone(),
            "services/delete.env".into(),
        ));
        waiting.wait();
        waiting.release();
        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
        let failed_once = AtomicBool::new(false);
        let injection = PathTransactionTestHook::new(root.clone(), "pre-effect", move || {
            if !failed_once.swap(true, Ordering::SeqCst) {
                panic!("fixture deletion failure");
            }
        });
        held.release();
        assert!(done(first)
            .unwrap_err()
            .starts_with("secrets_delete_text_task_failed:"));
        done(second).unwrap();
        drop(injection);
        assert!(!root.join(".maru/secrets/services/delete.env").exists());
    }

    #[test]
    fn phase08_10_secrets_writer_serializes_with_files_rename() {
        let home = Home::new();
        let parent = home.root.path();
        let root = parent.join("work-rename");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("note.md"), "# fixture\n").unwrap();
        let work = text(&root);

        let held = Held::new(root.clone(), "admitted");
        let first = start(ipc::secrets_write_text(
            work.clone(),
            "services/rename.env".into(),
            "TOKEN=rename\n".into(),
        ));
        held.wait();
        let waiting = Held::new(root.clone(), "before-admission");
        let rename = start(crate::workspace_files::ipc::rename_workspace_entry(
            text(parent),
            "work-rename".into(),
            "renamed-work".into(),
        ));
        waiting.wait();
        waiting.release();
        assert!(rename.recv_timeout(Duration::from_millis(30)).is_err());
        held.release();
        done(first).unwrap();
        done(rename).unwrap();
        let moved = parent.join("renamed-work");
        assert!(moved.join("note.md").is_file());
        assert!(moved.join(".maru/secrets/services/rename.env").is_file());

        // Reverse order: the parent operation owns the workspace first, and
        // the secret writer waits before its original workspace disappears.
        let reverse_root = parent.join("work-rename-reverse");
        fs::create_dir_all(&reverse_root).unwrap();
        fs::write(reverse_root.join("note.md"), "# fixture\n").unwrap();
        let reverse_work = text(&reverse_root);
        let document_held = Held::new(reverse_root.clone(), "pre-effect");
        let document = start(crate::workspace_files::ipc::rename_workspace_entry(
            text(parent),
            "work-rename-reverse".into(),
            "renamed-work-reverse".into(),
        ));
        document_held.wait();
        let secret_waiting = Held::new(reverse_root.clone(), "before-admission");
        let secret = start(ipc::secrets_write_text(
            reverse_work,
            "services/reverse-rename.env".into(),
            "TOKEN=reverse-rename\n".into(),
        ));
        secret_waiting.wait();
        secret_waiting.release();
        assert!(secret.recv_timeout(Duration::from_millis(30)).is_err());
        document_held.release();
        done(document).unwrap();
        assert!(done(secret).is_err());
        assert!(parent
            .join("renamed-work-reverse")
            .join("note.md")
            .is_file());
        assert!(!reverse_root.exists());
    }

    #[test]
    fn phase08_10_secrets_writer_serializes_with_files_trash() {
        let home = Home::new();
        let parent = home.root.path();
        let root = parent.join("work-trash");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("note.md"), "# fixture\n").unwrap();
        let trashed = parent.join("trashed-work");
        let _trash = TrashFixture::new(root.clone(), trashed.clone());
        let work = text(&root);

        let held = Held::new(root.clone(), "admitted");
        let first = start(ipc::secrets_write_text(
            work.clone(),
            "services/trash.env".into(),
            "TOKEN=trash\n".into(),
        ));
        held.wait();
        let waiting = Held::new(root.clone(), "before-admission");
        let trash = start(crate::workspace_files::ipc::trash_workspace_entries(
            text(parent),
            vec!["work-trash".into()],
        ));
        waiting.wait();
        waiting.release();
        assert!(trash.recv_timeout(Duration::from_millis(30)).is_err());
        held.release();
        done(first).unwrap();
        done(trash).unwrap();
        assert!(!root.exists());
        assert!(trashed.join("note.md").is_file());
        assert!(trashed.join(".maru/secrets/services/trash.env").is_file());

        // Reverse order: the Files trash move completes while the secret
        // writer is waiting on the original workspace identity.
        let reverse_root = parent.join("work-trash-reverse");
        fs::create_dir_all(&reverse_root).unwrap();
        fs::write(reverse_root.join("note.md"), "# fixture\n").unwrap();
        let reverse_trashed = parent.join("trashed-work-reverse");
        let _reverse_trash = TrashFixture::new(reverse_root.clone(), reverse_trashed.clone());
        let reverse_work = text(&reverse_root);
        let document_held = Held::new(reverse_root.clone(), "pre-effect");
        let document = start(crate::workspace_files::ipc::trash_workspace_entries(
            text(parent),
            vec!["work-trash-reverse".into()],
        ));
        document_held.wait();
        let secret_waiting = Held::new(reverse_root.clone(), "before-admission");
        let secret = start(ipc::secrets_write_text(
            reverse_work,
            "services/reverse-trash.env".into(),
            "TOKEN=reverse-trash\n".into(),
        ));
        secret_waiting.wait();
        secret_waiting.release();
        assert!(secret.recv_timeout(Duration::from_millis(30)).is_err());
        document_held.release();
        done(document).unwrap();
        assert!(done(secret).is_err());
        assert!(reverse_trashed.join("note.md").is_file());
        assert!(!reverse_root.exists());
    }

    async fn matrix_mutation(op: &str, work: String) -> Result<(), String> {
        match op {
            "migrate" => ipc::secrets_migrate(work, Some(false), None)
                .await
                .map(|_| ()),
            "write" => {
                ipc::secrets_write_text(work, "services/matrix.env".into(), "TOKEN=matrix\n".into())
                    .await
                    .map(|_| ())
            }
            "delete" => ipc::secrets_delete_text(work, "services/matrix.env".into())
                .await
                .map(|_| ()),
            _ => unreachable!("unknown secret matrix operation"),
        }
    }

    #[test]
    fn phase08_10_secrets_all_mutators_parent_rename_trash_both_orders_and_aliases() {
        let home = Home::new();
        for op in ["migrate", "write", "delete"] {
            for parent_first in [false, true] {
                for trash_parent in [false, true] {
                    for alias in [false, true] {
                        #[cfg(not(unix))]
                        if alias {
                            continue;
                        }
                        let suffix = format!("{op}-{parent_first}-{trash_parent}-{alias}");
                        let parent = home.root.path();
                        let root = parent.join(format!("matrix-work-{suffix}"));
                        let moved = parent.join(format!("matrix-moved-{suffix}"));
                        fs::create_dir_all(&root).unwrap();
                        fs::write(root.join("note.md"), "# fixture\n").unwrap();
                        if op == "migrate" {
                            fs::create_dir_all(root.join("sites/demo")).unwrap();
                            fs::write(
                                root.join("sites/demo/.env.local"),
                                "TOKEN=migration-matrix\n",
                            )
                            .unwrap();
                        } else if op == "delete" {
                            run(ipc::secrets_write_text(
                                text(&root),
                                "services/matrix.env".into(),
                                "TOKEN=delete-matrix\n".into(),
                            ))
                            .unwrap();
                        }

                        let parent_alias = parent.join(format!("matrix-parent-alias-{suffix}"));
                        let parent_work = if alias {
                            #[cfg(unix)]
                            {
                                std::os::unix::fs::symlink(parent, &parent_alias).unwrap();
                                text(&parent_alias)
                            }
                            #[cfg(not(unix))]
                            {
                                unreachable!()
                            }
                        } else {
                            text(parent)
                        };
                        let source = text(&root);
                        let new_name = moved.file_name().unwrap().to_string_lossy().into_owned();
                        let _parent_trash = if trash_parent {
                            Some(TrashFixture::new(root.clone(), moved.clone()))
                        } else {
                            None
                        };
                        let parent_future = async move {
                            if trash_parent {
                                crate::workspace_files::ipc::trash_workspace_entries(
                                    parent_work,
                                    vec![source],
                                )
                                .await
                                .map(|_| ())
                            } else {
                                crate::workspace_files::ipc::rename_workspace_entry(
                                    parent_work,
                                    source,
                                    new_name,
                                )
                                .await
                                .map(|_| ())
                            }
                        };
                        if parent_first {
                            let held = Held::new(root.clone(), "admitted");
                            let first = start(parent_future);
                            held.wait();
                            let waiting = Held::new(root.clone(), "before-admission");
                            let second = start(matrix_mutation(op, text(&root)));
                            waiting.wait();
                            waiting.release();
                            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(first).unwrap();
                            assert!(done(second).is_err(), "{op} must reject vanished parent");
                        } else {
                            let held = Held::new(root.clone(), "admitted");
                            let first = start(matrix_mutation(op, text(&root)));
                            held.wait();
                            let waiting = Held::new(root.clone(), "before-admission");
                            let second = start(parent_future);
                            waiting.wait();
                            waiting.release();
                            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(first).unwrap();
                            done(second).unwrap();
                        }
                        assert!(!root.exists(), "vanished workspace recreated: {op}");
                        assert!(moved.exists());
                        if !parent_first {
                            match op {
                                "migrate" => assert!(moved
                                    .join(".maru/secrets/sites/demo/local.env")
                                    .is_file()),
                                "write" => assert!(moved
                                    .join(".maru/secrets/services/matrix.env")
                                    .is_file()),
                                "delete" => assert!(!moved
                                    .join(".maru/secrets/services/matrix.env")
                                    .exists()),
                                _ => unreachable!(),
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_10_secrets_migration_rejects_new_physical_alias_before_effect() {
        let home = Home::new();
        let tmp = TempDir::new_in(home.root.path()).unwrap();
        let outside = TempDir::new_in(home.root.path()).unwrap();
        let root = tmp.path().to_path_buf();
        let outside_secret = outside.path().join(".secrets/escape.env");
        fs::create_dir_all(outside_secret.parent().unwrap()).unwrap();
        fs::write(&outside_secret, "TOKEN=outside\n").unwrap();
        let alias = root.join("legacy-link");
        let alias_for_hook = alias.clone();
        let outside_for_hook = outside_secret.clone();
        let hook = PathTransactionTestHook::new(root.clone(), "admitted", move || {
            if !alias_for_hook.exists() {
                std::os::unix::fs::symlink(&outside_for_hook, &alias_for_hook).unwrap();
            }
        });
        let error = run(ipc::secrets_migrate(text(&root), Some(false), None)).unwrap_err();
        drop(hook);
        assert!(
            error.contains("Nested mutation exceeds the admitted path set"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(outside_secret).unwrap(),
            "TOKEN=outside\n"
        );
        assert!(!root.join(".maru").exists());
        fs::remove_file(alias).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn phase08_10_secrets_write_rejects_stale_maru_alias_before_effect() {
        let home = Home::new();
        let tmp = TempDir::new_in(home.root.path()).unwrap();
        let outside = TempDir::new_in(home.root.path()).unwrap();
        let root = tmp.path().to_path_buf();
        let stale_maru = outside.path().join("maru");
        fs::create_dir_all(&stale_maru).unwrap();
        let maru = root.join(".maru");
        let maru_for_hook = maru.clone();
        let stale_for_hook = stale_maru.clone();
        let hook = PathTransactionTestHook::new(root.clone(), "admitted", move || {
            if !maru_for_hook.exists() {
                std::os::unix::fs::symlink(&stale_for_hook, &maru_for_hook).unwrap();
            }
        });
        let error = run(ipc::secrets_write_text(
            text(&root),
            "services/stale.env".into(),
            "TOKEN=stale\n".into(),
        ))
        .unwrap_err();
        drop(hook);
        assert!(
            error.contains("Nested mutation exceeds the admitted path set"),
            "{error}"
        );
        assert!(!stale_maru.join("secrets/services/stale.env").exists());
        fs::remove_file(maru).unwrap();
    }
}
