use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

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
    Ok(base.join("Anchor Vault").to_string_lossy().to_string())
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
    let mut entries = Vec::new();

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
        if let Ok(item) = read_entry(path, &vault) {
            entries.push(item);
        }
    }

    entries.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });
    Ok(entries)
}

pub fn normalize_existing_dir(input: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(input);
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|err| format!("Cannot create vault directory: {err}"))?;
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("Cannot open vault directory: {err}"))?;
    if !canonical.is_dir() {
        return Err("Vault path is not a directory".to_string());
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

    // Vault root itself might be a symlink (canonicalize earlier resolved it,
    // but the caller may have passed entries scanned from the un-resolved
    // form). Try canonicalizing the candidate as a fallback — if it lands
    // inside the canonical vault, allow.
    if let Ok(canon) = normalized.canonicalize() {
        if canon.starts_with(&vault) {
            return Ok(canon);
        }
    }

    Err("Document path escapes the selected vault".to_string())
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
    let h1 = Regex::new(r"(?m)^#\s+(.+)$").expect("valid h1 regex");
    if let Some(capture) = h1.captures(&body) {
        return capture
            .get(1)
            .map(|m| clean_text(m.as_str()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback.to_string());
    }

    let html_h1 = Regex::new(r"(?is)<h1[^>]*>(.*?)</h1>").expect("valid html h1 regex");
    if let Some(capture) = html_h1.captures(&body) {
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

fn read_entry(path: &Path, vault: &Path) -> Result<VaultEntry, String> {
    let content = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let parts = parse_frontmatter(&content);
    let fallback = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled");
    let title = title_from_content(&content, fallback);
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
        version_count: count_versions(path, vault),
    })
}

fn is_hidden_or_system_path(path: &Path, vault: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(vault) else {
        return true;
    };
    rel.components().any(|component| {
        let value = component.as_os_str().to_string_lossy();
        value.starts_with('.') || value == "node_modules" || value == "target"
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
            || rel_str
                .split('/')
                .any(|seg| seg == pat)
    })
}

fn clean_text(input: &str) -> String {
    let tags = Regex::new(r"(?is)<[^>]+>").expect("valid tag regex");
    let markup = Regex::new(r"(?m)^[-*#>\s]+").expect("valid markdown regex");
    let without_tags = tags.replace_all(input, " ");
    let without_markup = markup.replace_all(&without_tags, "");
    without_markup
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn count_versions(path: &Path, vault: &Path) -> usize {
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
        return 0;
    };
    let dir = vault.join(".anchor").join("versions");
    if !dir.exists() {
        return 0;
    }
    WalkDir::new(dir)
        .max_depth(1)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|name| name.starts_with(stem))
                    .unwrap_or(false)
        })
        .count()
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
        let resolved =
            resolve_inside_vault(tmp.path().to_str().unwrap(), "note.md").unwrap();
        assert!(resolved.ends_with("note.md"));
    }

    #[test]
    fn resolve_inside_vault_accepts_absolute_path_inside_vault() {
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "sub/note.md", "# X\n");
        let canonical_vault = tmp.path().canonicalize().unwrap();
        let abs = canonical_vault.join("sub").join("note.md");
        let resolved = resolve_inside_vault(
            canonical_vault.to_str().unwrap(),
            abs.to_str().unwrap(),
        )
        .unwrap();
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
            resolve_inside_vault(tmp.path().to_str().unwrap(), "downloads/linked.md")
                .unwrap();
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

    /// Bench harness for ad-hoc perf measurement on a real vault. Ignored by
    /// default — run with `cargo test bench_scan_real_vault -- --ignored
    /// --nocapture --test-threads=1` (set ANCHOR_BENCH_VAULT to override).
    /// Use this before reaching for a vault cache: tolaria's cache lift is
    /// 1,400 LOC, so confirm scan_vault is actually slow first.
    #[test]
    #[ignore]
    fn bench_scan_real_vault() {
        let path = std::env::var("ANCHOR_BENCH_VAULT")
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
