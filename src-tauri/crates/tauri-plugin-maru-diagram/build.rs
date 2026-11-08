const COMMANDS: &[&str] = &["validate"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
