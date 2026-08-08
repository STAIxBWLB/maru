// Gap analysis: diff a promoted draft against its frozen promote baseline and
// classify what changed. The baseline is written by `drafts_promote` to
// <work>/.maru/drafts/<id>/baseline.md; the promoted document lives at the
// vault-relative `promotedTo` path on the draft index entry.
//
// Classification is heuristic v1: pure Rust string/regex signals, no AI call.
// The ordering is documented at `classify_hunk`; approximations (e.g. a number
// that merely does not appear in the baseline counts as external info) are
// intentional and surfaced through `evidence` so the UI can show why.
//
// Isolation invariant: this module only reads the draft index, baselines, and
// in-vault documents (via vault path resolution), and only writes
// <work>/.maru/gap-log.jsonl — and only through the explicit gap_append_log
// command, never as a side effect of analysis.

use crate::atomic_file::write_atomic;
use crate::drafts::{load_index, validate_draft_id, DraftEntry, DraftStatus};
use crate::scratchpad::assert_scratchpad_workspace_access;
use crate::vault::{lexical_normalize, normalize_existing_dir, resolve_inside_vault};
use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::{DiffTag, TextDiff};
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// Context lines kept on each side of a change group, unified-diff style.
const CONTEXT_LINES: usize = 3;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GapHunkType {
    ExternalInfo,
    DirectEdit,
    CrossDocReference,
    Formatting,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GapHunkOp {
    Equal,
    Insert,
    Delete,
    Replace,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct GapDiffLine {
    /// ' ' context, '-' removed from baseline, '+' added in promoted doc.
    pub kind: char,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GapHunk {
    pub op: GapHunkOp,
    /// 1-based position of the first affected baseline line. For pure
    /// insertions (oldLines = 0) this is the baseline line number after which
    /// the insertion happened (0 = before the first line), matching unified
    /// diff convention.
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<GapDiffLine>,
    pub hunk_type: GapHunkType,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GapTypeCounts {
    pub external_info: usize,
    pub direct_edit: usize,
    pub cross_doc_reference: usize,
    pub formatting: usize,
}

impl GapTypeCounts {
    fn bump(&mut self, hunk_type: GapHunkType) {
        match hunk_type {
            GapHunkType::ExternalInfo => self.external_info += 1,
            GapHunkType::DirectEdit => self.direct_edit += 1,
            GapHunkType::CrossDocReference => self.cross_doc_reference += 1,
            GapHunkType::Formatting => self.formatting += 1,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GapSummary {
    pub total_hunks: usize,
    pub added_lines: usize,
    pub removed_lines: usize,
    pub by_type: GapTypeCounts,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GapReport {
    pub draft_id: String,
    pub draft_title: String,
    pub promoted_to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_hash: Option<String>,
    pub analyzed_at: String,
    pub hunks: Vec<GapHunk>,
    pub summary: GapSummary,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GapLogEntry {
    pub at: String,
    pub draft_id: String,
    pub promoted_to: String,
    pub added_lines: usize,
    pub removed_lines: usize,
    pub by_type: GapTypeCounts,
    pub hunk_count: usize,
    // Provenance, all optional so older log lines still deserialize. Raw churn
    // cannot answer "are the drafts getting better": 20 edited lines means one
    // thing in a 40-line note and another in a 400-line one, and nothing in the
    // entry said which runtime produced the draft.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_lines: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_by: Option<String>,
}

/// Cheap per-draft row for the analyzable-docs list: no diff is run.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GapReportSummary {
    pub draft_id: String,
    pub title: String,
    pub promoted_to: String,
    /// Draft `updatedAt` — `drafts_promote` bumps it, so it is the promote time.
    pub promoted_at: String,
    pub has_baseline: bool,
    pub has_document: bool,
}

fn baseline_path(work: &Path, draft_id: &str) -> PathBuf {
    work.join(".maru")
        .join("drafts")
        .join(draft_id)
        .join("baseline.md")
}

fn gap_log_path(work: &Path) -> PathBuf {
    work.join(".maru").join("gap-log.jsonl")
}

// ponytail: third module-private copy of this per-path append lock (see
// today_store.rs and agent_host/event_store.rs). Hoist the three into one
// shared helper if a fourth JSONL appender shows up.
fn append_lock_for(path: &Path) -> Result<Arc<Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "gap_log_lock_registry_poisoned".to_string())?;
    Ok(locks
        .entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

/// Intermediate hunk with line indices retained for classification.
struct RawHunk {
    op: GapHunkOp,
    old_start: usize,
    old_lines: usize,
    new_start: usize,
    new_lines: usize,
    lines: Vec<GapDiffLine>,
    /// 0-based line indices of '-' lines in the baseline.
    removed_idx: Vec<usize>,
    /// 0-based line indices of '+' lines in the promoted doc.
    added_idx: Vec<usize>,
}

fn strip_line_end(line: &str) -> &str {
    line.strip_suffix('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .unwrap_or(line)
}

/// Line-level diff grouped into hunks with CONTEXT_LINES of surrounding
/// context. Adjacent change groups separated by at most 2 * CONTEXT_LINES
/// equal lines merge into one hunk (unified diff behavior).
fn diff_hunks(old: &str, new: &str) -> Vec<RawHunk> {
    let diff = TextDiff::from_lines(old, new);
    let mut hunks = Vec::new();
    for group in diff.grouped_ops(CONTEXT_LINES * 2) {
        let mut hunk = RawHunk {
            op: GapHunkOp::Equal,
            old_start: 0,
            old_lines: 0,
            new_start: 0,
            new_lines: 0,
            lines: Vec::new(),
            removed_idx: Vec::new(),
            added_idx: Vec::new(),
        };
        let mut has_insert = false;
        let mut has_delete = false;
        let mut first_old: Option<usize> = None;
        let mut first_new: Option<usize> = None;
        let group_len = group.len();
        for (position, op) in group.iter().enumerate() {
            match op.tag() {
                DiffTag::Equal => {
                    // Interior equal runs stay whole; edge runs trim to context.
                    let range = op.old_range();
                    let start = if position == 0 && group_len > 1 {
                        range.end.saturating_sub(CONTEXT_LINES)
                    } else {
                        range.start
                    };
                    let end = if position == group_len - 1 && group_len > 1 {
                        (range.start + CONTEXT_LINES).min(range.end)
                    } else {
                        range.end
                    };
                    for index in start..end {
                        if first_old.is_none() {
                            first_old = Some(index);
                        }
                        let new_index = op.new_range().start + (index - range.start);
                        if first_new.is_none() {
                            first_new = Some(new_index);
                        }
                        hunk.lines.push(GapDiffLine {
                            kind: ' ',
                            text: strip_line_end(diff.old_slices()[index]).to_string(),
                        });
                        hunk.old_lines += 1;
                        hunk.new_lines += 1;
                    }
                    if start == end {
                        // Fully trimmed edge context: still anchors positions.
                        if first_old.is_none() {
                            first_old = Some(range.end);
                        }
                        if first_new.is_none() {
                            first_new = Some(op.new_range().end);
                        }
                    }
                }
                DiffTag::Delete | DiffTag::Replace => {
                    has_delete = true;
                    if first_old.is_none() {
                        first_old = Some(op.old_range().start);
                    }
                    for index in op.old_range() {
                        hunk.lines.push(GapDiffLine {
                            kind: '-',
                            text: strip_line_end(diff.old_slices()[index]).to_string(),
                        });
                        hunk.old_lines += 1;
                        hunk.removed_idx.push(index);
                    }
                    if op.tag() == DiffTag::Replace {
                        has_insert = true;
                        if first_new.is_none() {
                            first_new = Some(op.new_range().start);
                        }
                        for index in op.new_range() {
                            hunk.lines.push(GapDiffLine {
                                kind: '+',
                                text: strip_line_end(diff.new_slices()[index]).to_string(),
                            });
                            hunk.new_lines += 1;
                            hunk.added_idx.push(index);
                        }
                    }
                }
                DiffTag::Insert => {
                    has_insert = true;
                    if first_old.is_none() {
                        first_old = Some(op.old_range().start);
                    }
                    if first_new.is_none() {
                        first_new = Some(op.new_range().start);
                    }
                    for index in op.new_range() {
                        hunk.lines.push(GapDiffLine {
                            kind: '+',
                            text: strip_line_end(diff.new_slices()[index]).to_string(),
                        });
                        hunk.new_lines += 1;
                        hunk.added_idx.push(index);
                    }
                }
            }
        }
        hunk.old_start = match first_old {
            Some(index) if hunk.old_lines > 0 => index + 1,
            Some(index) => index,
            None => 0,
        };
        hunk.new_start = match first_new {
            Some(index) if hunk.new_lines > 0 => index + 1,
            Some(index) => index,
            None => 0,
        };
        hunk.op = match (has_delete, has_insert) {
            (true, true) => GapHunkOp::Replace,
            (true, false) => GapHunkOp::Delete,
            (false, true) => GapHunkOp::Insert,
            (false, false) => continue, // pure context: never emitted
        };
        hunks.push(hunk);
    }
    hunks
}

/// Inclusive end line index of the leading frontmatter block, if the document
/// opens with `---` and a closing `---` exists.
fn frontmatter_end(lines: &[&str]) -> Option<usize> {
    if lines.first().map(|line| line.trim()) != Some("---") {
        return None;
    }
    lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| line.trim() == "---")
        .map(|(index, _)| index)
}

fn url_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"https?://[^\s)\]>"']+"#).unwrap())
}

fn wikilink_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\[\]]+)\]\]").unwrap())
}

fn markdown_link_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[[^\]]*\]\(([^)\s]+)\)").unwrap())
}

