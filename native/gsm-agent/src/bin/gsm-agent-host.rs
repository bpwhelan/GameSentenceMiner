#![cfg_attr(windows, windows_subsystem = "windows")]
fn main() {
    if std::env::args().any(|arg| arg == "--gsm-wine-bridge") {
        std::process::exit(gsm_agent::wine_bridge::entry());
    }
    std::process::exit(gsm_agent::host::entry().unwrap_or(2));
}
