// Maru Today — AI planning contracts. The planning agent emits schema-tagged
// JSON (`maru_today_capture_v1`, `maru_today_plan_v1`); everything here runs
// before an output may touch the day state. Validation is layered: raw-JSON
// guards first (destructive-field denylist), then typed deserialization,
// then semantic checks with stable snake_case error codes. Applying a plan
// still goes through `today_mutate`/`TodayMutation::SetPlan`, so the store's
// own revision/day/plan checks remain the final authority.

use crate::agent_host::contracts::{TODAY_CAPTURE_SCHEMA_VERSION, TODAY_PLAN_SCHEMA_VERSION};
use crate::today::{
    block_crosses_sleep, parse_sleep_start, CapacitySummary, CaptureCandidate, DailyPlanV1,
    PlanItemRef, TodayMutation, TodaySnapshot, TOP_LANE_MAX,
};
use crate::today_store::{load_snapshot, today_mutate};
use crate::vault::normalize_existing_dir;
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashSet;

pub const MARU_TODAY_CAPTURE_V1: &str = TODAY_CAPTURE_SCHEMA_VERSION;
pub const MARU_TODAY_PLAN_V1: &str = TODAY_PLAN_SCHEMA_VERSION;

/// A single plan item may never claim more than a full day.
const MAX_ESTIMATE_MINUTES: u32 = 24 * 60;

