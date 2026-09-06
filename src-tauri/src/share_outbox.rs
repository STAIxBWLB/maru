//! Shared Outbox: stage files as share-ready copies via the `share-outbox`
//! skill. `workspace.config.yaml`'s `share_outbox` block is the SSOT; this
//! module only ever creates/edits `share_outbox.root` and reads the rest. The
//! personal/runtime keys (`timezone`, `default_author`, `authors`, `filename`,
//! `paths`) are never synthesized — when they are missing, Apply is disabled.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use walkdir::WalkDir;

use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionRequest,
};
use crate::inbox_settings::{expand_tilde, lexical_normalize_path, workspace_config_path};
use crate::skill_host;
use crate::skill_host::store::SkillRecord;
use crate::vault::resolve_inside_vault;
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use crate::win_process::NoWindow;

/// Keys the skill's `prepare_share_file.py` `require_config` enforces.
const REQUIRED_KEYS: [&str; 6] = [
    "root",
    "timezone",
    "default_author",
    "authors",
    "filename",
    "paths",
];
/// Mirrors the private `skill_host::store::BUILTIN_SOURCE_ID`.
const BUILTIN_SOURCE_ID: &str = "maru-builtin";
const SCAN_LIMIT: usize = 50;
const DEFAULT_RECEIPTS: &str = "_state/index.jsonl";

// ---------------------------------------------------------------------------
// Serde types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOutboxAuthorView {
    pub key: String,
    pub suffix: Option<String>,
    pub name_ref: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOutboxConfigView {
    /// `share_outbox` present at all in workspace.config.yaml.
    pub present: bool,
    /// Raw `root` string as stored (may contain `~`); None if absent/empty.
    pub root: Option<String>,
    /// Tilde-expanded, lexically-normalized absolute path; None if root absent.
    pub root_resolved: Option<String>,
    pub root_exists: bool,
    /// Whether `root_resolved` is lexically inside `work_path`. Reported, never throws.
    pub inside_workspace: bool,
    /// All six required keys present AND root inside workspace.
    pub has_required_config: bool,
    pub missing_keys: Vec<String>,
    pub timezone: Option<String>,
    pub default_author: Option<String>,
    pub authors: Vec<ShareOutboxAuthorView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOutboxEnsureResult {
    pub root_resolved: String,
    pub created: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOutboxSource {
    pub path: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOutboxApplyOptions {
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub replace: bool,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOutboxResult {
    pub source: String,
    pub ok: bool,
    pub dry_run: bool,
    pub output: Option<String>,
    pub error: Option<String>,
}

impl ShareOutboxResult {
    fn failure(source: &str, error: impl Into<String>) -> Self {
        Self {
            source: source.to_string(),
            ok: false,
            dry_run: false,
            output: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOutboxRecentItem {
    pub output: String,
    pub name: String,
    pub title: String,
    pub author: String,
    pub timestamp: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOutboxScan {
    pub root_resolved: Option<String>,
    pub root_exists: bool,
    pub index_exists: bool,
    pub items: Vec<ShareOutboxRecentItem>,
    pub total_receipts: usize,
    pub skipped_lines: usize,
}

impl ShareOutboxScan {
    fn empty() -> Self {
        Self {
            root_resolved: None,
            root_exists: false,
            index_exists: false,
            items: Vec::new(),
            total_receipts: 0,
            skipped_lines: 0,
        }
    }
}

/// Receipt as written by `prepare_share_file.py` (snake_case JSON). Internal —
/// only the fields the recent-list needs are modeled; serde ignores the rest.
#[derive(Debug, Clone, Deserialize)]
struct Receipt {
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    output: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author_key: String,
    #[serde(default)]
    timestamp: String,
    #[serde(default)]
    timestamp_iso: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

pub fn read_share_outbox_config(work_path: String) -> Result<ShareOutboxConfigView, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    let yaml = load_yaml(&work)?;
    Ok(build_config_view(&work, yaml.as_ref()))
}

pub fn save_share_outbox_root(
    work_path: String,
    root: String,
) -> Result<ShareOutboxConfigView, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    let (raw_root, root_abs, inside) =
        resolve_root(&work, &root).ok_or("share_outbox_root_required")?;
    if !inside {
        return Err("share_outbox_root_outside_workspace".to_string());
    }
    let path = workspace_config_path(&work);
    let mut paths = vec![path.clone(), root_abs.clone()];
    extend_workspace_alias_paths(&mut paths, &work_path, &root_abs, &work)?;
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        save_share_outbox_root_in_transaction(lease, &work_path, &raw_root, &root_abs, &work)
    })
}

pub fn ensure_share_outbox_root(work_path: String) -> Result<ShareOutboxEnsureResult, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    let yaml = load_yaml(&work)?;
    let map = yaml.as_ref().and_then(share_outbox_mapping);
    let raw_root = map
        .and_then(|m| string_field(m, "root"))
        .ok_or("share_outbox_root_missing")?;
    let (_, abs, inside) = resolve_root(&work, &raw_root).ok_or("share_outbox_root_missing")?;
    if !inside {
        return Err("share_outbox_root_outside_workspace".to_string());
    }
    let config_path = workspace_config_path(&work);
    let mut paths = vec![config_path, abs.clone()];
    extend_workspace_alias_paths(&mut paths, &work_path, &abs, &work)?;
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        ensure_share_outbox_root_in_transaction(lease, &work_path, &abs, &work)
    })
}

pub fn scan_share_outbox(work_path: String) -> Result<ShareOutboxScan, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    let yaml = load_yaml(&work)?;
    let map = yaml.as_ref().and_then(share_outbox_mapping);
    let Some((_, root_abs, _inside)) = map
        .and_then(|m| string_field(m, "root"))
        .and_then(|r| resolve_root(&work, &r))
    else {
        return Ok(ShareOutboxScan::empty());
    };
    let root_exists = root_abs.is_dir();
    let root_resolved = Some(root_abs.to_string_lossy().to_string());

    let receipts_rel = map
        .and_then(|m| m.get(YamlValue::String("paths".to_string())))
        .and_then(|v| v.as_mapping())
        .and_then(|m| string_field(m, "receipts"))
        .unwrap_or_else(|| DEFAULT_RECEIPTS.to_string());
    let empty_scan = ShareOutboxScan {
        root_resolved: root_resolved.clone(),
        root_exists,
        index_exists: false,
        items: Vec::new(),
        total_receipts: 0,
        skipped_lines: 0,
    };

    if validate_receipts_fragment(&receipts_rel).is_err() {
        return Ok(empty_scan);
    }
    let index_path = lexical_normalize_path(&root_abs.join(&receipts_rel));
    if !index_path.starts_with(&root_abs) || !index_path.is_file() {
        return Ok(empty_scan);
    }
    let text = fs::read_to_string(&index_path)
        .map_err(|err| format!("Cannot read share outbox receipts: {err}"))?;
    let (mut receipts, skipped) = parse_receipts(&text);
    let total = receipts.len();
    sort_recent(&mut receipts);
    let items = receipts
        .into_iter()
        .take(SCAN_LIMIT)
        .map(|r| {
            let exists = Path::new(&r.output).is_file();
            ShareOutboxRecentItem {
                name: basename(&r.output),
                output: r.output,
                title: r.title,
                author: r.author_key,
                timestamp: r.timestamp,
                exists,
            }
        })
        .collect();
    Ok(ShareOutboxScan {
        root_resolved,
        root_exists,
        index_exists: true,
        items,
        total_receipts: total,
        skipped_lines: skipped,
    })
}

pub fn prepare_share_outbox_files(
    work_path: String,
    sources: Vec<ShareOutboxSource>,
    options: ShareOutboxApplyOptions,
) -> Result<Vec<ShareOutboxResult>, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    if sources.is_empty() {
        return Err("no_sources_selected".to_string());
    }
    let yaml = load_yaml(&work)?;
    let view = build_config_view(&work, yaml.as_ref());
    if !view.has_required_config {
        return Err("share_outbox_config_incomplete".to_string());
    }

    let map = yaml.as_ref().and_then(share_outbox_mapping);
    let (_, root_abs, inside) = map
        .and_then(|m| string_field(m, "root"))
        .and_then(|raw| resolve_root(&work, &raw))
        .ok_or("share_outbox_root_missing")?;
    if !inside {
        return Err("share_outbox_root_outside_workspace".to_string());
    }
    let receipts_rel = map
        .and_then(|m| m.get(YamlValue::String("paths".to_string())))
        .and_then(|v| v.as_mapping())
        .and_then(|m| string_field(m, "receipts"))
        .unwrap_or_else(|| DEFAULT_RECEIPTS.to_string());
    let monthly_rel = map
        .and_then(|m| m.get(YamlValue::String("paths".to_string())))
        .and_then(|v| v.as_mapping())
        .and_then(|m| string_field(m, "monthly"))
        .unwrap_or_else(|| "{yyyy}-{mm}".to_string());
    if validate_receipts_fragment(&receipts_rel).is_err() {
        return Err("share_outbox_receipts_outside_root".to_string());
    }
    if validate_receipts_fragment(&monthly_rel).is_err() {
        return Err("share_outbox_monthly_outside_root".to_string());
    }
    let receipt_path = lexical_normalize_path(&root_abs.join(&receipts_rel));
    if !receipt_path.starts_with(&root_abs) {
        return Err("share_outbox_receipts_outside_root".to_string());
    }

    let mut paths = vec![workspace_config_path(&work), root_abs.clone(), receipt_path];
    paths.extend(collect_output_alias_paths(&root_abs)?);
    for source in &sources {
        if let Ok(path) = resolve_inside_vault(&work_path, &source.path) {
            paths.push(path);
        }
    }
    extend_workspace_alias_paths(&mut paths, &work_path, &root_abs, &work)?;
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        prepare_share_outbox_files_in_transaction(
            lease, work_path, sources, options, &work, &root_abs,
        )
    })
}

