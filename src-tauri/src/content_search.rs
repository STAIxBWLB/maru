use crate::cli_path::resolve_program;
use crate::inbox_settings::expand_tilde;
use crate::paths::GENERATED_DIRS;
use crate::vault::{
    lexical_normalize, load_maruignore, matches_maruignore, ScanFilter, ScanOptions,
};
use crate::win_process::NoWindow;
use crate::workspace_files::is_binary_file;
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use walkdir::WalkDir;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MATCH_LINES_PER_FILE: usize = 200;
const MAX_FILES: usize = 500;
const MAX_TOTAL_MATCHES: usize = 5_000;
const MAX_LINE_CHARS: usize = 500;
const RG_MATCH_LINE_SENTINEL: usize = MAX_MATCH_LINES_PER_FILE + 1;
const FALLBACK_CHUNK_SIZE: usize = 64;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchOptions {
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub include_dot_folders: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchMatch {
    /// One-based source line number.
    pub line: u32,
    pub text: String,
    /// JavaScript-compatible UTF-16 `[start, end]` ranges.
    pub ranges: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchFile {
    pub path: String,
    pub rel_path: String,
    pub matches: Vec<ContentSearchMatch>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchResult {
    pub files: Vec<ContentSearchFile>,
    pub file_count: usize,
    pub total_matches: usize,
    pub truncated: bool,
}

impl ContentSearchResult {
    fn empty() -> Self {
        Self {
            files: Vec::new(),
            file_count: 0,
            total_matches: 0,
            truncated: false,
        }
    }
}

#[derive(Debug)]
struct GlobMatcher {
    regex: Regex,
    match_path: bool,
}

struct SearchContext {
    root: PathBuf,
    matcher: Regex,
    include: Vec<GlobMatcher>,
    exclude: Vec<GlobMatcher>,
    ignore_patterns: Vec<String>,
    scan_filter: ScanFilter,
}

struct PendingFile {
    path: PathBuf,
    rel_path: String,
    matches: Vec<ContentSearchMatch>,
    truncated: bool,
    oracle_lines_seen: usize,
}

#[derive(Debug, PartialEq, Eq)]
struct RgVisibility {
    hidden: bool,
    exclude_git: bool,
}

#[derive(Default)]
struct BoundedFiles {
    files: BTreeMap<(String, String), ContentSearchFile>,
    truncated: bool,
}

#[tauri::command(async)]
pub fn search_workspace_contents(
    workspace_path: String,
    query: String,
    options: Option<ContentSearchOptions>,
) -> Result<ContentSearchResult, String> {
    if query.trim().is_empty() {
        return Ok(ContentSearchResult::empty());
    }

    let root = normalize_search_root(&workspace_path)?;
    let options = options.unwrap_or_default();
    let pattern = build_pattern(&query, &options);
    let matcher = Regex::new(&pattern).map_err(compact_regex_error)?;
    let scan_filter = ScanFilter::from_options(Some(ScanOptions {
        include_dot_folders: options.include_dot_folders.clone(),
    }))?;
    let context = SearchContext::new(root, matcher, &options, scan_filter)?;

    let files = collect_with_rg(&pattern, &context).unwrap_or_else(|| collect_with_rust(&context));
    Ok(files.into_result())
}

fn normalize_search_root(input: &str) -> Result<PathBuf, String> {
    let path = expand_tilde(input);
    if !path.exists() {
        return Err("Workspace path does not exist".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Cannot open workspace directory: {error}"))?;
    if !canonical.is_dir() {
        return Err("Workspace path is not a directory".to_string());
    }
    Ok(canonical)
}

fn build_pattern(query: &str, options: &ContentSearchOptions) -> String {
    let mut pattern = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if options.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    if !options.case_sensitive {
        pattern = format!("(?i){pattern}");
    }
    pattern
}

fn compact_regex_error(error: regex::Error) -> String {
    let detail = error
        .to_string()
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("invalid expression")
        .trim()
        .to_string();
    format!("invalid regex: {detail}")
}

impl SearchContext {
    fn new(
        root: PathBuf,
        matcher: Regex,
        options: &ContentSearchOptions,
        scan_filter: ScanFilter,
    ) -> Result<Self, String> {
        Ok(Self {
            include: compile_globs(&options.include)?,
            exclude: compile_globs(&options.exclude)?,
            ignore_patterns: load_maruignore(&root),
            root,
            matcher,
            scan_filter,
        })
    }

    fn start_file(&self, raw_path: &Path) -> Option<PendingFile> {
        let path = lexical_normalize(raw_path);
        let rel = path.strip_prefix(&self.root).ok()?;
        if rel.as_os_str().is_empty()
            || self
                .scan_filter
                .is_excluded_path(&path, &self.root, GENERATED_DIRS)
            || matches_maruignore(rel, &self.ignore_patterns)
        {
            return None;
        }
        let rel_path = rel.to_string_lossy().replace('\\', "/");
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&rel_path);
        if (!self.include.is_empty() && !matches_any_glob(&self.include, &rel_path, name))
            || matches_any_glob(&self.exclude, &rel_path, name)
        {
            return None;
        }
        let metadata = fs::metadata(&path).ok()?;
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES || is_binary_file(&path) {
            return None;
        }
        Some(PendingFile {
            path,
            rel_path,
            matches: Vec::new(),
            truncated: false,
            oracle_lines_seen: 0,
        })
    }

    fn match_line(&self, line: u32, text: &str) -> Option<ContentSearchMatch> {
        let text = truncate_chars(text, MAX_LINE_CHARS);
        let ranges: Vec<(u32, u32)> = self
            .matcher
            .find_iter(&text)
            .filter(|matched| matched.start() < matched.end())
            .map(|matched| {
                (
                    utf16_offset(&text, matched.start()),
                    utf16_offset(&text, matched.end()),
                )
            })
            .collect();
        (!ranges.is_empty()).then_some(ContentSearchMatch { line, text, ranges })
    }
}

impl PendingFile {
    fn push_matching_line(&mut self, context: &SearchContext, line: u32, text: &str) {
        self.oracle_lines_seen += 1;
        if self.oracle_lines_seen > MAX_MATCH_LINES_PER_FILE {
            self.truncated = true;
            return;
        }
        let Some(matched) = context.match_line(line, text) else {
            return;
        };
        if self.matches.len() >= MAX_MATCH_LINES_PER_FILE {
            self.truncated = true;
        } else {
            self.matches.push(matched);
        }
    }
}

fn rg_visibility(scan_filter: &ScanFilter) -> RgVisibility {
    RgVisibility {
        hidden: scan_filter.includes_dot_folders(),
        exclude_git: !scan_filter.could_include_dot_folder_named(".git"),
    }
}

impl BoundedFiles {
    fn push(&mut self, pending: PendingFile) {
        self.truncated |= pending.truncated;
        if pending.matches.is_empty() {
            return;
        }
        let file = ContentSearchFile {
            path: pending.path.to_string_lossy().to_string(),
            rel_path: pending.rel_path,
            matches: pending.matches,
        };
        let key = (file.rel_path.to_lowercase(), file.rel_path.clone());
        if self.files.len() < MAX_FILES {
            self.files.insert(key, file);
            return;
        }

        self.truncated = true;
        let replace_last = self
            .files
            .last_key_value()
            .map(|(last, _)| &key < last)
            .unwrap_or(true);
        if replace_last {
            self.files.pop_last();
            self.files.insert(key, file);
        }
    }

    fn into_result(self) -> ContentSearchResult {
        let mut truncated = self.truncated;
        let mut remaining = MAX_TOTAL_MATCHES;
        let mut files = Vec::with_capacity(self.files.len());
        for (_, mut file) in self.files {
            if remaining == 0 {
                truncated = true;
                break;
            }
            if file.matches.len() > remaining {
                file.matches.truncate(remaining);
                truncated = true;
            }
            remaining -= file.matches.len();
            files.push(file);
        }
        let total_matches = files.iter().map(|file| file.matches.len()).sum();
        ContentSearchResult {
            file_count: files.len(),
            total_matches,
            files,
            truncated,
        }
    }
}

/// ripgrep is deliberately only a line oracle. Stdout is consumed as a
/// `path\0line:text\n` stream and always drained to EOF. Filtering, range
/// calculation, ordering, and caps are shared with the fallback collector.
fn collect_with_rg(pattern: &str, context: &SearchContext) -> Option<BoundedFiles> {
    let rg = resolve_program("rg")?;
    let mut command = Command::new(rg);
    command
        .args([
            "--no-config",
            "--no-ignore",
            "--no-require-git",
            "--no-messages",
            "--text",
            "--sort=path",
            "--line-number",
            "--null",
            "--no-heading",
            "--crlf",
            "--max-filesize=2097152",
        ])
        .arg(format!("--max-count={RG_MATCH_LINE_SENTINEL}"))
        .arg("-e")
        .arg(pattern);
    let visibility = rg_visibility(&context.scan_filter);
    if visibility.hidden {
        command.arg("--hidden");
    }
    if visibility.exclude_git {
        command.arg("-g").arg("!.git/**");
        command.arg("-g").arg("!**/.git/**");
    }
    for directory in GENERATED_DIRS {
        command.arg("-g").arg(format!("!{directory}/**"));
        command.arg("-g").arg(format!("!**/{directory}/**"));
    }
    let mut child = command
        .arg("--")
        .arg(".")
        .current_dir(&context.root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .no_window()
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;
    let mut reader = BufReader::new(stdout);
    let mut files = BoundedFiles::default();
    let mut current_path: Option<PathBuf> = None;
    let mut current_file: Option<PendingFile> = None;
    let mut raw_path = Vec::new();
    let mut payload = Vec::new();
    let mut read_failed = false;

    loop {
        raw_path.clear();
        match reader.read_until(0, &mut raw_path) {
            Ok(0) => break,
            Ok(_) if raw_path.last() == Some(&0) => {
                raw_path.pop();
            }
            Ok(_) | Err(_) => {
                read_failed = true;
                break;
            }
        }
        payload.clear();
        match reader.read_until(b'\n', &mut payload) {
            Ok(0) | Err(_) => {
                read_failed = true;
                break;
            }
            Ok(_) => {}
        }
        if payload.last() == Some(&b'\n') {
            payload.pop();
        }
        if payload.last() == Some(&b'\r') {
            payload.pop();
        }

        let (Ok(raw_path), Ok(payload)) = (
            std::str::from_utf8(&raw_path),
            std::str::from_utf8(&payload),
        ) else {
            continue;
        };
        let Some((raw_line, text)) = payload.split_once(':') else {
            continue;
        };
        let Ok(line) = raw_line.parse::<u32>() else {
            continue;
        };
        let raw_path = raw_path.strip_prefix("./").unwrap_or(raw_path);
        let raw_path = PathBuf::from(raw_path);
        let path = lexical_normalize(&if raw_path.is_absolute() {
            raw_path
        } else {
            context.root.join(raw_path)
        });
        if current_path.as_ref() != Some(&path) {
            if let Some(pending) = current_file.take() {
                files.push(pending);
            }
            current_file = context.start_file(&path);
            current_path = Some(path);
        }
        if let Some(pending) = current_file.as_mut() {
            pending.push_matching_line(context, line, text);
        }
    }
    if let Some(pending) = current_file {
        files.push(pending);
    }

    if read_failed {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }
    let status = child.wait().ok()?;
    matches!(status.code(), Some(0 | 1)).then_some(files)
}

/// The fallback intentionally uses `read_to_string`. A file whose first 8 KiB
/// is valid UTF-8 but becomes invalid later is dropped here, while rg may
/// still report an earlier valid line. Closing that rare difference would
/// require rereading every rg candidate in full and erase the fast path.
fn collect_with_rust(context: &SearchContext) -> BoundedFiles {
    let candidates = WalkDir::new(&context.root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let path = entry.path();
            if path == context.root {
                return true;
            }
            if context
                .scan_filter
                .is_excluded_path(path, &context.root, GENERATED_DIRS)
            {
                return false;
            }
            let rel = path.strip_prefix(&context.root).unwrap_or(path);
            !matches_maruignore(rel, &context.ignore_patterns)
        })
        .filter_map(Result::ok);

    let mut files = BoundedFiles::default();
    let mut chunk = Vec::with_capacity(FALLBACK_CHUNK_SIZE);
    for entry in candidates {
        if !entry.file_type().is_file() {
            continue;
        }
        chunk.push(entry.into_path());
        if chunk.len() == FALLBACK_CHUNK_SIZE {
            process_fallback_chunk(context, &mut chunk, &mut files);
        }
    }
    process_fallback_chunk(context, &mut chunk, &mut files);
    files
}

fn process_fallback_chunk(
    context: &SearchContext,
    paths: &mut Vec<PathBuf>,
    files: &mut BoundedFiles,
) {
    let mut completed: Vec<PendingFile> = paths
        .par_iter()
        .filter_map(|path| {
            let mut pending = context.start_file(path)?;
            let contents = fs::read_to_string(path).ok()?;
            for (index, text) in contents.lines().enumerate() {
                if !context.matcher.is_match(text) {
                    continue;
                }
                let line = (index + 1).min(u32::MAX as usize) as u32;
                pending.push_matching_line(context, line, text);
            }
            Some(pending)
        })
        .collect();
    completed
        .sort_by_cached_key(|pending| (pending.rel_path.to_lowercase(), pending.rel_path.clone()));
    for pending in completed {
        files.push(pending);
    }
    paths.clear();
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((byte, _)) => text[..byte].to_string(),
        None => text.to_string(),
    }
}

fn utf16_offset(text: &str, byte: usize) -> u32 {
    text[..byte]
        .chars()
        .map(char::len_utf16)
        .sum::<usize>()
        .min(u32::MAX as usize) as u32
}

fn compile_globs(patterns: &[String]) -> Result<Vec<GlobMatcher>, String> {
    patterns
        .iter()
        .filter_map(|raw| {
            let pattern = raw.trim().replace('\\', "/");
            (!pattern.is_empty() && !pattern.starts_with('#')).then_some(pattern)
        })
        .map(|pattern| {
            let match_path = pattern.contains('/');
            let regex = Regex::new(&glob_regex_source(&pattern))
                .map_err(|error| format!("invalid glob: {error}"))?;
            Ok(GlobMatcher { regex, match_path })
        })
        .collect()
}

fn glob_regex_source(pattern: &str) -> String {
    let mut source = String::from("(?i)^");
    for character in pattern.chars() {
        match character {
            '*' => source.push_str(".*"),
            '?' => source.push('.'),
            other => source.push_str(&regex::escape(&other.to_string())),
        }
    }
    source.push('$');
    source
}

fn matches_any_glob(patterns: &[GlobMatcher], rel_path: &str, name: &str) -> bool {
    patterns.iter().any(|pattern| {
        pattern
            .regex
            .is_match(if pattern.match_path { rel_path } else { name })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn search(root: &Path, query: &str, options: ContentSearchOptions) -> ContentSearchResult {
        search_workspace_contents(
            root.to_string_lossy().to_string(),
            query.to_string(),
            Some(options),
        )
        .unwrap()
    }

    fn engine_results(
        root: &Path,
        query: &str,
        options: &ContentSearchOptions,
    ) -> (ContentSearchResult, ContentSearchResult) {
        let root = normalize_search_root(&root.to_string_lossy()).unwrap();
        let pattern = build_pattern(query, options);
        let matcher = Regex::new(&pattern).unwrap();
        let scan_filter = ScanFilter::from_options(Some(ScanOptions {
            include_dot_folders: options.include_dot_folders.clone(),
        }))
        .unwrap();
        let context = SearchContext::new(root, matcher, options, scan_filter).unwrap();
        let rg = collect_with_rg(&pattern, &context).unwrap().into_result();
        let fallback = collect_with_rust(&context).into_result();
        (rg, fallback)
    }

    #[test]
    fn utf16_ranges_are_not_byte_offsets() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("note.md"), "안녕 world 안녕");
        let result = search(dir.path(), "world", ContentSearchOptions::default());
        assert_eq!(result.files[0].matches[0].ranges, vec![(3, 8)]);
    }

    #[test]
    fn utf16_ranges_count_emoji_as_two_units() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("note.md"), "😀 world");
        let result = search(dir.path(), "world", ContentSearchOptions::default());
        assert_eq!(result.files[0].matches[0].ranges, vec![(3, 8)]);
    }

    #[test]
    fn literal_query_escapes_regex_metacharacters() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("literal.txt"), "a.b\naxb");
        let result = search(dir.path(), "a.b", ContentSearchOptions::default());
        assert_eq!(result.total_matches, 1);
        assert_eq!(result.files[0].matches[0].line, 1);
    }

    #[test]
    fn non_empty_query_whitespace_is_preserved() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("spaces.txt"), "needle\n needle \n");
        let result = search(dir.path(), " needle ", ContentSearchOptions::default());
        assert_eq!(result.total_matches, 1);
        assert_eq!(result.files[0].matches[0].line, 2);
        assert_eq!(result.files[0].matches[0].ranges, vec![(0, 8)]);
    }

    #[test]
    fn whole_word_does_not_match_inside_a_word() {
        let dir = tempdir().unwrap();
        write(
            &dir.path().join("word.md"),
            "회의\n정기회의록\nmeeting meetings",
        );
        let result = search(
            dir.path(),
            "회의",
            ContentSearchOptions {
                whole_word: true,
                ..Default::default()
            },
        );
        assert_eq!(result.total_matches, 1);
        let result = search(
            dir.path(),
            "meeting",
            ContentSearchOptions {
                whole_word: true,
                ..Default::default()
            },
        );
        assert_eq!(result.files[0].matches[0].ranges, vec![(0, 7)]);
    }

    #[test]
    fn invalid_regex_returns_message_not_panic() {
        let dir = tempdir().unwrap();
        let error = search_workspace_contents(
            dir.path().to_string_lossy().to_string(),
            "(".to_string(),
            Some(ContentSearchOptions {
                regex: true,
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(error.starts_with("invalid regex:"));
    }

    #[test]
    fn respects_maruignore_generated_dirs_and_dotfolders() {
        let dir = tempdir().unwrap();
        write(&dir.path().join(".maruignore"), "ignored\n");
        write(&dir.path().join("keep.md"), "needle");
        write(&dir.path().join("ignored/a.md"), "needle");
        write(&dir.path().join("node_modules/a.md"), "needle");
        write(&dir.path().join(".hidden/a.md"), "needle");
        write(&dir.path().join(".git/objects/a.md"), "needle");
        write(&dir.path().join(".allowed/a.md"), "needle");
        let result = search(
            dir.path(),
            "needle",
            ContentSearchOptions {
                include_dot_folders: vec![".allowed".to_string()],
                ..Default::default()
            },
        );
        assert_eq!(
            result
                .files
                .iter()
                .map(|file| file.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec![".allowed/a.md", "keep.md"]
        );
    }

    #[test]
    fn skips_binary_and_oversize_files() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("keep.txt"), "needle");
        fs::write(dir.path().join("binary.txt"), b"needle\0rest").unwrap();
        let mut large = fs::File::create(dir.path().join("large.txt")).unwrap();
        large.set_len(MAX_FILE_BYTES + 1).unwrap();
        large.write_all(b"needle").unwrap();
        let result = search(dir.path(), "needle", ContentSearchOptions::default());
        assert_eq!(result.file_count, 1);
        assert_eq!(result.files[0].rel_path, "keep.txt");
    }

    #[test]
    fn include_and_exclude_globs_apply() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("src/a.ts"), "needle");
        write(&dir.path().join("src/a.test.ts"), "needle");
        write(&dir.path().join("docs/a.md"), "needle");
        let result = search(
            dir.path(),
            "needle",
            ContentSearchOptions {
                include: vec!["src/**".to_string()],
                exclude: vec!["*.test.ts".to_string()],
                ..Default::default()
            },
        );
        assert_eq!(result.file_count, 1);
        assert_eq!(result.files[0].rel_path, "src/a.ts");
    }

    #[test]
    fn results_use_deterministic_case_insensitive_path_order() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("Z.txt"), "needle");
        write(&dir.path().join("a.txt"), "needle");
        write(&dir.path().join("B.txt"), "needle");
        let result = search(dir.path(), "needle", ContentSearchOptions::default());
        assert_eq!(
            result
                .files
                .iter()
                .map(|file| file.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.txt", "B.txt", "Z.txt"]
        );
    }

    #[test]
    fn caps_are_enforced_and_reported() {
        let dir = tempdir().unwrap();
        let contents = (0..=MAX_MATCH_LINES_PER_FILE)
            .map(|index| format!("needle {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        write(&dir.path().join("many.txt"), &contents);
        let result = search(dir.path(), "needle", ContentSearchOptions::default());
        assert_eq!(result.total_matches, MAX_MATCH_LINES_PER_FILE);
        assert!(result.truncated);

        let file_cap_dir = tempdir().unwrap();
        for index in 0..=MAX_FILES {
            write(
                &file_cap_dir.path().join(format!("file-{index:04}.txt")),
                "needle",
            );
        }
        let result = search(
            file_cap_dir.path(),
            "needle",
            ContentSearchOptions::default(),
        );
        assert_eq!(result.file_count, MAX_FILES);
        assert_eq!(result.total_matches, MAX_FILES);
        assert!(result.truncated);

        let total_cap_dir = tempdir().unwrap();
        let two_hundred_lines = (0..MAX_MATCH_LINES_PER_FILE)
            .map(|index| format!("needle {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        for index in 0..26 {
            write(
                &total_cap_dir.path().join(format!("file-{index:02}.txt")),
                &two_hundred_lines,
            );
        }
        let result = search(
            total_cap_dir.path(),
            "needle",
            ContentSearchOptions::default(),
        );
        assert_eq!(result.total_matches, MAX_TOTAL_MATCHES);
        assert!(result.truncated);
    }

    #[test]
    fn fallback_streams_many_files_into_bounded_lexical_retention() {
        let dir = tempdir().unwrap();
        for index in (0..MAX_FILES + 250).rev() {
            write(&dir.path().join(format!("file-{index:04}.txt")), "needle");
        }
        let options = ContentSearchOptions::default();
        let root = normalize_search_root(&dir.path().to_string_lossy()).unwrap();
        let pattern = build_pattern("needle", &options);
        let matcher = Regex::new(&pattern).unwrap();
        let context = SearchContext::new(root, matcher, &options, ScanFilter::default()).unwrap();
        let retained = collect_with_rust(&context);
        assert_eq!(retained.files.len(), MAX_FILES);
        let result = retained.into_result();
        assert_eq!(result.files.first().unwrap().rel_path, "file-0000.txt");
        assert_eq!(result.files.last().unwrap().rel_path, "file-0499.txt");
        assert!(result.truncated);
    }

    #[test]
    fn empty_query_returns_empty_without_reading_workspace() {
        let result = search_workspace_contents(
            "/path/that/does/not/exist".to_string(),
            "  ".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(result, ContentSearchResult::empty());
    }

    #[test]
    fn missing_workspace_is_not_created() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("missing");
        let error = search_workspace_contents(
            missing.to_string_lossy().to_string(),
            "needle".to_string(),
            None,
        )
        .unwrap_err();
        assert_eq!(error, "Workspace path does not exist");
        assert!(!missing.exists());
    }

    #[test]
    fn glob_to_regex_matches_existing_frontend_semantics() {
        let matcher = Regex::new(&glob_regex_source("src/*.ts")).unwrap();
        assert!(matcher.is_match("src/nested/a.ts"));
        assert!(!matcher.is_match("src/a.md"));
        let matcher = Regex::new(&glob_regex_source("file?.{ts,js}")).unwrap();
        assert!(matcher.is_match("file1.{ts,js}"));
        assert!(!matcher.is_match("file1.ts"));
    }

    #[test]
    fn rg_hidden_and_git_traversal_follow_dot_folder_allowlist() {
        assert_eq!(
            rg_visibility(&ScanFilter::default()),
            RgVisibility {
                hidden: false,
                exclude_git: true,
            }
        );

        let allowed = ScanFilter::from_options(Some(ScanOptions {
            include_dot_folders: vec![".allowed".to_string()],
        }))
        .unwrap();
        assert_eq!(
            rg_visibility(&allowed),
            RgVisibility {
                hidden: true,
                exclude_git: true,
            }
        );

        let git_allowed = ScanFilter::from_options(Some(ScanOptions {
            include_dot_folders: vec!["nested/.git/refs".to_string()],
        }))
        .unwrap();
        assert_eq!(
            rg_visibility(&git_allowed),
            RgVisibility {
                hidden: true,
                exclude_git: true,
            }
        );
        // SCAN-02: generated dirs are un-allowlistable — allowlisting a path
        // under .git must not resurrect it into rg results.
        assert!(rg_visibility(&git_allowed).exclude_git);
    }

    #[test]
    fn rg_and_fallback_produce_identical_results() {
        if resolve_program("rg").is_none() {
            return;
        }
        let dir = tempdir().unwrap();
        write(&dir.path().join(".maruignore"), "ignored\n");
        write(&dir.path().join("a.md"), "안녕 needle\r\nlast needle");
        write(&dir.path().join("nested/b.txt"), "needle without newline");
        write(&dir.path().join("ignored/c.md"), "needle");
        write(&dir.path().join("node_modules/d.md"), "needle");
        fs::write(dir.path().join("binary.txt"), b"needle\0rest").unwrap();
        let options = ContentSearchOptions::default();
        let (rg, fallback) = engine_results(dir.path(), "needle", &options);
        assert_eq!(rg, fallback);
    }

    #[test]
    fn rg_text_mode_matches_fallback_after_late_nul() {
        if resolve_program("rg").is_none() {
            return;
        }
        let dir = tempdir().unwrap();
        let contents = format!("{}\0\nneedle after nul", "a".repeat(8 * 1024 + 1));
        write(&dir.path().join("late-nul.txt"), &contents);
        let options = ContentSearchOptions::default();
        let (rg, fallback) = engine_results(dir.path(), "needle", &options);
        assert_eq!(rg, fallback);
        assert_eq!(rg.total_matches, 1);
        assert_eq!(rg.files[0].matches[0].line, 2);
    }

    #[test]
    fn rg_sentinel_reports_raw_line_overflow_without_retaining_it() {
        if resolve_program("rg").is_none() {
            return;
        }
        let dir = tempdir().unwrap();
        let beyond_display = format!("{}needle", "x".repeat(MAX_LINE_CHARS));
        let contents = std::iter::repeat(beyond_display)
            .take(RG_MATCH_LINE_SENTINEL)
            .collect::<Vec<_>>()
            .join("\n");
        write(&dir.path().join("sentinel.txt"), &contents);
        let options = ContentSearchOptions::default();
        let (rg, fallback) = engine_results(dir.path(), "needle", &options);
        assert_eq!(rg, fallback);
        assert_eq!(rg.total_matches, 0);
        assert!(rg.truncated);
    }

    #[test]
    fn rg_and_fallback_agree_across_search_options() {
        if resolve_program("rg").is_none() {
            return;
        }
        let dir = tempdir().unwrap();
        write(
            &dir.path().join("src/a.txt"),
            "Alpha alpha\nmeeting meetings\na.b axb",
        );
        write(&dir.path().join("src/a.test.txt"), "Alpha");
        write(&dir.path().join("docs/a.md"), "Alpha");
        write(&dir.path().join(".allowed/a.md"), "Alpha");

        let cases = [
            (
                "Alpha",
                ContentSearchOptions {
                    case_sensitive: true,
                    ..Default::default()
                },
            ),
            (
                "meeting",
                ContentSearchOptions {
                    whole_word: true,
                    ..Default::default()
                },
            ),
            (
                r"A(?:lph|LPH)a",
                ContentSearchOptions {
                    regex: true,
                    ..Default::default()
                },
            ),
            (
                "a.b",
                ContentSearchOptions {
                    include: vec!["src/**".to_string()],
                    exclude: vec!["*.test.txt".to_string()],
                    ..Default::default()
                },
            ),
            (
                "Alpha",
                ContentSearchOptions {
                    include_dot_folders: vec![".allowed".to_string()],
                    include: vec![".allowed/**".to_string()],
                    ..Default::default()
                },
            ),
        ];

        for (query, options) in cases {
            let (rg, fallback) = engine_results(dir.path(), query, &options);
            assert_eq!(rg, fallback, "engines differ for {query:?}");
        }
    }
}
