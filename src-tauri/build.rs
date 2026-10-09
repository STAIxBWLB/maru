fn main() {
    // include_dir!("skills-bootstrap") output is not invalidated by cargo on
    // its own; without this, release builds can embed a stale bootstrap
    // snapshot. The live skills tree no longer lives in this repo — it ships
    // as signed skills-channel bundles from STAIxBWLB/skills; refresh the
    // snapshot with `make skills-bootstrap-refresh` at release time.
    println!("cargo:rerun-if-changed=skills-bootstrap");
    // Tauri embeds its manifest in the desktop binary, but the libtest harness
    // also links the dialog plugin's TaskDialogIndirect (Comctl32 v6). Give
    // every MSVC-linked target that activation context, including unit tests.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rerun-if-changed=windows-common-controls.manifest");
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-common-controls.manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        // Tauri already owns resource 1 in the desktop executable. Keep its
        // application manifest authoritative; the extra dependency manifest
        // is only selected as resource 1 by the standalone libtest harness.
        println!("cargo:rustc-link-arg-bin=maru=/MANIFEST:EMBED,ID=2");
    }
    tauri_build::build()
}
