use chrono::{DateTime, Utc};
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use walkdir::WalkDir;

use include_dir::{include_dir, Dir};

use crate::skill_host::fs as host_fs;

const VAULT_CACHE_REL: &[&str] = &[".maru", "cache", "workspace-index-v2.json"];
const GENERATED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
];

/// The curated sample workspace, embedded into the binary at compile time so it
/// ships inside the installer on every platform (same mechanism as the builtin
/// `skills/` bundle). Materialized to a writable location on first run by
/// `sample_workspace_path`.
static SAMPLE_WORKSPACE_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../sample-workspace");

fn h1_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^#\s+(.+)$").expect("valid h1 regex"))
}

fn html_h1_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<h1[^>]*>(.*?)</h1>").expect("valid html h1 regex"))
}

fn html_tags_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<[^>]+>").expect("valid tag regex"))
}

fn markdown_markup_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^[-*#>\s]+").expect("valid markdown regex"))
}

fn wikilink_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]").expect("valid wikilink regex"))
}

fn push_wikilinks_from_str(s: &str, out: &mut Vec<String>) {
    for cap in wikilink_re().captures_iter(s) {
        let target = cap[1].trim();
        if !target.is_empty() {
            out.push(target.to_string());
        }
    }
}

fn collect_meta_wikilinks(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => push_wikilinks_from_str(s, out),
        Value::Sequence(seq) => {
            for v in seq {
                collect_meta_wikilinks(v, out);
            }
        }
        Value::Mapping(map) => {
            for (_k, v) in map {
                collect_meta_wikilinks(v, out);
            }
        }
        _ => {}
    }
}

/// Extract every `[[wikilink]]` target from the body and any frontmatter
/// string value, deduped preserving first-seen order. Mirrors the frontend
/// `collectWikilinkTargets` so backlink resolution agrees in both places.
fn extract_links(meta: &BTreeMap<String, Value>, body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    push_wikilinks_from_str(body, &mut out);
    for value in meta.values() {
        collect_meta_wikilinks(value, &mut out);
    }
    let mut seen = std::collections::HashSet::new();
    out.into_iter().filter(|t| seen.insert(t.clone())).collect()
}

