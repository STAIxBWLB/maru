use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use tauri::{AppHandle, Emitter, State};

use crate::cli_path::{augmented_path, is_executable};
use crate::inbox_drop::{
    auth_status, stage_message_json, stage_message_outcome, ProviderAuthStatus, StageOutcome,
};
use crate::skill_host::{fs as host_fs, store};
use crate::vault::resolve_inside_vault;
use crate::win_process::NoWindow;

const TELEGRAM_ACCEPT_KIND: &str = "telegram.accept";
const TELEGRAM_REJECT_KIND: &str = "telegram.reject";
const TELEGRAM_STAGE_KIND: &str = "telegram.stage";
const INBOX_BULK_KIND: &str = "inbox.bulk";
const DEFAULT_POLL_INTERVAL_SECONDS: u64 = 60;
const MIN_POLL_INTERVAL_SECONDS: u64 = 30;

#[derive(Default)]
pub struct TelegramIoState {
    run_lock: Arc<Mutex<()>>,
    poller: Mutex<Option<TelegramPollerHandle>>,
    status: Arc<Mutex<TelegramPollingStatus>>,
}

struct TelegramPollerHandle {
    shutdown: mpsc::Sender<()>,
    join: Option<JoinHandle<()>>,
}

impl Drop for TelegramPollerHandle {
    fn drop(&mut self) {
        let _ = self.shutdown.send(());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramMessage {
    pub id: String,
    pub chat_id: String,
    pub chat_title: String,
    pub sender: String,
    pub text: String,
    pub date: String,
    pub permalink: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramFetchOptions {
    pub work_path: Option<String>,
    pub max: Option<u32>,
    pub python_path: Option<String>,
    pub script_path: Option<String>,
    pub session_file: Option<String>,
    pub monitor_config_path: Option<String>,
    pub legacy_auto_drop: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramDecisionOutcome {
    pub message_id: String,
    pub decision: String,
    pub target_path: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramPollingStatus {
    pub running: bool,
    pub interval_seconds: u64,
    pub last_started_at: Option<String>,
    pub last_fetched_at: Option<String>,
    pub last_message_count: usize,
    pub last_error: Option<String>,
}

impl Default for TelegramPollingStatus {
    fn default() -> Self {
        Self {
            running: false,
            interval_seconds: DEFAULT_POLL_INTERVAL_SECONDS,
            last_started_at: None,
            last_fetched_at: None,
            last_message_count: 0,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramMessagesEvent {
    pub work_path: Option<String>,
    pub messages: Vec<TelegramMessage>,
    pub status: TelegramPollingStatus,
}

#[derive(Debug, Deserialize)]
struct TelegramScriptOutput {
    #[serde(default)]
    messages: Vec<TelegramMessage>,
}

#[tauri::command]
pub fn fetch_telegram_recent(
    state: State<'_, TelegramIoState>,
    options: TelegramFetchOptions,
) -> Result<Vec<TelegramMessage>, String> {
    fetch_telegram_recent_inner(&state.run_lock, options)
}

#[tauri::command]
pub fn accept_telegram_item(
    approvals: State<'_, crate::approval::ApprovalState>,
    work_path: String,
    message: TelegramMessage,
    approval_id: Option<String>,
) -> Result<TelegramDecisionOutcome, String> {
    crate::approval::require_approval(&approvals, approval_id, TELEGRAM_ACCEPT_KIND)?;
    let target = write_telegram_message_to_inbox(&work_path, &message)?;
    Ok(TelegramDecisionOutcome {
        message_id: message.id,
        decision: "accepted".to_string(),
        target_path: Some(target),
        ok: true,
        error: None,
    })
}

#[tauri::command]
pub fn reject_telegram_item(
    approvals: State<'_, crate::approval::ApprovalState>,
    message_id: String,
    approval_id: Option<String>,
) -> Result<TelegramDecisionOutcome, String> {
    crate::approval::require_approval(&approvals, approval_id, TELEGRAM_REJECT_KIND)?;
    Ok(TelegramDecisionOutcome {
        message_id,
        decision: "rejected".to_string(),
        target_path: None,
        ok: true,
        error: None,
    })
}

#[tauri::command]
pub fn stage_telegram_items(
    approvals: State<'_, crate::approval::ApprovalState>,
    work_path: String,
    messages: Vec<TelegramMessage>,
    approval_id: Option<String>,
) -> Result<Vec<StageOutcome>, String> {
    crate::approval::require_approval_any(
        &approvals,
        approval_id,
        &[TELEGRAM_STAGE_KIND, INBOX_BULK_KIND],
    )?;
    let work = resolve_inside_vault(&work_path, ".")?;
    Ok(messages
        .into_iter()
        .map(|message| stage_message_outcome(&work, "telegram", "telegram", &message.id, &message))
        .collect())
}

#[tauri::command]
pub fn check_telegram_auth(options: TelegramFetchOptions) -> Result<ProviderAuthStatus, String> {
    let config = match resolve_telegram_command_config(&options) {
        Ok(config) => config,
        Err(err) => {
            let state = classify_telegram_setup_state(&err);
            return Ok(auth_status("telegram", state, Some(err), None, None));
        }
    };
    let mut cmd = Command::new(&config.python_path);
    cmd.env("PATH", augmented_path())
        .env(
            "ANCHOR_SKILLS_ENV",
            config.env_root.to_string_lossy().to_string(),
        )
        .arg(&config.script_path)
        .arg("--once")
        .arg("--session-file")
        .arg(&config.session_file)
        .arg("--limit")
        .arg("1")
        .arg("--output-json");
    if let Some(monitor_config_path) = &config.monitor_config_path {
        cmd.arg("--config-file").arg(monitor_config_path);
    }
    let output = cmd
        .current_dir(
            config
                .script_path
                .parent()
                .unwrap_or_else(|| Path::new(".")),
        )
        .no_window()
        .output()
        .map_err(|err| format!("telegram_spawn_failed: {err}"))?;
    if output.status.success() {
        return Ok(auth_status(
            "telegram",
            "ok",
            None,
            Some(config.python_path),
            None,
        ));
    }
    let detail = [output.stderr.as_slice(), output.stdout.as_slice()]
        .into_iter()
        .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(auth_status(
        "telegram",
        classify_telegram_auth_state(&detail),
        Some(detail),
        Some(config.python_path),
        None,
    ))
}

#[tauri::command]
pub fn start_telegram_polling(
    app: AppHandle,
    state: State<'_, TelegramIoState>,
    options: TelegramFetchOptions,
    interval_seconds: Option<u64>,
) -> Result<TelegramPollingStatus, String> {
    stop_telegram_polling_state(&state)?;
    let interval = interval_seconds
        .unwrap_or(DEFAULT_POLL_INTERVAL_SECONDS)
        .max(MIN_POLL_INTERVAL_SECONDS);
    let (tx, rx) = mpsc::channel();
    let run_lock = state.run_lock.clone();
    let status_store = Arc::new(Mutex::new(TelegramPollingStatus {
        running: true,
        interval_seconds: interval,
        last_started_at: Some(Utc::now().to_rfc3339()),
        last_fetched_at: None,
        last_message_count: 0,
        last_error: None,
    }));
    *state
        .status
        .lock()
        .map_err(|_| "telegram_status_poisoned".to_string())? = status_store
        .lock()
        .map_err(|_| "telegram_status_poisoned".to_string())?
        .clone();
    let app_clone = app.clone();
    let work_path = options.work_path.clone();
    let state_status = state.status.clone();
    let join = thread::spawn(move || loop {
        match fetch_telegram_recent_inner(&run_lock, options.clone()) {
            Ok(messages) => {
                let mut status = status_store.lock().unwrap_or_else(|err| err.into_inner());
                status.running = true;
                status.last_fetched_at = Some(Utc::now().to_rfc3339());
                status.last_message_count = messages.len();
                status.last_error = None;
                if let Ok(mut shared) = state_status.lock() {
                    *shared = status.clone();
                }
                let _ = app_clone.emit(
                    "telegram://messages",
                    TelegramMessagesEvent {
                        work_path: work_path.clone(),
                        messages,
                        status: status.clone(),
                    },
                );
            }
            Err(err) => {
                let mut status = status_store.lock().unwrap_or_else(|err| err.into_inner());
                status.running = true;
                status.last_error = Some(err);
                if let Ok(mut shared) = state_status.lock() {
                    *shared = status.clone();
                }
                let _ = app_clone.emit(
                    "telegram://messages",
                    TelegramMessagesEvent {
                        work_path: work_path.clone(),
                        messages: Vec::new(),
                        status: status.clone(),
                    },
                );
            }
        }
        match rx.recv_timeout(Duration::from_secs(interval)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    });
    *state
        .poller
        .lock()
        .map_err(|_| "telegram_poller_poisoned".to_string())? = Some(TelegramPollerHandle {
        shutdown: tx,
        join: Some(join),
    });
    telegram_polling_status(state)
}

#[tauri::command]
pub fn stop_telegram_polling(
    state: State<'_, TelegramIoState>,
) -> Result<TelegramPollingStatus, String> {
    stop_telegram_polling_state(&state)?;
    telegram_polling_status(state)
}

#[tauri::command]
pub fn telegram_polling_status(
    state: State<'_, TelegramIoState>,
) -> Result<TelegramPollingStatus, String> {
    Ok(state
        .status
        .lock()
        .map_err(|_| "telegram_status_poisoned".to_string())?
        .clone())
}

pub fn stop_poller_on_exit(state: &TelegramIoState) {
    let _ = stop_telegram_polling_state_ref(state);
}

fn stop_telegram_polling_state(state: &State<'_, TelegramIoState>) -> Result<(), String> {
    stop_telegram_polling_state_ref(state.inner())
}

fn stop_telegram_polling_state_ref(state: &TelegramIoState) -> Result<(), String> {
    if let Some(mut handle) = state
        .poller
        .lock()
        .map_err(|_| "telegram_poller_poisoned".to_string())?
        .take()
    {
        let _ = handle.shutdown.send(());
        if let Some(join) = handle.join.take() {
            let _ = join.join();
        }
    }
    let mut status = state
        .status
        .lock()
        .map_err(|_| "telegram_status_poisoned".to_string())?;
    status.running = false;
    Ok(())
}

fn fetch_telegram_recent_inner(
    run_lock: &Arc<Mutex<()>>,
    options: TelegramFetchOptions,
) -> Result<Vec<TelegramMessage>, String> {
    let _guard = run_lock
        .lock()
        .map_err(|_| "telegram_run_lock_poisoned".to_string())?;
    let config = resolve_telegram_command_config(&options)?;
    let mut cmd = Command::new(&config.python_path);
    cmd.env("PATH", augmented_path())
        .env(
            "ANCHOR_SKILLS_ENV",
            config.env_root.to_string_lossy().to_string(),
        )
        .arg(&config.script_path)
        .arg("--once")
        .arg("--session-file")
        .arg(&config.session_file)
        .arg("--limit")
        .arg(config.max.to_string());
    if let Some(monitor_config_path) = &config.monitor_config_path {
        cmd.arg("--config-file").arg(monitor_config_path);
    }
    if !config.legacy_auto_drop {
        cmd.arg("--output-json");
    }
    cmd.no_window();
    let output = cmd
        .current_dir(
            config
                .script_path
                .parent()
                .unwrap_or_else(|| Path::new(".")),
        )
        .output()
        .map_err(|err| format!("telegram_spawn_failed: {err}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let kind = if classify_telegram_auth_state(&detail) == "auth_required" {
            "auth_required"
        } else {
            "telegram_failed"
        };
        return Err(format!("{kind}: {detail}"));
    }
    if config.legacy_auto_drop {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_telegram_output(&stdout).map_err(|err| format!("telegram_parse_failed: {err}"))
}

#[derive(Debug)]
struct TelegramCommandConfig {
    python_path: PathBuf,
    script_path: PathBuf,
    session_file: PathBuf,
    monitor_config_path: Option<PathBuf>,
    env_root: PathBuf,
    max: u32,
    legacy_auto_drop: bool,
}

fn resolve_telegram_command_config(
    options: &TelegramFetchOptions,
) -> Result<TelegramCommandConfig, String> {
    let work = options
        .work_path
        .as_deref()
        .and_then(|raw| resolve_inside_vault(raw, ".").ok());
    let _ = store::default_public_env_setup(options.work_path.as_deref());
    let env_root = host_fs::env_root()?;
    let python_path = options
        .python_path
        .as_deref()
        .and_then(non_empty_path)
        .or_else(|| {
            work.as_deref()
                .and_then(|path| workspace_provider_string(path, "telegram", &["python_path"]))
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| env_root.join(".venv").join("bin").join("python"));
    if !is_executable(&python_path) {
        return Err(format!(
            "env_missing: Telegram requires {}. Bootstrap ~/.anchor/env first.",
            python_path.to_string_lossy()
        ));
    }
    let script_path = options
        .script_path
        .as_deref()
        .and_then(non_empty_path)
        .or_else(|| {
            work.as_deref()
                .and_then(|path| workspace_provider_string(path, "telegram", &["script_path"]))
                .map(PathBuf::from)
        })
        .unwrap_or_else(default_telegram_script_path);
    if !script_path.is_file() {
        return Err(format!(
            "script_missing: Telegram script not found at {}",
            script_path.to_string_lossy()
        ));
    }
    let session_file = options
        .session_file
        .as_deref()
        .and_then(non_empty_path)
        .or_else(|| {
            work.as_deref()
                .and_then(|path| workspace_provider_string(path, "telegram", &["session_file"]))
                .map(PathBuf::from)
        })
        .unwrap_or_else(default_telegram_session_path);
    if !session_file.is_absolute() {
        return Err("session_file_must_be_absolute".to_string());
    }
    let monitor_config_path = options
        .monitor_config_path
        .as_deref()
        .and_then(non_empty_path)
        .or_else(|| {
            work.as_deref()
                .and_then(|path| {
                    workspace_provider_nested_string(
                        path,
                        "telegram",
                        &[
                            &["monitor_config"][..],
                            &["monitorConfig"][..],
                            &["monitor_config_path"][..],
                            &["monitorConfigPath"][..],
                            &["secrets", "monitor_config"][..],
                            &["secrets", "monitorConfig"][..],
                        ],
                    )
                })
                .map(PathBuf::from)
        });
    if let Some(path) = &monitor_config_path {
        if !path.is_file() {
            return Err(format!(
                "config_missing: Telegram monitor config not found at {}",
                path.to_string_lossy()
            ));
        }
    }
    Ok(TelegramCommandConfig {
        python_path,
        script_path,
        session_file,
        monitor_config_path,
        env_root,
        max: options.max.unwrap_or(50).clamp(1, 200),
        legacy_auto_drop: options.legacy_auto_drop.unwrap_or(false),
    })
}

fn write_telegram_message_to_inbox(
    work_path: &str,
    message: &TelegramMessage,
) -> Result<String, String> {
    let work = resolve_inside_vault(work_path, ".")?;
    stage_message_json(&work, "telegram", "telegram", &message.id, message)
}

pub fn classify_telegram_auth_state(detail: &str) -> &'static str {
    let lower = detail.to_lowercase();
    if lower.contains("session")
        || lower.contains("auth")
        || lower.contains("api_id")
        || lower.contains("api hash")
        || lower.contains("api_hash")
        || lower.contains("phone")
        || lower.contains("login")
        || lower.contains("unauthorized")
    {
        "auth_required"
    } else {
        "error"
    }
}

fn classify_telegram_setup_state(detail: &str) -> &'static str {
    if detail.starts_with("env_missing") {
        "env_missing"
    } else if detail.starts_with("script_missing") || detail.starts_with("config_missing") {
        "error"
    } else if classify_telegram_auth_state(detail) == "auth_required" {
        "auth_required"
    } else {
        "error"
    }
}

fn parse_telegram_output(raw: &str) -> Result<Vec<TelegramMessage>, String> {
    let json = extract_json_fragment(raw).ok_or_else(|| "no_json_payload".to_string())?;
    let output: TelegramScriptOutput = serde_json::from_str(json).map_err(|err| err.to_string())?;
    Ok(output.messages)
}

fn default_telegram_script_path() -> PathBuf {
    host_fs::skills_root()
        .unwrap_or_else(|_| PathBuf::from(".anchor/skills"))
        .join("_builtin")
        .join("skills")
        .join("io-telegram")
        .join("scripts")
        .join("telegram_monitor.py")
}

fn default_telegram_session_path() -> PathBuf {
    host_fs::anchor_home()
        .unwrap_or_else(|_| PathBuf::from(".anchor"))
        .join("telegram")
        .join("monitor.session")
}

fn non_empty_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| host_fs::expand_tilde(trimmed))
}

fn workspace_provider_string(work_path: &Path, provider: &str, keys: &[&str]) -> Option<String> {
    let content = fs::read_to_string(work_path.join("workspace.config.yaml")).ok()?;
    let yaml: YamlValue = serde_yaml::from_str(&content).ok()?;
    let provider = yaml.get("io")?.get("providers")?.get(provider)?;
    for key in keys {
        if let Some(value) = provider
            .get(key)
            .and_then(YamlValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
        {
            return Some(value);
        }
    }
    None
}

fn workspace_provider_nested_string(
    work_path: &Path,
    provider: &str,
    key_paths: &[&[&str]],
) -> Option<String> {
    let content = fs::read_to_string(work_path.join("workspace.config.yaml")).ok()?;
    let yaml: YamlValue = serde_yaml::from_str(&content).ok()?;
    let provider = yaml.get("io")?.get("providers")?.get(provider)?;
    for key_path in key_paths {
        let mut value = Some(provider);
        for key in *key_path {
            value = value.and_then(|current| current.get(*key));
        }
        if let Some(string) = value
            .and_then(YamlValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(host_fs::expand_tilde)
            .map(|path| path.to_string_lossy().to_string())
        {
            return Some(string);
        }
    }
    None
}

fn extract_json_fragment(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    for (start, byte) in bytes.iter().enumerate() {
        if *byte != b'{' {
            continue;
        }
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;
        for (offset, current) in bytes[start..].iter().enumerate() {
            if in_string {
                if escaped {
                    escaped = false;
                } else if *current == b'\\' {
                    escaped = true;
                } else if *current == b'"' {
                    in_string = false;
                }
                continue;
            }
            if *current == b'"' {
                in_string = true;
            } else if *current == b'{' {
                depth += 1;
            } else if *current == b'}' {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return raw.get(start..=start + offset);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbox_drop::sanitize_filename;

    // Isolates the process-global `ANCHOR_TEST_HOME` under the shared skill-host
    // home lock. `_guard` is declared last so it drops last — the lock is held
    // until after the env var is restored and the TempDir is removed, so this
    // test never races skill_host tests on the global env var (and never writes
    // the skill registry into the real ~/.anchor).
    struct TelegramTestHome {
        _dir: tempfile::TempDir,
        previous: Option<std::ffi::OsString>,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Drop for TelegramTestHome {
        fn drop(&mut self) {
            match self.previous.as_ref() {
                Some(previous) => std::env::set_var("ANCHOR_TEST_HOME", previous),
                None => std::env::remove_var("ANCHOR_TEST_HOME"),
            }
        }
    }

    fn isolated_anchor_home() -> TelegramTestHome {
        let guard = host_fs::test_anchor_home_lock();
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("ANCHOR_TEST_HOME");
        std::env::set_var("ANCHOR_TEST_HOME", dir.path());
        TelegramTestHome {
            _dir: dir,
            previous,
            _guard: guard,
        }
    }

    #[test]
    fn parses_noisy_telegram_output() {
        let raw = r#"login ok
{"messages":[{"id":"1","chatId":"42","chatTitle":"Ops","sender":"Lee","text":"hello","date":"2026-05-10T00:00:00Z","permalink":null}]}
"#;
        let messages = parse_telegram_output(raw).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].chat_title, "Ops");
    }

    #[test]
    fn rejects_relative_session_files() {
        // resolve_telegram_command_config calls store::default_public_env_setup,
        // which writes the skill registry under ANCHOR_TEST_HOME; isolate it.
        let _home = isolated_anchor_home();
        let options = TelegramFetchOptions {
            work_path: None,
            max: None,
            python_path: Some("/missing/python".to_string()),
            script_path: Some("/missing/script.py".to_string()),
            session_file: Some("relative.session".to_string()),
            monitor_config_path: None,
            legacy_auto_drop: None,
        };
        let err = resolve_telegram_command_config(&options).unwrap_err();
        assert!(err.contains("env_missing") || err.contains("session_file_must_be_absolute"));
    }

    #[test]
    fn reads_nested_monitor_config_path_from_workspace_config() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("telegram-monitor.config.yaml");
        fs::write(&config_path, "telegram:\n  api_id: 1\n  api_hash: test\n").unwrap();
        fs::write(
            dir.path().join("workspace.config.yaml"),
            format!(
                "io:\n  providers:\n    telegram:\n      secrets:\n        monitor_config: {}\n",
                config_path.to_string_lossy()
            ),
        )
        .unwrap();
        let resolved = workspace_provider_nested_string(
            dir.path(),
            "telegram",
            &[&["secrets", "monitor_config"][..]],
        );
        assert_eq!(resolved, Some(config_path.to_string_lossy().to_string()));
    }

    #[test]
    fn status_defaults_to_stopped() {
        let status = TelegramPollingStatus::default();
        assert!(!status.running);
        assert_eq!(status.interval_seconds, 60);
    }

    #[test]
    fn sanitizes_message_ids_for_drop_files() {
        assert_eq!(sanitize_filename("a/b+c=.json"), "a-b-c-.json");
    }

    #[test]
    fn classifies_telegram_auth_and_setup_errors() {
        assert_eq!(
            classify_telegram_auth_state("api_id missing"),
            "auth_required"
        );
        assert_eq!(
            classify_telegram_auth_state("Please login with phone"),
            "auth_required"
        );
        assert_eq!(classify_telegram_auth_state("network down"), "error");
        assert_eq!(
            classify_telegram_setup_state("env_missing: python not found"),
            "env_missing"
        );
    }
}
