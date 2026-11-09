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
    println!("ENGINE_E2_WORK {}", serde_json::to_string(&first).unwrap());
}