/// VaultEntry — minimal representation of a vault note for listing.
/// Phase 0 keeps only filesystem-derived facts plus the raw frontmatter
/// map. Typed lenses (status, project, people, tags…) are reconstructed
/// in Phase 1 by inspecting `frontmatter` rather than baking them into
/// the Rust struct.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub path: String,
    pub rel_path: String,
    pub title: String,
    pub frontmatter: BTreeMap<String, Value>,
    pub updated_at: Option<String>,
    pub word_count: usize,
    pub snippet: String,
    pub file_kind: String,
    pub version_count: usize,
    /// Raw `[[wikilink]]` targets found in the body + frontmatter. Lets the
    /// frontend compute backlinks (which notes point here) without re-reading
    /// every file. `#[serde(default)]` keeps deserialization tolerant of cache
    /// files or test fixtures that predate this field.
    #[serde(default)]
    pub links: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterParts {
    pub meta: BTreeMap<String, Value>,
    pub body: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    #[serde(default)]
    pub include_dot_folders: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ScanFilter {
    include_dot_folders: Vec<PathBuf>,
}

impl ScanFilter {
    pub fn from_options(options: Option<ScanOptions>) -> Result<Self, String> {
        let Some(options) = options else {
            return Ok(Self::default());
        };
        let mut include_dot_folders = Vec::new();
        for raw in options.include_dot_folders {
            let trimmed = raw.trim().replace('\\', "/");
            let normalized = trimmed.trim_matches('/').to_string();
            if normalized.is_empty() {
                return Err("dot_folder_include_required".to_string());
            }
            if normalized.contains('*') || normalized.contains('?') {
                return Err(format!("dot_folder_include_glob_unsupported: {normalized}"));
            }
            let path = Path::new(&normalized);
            if path.is_absolute()
                || path
                    .components()
                    .any(|component| matches!(component, Component::ParentDir))
            {
                return Err(format!(
                    "dot_folder_include_outside_workspace: {normalized}"
                ));
            }
            let has_dot_segment = path.components().any(|component| {
                matches!(component, Component::Normal(value) if value.to_string_lossy().starts_with('.'))
            });
            if !has_dot_segment {
                return Err(format!(
                    "dot_folder_include_missing_dot_segment: {normalized}"
                ));
            }
            include_dot_folders.push(PathBuf::from(normalized));
        }
        Ok(Self {
            include_dot_folders,
        })
    }

    pub fn includes_dot_folders(&self) -> bool {
        !self.include_dot_folders.is_empty()
    }

    pub fn is_excluded_path(&self, path: &Path, root: &Path, generated_dirs: &[&str]) -> bool {
        let Ok(rel) = path.strip_prefix(root) else {
            return true;
        };
        if rel.as_os_str().is_empty() {
            return false;
        }
        let mut has_dot_segment = false;
        for component in rel.components() {
            let Component::Normal(value) = component else {
                continue;
            };
            let name = value.to_string_lossy();
            if generated_dirs.iter().any(|dir| name == *dir) {
                return true;
            }
            if name.starts_with('.') {
                has_dot_segment = true;
            }
        }
        has_dot_segment && !self.dot_path_allowed(rel)
    }

    fn dot_path_allowed(&self, rel: &Path) -> bool {
        self.include_dot_folders
            .iter()
            .any(|allowed| rel.starts_with(allowed) || allowed.starts_with(rel))
    }
}

#[tauri::command]
pub fn default_vault_path() -> Result<String, String> {
    let base = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Cannot resolve a user documents directory".to_string())?;
    Ok(base.join("AI workspace").to_string_lossy().to_string())
}

#[tauri::command]
pub fn sample_workspace_path() -> Result<String, String> {
    let root = host_fs::maru_home()?.join("sample-workspace");
    host_fs::ensure_dir(&root)?;
    seed_dir_if_missing(&SAMPLE_WORKSPACE_DIR, &root)?;
    Ok(root.to_string_lossy().to_string())
}

/// Write each embedded sample file into `root`, but only if it does not already
/// exist. Never overwrites a user's edits and never deletes, so reopening the
/// sample workspace is idempotent and safe. The old implementation returned an
/// `env!("CARGO_MANIFEST_DIR")` path that only existed on the build machine, so
/// shipped installers had no sample at all; embedding + materializing fixes that.
fn seed_dir_if_missing(dir: &Dir<'_>, root: &Path) -> Result<(), String> {
    for file in dir.files() {
        // `file.path()` is the path relative to the embed root, e.g.
        // `references/maru-glossary.md`, so it joins straight onto `root`.
        let target = root.join(file.path());
        if target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Cannot create {}: {err}", parent.display()))?;
        }
        fs::write(&target, file.contents())
            .map_err(|err| format!("Cannot write {}: {err}", target.display()))?;
    }
    for child in dir.dirs() {
        seed_dir_if_missing(child, root)?;
    }
    Ok(())
}

#[tauri::command]
pub fn scan_vault(
    vault_path: String,
    scan_options: Option<ScanOptions>,
) -> Result<Vec<VaultEntry>, String> {
    let vault = normalize_existing_dir(&vault_path)?;
    let scan_filter = ScanFilter::from_options(scan_options)?;
    let ignore_patterns = load_maruignore(&vault);
    let version_names = collect_version_names(&vault);

    // Collect candidate paths sequentially (walkdir isn't thread-safe and
    // benefits little from parallelism — directory traversal is I/O bound),
    // then fan out the per-file read+parse across rayon's thread pool. On
    // the user's ~/workspace/work (7,100 .md files) the warm scan went from
    // 2.78s single-threaded to a fraction of that on a multi-core machine —
    // the YAML parse + h1 regex per file is the dominant cost.
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(&vault)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Skip hidden/system directories early so walkdir doesn't recurse
            // into node_modules, .git, .venv, etc. on a 50k-file work tree.
            let path = e.path();
            if path == vault {
                return true;
            }
            if scan_filter.is_excluded_path(path, &vault, GENERATED_DIRS) {
                return false;
            }
            let rel = path.strip_prefix(&vault).unwrap_or(path);
            !matches_maruignore(rel, &ignore_patterns)
        })
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !matches!(ext, "md" | "markdown" | "html" | "htm") {
            continue;
        }
        candidates.push(path.to_path_buf());
    }

    let mut entries: Vec<VaultEntry> = candidates
        .par_iter()
        .filter_map(|path| read_entry(path, &vault, &version_names).ok())
        .collect();

    entries.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });
    if !scan_filter.includes_dot_folders() {
        let _ = write_vault_cache(&vault, &entries);
    }
    Ok(entries)
}

