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
