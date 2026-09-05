#[cfg(windows)]
use crate::win_process::NoWindow;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::Duration as StdDuration;
use tauri::{AppHandle, Emitter, Manager};

use crate::atomic_file::{
    with_path_transactions, PathTransactionLease, PathTransactionParent, PathTransactionRequest,
};

pub(crate) fn mission_mutation_paths(id: &str) -> Result<Vec<PathBuf>, String> {
    let json = mission_json_path(id)?;
    Ok(vec![
        json.with_extension("json.tmp"),
        json,
        mission_log_path(id)?,
    ])
}

pub(crate) fn mission_parent_snapshot() -> Result<PathTransactionParent, String> {
    let mut parent = mission_dir()?;
    while !parent.is_dir() {
        parent = parent
            .parent()
            .ok_or("Mission parent does not exist")?
            .to_path_buf();
    }
    PathTransactionParent::capture(&parent)
}

fn mission_transaction<T>(
    id: &str,
    work: impl FnOnce(&PathTransactionLease) -> Result<T, String>,
) -> Result<T, String> {
    with_path_transactions(
        PathTransactionRequest::new(mission_mutation_paths(id)?)?,
        work,
    )
}

fn check_mission_lease(id: &str, lease: &PathTransactionLease) -> Result<(), String> {
    lease.ensure_covered(mission_mutation_paths(id)?)?;
    lease.before_effect()
}

const IDLE_AFTER_SECONDS: i64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MissionStatus {
    Running,
    Idle,
    Done,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionRecord {
    pub id: String,
    pub kind: String,
    pub started_at: String,
    pub last_output_at: String,
    pub status: MissionStatus,
    pub exit_code: Option<i32>,
    pub output_log_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionLogTail {
    pub invocation_id: String,
    pub lines: Vec<String>,
}

type ExecutionLease = (Weak<PathTransactionLease>, Weak<Mutex<()>>);

#[derive(Default)]
pub struct MissionState {
    missions: Mutex<HashMap<String, MissionRecord>>,
    pids: Mutex<HashMap<String, u32>>,
    execution_leases: Mutex<HashMap<String, ExecutionLease>>,
}

impl std::fmt::Debug for MissionState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MissionState")
            .field("missions", &self.missions)
            .field("pids", &self.pids)
            .finish_non_exhaustive()
    }
}

/// Stops are part of the already-admitted owned child transaction. Weak handles
/// do not keep an execution reservation alive after its stream/exit callbacks.
pub(crate) fn bind_execution_lease<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    lease: &Arc<PathTransactionLease>,
    serial: &Arc<Mutex<()>>,
) -> Result<(), String> {
    app.state::<MissionState>()
        .execution_leases
        .lock()
        .map_err(|_| "mission_state_poisoned".to_string())?
        .insert(
            id.to_string(),
            (Arc::downgrade(lease), Arc::downgrade(serial)),
        );
    Ok(())
}

impl Drop for MissionState {
    fn drop(&mut self) {
        if let Ok(pids) = self.pids.get_mut() {
            for pid in pids.values().copied() {
                let _ = kill_pid(pid, true);
            }
        }
    }
}

pub fn list_ai_missions<R: tauri::Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<MissionRecord>, String> {
    let state = app.state::<MissionState>();
    state.list()
}

pub fn stop_ai_mission<R: tauri::Runtime>(
    app: AppHandle<R>,
    invocation_id: String,
) -> Result<MissionRecord, String> {
    let state = app.state::<MissionState>();
    let record = state.stop(app.clone(), &invocation_id)?;
    emit_update(&app, &record);
    Ok(record)
}

pub fn read_ai_mission_log(
    invocation_id: String,
    max_lines: Option<usize>,
) -> Result<MissionLogTail, String> {
    read_mission_log_tail(&invocation_id, max_lines.unwrap_or(160).clamp(1, 1000))
}

/// IPC owns values before offloading; synchronous Rust callers keep their API.
pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn list_ai_missions<R: tauri::Runtime>(
        app: AppHandle<R>,
    ) -> Result<Vec<MissionRecord>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            if let Ok(dir) = super::mission_dir() {
                PathTransactionLease::test_stage(&[dir], "worker:list_ai_missions");
            }
            super::list_ai_missions(app)
        })
        .await
        .map_err(|err| format!("list_ai_missions_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn stop_ai_mission<R: tauri::Runtime>(
        app: AppHandle<R>,
        invocation_id: String,
    ) -> Result<MissionRecord, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            if let Ok(paths) = super::mission_mutation_paths(&invocation_id) {
                PathTransactionLease::test_stage(&paths, "worker:stop_ai_mission");
            }
            super::stop_ai_mission(app, invocation_id)
        })
        .await
        .map_err(|err| format!("stop_ai_mission_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn read_ai_mission_log(
        invocation_id: String,
        max_lines: Option<usize>,
    ) -> Result<MissionLogTail, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            if let Ok(path) = super::mission_log_path(&invocation_id) {
                PathTransactionLease::test_stage(&[path], "worker:read_ai_mission_log");
            }
            super::read_ai_mission_log(invocation_id, max_lines)
        })
        .await
        .map_err(|err| format!("read_ai_mission_log_task_failed: {err}"))?
    }
}