#[tauri::command]
pub fn read_vault_cache(vault_path: String) -> Result<Option<Vec<VaultEntry>>, String> {
    let vault = normalize_existing_dir(&vault_path)?;
    let path = vault_cache_path(&vault);
    if !path.exists() {
        return Ok(None);
    }
    let Ok(content) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    if content.trim().is_empty() {
        return Ok(None);
    }
    match serde_json::from_str::<Vec<VaultEntry>>(&content) {
        Ok(entries) => Ok(Some(entries)),
        Err(_) => Ok(None),
    }
}

pub fn normalize_existing_dir(input: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(input);
    if !path.exists() {
        fs::create_dir_all(&path)
            .map_err(|err| format!("Cannot create workspace directory: {err}"))?;
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("Cannot open workspace directory: {err}"))?;
    if !canonical.is_dir() {
        return Err("Workspace path is not a directory".to_string());
    }
    Ok(canonical)
}

pub fn resolve_inside_vault(vault_path: &str, document_path: &str) -> Result<PathBuf, String> {
    let vault = normalize_existing_dir(vault_path)?;
    let raw = PathBuf::from(document_path);
    let candidate = if raw.is_absolute() {
        raw
    } else {
        vault.join(raw)
    };

    // Lexical containment: resolve `..`/`.` without following symlinks, then
    // require the result to live under the canonicalized vault root. Using
    // canonicalize() here was wrong — it follows symlinks, so a deliberate
    // symlink inside the vault (e.g. work/inbox/downloads → ~/gdrive-workspace/…)
    // would resolve outside the vault and falsely trigger an "escapes" error.
    // Path traversal via `..` is still blocked by lexical_normalize.
    let normalized = lexical_normalize(&candidate);
    if normalized.starts_with(&vault) {
        return Ok(normalized);
    }

    // Workspace root itself might be a symlink (canonicalize earlier resolved it,
    // but the caller may have passed entries scanned from the un-resolved
    // form). Try canonicalizing the candidate as a fallback — if it lands
    // inside the canonical vault, allow.
    if let Ok(canon) = normalized.canonicalize() {
        if canon.starts_with(&vault) {
            return Ok(canon);
        }
    }

    Err("Document path escapes the selected workspace".to_string())
}

