// `.anchor/` is anchor's per-workspace home inside a vault root. It
// already housed `versions` (snapshots created by `create_version`);
// this module owns workspace-local state and catalogs. User/global
// preferences live outside workspaces at `~/.anchor/settings.json`.
//
// Layout:
//   <work>/.anchor/
//     workspace.json       — schema-versioned anchor metadata
//     rules/*.md           — operational rules (markdown + frontmatter)
//     templates/*.md       — note templates (markdown)
//     mcp.json             — MCP server config edited from System mode
//     projects.json        — project-registry equivalent (categories)
//     skills.json          — skills catalog (read-only v1, written by import)
//     workspace-state.json — workspace-scoped UI state and overrides
//     settings.json        — legacy read-once migration source
//     imports.json         — append-only receipts of `_sys/ → .anchor/` imports
//     versions/            — (legacy) snapshots
//
// The directory is owned by anchor: contents survive `_sys/` import,
// scan_vault skips `.` directories, and a stale schema version triggers
// migration via `ensure_anchor_dir`.

use crate::frontmatter::{build_frontmatter, FrontmatterValue};
use crate::vault::{lexical_normalize, parse_frontmatter, title_from_content};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const ANCHOR_DIR: &str = ".anchor";
const SCHEMA_VERSION: u32 = 1;

const GLOBAL_SETTINGS_PATHS: &[&[&str]] = &[
    &["ui", "activeAppMode"],
    &["ui", "activeWorkspaceVisibility"],
    &["ui", "editorViewMode"],
    &["ui", "rightPaneTab"],
    &["ui", "explorerPaneMode"],
    &["ui", "documentBrowserMode"],
    &["ui", "documentLabelMode"],
    &["ui", "workspaceFileFilter"],
    &["ui", "fileQueueDefaultOperation"],
    &["ui", "themeMode"],
    &["ui", "accentColor"],
    &["ui", "layout"],
    &["terminal"],
    &["ai"],
    &["connectors"],
];

const WORKSPACE_STATE_PATHS: &[&[&str]] = &[
    &["ui", "binaryFileIncludePatterns"],
    &["ui", "documentViews"],
    &["ui", "collapsedTreeFolders"],
    &["ui", "collapsedFileFolders"],
    &["ui", "inboxCollapsedSections"],
    &["ui", "documentTreeStateInitialized"],
    &["ui", "fileTreeStateInitialized"],
    &["scan"],
    &["inboxChannels"],
];

const ANCHORIGNORE_DEFAULTS: &[&str] = &[
    "node_modules",
    ".venv",
    "dist",
    "build",
    "target",
    ".next",
    ".turbo",
    ".cache",
    ".secrets",
    ".anchor/cache",
    "_sys/env",
];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

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

fn anchor_path(work: &Path) -> PathBuf {
    work.join(ANCHOR_DIR)
}

fn rules_dir(work: &Path) -> PathBuf {
    anchor_path(work).join("rules")
}

fn templates_dir(work: &Path) -> PathBuf {
    anchor_path(work).join("templates")
}

fn versions_dir(work: &Path) -> PathBuf {
    anchor_path(work).join("versions")
}

fn workspace_json_path(work: &Path) -> PathBuf {
    anchor_path(work).join("workspace.json")
}

fn mcp_json_path(work: &Path) -> PathBuf {
    anchor_path(work).join("mcp.json")
}

fn projects_json_path(work: &Path) -> PathBuf {
    anchor_path(work).join("projects.json")
}

fn skills_json_path(work: &Path) -> PathBuf {
    anchor_path(work).join("skills.json")
}

fn legacy_settings_json_path(work: &Path) -> PathBuf {
    anchor_path(work).join("settings.json")
}

fn workspace_state_json_path(work: &Path) -> PathBuf {
    anchor_path(work).join("workspace-state.json")
}

fn imports_json_path(work: &Path) -> PathBuf {
    anchor_path(work).join("imports.json")
}

fn anchorignore_path(work: &Path) -> PathBuf {
    work.join(".anchorignore")
}

fn anchor_home_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".anchor"))
        .ok_or_else(|| "Could not determine home directory for ~/.anchor".to_string())
}

fn global_settings_json_path_for_home(home: &Path) -> PathBuf {
    home.join(".anchor").join("settings.json")
}

fn global_settings_json_path() -> Result<PathBuf, String> {
    Ok(anchor_home_dir()?.join("settings.json"))
}

/// Reject `name` values that try to escape `.anchor/<sub>/`. We accept
/// only a leaf file name (no slashes, no `..`). Callers append `.md` so
/// the input is the bare stem.
fn validate_leaf_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name is required".to_string());
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.starts_with('.')
    {
        return Err(format!("Invalid name: {name}"));
    }
    Ok(())
}

