use super::*;
use crate::atomic_file::{
    phase08_06::{run, Home},
    PathTransactionTestHook,
};

pub(in crate::hwped) struct Fixture {
    pub home: Home,
    pub root: PathBuf,
    pub bin: PathBuf,
    previous: Option<std::ffi::OsString>,
    _env_guard: std::sync::MutexGuard<'static, ()>,
}
impl Fixture {
    pub(in crate::hwped) fn new() -> Self {
        let home = Home::new();
        let env_guard = super::super::PHASE08_21_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let root = home.root.path().join("workspace");
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/test.hwpx"), b"original").unwrap();
        let bin = home.root.path().join("hwp");
        let previous = std::env::var_os("MARU_HWP_BIN");
        std::env::set_var("MARU_HWP_BIN", &bin);
        let fixture = Self {
            home,
            root,
            bin,
            previous,
            _env_guard: env_guard,
        };
        fixture.engine("hwpx", "true", false);
        fixture
    }
    pub(in crate::hwped) fn engine(&self, format: &str, valid: &str, bad_read: bool) {
        let script = format!(
            r##"#!/bin/sh
case "$1" in
--version) echo 'ahwp 1.6.2' ;;
validate) printf '%s' '{{"valid":{valid},"format":"{format}","errors":[]}}' ;;
cat) if [ '{bad_read}' = 'true' ]; then echo 'not json'; else printf '{{"markdown":"'; cat "$2"; printf '","segments":[]}}'; fi ;;
info) echo '{{"body":{{"tables":0}}}}' ;;
*) exit 2 ;;
esac
"##
        );
        crate::test_support::write_executable_fixture(&self.bin, &script, 0o755).unwrap();
    }
    pub(in crate::hwped) fn root_text(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }
    pub(in crate::hwped) fn save(
        &self,
        bytes: &[u8],
        expected: &str,
    ) -> Result<HwpedSaveResponse, IpcError> {
        run(hwped_save(
            self.root_text(),
            "docs/test.hwpx".into(),
            BASE64.encode(bytes),
            expected.into(),
        ))
    }
    fn original(&self) {
        assert_eq!(
            fs::read(self.root.join("docs/test.hwpx")).unwrap(),
            b"original"
        );
    }
    fn no_snapshot(&self) {
        assert!(!self.root.join(".maru/versions").exists());
    }
    fn registry(&self, rows: Value) {
        let path = crate::vault_list::workspace_registry_path().unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::json!({"workspaces": rows}).to_string()).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        *HWP_TEST_TIMEOUT.lock().unwrap() = None;
        TEST_FAILURES
            .lock()
            .unwrap()
            .retain(|(root, _)| root != &self.root);
        match &self.previous {
            Some(value) => std::env::set_var("MARU_HWP_BIN", value),
            None => std::env::remove_var("MARU_HWP_BIN"),
        }
    }
}

#[test]
fn hwped_save_timeout_missing_engine_and_output_cap_refuse_before_snapshot() {
    let fixture = Fixture::new();
    let missing = save_with_engine(
        fixture.root_text(),
        "docs/test.hwpx".into(),
        BASE64.encode(b"edited"),
        digest(b"original"),
        || Err("cli_missing: HWP engine unavailable".into()),
    )
    .unwrap_err();
    assert!(missing.message.contains("unavailable"));
    fixture.original();
    fixture.no_snapshot();
    fixture.engine("hwpx", "true", false);
    // Probe first, then bound only the fixture engine's validation call.
    ensure_version(&fixture.bin).unwrap();
    crate::test_support::write_executable_fixture(
        &fixture.bin,
        "#!/bin/sh\ncase \"$1\" in --version) echo 'ahwp 1.6.2';; validate) sleep 2;; esac\n",
        0o755,
    )
    .unwrap();
    *HWP_TEST_TIMEOUT.lock().unwrap() = Some((fixture.bin.clone(), Duration::from_millis(200)));
    assert!(fixture
        .save(b"edited", &digest(b"original"))
        .unwrap_err()
        .message
        .contains("timed out"));
    *HWP_TEST_TIMEOUT.lock().unwrap() = None;
    fixture.original();
    fixture.no_snapshot();
    let mut report = b"{\"valid\":true,\"format\":\"hwpx\",\"errors\":[]}".to_vec();
    report.resize(STDOUT_LIMIT + 1024, b' ');
    fs::write(fixture.home.root.path().join("large-report"), report).unwrap();
    crate::test_support::write_executable_fixture(&fixture.bin,
        "#!/bin/sh\ncase \"$1\" in --version) echo 'ahwp 1.6.2';; validate) cat \"$(dirname \"$0\")/large-report\";; esac\n",0o755).unwrap();
    assert!(fixture
        .save(b"edited", &digest(b"original"))
        .unwrap_err()
        .message
        .contains("engine validation"));
    fixture.original();
    fixture.no_snapshot();
}

