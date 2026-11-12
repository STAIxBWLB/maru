//! The JSON edit channel's asset containment (`contain_json_edit_assets`),
//! mirroring `argv_tests.rs` for the legacy channel: the same two op kinds,
//! the same four refusals, and the rewrite to an absolute path a caller can no
//! longer point elsewhere.

use super::*;
use std::path::Path;

fn write_asset(path: &Path) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, b"fixture asset bytes").unwrap();
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn op(kind: &str, path: &str) -> Value {
    serde_json::json!({
        "op": kind,
        "anchor": match kind {
            "seal" => "서명",
            _ => "삽화",
        },
        "path": path,
    })
}

fn contained(kind: &str, path: &str, workspace_root: Option<&str>) -> String {
    contain_json_edit_assets(serde_json::json!([op(kind, path)]), workspace_root).unwrap_err()
}

fn rewritten(kind: &str, path: &str, workspace_root: &str) -> String {
    let ops = contain_json_edit_assets(serde_json::json!([op(kind, path)]), Some(workspace_root))
        .unwrap();
    ops[0]["path"].as_str().unwrap().to_string()
}

#[test]
fn every_asset_op_kind_requires_a_workspace_root() {
    let workspace = tempfile::tempdir().unwrap();
    let asset = workspace.path().join("assets/chart.png");
    write_asset(&asset);

    for kind in ["insert_image", "seal"] {
        let error = contained(kind, &text(&asset), None);
        assert!(error.starts_with("hwped_bad_request:"), "{kind}: {error}");
        assert!(error.contains("workspaceRoot"), "{kind}: {error}");
    }
}

#[test]
fn asset_paths_outside_the_workspace_are_refused_for_every_op_kind() {
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let outside_asset = outside.path().join("outside.png");
    write_asset(&outside_asset);
    let root = text(workspace.path());

    let traversal = format!(
        "../{}/outside.png",
        outside.path().file_name().unwrap().to_string_lossy()
    );
    for kind in ["insert_image", "seal"] {
        let relative = contained(kind, &traversal, Some(&root));
        assert!(relative.contains("workspace"), "{kind}: {relative}");
        assert!(relative.contains("outside"), "{kind}: {relative}");

        let absolute = contained(kind, &text(&outside_asset), Some(&root));
        assert!(absolute.contains("workspace"), "{kind}: {absolute}");
        assert!(absolute.contains("outside"), "{kind}: {absolute}");
    }
}

#[cfg(unix)]
#[test]
fn asset_symlinks_pointing_out_of_the_workspace_are_refused_for_every_op_kind() {
    use std::os::unix::fs::symlink;

    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let inside_file = workspace.path().join("assets/inside.png");
    let outside_file = outside.path().join("outside.png");
    write_asset(&inside_file);
    write_asset(&outside_file);
    symlink(&inside_file, workspace.path().join("inside-link.png")).unwrap();
    symlink(&outside_file, workspace.path().join("outside-link.png")).unwrap();
    let root = text(workspace.path());

    for kind in ["insert_image", "seal"] {
        let error = contained(kind, "outside-link.png", Some(&root));
        assert!(error.contains("workspace"), "{kind}: {error}");
        assert!(error.contains("outside"), "{kind}: {error}");

        // The control: the same shape pointing inside is accepted, so the case
        // above is refused for its target and not for being a symlink.
        assert_eq!(
            rewritten(kind, "inside-link.png", &root),
            text(&std::fs::canonicalize(&inside_file).unwrap())
        );
    }
}

#[test]
fn inside_asset_paths_are_rewritten_to_their_absolute_form() {
    let workspace = tempfile::tempdir().unwrap();
    let relative = workspace.path().join("assets/chart.png");
    let absolute = workspace.path().join("seals/stamp.png");
    write_asset(&relative);
    write_asset(&absolute);
    let root = text(workspace.path());
    let expected_relative = text(&std::fs::canonicalize(&relative).unwrap());
    let expected_absolute = text(&std::fs::canonicalize(&absolute).unwrap());

    assert_eq!(
        rewritten("insert_image", "assets/chart.png", &root),
        expected_relative
    );
    assert_eq!(
        rewritten("seal", "assets/chart.png", &root),
        expected_relative
    );
    assert_eq!(
        rewritten("insert_image", &text(&absolute), &root),
        expected_absolute
    );
    assert_eq!(
        rewritten("seal", &text(&absolute), &root),
        expected_absolute
    );

    // The rest of the op survives the rewrite untouched.
    let ops = contain_json_edit_assets(
        serde_json::json!([{
            "op": "insert_image",
            "anchor": "삽화",
            "path": "assets/chart.png",
            "width_mm": 80,
            "height_mm": 60
        }]),
        Some(&root),
    )
    .unwrap();
    assert_eq!(
        ops,
        serde_json::json!([{
            "op": "insert_image",
            "anchor": "삽화",
            "path": expected_relative,
            "width_mm": 80,
            "height_mm": 60
        }])
    );
}

