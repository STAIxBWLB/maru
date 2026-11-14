//! Read-only repository scanner that proposes a `floorplan/architecture@1`
//! map (issue #553, E5 T3).
//!
//! The scanner reads files and nothing else: it never runs a process, never
//! opens a socket and never writes. Its whole filesystem scope is the root the
//! [`crate::DiagramHost`] resolves for the caller-named workspace; a picked path
//! outside that root is refused, symbolic links are never followed, and the git
//! index is read only when it lies inside the same root. Every walk is bounded
//! in files, depth, bytes and time, and a bound stops the scan with its cause
//! and the next step instead of returning a partial map.
//!
//! The output is a proposal. Nothing is stored: the editor shows it, and the
//! user saves it as an ordinary Diagram document or discards it. No Floorplan
//! code is used; its JSON format is the reference.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(unix)]
use rustix::fs::{openat, AtFlags, FileType, Mode, OFlags};

pub const DEFAULT_MAX_FILES: usize = 5_000;
pub const MAX_FILES_LIMIT: usize = 20_000;
pub const DEFAULT_MAX_DEPTH: u8 = 24;
pub const MAX_DEPTH_LIMIT: u8 = 64;
pub const SCAN_TIME_BUDGET: Duration = Duration::from_secs(20);
/// Larger source files are counted but not parsed for imports.
pub const MAX_SOURCE_BYTES: u64 = 1024 * 1024;
/// Total bytes read across all parsed files and the index.
pub const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
/// Total bytes of paths an index may expand to (v4 prefix compression lets a
/// small index name very long paths), and the cap per path.
pub const MAX_INDEX_PATH_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PATH_BYTES: usize = 4096;
/// Ignore malformed or generated ignore lines before allocating/matching them.
pub const MAX_IGNORE_PATTERN_BYTES: usize = 4096;
/// Directory entries a walk may read, ignored ones included, so a very wide
/// generated folder stops the scan instead of being listed in full.
pub const MAX_DIR_ENTRIES: usize = 200_000;
/// Segments of a Rust `use` path that are resolved.
pub const MAX_USE_SEGMENTS: usize = 16;
/// Folder nesting the map keeps: a top-level folder and one level inside it.
pub const GROUP_DEPTH: usize = 2;
pub const MAX_NODES: usize = 400;
pub const MAX_EDGES: usize = 2_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanError {
    pub code: String,
    pub message: String,
    pub next_step: String,
}

impl ScanError {
    fn new(code: &str, message: impl Into<String>, next_step: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            next_step: next_step.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Inventory {
    /// Tracked files from a git index inside the workspace root.
    GitIndex,
    /// A filesystem walk that applies `.gitignore` rules.
    Filesystem,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    pub inventory: Inventory,
    pub files: usize,
    pub source_files: usize,
    pub file_imports: usize,
    pub skipped_large: usize,
    pub nodes: usize,
    pub edges: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    /// The proposed `floorplan/architecture@1` document.
    pub document: Value,
    /// The scanned folder, relative to the workspace root (`""` for the root).
    pub relative_path: String,
    pub stats: ScanStats,
}

#[derive(Debug, Clone, Copy)]
pub struct ScanLimits {
    pub max_files: usize,
    pub max_depth: u8,
    pub time_budget: Duration,
}

impl ScanLimits {
    pub fn new(max_files: Option<usize>, max_depth: Option<u8>) -> Result<Self, ScanError> {
        let max_files = max_files.unwrap_or(DEFAULT_MAX_FILES);
        let max_depth = max_depth.unwrap_or(DEFAULT_MAX_DEPTH);
        if max_files == 0 || max_files > MAX_FILES_LIMIT {
            return Err(ScanError::new(
                "diagram_scan_limit_invalid",
                format!("maxFiles must be between 1 and {MAX_FILES_LIMIT}"),
                "use a bounded file limit and scan again",
            ));
        }
        if max_depth == 0 || max_depth > MAX_DEPTH_LIMIT {
            return Err(ScanError::new(
                "diagram_scan_limit_invalid",
                format!("maxDepth must be between 1 and {MAX_DEPTH_LIMIT}"),
                "use a bounded folder depth and scan again",
            ));
        }
        Ok(Self {
            max_files,
            max_depth,
            time_budget: SCAN_TIME_BUDGET,
        })
    }
}

/// Scan `picked` inside `root` and propose a map. `root` must be the canonical
/// workspace root the host resolved; `picked` may be absolute or relative to it.
pub fn scan(root: &Path, picked: &str, limits: ScanLimits) -> Result<ScanReport, ScanError> {
    let started = Instant::now();
    let budget = Budget {
        deadline: started + limits.time_budget,
        bytes: 0,
    };
    let root = root.canonicalize().map_err(|error| {
        ScanError::new(
            "diagram_scan_workspace_unavailable",
            format!("the workspace root cannot be opened: {error}"),
            "reopen the workspace in Maru and scan again",
        )
    })?;
    // Opened once, after the canonicalize above proved the root is the folder
    // the host authorized. Every read below is resolved from this handle, not
    // from that path, so replacing the root or a folder under it with a link
    // during the scan cannot redirect a read outside the workspace.
    let anchor = RootAnchor::open(&root)?;
    let scan_root = resolve_picked(&root, picked)?;
    let relative_path = relative_string(&root, &scan_root);
    let Some(scan_dir) = anchor.open_scan_root(&relative_path) else {
        return Err(ScanError::new(
            "diagram_scan_path_missing",
            format!(
                "the picked folder cannot be opened: {}",
                if relative_path.is_empty() {
                    "the workspace root"
                } else {
                    relative_path.as_str()
                }
            ),
            "pick an existing folder inside the workspace",
        ));
    };
    let mut state = Walk {
        limits,
        budget,
        entry_cap: MAX_DIR_ENTRIES,
        entries: 0,
        files: Vec::new(),
    };
    let inventory = match git_index_files(&anchor, &root, &scan_root, &mut state)? {
        Some(files) => {
            for file in files {
                state.push(file)?;
            }
            Inventory::GitIndex
        }
        None => {
            walk(&scan_dir, &[], &mut state, 0)?;
            Inventory::Filesystem
        }
    };
    let Walk {
        mut files,
        mut budget,
        ..
    } = state;
    files.sort();
    files.dedup();
    let name = scan_root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("repository")
        .to_string();
    let (document, stats) = propose(
        &anchor,
        &relative_path,
        &name,
        &files,
        inventory,
        &mut budget,
    )?;
    // A scan that ran past its budget is refused, never returned late.
    budget.check_time()?;
    Ok(ScanReport {
        document,
        relative_path,
        stats,
    })
}

struct Budget {
    deadline: Instant,
    bytes: u64,
}

impl Budget {
    fn check_time(&self) -> Result<(), ScanError> {
        if Instant::now() >= self.deadline {
            return Err(ScanError::new(
                "diagram_scan_timeout",
                format!(
                    "the scan stopped at its {} s time limit",
                    SCAN_TIME_BUDGET.as_secs()
                ),
                "pick a smaller subfolder and scan again",
            ));
        }
        Ok(())
    }

    fn charge(&mut self, bytes: u64) -> Result<(), ScanError> {
        self.bytes = self.bytes.saturating_add(bytes);
        if self.bytes > MAX_TOTAL_BYTES {
            return Err(ScanError::new(
                "diagram_scan_too_much_data",
                format!(
                    "the scan stopped after reading {} MiB of source",
                    MAX_TOTAL_BYTES / (1024 * 1024)
                ),
                "pick a smaller subfolder and scan again",
            ));
        }
        Ok(())
    }
}

struct Walk {
    limits: ScanLimits,
    budget: Budget,
    /// Directory entries the walk may read, [`MAX_DIR_ENTRIES`] in a scan. A
    /// regression lowers it so the bound can be proved on a folder small enough
    /// to build in a test.
    entry_cap: usize,
    /// Directory entries read so far, ignored ones included.
    entries: usize,
    /// Paths relative to the scanned folder, `/`-separated.
    files: Vec<String>,
}

impl Walk {
    fn push(&mut self, file: String) -> Result<(), ScanError> {
        let depth = file.matches('/').count();
        if depth >= usize::from(self.limits.max_depth) {
            return Err(ScanError::new(
                "diagram_scan_too_deep",
                format!(
                    "{file} is nested deeper than the {} folder limit",
                    self.limits.max_depth
                ),
                format!(
                    "pick a subfolder closer to the code, or raise maxDepth (up to {MAX_DEPTH_LIMIT})"
                ),
            ));
        }
        if self.files.len() >= self.limits.max_files {
            return Err(ScanError::new(
                "diagram_scan_too_many_files",
                format!("the folder holds more than {} files", self.limits.max_files),
                format!("pick a smaller subfolder, or raise maxFiles (up to {MAX_FILES_LIMIT})"),
            ));
        }
        self.files.push(file);
        Ok(())
    }
}

fn resolve_picked(root: &Path, picked: &str) -> Result<PathBuf, ScanError> {
    let outside = || {
        ScanError::new(
            "diagram_scan_outside_workspace",
            "the picked folder is outside the open workspace",
            "pick a folder inside the open workspace, or open that folder as a workspace first",
        )
    };
    if picked.is_empty() || picked.chars().any(char::is_control) {
        return Err(ScanError::new(
            "diagram_scan_path_invalid",
            "the picked folder path is empty or contains control characters",
            "pick the folder again",
        ));
    }
    let raw = Path::new(picked);
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        if raw.components().any(|part| part == Component::ParentDir) {
            return Err(outside());
        }
        root.join(raw)
    };
    let canonical = candidate.canonicalize().map_err(|error| {
        ScanError::new(
            "diagram_scan_path_missing",
            format!("the picked folder cannot be opened: {error}"),
            "pick an existing folder inside the workspace",
        )
    })?;
    if !canonical.starts_with(root) {
        return Err(outside());
    }
    if !canonical.is_dir() {
        return Err(ScanError::new(
            "diagram_scan_path_not_folder",
            "the picked path is a file, not a folder",
            "pick the folder that contains the code",
        ));
    }
    Ok(canonical)
}

/// Git names use `/` on every platform. Reject Windows separators/prefixes
/// even on Unix, and never let a pushed component reset or traverse the root.
fn plain_relative_path(relative: &str) -> bool {
    !relative.is_empty()
        && !relative.contains(['\\', ':', '\0'])
        && relative.split('/').all(|part| {
            let mut components = Path::new(part).components();
            matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
        })
}

/// The authorized workspace root, held open for the whole scan.
///
/// [`resolve_picked`] canonicalizes once, which proves the picked folder lay
/// inside the root at that moment. A read that goes back to a pathname
/// afterwards can be redirected: a concurrent process with write access to the
/// workspace replaces the root, or a folder on the way to a file, with a
/// symbolic link, and the read that follows leaves the workspace. So every
/// read here is resolved from this handle one component at a time with
/// `O_NOFOLLOW`, and a folder is listed through a handle as well, which makes
/// the same replacement a refused open rather than a followed link.
///
/// Without `openat` the scan keeps its `symlink_metadata` checks: a link at the
/// root or at the leaf is still refused, but a folder swapped between the check
/// and the read that follows it is not, so that platform's protection stops at
/// the leaf.
struct RootAnchor {
    /// Only the pathname fallback needs the root back; the Unix reads resolve
    /// everything from the handle.
    #[cfg(not(unix))]
    root: PathBuf,
    #[cfg(unix)]
    handle: fs::File,
}

impl RootAnchor {
    /// Open `root`, which the caller has already canonicalized.
    fn open(root: &Path) -> Result<Self, ScanError> {
        let unavailable = |error: std::io::Error| {
            ScanError::new(
                "diagram_scan_workspace_unavailable",
                format!("the workspace root cannot be opened: {error}"),
                "reopen the workspace in Maru and scan again",
            )
        };
        #[cfg(unix)]
        {
            let handle = open_at(
                None,
                root,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            )
            .ok_or_else(|| unavailable(std::io::Error::from(std::io::ErrorKind::NotFound)))?;
            Ok(Self { handle })
        }
        #[cfg(not(unix))]
        {
            let meta = fs::symlink_metadata(root).map_err(unavailable)?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(unavailable(std::io::Error::from(
                    std::io::ErrorKind::NotADirectory,
                )));
            }
            Ok(Self {
                root: root.to_path_buf(),
            })
        }
    }