#[allow(dead_code)]
pub fn register_mission(app: &AppHandle, id: &str, kind: &str, pid: u32) -> Result<(), String> {
    register_mission_with_metadata(app, id, kind, pid, None)
}

pub fn register_mission_with_metadata<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    kind: &str,
    pid: u32,
    metadata: Option<JsonValue>,
) -> Result<(), String> {
    let state = app.state::<MissionState>();
    let record = state.start(id, kind, pid, metadata)?;
    emit_update(app, &record);
    spawn_idle_watch(app.clone(), id.to_string());
    Ok(())
}

/// Register a "logical" mission that has no single backing OS pid (e.g. the
/// structured loop, which spawns many short-lived child processes in sequence).
/// `stop_ai_mission` returns `mission_not_running` for it instead of signalling
/// an unrelated process. The mission still appears in the list, accumulates a
/// log, and advances through finish/fail like any other.
pub fn register_mission_logical<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    kind: &str,
    metadata: Option<JsonValue>,
) -> Result<(), String> {
    let state = app.state::<MissionState>();
    let record = state.start_logical(id, kind, metadata)?;
    emit_update(app, &record);
    spawn_idle_watch(app.clone(), id.to_string());
    Ok(())
}

pub fn touch_output<R: tauri::Runtime>(app: &AppHandle<R>, id: &str, stream: &str, line: &str) {
    let state = app.state::<MissionState>();
    if let Ok(record) = state.touch(id, stream, line) {
        emit_update(app, &record);
    }
}

pub fn finish_mission<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    exit_code: Option<i32>,
    success: bool,
) {
    let state = app.state::<MissionState>();
    if let Ok(record) = state.finish(id, exit_code, success) {
        emit_update(app, &record);
    }
}

pub fn fail_mission<R: tauri::Runtime>(app: &AppHandle<R>, id: &str, message: &str) {
    let state = app.state::<MissionState>();
    if let Ok(record) = state.fail(id, message) {
        emit_update(app, &record);
    }
}

pub(crate) fn register_mission_with_metadata_in_transaction<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    kind: &str,
    pid: u32,
    metadata: Option<JsonValue>,
    lease: &PathTransactionLease,
) -> Result<(), String> {
    let record = app
        .state::<MissionState>()
        .start_in_transaction(id, kind, pid, metadata, lease)?;
    emit_update(app, &record);
    spawn_idle_watch(app.clone(), id.to_string());
    Ok(())
}

pub(crate) fn touch_output_in_transaction<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    stream: &str,
    line: &str,
    lease: &PathTransactionLease,
) -> Result<(), String> {
    let record = app
        .state::<MissionState>()
        .touch_in_transaction(id, stream, line, lease)?;
    emit_update(app, &record);
    Ok(())
}

pub(crate) fn finish_mission_in_transaction<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    exit_code: Option<i32>,
    success: bool,
    lease: &PathTransactionLease,
) -> Result<(), String> {
    let record = app
        .state::<MissionState>()
        .finish_in_transaction(id, exit_code, success, lease)?;
    emit_update(app, &record);
    Ok(())
}

pub(crate) fn fail_mission_in_transaction<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    message: &str,
    lease: &PathTransactionLease,
) -> Result<(), String> {
    let record = app
        .state::<MissionState>()
        .fail_in_transaction(id, message, lease)?;
    emit_update(app, &record);
    Ok(())
}

impl MissionState {
    fn start(
        &self,
        id: &str,
        kind: &str,
        pid: u32,
        metadata: Option<JsonValue>,
    ) -> Result<MissionRecord, String> {
        mission_transaction(id, |lease| {
            self.start_in_transaction(id, kind, pid, metadata, lease)
        })
    }

