use super::*;
use crate::atomic_file::phase08_06::Home;
use std::sync::{Arc, Barrier};

const KIND: &str = "task.completion.accept";

fn workspace(home: &Home) -> String {
    let work = home.root.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    work.to_string_lossy().into_owned()
}

fn binding() -> ApprovalBinding {
    ApprovalBinding {
        logical_target: "workspace/task-fixture/generation-3".into(),
        payload_hash: "review-and-artifact-manifest".into(),
        source_run_id: Some("creator-run".into()),
        source_revision: "task-source-revision".into(),
        base_revision: "committed-artifact-revision".into(),
        policy_revision: "completion-required-independent-person".into(),
    }
}

fn prepare(state: &ApprovalState, cwd: &str, binding: ApprovalBinding) -> ApprovalRequest {
    state
        .prepare_fresh_bound(
            cwd,
            "Accept the reviewed task output".into(),
            Some("tasks/active/fixture.md".into()),
            Some("The current artifact manifest and review are unchanged".into()),
            binding,
        )
        .unwrap()
}

fn consume(
    state: &ApprovalState,
    cwd: &str,
    id: &str,
    binding: &ApprovalBinding,
) -> Result<String, String> {
    let path = audit_path(cwd, id)?;
    with_path_transactions(audit_transaction(path)?, |lease| {
        state.consume_fresh_bound(Some(id), binding, lease)
    })
}

#[test]
fn task_completion_generic_prepare_refuses_unbound_acceptance() {
    let state = ApprovalState::default();
    let result = state.prepare(KIND.into(), "Unbound acceptance".into(), None, None);
    assert!(
        result.is_err(),
        "task completion must not create authority without a backend binding: {result:?}"
    );
    assert!(state.store.lock().unwrap().approvals.is_empty());
}

#[test]
fn task_completion_remembered_kind_and_binding_never_autoapprove() {
    let home = Home::new();
    let cwd = workspace(&home);
    let state = ApprovalState::default();
    let original = binding();
    {
        let mut store = state.store.lock().unwrap();
        // Seed both older session-cache shapes independently of the new
        // prepare operation. Neither may stand in for a fresh person action.
        store.session_allowed_kinds.insert(KIND.into());
        store.session_allowed_bindings.insert(original.clone());
    }
    let request = prepare(&state, &cwd, original.clone());
    assert_eq!(request.kind, KIND);
    assert!(!request.auto_approved);
    assert_eq!(request.binding.as_ref(), Some(&original));
    assert_eq!(
        consume(&state, &cwd, &request.id, &original).unwrap_err(),
        "approval_not_granted"
    );
    assert_eq!(
        state.store.lock().unwrap().approvals[&request.id].decision,
        ApprovalDecision::Pending
    );
}

#[test]
fn task_completion_fresh_approval_requires_an_exact_binding_and_consumes_once() {
    let home = Home::new();
    let cwd = workspace(&home);
    let state = ApprovalState::default();
    let original = binding();
    let request = prepare(&state, &cwd, original.clone());
    state
        .record(&request.id, ApprovalDecision::Approved, false)
        .unwrap();

    let mut changes = Vec::new();
    let mut changed = original.clone();
    changed.logical_target.push_str("-other-task-or-generation");
    changes.push(changed);
    let mut changed = original.clone();
    changed.payload_hash.push_str("-new-review");
    changes.push(changed);
    let mut changed = original.clone();
    changed.source_run_id = Some("other-creator-run".into());
    changes.push(changed);
    let mut changed = original.clone();
    changed.source_revision.push_str("-new-source");
    changes.push(changed);
    let mut changed = original.clone();
    changed.base_revision.push_str("-new-artifact");
    changes.push(changed);
    let mut changed = original.clone();
    changed.policy_revision.push_str("-new-policy");
    changes.push(changed);
    for changed in changes {
        assert_eq!(
            consume(&state, &cwd, &request.id, &changed).unwrap_err(),
            "approval_binding_mismatch"
        );
        assert!(!state.store.lock().unwrap().approvals[&request.id].consumed);
    }

    assert_eq!(
        consume(&state, &cwd, &request.id, &original).unwrap(),
        request.id
    );
    assert_eq!(
        consume(&state, &cwd, &request.id, &original).unwrap_err(),
        "approval_consumed"
    );
    let events = read_approval_audit(&cwd, &request.id).unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event.as_str())
            .collect::<Vec<_>>(),
        ["requested", "decided", "consumed"]
    );
    let next = prepare(&state, &cwd, original);
    assert!(
        !next.auto_approved,
        "a prior acceptance never grants the next one"
    );
}

