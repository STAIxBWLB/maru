use super::*;
use std::path::{Path, PathBuf};

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn write_asset(path: &Path) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    // The legacy bridge validates paths but never decodes or executes image data.
    std::fs::write(path, b"fixture asset bytes").unwrap();
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn asset_error(argv: Vec<String>, workspace_root: Option<&str>) -> String {
    prepare_legacy_edit_args(argv, workspace_root).unwrap_err()
}

#[test]
fn legacy_edit_flags_are_closed_to_safe_operations() {
    assert_eq!(LEGACY_EDIT_FLAGS.len(), 28);
    let workspace = tempfile::tempdir().unwrap();
    let image = workspace.path().join("fixture.png");
    write_asset(&image);
    let root = text(workspace.path());

    for flag in LEGACY_EDIT_FLAGS {
        let value = match *flag {
            "--insert-image" | "--seal" => format!("anchor=>{}", image.display()),
            _ => "value".to_string(),
        };
        prepare_legacy_edit_args(vec![(*flag).to_string(), value], Some(&root))
            .unwrap_or_else(|error| panic!("{flag}: {error}"));
    }

    let prepared = prepare_legacy_edit_args(
        args(&[
            "--replace",
            "old=>new",
            "--set-cell",
            "0:1:2=내용",
            "--set-format",
            "word:bold=on",
            "--replace",
            "text=>--allow-partial",
        ]),
        Some(&root),
    )
    .unwrap();
    assert_eq!(prepared[1], "old=>new");
    assert_eq!(prepared[3], "0:1:2=내용");
    assert_eq!(prepared[5], "word:bold=on");
    assert_eq!(prepared[7], "text=>--allow-partial");
}

#[test]
fn legacy_control_and_file_flags_are_rejected_before_any_document_or_cli_access() {
    for flag in [
        "--report",
        "--report=/tmp/report",
        "--ops",
        "--output",
        "-o",
        "--verify",
        "--allow-partial",
        "--password",
        "--help",
        "--",
        "--unknown-operation",
    ] {
        let argv = args(&[flag, "fixture-only-path"]);
        let error = validate_legacy_edit_args(&argv).unwrap_err();
        assert!(
            error.starts_with("hwped_bad_request: opsArgv flag"),
            "{error}"
        );
        assert!(error.contains(flag), "{error}");
        let document = HwpedDocumentRef {
            name: "fixture.hwpx".to_string(),
            path: None,
            data_base64: None,
        };
        let command_error = edit_now(
            document,
            Some(serde_json::json!(argv)),
            None,
            None,
            None,
            None,
        )
        .unwrap_err()
        .to_string();
        assert_eq!(
            command_error, error,
            "rejection must precede CLI discovery and staging"
        );
    }
}

#[test]
fn option_like_legacy_values_only_allow_finite_negative_numbers() {
    for value in [
        "--allow-partial",
        "--verify",
        "--report=/tmp/report",
        "-o",
        "--ops",
        "-",
    ] {
        let error = validate_legacy_edit_args(&args(&["--replace", value])).unwrap_err();
        assert!(
            error.contains("value starts with a CLI option prefix"),
            "{error}"
        );
        assert!(error.contains("finite number"), "{error}");
    }

    for value in ["-42", "-1.25", "  -3.5  "] {
        prepare_legacy_edit_args(args(&["--delete-para", value]), None)
            .unwrap_or_else(|error| panic!("finite negative scalar {value:?} is data: {error}"));
    }
    for value in ["-NaN", "-inf", "-Infinity", "--5", "- "] {
        let error = validate_legacy_edit_args(&args(&["--delete-para", value])).unwrap_err();
        assert!(
            error.contains("value starts with a CLI option prefix"),
            "{error}"
        );
    }

    assert!(validate_legacy_edit_args(&args(&["--replace"]))
        .unwrap_err()
        .contains("--flag value pairs"));
}

#[test]
fn asset_flags_rewrite_relative_and_absolute_files_without_losing_anchors_or_sizes() {
    let workspace = tempfile::tempdir().unwrap();
    let relative_asset = workspace.path().join("assets with spaces/photo@18.png");
    let absolute_asset = workspace.path().join("seals/stamp@25.png");
    write_asset(&relative_asset);
    write_asset(&absolute_asset);
    let root = text(workspace.path());
    let relative = PathBuf::from("assets with spaces/photo@18.png");
    let argv = vec![
        "--insert-image".to_string(),
        format!("차트=>{}@90x45", relative.display()),
        "--seal".to_string(),
        format!("서명=>{}@18mm", absolute_asset.display()),
        "--insert-image".to_string(),
        "삽화=>assets with spaces/photo@18.png".to_string(),
    ];

    let prepared = prepare_legacy_edit_args(argv, Some(&root)).unwrap();
    let expected_relative = std::fs::canonicalize(&relative_asset).unwrap();
    let expected_absolute = std::fs::canonicalize(&absolute_asset).unwrap();
    assert_eq!(
        prepared[1],
        format!("차트=>{}@90x45", expected_relative.display())
    );
    assert_eq!(
        prepared[3],
        format!("서명=>{}@18mm", expected_absolute.display())
    );
    assert_eq!(
        prepared[5],
        format!("삽화=>{}", expected_relative.display())
    );
}

