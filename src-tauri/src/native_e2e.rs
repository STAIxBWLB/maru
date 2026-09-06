//! Phase 08-27 native saturation and source-race harness (PERF-01/PERF-02).
//!
//! Everything in this module compiles only under the default-off `native-e2e`
//! cargo feature (D-10): no runtime override, async probe, or load control
//! exists in a build a user can install. The probe is genuinely async on the
//! same Tauri runtime that serves production commands (never `spawn_blocking`),
//! and the load control holds a deterministic pre-work interval inside the
//! real blocking closures of already-converted commands, so the saturation
//! window overlaps real Git/scan/sync work rather than sleep-only commands.
//!
//! Distinctive marker scanned by scripts/check-native-e2e-isolation.mjs:
//! MARU_NATIVE_RESPONSIVENESS_HOOK

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::paths::{native_e2e_dir_override, NATIVE_E2E_HOME_VAR};

pub const MARU_NATIVE_RESPONSIVENESS_HOOK: &str = "MARU_NATIVE_RESPONSIVENESS_HOOK";
pub const EXPECTED_WORKER_THREADS: usize = 2;
const LOAD_INTERVAL: Duration = Duration::from_millis(2500);
const LOAD_CONTROL_OPS: &[&str] = &["git_status", "scan_vault", "skills_sync_source"];

static INSTALLED_RUNTIME: OnceLock<tauri::async_runtime::TokioRuntime> = OnceLock::new();

/// Installs the saturation runtime before any Tauri runtime initialization:
/// `TokioRuntime::new()` honors `TOKIO_WORKER_THREADS` (the native-e2e
/// launcher sets it to 2 before spawning the app), the observed worker count
/// is asserted so a misconfigured run fails loudly instead of measuring the
/// wrong runtime, and the runtime is stored for the process lifetime while
/// its cloned handle is installed for Tauri. The default build never calls
/// this and keeps Tauri's lazily initialized runtime.
pub fn install_test_runtime() {
    let runtime = tauri::async_runtime::TokioRuntime::new()
        .unwrap_or_else(|err| panic!("native-e2e runtime creation failed: {err}"));
    let workers = runtime_worker_count(&runtime);
    assert_eq!(
        workers, EXPECTED_WORKER_THREADS,
        "native-e2e runtime must run exactly {EXPECTED_WORKER_THREADS} workers (set TOKIO_WORKER_THREADS=2 before app spawn); observed {workers}"
    );
    INSTALLED_RUNTIME
        .set(runtime)
        .unwrap_or_else(|_| panic!("native-e2e runtime installed twice"));
    let runtime = INSTALLED_RUNTIME.get().expect("native-e2e runtime missing");
    tauri::async_runtime::set(runtime.handle().clone());
}

fn runtime_worker_count(runtime: &tauri::async_runtime::TokioRuntime) -> usize {
    runtime.handle().metrics().num_workers()
}

fn installed_worker_count() -> usize {
    tauri::async_runtime::handle()
        .inner()
        .metrics()
        .num_workers()
}

async fn probe_handshake() -> Value {
    let mut yielded = false;
    std::future::poll_fn(|cx| {
        if yielded {
            std::task::Poll::Ready(())
        } else {
            yielded = true;
            cx.waker().wake_by_ref();
            std::task::Poll::Pending
        }
    })
    .await;
    json!({
        "ok": true,
        "yielded": true,
        "workerCount": installed_worker_count(),
        "hook": MARU_NATIVE_RESPONSIVENESS_HOOK,
    })
}

/// Same-runtime async probe: a one-yield `poll_fn` handshake scheduled by the
/// Tauri runtime itself, never `spawn_blocking`. While async workers are
/// stalled (blocking_async control) the probe cannot complete, which is
/// exactly the responsiveness signal the saturation harness measures.
#[tauri::command]
pub async fn native_e2e_async_probe() -> Result<Value, String> {
    Ok(probe_handshake().await)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LoadMode {
    Isolated,
    BlockingAsync,
}

#[derive(Debug)]
struct ArmedControl {
    mode: LoadMode,
    paths: Vec<PathBuf>,
    source_id: Option<String>,
}

#[derive(Default)]
struct LoadControlState {
    epoch: Option<Instant>,
    armed: BTreeMap<String, ArmedControl>,
    active: BTreeMap<String, usize>,
    windows: BTreeMap<String, Vec<(u64, u64)>>,
    totals: BTreeMap<String, u64>,
    max_concurrent: usize,
    changed_source: Option<(String, String)>,
}

static LOAD_CONTROL: OnceLock<Mutex<LoadControlState>> = OnceLock::new();

fn load_control() -> &'static Mutex<LoadControlState> {
    LOAD_CONTROL.get_or_init(Default::default)
}

