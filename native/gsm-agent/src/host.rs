//! Shared native Agent control protocol.
#[cfg(feature = "runtime")]
pub use crate::server::entry;
use serde_json::Value;
use std::{
    io::{BufRead, Read, Write},
    net::TcpStream,
    path::PathBuf,
};
pub const HOST_ARG: &str = "--gsm-agent-host";
pub const OPTIONS_ARG: &str = "--gsm-agent-host-options";
pub fn metadata_path(base: &str) -> PathBuf {
    PathBuf::from(base).join("texthook/agent-host.json")
}
pub(crate) fn send(socket: &mut TcpStream, value: &Value) -> Result<(), String> {
    writeln!(socket, "{value}").map_err(|e| e.to_string())
}
pub(crate) fn read(reader: &mut impl BufRead) -> Result<Value, String> {
    let mut bytes = Vec::new();
    let size = reader
        .take(32 * 1024 * 1024 + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
    if size == 0 || size > 32 * 1024 * 1024 || bytes.last() != Some(&b'\n') {
        return Err("Agent connection closed or message too large".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