#[test]
fn task_completion_generic_consume_cannot_take_fresh_bound_authority() {
    let home = Home::new();
    let cwd = workspace(&home);
    let state = ApprovalState::default();
    let original = binding();
    let request = prepare(&state, &cwd, original.clone());
    state
        .record(&request.id, ApprovalDecision::Approved, false)
        .unwrap();
    assert!(state.consume_any(Some(&request.id), &[KIND]).is_err());
    assert!(!state.store.lock().unwrap().approvals[&request.id].consumed);
    assert_eq!(
        consume(&state, &cwd, &request.id, &original).unwrap(),
        request.id
    );

    // Even an unbound entry left by an older generic preparation cannot be
    // consumed through the generic API after this kind becomes reserved.
    let legacy_id = format!("approval-{}", Uuid::new_v4());
    state.store.lock().unwrap().approvals.insert(
        legacy_id.clone(),
        StoredApproval {
            request: ApprovalRequest {
                id: legacy_id.clone(),
                kind: KIND.into(),
                summary: "Older unbound acceptance".into(),
                target: None,
                payload_preview: None,
                auto_approved: false,
                binding: None,
            },
            decision: ApprovalDecision::Approved,
            consumed: false,
            audit_workspace: None,
        },
    );
    assert!(state.consume_any(Some(&legacy_id), &[KIND]).is_err());
    assert!(!state.store.lock().unwrap().approvals[&legacy_id].consumed);
}

#[test]
fn task_completion_acceptance_refuses_remember_without_recording_a_decision() {
    let home = Home::new();
    let cwd = workspace(&home);
    let state = ApprovalState::default();
    let original = binding();
    let request = prepare(&state, &cwd, original.clone());
    assert!(state
        .record(&request.id, ApprovalDecision::Approved, true)
        .is_err());
    {
        let store = state.store.lock().unwrap();
        assert_eq!(
            store.approvals[&request.id].decision,
            ApprovalDecision::Pending
        );
        assert!(!store.session_allowed_kinds.contains(KIND));
        assert!(!store.session_allowed_bindings.contains(&original));
    }
    assert_eq!(read_approval_audit(&cwd, &request.id).unwrap().len(), 1);
    state
        .record(&request.id, ApprovalDecision::Approved, false)
        .unwrap();
    assert!(state
        .record(&request.id, ApprovalDecision::Approved, true)
        .is_err());
    assert_eq!(
        consume(&state, &cwd, &request.id, &original).unwrap(),
        request.id
    );
}

#[test]
fn task_completion_restart_keeps_audit_without_restoring_acceptance_authority() {
    let home = Home::new();
    let cwd = workspace(&home);
    let original = binding();
    let request = {
        let state = ApprovalState::default();
        let request = prepare(&state, &cwd, original.clone());
        state
            .record(&request.id, ApprovalDecision::Approved, false)
            .unwrap();
        request
    };
    let restarted = ApprovalState::default();
    let events = read_approval_audit(&cwd, &request.id).unwrap();
    assert_eq!(events.last().unwrap().decision, ApprovalDecision::Approved);
    assert_eq!(
        consume(&restarted, &cwd, &request.id, &original).unwrap_err(),
        "approval_not_found"
    );
    let fresh = prepare(&restarted, &cwd, original);
    assert!(!fresh.auto_approved);
    assert_ne!(fresh.id, request.id);
}

#[test]
fn task_completion_concurrent_consumption_has_one_winner_and_one_audit_effect() {
    let home = Home::new();
    let cwd = workspace(&home);
    let state = ApprovalState::default();
    let original = binding();
    let request = prepare(&state, &cwd, original.clone());
    state
        .record(&request.id, ApprovalDecision::Approved, false)
        .unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let contenders = (0..2)
        .map(|_| {
            let state = state.clone();
            let cwd = cwd.clone();
            let id = request.id.clone();
            let original = original.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                consume(&state, &cwd, &id, &original)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = contenders
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["approval_consumed"]
    );
    let events = read_approval_audit(&cwd, &request.id).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event == "consumed")
            .count(),
        1
    );
}