fn ensure_within(parent: &Path, child: &Path) -> Result<(), String> {
    let normalized = lexical_normalize(child);
    if !normalized.starts_with(parent) {
        return Err("Path escapes the .anchor directory".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/// Idempotently set up `<work>/.anchor/` with skeleton files. Re-running
/// on an already-bootstrapped workspace is a no-op except for any
/// missing files (which are created with their defaults). Existing user
/// content is never overwritten.
pub fn ensure_anchor_dir(work: &Path) -> Result<PathBuf, String> {
    let dir = anchor_path(work);
    fs::create_dir_all(&dir).map_err(|err| format!("Cannot create .anchor: {err}"))?;
    fs::create_dir_all(rules_dir(work))
        .map_err(|err| format!("Cannot create .anchor/rules: {err}"))?;
    fs::create_dir_all(templates_dir(work))
        .map_err(|err| format!("Cannot create .anchor/templates: {err}"))?;
    fs::create_dir_all(versions_dir(work))
        .map_err(|err| format!("Cannot create .anchor/versions: {err}"))?;

    if !workspace_json_path(work).exists() {
        let now = Utc::now().to_rfc3339();
        let initial = AnchorWorkspaceMeta {
            version: SCHEMA_VERSION,
            work_path: work.to_string_lossy().to_string(),
            paired_vault_path: None,
            owner_name: None,
            locale: None,
            last_active_mode: None,
            created_at: now.clone(),
            updated_at: now,
        };
        write_workspace(work, &initial)?;
    } else {
        // Touch read+write to verify file is parseable; if not, leave it
        // alone — surfaces a clear error to the caller next time they ask
        // for it rather than silently overwriting potential user edits.
        let _ = read_workspace_internal(work)?;
    }

    if !mcp_json_path(work).exists() {
        write_json_pretty(
            &mcp_json_path(work),
            &json!({ "version": SCHEMA_VERSION, "servers": {} }),
        )?;
    }
    if !projects_json_path(work).exists() {
        write_json_pretty(
            &projects_json_path(work),
            &json!({ "version": SCHEMA_VERSION, "categories": [] }),
        )?;
    }
    if !skills_json_path(work).exists() {
        write_json_pretty(
            &skills_json_path(work),
            &json!({ "version": SCHEMA_VERSION, "skills": [] }),
        )?;
    }
    if !imports_json_path(work).exists() {
        write_json_pretty(
            &imports_json_path(work),
            &json!({ "version": SCHEMA_VERSION, "items": [] }),
        )?;
    }

    ensure_anchorignore(work)?;
    Ok(dir)
}

/// Append the recommended ignore patterns to `<work>/.anchorignore`,
/// creating the file if absent. Patterns already present are left as-is
/// — the function is idempotent and never reorders existing lines.
fn ensure_anchorignore(work: &Path) -> Result<(), String> {
    let path = anchorignore_path(work);
    let existing = if path.exists() {
        fs::read_to_string(&path).map_err(|err| format!("Cannot read .anchorignore: {err}"))?
    } else {
        String::new()
    };
    let mut lines: Vec<String> = existing.lines().map(|l| l.to_string()).collect();
    let already: std::collections::HashSet<String> = lines
        .iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    let missing: Vec<&&str> = ANCHORIGNORE_DEFAULTS
        .iter()
        .filter(|pattern| !already.contains(**pattern))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    if !lines.is_empty() && !lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.push(String::new());
    }
    if existing.is_empty() {
        lines.push("# anchor: recommended ignore patterns (auto-added by anchor)".to_string());
    } else {
        lines.push("# anchor: added by anchor".to_string());
    }
    for pattern in missing {
        lines.push((*pattern).to_string());
    }
    let mut content = lines.join("\n");
    if !content.ends_with('\n') {
        content.push('\n');
    }
    fs::write(&path, content).map_err(|err| format!("Cannot write .anchorignore: {err}"))?;
    Ok(())
}

fn write_json_pretty(path: &Path, value: &JsonValue) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create {}: {err}", parent.display()))?;
    }
    let serialized =
        serde_json::to_string_pretty(value).map_err(|err| format!("Cannot serialize: {err}"))?;
    let mut content = serialized;
    content.push('\n');
    fs::write(path, content).map_err(|err| format!("Cannot write {}: {err}", path.display()))
}

fn read_json(path: &Path) -> Result<JsonValue, String> {
    let mut file =
        fs::File::open(path).map_err(|err| format!("Cannot open {}: {err}", path.display()))?;
    let mut buf = String::new();
    file.read_to_string(&mut buf)
        .map_err(|err| format!("Cannot read {}: {err}", path.display()))?;
    if buf.trim().is_empty() {
        return Ok(JsonValue::Null);
    }
    serde_json::from_str(&buf).map_err(|err| format!("Cannot parse {}: {err}", path.display()))
}

fn default_settings_json() -> JsonValue {
    json!({
        "version": SCHEMA_VERSION,
        "ui": {
            "activeAppMode": "pkm",
            "activeWorkspaceVisibility": "private",
            "editorViewMode": "source",
            "rightPaneTab": "outline",
            "explorerPaneMode": "documents",
            "documentBrowserMode": "tree",
            "documentLabelMode": "title",
            "workspaceFileFilter": "all",
            "binaryFileIncludePatterns": [
                "*.tgz",
                "*.gz",
                "*.zst",
                "*.ogg",
                "*.mp3",
                "*.wav",
                "*.flac",
                "*.mp4",
                "*.avi",
                "*.mov",
                "*.mkv",
                "*.srt",
                "*.png",
                "*.jpg",
                "*.jpeg",
                "*.heic",
                "*.ai",
                "*.key",
                "*.pdf",
                "*.hwp*",
                "*.doc",
                "*.docx",
                "*.ppt",
                "*.pptx",
                "*.ppsx",
                "*.pps",
                "*.xls*",
                "*.xlsx",
                "*.xlsm",
                "*.tsv",
                "*.html"
            ],
            "documentViews": [],
            "collapsedTreeFolders": [],
            "collapsedFileFolders": [],
            "documentTreeStateInitialized": false,
            "fileTreeStateInitialized": false,
            "fileQueueDefaultOperation": "copy",
            "themeMode": "system",
            "accentColor": "#2f5a3c",
            "layout": {
                "documentTypesPaneOpen": true,
                "documentsPaneOpen": true,
                "documentsPaneWidth": 340,
                "outlineOpen": true,
                "outlinePaneWidth": 280,
                "terminalOpen": false,
                "terminalHeight": 260,
                "terminalMaximized": false,
                "editorSplitOpen": false,
                "editorSplitRatio": 0.5,
                "terminalSplitOpen": false,
                "terminalSplitRatio": 0.5,
                "windowBounds": null,
                "windowMaximized": null
            }
        },
        "terminal": {
            "defaultPanelOpen": false,
            "lastHeight": 260,
            "autoLaunch": "shell",
            "launchers": {
                "claude": {
                    "enabled": true,
                    "label": "Claude Code"
                },
                "codex": {
                    "enabled": true,
                    "label": "Codex"
                },
                "shell": {
                    "enabled": true,
                    "label": "Shell"
                }
            }
        },
        "ai": {
            "providers": {},
            "defaults": {}
        },
        "inboxChannels": {},
        "connectors": {}
    })
}

