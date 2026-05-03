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

const VAULT_CACHE_REL: &[&str] = &[".anchor", "cache", "workspace-index-v1.json"];
const GENERATED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
];

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterParts {
    pub meta: BTreeMap<String, Value>,
    pub body: String,
}

#[tauri::command]
pub fn default_vault_path() -> Result<String, String> {
    let base = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Cannot resolve a user documents directory".to_string())?;
    Ok(base.join("Anchor Workspace").to_string_lossy().to_string())
}

#[tauri::command]
pub fn sample_vault_path() -> Result<String, String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "Cannot resolve project root".to_string())?
        .join("sample-vault");
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn scan_vault(vault_path: String) -> Result<Vec<VaultEntry>, String> {
    let vault = normalize_existing_dir(&vault_path)?;
    let ignore_patterns = load_anchorignore(&vault);
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
            if is_hidden_or_system_path(path, &vault) {
                return false;
            }
            let rel = path.strip_prefix(&vault).unwrap_or(path);
            !matches_anchorignore(rel, &ignore_patterns)
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
    let _ = write_vault_cache(&vault, &entries);
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
    let meta = serde_yaml::from_str::<BTreeMap<String, Value>>(yaml).unwrap_or_default();
    FrontmatterParts {
        meta,
        body: body.trim_start_matches('\n').to_string(),
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
    })
}

fn is_hidden_or_system_path(path: &Path, vault: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(vault) else {
        return true;
    };
    rel.components().any(|component| {
        let value = component.as_os_str().to_string_lossy();
        value.starts_with('.') || GENERATED_DIRS.iter().any(|dir| value == *dir)
    })
}

/// Load `.anchorignore` patterns from the vault root. Each non-comment,
/// non-empty line is a pattern. Comparison is plain prefix / segment
/// match (no glob support yet — gitignore-like patterns can be added in
/// Phase 1 if real-world vaults need them).
fn load_anchorignore(vault: &Path) -> Vec<String> {
    let path = vault.join(".anchorignore");
    if !path.exists() {
        return Vec::new();
    }
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(String::from)
        .collect()
}

fn matches_anchorignore(rel_path: &Path, patterns: &[String]) -> bool {
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
    let dir = vault.join(".anchor").join("versions");
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
        let entries = scan_vault(root.to_string_lossy().to_string()).unwrap();
        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert!(titles.contains(&"Top"));
        assert!(
            titles.contains(&"Deep"),
            "deep notes must be found regardless of depth"
        );
    }

    #[test]
    fn scan_vault_respects_anchorignore() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(root, ".anchorignore", "skipme\n_sys/env\n");
        write_file(root, "keep.md", "# Keep\n");
        write_file(root, "skipme/inside.md", "# Inside\n");
        write_file(root, "_sys/env/python.md", "# Python\n");
        let entries = scan_vault(root.to_string_lossy().to_string()).unwrap();
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
        let entries = scan_vault(root.to_string_lossy().to_string()).unwrap();
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
        let entries = scan_vault(root.to_string_lossy().to_string()).unwrap();
        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert!(titles.contains(&"Kept"));
        assert!(!titles.contains(&"Secret"));
        assert!(!titles.contains(&"Dep"));
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
        let entries = scan_vault(root.to_string_lossy().to_string()).unwrap();
        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, vec!["Kept"]);
    }

    #[test]
    fn scan_vault_precomputes_version_names() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(root, "report.md", "# Report\n");
        write_file(root, ".anchor/versions/report-20260503.md", "# Old\n");
        write_file(root, ".anchor/versions/report-20260504.md", "# Older\n");
        let entries = scan_vault(root.to_string_lossy().to_string()).unwrap();
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
        let scanned = scan_vault(root.to_string_lossy().to_string()).unwrap();
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
    /// --nocapture --test-threads=1` (set ANCHOR_BENCH_WORKSPACE to override).
    /// Use this before reaching for a workspace cache: tolaria's cache lift is
    /// 1,400 LOC, so confirm scan_vault is actually slow first.
    #[test]
    #[ignore]
    fn bench_scan_real_workspace() {
        let path = std::env::var("ANCHOR_BENCH_WORKSPACE")
            .unwrap_or_else(|_| "/Users/yj.lee/workspace/work".to_string());
        let t0 = std::time::Instant::now();
        let entries = scan_vault(path.clone()).expect("scan failed");
        let dt = t0.elapsed();
        let total_bytes: usize = entries.iter().map(|e| e.snippet.len()).sum();
        eprintln!(
            "scan_vault({path}) → {} entries in {dt:?} (snippet bytes: {total_bytes})",
            entries.len()
        );
    }
}
