fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(anchor_lib::run_cli(args));
}