fn date_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b").unwrap())
}

fn number_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b\d[\d,]*(?:\.\d+)?\b").unwrap())
}

fn quoted_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new("\"([^\"\\n]{2,80})\"").unwrap())
}

fn squash_whitespace(text: &str) -> String {
    text.split_whitespace().collect()
}

/// Classify one change hunk. v1 heuristic, ordered — first match wins:
/// 1. `formatting`: every changed line is blank, or added/removed lines are
///    identical once all whitespace is squashed, or every changed line sits
///    inside the leading frontmatter block of its document.
/// 2. `cross-doc-reference`: an added line contains a [[wikilink]] or a
///    markdown link to a non-URL (workspace-relative) target.
/// 3. `external-info`: an added line contains a URL, a date, a number, or a
///    quoted name that does not appear anywhere in the baseline. This is an
///    approximation — "not in the baseline" stands in for "new information",
///    and it gates every signal: rewording around an existing citation is a
///    direct edit, not new external info.
/// 4. `direct-edit`: everything else.
fn classify_hunk(
    hunk: &RawHunk,
    baseline: &str,
    old_frontmatter_end: Option<usize>,
    new_frontmatter_end: Option<usize>,
) -> (GapHunkType, Vec<String>) {
    let added: Vec<&str> = hunk
        .lines
        .iter()
        .filter(|line| line.kind == '+')
        .map(|line| line.text.as_str())
        .collect();
    let removed: Vec<&str> = hunk
        .lines
        .iter()
        .filter(|line| line.kind == '-')
        .map(|line| line.text.as_str())
        .collect();

    // 1. formatting
    let all_blank = added.iter().chain(removed.iter()).all(|line| line.trim().is_empty());
    let added_squashed: BTreeSet<String> = added.iter().map(|line| squash_whitespace(line)).collect();
    let removed_squashed: BTreeSet<String> =
        removed.iter().map(|line| squash_whitespace(line)).collect();
    let whitespace_only = !added.is_empty() && !removed.is_empty() && added_squashed == removed_squashed;
    let frontmatter_only = match (old_frontmatter_end, new_frontmatter_end) {
        (Some(old_end), Some(new_end)) => {
            (!hunk.removed_idx.is_empty() || !hunk.added_idx.is_empty())
                && hunk.removed_idx.iter().all(|index| *index <= old_end)
                && hunk.added_idx.iter().all(|index| *index <= new_end)
        }
        // Frontmatter the promote target injected over a baseline that had
        // none (create_task_note does this): insert-only, and every added line
        // sits inside the new leading block.
        (None, Some(new_end)) => {
            hunk.removed_idx.is_empty()
                && !hunk.added_idx.is_empty()
                && hunk.added_idx.iter().all(|index| *index <= new_end)
        }
        _ => false,
    };
    if all_blank || whitespace_only || frontmatter_only {
        let evidence = if frontmatter_only && !all_blank && !whitespace_only {
            vec!["frontmatter".to_string()]
        } else {
            Vec::new()
        };
        return (GapHunkType::Formatting, evidence);
    }

    // 2. cross-doc-reference
    let mut evidence: Vec<String> = Vec::new();
    for line in &added {
        for capture in wikilink_regex().captures_iter(line) {
            evidence.push(capture[0].to_string());
        }
        for capture in markdown_link_regex().captures_iter(line) {
            let target = capture.get(1).map(|value| value.as_str()).unwrap_or("");
            if !target.starts_with("http://")
                && !target.starts_with("https://")
                && !target.starts_with('#')
                && !target.starts_with("mailto:")
            {
                evidence.push(capture[0].to_string());
            }
        }
    }
    if !evidence.is_empty() {
        evidence.sort();
        evidence.dedup();
        return (GapHunkType::CrossDocReference, evidence);
    }

    // 3. external-info
    for line in &added {
        for found in url_regex().find_iter(line) {
            if !baseline.contains(found.as_str()) {
                evidence.push(found.as_str().to_string());
            }
        }
        // Every date range is recorded so the number heuristic below stays
        // deduped, but only dates absent from the baseline are new information.
        let date_ranges: Vec<(usize, usize)> = date_regex()
            .find_iter(line)
            .map(|found| {
                if !baseline.contains(found.as_str()) {
                    evidence.push(found.as_str().to_string());
                }
                (found.start(), found.end())
            })
            .collect();
        for found in number_regex().find_iter(line) {
            let overlaps_date = date_ranges
                .iter()
                .any(|(start, end)| found.start() < *end && *start < found.end());
            if !overlaps_date && !baseline.contains(found.as_str()) {
                evidence.push(found.as_str().to_string());
            }
        }
        for capture in quoted_regex().captures_iter(line) {
            let name = capture.get(1).map(|value| value.as_str()).unwrap_or("");
            if !baseline.contains(name) {
                evidence.push(format!("\"{name}\""));
            }
        }
    }
    if !evidence.is_empty() {
        evidence.sort();
        evidence.dedup();
        return (GapHunkType::ExternalInfo, evidence);
    }

    (GapHunkType::DirectEdit, Vec::new())
}