/// Test-only fixture-root injection so the load-control command tests can
/// run without mutating `MARU_NATIVE_E2E_HOME`, which would race the parallel
/// lib suite (the native override outranks `MARU_TEST_HOME` in
/// `maru_home_dir`). Same seam style as `native_e2e_dir_override`'s
/// `cfg!(test)` escape hatch.
#[cfg(test)]
static TEST_FIXTURE_ROOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[cfg(test)]
fn test_fixture_root() -> Option<PathBuf> {
    TEST_FIXTURE_ROOT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or(None)
}

#[cfg(test)]
fn set_test_fixture_root(path: Option<PathBuf>) {
    *TEST_FIXTURE_ROOT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|err| err.into_inner()) = path;
}

/// Canonical fixture root: the parent of the `MARU_NATIVE_E2E_HOME`
/// directory the native-e2e launcher seeds and exports.
fn fixture_root() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(root) = test_fixture_root() {
        return Ok(root);
    }
    let home = native_e2e_dir_override(NATIVE_E2E_HOME_VAR)?
        .ok_or_else(|| format!("{NATIVE_E2E_HOME_VAR} is not set"))?;
    let home = home
        .canonicalize()
        .map_err(|err| format!("native-e2e home canonicalize failed: {err}"))?;
    home.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "native-e2e home has no parent root".to_string())
}

