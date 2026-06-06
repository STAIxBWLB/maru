use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use tauri::{AppHandle, Emitter};

use crate::inbox_settings::{expand_tilde, lexical_normalize_path};
use crate::vault::resolve_inside_vault;

pub const SECRET_UNCHANGED: &str = "__ANCHOR_KEEP_SECRET__";
const MIN_INTERVAL_SECONDS: u64 = 30;

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct TelegramMonitorConfig {
    #[serde(default)]
    pub telegram: TelegramAuthConfig,
    #[serde(default)]
    pub polling: TelegramPollingConfig,
    #[serde(default)]
    pub chats: Vec<TelegramChatConfig>,
    #[serde(default)]
    pub notification: TelegramNotificationConfig,
    #[serde(flatten)]
    pub extra: BTreeMap<String, YamlValue>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct TelegramAuthConfig {
    #[serde(default)]
    pub api_id: Option<String>,
    #[serde(default)]
    pub api_hash: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub self_id: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, YamlValue>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct TelegramPollingConfig {
    #[serde(default)]
    pub interval_seconds: Option<u64>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, YamlValue>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TelegramChatConfig {
    pub chat_id: i64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub contexts: Vec<String>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, YamlValue>,
}

impl Default for TelegramChatConfig {
    fn default() -> Self {
        Self {
            chat_id: 0,
            name: None,
            enabled: true,
            priority: None,
            tags: Vec::new(),
            contexts: Vec::new(),
            profile: None,
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct TelegramNotificationConfig {
    #[serde(default)]
    pub telegram: TelegramNotificationTelegramConfig,
    #[serde(flatten)]
    pub extra: BTreeMap<String, YamlValue>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct TelegramNotificationTelegramConfig {
    #[serde(default)]
    pub bot_token: Option<String>,
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, YamlValue>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramMonitorConfigView {
    pub path: String,
    pub exists: bool,
    pub warnings: Vec<String>,
    pub telegram: TelegramAuthConfigView,
    pub polling: TelegramPollingConfig,
    pub chats: Vec<TelegramChatConfig>,
    pub notification: TelegramNotificationConfigView,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramAuthConfigView {
    pub api_id: Option<String>,
    pub api_hash: Option<String>,
    pub has_api_hash: bool,
    pub phone: Option<String>,
    pub self_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramNotificationConfigView {
    pub telegram: TelegramNotificationTelegramConfigView,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramNotificationTelegramConfigView {
    pub bot_token: Option<String>,
    pub has_bot_token: bool,
    pub chat_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramMonitorConfigSave {
    #[serde(default)]
    pub telegram: TelegramAuthConfigSave,
    #[serde(default)]
    pub polling: TelegramPollingConfig,
    #[serde(default)]
    pub chats: Vec<TelegramChatConfig>,
    #[serde(default)]
    pub notification: TelegramNotificationConfigSave,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramAuthConfigSave {
    #[serde(default)]
    pub api_id: Option<String>,
    #[serde(default)]
    pub api_hash: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub self_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramNotificationConfigSave {
    #[serde(default)]
    pub telegram: TelegramNotificationTelegramConfigSave,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramNotificationTelegramConfigSave {
    #[serde(default)]
    pub bot_token: Option<String>,
    #[serde(default)]
    pub chat_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramMonitorConfigUpdated {
    pub path: String,
}

fn default_true() -> bool {
    true
}

#[tauri::command]
pub fn read_telegram_monitor_config(
    work_path: Option<String>,
    monitor_config_path: Option<String>,
) -> Result<TelegramMonitorConfigView, String> {
    let (work, path) =
        resolve_monitor_config_path(work_path.as_deref(), monitor_config_path.as_deref())?;
    let (config, exists) = read_config_or_default(&path)?;
    Ok(redacted_view(&work, &path, config, exists))
}

#[tauri::command]
pub fn save_telegram_monitor_config(
    app: AppHandle,
    work_path: Option<String>,
    monitor_config_path: Option<String>,
    config: TelegramMonitorConfigSave,
) -> Result<TelegramMonitorConfigView, String> {
    let (work, path) =
        resolve_monitor_config_path(work_path.as_deref(), monitor_config_path.as_deref())?;
    ensure_secret_config_path(&path)?;
    let (mut current, _) = read_config_or_default(&path)?;
    apply_save(&mut current, config);
    validate_config(&work, &current)?;
    write_config_blocks(
        &path,
        &current,
        &["telegram", "polling", "chats", "notification"],
    )?;
    set_secret_file_mode(&path)?;
    let (saved, exists) = read_config_or_default(&path)?;
    let _ = app.emit(
        "telegram://monitor_config_updated",
        TelegramMonitorConfigUpdated {
            path: path.to_string_lossy().to_string(),
        },
    );
    Ok(redacted_view(&work, &path, saved, exists))
}

fn resolve_monitor_config_path(
    work_path: Option<&str>,
    monitor_config_path: Option<&str>,
) -> Result<(Option<PathBuf>, PathBuf), String> {
    let work = work_path
        .map(|raw| resolve_inside_vault(raw, "."))
        .transpose()?;
    if let Some(path) = monitor_config_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(expand_tilde)
    {
        return Ok((work, lexical_normalize_path(&path)));
    }
    if let Some(work) = &work {
        if let Some(path) = workspace_provider_monitor_config(work) {
            return Ok((
                Some(work.clone()),
                lexical_normalize_path(&expand_tilde(&path)),
            ));
        }
        return Ok((
            Some(work.clone()),
            work.join(".secrets")
                .join("services")
                .join("telegram-monitor.config.yaml"),
        ));
    }
    Err("work_path_required".to_string())
}

fn workspace_provider_monitor_config(work_path: &Path) -> Option<String> {
    let content = fs::read_to_string(work_path.join("workspace.config.yaml")).ok()?;
    let yaml: YamlValue = serde_yaml::from_str(&content).ok()?;
    let provider = yaml.get("io")?.get("providers")?.get("telegram")?;
    for key_path in [
        &["monitor_config"][..],
        &["monitorConfig"][..],
        &["monitor_config_path"][..],
        &["monitorConfigPath"][..],
        &["secrets", "monitor_config"][..],
        &["secrets", "monitorConfig"][..],
    ] {
        let mut value = Some(provider);
        for key in key_path {
            value = value.and_then(|current| current.get(*key));
        }
        if let Some(path) = value
            .and_then(YamlValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(path.to_string());
        }
    }
    None
}

fn read_config_or_default(path: &Path) -> Result<(TelegramMonitorConfig, bool), String> {
    if !path.exists() {
        return Ok((TelegramMonitorConfig::default(), false));
    }
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("Cannot read Telegram monitor config: {err}"))?;
    let config = serde_yaml::from_str(&raw)
        .map_err(|err| format!("Cannot parse Telegram monitor config: {err}"))?;
    Ok((config, true))
}

fn redacted_view(
    work: &Option<PathBuf>,
    path: &Path,
    config: TelegramMonitorConfig,
    exists: bool,
) -> TelegramMonitorConfigView {
    let project_ids = work
        .as_deref()
        .map(project_ids_for_work)
        .unwrap_or_default();
    let mut warnings = Vec::new();
    if !exists {
        warnings.push("monitor_config_missing".to_string());
    }
    for chat in &config.chats {
        for context in &chat.contexts {
            if !project_ids.is_empty() && !project_ids.contains(context) {
                warnings.push(format!("unknown_project_context:{context}"));
            }
        }
    }
    TelegramMonitorConfigView {
        path: path.to_string_lossy().to_string(),
        exists,
        warnings,
        telegram: TelegramAuthConfigView {
            api_id: config.telegram.api_id.clone(),
            api_hash: config.telegram.api_hash.as_deref().map(mask_secret),
            has_api_hash: config.telegram.api_hash.is_some(),
            phone: config.telegram.phone.clone(),
            self_id: config.telegram.self_id.clone(),
        },
        polling: config.polling.clone(),
        chats: config.chats.clone(),
        notification: TelegramNotificationConfigView {
            telegram: TelegramNotificationTelegramConfigView {
                bot_token: config
                    .notification
                    .telegram
                    .bot_token
                    .as_deref()
                    .map(mask_secret),
                has_bot_token: config.notification.telegram.bot_token.is_some(),
                chat_id: config.notification.telegram.chat_id.clone(),
            },
        },
    }
}

fn apply_save(current: &mut TelegramMonitorConfig, save: TelegramMonitorConfigSave) {
    current.telegram.api_id = normalize_optional(save.telegram.api_id);
    current.telegram.phone = normalize_optional(save.telegram.phone);
    current.telegram.self_id = normalize_optional(save.telegram.self_id);
    if let Some(api_hash) = save.telegram.api_hash {
        if api_hash != SECRET_UNCHANGED {
            current.telegram.api_hash = normalize_optional(Some(api_hash));
        }
    }
    current.polling = save.polling;
    current.chats = save.chats;
    current.notification.telegram.chat_id = normalize_optional(save.notification.telegram.chat_id);
    if let Some(bot_token) = save.notification.telegram.bot_token {
        if bot_token != SECRET_UNCHANGED {
            current.notification.telegram.bot_token = normalize_optional(Some(bot_token));
        }
    }
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn validate_config(work: &Option<PathBuf>, config: &TelegramMonitorConfig) -> Result<(), String> {
    if let Some(interval) = config.polling.interval_seconds {
        if interval < MIN_INTERVAL_SECONDS {
            return Err("interval_seconds_too_low".to_string());
        }
    }
    for chat in &config.chats {
        validate_chat(chat)?;
    }
    let project_ids = work
        .as_deref()
        .map(project_ids_for_work)
        .unwrap_or_default();
    let _unknown_contexts = config
        .chats
        .iter()
        .flat_map(|chat| chat.contexts.iter())
        .filter(|context| !project_ids.is_empty() && !project_ids.contains(*context))
        .collect::<Vec<_>>();
    Ok(())
}

fn validate_chat(chat: &TelegramChatConfig) -> Result<(), String> {
    if chat.chat_id == 0 {
        return Err("chat_id_required".to_string());
    }
    let _ = normalize_contexts(chat.contexts.clone())?;
    Ok(())
}

fn normalize_contexts(contexts: Vec<String>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for context in contexts {
        let trimmed = context.trim();
        if trimmed.is_empty() {
            return Err("empty_project_context".to_string());
        }
        if !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    }
    Ok(out)
}

fn ensure_secret_config_path(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "monitor_config_parent_missing".to_string())?;
    if !parent.is_dir() {
        return Err("monitor_config_parent_missing".to_string());
    }
    if !path
        .components()
        .any(|component| component.as_os_str().to_string_lossy() == ".secrets")
    {
        return Err("monitor_config_not_under_secrets".to_string());
    }
    Ok(())
}

fn write_config_blocks(
    path: &Path,
    config: &TelegramMonitorConfig,
    keys: &[&str],
) -> Result<(), String> {
    let raw = if path.exists() {
        fs::read_to_string(path)
            .map_err(|err| format!("Cannot read Telegram monitor config: {err}"))?
    } else {
        String::new()
    };
    let mut next = raw;
    for key in keys {
        let block = match *key {
            "telegram" => yaml_top_level_block("telegram", &config.telegram)?,
            "polling" => yaml_top_level_block("polling", &config.polling)?,
            "chats" => yaml_top_level_block("chats", &config.chats)?,
            "notification" => yaml_top_level_block("notification", &config.notification)?,
            other => return Err(format!("unknown_telegram_config_block: {other}")),
        };
        next = replace_top_level_yaml_block(&next, key, &block);
    }
    write_secret_file(path, &next)
        .map_err(|err| format!("Cannot write Telegram monitor config: {err}"))
}

/// Write a secret-bearing file, creating it 0600 from the start so the
/// contents are never group/world-readable — even briefly. (`fs::write`
/// creates with the process umask, typically 0644, and the later chmod in
/// `set_secret_file_mode` would leave a readable window.)
fn write_secret_file(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents.as_bytes())
}

fn yaml_top_level_block<T: Serialize>(key: &str, value: &T) -> Result<String, String> {
    let yaml = serde_yaml::to_string(value)
        .map_err(|err| format!("Cannot serialize Telegram monitor config: {err}"))?;
    let mut out = format!("{key}:\n");
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
        if !out.is_empty() {
            out.push_str("\n\n");
        }
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

fn mask_secret(secret: &str) -> String {
    let trimmed = secret.trim();
    let suffix = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    if suffix.is_empty() {
        "****".to_string()
    } else {
        format!("****{suffix}")
    }
}

fn set_secret_file_mode(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|err| {
            format!(
                "Cannot set permissions for Telegram monitor config {}: {err}",
                path.to_string_lossy()
            )
        })?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn project_ids_for_work(work: &Path) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    if let Ok(raw) = fs::read_to_string(work.join(".anchor/projects.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            collect_project_ids_json(&value, &mut ids);
        }
    }
    if ids.is_empty() {
        if let Ok(raw) = fs::read_to_string(work.join("project-registry.yaml")) {
            if let Ok(value) = serde_yaml::from_str::<YamlValue>(&raw) {
                collect_project_ids_yaml(&value, &mut ids);
            }
        }
    }
    ids
}

fn collect_project_ids_json(value: &serde_json::Value, ids: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(id) = map
                .get("id")
                .or_else(|| map.get("key"))
                .and_then(serde_json::Value::as_str)
            {
                ids.insert(id.to_string());
            }
            for value in map.values() {
                collect_project_ids_json(value, ids);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_project_ids_json(item, ids);
            }
        }
        _ => {}
    }
}

fn collect_project_ids_yaml(value: &YamlValue, ids: &mut BTreeSet<String>) {
    match value {
        YamlValue::Mapping(map) => {
            if let Some(id) = map
                .get(YamlValue::String("id".to_string()))
                .or_else(|| map.get(YamlValue::String("key".to_string())))
                .and_then(YamlValue::as_str)
            {
                ids.insert(id.to_string());
            }
            for value in map.values() {
                collect_project_ids_yaml(value, ids);
            }
        }
        YamlValue::Sequence(items) => {
            for item in items {
                collect_project_ids_yaml(item, ids);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(unix)]
    #[test]
    fn write_secret_file_creates_with_owner_only_mode() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("monitor.config.yaml");
        write_secret_file(&path, "telegram:\n  api_hash: secret\n").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "secret file must be created 0600, not chmod'd later");
        // Overwrites keep working and keep the restrictive mode.
        write_secret_file(&path, "telegram:\n  api_hash: rotated\n").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "telegram:\n  api_hash: rotated\n"
        );
    }

    #[test]
    fn redacted_view_masks_secrets() {
        let tmp = TempDir::new().unwrap();
        let path = tmp
            .path()
            .join(".secrets/services/telegram-monitor.config.yaml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"
telegram:
  api_id: "123"
  api_hash: "abcdef123456"
  phone: "+8210"
notification:
  telegram:
    bot_token: "token123456"
    chat_id: "999"
"#,
        )
        .unwrap();
        let view = read_telegram_monitor_config(
            Some(tmp.path().to_string_lossy().to_string()),
            Some(path.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(view.telegram.api_hash.as_deref(), Some("****3456"));
        assert!(view.telegram.has_api_hash);
        assert_eq!(
            view.notification.telegram.bot_token.as_deref(),
            Some("****3456")
        );
        assert!(view.notification.telegram.has_bot_token);
    }

    #[test]
    fn save_preserves_unrelated_comments_and_secret_sentinel() {
        let tmp = TempDir::new().unwrap();
        let path = tmp
            .path()
            .join(".secrets/services/telegram-monitor.config.yaml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"# header comment
telegram:
  api_id: "123"
  api_hash: "abcdef123456"
  phone: "+8210"

# keep this block
custom_block:
  value: 7

notification:
  telegram:
    bot_token: "token123456"
    chat_id: "999"
"#,
        )
        .unwrap();
        let save = TelegramMonitorConfigSave {
            telegram: TelegramAuthConfigSave {
                api_id: Some("456".to_string()),
                api_hash: Some(SECRET_UNCHANGED.to_string()),
                phone: Some("+8211".to_string()),
                self_id: None,
            },
            polling: TelegramPollingConfig {
                interval_seconds: Some(60),
                extra: BTreeMap::new(),
            },
            chats: vec![TelegramChatConfig {
                chat_id: -100,
                name: Some("Room".to_string()),
                enabled: true,
                priority: Some("high".to_string()),
                tags: vec!["ops".to_string()],
                contexts: vec!["rise-admin".to_string()],
                profile: Some("deep-digest".to_string()),
                extra: BTreeMap::new(),
            }],
            notification: TelegramNotificationConfigSave {
                telegram: TelegramNotificationTelegramConfigSave {
                    bot_token: Some(SECRET_UNCHANGED.to_string()),
                    chat_id: Some("111".to_string()),
                },
            },
        };
        let (work, resolved_path) = resolve_monitor_config_path(
            Some(&tmp.path().to_string_lossy()),
            Some(&path.to_string_lossy()),
        )
        .unwrap();
        ensure_secret_config_path(&resolved_path).unwrap();
        let (mut current, _) = read_config_or_default(&resolved_path).unwrap();
        apply_save(&mut current, save);
        validate_config(&work, &current).unwrap();
        write_config_blocks(
            &resolved_path,
            &current,
            &["telegram", "polling", "chats", "notification"],
        )
        .unwrap();
        set_secret_file_mode(&resolved_path).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("# header comment"));
        assert!(raw.contains("# keep this block"));
        assert!(raw.contains("custom_block:"));
        assert!(
            raw.contains("api_hash: abcdef123456") || raw.contains("api_hash: \"abcdef123456\"")
        );
        assert!(
            raw.contains("bot_token: token123456") || raw.contains("bot_token: \"token123456\"")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn set_contexts_edits_only_target_chat() {
        let tmp = TempDir::new().unwrap();
        let path = tmp
            .path()
            .join(".secrets/services/telegram-monitor.config.yaml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"
chats:
  - chat_id: 1
    name: A
    contexts: [old]
  - chat_id: 2
    name: B
    contexts: [keep]
"#,
        )
        .unwrap();
        let (work, resolved_path) = resolve_monitor_config_path(
            Some(&tmp.path().to_string_lossy()),
            Some(&path.to_string_lossy()),
        )
        .unwrap();
        ensure_secret_config_path(&resolved_path).unwrap();
        let (mut config, _) = read_config_or_default(&resolved_path).unwrap();
        let chat = config
            .chats
            .iter_mut()
            .find(|chat| chat.chat_id == 1)
            .unwrap();
        chat.contexts = normalize_contexts(vec!["new".to_string()]).unwrap();
        chat.enabled = false;
        validate_config(&work, &config).unwrap();
        write_config_blocks(&resolved_path, &config, &["chats"]).unwrap();
        let config = read_config_or_default(&path).unwrap().0;
        let first = config.chats.iter().find(|chat| chat.chat_id == 1).unwrap();
        let second = config.chats.iter().find(|chat| chat.chat_id == 2).unwrap();
        assert_eq!(first.contexts, vec!["new"]);
        assert!(!first.enabled);
        assert_eq!(second.contexts, vec!["keep"]);
    }

    #[test]
    fn validation_rejects_low_interval_and_zero_chat() {
        let mut config = TelegramMonitorConfig::default();
        config.polling.interval_seconds = Some(10);
        assert_eq!(
            validate_config(&None, &config).unwrap_err(),
            "interval_seconds_too_low"
        );
        config.polling.interval_seconds = Some(30);
        config.chats.push(TelegramChatConfig::default());
        assert_eq!(
            validate_config(&None, &config).unwrap_err(),
            "chat_id_required"
        );
    }
}