fn summarize(hunks: &[GapHunk]) -> GapSummary {
    let mut summary = GapSummary::default();
    for hunk in hunks {
        summary.total_hunks += 1;
        summary.added_lines += hunk.lines.iter().filter(|line| line.kind == '+').count();
        summary.removed_lines += hunk.lines.iter().filter(|line| line.kind == '-').count();
        summary.by_type.bump(hunk.hunk_type);
    }
    summary
}

fn build_report(entry: &DraftEntry, baseline: &str, current: &str) -> GapReport {
    let old_lines: Vec<&str> = baseline.lines().collect();
    let new_lines: Vec<&str> = current.lines().collect();
    let old_frontmatter_end = frontmatter_end(&old_lines);
    let new_frontmatter_end = frontmatter_end(&new_lines);
    let hunks: Vec<GapHunk> = diff_hunks(baseline, current)
        .into_iter()
        .map(|raw| {
            let (hunk_type, evidence) =
                classify_hunk(&raw, baseline, old_frontmatter_end, new_frontmatter_end);
            GapHunk {
                op: raw.op,
                old_start: raw.old_start,
                old_lines: raw.old_lines,
                new_start: raw.new_start,
                new_lines: raw.new_lines,
                lines: raw.lines,
                hunk_type,
                evidence,
            }
        })
        .collect();
    let summary = summarize(&hunks);
    let baseline_hash = format!("{:x}", Sha256::digest(baseline.as_bytes()));
    GapReport {
        draft_id: entry.id.clone(),
        draft_title: entry.title.clone(),
        promoted_to: entry.promoted_to.clone().unwrap_or_default(),
        baseline_hash: Some(baseline_hash),
        analyzed_at: Utc::now().to_rfc3339(),
        hunks,
        summary,
    }
}

fn promoted_doc_path(work_path: &str, promoted_to: &str) -> Result<PathBuf, String> {
    // promotedTo is written by drafts_promote as a vault-relative path, but a
    // hand-edited index must not be able to redirect the read outside the
    // workspace: re-validate through the same resolver document reads use.
    let trimmed = promoted_to.trim();
    if trimmed.is_empty() || Path::new(trimmed).is_absolute() {
        return Err("gap_promoted_doc_missing".to_string());
    }
    let relative = lexical_normalize(Path::new(trimmed));
    let path = resolve_inside_vault(work_path, &relative.to_string_lossy().replace('\\', "/"))?;
    if !path.is_file() {
        return Err("gap_promoted_doc_missing".to_string());
    }
    Ok(path)
}

fn load_promoted_entry(work: &Path, draft_id: &str) -> Result<DraftEntry, String> {
    validate_draft_id(draft_id)?;
    let entries = load_index(work)?;
    entries
        .into_iter()
        .find(|entry| entry.id == draft_id)
        .ok_or_else(|| "drafts_not_found".to_string())
}

fn analyze_impl(work_path: &str, draft_id: &str) -> Result<GapReport, String> {
    assert_scratchpad_workspace_access(Path::new(work_path))?;
    let work = normalize_existing_dir(work_path)?;
    let entry = load_promoted_entry(&work, draft_id)?;
    let promoted_to = entry
        .promoted_to
        .clone()
        .ok_or_else(|| "gap_not_promoted".to_string())?;
    let baseline_path = baseline_path(&work, &entry.id);
    if !baseline_path.is_file() {
        return Err("gap_baseline_missing".to_string());
    }
    let baseline = fs::read_to_string(&baseline_path)
        .map_err(|err| format!("Cannot read baseline {}: {err}", baseline_path.display()))?;
    let doc_path = promoted_doc_path(work_path, &promoted_to)?;
    let current = fs::read_to_string(&doc_path)
        .map_err(|err| format!("Cannot read promoted document {}: {err}", doc_path.display()))?;
    Ok(build_report(&entry, &baseline, &current))
}

#[tauri::command]
pub fn gap_analyze(work_path: String, draft_id: String) -> Result<GapReport, String> {
    analyze_impl(&work_path, &draft_id)
}