#[test]
fn hwped_save_snapshot_keeps_arbitrary_binary_original_bytes() {
    let fixture = Fixture::new();
    let bytes = vec![0, 255, 0, 1, 2, 3, 13, 10];
    fs::write(fixture.root.join("docs/test.hwpx"), &bytes).unwrap();
    let saved = fixture.save(b"edited", &digest(&bytes)).unwrap();
    assert_eq!(
        fs::read(fixture.root.join(saved.snapshot_path)).unwrap(),
        bytes
    );
}

#[cfg(unix)]
#[test]
fn hwped_save_rerouted_alias_and_truncated_source_keep_structured_conflicts() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("docs/external.hwpx"), b"external").unwrap();
    let alias = fixture.root.join("alias.hwpx");
    std::os::unix::fs::symlink(fixture.root.join("docs/test.hwpx"), &alias).unwrap();
    let held = crate::atomic_file::phase08_06::Held::new(alias.clone(), "before-admission");
    let root = fixture.root_text();
    let worker = std::thread::spawn(move || {
        run(hwped_save(
            root,
            "alias.hwpx".into(),
            BASE64.encode(b"edited"),
            digest(b"original"),
        ))
    });
    held.wait();
    fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(fixture.root.join("docs/external.hwpx"), &alias).unwrap();
    held.release();
    assert_eq!(worker.join().unwrap().unwrap_err().code, DOCUMENT_CONFLICT);
    fixture.original();
    fixture.no_snapshot();
    let path = fixture.root.join("docs/test.hwpx");
    let _hook =
        PathTransactionTestHook::new(fixture.root.clone(), "hwped:snapshot-complete", move || {
            fs::write(&path, []).unwrap();
        });
    assert_eq!(
        fixture
            .save(b"edited", &digest(b"original"))
            .unwrap_err()
            .code,
        DOCUMENT_CONFLICT
    );
    assert_eq!(fs::read(fixture.root.join("docs/test.hwpx")).unwrap(), b"");
}

#[test]
fn hwped_save_rejects_unconditional_revisions_and_bounds_before_engine() {
    let fixture = Fixture::new();
    fs::remove_file(&fixture.bin).unwrap();
    for expected in [
        "".to_string(),
        "A".repeat(64),
        "0".repeat(63),
        "z".repeat(64),
    ] {
        assert!(fixture
            .save(b"edited", &expected)
            .unwrap_err()
            .message
            .contains("expectedRevision"));
    }
    for input in [
        "".into(),
        "???=".into(),
        "é".into(),
        "A".repeat(MAX_BASE64 + 1),
    ] {
        assert!(save_now(
            fixture.root_text(),
            "docs/test.hwpx".into(),
            input,
            digest(b"original")
        )
        .is_err());
    }
    assert!(decode_candidate(&BASE64.encode(vec![1; MAX_BYTES])).is_ok());
    assert!(decode_candidate(&BASE64.encode(vec![1; MAX_BYTES + 1])).is_err());
    fixture.original();
    fixture.no_snapshot();
}