    fn start_in_transaction(
        &self,
        id: &str,
        kind: &str,
        pid: u32,
        metadata: Option<JsonValue>,
        lease: &PathTransactionLease,
    ) -> Result<MissionRecord, String> {
        check_mission_lease(id, lease)?;
        let now = Utc::now().to_rfc3339();
        let log_path = mission_log_path(id)?;
        let record = MissionRecord {
            id: id.to_string(),
            kind: kind.to_string(),
            started_at: now.clone(),
            last_output_at: now,
            status: MissionStatus::Running,
            exit_code: None,
            output_log_path: Some(log_path.to_string_lossy().to_string()),
            metadata,
        };
        self.pids
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?
            .insert(id.to_string(), pid);
        self.store_record_in_transaction(record.clone(), lease)?;
        Ok(record)
    }

    fn start_logical(
        &self,
        id: &str,
        kind: &str,
        metadata: Option<JsonValue>,
    ) -> Result<MissionRecord, String> {
        mission_transaction(id, |lease| {
            self.start_logical_in_transaction(id, kind, metadata, lease)
        })
    }

    fn start_logical_in_transaction(
        &self,
        id: &str,
        kind: &str,
        metadata: Option<JsonValue>,
        lease: &PathTransactionLease,
    ) -> Result<MissionRecord, String> {
        check_mission_lease(id, lease)?;
        let now = Utc::now().to_rfc3339();
        let log_path = mission_log_path(id)?;
        let record = MissionRecord {
            id: id.to_string(),
            kind: kind.to_string(),
            started_at: now.clone(),
            last_output_at: now,
            status: MissionStatus::Running,
            exit_code: None,
            output_log_path: Some(log_path.to_string_lossy().to_string()),
            metadata,
        };
        // Intentionally no pid registered — see `register_mission_logical`.
        self.store_record_in_transaction(record.clone(), lease)?;
        Ok(record)
    }

    fn touch(&self, id: &str, stream: &str, line: &str) -> Result<MissionRecord, String> {
        mission_transaction(id, |lease| {
            self.touch_in_transaction(id, stream, line, lease)
        })
    }

    fn touch_in_transaction(
        &self,
        id: &str,
        stream: &str,
        line: &str,
        lease: &PathTransactionLease,
    ) -> Result<MissionRecord, String> {
        check_mission_lease(id, lease)?;
        append_output_in_transaction(id, stream, line, lease)?;
        let mut missions = self
            .missions
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?;
        let Some(record) = missions.get_mut(id) else {
            return Err("mission_not_found".to_string());
        };
        record.last_output_at = Utc::now().to_rfc3339();
        if record.status == MissionStatus::Idle {
            record.status = MissionStatus::Running;
        }
        let record = record.clone();
        drop(missions);
        persist_record_in_transaction(&record, lease)?;
        Ok(record)
    }

    fn finish(
        &self,
        id: &str,
        exit_code: Option<i32>,
        success: bool,
    ) -> Result<MissionRecord, String> {
        mission_transaction(id, |lease| {
            self.finish_in_transaction(id, exit_code, success, lease)
        })
    }

    fn finish_in_transaction(
        &self,
        id: &str,
        exit_code: Option<i32>,
        success: bool,
        lease: &PathTransactionLease,
    ) -> Result<MissionRecord, String> {
        check_mission_lease(id, lease)?;
        self.pids
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?
            .remove(id);
        let mut missions = self
            .missions
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?;
        let Some(record) = missions.get_mut(id) else {
            return Err("mission_not_found".to_string());
        };
        if record.status != MissionStatus::Stopped {
            record.status = if success {
                MissionStatus::Done
            } else {
                MissionStatus::Failed
            };
        }
        record.exit_code = exit_code;
        let record = record.clone();
        drop(missions);
        persist_record_in_transaction(&record, lease)?;
        Ok(record)
    }

    fn fail(&self, id: &str, message: &str) -> Result<MissionRecord, String> {
        mission_transaction(id, |lease| self.fail_in_transaction(id, message, lease))
    }

    fn fail_in_transaction(
        &self,
        id: &str,
        message: &str,
        lease: &PathTransactionLease,
    ) -> Result<MissionRecord, String> {
        check_mission_lease(id, lease)?;
        append_output_in_transaction(id, "error", message, lease)?;
        self.finish_in_transaction(id, None, false, lease)
    }

    fn stop<R: tauri::Runtime>(
        &self,
        app: AppHandle<R>,
        id: &str,
    ) -> Result<MissionRecord, String> {
        // This lookup is bookkeeping only, released before waiting for either
        // admission or the owner's finite callback serialization guard.
        let execution = self
            .execution_leases
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?
            .get(id)
            .and_then(|(lease, serial)| Some((lease.upgrade()?, serial.upgrade()?)));
        if let Some((lease, serial)) = execution {
            let _guard = serial
                .lock()
                .map_err(|_| "mission_state_poisoned".to_string())?;
            self.stop_in_transaction(app, id, &lease)
        } else {
            mission_transaction(id, |lease| self.stop_in_transaction(app, id, lease))
        }
    }