fn save_share_outbox_root_in_transaction(
    lease: &PathTransactionLease,
    work_path: &str,
    raw_root: &str,
    initial_root: &Path,
    initial_work: &Path,
) -> Result<ShareOutboxConfigView, String> {
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    let work = resolve_inside_vault(work_path, ".")?;
    if work != initial_work {
        return Err("Transaction parent changed; retry the operation".to_string());
    }
    let (_, current_root, inside) =
        resolve_root(&work, raw_root).ok_or("share_outbox_root_required")?;
    lease.ensure_covered([workspace_config_path(&work), current_root.clone()])?;
    if current_root != initial_root || !inside {
        return Err("share_outbox_root_changed; retry the operation".to_string());
    }
    assert_maru_can_write(&work.to_string_lossy(), WorkspaceWriteAction::Share)?;
    let path = workspace_config_path(&work);
    if !path.exists() {
        return Err("workspace_config_missing".to_string());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read workspace.config.yaml: {err}"))?;
    let yaml: YamlValue = serde_yaml::from_str(&raw)
        .map_err(|err| format!("Cannot parse workspace.config.yaml: {err}"))?;
    // Round-trip the share_outbox mapping untyped so sibling keys survive; set
    // only `root`. Absent => minimal {root} block (Apply stays disabled until
    // the user fills the rest of the required keys themselves).
    let mut map = share_outbox_mapping(&yaml)
        .cloned()
        .unwrap_or_else(serde_yaml::Mapping::new);
    map.insert(
        YamlValue::String("root".to_string()),
        YamlValue::String(raw_root.to_string()),
    );
    let block = share_outbox_yaml_block(&map)?;
    let next = replace_top_level_yaml_block(&raw, "share_outbox", &block);
    write_atomic(&path, next.as_bytes())
        .map_err(|err| format!("Cannot write workspace.config.yaml: {err}"))?;
    let yaml2 = load_yaml(&work)?;
    Ok(build_config_view(&work, yaml2.as_ref()))
}

fn ensure_share_outbox_root_in_transaction(
    lease: &PathTransactionLease,
    work_path: &str,
    initial_root: &Path,
    initial_work: &Path,
) -> Result<ShareOutboxEnsureResult, String> {
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    let work = resolve_inside_vault(work_path, ".")?;
    if work != initial_work {
        return Err("Transaction parent changed; retry the operation".to_string());
    }
    let yaml = load_yaml(&work)?;
    let map = yaml.as_ref().and_then(share_outbox_mapping);
    let raw_root = map
        .and_then(|m| string_field(m, "root"))
        .ok_or("share_outbox_root_missing")?;
    let (_, abs, inside) = resolve_root(&work, &raw_root).ok_or("share_outbox_root_missing")?;
    lease.ensure_covered([workspace_config_path(&work), abs.clone()])?;
    if abs != initial_root || !inside {
        return Err("share_outbox_root_changed; retry the operation".to_string());
    }
    assert_maru_can_write(&work.to_string_lossy(), WorkspaceWriteAction::Share)?;
    let existed = abs.is_dir();
    if !existed {
        fs::create_dir_all(&abs)
            .map_err(|err| format!("Cannot create share outbox root: {err}"))?;
    }
    Ok(ShareOutboxEnsureResult {
        root_resolved: abs.to_string_lossy().to_string(),
        created: !existed,
    })
}

fn prepare_share_outbox_files_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    sources: Vec<ShareOutboxSource>,
    options: ShareOutboxApplyOptions,
    initial_work: &Path,
    initial_root: &Path,
) -> Result<Vec<ShareOutboxResult>, String> {
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    let work = resolve_inside_vault(&work_path, ".")?;
    if work != initial_work {
        return Err("Transaction parent changed; retry the operation".to_string());
    }
    let yaml = load_yaml(&work)?;
    let view = build_config_view(&work, yaml.as_ref());
    if !view.has_required_config {
        return Err("share_outbox_config_incomplete".to_string());
    }
    let map = yaml.as_ref().and_then(share_outbox_mapping);
    let (_, root_abs, inside) = map
        .and_then(|m| string_field(m, "root"))
        .and_then(|raw| resolve_root(&work, &raw))
        .ok_or("share_outbox_root_missing")?;
    let receipts_rel = map
        .and_then(|m| m.get(YamlValue::String("paths".to_string())))
        .and_then(|v| v.as_mapping())
        .and_then(|m| string_field(m, "receipts"))
        .unwrap_or_else(|| DEFAULT_RECEIPTS.to_string());
    let monthly_rel = map
        .and_then(|m| m.get(YamlValue::String("paths".to_string())))
        .and_then(|v| v.as_mapping())
        .and_then(|m| string_field(m, "monthly"))
        .unwrap_or_else(|| "{yyyy}-{mm}".to_string());
    let receipt_path = lexical_normalize_path(&root_abs.join(&receipts_rel));
    let mut source_paths = Vec::with_capacity(sources.len());
    for source in &sources {
        if let Ok(path) = resolve_inside_vault(&work_path, &source.path) {
            source_paths.push(path);
        }
    }
    lease.ensure_covered([
        workspace_config_path(&work),
        root_abs.clone(),
        receipt_path.clone(),
    ])?;
    lease.ensure_covered(source_paths)?;
    lease.ensure_covered(collect_output_alias_paths(&root_abs)?)?;
    if root_abs != initial_root
        || !inside
        || validate_receipts_fragment(&receipts_rel).is_err()
        || validate_receipts_fragment(&monthly_rel).is_err()
    {
        return Err("share_outbox_root_changed; retry the operation".to_string());
    }
    assert_maru_can_write(&work.to_string_lossy(), WorkspaceWriteAction::Share)?;

    let skill = resolve_share_outbox_record()?;
    let script = resolve_prepare_script(&skill)?;
    let (runner, uses_test_fixture) = share_outbox_runner()?;
    #[cfg(not(test))]
    let _ = uses_test_fixture;
    if !runner.is_file() {
        return Err("share_outbox_python_missing".to_string());
    }
    let env = skill_host::store::env_vars_for_runs(Some(&work))?;
    let config_path = workspace_config_path(&work);
    let mut results = Vec::with_capacity(sources.len());
    for src in &sources {
        // Each source must live inside the workspace.
        let source = match resolve_inside_vault(&work_path, &src.path) {
            Ok(path) => path,
            Err(err) => {
                results.push(ShareOutboxResult::failure(&src.path, err));
                continue;
            }
        };
        let mut cmd = Command::new(&runner);
        #[cfg(test)]
        let fixture_response = if uses_test_fixture {
            let stem = source
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("source");
            Some(
                root_abs
                    .join("_state")
                    .join(format!(".phase08-10-response-{stem}.json")),
            )
        } else {
            None
        };
        #[cfg(test)]
        if uses_test_fixture {
            cmd.args([
                "--exact",
                "share_outbox::phase08_10::native_fixture_child",
                "--",
            ])
            .env("MARU_PHASE08_10_SHARE_OUTBOX_SOURCE", &source)
            .env("MARU_PHASE08_10_SHARE_OUTBOX_ROOT", &root_abs)
            .env("MARU_PHASE08_10_SHARE_OUTBOX_RECEIPT", &receipt_path)
            .env(
                "MARU_PHASE08_10_SHARE_OUTBOX_RESPONSE",
                fixture_response.as_ref().expect("fixture response path"),
            );
        }
        for (key, value) in &env {
            cmd.env(key, value);
        }
        // Imported Python modules must not create bytecode outside the admitted output set.
        cmd.env("PYTHONDONTWRITEBYTECODE", "1");
        cmd.arg(&script)
            .arg(&source)
            .arg("--config")
            .arg(&config_path)
            // Shared-outbox preparation is a local filesystem operation. A
            // separate, explicit send flow owns any provider notification.
            .arg("--no-telegram");
        if let Some(title) = src
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            cmd.arg("--title").arg(title);
        }
        if let Some(author) = options
            .author
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            cmd.arg("--author").arg(author);
        }
        if let Some(ts) = options
            .timestamp
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            cmd.arg("--timestamp").arg(ts);
        }
        if options.replace {
            cmd.arg("--replace");
        }
        if options.dry_run {
            cmd.arg("--dry-run");
        }
        // The skill accepts a relative root. Running from the workspace keeps
        // its path expansion aligned with Rust's workspace-relative resolver.
        cmd.current_dir(&work);
        cmd.no_window();

        #[cfg(test)]
        if uses_test_fixture {
            assert_eq!(
                cmd.get_program(),
                std::env::current_exe().unwrap().as_os_str(),
                "fixture selected executable before invocation"
            );
            assert!(cmd.get_args().any(|arg| arg == "--no-telegram"));
            assert!(cmd
                .get_envs()
                .any(|(key, value)| key == "PYTHONDONTWRITEBYTECODE"
                    && value == Some(std::ffi::OsStr::new("1"))));
            assert_eq!(cmd.get_current_dir(), Some(work.as_path()));
        }
        match cmd.output() {
            Ok(output) => {
                #[cfg(test)]
                let stdout = if uses_test_fixture {
                    fixture_response
                        .as_ref()
                        .and_then(|path| fs::read(path).ok())
                        .unwrap_or_else(|| output.stdout.clone())
                } else {
                    output.stdout.clone()
                };
                #[cfg(not(test))]
                let stdout = output.stdout.clone();
                #[cfg(test)]
                let stderr = if uses_test_fixture && !output.status.success() {
                    fixture_response
                        .as_ref()
                        .and_then(|path| fs::read(path).ok())
                        .unwrap_or_else(|| output.stderr.clone())
                } else {
                    output.stderr.clone()
                };
                #[cfg(not(test))]
                let stderr = output.stderr.clone();
                results.push(parse_one(
                    &src.path,
                    output.status.success(),
                    &stdout,
                    &stderr,
                    options.dry_run,
                ));
            }
            Err(err) => results.push(ShareOutboxResult::failure(
                &src.path,
                format!("spawn_failed: {err}"),
            )),
        }
    }
    Ok(results)
}