fn read_json_if_exists(path: &Path) -> Result<Option<JsonValue>, String> {
    if !path.exists() {
        return Ok(None);
    }
    read_json(path).map(Some)
}

fn merge_json(base: &mut JsonValue, overlay: &JsonValue) {
    match (base, overlay) {
        (JsonValue::Object(base_map), JsonValue::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                match base_map.get_mut(key) {
                    Some(existing) => merge_json(existing, value),
                    None => {
                        base_map.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (base_slot, overlay_value) => {
            *base_slot = overlay_value.clone();
        }
    }
}

fn copy_path(source: &JsonValue, target: &mut JsonValue, path: &[&str]) {
    let pointer = format!("/{}", path.join("/"));
    if let Some(value) = source.pointer(&pointer) {
        insert_path(target, path, value.clone());
    }
}

fn insert_path(target: &mut JsonValue, path: &[&str], value: JsonValue) {
    if path.is_empty() {
        *target = value;
        return;
    }
    if !target.is_object() {
        *target = json!({});
    }
    if path.len() == 1 {
        if let Some(map) = target.as_object_mut() {
            map.insert(path[0].to_string(), value);
        }
        return;
    }
    let child = target
        .as_object_mut()
        .expect("target is object")
        .entry(path[0].to_string())
        .or_insert_with(|| json!({}));
    insert_path(child, &path[1..], value);
}

fn split_settings_json(value: &JsonValue) -> (JsonValue, JsonValue) {
    let mut global = json!({ "version": SCHEMA_VERSION });
    for path in GLOBAL_SETTINGS_PATHS {
        copy_path(value, &mut global, path);
    }

    let mut workspace_state = json!({ "version": SCHEMA_VERSION });
    for path in WORKSPACE_STATE_PATHS {
        copy_path(value, &mut workspace_state, path);
    }

    (global, workspace_state)
}

fn apply_changed_paths(
    target: &mut JsonValue,
    incoming: &JsonValue,
    base: &JsonValue,
    paths: &[&[&str]],
) -> bool {
    let mut changed = false;
    for path in paths {
        let pointer = format!("/{}", path.join("/"));
        let incoming_value = incoming.pointer(&pointer);
        if incoming_value == base.pointer(&pointer) {
            continue;
        }
        if let Some(value) = incoming_value {
            insert_path(target, path, value.clone());
            changed = true;
        }
    }
    changed
}

fn migrate_legacy_settings_if_needed(work: &Path, global_path: &Path) -> Result<(), String> {
    let legacy_path = legacy_settings_json_path(work);
    if !legacy_path.exists() {
        return Ok(());
    }

    let state_path = workspace_state_json_path(work);
    if global_path.exists() && state_path.exists() {
        return Ok(());
    }

    let legacy = read_json(&legacy_path)?;
    let (legacy_global, legacy_workspace_state) = split_settings_json(&legacy);
    if !global_path.exists() {
        write_json_pretty(global_path, &legacy_global)?;
    }
    if !state_path.exists() {
        write_json_pretty(&state_path, &legacy_workspace_state)?;
    }
    Ok(())
}

fn read_anchor_settings_internal(work: &Path, global_path: &Path) -> Result<JsonValue, String> {
    ensure_anchor_dir(work)?;
    migrate_legacy_settings_if_needed(work, global_path)?;

    let mut settings = default_settings_json();
    if let Some(global) = read_json_if_exists(global_path)? {
        merge_json(&mut settings, &global);
    }
    if let Some(workspace_state) = read_json_if_exists(&workspace_state_json_path(work))? {
        merge_json(&mut settings, &workspace_state);
    }
    Ok(settings)
}

fn save_anchor_settings_internal(
    work: &Path,
    global_path: &Path,
    value: JsonValue,
) -> Result<AnchorSettingsSaveOutcome, String> {
    save_anchor_settings_internal_with_base(work, global_path, value, None)
}

fn save_anchor_settings_internal_with_base(
    work: &Path,
    global_path: &Path,
    value: JsonValue,
    base_value: Option<JsonValue>,
) -> Result<AnchorSettingsSaveOutcome, String> {
    ensure_anchor_dir(work)?;
    migrate_legacy_settings_if_needed(work, global_path)?;
    let (global, workspace_state) = split_settings_json(&value);
    let state_path = workspace_state_json_path(work);
    let Some(base) = base_value else {
        write_json_pretty(global_path, &global)?;
        write_json_pretty(&state_path, &workspace_state)?;
        return Ok(AnchorSettingsSaveOutcome {
            global_changed: true,
            workspace_changed: true,
        });
    };

    let mut current_global =
        read_json_if_exists(global_path)?.unwrap_or_else(|| json!({ "version": SCHEMA_VERSION }));
    let mut current_workspace_state =
        read_json_if_exists(&state_path)?.unwrap_or_else(|| json!({ "version": SCHEMA_VERSION }));
    let global_changed =
        apply_changed_paths(&mut current_global, &global, &base, GLOBAL_SETTINGS_PATHS);
    let workspace_changed = apply_changed_paths(
        &mut current_workspace_state,
        &workspace_state,
        &base,
        WORKSPACE_STATE_PATHS,
    );
    if global_changed {
        write_json_pretty(global_path, &current_global)?;
    }
    if workspace_changed {
        write_json_pretty(&state_path, &current_workspace_state)?;
    }
    Ok(AnchorSettingsSaveOutcome {
        global_changed,
        workspace_changed,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorSettingsSaveOutcome {
    pub global_changed: bool,
    pub workspace_changed: bool,
}

// ---------------------------------------------------------------------------
// Workspace meta
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorWorkspaceMeta {
    pub version: u32,
    pub work_path: String,
    pub paired_vault_path: Option<String>,
    pub owner_name: Option<String>,
    pub locale: Option<String>,
    /// "pkm" | "inbox" | "system".
    pub last_active_mode: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Patch envelope for `update_anchor_workspace`.
///
/// Each field is `Option<String>` with v1 semantics: `Some(value)` sets
/// the field, omitting / sending `null` leaves the existing value
/// unchanged. We don't yet support "clear to None" via the patch — none
/// of the v1 callers need it. Adding nested-Option support is a future
/// extension when a real use case appears.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorWorkspaceMetaPatch {
    #[serde(default)]
    pub paired_vault_path: Option<String>,
    #[serde(default)]
    pub owner_name: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub last_active_mode: Option<String>,
}

fn read_workspace_internal(work: &Path) -> Result<AnchorWorkspaceMeta, String> {
    let path = workspace_json_path(work);
    let content =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read workspace.json: {err}"))?;
    let meta: AnchorWorkspaceMeta = serde_json::from_str(&content)
        .map_err(|err| format!("Cannot parse workspace.json: {err}"))?;
    if meta.version > SCHEMA_VERSION {
        return Err(format!(
            "Anchor workspace schema is newer than this client (got v{}, supports v{})",
            meta.version, SCHEMA_VERSION
        ));
    }
    Ok(meta)
}

fn write_workspace(work: &Path, meta: &AnchorWorkspaceMeta) -> Result<(), String> {
    let mut value = serde_json::to_value(meta)
        .map_err(|err| format!("Cannot serialize workspace meta: {err}"))?;
    if let JsonValue::Object(ref mut map) = value {
        // Stable key order via BTreeMap re-serialize.
        let mut sorted: BTreeMap<String, JsonValue> = BTreeMap::new();
        for (k, v) in map.iter() {
            sorted.insert(k.clone(), v.clone());
        }
        let stable = serde_json::to_value(&sorted)
            .map_err(|err| format!("Cannot stabilize workspace meta: {err}"))?;
        write_json_pretty(&workspace_json_path(work), &stable)
    } else {
        Err("workspace meta did not serialize to an object".to_string())
    }
}

#[tauri::command]
pub fn read_anchor_workspace(work_path: String) -> Result<AnchorWorkspaceMeta, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    read_workspace_internal(&work)
}

#[tauri::command]
pub fn update_anchor_workspace(
    work_path: String,
    patch: AnchorWorkspaceMetaPatch,
) -> Result<AnchorWorkspaceMeta, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    let mut meta = read_workspace_internal(&work)?;
    if let Some(value) = patch.paired_vault_path {
        meta.paired_vault_path = Some(value);
    }
    if let Some(value) = patch.owner_name {
        meta.owner_name = Some(value);
    }
    if let Some(value) = patch.locale {
        meta.locale = Some(value);
    }
    if let Some(value) = patch.last_active_mode {
        meta.last_active_mode = Some(value);
    }
    meta.updated_at = Utc::now().to_rfc3339();
    write_workspace(&work, &meta)?;
    Ok(meta)
}

/// Direct write used by `workspace::register_workspace_pair` so the
/// pairing can stamp the meta atomically with vault registration. Goes
/// through the same `ensure_anchor_dir → read → patch → write` pipeline
/// as the command but without a `patch` envelope.
pub fn set_paired_vault_path(work: &Path, paired: Option<String>) -> Result<(), String> {
    ensure_anchor_dir(work)?;
    let mut meta = read_workspace_internal(work)?;
    meta.paired_vault_path = paired;
    meta.updated_at = Utc::now().to_rfc3339();
    write_workspace(work, &meta)
}

pub fn set_owner_name(work: &Path, owner: Option<String>) -> Result<(), String> {
    ensure_anchor_dir(work)?;
    let mut meta = read_workspace_internal(work)?;
    meta.owner_name = owner;
    meta.updated_at = Utc::now().to_rfc3339();
    write_workspace(work, &meta)
}

#[tauri::command]
pub fn bootstrap_anchor_dir(work_path: String) -> Result<AnchorWorkspaceMeta, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    read_workspace_internal(&work)
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleEntry {
    pub name: String,
    pub title: String,
    pub enabled: bool,
    pub scope: Option<String>,
    pub origin: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDocument {
    pub name: String,
    pub rel_path: String,
    pub content: String,
    pub title: String,
    pub enabled: bool,
}

fn rule_path(work: &Path, name: &str) -> Result<PathBuf, String> {
    validate_leaf_name(name)?;
    let path = rules_dir(work).join(format!("{name}.md"));
    ensure_within(&rules_dir(work), &path)?;
    Ok(path)
}

fn rule_entry_from_path(path: &Path, name: String) -> RuleEntry {
    let content = fs::read_to_string(path).unwrap_or_default();
    let parts = parse_frontmatter(&content);
    let title = title_from_content(&content, &name);
    let enabled = parts
        .meta
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let scope = parts
        .meta
        .get("scope")
        .and_then(|v| v.as_str().map(str::to_string));
    let origin = parts
        .meta
        .get("origin")
        .and_then(|v| v.as_str().map(str::to_string));
    let updated_at = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .map(chrono::DateTime::<Utc>::from)
        .map(|dt| dt.to_rfc3339());
    RuleEntry {
        name,
        title,
        enabled,
        scope,
        origin,
        updated_at,
    }
}

#[tauri::command]
pub fn list_anchor_rules(work_path: String) -> Result<Vec<RuleEntry>, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    let dir = rules_dir(&work);
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir)
        .map_err(|err| format!("Cannot read rules directory: {err}"))?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        entries.push(rule_entry_from_path(&path, name.to_string()));
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

#[tauri::command]
pub fn read_anchor_rule(work_path: String, name: String) -> Result<RuleDocument, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    let path = rule_path(&work, &name)?;
    let content =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read rule {name}: {err}"))?;
    let parts = parse_frontmatter(&content);
    let title = title_from_content(&content, &name);
    let enabled = parts
        .meta
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let rel_path = path
        .strip_prefix(&work)
        .unwrap_or(&path)
        .to_string_lossy()
        .to_string();
    Ok(RuleDocument {
        name,
        rel_path,
        content,
        title,
        enabled,
    })
}

#[tauri::command]
pub fn save_anchor_rule(
    work_path: String,
    name: String,
    content: String,
) -> Result<RuleEntry, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    let path = rule_path(&work, &name)?;
    fs::write(&path, content).map_err(|err| format!("Cannot save rule {name}: {err}"))?;
    Ok(rule_entry_from_path(&path, name))
}

#[tauri::command]
pub fn delete_anchor_rule(work_path: String, name: String) -> Result<(), String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    let path = rule_path(&work, &name)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|err| format!("Cannot delete rule: {err}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateEntry {
    pub name: String,
    pub title: String,
    pub doc_type: Option<String>,
    pub origin: Option<String>,
    pub updated_at: Option<String>,
}

fn template_path(work: &Path, name: &str) -> Result<PathBuf, String> {
    validate_leaf_name(name)?;
    let path = templates_dir(work).join(format!("{name}.md"));
    ensure_within(&templates_dir(work), &path)?;
    Ok(path)
}

fn template_entry_from_path(path: &Path, name: String) -> TemplateEntry {
    let content = fs::read_to_string(path).unwrap_or_default();
    let parts = parse_frontmatter(&content);
    let title = title_from_content(&content, &name);
    let doc_type = parts
        .meta
        .get("type")
        .and_then(|v| v.as_str().map(str::to_string));
    let origin = parts
        .meta
        .get("origin")
        .and_then(|v| v.as_str().map(str::to_string));
    let updated_at = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .map(chrono::DateTime::<Utc>::from)
        .map(|dt| dt.to_rfc3339());
    TemplateEntry {
        name,
        title,
        doc_type,
        origin,
        updated_at,
    }
}

#[tauri::command]
pub fn list_anchor_templates(work_path: String) -> Result<Vec<TemplateEntry>, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    let dir = templates_dir(&work);
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir)
        .map_err(|err| format!("Cannot read templates directory: {err}"))?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        entries.push(template_entry_from_path(&path, name.to_string()));
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

#[tauri::command]
pub fn read_anchor_template(work_path: String, name: String) -> Result<String, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    let path = template_path(&work, &name)?;
    fs::read_to_string(&path).map_err(|err| format!("Cannot read template {name}: {err}"))
}