#[test]
fn missing_and_non_regular_assets_are_refused() {
    let workspace = tempfile::tempdir().unwrap();
    let directory = workspace.path().join("assets/directory.png");
    std::fs::create_dir_all(&directory).unwrap();
    let root = text(workspace.path());

    for kind in ["insert_image", "seal"] {
        let missing = contained(kind, "assets/missing.png", Some(&root));
        assert!(missing.contains("missing.png"), "{kind}: {missing}");
        assert!(missing.contains("hwped_bad_request:"), "{kind}: {missing}");

        let not_a_file = contained(kind, "assets/directory.png", Some(&root));
        assert!(not_a_file.contains("regular file"), "{kind}: {not_a_file}");
    }
}

#[test]
fn a_non_string_asset_path_is_refused_before_the_engine_sees_it() {
    for kind in ["insert_image", "seal"] {
        let error = contain_json_edit_assets(
            serde_json::json!([{"op": kind, "anchor": "삽화", "path": 42}]),
            Some("/tmp"),
        )
        .unwrap_err();
        assert!(error.starts_with("hwped_bad_request:"), "{kind}: {error}");
        assert!(error.contains("path must be a string"), "{kind}: {error}");
        assert!(error.contains(kind), "{kind}: {error}");
    }
}

#[test]
fn only_asset_ops_are_touched_and_the_array_shape_is_preserved() {
    let workspace = tempfile::tempdir().unwrap();
    let asset = workspace.path().join("assets/chart.png");
    write_asset(&asset);
    let root = text(workspace.path());

    // A non-asset op with a `path`-looking key, a non-object member and an op
    // whose own path is missing all pass through unchanged.
    let ops = serde_json::json!([
        {"op": "set_format", "address": {"at": {"section": 0, "paragraph": 0, "run": 0}}, "bold": "on"},
        {"op": "insert_image", "anchor": "삽화"},
        {"future_op": {"path": "assets/chart.png"}},
        false
    ]);
    assert_eq!(
        contain_json_edit_assets(ops.clone(), Some(&root)).unwrap(),
        ops
    );

    // An empty array, and the refusal to fall back when the root is absent from
    // an array that does carry an asset op.
    assert_eq!(
        contain_json_edit_assets(serde_json::json!([]), None).unwrap(),
        serde_json::json!([])
    );
    assert!(contain_json_edit_assets(
        serde_json::json!([op("insert_image", "assets/chart.png")]),
        None
    )
    .unwrap_err()
    .contains("workspaceRoot"));
}

#[test]
fn apply_form_bindings_is_refused_on_the_json_channel() {
    // Even with a workspace root, and a receipt that would resolve inside it,
    // the op is refused: its own write destinations sit outside the bridge's
    // contract, so containment is not the answer here.
    let workspace = tempfile::tempdir().unwrap();
    let root = text(workspace.path());
    let error = contain_json_edit_assets(
        serde_json::json!([{
            "op": "apply_form_bindings",
            "receipt": "bindings/receipt.json",
            "preview": "bindings/preview.hwpx"
        }]),
        Some(&root),
    )
    .unwrap_err();

    assert!(error.starts_with("hwped_bad_request:"), "{error}");
    assert!(error.contains("apply_form_bindings"), "{error}");
    assert!(error.contains("receipt and preview"), "{error}");
    assert!(error.contains("ahwp edit"), "{error}");

    // The refusal belongs to the op, not to the root: with no root at all it
    // still names the op instead of asking for workspaceRoot.
    let without_root =
        contain_json_edit_assets(serde_json::json!([{"op": "apply_form_bindings"}]), None)
            .unwrap_err();
    assert!(
        without_root.contains("apply_form_bindings"),
        "{without_root}"
    );
    assert!(!without_root.contains("workspaceRoot"), "{without_root}");
}

#[test]
fn a_batch_mixing_a_valid_asset_with_apply_form_bindings_is_refused_as_a_whole() {
    let workspace = tempfile::tempdir().unwrap();
    let asset = workspace.path().join("assets/chart.png");
    write_asset(&asset);
    let root = text(workspace.path());

    let refused = contain_json_edit_assets(
        serde_json::json!([
            op("insert_image", "assets/chart.png"),
            {"op": "apply_form_bindings", "receipt": "bindings/receipt.json"},
            op("seal", "assets/chart.png")
        ]),
        Some(&root),
    )
    .unwrap_err();
    assert!(refused.starts_with("hwped_bad_request:"), "{refused}");
    assert!(refused.contains("apply_form_bindings"), "{refused}");

    // The control: the same batch without that one op is accepted, so the
    // refusal is that op's and not an artifact of the batch shape.
    let accepted = contain_json_edit_assets(
        serde_json::json!([
            op("insert_image", "assets/chart.png"),
            op("seal", "assets/chart.png")
        ]),
        Some(&root),
    )
    .unwrap();
    assert_eq!(accepted.as_array().unwrap().len(), 2);
}
