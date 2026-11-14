fn main() {
    std::process::exit(gsm_agent::host::entry().unwrap_or(2));
}
