//! Bounded durable receipts. Locks cover only read/modify/replace, never child waits.
use crate::atomic_file::{with_path_transactions, PathTransactionParent, PathTransactionRequest};
use serde::{Deserialize, Serialize};
#[cfg(test)]
static WAIT_HOOK: std::sync::Mutex<Option<(PathBuf, std::sync::mpsc::Sender<()>)>> =
    std::sync::Mutex::new(None);
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const HISTORY_LIMIT: usize = 100;
const HISTORY_BYTES_LIMIT: u64 = 2 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProcessIdentity {
    pub pid: u32,
    pub start: String,
}

// A PID by itself is not ownership evidence: compare native creation time.
#[cfg(target_os = "macos")]
fn native_start(pid: u32) -> Option<String> {
    #[repr(C)]
    #[derive(Default)]
    struct BsdInfo {
        fields: [u32; 12],
        comm: [u8; 16],
        name: [u8; 32],
        more: [u32; 6],
        start_sec: u64,
        start_usec: u64,
    }
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            size: i32,
        ) -> i32;
    }
    let mut info = BsdInfo::default();
    let size = std::mem::size_of::<BsdInfo>() as i32;
    // SAFETY: PROC_PIDTBSDINFO (3) writes at most size bytes into this live buffer.
    let written =
        unsafe { proc_pidinfo(pid as i32, 3, 0, (&mut info as *mut BsdInfo).cast(), size) };
    (written == size).then(|| format!("{}:{}", info.start_sec, info.start_usec))
}
#[cfg(target_os = "linux")]
fn native_start(pid: u32) -> Option<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = stat.rsplit_once(')')?.1;
    let ticks = rest.split_whitespace().nth(19)?;
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    Some(format!("{}:{ticks}", boot.trim()))
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn native_start(_pid: u32) -> Option<String> {
    None
}

