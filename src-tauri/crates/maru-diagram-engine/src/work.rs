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
    #[serde(default)]
    pub endpoint_clearance_evaluations: u64,
    /// Subset of A* expansions performed by a leg carrying active endpoint masks.
    /// This proof counter is not added again to `total`.
    #[serde(default)]
    pub masked_astar_expanded_states: u64,
}
impl WorkStats {
    pub fn total(self) -> u64 {
        self.astar_expanded_states.checked_add(self.route_evaluations)
            .and_then(|n|n.checked_add(self.constraint_evaluations))
            .and_then(|n|n.checked_add(self.endpoint_mask_evaluations))
            .and_then(|n|n.checked_add(self.endpoint_clearance_evaluations))
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
pub(crate) fn record_masked_astar_expansion() {
    increment(|s| s.masked_astar_expanded_states = next(s.masked_astar_expanded_states));
}
pub(crate) fn record_route_evaluation() {
    increment(|s| s.route_evaluations = next(s.route_evaluations));
}
pub(crate) fn record_constraint_evaluation() {
    increment(|s| s.constraint_evaluations = next(s.constraint_evaluations));
}
/// One candidate evaluated while deriving the authored endpoint
/// node/label mask. Count candidates, not routes, so repeated scans remain visible.
pub(crate) fn record_endpoint_mask_evaluation() {
    increment(|s| s.endpoint_mask_evaluations = next(s.endpoint_mask_evaluations));
}
/// One node/label candidate in a final authored-via segment clearance scan.
pub(crate) fn record_endpoint_clearance_evaluation() {
    increment(|s| s.endpoint_clearance_evaluations = next(s.endpoint_clearance_evaluations));
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
    let next_via = &spec["connections"][0]["via"][1];
    let blocker_leg_end = crate::layout::point(
        next_via[0]
            .as_f64()
            .expect("second blocker-leg via x must be numeric"),
        next_via[1]
            .as_f64()
            .expect("second blocker-leg via y must be numeric"),
    )
    .expect("second blocker-leg via point must be in fixed-point range");
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
    let source_nodes = spec["components"]
        .as_array()
        .expect("authored-via fixture must contain components")
        .len();
    let source_routes = spec["connections"]
        .as_array()
        .expect("authored-via fixture must contain connections")
        .len();
    assert_eq!(
        geometry.nodes.len(),
        source_nodes,
        "retain every work-fixture component"
    );
    assert_eq!(
        geometry.routes.len(),
        source_routes,
        "retain every authored work-fixture route"
    );
    assert!(
        geometry.labels.len() >= geometry.nodes.len(),
        "retain at least one node label per component"
    );
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
    let source_label = geometry
        .labels
        .iter()
        .find(|label| label.id.as_deref() == Some("node:a:label"))
        .expect("the source endpoint must retain its node label");
    assert!(
        source_label.bounds.x >= source.bounds.x
            && source_label.bounds.y >= source.bounds.y
            && source_label.bounds.right().unwrap() <= source.bounds.right().unwrap()
            && source_label.bounds.bottom().unwrap() <= source.bounds.bottom().unwrap(),
        "the endpoint label must be contained by its node to qualify for masking"
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
    assert!(
        stats.astar_expanded_states > 0,
        "authored-via route did not expand any A* search states"
    );
    assert!(
        stats.masked_astar_expanded_states > 0,
        "no A* expansion was observed while the source endpoint mask was active"
    );
    let route = &geometry.routes[0].points;
    let via_start_index = route
        .iter()
        .position(|point| *point == endpoint_anchor)
        .expect("routed geometry must retain the mask-activating via");
    let via_end_index = route
        .iter()
        .position(|point| *point == blocker_leg_end)
        .expect("routed geometry must retain the second blocker-leg via");
    assert!(via_start_index < via_end_index);
    assert!(
        route[via_start_index..=via_end_index]
            .windows(2)
            .any(|segment| segment[0].y != segment[1].y),
        "the unrelated tag obstacle must force an A* detour between the first two vias"
    );
    // Blank tag lines reserve conservative routing bounds without adding ink.
    // Keep the showcase profile and force a detour long enough for its rhythm
    // rules, rather than relaxing those rules to accommodate a 1-2px bend.
    assert!(
        route[via_start_index..=via_end_index]
            .iter()
            .any(|point| (i64::from(point.y) - i64::from(endpoint_anchor.y)).abs() >= 16 * 64),
        "the masked A* detour must retain the showcase's 16px interior rhythm"
    );
    let blocker = geometry
        .nodes
        .iter()
        .find(|node| node.id == "mask-blocker")
        .expect("authored-via fixture must retain its unrelated blocker");
    assert_eq!(
        endpoint_anchor.y - blocker.bounds.bottom().unwrap(),
        3 * 64,
        "blocker body must stay 3px clear while its label line box blocks routing"
    );
    let blocker_tag = geometry
        .labels
        .iter()
        .find(|label| label.id.as_deref() == Some("node:mask-blocker:tag"))
        .expect("blocker must retain its tag obstacle");
    assert!(
        blocker_tag.bounds.x < blocker_leg_end.x
            && blocker_tag.bounds.right().unwrap() > endpoint_anchor.x
            && blocker_tag.bounds.y < endpoint_anchor.y
            && endpoint_anchor.y - blocker_tag.bounds.bottom().unwrap() < 2 * 64,
        "unrelated tag line box must be within the route's 2px inflated clearance of the direct first-via chord"
    );
    for label in geometry
        .labels
        .iter()
        .filter(|label| label.target_id == blocker.id)
    {
        for glyph in label
            .glyphs
            .iter()
            .filter(|glyph| glyph.ink.width > 0 && glyph.ink.height > 0)
        {
            assert!(
                glyph.ink.x >= blocker.bounds.x
                    && glyph.ink.y >= blocker.bounds.y
                    && glyph.ink.right().unwrap() <= blocker.bounds.right().unwrap()
                    && glyph.ink.bottom().unwrap() <= blocker.bounds.bottom().unwrap(),
                "blocker glyph ink must stay inside its node; its line box alone creates the routing obstacle"
            );
        }
    }
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
            record_astar_expansion();
            record_masked_astar_expansion();
        });
        assert_eq!(first.route_evaluations, 1);
        assert_eq!(first.constraint_evaluations, 1);
        assert_eq!(first.endpoint_mask_evaluations, 1);
        assert_eq!(first.astar_expanded_states, 1);
        assert_eq!(first.masked_astar_expanded_states, 1);
        // Masked A* is a subset of all expansions, so total must not double-count it.
        assert_eq!(first.total(), 4);
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