    fn stop_in_transaction<R: tauri::Runtime>(
        &self,
        app: AppHandle<R>,
        id: &str,
        lease: &PathTransactionLease,
    ) -> Result<MissionRecord, String> {
        check_mission_lease(id, lease)?;
        let pid = self
            .pids
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?
            .get(id)
            .copied()
            .ok_or_else(|| "mission_not_running".to_string())?;
        kill_pid(pid, false)?;
        let id_for_force = id.to_string();
        thread::spawn(move || {
            thread::sleep(StdDuration::from_secs(2));
            let state = app.state::<MissionState>();
            let still_registered = state
                .pids
                .lock()
                .ok()
                .and_then(|pids| pids.get(&id_for_force).copied())
                == Some(pid);
            if still_registered {
                let _ = kill_pid(pid, true);
            }
        });

        let mut missions = self
            .missions
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?;
        let Some(record) = missions.get_mut(id) else {
            return Err("mission_not_found".to_string());
        };
        record.status = MissionStatus::Stopped;
        let record = record.clone();
        drop(missions);
        persist_record_in_transaction(&record, lease)?;
        Ok(record)
    }

    fn list(&self) -> Result<Vec<MissionRecord>, String> {
        self.hydrate_from_disk()?;
        let mut records: Vec<_> = self
            .missions
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?
            .values()
            .cloned()
            .collect();
        records.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(records)
    }

    fn hydrate_from_disk(&self) -> Result<(), String> {
        with_path_transactions(
            PathTransactionRequest::new(vec![mission_dir()?])?,
            |lease| self.hydrate_from_disk_in_transaction(lease),
        )
    }

    fn hydrate_from_disk_in_transaction(&self, lease: &PathTransactionLease) -> Result<(), String> {
        lease.ensure_covered(vec![mission_dir()?])?;
        lease.before_effect()?;
        let dir = mission_dir()?;
        if !dir.is_dir() {
            return Ok(());
        }
        let pids = self
            .pids
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?
            .clone();
        let mut missions = self
            .missions
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?;
        for entry in fs::read_dir(&dir)
            .map_err(|err| format!("Cannot read mission state directory: {err}"))?
        {
            let entry = entry.map_err(|err| format!("Cannot read mission state: {err}"))?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let raw = fs::read_to_string(&path)
                .map_err(|err| format!("Cannot read mission state: {err}"))?;
            let mut record: MissionRecord = serde_json::from_str(&raw)
                .map_err(|err| format!("Cannot parse mission state: {err}"))?;
            if missions.contains_key(&record.id) {
                continue;
            }
            if matches!(record.status, MissionStatus::Running | MissionStatus::Idle)
                && !pids.contains_key(&record.id)
            {
                record.status = MissionStatus::Stopped;
                let _ = persist_record_in_transaction(&record, lease);
            }
            missions.insert(record.id.clone(), record);
        }
        Ok(())
    }

