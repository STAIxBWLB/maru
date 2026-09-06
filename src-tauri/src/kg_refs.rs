// Knowledge-graph reference mapping: for one document, compute which vault
// notes it references and where. Two match kinds:
//
//   * `wikilink` — every [[target]] in body + frontmatter, resolved to a vault
//     note path (mirrors the frontend resolver in src/lib/wikilinkSuggestions.ts:
//     exact title → filename-no-ext → exact relPath → relPath-no-ext → slash
//     suffix fallback). Unresolved targets (ghost nodes) are skipped — the live
//     graph already surfaces them from VaultEntry.links.
//   * `entity` — occurrences of other notes' titles (plus frontmatter
//     `aliases`) as whole-phrase matches in the BODY only. Case-insensitive;
//     pure-ASCII phrases additionally require non-word neighbors so "Rise"
//     does not match inside "arises" (Korean phrases use plain substring —
//     Korean has no word-boundary ambiguity for this use).
//
// The mapping is expensive (one regex scan of the doc per vault title), so it
// runs ON DEMAND ONLY through the kg_document_refs command and is cached on
// disk at <work>/.maru/kg-cache/<sha256(docRelPath)>.json. A cached entry is
// valid iff the document content hash matches AND the vault stamp matches.
// The vault stamp hashes the note *identities* in the vault scan cache
// (.maru/cache/workspace-index-v4.json) — rel_path + title + aliases, sorted —
// so it changes only when a note is added, removed, renamed, retitled or
// re-aliased. Identical identity sets stamp equal, so no-change rescans do NOT
// invalidate this cache, and neither does editing the body of an unrelated
// note (which cannot change what this document matches). Known gap: a vault
// change that no scan_vault call has picked up yet (watcher debounce window)
// leaves the stamp unchanged and the stale entry is served — the next trigger
// after any scan refreshes it. Document edits are always caught immediately
// via the content hash.
//
// Span offsets are UTF-8 BYTE offsets into the raw document content (what
// read_document returns), not JS char offsets. `paragraph` is the 0-based
// index of the blank-line-separated block containing the span start, counted
// over the whole raw document (the frontmatter block counts as paragraph 0).

use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionRequest,
};
use crate::vault::{
    normalize_existing_dir, read_vault_cache_in_transaction, resolve_inside_vault,
    scan_vault_in_transaction, vault_cache_path, VaultEntry,
};
use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const KG_CACHE_REL: &[&str] = &[".maru", "kg-cache"];
/// Per-note occurrence cap for entity matches (first N spans win).
const MAX_ENTITY_SPANS_PER_NOTE: usize = 20;
/// Total entity-span cap across all notes, bounding worst-case output size.
const MAX_ENTITY_SPANS_TOTAL: usize = 200;
/// Titles/aliases shorter than this (in chars) never entity-match.
const MIN_ENTITY_PHRASE_CHARS: usize = 2;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum KgRefMatchKind {
    Wikilink,
    Entity,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KgRefSpan {
    /// UTF-8 byte offset of the span start in the raw document content.
    pub start: usize,
    /// UTF-8 byte offset one past the span end.
    pub end: usize,
    /// 0-based blank-line-separated block index of the span start.
    pub paragraph: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KgNodeRef {
    /// Vault-relative path of the referenced note (matches GraphNode.relPath).
    pub node_path: String,
    pub node_title: String,
    pub match_kind: KgRefMatchKind,
    pub spans: Vec<KgRefSpan>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRefMap {
    /// Vault-relative document path (forward slashes).
    pub doc_path: String,
    /// sha256 hex of the raw document bytes at compute time.
    pub doc_hash: String,
    /// sha256 hex of the vault note-identity set at compute time (see header).
    pub vault_stamp: String,
    pub refs: Vec<KgNodeRef>,
    pub computed_at: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Same pattern the vault scanner uses: `[[target]]` or `[[target|alias]]`.
fn wikilink_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]").expect("valid wikilink regex"))
}

/// Mirror of the frontend `stripExt` (wikilinkSuggestions.ts): strip one
/// trailing markdown extension, case-insensitive.
fn strip_ext(path: &str) -> &str {
    for ext in [".md", ".mdx", ".markdown"] {
        let Some(cut) = path.len().checked_sub(ext.len()) else {
            continue;
        };
        if cut > 0 && path.is_char_boundary(cut) && path[cut..].eq_ignore_ascii_case(ext) {
            return &path[..cut];
        }
    }
    path
}

fn normalize_rel(rel: &str) -> String {
    rel.replace('\\', "/")
}

/// O(1) wikilink resolution index. Mirrors buildEntryIndex in
/// wikilinkSuggestions.ts, including its first-wins vs last-wins semantics.
struct EntryIndex<'a> {
    by_title: HashMap<String, &'a VaultEntry>,
    by_filename_no_ext: HashMap<String, &'a VaultEntry>,
    by_rel_path: HashMap<String, &'a VaultEntry>,
    by_rel_path_no_ext: HashMap<String, &'a VaultEntry>,
}

fn build_entry_index(entries: &[VaultEntry]) -> EntryIndex<'_> {
    let mut index = EntryIndex {
        by_title: HashMap::new(),
        by_filename_no_ext: HashMap::new(),
        by_rel_path: HashMap::new(),
        by_rel_path_no_ext: HashMap::new(),
    };
    for entry in entries {
        let rel = normalize_rel(&entry.rel_path);
        index
            .by_title
            .entry(entry.title.to_lowercase())
            .or_insert(entry);
        let filename = rel.rsplit('/').next().unwrap_or("");
        index
            .by_filename_no_ext
            .entry(strip_ext(filename).to_lowercase())
            .or_insert(entry);
        index.by_rel_path.insert(rel.to_lowercase(), entry);
        index
            .by_rel_path_no_ext
            .insert(strip_ext(&rel).to_lowercase(), entry);
    }
    index
}

/// Mirror of resolveTargetIndexed (wikilinkSuggestions.ts).
fn resolve_target<'a>(
    index: &EntryIndex<'a>,
    entries: &'a [VaultEntry],
    target: &str,
) -> Option<&'a VaultEntry> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_lowercase();
    let stripped = strip_ext(trimmed).to_lowercase();
    if let Some(entry) = index
        .by_title
        .get(&lower)
        .or_else(|| index.by_filename_no_ext.get(&stripped))
        .or_else(|| index.by_rel_path.get(&lower))
        .or_else(|| index.by_rel_path_no_ext.get(&stripped))
    {
        return Some(entry);
    }
    if !lower.contains('/') {
        return None;
    }
    let suffix_plain = format!("/{lower}");
    let suffix_md = format!("/{stripped}.md");
    entries.iter().find(|entry| {
        let rel = normalize_rel(&entry.rel_path).to_lowercase();
        rel.ends_with(&suffix_plain) || rel.ends_with(&suffix_md)
    })
}