/// Resolve `..` and `.` lexically, leaving symlinks untouched. Equivalent to
/// Go's `filepath.Clean` minus separator collapsing (which `PathBuf` already
/// handles). Used for vault-containment checks where canonicalize() is wrong
/// because it follows symlinks.
pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                // Don't pop past the root or above an empty/relative prefix.
                let popped = out.pop();
                if !popped {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn parse_frontmatter(content: &str) -> FrontmatterParts {
    if !content.starts_with("---\n") {
        return FrontmatterParts {
            meta: BTreeMap::new(),
            body: content.to_string(),
        };
    }
    let Some(end) = content[4..].find("\n---") else {
        return FrontmatterParts {
            meta: BTreeMap::new(),
            body: content.to_string(),
        };
    };
    let yaml_end = end + 4;
    let yaml = &content[4..yaml_end];
    let body_start = yaml_end + 4;
    let body = content.get(body_start..).unwrap_or_default();
    let meta = serde_yaml::from_str::<BTreeMap<String, Value>>(yaml)
        .unwrap_or_default()
        .into_iter()
        .map(|(key, value)| (key, json_safe_value(value)))
        .collect();
    FrontmatterParts {
        meta,
        body: body.trim_start_matches('\n').to_string(),
    }
}

/// YAML mappings may carry non-string keys — template placeholders like
/// `date: {{date}}` parse as a flow mapping keyed by another mapping. JSON
/// (the Tauri IPC wire format) requires string keys, so one such entry made
/// the whole `scan_vault` response fail with "key must be a string" and the
/// document list render empty. Coerce every mapping key to a string (and
/// unwrap tags) so frontmatter is always JSON-serializable.
fn json_safe_value(value: Value) -> Value {
    match value {
        Value::Mapping(map) => {
            let mut out = serde_yaml::Mapping::new();
            for (key, val) in map {
                let key = match key {
                    Value::String(s) => s,
                    Value::Bool(b) => b.to_string(),
                    Value::Number(n) => n.to_string(),
                    Value::Null => "null".to_string(),
                    other => serde_yaml::to_string(&other)
                        .unwrap_or_else(|_| "invalid-key".to_string())
                        .trim()
                        .to_string(),
                };
                out.insert(Value::String(key), json_safe_value(val));
            }
            Value::Mapping(out)
        }
        Value::Sequence(seq) => {
            Value::Sequence(seq.into_iter().map(json_safe_value).collect())
        }
        Value::Tagged(tagged) => json_safe_value(tagged.value),
        other => other,
    }
}

pub fn title_from_content(content: &str, fallback: &str) -> String {
    let body = parse_frontmatter(content).body;
    title_from_body(&body, fallback)
}

fn title_from_body(body: &str, fallback: &str) -> String {
    if let Some(capture) = h1_re().captures(body) {
        return capture
            .get(1)
            .map(|m| clean_text(m.as_str()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback.to_string());
    }

    if let Some(capture) = html_h1_re().captures(body) {
        return capture
            .get(1)
            .map(|m| clean_text(m.as_str()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback.to_string());
    }

    fallback.to_string()
}

pub fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in input.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if ch.is_whitespace() || matches!(ch, '-' | '_' | '.' | '/') {
            if !last_dash && !out.is_empty() {
                out.push('-');
                last_dash = true;
            }
        } else if ('가'..='힣').contains(&ch) {
            out.push(ch);
            last_dash = false;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed
    }
}

fn read_entry(path: &Path, vault: &Path, version_names: &[String]) -> Result<VaultEntry, String> {
    let content = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let parts = parse_frontmatter(&content);
    let fallback = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled");
    let title = title_from_body(&parts.body, fallback);
    let rel_path = path
        .strip_prefix(vault)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    let file_kind = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("md")
        .to_string();
    let metadata = fs::metadata(path).ok();
    let modified = metadata
        .and_then(|m| m.modified().ok())
        .map(DateTime::<Utc>::from)
        .map(|dt| dt.to_rfc3339());
    let snippet = clean_text(&parts.body)
        .chars()
        .take(240)
        .collect::<String>();
    let word_count = parts
        .body
        .split_whitespace()
        .filter(|part| !part.trim().is_empty())
        .count();
    let links = extract_links(&parts.meta, &parts.body);

    Ok(VaultEntry {
        path: path.to_string_lossy().to_string(),
        rel_path,
        title,
        frontmatter: parts.meta,
        updated_at: modified,
        word_count,
        snippet,
        file_kind,
        version_count: count_versions_from_names(path, version_names),
        links,
    })
}

/// Built-in patterns that any workspace should ignore even without an
/// explicit `.maruignore`. macOS / Windows / git noise that has
/// nothing to do with the user's notes.
pub const DEFAULT_MARU_IGNORE: &[&str] =
    &[".DS_Store", ".gitkeep", ".keep", "Thumbs.db", "Icon\r"];

/// Load `.maruignore` patterns from the workspace root, merged with the
/// built-in defaults. Each non-comment, non-empty line is a pattern.
/// Comparison is plain prefix / segment match (no glob support yet —
/// gitignore-like patterns can be added in Phase 1 if real-world workspaces
/// need them).
pub fn load_maruignore(vault: &Path) -> Vec<String> {
    let mut patterns: Vec<String> = DEFAULT_MARU_IGNORE
        .iter()
        .map(|p| (*p).to_string())
        .collect();
    // `.maruignore` preferred; fall back to the pre-M0 `.anchorignore` so
    // existing user vaults keep working (DR-024 §5).
    let mut path = vault.join(".maruignore");
    if !path.exists() {
        path = vault.join(".anchorignore");
    }
    if !path.exists() {
        return patterns;
    }
    let Ok(content) = fs::read_to_string(&path) else {
        return patterns;
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let owned = trimmed.to_string();
        if !patterns.iter().any(|existing| existing == &owned) {
            patterns.push(owned);
        }
    }
    patterns
}

pub fn matches_maruignore(rel_path: &Path, patterns: &[String]) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let rel_str = rel_path.to_string_lossy().replace('\\', "/");
    patterns.iter().any(|pattern| {
        let pat = pattern.trim_start_matches('/').trim_end_matches('/');
        if pat.is_empty() {
            return false;
        }
        rel_str == pat
            || rel_str.starts_with(&format!("{pat}/"))
            || rel_str.split('/').any(|seg| seg == pat)
    })
}

fn clean_text(input: &str) -> String {
    let without_tags = html_tags_re().replace_all(input, " ");
    let without_markup = markdown_markup_re().replace_all(&without_tags, "");
    without_markup
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn count_versions_from_names(path: &Path, version_names: &[String]) -> usize {
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
        return 0;
    };
    version_names
        .iter()
        .filter(|name| name.starts_with(stem))
        .count()
}

fn collect_version_names(vault: &Path) -> Vec<String> {
    let dir = vault.join(".maru").join("versions");
    if !dir.exists() {
        return Vec::new();
    }
    WalkDir::new(dir)
        .max_depth(1)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            entry
                .path()
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::to_string)
        })
        .collect()
}

