use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::Duration as StdDuration;
use tauri::{AppHandle, Emitter, Manager};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MissionRecord {
    pub id: String,
    pub kind: String,
    pub started_at: String,
    pub last_output_at: String,
    pub status: MissionStatus,
    pub exit_code: Option<i32>,
    pub output_log_path: Option<String>,
}

#[derive(Debug, Default)]
pub struct MissionState {
    missions: Mutex<HashMap<String, MissionRecord>>,
    pids: Mutex<HashMap<String, u32>>,
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

#[tauri::command]
pub fn list_ai_missions(app: AppHandle) -> Result<Vec<MissionRecord>, String> {
    let state = app.state::<MissionState>();
    state.list()
}

#[tauri::command]
pub fn stop_ai_mission(app: AppHandle, invocation_id: String) -> Result<MissionRecord, String> {
    let state = app.state::<MissionState>();
    let record = state.stop(app.clone(), &invocation_id)?;
    emit_update(&app, &record);
    Ok(record)
}

pub fn register_mission(app: &AppHandle, id: &str, kind: &str, pid: u32) -> Result<(), String> {
    let state = app.state::<MissionState>();
    let record = state.start(id, kind, pid)?;
    emit_update(app, &record);
    spawn_idle_watch(app.clone(), id.to_string());
    Ok(())
}

pub fn touch_output(app: &AppHandle, id: &str, stream: &str, line: &str) {
    let state = app.state::<MissionState>();
    if let Ok(record) = state.touch(id, stream, line) {
        emit_update(app, &record);
    }
}

pub fn finish_mission(app: &AppHandle, id: &str, exit_code: Option<i32>, success: bool) {
    let state = app.state::<MissionState>();
    if let Ok(record) = state.finish(id, exit_code, success) {
        emit_update(app, &record);
    }
}

pub fn fail_mission(app: &AppHandle, id: &str, message: &str) {
    let state = app.state::<MissionState>();
    if let Ok(record) = state.fail(id, message) {
        emit_update(app, &record);
    }
}

impl MissionState {
    fn start(&self, id: &str, kind: &str, pid: u32) -> Result<MissionRecord, String> {
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
        };
        self.pids
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?
            .insert(id.to_string(), pid);
        self.store_record(record.clone())?;
        Ok(record)
    }

    fn touch(&self, id: &str, stream: &str, line: &str) -> Result<MissionRecord, String> {
        append_output(id, stream, line)?;
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
        persist_record(&record)?;
        Ok(record)
    }

    fn finish(
        &self,
        id: &str,
        exit_code: Option<i32>,
        success: bool,
    ) -> Result<MissionRecord, String> {
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
        persist_record(&record)?;
        Ok(record)
    }

    fn fail(&self, id: &str, message: &str) -> Result<MissionRecord, String> {
        append_output(id, "error", message)?;
        self.finish(id, None, false)
    }

    fn stop(&self, app: AppHandle, id: &str) -> Result<MissionRecord, String> {
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
        persist_record(&record)?;
        Ok(record)
    }

    fn list(&self) -> Result<Vec<MissionRecord>, String> {
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

    fn mark_idle_if_stale(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<MissionRecord>, String> {
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
        persist_record(&record)?;
        Ok(Some(record))
    }

    fn store_record(&self, record: MissionRecord) -> Result<(), String> {
        persist_record(&record)?;
        self.missions
            .lock()
            .map_err(|_| "mission_state_poisoned".to_string())?
            .insert(record.id.clone(), record);
        Ok(())
    }
}

fn spawn_idle_watch(app: AppHandle, id: String) {
    thread::spawn(move || loop {
        thread::sleep(StdDuration::from_secs(5));
        let state = app.state::<MissionState>();
        match state.mark_idle_if_stale(&id, Utc::now()) {
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

fn emit_update(app: &AppHandle, record: &MissionRecord) {
    let _ = app.emit("ai://mission_update", record);
}

fn mission_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("ANCHOR_MISSION_STATE_DIR") {
        if !dir.trim().is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    let home = dirs::home_dir().ok_or_else(|| "Cannot resolve home directory".to_string())?;
    Ok(home.join(".anchor").join("state").join("missions"))
}

fn mission_json_path(id: &str) -> Result<PathBuf, String> {
    Ok(mission_dir()?.join(format!("{id}.json")))
}

fn mission_log_path(id: &str) -> Result<PathBuf, String> {
    Ok(mission_dir()?.join(format!("{id}.log")))
}

fn persist_record(record: &MissionRecord) -> Result<(), String> {
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

fn append_output(id: &str, stream: &str, line: &str) -> Result<(), String> {
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
    use std::sync::{Mutex as TestMutex, OnceLock};
    use tempfile::TempDir;

    fn test_env_lock() -> &'static TestMutex<()> {
        static LOCK: OnceLock<TestMutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| TestMutex::new(()))
    }

    #[test]
    fn idle_transition_marks_stale_running_record() {
        let _guard = test_env_lock().lock().unwrap();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("ANCHOR_MISSION_STATE_DIR", tmp.path());
        let state = MissionState::default();
        let id = "ai-test-idle";
        state.start(id, "test", 999_999).unwrap();
        {
            let mut missions = state.missions.lock().unwrap();
            let record = missions.get_mut(id).unwrap();
            record.last_output_at = (Utc::now() - Duration::seconds(61)).to_rfc3339();
        }
        let changed = state.mark_idle_if_stale(id, Utc::now()).unwrap().unwrap();
        assert_eq!(changed.status, MissionStatus::Idle);
        state.pids.lock().unwrap().clear();
        std::env::remove_var("ANCHOR_MISSION_STATE_DIR");
    }

    #[test]
    fn finish_keeps_stopped_status() {
        let _guard = test_env_lock().lock().unwrap();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("ANCHOR_MISSION_STATE_DIR", tmp.path());
        let state = MissionState::default();
        let id = "ai-test-stopped";
        state.start(id, "test", 999_999).unwrap();
        {
            let mut missions = state.missions.lock().unwrap();
            missions.get_mut(id).unwrap().status = MissionStatus::Stopped;
        }
        let done = state.finish(id, Some(143), false).unwrap();
        assert_eq!(done.status, MissionStatus::Stopped);
        assert_eq!(done.exit_code, Some(143));
        state.pids.lock().unwrap().clear();
        std::env::remove_var("ANCHOR_MISSION_STATE_DIR");
    }

    #[test]
    fn list_sorts_newest_first() {
        let _guard = test_env_lock().lock().unwrap();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("ANCHOR_MISSION_STATE_DIR", tmp.path());
        let state = MissionState::default();
        state.start("ai-old", "test", 999_998).unwrap();
        state.start("ai-new", "test", 999_999).unwrap();
        let records = state.list().unwrap();
        assert_eq!(records[0].id, "ai-new");
        state.pids.lock().unwrap().clear();
        std::env::remove_var("ANCHOR_MISSION_STATE_DIR");
    }
}