/// Byte offsets at which each blank-line-separated block begins. Leading
/// blank lines attach to the first block (paragraph 0 = first real content,
/// usually the frontmatter block when present).
fn paragraph_starts(content: &str) -> Vec<usize> {
    let mut starts: Vec<usize> = Vec::new();
    let mut seen_content = false;
    let mut prev_blank = true;
    let mut offset = 0usize;
    for line in content.split_inclusive('\n') {
        let text = line.trim_end_matches(['\n', '\r']);
        if text.trim().is_empty() {
            if seen_content {
                prev_blank = true;
            }
        } else {
            if !seen_content {
                starts.push(offset);
                seen_content = true;
            } else if prev_blank {
                starts.push(offset);
            }
            prev_blank = false;
        }
        offset += line.len();
    }
    starts
}

fn paragraph_of(starts: &[usize], offset: usize) -> usize {
    starts.partition_point(|start| *start <= offset) - 1
}

/// Byte offset where the body begins, mirroring vault::parse_frontmatter
/// (opening `---\n`, closing `\n---`, then leading newlines trimmed).
fn body_start_offset(content: &str) -> usize {
    if !content.starts_with("---\n") {
        return 0;
    }
    let Some(end) = content[4..].find("\n---") else {
        return 0;
    };
    let mut start = end + 4 + 4;
    while content.as_bytes().get(start) == Some(&b'\n') {
        start += 1;
    }
    start
}

/// For pure-ASCII phrases require non-word neighbors on both sides so "Rise"
/// rejects "arises"/"RISE2". Neighboring multi-byte UTF-8 bytes are >= 0x80
/// and never read as ASCII word chars, so byte-level checks are safe here.
fn ascii_boundary_ok(content: &str, start: usize, end: usize) -> bool {
    let bytes = content.as_bytes();
    let is_word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let before_ok = start == 0 || !is_word(bytes[start - 1]);
    let after_ok = end >= bytes.len() || !is_word(bytes[end]);
    before_ok && after_ok
}

/// Frontmatter `aliases` of a note: a string or a list of strings.
fn frontmatter_aliases(entry: &VaultEntry) -> Vec<String> {
    let mut out = Vec::new();
    match entry.frontmatter.get("aliases") {
        Some(Value::String(single)) => out.push(single.clone()),
        Some(Value::Sequence(items)) => {
            for item in items {
                if let Value::String(s) = item {
                    out.push(s.clone());
                }
            }
        }
        _ => {}
    }
    out
}

fn cache_file_path(work: &Path, doc_rel: &str) -> PathBuf {
    let name = format!("{}.json", sha256_hex(doc_rel.as_bytes()));
    KG_CACHE_REL
        .iter()
        .fold(work.to_path_buf(), |acc, part| acc.join(part))
        .join(name)
}

/// The vault freshness stamp: sha256 over the *identity* of every note the
/// scan cache holds — rel_path, title and aliases, i.e. exactly what
/// build_entry_index and entity matching key on. Note bodies, fingerprints and
/// timestamps are excluded on purpose: editing an unrelated note cannot change
/// which titles/aliases a document matches, so its cached map survives. Sorted
/// before hashing, so repeated no-change rescans stamp EQUAL (header
/// invariant). Missing/unparseable cache → "none", which never matches a
/// computed stamp (compute runs scan_vault first, which writes the cache), so
/// it degrades to a miss.
fn vault_stamp(lease: &PathTransactionLease, work: &Path) -> String {
    let Ok(Some(entries)) =
        read_vault_cache_in_transaction(lease, work.to_string_lossy().to_string())
    else {
        return "none".to_string();
    };
    let mut ids: Vec<String> = entries
        .iter()
        .map(|entry| {
            let mut aliases = frontmatter_aliases(entry);
            aliases.sort();
            format!(
                "{}\u{1}{}\u{1}{}",
                normalize_rel(&entry.rel_path),
                entry.title,
                aliases.join("\u{2}")
            )
        })
        .collect();
    ids.sort();
    sha256_hex(ids.join("\n").as_bytes())
}

struct RefBuilder {
    /// rel_path -> (title, spans), insertion order preserved via `order`.
    spans_by_node: HashMap<String, (String, Vec<KgRefSpan>)>,
    order: Vec<String>,
}

impl RefBuilder {
    fn new() -> Self {
        Self {
            spans_by_node: HashMap::new(),
            order: Vec::new(),
        }
    }

    fn push(&mut self, entry: &VaultEntry, span: KgRefSpan) {
        let key = normalize_rel(&entry.rel_path);
        if !self.spans_by_node.contains_key(&key) {
            self.order.push(key.clone());
            self.spans_by_node
                .insert(key.clone(), (entry.title.clone(), Vec::new()));
        }
        if let Some((_, spans)) = self.spans_by_node.get_mut(&key) {
            spans.push(span);
        }
    }
}