#[tauri::command]
pub fn save_anchor_template(
    work_path: String,
    name: String,
    content: String,
) -> Result<TemplateEntry, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    let path = template_path(&work, &name)?;
    fs::write(&path, content).map_err(|err| format!("Cannot save template {name}: {err}"))?;
    Ok(template_entry_from_path(&path, name))
}

#[tauri::command]
pub fn delete_anchor_template(work_path: String, name: String) -> Result<(), String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    let path = template_path(&work, &name)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|err| format!("Cannot delete template: {err}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// MCP / Projects / Skills (raw JSON documents)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn read_anchor_mcp(work_path: String) -> Result<JsonValue, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    read_json(&mcp_json_path(&work))
}

#[tauri::command]
pub fn save_anchor_mcp(work_path: String, value: JsonValue) -> Result<(), String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    write_json_pretty(&mcp_json_path(&work), &value)
}

#[tauri::command]
pub fn read_anchor_projects(work_path: String) -> Result<JsonValue, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    read_json(&projects_json_path(&work))
}

#[tauri::command]
pub fn save_anchor_projects(work_path: String, value: JsonValue) -> Result<(), String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    write_json_pretty(&projects_json_path(&work), &value)
}

#[tauri::command]
pub fn read_anchor_skills(work_path: String) -> Result<JsonValue, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    read_json(&skills_json_path(&work))
}