pub fn identity(pid: u32) -> Option<NativeProcessIdentity> {
    native_start(pid).map(|start| NativeProcessIdentity { pid, start })
}
#[cfg(unix)]
fn native_definitely_dead(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    #[cfg(target_os = "macos")]
    unsafe extern "C" {
        fn __error() -> *mut i32;
    }
    #[cfg(target_os = "linux")]
    unsafe extern "C" {
        fn __errno_location() -> *mut i32;
    }
    // SAFETY: signal 0 performs a native existence/permission probe; no signal is delivered.
    let result = unsafe { kill(pid as i32, 0) };
    if result == 0 {
        return false;
    }
    #[cfg(target_os = "macos")]
    let errno = unsafe { *__error() };
    #[cfg(target_os = "linux")]
    let errno = unsafe { *__errno_location() };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let errno = 0;
    errno == 3 // ESRCH only; EPERM or missing telemetry remains uncertain.
}
fn alive(process: &NativeProcessIdentity) -> bool {
    native_start(process.pid)
        .map(|start| start == process.start)
        .unwrap_or_else(|| {
            #[cfg(unix)]
            {
                !native_definitely_dead(process.pid)
            }
            #[cfg(not(unix))]
            {
                true
            }
        })
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobRunReceipt {
    pub request_id: String,
    pub run_id: String,
    pub source: String,
    pub job_revision: String,
    pub scheduled_fire_at: Option<u64>,
    pub admitted_at: u64,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub process_outcome: String,
    pub exit_code: Option<i32>,
    pub verification_outcome: String,
    #[serde(default)]
    pub ledger_recorded: bool,
    pub coalesced_into: Option<String>,
    pub owner: Option<NativeProcessIdentity>,
    pub child: Option<NativeProcessIdentity>,
}
fn paths(work: &Path, id: &str) -> (PathBuf, PathBuf) {
    let dir = work.join(".maru/jobs-state");
    (
        dir.join(format!("{id}.receipts.json")),
        dir.join(format!("{id}.receipts.lock")),
    )
}
fn verify_lock_identity(file: &fs::File, path: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|e| format!("job_receipt_lock_changed: {e}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("job_receipt_lock_changed".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let original = file.metadata().map_err(|e| e.to_string())?;
        if original.dev() != metadata.dev() || original.ino() != metadata.ino() {
            return Err("job_receipt_lock_changed".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        fn key(file: &fs::File) -> Result<(u32, u32, u32), String> {
            let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
            // SAFETY: a live file handle and writable correctly sized output buffer.
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
                return Err("job_receipt_lock_identity_unavailable".into());
            }
            let info = unsafe { info.assume_init() };
            Ok((
                info.dwVolumeSerialNumber,
                info.nFileIndexHigh,
                info.nFileIndexLow,
            ))
        }
        let selected = fs::File::open(path).map_err(|e| e.to_string())?;
        if key(file)? != key(&selected)? {
            return Err("job_receipt_lock_changed".into());
        }
    }
    Ok(())
}
fn assert_publish_action(work: &Path, path: &Path) -> Result<(), String> {
    let action = if path.exists() {
        crate::vault_list::WorkspaceWriteAction::Modify
    } else {
        crate::vault_list::WorkspaceWriteAction::Create
    };
    crate::vault_list::assert_maru_can_write(&work.to_string_lossy(), action)
}
fn read_rows(path: &Path) -> Result<Vec<JobRunReceipt>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("job_receipt_read: {e}")),
    };
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(HISTORY_BYTES_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("job_receipt_read: {e}"))?;
    if bytes.len() as u64 > HISTORY_BYTES_LIMIT {
        return Err("job_receipt_history_too_large".into());
    }
    let rows: Vec<JobRunReceipt> =
        serde_json::from_slice(&bytes).map_err(|e| format!("job_receipt_read: {e}"))?;
    if rows.len() > HISTORY_LIMIT {
        return Err("job_receipt_history_too_large".into());
    }
    Ok(rows)
}
fn transaction<T>(
    work: &Path,
    id: &str,
    f: impl FnOnce(&mut Vec<JobRunReceipt>) -> Result<T, String>,
) -> Result<T, String> {
    let (path, lock) = paths(work, id);
    let parent = path.parent().unwrap();
    // Directory aliases are supported, and pinned below to their physical identities.
    // Receipt/lock leaf aliases are never followed for publication.
    for candidate in [path.clone(), lock.clone()] {
        if fs::symlink_metadata(&candidate).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("job_receipt_symlink_rejected".into());
        }
    }
    assert_publish_action(work, &path)?;
    if !parent.exists() || !lock.exists() {
        crate::vault_list::assert_maru_can_write(
            &work.to_string_lossy(),
            crate::vault_list::WorkspaceWriteAction::Create,
        )?;
    }
    fs::create_dir_all(parent).map_err(|e| format!("job_receipt_directory: {e}"))?;
    let work_parent = PathTransactionParent::capture(work)?;
    let maru_parent = PathTransactionParent::capture(&work.join(".maru"))?;
    let state_parent = PathTransactionParent::capture(parent)?;
    let request = PathTransactionRequest::new([path.clone(), lock.clone()])?
        .require_parent_snapshot(&work_parent)?
        .require_parent_snapshot(&maru_parent)?
        .require_parent_snapshot(&state_parent)?;
    let lock_path = lock;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("job_receipt_lock: {e}"))?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("job_receipt_sync: {e}"))?;
    #[cfg(unix)]
    if let Some(grandparent) = parent.parent() {
        fs::File::open(grandparent)
            .and_then(|file| file.sync_all())
            .map_err(|e| format!("job_receipt_sync: {e}"))?;
    }
    #[cfg(unix)]
    fs::File::open(work)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("job_receipt_sync: {e}"))?;
    #[cfg(test)]
    {
        let mut hook = WAIT_HOOK.lock().unwrap();
        if hook.as_ref().is_some_and(|(selected, _)| selected == &path) {
            if let Some((_, sender)) = hook.take() {
                let _ = sender.send(());
            }
        }
    }
    lock.lock().map_err(|e| format!("job_receipt_lock: {e}"))?;
    verify_lock_identity(&lock, &lock_path)?;
    // Revalidate the pinned directory identities after cross-process lock admission.
    with_path_transactions(request, |lease| {
        let mut receipts = read_rows(&path)?;
        let before = receipts.clone();
        let result = f(&mut receipts)?;
        if receipts != before {
            let bytes =
                serde_json::to_vec(&receipts).map_err(|e| format!("job_receipt_serialize: {e}"))?;
            if bytes.len() as u64 > HISTORY_BYTES_LIMIT {
                return Err("job_receipt_history_too_large".into());
            }
            assert_publish_action(work, &path)?;
            verify_lock_identity(&lock, &lock_path)?;
            crate::vault_guard::validate_managed_write(
                &work.to_string_lossy(),
                &path.to_string_lossy(),
                &String::from_utf8_lossy(&bytes),
            )?;
            lease.before_effect()?;
            crate::atomic_file::write_atomic(&path, &bytes)?;
            // Atomic replacement syncs the file; sync its directory entry as well.
            #[cfg(unix)]
            fs::File::open(parent)
                .and_then(|file| file.sync_all())
                .map_err(|e| format!("job_receipt_sync: {e}"))?;
        }
        Ok(result)
    })
}
pub fn save(work: &Path, id: &str, receipt: &JobRunReceipt) -> Result<(), String> {
    transaction(work, id, |receipts| {
        if let Some(row) = receipts.iter_mut().find(|row| row.run_id == receipt.run_id) {
            *row = receipt.clone();
        } else {
            if receipts.len() >= HISTORY_LIMIT {
                // Never evict live/uncertain ownership to admit more work.
                let index = receipts
                    .iter()
                    .position(|r| r.finished_at.is_some())
                    .ok_or("job_receipt_history_busy")?;
                receipts.remove(index);
            }
            receipts.push(receipt.clone());
        }
        Ok(())
    })
}
pub fn history(work: &Path, id: &str) -> Result<Vec<JobRunReceipt>, String> {
    if !paths(work, id).0.exists() {
        return Ok(Vec::new());
    }
    transaction(work, id, |receipts| {
        for receipt in receipts.iter_mut().filter(|r| r.finished_at.is_none()) {
            if receipt.owner.as_ref().is_some_and(alive) {
                continue;
            }
            // No stored child identity leaves the spawn/persist crash window uncertain.
            // Mark interrupted but keep it nonterminal, preventing silent provider replay.
            receipt.process_outcome = "interrupted".into();
            if receipt.child.as_ref().is_some_and(|child| !alive(child)) {
                receipt.finished_at = Some(super::now_epoch_seconds());
            }
        }
        Ok(receipts.iter().rev().take(HISTORY_LIMIT).cloned().collect())
    })
}
/// Atomic-file snapshot for the read-only IPC seam; no lock file or registry migration.
pub fn readback(work: &Path, id: &str) -> Result<Vec<JobRunReceipt>, String> {
    let (path, _) = paths(work, id);
    for ancestor in [path.clone()] {
        if fs::symlink_metadata(&ancestor).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("job_receipt_symlink_rejected".into());
        }
    }
    let mut rows = read_rows(&path)?;
    for row in rows.iter_mut().filter(|r| r.finished_at.is_none()) {
        if !row.owner.as_ref().is_some_and(alive) {
            row.process_outcome = "interrupted".into();
            if row.child.as_ref().is_some_and(|child| !alive(child)) {
                row.finished_at = Some(super::now_epoch_seconds());
            }
        }
    }
    rows.reverse();
    Ok(rows)
}
pub fn uncertain_active(work: &Path, id: &str) -> Result<Option<String>, String> {
    Ok(history(work, id)?
        .into_iter()
        .find(|r| r.finished_at.is_none())
        .map(|r| r.run_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_file::phase08_06::Home;
    fn receipt(id: &str) -> JobRunReceipt {
        JobRunReceipt {
            request_id: id.into(),
            run_id: id.into(),
            source: "manual".into(),
            job_revision: "frozen".into(),
            scheduled_fire_at: Some(1),
            admitted_at: 2,
            started_at: None,
            finished_at: None,
            process_outcome: "admitted".into(),
            exit_code: None,
            verification_outcome: "notRequested".into(),
            ledger_recorded: false,
            coalesced_into: None,
            owner: None,
            child: None,
        }
    }
    #[test]
    fn before_spawn_crash_is_interrupted_and_blocks_replay() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        save(work.path(), "job", &receipt("admission")).unwrap();
        let rows = history(work.path(), "job").unwrap();
        assert_eq!(rows[0].process_outcome, "interrupted");
        assert_eq!(rows[0].verification_outcome, "notRequested");
        assert_eq!(
            uncertain_active(work.path(), "job").unwrap(),
            Some("admission".into())
        );
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn orphan_child_keeps_ownership_even_without_a_launcher() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let mut row = receipt("orphan");
        row.child = identity(std::process::id());
        assert!(row.child.is_some());
        save(work.path(), "job", &row).unwrap();
        assert_eq!(history(work.path(), "job").unwrap()[0].finished_at, None);
        assert!(uncertain_active(work.path(), "job").unwrap().is_some());
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn reused_pid_is_not_native_ownership() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let mut row = receipt("recycled");
        row.child = Some(NativeProcessIdentity {
            pid: std::process::id(),
            start: "different-creation-time".into(),
        });
        save(work.path(), "job", &row).unwrap();
        assert!(history(work.path(), "job").unwrap()[0]
            .finished_at
            .is_some());
        assert!(uncertain_active(work.path(), "job").unwrap().is_none());
    }
    #[test]
    fn exited_receipt_survives_restart_before_ledger_and_never_implies_verification() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let mut row = receipt("exit");
        row.finished_at = Some(3);
        row.exit_code = Some(0);
        row.process_outcome = "exited".into();
        save(work.path(), "job", &row).unwrap();
        let rows = history(work.path(), "job").unwrap();
        assert_eq!(rows[0], row);
        assert!(!rows[0].ledger_recorded);
        assert_eq!(rows[0].verification_outcome, "notRequested");
    }
    #[test]
    fn concurrent_short_transactions_preserve_rows_and_bounded_history() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        std::thread::scope(|scope| {
            for worker in 0..4 {
                let work = work.path();
                scope.spawn(move || {
                    for i in 0..30 {
                        let mut row = receipt(&format!("{worker}-{i}"));
                        row.finished_at = Some(3);
                        save(work, "job", &row).unwrap();
                    }
                });
            }
        });
        let rows = history(work.path(), "job").unwrap();
        assert_eq!(rows.len(), HISTORY_LIMIT);
        let ids: std::collections::HashSet<_> = rows.iter().map(|r| &r.run_id).collect();
        assert_eq!(ids.len(), HISTORY_LIMIT);
    }
    #[cfg(unix)]
    #[test]
    fn symlink_history_is_rejected_without_mutating_target() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        fs::create_dir_all(work.path().join(".maru/jobs-state")).unwrap();
        let target = work.path().join("outside");
        fs::write(&target, "preserved").unwrap();
        std::os::unix::fs::symlink(&target, paths(work.path(), "job").0).unwrap();
        assert!(save(work.path(), "job", &receipt("x")).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "preserved");
    }
    #[cfg(unix)]
    #[test]
    fn deliberate_state_directory_alias_remains_supported() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let alias = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(alias.path(), work.path().join(".maru")).unwrap();
        let mut row = receipt("aliased");
        row.finished_at = Some(1);
        save(work.path(), "job", &row).unwrap();
        assert!(alias.path().join("jobs-state/job.receipts.json").exists());
        assert_eq!(readback(work.path(), "job").unwrap(), vec![row]);
    }
    #[cfg(unix)]
    #[test]
    fn lock_wait_parent_swap_fails_before_outside_publication() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        save(work.path(), "job", &{
            let mut row = receipt("old");
            row.finished_at = Some(1);
            row
        })
        .unwrap();
        let (path, lock_path) = paths(work.path(), "job");
        let lock = fs::OpenOptions::new().write(true).open(lock_path).unwrap();
        lock.lock().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        *WAIT_HOOK.lock().unwrap() = Some((path, sender));
        std::thread::scope(|scope| {
            let writer = scope.spawn(|| save(work.path(), "job", &receipt("new")));
            let ready = receiver.recv_timeout(std::time::Duration::from_secs(2));
            if ready.is_err() {
                lock.unlock().unwrap();
            }
            ready.expect("writer reached the cross-process lock wait");
            fs::rename(
                work.path().join(".maru/jobs-state"),
                work.path().join(".maru/original-state"),
            )
            .unwrap();
            std::os::unix::fs::symlink(outside.path(), work.path().join(".maru/jobs-state"))
                .unwrap();
            lock.unlock().unwrap();
            assert!(writer.join().unwrap().is_err());
        });
        assert!(!outside.path().join("job.receipts.json").exists());
    }
    #[cfg(unix)]
    #[test]
    fn replaced_lock_inode_is_rejected_after_wait() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let mut old = receipt("old");
        old.finished_at = Some(1);
        save(work.path(), "job", &old).unwrap();
        let (path, lock_path) = paths(work.path(), "job");
        let lock = fs::OpenOptions::new().write(true).open(&lock_path).unwrap();
        lock.lock().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        *WAIT_HOOK.lock().unwrap() = Some((path.clone(), sender));
        std::thread::scope(|scope| {
            let writer = scope.spawn(|| save(work.path(), "job", &receipt("new")));
            let ready = receiver.recv_timeout(std::time::Duration::from_secs(2));
            if ready.is_err() {
                lock.unlock().unwrap();
            }
            ready.unwrap();
            fs::rename(&lock_path, lock_path.with_extension("old-lock")).unwrap();
            fs::File::create(&lock_path).unwrap();
            lock.unlock().unwrap();
            assert!(writer
                .join()
                .unwrap()
                .unwrap_err()
                .contains("job_receipt_lock_changed"));
        });
        let persisted: Vec<JobRunReceipt> =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted, vec![old]);
    }
    fn allow_modify_without_create(work: &Path) {
        let path = crate::vault_list::workspace_registry_path().unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(&serde_json::json!({"workspaces": [{"label": "Modify only", "path": work, "visibility": "private", "provider": "nextcloud", "writePolicy": "direct", "permissionSummary": {"role": "3", "source": "manual", "capabilities": {"canRead": true, "canCreate": false, "canModify": true, "canDelete": false, "canRenameMove": false, "canShare": false, "canManageMembers": false}}}]})).unwrap()).unwrap();
    }
    #[test]
    fn modify_only_capability_does_not_create_receipt_state() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let mut row = receipt("existing");
        row.finished_at = Some(1);
        save(work.path(), "existing", &row).unwrap();
        allow_modify_without_create(work.path());
        row.process_outcome = "exited".into();
        save(work.path(), "existing", &row).unwrap();
        assert!(save(work.path(), "new", &receipt("new")).is_err());
        assert!(!paths(work.path(), "new").0.exists());
        assert!(!paths(work.path(), "new").1.exists());
        fs::remove_file(paths(work.path(), "existing").1).unwrap();
        assert!(save(work.path(), "existing", &row).is_err()); // A missing lock also requires Create.
    }
    #[test]
    fn missing_history_during_lock_wait_requires_fresh_create_authorization() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let mut row = receipt("old");
        row.finished_at = Some(1);
        save(work.path(), "job", &row).unwrap();
        allow_modify_without_create(work.path());
        let (path, lock_path) = paths(work.path(), "job");
        let lock = fs::OpenOptions::new().write(true).open(&lock_path).unwrap();
        lock.lock().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        *WAIT_HOOK.lock().unwrap() = Some((path.clone(), sender));
        std::thread::scope(|scope| {
            let writer = scope.spawn(|| save(work.path(), "job", &receipt("new")));
            let ready = receiver.recv_timeout(std::time::Duration::from_secs(2));
            if ready.is_err() {
                lock.unlock().unwrap();
            }
            ready.unwrap();
            fs::remove_file(&path).unwrap();
            lock.unlock().unwrap();
            assert!(writer.join().unwrap().is_err());
        });
        assert!(!path.exists());
    }
    #[test]
    fn oversized_history_fails_closed_for_readback_and_mutating_transactions() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let (path, _) = paths(work.path(), "large");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(&path)
            .unwrap()
            .set_len(HISTORY_BYTES_LIMIT + 1)
            .unwrap();
        assert_eq!(
            readback(work.path(), "large").unwrap_err(),
            "job_receipt_history_too_large"
        );
        assert_eq!(
            history(work.path(), "large").unwrap_err(),
            "job_receipt_history_too_large"
        );
        assert_eq!(
            save(work.path(), "large", &receipt("new")).unwrap_err(),
            "job_receipt_history_too_large"
        );
        assert_eq!(fs::metadata(&path).unwrap().len(), HISTORY_BYTES_LIMIT + 1);
    }
}
