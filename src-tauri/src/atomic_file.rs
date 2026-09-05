use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};

type ActivePathTransactions = Vec<(u64, Vec<PathBuf>)>;
static PATH_TRANSACTIONS: (Mutex<ActivePathTransactions>, Condvar) =
    (Mutex::new(Vec::new()), Condvar::new());
static NEXT_TRANSACTION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Reusable explicit parent precondition for later background callbacks. The
/// pinned handle belongs to the original directory, even after it is unlinked.
#[derive(Clone)]
pub(crate) struct PathTransactionParent {
    path: PathBuf,
    handle: std::sync::Arc<fs::File>,
}
impl PathTransactionParent {
    pub(crate) fn capture(path: &Path) -> Result<Self, String> {
        let handle = PathTransactionRequest::open_parent(path).map_err(|err| err.to_string())?;
        PathTransactionRequest::same_identity(&handle, &handle)?;
        Ok(Self {
            path: path.to_path_buf(),
            handle: std::sync::Arc::new(handle),
        })
    }
}

/// A complete mutation set. Paths authorize nothing: physical keys only identify
/// resources, while each command retains its lexical permission checks.
pub(crate) struct PathTransactionRequest {
    paths: Vec<PathBuf>,
    keys: Vec<PathBuf>,
    aliases: Vec<PathBuf>,
    parents: Vec<PathTransactionParent>,
    registry: Option<(PathBuf, PathBuf)>,
}