/// Compute the reference map for one document. Cost: one warm scan_vault
/// (fingerprint-stat pass; unchanged files reuse the scan cache), then one
/// regex pass over the document per vault title/alias — O(vault notes x doc
/// bytes), bounded by the entity caps, cached on disk afterwards.
fn compute_document_refs(
    lease: &PathTransactionLease,
    work: &Path,
    work_path: &str,
    doc_rel: &str,
    content: &str,
) -> Result<DocumentRefMap, String> {
    let entries = scan_vault_in_transaction(lease, work_path.to_string(), None)?;
    let index = build_entry_index(&entries);
    let paragraphs = paragraph_starts(content);
    let mut wikilinks = RefBuilder::new();
    let mut wikilink_spans: Vec<(usize, usize)> = Vec::new();

    for cap in wikilink_re().captures_iter(content) {
        let Some(whole) = cap.get(0) else {
            continue;
        };
        let target = cap[1].trim();
        if target.is_empty() {
            continue;
        }
        let Some(entry) = resolve_target(&index, &entries, target) else {
            continue; // ghost target — not a vault node
        };
        if normalize_rel(&entry.rel_path) == doc_rel {
            continue; // self-reference
        }
        wikilink_spans.push((whole.start(), whole.end()));
        wikilinks.push(
            entry,
            KgRefSpan {
                start: whole.start(),
                end: whole.end(),
                paragraph: paragraph_of(&paragraphs, whole.start()),
            },
        );
    }

    // Entity matching over the body only (frontmatter mentions are metadata,
    // not prose references).
    let body_offset = body_start_offset(content);
    let body = &content[body_offset..];
    let mut entities = RefBuilder::new();
    let mut total_entity_spans = 0usize;
    let mut seen_phrases: HashSet<String> = HashSet::new();
    'notes: for entry in &entries {
        if normalize_rel(&entry.rel_path) == doc_rel {
            continue; // self-reference
        }
        let mut per_note = 0usize;
        for phrase in std::iter::once(entry.title.clone()).chain(frontmatter_aliases(entry)) {
            let phrase = phrase.trim();
            if phrase.chars().count() < MIN_ENTITY_PHRASE_CHARS || phrase.len() > body.len() {
                continue;
            }
            if !seen_phrases.insert(phrase.to_lowercase()) {
                continue; // first note wins, mirroring byTitle
            }
            // ASCII phrases: ASCII-only case-insensitivity (no Unicode folds
            // like U+212A) plus explicit word-boundary checks below.
            let pattern = if phrase.is_ascii() {
                format!("(?-u)(?i){}", regex::escape(phrase))
            } else {
                format!("(?i){}", regex::escape(phrase))
            };
            let Ok(re) = Regex::new(&pattern) else {
                continue;
            };
            for found in re.find_iter(body) {
                let start = body_offset + found.start();
                let end = body_offset + found.end();
                if phrase.is_ascii() && !ascii_boundary_ok(content, start, end) {
                    continue;
                }
                let overlaps_wikilink = wikilink_spans
                    .iter()
                    .any(|(ws, we)| start < *we && *ws < end);
                if overlaps_wikilink {
                    continue;
                }
                entities.push(
                    entry,
                    KgRefSpan {
                        start,
                        end,
                        paragraph: paragraph_of(&paragraphs, start),
                    },
                );
                per_note += 1;
                total_entity_spans += 1;
                if per_note >= MAX_ENTITY_SPANS_PER_NOTE
                    || total_entity_spans >= MAX_ENTITY_SPANS_TOTAL
                {
                    break;
                }
            }
            if per_note >= MAX_ENTITY_SPANS_PER_NOTE || total_entity_spans >= MAX_ENTITY_SPANS_TOTAL
            {
                break;
            }
            if total_entity_spans >= MAX_ENTITY_SPANS_TOTAL {
                break 'notes;
            }
        }
        if total_entity_spans >= MAX_ENTITY_SPANS_TOTAL {
            break 'notes;
        }
    }

    let mut refs: Vec<KgNodeRef> = Vec::new();
    for (kind, builder) in [
        (KgRefMatchKind::Wikilink, &wikilinks),
        (KgRefMatchKind::Entity, &entities),
    ] {
        for key in &builder.order {
            if let Some((title, spans)) = builder.spans_by_node.get(key) {
                refs.push(KgNodeRef {
                    node_path: key.clone(),
                    node_title: title.clone(),
                    match_kind: kind,
                    spans: spans.clone(),
                });
            }
        }
    }
    refs.sort_by(|a, b| {
        let a0 = a.spans.first().map(|s| s.start).unwrap_or(usize::MAX);
        let b0 = b.spans.first().map(|s| s.start).unwrap_or(usize::MAX);
        a0.cmp(&b0)
            .then_with(|| a.node_path.cmp(&b.node_path))
            .then_with(|| {
                (a.match_kind == KgRefMatchKind::Entity)
                    .cmp(&(b.match_kind == KgRefMatchKind::Entity))
            })
    });

    Ok(DocumentRefMap {
        doc_path: doc_rel.to_string(),
        doc_hash: sha256_hex(content.as_bytes()),
        vault_stamp: vault_stamp(lease, work),
        refs,
        computed_at: Utc::now().to_rfc3339(),
    })
}

/// On-demand, cache-aware reference mapping for one document. Recomputes only
/// when the cache is missing, the document changed (content hash), or the
/// vault scan cache changed (vault stamp).
///
/// The IPC adapter owns this full synchronous scan/cache transaction.
pub fn kg_document_refs(work_path: String, doc_path: String) -> Result<DocumentRefMap, String> {
    let work = normalize_existing_dir(&work_path)?;
    let path = resolve_inside_vault(&work_path, &doc_path)?;
    let doc_rel = normalize_rel(&path.strip_prefix(&work).unwrap_or(&path).to_string_lossy());
    let cache_file = cache_file_path(&work, &doc_rel);
    // The scan reads the entire source tree and may migrate registry state.
    // Include exact cache endpoints as well as allocation directories so
    // deliberate cache/source aliases outside the tree conflict too.
    let mut paths = vec![
        PathBuf::from(&work_path),
        work.clone(),
        path,
        cache_file.clone(),
        cache_file.parent().unwrap().to_path_buf(),
        vault_cache_path(&work),
        work.join(".maru/cache"),
        crate::vault_list::workspace_registry_path()?,
        crate::vault_list::legacy_vault_list_path()?,
    ];
    paths.extend(
        paths
            .clone()
            .into_iter()
            .filter_map(|path| path.canonicalize().ok()),
    );
    let request = PathTransactionRequest::new(paths)?
        .require_parent(Path::new(&work_path))?
        .require_parent(&work)?;
    with_path_transactions(request, |lease| {
        kg_document_refs_in_transaction(lease, work_path, doc_path)
    })
}

fn kg_document_refs_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    doc_path: String,
) -> Result<DocumentRefMap, String> {
    let work = normalize_existing_dir(&work_path)?;
    let path = resolve_inside_vault(&work_path, &doc_path)?;
    let vault_root = resolve_inside_vault(&work_path, ".")?;
    lease.ensure_covered(vec![path.clone(), vault_cache_path(&work)])?;
    let content =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read document: {err}"))?;
    let doc_rel = normalize_rel(
        &path
            .strip_prefix(&vault_root)
            .unwrap_or(&path)
            .to_string_lossy(),
    );
    let doc_hash = sha256_hex(content.as_bytes());
    let stamp = vault_stamp(lease, &work);
    let cache_file = cache_file_path(&work, &doc_rel);
    if let Ok(raw) = fs::read_to_string(&cache_file) {
        if let Ok(cached) = serde_json::from_str::<DocumentRefMap>(&raw) {
            if cached.doc_path == doc_rel
                && cached.doc_hash == doc_hash
                && cached.vault_stamp == stamp
            {
                return Ok(cached);
            }
        }
    }
    let map = compute_document_refs(lease, &work, &work_path, &doc_rel, &content)?;
    debug_assert_eq!(map.doc_hash, doc_hash);
    // A cache-write failure degrades to "recompute next time", never an error.
    if let Ok(serialized) = serde_json::to_string(&map) {
        lease.ensure_covered(vec![cache_file.clone()])?;
        lease.before_effect()?;
        let _ = write_atomic(&cache_file, serialized.as_bytes());
    }
    Ok(map)
}