    #[cfg(test)]
    fn mark_idle_if_stale(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<MissionRecord>, String> {
        mission_transaction(id, |lease| {
            self.mark_idle_if_stale_in_transaction(id, now, lease)
        })
    }

    fn mark_idle_if_stale_in_transaction(
        &self,
        id: &str,
        now: DateTime<Utc>,
        lease: &PathTransactionLease,
    ) -> Result<Option<MissionRecord>, String> {
        check_mission_lease(id, lease)?;
        let mut missions = self
            .missions
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?;
        let Some(record) = missions.get_mut(id) else {
            return Ok(None);
        };
        if record.status != MissionStatus::Running {
            return Ok(None);
        }
        let last = DateTime::parse_from_rfc3339(&record.last_output_at)
            .map_err(|err| format!("mission_time_parse_failed: {err}"))?
            .with_timezone(&Utc);
        if now.signed_duration_since(last) < Duration::seconds(IDLE_AFTER_SECONDS) {
            return Ok(None);
        }
        record.status = MissionStatus::Idle;
        let record = record.clone();
        drop(missions);
        persist_record_in_transaction(&record, lease)?;
        Ok(Some(record))
    }

    fn store_record_in_transaction(
        &self,
        record: MissionRecord,
        lease: &PathTransactionLease,
    ) -> Result<(), String> {
        check_mission_lease(&record.id, lease)?;
        persist_record_in_transaction(&record, lease)?;
        self.missions
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?
            .insert(record.id.clone(), record);
        Ok(())
    }
}

fn spawn_idle_watch<R: tauri::Runtime>(app: AppHandle<R>, id: String) {
    let Ok(parent) = mission_parent_snapshot() else {
        return;
    };
    thread::spawn(move || loop {
        thread::sleep(StdDuration::from_secs(5));
        let state = app.state::<MissionState>();
        let result = (|| {
            let request = PathTransactionRequest::new(mission_mutation_paths(&id)?)?
                .require_parent_snapshot(&parent)?;
            with_path_transactions(request, |lease| {
                state.mark_idle_if_stale_in_transaction(&id, Utc::now(), lease)
            })
        })();
        match result {
            Ok(Some(record)) => {
                let _ = app.emit("ai://idle", &record);
                emit_update(&app, &record);
            }
            Ok(None) => {
                let done = state
                    .missions
                    .lock()
                    .ok()
                    .and_then(|missions| missions.get(&id).map(|record| record.status.clone()))
                    .map(|status| !matches!(status, MissionStatus::Running | MissionStatus::Idle))
                    .unwrap_or(true);
                if done {
                    break;
                }
            }
            Err(_) => break,
        }
    });
}

fn emit_update<R: tauri::Runtime>(app: &AppHandle<R>, record: &MissionRecord) {
    let _ = app.emit("ai://mission_update", record);
}

pub(crate) fn mission_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("MARU_MISSION_STATE_DIR") {
        if !dir.trim().is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    Ok(crate::skill_host::fs::maru_home()?
        .join("state")
        .join("missions"))
}

fn mission_json_path(id: &str) -> Result<PathBuf, String> {
    validate_mission_id(id)?;
    Ok(mission_dir()?.join(format!("{id}.json")))
}

fn mission_log_path(id: &str) -> Result<PathBuf, String> {
    validate_mission_id(id)?;
    Ok(mission_dir()?.join(format!("{id}.log")))
}

fn validate_mission_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("mission_id_invalid".to_string());
    }
    Ok(())
}

fn read_mission_log_tail(id: &str, max_lines: usize) -> Result<MissionLogTail, String> {
    validate_mission_id(id)?;
    let path = mission_log_path(id)?;
    if !path.exists() {
        return Ok(MissionLogTail {
            invocation_id: id.to_string(),
            lines: Vec::new(),
        });
    }
    let raw = fs::read_to_string(&path).map_err(|err| format!("Cannot read mission log: {err}"))?;
    let mut lines = raw.lines().map(str::to_string).collect::<Vec<_>>();
    if lines.len() > max_lines {
        lines = lines.split_off(lines.len() - max_lines);
    }
    Ok(MissionLogTail {
        invocation_id: id.to_string(),
        lines,
    })
}