mod native_ipc {
    use super::*;
    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, MockRuntime, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewWindowBuilder};

    struct ChildIpc<'a>(&'a tauri::Webview<MockRuntime>);

    impl AsRef<tauri::Webview<MockRuntime>> for ChildIpc<'_> {
        fn as_ref(&self) -> &tauri::Webview<MockRuntime> {
            self.0
        }
    }

    fn app(state: ApprovalState) -> tauri::App<MockRuntime> {
        tauri::test::mock_builder()
            .manage(state)
            .invoke_handler(tauri::generate_handler![
                crate::approval::ipc::record_approval
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    fn request(id: &str) -> InvokeRequest {
        InvokeRequest {
            cmd: "record_approval".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            // These forged labels must never substitute for the injected
            // native webview and its actual owning window.
            body: InvokeBody::Json(json!({
                "id": id, "decision": "approved", "rememberKind": false,
                "webviewLabel": "main", "windowLabel": "main", "actor": "person",
            })),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        }
    }

    fn pending(state: &ApprovalState, cwd: &str, id: &str, before: &[u8]) {
        let store = state.store.lock().unwrap();
        assert_eq!(store.approvals[id].decision, ApprovalDecision::Pending);
        assert!(!store.approvals[id].consumed);
        assert!(store.session_allowed_kinds.is_empty());
        assert!(store.session_allowed_bindings.is_empty());
        drop(store);
        assert_eq!(std::fs::read(audit_path(cwd, id).unwrap()).unwrap(), before);
    }

    #[test]
    fn task_completion_record_ipc_requires_both_native_main_labels_before_effects() {
        let home = Home::new();
        let cwd = workspace(&home);
        let state = ApprovalState::default();
        let approval = prepare(&state, &cwd, binding());
        let before = std::fs::read(audit_path(&cwd, &approval.id).unwrap()).unwrap();
        let app = app(state.clone());
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let skill_editor = WebviewWindowBuilder::new(&app, "skill-editor", Default::default())
            .build()
            .unwrap();
        let local_child = main
            .as_ref()
            .window()
            .add_child(
                tauri::WebviewBuilder::new("local-child", tauri::WebviewUrl::default()),
                tauri::Position::Logical(tauri::LogicalPosition::new(0.0, 0.0)),
                tauri::Size::Logical(tauri::LogicalSize::new(100.0, 100.0)),
            )
            .unwrap();
        for view in [skill_editor.as_ref().clone(), local_child] {
            let result = get_ipc_response(&ChildIpc(&view), request(&approval.id));
            assert!(
                result.is_err(),
                "completion approval from {}/{} must be refused: {result:?}",
                view.window().label(),
                view.label()
            );
            pending(&state, &cwd, &approval.id, &before);
        }
        let other_app = self::app(state.clone());
        let other_window = tauri::WindowBuilder::new(&other_app, "other-window")
            .build()
            .unwrap();
        let disguised_main = other_window
            .add_child(
                tauri::WebviewBuilder::new("main", tauri::WebviewUrl::default()),
                tauri::Position::Logical(tauri::LogicalPosition::new(0.0, 0.0)),
                tauri::Size::Logical(tauri::LogicalSize::new(100.0, 100.0)),
            )
            .unwrap();
        let result = get_ipc_response(&ChildIpc(&disguised_main), request(&approval.id));
        assert!(
            result.is_err(),
            "a main-labelled child inside another window must be refused: {result:?}"
        );
        pending(&state, &cwd, &approval.id, &before);

        let result = get_ipc_response(&main, request(&approval.id)).unwrap();
        let recorded: Value = result.deserialize().unwrap();
        assert_eq!(recorded["kind"], KIND);
        assert_eq!(
            state.store.lock().unwrap().approvals[&approval.id].decision,
            ApprovalDecision::Approved
        );
        assert_eq!(read_approval_audit(&cwd, &approval.id).unwrap().len(), 2);
        consume(&state, &cwd, &approval.id, &binding()).unwrap();
    }

    #[test]
    fn ordinary_record_ipc_keeps_existing_skill_editor_window_behavior() {
        let state = ApprovalState::default();
        let approval = state
            .prepare(
                "inbox.file.accept".into(),
                "Ordinary action".into(),
                None,
                None,
            )
            .unwrap();
        let app = app(state.clone());
        let skill_editor = WebviewWindowBuilder::new(&app, "skill-editor", Default::default())
            .build()
            .unwrap();
        get_ipc_response(&skill_editor, request(&approval.id)).unwrap();
        state
            .consume_any(Some(&approval.id), &["inbox.file.accept"])
            .unwrap();
    }
}