fn share_outbox_runner() -> Result<(PathBuf, bool), String> {
    #[cfg(test)]
    if let Some(path) = std::env::var_os("MARU_PHASE08_10_SHARE_OUTBOX_PROGRAM") {
        return Ok((PathBuf::from(path), true));
    }
    Ok((
        skill_host::fs::env_root()?
            .join(".venv")
            .join("bin")
            .join("python"),
        false,
    ))
}

fn extend_workspace_alias_paths(
    paths: &mut Vec<PathBuf>,
    work_path: &str,
    root: &Path,
    work: &Path,
) -> Result<(), String> {
    let requested_work = absolute_lexical_path(work_path)?;
    paths.push(requested_work.join("workspace.config.yaml"));
    if let Ok(relative) = root.strip_prefix(work) {
        paths.push(requested_work.join(relative));
    }
    Ok(())
}

fn absolute_lexical_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(lexical_normalize_path(&path))
    } else {
        Ok(lexical_normalize_path(
            &std::env::current_dir()
                .map_err(|err| format!("Cannot determine current directory: {err}"))?
                .join(path),
        ))
    }
}

/// Reserve existing symlink entries below the output root so a configured
/// monthly directory cannot redirect a subprocess write to an unadmitted
/// physical tree. Symlinks are inspected but never descended into, which keeps
/// the scan finite with respect to the lexical output tree and makes cycles
/// harmless; any walk error fails closed before the child starts.
fn collect_output_alias_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut aliases = Vec::new();
    for entry in WalkDir::new(root).follow_links(true).into_iter() {
        let entry = entry.map_err(|err| format!("Cannot inspect share outbox root: {err}"))?;
        if fs::symlink_metadata(entry.path())
            .map_err(|err| format!("Cannot inspect share alias: {err}"))?
            .file_type()
            .is_symlink()
        {
            aliases.push(entry.path().to_path_buf());
        }
    }
    Ok(aliases)
}

/// IPC scheduling boundary; synchronous entry points remain available to Rust callers.
pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn read_share_outbox_config(
        work_path: String,
    ) -> Result<ShareOutboxConfigView, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:read_share_outbox_config",
            );
            super::read_share_outbox_config(work_path)
        })
        .await
        .map_err(|err| format!("read_share_outbox_config_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn save_share_outbox_root(
        work_path: String,
        root: String,
    ) -> Result<ShareOutboxConfigView, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:save_share_outbox_root",
            );
            super::save_share_outbox_root(work_path, root)
        })
        .await
        .map_err(|err| format!("save_share_outbox_root_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn ensure_share_outbox_root(
        work_path: String,
    ) -> Result<ShareOutboxEnsureResult, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:ensure_share_outbox_root",
            );
            super::ensure_share_outbox_root(work_path)
        })
        .await
        .map_err(|err| format!("ensure_share_outbox_root_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn scan_share_outbox(work_path: String) -> Result<ShareOutboxScan, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scan_share_outbox",
            );
            super::scan_share_outbox(work_path)
        })
        .await
        .map_err(|err| format!("scan_share_outbox_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn prepare_share_outbox_files(
        work_path: String,
        sources: Vec<ShareOutboxSource>,
        options: ShareOutboxApplyOptions,
    ) -> Result<Vec<ShareOutboxResult>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:prepare_share_outbox_files",
            );
            super::prepare_share_outbox_files(work_path, sources, options)
        })
        .await
        .map_err(|err| format!("prepare_share_outbox_files_task_failed: {err}"))?
    }
}