/// Explicit, frontend-triggered log append: analysis itself stays read-only.
/// The UI calls this after an analysis has been viewed/confirmed.
#[tauri::command]
pub fn gap_append_log(work_path: String, draft_id: String) -> Result<GapLogEntry, String> {
    let report = analyze_impl(&work_path, &draft_id)?;
    let work = normalize_existing_dir(&work_path)?;
    let draft = load_promoted_entry(&work, &draft_id)?;
    let baseline_lines = fs::read_to_string(baseline_path(&work, &draft.id))
        .ok()
        .map(|text| text.lines().count());
    let entry = GapLogEntry {
        at: Utc::now().to_rfc3339(),
        draft_id: report.draft_id.clone(),
        promoted_to: report.promoted_to.clone(),
        added_lines: report.summary.added_lines,
        removed_lines: report.summary.removed_lines,
        by_type: report.summary.by_type.clone(),
        hunk_count: report.summary.total_hunks,
        baseline_hash: report.baseline_hash.clone(),
        baseline_lines,
        draft_kind: serde_json::to_value(draft.kind)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string)),
        generated_by: serde_json::to_value(draft.source)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string)),
    };
    let log_path = gap_log_path(&work);
    // Save to log can be clicked twice, and each click used to append a row,
    // doubling that document's weight in every aggregate and in the feedback
    // digest. Same draft, same baseline, same counts as the last logged state
    // is not new information.
    if let Some(previous) = last_entry_for(&log_path, &draft_id) {
        if previous.baseline_hash == entry.baseline_hash
            && previous.added_lines == entry.added_lines
            && previous.removed_lines == entry.removed_lines
            && previous.hunk_count == entry.hunk_count
            && previous.by_type == entry.by_type
        {
            return Ok(previous);
        }
    }
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Cannot create gap log dir: {err}"))?;
    }
    let line = serde_json::to_string(&entry)
        .map_err(|err| format!("Cannot serialize gap log entry: {err}"))?;
    // One buffer, one write_all, under the append lock: a concurrent window
    // appending here must never interleave a record with its own newline.
    let append_lock = append_lock_for(&log_path)?;
    let _guard = append_lock
        .lock()
        .map_err(|_| "gap_log_append_lock_poisoned".to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| format!("Cannot open gap log: {err}"))?;
    file.write_all(format!("{line}\n").as_bytes())
        .map_err(|err| format!("Cannot append gap log: {err}"))?;
    Ok(entry)
}

/// Most recent logged entry for one draft, or None. Corrupt lines are skipped
/// the same way `gap_log_list` skips them.
fn last_entry_for(log_path: &Path, draft_id: &str) -> Option<GapLogEntry> {
    let raw = fs::read_to_string(log_path).ok()?;
    raw.lines()
        .filter_map(|line| serde_json::from_str::<GapLogEntry>(line).ok())
        .filter(|entry| entry.draft_id == draft_id)
        .next_back()
}

/// Read and parse the gap log for a workspace, newest-first. Corrupt lines
/// are skipped so one bad write can never wedge the log. Shared by the
/// `gap_log_list` command and the scheduler's dispatch-time digest build.
pub(crate) fn read_gap_log_entries(work: &Path) -> Result<Vec<GapLogEntry>, String> {
    let log_path = gap_log_path(work);
    if !log_path.is_file() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&log_path)
        .map_err(|err| format!("Cannot read gap log {}: {err}", log_path.display()))?;
    let mut entries: Vec<GapLogEntry> = raw
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    entries.reverse();
    Ok(entries)
}

#[tauri::command]
pub fn gap_log_list(work_path: String, limit: Option<u32>) -> Result<Vec<GapLogEntry>, String> {
    assert_scratchpad_workspace_access(Path::new(&work_path))?;
    let work = normalize_existing_dir(&work_path)?;
    let mut entries = read_gap_log_entries(&work)?;
    entries.truncate(limit.unwrap_or(100) as usize);
    Ok(entries)
}

#[tauri::command]
pub fn gap_reports_list(work_path: String) -> Result<Vec<GapReportSummary>, String> {
    assert_scratchpad_workspace_access(Path::new(&work_path))?;
    let work = normalize_existing_dir(&work_path)?;
    let entries = load_index(&work)?;
    Ok(entries
        .into_iter()
        .filter(|entry| entry.status == DraftStatus::Accepted && entry.promoted_to.is_some())
        .map(|entry| {
            let has_document = entry
                .promoted_to
                .as_deref()
                .map(|path| promoted_doc_path(&work_path, path).is_ok())
                .unwrap_or(false);
            GapReportSummary {
                has_baseline: baseline_path(&work, &entry.id).is_file(),
                has_document,
                promoted_at: entry.updated_at.clone(),
                draft_id: entry.id,
                title: entry.title,
                promoted_to: entry.promoted_to.unwrap_or_default(),
            }
        })
        .collect())
}

/// Kept for parity with other writers; the log itself uses append semantics.
#[allow(dead_code)]
fn rewrite_gap_log(work: &Path, entries: &[GapLogEntry]) -> Result<(), String> {
    let mut body = String::new();
    for entry in entries {
        let line = serde_json::to_string(entry)
            .map_err(|err| format!("Cannot serialize gap log entry: {err}"))?;
        body.push_str(&line);
        body.push('\n');
    }
    write_atomic(&gap_log_path(work), body.as_bytes())
}

// === Feedback digest (gap → scheduler prompt loop) ===
//
// Rust port of `buildGapFeedbackDigest` / `appendGapFeedbackDigest` in
// `src/lib/gapAnalysis.ts` — the two must stay in sync. The scheduler
// attaches the digest to inbox-process schedule prompts at dispatch time;
// the frontend renders the same digest as a read-only preview in the
// schedule dialog. Keep the header string and the Korean copy identical.

/// Delimited prompt section header marking the auto-attached digest.
pub(crate) const GAP_FEEDBACK_SECTION_HEADER: &str = "## 최근 수정 경향 (자동 첨부)";

/// How many of the most recent log entries the digest aggregates.
pub(crate) const GAP_FEEDBACK_DEFAULT_MAX_ENTRIES: usize = 20;

/// (label, hint) per edit type, in declaration order — stable ties in the
/// dominant-type pick keep this order, same as the TS port.
const GAP_TYPE_FEEDBACK: [(&str, &str); 4] = [
    ("외부 정보 추가", "초안에 출처·수치·날짜 등 근거 정보를 더 포함할 것"),
    ("직접 수정", "초안 문장을 최종 문서 톤에 맞춰 더 다듬어 작성할 것"),
    ("교차 문서 참조", "관련 문서의 [[위키링크]]를 초안에 미리 포함할 것"),
    ("서식 정리", "초안의 서식·공백·프론트매터를 최종 문서 형식에 맞출 것"),
];