impl PathTransactionRequest {
    fn key(path: &Path) -> PathBuf {
        // These supported platforms can expose case-insensitive volumes.
        // Folding only exclusion identities is conservative on sensitive
        // volumes; authorization continues using the original lexical path.
        #[cfg(any(windows, target_os = "macos"))]
        {
            PathBuf::from(path.as_os_str().to_string_lossy().to_lowercase())
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            path.to_path_buf()
        }
    }
    fn open_parent(path: &Path) -> std::io::Result<fs::File> {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            };
            options
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
        }
        options.open(path)
    }

    #[cfg(windows)]
    fn windows_identity(file: &fs::File) -> Result<(u32, u64), String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // SAFETY: file owns a live handle; the OS initializes the output on success.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(format!(
                "Cannot identify transaction parent: {}",
                std::io::Error::last_os_error()
            ));
        }
        let info = unsafe { info.assume_init() };
        let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 || index == 0 {
            return Err("Stable transaction parent identity is unavailable".to_string());
        }
        Ok((info.dwVolumeSerialNumber, index))
    }
    /// Include the legacy loader's write only when migration can occur. If
    /// that condition changes while waiting, fail before invoking the loader.
    pub(crate) fn with_workspace_registry(self) -> Result<Self, String> {
        let output = crate::vault_list::workspace_registry_path()?;
        let legacy = crate::vault_list::legacy_vault_list_path()?;
        let mut request = if !output.exists() && legacy.exists() {
            let mut paths = self.paths.clone();
            paths.extend([output.clone(), legacy.clone()]);
            let mut expanded = Self::new(paths)?;
            expanded.parents.extend(self.parents);
            expanded
        } else {
            self
        };
        request.registry = Some((output, legacy));
        Ok(request)
    }
    pub(crate) fn require_parent(self, path: &Path) -> Result<Self, String> {
        self.require_parent_snapshot(&PathTransactionParent::capture(path)?)
    }
    pub(crate) fn require_parent_snapshot(
        mut self,
        parent: &PathTransactionParent,
    ) -> Result<Self, String> {
        Self::same_identity(
            &parent.handle,
            &Self::open_parent(&parent.path).map_err(|err| err.to_string())?,
        )?;
        self.parents.push(parent.clone());
        Ok(self)
    }
    pub(crate) fn new(paths: impl IntoIterator<Item = PathBuf>) -> Result<Self, String> {
        let mut paths = paths
            .into_iter()
            .map(|path| {
                if !path.is_absolute() {
                    return Err("Transaction paths must be absolute".to_string());
                }
                Ok(crate::vault::lexical_normalize(&path))
            })
            .collect::<Result<Vec<_>, _>>()?;
        paths.sort();
        paths.dedup();
        if paths.is_empty() {
            return Err("Transaction requires a complete nonempty path set".to_string());
        }
        let mut keys: Vec<_> = paths.iter().map(|path| Self::key(path)).collect();
        let mut aliases = Vec::new();
        let mut parents = Vec::new();
        for path in &paths {
            let alias = Self::physical_path(path)?;
            keys.push(Self::key(&alias));
            aliases.push(alias);
            let mut parent = if path.is_dir() {
                path.as_path()
            } else {
                path.parent().ok_or("Transaction path has no parent")?
            };
            while !parent.is_dir() {
                parent = parent.parent().ok_or("Transaction parent does not exist")?;
            }
            // Keep an open directory handle: on Unix it also prevents inode
            // reuse from disguising remove/recreate at the same pathname.
            let handle = Self::open_parent(parent)
                .map_err(|err| format!("Cannot capture transaction parent: {err}"))?;
            Self::same_identity(
                &handle,
                &Self::open_parent(parent).map_err(|err| err.to_string())?,
            )?;
            parents.push(PathTransactionParent {
                path: parent.to_path_buf(),
                handle: std::sync::Arc::new(handle),
            });
        }
        keys.sort();
        keys.dedup();
        Ok(Self {
            paths,
            keys,
            aliases,
            parents,
            registry: None,
        })
    }

    fn physical_path(path: &Path) -> Result<PathBuf, String> {
        Self::physical_path_depth(path, 0)
    }

    fn physical_path_depth(path: &Path, depth: usize) -> Result<PathBuf, String> {
        if depth > 40 {
            return Err("Cannot resolve cyclic transaction alias".to_string());
        }
        let mut ancestor = path;
        let mut suffix = PathBuf::new();
        while fs::symlink_metadata(ancestor).is_err() {
            let name = ancestor
                .file_name()
                .ok_or("Cannot resolve transaction alias")?;
            suffix = PathBuf::from(name).join(suffix);
            ancestor = ancestor
                .parent()
                .ok_or("Cannot resolve transaction ancestor")?;
        }
        match ancestor.canonicalize() {
            Ok(root) => Ok(root.join(suffix)),
            Err(err) => {
                // Broken symlinks are legitimate Files entries; reserve their
                // missing physical destination as well as the link itself.
                let target = fs::read_link(ancestor)
                    .map_err(|_| format!("Cannot resolve transaction alias: {err}"))?;
                let target = if target.is_absolute() {
                    target
                } else {
                    ancestor.parent().ok_or("Alias has no parent")?.join(target)
                };
                Self::physical_path_depth(
                    &crate::vault::lexical_normalize(&target.join(suffix)),
                    depth + 1,
                )
            }
        }
    }

    fn same_identity(left: &fs::File, right: &fs::File) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let left = left.metadata().map_err(|err| err.to_string())?;
            let right = right.metadata().map_err(|err| err.to_string())?;
            if left.is_dir()
                && right.is_dir()
                && left.dev() == right.dev()
                && left.ino() == right.ino()
            {
                return Ok(());
            }
            Err("Transaction parent changed; retry the operation".to_string())
        }
        #[cfg(windows)]
        {
            if Self::windows_identity(left)? == Self::windows_identity(right)? {
                return Ok(());
            }
            Err("Transaction parent changed; retry the operation".to_string())
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (left, right);
            Err("Stable transaction parent identity is unavailable on this platform".to_string())
        }
    }

    fn revalidate(&self) -> Result<(), String> {
        if let Some((output, legacy)) = &self.registry {
            if !output.exists() && legacy.exists() && !self.paths.contains(output) {
                return Err("Workspace registry migration changed; retry the operation".to_string());
            }
        }
        for parent in &self.parents {
            let current = Self::open_parent(&parent.path)
                .map_err(|_| "Transaction parent disappeared; retry the operation".to_string())?;
            Self::same_identity(&parent.handle, &current)?;
        }
        for (path, alias) in self.paths.iter().zip(&self.aliases) {
            if *alias != Self::physical_path(path)? {
                return Err("Transaction alias changed; retry the operation".to_string());
            }
        }
        Ok(())
    }

    /// Owned admission is for dedicated background threads. Acquire in a
    /// blocking worker; never hold this token across an async await.
    pub(crate) fn acquire(self) -> Result<PathTransactionLease, String> {
        #[cfg(test)]
        PathTransactionLease::test_stage(&self.paths, "before-admission");
        let (mutex, ready) = &PATH_TRANSACTIONS;
        let mut active = mutex
            .lock()
            .map_err(|_| "Transaction bookkeeping poisoned")?;
        while active.iter().any(|(_, keys)| {
            keys.iter().any(|left| {
                self.keys
                    .iter()
                    .any(|right| left.starts_with(right) || right.starts_with(left))
            })
        }) {
            active = ready
                .wait(active)
                .map_err(|_| "Transaction bookkeeping poisoned")?;
        }
        let id = NEXT_TRANSACTION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        active.push((id, self.keys.clone()));
        drop(active);
        let lease = PathTransactionLease {
            id,
            request: self,
            effects_started: std::sync::atomic::AtomicBool::new(false),
        };
        lease.request.revalidate()?;
        #[cfg(test)]
        Self::stage_admitted(&lease);
        Ok(lease)
    }

    #[cfg(test)]
    fn stage_admitted(lease: &PathTransactionLease) {
        PathTransactionLease::test_stage(&lease.request.paths, "admitted");
    }
}