fn canonical_fixture_path(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("fixture path must be absolute: {raw}"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("fixture path canonicalize failed for {raw}: {err}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("fixture path escapes the native-e2e root: {raw}"));
    }
    Ok(canonical)
}

fn require_fixture_source(root: &Path, source_id: &str) -> Result<(), String> {
    let source = crate::skill_host::store::native_e2e_find_source(source_id)?
        .ok_or_else(|| format!("unknown_source: {source_id}"))?;
    let raw = source
        .path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| format!("source_path_required: {source_id}"))?;
    let canonical = PathBuf::from(raw)
        .canonicalize()
        .map_err(|err| format!("source_path_invalid: {err}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("source_not_fixture_owned: {source_id}"));
    }
    Ok(())
}

fn validate_arm_op(root: &Path, op: &ArmOp) -> Result<ArmedControl, String> {
    if !LOAD_CONTROL_OPS.contains(&op.op.as_str()) {
        return Err(format!("load_control_op_not_allowed: {}", op.op));
    }
    let mut paths = Vec::with_capacity(op.paths.len());
    for raw in &op.paths {
        paths.push(canonical_fixture_path(root, raw)?);
    }
    if op.op == "skills_sync_source" {
        let source_id = op
            .source_id
            .as_deref()
            .ok_or_else(|| "load_control_source_id_required: skills_sync_source".to_string())?;
        require_fixture_source(root, source_id)?;
    }
    Ok(ArmedControl {
        mode: LoadMode::Isolated,
        paths,
        source_id: op.source_id.clone(),
    })
}

struct LoadWindow {
    op: String,
    started: Instant,
}

impl LoadWindow {
    fn begin(op: &str, source: Option<&str>, path: Option<&str>) -> Option<Self> {
        let mut state = load_control().lock().ok()?;
        let control = state.armed.get(op)?;
        if control.mode != LoadMode::Isolated {
            return None;
        }
        // A source-scoped arm (skills_sync_source) windows only calls for
        // that source, so a Sync All over the other sources is not delayed
        // and its busy admission lands while the in-flight sync still holds
        // the lease.
        if control.source_id.is_some() && control.source_id.as_deref() != source {
            return None;
        }
        if let Some(raw) = path {
            let canonical = PathBuf::from(raw).canonicalize().ok()?;
            if !control.paths.iter().any(|armed| armed == &canonical) {
                return None;
            }
        } else if !control.paths.is_empty() {
            return None;
        }
        *state.active.entry(op.to_string()).or_insert(0) += 1;
        let concurrent = state.active.values().sum();
        state.max_concurrent = state.max_concurrent.max(concurrent);
        *state.totals.entry(op.to_string()).or_insert(0) += 1;
        Some(Self {
            op: op.to_string(),
            started: Instant::now(),
        })
    }
}

impl Drop for LoadWindow {
    fn drop(&mut self) {
        if let Ok(mut state) = load_control().lock() {
            if let Some(count) = state.active.get_mut(&self.op) {
                *count = count.saturating_sub(1);
            }
            let epoch = state.epoch.unwrap_or_else(Instant::now);
            let start_ms = self
                .started
                .checked_duration_since(epoch)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let end_ms = Instant::now()
                .checked_duration_since(epoch)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(start_ms);
            state
                .windows
                .entry(self.op.clone())
                .or_default()
                .push((start_ms, end_ms));
        }
    }
}

/// Holds the deterministic pre-work interval inside the real blocking closure
/// of a converted command, then runs the real domain work while the window is
/// still recorded active. A no-op unless the operation was armed in isolated
/// mode for this source (and, for path-taking operations, called with an
/// armed fixture path).
pub fn with_load_control<T>(
    op: &str,
    source: Option<&str>,
    path: Option<&str>,
    work: impl FnOnce() -> T,
) -> T {
    let Some(window) = LoadWindow::begin(op, source, path) else {
        return work();
    };
    std::thread::sleep(LOAD_INTERVAL);
    let result = work();
    drop(window);
    result
}

/// True while the operation is armed in the blocking_async negative-control
/// mode: the caller then runs the same work inline in its async wrapper,
/// deliberately stalling the shared async workers.
pub fn is_blocking_async(op: &str) -> bool {
    load_control()
        .lock()
        .map(|state| {
            state
                .armed
                .get(op)
                .map(|control| control.mode == LoadMode::BlockingAsync)
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

pub fn blocking_async_interval() {
    std::thread::sleep(LOAD_INTERVAL);
}

fn reset_counters() {
    if let Ok(mut state) = load_control().lock() {
        state.active.clear();
        state.windows.clear();
        state.totals.clear();
        state.max_concurrent = 0;
        state.changed_source = None;
    }
}

fn control_status() -> Value {
    let state = match load_control().lock() {
        Ok(state) => state,
        Err(_) => {
            return json!({ "error": "load_control_lock_poisoned" });
        }
    };
    json!({
        "hook": MARU_NATIVE_RESPONSIVENESS_HOOK,
        "workerCount": installed_worker_count(),
        "loadIntervalMs": LOAD_INTERVAL.as_millis(),
        "armed": state.armed.iter().map(|(op, control)| json!({
            "op": op,
            "mode": match control.mode {
                LoadMode::Isolated => "isolated",
                LoadMode::BlockingAsync => "blockingAsync",
            },
            "paths": control.paths.iter().map(|path| path.display().to_string()).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "active": state.active,
        "totals": state.totals,
        "windows": state.windows,
        "maxConcurrent": state.max_concurrent,
        "changedSource": state.changed_source.as_ref().map(|(source_id, _)| source_id.clone()),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArmOp {
    op: String,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    source_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadControlRequest {
    action: String,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    ops: Vec<ArmOp>,
    #[serde(default)]
    source_id: Option<String>,
}

fn arm_load_control(mode: Option<String>, ops: Vec<ArmOp>) -> Result<Value, String> {
    let mode = match mode.as_deref() {
        Some("isolated") => LoadMode::Isolated,
        Some("blockingAsync") | Some("blocking_async") => LoadMode::BlockingAsync,
        _ => return Err("load_control_mode_required: isolated | blockingAsync".to_string()),
    };
    let root = fixture_root()?;
    let mut armed = BTreeMap::new();
    for op in &ops {
        let mut control = validate_arm_op(&root, op)?;
        control.mode = mode;
        armed.insert(op.op.clone(), control);
    }
    {
        let mut state = load_control()
            .lock()
            .map_err(|_| "load_control_lock_poisoned".to_string())?;
        state.epoch = Some(Instant::now());
        for (op, control) in armed {
            state.armed.insert(op, control);
        }
    }
    Ok(control_status())
}

fn change_fixture_source(source_id: Option<String>) -> Result<Value, String> {
    let source_id = source_id.ok_or_else(|| "source_id_required".to_string())?;
    let root = fixture_root()?;
    require_fixture_source(&root, &source_id)?;
    let previous_subdir;
    {
        let mut state = load_control()
            .lock()
            .map_err(|_| "load_control_lock_poisoned".to_string())?;
        if state.changed_source.is_some() {
            return Err("source_change_pending: revert the previous change first".to_string());
        }
        let current = crate::skill_host::store::native_e2e_find_source(&source_id)?
            .ok_or_else(|| format!("unknown_source: {source_id}"))?;
        previous_subdir = current.skills_subdir.clone();
        state.changed_source = Some((source_id.clone(), previous_subdir.clone()));
    }
    crate::skill_host::store::native_e2e_set_source_subdir(
        &source_id,
        &format!("{previous_subdir}-race"),
    )?;
    Ok(control_status())
}

fn revert_fixture_source() -> Result<Value, String> {
    let (source_id, previous) = {
        let mut state = load_control()
            .lock()
            .map_err(|_| "load_control_lock_poisoned".to_string())?;
        state
            .changed_source
            .take()
            .ok_or_else(|| "no_source_change_pending".to_string())?
    };
    crate::skill_host::store::native_e2e_set_source_subdir(&source_id, &previous)?;
    Ok(control_status())
}

/// Feature-only load control: allowlisted operation IDs, fixture-root path
/// validation, overlap counters, isolated/blocking_async modes, and
/// change/revert of a fixture-owned source through the existing registry
/// transaction seams. Every other action, operation, path or source is
/// refused.
#[tauri::command]
pub async fn native_e2e_load_control(request: LoadControlRequest) -> Result<Value, String> {
    match request.action.as_str() {
        "arm" => arm_load_control(request.mode, request.ops),
        "disarm" => {
            let mut state = load_control()
                .lock()
                .map_err(|_| "load_control_lock_poisoned".to_string())?;
            state.armed.clear();
            drop(state);
            reset_counters();
            Ok(control_status())
        }
        "reset" => {
            reset_counters();
            Ok(control_status())
        }
        "status" => Ok(control_status()),
        "changeSource" => change_fixture_source(request.source_id),
        "revertSource" => revert_fixture_source(),
        other => Err(format!("load_control_action_not_allowed: {other}")),
    }
}

#[cfg(test)]
mod phase08_native_harness {
    use super::*;
    use std::sync::{Mutex as TestMutex, MutexGuard};

    // Serializes the one test that mutates TOKIO_WORKER_THREADS so a
    // parallel test cannot observe the override mid-runtime-creation.
    static WORKER_ENV_LOCK: TestMutex<()> = TestMutex::new(());

    fn worker_env_guard() -> MutexGuard<'static, ()> {
        WORKER_ENV_LOCK
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }

    #[test]
    fn phase08_27_allowlist_refuses_unknown_operation() {
        let root = std::env::temp_dir();
        let op = ArmOp {
            op: "git_status_everything".to_string(),
            paths: Vec::new(),
            source_id: None,
        };
        let err = validate_arm_op(&root, &op).unwrap_err();
        assert!(
            err.contains("load_control_op_not_allowed"),
            "unexpected refusal reason: {err}"
        );
        let known = ArmOp {
            op: "git_status".to_string(),
            paths: Vec::new(),
            source_id: None,
        };
        assert!(validate_arm_op(&root, &known).is_ok());
    }

    #[test]
    fn phase08_27_fixture_path_rejection() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let inside = root.join("repo-a");
        std::fs::create_dir(&inside).unwrap();
        let op = ArmOp {
            op: "git_status".to_string(),
            paths: vec![inside.display().to_string()],
            source_id: None,
        };
        assert!(validate_arm_op(&root, &op).is_ok());
        let escape = ArmOp {
            op: "git_status".to_string(),
            paths: vec!["/etc".to_string()],
            source_id: None,
        };
        let err = validate_arm_op(&root, &escape).unwrap_err();
        assert!(
            err.contains("escapes the native-e2e root"),
            "unexpected refusal reason: {err}"
        );
        let missing = ArmOp {
            op: "git_status".to_string(),
            paths: vec![root.join("does-not-exist").display().to_string()],
            source_id: None,
        };
        assert!(validate_arm_op(&root, &missing).is_err());
        let relative = ArmOp {
            op: "git_status".to_string(),
            paths: vec!["relative/repo".to_string()],
            source_id: None,
        };
        assert!(validate_arm_op(&root, &relative).is_err());
    }

    #[test]
    fn phase08_27_installed_runtime_worker_count() {
        let _guard = worker_env_guard();
        std::env::set_var("TOKIO_WORKER_THREADS", "2");
        let runtime = tauri::async_runtime::TokioRuntime::new()
            .unwrap_or_else(|err| panic!("runtime creation failed: {err}"));
        std::env::remove_var("TOKIO_WORKER_THREADS");
        assert_eq!(runtime_worker_count(&runtime), EXPECTED_WORKER_THREADS);
    }

    #[test]
    fn phase08_27_probe_yields_on_same_runtime() {
        let result = tauri::async_runtime::block_on(probe_handshake());
        assert_eq!(result["ok"], true);
        assert_eq!(result["yielded"], true);
        assert_eq!(result["hook"], MARU_NATIVE_RESPONSIVENESS_HOOK);
        assert!(result["workerCount"].as_u64().unwrap() >= 1);
    }

    #[test]
    fn phase08_27_control_reset_clears_counters() {
        {
            let mut state = load_control().lock().unwrap_or_else(|err| err.into_inner());
            state.epoch = Some(Instant::now());
            state.armed.insert(
                "git_status".to_string(),
                ArmedControl {
                    mode: LoadMode::Isolated,
                    paths: Vec::new(),
                    source_id: None,
                },
            );
            state.active.insert("git_status".to_string(), 3);
            state.totals.insert("git_status".to_string(), 7);
            state.max_concurrent = 3;
            state
                .windows
                .insert("git_status".to_string(), vec![(0, 10)]);
        }
        reset_counters();
        let state = load_control().lock().unwrap_or_else(|err| err.into_inner());
        assert!(state.active.is_empty());
        assert!(state.totals.is_empty());
        assert!(state.windows.is_empty());
        assert_eq!(state.max_concurrent, 0);
        assert!(state.changed_source.is_none());
        // Armed operations survive a counter reset; disarm clears them.
        assert!(state.armed.contains_key("git_status"));
    }

    // Regression test for the load-control self-deadlock: the first
    // implementation of `arm_load_control` called `control_status()` — which
    // re-locks the same std Mutex — while its own guard was still alive, and
    // `change_fixture_source` repeated the pattern. Either blocks one mutex
    // holder forever and wedges every later load_control caller. The arm
    // round-trip below runs on a spawned thread with a 2s recv budget so the
    // buggy version fails loudly instead of hanging the suite.
    #[test]
    fn phase08_27_arm_status_disarm_do_not_deadlock() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let repo = root.join("repo-a");
        std::fs::create_dir(&repo).unwrap();
        set_test_fixture_root(Some(root));

        let (tx, rx) = std::sync::mpsc::channel();
        let repo_arg = repo.display().to_string();
        std::thread::spawn(move || {
            let result =
                tauri::async_runtime::block_on(native_e2e_load_control(LoadControlRequest {
                    action: "arm".to_string(),
                    mode: Some("isolated".to_string()),
                    ops: vec![ArmOp {
                        op: "git_status".to_string(),
                        paths: vec![repo_arg],
                        source_id: None,
                    }],
                    source_id: None,
                }));
            let _ = tx.send(result);
        });
        let armed = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("native_e2e_load_control(arm) deadlocked (load-control mutex self-relock)")
            .expect("arm request failed");
        assert_eq!(armed["hook"], MARU_NATIVE_RESPONSIVENESS_HOOK);
        let armed_ops = armed["armed"].as_array().expect("armed must be an array");
        assert_eq!(armed_ops[0]["op"], "git_status");
        assert_eq!(armed_ops[0]["mode"], "isolated");

        let status = tauri::async_runtime::block_on(native_e2e_load_control(LoadControlRequest {
            action: "status".to_string(),
            mode: None,
            ops: Vec::new(),
            source_id: None,
        }))
        .expect("status request failed");
        let status_ops = status["armed"].as_array().expect("armed must be an array");
        assert_eq!(status_ops[0]["op"], "git_status");
        assert_eq!(status_ops[0]["mode"], "isolated");

        let disarmed =
            tauri::async_runtime::block_on(native_e2e_load_control(LoadControlRequest {
                action: "disarm".to_string(),
                mode: None,
                ops: Vec::new(),
                source_id: None,
            }))
            .expect("disarm request failed");
        assert!(disarmed["armed"]
            .as_array()
            .expect("armed must be an array")
            .is_empty());
        set_test_fixture_root(None);
    }
}
