use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(test)]
use crate::atomic_file::PathTransactionLease;
use crate::atomic_file::{with_path_transactions, PathTransactionParent, PathTransactionRequest};
use crate::cli_path::{augmented_path, is_executable};
use crate::command_output::{run_command_with_timeout, BoundedOutput, CommandTermination};
use crate::inbox_drop::{
    auth_status, stage_message_json_with_parent, stage_message_outcome_with_parent,
    ProviderAuthStatus, StageOutcome,
};
use crate::secrets;
use crate::skill_host::{fs as host_fs, store};
use crate::vault::resolve_inside_vault;
use crate::win_process::NoWindow;

const TELEGRAM_ACCEPT_KIND: &str = "telegram.accept";
const TELEGRAM_REJECT_KIND: &str = "telegram.reject";
const TELEGRAM_STAGE_KIND: &str = "telegram.stage";
const INBOX_BULK_KIND: &str = "inbox.bulk";
const DEFAULT_POLL_INTERVAL_SECONDS: u64 = 60;
const MIN_POLL_INTERVAL_SECONDS: u64 = 30;
#[cfg(not(test))]
const PROVIDER_READINESS_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const PROVIDER_READINESS_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Clone, Default)]
pub struct TelegramIoState {
    run_lock: Arc<(Mutex<bool>, Condvar)>,
    lifecycle: Arc<Mutex<()>>,
    poller: Arc<Mutex<Option<TelegramPollerHandle>>>,
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

#[allow(dead_code)] // Preserved synchronous API for Rust callers.
pub fn fetch_telegram_recent(
    state: State<'_, TelegramIoState>,
    options: TelegramFetchOptions,
) -> Result<Vec<TelegramMessage>, String> {
    fetch_telegram_recent_blocking(state.inner().clone(), options)
}

fn fetch_telegram_recent_blocking(
    state: TelegramIoState,
    options: TelegramFetchOptions,
) -> Result<Vec<TelegramMessage>, String> {
    fetch_telegram_recent_inner(&state.run_lock, options)
}

#[allow(dead_code)] // Preserved synchronous API for Rust callers.
pub fn accept_telegram_item(
    approvals: State<'_, crate::approval::ApprovalState>,
    work_path: String,
    message: TelegramMessage,
    approval_id: Option<String>,
) -> Result<TelegramDecisionOutcome, String> {
    accept_telegram_item_blocking(&approvals, work_path, message, approval_id)
}

fn accept_telegram_item_blocking(
    approvals: &crate::approval::ApprovalState,
    work_path: String,
    message: TelegramMessage,
    approval_id: Option<String>,
) -> Result<TelegramDecisionOutcome, String> {
    crate::approval::require_approval(approvals, approval_id, TELEGRAM_ACCEPT_KIND)?;
    let target = write_telegram_message_to_inbox(&work_path, &message)?;
    Ok(TelegramDecisionOutcome {
        message_id: message.id,
        decision: "accepted".to_string(),
        target_path: Some(target),
        ok: true,
        error: None,
    })
}

#[allow(dead_code)] // Preserved synchronous API for Rust callers.
pub fn reject_telegram_item(
    approvals: State<'_, crate::approval::ApprovalState>,
    message_id: String,
    approval_id: Option<String>,
) -> Result<TelegramDecisionOutcome, String> {
    reject_telegram_item_blocking(&approvals, message_id, approval_id)
}

fn reject_telegram_item_blocking(
    approvals: &crate::approval::ApprovalState,
    message_id: String,
    approval_id: Option<String>,
) -> Result<TelegramDecisionOutcome, String> {
    crate::approval::require_approval(approvals, approval_id, TELEGRAM_REJECT_KIND)?;
    Ok(TelegramDecisionOutcome {
        message_id,
        decision: "rejected".to_string(),
        target_path: None,
        ok: true,
        error: None,
    })
}

#[allow(dead_code)] // Preserved synchronous API for Rust callers.
pub fn stage_telegram_items(
    approvals: State<'_, crate::approval::ApprovalState>,
    work_path: String,
    messages: Vec<TelegramMessage>,
    approval_id: Option<String>,
) -> Result<Vec<StageOutcome>, String> {
    stage_telegram_items_blocking(&approvals, work_path, messages, approval_id)
}

fn stage_telegram_items_blocking(
    approvals: &crate::approval::ApprovalState,
    work_path: String,
    messages: Vec<TelegramMessage>,
    approval_id: Option<String>,
) -> Result<Vec<StageOutcome>, String> {
    crate::approval::require_approval_any(
        approvals,
        approval_id,
        &[TELEGRAM_STAGE_KIND, INBOX_BULK_KIND],
    )?;
    let work = resolve_inside_vault(&work_path, ".")?;
    let parent = PathTransactionParent::capture(&work)?;
    Ok(messages
        .into_iter()
        .map(|message| {
            stage_message_outcome_with_parent(
                &work,
                "telegram",
                "telegram",
                &message.id,
                &message,
                &parent,
            )
        })
        .collect())
}

#[tauri::command]
pub async fn check_telegram_auth(
    options: TelegramFetchOptions,
) -> Result<ProviderAuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        PathTransactionLease::test_stage(
            &[options
                .work_path
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)],
            "worker:check_telegram_auth",
        );
        check_telegram_auth_now(options)
    })
    .await
    .map_err(|err| format!("telegram_probe_task_failed: {err}"))?
}