/// Entire-set RAII release, including failed validation, errors and unwind.
pub(crate) struct PathTransactionLease {
    id: u64,
    request: PathTransactionRequest,
    effects_started: std::sync::atomic::AtomicBool,
}

impl PathTransactionLease {
    pub(crate) fn ensure_workspace_registry(&self) -> Result<(), String> {
        let output = crate::vault_list::workspace_registry_path()?;
        let legacy = crate::vault_list::legacy_vault_list_path()?;
        if !output.exists() && legacy.exists() {
            self.ensure_covered(vec![output, legacy])?;
        }
        Ok(())
    }
    /// Nested mutation adapters must verify their entire set, without extending
    /// this lease or reacquiring admission while a domain guard is held.
    pub(crate) fn ensure_covered(
        &self,
        paths: impl IntoIterator<Item = PathBuf>,
    ) -> Result<(), String> {
        for path in paths {
            if !path.is_absolute() {
                return Err("Transaction paths must be absolute".to_string());
            }
            let lexical = crate::vault::lexical_normalize(&path);
            let physical =
                PathTransactionRequest::key(&PathTransactionRequest::physical_path(&lexical)?);
            let lexical = PathTransactionRequest::key(&lexical);
            if ![lexical, physical]
                .iter()
                .all(|path| self.request.keys.iter().any(|key| path.starts_with(key)))
            {
                return Err("Nested mutation exceeds the admitted path set".to_string());
            }
        }
        Ok(())
    }

    /// Revalidate the original selection before this lease's first effect.
    /// Later nested calls retain coverage/domain checks but do not compare an
    /// original tree that the transaction has itself renamed. Network-to-commit
    /// stages must release and acquire a fresh complete request. Independent
    /// callbacks likewise use fresh requests plus an original parent snapshot.
    pub(crate) fn before_effect(&self) -> Result<(), String> {
        if !self
            .effects_started
            .load(std::sync::atomic::Ordering::Acquire)
        {
            self.request.revalidate()?;
            self.effects_started
                .store(true, std::sync::atomic::Ordering::Release);
        }
        #[cfg(test)]
        Self::test_stage(&self.request.paths, "pre-effect");
        Ok(())
    }
}

impl Drop for PathTransactionLease {
    fn drop(&mut self) {
        let (mutex, ready) = &PATH_TRANSACTIONS;
        // A poisoned mutex stays poisoned: future admission must fail closed.
        let mut active = mutex.lock().unwrap_or_else(|poison| poison.into_inner());
        active.retain(|(id, _)| *id != self.id);
        ready.notify_all();
    }
}

pub(crate) fn with_path_transactions<T>(
    request: PathTransactionRequest,
    work: impl FnOnce(&PathTransactionLease) -> Result<T, String>,
) -> Result<T, String> {
    let lease = request.acquire()?;
    work(&lease)
}

#[cfg(test)]
type TransactionTestCallback = std::sync::Arc<dyn Fn() + Send + Sync>;
#[cfg(test)]
static TRANSACTION_TEST_STAGES: Mutex<Vec<(u64, PathBuf, String, TransactionTestCallback)>> =
    Mutex::new(Vec::new());

