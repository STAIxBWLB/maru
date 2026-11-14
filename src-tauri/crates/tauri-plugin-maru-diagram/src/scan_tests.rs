//! Scanner tests on synthetic trees only (no copied repository content).

use super::*;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

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
    assert_eq!(
        parse_index(&bytes).unwrap(),
        ["a/one.ts".to_string(), "bin/run.py".to_string()]
    );
    assert!(parse_index(b"DIRC\0\0\0\x09\0\0\0\0").is_none());
    assert!(parse_index(&index_v2(&[(0o100644, "../escape")])).is_none());
    assert!(parse_index(&bytes[..bytes.len() / 2]).is_none());
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
    );
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
    );
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