fn vault_cache_path(vault: &Path) -> PathBuf {
    VAULT_CACHE_REL
        .iter()
        .fold(vault.to_path_buf(), |acc, part| acc.join(part))
}

fn write_vault_cache(vault: &Path, entries: &[VaultEntry]) -> Result<(), String> {
    let path = vault_cache_path(vault);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create workspace cache directory: {err}"))?;
    }
    let serialized = serde_json::to_string(entries)
        .map_err(|err| format!("Cannot serialize workspace cache: {err}"))?;
    fs::write(&path, serialized).map_err(|err| format!("Cannot write workspace cache: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_file(dir: &Path, rel: &str, content: &str) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn scan_vault_finds_deep_notes() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(root, "top.md", "# Top\n");
        write_file(root, "a/b/c/d/e/f/g/deep.md", "# Deep\n");
        let entries = scan_vault(root.to_string_lossy().to_string(), None).unwrap();
        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert!(titles.contains(&"Top"));
        assert!(
            titles.contains(&"Deep"),
            "deep notes must be found regardless of depth"
        );
    }

    #[test]
    fn scan_vault_respects_maruignore() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(root, ".maruignore", "skipme\n_sys/env\n");
        write_file(root, "keep.md", "# Keep\n");
        write_file(root, "skipme/inside.md", "# Inside\n");
        write_file(root, "_sys/env/python.md", "# Python\n");
        let entries = scan_vault(root.to_string_lossy().to_string(), None).unwrap();
        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert!(titles.contains(&"Keep"));
        assert!(!titles.contains(&"Inside"), "skipme/ must be excluded");
        assert!(!titles.contains(&"Python"), "_sys/env/ must be excluded");
    }

    #[test]
    fn scan_vault_exposes_raw_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(
            root,
            "note.md",
            "---\ntype: meeting\nstatus: 진행중\nproject: \"[[RISE]]\"\n---\n# Hello\n",
        );
        let entries = scan_vault(root.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(entries.len(), 1);
        let fm = &entries[0].frontmatter;
        assert_eq!(
            fm.get("type").and_then(Value::as_str),
            Some("meeting"),
            "raw frontmatter must surface type"
        );
        assert_eq!(
            fm.get("status").and_then(Value::as_str),
            Some("진행중"),
            "Korean values must round-trip through scan"
        );
    }

    #[test]
    fn scan_vault_extracts_wikilinks_from_body_and_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(
            root,
            "note.md",
            "---\nproject: \"[[Alpha]]\"\nrelated:\n  - \"[[Bravo]]\"\n---\n# Hello\nSee [[Charlie]] and [[Charlie]] and [[Delta|nickname]].\n",
        );
        let entries = scan_vault(root.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(entries.len(), 1);
        let links = &entries[0].links;
        assert!(links.contains(&"Charlie".to_string()), "body links surface");
        assert!(
            links.contains(&"Delta".to_string()),
            "pipe alias keeps target"
        );
        assert!(
            links.contains(&"Alpha".to_string()),
            "frontmatter scalar links surface"
        );
        assert!(
            links.contains(&"Bravo".to_string()),
            "frontmatter list links surface"
        );
        assert_eq!(
            links.iter().filter(|t| *t == "Charlie").count(),
            1,
            "duplicate targets are deduped"
        );
    }

    #[test]
    fn frontmatter_with_template_placeholders_is_json_serializable() {
        // `{{date}}` parses as a YAML flow mapping keyed by a mapping —
        // without sanitization the JSON IPC serialization of the whole scan
        // failed with "key must be a string" (0 documents + error toast).
        let content = "---\ntitle: \"{{title}}\"\ndate: {{date}}\nbu: {{bu}}\nnested:\n  1: one\n  true: yes\n---\n\n# 본문\n";
        let parts = parse_frontmatter(content);
        let json = serde_json::to_string(&parts.meta)
            .expect("frontmatter must always be JSON-serializable");
        assert!(json.contains("\"title\""));
        // Non-string nested keys are coerced to strings.
        assert!(json.contains("\"1\":\"one\""));
    }

    #[test]
    fn resolve_inside_vault_accepts_relative_path() {
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "note.md", "# X\n");
        let resolved = resolve_inside_vault(tmp.path().to_str().unwrap(), "note.md").unwrap();
        assert!(resolved.ends_with("note.md"));
    }

    #[test]
    fn resolve_inside_vault_accepts_absolute_path_inside_vault() {
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "sub/note.md", "# X\n");
        let canonical_vault = tmp.path().canonicalize().unwrap();
        let abs = canonical_vault.join("sub").join("note.md");
        let resolved =
            resolve_inside_vault(canonical_vault.to_str().unwrap(), abs.to_str().unwrap()).unwrap();
        assert!(resolved.ends_with("sub/note.md"));
    }

    #[test]
    fn resolve_inside_vault_rejects_path_traversal() {
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "note.md", "# X\n");
        // Try to climb out via `..`
        let result = resolve_inside_vault(tmp.path().to_str().unwrap(), "../escaped.md");
        assert!(result.is_err(), "`..` traversal must be rejected");
    }

    #[test]
    fn resolve_inside_vault_rejects_absolute_outside_vault() {
        let tmp = TempDir::new().unwrap();
        let result = resolve_inside_vault(tmp.path().to_str().unwrap(), "/etc/passwd");
        assert!(result.is_err());
    }

    /// The bug that caused this fix: with the old canonicalize-and-starts-with
    /// approach, a symlink inside the vault that pointed outside (e.g.
    /// `inbox/downloads → ~/gdrive-workspace/work/inbox/downloads`) would make
    /// every file under the symlink falsely escape the vault. The lexical
    /// containment approach must allow these paths since the user explicitly
    /// set them up.
    #[cfg(unix)]
    #[test]
    fn resolve_inside_vault_allows_symlink_inside_vault() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        write_file(outside.path(), "linked.md", "# linked\n");
        // Create a symlink INSIDE the vault that points OUTSIDE.
        let link = tmp.path().join("downloads");
        symlink(outside.path(), &link).unwrap();
        // Lexical path is /vault/downloads/linked.md — inside vault. The old
        // canonicalize() would resolve through the symlink to outside.tmp/linked.md
        // and reject. The new lexical_normalize must accept.
        let resolved =
            resolve_inside_vault(tmp.path().to_str().unwrap(), "downloads/linked.md").unwrap();
        assert!(
            resolved.ends_with("downloads/linked.md"),
            "symlink-traversed path inside vault must be allowed (got {resolved:?})"
        );
    }

    #[test]
    fn lexical_normalize_resolves_dot_dot() {
        let p = lexical_normalize(Path::new("/a/b/c/../d"));
        assert_eq!(p, PathBuf::from("/a/b/d"));
        let q = lexical_normalize(Path::new("/a/./b"));
        assert_eq!(q, PathBuf::from("/a/b"));
    }

    #[test]
    fn scan_vault_skips_hidden_and_node_modules() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(root, "kept.md", "# Kept\n");
        write_file(root, ".hidden/secret.md", "# Secret\n");
        write_file(root, "node_modules/dep/readme.md", "# Dep\n");
        let entries = scan_vault(root.to_string_lossy().to_string(), None).unwrap();
        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert!(titles.contains(&"Kept"));
        assert!(!titles.contains(&"Secret"));
        assert!(!titles.contains(&"Dep"));
    }

    #[test]
    fn scan_vault_includes_dot_folder_only_when_allowlisted() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(root, "kept.md", "# Kept\n");
        write_file(root, ".notes/secret.md", "# Secret\n");

        let default_entries = scan_vault(root.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(
            default_entries
                .iter()
                .map(|entry| entry.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Kept"]
        );

        let allowlisted = scan_vault(
            root.to_string_lossy().to_string(),
            Some(ScanOptions {
                include_dot_folders: vec![".notes".to_string()],
            }),
        )
        .unwrap();
        let titles: Vec<&str> = allowlisted
            .iter()
            .map(|entry| entry.title.as_str())
            .collect();
        assert!(titles.contains(&"Kept"));
        assert!(titles.contains(&"Secret"));
    }

    #[test]
    fn scan_vault_skips_generated_directories() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(root, "kept.md", "# Kept\n");
        write_file(root, "dist/generated.md", "# Generated\n");
        write_file(root, "build/generated.md", "# Build\n");
        write_file(root, ".next/generated.md", "# Next\n");
        write_file(root, ".turbo/generated.md", "# Turbo\n");
        write_file(root, ".cache/generated.md", "# Cache\n");
        let entries = scan_vault(root.to_string_lossy().to_string(), None).unwrap();
        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, vec!["Kept"]);
    }

    #[test]
    fn scan_vault_precomputes_version_names() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(root, "report.md", "# Report\n");
        write_file(root, ".maru/versions/report-20260503.md", "# Old\n");
        write_file(root, ".maru/versions/report-20260504.md", "# Older\n");
        let entries = scan_vault(root.to_string_lossy().to_string(), None).unwrap();
        let report = entries
            .iter()
            .find(|entry| entry.rel_path == "report.md")
            .unwrap();
        assert_eq!(report.version_count, 2);
    }

    #[test]
    fn scan_vault_writes_cache_and_read_vault_cache_loads_it() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(root, "note.md", "# Note\n");
        let scanned = scan_vault(root.to_string_lossy().to_string(), None).unwrap();
        let cached = read_vault_cache(root.to_string_lossy().to_string())
            .unwrap()
            .expect("cache should exist after scan");
        assert_eq!(cached.len(), scanned.len());
        assert_eq!(cached[0].rel_path, "note.md");
    }

    #[test]
    fn read_vault_cache_returns_none_for_missing_or_malformed_cache() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        assert!(read_vault_cache(root.to_string_lossy().to_string())
            .unwrap()
            .is_none());
        let cache = vault_cache_path(root);
        fs::create_dir_all(cache.parent().unwrap()).unwrap();
        fs::write(cache, "not json").unwrap();
        assert!(read_vault_cache(root.to_string_lossy().to_string())
            .unwrap()
            .is_none());
    }

    /// Bench harness for ad-hoc perf measurement on a real workspace. Ignored by
    /// default — run with `cargo test bench_scan_real_workspace -- --ignored
    /// --nocapture --test-threads=1` (set MARU_BENCH_WORKSPACE to override).
    /// Use this before reaching for a workspace cache: tolaria's cache lift is
    /// 1,400 LOC, so confirm scan_vault is actually slow first.
    #[test]
    #[ignore]
    fn bench_scan_real_workspace() {
        let path = std::env::var("MARU_BENCH_WORKSPACE")
            .unwrap_or_else(|_| "/Users/yj.lee/workspace/work".to_string());
        let t0 = std::time::Instant::now();
        let entries = scan_vault(path.clone(), None).expect("scan failed");
        let dt = t0.elapsed();
        let total_bytes: usize = entries.iter().map(|e| e.snippet.len()).sum();
        eprintln!(
            "scan_vault({path}) → {} entries in {dt:?} (snippet bytes: {total_bytes})",
            entries.len()
        );
    }

    #[test]
    fn seeds_embedded_sample_workspace_into_empty_dir() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        seed_dir_if_missing(&SAMPLE_WORKSPACE_DIR, root).unwrap();
        // A top-level note, the dotfile, the nested dot-dir snapshot, and a note
        // with a Korean + whitespace filename must all materialize.
        assert!(root.join("2026-maru-project-report.md").is_file());
        assert!(root.join(".maruignore").is_file());
        assert!(root
            .join(".maru/versions/2026-maru-project-report-20260424-173000.md")
            .is_file());
        assert!(root
            .join("meetings/2026/2026-04/04-20 회의 - Maru 사업 주간 점검 - KPI.md")
            .is_file());
    }

    #[test]
    fn seeding_is_idempotent_and_preserves_user_edits() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        seed_dir_if_missing(&SAMPLE_WORKSPACE_DIR, root).unwrap();

        let edited = root.join("2026-maru-project-report.md");
        fs::write(&edited, "# my own notes\n").unwrap();

        // Re-seeding must not error and must leave the user's edit untouched.
        seed_dir_if_missing(&SAMPLE_WORKSPACE_DIR, root).unwrap();
        assert_eq!(fs::read_to_string(&edited).unwrap(), "# my own notes\n");
    }
}
