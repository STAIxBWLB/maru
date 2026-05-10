// Per-vault inbox configuration. Stored at `<vault>/.anchor/inbox.json`.
// Loaded by `scan_inbox_drop` and `start_inbox_watcher` so the user can
// retarget the inbox root (`inbox/downloads` by default) and restrict
// which subdirectories are recognized as classification sources.
//
// Schema is intentionally tiny — anything richer belongs in the broader
// layered settings model. Missing or unreadable file → defaults.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use tauri::{AppHandle, Emitter};

use crate::vault::resolve_inside_vault;

pub const DEFAULT_INBOX_ROOT: &str = "inbox/downloads";
const WORKSPACE_CONFIG_FILE: &str = "workspace.config.yaml";

pub fn default_sources() -> Vec<String> {
    vec![
        "outlook".to_string(),
        "sharepoint".to_string(),
        "gmail".to_string(),
        "kakao".to_string(),
        "telegram".to_string(),
        "downloads".to_string(),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxSettings {
    pub inbox_root: String,
    pub sources: Vec<String>,
    /// Optional absolute path to the `gws` CLI binary. When None,
    /// `gmail_gws::resolve_gws_path` falls back to PATH lookup with a
    /// macOS-aware augmentation.
    #[serde(default)]
    pub gws_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InboxPathConfig {
    pub drop: String,
    pub items: String,
    pub pending: String,
    pub done: String,
    pub failed: String,
    pub duplicate: String,
    pub state: String,
    pub receipts: String,
}

impl Default for InboxPathConfig {
    fn default() -> Self {
        Self {
            drop: "drop".to_string(),
            items: "items".to_string(),
            pending: "items/pending".to_string(),
            done: "items/done".to_string(),
            failed: "items/failed".to_string(),
            duplicate: "items/duplicate".to_string(),
            state: "_state".to_string(),
            receipts: "_state/index.jsonl".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InboxNamingConfig {
    pub item_id_template: String,
    pub raw_dir: String,
    pub manifest_file: String,
    pub extracted_file: String,
    pub summary_file: String,
    pub route_file: String,
}

impl Default for InboxNamingConfig {
    fn default() -> Self {
        Self {
            item_id_template: "{date}-{channel}-{slug}".to_string(),
            raw_dir: "raw".to_string(),
            manifest_file: "manifest.yaml".to_string(),
            extracted_file: "extracted.md".to_string(),
            summary_file: "summary.md".to_string(),
            route_file: "route.md".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InboxFileDropConfig {
    pub channel: String,
    pub drop_path: String,
    pub operation: String,
}

impl Default for InboxFileDropConfig {
    fn default() -> Self {
        Self {
            channel: "incoming".to_string(),
            drop_path: "drop/incoming".to_string(),
            operation: "copy".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InboxGmailConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_gmail_scan_window_days")]
    pub scan_window_days: u32,
    #[serde(default = "default_gmail_max_results")]
    pub max_results: u32,
    #[serde(default = "default_gmail_auto_refresh_ttl_seconds")]
    pub auto_refresh_ttl_seconds: u32,
    #[serde(default = "default_true")]
    pub unread_only: bool,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub gws_path: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_gmail_scan_window_days() -> u32 {
    14
}

fn default_gmail_max_results() -> u32 {
    20
}

fn default_gmail_auto_refresh_ttl_seconds() -> u32 {
    300
}

impl Default for InboxGmailConfig {
    fn default() -> Self {
        Self {
            enabled: default_true(),
            scan_window_days: default_gmail_scan_window_days(),
            max_results: default_gmail_max_results(),
            auto_refresh_ttl_seconds: default_gmail_auto_refresh_ttl_seconds(),
            unread_only: default_true(),
            query: String::new(),
            gws_path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InboxChannelConfig {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
    pub kind: String,
    pub drop_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub source_kinds: BTreeMap<String, String>,
    pub dedupe: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, YamlValue>,
}

impl InboxChannelConfig {
    fn local(channel: &str, kind: &str) -> Self {
        Self {
            provider: "local".to_string(),
            skill: None,
            kind: kind.to_string(),
            drop_paths: vec![format!("drop/{channel}")],
            source_kinds: BTreeMap::new(),
            dedupe: "sha256".to_string(),
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InboxRuntimeConfig {
    pub root: String,
    #[serde(default)]
    pub schema_version: Option<u32>,
    #[serde(default)]
    pub paths: InboxPathConfig,
    #[serde(default)]
    pub naming: InboxNamingConfig,
    #[serde(default)]
    pub file_drop: InboxFileDropConfig,
    #[serde(default)]
    pub gmail: InboxGmailConfig,
    #[serde(default)]
    pub dedupe: BTreeMap<String, YamlValue>,
    #[serde(default)]
    pub channels: BTreeMap<String, InboxChannelConfig>,
    #[serde(default)]
    pub processing: BTreeMap<String, YamlValue>,
    #[serde(default)]
    pub hooks: BTreeMap<String, YamlValue>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, YamlValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxRuntimeConfigUpdated {
    pub work_path: String,
    pub config: InboxRuntimeConfig,
}

impl Default for InboxRuntimeConfig {
    fn default() -> Self {
        let mut channels = BTreeMap::new();
        for key in [
            "incoming", "arc", "atlas", "chrome", "flow", "safari", "others",
        ] {
            channels.insert(key.to_string(), InboxChannelConfig::local(key, "file"));
        }
        channels.insert(
            "transcripts".to_string(),
            InboxChannelConfig::local("transcripts", "transcript"),
        );
        channels.insert(
            "mso".to_string(),
            InboxChannelConfig {
                provider: "mso".to_string(),
                skill: Some("io-mso".to_string()),
                kind: "bundle".to_string(),
                drop_paths: vec!["drop/mso".to_string()],
                source_kinds: BTreeMap::from([
                    ("mail".to_string(), "message".to_string()),
                    ("sharepoint".to_string(), "document".to_string()),
                    ("onedrive".to_string(), "document".to_string()),
                ]),
                dedupe: "provider-native".to_string(),
                extra: BTreeMap::new(),
            },
        );
        channels.insert(
            "gws".to_string(),
            InboxChannelConfig {
                provider: "gws".to_string(),
                skill: Some("io-gws".to_string()),
                kind: "bundle".to_string(),
                drop_paths: vec!["drop/gws".to_string()],
                source_kinds: BTreeMap::from([
                    ("mail".to_string(), "message".to_string()),
                    ("drive".to_string(), "document".to_string()),
                    ("gdrive".to_string(), "document".to_string()),
                ]),
                dedupe: "provider-native".to_string(),
                extra: BTreeMap::new(),
            },
        );
        channels.insert(
            "telegram".to_string(),
            InboxChannelConfig {
                provider: "telegram".to_string(),
                skill: Some("io-telegram".to_string()),
                kind: "bundle".to_string(),
                drop_paths: vec!["drop/telegram".to_string()],
                source_kinds: BTreeMap::from([
                    ("messages".to_string(), "message".to_string()),
                    ("files".to_string(), "attachment".to_string()),
                ]),
                dedupe: "provider-native".to_string(),
                extra: BTreeMap::new(),
            },
        );
        channels.insert(
            "kakao".to_string(),
            InboxChannelConfig {
                provider: "kakao".to_string(),
                skill: Some("io-kakao".to_string()),
                kind: "bundle".to_string(),
                drop_paths: vec!["drop/kakao".to_string()],
                source_kinds: BTreeMap::from([
                    ("messages".to_string(), "message".to_string()),
                    ("files".to_string(), "attachment".to_string()),
                    ("exports".to_string(), "data".to_string()),
                ]),
                dedupe: "sha256".to_string(),
                extra: BTreeMap::new(),
            },
        );
        Self {
            root: "inbox".to_string(),
            schema_version: Some(1),
            paths: InboxPathConfig::default(),
            naming: InboxNamingConfig::default(),
            file_drop: InboxFileDropConfig::default(),
            gmail: InboxGmailConfig::default(),
            dedupe: BTreeMap::from([(
                "default".to_string(),
                YamlValue::String("sha256".to_string()),
            )]),
            channels,
            processing: BTreeMap::from([
                (
                    "require_confirm_before_route".to_string(),
                    YamlValue::Bool(true),
                ),
                (
                    "summary_schema".to_string(),
                    YamlValue::String("inbox-summary/v1".to_string()),
                ),
            ]),
            hooks: BTreeMap::new(),
            extra: BTreeMap::new(),
        }
    }
}

impl Default for InboxSettings {
    fn default() -> Self {
        Self {
            inbox_root: DEFAULT_INBOX_ROOT.to_string(),
            sources: default_sources(),
            gws_path: None,
        }
    }
}

fn settings_path(vault: &Path) -> PathBuf {
    vault.join(".anchor").join("inbox.json")
}

fn ensure_anchor_dir(vault: &Path) -> Result<(), String> {
    let dir = vault.join(".anchor");
    fs::create_dir_all(&dir).map_err(|err| format!("Cannot create .anchor directory: {err}"))
}

pub fn load(vault: &Path) -> InboxSettings {
    let path = settings_path(vault);
    let Ok(content) = fs::read_to_string(&path) else {
        return InboxSettings::default();
    };
    serde_json::from_str::<InboxSettings>(&content).unwrap_or_default()
}

pub fn expand_tilde(input: &str) -> PathBuf {
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if input == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(input)
}

pub fn lexical_normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn resolve_runtime_root(work: &Path, config: &InboxRuntimeConfig) -> Result<PathBuf, String> {
    let raw = config.root.trim();
    if raw.is_empty() {
        return Err("inbox_root_required".to_string());
    }
    let candidate = expand_tilde(raw);
    let root = if candidate.is_absolute() {
        candidate
    } else {
        work.join(candidate)
    };
    let normalized = lexical_normalize_path(&root);
    let normalized_work = lexical_normalize_path(work);
    if !normalized.starts_with(&normalized_work) {
        return Err("inbox_root_outside_workspace".to_string());
    }
    Ok(normalized)
}

pub fn validate_inbox_runtime_config(
    work: &Path,
    config: &InboxRuntimeConfig,
) -> Result<(), String> {
    let root = resolve_runtime_root(work, config)?;
    let path_values = [
        config.paths.drop.as_str(),
        config.paths.items.as_str(),
        config.paths.pending.as_str(),
        config.paths.done.as_str(),
        config.paths.failed.as_str(),
        config.paths.duplicate.as_str(),
        config.paths.state.as_str(),
        config.paths.receipts.as_str(),
        config.naming.raw_dir.as_str(),
        config.naming.manifest_file.as_str(),
        config.naming.extracted_file.as_str(),
        config.naming.summary_file.as_str(),
        config.naming.route_file.as_str(),
        config.file_drop.drop_path.as_str(),
    ];
    for value in path_values {
        validate_relative_fragment(value)?;
    }
    validate_channel_key(&config.file_drop.channel)?;
    if config.file_drop.operation.trim().is_empty() {
        return Err("file_drop_operation_required".to_string());
    }
    if config.gmail.max_results == 0 || config.gmail.max_results > 200 {
        return Err("gmail_max_results_out_of_range".to_string());
    }
    if config.gmail.scan_window_days > 3650 {
        return Err("gmail_scan_window_out_of_range".to_string());
    }
    if config.gmail.auto_refresh_ttl_seconds > 86_400 {
        return Err("gmail_auto_refresh_ttl_out_of_range".to_string());
    }
    for (key, channel) in &config.channels {
        validate_channel_key(key)?;
        for drop_path in &channel.drop_paths {
            validate_relative_fragment(drop_path)?;
            let resolved = lexical_normalize_path(&root.join(drop_path));
            if !resolved.starts_with(&root) {
                return Err(format!("drop_path_outside_inbox: {drop_path}"));
            }
        }
    }
    Ok(())
}

fn validate_channel_key(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(format!("invalid_channel_key: {value}"));
    }
    Ok(())
}

fn validate_relative_fragment(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("inbox_path_required".to_string());
    }
    let path = Path::new(trimmed);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!("inbox_path_outside_root: {trimmed}"));
    }
    Ok(())
}

pub fn workspace_config_path(work: &Path) -> PathBuf {
    work.join(WORKSPACE_CONFIG_FILE)
}

pub fn load_runtime_config(work: &Path) -> Result<Option<InboxRuntimeConfig>, String> {
    let path = workspace_config_path(work);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read workspace.config.yaml: {err}"))?;
    let yaml: YamlValue = serde_yaml::from_str(&raw)
        .map_err(|err| format!("Cannot parse workspace.config.yaml: {err}"))?;
    let Some(mapping) = yaml.as_mapping() else {
        return Ok(None);
    };
    let Some(inbox_value) = mapping.get(YamlValue::String("inbox".to_string())) else {
        return Ok(None);
    };
    let mut config: InboxRuntimeConfig = serde_yaml::from_value(inbox_value.clone())
        .map_err(|err| format!("Cannot parse inbox config: {err}"))?;
    merge_runtime_defaults(&mut config);
    validate_inbox_runtime_config(work, &config)?;
    Ok(Some(config))
}

pub fn load_runtime_config_or_legacy(work: &Path) -> Result<InboxRuntimeConfig, String> {
    if let Some(config) = load_runtime_config(work)? {
        return Ok(config);
    }
    let legacy = load(work);
    let mut config = InboxRuntimeConfig::default();
    config.root = ".".to_string();
    config.gmail.gws_path = legacy.gws_path.clone();
    config.channels.clear();
    let sources = if legacy.sources.is_empty() {
        default_sources()
    } else {
        legacy.sources
    };
    for source in sources {
        config.channels.insert(
            source.clone(),
            InboxChannelConfig {
                provider: "local".to_string(),
                skill: None,
                kind: "file".to_string(),
                drop_paths: vec![format!(
                    "{}/{}",
                    legacy.inbox_root.trim_end_matches('/'),
                    source
                )],
                source_kinds: BTreeMap::new(),
                dedupe: "sha256".to_string(),
                extra: BTreeMap::new(),
            },
        );
    }
    Ok(config)
}

fn merge_runtime_defaults(config: &mut InboxRuntimeConfig) {
    let defaults = InboxRuntimeConfig::default();
    if config.root.trim().is_empty() {
        config.root = defaults.root;
    }
    if config.channels.is_empty() {
        config.channels = defaults.channels;
    }
    if config.naming.item_id_template.trim().is_empty() {
        config.naming.item_id_template = defaults.naming.item_id_template;
    }
    if config.naming.raw_dir.trim().is_empty() {
        config.naming.raw_dir = defaults.naming.raw_dir;
    }
    if config.naming.manifest_file.trim().is_empty() {
        config.naming.manifest_file = defaults.naming.manifest_file;
    }
    if config.naming.extracted_file.trim().is_empty() {
        config.naming.extracted_file = defaults.naming.extracted_file;
    }
    if config.naming.summary_file.trim().is_empty() {
        config.naming.summary_file = defaults.naming.summary_file;
    }
    if config.naming.route_file.trim().is_empty() {
        config.naming.route_file = defaults.naming.route_file;
    }
    if config.file_drop.channel.trim().is_empty() {
        config.file_drop.channel = defaults.file_drop.channel;
    }
    if config.file_drop.drop_path.trim().is_empty() {
        config.file_drop.drop_path = defaults.file_drop.drop_path;
    }
    if config.file_drop.operation.trim().is_empty() {
        config.file_drop.operation = defaults.file_drop.operation;
    }
    if config.gmail.max_results == 0 {
        config.gmail.max_results = defaults.gmail.max_results;
    }
}

#[tauri::command]
pub fn read_inbox_runtime_config(work_path: String) -> Result<InboxRuntimeConfig, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    load_runtime_config_or_legacy(&work)
}

#[tauri::command]
pub fn save_inbox_runtime_config(
    app: AppHandle,
    work_path: String,
    config: InboxRuntimeConfig,
) -> Result<InboxRuntimeConfig, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    let saved = save_runtime_config(&work, config)?;
    let _ = app.emit(
        "inbox://runtime_config_updated",
        InboxRuntimeConfigUpdated {
            work_path: work.to_string_lossy().to_string(),
            config: saved.clone(),
        },
    );
    Ok(saved)
}

fn save_runtime_config(
    work: &Path,
    config: InboxRuntimeConfig,
) -> Result<InboxRuntimeConfig, String> {
    validate_inbox_runtime_config(&work, &config)?;
    let path = workspace_config_path(&work);
    if !path.exists() {
        return Err("workspace_config_missing".to_string());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read workspace.config.yaml: {err}"))?;
    let block = inbox_config_yaml_block(&config)?;
    let next = replace_top_level_yaml_block(&raw, "inbox", &block);
    fs::write(&path, next).map_err(|err| format!("Cannot write workspace.config.yaml: {err}"))?;
    Ok(config)
}

fn inbox_config_yaml_block(config: &InboxRuntimeConfig) -> Result<String, String> {
    let yaml = serde_yaml::to_string(config)
        .map_err(|err| format!("Cannot serialize inbox config: {err}"))?;
    let mut out = String::from("inbox:\n");
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

#[tauri::command]
pub fn read_inbox_settings(vault_path: String) -> Result<InboxSettings, String> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    Ok(load(&vault))
}

#[tauri::command]
pub fn save_inbox_settings(
    vault_path: String,
    settings: InboxSettings,
) -> Result<InboxSettings, String> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    ensure_anchor_dir(&vault)?;
    let serialized = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("Cannot serialize inbox settings: {err}"))?;
    fs::write(settings_path(&vault), format!("{serialized}\n"))
        .map_err(|err| format!("Cannot write inbox settings: {err}"))?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn load_returns_defaults_when_missing() {
        let tmp = TempDir::new().unwrap();
        let settings = load(tmp.path());
        assert_eq!(settings, InboxSettings::default());
        assert_eq!(settings.inbox_root, "inbox/downloads");
        assert!(settings.sources.contains(&"outlook".to_string()));
    }

    #[test]
    fn save_then_load_round_trips() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        let next = InboxSettings {
            inbox_root: "incoming/spool".to_string(),
            sources: vec!["alpha".to_string(), "beta".to_string()],
            gws_path: Some("/opt/homebrew/bin/gws".to_string()),
        };
        let saved = save_inbox_settings(path.clone(), next.clone()).unwrap();
        assert_eq!(saved, next);
        let reloaded = read_inbox_settings(path).unwrap();
        assert_eq!(reloaded, next);
    }

    #[test]
    fn save_creates_anchor_directory() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        save_inbox_settings(path, InboxSettings::default()).unwrap();
        assert!(tmp.path().join(".anchor/inbox.json").exists());
    }

    #[test]
    fn load_runtime_config_reads_workspace_inbox_block() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join(WORKSPACE_CONFIG_FILE),
            r#"
profile: local
inbox:
  root: inbox
  paths:
    drop: drop
    items: items
    pending: items/pending
    done: items/done
    failed: items/failed
    duplicate: items/duplicate
    state: _state
    receipts: _state/index.jsonl
  naming:
    item_id_template: "{date}-{channel}-{slug}"
    raw_dir: raw
    manifest_file: manifest.yaml
    extracted_file: extracted.md
    summary_file: custom-summary.md
    route_file: route.md
  gmail:
    enabled: true
    scan_window_days: 30
    max_results: 50
    auto_refresh_ttl_seconds: 120
    unread_only: true
    query: ""
    gws_path: /opt/homebrew/bin/gws
  channels:
    kakao:
      provider: kakao
      skill: io-kakao
      kind: bundle
      dedupe: sha256
      drop_paths:
        - drop/kakao
"#,
        )
        .unwrap();

        let config = load_runtime_config(tmp.path()).unwrap().unwrap();

        assert_eq!(config.root, "inbox");
        assert_eq!(config.naming.summary_file, "custom-summary.md");
        assert_eq!(config.gmail.scan_window_days, 30);
        assert_eq!(config.gmail.max_results, 50);
        assert_eq!(config.gmail.auto_refresh_ttl_seconds, 120);
        assert_eq!(
            config.gmail.gws_path.as_deref(),
            Some("/opt/homebrew/bin/gws")
        );
        assert_eq!(
            config
                .channels
                .get("kakao")
                .unwrap()
                .drop_paths
                .first()
                .unwrap(),
            "drop/kakao"
        );
    }

    #[test]
    fn save_runtime_config_replaces_only_inbox_top_level_block() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join(WORKSPACE_CONFIG_FILE),
            r#"# workspace comment
profile: local
inbox:
  root: inbox
  channels: {}
projects:
  root: ~/workspace/work
"#,
        )
        .unwrap();
        let mut config = InboxRuntimeConfig::default();
        config.naming.summary_file = "digest.md".to_string();

        save_runtime_config(tmp.path(), config).unwrap();
        let saved = fs::read_to_string(tmp.path().join(WORKSPACE_CONFIG_FILE)).unwrap();

        assert!(saved.contains("# workspace comment"));
        assert!(saved.contains("profile: local"));
        assert!(saved.contains("projects:\n  root: ~/workspace/work"));
        assert!(saved.contains("summary_file: digest.md"));
    }

    #[test]
    fn validate_runtime_config_rejects_traversal_fragments() {
        let tmp = TempDir::new().unwrap();
        let mut config = InboxRuntimeConfig::default();
        config.naming.manifest_file = "../manifest.yaml".to_string();

        let err = validate_inbox_runtime_config(tmp.path(), &config).unwrap_err();

        assert!(err.contains("inbox_path_outside_root"));
    }

    #[test]
    fn validate_runtime_config_rejects_invalid_gmail_bounds() {
        let tmp = TempDir::new().unwrap();
        let mut config = InboxRuntimeConfig::default();
        config.gmail.max_results = 0;
        assert_eq!(
            validate_inbox_runtime_config(tmp.path(), &config).unwrap_err(),
            "gmail_max_results_out_of_range"
        );

        config.gmail.max_results = 20;
        config.gmail.scan_window_days = 3651;
        assert_eq!(
            validate_inbox_runtime_config(tmp.path(), &config).unwrap_err(),
            "gmail_scan_window_out_of_range"
        );

        config.gmail.scan_window_days = 14;
        config.gmail.auto_refresh_ttl_seconds = 86_401;
        assert_eq!(
            validate_inbox_runtime_config(tmp.path(), &config).unwrap_err(),
            "gmail_auto_refresh_ttl_out_of_range"
        );
    }

    #[test]
    fn validate_runtime_config_rejects_root_and_drop_escapes() {
        let tmp = TempDir::new().unwrap();
        let mut outside_root = InboxRuntimeConfig::default();
        outside_root.root = "../inbox".to_string();
        assert_eq!(
            validate_inbox_runtime_config(tmp.path(), &outside_root).unwrap_err(),
            "inbox_root_outside_workspace"
        );

        let mut outside_drop = InboxRuntimeConfig::default();
        outside_drop.channels.get_mut("kakao").unwrap().drop_paths =
            vec!["../drop/kakao".to_string()];
        let err = validate_inbox_runtime_config(tmp.path(), &outside_drop).unwrap_err();
        assert!(err.contains("inbox_path_outside_root"));
    }

    #[test]
    fn validate_runtime_config_rejects_invalid_channel_key() {
        let tmp = TempDir::new().unwrap();
        let mut config = InboxRuntimeConfig::default();
        let channel = config.channels.remove("kakao").unwrap();
        config.channels.insert("KaKao".to_string(), channel);

        let err = validate_inbox_runtime_config(tmp.path(), &config).unwrap_err();

        assert!(err.contains("invalid_channel_key"));
    }

    #[test]
    fn runtime_config_falls_back_to_legacy_anchor_inbox_json() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".anchor")).unwrap();
        fs::write(
            tmp.path().join(".anchor/inbox.json"),
            r#"{"inboxRoot":"incoming/spool","sources":["alpha"]}"#,
        )
        .unwrap();

        let config = load_runtime_config_or_legacy(tmp.path()).unwrap();

        assert_eq!(config.root, ".");
        assert_eq!(config.gmail.gws_path, None);
        assert_eq!(
            config.channels.get("alpha").unwrap().drop_paths,
            vec!["incoming/spool/alpha".to_string()]
        );
    }
}