fn check_telegram_auth_now(options: TelegramFetchOptions) -> Result<ProviderAuthStatus, String> {
    let config = match resolve_telegram_command_config(&options) {
        Ok(config) => config,
        Err(err) => {
            let state = classify_telegram_setup_state(&err);
            return Ok(auth_status("telegram", state, Some(err), None, None));
        }
    };
    let session_work = options.work_path.as_deref().filter(|work| {
        let work = Path::new(work);
        config.session_file.starts_with(work)
            || config
                .session_file
                .parent()
                .and_then(|p| p.canonicalize().ok())
                .zip(work.canonicalize().ok())
                .is_some_and(|(session, work)| session.starts_with(work))
    });
    if let Some(work) = session_work {
        // Finish any legacy registry migration before acquiring the provider's
        // local-write lease; no global registry reservation spans the process.
        with_path_transactions(
            PathTransactionRequest::new([Path::new(work).join("workspace.config.yaml")])?
                .with_workspace_registry()?,
            |lease| {
                lease.ensure_workspace_registry()?;
                lease.before_effect()?;
                crate::vault_list::assert_maru_can_write(
                    work,
                    crate::vault_list::WorkspaceWriteAction::Modify,
                )
            },
        )?;
    }
    // Telethon opens SQLite even for reads. Reserve the session allocation
    // parent, both possible session names, and SQLite journal/WAL/SHM siblings.
    // This is a finite local-write lease, not a held session/domain mutex.
    let session_parent = config
        .session_file
        .parent()
        .ok_or("session_file_has_no_parent")?;
    let mut session_paths = vec![session_parent.to_path_buf(), config.session_file.clone()];
    for session in [
        config.session_file.clone(),
        PathBuf::from(format!("{}.session", config.session_file.display())),
    ] {
        session_paths.push(session.clone());
        for suffix in ["-journal", "-wal", "-shm"] {
            session_paths.push(PathBuf::from(format!("{}{suffix}", session.display())));
        }
    }
    let session_lease = PathTransactionRequest::new(session_paths)?.acquire()?;
    if let Some(work) = session_work {
        session_lease.ensure_workspace_registry()?;
        crate::vault_list::assert_maru_can_write(
            work,
            crate::vault_list::WorkspaceWriteAction::Modify,
        )?;
    }
    session_lease.before_effect()?;
    let mut cmd = Command::new(&config.python_path);
    cmd.env("PATH", augmented_path())
        .env(
            "MARU_SKILLS_ENV",
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
    cmd.current_dir(
        config
            .script_path
            .parent()
            .unwrap_or_else(|| Path::new(".")),
    );
    let output = run_command_with_timeout(&mut cmd, PROVIDER_READINESS_TIMEOUT, |_, _| false)
        .map_err(|err| format!("telegram_spawn_failed: {err}"))?;
    drop(session_lease);
    let detail = output.diagnostic_tail(4096).unwrap_or_default();
    if output.termination == CommandTermination::TimedOut {
        if classify_telegram_auth_state(&detail) == "auth_required" {
            return Ok(auth_status(
                "telegram",
                "auth_required",
                Some("Telegram authentication is required.".to_string()),
                Some(config.python_path),
                None,
            ));
        }
        return Ok(auth_status(
            "telegram",
            "error",
            Some(provider_timeout_detail(
                "telegram_timeout: readiness probe exceeded 10 seconds",
                &output,
            )),
            Some(config.python_path),
            None,
        ));
    }
    if output.status.success() {
        return Ok(auth_status(
            "telegram",
            "ok",
            None,
            Some(config.python_path),
            None,
        ));
    }
    let state = classify_telegram_auth_state(&detail);
    Ok(auth_status(
        "telegram",
        state,
        Some(if state == "auth_required" {
            "Telegram authentication is required.".to_string()
        } else {
            provider_failure_detail(&output, "Telegram command failed without a safe diagnostic")
        }),
        Some(config.python_path),
        None,
    ))
}

fn provider_timeout_detail(prefix: &str, output: &BoundedOutput) -> String {
    match output.safe_diagnostic_tail(1024) {
        Some(detail) if !detail.is_empty() => format!("{prefix}. Diagnostic tail:\n{detail}"),
        _ => prefix.to_string(),
    }
}

fn provider_failure_detail(output: &BoundedOutput, fallback: &str) -> String {
    output
        .safe_diagnostic_tail(4096)
        .filter(|detail| !detail.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

#[allow(dead_code)] // Preserved synchronous API for Rust callers.
pub fn start_telegram_polling<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, TelegramIoState>,
    options: TelegramFetchOptions,
    interval_seconds: Option<u64>,
) -> Result<TelegramPollingStatus, String> {
    start_telegram_polling_blocking(app, state.inner().clone(), options, interval_seconds)
}

fn start_telegram_polling_blocking<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: TelegramIoState,
    options: TelegramFetchOptions,
    interval_seconds: Option<u64>,
) -> Result<TelegramPollingStatus, String> {
    let _lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "telegram_lifecycle_poisoned".to_string())?;
    stop_telegram_polling_state_ref(&state)?;
    let parent = options
        .work_path
        .as_deref()
        .map(|work| PathTransactionParent::capture(Path::new(work)))
        .transpose()?;
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
        let result = fetch_telegram_recent_inner(&run_lock, options.clone());
        let publish = |result: Result<Vec<TelegramMessage>, String>| match result {
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
        };
        if let (Some(work), Some(parent)) = (work_path.as_deref(), parent.as_ref()) {
            let settlement = PathTransactionRequest::new([PathBuf::from(work)])
                .and_then(|request| request.require_parent_snapshot(parent))
                .and_then(|request| {
                    with_path_transactions(request, |lease| {
                        lease.before_effect()?;
                        publish(result);
                        Ok(())
                    })
                });
            if let Err(error) = settlement {
                publish(Err(error));
            }
        } else {
            publish(result);
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
    telegram_polling_status_blocking(state.clone())
}

#[allow(dead_code)] // Preserved synchronous API for Rust callers.
pub fn stop_telegram_polling(
    state: State<'_, TelegramIoState>,
) -> Result<TelegramPollingStatus, String> {
    stop_telegram_polling_blocking(state.inner().clone())
}

fn stop_telegram_polling_blocking(state: TelegramIoState) -> Result<TelegramPollingStatus, String> {
    let _lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "telegram_lifecycle_poisoned".to_string())?;
    stop_telegram_polling_state_ref(&state)?;
    telegram_polling_status_blocking(state.clone())
}

#[allow(dead_code)] // Preserved synchronous API for Rust callers.
pub fn telegram_polling_status(
    state: State<'_, TelegramIoState>,
) -> Result<TelegramPollingStatus, String> {
    telegram_polling_status_blocking(state.inner().clone())
}

fn telegram_polling_status_blocking(
    state: TelegramIoState,
) -> Result<TelegramPollingStatus, String> {
    Ok(state
        .status
        .lock()
        .map_err(|_| "telegram_status_poisoned".to_string())?
        .clone())
}

pub fn stop_poller_on_exit(state: &TelegramIoState) {
    let _ = stop_telegram_polling_blocking(state.clone());
}

