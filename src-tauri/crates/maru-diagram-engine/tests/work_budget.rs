//! A logical-work ceiling catches algorithmic amplification independently of
//! shared-runner wall-clock load. Each component and the sum have 25% headroom.
#![cfg(feature = "geometry-corpus")]
use maru_diagram_engine::work::{benchmark_work, WorkStats};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Budget {
    schema_version: u32,
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
    fixture_sha256: String,
    nodes: usize,
    minimum_labels: usize,
    routes: usize,
    via_points: usize,
    minimum_route_segments: usize,
    endpoint_mask_passes_per_node_or_label_ceiling: u64,
    total_operations_per_node_segment_ceiling: u64,
}
fn plus_25_percent(value: u64) -> u64 {
    value
        .checked_mul(5)
        .and_then(|n| n.checked_add(3))
        .expect("work ceiling overflowed; reduce the baseline before updating the budget")
        / 4
}
#[test]
fn seeded_thousand_node_work_is_repeatable_and_below_the_reviewed_ceiling() {
    let budget: Budget =
        serde_json::from_str(include_str!("../testdata/work-budget.json")).unwrap();
    assert_eq!(budget.schema_version, 1);
    let first = benchmark_work();
    assert_eq!(first,benchmark_work(),"logical work changed for an unchanged fixture; remove unordered evaluation before updating any ceiling");
    assert_eq!(first.fixture_sha256,budget.fixture_sha256,"the work fixture changed; run geometry-work and deliberately review/update testdata/work-budget.json");
    assert!(first.stats.astar_expanded_states>0&&first.stats.route_evaluations>0&&first.stats.constraint_evaluations>0,"work instrumentation is missing; restore A*, route and constraint counters before recording a budget");
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
    ] {
        assert_eq!(
            ceiling,
            plus_25_percent(baseline),
            "{name}: the checked-in ceiling must be the recorded baseline plus 25%"
        );
        assert!(actual<=ceiling,"{name} work {actual} exceeds checked-in ceiling {ceiling}; inspect the algorithm change, then deliberately remeasure and update testdata/work-budget.json with geometry-work");
    }
    assert_eq!(budget.total_baseline, budget.baseline.total());
    assert_eq!(budget.total_ceiling, plus_25_percent(budget.total_baseline));
    assert!(first.total<=budget.total_ceiling,"total logical work {} exceeds ceiling {}; inspect the change and update testdata/work-budget.json deliberately after remeasurement",first.total,budget.total_ceiling);
    let via = &first.via_benchmark_work;
    assert_eq!(
        via.fixture_sha256, budget.authored_via.fixture_sha256,
        "the authored-via fixture changed; review it and update its work budget deliberately"
    );
    assert_eq!(via.nodes, budget.authored_via.nodes);
    assert!(via.labels >= budget.authored_via.minimum_labels);
    assert_eq!(via.routes, budget.authored_via.routes);
    assert_eq!(via.via_points, budget.authored_via.via_points);
    assert!(
        via.route_segments >= budget.authored_via.minimum_route_segments,
        "the authored-via route lost enough legs to expose repeated mask scans"
    );
    assert!(
        via.stats.endpoint_mask_evaluations > 0,
        "the authored-via fixture must exercise real endpoint-mask candidate work"
    );
    let mask_work_ceiling = u64::try_from(via.nodes + via.labels)
        .unwrap()
        .checked_mul(
            budget
                .authored_via
                .endpoint_mask_passes_per_node_or_label_ceiling,
        )
        .expect("authored-via endpoint-mask ceiling overflowed");
    assert!(
        via.stats.endpoint_mask_evaluations <= mask_work_ceiling,
        "endpoint-mask work {} exceeds the reviewed linear ceiling {mask_work_ceiling}; inspect repeated candidate scans",
        via.stats.endpoint_mask_evaluations
    );
    let total_work_ceiling = u64::try_from(via.nodes)
        .unwrap()
        .checked_mul(u64::try_from(via.route_segments).unwrap())
        .and_then(|n| {
            n.checked_mul(
                budget
                    .authored_via
                    .total_operations_per_node_segment_ceiling,
            )
        })
        .expect("authored-via total work ceiling overflowed");
    assert!(
        via.total <= total_work_ceiling,
        "authored-via total work {} exceeds the reviewed route-node-segment ceiling {total_work_ceiling}",
        via.total
    );
    assert_eq!(
        budget.authored_via.fixture_path,
        "testdata/bench-authored-via.json"
    );
    println!("ENGINE_E2_WORK {}", serde_json::to_string(&first).unwrap());
}