    /// Open a folder under the root for listing, refusing a symbolic link at
    /// every component. `""` is the root itself.
    fn open_dir(&self, relative: &str) -> Option<ScanDir> {
        if !relative.is_empty() && !plain_relative_path(relative) {
            return None;
        }
        #[cfg(unix)]
        {
            let mut current = self.handle.try_clone().ok()?;
            for part in relative.split('/').filter(|part| !part.is_empty()) {
                current = open_at(
                    Some(&current),
                    Path::new(part),
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                )?;
            }
            Some(ScanDir {
                relative: relative.to_string(),
                handle: current,
            })
        }
        #[cfg(not(unix))]
        {
            let path = self.root.join(relative);
            let meta = fs::symlink_metadata(&path).ok()?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return None;
            }
            Some(ScanDir {
                relative: relative.to_string(),
                path,
            })
        }
    }

    /// The folder being scanned. Its report paths are relative to that folder,
    /// not to the workspace root, so the resolved handle keeps the root-relative
    /// base only for resolution and drops it for the walk.
    fn open_scan_root(&self, relative: &str) -> Option<ScanDir> {
        let mut dir = self.open_dir(relative)?;
        dir.relative.clear();
        Some(dir)
    }

    /// Whether `relative` exists and is a folder, never following a link at
    /// its last component: `None` when nothing is there.
    fn lstat_kind(&self, relative: &str) -> Option<bool> {
        let (parent, name) = match relative.rsplit_once('/') {
            Some((parent, name)) => (parent, name),
            None => ("", relative),
        };
        if name.is_empty() || !plain_relative_path(name) {
            return None;
        }
        let dir = self.open_dir(parent)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsFd;
            let stat =
                rustix::fs::statat(dir.handle.as_fd(), name, AtFlags::SYMLINK_NOFOLLOW).ok()?;
            Some(FileType::from_raw_mode(stat.st_mode).is_dir())
        }
        #[cfg(not(unix))]
        {
            let meta = fs::symlink_metadata(dir.path.join(name)).ok()?;
            Some(meta.is_dir())
        }
    }

    /// Open a file under the root, refusing a symbolic link at every component
    /// and a leaf that is not a regular file.
    fn open_file(&self, relative: &str) -> Option<fs::File> {
        if !plain_relative_path(relative) {
            return None;
        }
        #[cfg(unix)]
        {
            let mut current = self.handle.try_clone().ok()?;
            let mut parts = relative.split('/').peekable();
            while let Some(part) = parts.next() {
                let flags = if parts.peek().is_none() {
                    // `O_NONBLOCK` so a FIFO cannot block before the handle is
                    // checked for regular-file type.
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC
                } else {
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC
                };
                current = open_at(Some(&current), Path::new(part), flags)?;
            }
            Some(current)
        }
        #[cfg(not(unix))]
        {
            let mut current = self.root.clone();
            let mut parts = relative.split('/').peekable();
            while let Some(part) = parts.next() {
                current.push(part);
                let meta = fs::symlink_metadata(&current).ok()?;
                let last = parts.peek().is_none();
                if meta.file_type().is_symlink()
                    || (last && !meta.is_file())
                    || (!last && !meta.is_dir())
                {
                    return None;
                }
            }
            fs::File::open(current).ok()
        }
    }

    /// Whether `relative` reaches a regular file with no symbolic link on the
    /// way. The answer comes from the anchored open itself, so a later read
    /// cannot disagree with it.
    fn is_regular_file(&self, relative: &str) -> bool {
        match self.open_file(relative) {
            Some(handle) => handle
                .metadata()
                .map(|meta| meta.is_file())
                .unwrap_or(false),
            None => false,
        }
    }

    /// Read a file under the root under the same byte bound and budget as the
    /// rest of the scan.
    fn read_bounded(
        &self,
        relative: &str,
        cap: u64,
        budget: &mut Budget,
    ) -> Result<BoundedRead, ScanError> {
        let Some(handle) = self.open_file(relative) else {
            return Ok(BoundedRead::Unreadable);
        };
        read_bounded_from(handle, cap, budget)
    }
}