#[cfg(test)]
pub(crate) struct PathTransactionTestHook(u64);

#[cfg(test)]
impl PathTransactionTestHook {
    pub(crate) fn new(
        path: PathBuf,
        stage: &str,
        callback: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        assert!(path.is_absolute());
        let id = NEXT_TRANSACTION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        TRANSACTION_TEST_STAGES.lock().unwrap().push((
            id,
            path,
            stage.into(),
            std::sync::Arc::new(callback),
        ));
        Self(id)
    }
}

#[cfg(test)]
impl Drop for PathTransactionTestHook {
    fn drop(&mut self) {
        TRANSACTION_TEST_STAGES
            .lock()
            .unwrap()
            .retain(|(id, _, _, _)| *id != self.0);
    }
}

#[cfg(test)]
impl PathTransactionLease {
    pub(crate) fn test_stage(paths: &[PathBuf], stage: &str) {
        let callbacks: Vec<_> = TRANSACTION_TEST_STAGES
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, path, label, _)| label == stage && paths.contains(path))
            .map(|(_, _, _, callback)| callback.clone())
            .collect();
        for callback in callbacks {
            callback();
        }
    }
}

#[cfg(test)]
pub(crate) mod phase08_06 {
    use super::*;
    use std::future::Future;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::Duration;

    pub(crate) struct Home {
        pub root: tempfile::TempDir,
        prior: [Option<std::ffi::OsString>; 2],
        _guard: std::sync::MutexGuard<'static, ()>,
    }
    impl Home {
        pub(crate) fn new() -> Self {
            let guard = crate::skill_host::fs::test_maru_home_lock();
            let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
            let prior = [
                std::env::var_os("MARU_TEST_HOME"),
                std::env::var_os("MARU_TEST_CONFIG_DIR"),
            ];
            std::env::set_var("MARU_TEST_HOME", root.path());
            std::env::set_var("MARU_TEST_CONFIG_DIR", root.path());
            Self {
                root,
                prior,
                _guard: guard,
            }
        }
    }
    impl Drop for Home {
        fn drop(&mut self) {
            for (name, old) in ["MARU_TEST_HOME", "MARU_TEST_CONFIG_DIR"]
                .iter()
                .zip(&self.prior)
            {
                match old {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
    pub(crate) fn run<F>(future: F) -> F::Output
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx.recv_timeout(Duration::from_secs(10))
            .expect("fixture runtime completion")
    }

    pub(crate) struct Held {
        entered: mpsc::Receiver<std::thread::ThreadId>,
        release: mpsc::Sender<()>,
        _hook: PathTransactionTestHook,
    }
    impl Held {
        pub(crate) fn new(path: PathBuf, stage: &str) -> Self {
            let (entered_tx, entered) = mpsc::channel();
            let (release, release_rx) = mpsc::channel();
            let release_rx = Mutex::new(release_rx);
            let used = AtomicBool::new(false);
            let hook = PathTransactionTestHook::new(path, stage, move || {
                if used.swap(true, Ordering::SeqCst) {
                    return;
                }
                entered_tx.send(std::thread::current().id()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .expect("release held transaction");
            });
            Self {
                entered,
                release,
                _hook: hook,
            }
        }
        pub(crate) fn wait(&self) {
            self.entered
                .recv_timeout(Duration::from_secs(5))
                .expect("transaction entered");
        }
        pub(crate) fn release(&self) {
            let _ = self.release.send(());
        }
    }
    impl Drop for Held {
        fn drop(&mut self) {
            self.release();
        }
    }

    pub(crate) fn boundary<F, T>(path: PathBuf, command: &str, future: F)
    where
        F: Future<Output = Result<T, String>> + Send + 'static,
        T: Send + 'static,
    {
        let (entered_tx, mut entered_rx) = tauri::async_runtime::channel(1);
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let _hook = PathTransactionTestHook::new(path, &format!("worker:{command}"), move || {
            entered_tx
                .blocking_send(std::thread::current().id())
                .unwrap();
            release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            panic!("fixture worker failure");
        });
        let command = command.to_string();
        run(async move {
            let caller = std::thread::current().id();
            let mut future = Box::pin(future);
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx)))
                    .await
                    .is_pending()
            );
            let worker = entered_rx.recv().await.unwrap();
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
            assert_ne!(worker, caller);
            release_tx.send(()).unwrap();
            assert!(
                matches!(future.await, Err(error) if error.starts_with(&format!("{command}_task_failed:")))
            );
        });
    }

