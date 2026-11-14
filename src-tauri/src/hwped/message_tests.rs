use super::*;
use crate::atomic_file::phase08_06::run;

#[test]
fn form_worker_cancellation_names_cause_and_recovery() {
    let task = tauri::async_runtime::spawn(std::future::pending::<()>());
    task.abort();
    let error = run(async move { task.await }).unwrap_err();
    let message = form_worker_error(error);
    assert!(message.starts_with("hwped_task_failed:"));
    assert!(message.contains("worker_cancelled"), "{message}");
    assert!(message.contains("retry"), "{message}");
    assert!(message.contains("check"), "{message}");
}

#[test]
fn stage_io_error_uses_kind_without_sensitive_error_text() {
    let error = std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "private-marker: /Users/stage-fixture/secret.hwpx",
    );
    let message = stage_io_error("write document bytes", error);
    assert!(message.starts_with("hwp_stage_failed:"));
    assert!(message.contains("PermissionDenied"), "{message}");
    assert!(!message.contains("private-marker"), "{message}");
    assert!(!message.contains("/Users/"), "{message}");
    assert!(message.contains("check"), "{message}");
    assert!(message.contains("retry"), "{message}");
}

#[test]
fn stage_document_write_failure_has_cause_and_next_step() {
    let tmp = tempfile::tempdir().unwrap();
    let blocked = tmp.path().join("blocked");
    std::fs::write(&blocked, "not a directory").unwrap();
    let document = HwpedDocumentRef {
        name: "fixture.hwpx".into(),
        path: None,
        data_base64: Some(BASE64.encode(b"fixture")),
    };
    let message = stage_document(&blocked, &document, None).unwrap_err();
    assert!(message.starts_with("hwp_stage_failed:"));
    assert!(!message.contains(&blocked.to_string_lossy().to_string()));
    assert!(message.contains("check"), "{message}");
    assert!(message.contains("retry"), "{message}");
}

#[cfg(not(windows))]
#[test]
fn edit_stage_resolution_failure_has_cause_and_next_step() {
    let tmp = tempfile::tempdir().unwrap();
    let missing = tmp.path().join("missing");
    let message = edit_stage_dir(&missing).unwrap_err();
    assert!(message.starts_with("hwp_stage_failed:"));
    assert!(message.contains("NotFound"), "{message}");
    assert!(!message.contains(&missing.to_string_lossy().to_string()));
    assert!(message.contains("check"), "{message}");
    assert!(message.contains("retry"), "{message}");
}