#[tauri::command]
pub fn save_anchor_skills(work_path: String, value: JsonValue) -> Result<(), String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    write_json_pretty(&skills_json_path(&work), &value)
}

#[tauri::command]
pub fn read_anchor_settings(work_path: String) -> Result<JsonValue, String> {
    let work = normalize_work_path(&work_path)?;
    let global_path = global_settings_json_path()?;
    read_anchor_settings_internal(&work, &global_path)
}

#[tauri::command]
pub fn save_anchor_settings(
    work_path: String,
    value: JsonValue,
    base_value: Option<JsonValue>,
) -> Result<AnchorSettingsSaveOutcome, String> {
    let work = normalize_work_path(&work_path)?;
    let global_path = global_settings_json_path()?;
    save_anchor_settings_internal_with_base(&work, &global_path, value, base_value)
}

#[tauri::command]
pub fn read_anchor_imports(work_path: String) -> Result<JsonValue, String> {
    let work = normalize_work_path(&work_path)?;
    ensure_anchor_dir(&work)?;
    read_json(&imports_json_path(&work))
}

/// Append entries to `.anchor/imports.json`. Each entry is a free-form
/// JSON object — the schema is owned by `sys_import.rs`.
pub fn append_imports(work: &Path, items: Vec<JsonValue>) -> Result<(), String> {
    let path = imports_json_path(work);
    let mut value = read_json(&path).unwrap_or(JsonValue::Null);
    if !value.is_object() {
        value = json!({ "version": SCHEMA_VERSION, "items": [] });
    }
    let arr = value
        .as_object_mut()
        .and_then(|obj| obj.get_mut("items"))
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "imports.json missing items array".to_string())?;
    for item in items {
        arr.push(item);
    }
    write_json_pretty(&path, &value)
}

// ---------------------------------------------------------------------------
// Public helpers used by other modules
// ---------------------------------------------------------------------------