/// Keys that smell like lifecycle transitions or external-system writes. An
/// AI planning output proposes a plan; it never executes side effects, so any
/// of these keys anywhere in the raw payload rejects the whole output.
const DESTRUCTIVE_KEYS: [&str; 7] = [
    "status",
    "delete",
    "cancel",
    "complete",
    "googleTaskId",
    "calendarEventId",
    "sync",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodayCaptureOutputV1 {
    pub schema: String,
    #[serde(default)]
    pub candidates: Vec<CaptureCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodayPlanOutputV1 {
    pub schema: String,
    pub plan: DailyPlanV1,
}

/// Recursive raw-JSON guard. `calendarSync` subtrees are exempt: their
/// `status` field is a legitimate domain value (the only place a denylisted
/// key may appear).
fn reject_destructive_fields(value: &JsonValue) -> Result<(), String> {
    match value {
        JsonValue::Object(map) => {
            for (key, child) in map {
                if DESTRUCTIVE_KEYS.contains(&key.as_str()) {
                    return Err(format!("today_ai_destructive_field: {key}"));
                }
                if key != "calendarSync" {
                    reject_destructive_fields(child)?;
                }
            }
            Ok(())
        }
        JsonValue::Array(items) => {
            for item in items {
                reject_destructive_fields(item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Validate a `maru_today_capture_v1` output. Candidates from unknown
/// providers are dropped (not actionable); duplicates within the output are
/// removed, keyed by provider + providerItemId when present, else by
/// fingerprint. Empty titles reject the whole output.
pub fn validate_capture_output(
    output: &TodayCaptureOutputV1,
    known_providers: &[String],
) -> Result<Vec<CaptureCandidate>, String> {
    if output.schema != MARU_TODAY_CAPTURE_V1 {
        return Err(format!("today_ai_schema_mismatch: {}", output.schema));
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut candidates = Vec::new();
    for candidate in &output.candidates {
        if !known_providers.iter().any(|p| p == &candidate.provider) {
            continue;
        }
        if candidate.title.trim().is_empty() {
            return Err(format!("today_ai_empty_title: {}", candidate.capture_id));
        }
        let key = match &candidate.provider_item_id {
            Some(item_id) => format!("provider:{}:{item_id}", candidate.provider),
            None => format!("fingerprint:{}", candidate.fingerprint),
        };
        if seen.insert(key) {
            candidates.push(candidate.clone());
        }
    }
    Ok(candidates)
}

/// Validate a raw `maru_today_plan_v1` output against the current day
/// context. Returns the typed plan only when every guard passes.
pub fn validate_plan_output(
    raw: &JsonValue,
    expected_logical_day: &str,
    expected_input_revision: &str,
    valid_refs: &HashSet<PlanItemRef>,
    sleep_start: &str,
) -> Result<DailyPlanV1, String> {
    reject_destructive_fields(raw)?;
    let output: TodayPlanOutputV1 = serde_json::from_value(raw.clone())
        .map_err(|err| format!("today_ai_invalid_payload: {err}"))?;
    if output.schema != MARU_TODAY_PLAN_V1 {
        return Err(format!("today_ai_schema_mismatch: {}", output.schema));
    }
    let plan = output.plan;
    if plan.logical_day != expected_logical_day {
        return Err(format!(
            "today_ai_day_mismatch: {} != {expected_logical_day}",
            plan.logical_day
        ));
    }
    if plan.input_revision != expected_input_revision {
        return Err(format!(
            "today_ai_stale_revision: {} != {expected_input_revision}",
            plan.input_revision
        ));
    }
    if plan.top.len() > TOP_LANE_MAX {
        return Err(format!(
            "today_ai_too_many_top: {} > {TOP_LANE_MAX}",
            plan.top.len()
        ));
    }
    let sleep = parse_sleep_start(sleep_start)?;
    let mut seen_refs: HashSet<&PlanItemRef> = HashSet::new();
    let mut intervals: Vec<(String, i64, i64)> = Vec::new();
    for item in plan.items() {
        if !valid_refs.contains(&item.item_ref) {
            return Err(format!("today_ai_unknown_ref: {}", item.item_ref.id()));
        }
        if !seen_refs.insert(&item.item_ref) {
            return Err(format!("today_ai_duplicate_ref: {}", item.item_ref.id()));
        }
        if let Some(minutes) = item.estimate_minutes {
            if minutes == 0 || minutes > MAX_ESTIMATE_MINUTES {
                return Err(format!(
                    "today_ai_invalid_estimate: {} {minutes}",
                    item.item_ref.id()
                ));
            }
        }
        if let Some(block) = &item.proposed_block {
            if block_crosses_sleep(block, sleep)? {
                return Err(format!(
                    "today_ai_block_past_sleep: {} {}-{}",
                    item.item_ref.id(),
                    block.start_iso,
                    block.end_iso
                ));
            }
            // `block_crosses_sleep` already parsed both ends successfully.
            let start = DateTime::parse_from_rfc3339(&block.start_iso)
                .map_err(|err| format!("today_invalid_block: {err}"))?;
            let end = DateTime::parse_from_rfc3339(&block.end_iso)
                .map_err(|err| format!("today_invalid_block: {err}"))?;
            intervals.push((
                item.item_ref.id().to_string(),
                start.timestamp(),
                end.timestamp(),
            ));
        }
    }
    intervals.sort_by_key(|(_, start, _)| *start);
    for pair in intervals.windows(2) {
        if pair[1].1 < pair[0].2 {
            return Err(format!(
                "today_ai_block_overlap: {} overlaps {}",
                pair[0].0, pair[1].0
            ));
        }
    }
    Ok(plan)
}

/// What the frontend serializes into the planning prompt: the contract tag,
/// the revision the output must echo back, and the refs the plan may cite.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodayPlanRequest {
    pub schema: String,
    pub logical_day: String,
    pub input_revision: String,
    #[serde(default)]
    pub candidate_refs: Vec<PlanItemRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capacity: Option<CapacitySummary>,
    #[serde(default)]
    pub brain_dump: String,
    pub sleep_start: String,
    pub day_start: String,
}

/// Assemble the plan-request context from the stored snapshot. Candidate
/// refs are carryovers, yesterday items, and any existing plan items,
/// deduplicated in first-seen order.
#[tauri::command]
pub fn today_build_plan_request(
    work_path: String,
    logical_day: String,
) -> Result<TodayPlanRequest, String> {
    let work = normalize_existing_dir(&work_path)?;
    let snapshot = load_snapshot(&work, &logical_day)?;
    let mut candidate_refs: Vec<PlanItemRef> = snapshot
        .carryovers
        .iter()
        .map(|carry| carry.item_ref.clone())
        .chain(snapshot.yesterday.iter().map(|item| PlanItemRef::Task {
            task_id: item.task_id.clone(),
        }))
        .chain(
            snapshot
                .plan
                .iter()
                .flat_map(|plan| plan.items().map(|item| item.item_ref.clone())),
        )
        .collect();
    let mut seen: HashSet<PlanItemRef> = HashSet::new();
    candidate_refs.retain(|item_ref| seen.insert(item_ref.clone()));
    Ok(TodayPlanRequest {
        schema: MARU_TODAY_PLAN_V1.to_string(),
        logical_day: snapshot.logical_day,
        input_revision: snapshot.revision,
        candidate_refs,
        capacity: snapshot.capacity,
        brain_dump: snapshot.brain_dump,
        sleep_start: snapshot.sleep_start,
        day_start: snapshot.day_start,
    })
}

/// Validate a raw `maru_today_plan_v1` output and apply it through the same
/// path as `TodayMutation::SetPlan`. Revision drift between validation and
/// the stored snapshot propagates as `today_conflict`.
#[tauri::command]
pub fn today_apply_plan_result(
    work_path: String,
    logical_day: String,
    expected_revision: String,
    output_json: String,
    valid_refs: Vec<PlanItemRef>,
    sleep_start: String,
) -> Result<TodaySnapshot, String> {
    let raw: JsonValue = serde_json::from_str(&output_json)
        .map_err(|err| format!("today_ai_invalid_payload: {err}"))?;
    let valid: HashSet<PlanItemRef> = valid_refs.into_iter().collect();
    let plan = validate_plan_output(
        &raw,
        &logical_day,
        &expected_revision,
        &valid,
        &sleep_start,
    )?;
    today_mutate(
        work_path,
        logical_day,
        expected_revision,
        TodayMutation::SetPlan { plan },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::today::CaptureConfidence;
    use crate::today_store::today_open;
    use serde_json::json;
    use std::fs;

    const SEOUL: &str = "Asia/Seoul";
    const DAY: &str = "2026-07-21";
    const SLEEP: &str = "21:30";

    fn open_day(work: &str) -> TodaySnapshot {
        today_open(
            work.to_string(),
            "2026-07-21T09:00:00+09:00".to_string(),
            SEOUL.to_string(),
            "03:30".to_string(),
            SLEEP.to_string(),
        )
        .unwrap()
    }

    fn task_ref(id: &str) -> PlanItemRef {
        PlanItemRef::Task {
            task_id: id.to_string(),
        }
    }

    fn valid_refs(ids: &[&str]) -> Vec<PlanItemRef> {
        ids.iter().map(|id| task_ref(id)).collect()
    }

    fn top_item(id: &str) -> JsonValue {
        json!({
            "itemRef": {"kind": "task", "taskId": id},
            "lane": "top",
            "order": 0,
            "estimateMinutes": 45,
        })
    }

    fn plan_output_json(revision: &str, top: Vec<JsonValue>, flexible: Vec<JsonValue>) -> String {
        json!({
            "schema": MARU_TODAY_PLAN_V1,
            "plan": {
                "logicalDay": DAY,
                "inputRevision": revision,
                "top": top,
                "flexible": flexible,
                "overflow": [],
                "reasons": [],
                "warnings": [],
            }
        })
        .to_string()
    }

    fn candidate_json(
        capture_id: &str,
        provider: &str,
        provider_item_id: Option<&str>,
        fingerprint: &str,
    ) -> JsonValue {
        json!({
            "captureId": capture_id,
            "provider": provider,
            "providerItemId": provider_item_id,
            "fingerprint": fingerprint,
            "confidence": "high",
            "title": format!("Title {capture_id}"),
            "receivedAt": "2026-07-21T08:00:00+09:00",
        })
    }

    fn capture_output(candidates: Vec<JsonValue>) -> TodayCaptureOutputV1 {
        serde_json::from_value(json!({
            "schema": MARU_TODAY_CAPTURE_V1,
            "candidates": candidates,
        }))
        .unwrap()
    }

    // --- Capture contract ---------------------------------------------------

    #[test]
    fn capture_output_validates_and_dedupes() {
        let output = capture_output(vec![
            candidate_json("c1", "gmail", Some("m-1"), "fp-1"),
            // Same provider + providerItemId: duplicate of c1.
            candidate_json("c2", "gmail", Some("m-1"), "fp-2"),
            candidate_json("c3", "kakao", None, "fp-3"),
            // No providerItemId: fingerprint fallback makes this a dup of c3.
            candidate_json("c4", "kakao", None, "fp-3"),
            // Unknown provider: dropped, not an error.
            candidate_json("c5", "slack", Some("s-1"), "fp-5"),
        ]);
        let providers = vec!["gmail".to_string(), "kakao".to_string()];
        let candidates = validate_capture_output(&output, &providers).unwrap();
        let ids: Vec<&str> = candidates
            .iter()
            .map(|candidate| candidate.capture_id.as_str())
            .collect();
        assert_eq!(ids, vec!["c1", "c3"]);
    }

    #[test]
    fn capture_output_rejects_schema_mismatch() {
        let mut value = json!({ "schema": "maru_today_capture_v0", "candidates": [] });
        let output: TodayCaptureOutputV1 = serde_json::from_value(value.clone()).unwrap();
        let err = validate_capture_output(&output, &[]).unwrap_err();
        assert!(err.starts_with("today_ai_schema_mismatch"));
        value["schema"] = json!(MARU_TODAY_PLAN_V1);
        let output: TodayCaptureOutputV1 = serde_json::from_value(value).unwrap();
        assert!(validate_capture_output(&output, &[])
            .unwrap_err()
            .starts_with("today_ai_schema_mismatch"));
    }

    #[test]
    fn capture_output_rejects_empty_title() {
        let mut raw = candidate_json("c1", "gmail", Some("m-1"), "fp-1");
        raw["title"] = json!("   ");
        let output = capture_output(vec![raw]);
        let providers = vec!["gmail".to_string()];
        let err = validate_capture_output(&output, &providers).unwrap_err();
        assert!(err.starts_with("today_ai_empty_title"));
    }

    #[test]
    fn capture_output_rejects_invalid_confidence_via_serde() {
        let mut raw = candidate_json("c1", "gmail", Some("m-1"), "fp-1");
        raw["confidence"] = json!("certain");
        let err = serde_json::from_value::<TodayCaptureOutputV1>(json!({
            "schema": MARU_TODAY_CAPTURE_V1,
            "candidates": [raw],
        }))
        .unwrap_err();
        assert!(err.to_string().contains("unknown variant"));
    }

    // --- Plan contract ------------------------------------------------------

    #[test]
    fn build_plan_request_assembles_snapshot_context() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        today_mutate(
            work.clone(),
            snapshot.logical_day.clone(),
            snapshot.revision.clone(),
            TodayMutation::SetBrainDump {
                brain_dump: "loose thoughts".to_string(),
            },
        )
        .unwrap();
        let request = today_build_plan_request(work, DAY.to_string()).unwrap();
        assert_eq!(request.schema, MARU_TODAY_PLAN_V1);
        assert_eq!(request.logical_day, DAY);
        assert_eq!(request.brain_dump, "loose thoughts");
        assert_eq!(request.sleep_start, SLEEP);
        assert_eq!(request.day_start, "03:30");
        assert!(!request.input_revision.is_empty());
        assert!(request.candidate_refs.is_empty());
        assert!(request.capacity.is_none());
        let err = today_build_plan_request(
            tmp.path().to_string_lossy().to_string(),
            "2026-07-22".to_string(),
        )
        .unwrap_err();
        assert_eq!(err, "today_state_missing");
    }

    #[test]
    fn apply_plan_result_happy_path_persists_and_bumps_revision() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        let request = today_build_plan_request(work.clone(), DAY.to_string()).unwrap();
        assert_eq!(request.input_revision, snapshot.revision);
        let output = plan_output_json(
            &request.input_revision,
            vec![top_item("a"), top_item("b")],
            vec![json!({
                "itemRef": {"kind": "task", "taskId": "c"},
                "lane": "flexible",
                "order": 0,
                "estimateMinutes": 30,
            })],
        );
        let applied = today_apply_plan_result(
            work,
            DAY.to_string(),
            request.input_revision,
            output,
            valid_refs(&["a", "b", "c"]),
            SLEEP.to_string(),
        )
        .unwrap();
        assert_ne!(applied.revision, snapshot.revision);
        let plan = applied.plan.as_ref().unwrap();
        assert_eq!(plan.top.len(), 2);
        assert_eq!(plan.flexible.len(), 1);
        // State file on disk carries the new plan and revision.
        let raw = fs::read_to_string(
            tmp.path().join(".maru/today").join(format!("{DAY}.json")),
        )
        .unwrap();
        let stored: TodaySnapshot = serde_json::from_str(&raw).unwrap();
        assert_eq!(stored.revision, applied.revision);
        assert!(stored.plan.is_some());
    }

    #[test]
    fn apply_plan_result_conflict_propagates_as_today_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        let output = plan_output_json(&snapshot.revision, vec![top_item("a")], vec![]);
        let applied = today_apply_plan_result(
            work.clone(),
            DAY.to_string(),
            snapshot.revision.clone(),
            output.clone(),
            valid_refs(&["a"]),
            SLEEP.to_string(),
        )
        .unwrap();
        // Replaying the same output: inputRevision still matches the caller's
        // expected_revision, so validation passes and the store's optimistic
        // concurrency check rejects it as today_conflict.
        let err = today_apply_plan_result(
            work.clone(),
            DAY.to_string(),
            snapshot.revision.clone(),
            output,
            valid_refs(&["a"]),
            SLEEP.to_string(),
        )
        .unwrap_err();
        assert!(err.starts_with("today_conflict"));
        // A draft computed against the newer revision but handed in with the
        // old expected_revision is caught by validation itself.
        let fresh = plan_output_json(&applied.revision, vec![top_item("a")], vec![]);
        let err = today_apply_plan_result(
            work,
            DAY.to_string(),
            snapshot.revision,
            fresh,
            valid_refs(&["a"]),
            SLEEP.to_string(),
        )
        .unwrap_err();
        assert!(err.starts_with("today_ai_stale_revision"));
    }

    fn plan_validation_err(
        output: String,
        snapshot: &TodaySnapshot,
        refs: &[&str],
    ) -> String {
        let raw: JsonValue = serde_json::from_str(&output).unwrap();
        let valid: HashSet<PlanItemRef> = valid_refs(refs).into_iter().collect();
        validate_plan_output(&raw, DAY, &snapshot.revision, &valid, SLEEP).unwrap_err()
    }

    #[test]
    fn plan_output_rejects_schema_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        let output = plan_output_json(&snapshot.revision, vec![top_item("a")], vec![])
            .replace(MARU_TODAY_PLAN_V1, "maru_today_plan_v0");
        assert!(plan_validation_err(output, &snapshot, &["a"])
            .starts_with("today_ai_schema_mismatch"));
    }

    #[test]
    fn plan_output_rejects_day_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        let output = plan_output_json(&snapshot.revision, vec![top_item("a")], vec![])
            .replace(DAY, "2026-07-22");
        assert!(plan_validation_err(output, &snapshot, &["a"])
            .starts_with("today_ai_day_mismatch"));
    }

    #[test]
    fn plan_output_rejects_stale_revision() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        let output = plan_output_json("stale-revision", vec![top_item("a")], vec![]);
        assert!(plan_validation_err(output, &snapshot, &["a"])
            .starts_with("today_ai_stale_revision"));
    }

    #[test]
    fn plan_output_rejects_unknown_ref() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        let output = plan_output_json(&snapshot.revision, vec![top_item("ghost")], vec![]);
        assert!(plan_validation_err(output, &snapshot, &["a"])
            .starts_with("today_ai_unknown_ref"));
    }

    #[test]
    fn plan_output_rejects_duplicate_ref_across_lanes() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        let dup_flexible = json!({
            "itemRef": {"kind": "task", "taskId": "a"},
            "lane": "flexible",
            "order": 0,
        });
        let output = plan_output_json(&snapshot.revision, vec![top_item("a")], vec![dup_flexible]);
        assert!(plan_validation_err(output, &snapshot, &["a"])
            .starts_with("today_ai_duplicate_ref"));
    }

    #[test]
    fn plan_output_rejects_more_than_three_top() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        let output = plan_output_json(
            &snapshot.revision,
            vec![top_item("a"), top_item("b"), top_item("c"), top_item("d")],
            vec![],
        );
        assert!(plan_validation_err(output, &snapshot, &["a", "b", "c", "d"])
            .starts_with("today_ai_too_many_top"));
    }

    #[test]
    fn plan_output_rejects_zero_and_absurd_estimates() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        for minutes in [0, 24 * 60 + 1] {
            let mut item = top_item("a");
            item["estimateMinutes"] = json!(minutes);
            let output = plan_output_json(&snapshot.revision, vec![item], vec![]);
            assert!(
                plan_validation_err(output, &snapshot, &["a"])
                    .starts_with("today_ai_invalid_estimate"),
                "estimate {minutes} must be rejected"
            );
        }
        // Exactly 24h is allowed.
        let mut item = top_item("a");
        item["estimateMinutes"] = json!(24 * 60);
        let output = plan_output_json(&snapshot.revision, vec![item], vec![]);
        let raw: JsonValue = serde_json::from_str(&output).unwrap();
        let valid: HashSet<PlanItemRef> = valid_refs(&["a"]).into_iter().collect();
        assert!(validate_plan_output(&raw, DAY, &snapshot.revision, &valid, SLEEP).is_ok());
    }

    #[test]
    fn plan_output_rejects_overlapping_blocks() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        let block = |start: &str, end: &str| json!({"startIso": start, "endIso": end});
        let mut first = top_item("a");
        first["proposedBlock"] = block("2026-07-21T10:00:00+09:00", "2026-07-21T11:00:00+09:00");
        let mut second = top_item("b");
        second["proposedBlock"] = block("2026-07-21T10:30:00+09:00", "2026-07-21T11:30:00+09:00");
        let output = plan_output_json(&snapshot.revision, vec![first, second], vec![]);
        assert!(plan_validation_err(output, &snapshot, &["a", "b"])
            .starts_with("today_ai_block_overlap"));
        // Adjacent blocks (end == start) do not overlap.
        let mut first = top_item("a");
        first["proposedBlock"] = block("2026-07-21T10:00:00+09:00", "2026-07-21T11:00:00+09:00");
        let mut second = top_item("b");
        second["proposedBlock"] = block("2026-07-21T11:00:00+09:00", "2026-07-21T12:00:00+09:00");
        let output = plan_output_json(&snapshot.revision, vec![first, second], vec![]);
        let raw: JsonValue = serde_json::from_str(&output).unwrap();
        let valid: HashSet<PlanItemRef> = valid_refs(&["a", "b"]).into_iter().collect();
        assert!(validate_plan_output(&raw, DAY, &snapshot.revision, &valid, SLEEP).is_ok());
    }

    #[test]
    fn plan_output_rejects_block_past_sleep() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        let mut item = top_item("a");
        item["proposedBlock"] =
            json!({"startIso": "2026-07-21T21:00:00+09:00", "endIso": "2026-07-21T22:00:00+09:00"});
        let output = plan_output_json(&snapshot.revision, vec![item], vec![]);
        assert!(plan_validation_err(output, &snapshot, &["a"])
            .starts_with("today_ai_block_past_sleep"));
    }

    #[test]
    fn plan_output_rejects_destructive_fields_top_level_and_nested() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        // Top-level lifecycle key.
        let mut raw: JsonValue = serde_json::from_str(&plan_output_json(
            &snapshot.revision,
            vec![top_item("a")],
            vec![],
        ))
        .unwrap();
        raw["status"] = json!("done");
        let valid: HashSet<PlanItemRef> = valid_refs(&["a"]).into_iter().collect();
        let err = validate_plan_output(&raw, DAY, &snapshot.revision, &valid, SLEEP).unwrap_err();
        assert_eq!(err, "today_ai_destructive_field: status");
        // Nested inside a plan item.
        let mut raw: JsonValue = serde_json::from_str(&plan_output_json(
            &snapshot.revision,
            vec![top_item("a")],
            vec![],
        ))
        .unwrap();
        raw["plan"]["top"][0]["status"] = json!("done");
        let err = validate_plan_output(&raw, DAY, &snapshot.revision, &valid, SLEEP).unwrap_err();
        assert_eq!(err, "today_ai_destructive_field: status");
        // External-system write key.
        let mut raw: JsonValue = serde_json::from_str(&plan_output_json(
            &snapshot.revision,
            vec![top_item("a")],
            vec![],
        ))
        .unwrap();
        raw["googleTaskId"] = json!("gt-123");
        let err = validate_plan_output(&raw, DAY, &snapshot.revision, &valid, SLEEP).unwrap_err();
        assert_eq!(err, "today_ai_destructive_field: googleTaskId");
    }

    #[test]
    fn plan_output_allows_legit_calendar_sync_status() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        let mut item = top_item("a");
        item["calendarSync"] = json!({"status": "none"});
        let output = plan_output_json(&snapshot.revision, vec![item], vec![]);
        let raw: JsonValue = serde_json::from_str(&output).unwrap();
        let valid: HashSet<PlanItemRef> = valid_refs(&["a"]).into_iter().collect();
        let plan = validate_plan_output(&raw, DAY, &snapshot.revision, &valid, SLEEP).unwrap();
        assert_eq!(plan.top.len(), 1);
    }

    #[test]
    fn plan_output_rejects_malformed_json_and_unknown_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work);
        let err = today_apply_plan_result(
            work,
            DAY.to_string(),
            snapshot.revision.clone(),
            "{ not json".to_string(),
            valid_refs(&["a"]),
            SLEEP.to_string(),
        )
        .unwrap_err();
        assert!(err.starts_with("today_ai_invalid_payload"));
        // deny_unknown_fields on the output wrapper: unexpected top-level
        // key is an invalid payload, not silently ignored.
        let mut raw: JsonValue = serde_json::from_str(&plan_output_json(
            &snapshot.revision,
            vec![top_item("a")],
            vec![],
        ))
        .unwrap();
        raw["surprise"] = json!(true);
        let valid: HashSet<PlanItemRef> = valid_refs(&["a"]).into_iter().collect();
        let err = validate_plan_output(&raw, DAY, &snapshot.revision, &valid, SLEEP).unwrap_err();
        assert!(err.starts_with("today_ai_invalid_payload"));
    }
}