/// Short Korean digest of recent user edit tendencies, appended to
/// inbox-process schedule prompts so future drafts need fewer manual edits.
/// Entries may arrive in any order; the most recent `max_entries` (by `at`)
/// are used. Returns an empty string when there is nothing to say.
pub(crate) fn build_gap_feedback_digest(entries: &[GapLogEntry], max_entries: usize) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let mut recent: Vec<&GapLogEntry> = entries.iter().collect();
    recent.sort_by(|a, b| b.at.cmp(&a.at));
    recent.truncate(max_entries.max(1));
    let mut totals = GapTypeCounts::default();
    let mut added_lines = 0usize;
    let mut removed_lines = 0usize;
    for entry in &recent {
        added_lines += entry.added_lines;
        removed_lines += entry.removed_lines;
        totals.external_info += entry.by_type.external_info;
        totals.direct_edit += entry.by_type.direct_edit;
        totals.cross_doc_reference += entry.by_type.cross_doc_reference;
        totals.formatting += entry.by_type.formatting;
    }
    let counts = [
        totals.external_info,
        totals.direct_edit,
        totals.cross_doc_reference,
        totals.formatting,
    ];
    let mut lines = vec![format!(
        // One line, no literal continuation: the frontend TS builds this with
        // a single space and the two digests must stay byte-identical.
        "최근 초안 {}건의 수정 분석: 추가 {}줄, 삭제 {}줄 (외부 정보 {}건, 직접 수정 {}건, 교차 참조 {}건, 서식 {}건)",
        recent.len(),
        added_lines,
        removed_lines,
        counts[0],
        counts[1],
        counts[2],
        counts[3],
    )];
    // sort_by is stable, so ties keep the declaration order above.
    let mut ranked: Vec<usize> = (0..counts.len()).collect();
    ranked.sort_by(|a, b| counts[*b].cmp(&counts[*a]));
    let dominant = ranked[0];
    if counts[dominant] > 0 {
        let (label, hint) = GAP_TYPE_FEEDBACK[dominant];
        lines.push(format!("가장 잦은 수정 유형은 {label}: {hint}"));
    }
    lines.join("\n")
}

/// Append the digest to a schedule prompt under the section header. A prompt
/// is returned unchanged when the digest is empty.
pub(crate) fn append_gap_feedback_digest(prompt: &str, digest: &str) -> String {
    if digest.is_empty() {
        return prompt.to_string();
    }
    let section = format!("{GAP_FEEDBACK_SECTION_HEADER}\n\n{digest}");
    if prompt.is_empty() {
        section
    } else {
        format!("{prompt}\n\n{section}")
    }
}