pub fn write_rule_with_origin(
    work: &Path,
    name: &str,
    body: &str,
    origin_rel: &str,
    sha256: &str,
) -> Result<PathBuf, String> {
    ensure_anchor_dir(work)?;
    let path = rule_path(work, name)?;
    // Strip any leading frontmatter on incoming body — origin file may
    // itself be frontmatter-bearing. We attach our own metadata block.
    let parts = parse_frontmatter(body);
    let stripped_body = parts.body;
    let now = Utc::now().to_rfc3339();
    let mut fields: Vec<(&str, FrontmatterValue)> = vec![
        ("origin", FrontmatterValue::String(origin_rel.to_string())),
        (
            "origin_sha256",
            FrontmatterValue::String(sha256.to_string()),
        ),
        ("imported_at", FrontmatterValue::String(now)),
        ("enabled", FrontmatterValue::Bool(true)),
    ];
    // If the original frontmatter already had `scope` or `title`,
    // preserve them verbatim.
    if let Some(scope) = parts.meta.get("scope").and_then(|v| v.as_str()) {
        fields.push(("scope", FrontmatterValue::String(scope.to_string())));
    }
    let content = build_frontmatter(&fields, &stripped_body);
    let mut file = fs::File::create(&path)
        .map_err(|err| format!("Cannot write rule file {}: {err}", path.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|err| format!("Cannot write rule {}: {err}", path.display()))?;
    Ok(path)
}

pub fn write_template_with_origin(
    work: &Path,
    name: &str,
    body: &str,
    origin_rel: &str,
    sha256: &str,
) -> Result<PathBuf, String> {
    ensure_anchor_dir(work)?;
    let path = template_path(work, name)?;
    let parts = parse_frontmatter(body);
    let stripped_body = parts.body;
    let now = Utc::now().to_rfc3339();
    let mut fields: Vec<(&str, FrontmatterValue)> = vec![
        ("origin", FrontmatterValue::String(origin_rel.to_string())),
        (
            "origin_sha256",
            FrontmatterValue::String(sha256.to_string()),
        ),
        ("imported_at", FrontmatterValue::String(now)),
    ];
    if let Some(t) = parts.meta.get("type").and_then(|v| v.as_str()) {
        fields.push(("type", FrontmatterValue::String(t.to_string())));
    }
    let content = build_frontmatter(&fields, &stripped_body);
    fs::write(&path, content).map_err(|err| format!("Cannot write template: {err}"))?;
    Ok(path)
}

/// Used by sys_import to overwrite the projects/mcp/skills JSON.
pub fn write_mcp(work: &Path, value: &JsonValue) -> Result<(), String> {
    ensure_anchor_dir(work)?;
    write_json_pretty(&mcp_json_path(work), value)
}

pub fn write_projects(work: &Path, value: &JsonValue) -> Result<(), String> {
    ensure_anchor_dir(work)?;
    write_json_pretty(&projects_json_path(work), value)
}

pub fn write_skills(work: &Path, value: &JsonValue) -> Result<(), String> {
    ensure_anchor_dir(work)?;
    write_json_pretty(&skills_json_path(work), value)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh_work() -> TempDir {
        TempDir::new().unwrap()
    }

    #[test]
    fn ensure_anchor_dir_creates_skeleton() {
        let tmp = fresh_work();
        ensure_anchor_dir(tmp.path()).unwrap();
        assert!(tmp.path().join(".anchor/workspace.json").exists());
        assert!(tmp.path().join(".anchor/rules").is_dir());
        assert!(tmp.path().join(".anchor/templates").is_dir());
        assert!(tmp.path().join(".anchor/versions").is_dir());
        assert!(tmp.path().join(".anchor/mcp.json").exists());
        assert!(tmp.path().join(".anchor/projects.json").exists());
        assert!(tmp.path().join(".anchor/skills.json").exists());
        assert!(!tmp.path().join(".anchor/settings.json").exists());
        assert!(tmp.path().join(".anchor/imports.json").exists());
        assert!(tmp.path().join(".anchorignore").exists());
    }

    #[test]
    fn ensure_anchor_dir_is_idempotent() {
        let tmp = fresh_work();
        ensure_anchor_dir(tmp.path()).unwrap();
        // Edit a known file the second call should not clobber.
        let mcp = tmp.path().join(".anchor/mcp.json");
        fs::write(&mcp, "{\"version\": 1, \"servers\": {\"x\": {}}}").unwrap();
        let before = fs::read_to_string(&mcp).unwrap();
        ensure_anchor_dir(tmp.path()).unwrap();
        let after = fs::read_to_string(&mcp).unwrap();
        assert_eq!(
            before, after,
            "second ensure must not overwrite existing JSON"
        );
    }

    #[test]
    fn settings_paths_are_split_between_home_and_workspace() {
        let home = fresh_work();
        let work = fresh_work();
        assert_eq!(
            global_settings_json_path_for_home(home.path()),
            home.path().join(".anchor/settings.json")
        );
        assert_eq!(
            workspace_state_json_path(work.path()),
            work.path().join(".anchor/workspace-state.json")
        );
        assert_eq!(
            legacy_settings_json_path(work.path()),
            work.path().join(".anchor/settings.json")
        );
    }

    #[test]
    fn ensure_anchorignore_appends_without_dup() {
        let tmp = fresh_work();
        fs::write(
            tmp.path().join(".anchorignore"),
            "# pre-existing\nnode_modules\n.venv\n",
        )
        .unwrap();
        ensure_anchor_dir(tmp.path()).unwrap();
        let content = fs::read_to_string(tmp.path().join(".anchorignore")).unwrap();
        // node_modules and .venv must not duplicate.
        assert_eq!(content.matches("node_modules").count(), 1);
        assert_eq!(content.matches(".venv").count(), 1);
        // Newly-required patterns are appended.
        assert!(content.contains("_sys/env"));
        assert!(content.contains(".secrets"));
        // Idempotent on a second run.
        ensure_anchor_dir(tmp.path()).unwrap();
        let again = fs::read_to_string(tmp.path().join(".anchorignore")).unwrap();
        assert_eq!(content, again, "second ensure_anchorignore must be a no-op");
    }

    #[test]
    fn settings_split_round_trips_pretty() {
        let tmp = fresh_work();
        let home = fresh_work();
        let global = home.path().join(".anchor/settings.json");
        let initial = read_anchor_settings_internal(tmp.path(), &global).unwrap();
        assert_eq!(
            initial
                .pointer("/ui/documentBrowserMode")
                .and_then(JsonValue::as_str),
            Some("tree")
        );
        assert_eq!(
            initial
                .pointer("/terminal/defaultPanelOpen")
                .and_then(JsonValue::as_bool),
            Some(false)
        );
        assert_eq!(
            initial
                .pointer("/terminal/autoLaunch")
                .and_then(JsonValue::as_str),
            Some("shell")
        );
        assert_eq!(
            initial
                .pointer("/ui/layout/terminalOpen")
                .and_then(JsonValue::as_bool),
            Some(false)
        );

        let next = json!({
            "version": 1,
            "ui": {
                "documentBrowserMode": "tree",
                "collapsedTreeFolders": ["projects/rise"],
                "documentViews": [
                    {
                        "id": "rise-active",
                        "label": "RISE Active",
                        "color": "#884477",
                        "type": "project",
                        "status": "active"
                    }
                ]
            },
            "terminal": {
                "defaultPanelOpen": false,
                "lastHeight": 320,
                "launchers": {}
            },
            "inboxChannels": {},
            "connectors": {}
        });
        save_anchor_settings_internal(tmp.path(), &global, next).unwrap();
        let reloaded = read_anchor_settings_internal(tmp.path(), &global).unwrap();
        assert_eq!(
            reloaded
                .pointer("/ui/documentBrowserMode")
                .and_then(JsonValue::as_str),
            Some("tree")
        );
        assert_eq!(
            reloaded
                .pointer("/ui/collapsedTreeFolders/0")
                .and_then(JsonValue::as_str),
            Some("projects/rise")
        );
        assert_eq!(
            reloaded
                .pointer("/ui/documentViews/0/label")
                .and_then(JsonValue::as_str),
            Some("RISE Active")
        );
        let raw = fs::read_to_string(&global).unwrap();
        assert!(
            raw.contains('\n') && raw.ends_with('\n'),
            "global settings should be pretty JSON with trailing newline"
        );
        let state_raw =
            fs::read_to_string(tmp.path().join(".anchor/workspace-state.json")).unwrap();
        assert!(
            state_raw.contains('\n') && state_raw.ends_with('\n'),
            "workspace state should be pretty JSON with trailing newline"
        );
        assert!(!tmp.path().join(".anchor/settings.json").exists());
        let global_value = read_json(&global).unwrap();
        assert_eq!(
            global_value
                .pointer("/ui/documentBrowserMode")
                .and_then(JsonValue::as_str),
            Some("tree")
        );
        assert!(global_value.pointer("/ui/collapsedTreeFolders").is_none());
        assert!(global_value.pointer("/ui/documentViews").is_none());
        let state_value = read_json(&tmp.path().join(".anchor/workspace-state.json")).unwrap();
        assert_eq!(
            state_value
                .pointer("/ui/collapsedTreeFolders/0")
                .and_then(JsonValue::as_str),
            Some("projects/rise")
        );
        assert_eq!(
            state_value
                .pointer("/ui/documentViews/0/id")
                .and_then(JsonValue::as_str),
            Some("rise-active")
        );
        assert!(state_value.pointer("/terminal").is_none());
        assert!(state_value.pointer("/connectors").is_none());
    }

    #[test]
    fn settings_save_with_base_preserves_newer_global_values() {
        let work_a = fresh_work();
        let work_b = fresh_work();
        let home = fresh_work();
        let global = home.path().join(".anchor/settings.json");

        let base_a = read_anchor_settings_internal(work_a.path(), &global).unwrap();
        let stale_base_b = read_anchor_settings_internal(work_b.path(), &global).unwrap();
        let mut next_a = base_a.clone();
        insert_path(
            &mut next_a,
            &["ui", "themeMode"],
            JsonValue::String("dark".to_string()),
        );
        save_anchor_settings_internal_with_base(work_a.path(), &global, next_a, Some(base_a))
            .unwrap();

        let mut next_b = stale_base_b.clone();
        insert_path(
            &mut next_b,
            &["ui", "collapsedTreeFolders"],
            json!(["workspace-b-only"]),
        );
        save_anchor_settings_internal_with_base(work_b.path(), &global, next_b, Some(stale_base_b))
            .unwrap();

        let effective_a = read_anchor_settings_internal(work_a.path(), &global).unwrap();
        let effective_b = read_anchor_settings_internal(work_b.path(), &global).unwrap();
        assert_eq!(
            effective_a
                .pointer("/ui/themeMode")
                .and_then(JsonValue::as_str),
            Some("dark")
        );
        assert_eq!(
            effective_b
                .pointer("/ui/themeMode")
                .and_then(JsonValue::as_str),
            Some("dark")
        );
        assert_eq!(
            effective_b
                .pointer("/ui/collapsedTreeFolders/0")
                .and_then(JsonValue::as_str),
            Some("workspace-b-only")
        );
    }

    #[test]
    fn connectors_save_to_global_defaults_not_workspace_state() {
        let tmp = fresh_work();
        let home = fresh_work();
        let global = home.path().join(".anchor/settings.json");
        let base = read_anchor_settings_internal(tmp.path(), &global).unwrap();
        let mut next = base.clone();
        insert_path(
            &mut next,
            &["connectors"],
            json!({
                "hub": {
                    "endpoint": "http://localhost:9710"
                }
            }),
        );

        let outcome =
            save_anchor_settings_internal_with_base(tmp.path(), &global, next, Some(base)).unwrap();

        assert!(outcome.global_changed);
        assert!(!outcome.workspace_changed);
        let global_value = read_json(&global).unwrap();
        assert_eq!(
            global_value
                .pointer("/connectors/hub/endpoint")
                .and_then(JsonValue::as_str),
            Some("http://localhost:9710")
        );
        let state_value = read_json_if_exists(&tmp.path().join(".anchor/workspace-state.json"))
            .unwrap()
            .unwrap_or_else(|| json!({}));
        assert!(state_value.pointer("/connectors").is_none());
    }

    #[test]
    fn legacy_workspace_settings_migrate_without_deleting_source() {
        let tmp = fresh_work();
        let home = fresh_work();
        let global = home.path().join(".anchor/settings.json");
        ensure_anchor_dir(tmp.path()).unwrap();
        fs::write(
            tmp.path().join(".anchor/settings.json"),
            r##"{
  "version": 1,
  "ui": {
    "documentBrowserMode": "list",
    "themeMode": "dark",
    "collapsedTreeFolders": ["projects/rise"],
    "binaryFileIncludePatterns": ["*.pdf"]
  },
  "terminal": {
    "defaultPanelOpen": true,
    "lastHeight": 420,
    "autoLaunch": "codex",
    "launchers": {}
  },
  "connectors": {
    "hub": {
      "endpoint": "http://localhost:9710"
    }
  }
}"##,
        )
        .unwrap();

        let effective = read_anchor_settings_internal(tmp.path(), &global).unwrap();
        assert_eq!(
            effective
                .pointer("/ui/documentBrowserMode")
                .and_then(JsonValue::as_str),
            Some("list")
        );
        assert_eq!(
            effective
                .pointer("/ui/themeMode")
                .and_then(JsonValue::as_str),
            Some("dark")
        );
        assert_eq!(
            effective
                .pointer("/ui/collapsedTreeFolders/0")
                .and_then(JsonValue::as_str),
            Some("projects/rise")
        );
        assert_eq!(
            effective
                .pointer("/connectors/hub/endpoint")
                .and_then(JsonValue::as_str),
            Some("http://localhost:9710")
        );
        assert_eq!(
            read_json(&global)
                .unwrap()
                .pointer("/connectors/hub/endpoint")
                .and_then(JsonValue::as_str),
            Some("http://localhost:9710")
        );
        assert!(read_json(&tmp.path().join(".anchor/workspace-state.json"))
            .unwrap()
            .pointer("/connectors")
            .is_none());
        assert!(tmp.path().join(".anchor/settings.json").exists());
        assert!(tmp.path().join(".anchor/workspace-state.json").exists());
        assert!(global.exists());
    }

    #[test]
    fn settings_path_rejects_missing_or_file_work_path() {
        let tmp = fresh_work();
        let file = tmp.path().join("not-a-dir");
        fs::write(&file, "x").unwrap();
        let result = read_anchor_settings(file.to_string_lossy().to_string());
        assert!(result.is_err());
    }

    #[test]
    fn workspace_meta_round_trips() {
        let tmp = fresh_work();
        let work = tmp.path().to_string_lossy().to_string();
        let meta = read_anchor_workspace(work.clone()).unwrap();
        assert_eq!(meta.version, SCHEMA_VERSION);
        assert!(meta.paired_vault_path.is_none());
        let patch = AnchorWorkspaceMetaPatch {
            paired_vault_path: Some("/vault/path".to_string()),
            owner_name: Some("이영준".to_string()),
            locale: None,
            last_active_mode: Some("system".to_string()),
        };
        let updated = update_anchor_workspace(work.clone(), patch).unwrap();
        assert_eq!(updated.paired_vault_path.as_deref(), Some("/vault/path"));
        assert_eq!(updated.owner_name.as_deref(), Some("이영준"));
        assert_eq!(updated.last_active_mode.as_deref(), Some("system"));
        let reloaded = read_anchor_workspace(work).unwrap();
        assert_eq!(reloaded.paired_vault_path.as_deref(), Some("/vault/path"));
    }

    #[test]
    fn rule_crud_round_trips() {
        let tmp = fresh_work();
        let work = tmp.path().to_string_lossy().to_string();
        let body = "---\nenabled: true\nscope: meetings\n---\n# Demo Rule\n\nbody.\n";
        let entry = save_anchor_rule(work.clone(), "demo".to_string(), body.to_string()).unwrap();
        assert_eq!(entry.name, "demo");
        assert!(entry.enabled);
        assert_eq!(entry.scope.as_deref(), Some("meetings"));

        let listed = list_anchor_rules(work.clone()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "Demo Rule");

        let doc = read_anchor_rule(work.clone(), "demo".to_string()).unwrap();
        assert_eq!(doc.content, body);

        delete_anchor_rule(work.clone(), "demo".to_string()).unwrap();
        let listed = list_anchor_rules(work).unwrap();
        assert!(listed.is_empty());
    }

    #[test]
    fn rule_name_rejects_path_traversal() {
        let tmp = fresh_work();
        let work = tmp.path().to_string_lossy().to_string();
        let result = save_anchor_rule(work, "../escape".to_string(), "x".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn imports_append_round_trips() {
        let tmp = fresh_work();
        ensure_anchor_dir(tmp.path()).unwrap();
        append_imports(
            tmp.path(),
            vec![json!({ "origin_rel": "_sys/rules/x.md", "sha256": "deadbeef", "category": "rule" })],
        )
        .unwrap();
        let value = read_json(&imports_json_path(tmp.path())).unwrap();
        let items = value.get("items").and_then(JsonValue::as_array).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].get("origin_rel").and_then(JsonValue::as_str),
            Some("_sys/rules/x.md")
        );
    }

    #[test]
    fn write_rule_with_origin_attaches_metadata() {
        let tmp = fresh_work();
        let written = write_rule_with_origin(
            tmp.path(),
            "ingest-chain",
            "# Ingest Chain\n\nBody.\n",
            "_sys/rules/ingest-chain.md",
            "abc123",
        )
        .unwrap();
        let content = fs::read_to_string(&written).unwrap();
        assert!(content.starts_with("---\n"));
        assert!(
            content.contains("origin:") && content.contains("_sys/rules/ingest-chain.md"),
            "got: {content}"
        );
        assert!(content.contains("origin_sha256:") && content.contains("abc123"));
        assert!(content.contains("# Ingest Chain"));
    }
}
