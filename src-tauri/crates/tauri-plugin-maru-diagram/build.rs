const COMMANDS: &[&str] = &["validate", "render_png", "render_svg"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
