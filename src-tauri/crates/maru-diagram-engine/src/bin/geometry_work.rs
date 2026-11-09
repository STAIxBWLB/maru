//! Test-only work receipt; the normal geometry WASM omits this module.
fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&maru_diagram_engine::work::benchmark_work())
            .expect("work receipt serialization failed; preserve finite integer counters")
    );
}