fn stop_telegram_polling_state_ref(state: &TelegramIoState) -> Result<(), String> {
    let handle = state
        .poller
        .lock()
        .map_err(|_| "telegram_poller_poisoned".to_string())?
        .take();
    if let Some(mut handle) = handle {
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
    run_lock: &Arc<(Mutex<bool>, Condvar)>,
    options: TelegramFetchOptions,
) -> Result<Vec<TelegramMessage>, String> {
    let parent = options
        .work_path
        .as_deref()
        .map(|work| PathTransactionParent::capture(Path::new(work)))
        .transpose()?;
    // Setup admits its own registry paths before the session reservation.
    let config = resolve_telegram_command_config(&options)?;
    let mut snapshots = Vec::new();
    if let Some(work) = options.work_path.as_deref() {
        snapshots.push(Path::new(work).join("workspace.config.yaml"));
        if config.legacy_auto_drop {
            snapshots.push(Path::new(work).join(".maru/inbox.json"));
        }
    }
    if let Some(path) = &config.monitor_config_path {
        snapshots.push(path.clone());
    }
    let snapshots: Vec<_> = snapshots
        .into_iter()
        .map(|path| {
            let bytes = fs::read(&path).ok();
            (path, bytes)
        })
        .collect();

    let session_work = options.work_path.as_deref().filter(|work| {
        let work = Path::new(work);
        config.legacy_auto_drop
            || config.session_file.starts_with(work)
            || config
                .session_file
                .parent()
                .and_then(|p| p.canonicalize().ok())
                .zip(work.canonicalize().ok())
                .is_some_and(|(session, work)| session.starts_with(work))
    });
    if let Some(work) = session_work {
        // Finish any legacy registry migration before acquiring the provider's
        // local-write lease; no global registry reservation spans the process.
        with_path_transactions(
            PathTransactionRequest::new([Path::new(work).join("workspace.config.yaml")])?
                .with_workspace_registry()?,
            |lease| {
                lease.ensure_workspace_registry()?;
                lease.before_effect()?;
                crate::vault_list::assert_maru_can_write(
                    work,
                    crate::vault_list::WorkspaceWriteAction::Modify,
                )
            },
        )?;
    }
    // Telethon opens SQLite even for reads. Reserve the session allocation
    // parent, both possible session names, and SQLite journal/WAL/SHM siblings.
    // This is a finite local-write lease, not a held session/domain mutex.
    let session_parent = config
        .session_file
        .parent()
        .ok_or("session_file_has_no_parent")?;
    let mut session_paths = vec![session_parent.to_path_buf(), config.session_file.clone()];
    for session in [
        config.session_file.clone(),
        PathBuf::from(format!("{}.session", config.session_file.display())),
    ] {
        session_paths.push(session.clone());
        for suffix in ["-journal", "-wal", "-shm"] {
            session_paths.push(PathBuf::from(format!("{}{suffix}", session.display())));
        }
    }
    // Legacy scripts may write the declared inbox tree directly. Preserve
    // their argv and reserve that complete configured local output set. A
    // custom script without a workspace retains its external-tool boundary.
    let legacy_inbox = if config.legacy_auto_drop {
        options
            .work_path
            .as_deref()
            .map(|work| {
                let work = PathBuf::from(work);
                let inbox = crate::inbox_settings::load_runtime_config_or_legacy(&work)?;
                let root = crate::inbox_settings::resolve_runtime_root(&work, &inbox)?;
                session_paths.extend([
                    work.clone(),
                    root.clone(),
                    work.join("workspace.config.yaml"),
                    work.join(".maru/inbox.json"),
                ]);
                for channel in inbox.channels.values() {
                    for drop_path in &channel.drop_paths {
                        session_paths.push(crate::inbox_settings::lexical_normalize_path(
                            &root.join(drop_path),
                        ));
                    }
                }
                if root.exists() {
                    for entry in walkdir::WalkDir::new(&root).follow_links(false) {
                        let entry = entry.map_err(|error| error.to_string())?;
                        if entry.file_type().is_symlink() {
                            session_paths.push(entry.path().to_path_buf());
                        }
                    }
                }
                Ok::<_, String>((work, inbox))
            })
            .transpose()?
    } else {
        None
    };
    let mut session_request = PathTransactionRequest::new(session_paths)?;
    if legacy_inbox.is_some() {
        if let Some(parent) = &parent {
            session_request = session_request.require_parent_snapshot(parent)?;
        }
    }
    let (active, ready) = &**run_lock;
    let mut running = active
        .lock()
        .map_err(|_| "telegram_run_lock_poisoned".to_string())?;
    while *running {
        running = ready
            .wait(running)
            .map_err(|_| "telegram_run_lock_poisoned".to_string())?;
    }
    *running = true;
    drop(running);
    struct Reservation(Arc<(Mutex<bool>, Condvar)>);
    impl Drop for Reservation {
        fn drop(&mut self) {
            let (active, ready) = &*self.0;
            *active.lock().unwrap_or_else(|err| err.into_inner()) = false;
            ready.notify_all();
        }
    }
    let _reservation = Reservation(run_lock.clone());
    for (path, bytes) in &snapshots {
        if fs::read(path).ok() != *bytes {
            return Err("Telegram configuration changed; retry the operation".into());
        }
    }

    let session_lease = session_request.acquire()?;
    if let Some((work, inbox)) = &legacy_inbox {
        if crate::inbox_settings::load_runtime_config_or_legacy(work)? != *inbox {
            return Err("Inbox configuration changed; retry the operation".into());
        }
    }
    if let Some(work) = session_work {
        session_lease.ensure_workspace_registry()?;
        crate::vault_list::assert_maru_can_write(
            work,
            crate::vault_list::WorkspaceWriteAction::Modify,
        )?;
    }
    session_lease.before_effect()?;
    let mut cmd = Command::new(&config.python_path);
    cmd.env("PATH", augmented_path())
        .env(
            "MARU_SKILLS_ENV",
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
    drop(session_lease);
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let kind = if classify_telegram_auth_state(&detail) == "auth_required" {
            "auth_required"
        } else {
            "telegram_failed"
        };
        return Err(format!("{kind}: {detail}"));
    }
    drop(_reservation);
    let mut paths: Vec<_> = snapshots.iter().map(|(path, _)| path.clone()).collect();
    if let Some(work) = options.work_path.as_deref() {
        paths.push(PathBuf::from(work));
    }
    if !paths.is_empty() {
        let mut request = PathTransactionRequest::new(paths)?;
        if let Some(parent) = parent.as_ref() {
            request = request.require_parent_snapshot(parent)?;
        }
        with_path_transactions(request, |lease| {
            for (path, bytes) in &snapshots {
                if fs::read(path).ok() != *bytes {
                    return Err("Telegram configuration changed; retry the operation".into());
                }
            }
            lease.before_effect()
        })?;
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
            "env_missing: Telegram requires {}. Bootstrap ~/.maru/env first.",
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
                .or_else(|| {
                    work.as_deref()
                        .map(secrets::default_telegram_monitor_config)
                })
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
    let parent = PathTransactionParent::capture(&work)?;
    stage_message_json_with_parent(&work, "telegram", "telegram", &message.id, message, &parent)
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
        .unwrap_or_else(|_| PathBuf::from(".maru/skills"))
        .join("_builtin")
        .join("skills")
        .join("io-telegram")
        .join("scripts")
        .join("telegram_monitor.py")
}

fn default_telegram_session_path() -> PathBuf {
    host_fs::maru_home()
        .unwrap_or_else(|_| PathBuf::from(".maru"))
        .join("telegram")
        .join("monitor.session")
}

fn non_empty_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| host_fs::expand_tilde(trimmed))
}