#[test]
fn hwped_save_refuses_escape_extension_nested_owner_and_registry_alias_policies() {
    let fixture = Fixture::new();
    for selected in [
        "../escape.hwpx".into(),
        fixture
            .home
            .root
            .path()
            .join("escape.hwpx")
            .to_string_lossy()
            .into_owned(),
        "docs/test.hwp".into(),
    ] {
        assert!(save_now(
            fixture.root_text(),
            selected,
            BASE64.encode(b"edited"),
            digest(b"original")
        )
        .is_err());
    }
    fixture.registry(serde_json::json!([
        {"label":"root","path":fixture.root_text(),"visibility":"private","writePolicy":"direct"},
        {"label":"nested","path":fixture.root.join("docs"),"visibility":"private","writePolicy":"direct"}
    ]));
    assert!(fixture
        .save(b"edited", &digest(b"original"))
        .unwrap_err()
        .message
        .contains("belongs"));
    for policy in ["readOnly", "delegated"] {
        fixture.registry(serde_json::json!([
            {"label":"root","path":fixture.root_text(),"visibility":"private","writePolicy":"direct"},
            {"label":"alias","path":format!("{}/.", fixture.root_text()),"visibility":"private","writePolicy":policy}
        ]));
        assert!(fixture
            .save(b"edited", &digest(b"original"))
            .unwrap_err()
            .message
            .contains("blocked"));
    }
    fixture.original();
    fixture.no_snapshot();
}

#[test]
fn hwped_save_refuses_invalid_or_renamed_hwp_and_reread_failure_before_snapshot() {
    let fixture = Fixture::new();
    for (format, valid, read) in [
        ("hwp5", "true", false),
        ("unknown", "false", false),
        ("hwpx", "false", false),
        ("hwpx", "true", true),
    ] {
        fixture.engine(format, valid, read);
        assert!(fixture.save(b"edited", &digest(b"original")).is_err());
        fixture.original();
        fixture.no_snapshot();
    }
    crate::test_support::write_executable_fixture(
        &fixture.bin,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'ahwp 1.6.2'; else echo 'malformed'; fi\n",
        0o755,
    )
    .unwrap();
    assert!(fixture.save(b"edited", &digest(b"original")).is_err());
    fixture.original();
    fixture.no_snapshot();
}

#[test]
fn hwped_capture_envelope_and_revision_use_the_same_immutable_copy() {
    let fixture = Fixture::new();
    let path = fixture.root.join("docs/test.hwpx");
    let _hook =
        PathTransactionTestHook::new(fixture.root.clone(), "hwped:capture-staged", move || {
            fs::write(&path, b"external").unwrap();
        });
    let result = run(hwped_read(
        HwpedDocumentRef {
            name: "test.hwpx".into(),
            path: Some("docs/test.hwpx".into()),
            data_base64: None,
        },
        Some(fixture.root_text()),
        Some(true),
    ))
    .unwrap();
    assert_eq!(result["markdown"], "original");
    assert_eq!(result["source"]["revision"], digest(b"original"));
    assert_eq!(
        BASE64
            .decode(result["source"]["dataBase64"].as_str().unwrap())
            .unwrap(),
        b"original"
    );
    assert_eq!(
        fs::read(fixture.root.join("docs/test.hwpx")).unwrap(),
        b"external"
    );
}

#[test]
fn hwped_capture_legacy_registry_is_read_only_without_migration() {
    let fixture = Fixture::new();
    let legacy = crate::vault_list::legacy_vault_list_path().unwrap();
    let output = crate::vault_list::workspace_registry_path().unwrap();
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    let content =
        serde_json::json!({"vaults":[{"label":"fixture","path":fixture.root_text()}]}).to_string();
    fs::write(&legacy, &content).unwrap();
    assert!(!output.exists());
    let result = capture_now(
        HwpedDocumentRef {
            name: "test.hwpx".into(),
            path: Some("docs/test.hwpx".into()),
            data_base64: None,
        },
        Some(fixture.root_text()),
    )
    .unwrap();
    assert_eq!(result["markdown"], "original");
    assert!(!output.exists(), "capture must not migrate metadata");
    assert_eq!(fs::read_to_string(legacy).unwrap(), content);
    fixture.original();
    fixture.no_snapshot();
}