fn persist_record_in_transaction(
    record: &MissionRecord,
    lease: &PathTransactionLease,
) -> Result<(), String> {
    check_mission_lease(&record.id, lease)?;
    let path = mission_json_path(&record.id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create mission state directory: {err}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(record)
        .map_err(|err| format!("Cannot serialize mission state: {err}"))?;
    fs::write(&tmp, json).map_err(|err| format!("Cannot write mission state: {err}"))?;
    fs::rename(&tmp, &path).map_err(|err| format!("Cannot finalize mission state: {err}"))
}

#[cfg(test)]
fn append_output(id: &str, stream: &str, line: &str) -> Result<(), String> {
    mission_transaction(id, |lease| {
        append_output_in_transaction(id, stream, line, lease)
    })
}

fn append_output_in_transaction(
    id: &str,
    stream: &str,
    line: &str,
    lease: &PathTransactionLease,
) -> Result<(), String> {
    check_mission_lease(id, lease)?;
    let path = mission_log_path(id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create mission log directory: {err}"))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| format!("Cannot open mission log: {err}"))?;
    writeln!(file, "[{}] {}", stream, line)
        .map_err(|err| format!("Cannot write mission log: {err}"))
}

fn kill_pid(pid: u32, force: bool) -> Result<(), String> {
    #[cfg(unix)]
    {
        let signal = if force { "-KILL" } else { "-TERM" };
        let status = Command::new("kill")
            .args([signal, &pid.to_string()])
            .status()
            .map_err(|err| format!("mission_stop_failed: {err}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("mission_stop_failed: pid {pid}"))
        }
    }
    #[cfg(windows)]
    {
        let mut args = vec!["/PID".to_string(), pid.to_string()];
        if force {
            args.push("/F".to_string());
        }
        let status = Command::new("taskkill")
            .args(args)
            .no_window()
            .status()
            .map_err(|err| format!("mission_stop_failed: {err}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("mission_stop_failed: pid {pid}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_env_lock() -> std::sync::MutexGuard<'static, ()> {
        crate::skill_host::fs::test_maru_home_lock()
    }

    #[test]
    fn idle_transition_marks_stale_running_record() {
        let _guard = test_env_lock();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("MARU_MISSION_STATE_DIR", tmp.path());
        let state = MissionState::default();
        let id = "ai-test-idle";
        state.start(id, "test", 999_999, None).unwrap();
        {
            let mut missions = state.missions.lock().unwrap();
            let record = missions.get_mut(id).unwrap();
            record.last_output_at = (Utc::now() - Duration::seconds(61)).to_rfc3339();
        }
        let changed = state.mark_idle_if_stale(id, Utc::now()).unwrap().unwrap();
        assert_eq!(changed.status, MissionStatus::Idle);
        state.pids.lock().unwrap().clear();
        std::env::remove_var("MARU_MISSION_STATE_DIR");
    }

    #[test]
    fn finish_keeps_stopped_status() {
        let _guard = test_env_lock();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("MARU_MISSION_STATE_DIR", tmp.path());
        let state = MissionState::default();
        let id = "ai-test-stopped";
        state.start(id, "test", 999_999, None).unwrap();
        {
            let mut missions = state.missions.lock().unwrap();
            missions.get_mut(id).unwrap().status = MissionStatus::Stopped;
        }
        let done = state.finish(id, Some(143), false).unwrap();
        assert_eq!(done.status, MissionStatus::Stopped);
        assert_eq!(done.exit_code, Some(143));
        state.pids.lock().unwrap().clear();
        std::env::remove_var("MARU_MISSION_STATE_DIR");
    }

    #[test]
    fn list_sorts_newest_first() {
        let _guard = test_env_lock();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("MARU_MISSION_STATE_DIR", tmp.path());
        let state = MissionState::default();
        state.start("ai-old", "test", 999_998, None).unwrap();
        state.start("ai-new", "test", 999_999, None).unwrap();
        let records = state.list().unwrap();
        assert_eq!(records[0].id, "ai-new");
        state.pids.lock().unwrap().clear();
        std::env::remove_var("MARU_MISSION_STATE_DIR");
    }

    #[test]
    fn metadata_persists_and_log_tail_reads_recent_lines() {
        let _guard = test_env_lock();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("MARU_MISSION_STATE_DIR", tmp.path());
        let state = MissionState::default();
        let id = "ai-test-meta";
        state
            .start(
                id,
                "skill",
                999_999,
                Some(serde_json::json!({
                    "origin": "inboxProcess",
                    "channel": "kakao",
                })),
            )
            .unwrap();
        let records = state.list().unwrap();
        assert_eq!(
            records[0].metadata.as_ref().unwrap()["origin"],
            "inboxProcess"
        );

        append_output(id, "stdout", "one").unwrap();
        append_output(id, "stdout", "two").unwrap();
        let tail = read_mission_log_tail(id, 1).unwrap();
        assert_eq!(tail.lines, vec!["[stdout] two"]);
        state.pids.lock().unwrap().clear();
        std::env::remove_var("MARU_MISSION_STATE_DIR");
    }
}

#[cfg(all(test, unix))]
mod phase08_29_dispatch_missions {
    use super::*;
    use crate::atomic_file::phase08_06::Home;

    #[test]
    fn phase08_29_dispatch_stop_reuses_owned_child_lease_without_waiting_for_exit() {
        let _home = Home::new();
        let app = tauri::test::mock_app();
        app.manage(MissionState::default());
        let id = "owned-stop";
        let lease = Arc::new(
            PathTransactionRequest::new(mission_mutation_paths(id).unwrap())
                .unwrap()
                .acquire()
                .unwrap(),
        );
        let serial = Arc::new(Mutex::new(()));
        let mut child = Command::new("sleep").arg("10").spawn().unwrap();
        let pid = child.id();
        bind_execution_lease(app.handle(), id, &lease, &serial).unwrap();
        app.state::<MissionState>()
            .start_in_transaction(id, "fixture", pid, None, &lease)
            .unwrap();
        let handle = app.handle().clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            let result = handle.state::<MissionState>().stop(handle.clone(), id);
            let _ = tx.send(result);
        });
        let stopped = rx.recv_timeout(StdDuration::from_secs(2));
        // Reap the fixture even on assertion failure; never leave a real pid in
        // the test MissionState's drop handler.
        let _ = child.kill();
        let _ = child.wait();
        app.state::<MissionState>().pids.lock().unwrap().clear();
        drop(lease);
        let record = stopped
            .expect("stop must borrow the child transaction")
            .unwrap();
        worker.join().unwrap();
        assert_eq!(record.status, MissionStatus::Stopped);
    }
}

#[cfg(test)]
mod phase08_16 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use crate::workspace_files::{ipc as files_ipc, phase08_06::TrashFixture};
    use std::fs;
    use std::sync::mpsc;
    use std::time::Duration;

    fn text(path: &std::path::Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn start<F>(future: F) -> mpsc::Receiver<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }

    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("mission fixture completion")
    }

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(MissionState::default());
        app
    }

    /// Register a real short-lived child so stop exercises the actual kill
    /// path; the caller must reap or stop it before the state drops.
    fn spawn_sleep() -> std::process::Child {
        Command::new("sleep").arg("30").spawn().unwrap()
    }

    #[test]
    fn phase08_16_missions_all_wrappers_round_trip_and_legacy_rejections() {
        let _home = Home::new();
        let app = app();
        let state = app.state::<MissionState>();
        let handle = app.handle().clone();

        let listed = run(ipc::list_ai_missions(handle.clone())).unwrap();
        assert!(listed.is_empty());

        let mut child = spawn_sleep();
        let pid = child.id();
        register_mission_with_metadata(&handle, "ai-fixture-run", "claude", pid, None).unwrap();
        append_output("ai-fixture-run", "stdout", "fixture output line").unwrap();

        let listed = run(ipc::list_ai_missions(handle.clone())).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "ai-fixture-run");
        assert_eq!(listed[0].status, MissionStatus::Running);

        let tail = run(ipc::read_ai_mission_log("ai-fixture-run".into(), Some(10))).unwrap();
        assert_eq!(tail.invocation_id, "ai-fixture-run");
        assert_eq!(tail.lines, vec!["[stdout] fixture output line"]);

        let stopped = run(ipc::stop_ai_mission(
            handle.clone(),
            "ai-fixture-run".into(),
        ))
        .unwrap();
        assert_eq!(stopped.status, MissionStatus::Stopped);
        let _ = child.wait();

        assert_eq!(
            run(ipc::read_ai_mission_log("bad id!".into(), None)).unwrap_err(),
            "mission_id_invalid"
        );
        assert_eq!(
            run(ipc::stop_ai_mission(handle, "ai-not-running".into())).unwrap_err(),
            "mission_not_running"
        );
        state.pids.lock().unwrap().clear();
    }

    #[test]
    fn phase08_16_missions_each_wrapper_yields_same_poll_and_maps_join_failure() {
        let _home = Home::new();
        let app = app();
        let handle = app.handle().clone();
        let dir = mission_dir().unwrap();
        boundary(
            dir,
            "list_ai_missions",
            ipc::list_ai_missions(handle.clone()),
        );
        let paths = mission_mutation_paths("ai-yield-stop").unwrap();
        boundary(
            paths[1].clone(),
            "stop_ai_mission",
            ipc::stop_ai_mission(handle.clone(), "ai-yield-stop".into()),
        );
        boundary(
            paths[2].clone(),
            "read_ai_mission_log",
            ipc::read_ai_mission_log("ai-yield-stop".into(), Some(5)),
        );
        app.state::<MissionState>().pids.lock().unwrap().clear();
    }

    #[cfg(unix)]
    #[test]
    fn phase08_16_missions_files_parent_both_orders_and_aliases_no_recreation() {
        let _home = Home::new();
        let root = maru_root();
        fs::create_dir_all(&root).unwrap();
        for parent in ["rename", "trash"] {
            for parent_first in [false, true] {
                for alias in [false, true] {
                    if alias && parent == "trash" {
                        continue;
                    }
                    let fixture = tempfile::tempdir_in(&root).unwrap();
                    let fixture_root = fixture.path();
                    let state_dir = fixture_root.join("state");
                    fs::create_dir_all(&state_dir).unwrap();
                    std::env::set_var("MARU_MISSION_STATE_DIR", &state_dir);
                    let external = fixture_root.join("external");
                    fs::create_dir(&external).unwrap();
                    let (selected, key) = if alias {
                        fs::remove_dir(&state_dir).unwrap();
                        std::os::unix::fs::symlink(&external, &state_dir).unwrap();
                        (external.clone(), state_dir.join("ai-fixture.json"))
                    } else {
                        (state_dir.clone(), state_dir.join("ai-fixture.json"))
                    };
                    let app = app();
                    let handle = app.handle().clone();
                    let vault = text(fixture_root);
                    let trash_target = fixture_root.join("trash-target");
                    let selected_for_parent = selected.clone();
                    let trash_target_for_parent = trash_target.clone();
                    let parent_future = async move {
                        if parent == "rename" {
                            files_ipc::rename_workspace_entry(
                                vault,
                                text(&selected_for_parent),
                                "moved".into(),
                            )
                            .await
                            .map(|outcome| assert!(outcome.error.is_none()))
                        } else {
                            let _trash = TrashFixture::new(
                                selected_for_parent.clone(),
                                trash_target_for_parent.clone(),
                            );
                            files_ipc::trash_workspace_entries(
                                vault,
                                vec![text(&selected_for_parent)],
                            )
                            .await
                            .map(|outcomes| assert!(outcomes[0].error.is_none()))
                        }
                    };
                    let mut child = spawn_sleep();
                    let pid = child.id();
                    register_mission_with_metadata(&handle, "ai-fixture", "claude", pid, None)
                        .unwrap();
                    let stop_future =
                        async move { ipc::stop_ai_mission(handle, "ai-fixture".into()).await };
                    if parent_first {
                        let held = Held::new(selected.clone(), "pre-effect");
                        let p = start(parent_future);
                        held.wait();
                        let waiting = Held::new(key.clone(), "before-admission");
                        let c = start(stop_future);
                        waiting.wait();
                        waiting.release();
                        assert!(c.recv_timeout(Duration::from_millis(20)).is_err());
                        held.release();
                        done(p).unwrap();
                        assert!(
                            done(c).is_err(),
                            "{parent}/{alias}: renamed original parent must fail revalidation"
                        );
                    } else {
                        let held = Held::new(key.clone(), "pre-effect");
                        let c = start(stop_future);
                        held.wait();
                        let waiting = Held::new(selected.clone(), "before-admission");
                        let p = start(parent_future);
                        waiting.wait();
                        waiting.release();
                        assert!(p.recv_timeout(Duration::from_millis(20)).is_err());
                        held.release();
                        let record = done(c).unwrap();
                        assert_eq!(record.status, MissionStatus::Stopped);
                        done(p).unwrap();
                        let moved = if parent == "rename" {
                            fixture_root.join("moved")
                        } else {
                            trash_target.clone()
                        };
                        assert!(moved.join("ai-fixture.json").is_file(), "{parent}/{alias}");
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    app.state::<MissionState>().pids.lock().unwrap().clear();
                    std::env::remove_var("MARU_MISSION_STATE_DIR");
                    assert!(
                        !selected.exists(),
                        "{parent}/{alias}: original mission parent recreated"
                    );
                }
            }
        }
    }

    fn maru_root() -> std::path::PathBuf {
        mission_dir()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf()
    }

    #[test]
    fn phase08_16_missions_error_and_unwind_release_admission() {
        let _home = Home::new();
        let app = app();
        let handle = app.handle().clone();
        let key = mission_mutation_paths("ai-release").unwrap()[1].clone();

        // mission_not_running after admission releases: a competitor rename of
        // the mission parent proceeds and the mission file is not recreated.
        assert_eq!(
            run(ipc::stop_ai_mission(handle.clone(), "ai-release".into())).unwrap_err(),
            "mission_not_running"
        );
        let dir = mission_dir().unwrap();
        fs::create_dir_all(&dir).unwrap();
        let root = dir.parent().unwrap().parent().unwrap().to_path_buf();
        run(files_ipc::rename_workspace_entry(
            text(&root),
            "state".into(),
            "state-moved".into(),
        ))
        .unwrap();
        assert!(root.join("state-moved/missions").is_dir());
        fs::rename(root.join("state-moved"), root.join("state")).unwrap();

        // An unwinding worker releases the admitted set.
        {
            let _panic = PathTransactionTestHook::new(key, "pre-effect", || {
                panic!("fixture mission transaction unwind")
            });
            assert!(
                run(ipc::stop_ai_mission(handle.clone(), "ai-release".into()))
                    .unwrap_err()
                    .starts_with("stop_ai_mission_task_failed:")
            );
        }
        assert_eq!(
            run(ipc::stop_ai_mission(handle, "ai-release".into())).unwrap_err(),
            "mission_not_running"
        );
        app.state::<MissionState>().pids.lock().unwrap().clear();
    }
}