/// One folder of the scan, held open for listing.
///
/// Entries are read from the handle and a child folder is opened from it, so a
/// folder replaced after it was opened cannot change what the scan lists.
/// Without `openat` the path is kept and listing goes by pathname, which is the
/// platform gap documented on [`RootAnchor`].
struct ScanDir {
    /// `/`-separated path from the workspace root (`""` for the root itself).
    relative: String,
    #[cfg(unix)]
    handle: fs::File,
    #[cfg(not(unix))]
    path: PathBuf,
}

impl ScanDir {
    fn relative(&self) -> &str {
        &self.relative
    }

    /// This folder's entries one at a time, in no particular order.
    ///
    /// `admit` runs before the entry's type is resolved through the handle and
    /// before anything about the entry is kept, so the walk's bounds stop a very
    /// wide folder while it is still being listed. Draining the folder first and
    /// counting afterwards would let one generated or vendored tree cost
    /// unbounded memory and enumeration time before the cap could fire.
    ///
    /// `visit` receives the entry's name and, when `d_type` already settled it,
    /// the kind; `None` leaves the type to [`ScanDir::classify`].
    fn for_each_entry<A, V>(&self, mut admit: A, mut visit: V) -> Result<(), ScanError>
    where
        A: FnMut() -> Result<(), ScanError>,
        V: FnMut(&str, Option<EntryKind>) -> Result<(), ScanError>,
    {
        #[cfg(unix)]
        {
            use std::os::fd::AsFd;
            let listed = rustix::fs::Dir::read_from(self.handle.as_fd())
                .map_err(|error| self.list_error(error))?;
            for entry in listed {
                let entry = entry.map_err(|error| self.list_error(error))?;
                let name = match std::str::from_utf8(entry.file_name().to_bytes()) {
                    Ok(name) => name,
                    Err(_) => continue,
                };
                // A handle-based listing yields the raw `.` and `..` entries
                // that `read_dir` filters out, and neither may become a child of
                // the walk.
                if name == "." || name == ".." {
                    continue;
                }
                #[cfg(test)]
                entry_probe::yielded_one();
                admit()?;
                visit(name, entry_kind(entry.file_type()))?;
            }
        }
        #[cfg(not(unix))]
        {
            let listed = fs::read_dir(&self.path).map_err(|error| self.list_error(error))?;
            for entry in listed {
                let entry = entry.map_err(|error| self.list_error(error))?;
                let Ok(name) = entry.file_name().into_string() else {
                    continue;
                };
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                #[cfg(test)]
                entry_probe::yielded_one();
                admit()?;
                let kind = if kind.is_dir() {
                    EntryKind::Dir
                } else if kind.is_file() {
                    EntryKind::File
                } else {
                    EntryKind::Skip
                };
                visit(&name, Some(kind))?;
            }
        }
        Ok(())
    }

    /// Resolve an entry whose type the filesystem did not report, through this
    /// folder's handle, exactly as the listing did before it: a link is never
    /// followed and anything that is neither a folder nor a regular file is
    /// skipped.
    fn classify(&self, name: &str) -> EntryKind {
        #[cfg(unix)]
        {
            if self.child(name).is_some() {
                return EntryKind::Dir;
            }
            match self.open_file(name) {
                Some(handle)
                    if handle
                        .metadata()
                        .map(|meta| meta.is_file())
                        .unwrap_or(false) =>
                {
                    EntryKind::File
                }
                _ => EntryKind::Skip,
            }
        }
        #[cfg(not(unix))]
        {
            match fs::symlink_metadata(self.path.join(name)) {
                Ok(meta) if meta.is_dir() => EntryKind::Dir,
                Ok(meta) if meta.is_file() => EntryKind::File,
                _ => EntryKind::Skip,
            }
        }
    }

    fn list_error(&self, error: impl Into<std::io::Error>) -> ScanError {
        let error = error.into();
        ScanError::new(
            "diagram_scan_read_failed",
            format!("cannot list {}: {error}", display(&self.relative)),
            "check the folder's permissions and scan again",
        )
    }

    /// The child folder `name`, opened from this folder's handle.
    fn child(&self, name: &str) -> Option<ScanDir> {
        let relative = join(&self.relative, name);
        #[cfg(unix)]
        {
            let handle = open_at(
                Some(&self.handle),
                Path::new(name),
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            )?;
            Some(ScanDir { relative, handle })
        }
        #[cfg(not(unix))]
        {
            let path = self.path.join(name);
            let meta = fs::symlink_metadata(&path).ok()?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return None;
            }
            Some(ScanDir { relative, path })
        }
    }

    /// Read `name` from this folder under the scan's byte bound and budget.
    fn read_bounded(
        &self,
        name: &str,
        cap: u64,
        budget: &mut Budget,
    ) -> Result<BoundedRead, ScanError> {
        let Some(handle) = self.open_file(name) else {
            return Ok(BoundedRead::Unreadable);
        };
        read_bounded_from(handle, cap, budget)
    }

    fn open_file(&self, name: &str) -> Option<fs::File> {
        #[cfg(unix)]
        {
            open_at(
                Some(&self.handle),
                Path::new(name),
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            )
        }
        #[cfg(not(unix))]
        {
            let path = self.path.join(name);
            let meta = fs::symlink_metadata(&path).ok()?;
            if meta.file_type().is_symlink() || !meta.is_file() {
                return None;
            }
            fs::File::open(path).ok()
        }
    }
}

/// `O_NOFOLLOW` for the root open: the root is already canonical, so a link
/// here means it was replaced after that check.
#[cfg(unix)]
fn open_at(dir: Option<&fs::File>, path: &Path, flags: OFlags) -> Option<fs::File> {
    use std::os::fd::AsFd;
    let fd = match dir {
        Some(dir) => openat(dir.as_fd(), path, flags, Mode::empty()),
        None => openat(rustix::fs::CWD, path, flags, Mode::empty()),
    };
    fd.ok().map(fs::File::from)
}

/// What a listed entry is. A link, a FIFO, a socket or a device is `Skip`: the
/// walk neither lists nor reads it, which is what keeps the scan inside the
/// workspace without a second metadata check.
#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    Dir,
    File,
    Skip,
}

/// The entry's kind when `d_type` already settled it. `None` means the
/// filesystem reported no type, and [`ScanDir::classify`] resolves it through
/// the folder's handle instead of dropping the entry.
#[cfg(unix)]
fn entry_kind(kind: rustix::fs::FileType) -> Option<EntryKind> {
    if kind.is_dir() {
        Some(EntryKind::Dir)
    } else if kind.is_file() {
        Some(EntryKind::File)
    } else if kind.is_symlink() {
        Some(EntryKind::Skip)
    } else {
        None
    }
}

/// Entries a listing handed to the walk, so a regression can prove a very wide
/// folder is refused while it is listed rather than after it has been read into
/// memory. Thread-local: parallel tests never see each other's counts.
#[cfg(test)]
mod entry_probe {
    use std::cell::Cell;

    thread_local! {
        static YIELDED: Cell<usize> = const { Cell::new(0) };
    }

    pub(super) fn yielded_one() {
        YIELDED.with(|count| count.set(count.get() + 1));
    }

    pub(super) fn yielded() -> usize {
        YIELDED.with(Cell::get)
    }

    pub(super) fn reset() {
        YIELDED.with(|count| count.set(0));
    }
}

#[derive(Debug)]
enum BoundedRead {
    Bytes(Vec<u8>),
    TooLarge,
    Unreadable,
}