#[test]
fn hwped_save_holds_existing_registry_lease_and_observes_new_policy() {
    let fixture = Fixture::new();
    fixture.registry(serde_json::json!([{"label":"fixture","path":fixture.root_text(),"visibility":"private","provider":"local","writePolicy":"direct"}]));
    let registry = crate::vault_list::workspace_registry_path().unwrap();
    let registry_writer = PathTransactionRequest::new([registry])
        .unwrap()
        .acquire()
        .unwrap();
    let held = crate::atomic_file::phase08_06::Held::new(
        fixture.root.join("docs/test.hwpx"),
        "before-admission",
    );
    let root = fixture.root_text();
    let (done, result) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let outcome = run(hwped_save(
            root,
            "docs/test.hwpx".into(),
            BASE64.encode(b"edited"),
            digest(b"original"),
        ));
        done.send(outcome).unwrap();
    });
    held.wait();
    held.release();
    assert!(
        result.recv_timeout(Duration::from_millis(40)).is_err(),
        "save must wait for an existing registry writer"
    );
    fixture.registry(serde_json::json!([{"label":"fixture","path":fixture.root_text(),"visibility":"private","provider":"local","writePolicy":"readOnly"}]));
    drop(registry_writer);
    assert!(result
        .recv_timeout(Duration::from_secs(15))
        .unwrap()
        .unwrap_err()
        .message
        .contains("blocked"));
    worker.join().unwrap();
    fixture.original();
    fixture.no_snapshot();
}

#[test]
fn hwped_save_every_injected_precommit_failure_keeps_original_and_completed_snapshots() {
    let fixture = Fixture::new();
    for label in [
        "source-read",
        "candidate-stage",
        "snapshot-directory",
        "snapshot-create",
        "snapshot-write",
        "snapshot-sync",
        "snapshot-publish",
        "replacement-stage",
        "before-replace",
    ] {
        let versions = fixture.root.join(".maru/versions");
        if versions.exists() {
            fs::remove_dir_all(&versions).unwrap();
        }
        TEST_FAILURES
            .lock()
            .unwrap()
            .push((fixture.root.clone(), label.into()));
        let error = fixture.save(b"edited", &digest(b"original")).unwrap_err();
        assert!(error.message.contains(label), "{label}: {error}");
        TEST_FAILURES.lock().unwrap().clear();
        fixture.original();
        if versions.exists() {
            for file in fs::read_dir(&versions).unwrap() {
                assert_eq!(fs::read(file.unwrap().path()).unwrap(), b"original");
            }
        }
    }
}

#[test]
fn hwped_save_atomic_create_write_sync_permissions_and_rename_failures_preserve_source() {
    let fixture = Fixture::new();
    let source = fixture.root.join("docs/test.hwpx");
    for stage in ["create", "write", "sync", "permissions", "rename"] {
        let _fault = crate::atomic_file::AtomicWriteTestFailure::new(source.clone(), stage);
        let error = fixture.save(b"edited", &digest(b"original")).unwrap_err();
        assert!(error.message.contains(stage), "{error}");
        fixture.original();
        for entry in fs::read_dir(fixture.root.join(".maru/versions")).unwrap() {
            assert_eq!(fs::read(entry.unwrap().path()).unwrap(), b"original");
        }
        assert!(fs::read_dir(source.parent().unwrap())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("maru-tmp")));
    }
}

