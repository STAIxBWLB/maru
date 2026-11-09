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
}
impl WorkStats {
    pub fn total(self) -> u64 {
        self.astar_expanded_states.checked_add(self.route_evaluations)
            .and_then(|n|n.checked_add(self.constraint_evaluations))
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkWork {
    pub fixture_sha256: String,
    pub nodes: usize,
    pub routes: usize,
    pub stats: WorkStats,
    pub total: u64,
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
    BenchmarkWork {
        fixture_sha256: crate::spec_hash(BENCHMARK_SPEC),
        nodes: geometry.nodes.len(),
        routes: geometry.routes.len(),
        stats,
        total: stats.total(),
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
        });
        assert_eq!(first.route_evaluations, 1);
        assert_eq!(first.constraint_evaluations, 1);
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