#[cfg(test)]
pub(crate) mod phase08_10 {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::path::PathBuf;

    /// Current-test-executable child used by prepare tests. The parent
    /// captures stdout/stderr, so the child cannot pollute the cargo test log.
    #[test]
    pub(crate) fn native_fixture_child() {
        let Some(source_value) = std::env::var_os("MARU_PHASE08_10_SHARE_OUTBOX_SOURCE") else {
            // Matching `phase08_10` in a normal cargo test run also selects
            // this child entry; it is only a launcher when the parent sets the
            // scoped fixture environment.
            return;
        };
        assert!(
            std::env::args().any(|arg| arg == "--no-telegram"),
            "prepare must explicitly suppress provider sends"
        );
        let source = PathBuf::from(source_value);
        let root = PathBuf::from(
            std::env::var_os("MARU_PHASE08_10_SHARE_OUTBOX_ROOT")
                .expect("share outbox fixture root"),
        );
        let receipt = PathBuf::from(
            std::env::var_os("MARU_PHASE08_10_SHARE_OUTBOX_RECEIPT")
                .expect("share outbox fixture receipt"),
        );
        let response = PathBuf::from(
            std::env::var_os("MARU_PHASE08_10_SHARE_OUTBOX_RESPONSE")
                .expect("share outbox fixture response"),
        );
        std::fs::create_dir_all(response.parent().expect("fixture response parent")).unwrap();
        if std::env::var_os("MARU_PHASE08_10_SHARE_OUTBOX_FAIL").is_some()
            || source
                .file_name()
                .map(|name| name.to_string_lossy() == "bad.md")
                .unwrap_or(false)
        {
            std::fs::write(&response, br#"{"error":"fixture rejected"}"#).unwrap();
            std::process::exit(17);
        }
        let name = source
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("source");
        let output = root.join(format!("{name}-shared.md"));
        std::fs::create_dir_all(output.parent().expect("fixture output parent")).unwrap();
        std::fs::copy(&source, &output).unwrap();
        std::fs::create_dir_all(receipt.parent().expect("fixture receipt parent")).unwrap();
        let line = serde_json::json!({
            "output": output.to_string_lossy(),
            "title": name,
            "author_key": "fixture",
            "timestamp": "260905-1000",
            "timestamp_iso": "2026-09-05T10:00:00+09:00",
            "created_at": "2026-09-05T10:00:00+09:00"
        });
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&receipt)
            .unwrap();
        writeln!(file, "{line}").unwrap();
        std::fs::write(
            response,
            serde_json::to_vec(&serde_json::json!({
                "ok": true,
                "dry_run": false,
                "output": output.to_string_lossy(),
            }))
            .unwrap(),
        )
        .unwrap();
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn load_yaml(work: &Path) -> Result<Option<YamlValue>, String> {
    let path = workspace_config_path(work);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read workspace.config.yaml: {err}"))?;
    let yaml = serde_yaml::from_str(&raw)
        .map_err(|err| format!("Cannot parse workspace.config.yaml: {err}"))?;
    Ok(Some(yaml))
}

fn share_outbox_mapping(yaml: &YamlValue) -> Option<&serde_yaml::Mapping> {
    yaml.as_mapping()
        .and_then(|m| m.get(YamlValue::String("share_outbox".to_string())))
        .and_then(|v| v.as_mapping())
}

fn string_field(map: &serde_yaml::Mapping, key: &str) -> Option<String> {
    map.get(YamlValue::String(key.to_string()))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// `(raw, resolved_abs, inside_workspace)`. Never errors on out-of-workspace;
/// the bool reports it. Uses lexical normalization (not canonicalize) so a root
/// that does not exist yet still resolves.
fn resolve_root(work: &Path, raw_root: &str) -> Option<(String, PathBuf, bool)> {
    let trimmed = raw_root.trim();
    if trimmed.is_empty() {
        return None;
    }
    let expanded = expand_tilde(trimmed);
    let abs = if expanded.is_absolute() {
        expanded
    } else {
        work.join(expanded)
    };
    let normalized = lexical_normalize_path(&abs);
    let inside = normalized.starts_with(lexical_normalize_path(work));
    Some((trimmed.to_string(), normalized, inside))
}

fn build_config_view(work: &Path, yaml: Option<&YamlValue>) -> ShareOutboxConfigView {
    let map = yaml.and_then(share_outbox_mapping);
    let present = map.is_some();
    let root_raw = map.and_then(|m| string_field(m, "root"));
    let resolved = root_raw.as_deref().and_then(|r| resolve_root(work, r));
    let (root_resolved, root_exists, inside) = match &resolved {
        Some((_, abs, inside)) => (
            Some(abs.to_string_lossy().to_string()),
            abs.is_dir(),
            *inside,
        ),
        None => (None, false, false),
    };
    let missing_keys: Vec<String> = REQUIRED_KEYS
        .iter()
        .filter(|key| {
            map.map(|m| m.get(YamlValue::String((*key).to_string())).is_none())
                .unwrap_or(true)
        })
        .map(|key| (*key).to_string())
        .collect();
    let has_required_config = missing_keys.is_empty() && inside;
    let timezone = map.and_then(|m| string_field(m, "timezone"));
    let default_author = map.and_then(|m| string_field(m, "default_author"));
    let authors = build_authors(map, default_author.as_deref());
    ShareOutboxConfigView {
        present,
        root: root_raw,
        root_resolved,
        root_exists,
        inside_workspace: inside,
        has_required_config,
        missing_keys,
        timezone,
        default_author,
        authors,
    }
}

fn build_authors(
    map: Option<&serde_yaml::Mapping>,
    default_author: Option<&str>,
) -> Vec<ShareOutboxAuthorView> {
    let Some(authors) = map
        .and_then(|m| m.get(YamlValue::String("authors".to_string())))
        .and_then(|v| v.as_mapping())
    else {
        return Vec::new();
    };
    authors
        .iter()
        .filter_map(|(k, v)| {
            let key = k.as_str()?;
            let detail = v.as_mapping();
            Some(ShareOutboxAuthorView {
                key: key.to_string(),
                suffix: detail.and_then(|m| string_field(m, "suffix")),
                name_ref: detail.and_then(|m| string_field(m, "name_ref")),
                is_default: default_author == Some(key),
            })
        })
        .collect()
}

/// Serialize a `share_outbox` mapping into an indented top-level YAML block.
/// Mirrors `inbox_settings::inbox_config_yaml_block`.
fn share_outbox_yaml_block(map: &serde_yaml::Mapping) -> Result<String, String> {
    let value = YamlValue::Mapping(map.clone());
    let yaml = serde_yaml::to_string(&value)
        .map_err(|err| format!("Cannot serialize share_outbox config: {err}"))?;
    let mut out = String::from("share_outbox:\n");
    for line in yaml.lines() {
        if line == "---" {
            continue;
        }
        out.push_str("  ");
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

/// Replace (or append) a single top-level YAML block, preserving everything
/// else byte-for-byte. Copied verbatim from `inbox_settings.rs` (private there).
fn replace_top_level_yaml_block(raw: &str, key: &str, block: &str) -> String {
    let lines: Vec<&str> = raw.lines().collect();
    let needle = format!("{key}:");
    let start = lines
        .iter()
        .position(|line| line.trim_end() == needle && !line.starts_with([' ', '\t']));
    let Some(start) = start else {
        let mut out = raw.trim_end().to_string();
        out.push_str("\n\n");
        out.push_str(block.trim_end());
        out.push('\n');
        return out;
    };
    let mut end = lines.len();
    for (idx, line) in lines.iter().enumerate().skip(start + 1) {
        if !line.trim().is_empty() && !line.starts_with([' ', '\t']) {
            end = idx;
            break;
        }
    }
    let mut out = String::new();
    if start > 0 {
        out.push_str(&lines[..start].join("\n"));
        out.push('\n');
    }
    out.push_str(block.trim_end());
    out.push('\n');
    if end < lines.len() {
        out.push_str(&lines[end..].join("\n"));
        out.push('\n');
    }
    out
}

fn validate_receipts_fragment(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("receipts_required".to_string());
    }
    let path = Path::new(trimmed);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("receipts_outside_root".to_string());
    }
    Ok(())
}

fn basename(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// Parse JSONL receipts. Returns `(receipts, skipped_line_count)`; blank lines
/// are ignored and malformed lines are skipped + counted.
fn parse_receipts(text: &str) -> (Vec<Receipt>, usize) {
    let mut receipts = Vec::new();
    let mut skipped = 0usize;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Receipt>(trimmed) {
            Ok(receipt) => receipts.push(receipt),
            Err(_) => skipped += 1,
        }
    }
    (receipts, skipped)
}

/// Newest-first by `timestamp_iso`, tie-broken by `created_at`.
fn sort_recent(receipts: &mut [Receipt]) {
    receipts.sort_by(|a, b| {
        b.timestamp_iso
            .cmp(&a.timestamp_iso)
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
}

fn resolve_share_outbox_record() -> Result<SkillRecord, String> {
    #[cfg(test)]
    if let Some(abs_path) = std::env::var_os("MARU_PHASE08_10_SHARE_OUTBOX_SKILL_ROOT") {
        return Ok(SkillRecord {
            id: "phase08-10-share-outbox".to_string(),
            source_id: BUILTIN_SOURCE_ID.to_string(),
            name: "share-outbox".to_string(),
            rel_path: "skills/share-outbox".to_string(),
            abs_path: PathBuf::from(abs_path).to_string_lossy().to_string(),
            title: "Phase 08 share outbox fixture".to_string(),
            description: None,
            runtime: Some("python".to_string()),
            category: Some("test".to_string()),
            tier: "core".to_string(),
            valid: true,
            validation_errors: Vec::new(),
            editable: false,
            dirty: false,
            content_hash: None,
            saved_hash: None,
        });
    }
    let registry = skill_host::store::load_registry()?;
    let mut matches: Vec<SkillRecord> = registry
        .skills
        .into_iter()
        .filter(|skill| skill.name == "share-outbox")
        .collect();
    if matches.is_empty() {
        return Err("share_outbox_skill_not_installed".to_string());
    }
    // Prefer the builtin source, then valid records — disambiguates the
    // builtin vs forked-public-mirror duplication.
    matches.sort_by_key(|skill| (skill.source_id != BUILTIN_SOURCE_ID, !skill.valid));
    Ok(matches.into_iter().next().unwrap())
}

fn resolve_prepare_script(skill: &SkillRecord) -> Result<PathBuf, String> {
    let base = PathBuf::from(&skill.abs_path);
    let candidate = base.join("scripts").join("prepare_share_file.py");
    let normalized = lexical_normalize_path(&candidate);
    if !normalized.starts_with(&base) {
        return Err("share_outbox_script_escapes_skill_root".to_string());
    }
    if !normalized.is_file() {
        return Err("share_outbox_script_missing".to_string());
    }
    Ok(normalized)
}

fn parse_one(
    source: &str,
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
    dry_run: bool,
) -> ShareOutboxResult {
    if success {
        let text = String::from_utf8_lossy(stdout);
        match serde_json::from_str::<serde_json::Value>(text.trim()) {
            Ok(value) => ShareOutboxResult {
                source: source.to_string(),
                ok: true,
                dry_run,
                output: value
                    .get("output")
                    .and_then(|o| o.as_str())
                    .map(|s| s.to_string()),
                error: None,
            },
            Err(_) => ShareOutboxResult {
                source: source.to_string(),
                ok: false,
                dry_run,
                output: None,
                error: Some(format!("share_outbox_parse_failed: {}", text.trim())),
            },
        }
    } else {
        let err_text = String::from_utf8_lossy(stderr);
        let message = serde_json::from_str::<serde_json::Value>(err_text.trim())
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| {
                let trimmed = err_text.trim();
                if trimmed.is_empty() {
                    "share_outbox_failed".to_string()
                } else {
                    trimmed.to_string()
                }
            });
        ShareOutboxResult {
            source: source.to_string(),
            ok: false,
            dry_run,
            output: None,
            error: Some(message),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use std::future::Future;
    use std::sync::mpsc;
    use std::time::Duration;
    use tempfile::TempDir;

    const FULL_CONFIG: &str = r#"# leading comment
version: 1
inbox:
  root: inbox
share_outbox:
  root: shared
  timezone: Asia/Seoul
  default_author: yjlee
  authors:
    yjlee:
      suffix: LEE
      name_ref: owner.name
  filename:
    template: "{title}_{author}_{timestamp}{ext}"
  paths:
    monthly: "{yyyy}-{mm}"
    receipts: _state/index.jsonl
sync:
  mirror: ~/mirror
"#;

    fn workspace(config: &str) -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let work = dir.path().canonicalize().unwrap();
        fs::write(work.join("workspace.config.yaml"), config).unwrap();
        (dir, work)
    }

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

    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("share outbox fixture completion")
    }

    struct RunnerGuard {
        prior: [Option<std::ffi::OsString>; 3],
    }

    impl RunnerGuard {
        fn new(skill_root: &Path, fail: bool) -> Self {
            let prior = [
                std::env::var_os("MARU_PHASE08_10_SHARE_OUTBOX_PROGRAM"),
                std::env::var_os("MARU_PHASE08_10_SHARE_OUTBOX_SKILL_ROOT"),
                std::env::var_os("MARU_PHASE08_10_SHARE_OUTBOX_FAIL"),
            ];
            std::env::set_var(
                "MARU_PHASE08_10_SHARE_OUTBOX_PROGRAM",
                std::env::current_exe().expect("current test executable"),
            );
            std::env::set_var("MARU_PHASE08_10_SHARE_OUTBOX_SKILL_ROOT", skill_root);
            if fail {
                std::env::set_var("MARU_PHASE08_10_SHARE_OUTBOX_FAIL", "1");
            } else {
                std::env::remove_var("MARU_PHASE08_10_SHARE_OUTBOX_FAIL");
            }
            Self { prior }
        }
    }

    impl Drop for RunnerGuard {
        fn drop(&mut self) {
            for (name, value) in [
                "MARU_PHASE08_10_SHARE_OUTBOX_PROGRAM",
                "MARU_PHASE08_10_SHARE_OUTBOX_SKILL_ROOT",
                "MARU_PHASE08_10_SHARE_OUTBOX_FAIL",
            ]
            .into_iter()
            .zip(&self.prior)
            {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }

    fn fake_skill_root(root: &Path) -> PathBuf {
        let skill = root.join("fake-share-outbox-skill");
        fs::create_dir_all(skill.join("scripts")).unwrap();
        fs::write(skill.join("scripts/prepare_share_file.py"), b"fixture").unwrap();
        skill
    }

    #[test]
    fn save_preserves_unrelated_keys_and_subkeys() {
        let _home = Home::new();
        let (_dir, work) = workspace(FULL_CONFIG);
        let new_root = work.join("outgoing");
        let view = save_share_outbox_root(
            work.to_string_lossy().to_string(),
            new_root.to_string_lossy().to_string(),
        )
        .unwrap();
        assert_eq!(
            view.root.as_deref(),
            Some(new_root.to_string_lossy().as_ref())
        );
        assert!(view.inside_workspace);
        assert!(view.has_required_config);

        let saved = fs::read_to_string(work.join("workspace.config.yaml")).unwrap();
        // Unrelated top-level keys + comment survive.
        assert!(saved.contains("# leading comment"));
        assert!(saved.contains("inbox:"));
        assert!(saved.contains("root: inbox"));
        assert!(saved.contains("sync:"));
        assert!(saved.contains("mirror: ~/mirror"));
        // Sibling share_outbox sub-keys survive.
        assert!(saved.contains("default_author: yjlee"));
        assert!(saved.contains("suffix: LEE"));
        assert!(saved.contains("{title}_{author}_{timestamp}{ext}"));
        assert!(saved.contains("monthly:"));
        // Only root changed.
        assert!(!saved.contains("root: shared\n"));
    }

    #[test]
    fn save_creates_minimal_block_when_absent() {
        let _home = Home::new();
        let (_dir, work) = workspace("version: 1\ninbox:\n  root: inbox\n");
        let new_root = work.join("outgoing");
        save_share_outbox_root(
            work.to_string_lossy().to_string(),
            new_root.to_string_lossy().to_string(),
        )
        .unwrap();
        let saved = fs::read_to_string(work.join("workspace.config.yaml")).unwrap();
        assert!(saved.contains("share_outbox:"));
        assert!(saved.contains("inbox:"));
        // Required keys still missing -> Apply disabled.
        let view = read_share_outbox_config(work.to_string_lossy().to_string()).unwrap();
        assert!(!view.has_required_config);
        assert!(view.missing_keys.contains(&"authors".to_string()));
    }

    #[test]
    fn save_rejects_outside_workspace() {
        let _home = Home::new();
        let (_dir, work) = workspace(FULL_CONFIG);
        let outside = TempDir::new().unwrap();
        let err = save_share_outbox_root(
            work.to_string_lossy().to_string(),
            outside.path().to_string_lossy().to_string(),
        )
        .unwrap_err();
        assert_eq!(err, "share_outbox_root_outside_workspace");
    }

    #[test]
    fn resolve_root_handles_tilde_relative_and_escape() {
        let (_dir, work) = workspace(FULL_CONFIG);
        // relative -> inside
        let (_, abs, inside) = resolve_root(&work, "shared").unwrap();
        assert!(inside);
        assert_eq!(abs, work.join("shared"));
        // parent escape -> outside
        let (_, _, inside) = resolve_root(&work, "../escape").unwrap();
        assert!(!inside);
        // empty -> None
        assert!(resolve_root(&work, "   ").is_none());
        // tilde expands (only assert when home is available)
        if dirs::home_dir().is_some() {
            let (_, abs, _) = resolve_root(&work, "~/x").unwrap();
            assert!(abs.is_absolute());
            assert!(abs.ends_with("x"));
        }
    }

    #[test]
    fn config_view_reports_missing_keys() {
        let yaml: YamlValue =
            serde_yaml::from_str("share_outbox:\n  root: shared\n  timezone: Asia/Seoul\n")
                .unwrap();
        let work = PathBuf::from("/tmp/ws");
        let view = build_config_view(&work, Some(&yaml));
        assert!(view.present);
        assert!(view.inside_workspace); // shared is relative -> inside /tmp/ws
        assert!(view.missing_keys.contains(&"authors".to_string()));
        assert!(view.missing_keys.contains(&"filename".to_string()));
        assert!(!view.has_required_config);
    }

    #[test]
    fn config_view_full_is_apply_ready() {
        let (_dir, work) = workspace(FULL_CONFIG);
        let view = read_share_outbox_config(work.to_string_lossy().to_string()).unwrap();
        assert!(view.has_required_config);
        assert!(view.missing_keys.is_empty());
        assert_eq!(view.default_author.as_deref(), Some("yjlee"));
        assert_eq!(view.authors.len(), 1);
        assert_eq!(view.authors[0].key, "yjlee");
        assert_eq!(view.authors[0].suffix.as_deref(), Some("LEE"));
        assert!(view.authors[0].is_default);
    }

    #[test]
    fn parse_receipts_skips_malformed_and_sorts_newest_first() {
        let text = "\
{\"output\":\"/a.docx\",\"title\":\"가\",\"author_key\":\"yjlee\",\"timestamp\":\"250601-1000\",\"timestamp_iso\":\"2025-06-01T10:00:00+09:00\",\"created_at\":\"2025-06-01T10:00:00+09:00\"}

not json
{\"output\":\"/b.docx\",\"title\":\"나\",\"author_key\":\"yjlee\",\"timestamp\":\"250603-1000\",\"timestamp_iso\":\"2025-06-03T10:00:00+09:00\",\"created_at\":\"2025-06-03T10:00:00+09:00\"}
{
";
        let (mut receipts, skipped) = parse_receipts(text);
        assert_eq!(receipts.len(), 2);
        assert_eq!(skipped, 2);
        sort_recent(&mut receipts);
        assert_eq!(receipts[0].output, "/b.docx"); // newest first
        assert_eq!(receipts[1].output, "/a.docx");
    }

    #[test]
    fn parse_one_surfaces_success_and_errors() {
        let ok = parse_one(
            "/src.docx",
            true,
            br#"{"ok": true, "dry_run": false, "output": "/out/x.docx"}"#,
            b"",
            false,
        );
        assert!(ok.ok);
        assert_eq!(ok.output.as_deref(), Some("/out/x.docx"));

        let json_err = parse_one(
            "/src.docx",
            false,
            b"",
            br#"{"ok": false, "error": "Outgoing title has no Hangul."}"#,
            false,
        );
        assert!(!json_err.ok);
        assert_eq!(
            json_err.error.as_deref(),
            Some("Outgoing title has no Hangul.")
        );

        let raw_err = parse_one("/src.docx", false, b"", b"Traceback: boom", false);
        assert!(!raw_err.ok);
        assert_eq!(raw_err.error.as_deref(), Some("Traceback: boom"));
    }

    #[test]
    fn basename_and_receipts_fragment_guard() {
        assert_eq!(basename("/a/b/c.docx"), "c.docx");
        assert_eq!(basename("c.docx"), "c.docx");
        assert!(validate_receipts_fragment("_state/index.jsonl").is_ok());
        assert!(validate_receipts_fragment("/abs/index.jsonl").is_err());
        assert!(validate_receipts_fragment("../escape.jsonl").is_err());
    }

    #[test]
    fn scan_reads_receipts_and_flags_missing_output() {
        let (_dir, work) = workspace(FULL_CONFIG);
        let root = work.join("shared");
        fs::create_dir_all(root.join("_state")).unwrap();
        let present = root.join("2025-06").join("present.docx");
        fs::create_dir_all(present.parent().unwrap()).unwrap();
        fs::write(&present, b"x").unwrap();
        let line = format!(
            "{{\"output\":\"{}\",\"title\":\"존재\",\"author_key\":\"yjlee\",\"timestamp\":\"250601-1000\",\"timestamp_iso\":\"2025-06-01T10:00:00+09:00\",\"created_at\":\"2025-06-01T10:00:00+09:00\"}}\n{{\"output\":\"{}/missing.docx\",\"title\":\"없음\",\"author_key\":\"yjlee\",\"timestamp\":\"250602-1000\",\"timestamp_iso\":\"2025-06-02T10:00:00+09:00\",\"created_at\":\"2025-06-02T10:00:00+09:00\"}}\n",
            present.to_string_lossy(),
            root.to_string_lossy(),
        );
        fs::write(root.join("_state").join("index.jsonl"), line).unwrap();

        let scan = scan_share_outbox(work.to_string_lossy().to_string()).unwrap();
        assert!(scan.index_exists);
        assert_eq!(scan.total_receipts, 2);
        assert_eq!(scan.items.len(), 2);
        // newest first: missing.docx (06-02) before present.docx (06-01)
        assert_eq!(scan.items[0].name, "missing.docx");
        assert!(!scan.items[0].exists);
        assert_eq!(scan.items[1].name, "present.docx");
        assert!(scan.items[1].exists);
    }

    #[test]
    fn scan_empty_when_no_share_outbox() {
        let (_dir, work) = workspace("version: 1\n");
        let scan = scan_share_outbox(work.to_string_lossy().to_string()).unwrap();
        assert!(scan.root_resolved.is_none());
        assert!(scan.items.is_empty());
    }

    #[test]
    fn phase08_10_all_five_wrappers_yield_on_the_same_polling_task() {
        let _home = Home::new();
        let root = _home.root.path();
        let work = text(root);
        boundary(
            root.into(),
            "read_share_outbox_config",
            ipc::read_share_outbox_config(work.clone()),
        );
        boundary(
            root.into(),
            "save_share_outbox_root",
            ipc::save_share_outbox_root(work.clone(), "shared".into()),
        );
        boundary(
            root.into(),
            "ensure_share_outbox_root",
            ipc::ensure_share_outbox_root(work.clone()),
        );
        boundary(
            root.into(),
            "scan_share_outbox",
            ipc::scan_share_outbox(work.clone()),
        );
        boundary(
            root.into(),
            "prepare_share_outbox_files",
            ipc::prepare_share_outbox_files(work, Vec::new(), ShareOutboxApplyOptions::default()),
        );
    }

    #[test]
    fn phase08_10_wrappers_return_real_payloads_and_preserve_sync_contract() {
        let _home = Home::new();
        let (_dir, work) = workspace(FULL_CONFIG);
        fs::create_dir_all(work.join("shared")).unwrap();
        let work_text = text(&work);

        let config = run(ipc::read_share_outbox_config(work_text.clone())).unwrap();
        assert!(config.has_required_config);
        assert_eq!(config.default_author.as_deref(), Some("yjlee"));

        let ensured = run(ipc::ensure_share_outbox_root(work_text.clone())).unwrap();
        assert!(!ensured.created);
        let scan = run(ipc::scan_share_outbox(work_text.clone())).unwrap();
        assert!(scan.root_exists);

        let saved = run(ipc::save_share_outbox_root(
            work_text.clone(),
            "shared-2".into(),
        ))
        .unwrap();
        assert_eq!(saved.root.as_deref(), Some("shared-2"));
        assert!(saved.has_required_config);

        let missing = run(ipc::prepare_share_outbox_files(
            work_text,
            Vec::new(),
            ShareOutboxApplyOptions::default(),
        ))
        .unwrap_err();
        assert_eq!(missing, "no_sources_selected");
    }

    #[test]
    fn phase08_10_prepare_writes_fixture_output_receipt_and_retains_sibling_failure() {
        let _home = Home::new();
        let (_dir, work) = workspace(FULL_CONFIG);
        let shared = work.join("shared");
        fs::create_dir_all(&shared).unwrap();
        fs::write(shared.join("good.md"), "좋은 문서").unwrap();
        fs::write(shared.join("bad.md"), "실패 문서").unwrap();
        let fake_skill = fake_skill_root(&work);
        let _runner = RunnerGuard::new(&fake_skill, false);
        let work_text = text(&work);

        let results = run(ipc::prepare_share_outbox_files(
            work_text.clone(),
            vec![
                ShareOutboxSource {
                    path: text(&shared.join("good.md")),
                    title: Some("좋은 문서".into()),
                },
                ShareOutboxSource {
                    path: text(&shared.join("bad.md")),
                    title: Some("실패 문서".into()),
                },
            ],
            ShareOutboxApplyOptions::default(),
        ))
        .unwrap();
        assert_eq!(results.len(), 2);
        assert!(results[0].ok);
        assert_eq!(results[0].source, text(&shared.join("good.md")));
        assert!(results[0]
            .output
            .as_deref()
            .unwrap()
            .ends_with("good-shared.md"));
        assert!(!results[1].ok);
        assert_eq!(results[1].error.as_deref(), Some("fixture rejected"));

        let output = shared.join("good-shared.md");
        assert!(output.is_file());
        let scan = run(ipc::scan_share_outbox(work_text.clone())).unwrap();
        assert_eq!(scan.total_receipts, 1);
        assert_eq!(scan.items[0].output, text(&output));
        assert!(scan.items[0].exists);

        let retry = run(ipc::prepare_share_outbox_files(
            work_text,
            vec![ShareOutboxSource {
                path: text(&shared.join("good.md")),
                title: Some("좋은 문서".into()),
            }],
            ShareOutboxApplyOptions {
                replace: true,
                ..Default::default()
            },
        ))
        .unwrap();
        assert_eq!(retry.len(), 1);
        assert!(retry[0].ok);
        assert_eq!(fs::read_to_string(output).unwrap(), "좋은 문서");
    }

    #[test]
    fn phase08_10_share_mutation_same_target_and_error_release() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let _home = Home::new();
        let (_dir, work) = workspace(FULL_CONFIG);
        let shared = work.join("shared");
        fs::create_dir_all(&shared).unwrap();
        let work_text = text(&work);

        let held = Held::new(shared.clone(), "admitted");
        let first = start(ipc::ensure_share_outbox_root(work_text.clone()));
        held.wait();
        let waiting = Held::new(shared.clone(), "before-admission");
        let second = start(ipc::ensure_share_outbox_root(work_text.clone()));
        waiting.wait();
        waiting.release();
        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
        held.release();
        assert!(done(first).is_ok());
        assert!(done(second).is_ok());

        let fired = AtomicBool::new(false);
        let error_hook = crate::atomic_file::PathTransactionTestHook::new(
            shared.clone(),
            "pre-effect",
            move || {
                if !fired.swap(true, Ordering::SeqCst) {
                    panic!("share outbox fixture failure");
                }
            },
        );
        let failed = done(start(ipc::ensure_share_outbox_root(work_text.clone())));
        assert!(failed
            .unwrap_err()
            .contains("ensure_share_outbox_root_task_failed:"));
        drop(error_hook);

        fs::write(shared.join("after-error.md"), b"still writable").unwrap();
        let moved = run(crate::workspace_files::ipc::rename_workspace_entry(
            work_text,
            text(&shared.join("after-error.md")),
            "after-error-renamed.md".into(),
        ));
        assert!(
            moved.is_ok(),
            "document writer must enter after release: {moved:?}"
        );
    }

    #[test]
    fn phase08_10_real_document_rename_and_trash_contend_with_share_root() {
        let _home = Home::new();
        for trash in [false, true] {
            let (_dir, work) = workspace(FULL_CONFIG);
            let shared = work.join("shared");
            fs::create_dir_all(&shared).unwrap();
            let source = shared.join(if trash { "trash.md" } else { "rename.md" });
            fs::write(&source, b"document bytes").unwrap();
            let work_text = text(&work);
            let _trash_fixture = trash.then(|| {
                let destination = work
                    .join(".test-trash")
                    .join(source.file_name().expect("trash fixture source name"));
                fs::create_dir_all(destination.parent().unwrap()).unwrap();
                crate::workspace_files::phase08_06::TrashFixture::new(source.clone(), destination)
            });

            let held = Held::new(shared.clone(), "admitted");
            let share = start(ipc::ensure_share_outbox_root(work_text.clone()));
            held.wait();
            let source_text = text(&source);
            let document = start(async move {
                if trash {
                    crate::workspace_files::ipc::trash_workspace_entries(
                        work_text,
                        vec![source_text],
                    )
                    .await
                    .map(|_| ())
                } else {
                    crate::workspace_files::ipc::rename_workspace_entry(
                        work_text,
                        source_text,
                        "renamed.md".into(),
                    )
                    .await
                    .map(|_| ())
                }
            });
            assert!(document.recv_timeout(Duration::from_millis(30)).is_err());
            held.release();
            assert!(done(share).is_ok());
            let result = done(document);
            assert!(
                result.is_ok(),
                "document mutation after share release: {result:?}"
            );
            if trash {
                assert!(!source.exists());
                assert!(work
                    .join(".test-trash")
                    .join(source.file_name().unwrap())
                    .is_file());
            } else {
                assert!(shared.join("renamed.md").is_file());
                assert_eq!(
                    fs::read(shared.join("renamed.md")).unwrap(),
                    b"document bytes"
                );
            }
        }
    }

    #[test]
    fn phase08_10_every_share_mutator_contention_and_error_release() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let _home = Home::new();
        for operation in ["save", "ensure", "prepare"] {
            let (_dir, work) = workspace(FULL_CONFIG);
            let shared = work.join("shared");
            fs::create_dir_all(&shared).unwrap();
            let source = shared.join("source.md");
            fs::write(&source, "내용").unwrap();
            let work_text = text(&work);
            let fake_skill = fake_skill_root(&work);
            let _runner = RunnerGuard::new(&fake_skill, false);

            let mutator = |work_path: String| start(mutate(operation, work_path));

            let held = Held::new(shared.clone(), "admitted");
            let first = mutator(work_text.clone());
            held.wait();
            let waiting = Held::new(shared.clone(), "before-admission");
            let second = mutator(work_text.clone());
            waiting.wait();
            waiting.release();
            assert!(
                second.recv_timeout(Duration::from_millis(30)).is_err(),
                "{operation}"
            );
            held.release();
            assert!(done(first).is_ok(), "{operation} first mutation");
            assert!(done(second).is_ok(), "{operation} retry after contention");

            let fired = AtomicBool::new(false);
            let error_hook = crate::atomic_file::PathTransactionTestHook::new(
                shared.clone(),
                "pre-effect",
                move || {
                    if !fired.swap(true, Ordering::SeqCst) {
                        panic!("share mutator fixture failure");
                    }
                },
            );
            let failed = done(mutator(work_text.clone()));
            assert!(
                failed.is_err(),
                "{operation} must surface the injected failure"
            );
            drop(error_hook);
            assert!(
                done(mutator(work_text)).is_ok(),
                "{operation} retry after error release"
            );
        }
    }

    async fn mutate(operation: &'static str, work: String) -> Result<(), String> {
        match operation {
            "save" => ipc::save_share_outbox_root(work, "shared".into())
                .await
                .map(|_| ()),
            "ensure" => ipc::ensure_share_outbox_root(work).await.map(|_| ()),
            "prepare" => {
                let source = PathBuf::from(&work).join("shared/source.md");
                let rows = ipc::prepare_share_outbox_files(
                    work,
                    vec![ShareOutboxSource {
                        path: text(&source),
                        title: Some("제목".into()),
                    }],
                    ShareOutboxApplyOptions::default(),
                )
                .await?;
                if rows.len() == 1 && rows[0].ok {
                    Ok(())
                } else {
                    Err(rows
                        .first()
                        .and_then(|r| r.error.clone())
                        .unwrap_or_else(|| "missing fixture outcome".into()))
                }
            }
            _ => unreachable!(),
        }
    }
    #[cfg(unix)]
    #[test]
    fn phase08_10_share_mutators_vs_real_workspace_parent_rename_trash_orders() {
        let home = Home::new();
        for operation in ["save", "ensure", "prepare"] {
            for trash in [false, true] {
                for parent_first in [false, true] {
                    for alias in [false, true] {
                        let tmp = tempfile::tempdir_in(home.root.path()).unwrap();
                        let work = tmp.path().to_path_buf();
                        fs::write(work.join("workspace.config.yaml"), FULL_CONFIG).unwrap();
                        fs::create_dir(work.join("shared")).unwrap();
                        fs::write(work.join("shared/source.md"), "내용").unwrap();
                        let fake_skill = fake_skill_root(home.root.path());
                        let _runner = RunnerGuard::new(&fake_skill, false);
                        let parent = home.root.path();
                        let basename = work.file_name().unwrap().to_string_lossy();
                        let moved = parent.join(format!("moved-{basename}"));
                        let parent_alias = parent.join(format!("alias-{basename}"));
                        let parent_work = if alias {
                            std::os::unix::fs::symlink(parent, &parent_alias).unwrap();
                            text(&parent_alias)
                        } else {
                            text(parent)
                        };
                        let _trash = crate::workspace_files::phase08_06::TrashFixture::new(
                            work.clone(),
                            moved.clone(),
                        );
                        let source = text(&work);
                        let new_name = moved.file_name().unwrap().to_string_lossy().into_owned();
                        let parent_future = async move {
                            if trash {
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
                        let key = work.join("shared");
                        if parent_first {
                            let held = Held::new(work.clone(), "admitted");
                            let first = start(parent_future);
                            held.wait();
                            let waiting = Held::new(key, "before-admission");
                            let second = start(mutate(operation, text(&work)));
                            waiting.wait();
                            waiting.release();
                            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(first).unwrap();
                            assert!(done(second).is_err(), "{operation}");
                        } else {
                            let held = Held::new(key, "admitted");
                            let first = start(mutate(operation, text(&work)));
                            held.wait();
                            let waiting = Held::new(work.clone(), "before-admission");
                            let second = start(parent_future);
                            waiting.wait();
                            waiting.release();
                            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(first).unwrap();
                            done(second).unwrap();
                            if operation == "prepare" {
                                assert_eq!(
                                    fs::read_to_string(moved.join("shared/source-shared.md"))
                                        .unwrap(),
                                    "내용"
                                );
                            }
                        }
                        assert!(!work.exists());
                        assert!(moved.join("workspace.config.yaml").is_file());
                    }
                }
            }
        }
    }

    #[test]
    fn phase08_10_share_parent_replacement_fails_closed() {
        let _home = Home::new();
        // A selected workspace parent that disappears and is recreated while
        // admission waits must fail closed without recreating the old tree.
        let (_dir, work) = workspace(FULL_CONFIG);
        let shared = work.join("shared");
        fs::create_dir_all(&shared).unwrap();
        let held = Held::new(shared.clone(), "admitted");
        let first = start(ipc::ensure_share_outbox_root(text(&work)));
        held.wait();
        let replacement = work.with_extension("replaced");
        fs::rename(&work, &replacement).unwrap();
        fs::create_dir(&work).unwrap();
        fs::write(work.join("workspace.config.yaml"), FULL_CONFIG).unwrap();
        held.release();
        let result = done(first);
        assert!(result.is_err());
        assert!(!work.join("shared").exists());
        assert!(replacement.join("shared").is_dir());
        fs::remove_dir_all(replacement).unwrap();
    }
}
