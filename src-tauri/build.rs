fn main() {
    // include_dir!("skills-bootstrap") output is not invalidated by cargo on
    // its own; without this, release builds can embed a stale bootstrap
    // snapshot. The live skills tree no longer lives in this repo — it ships
    // as signed skills-channel bundles from STAIxBWLB/skills; refresh the
    // snapshot with `make skills-bootstrap-refresh` at release time.
    println!("cargo:rerun-if-changed=skills-bootstrap");
    tauri_build::build()
}
