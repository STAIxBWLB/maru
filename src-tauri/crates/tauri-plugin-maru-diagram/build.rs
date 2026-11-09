const COMMANDS: &[&str] = &["validate", "render_png"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
