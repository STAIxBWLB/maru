//! Scanner tests on synthetic trees only (no copied repository content).

use super::*;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn write(root: &Path, relative: &str, body: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

/// A unique scratch folder removed on drop (the crate carries no tempfile
/// dependency). It lives under the system temp dir, never the workspace.
struct Scratch(PathBuf);

impl Scratch {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn tempdir() -> Scratch {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "maru-scan-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    Scratch(path)
}

/// A budget far from its deadline, for calling the resolvers directly.
fn open_budget() -> Budget {
    Budget {
        deadline: Instant::now() + Duration::from_secs(60),
        bytes: 0,
    }
}

fn limits() -> ScanLimits {
    ScanLimits::new(None, None).unwrap()
}

/// A small polyglot repository: a TS app, a Rust crate and a Python package,
/// with imports across folders, an ignored build folder and a vendored file.
fn sample(root: &Path) {
    write(root, ".gitignore", "dist/\n*.log\n/vendor/\n!keep.log\n");
    write(root, "README.md", "# sample\n");
    write(root, "keep.log", "kept by negation\n");
    write(root, "debug.log", "ignored\n");
    write(root, "dist/bundle.js", "import x from '../web/src/main';\n");
    write(root, "vendor/lib.js", "ignored\n");
    // TypeScript: web/src/main.ts -> web/src/ui/button.tsx and shared/util.ts.
    write(
        root,
        "web/src/main.ts",
        "import { Button } from './ui/button';\nimport { slug } from \"../../shared/util.js\";\nimport React from 'react';\nimport fs from 'node:fs';\nimport path from 'path';\n",
    );
    write(
        root,
        "web/src/ui/button.tsx",
        "export const Button = () => null;\nimport type { Props } from '@scope/kit/types';\n",
    );
    write(
        root,
        "shared/util.ts",
        "export const slug = (s: string) => s;\n// import nothing from './gone';\n",
    );
    // Rust: core/src/lib.rs declares a module and uses a sibling.
    write(root, "core/Cargo.toml", "[package]\nname = \"core\"\n");
    write(
        root,
        "core/src/lib.rs",
        "pub mod parse;\nmod store;\nuse serde::Serialize;\n",
    );
    write(
        root,
        "core/src/parse.rs",
        "use crate::store::Store;\nuse std::fmt;\n",
    );
    write(root, "core/src/store/mod.rs", "pub struct Store;\n");
    // Python: tools/report.py imports the analysis package two ways.
    write(root, "analysis/__init__.py", "");
    write(
        root,
        "analysis/stats.py",
        "from .helpers import mean\nimport numpy as np\n",
    );
    write(
        root,
        "analysis/helpers.py",
        "def mean(xs):\n    return sum(xs) / len(xs)\n",
    );
    write(
        root,
        "tools/report.py",
        "import analysis.stats\nfrom analysis import helpers\n",
    );
}

fn ids(document: &Value) -> Vec<String> {
    document["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| node["id"].as_str().unwrap().to_string())
        .collect()
}

fn edges(document: &Value) -> Vec<(String, String)> {
    document["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|edge| {
            (
                edge["from"].as_str().unwrap().to_string(),
                edge["to"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn node<'a>(document: &'a Value, id: &str) -> &'a Value {
    document["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["id"] == id)
        .unwrap_or_else(|| panic!("node {id} missing"))
}

#[test]
fn a_synthetic_repository_proposes_the_recorded_modules_and_import_edges() {
    let dir = tempdir();
    let root = dir.path();
    sample(root);
    let report = scan(root, root.to_str().unwrap(), limits()).unwrap();
    let document = &report.document;
    assert_eq!(report.stats.inventory, Inventory::Filesystem);
    assert_eq!(report.relative_path, "");
    assert_eq!(document["$schema"], "floorplan/architecture@1");
    assert_eq!(
        document["project"]["name"],
        root.file_name().unwrap().to_str().unwrap()
    );
    // The recorded expectation: folder nodes to depth two, ignored folders absent.
    assert_eq!(
        ids(document),
        ["root", "analysis", "core", "core.src", "shared", "tools", "web", "web.src",]
    );
    let mut found = edges(document);
    found.sort();
    assert_eq!(
        found,
        [
            ("tools".to_string(), "analysis".to_string()),
            ("web.src".to_string(), "shared".to_string()),
        ]
    );
    // Same-folder imports are counted but are not edges.
    assert_eq!(report.stats.file_imports, 8);
    assert_eq!(node(document, "core.src")["parent"], "core");
    assert_eq!(node(document, "web.src")["paths"][0], "web/src/**");
    assert_eq!(node(document, "tools")["kind"], "script");
    assert_eq!(
        node(document, "web.src")["packages"],
        serde_json::json!(["@scope/kit", "react"])
    );
    assert_eq!(
        node(document, "core.src")["packages"],
        serde_json::json!(["serde"])
    );
    assert_eq!(
        node(document, "analysis")["packages"],
        serde_json::json!(["numpy"])
    );
    // keep.log survives its negation; debug.log, dist/ and vendor/ do not.
    assert!(node(document, "root")["summary"]
        .as_str()
        .unwrap()
        .contains("log 1"));
}

#[test]
fn the_proposal_passes_the_engine_floorplan_shape() {
    let dir = tempdir();
    sample(dir.path());
    let report = scan(dir.path(), ".", limits()).unwrap();
    let document = &report.document;
    let known: std::collections::HashSet<_> = ids(document).into_iter().collect();
    assert_eq!(known.len(), ids(document).len(), "node ids are unique");
    for value in document["nodes"].as_array().unwrap() {
        let id = value["id"].as_str().unwrap();
        assert!(id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')));
        assert!(!value["label"].as_str().unwrap().is_empty());
        if let Some(parent) = value["parent"].as_str() {
            assert!(known.contains(parent));
        }
    }
    for (from, to) in edges(document) {
        assert!(known.contains(&from) && known.contains(&to));
    }
}

#[test]
fn the_scan_never_writes_into_the_tree() {
    let dir = tempdir();
    sample(dir.path());
    let listing = |root: &Path| {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(folder) = stack.pop() {
            for entry in fs::read_dir(&folder).unwrap() {
                let path = entry.unwrap().path();
                let meta = fs::symlink_metadata(&path).unwrap();
                out.push((path.clone(), meta.len(), meta.modified().unwrap()));
                if meta.is_dir() {
                    stack.push(path);
                }
            }
        }
        out.sort();
        out
    };
    let before = listing(dir.path());
    scan(dir.path(), ".", limits()).unwrap();
    assert_eq!(listing(dir.path()), before);
}

#[test]
fn a_subfolder_is_scanned_on_its_own_and_reports_its_relative_path() {
    let dir = tempdir();
    sample(dir.path());
    let report = scan(dir.path(), "web", limits()).unwrap();
    assert_eq!(report.relative_path, "web");
    assert_eq!(ids(&report.document), ["src", "src.ui"]);
    assert_eq!(
        edges(&report.document),
        [("src".to_string(), "src.ui".to_string())]
    );
}

#[test]
fn paths_outside_the_workspace_are_refused() {
    let outer = tempdir();
    let root = outer.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    write(outer.path(), "secret/a.ts", "");
    for picked in [
        "..".to_string(),
        "../secret".to_string(),
        outer.path().join("secret").to_str().unwrap().to_string(),
        "/".to_string(),
    ] {
        let error = scan(&root, &picked, limits()).unwrap_err();
        assert_eq!(error.code, "diagram_scan_outside_workspace", "{picked}");
        assert!(!error.next_step.is_empty());
    }
}

#[cfg(unix)]
#[test]
fn a_link_out_of_the_workspace_is_neither_picked_nor_walked() {
    let outer = tempdir();
    let root = outer.path().join("workspace");
    write(&root, "src/a.ts", "import './b';\n");
    write(&root, "src/b.ts", "");
    write(
        outer.path(),
        "secret/key.ts",
        "import x from '../workspace/src/a';\n",
    );
    std::os::unix::fs::symlink(outer.path().join("secret"), root.join("linked")).unwrap();
    std::os::unix::fs::symlink(outer.path().join("secret/key.ts"), root.join("src/key.ts"))
        .unwrap();
    let error = scan(&root, "linked", limits()).unwrap_err();
    assert_eq!(error.code, "diagram_scan_outside_workspace");
    let report = scan(&root, ".", limits()).unwrap();
    assert_eq!(report.stats.files, 2, "links are skipped, not followed");
    assert_eq!(ids(&report.document), ["src"]);
}

#[test]
fn a_file_or_missing_path_is_refused_with_a_next_step() {
    let dir = tempdir();
    write(dir.path(), "a.ts", "");
    let file = scan(dir.path(), "a.ts", limits()).unwrap_err();
    assert_eq!(file.code, "diagram_scan_path_not_folder");
    let missing = scan(dir.path(), "nope", limits()).unwrap_err();
    assert_eq!(missing.code, "diagram_scan_path_missing");
    let empty = scan(dir.path(), "", limits()).unwrap_err();
    assert_eq!(empty.code, "diagram_scan_path_invalid");
    for error in [file, missing, empty] {
        assert!(!error.message.is_empty() && !error.next_step.is_empty());
    }
}

#[test]
fn the_file_bound_stops_the_scan_with_its_cause() {
    let dir = tempdir();
    for index in 0..12 {
        write(dir.path(), &format!("src/f{index}.ts"), "");
    }
    let error = scan(dir.path(), ".", ScanLimits::new(Some(10), None).unwrap()).unwrap_err();
    assert_eq!(error.code, "diagram_scan_too_many_files");
    assert!(error.message.contains("10"));
    assert!(error.next_step.contains("smaller subfolder"));
    assert!(scan(dir.path(), ".", ScanLimits::new(Some(12), None).unwrap()).is_ok());
}

#[test]
fn the_depth_bound_stops_the_scan_with_its_cause() {
    let dir = tempdir();
    write(dir.path(), "a/b/c/d/e/f.ts", "");
    let error = scan(dir.path(), ".", ScanLimits::new(None, Some(3)).unwrap()).unwrap_err();
    assert_eq!(error.code, "diagram_scan_too_deep");
    assert!(error.next_step.contains("maxDepth"));
    assert!(scan(dir.path(), ".", ScanLimits::new(None, Some(8)).unwrap()).is_ok());
}

#[test]
fn the_time_bound_stops_the_scan_with_its_cause() {
    let dir = tempdir();
    write(dir.path(), "src/a.ts", "");
    let mut zero = limits();
    zero.time_budget = Duration::ZERO;
    let error = scan(dir.path(), ".", zero).unwrap_err();
    assert_eq!(error.code, "diagram_scan_timeout");
    assert!(!error.next_step.is_empty());
}

#[cfg(unix)]
#[test]
fn fifo_metadata_files_never_block_the_scan() {
    for relative in [".gitignore", ".git/index"] {
        let dir = tempdir();
        write(dir.path(), "main.ts", "export const answer = 42;");
        let fifo = dir.path().join(relative);
        fs::create_dir_all(fifo.parent().unwrap()).unwrap();
        assert!(std::process::Command::new("/usr/bin/mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let root = dir.path().to_path_buf();
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = send.send(scan(&root, ".", limits()));
        });
        let result = receive
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|_| panic!("scan blocked while opening FIFO {relative}"));
        assert!(result.is_ok(), "{relative}: {result:?}");
    }
}

#[test]
fn the_edge_bound_stops_before_reading_the_remaining_sources() {
    let dir = tempdir();
    let files = (0..46)
        .map(|n| format!("module{n:02}/main.ts"))
        .collect::<Vec<_>>();
    let mut total = 0;
    for (index, file) in files.iter().enumerate() {
        let text = files
            .iter()
            .enumerate()
            .filter(|(other, _)| *other != index)
            .map(|(_, target)| format!("import '../{target}';\n"))
            .collect::<String>();
        total += text.len() as u64;
        write(dir.path(), file, &text);
    }
    let mut budget = open_budget();
    let error = propose(
        dir.path(),
        "bounded edges",
        &files,
        Inventory::Filesystem,
        &mut budget,
    )
    .unwrap_err();
    assert_eq!(error.code, "diagram_scan_too_many_edges");
    assert!(
        budget.bytes < total,
        "edge refusal must precede the remaining source reads"
    );
}

#[test]
fn out_of_range_limits_are_refused() {
    for (files, depth) in [
        (Some(0), None),
        (Some(MAX_FILES_LIMIT + 1), None),
        (None, Some(0)),
        (None, Some(MAX_DEPTH_LIMIT + 1)),
    ] {
        let error = ScanLimits::new(files, depth).unwrap_err();
        assert_eq!(error.code, "diagram_scan_limit_invalid");
    }
}

#[test]
fn a_large_source_file_is_counted_but_not_parsed() {
    let dir = tempdir();
    let big = format!(
        "import x from '../b/x';\n{}",
        "// pad\n".repeat((MAX_SOURCE_BYTES as usize) / 7 + 1)
    );
    write(dir.path(), "a/big.ts", &big);
    write(dir.path(), "b/x.ts", "");
    let report = scan(dir.path(), ".", limits()).unwrap();
    assert_eq!(report.stats.skipped_large, 1);
    assert!(edges(&report.document).is_empty());
}

/// A version 2 index with the given entries (mode, path), as git writes it.
fn index_v2(entries: &[(u32, &str)]) -> Vec<u8> {
    let mut bytes = b"DIRC".to_vec();
    bytes.extend_from_slice(&2u32.to_be_bytes());
    bytes.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (mode, path) in entries {
        let start = bytes.len();
        bytes.extend_from_slice(&[0u8; 24]);
        bytes.extend_from_slice(&mode.to_be_bytes());
        bytes.extend_from_slice(&[0u8; 12]);
        bytes.extend_from_slice(&[0u8; 20]);
        let flags = (path.len().min(0xfff)) as u16;
        bytes.extend_from_slice(&flags.to_be_bytes());
        bytes.extend_from_slice(path.as_bytes());
        let length = bytes.len() - start + 1;
        let padded = length.div_ceil(8) * 8;
        bytes.resize(start + padded, 0);
    }
    bytes.extend_from_slice(&[0u8; 20]);
    bytes
}

#[test]
fn the_git_index_lists_tracked_regular_files_only() {
    let bytes = index_v2(&[
        (0o100644, "a/one.ts"),
        (0o100755, "bin/run.py"),
        (0o120000, "link"),
        (0o160000, "submodule"),
    ]);
    let later = Instant::now() + Duration::from_secs(60);
    assert_eq!(
        parse_index(&bytes, later).unwrap().unwrap(),
        ["a/one.ts".to_string(), "bin/run.py".to_string()]
    );
    assert!(parse_index(b"DIRC\0\0\0\x09\0\0\0\0", later)
        .unwrap()
        .is_none());
    assert!(parse_index(&index_v2(&[(0o100644, "../escape")]), later)
        .unwrap()
        .is_none());
    assert!(parse_index(&bytes[..bytes.len() / 2], later)
        .unwrap()
        .is_none());
}

#[test]
fn windows_index_paths_are_refused_on_every_platform() {
    let later = Instant::now() + Duration::from_secs(60);
    for path in [
        r"..\outside\leak.ts",
        r"C:\outside\leak.ts",
        "C:/outside/leak.ts",
    ] {
        assert!(
            parse_index(&index_v2(&[(0o100644, path)]), later)
                .unwrap()
                .is_none(),
            "unsafe index path: {path}"
        );
    }
    let dir = tempdir();
    for path in [
        "",
        ".",
        "../escape",
        "src//a.ts",
        "src/a.ts/",
        "src/a\0.ts",
        r"..\outside\leak.ts",
        r"C:\outside\leak.ts",
    ] {
        assert!(!plain_relative_path(path), "{path}");
        assert!(!regular_file_without_links(dir.path(), path), "{path}");
    }
    write(dir.path(), "src/a.ts", "");
    assert!(regular_file_without_links(dir.path(), "src/a.ts"));
}

#[test]
fn overlong_ignore_lines_are_skipped_before_glob_tokenization() {
    let text = format!("{}\n*.log\n", "[".repeat(MAX_SOURCE_BYTES as usize));
    let rules = parse_gitignore("", &text);
    assert_eq!(rules.len(), 1);
    assert!(ignored(&rules, "debug.log", false));
    assert!(!ignored(&rules, "main.ts", false));
    assert_eq!(
        parse_gitignore("", &"a".repeat(MAX_IGNORE_PATTERN_BYTES)).len(),
        1
    );
    assert!(parse_gitignore("", &"a".repeat(MAX_IGNORE_PATTERN_BYTES + 1)).is_empty());
}

#[test]
fn bounded_reads_charge_growth_and_partial_errors_before_skipping() {
    let mut budget = open_budget();
    // Simulate growth after the metadata check, without a timing-dependent race.
    let mut growing = std::io::Cursor::new(vec![b'x'; 100]);
    assert!(matches!(
        read_bounded(&mut growing, 8, &mut budget).unwrap(),
        BoundedRead::TooLarge
    ));
    assert_eq!(growing.position(), 9);
    assert_eq!(budget.bytes, 9);

    struct FailsAfterPrefix(bool);
    impl std::io::Read for FailsAfterPrefix {
        fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
            if self.0 {
                return Err(std::io::Error::other("injected read failure"));
            }
            self.0 = true;
            output[..3].copy_from_slice(b"abc");
            Ok(3)
        }
    }
    assert!(matches!(
        read_bounded(FailsAfterPrefix(false), 100, &mut budget).unwrap(),
        BoundedRead::Unreadable
    ));
    assert_eq!(
        budget.bytes, 12,
        "partial failed reads still consume the shared budget"
    );
}

#[test]
fn bounded_reads_use_the_remaining_shared_budget() {
    let mut budget = open_budget();
    budget.bytes = MAX_TOTAL_BYTES - 3;
    let mut reader = std::io::Cursor::new(vec![b'x'; 100]);
    let error = read_bounded(&mut reader, MAX_SOURCE_BYTES, &mut budget).unwrap_err();
    assert_eq!(error.code, "diagram_scan_too_much_data");
    assert_eq!(
        reader.position(),
        4,
        "only remaining bytes and one sentinel are read"
    );
    assert_eq!(budget.bytes, MAX_TOTAL_BYTES + 1);
}

#[test]
fn index_and_ignore_reads_share_the_remaining_budget() {
    let dir = tempdir();
    write(dir.path(), "src/a.ts", "");
    fs::create_dir_all(dir.path().join(".git")).unwrap();
    fs::write(
        dir.path().join(".git/index"),
        index_v2(&[(0o100644, "src/a.ts")]),
    )
    .unwrap();
    let mut state = Walk {
        limits: limits(),
        budget: open_budget(),
        entries: 0,
        files: Vec::new(),
    };
    state.budget.bytes = MAX_TOTAL_BYTES - 3;
    assert_eq!(
        git_index_files(dir.path(), dir.path(), &mut state)
            .unwrap_err()
            .code,
        "diagram_scan_too_much_data"
    );
    assert_eq!(state.budget.bytes, MAX_TOTAL_BYTES + 1);

    fs::remove_dir_all(dir.path().join(".git")).unwrap();
    write(dir.path(), ".gitignore", "*.log\n");
    state.budget.bytes = MAX_TOTAL_BYTES - 3;
    assert_eq!(
        walk(dir.path(), "", &[], &mut state, 0).unwrap_err().code,
        "diagram_scan_too_much_data"
    );
    assert_eq!(state.budget.bytes, MAX_TOTAL_BYTES + 1);
}

#[test]
fn a_git_index_inside_the_workspace_is_the_inventory() {
    let dir = tempdir();
    let root = dir.path();
    write(root, "src/a.ts", "import './lib/b';\n");
    write(root, "src/lib/b.ts", "");
    write(root, "untracked/c.ts", "");
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(
        root.join(".git/index"),
        index_v2(&[
            (0o100644, "src/a.ts"),
            (0o100644, "src/lib/b.ts"),
            (0o100644, "src/gone.ts"),
        ]),
    )
    .unwrap();
    let report = scan(root, ".", limits()).unwrap();
    assert_eq!(report.stats.inventory, Inventory::GitIndex);
    assert_eq!(
        report.stats.files, 2,
        "untracked and deleted files are left out"
    );
    assert_eq!(ids(&report.document), ["src", "src.lib"]);
    assert_eq!(
        edges(&report.document),
        [("src".to_string(), "src.lib".to_string())]
    );
    let sub = scan(root, "src/lib", limits()).unwrap();
    assert_eq!(sub.stats.inventory, Inventory::GitIndex);
    assert_eq!(sub.stats.files, 1);
}

#[test]
fn a_git_index_above_the_workspace_is_not_read() {
    let outer = tempdir();
    fs::create_dir_all(outer.path().join(".git")).unwrap();
    fs::write(
        outer.path().join(".git/index"),
        index_v2(&[(0o100644, "workspace/x.ts")]),
    )
    .unwrap();
    let root = outer.path().join("workspace");
    write(&root, "src/a.ts", "");
    let report = scan(&root, ".", limits()).unwrap();
    assert_eq!(report.stats.inventory, Inventory::Filesystem);
    assert_eq!(report.stats.files, 1);
}

#[test]
fn gitignore_globs_follow_git() {
    let rules = parse_gitignore(
        "",
        "*.log\n!keep.log\nbuild/\n/top.txt\ndocs/**/draft-*.md\n",
    );
    assert!(ignored(&rules, "x/debug.log", false));
    assert!(!ignored(&rules, "x/keep.log", false));
    assert!(ignored(&rules, "a/build", true));
    assert!(
        !ignored(&rules, "a/build", false),
        "a dir-only rule skips files"
    );
    assert!(ignored(&rules, "top.txt", false));
    assert!(
        !ignored(&rules, "sub/top.txt", false),
        "a leading slash anchors"
    );
    assert!(ignored(&rules, "docs/draft-1.md", false));
    assert!(ignored(&rules, "docs/a/b/draft-2.md", false));
    assert!(!ignored(&rules, "docs/final.md", false));
    let nested = parse_gitignore("pkg", "gen\n");
    assert!(ignored(&nested, "pkg/gen", true));
    assert!(
        !ignored(&nested, "other/gen", true),
        "a nested file only covers its folder"
    );
}

#[test]
fn a_pathological_ignore_pattern_stays_within_its_budget() {
    let pattern: Vec<char> = "*a".repeat(40).chars().collect();
    let text: Vec<char> = "a".repeat(39).chars().collect();
    let started = std::time::Instant::now();
    assert!(!glob_match(&pattern, &text));
    assert!(started.elapsed() < Duration::from_secs(1));

    // Call the matcher directly too: its tokenizer stays linear even without
    // the parser's 4 KiB per-line guard.
    let pattern: Vec<char> = "[".repeat(100_000).chars().collect();
    let started = Instant::now();
    assert!(!glob_match(&pattern, &[]));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn ignore_matching_stops_at_the_scan_deadline() {
    let expired = Budget {
        deadline: Instant::now(),
        bytes: 0,
    };
    let rules = parse_gitignore("", "*.log");
    assert_eq!(
        ignored_with_budget(&rules, "debug.log", false, &expired)
            .unwrap_err()
            .code,
        "diagram_scan_timeout"
    );
    assert_eq!(
        glob_match_with_budget(&['*'], &['a'], &expired)
            .unwrap_err()
            .code,
        "diagram_scan_timeout"
    );
}

#[test]
fn rust_and_python_resolution_cover_their_module_forms() {
    let files: BTreeSet<String> = [
        "c/Cargo.toml",
        "c/src/lib.rs",
        "c/src/a.rs",
        "c/src/a/b.rs",
        "c/src/z/mod.rs",
        "p/__init__.py",
        "p/q/__init__.py",
        "p/q/r.py",
        "p/s.py",
    ]
    .iter()
    .map(|path| path.to_string())
    .collect();
    let mut refs = Refs::default();
    rust_refs(
        "c/src/a.rs",
        "mod b;\nuse super::z::Thing;\npub(crate) use crate::a::b::f;\n",
        &files,
        &mut refs,
        &open_budget(),
    )
    .unwrap();
    assert_eq!(
        refs.files.iter().cloned().collect::<Vec<_>>(),
        ["c/src/a/b.rs", "c/src/z/mod.rs"]
    );
    let mut refs = Refs::default();
    python_refs(
        "p/q/r.py",
        "from .. import s\nfrom ..s import thing\nimport p.q\n",
        &files,
        &mut refs,
        &open_budget(),
    )
    .unwrap();
    assert_eq!(
        refs.files.iter().cloned().collect::<Vec<_>>(),
        ["p/q/__init__.py", "p/s.py"]
    );
}

/// The exact tree the native spec (e2e-native/specs/diagram-scan.spec.ts)
/// scans, so its recorded counts come from the scanner, not by hand.
#[test]
fn the_native_spec_tree_has_its_recorded_counts() {
    let dir = tempdir();
    let root = dir.path();
    write(
        root,
        "web/src/main.ts",
        "import { b } from './ui/button';\nimport { u } from '../../shared/util';\n",
    );
    write(root, "web/src/ui/button.tsx", "export const b = 1;\n");
    write(root, "shared/util.ts", "export const u = 1;\n");
    write(root, "core/Cargo.toml", "[package]\nname = \"core\"\n");
    write(root, "core/src/lib.rs", "mod parse;\n");
    write(root, "core/src/parse.rs", "");
    let report = scan(root, ".", limits()).unwrap();
    assert_eq!(
        ids(&report.document),
        ["core", "core.src", "shared", "web", "web.src"]
    );
    assert_eq!(
        edges(&report.document),
        [("web.src".to_string(), "shared".to_string())]
    );
    assert_eq!(
        (report.stats.nodes, report.stats.edges, report.stats.files),
        (5, 1, 6)
    );
}

#[cfg(unix)]
#[test]
fn a_tracked_path_under_a_folder_now_linked_out_is_never_read() {
    let outer = tempdir();
    let root = outer.path().join("workspace");
    write(&root, "src/a.ts", "import x from '../vendor/x';\n");
    write(
        outer.path(),
        "secret/x.ts",
        "import leak from 'outside-only-package';\n",
    );
    std::os::unix::fs::symlink(outer.path().join("secret"), root.join("vendor")).unwrap();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(
        root.join(".git/index"),
        index_v2(&[(0o100644, "src/a.ts"), (0o100644, "vendor/x.ts")]),
    )
    .unwrap();
    let report = scan(&root, ".", limits()).unwrap();
    assert_eq!(report.stats.inventory, Inventory::GitIndex);
    assert_eq!(
        report.stats.files, 1,
        "the linked folder's file is left out"
    );
    let text = report.document.to_string();
    assert!(!text.contains("outside-only-package"), "{text}");
    assert!(!text.contains("vendor"), "{text}");
    // The read-time check holds on its own, even for a path the inventory kept.
    assert!(!regular_file_without_links(&root, "vendor/x.ts"));
    assert!(regular_file_without_links(&root, "src/a.ts"));
}

/// A version 4 index whose paths grow: each entry strips the last character
/// (`x`) of the previous path and appends `a/x`, so `a/x`, `a/a/x`, ... are
/// all valid paths, each two bytes longer than the last.
fn index_v4_growing(count: usize) -> Vec<u8> {
    let mut bytes = b"DIRC".to_vec();
    bytes.extend_from_slice(&4u32.to_be_bytes());
    bytes.extend_from_slice(&(count as u32).to_be_bytes());
    for index in 0..count {
        bytes.extend_from_slice(&[0u8; 24]);
        bytes.extend_from_slice(&0o100644u32.to_be_bytes());
        bytes.extend_from_slice(&[0u8; 32]);
        bytes.extend_from_slice(&0x0fffu16.to_be_bytes());
        bytes.push(u8::from(index > 0)); // strip the previous trailing `x`
        bytes.extend_from_slice(b"a/x");
        bytes.push(0);
    }
    bytes
}

#[test]
fn v4_prefix_expansion_is_bounded_before_paths_are_kept() {
    // Each entry is ~70 bytes but rebuilds a path two bytes longer than the
    // last: without a budget, a few MiB of index expands to gigabytes. A small
    // growing index still parses, which proves the format is read correctly.
    let small = parse_index(
        &index_v4_growing(3),
        Instant::now() + Duration::from_secs(60),
    )
    .unwrap()
    .unwrap();
    assert_eq!(small, ["a/x", "a/a/x", "a/a/a/x"]);
    let bytes = index_v4_growing(20_000);
    let started = Instant::now();
    let error = parse_index(&bytes, Instant::now() + Duration::from_secs(60)).unwrap_err();
    assert_eq!(error.code, "diagram_scan_index_too_large");
    assert!(!error.next_step.is_empty());
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn a_very_wide_ignored_folder_stops_at_the_entry_budget() {
    let dir = tempdir();
    write(dir.path(), ".gitignore", "gen/\n*.tmp\n");
    // Ignored files still count as read entries; kept ones never exceed the cap.
    for index in 0..300 {
        write(dir.path(), &format!("wide/{index}.tmp"), "");
    }
    write(dir.path(), "wide/keep.ts", "");
    let report = scan(dir.path(), ".", ScanLimits::new(Some(5), None).unwrap()).unwrap();
    assert_eq!(report.stats.files, 2, ".gitignore and keep.ts");
    // The file limit applies while the folder is read, before any sort.
    for index in 0..20 {
        write(dir.path(), &format!("many/{index}.ts"), "");
    }
    let error = scan(dir.path(), ".", ScanLimits::new(Some(10), None).unwrap()).unwrap_err();
    assert_eq!(error.code, "diagram_scan_too_many_files");
}

#[test]
fn a_long_rust_use_path_resolves_in_bounded_time() {
    let files: BTreeSet<String> = ["c/Cargo.toml", "c/src/lib.rs", "c/src/a.rs"]
        .iter()
        .map(|path| path.to_string())
        .collect();
    let line = format!("use crate::{}x;\n", "a::".repeat(50_000));
    let text = line.repeat(20);
    let started = Instant::now();
    let mut refs = Refs::default();
    rust_refs("c/src/lib.rs", &text, &files, &mut refs, &open_budget()).unwrap();
    assert_eq!(
        refs.files.iter().cloned().collect::<Vec<_>>(),
        ["c/src/a.rs"]
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_scan_that_overruns_its_budget_is_refused_not_returned() {
    let dir = tempdir();
    write(dir.path(), "a.ts", "");
    let mut tight = limits();
    tight.time_budget = Duration::from_nanos(1);
    let error = scan(dir.path(), ".", tight).unwrap_err();
    assert_eq!(error.code, "diagram_scan_timeout");
}

#[test]
fn a_long_python_dotted_import_resolves_in_bounded_time() {
    let files: BTreeSet<String> = ["p/__init__.py", "p/a.py", "p/q.py"]
        .iter()
        .map(|path| path.to_string())
        .collect();
    // ~200 KiB on one line, well under the 1 MiB per-file cap.
    let line = format!("import p.{}x\n", "a.".repeat(100_000));
    let started = Instant::now();
    let mut refs = Refs::default();
    python_refs("p/q.py", &line, &files, &mut refs, &open_budget()).unwrap();
    assert_eq!(refs.files.iter().cloned().collect::<Vec<_>>(), ["p/a.py"]);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}

#[cfg(unix)]
#[test]
fn a_leaf_replaced_by_a_link_after_the_inventory_is_not_read() {
    let outer = tempdir();
    let root = outer.path().join("workspace");
    write(&root, "src/a.ts", "");
    write(
        outer.path(),
        "secret.ts",
        "import leak from 'outside-only-package';\n",
    );
    // The no-follow open refuses a leaf link even if the path check raced.
    std::os::unix::fs::symlink(outer.path().join("secret.ts"), root.join("src/b.ts")).unwrap();
    assert!(open_regular_no_follow(&root.join("src/b.ts")).is_none());
    assert!(open_regular_no_follow(&root.join("src/a.ts")).is_some());
}