    #[test]
    fn phase08_06_sets_are_atomic_hierarchical_and_component_wise() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let ab = temp.path().join("ab");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&ab).unwrap();
        let request = PathTransactionRequest::new(vec![a.clone()]).unwrap();
        let lease = request.acquire().unwrap();
        let (tx, rx) = mpsc::channel();
        let a_child = a.join("note.md");
        let ready = Held::new(a_child.clone(), "before-admission");
        let worker = std::thread::spawn(move || {
            with_path_transactions(PathTransactionRequest::new(vec![a_child]).unwrap(), |_| {
                tx.send(()).unwrap();
                Ok(())
            })
        });
        ready.wait();
        ready.release();
        with_path_transactions(PathTransactionRequest::new(vec![ab]).unwrap(), |_| Ok(())).unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
        drop(lease);
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        worker.join().unwrap().unwrap();
        // Opposing requests reserve complete sets at once: no AB/BA deadlock.
        let b = temp.path().join("b");
        let first = PathTransactionRequest::new(vec![a.clone(), b.clone()])
            .unwrap()
            .acquire()
            .unwrap();
        let worker = std::thread::spawn(move || {
            with_path_transactions(PathTransactionRequest::new(vec![b, a]).unwrap(), |_| Ok(()))
        });
        drop(first);
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn phase08_06_parent_replacement_and_missing_parent_fail_without_recreation() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("a");
        fs::create_dir(&parent).unwrap();
        for recreate in [false, true] {
            let request = PathTransactionRequest::new(vec![parent.join("note.md")]).unwrap();
            fs::remove_dir(&parent).unwrap();
            if recreate {
                fs::create_dir(&parent).unwrap();
            }
            assert!(with_path_transactions(request, |_| -> Result<(), String> {
                panic!("stale parent reached effect")
            })
            .is_err());
            assert!(!parent.join("note.md").exists());
            if !recreate {
                fs::create_dir(&parent).unwrap();
            }
        }
    }

    #[test]
    fn phase08_06_reusable_parent_snapshot_rejects_later_callback_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("parent");
        fs::create_dir(&parent).unwrap();
        let snapshot = PathTransactionParent::capture(&parent).unwrap();
        let callback = snapshot.clone();
        with_path_transactions(
            PathTransactionRequest::new(vec![parent.join("first")])
                .unwrap()
                .require_parent_snapshot(&snapshot)
                .unwrap(),
            |lease| {
                lease.before_effect()?;
                write_atomic(&parent.join("first"), b"first callback")
            },
        )
        .unwrap();
        fs::remove_dir_all(&parent).unwrap();
        fs::create_dir(&parent).unwrap();
        assert!(PathTransactionRequest::new(vec![parent.join("second")])
            .unwrap()
            .require_parent_snapshot(&callback)
            .is_err());
        assert!(!parent.join("second").exists());
    }

    #[test]
    fn phase08_06_nested_subset_error_and_unwind_release() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let request = || PathTransactionRequest::new(vec![a.clone()]).unwrap();
        with_path_transactions(request(), |lease| {
            lease.ensure_covered(vec![a.join("nested")])?;
            assert!(lease
                .ensure_covered(vec![temp.path().join("other")])
                .is_err());
            Ok(())
        })
        .unwrap();
        assert!(
            with_path_transactions(request(), |_| Err::<(), _>("injected error".to_string()))
                .is_err()
        );
        assert!(std::panic::catch_unwind(|| with_path_transactions(
            request(),
            |_| -> Result<(), String> { panic!("injected unwind") }
        ))
        .is_err());
        with_path_transactions(request(), |_| Ok(())).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn phase08_06_symlink_alias_conflicts_and_retarget_fails() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let physical = temp.path().join("real");
        let other = temp.path().join("other");
        let alias = temp.path().join("alias");
        fs::create_dir(&physical).unwrap();
        fs::create_dir(&other).unwrap();
        symlink(&physical, &alias).unwrap();
        let lease = PathTransactionRequest::new(vec![physical.clone()])
            .unwrap()
            .acquire()
            .unwrap();
        let request = PathTransactionRequest::new(vec![alias.join("note.md")]).unwrap();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            with_path_transactions(request, |_| {
                tx.send(()).unwrap();
                Ok(())
            })
        });
        assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
        fs::remove_file(&alias).unwrap();
        symlink(&other, &alias).unwrap();
        drop(lease);
        assert!(worker.join().unwrap().is_err());
        with_path_transactions(
            PathTransactionRequest::new(vec![alias.join("note.md")]).unwrap(),
            |lease| {
                lease.before_effect()?;
                write_atomic(&alias.join("note.md"), b"alias content")
            },
        )
        .unwrap();
        assert_eq!(fs::read(other.join("note.md")).unwrap(), b"alias content");
    }
}

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// Write a same-filesystem temporary file, flush it, then atomically replace
/// the destination. `tempfile::persist` uses replace semantics on Windows,
/// where `std::fs::rename` cannot overwrite an existing file.
pub(crate) fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    write_atomic_with_create_mode(path, content, 0o666)
}