pub(crate) fn workspace_provider_string(
    work_path: &Path,
    provider: &str,
    keys: &[&str],
) -> Option<String> {
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

pub(crate) fn workspace_provider_nested_string(
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

/// The owned handle is resolved only inside the blocking worker; borrowed State
/// never crosses the async boundary. The wire command names remain unchanged.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn fetch_telegram_recent(
        state: State<'_, TelegramIoState>,
        options: TelegramFetchOptions,
    ) -> Result<Vec<TelegramMessage>, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[options
                    .work_path
                    .as_deref()
                    .map(PathBuf::from)
                    .unwrap_or_else(std::env::temp_dir)],
                "worker:fetch_telegram_recent",
            );
            super::fetch_telegram_recent_blocking(state, options)
        })
        .await
        .map_err(|err| format!("fetch_telegram_recent_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn accept_telegram_item<R: tauri::Runtime>(
        app: AppHandle<R>,
        work_path: String,
        message: TelegramMessage,
        approval_id: Option<String>,
    ) -> Result<TelegramDecisionOutcome, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:accept_telegram_item",
            );
            super::accept_telegram_item_blocking(
                &app.state::<crate::approval::ApprovalState>(),
                work_path,
                message,
                approval_id,
            )
        })
        .await
        .map_err(|err| format!("accept_telegram_item_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn reject_telegram_item<R: tauri::Runtime>(
        app: AppHandle<R>,
        message_id: String,
        approval_id: Option<String>,
    ) -> Result<TelegramDecisionOutcome, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[std::env::temp_dir()],
                "worker:reject_telegram_item",
            );
            super::reject_telegram_item_blocking(
                &app.state::<crate::approval::ApprovalState>(),
                message_id,
                approval_id,
            )
        })
        .await
        .map_err(|err| format!("reject_telegram_item_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn stage_telegram_items<R: tauri::Runtime>(
        app: AppHandle<R>,
        work_path: String,
        messages: Vec<TelegramMessage>,
        approval_id: Option<String>,
    ) -> Result<Vec<StageOutcome>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:stage_telegram_items",
            );
            super::stage_telegram_items_blocking(
                &app.state::<crate::approval::ApprovalState>(),
                work_path,
                messages,
                approval_id,
            )
        })
        .await
        .map_err(|err| format!("stage_telegram_items_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn start_telegram_polling<R: tauri::Runtime>(
        app: AppHandle<R>,
        state: State<'_, TelegramIoState>,
        options: TelegramFetchOptions,
        interval_seconds: Option<u64>,
    ) -> Result<TelegramPollingStatus, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[options
                    .work_path
                    .as_deref()
                    .map(PathBuf::from)
                    .unwrap_or_else(std::env::temp_dir)],
                "worker:start_telegram_polling",
            );
            super::start_telegram_polling_blocking(app, state, options, interval_seconds)
        })
        .await
        .map_err(|err| format!("start_telegram_polling_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn stop_telegram_polling(
        state: State<'_, TelegramIoState>,
    ) -> Result<TelegramPollingStatus, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[std::env::temp_dir()],
                "worker:stop_telegram_polling",
            );
            super::stop_telegram_polling_blocking(state)
        })
        .await
        .map_err(|err| format!("stop_telegram_polling_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn telegram_polling_status(
        state: State<'_, TelegramIoState>,
    ) -> Result<TelegramPollingStatus, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[std::env::temp_dir()],
                "worker:telegram_polling_status",
            );
            super::telegram_polling_status_blocking(state)
        })
        .await
        .map_err(|err| format!("telegram_polling_status_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbox_drop::sanitize_filename;

    // Isolates the process-global `MARU_TEST_HOME` under the shared skill-host
    // home lock. `_guard` is declared last so it drops last — the lock is held
    // until after the env var is restored and the TempDir is removed, so this
    // test never races skill_host tests on the global env var (and never writes
    // the skill registry into the real ~/.maru).
    struct TelegramTestHome {
        _dir: tempfile::TempDir,
        previous: Option<std::ffi::OsString>,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Drop for TelegramTestHome {
        fn drop(&mut self) {
            match self.previous.as_ref() {
                Some(previous) => std::env::set_var("MARU_TEST_HOME", previous),
                None => std::env::remove_var("MARU_TEST_HOME"),
            }
        }
    }

    fn isolated_maru_home() -> TelegramTestHome {
        let guard = host_fs::test_maru_home_lock();
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("MARU_TEST_HOME");
        std::env::set_var("MARU_TEST_HOME", dir.path());
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
        // which writes the skill registry under MARU_TEST_HOME; isolate it.
        let _home = isolated_maru_home();
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

    #[cfg(unix)]
    #[test]
    fn non_timeout_failure_detail_suppresses_camel_case_api_hash() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "printf '{\"apiHash\":\"TELEGRAM-SECRET\",\"error\":\"network unavailable\"}' >&2; exit 1",
        ]);
        let output =
            run_command_with_timeout(&mut command, Duration::from_secs(1), |_, _| false).unwrap();

        let detail =
            provider_failure_detail(&output, "Telegram command failed without a safe diagnostic");

        assert_eq!(detail, "Telegram command failed without a safe diagnostic");
        assert!(!detail.contains("TELEGRAM-SECRET"));
    }
}

