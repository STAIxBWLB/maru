//! Deterministic logical work, available only to tests/corpus tooling. Counters
//! are scoped to the current thread, so parallel tests cannot contaminate them.
use serde::{Deserialize, Serialize};
use std::cell::Cell;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkStats {
    pub astar_expanded_states: u64,
    pub route_evaluations: u64,
    pub constraint_evaluations: u64,
    #[serde(default)]
    pub endpoint_mask_evaluations: u64,
}
impl WorkStats {
    pub fn total(self) -> u64 {
        self.astar_expanded_states.checked_add(self.route_evaluations)
            .and_then(|n|n.checked_add(self.constraint_evaluations))
            .and_then(|n|n.checked_add(self.endpoint_mask_evaluations))
            .expect("logical work total overflowed; reduce the measured fixture before recording a new budget")
    }
}
thread_local! {
    static ACTIVE:Cell<Option<WorkStats>>=const { Cell::new(None) };
}
fn increment(update: impl FnOnce(&mut WorkStats)) {
    ACTIVE.with(|state| {
        if let Some(mut value) = state.get() {
            update(&mut value);
            state.set(Some(value));
        }
    });
}
fn next(value: u64) -> u64 {
    value.checked_add(1).expect("logical work counter overflowed; reduce the measured fixture before recording a new budget")
}
pub(crate) fn record_astar_expansion() {
    increment(|s| s.astar_expanded_states = next(s.astar_expanded_states));
}
pub(crate) fn record_route_evaluation() {
    increment(|s| s.route_evaluations = next(s.route_evaluations));
}
pub(crate) fn record_constraint_evaluation() {
    increment(|s| s.constraint_evaluations = next(s.constraint_evaluations));
}
/// One candidate evaluated while deriving or checking the authored endpoint
/// node/label mask. Count candidates, not routes, so repeated scans remain visible.
pub(crate) fn record_endpoint_mask_evaluation() {
    increment(|s| s.endpoint_mask_evaluations = next(s.endpoint_mask_evaluations));
}
struct Reset;
impl Drop for Reset {
    fn drop(&mut self) {
        ACTIVE.with(|s| s.set(None));
    }
}
pub fn capture<T>(run: impl FnOnce() -> T) -> (T, WorkStats) {
    ACTIVE.with(|s| {
        assert!(
            s.get().is_none(),
            "work capture is already active; finish the outer capture before starting another"
        );
        s.set(Some(WorkStats::default()));
    });
    let reset = Reset;
    let result = run();
    let stats = ACTIVE.with(|s| {
        s.get()
            .expect("active work capture disappeared; keep counter scope on the same thread")
    });
    drop(reset);
    (result, stats)
}
pub const BENCHMARK_SPEC: &str = include_str!("../testdata/bench-1000.json");
pub const AUTHORED_VIA_BENCHMARK_SPEC: &str = include_str!("../testdata/bench-authored-via.json");
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkWork {
    pub fixture_sha256: String,
    pub nodes: usize,
    pub routes: usize,
    pub stats: WorkStats,
    pub total: u64,
    pub via_benchmark_work: ViaBenchmarkWork,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViaBenchmarkWork {
    pub fixture_sha256: String,
    pub nodes: usize,
    pub labels: usize,
    pub routes: usize,
    pub via_points: usize,
    pub route_segments: usize,
    pub stats: WorkStats,
    pub total: u64,
}
pub fn authored_via_benchmark_work() -> ViaBenchmarkWork {
    let spec: serde_json::Value = serde_json::from_str(AUTHORED_VIA_BENCHMARK_SPEC)
        .expect("authored-via work fixture must be checked-in JSON");
    let via_points = spec["connections"][0]["via"]
        .as_array()
        .expect("authored-via fixture must contain one connection with a via array")
        .len();
    let first_via = &spec["connections"][0]["via"][0];
    let endpoint_anchor = crate::layout::point(
        first_via[0]
            .as_f64()
            .expect("first endpoint-mask via x must be numeric"),
        first_via[1]
            .as_f64()
            .expect("first endpoint-mask via y must be numeric"),
    )
    .expect("first endpoint-mask via point must be in fixed-point range");
    let input = serde_json::json!({"specJson":AUTHORED_VIA_BENCHMARK_SPEC}).to_string();
    let (report, stats) = capture(|| crate::layout::layout_json(&input));
    assert!(
        report.ok,
        "the authored-via work fixture was refused: {:?}; keep the measured route and node/label scene accepted",
        report.diagnostics
    );
    let geometry = report.geometry.expect(
        "accepted authored-via layout omitted geometry; restore the report contract before measuring work",
    );
    assert_eq!(
        geometry.nodes.len(),
        26,
        "restore the 26-node mask-work scene"
    );
    assert_eq!(geometry.routes.len(), 1, "keep one measured authored route");
    assert!(
        via_points >= 12,
        "keep enough authored vias to expose repeated scans"
    );
    let source = geometry
        .nodes
        .iter()
        .find(|node| node.id == "a")
        .expect("authored-via fixture needs its source node");
    assert!(
        source.bounds.contains(endpoint_anchor).unwrap_or(false),
        "the first via must activate its source-node endpoint mask"
    );
    assert!(
        geometry.routes[0].points.contains(&endpoint_anchor),
        "the route must retain the mask-activating authored via"
    );
    assert!(
        geometry
            .labels
            .iter()
            .all(|label| !label.bounds.contains(endpoint_anchor).unwrap_or(true)),
        "the mask-activating via must stay outside visible label bounds"
    );
    let route_segments = geometry.routes[0].points.len().saturating_sub(1);
    assert!(
        route_segments >= 10,
        "authored-via fixture needs enough orthogonal legs to expose repeated mask scans"
    );
    assert!(
        stats.endpoint_mask_evaluations > 0,
        "authored-via route did not exercise endpoint node/label mask work"
    );
    ViaBenchmarkWork {
        fixture_sha256: crate::spec_hash(AUTHORED_VIA_BENCHMARK_SPEC),
        nodes: geometry.nodes.len(),
        labels: geometry.labels.len(),
        routes: geometry.routes.len(),
        via_points,
        route_segments,
        stats,
        total: stats.total(),
    }
}
pub fn benchmark_work() -> BenchmarkWork {
    let input = serde_json::json!({"specJson":BENCHMARK_SPEC}).to_string();
    let (report, stats) = capture(|| crate::layout::layout_json(&input));
    assert!(
        report.ok,
        "the work fixture was refused: {:?}; repair layout validity before measuring its work",
        report.diagnostics
    );
    let geometry = report.geometry.expect(
        "successful layout omitted geometry; repair the report contract before measuring work",
    );
    assert_eq!(
        geometry.nodes.len(),
        1000,
        "restore all 1000 nodes before measuring the work gate"
    );
    assert_eq!(
        geometry.routes.len(),
        999,
        "restore all 999 routes before measuring the work gate"
    );
    assert!(geometry.routes.iter().all(|r|r.points.len()>=2&&r.points.windows(2).all(|p|p[0].x==p[1].x||p[0].y==p[1].y)),
        "the work fixture lost routed orthogonal geometry; repair routing before measuring its work");
    let via_benchmark_work = authored_via_benchmark_work();
    BenchmarkWork {
        fixture_sha256: crate::spec_hash(BENCHMARK_SPEC),
        nodes: geometry.nodes.len(),
        routes: geometry.routes.len(),
        stats,
        total: stats.total(),
        via_benchmark_work,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captures_are_isolated_and_restore_after_unwinding() {
        let (_, first) = capture(|| {
            record_route_evaluation();
            record_constraint_evaluation();
            record_endpoint_mask_evaluation();
        });
        assert_eq!(first.route_evaluations, 1);
        assert_eq!(first.constraint_evaluations, 1);
        assert_eq!(first.endpoint_mask_evaluations, 1);
        assert_eq!(first.total(), 3);
        let _ = std::panic::catch_unwind(|| {
            capture(|| {
                record_route_evaluation();
                panic!("fixture unwind")
            })
        });
        let (_, empty) = capture(|| {});
        assert_eq!(empty, WorkStats::default());
        let from_thread = std::thread::spawn(|| capture(record_route_evaluation).1)
            .join()
            .unwrap();
        assert_eq!(from_thread.route_evaluations, 1);
        assert_eq!(capture(|| {}).1, WorkStats::default());
    }
}