/// Atomically replace a potentially sensitive file. Existing permissions are
/// preserved; a newly created file is owner-readable/writable on Unix.
pub(crate) fn write_atomic_private(path: &Path, content: &[u8]) -> Result<(), String> {
    write_atomic_with_create_mode(path, content, 0o600)
}

fn write_atomic_with_create_mode(
    path: &Path,
    content: &[u8],
    create_mode: u32,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Cannot determine parent directory for {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("Cannot create {}: {err}", parent.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let prefix = format!(".{file_name}.maru-tmp-");
    let mut builder = tempfile::Builder::new();
    builder.prefix(&prefix);
    #[cfg(unix)]
    builder.permissions(fs::Permissions::from_mode(create_mode));
    #[cfg(not(unix))]
    let _ = create_mode;
    let mut temp = builder
        .tempfile_in(parent)
        .map_err(|err| format!("Cannot create temporary file: {err}"))?;
    temp.write_all(content)
        .map_err(|err| format!("Cannot write temporary file: {err}"))?;
    if let Ok(metadata) = fs::metadata(path) {
        temp.as_file()
            .set_permissions(metadata.permissions())
            .map_err(|err| format!("Cannot preserve {} permissions: {err}", path.display()))?;
    }
    temp.as_file()
        .sync_all()
        .map_err(|err| format!("Cannot sync temporary file: {err}"))?;
    temp.persist(path).map(|_| ()).map_err(|err| {
        format!(
            "Cannot atomically replace {}: {}",
            path.display(),
            err.error
        )
    })
}

/// Atomically publish a fully written file only when the destination does not
/// exist. `persist_noclobber` closes the check/write race that would otherwise
/// let a concurrent creator be overwritten.
pub(crate) fn write_atomic_create(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Cannot determine parent directory for {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("Cannot create {}: {err}", parent.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let prefix = format!(".{file_name}.maru-tmp-");
    let mut builder = tempfile::Builder::new();
    builder.prefix(&prefix);
    #[cfg(unix)]
    builder.permissions(fs::Permissions::from_mode(0o666));
    let mut temp = builder
        .tempfile_in(parent)
        .map_err(|err| format!("Cannot create temporary file: {err}"))?;
    temp.write_all(content)
        .map_err(|err| format!("Cannot write temporary file: {err}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|err| format!("Cannot sync temporary file: {err}"))?;
    temp.persist_noclobber(path).map(|_| ()).map_err(|err| {
        format!(
            "target_exists: cannot create {} without overwriting: {}",
            path.display(),
            err.error
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn replaces_existing_file_without_leaving_a_temp_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.md");
        fs::write(&path, "old").unwrap();

        write_atomic(&path, b"new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    #[test]
    fn create_never_overwrites_existing_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.md");
        fs::write(&path, "old").unwrap();

        let error = write_atomic_create(&path, b"new").unwrap_err();

        assert!(error.contains("target_exists"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
    }

    #[cfg(unix)]
    #[test]
    fn preserves_existing_unix_permissions() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("shared.md");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();

        write_atomic(&path, b"new").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn private_create_uses_owner_only_permissions() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");

        write_atomic_private(&path, b"hooks = []").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