/// Drop kg-cache entries: one document's entry when `doc_path` is given
/// (returns 0 or 1), or every entry when omitted. Returns entries removed.
pub fn kg_refs_clear(work_path: String, doc_path: Option<String>) -> Result<u32, String> {
    let work = normalize_existing_dir(&work_path)?;
    let dir = KG_CACHE_REL
        .iter()
        .fold(work.clone(), |acc, part| acc.join(part));
    let mut paths = vec![
        PathBuf::from(&work_path).join(".maru/kg-cache"),
        dir.clone(),
    ];
    if let Some(doc) = &doc_path {
        let path = resolve_inside_vault(&work_path, doc)?;
        let rel = normalize_rel(&path.strip_prefix(&work).unwrap_or(&path).to_string_lossy());
        paths.extend([path, cache_file_path(&work, &rel)]);
    } else if dir.is_dir() {
        for entry in fs::read_dir(&dir).map_err(|err| format!("Cannot read kg cache dir: {err}"))? {
            let path = entry
                .map_err(|err| format!("Cannot read kg cache dir: {err}"))?
                .path();
            if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                paths.push(path);
            }
        }
    }
    paths.extend(
        paths
            .clone()
            .into_iter()
            .filter_map(|path| path.canonicalize().ok()),
    );
    let request = PathTransactionRequest::new(paths)?
        .require_parent(Path::new(&work_path))?
        .require_parent(&work)?;
    with_path_transactions(request, |lease| {
        kg_refs_clear_in_transaction(lease, work_path, doc_path)
    })
}

fn kg_refs_clear_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    doc_path: Option<String>,
) -> Result<u32, String> {
    let work = normalize_existing_dir(&work_path)?;
    lease.before_effect()?;
    if let Some(doc_path) = doc_path {
        let path = resolve_inside_vault(&work_path, &doc_path)?;
        let vault_root = resolve_inside_vault(&work_path, ".")?;
        let doc_rel = normalize_rel(
            &path
                .strip_prefix(&vault_root)
                .unwrap_or(&path)
                .to_string_lossy(),
        );
        let cache_file = cache_file_path(&work, &doc_rel);
        if cache_file.is_file() {
            lease.ensure_covered(vec![cache_file.clone()])?;
            lease.before_effect()?;
            fs::remove_file(&cache_file)
                .map_err(|err| format!("Cannot remove kg cache entry: {err}"))?;
            return Ok(1);
        }
        return Ok(0);
    }
    let dir = KG_CACHE_REL.iter().fold(work, |acc, part| acc.join(part));
    if !dir.is_dir() {
        return Ok(0);
    }
    let mut removed = 0u32;
    for entry in fs::read_dir(&dir).map_err(|err| format!("Cannot read kg cache dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Cannot read kg cache dir: {err}"))?;
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            lease.ensure_covered(vec![path.clone()])?;
            lease.before_effect()?;
            fs::remove_file(&path).map_err(|err| format!("Cannot remove kg cache entry: {err}"))?;
            removed += 1;
        }
    }
    Ok(removed)
}

pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn kg_document_refs(
        work_path: String,
        doc_path: String,
    ) -> Result<DocumentRefMap, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:kg_document_refs",
            );
            super::kg_document_refs(work_path, doc_path)
        })
        .await
        .map_err(|err| format!("kg_document_refs_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn kg_refs_clear(work_path: String, doc_path: Option<String>) -> Result<u32, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:kg_refs_clear");
            super::kg_refs_clear(work_path, doc_path)
        })
        .await
        .map_err(|err| format!("kg_refs_clear_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::scan_vault;
    use tempfile::TempDir;

    fn workspace() -> (TempDir, String) {
        let temp = TempDir::new().unwrap();
        let work = temp.path().to_string_lossy().to_string();
        (temp, work)
    }

    fn write_file(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn cache_dir(work: &str) -> PathBuf {
        Path::new(work).join(".maru").join("kg-cache")
    }

    fn cache_entry_count(work: &str) -> usize {
        fs::read_dir(cache_dir(work))
            .map(|entries| entries.filter_map(Result::ok).count())
            .unwrap_or(0)
    }

    /// Overwrite every cached map's computedAt with a sentinel so a later
    /// cache hit is observable (a recompute would regenerate the timestamp).
    fn sentinelize_cache(work: &str) {
        for entry in fs::read_dir(cache_dir(work)).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let mut map: DocumentRefMap =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            map.computed_at = "sentinel".to_string();
            fs::write(&path, serde_json::to_string(&map).unwrap()).unwrap();
        }
    }

    fn refs_for<'a>(
        map: &'a DocumentRefMap,
        node_path: &str,
        kind: KgRefMatchKind,
    ) -> Option<&'a KgNodeRef> {
        map.refs
            .iter()
            .find(|r| r.node_path == node_path && r.match_kind == kind)
    }

    #[test]
    fn wikilinks_carry_byte_spans_and_paragraph_indices() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "Alpha.md", "# Alpha\n");
        let doc = "---\nproject: \"[[Alpha]]\"\n---\n# 주간 보고\n\n첫 문단에서 [[Alpha]]를 참조한다.\n\n둘째 문단.\n\n셋째 문단 [[Alpha|별칭]] 다시.\n";
        write_file(temp.path(), "doc.md", doc);

        let map = kg_document_refs(work, "doc.md".to_string()).unwrap();
        let alpha = refs_for(&map, "Alpha.md", KgRefMatchKind::Wikilink).unwrap();
        assert_eq!(alpha.node_title, "Alpha");
        assert_eq!(alpha.spans.len(), 3, "frontmatter + two body wikilinks");

        // Byte offsets slice the raw content back to the exact wikilinks.
        let texts: Vec<&str> = alpha.spans.iter().map(|s| &doc[s.start..s.end]).collect();
        assert_eq!(texts, vec!["[[Alpha]]", "[[Alpha]]", "[[Alpha|별칭]]"]);
        assert_eq!(alpha.spans[0].start, doc.find("[[Alpha]]").unwrap());

        // Paragraph blocks: frontmatter + "# 주간 보고" run together (no blank
        // line between) as block 0, then 첫 문단=1, 둘째=2, 셋째=3.
        let paragraphs: Vec<usize> = alpha.spans.iter().map(|s| s.paragraph).collect();
        assert_eq!(paragraphs, vec![0, 1, 3]);
    }

    #[test]
    fn strip_ext_only_cuts_at_char_boundaries() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        assert_eq!(strip_ext("인공지능"), "인공지능");
        assert_eq!(strip_ext("회의.html"), "회의.html");
        assert_eq!(strip_ext("note.md"), "note");
        assert_eq!(strip_ext("NOTE.MD"), "NOTE");
        assert_eq!(strip_ext("한글노트.md"), "한글노트");
    }

    #[test]
    fn hangul_wikilink_target_resolves() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "ai.md", "# 인공지능\n");
        write_file(temp.path(), "doc.md", "# Doc\n\n[[인공지능]]을 참조한다.\n");
        let map = kg_document_refs(work, "doc.md".to_string()).unwrap();
        let ai = refs_for(&map, "ai.md", KgRefMatchKind::Wikilink).unwrap();
        assert_eq!(ai.spans.len(), 1);
    }

    #[test]
    fn korean_named_non_markdown_note_is_indexable() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "notes/회의.html", "<h1>회의록</h1>");
        write_file(temp.path(), "doc.md", "# Doc\n\n위키링크가 없는 본문.\n");
        let map = kg_document_refs(work, "doc.md".to_string()).unwrap();
        assert_eq!(map.doc_path, "doc.md");
        assert!(
            map.refs
                .iter()
                .all(|r| r.match_kind != KgRefMatchKind::Wikilink),
            "the document has no wikilinks: {:?}",
            map.refs
        );
    }

    #[test]
    fn wikilink_resolution_by_title_filename_and_path() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "notes/deep-note.md", "# Deep Title\n");
        write_file(
            temp.path(),
            "doc.md",
            "# Doc\n\nSee [[Deep Title]], [[deep-note]], [[notes/deep-note.md]] and [[deep-note.md]].\n",
        );
        let map = kg_document_refs(work, "doc.md".to_string()).unwrap();
        let node = refs_for(&map, "notes/deep-note.md", KgRefMatchKind::Wikilink).unwrap();
        assert_eq!(node.node_title, "Deep Title");
        assert_eq!(
            node.spans.len(),
            4,
            "all four spellings resolve to the same note"
        );
    }

    #[test]
    fn unresolved_wikilinks_are_skipped() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "doc.md", "# Doc\n\nSee [[Nowhere]].\n");
        let map = kg_document_refs(work, "doc.md".to_string()).unwrap();
        assert!(map.refs.is_empty(), "ghost targets are not vault nodes");
    }

    #[test]
    fn entity_match_whole_phrase_and_ascii_boundary() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "rise.md", "# Rise\n");
        // "arises" and "RISE2" must not match; the standalone "RISE" must.
        let doc = "# Doc\n\nHe arises early. The RISE program runs RISE2 pilots.\n";
        write_file(temp.path(), "doc.md", doc);
        let map = kg_document_refs(work.clone(), "doc.md".to_string()).unwrap();
        let rise = refs_for(&map, "rise.md", KgRefMatchKind::Entity).unwrap();
        assert_eq!(rise.spans.len(), 1);
        assert_eq!(&doc[rise.spans[0].start..rise.spans[0].end], "RISE");
        assert_eq!(rise.spans[0].paragraph, 1);
    }

    #[test]
    fn entity_match_korean_substring_and_aliases() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "ai.md", "# 인공지능\n");
        write_file(
            temp.path(),
            "team.md",
            "---\naliases:\n  - 알파팀\n---\n# Team Alpha\n",
        );
        // Korean title matches as plain substring (인공지능 inside 인공지능학과);
        // the frontmatter alias matches too.
        write_file(
            temp.path(),
            "doc.md",
            "# Doc\n\n인공지능학과와 알파팀이 협업한다.\n",
        );
        let map = kg_document_refs(work, "doc.md".to_string()).unwrap();
        assert_eq!(
            refs_for(&map, "ai.md", KgRefMatchKind::Entity)
                .unwrap()
                .spans
                .len(),
            1
        );
        assert_eq!(
            refs_for(&map, "team.md", KgRefMatchKind::Entity)
                .unwrap()
                .spans
                .len(),
            1
        );
    }

    #[test]
    fn entity_match_skips_short_titles_self_and_frontmatter() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "q.md", "# Q\n"); // 1-char title: skipped
        write_file(temp.path(), "omega.md", "# Omega\n");
        // Doc titled "Doc Omega"? No — self is doc.md; "Omega" appears only in
        // the frontmatter here, which must not entity-match.
        write_file(
            temp.path(),
            "doc.md",
            "---\nrelated: Omega\n---\n# Doc\n\nQ is short.\n",
        );
        let map = kg_document_refs(work, "doc.md".to_string()).unwrap();
        assert!(refs_for(&map, "q.md", KgRefMatchKind::Entity).is_none());
        assert!(refs_for(&map, "omega.md", KgRefMatchKind::Entity).is_none());
    }

    #[test]
    fn self_reference_is_excluded_for_both_kinds() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(
            temp.path(),
            "doc.md",
            "# Self Note\n\nSelf Note mentions itself and [[Self Note]].\n",
        );
        let map = kg_document_refs(work, "doc.md".to_string()).unwrap();
        assert!(
            map.refs.iter().all(|r| r.node_path != "doc.md"),
            "self-references must be excluded: {:?}",
            map.refs
        );
    }

    #[test]
    fn entity_spans_overlapping_wikilinks_are_excluded() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "Beta.md", "# Beta\n");
        let doc = "# Doc\n\nSee [[Beta]] first. Later Beta again.\n";
        write_file(temp.path(), "doc.md", doc);
        let map = kg_document_refs(work, "doc.md".to_string()).unwrap();
        let wiki = refs_for(&map, "Beta.md", KgRefMatchKind::Wikilink).unwrap();
        assert_eq!(wiki.spans.len(), 1);
        let entity = refs_for(&map, "Beta.md", KgRefMatchKind::Entity).unwrap();
        assert_eq!(entity.spans.len(), 1, "only the non-wikilink occurrence");
        let occurrence = &doc[entity.spans[0].start..entity.spans[0].end];
        assert_eq!(occurrence, "Beta");
        assert!(entity.spans[0].start > wiki.spans[0].end);
    }

    #[test]
    fn entity_caps_per_note_and_total() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        // Per-note cap: 25 mentions of Gamma -> 20 spans.
        write_file(temp.path(), "gamma.md", "# Gamma\n");
        let many = "Gamma ".repeat(25);
        write_file(temp.path(), "doc.md", &format!("# Doc\n\n{many}\n"));
        let map = kg_document_refs(work.clone(), "doc.md".to_string()).unwrap();
        let gamma = refs_for(&map, "gamma.md", KgRefMatchKind::Entity).unwrap();
        assert_eq!(gamma.spans.len(), MAX_ENTITY_SPANS_PER_NOTE);

        // Total cap: 11 notes x 20 mentions = 220 -> 200 spans overall.
        let (temp2, work2) = workspace();
        let mut body = String::from("# Doc\n\n");
        for i in 0..11 {
            let title = format!("EntityTitle{i}");
            write_file(temp2.path(), &format!("n{i}.md"), &format!("# {title}\n"));
            body.push_str(&format!("{} ", title).repeat(20));
            body.push_str("\n\n");
        }
        write_file(temp2.path(), "doc.md", &body);
        let map2 = kg_document_refs(work2, "doc.md".to_string()).unwrap();
        let total: usize = map2
            .refs
            .iter()
            .filter(|r| r.match_kind == KgRefMatchKind::Entity)
            .map(|r| r.spans.len())
            .sum();
        assert_eq!(total, MAX_ENTITY_SPANS_TOTAL);
    }

    #[test]
    fn cache_hit_serves_stored_entry_and_doc_change_recomputes() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "Alpha.md", "# Alpha\n");
        write_file(temp.path(), "doc.md", "# Doc\n\nSee [[Alpha]].\n");
        let first = kg_document_refs(work.clone(), "doc.md".to_string()).unwrap();
        assert_eq!(cache_entry_count(&work), 1);
        assert_ne!(first.computed_at, "sentinel");

        sentinelize_cache(&work);
        let hit = kg_document_refs(work.clone(), "doc.md".to_string()).unwrap();
        assert_eq!(
            hit.computed_at, "sentinel",
            "second call must be a cache hit"
        );
        assert_eq!(hit.refs, first.refs, "a hit serves the stored refs");
        assert_eq!(hit.doc_hash, first.doc_hash);

        // Doc content change invalidates the entry.
        write_file(
            temp.path(),
            "doc.md",
            "# Doc\n\nSee [[Alpha]] twice [[Alpha]].\n",
        );
        let recomputed = kg_document_refs(work.clone(), "doc.md".to_string()).unwrap();
        assert_ne!(
            recomputed.computed_at, "sentinel",
            "doc change must recompute"
        );
        let alpha = refs_for(&recomputed, "Alpha.md", KgRefMatchKind::Wikilink).unwrap();
        assert_eq!(alpha.spans.len(), 2);
    }

    #[test]
    fn vault_stamp_change_recomputes_but_unscanned_edit_does_not() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "Alpha.md", "# Alpha\n");
        write_file(temp.path(), "doc.md", "# Doc\n\nSee [[Alpha]].\n");
        kg_document_refs(work.clone(), "doc.md".to_string()).unwrap();
        sentinelize_cache(&work);

        // Vault edit without any scan: stamp unchanged, cached entry served
        // (documented watcher-debounce gap).
        write_file(temp.path(), "Bravo.md", "# Bravo\n");
        let hit = kg_document_refs(work.clone(), "doc.md".to_string()).unwrap();
        assert_eq!(hit.computed_at, "sentinel");

        // After a scan picks the change up, the stamp flips and we recompute.
        scan_vault(work.clone(), None).unwrap();
        let recomputed = kg_document_refs(work.clone(), "doc.md".to_string()).unwrap();
        assert_ne!(
            recomputed.computed_at, "sentinel",
            "vault change must recompute"
        );
    }

    #[test]
    fn unrelated_note_body_edit_keeps_the_cached_entry() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "Alpha.md", "# Alpha\n");
        write_file(temp.path(), "other.md", "# Other\n\nfirst body\n");
        write_file(temp.path(), "doc.md", "# Doc\n\nSee [[Alpha]].\n");
        kg_document_refs(work.clone(), "doc.md".to_string()).unwrap();
        sentinelize_cache(&work);

        // Body-only edit of an unrelated note: the note-identity set is
        // unchanged, so the stamp holds and the cached map survives the rescan.
        write_file(temp.path(), "other.md", "# Other\n\na rewritten body\n");
        scan_vault(work.clone(), None).unwrap();
        let hit = kg_document_refs(work.clone(), "doc.md".to_string()).unwrap();
        assert_eq!(
            hit.computed_at, "sentinel",
            "an unrelated body edit must not invalidate the ref map"
        );
    }

    #[test]
    fn clear_by_doc_and_clear_all() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "Alpha.md", "# Alpha\n");
        write_file(temp.path(), "a.md", "# A\n\n[[Alpha]]\n");
        write_file(temp.path(), "b.md", "# B\n\n[[Alpha]]\n");
        kg_document_refs(work.clone(), "a.md".to_string()).unwrap();
        kg_document_refs(work.clone(), "b.md".to_string()).unwrap();
        assert_eq!(cache_entry_count(&work), 2);

        assert_eq!(
            kg_refs_clear(work.clone(), Some("a.md".to_string())).unwrap(),
            1
        );
        assert_eq!(cache_entry_count(&work), 1);
        // Clearing a doc with no entry is a no-op.
        assert_eq!(
            kg_refs_clear(work.clone(), Some("a.md".to_string())).unwrap(),
            0
        );
        assert_eq!(kg_refs_clear(work.clone(), None).unwrap(), 1);
        assert_eq!(cache_entry_count(&work), 0);
        assert_eq!(kg_refs_clear(work.clone(), None).unwrap(), 0);
    }

    #[test]
    fn traversal_is_rejected() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (temp, work) = workspace();
        write_file(temp.path(), "doc.md", "# Doc\n");
        for bad in ["../escape.md", "notes/../../escape.md", "/etc/passwd"] {
            let result = kg_document_refs(work.clone(), bad.to_string());
            assert!(result.is_err(), "{bad} must be rejected");
            let cleared = kg_refs_clear(work.clone(), Some(bad.to_string()));
            assert!(cleared.is_err(), "clearing {bad} must be rejected");
        }
    }

    #[test]
    fn missing_document_is_an_error() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (_temp, work) = workspace();
        let result = kg_document_refs(work, "nope.md".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Cannot read document"));
    }
}

