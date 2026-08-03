fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(maru_lib::run_cli(args));
}