#[test]
fn hwped_save_changes_and_deletions_during_validation_and_snapshot_conflict() {
    let fixture = Fixture::new();
    for label in ["validated", "snapshot-complete", "before-replace"] {
        for delete in [false, true] {
            fs::write(fixture.root.join("docs/test.hwpx"), b"original").unwrap();
            let path = fixture.root.join("docs/test.hwpx");
            let _hook = PathTransactionTestHook::new(
                fixture.root.clone(),
                &format!("hwped:{label}"),
                move || {
                    if delete {
                        fs::remove_file(&path).unwrap();
                    } else {
                        fs::write(&path, b"external").unwrap();
                    }
                },
            );
            assert_eq!(
                fixture
                    .save(b"edited", &digest(b"original"))
                    .unwrap_err()
                    .code,
                DOCUMENT_CONFLICT
            );
            if delete {
                assert!(!fixture.root.join("docs/test.hwpx").exists());
            } else {
                assert_eq!(
                    fs::read(fixture.root.join("docs/test.hwpx")).unwrap(),
                    b"external"
                );
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn hwped_save_file_and_ancestor_symlinks_keep_links_and_permissions() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let fixture = Fixture::new();
    let physical = fixture.home.root.path().join("physical");
    fs::create_dir(&physical).unwrap();
    let source = physical.join("target.hwpx");
    fs::write(&source, b"original").unwrap();
    fs::set_permissions(&source, fs::Permissions::from_mode(0o640)).unwrap();
    symlink(&source, fixture.root.join("alias.hwpx")).unwrap();
    symlink(&physical, fixture.root.join("directory")).unwrap();
    for selected in ["alias.hwpx", "directory/target.hwpx"] {
        fs::write(&source, b"original").unwrap();
        let saved = save_now(
            fixture.root_text(),
            selected.into(),
            BASE64.encode(b"edited"),
            digest(b"original"),
        )
        .unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"edited");
        assert_eq!(
            fs::read(fixture.root.join(saved.snapshot_path)).unwrap(),
            b"original"
        );
        assert_eq!(
            fs::metadata(&source).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert!(fs::symlink_metadata(fixture.root.join("alias.hwpx"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(fixture.root.join("directory"))
            .unwrap()
            .file_type()
            .is_symlink());
    }
}

#[cfg(unix)]
#[test]
fn hwped_save_deleted_selected_alias_conflicts_during_snapshot_and_admission() {
    use std::os::unix::fs::symlink;
    for ancestor in [false, true] {
        for waiting in [false, true] {
            let fixture = Fixture::new();
            let alias = fixture.root.join(if ancestor {
                "linked-dir"
            } else {
                "linked.hwpx"
            });
            let selected = if ancestor {
                "linked-dir/test.hwpx"
            } else {
                "linked.hwpx"
            };
            symlink(
                fixture
                    .root
                    .join(if ancestor { "docs" } else { "docs/test.hwpx" }),
                &alias,
            )
            .unwrap();
            if waiting {
                let held = crate::atomic_file::phase08_06::Held::new(
                    fixture.root.join(selected),
                    "before-admission",
                );
                let root = fixture.root_text();
                let task = std::thread::spawn(move || {
                    run(hwped_save(
                        root,
                        selected.into(),
                        BASE64.encode(b"edited"),
                        digest(b"original"),
                    ))
                });
                held.wait();
                fs::remove_file(&alias).unwrap();
                held.release();
                assert_eq!(task.join().unwrap().unwrap_err().code, DOCUMENT_CONFLICT);
                fixture.no_snapshot();
            } else {
                let _hook = PathTransactionTestHook::new(
                    fixture.root.clone(),
                    "hwped:snapshot-complete",
                    move || {
                        fs::remove_file(&alias).unwrap();
                    },
                );
                assert_eq!(
                    save_now(
                        fixture.root_text(),
                        selected.into(),
                        BASE64.encode(b"edited"),
                        digest(b"original")
                    )
                    .unwrap_err()
                    .code,
                    DOCUMENT_CONFLICT
                );
            }
            fixture.original();
        }
    }
}

#[test]
fn hwped_source_exact_limit_is_bounded_and_capture_refuses_a_growing_oversize_source() {
    let fixture = Fixture::new();
    let path = fixture.root.join("docs/test.hwpx");
    let file = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&path)
        .unwrap();
    file.set_len(MAX_BYTES as u64).unwrap();
    assert_eq!(bounded_source(&path).unwrap().len(), MAX_BYTES);
    file.set_len(MAX_BYTES as u64 + 1).unwrap();
    assert!(bounded_source(&path)
        .unwrap_err()
        .message
        .contains("32 MiB"));
    let error = capture_now(
        HwpedDocumentRef {
            name: "test.hwpx".into(),
            path: Some("docs/test.hwpx".into()),
            data_base64: None,
        },
        Some(fixture.root_text()),
    )
    .unwrap_err();
    assert!(error.contains("32 MiB"));
    fixture.no_snapshot();
}

#[test]
fn hwped_save_parent_replacement_after_snapshot_refuses_without_new_target_write() {
    let fixture = Fixture::new();
    let root = fixture.root.clone();
    let _hook = PathTransactionTestHook::new(root.clone(), "hwped:snapshot-complete", move || {
        fs::rename(root.join("docs"), root.join("old-docs")).unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("docs/test.hwpx"), b"replacement").unwrap();
    });
    assert!(fixture.save(b"edited", &digest(b"original")).is_err());
    assert_eq!(
        fs::read(fixture.root.join("old-docs/test.hwpx")).unwrap(),
        b"original"
    );
    assert_eq!(
        fs::read(fixture.root.join("docs/test.hwpx")).unwrap(),
        b"replacement"
    );
}

#[test]
fn hwped_save_new_snapshot_parent_replacement_or_snapshot_loss_refuses_commit() {
    for sabotage in ["directory", "delete", "modify"] {
        let fixture = Fixture::new();
        let versions = fixture.root.join(".maru/versions");
        let _hook = PathTransactionTestHook::new(
            fixture.root.clone(),
            "hwped:snapshot-complete",
            move || {
                if sabotage == "directory" {
                    fs::rename(&versions, versions.with_file_name("retained-versions")).unwrap();
                    fs::create_dir(&versions).unwrap();
                } else {
                    let snapshot = fs::read_dir(&versions)
                        .unwrap()
                        .next()
                        .unwrap()
                        .unwrap()
                        .path();
                    if sabotage == "delete" {
                        fs::remove_file(snapshot).unwrap();
                    } else {
                        fs::write(snapshot, b"changed recovery").unwrap();
                    }
                }
            },
        );
        assert!(fixture.save(b"edited", &digest(b"original")).is_err());
        fixture.original();
    }
}

#[test]
fn hwped_save_real_ipc_requires_revision_and_preserves_structured_conflict() {
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    let fixture = Fixture::new();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.runtime_authority_mut().__allow_command(
        "hwped_save".to_string(),
        tauri::utils::acl::ExecutionContext::Local,
    );
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![crate::hwped::hwped_save])
        .build(context)
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |payload| {
        get_ipc_response(
            &view,
            InvokeRequest {
                cmd: "hwped_save".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: view.url().unwrap(),
                body: InvokeBody::Json(payload),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
    };
    let mut payload = serde_json::json!({"workspaceRoot":fixture.root_text(),"documentPath":"docs/test.hwpx","dataBase64":BASE64.encode(b"edited")});
    assert!(invoke(payload.clone()).is_err());
    fixture.original();
    fixture.no_snapshot();
    payload["expectedRevision"] = Value::String("0".repeat(64));
    let stale = invoke(payload.clone()).unwrap_err();
    assert_eq!(stale["code"], DOCUMENT_CONFLICT);
    fixture.original();
    fixture.no_snapshot();
    payload["expectedRevision"] = Value::String(digest(b"original"));
    let saved = invoke(payload).unwrap().deserialize::<Value>().unwrap();
    assert_eq!(saved["revision"], digest(b"edited"));
    assert_eq!(
        fs::read(fixture.root.join(saved["snapshotPath"].as_str().unwrap())).unwrap(),
        b"original"
    );
}

#[test]
#[ignore = "requires MARU_HWPED_REAL_TEST_BIN pointing to the installed released engine"]
fn released_hwpx_persistence_roundtrip_and_structural_refusals() {
    let binary = PathBuf::from(
        std::env::var_os("MARU_HWPED_REAL_TEST_BIN").expect("set the released engine path"),
    );
    let fixture = Fixture::new();
    std::env::set_var("MARU_HWP_BIN", &binary);
    let input = fixture.home.root.path().join("source.md");
    let selected = fixture.root.join("docs/test.hwpx");
    fs::write(
        &input,
        "# 한글 제목\n\nOriginal English\n\n같은 문구\n\n같은 문구\n",
    )
    .unwrap();
    run_hwp_ok(
        &binary,
        &[
            "new".into(),
            "--from".into(),
            input.as_os_str().to_owned(),
            "-o".into(),
            selected.as_os_str().to_owned(),
        ],
        None,
    )
    .unwrap();
    let original = fs::read(&selected).unwrap();
    let captured = capture_now(
        HwpedDocumentRef {
            name: "test.hwpx".into(),
            path: Some("docs/test.hwpx".into()),
            data_base64: None,
        },
        Some(fixture.root_text()),
    )
    .unwrap();
    assert_eq!(captured["source"]["revision"], digest(&original));
    assert_eq!(
        BASE64
            .decode(captured["source"]["dataBase64"].as_str().unwrap())
            .unwrap(),
        original
    );
    fs::write(
        &input,
        "# 수정 제목\n\nSaved English\n\n같은 문구\n\n수정된 문구\n",
    )
    .unwrap();
    let edited = fixture.home.root.path().join("edited.hwpx");
    run_hwp_ok(
        &binary,
        &[
            "new".into(),
            "--from".into(),
            input.as_os_str().to_owned(),
            "-o".into(),
            edited.as_os_str().to_owned(),
        ],
        None,
    )
    .unwrap();
    let saved = fixture
        .save(&fs::read(&edited).unwrap(), &digest(&original))
        .unwrap();
    assert_eq!(
        fs::read(fixture.root.join(&saved.snapshot_path)).unwrap(),
        original
    );
    let version = ensure_version(&binary).unwrap();
    let read = read_staged(&binary, &version, &selected).unwrap();
    assert!(read["markdown"].as_str().unwrap().contains("수정된 문구"));
    assert!(read["markdown"].as_str().unwrap().contains("Saved English"));
    let committed = fs::read(&selected).unwrap();
    let native = fixture.home.root.path().join("native.hwp");
    run_hwp_ok(
        &binary,
        &[
            "convert".into(),
            selected.as_os_str().to_owned(),
            "--to".into(),
            "hwp".into(),
            "-o".into(),
            native.as_os_str().to_owned(),
        ],
        None,
    )
    .unwrap();
    let zip_path = fixture.home.root.path().join("arbitrary.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
    zip.start_file("unrelated.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"not an HWPX package").unwrap();
    zip.finish().unwrap();
    for invalid in [
        fs::read(native).unwrap(),
        fs::read(zip_path).unwrap(),
        b"invalid ZIP".to_vec(),
    ] {
        assert!(fixture.save(&invalid, &saved.revision).is_err());
        assert_eq!(fs::read(&selected).unwrap(), committed);
        assert_eq!(
            fs::read_dir(fixture.root.join(".maru/versions"))
                .unwrap()
                .count(),
            1
        );
    }
    println!(
        "HWPX_PERSISTENCE_REAL_PASS engine={version} original={} committed={} snapshot={}",
        digest(&original),
        digest(&committed),
        saved.snapshot_path
    );
}
