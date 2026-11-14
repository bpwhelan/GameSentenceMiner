#![cfg(feature = "runtime")]
use serde_json::json;
use std::path::Path;

#[test]
fn native_bridge_reports_invalid_context_without_node() {
    let result = gsm_agent::wine_bridge::resolve(Path::new(env!("CARGO_BIN_EXE_gsm-agent-host")), &json!({"exeName":"fixture.exe"}), || false);
    assert!(result.unwrap_err().contains("Missing Wine launch context"));
}

#[test]
fn cancelling_native_bridge_releases_the_owned_helper() {
    let started = std::time::Instant::now();
    let result = gsm_agent::wine_bridge::resolve(Path::new(env!("CARGO_BIN_EXE_gsm-agent-host")), &json!({"exeName":"fixture.exe"}), || true);
    assert!(result.unwrap_err().contains("cancelled"));
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}
