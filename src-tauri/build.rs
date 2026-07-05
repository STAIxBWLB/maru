fn main() {
    // include_dir!("../skills") output is not invalidated by cargo on its own;
    // without this, release builds can embed a stale skills snapshot.
    println!("cargo:rerun-if-changed=../skills");
    tauri_build::build()
}