#[cfg(test)]
mod phase08_13 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use crate::vault_graph::{ipc as graph_ipc, GraphLayoutCache};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::Duration;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
    struct Fixture {
        temp: tempfile::TempDir,
        _access: crate::scratchpad::phase08_08::PrimaryWorkspaceAccessFixture,
    }
    impl Fixture {
        fn path(&self) -> &Path {
            self.temp.path()
        }
    }
    fn fixture(home: &Home) -> Fixture {
        let temp = tempfile::tempdir_in(home.root.path()).unwrap();
        fs::create_dir_all(temp.path().join("work/.maru/kg-cache")).unwrap();
        fs::create_dir_all(temp.path().join("work/.maru/cache")).unwrap();
        fs::write(temp.path().join("work/doc.md"), "# Doc\n\n[[Alpha]]\n").unwrap();
        fs::write(temp.path().join("work/Alpha.md"), "# Alpha\n").unwrap();
        fs::write(cache_file_path(&temp.path().join("work"), "doc.md"), "{}").unwrap();
        let work = temp.path().join("work");
        crate::scratchpad::phase08_08::registry(&work, "direct");
        let access = crate::scratchpad::phase08_08::PrimaryWorkspaceAccessFixture::new(work);
        Fixture {
            temp,
            _access: access,
        }
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
            .expect("bounded graph/cache completion")
    }
    fn target(root: &Path, writer: &str) -> PathBuf {
        if writer == "layout" {
            root.join(".maru/cache/graph-layout.json")
        } else {
            cache_file_path(root, "doc.md")
        }
    }
    async fn write(writer: &'static str, work: String) -> Result<(), String> {
        match writer {
            "layout" => graph_ipc::vault_graph_layout_save(work, GraphLayoutCache::default()).await,
            "refs" => ipc::kg_document_refs(work, "doc.md".into())
                .await
                .map(|map| assert!(!map.refs.is_empty())),
            "clear" => ipc::kg_refs_clear(work, Some("doc.md".into()))
                .await
                .map(|_| ()),
            _ => unreachable!(),
        }
    }

    #[test]
    fn phase08_13_refs_wrappers_yield_same_task_and_report_join_failure() {
        let home = Home::new();
        let root = text(home.root.path());
        boundary(
            root.clone().into(),
            "kg_document_refs",
            ipc::kg_document_refs(root.clone(), "doc.md".into()),
        );
        boundary(
            root.clone().into(),
            "kg_refs_clear",
            ipc::kg_refs_clear(root, None),
        );
    }

    #[test]
    fn phase08_13_refs_wrappers_preserve_payload_cache_hits_clear_counts_and_errors() {
        let home = Home::new();
        let temp = fixture(&home);
        let root = temp.path().join("work");
        let work = text(&root);
        let map = run(ipc::kg_document_refs(work.clone(), "doc.md".into())).unwrap();
        assert_eq!(map.refs[0].node_path, "Alpha.md");
        assert_eq!(map.doc_hash, sha256_hex(b"# Doc\n\n[[Alpha]]\n"));
        let hit = run(ipc::kg_document_refs(work.clone(), "doc.md".into())).unwrap();
        assert_eq!(map, hit);
        assert!(vault_cache_path(&root).is_file());
        assert_eq!(
            run(ipc::kg_refs_clear(work.clone(), Some("doc.md".into()))).unwrap(),
            1
        );
        assert_eq!(
            run(ipc::kg_refs_clear(work.clone(), Some("doc.md".into()))).unwrap(),
            0
        );
        run(ipc::kg_document_refs(work.clone(), "doc.md".into())).unwrap();
        assert_eq!(run(ipc::kg_refs_clear(work.clone(), None)).unwrap(), 1);
        for bad in ["../escape.md", "missing.md"] {
            let expected = kg_document_refs(work.clone(), bad.into()).unwrap_err();
            assert_eq!(
                run(ipc::kg_document_refs(work.clone(), bad.into())).unwrap_err(),
                expected
            );
        }
        let expected = kg_refs_clear(work.clone(), Some("../escape.md".into())).unwrap_err();
        assert_eq!(
            run(ipc::kg_refs_clear(work, Some("../escape.md".into()))).unwrap_err(),
            expected
        );
    }

    #[test]
    fn phase08_13_each_cache_writer_serializes_and_releases_on_error_and_unwind() {
        let home = Home::new();
        for writer in ["layout", "refs", "clear"] {
            for outcome in ["success", "error", "unwind"] {
                let temp = fixture(&home);
                let root = temp.path().join("work");
                let path = target(&root, writer);
                // Missing graph cache is legitimate until the first layout write.
                let held = Held::new(path.clone(), "admitted");
                let first = start(write(writer, text(&root)));
                held.wait();
                let waiting = Held::new(path.clone(), "before-admission");
                let second = start(write(writer, text(&root)));
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                let used = AtomicBool::new(false);
                let _panic = if outcome == "unwind" {
                    Some(PathTransactionTestHook::new(
                        path.clone(),
                        "pre-effect",
                        move || {
                            if !used.swap(true, Ordering::SeqCst) {
                                panic!("fixture graph cache unwind");
                            }
                        },
                    ))
                } else {
                    None
                };
                if outcome == "error" {
                    // Replace the original pinned cache parent while the first
                    // admitted command waits; both original selections reject.
                    let parent = path.parent().unwrap();
                    fs::rename(parent, parent.with_extension("moved")).unwrap();
                    fs::create_dir(parent).unwrap();
                }
                held.release();
                let first = done(first);
                let second = done(second);
                if outcome == "success" {
                    first.unwrap();
                    second.unwrap();
                } else {
                    assert!(first.is_err(), "{writer}/{outcome}");
                }
                drop(_panic);
                // A fresh real command proves the whole lease was released.
                if writer == "clear" {
                    fs::write(&path, "{}").unwrap();
                }
                run(write(writer, text(&root))).unwrap();
            }
        }
    }

    #[test]
    fn phase08_13_cache_files_parent_rename_trash_both_orders_and_workspace_aliases() {
        let home = Home::new();
        for parent_kind in ["rename", "trash"] {
            for writer in ["layout", "refs", "clear"] {
                for parent_first in [false, true] {
                    for alias in [false, true] {
                        let temp = fixture(&home);
                        let root = temp.path().join("work");
                        let selected = if alias {
                            #[cfg(unix)]
                            std::os::unix::fs::symlink(&root, temp.path().join("alias")).unwrap();
                            #[cfg(not(unix))]
                            continue;
                            temp.path().join("alias")
                        } else {
                            root.clone()
                        };
                        let path = if writer == "layout" {
                            target(&selected, writer)
                        } else {
                            target(&root, writer)
                        };
                        let _trash = crate::workspace_files::phase08_06::TrashFixture::new(
                            root.clone(),
                            temp.path().join("moved"),
                        );
                        let parent_root = text(temp.path());
                        let parent = async move {
                            if parent_kind == "rename" {
                                crate::workspace_files::ipc::rename_workspace_entry(
                                    parent_root,
                                    "work".into(),
                                    "moved".into(),
                                )
                                .await
                                .map(|outcome| assert!(outcome.error.is_none()))
                            } else {
                                crate::workspace_files::ipc::trash_workspace_entries(
                                    parent_root,
                                    vec!["work".into()],
                                )
                                .await
                                .map(|outcomes| {
                                    assert_eq!(outcomes.len(), 1);
                                    assert!(outcomes[0].error.is_none());
                                })
                            }
                        };
                        let child = write(writer, text(&selected));
                        if parent_first {
                            let held = Held::new(root.clone(), "pre-effect");
                            let p = start(parent);
                            held.wait();
                            let waiting = Held::new(path.clone(), "before-admission");
                            let c = start(child);
                            waiting.wait();
                            waiting.release();
                            assert!(c.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(p).unwrap();
                            assert!(done(c).is_err());
                        } else {
                            let held = Held::new(path, "pre-effect");
                            let c = start(child);
                            held.wait();
                            let waiting = Held::new(root.clone(), "before-admission");
                            let p = start(parent);
                            waiting.wait();
                            waiting.release();
                            assert!(p.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(c).unwrap();
                            done(p).unwrap();
                        }
                        assert!(
                            !root.exists(),
                            "{writer} must never recreate moved workspace"
                        );
                        assert!(temp.path().join("moved/doc.md").is_file());
                    }
                }
            }
        }
    }

    #[test]
    fn phase08_13_refs_and_document_save_both_orders_preserve_current_bytes_and_typed_conflict() {
        let home = Home::new();
        for refs_first in [false, true] {
            let temp = fixture(&home);
            let root = temp.path().join("work");
            let cache = cache_file_path(&root, "doc.md");
            let doc = root.join("doc.md");
            let original = fs::read_to_string(&doc).unwrap();
            let revision = crate::document::revision_for(&original);
            let body = "# Doc\n\n[[Alpha]] [[Alpha]]\n";
            let save = crate::document::ipc::save_document(
                text(&root),
                "doc.md".into(),
                body.into(),
                Some(revision.clone()),
            );
            let refs = ipc::kg_document_refs(text(&root), "doc.md".into());
            let map = if refs_first {
                let held = Held::new(cache, "pre-effect");
                let r = start(refs);
                held.wait();
                let waiting = Held::new(doc, "before-admission");
                let s = start(save);
                waiting.wait();
                waiting.release();
                assert!(s.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                let map = done(r).unwrap();
                done(s).unwrap();
                map
            } else {
                let held = Held::new(doc, "pre-effect");
                let s = start(save);
                held.wait();
                let waiting = Held::new(cache, "before-admission");
                let r = start(refs);
                waiting.wait();
                waiting.release();
                assert!(r.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(s).unwrap();
                done(r).unwrap()
            };
            assert_eq!(map.refs[0].spans.len(), if refs_first { 1 } else { 2 });
            assert_eq!(fs::read_to_string(root.join("doc.md")).unwrap(), body);
            let error = run(crate::document::ipc::save_document(
                text(&root),
                "doc.md".into(),
                "stale".into(),
                Some(revision),
            ))
            .unwrap_err();
            assert_eq!(error.code, crate::ipc_error::DOCUMENT_CONFLICT);
            assert_eq!(
                run(ipc::kg_document_refs(text(&root), "doc.md".into()))
                    .unwrap()
                    .refs[0]
                    .spans
                    .len(),
                2
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_13_cache_file_alias_document_and_physical_parent_races_both_orders() {
        let home = Home::new();
        for writer in ["layout", "refs", "clear"] {
            for external_first in [false, true] {
                for external in ["document", "parent"] {
                    let temp = fixture(&home);
                    let root = temp.path().join("work");
                    let selected = temp.path().join("workspace-alias");
                    std::os::unix::fs::symlink(&root, &selected).unwrap();
                    let external_root = temp.path().join("external");
                    fs::create_dir(&external_root).unwrap();
                    let external_doc = external_root.join("note.md");
                    fs::write(&external_doc, "# before").unwrap();
                    let cache = target(&root, writer);
                    let _ = fs::remove_file(&cache);
                    std::os::unix::fs::symlink(&external_doc, &cache).unwrap();
                    let parent_path = external_root.clone();
                    let parent_work = text(temp.path());
                    let ext_work = text(&external_root);
                    let operation = async move {
                        if external == "document" {
                            crate::document::ipc::save_document(
                                ext_work,
                                "note.md".into(),
                                "# after".into(),
                                None,
                            )
                            .await
                            .map(|_| ())
                        } else {
                            crate::workspace_files::ipc::rename_workspace_entry(
                                parent_work,
                                "external".into(),
                                "moved".into(),
                            )
                            .await
                            .map_err(crate::ipc_error::IpcError::from)
                            .map(|outcome| assert!(outcome.error.is_none()))
                        }
                    };
                    let entry = if external == "document" {
                        external_doc.clone()
                    } else {
                        parent_path
                    };
                    let child = write(writer, text(&selected));
                    if external_first {
                        let held = Held::new(entry, "pre-effect");
                        let e = start(operation);
                        held.wait();
                        let waiting = Held::new(cache.clone(), "before-admission");
                        let c = start(child);
                        waiting.wait();
                        waiting.release();
                        assert!(c.recv_timeout(Duration::from_millis(30)).is_err());
                        held.release();
                        done(e).unwrap();
                        if external == "parent" {
                            assert!(done(c).is_err());
                        } else {
                            done(c).unwrap();
                        }
                    } else {
                        let held = Held::new(cache.clone(), "pre-effect");
                        let c = start(child);
                        held.wait();
                        let waiting = Held::new(entry, "before-admission");
                        let e = start(operation);
                        waiting.wait();
                        waiting.release();
                        assert!(e.recv_timeout(Duration::from_millis(30)).is_err());
                        held.release();
                        done(c).unwrap();
                        done(e).unwrap();
                    }
                    if external == "document" {
                        assert_eq!(fs::read_to_string(external_doc).unwrap(), "# after");
                    } else {
                        assert!(
                            !external_root.exists(),
                            "cache write must never recreate physical parent"
                        );
                        assert_eq!(
                            fs::read_to_string(temp.path().join("moved/note.md")).unwrap(),
                            "# before"
                        );
                    }
                }
            }
        }
    }
}