#[cfg(all(test, unix))]
mod phase08_14 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::scratchpad::phase08_08::{registry, PrimaryWorkspaceAccessFixture};
    use std::os::unix::fs::PermissionsExt;

    type TestApp = AppHandle<tauri::test::MockRuntime>;

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(crate::approval::ApprovalState::default());
        app.manage(TelegramIoState::default());
        app
    }

    fn fixture(home: &Home) -> (TelegramFetchOptions, PrimaryWorkspaceAccessFixture) {
        let work = home.root.path().join("work");
        fs::create_dir_all(work.join("inbox/drop/telegram")).unwrap();
        fs::write(
            work.join("workspace.config.yaml"),
            "inbox:\n  root: inbox\n",
        )
        .unwrap();
        let python = home.root.path().join("fixture-python");
        fs::write(&python, "#!/bin/sh\nprintf '%s\\n' '{\"messages\":[{\"id\":\"fixture-1\",\"chatId\":\"42\",\"chatTitle\":\"Fixture\",\"sender\":\"Synthetic\",\"text\":\"hello\",\"date\":\"2026-01-01\",\"permalink\":null}]}'\n").unwrap();
        fs::set_permissions(&python, fs::Permissions::from_mode(0o700)).unwrap();
        let script = home.root.path().join("fixture-monitor.py");
        fs::write(&script, "synthetic fixture, never interpreted").unwrap();
        let config = home.root.path().join("fixture-config.yaml");
        fs::write(&config, "fixture: true\n").unwrap();
        let options = TelegramFetchOptions {
            work_path: Some(work.to_string_lossy().into_owned()),
            max: Some(3),
            python_path: Some(python.to_string_lossy().into_owned()),
            script_path: Some(script.to_string_lossy().into_owned()),
            session_file: Some(
                home.root
                    .path()
                    .join("fixture.session")
                    .to_string_lossy()
                    .into_owned(),
            ),
            monitor_config_path: Some(config.to_string_lossy().into_owned()),
            legacy_auto_drop: Some(false),
        };
        assert!(python.is_file() && is_executable(&python));
        assert_eq!(
            resolve_telegram_command_config(&options)
                .unwrap()
                .python_path,
            python
        );
        registry(&work, "direct");
        let access = PrimaryWorkspaceAccessFixture::new(work);
        (options, access)
    }

    fn message() -> TelegramMessage {
        TelegramMessage {
            id: "fixture-1".into(),
            chat_id: "42".into(),
            chat_title: "Fixture".into(),
            sender: "Synthetic".into(),
            text: "hello".into(),
            date: "2026-01-01".into(),
            permalink: None,
        }
    }

    fn approval(app: &TestApp, kind: &str) -> Option<String> {
        let request = crate::approval::prepare_approval(
            app.state(),
            kind.into(),
            "synthetic".into(),
            None,
            None,
        )
        .unwrap();
        crate::approval::record_approval(
            app.state(),
            request.id.clone(),
            crate::approval::ApprovalDecision::Approved,
            None,
        )
        .unwrap();
        Some(request.id)
    }

    async fn invoke(
        command: &str,
        app: TestApp,
        options: TelegramFetchOptions,
        approval_id: Option<String>,
    ) -> Result<serde_json::Value, String> {
        let work = options.work_path.clone().unwrap();
        match command {
            "check_telegram_auth" => check_telegram_auth(options)
                .await
                .map(|v| serde_json::to_value(v).unwrap()),
            "fetch_telegram_recent" => ipc::fetch_telegram_recent(app.state(), options)
                .await
                .map(|v| serde_json::to_value(v).unwrap()),
            "accept_telegram_item" => ipc::accept_telegram_item(app, work, message(), approval_id)
                .await
                .map(|v| serde_json::to_value(v).unwrap()),
            "reject_telegram_item" => {
                ipc::reject_telegram_item(app, "fixture-1".into(), approval_id)
                    .await
                    .map(|v| serde_json::to_value(v).unwrap())
            }
            "stage_telegram_items" => {
                ipc::stage_telegram_items(app, work, vec![message()], approval_id)
                    .await
                    .map(|v| serde_json::to_value(v).unwrap())
            }
            "start_telegram_polling" => {
                ipc::start_telegram_polling(app.clone(), app.state(), options, Some(30))
                    .await
                    .map(|v| serde_json::to_value(v).unwrap())
            }
            "stop_telegram_polling" => ipc::stop_telegram_polling(app.state())
                .await
                .map(|v| serde_json::to_value(v).unwrap()),
            "telegram_polling_status" => ipc::telegram_polling_status(app.state())
                .await
                .map(|v| serde_json::to_value(v).unwrap()),
            _ => panic!("unknown fixture command"),
        }
    }

    #[test]
    fn phase08_14_telegram_every_wrapper_yields_and_preserves_join_errors() {
        let home = Home::new();
        let (options, _access) = fixture(&home);
        let app = app();
        for command in [
            "fetch_telegram_recent",
            "accept_telegram_item",
            "reject_telegram_item",
            "stage_telegram_items",
            "start_telegram_polling",
            "stop_telegram_polling",
            "telegram_polling_status",
        ] {
            let path = if matches!(
                command,
                "reject_telegram_item" | "stop_telegram_polling" | "telegram_polling_status"
            ) {
                std::env::temp_dir()
            } else {
                PathBuf::from(options.work_path.as_ref().unwrap())
            };
            let handle = app.handle().clone();
            let options = options.clone();
            boundary(path, command, async move {
                invoke(command, handle, options, None).await
            });
        }
    }

    #[test]
    fn phase08_14_telegram_retained_auth_yields_and_preserves_probe_error() {
        let home = Home::new();
        let (options, _access) = fixture(&home);
        boundary(
            PathBuf::from(options.work_path.as_ref().unwrap()),
            "check_telegram_auth",
            async move {
                check_telegram_auth(options).await.map_err(|error| {
                    assert!(error.starts_with("telegram_probe_task_failed:"));
                    error.replacen(
                        "telegram_probe_task_failed:",
                        "check_telegram_auth_task_failed:",
                        1,
                    )
                })
            },
        );
    }

    #[test]
    fn phase08_14_telegram_actual_entries_nonempty_results_approvals_auth_and_polling() {
        let home = Home::new();
        let (options, _access) = fixture(&home);
        let app = app();
        let call = |command: &'static str, auth| {
            let handle = app.handle().clone();
            let options = options.clone();
            run(async move { invoke(command, handle, options, auth).await })
        };
        assert_eq!(
            call("fetch_telegram_recent", None).unwrap()[0]["text"],
            "hello"
        );
        assert_eq!(
            run(check_telegram_auth(options.clone())).unwrap().state,
            "ok"
        );
        for (command, kind) in [
            ("accept_telegram_item", TELEGRAM_ACCEPT_KIND),
            ("reject_telegram_item", TELEGRAM_REJECT_KIND),
            ("stage_telegram_items", TELEGRAM_STAGE_KIND),
        ] {
            assert_eq!(
                call(command, None).unwrap_err(),
                format!("approval_required: {kind}")
            );
            let result = call(command, approval(app.handle(), kind)).unwrap();
            if command == "stage_telegram_items" {
                assert_eq!(result[0]["ok"], true);
            } else {
                assert_eq!(result["ok"], true);
            }
        }
        assert_eq!(
            call("telegram_polling_status", None).unwrap()["running"],
            false
        );
        assert_eq!(
            call("start_telegram_polling", None).unwrap()["running"],
            true
        );
        assert_eq!(
            call("start_telegram_polling", None).unwrap()["running"],
            true
        );
        assert_eq!(
            call("stop_telegram_polling", None).unwrap()["running"],
            false
        );
        assert!(app
            .state::<TelegramIoState>()
            .poller
            .lock()
            .unwrap()
            .is_none());
    }

    #[test]
    fn phase08_14_telegram_raw_writers_policy_alias_and_error_release() {
        let home = Home::new();
        let (options, _access) = fixture(&home);
        let work = PathBuf::from(options.work_path.as_ref().unwrap());
        let alias = home.root.path().join("alias");
        std::os::unix::fs::symlink(&work, &alias).unwrap();
        let app = app();
        for command in ["accept_telegram_item", "stage_telegram_items"] {
            for (registered, caller) in [(&work, &alias), (&alias, &work)] {
                for policy in ["readOnly", "delegated", "direct"] {
                    registry(registered, policy);
                    let kind = if command == "accept_telegram_item" {
                        TELEGRAM_ACCEPT_KIND
                    } else {
                        TELEGRAM_STAGE_KIND
                    };
                    let auth = approval(app.handle(), kind);
                    let handle = app.handle().clone();
                    let mut options = options.clone();
                    options.work_path = Some(caller.to_string_lossy().into_owned());
                    let result = run(async move { invoke(command, handle, options, auth).await });
                    if policy == "direct" {
                        assert!(result.is_ok());
                    } else if command == "accept_telegram_item" {
                        assert!(result.unwrap_err().contains("Workspace writes are blocked"));
                    } else {
                        assert_eq!(result.unwrap()[0]["ok"], false);
                    }
                }
            }
        }
    }

    #[test]
    fn phase08_14_telegram_fetch_discards_replaced_parent_and_releases_reservation() {
        let home = Home::new();
        let (options, _access) = fixture(&home);
        let app = app();
        let work = PathBuf::from(options.work_path.as_ref().unwrap());
        let state = app.state::<TelegramIoState>().inner().clone();
        // Hold provider-session admission, then replace the captured workspace.
        *state.run_lock.0.lock().unwrap() = true;
        let (tx, rx) = mpsc::channel();
        let options_copy = options.clone();
        let state_copy = state.clone();
        let held = Held::new(
            host_fs::skills_root().unwrap().join("registry.json"),
            "admitted",
        );
        let worker = thread::spawn(move || {
            tx.send(fetch_telegram_recent_blocking(state_copy, options_copy))
                .unwrap();
        });
        held.wait();
        fs::rename(&work, home.root.path().join("old-work")).unwrap();
        fs::create_dir(&work).unwrap();
        held.release();
        *state.run_lock.0.lock().unwrap() = false;
        state.run_lock.1.notify_all();
        assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().is_err());
        worker.join().unwrap();
        assert!(!*state.run_lock.0.lock().unwrap());
        assert!(!work.join("inbox").exists());
    }
    #[test]
    fn phase08_14_telegram_writers_contend_with_files_both_orders() {
        let home = Home::new();
        for command in ["accept_telegram_item", "stage_telegram_items"] {
            for files_first in [false, true] {
                for trash in [false, true] {
                    for use_alias in [false, true] {
                        let (mut options, _access) = fixture(&home);
                        let app = app();
                        let work = PathBuf::from(options.work_path.as_ref().unwrap());
                        let alias = home.root.path().join("raw-work-alias");
                        std::os::unix::fs::symlink(&work, &alias).unwrap();
                        if use_alias {
                            options.work_path = Some(alias.to_string_lossy().into_owned());
                        }
                        // resolve_inside_vault canonicalizes the selected root.
                        let target = work.join("inbox/drop/telegram");
                        let _trash = crate::workspace_files::phase08_06::TrashFixture::new(
                            work.join("inbox"),
                            work.join("moved"),
                        );
                        let kind = if command == "accept_telegram_item" {
                            TELEGRAM_ACCEPT_KIND
                        } else {
                            TELEGRAM_STAGE_KIND
                        };
                        let auth = approval(app.handle(), kind);
                        let held = Held::new(
                            if files_first {
                                work.join("inbox")
                            } else {
                                target.clone()
                            },
                            "admitted",
                        );
                        let (writer_tx, writer_rx) = mpsc::channel();
                        let (files_tx, files_rx) = mpsc::channel();
                        let handle = app.handle().clone();
                        let writer = move || {
                            writer_tx
                                .send(run(
                                    async move { invoke(command, handle, options, auth).await },
                                ))
                                .unwrap();
                        };
                        let root = work.to_string_lossy().into_owned();
                        let files = move || {
                            let result = if trash {
                                crate::workspace_files::trash_workspace_entries(
                                    root,
                                    vec!["inbox".into()],
                                )
                                .map(|items| {
                                    assert!(items.iter().all(|item| item.error.is_none()));
                                })
                            } else {
                                crate::workspace_files::rename_workspace_entry(
                                    root,
                                    "inbox".into(),
                                    "moved".into(),
                                )
                                .map(|_| ())
                            };
                            files_tx.send(result).unwrap();
                        };
                        let (first, second) = if files_first {
                            let first = thread::spawn(files);
                            held.wait();
                            let waiting = Held::new(target.clone(), "before-admission");
                            let second = thread::spawn(writer);
                            waiting.wait();
                            waiting.release();
                            assert!(writer_rx.recv_timeout(Duration::from_millis(40)).is_err());
                            held.release();
                            (first, second)
                        } else {
                            let first = thread::spawn(writer);
                            held.wait();
                            let waiting = Held::new(work.join("inbox"), "before-admission");
                            let second = thread::spawn(files);
                            waiting.wait();
                            waiting.release();
                            assert!(files_rx.recv_timeout(Duration::from_millis(40)).is_err());
                            held.release();
                            (first, second)
                        };
                        first.join().unwrap();
                        second.join().unwrap();
                        assert!(files_rx
                            .recv_timeout(Duration::from_secs(5))
                            .unwrap()
                            .is_ok());
                        let result = writer_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                        if files_first {
                            if command == "stage_telegram_items" {
                                assert_eq!(result.unwrap()[0]["ok"], false);
                            } else {
                                assert!(result.is_err());
                            }
                        } else {
                            assert!(result.is_ok());
                        }
                        assert!(!work.join("inbox").exists());
                        fs::remove_dir_all(work.join("moved")).unwrap();
                        fs::remove_file(alias).unwrap();
                        fs::remove_dir_all(&work).unwrap();
                    }
                }
            }
        }
    }
    #[test]
    fn phase08_14_telegram_same_target_contention_and_actual_unwind_release() {
        use crate::atomic_file::PathTransactionTestHook;
        use std::sync::atomic::{AtomicBool, Ordering};
        let home = Home::new();
        let (options, _access) = fixture(&home);
        let app = app();
        let target = Path::new(options.work_path.as_ref().unwrap()).join("inbox/drop/telegram");
        for command in ["accept_telegram_item", "stage_telegram_items"] {
            let kind = if command == "accept_telegram_item" {
                TELEGRAM_ACCEPT_KIND
            } else {
                TELEGRAM_STAGE_KIND
            };
            let auth = approval(app.handle(), kind);
            let handle = app.handle().clone();
            let first_options = options.clone();
            let held = Held::new(target.clone(), "admitted");
            let first = thread::spawn(move || {
                run(async move { invoke(command, handle, first_options, auth).await })
            });
            held.wait();
            let waiting = Held::new(target.clone(), "before-admission");
            let auth = approval(app.handle(), kind);
            let handle = app.handle().clone();
            let second_options = options.clone();
            let (tx, rx) = mpsc::channel();
            let second = thread::spawn(move || {
                tx.send(run(async move {
                    invoke(command, handle, second_options, auth).await
                }))
                .unwrap()
            });
            waiting.wait();
            waiting.release();
            assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
            held.release();
            assert!(first.join().unwrap().is_ok());
            assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().is_ok());
            second.join().unwrap();
            drop(held);
            drop(waiting);
            let once = AtomicBool::new(false);
            let hook = PathTransactionTestHook::new(target.clone(), "pre-effect", move || {
                if !once.swap(true, Ordering::SeqCst) {
                    panic!("synthetic raw-stage unwind");
                }
            });
            let auth = approval(app.handle(), kind);
            let handle = app.handle().clone();
            let next = options.clone();
            let err = run(async move { invoke(command, handle, next, auth).await }).unwrap_err();
            assert!(err.starts_with(&format!("{command}_task_failed:")));
            drop(hook);
            let auth = approval(app.handle(), kind);
            let handle = app.handle().clone();
            let next = options.clone();
            assert!(run(async move { invoke(command, handle, next, auth).await }).is_ok());
        }
    }

    #[test]
    fn phase08_14_telegram_polling_callback_rejects_replaced_parent_without_locking_status() {
        let home = Home::new();
        let (options, _access) = fixture(&home);
        let app = app();
        let work = PathBuf::from(options.work_path.as_ref().unwrap());
        let held = Held::new(
            host_fs::skills_root().unwrap().join("registry.json"),
            "admitted",
        );
        let handle = app.handle().clone();
        let next = options.clone();
        assert_eq!(
            run(async move { invoke("start_telegram_polling", handle, next, None).await }).unwrap()
                ["running"],
            true
        );
        held.wait();
        let handle = app.handle().clone();
        let next = options.clone();
        assert_eq!(
            run(async move { invoke("telegram_polling_status", handle, next, None).await })
                .unwrap()["running"],
            true
        );
        fs::rename(&work, home.root.path().join("old-work")).unwrap();
        fs::create_dir(&work).unwrap();
        held.release();
        let state = app.state::<TelegramIoState>().inner().clone();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if state.status.lock().unwrap().last_error.is_some() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "bounded late callback"
            );
            thread::sleep(Duration::from_millis(5));
        }
        let handle = app.handle().clone();
        let next = options.clone();
        assert_eq!(
            run(async move { invoke("stop_telegram_polling", handle, next, None).await }).unwrap()
                ["running"],
            false
        );
        assert_eq!(state.status.lock().unwrap().last_message_count, 0);
        assert!(state.poller.lock().unwrap().is_none());
        assert!(!work.join("inbox").exists());
    }
    #[test]
    fn phase08_14_telegram_fetch_auth_session_writers_files_both_orders_aliases() {
        let home = Home::new();
        for command in ["fetch_telegram_recent", "check_telegram_auth"] {
            for files_first in [false, true] {
                for use_alias in [false, true] {
                    let (mut options, _access) = fixture(&home);
                    let work = PathBuf::from(options.work_path.as_ref().unwrap());
                    let session_dir = work.join("sessions");
                    fs::create_dir_all(&session_dir).unwrap();
                    let alias = home.root.path().join("session-alias");
                    std::os::unix::fs::symlink(&session_dir, &alias).unwrap();
                    let selected = if use_alias {
                        alias.clone()
                    } else {
                        session_dir.clone()
                    };
                    options.session_file = Some(
                        selected
                            .join("fixture.session")
                            .to_string_lossy()
                            .into_owned(),
                    );
                    let python = PathBuf::from(options.python_path.as_ref().unwrap());
                    let original = fs::read_to_string(&python).unwrap();
                    let writer_script = r#"#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--session-file' ]; then shift; session="$1"; fi
  shift
done
printf 'synthetic SQLite' > "$session"
printf 'synthetic WAL' > "$session-wal"
"#;
                    fs::write(
                        &python,
                        format!(
                            "{writer_script}{}",
                            original.strip_prefix("#!/bin/sh\n").unwrap()
                        ),
                    )
                    .unwrap();
                    assert!(python.is_file() && is_executable(&python));
                    assert_eq!(
                        resolve_telegram_command_config(&options)
                            .unwrap()
                            .python_path,
                        python
                    );
                    let app = app();
                    let held = Held::new(
                        if files_first {
                            session_dir.clone()
                        } else {
                            selected.clone()
                        },
                        "admitted",
                    );
                    let (writer_tx, writer_rx) = mpsc::channel();
                    let (files_tx, files_rx) = mpsc::channel();
                    let handle = app.handle().clone();
                    let writer = move || {
                        writer_tx
                            .send(run(
                                async move { invoke(command, handle, options, None).await },
                            ))
                            .unwrap();
                    };
                    let root = work.to_string_lossy().into_owned();
                    let files = move || {
                        files_tx
                            .send(crate::workspace_files::rename_workspace_entry(
                                root,
                                "sessions".into(),
                                "moved-sessions".into(),
                            ))
                            .unwrap();
                    };
                    let (first, second) = if files_first {
                        let first = thread::spawn(files);
                        held.wait();
                        let waiting = Held::new(selected, "before-admission");
                        let second = thread::spawn(writer);
                        waiting.wait();
                        waiting.release();
                        assert!(writer_rx.recv_timeout(Duration::from_millis(40)).is_err());
                        held.release();
                        (first, second)
                    } else {
                        let first = thread::spawn(writer);
                        held.wait();
                        let waiting = Held::new(session_dir, "before-admission");
                        let second = thread::spawn(files);
                        waiting.wait();
                        waiting.release();
                        assert!(files_rx.recv_timeout(Duration::from_millis(40)).is_err());
                        held.release();
                        (first, second)
                    };
                    first.join().unwrap();
                    second.join().unwrap();
                    assert!(files_rx
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap()
                        .is_ok());
                    let result = writer_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    if files_first {
                        assert!(result.is_err());
                    } else {
                        assert!(result.is_ok());
                        assert!(work.join("moved-sessions/fixture.session").exists());
                        assert!(work.join("moved-sessions/fixture.session-wal").exists());
                    }
                    assert!(!work.join("sessions").exists());
                    fs::remove_file(alias).unwrap();
                    fs::remove_dir_all(&work).unwrap();
                }
            }
        }
    }
    #[test]
    fn phase08_14_telegram_concurrent_actual_starts_status_and_stop_reap() {
        let home = Home::new();
        let (options, _access) = fixture(&home);
        let app = app();
        let work = PathBuf::from(options.work_path.as_ref().unwrap());
        let held = Held::new(work, "worker:start_telegram_polling");
        let handle = app.handle().clone();
        let next = options.clone();
        let first = thread::spawn(move || {
            run(async move { invoke("start_telegram_polling", handle, next, None).await })
        });
        held.wait();
        let handle = app.handle().clone();
        let next = options.clone();
        assert_eq!(
            run(async move { invoke("start_telegram_polling", handle, next, None).await }).unwrap()
                ["running"],
            true
        );
        let handle = app.handle().clone();
        let next = options.clone();
        assert_eq!(
            run(async move { invoke("telegram_polling_status", handle, next, None).await })
                .unwrap()["running"],
            true
        );
        held.release();
        assert_eq!(first.join().unwrap().unwrap()["running"], true);
        let handle = app.handle().clone();
        assert_eq!(
            run(async move { invoke("stop_telegram_polling", handle, options, None).await })
                .unwrap()["running"],
            false
        );
        assert!(app
            .state::<TelegramIoState>()
            .poller
            .lock()
            .unwrap()
            .is_none());
    }

    #[test]
    fn phase08_14_telegram_session_policy_rechecked_after_admission_and_released() {
        let home = Home::new();
        for command in ["fetch_telegram_recent", "check_telegram_auth"] {
            for use_alias in [false, true] {
                let (mut options, _access) = fixture(&home);
                let work = PathBuf::from(options.work_path.as_ref().unwrap());
                let sessions = work.join("sessions");
                fs::create_dir_all(&sessions).unwrap();
                let alias = home.root.path().join("policy-session-alias");
                std::os::unix::fs::symlink(&sessions, &alias).unwrap();
                let selected = if use_alias {
                    alias.clone()
                } else {
                    sessions.clone()
                };
                options.session_file = Some(
                    selected
                        .join("fixture.session")
                        .to_string_lossy()
                        .into_owned(),
                );
                let marker = home.root.path().join("provider-invoked");
                let python = PathBuf::from(options.python_path.as_ref().unwrap());
                let original = fs::read_to_string(&python).unwrap();
                fs::write(
                    &python,
                    format!(
                        "#!/bin/sh\nprintf invoked > '{}'\n{}",
                        marker.display(),
                        original.strip_prefix("#!/bin/sh\n").unwrap()
                    ),
                )
                .unwrap();
                assert!(python.is_file() && is_executable(&python));
                assert_eq!(
                    resolve_telegram_command_config(&options)
                        .unwrap()
                        .python_path,
                    python
                );
                let app = app();
                let held = Held::new(selected, "admitted");
                let handle = app.handle().clone();
                let next = options.clone();
                let worker = thread::spawn(move || {
                    run(async move { invoke(command, handle, next, None).await })
                });
                held.wait();
                registry(&work, "readOnly");
                held.release();
                assert!(worker
                    .join()
                    .unwrap()
                    .unwrap_err()
                    .contains("Workspace writes are blocked"));
                assert!(!marker.exists());
                drop(held);
                registry(&work, "direct");
                let handle = app.handle().clone();
                assert!(run(async move { invoke(command, handle, options, None).await }).is_ok());
                assert!(marker.exists());
                fs::remove_file(marker).unwrap();
                fs::remove_file(alias).unwrap();
                fs::remove_dir_all(work).unwrap();
            }
        }
    }
    #[test]
    fn phase08_14_telegram_legacy_configured_drop_preserves_argv_files_races_and_aliases() {
        let home = Home::new();
        for files_first in [false, true] {
            for use_alias in [false, true] {
                let (mut options, _access) = fixture(&home);
                let work = PathBuf::from(options.work_path.as_ref().unwrap());
                let alias = home.root.path().join("legacy-work-alias");
                std::os::unix::fs::symlink(&work, &alias).unwrap();
                let selected = if use_alias {
                    alias.clone()
                } else {
                    work.clone()
                };
                options.work_path = Some(selected.to_string_lossy().into_owned());
                options.legacy_auto_drop = Some(true);
                let argv = home.root.path().join("legacy-argv");
                let target = selected.join("inbox/drop/telegram");
                let python = PathBuf::from(options.python_path.as_ref().unwrap());
                fs::write(&python, format!("#!/bin/sh\nprintf '%s\n' \"$@\" > '{}'\nmkdir -p '{}'\nprintf 'synthetic legacy drop' > '{}/legacy.txt'\n", argv.display(), target.display(), target.display())).unwrap();
                assert!(python.is_file() && is_executable(&python));
                assert_eq!(
                    resolve_telegram_command_config(&options)
                        .unwrap()
                        .python_path,
                    python
                );
                let app = app();
                let held = Held::new(
                    if files_first {
                        work.join("inbox")
                    } else {
                        selected.clone()
                    },
                    "admitted",
                );
                let (writer_tx, writer_rx) = mpsc::channel();
                let (files_tx, files_rx) = mpsc::channel();
                let handle = app.handle().clone();
                let writer = move || {
                    writer_tx
                        .send(run(async move {
                            invoke("fetch_telegram_recent", handle, options, None).await
                        }))
                        .unwrap();
                };
                let root = work.to_string_lossy().into_owned();
                let files = move || {
                    files_tx
                        .send(crate::workspace_files::rename_workspace_entry(
                            root,
                            "inbox".into(),
                            "moved-inbox".into(),
                        ))
                        .unwrap();
                };
                let (first, second) = if files_first {
                    let first = thread::spawn(files);
                    held.wait();
                    let waiting = Held::new(selected, "before-admission");
                    let second = thread::spawn(writer);
                    waiting.wait();
                    waiting.release();
                    assert!(writer_rx.recv_timeout(Duration::from_millis(40)).is_err());
                    held.release();
                    (first, second)
                } else {
                    let first = thread::spawn(writer);
                    held.wait();
                    let waiting = Held::new(work.join("inbox"), "before-admission");
                    let second = thread::spawn(files);
                    waiting.wait();
                    waiting.release();
                    assert!(files_rx.recv_timeout(Duration::from_millis(40)).is_err());
                    held.release();
                    (first, second)
                };
                first.join().unwrap();
                second.join().unwrap();
                assert!(files_rx
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap()
                    .is_ok());
                let result = writer_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                if files_first {
                    assert!(result.is_err());
                    assert!(!argv.exists());
                } else {
                    assert_eq!(result.unwrap(), serde_json::json!([]));
                    assert_eq!(
                        fs::read_to_string(work.join("moved-inbox/drop/telegram/legacy.txt"))
                            .unwrap(),
                        "synthetic legacy drop"
                    );
                    let args = fs::read_to_string(&argv).unwrap();
                    assert!(
                        args.contains("--once")
                            && args.contains("--session-file")
                            && args.contains("--config-file")
                    );
                    assert!(!args.contains("--output-json"));
                    fs::remove_file(argv).unwrap();
                }
                assert!(!work.join("inbox").exists());
                fs::remove_file(alias).unwrap();
                fs::remove_dir_all(work).unwrap();
            }
        }
    }
}