/// Always charge consumed bytes, including partial I/O failures and the one
/// sentinel byte used to detect a growing file or an exhausted shared budget.
fn read_bounded(
    reader: impl std::io::Read,
    cap: u64,
    budget: &mut Budget,
) -> Result<BoundedRead, ScanError> {
    budget.check_time()?;
    let limit = cap.min(MAX_TOTAL_BYTES.saturating_sub(budget.bytes));
    let mut bytes = Vec::new();
    let result =
        std::io::Read::read_to_end(&mut std::io::Read::take(reader, limit + 1), &mut bytes);
    budget.charge(bytes.len() as u64)?;
    budget.check_time()?;
    if bytes.len() as u64 > cap {
        Ok(BoundedRead::TooLarge)
    } else if result.is_err() {
        Ok(BoundedRead::Unreadable)
    } else {
        Ok(BoundedRead::Bytes(bytes))
    }
}

/// Size checks and the read use the same no-follow handle. An already oversized
/// file is skipped without reading; subsequent growth is bounded by take().
fn read_bounded_from(
    handle: fs::File,
    cap: u64,
    budget: &mut Budget,
) -> Result<BoundedRead, ScanError> {
    let Ok(meta) = handle.metadata() else {
        return Ok(BoundedRead::Unreadable);
    };
    if !meta.is_file() {
        return Ok(BoundedRead::Unreadable);
    }
    if meta.len() > cap {
        return Ok(BoundedRead::TooLarge);
    }
    read_bounded(handle, cap, budget)
}

