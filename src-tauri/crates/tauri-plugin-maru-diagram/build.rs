fn main() {
    let mut commands = vec!["validate"];
    if std::env::var_os("CARGO_FEATURE_PNG").is_some() {
        commands.push("render_png");
    }
    if std::env::var_os("CARGO_FEATURE_OUTLINE").is_some() {
        commands.push("render_svg");
    }
    if std::env::var_os("CARGO_FEATURE_RENDER_STORE").is_some() {
        commands.extend([
            "diagram_list_renders",
            "diagram_prepare_render_view",
            "diagram_delete_render",
            "render_and_store",
        ]);
    }
    tauri_plugin::Builder::new(&commands).build();
}