#[test]
fn asset_flags_require_existing_regular_files_and_a_workspace_root() {
    let workspace = tempfile::tempdir().unwrap();
    let missing = "anchor=>assets/missing.png";
    let error = asset_error(args(&["--insert-image", missing]), None);
    assert!(error.starts_with("hwped_bad_request:"), "{error}");
    assert!(error.contains("workspaceRoot"), "{error}");

    let root = text(workspace.path());
    let error = asset_error(args(&["--insert-image", missing]), Some(&root));
    assert!(error.contains("file"), "{error}");
    assert!(error.contains("missing.png"), "{error}");

    let directory = workspace.path().join("assets/directory.png");
    std::fs::create_dir_all(&directory).unwrap();
    let error = asset_error(
        args(&["--seal", "seal=>assets/directory.png@18mm"]),
        Some(&root),
    );
    assert!(error.contains("regular file"), "{error}");
}

#[test]
fn asset_paths_must_remain_inside_the_canonical_workspace() {
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let outside_asset = outside.path().join("outside.png");
    write_asset(&outside_asset);
    let root = text(workspace.path());

    let outside_relative = format!(
        "../{}/outside.png",
        outside.path().file_name().unwrap().to_string_lossy()
    );
    let traversal_value = format!("anchor=>{outside_relative}");
    let traversal = asset_error(args(&["--insert-image", &traversal_value]), Some(&root));
    assert!(traversal.contains("workspace"), "{traversal}");
    assert!(traversal.contains("outside"), "{traversal}");

    let absolute = asset_error(
        vec![
            "--seal".to_string(),
            format!("anchor=>{}@18mm", outside_asset.display()),
        ],
        Some(&root),
    );
    assert!(absolute.contains("workspace"), "{absolute}");
    assert!(absolute.contains("outside"), "{absolute}");
}

#[cfg(unix)]
#[test]
fn asset_paths_reject_symlink_escape_but_allow_symlinks_inside_the_workspace() {
    use std::os::unix::fs::symlink;

    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let inside_file = workspace.path().join("assets/inside.png");
    let outside_file = outside.path().join("outside.png");
    write_asset(&inside_file);
    write_asset(&outside_file);
    let inside_alias = workspace.path().join("inside-link.png");
    let outside_alias = workspace.path().join("outside-link.png");
    symlink(&inside_file, &inside_alias).unwrap();
    symlink(&outside_file, &outside_alias).unwrap();
    let root = text(workspace.path());

    let accepted = prepare_legacy_edit_args(
        args(&["--insert-image", "anchor=>inside-link.png@80x60"]),
        Some(&root),
    )
    .unwrap();
    assert_eq!(
        accepted[1],
        format!(
            "anchor=>{}@80x60",
            std::fs::canonicalize(&inside_file).unwrap().display()
        )
    );

    let error = asset_error(
        args(&["--insert-image", "anchor=>outside-link.png@80x60"]),
        Some(&root),
    );
    assert!(error.contains("workspace"), "{error}");
    assert!(error.contains("outside"), "{error}");
}

#[cfg(unix)]
#[test]
fn size_like_canonical_filenames_need_explicit_size_suffixes() {
    use std::os::unix::fs::symlink;

    let workspace = tempfile::tempdir().unwrap();
    let image = workspace.path().join("assets/chart@12x20");
    let seal = workspace.path().join("assets/stamp@18mm");
    write_asset(&image);
    write_asset(&seal);
    let image_alias = workspace.path().join("aliases/chart");
    let seal_alias = workspace.path().join("aliases/stamp");
    std::fs::create_dir_all(image_alias.parent().unwrap()).unwrap();
    symlink(&image, &image_alias).unwrap();
    symlink(&seal, &seal_alias).unwrap();
    let root = text(workspace.path());

    let ambiguous_image = asset_error(
        args(&["--insert-image", "chart=>aliases/chart"]),
        Some(&root),
    );
    assert!(
        ambiguous_image.contains("size-like @suffix"),
        "{ambiguous_image}"
    );
    let ambiguous_seal = asset_error(args(&["--seal", "stamp=>aliases/stamp"]), Some(&root));
    assert!(
        ambiguous_seal.contains("size-like @suffix"),
        "{ambiguous_seal}"
    );

    let prepared = prepare_legacy_edit_args(
        args(&[
            "--insert-image",
            "chart=>aliases/chart@90X45",
            "--seal",
            "stamp=>aliases/stamp@14",
        ]),
        Some(&root),
    )
    .unwrap();
    assert_eq!(
        prepared[1],
        format!(
            "chart=>{}@90X45",
            std::fs::canonicalize(&image).unwrap().display()
        )
    );
    assert_eq!(
        prepared[3],
        format!(
            "stamp=>{}@14",
            std::fs::canonicalize(&seal).unwrap().display()
        )
    );
}