fn relative_string(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .map(|rest| {
            rest.components()
                .filter_map(|part| part.as_os_str().to_str())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Inventory: the git index
// ---------------------------------------------------------------------------

/// Tracked files under `scan_root`, when a readable index lies inside `root`.
/// `None` falls back to the filesystem walk. A repository whose metadata lives
/// outside the workspace (a linked worktree, for example) is walked instead,
/// because the scanner reads nothing outside the root the host resolved.
fn git_index_files(
    anchor: &RootAnchor,
    root: &Path,
    scan_root: &Path,
    state: &mut Walk,
) -> Result<Option<Vec<String>>, ScanError> {
    let scan_relative = relative_string(root, scan_root);
    let mut repo = Some(scan_root);
    while let Some(dir) = repo {
        if !dir.starts_with(root) {
            return Ok(None);
        }
        let dot_git = join(&relative_string(root, dir), ".git");
        // `.git` is classified without following a link, and the index is read
        // through the anchor, so a `.git` replaced after this check cannot
        // serve an index from outside the workspace.
        match anchor.lstat_kind(&dot_git) {
            // No `.git` here: an enclosing repository may still hold the index.
            None => {}
            // A file or a link, as in a linked worktree: walk instead.
            Some(false) => return Ok(None),
            Some(true) => {
                let BoundedRead::Bytes(bytes) = anchor.read_bounded(
                    &join(&dot_git, "index"),
                    MAX_INDEX_BYTES,
                    &mut state.budget,
                )?
                else {
                    return Ok(None);
                };
                let Some(entries) = parse_index(&bytes, state.budget.deadline)? else {
                    return Ok(None);
                };
                let prefix = relative_string(dir, scan_root);
                let mut files = Vec::new();
                for entry in entries {
                    let rest = if prefix.is_empty() {
                        entry.as_str()
                    } else if let Some(rest) = entry
                        .strip_prefix(prefix.as_str())
                        .and_then(|rest| rest.strip_prefix('/'))
                    {
                        rest
                    } else {
                        continue;
                    };
                    // A tracked path that is now missing, a directory, a link or
                    // under a linked folder is left out: the map describes what is
                    // on disk inside the workspace, and nothing is read through a link.
                    if anchor.is_regular_file(&join(&scan_relative, rest)) {
                        files.push(rest.to_string());
                    }
                    state.budget.check_time()?;
                }
                return Ok(Some(files));
            }
        }
        repo = dir.parent();
    }
    Ok(None)
}

/// Paths of the regular files in a git index (versions 2, 3 and 4). Conflict
/// stages, gitlinks and symbolic links are skipped. A malformed index is
/// `Ok(None)` and the caller walks the filesystem instead. Every rebuilt path
/// is charged against [`MAX_PATH_BYTES`] and [`MAX_INDEX_PATH_BYTES`] before it
/// is kept, and the deadline is checked while parsing, so v4 prefix expansion
/// cannot grow past the budget; exceeding it refuses the scan.
pub(crate) fn parse_index(
    bytes: &[u8],
    deadline: Instant,
) -> Result<Option<Vec<String>>, ScanError> {
    let mut expanded = 0usize;
    let mut seen = 0usize;
    let mut admit = |length: usize| -> Result<(), ScanError> {
        expanded = expanded.saturating_add(length);
        seen += 1;
        if length > MAX_PATH_BYTES || expanded > MAX_INDEX_PATH_BYTES {
            return Err(ScanError::new(
                "diagram_scan_index_too_large",
                format!(
                    "the git index names more than {} MiB of paths, or a path over {MAX_PATH_BYTES} bytes",
                    MAX_INDEX_PATH_BYTES / (1024 * 1024)
                ),
                "pick a subfolder of a smaller repository, or scan a checkout with a smaller index",
            ));
        }
        if seen.is_multiple_of(1024) && Instant::now() >= deadline {
            return Err(ScanError::new(
                "diagram_scan_timeout",
                format!(
                    "the scan stopped at its {} s time limit while reading the git index",
                    SCAN_TIME_BUDGET.as_secs()
                ),
                "pick a smaller subfolder and scan again",
            ));
        }
        Ok(())
    };
    parse_index_with(bytes, &mut admit)
}

/// `admit` sees each path's length before the path is built and kept.
fn parse_index_with(
    bytes: &[u8],
    admit: &mut dyn FnMut(usize) -> Result<(), ScanError>,
) -> Result<Option<Vec<String>>, ScanError> {
    macro_rules! need {
        ($value:expr) => {
            match $value {
                Some(value) => value,
                None => return Ok(None),
            }
        };
    }
    let read_u32 = |at: usize| -> Option<u32> {
        bytes
            .get(at..at + 4)
            .map(|slice| u32::from_be_bytes(slice.try_into().expect("four bytes")))
    };
    if need!(bytes.get(0..4)) != b"DIRC" {
        return Ok(None);
    }
    let version = need!(read_u32(4));
    if !(2..=4).contains(&version) {
        return Ok(None);
    }
    let count = need!(read_u32(8)) as usize;
    if count > 2_000_000 {
        return Ok(None);
    }
    let mut at = 12usize;
    let mut previous: Vec<u8> = Vec::new();
    let mut paths = Vec::with_capacity(count.min(65_536));
    for _ in 0..count {
        let start = at;
        let mode = need!(read_u32(at + 24));
        let flags = u16::from_be_bytes(need!(need!(bytes.get(at + 60..at + 62)).try_into().ok()));
        at += 62;
        if version >= 3 && flags & 0x4000 != 0 {
            at += 2;
        }
        let path = if version == 4 {
            let (strip, used) = need!(read_offset_varint(need!(bytes.get(at..))));
            at += used;
            let end = at + need!(need!(bytes.get(at..)).iter().position(|byte| *byte == 0));
            let keep = need!(previous.len().checked_sub(strip));
            admit(keep + (end - at))?;
            let mut path = previous[..keep].to_vec();
            path.extend_from_slice(&bytes[at..end]);
            at = end + 1;
            path
        } else {
            let end = at + need!(need!(bytes.get(at..)).iter().position(|byte| *byte == 0));
            admit(end - at)?;
            let path = bytes[at..end].to_vec();
            // Entries are NUL-padded to a multiple of eight bytes.
            let length = end + 1 - start;
            at = start + length.div_ceil(8) * 8;
            path
        };
        previous.clone_from(&path);
        let stage = (flags >> 12) & 0x3;
        let kind = mode & 0o170000;
        if stage != 0 || kind != 0o100000 {
            continue;
        }
        let text = need!(String::from_utf8(path).ok());
        if !plain_relative_path(&text) {
            return Ok(None);
        }
        paths.push(text);
    }
    Ok(Some(paths))
}

/// Git's index v4 offset varint: each continuation adds one before shifting.
fn read_offset_varint(bytes: &[u8]) -> Option<(usize, usize)> {
    let mut used = 0;
    let mut byte = *bytes.get(used)?;
    used += 1;
    let mut value = usize::from(byte & 0x7f);
    while byte & 0x80 != 0 {
        byte = *bytes.get(used)?;
        used += 1;
        value = value.checked_add(1)?.checked_mul(128)? + usize::from(byte & 0x7f);
    }
    Some((value, used))
}

// ---------------------------------------------------------------------------
// Inventory: the filesystem walk with .gitignore
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct IgnoreRule {
    /// The folder (relative to the scanned folder) whose `.gitignore` holds it.
    base: String,
    negated: bool,
    directory_only: bool,
    /// Matched against the path relative to `base`; otherwise the basename.
    anchored: bool,
    pattern: Vec<char>,
}

fn parse_gitignore(base: &str, text: &str) -> Vec<IgnoreRule> {
    let mut rules = Vec::new();
    for line in text.lines() {
        if line.len() > MAX_IGNORE_PATTERN_BYTES {
            continue;
        }
        let mut line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Trailing spaces are ignored unless escaped; the escape is rare
        // enough that an unescaped trim is the documented behaviour here.
        line = line.trim_end_matches(' ');
        let negated = line.starts_with('!');
        let mut body = if negated { &line[1..] } else { line };
        if let Some(rest) = body.strip_prefix('\\') {
            body = rest;
        }
        let directory_only = body.ends_with('/');
        let body = body.trim_end_matches('/');
        if body.is_empty() {
            continue;
        }
        let anchored = body.contains('/');
        let body = body.trim_start_matches('/');
        rules.push(IgnoreRule {
            base: base.to_string(),
            negated,
            directory_only,
            anchored,
            pattern: body.chars().collect(),
        });
    }
    rules
}

/// Whether `path` (relative to the scanned folder) is ignored: the last rule
/// that matches decides, as in git.
#[cfg(test)]
fn ignored(rules: &[IgnoreRule], path: &str, is_dir: bool) -> bool {
    ignored_with_budget(rules, path, is_dir, &test_match_budget()).unwrap()
}

fn ignored_with_budget(
    rules: &[IgnoreRule],
    path: &str,
    is_dir: bool,
    budget: &Budget,
) -> Result<bool, ScanError> {
    budget.check_time()?;
    let mut verdict = false;
    for rule in rules {
        budget.check_time()?;
        if rule.directory_only && !is_dir {
            continue;
        }
        let local = if rule.base.is_empty() {
            path
        } else if let Some(rest) = path
            .strip_prefix(rule.base.as_str())
            .and_then(|rest| rest.strip_prefix('/'))
        {
            rest
        } else {
            continue;
        };
        let subject = if rule.anchored {
            local
        } else {
            local.rsplit('/').next().unwrap_or(local)
        };
        let text: Vec<char> = subject.chars().collect();
        if glob_match_with_budget(&rule.pattern, &text, budget)? {
            verdict = !rule.negated;
        }
    }
    Ok(verdict)
}

#[cfg(test)]
fn test_match_budget() -> Budget {
    Budget {
        deadline: Instant::now() + SCAN_TIME_BUDGET,
        bytes: 0,
    }
}

/// Gitignore glob: `*` and `?` stay inside one segment, `**` crosses them and
/// `[...]` is a class. Dynamic programming over pattern and text, so no
/// pattern can cost more than their product.
#[cfg(test)]
pub(crate) fn glob_match(pattern: &[char], text: &[char]) -> bool {
    glob_match_with_budget(pattern, text, &test_match_budget()).unwrap()
}

fn glob_match_with_budget(
    pattern: &[char],
    text: &[char],
    budget: &Budget,
) -> Result<bool, ScanError> {
    budget.check_time()?;
    #[derive(Clone, Copy)]
    enum Token {
        Char(char),
        Any,
        Star,
        Globstar,
        Class(usize, usize, bool),
    }
    // One reverse pass replaces repeated suffix searches for an unmatched `[`.
    let mut class_closers = vec![None; pattern.len()];
    let mut closer = None;
    for index in (0..pattern.len()).rev() {
        if index.is_multiple_of(1024) {
            budget.check_time()?;
        }
        class_closers[index] = closer;
        if pattern[index] == ']' {
            closer = Some(index);
        }
    }
    let mut tokens = Vec::new();
    let mut at = 0;
    while at < pattern.len() {
        if at.is_multiple_of(1024) {
            budget.check_time()?;
        }
        match pattern[at] {
            '*' if pattern.get(at + 1) == Some(&'*') => {
                tokens.push(Token::Globstar);
                at += 2;
                // `**/` also matches zero folders.
                if pattern.get(at) == Some(&'/') {
                    at += 1;
                }
            }
            '*' => {
                tokens.push(Token::Star);
                at += 1;
            }
            '?' => {
                tokens.push(Token::Any);
                at += 1;
            }
            '[' => match class_closers[at] {
                Some(close) if close > at + 1 => {
                    let negated = matches!(pattern[at + 1], '!' | '^');
                    let start = at + 1 + usize::from(negated);
                    tokens.push(Token::Class(start, close, negated));
                    at = close + 1;
                }
                _ => {
                    tokens.push(Token::Char('['));
                    at += 1;
                }
            },
            '\\' if at + 1 < pattern.len() => {
                tokens.push(Token::Char(pattern[at + 1]));
                at += 2;
            }
            ch => {
                tokens.push(Token::Char(ch));
                at += 1;
            }
        }
    }
    let class = |start: usize, end: usize, ch: char| {
        let body = &pattern[start..end];
        let mut index = 0;
        while index < body.len() {
            if index + 2 < body.len() && body[index + 1] == '-' {
                if body[index] <= ch && ch <= body[index + 2] {
                    return true;
                }
                index += 3;
            } else {
                if body[index] == ch {
                    return true;
                }
                index += 1;
            }
        }
        false
    };
    // reach[j]: tokens[..i] can match text[..j].
    let mut reach = vec![false; text.len() + 1];
    reach[0] = true;
    for token in tokens {
        budget.check_time()?;
        let mut next = vec![false; text.len() + 1];
        match token {
            Token::Star | Token::Globstar => {
                let crosses = matches!(token, Token::Globstar);
                for j in 0..=text.len() {
                    if j.is_multiple_of(1024) {
                        budget.check_time()?;
                    }
                    // Either the run starts here, or it extends the run that
                    // reached the previous character.
                    next[j] = reach[j] || (j > 0 && next[j - 1] && (crosses || text[j - 1] != '/'));
                }
            }
            _ => {
                for j in 1..=text.len() {
                    if j.is_multiple_of(1024) {
                        budget.check_time()?;
                    }
                    if !reach[j - 1] {
                        continue;
                    }
                    let ch = text[j - 1];
                    next[j] = match token {
                        Token::Char(expected) => ch == expected,
                        Token::Any => ch != '/',
                        Token::Class(start, end, negated) => {
                            ch != '/' && class(start, end, ch) != negated
                        }
                        Token::Star | Token::Globstar => unreachable!(),
                    };
                }
            }
        }
        reach = next;
    }
    budget.check_time()?;
    Ok(reach[text.len()])
}

fn walk(
    dir: &ScanDir,
    inherited: &[IgnoreRule],
    state: &mut Walk,
    depth: usize,
) -> Result<(), ScanError> {
    state.budget.check_time()?;
    let mut rules = inherited.to_vec();
    let relative = dir.relative().to_string();
    if let BoundedRead::Bytes(bytes) =
        dir.read_bounded(".gitignore", MAX_SOURCE_BYTES, &mut state.budget)?
    {
        if let Ok(text) = std::str::from_utf8(&bytes) {
            rules.extend(parse_gitignore(&relative, text));
        }
    }
    let mut children: Vec<(String, bool)> = Vec::new();
    let mut kept_files = 0usize;
    let files_before = state.files.len();
    let max_files = state.limits.max_files;
    let entry_cap = state.entry_cap;
    let mut read = state.entries;
    let listed = dir.for_each_entry(
        // The entry and time budgets apply while reading, so one very wide
        // folder (generated output, a vendored tree) cannot outrun them. The
        // check runs before the entry's type is resolved and before anything
        // about it is kept.
        || {
            read += 1;
            if read > entry_cap {
                return Err(ScanError::new(
                    "diagram_scan_too_many_entries",
                    format!(
                        "the scan read more than {entry_cap} folder entries (stopped in {})",
                        display(&relative)
                    ),
                    "pick a smaller subfolder, or list generated folders in .gitignore, and scan again",
                ));
            }
            if read.is_multiple_of(256) {
                state.budget.check_time()?;
            }
            Ok(())
        },
        |name: &str, kind: Option<EntryKind>| {
            // A link, a FIFO or any other non-file is skipped by the listing,
            // and `.git` is never walked into: the walk cannot leave the
            // workspace and never reads repository metadata as source.
            let is_dir = match kind.unwrap_or_else(|| dir.classify(name)) {
                EntryKind::Dir if name == ".git" => return Ok(()),
                EntryKind::Dir => true,
                EntryKind::File => false,
                EntryKind::Skip => return Ok(()),
            };
            // Ignored entries are dropped as they are read, never kept or sorted.
            if ignored_with_budget(&rules, &join(&relative, name), is_dir, &state.budget)? {
                return Ok(());
            }
            if !is_dir {
                kept_files += 1;
                if files_before + kept_files > max_files {
                    return Err(ScanError::new(
                        "diagram_scan_too_many_files",
                        format!("the folder holds more than {max_files} files"),
                        format!(
                            "pick a smaller subfolder, or raise maxFiles (up to {MAX_FILES_LIMIT})"
                        ),
                    ));
                }
            }
            children.push((name.to_string(), is_dir));
            Ok(())
        },
    );
    // The count is recorded even when the listing above stopped at the cap, so
    // the refusal and the counter a regression reads agree.
    state.entries = read;
    listed?;
    children.sort();
    for (name, is_dir) in children {
        let path = join(&relative, &name);
        if is_dir {
            if depth + 1 >= usize::from(state.limits.max_depth) {
                return Err(ScanError::new(
                    "diagram_scan_too_deep",
                    format!(
                        "{path} is nested deeper than the {} folder limit",
                        state.limits.max_depth
                    ),
                    format!(
                        "pick a subfolder closer to the code, or raise maxDepth (up to {MAX_DEPTH_LIMIT})"
                    ),
                ));
            }
            let Some(child) = dir.child(&name) else {
                // The folder was replaced with a link, or removed, after it was
                // listed: it is skipped instead of being read through.
                continue;
            };
            walk(&child, &rules, state, depth + 1)?;
        } else {
            state.push(path)?;
        }
    }
    Ok(())
}

fn display(relative: &str) -> &str {
    if relative.is_empty() {
        "the picked folder"
    } else {
        relative
    }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Language {
    Script,
    Rust,
    Python,
}

const SCRIPT_EXTENSIONS: &[&str] = &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];

fn language(path: &str) -> Option<Language> {
    let extension = path.rsplit_once('.').map(|(_, ext)| ext)?;
    if path.ends_with(".d.ts") {
        return None;
    }
    if SCRIPT_EXTENSIONS.contains(&extension) {
        Some(Language::Script)
    } else if extension == "rs" {
        Some(Language::Rust)
    } else if extension == "py" {
        Some(Language::Python)
    } else {
        None
    }
}

/// What one source file refers to: other scanned files, and external packages.
#[derive(Debug, Default)]
struct Refs {
    files: BTreeSet<String>,
    packages: BTreeSet<String>,
}

fn parent_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("")
}

fn join(base: &str, rest: &str) -> String {
    if base.is_empty() {
        rest.to_string()
    } else if rest.is_empty() {
        base.to_string()
    } else {
        format!("{base}/{rest}")
    }
}

/// Normalize `base/relative` lexically; `None` when it climbs above the scan.
fn normalize(base: &str, relative: &str) -> Option<String> {
    let mut parts: Vec<&str> = base.split('/').filter(|part| !part.is_empty()).collect();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

const NODE_BUILTINS: &[&str] = &[
    "assert",
    "buffer",
    "child_process",
    "crypto",
    "dns",
    "events",
    "fs",
    "http",
    "https",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "readline",
    "stream",
    "timers",
    "tls",
    "url",
    "util",
    "vm",
    "worker_threads",
    "zlib",
];

fn script_specifiers(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") || trimmed.starts_with('*') || trimmed.starts_with("/*") {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        for keyword in ["from", "import", "require"] {
            let word: Vec<char> = keyword.chars().collect();
            let mut at = 0;
            while at + word.len() <= chars.len() {
                if chars[at..at + word.len()] != word[..]
                    || (at > 0 && is_ident(chars[at - 1]))
                    || chars.get(at + word.len()).is_some_and(|ch| is_ident(*ch))
                {
                    at += 1;
                    continue;
                }
                let mut cursor = at + word.len();
                while chars.get(cursor).is_some_and(|ch| ch.is_whitespace()) {
                    cursor += 1;
                }
                if chars.get(cursor) == Some(&'(') {
                    cursor += 1;
                    while chars.get(cursor).is_some_and(|ch| ch.is_whitespace()) {
                        cursor += 1;
                    }
                }
                if let Some(quote) = chars
                    .get(cursor)
                    .copied()
                    .filter(|ch| matches!(ch, '\'' | '"' | '`'))
                {
                    if let Some(length) = chars[cursor + 1..].iter().position(|ch| *ch == quote) {
                        let value: String = chars[cursor + 1..cursor + 1 + length].iter().collect();
                        if !value.is_empty() && !value.contains("${") {
                            found.push(value);
                        }
                    }
                }
                at += word.len();
            }
        }
    }
    found
}

fn is_ident(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '$'
}

fn script_package(specifier: &str) -> Option<String> {
    let specifier = specifier.strip_prefix("node:").map_or(specifier, |_| "");
    if specifier.is_empty()
        || specifier.starts_with('.')
        || specifier.starts_with('/')
        || specifier.starts_with("@/")
        || specifier.starts_with('~')
        || specifier.starts_with('#')
    {
        return None;
    }
    let mut parts = specifier.split('/');
    let first = parts.next()?;
    let name = if first.starts_with('@') {
        format!("{first}/{}", parts.next()?)
    } else {
        first.to_string()
    };
    let valid = name.chars().all(|ch| {
        ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '.' | '_' | '@' | '/')
    });
    (valid && !NODE_BUILTINS.contains(&name.as_str())).then_some(name)
}

fn resolve_script(from: &str, specifier: &str, files: &BTreeSet<String>) -> Option<String> {
    if !specifier.starts_with('.') {
        return None;
    }
    let target = normalize(parent_of(from), specifier)?;
    let mut candidates = vec![target.clone()];
    for extension in SCRIPT_EXTENSIONS {
        candidates.push(format!("{target}.{extension}"));
    }
    for extension in SCRIPT_EXTENSIONS {
        candidates.push(join(&target, &format!("index.{extension}")));
    }
    // TypeScript ESM imports name the emitted `.js` file.
    if let Some((stem, extension)) = target.rsplit_once('.') {
        let sources: &[&str] = match extension {
            "js" => &["ts", "tsx"],
            "jsx" => &["tsx"],
            "mjs" => &["mts"],
            "cjs" => &["cts"],
            _ => &[],
        };
        candidates.extend(sources.iter().map(|ext| format!("{stem}.{ext}")));
    }
    candidates
        .into_iter()
        .find(|candidate| files.contains(candidate))
}

/// The folder a Rust module's children live in.
fn rust_module_dir(path: &str) -> String {
    let dir = parent_of(path);
    let file = path.rsplit('/').next().unwrap_or(path);
    if matches!(file, "mod.rs" | "lib.rs" | "main.rs") {
        dir.to_string()
    } else {
        join(dir, file.trim_end_matches(".rs"))
    }
}

/// The `src` folder of the nearest crate above `path`.
fn rust_crate_src(path: &str, files: &BTreeSet<String>) -> Option<String> {
    let mut dir = parent_of(path).to_string();
    loop {
        if files.contains(&join(&dir, "Cargo.toml")) {
            return Some(join(&dir, "src"));
        }
        if dir.is_empty() {
            return None;
        }
        dir = parent_of(&dir).to_string();
    }
}

fn rust_module_file(dir: &str, segments: &[&str], files: &BTreeSet<String>) -> Option<String> {
    for length in (1..=segments.len()).rev() {
        let base = join(dir, &segments[..length].join("/"));
        for candidate in [format!("{base}.rs"), join(&base, "mod.rs")] {
            if files.contains(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn rust_refs(
    path: &str,
    text: &str,
    files: &BTreeSet<String>,
    refs: &mut Refs,
    budget: &Budget,
) -> Result<(), ScanError> {
    let module_dir = rust_module_dir(path);
    for line in text.lines() {
        budget.check_time()?;
        let line = line.trim();
        if line.starts_with("//") {
            continue;
        }
        let line = strip_visibility(line);
        if let Some(rest) = line.strip_prefix("mod ") {
            if let Some(name) = rest.strip_suffix(';').map(str::trim) {
                if !name.is_empty() && name.chars().all(|ch| ch.is_alphanumeric() || ch == '_') {
                    if let Some(file) = rust_module_file(&module_dir, &[name], files) {
                        refs.files.insert(file);
                    }
                }
            }
            continue;
        }
        let path_text = if let Some(rest) = line.strip_prefix("use ") {
            rest
        } else if let Some(rest) = line.strip_prefix("extern crate ") {
            rest
        } else {
            continue;
        };
        let path_text = path_text.trim_start_matches("::");
        let segments: Vec<&str> = path_text
            .split("::")
            .map(|segment| {
                segment
                    .split(|ch: char| !(ch.is_alphanumeric() || ch == '_'))
                    .next()
                    .unwrap_or("")
            })
            .take_while(|segment| !segment.is_empty())
            // A long `use a::a::...` path is cut, so resolution stays linear.
            .take(MAX_USE_SEGMENTS)
            .collect();
        let Some((first, rest)) = segments.split_first() else {
            continue;
        };
        match *first {
            "crate" => {
                if let Some(src) = rust_crate_src(path, files) {
                    if let Some(file) = rust_module_file(&src, rest, files) {
                        refs.files.insert(file);
                    }
                }
            }
            "self" | "super" => {
                let mut dir = module_dir.clone();
                let mut rest = rest;
                if *first == "super" {
                    dir = parent_of(&dir).to_string();
                }
                while let Some(("super", tail)) =
                    rest.split_first().map(|(head, tail)| (*head, tail))
                {
                    dir = parent_of(&dir).to_string();
                    rest = tail;
                }
                if let Some(file) = rust_module_file(&dir, rest, files) {
                    refs.files.insert(file);
                }
            }
            "std" | "core" | "alloc" => {}
            name => {
                refs.packages.insert(name.replace('_', "-"));
            }
        }
    }
    Ok(())
}

fn strip_visibility(line: &str) -> &str {
    let mut line = line;
    loop {
        if let Some(rest) = line.strip_prefix("pub ") {
            line = rest.trim_start();
        } else if line.starts_with("pub(") {
            match line.find(')') {
                Some(close) => line = line[close + 1..].trim_start(),
                None => return line,
            }
        } else {
            return line;
        }
    }
}

fn python_module_file(base: &str, dotted: &str, files: &BTreeSet<String>) -> Option<String> {
    // A long `import a.a.a...` is cut, so the prefix search stays linear.
    let segments: Vec<&str> = dotted
        .split('.')
        .filter(|part| !part.is_empty())
        .take(MAX_USE_SEGMENTS)
        .collect();
    for length in (1..=segments.len()).rev() {
        let target = join(base, &segments[..length].join("/"));
        for candidate in [format!("{target}.py"), join(&target, "__init__.py")] {
            if files.contains(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Folders an absolute Python import may start from: the scan root, `src`,
/// and the folder above the importing file's top package.
fn python_roots(path: &str, files: &BTreeSet<String>) -> Vec<String> {
    let mut roots = vec![String::new(), "src".to_string()];
    let mut dir = parent_of(path).to_string();
    while !dir.is_empty() && files.contains(&join(&dir, "__init__.py")) {
        dir = parent_of(&dir).to_string();
    }
    if !roots.contains(&dir) {
        roots.push(dir);
    }
    roots
}

/// Standard-library modules that are not external packages.
const PYTHON_STDLIB: &[&str] = &[
    "__future__",
    "abc",
    "argparse",
    "asyncio",
    "base64",
    "collections",
    "contextlib",
    "copy",
    "csv",
    "dataclasses",
    "datetime",
    "enum",
    "functools",
    "glob",
    "hashlib",
    "heapq",
    "http",
    "importlib",
    "io",
    "itertools",
    "json",
    "logging",
    "math",
    "multiprocessing",
    "operator",
    "os",
    "pathlib",
    "pickle",
    "platform",
    "queue",
    "random",
    "re",
    "shutil",
    "signal",
    "socket",
    "sqlite3",
    "statistics",
    "string",
    "struct",
    "subprocess",
    "sys",
    "tempfile",
    "textwrap",
    "threading",
    "time",
    "traceback",
    "typing",
    "unittest",
    "urllib",
    "uuid",
    "warnings",
    "weakref",
    "xml",
    "zipfile",
];

fn python_refs(
    path: &str,
    text: &str,
    files: &BTreeSet<String>,
    refs: &mut Refs,
    budget: &Budget,
) -> Result<(), ScanError> {
    let roots = python_roots(path, files);
    // An import no scanned file answers is an external package.
    let absolute = |module: &str, refs: &mut Refs| {
        for root in &roots {
            if let Some(file) = python_module_file(root, module, files) {
                refs.files.insert(file);
                return;
            }
        }
        let top = module.split('.').next().unwrap_or("");
        if !top.is_empty()
            && top.chars().all(|ch| ch.is_alphanumeric() || ch == '_')
            && !PYTHON_STDLIB.contains(&top)
        {
            refs.packages.insert(top.to_string());
        }
    };
    for line in text.lines() {
        budget.check_time()?;
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("import ") {
            for item in rest.split(',') {
                let module = item.split_whitespace().next().unwrap_or("");
                if !module.is_empty() {
                    absolute(module, refs);
                }
            }
        } else if let Some(rest) = line.strip_prefix("from ") {
            let mut parts = rest.splitn(2, " import ");
            let module = parts.next().unwrap_or("").trim();
            let names = parts.next().unwrap_or("");
            if module.is_empty() {
                continue;
            }
            let dots = module.chars().take_while(|ch| *ch == '.').count();
            if dots == 0 {
                absolute(module, refs);
                continue;
            }
            let mut base = parent_of(path).to_string();
            for _ in 1..dots {
                base = parent_of(&base).to_string();
            }
            let tail = &module[dots..];
            if !tail.is_empty() {
                if let Some(file) = python_module_file(&base, tail, files) {
                    refs.files.insert(file);
                }
                continue;
            }
            // `from . import a, b`: each name may be a module of the package.
            let mut found = false;
            for name in names.trim_matches(|ch| ch == '(' || ch == ')').split(',') {
                let name = name.split_whitespace().next().unwrap_or("");
                if let Some(file) = python_module_file(&base, name, files) {
                    refs.files.insert(file);
                    found = true;
                }
            }
            if !found {
                let init = join(&base, "__init__.py");
                if files.contains(&init) {
                    refs.files.insert(init);
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The proposed map
// ---------------------------------------------------------------------------

fn node_id(group: &str) -> String {
    if group.is_empty() {
        return "root".into();
    }
    group
        .split('/')
        .map(|segment| {
            let cleaned: String = segment
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
                        ch
                    } else {
                        '-'
                    }
                })
                .collect();
            let cleaned = cleaned.trim_matches('-').to_string();
            if cleaned.is_empty() {
                "dir".to_string()
            } else {
                cleaned
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}

fn node_kind(group: &str) -> &'static str {
    let name = group
        .rsplit('/')
        .next()
        .unwrap_or(group)
        .to_ascii_lowercase();
    let name = name.trim_start_matches('.');
    match name {
        "test" | "tests" | "__tests__" | "spec" | "specs" | "e2e" | "testdata" | "fixtures" => {
            "test"
        }
        "scripts" | "script" | "bin" | "tools" => "script",
        "ui" | "components" | "app" | "web" | "frontend" | "pages" | "views" | "client" => "ui",
        "config" | "configs" | "github" | "settings" => "config",
        "infra" | "deploy" | "docker" | "terraform" | "k8s" | "ops" => "infra",
        "data" | "db" | "migrations" | "schema" | "schemas" => "data",
        "worker" | "workers" | "jobs" | "queue" => "worker",
        "server" | "api" | "service" | "services" | "backend" => "service",
        "docs" | "doc" => "feature",
        _ => "library",
    }
}

/// The node a file belongs to: its folder, cut to [`GROUP_DEPTH`] levels.
fn group_of(file: &str) -> String {
    let dir = parent_of(file);
    if dir.is_empty() {
        return String::new();
    }
    dir.split('/')
        .take(GROUP_DEPTH)
        .collect::<Vec<_>>()
        .join("/")
}

fn propose(
    anchor: &RootAnchor,
    root_relative: &str,
    name: &str,
    files: &[String],
    inventory: Inventory,
    budget: &mut Budget,
) -> Result<(Value, ScanStats), ScanError> {
    let file_set: BTreeSet<String> = files.iter().cloned().collect();
    let mut groups: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    for file in files {
        let extension = file
            .rsplit('/')
            .next()
            .and_then(|base| base.rsplit_once('.'))
            .map(|(_, ext)| ext.to_ascii_lowercase())
            .unwrap_or_else(|| "other".into());
        *groups
            .entry(group_of(file))
            .or_default()
            .entry(extension)
            .or_default() += 1;
    }
    // Every ancestor of a group is a node, so `a/b` always has `a` as parent.
    let ancestors: Vec<String> = groups
        .keys()
        .filter(|group| group.contains('/'))
        .map(|group| parent_of(group).to_string())
        .collect();
    for ancestor in ancestors {
        groups.entry(ancestor).or_default();
    }
    if groups.len() > MAX_NODES {
        return Err(ScanError::new(
            "diagram_scan_too_many_nodes",
            format!("the map would hold more than {MAX_NODES} folders"),
            "pick a smaller subfolder and scan again",
        ));
    }

    let mut ids: HashMap<String, String> = HashMap::new();
    let mut used: BTreeSet<String> = BTreeSet::new();
    for group in groups.keys() {
        let base = node_id(group);
        let mut id = base.clone();
        let mut suffix = 2;
        while !used.insert(id.clone()) {
            id = format!("{base}-{suffix}");
            suffix += 1;
        }
        ids.insert(group.clone(), id);
    }

    let mut source_files = 0usize;
    let mut skipped_large = 0usize;
    let mut file_imports = 0usize;
    let mut edges: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut packages: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut entrypoints = Vec::new();
    for file in files {
        let Some(lang) = language(file) else {
            continue;
        };
        source_files += 1;
        budget.check_time()?;
        let base = file.rsplit('/').next().unwrap_or(file);
        let depth = file.matches('/').count();
        if depth <= 1
            && matches!(
                base,
                "main.rs"
                    | "lib.rs"
                    | "main.ts"
                    | "index.ts"
                    | "main.py"
                    | "__main__.py"
                    | "cli.ts"
                    | "index.js"
                    | "main.js"
            )
        {
            entrypoints.push(file.clone());
        }
        // Resolved from the root handle for this read, so a folder replaced by
        // a link after the inventory is skipped rather than read through.
        let bytes =
            match anchor.read_bounded(&join(root_relative, file), MAX_SOURCE_BYTES, budget)? {
                BoundedRead::Bytes(bytes) => bytes,
                BoundedRead::TooLarge => {
                    skipped_large += 1;
                    continue;
                }
                BoundedRead::Unreadable => continue,
            };
        let text = String::from_utf8_lossy(&bytes);
        let mut refs = Refs::default();
        match lang {
            Language::Script => {
                for specifier in script_specifiers(&text) {
                    if let Some(target) = resolve_script(file, &specifier, &file_set) {
                        refs.files.insert(target);
                    } else if let Some(package) = script_package(&specifier) {
                        refs.packages.insert(package);
                    }
                }
            }
            Language::Rust => rust_refs(file, &text, &file_set, &mut refs, budget)?,
            Language::Python => python_refs(file, &text, &file_set, &mut refs, budget)?,
        }
        let from = group_of(file);
        refs.files.remove(file);
        file_imports += refs.files.len();
        for target in refs.files {
            let to = group_of(&target);
            if to != from {
                *edges.entry((from.clone(), to)).or_default() += 1;
                if edges.len() > MAX_EDGES {
                    return Err(ScanError::new(
                        "diagram_scan_too_many_edges",
                        format!("the map would hold more than {MAX_EDGES} import links"),
                        "pick a smaller subfolder and scan again",
                    ));
                }
            }
        }
        if !refs.packages.is_empty() {
            packages.entry(from).or_default().extend(refs.packages);
        }
    }
    budget.check_time()?;

    let nodes: Vec<Value> = groups
        .iter()
        .map(|(group, extensions)| {
            let id = &ids[group];
            let label = if group.is_empty() {
                "Top-level files".to_string()
            } else {
                group.rsplit('/').next().unwrap_or(group).to_string()
            };
            let count: usize = extensions.values().sum();
            let mut node = json!({
                "id": id,
                "label": label,
                "kind": if group.is_empty() { "config" } else { node_kind(group) },
                "paths": [if group.is_empty() { "*".to_string() } else { format!("{group}/**") }],
            });
            if count > 0 {
                let mix = extensions
                    .iter()
                    .map(|(extension, n)| format!("{extension} {n}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                node["summary"] = json!(format!(
                    "{count} file{} directly here ({mix})",
                    if count == 1 { "" } else { "s" }
                ));
            }
            if group.contains('/') {
                node["parent"] = json!(ids[parent_of(group)]);
            }
            if let Some(names) = packages.get(group) {
                node["packages"] = json!(names.iter().collect::<Vec<_>>());
            }
            node
        })
        .collect();
    let edge_values: Vec<Value> = edges
        .keys()
        .map(|(from, to)| json!({ "from": ids[from], "to": ids[to], "kind": "import" }))
        .collect();
    let mut project = json!({
        "name": name,
        "summary": format!(
            "Proposed by the Maru repository scan from {} files: folders become nodes and source imports become edges. Review before saving.",
            files.len()
        ),
    });
    if !entrypoints.is_empty() {
        project["entrypoints"] = json!(entrypoints);
    }
    let stats = ScanStats {
        inventory,
        files: files.len(),
        source_files,
        file_imports,
        skipped_large,
        nodes: nodes.len(),
        edges: edge_values.len(),
    };
    let document = json!({
        "$schema": "floorplan/architecture@1",
        "audience": "developers",
        "project": project,
        "nodes": nodes,
        "edges": edge_values,
    });
    Ok((document, stats))
}

#[cfg(test)]
#[path = "scan_tests.rs"]
mod tests;
