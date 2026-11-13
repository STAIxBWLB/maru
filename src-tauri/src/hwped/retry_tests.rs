use super::*;
use std::path::{Path, PathBuf};

fn write_render_fixture(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let bin_dir = dir.join("bin");
    let render_dir = dir.join("render");
    let input = dir.join("source.hwpx");
    std::fs::create_dir_all(&bin_dir).unwrap();
    std::fs::create_dir_all(&render_dir).unwrap();
    std::fs::write(&input, b"fixture document").unwrap();
    std::fs::write(bin_dir.join("selected-version"), b"hwp 0.20.0\n").unwrap();
    let script = r#"#!/bin/sh
printf '%s\n' "$*" >> "$(dirname "$0")/invocations"
case "$1" in
  --version)
    cat "$(dirname "$0")/selected-version" ;;
  render)
    out=""; report=""; layout=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; out="$1"; fi
      if [ "$1" = "--report" ]; then shift; report="$1"; fi
      if [ "$1" = "--layout-json" ]; then shift; layout="$1"; fi
      shift
    done
    [ -n "$out" ] && [ -n "$report" ] || exit 2
    dir=$(dirname "$out")
    printf '<svg width="100pt" height="50pt"></svg>' > "$out"
    printf '{"selected_pages":[1]}' > "$report"
    if [ -n "$layout" ]; then
      printf '<svg width="1pt" height="1pt"></svg>' > "$dir/page-99.svg"
      echo 'unknown option --layout-json' >&2
      exit 2
    fi ;;
  edit)
    for argument in "$@"; do
      if [ "$argument" = "--ops" ]; then
        echo 'unknown option --ops' >&2
        exit 2
      fi
    done
    echo 'legacy edit succeeded' ;;
  *) exit 2 ;;
esac
"#;
    let binary = bin_dir.join("hwp");
    crate::test_support::write_executable_fixture(&binary, script, 0o755).unwrap();
    (binary, render_dir, input)
}

fn render(
    binary: &Path,
    dir: &Path,
    input: &Path,
    mode: LayoutMetadataMode,
) -> Result<(Vec<HwpedRenderPage>, Vec<HwpedRenderNote>), String> {
    render_with_layout_fallback(binary, dir, input, "svg", "all", 96, mode)
}

fn render_invocations(binary: &Path) -> Vec<String> {
    std::fs::read_to_string(binary.parent().unwrap().join("invocations"))
        .unwrap()
        .lines()
        .filter(|line| line.starts_with("render "))
        .map(str::to_string)
        .collect()
}

#[cfg(unix)]
#[test]
fn optional_layout_failure_retries_without_layout_and_discards_stale_pages() {
    let temp = tempfile::tempdir().unwrap();
    let (binary, render_dir, input) = write_render_fixture(temp.path());
    let (pages, notes) =
        render(&binary, &render_dir, &input, LayoutMetadataMode::Optional).unwrap();

    assert_eq!(
        pages.len(),
        1,
        "failed layout attempt's page-99.svg must not leak into retry output"
    );
    assert_eq!(pages[0].page, 1);
    assert!(pages[0].layout.is_none());
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].code, "layout_metadata_unavailable");
    let invocations = render_invocations(&binary);
    assert_eq!(invocations.len(), 2);
    assert!(invocations[0].contains("--layout-json"));
    assert!(!invocations[1].contains("--layout-json"));
}

#[cfg(unix)]
#[test]
fn required_layout_failure_does_not_retry_without_the_requested_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let (binary, render_dir, input) = write_render_fixture(temp.path());
    let error = render(&binary, &render_dir, &input, LayoutMetadataMode::Required).unwrap_err();

    assert!(error.contains("render"), "{error}");
    assert!(error.contains("layout-json"), "{error}");
    let invocations = render_invocations(&binary);
    assert_eq!(invocations.len(), 1);
    assert!(invocations[0].contains("--layout-json"));
}

#[cfg(unix)]
#[test]
fn disabled_layout_renders_once_without_a_note() {
    let temp = tempfile::tempdir().unwrap();
    let (binary, render_dir, input) = write_render_fixture(temp.path());
    let (pages, notes) =
        render(&binary, &render_dir, &input, LayoutMetadataMode::Disabled).unwrap();

    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].page, 1);
    assert!(pages[0].layout.is_none());
    assert!(notes.is_empty());
    let invocations = render_invocations(&binary);
    assert_eq!(invocations.len(), 1);
    assert!(!invocations[0].contains("--layout-json"));
}

#[cfg(unix)]
#[test]
fn optional_layout_retry_invalidates_cached_version_without_touching_the_shim() {
    let temp = tempfile::tempdir().unwrap();
    let (binary, render_dir, input) = write_render_fixture(temp.path());
    assert_eq!(ensure_version(&binary).unwrap(), "0.20.0");
    let binary_mtime = std::fs::metadata(&binary).unwrap().modified().unwrap();

    let (pages, notes) =
        render(&binary, &render_dir, &input, LayoutMetadataMode::Optional).unwrap();
    assert_eq!(pages.len(), 1);
    assert_eq!(notes.len(), 1);

    std::fs::write(
        binary.parent().unwrap().join("selected-version"),
        b"hwp 0.19.99\n",
    )
    .unwrap();
    assert_eq!(
        std::fs::metadata(&binary).unwrap().modified().unwrap(),
        binary_mtime,
        "the version selection changed through its sidecar; the executable mtime must stay fixed"
    );
    assert_eq!(
        ensure_version(&binary).unwrap(),
        "0.19.99",
        "the optional feature failure must invalidate the cached 0.20.0 probe"
    );
    let probes = std::fs::read_to_string(binary.parent().unwrap().join("invocations")).unwrap();
    assert_eq!(
        probes.lines().filter(|line| *line == "--version").count(),
        2
    );
}

#[cfg(unix)]
#[test]
fn failed_json_edit_feature_command_invalidates_cached_version_without_touching_the_shim() {
    let temp = tempfile::tempdir().unwrap();
    let (binary, _, _) = write_render_fixture(temp.path());
    assert_eq!(ensure_version(&binary).unwrap(), "0.20.0");
    let binary_mtime = std::fs::metadata(&binary).unwrap().modified().unwrap();

    let error = run_hwp_feature_ok(
        &binary,
        &[
            OsString::from("edit"),
            OsString::from("source.hwpx"),
            OsString::from("--ops"),
            OsString::from("ops.json"),
        ],
        None,
    )
    .unwrap_err();
    assert!(error.contains("hwp_failed"), "{error}");

    std::fs::write(
        binary.parent().unwrap().join("selected-version"),
        b"hwp 0.19.99\n",
    )
    .unwrap();
    assert_eq!(
        std::fs::metadata(&binary).unwrap().modified().unwrap(),
        binary_mtime,
        "the version selection changed through its sidecar; the executable mtime must stay fixed"
    );
    assert_eq!(ensure_version(&binary).unwrap(), "0.19.99");
    let probes = std::fs::read_to_string(binary.parent().unwrap().join("invocations")).unwrap();
    assert_eq!(
        probes.lines().filter(|line| *line == "--version").count(),
        2
    );
}
