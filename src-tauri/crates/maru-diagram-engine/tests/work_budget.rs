//! A logical-work ceiling catches algorithmic amplification independently of
//! shared-runner wall-clock load. Each component and the sum have 25% headroom.
#![cfg(feature = "geometry-corpus")]
use maru_diagram_engine::work::{benchmark_work, WorkStats};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Budget {
    schema_version: u32,
    counter_definition_version: u32,
    fixture_sha256: String,
    baseline: WorkStats,
    ceiling: WorkStats,
    total_baseline: u64,
    total_ceiling: u64,
    authored_via: AuthoredViaBudget,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthoredViaBudget {
    fixture_path: String,
    measurement_status: String,
    fixture_sha256: Option<String>,
    nodes: Option<usize>,
    labels: Option<usize>,
    routes: Option<usize>,
    via_points: Option<usize>,
    minimum_route_segments: usize,
    route_segments: Option<usize>,
    baseline: Option<WorkStats>,
    ceiling: Option<WorkStats>,
    total_baseline: Option<u64>,
    total_ceiling: Option<u64>,
}
fn plus_25_percent(value: u64) -> u64 {
    value
        .checked_mul(5)
        .and_then(|n| n.checked_add(3))
        .expect("work ceiling overflowed; reduce the baseline before updating the budget")
        / 4
}
fn assert_counter(name: &str, actual: u64, baseline: u64, ceiling: u64) {
    assert_eq!(
        ceiling,
        plus_25_percent(baseline),
        "{name}: the checked-in ceiling must be the measured baseline plus 25%"
    );
    assert!(
        actual <= ceiling,
        "{name} work {actual} exceeds checked-in ceiling {ceiling}; inspect the algorithm change, then deliberately remeasure with geometry-work"
    );
}
fn assert_stats_below_ceiling(actual: WorkStats, baseline: WorkStats, ceiling: WorkStats) {
    for (name, value, base, cap) in [
        (
            "A* expanded states",
            actual.astar_expanded_states,
            baseline.astar_expanded_states,
            ceiling.astar_expanded_states,
        ),
        (
            "route evaluations",
            actual.route_evaluations,
            baseline.route_evaluations,
            ceiling.route_evaluations,
        ),
        (
            "constraint evaluations",
            actual.constraint_evaluations,
            baseline.constraint_evaluations,
            ceiling.constraint_evaluations,
        ),
        (
            "endpoint mask evaluations",
            actual.endpoint_mask_evaluations,
            baseline.endpoint_mask_evaluations,
            ceiling.endpoint_mask_evaluations,
        ),
        (
            "endpoint clearance evaluations",
            actual.endpoint_clearance_evaluations,
            baseline.endpoint_clearance_evaluations,
            ceiling.endpoint_clearance_evaluations,
        ),
        (
            "masked A* expanded states",
            actual.masked_astar_expanded_states,
            baseline.masked_astar_expanded_states,
            ceiling.masked_astar_expanded_states,
        ),
    ] {
        assert_counter(name, value, base, cap);
    }
}

#[test]
fn seeded_thousand_node_work_is_repeatable_and_below_the_reviewed_ceiling() {
    let budget: Budget =
        serde_json::from_str(include_str!("../testdata/work-budget.json")).unwrap();
    assert_eq!(budget.schema_version, 1);
    assert_eq!(budget.counter_definition_version, 2);
    let first = benchmark_work();
    assert_eq!(
        first,
        benchmark_work(),
        "logical work changed for an unchanged fixture; remove unordered evaluation before updating any ceiling"
    );
    assert_eq!(
        first.fixture_sha256, budget.fixture_sha256,
        "the 1000-node fixture changed; remeasure and deliberately update its reviewed budget"
    );
    assert!(
        first.stats.astar_expanded_states > 0
            && first.stats.route_evaluations > 0
            && first.stats.constraint_evaluations > 0,
        "work instrumentation is missing; restore A*, route and constraint counters before recording a budget"
    );
    assert_eq!(
        first.stats.masked_astar_expanded_states, 0,
        "the unchanged no-via 1000-node benchmark must not expand masked A* states"
    );
    for (name, actual, baseline, ceiling) in [
        (
            "A* expanded states",
            first.stats.astar_expanded_states,
            budget.baseline.astar_expanded_states,
            budget.ceiling.astar_expanded_states,
        ),
        (
            "route evaluations",
            first.stats.route_evaluations,
            budget.baseline.route_evaluations,
            budget.ceiling.route_evaluations,
        ),
        (
            "constraint evaluations",
            first.stats.constraint_evaluations,
            budget.baseline.constraint_evaluations,
            budget.ceiling.constraint_evaluations,
        ),
        (
            "endpoint mask evaluations in the unchanged no-via benchmark",
            first.stats.endpoint_mask_evaluations,
            budget.baseline.endpoint_mask_evaluations,
            budget.ceiling.endpoint_mask_evaluations,
        ),
        (
            "endpoint clearance evaluations in the unchanged no-via benchmark",
            first.stats.endpoint_clearance_evaluations,
            budget.baseline.endpoint_clearance_evaluations,
            budget.ceiling.endpoint_clearance_evaluations,
        ),
        (
            "masked A* expansions in the unchanged no-via benchmark",
            first.stats.masked_astar_expanded_states,
            budget.baseline.masked_astar_expanded_states,
            budget.ceiling.masked_astar_expanded_states,
        ),
    ] {
        assert_counter(name, actual, baseline, ceiling);
    }
    assert_eq!(budget.total_baseline, budget.baseline.total());
    assert_eq!(budget.total_ceiling, plus_25_percent(budget.total_baseline));
    assert!(
        first.total <= budget.total_ceiling,
        "total logical work {} exceeds ceiling {}; inspect the change and update testdata/work-budget.json deliberately after remeasurement",
        first.total,
        budget.total_ceiling
    );

    let via = &first.via_benchmark_work;
    assert_eq!(
        budget.authored_via.fixture_path,
        "testdata/bench-authored-via.json"
    );
    assert_eq!(
        budget.authored_via.measurement_status,
        "measured",
        "authored-via baseline/ceilings are explicitly pending; run geometry-work on the approved remote host and fill the exact output before treating this gate as complete"
    );
    assert_eq!(
        via.fixture_sha256,
        budget
            .authored_via
            .fixture_sha256
            .expect("measured authored-via budget needs the captured fixture hash"),
        "the authored-via fixture changed; remeasure its reviewed work budget"
    );
    assert_eq!(
        Some(via.nodes),
        budget.authored_via.nodes,
        "the authored-via node count must come from the measured geometry report"
    );
    assert_eq!(
        Some(via.labels),
        budget.authored_via.labels,
        "the authored-via label count must come from the measured geometry report"
    );
    assert_eq!(Some(via.routes), budget.authored_via.routes);
    assert_eq!(Some(via.via_points), budget.authored_via.via_points);
    assert_eq!(
        Some(via.route_segments),
        budget.authored_via.route_segments,
        "the routed segment count must come from measured geometry"
    );
    assert!(
        via.route_segments >= budget.authored_via.minimum_route_segments,
        "the authored-via route lost enough legs to expose repeated mask scans"
    );
    assert!(
        via.stats.endpoint_mask_evaluations > 0,
        "the authored-via fixture must exercise real endpoint-mask candidate work"
    );
    assert!(
        via.stats.endpoint_clearance_evaluations > 0,
        "the authored-via fixture must exercise final segment clearance work"
    );
    assert!(
        via.stats.astar_expanded_states > 0,
        "the authored-via fixture must exercise A*"
    );
    assert!(
        via.stats.masked_astar_expanded_states > 0,
        "the authored-via fixture must exercise A* while its endpoint mask is active"
    );
    let baseline = budget
        .authored_via
        .baseline
        .expect("measured authored-via budget needs per-counter baselines");
    let ceiling = budget
        .authored_via
        .ceiling
        .expect("measured authored-via budget needs per-counter ceilings");
    assert_eq!(
        via.stats, baseline,
        "authored-via logical work changed from the recorded deterministic baseline"
    );
    assert_stats_below_ceiling(via.stats, baseline, ceiling);
    let total_baseline = budget
        .authored_via
        .total_baseline
        .expect("measured authored-via budget needs a total baseline");
    let total_ceiling = budget
        .authored_via
        .total_ceiling
        .expect("measured authored-via budget needs a total ceiling");
    assert_eq!(
        total_baseline,
        baseline.total(),
        "authored-via total baseline must sum additive work counters only"
    );
    assert_eq!(
        total_ceiling,
        plus_25_percent(total_baseline),
        "authored-via total ceiling must be its measured baseline plus 25%"
    );
    assert_eq!(via.total, total_baseline);
    assert!(via.total <= total_ceiling);

    println!("ENGINE_E2_WORK {}", serde_json::to_string(&first).unwrap());
}