/// Remove a previously attached digest section — the header line through
/// end-of-prompt — so a stale add-time snapshot baked into a legacy schedule
/// never survives to dispatch.
pub(crate) fn strip_gap_feedback_section(prompt: &str) -> String {
    let Some(index) = prompt.find(GAP_FEEDBACK_SECTION_HEADER) else {
        return prompt.to_string();
    };
    // Back up to the start of the header line so the blank-line separator
    // before the section goes with it.
    let line_start = prompt[..index].rfind('\n').map(|i| i + 1).unwrap_or(0);
    prompt[..line_start].trim_end().to_string()
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::drafts::{DraftImportance, DraftKind};
    use crate::scratchpad::ScratchpadSource;
    use tempfile::TempDir;

    fn workspace() -> (TempDir, String) {
        let temp = TempDir::new().unwrap();
        let work = temp.path().to_string_lossy().to_string();
        (temp, work)
    }

    fn hunk_kinds(hunk: &RawHunk) -> String {
        hunk.lines.iter().map(|line| line.kind).collect()
    }

    #[test]
    fn identical_texts_produce_no_hunks() {
        assert!(diff_hunks("a\nb\nc\n", "a\nb\nc\n").is_empty());
        assert!(diff_hunks("", "").is_empty());
    }

    #[test]
    fn pure_insertion_reports_insert_hunk() {
        let hunks = diff_hunks("a\nb\nc\n", "a\nx\ny\nb\nc\n");
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].op, GapHunkOp::Insert);
        assert_eq!(hunks[0].added_idx, vec![1, 2]);
        assert!(hunks[0].removed_idx.is_empty());
        // Context: 1 line before, 2 after (all that exist).
        assert_eq!(hunk_kinds(&hunks[0]), " ++  ");
        assert_eq!(hunks[0].new_lines, 5);
        // Insertion after baseline line 1.
        assert_eq!(hunks[0].old_start, 1);
        assert_eq!(hunks[0].old_lines, 3);
    }

    #[test]
    fn pure_deletion_reports_delete_hunk() {
        let hunks = diff_hunks("a\nx\ny\nb\n", "a\nb\n");
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].op, GapHunkOp::Delete);
        assert_eq!(hunks[0].removed_idx, vec![1, 2]);
        assert_eq!(hunks[0].added_idx.len(), 0);
        assert_eq!(hunks[0].old_lines, 4);
        assert_eq!(hunks[0].new_lines, 2);
    }

    #[test]
    fn replacement_reports_replace_hunk() {
        let hunks = diff_hunks("a\nold\nc\n", "a\nnew\nc\n");
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].op, GapHunkOp::Replace);
        assert_eq!(hunk_kinds(&hunks[0]), " -+ ");
        assert_eq!(hunks[0].old_start, 1);
        assert_eq!(hunks[0].new_start, 1);
    }

    #[test]
    fn distant_changes_split_close_changes_merge() {
        let old = (1..=30).map(|n| format!("line{n}\n")).collect::<String>();
        let mut new_text = old.clone();
        new_text = new_text.replacen("line5\n", "five\n", 1);
        new_text = new_text.replacen("line25\n", "twentyfive\n", 1);
        let hunks = diff_hunks(&old, &new_text);
        assert_eq!(hunks.len(), 2, "changes 20 lines apart must not merge");
        // Context is capped at CONTEXT_LINES on each side.
        assert_eq!(hunks[0].old_lines, 2 * CONTEXT_LINES + 1);

        let mut close = old.clone();
        close = close.replacen("line5\n", "five\n", 1);
        close = close.replacen("line8\n", "eight\n", 1);
        let hunks = diff_hunks(&old, &close);
        assert_eq!(hunks.len(), 1, "changes 3 lines apart merge into one hunk");
        assert_eq!(hunks[0].op, GapHunkOp::Replace);
    }

    #[test]
    fn multibyte_korean_lines_diff_safely() {
        let old = "# 주간 보고\n\n기존 문장입니다.\n";
        let new = "# 주간 보고\n\n새로운 문장입니다.\n\n추가된 한국어 줄.\n";
        let hunks = diff_hunks(old, new);
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0]
            .lines
            .iter()
            .any(|line| line.kind == '-' && line.text == "기존 문장입니다."));
        assert!(hunks[0]
            .lines
            .iter()
            .any(|line| line.kind == '+' && line.text == "추가된 한국어 줄."));
    }

    fn classified(old: &str, new: &str) -> Vec<(GapHunkType, Vec<String>)> {
        let old_lines: Vec<&str> = old.lines().collect();
        let new_lines: Vec<&str> = new.lines().collect();
        diff_hunks(old, new)
            .iter()
            .map(|raw| {
                classify_hunk(
                    raw,
                    old,
                    frontmatter_end(&old_lines),
                    frontmatter_end(&new_lines),
                )
            })
            .collect()
    }

    #[test]
    fn whitespace_only_change_is_formatting() {
        let result = classified("hello   world\n", "hello world\n");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, GapHunkType::Formatting);
    }

    #[test]
    fn frontmatter_only_change_is_formatting() {
        let old = "---\ntitle: A\ntags: [x]\n---\nbody\n";
        let new = "---\ntitle: B\ntags: [x]\n---\nbody\n";
        let result = classified(old, new);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, GapHunkType::Formatting);
        // A body change in the same doc is not formatting.
        let mixed = "---\ntitle: B\ntags: [x]\n---\nbody changed\n";
        let result = classified(old, mixed);
        assert!(result.iter().any(|(kind, _)| *kind != GapHunkType::Formatting));
    }

    #[test]
    fn injected_frontmatter_over_a_plain_baseline_is_formatting() {
        // What an older drafts_promote left behind: baseline = raw draft body,
        // promoted note = the same body with generated frontmatter on top.
        let old = "# Draft body\n\nDetails here.\n";
        let new = "---\nstatus: active\ntitle: Ship 3 reports\n---\n# Draft body\n\nDetails here.\n";
        let result = classified(old, new);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, GapHunkType::Formatting);
        assert_eq!(result[0].1, vec!["frontmatter".to_string()]);
    }

    #[test]
    fn url_or_date_already_in_the_baseline_is_not_external_info() {
        let old = "see https://example.com/a on 2026-08-01\n";
        let new = "please see https://example.com/a on 2026-08-01 for details\n";
        let result = classified(old, new);
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].0,
            GapHunkType::DirectEdit,
            "rewording around an existing citation is a direct edit"
        );
        assert!(result[0].1.is_empty(), "unexpected evidence {:?}", result[0].1);
    }

    #[test]
    fn added_wikilink_is_cross_doc_reference() {
        let result = classified("intro\n", "intro\nsee [[Weekly Plan]]\n");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, GapHunkType::CrossDocReference);
        assert_eq!(result[0].1, vec!["[[Weekly Plan]]".to_string()]);
    }

    #[test]
    fn added_relative_markdown_link_is_cross_doc_reference() {
        let result = classified("intro\n", "intro\nsee [plan](notes/plan.md)\n");
        assert_eq!(result[0].0, GapHunkType::CrossDocReference);
        // External URLs are not cross-doc references.
        let result = classified("intro\n", "intro\nsee [site](https://example.com/x)\n");
        assert_eq!(result[0].0, GapHunkType::ExternalInfo);
    }

    #[test]
    fn added_url_date_or_new_number_is_external_info() {
        let result = classified("report\n", "report\nsource https://example.com/a\n");
        assert_eq!(result[0].0, GapHunkType::ExternalInfo);
        assert!(result[0].1.contains(&"https://example.com/a".to_string()));

        let result = classified("report\n", "report\ndue 2026-08-01\n");
        assert_eq!(result[0].0, GapHunkType::ExternalInfo);
        assert_eq!(result[0].1, vec!["2026-08-01".to_string()]);

        let result = classified("report\n", "report\ngrew 42 percent\n");
        assert_eq!(result[0].0, GapHunkType::ExternalInfo);
        assert_eq!(result[0].1, vec!["42".to_string()]);
        // A number already in the baseline is not external info on its own.
        let result = classified("report 42\n", "report 42\nrestated 42\n");
        assert_eq!(result[0].0, GapHunkType::DirectEdit);
    }

    #[test]
    fn plain_rewording_is_direct_edit() {
        let result = classified("the plan is solid\n", "the plan is stronger now\n");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, GapHunkType::DirectEdit);
        assert!(result[0].1.is_empty());
    }

    /// Seed a draft index + baseline + promoted doc the way drafts_promote
    /// leaves them, without invoking the full promote flow.
    fn seed_promoted_draft(
        work: &str,
        id: &str,
        promoted_to: &str,
        baseline_body: &str,
        current_body: Option<&str>,
    ) {
        let root = Path::new(work);
        let entry = DraftEntry {
            id: id.to_string(),
            kind: DraftKind::Task,
            title: "Gap fixture".to_string(),
            status: DraftStatus::Accepted,
            importance: Some(DraftImportance::Medium),
            confidence: None,
            source: ScratchpadSource::Kimi,
            origin_refs: Vec::new(),
            body_path: format!("{id}.md"),
            promoted_to: Some(promoted_to.to_string()),
            created_at: "2026-07-01T00:00:00Z".to_string(),
            updated_at: "2026-07-02T00:00:00Z".to_string(),
        };
        let index_dir = root.join(".maru/drafts");
        fs::create_dir_all(&index_dir).unwrap();
        let index_file = index_dir.join("index.json");
        let mut entries: Vec<DraftEntry> = if index_file.is_file() {
            serde_json::from_str(&fs::read_to_string(&index_file).unwrap()).unwrap_or_default()
        } else {
            Vec::new()
        };
        entries.retain(|existing| existing.id != id);
        entries.push(entry);
        fs::write(&index_file, serde_json::to_string_pretty(&entries).unwrap()).unwrap();
        let baseline = baseline_path(root, id);
        fs::create_dir_all(baseline.parent().unwrap()).unwrap();
        fs::write(&baseline, baseline_body).unwrap();
        if let Some(body) = current_body {
            let doc = root.join(promoted_to);
            fs::create_dir_all(doc.parent().unwrap()).unwrap();
            fs::write(&doc, body).unwrap();
        }
    }

    #[test]
    fn analyze_end_to_end_summary_math() {
        let (_temp, work) = workspace();
        let baseline = "# Report\n\nintro line\n\nold detail\n\ntail\n";
        let current = "# Report\n\nintro line\n\nnew detail from https://example.com\nadded 17 rows\n\ntail\n";
        seed_promoted_draft(&work, "draft-abc-1", "notes/report.md", baseline, Some(current));

        let report = analyze_impl(&work, "draft-abc-1").unwrap();
        assert_eq!(report.draft_id, "draft-abc-1");
        assert_eq!(report.draft_title, "Gap fixture");
        assert_eq!(report.promoted_to, "notes/report.md");
        assert_eq!(
            report.baseline_hash.as_deref(),
            Some(format!("{:x}", Sha256::digest(baseline.as_bytes())).as_str())
        );
        assert!(!report.analyzed_at.is_empty());
        let summary = &report.summary;
        assert_eq!(summary.total_hunks, report.hunks.len());
        assert_eq!(summary.added_lines, 2);
        assert_eq!(summary.removed_lines, 1);
        assert_eq!(
            summary.total_hunks,
            summary.by_type.external_info
                + summary.by_type.direct_edit
                + summary.by_type.cross_doc_reference
                + summary.by_type.formatting
        );
        assert_eq!(summary.by_type.external_info, 1);
    }

    #[test]
    fn analyze_identical_doc_reports_zero_hunks() {
        let (_temp, work) = workspace();
        seed_promoted_draft(&work, "draft-same-1", "notes/same.md", "body\n", Some("body\n"));
        let report = analyze_impl(&work, "draft-same-1").unwrap();
        assert_eq!(report.summary.total_hunks, 0);
        assert!(report.hunks.is_empty());
    }

    #[test]
    fn gap_log_append_and_list_round_trip() {
        let (_temp, work) = workspace();
        seed_promoted_draft(&work, "draft-log-1", "notes/log.md", "a\n", Some("a\nb\n"));
        let entry = gap_append_log(work.clone(), "draft-log-1".to_string()).unwrap();
        assert_eq!(entry.draft_id, "draft-log-1");
        assert_eq!(entry.added_lines, 1);
        assert_eq!(entry.removed_lines, 0);
        assert_eq!(entry.hunk_count, 1);

        // A second entry then listing newest-first with limit.
        seed_promoted_draft(&work, "draft-log-2", "notes/log2.md", "x\n", Some("x\ny\n"));
        gap_append_log(work.clone(), "draft-log-2".to_string()).unwrap();
        let listed = gap_log_list(work.clone(), None).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].draft_id, "draft-log-2");
        assert_eq!(listed[1].draft_id, "draft-log-1");
        let limited = gap_log_list(work.clone(), Some(1)).unwrap();
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].draft_id, "draft-log-2");

        // A corrupt line is skipped, not fatal.
        let log = gap_log_path(Path::new(&work));
        let mut file = OpenOptions::new().append(true).open(&log).unwrap();
        writeln!(file, "{{not json").unwrap();
        let listed = gap_log_list(work.clone(), None).unwrap();
        assert_eq!(listed.len(), 2);
    }

    #[test]
    fn log_entry_carries_provenance_for_normalizing_churn() {
        let (_temp, work) = workspace();
        seed_promoted_draft(&work, "draft-prov", "notes/prov.md", "a\nb\n", Some("a\nb\nc\n"));
        let entry = gap_append_log(work.clone(), "draft-prov".to_string()).unwrap();
        // Two added lines mean one thing against a 2-line baseline and another
        // against a 200-line one, so the size has to travel with the counts.
        assert_eq!(entry.baseline_lines, Some(2));
        assert_eq!(entry.draft_kind.as_deref(), Some("task"));
        assert_eq!(entry.generated_by.as_deref(), Some("kimi"));
        assert!(entry.baseline_hash.is_some());
    }

    #[test]
    fn logging_the_same_unchanged_state_twice_appends_once() {
        let (_temp, work) = workspace();
        seed_promoted_draft(&work, "draft-dupe", "notes/dupe.md", "a\n", Some("a\nb\n"));

        let first = gap_append_log(work.clone(), "draft-dupe".to_string()).unwrap();
        let second = gap_append_log(work.clone(), "draft-dupe".to_string()).unwrap();
        // The second click returns the first row rather than doubling this
        // document's weight in every aggregate.
        assert_eq!(second.at, first.at);
        assert_eq!(gap_log_list(work.clone(), None).unwrap().len(), 1);

        // A real edit is a different state and does get its own row.
        fs::write(Path::new(&work).join("notes/dupe.md"), "a\nb\nc\n").unwrap();
        let third = gap_append_log(work.clone(), "draft-dupe".to_string()).unwrap();
        assert_ne!(third.at, first.at);
        assert_eq!(third.added_lines, 2);
        assert_eq!(gap_log_list(work.clone(), None).unwrap().len(), 2);

        // Another draft is never confused with this one.
        seed_promoted_draft(&work, "draft-other", "notes/other.md", "a\n", Some("a\nb\n"));
        gap_append_log(work.clone(), "draft-other".to_string()).unwrap();
        assert_eq!(gap_log_list(work.clone(), None).unwrap().len(), 3);
    }

    #[test]
    fn analyze_rejects_missing_baseline_and_missing_doc() {
        let (temp, work) = workspace();
        // Baseline exists, promoted doc does not.
        seed_promoted_draft(&work, "draft-miss-1", "notes/gone.md", "a\n", None);
        let error = analyze_impl(&work, "draft-miss-1").unwrap_err();
        assert_eq!(error, "gap_promoted_doc_missing");

        // Promoted doc exists, baseline removed.
        seed_promoted_draft(&work, "draft-miss-2", "notes/here.md", "a\n", Some("a\n"));
        fs::remove_file(baseline_path(temp.path(), "draft-miss-2")).unwrap();
        let error = analyze_impl(&work, "draft-miss-2").unwrap_err();
        assert_eq!(error, "gap_baseline_missing");

        // Unknown draft.
        let error = analyze_impl(&work, "draft-nope-9").unwrap_err();
        assert_eq!(error, "drafts_not_found");
    }

    #[test]
    fn analyze_rejects_traversal_in_promoted_to() {
        let (_temp, work) = workspace();
        for bad in ["../escape.md", "notes/../../escape.md", "/abs/path.md"] {
            seed_promoted_draft(&work, "draft-trav-1", bad, "a\n", None);
            let error = analyze_impl(&work, "draft-trav-1").unwrap_err();
            assert!(
                error == "gap_promoted_doc_missing"
                    || error.contains("escapes"),
                "promotedTo {bad} must be rejected, got {error}"
            );
        }
    }

    #[test]
    fn reports_list_covers_accepted_drafts_only() {
        let (temp, work) = workspace();
        seed_promoted_draft(&work, "draft-rep-1", "notes/a.md", "a\n", Some("a\n"));
        // Accepted but baseline deleted -> hasBaseline false.
        seed_promoted_draft(&work, "draft-rep-2", "notes/b.md", "b\n", Some("b\n"));
        fs::remove_file(baseline_path(temp.path(), "draft-rep-2")).unwrap();
        // Non-accepted draft must not appear.
        let index = temp.path().join(".maru/drafts/index.json");
        let mut entries: Vec<DraftEntry> =
            serde_json::from_str(&fs::read_to_string(&index).unwrap()).unwrap();
        entries[0].status = DraftStatus::Accepted;
        entries.push(DraftEntry {
            status: DraftStatus::New,
            promoted_to: None,
            id: "draft-rep-3".to_string(),
            ..entries[0].clone()
        });
        fs::write(&index, serde_json::to_string_pretty(&entries).unwrap()).unwrap();

        let rows = gap_reports_list(work.clone()).unwrap();
        assert_eq!(rows.len(), 2);
        let first = rows.iter().find(|row| row.draft_id == "draft-rep-1").unwrap();
        assert!(first.has_baseline);
        assert_eq!(first.promoted_to, "notes/a.md");
        assert_eq!(first.promoted_at, "2026-07-02T00:00:00Z");
        let second = rows.iter().find(|row| row.draft_id == "draft-rep-2").unwrap();
        assert!(!second.has_baseline);

        // The baseline can survive a moved/trashed promoted document. The row
        // stays visible so the UI can offer a guarded relink instead of
        // attempting analysis and surfacing a raw backend error.
        fs::remove_file(temp.path().join("notes/a.md")).unwrap();
        let rows = gap_reports_list(work).unwrap();
        let first = rows.iter().find(|row| row.draft_id == "draft-rep-1").unwrap();
        assert!(!first.has_document);
    }

    // === Feedback digest (mirrors src/__tests__/gapAnalysis.test.ts) ===

    fn feedback_entry(at: &str, added: usize, removed: usize, by_type: GapTypeCounts) -> GapLogEntry {
        GapLogEntry {
            at: at.to_string(),
            draft_id: "draft-fb".to_string(),
            promoted_to: "notes/fb.md".to_string(),
            added_lines: added,
            removed_lines: removed,
            by_type,
            hunk_count: 0,
            baseline_hash: None,
            baseline_lines: None,
            draft_kind: None,
            generated_by: None,
        }
    }

    fn counts(external: usize, direct: usize, cross: usize, format: usize) -> GapTypeCounts {
        GapTypeCounts {
            external_info: external,
            direct_edit: direct,
            cross_doc_reference: cross,
            formatting: format,
        }
    }

    #[test]
    fn digest_is_empty_for_no_entries() {
        assert_eq!(build_gap_feedback_digest(&[], 20), "");
    }

    #[test]
    fn digest_aggregates_line_and_per_type_totals() {
        let digest = build_gap_feedback_digest(
            &[
                feedback_entry("2026-07-29T09:00:00", 3, 1, counts(2, 1, 0, 0)),
                feedback_entry("2026-07-30T09:00:00", 2, 2, counts(1, 0, 1, 1)),
            ],
            20,
        );
        let first = digest.lines().next().unwrap();
        assert!(first.contains("최근 초안 2건"), "{first}");
        assert!(first.contains("추가 5줄"), "{first}");
        assert!(first.contains("삭제 3줄"), "{first}");
        assert!(first.contains("외부 정보 3건"), "{first}");
        assert!(first.contains("직접 수정 1건"), "{first}");
        assert!(first.contains("교차 참조 1건"), "{first}");
        assert!(first.contains("서식 1건"), "{first}");
    }

    #[test]
    fn digest_hints_the_dominant_type_only() {
        let digest = build_gap_feedback_digest(
            &[feedback_entry("2026-07-30T09:00:00", 5, 0, counts(4, 1, 0, 0))],
            20,
        );
        assert!(digest.contains("가장 잦은 수정 유형은 외부 정보 추가"), "{digest}");
        assert!(digest.contains("출처·수치·날짜"), "{digest}");
    }

    #[test]
    fn digest_hints_cross_doc_references_when_those_dominate() {
        let digest = build_gap_feedback_digest(
            &[feedback_entry("2026-07-30T09:00:00", 4, 0, counts(0, 0, 3, 1))],
            20,
        );
        assert!(digest.contains("교차 문서 참조"), "{digest}");
        assert!(digest.contains("[[위키링크]]"), "{digest}");
    }

    #[test]
    fn digest_omits_the_hint_when_every_type_count_is_zero() {
        let digest = build_gap_feedback_digest(
            &[feedback_entry("2026-07-30T09:00:00", 0, 0, counts(0, 0, 0, 0))],
            20,
        );
        assert_eq!(digest.lines().count(), 1, "{digest}");
    }

    #[test]
    fn digest_keeps_only_the_most_recent_max_entries() {
        let entries: Vec<GapLogEntry> = (0..5)
            .map(|index| {
                feedback_entry(
                    &format!("2026-07-2{index}T09:00:00"),
                    1,
                    0,
                    counts(if index == 0 { 9 } else { 0 }, 1, 0, 0),
                )
            })
            .collect();
        let digest = build_gap_feedback_digest(&entries, 2);
        // Only the two newest (07-23, 07-24) count: the old 9-external-info
        // entry is out.
        assert!(digest.contains("최근 초안 2건"), "{digest}");
        assert!(digest.contains("추가 2줄"), "{digest}");
        assert!(digest.contains("외부 정보 0건"), "{digest}");
        assert!(digest.contains("가장 잦은 수정 유형은 직접 수정"), "{digest}");
    }

    #[test]
    fn append_returns_the_prompt_unchanged_for_an_empty_digest() {
        assert_eq!(append_gap_feedback_digest("run extract-tasks", ""), "run extract-tasks");
    }

    #[test]
    fn append_adds_a_delimited_section() {
        assert_eq!(
            append_gap_feedback_digest("run extract-tasks", "digest body"),
            format!("run extract-tasks\n\n{GAP_FEEDBACK_SECTION_HEADER}\n\ndigest body"),
        );
        assert_eq!(
            append_gap_feedback_digest("", "digest body"),
            format!("{GAP_FEEDBACK_SECTION_HEADER}\n\ndigest body"),
        );
    }

    #[test]
    fn strip_removes_a_baked_in_section_and_its_separator() {
        let baked = format!("do stuff\n\n{GAP_FEEDBACK_SECTION_HEADER}\n\nstale digest");
        assert_eq!(strip_gap_feedback_section(&baked), "do stuff");
        // A prompt without the section is untouched.
        assert_eq!(strip_gap_feedback_section("do stuff"), "do stuff");
        // A section-only prompt strips to empty.
        assert_eq!(
            strip_gap_feedback_section(&format!("{GAP_FEEDBACK_SECTION_HEADER}\n\nstale")),
            ""
        );
    }
}
