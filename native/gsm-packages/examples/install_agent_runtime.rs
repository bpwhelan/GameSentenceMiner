//! Verify/install an offline runtime archive into a selected shared data folder.
//! This uses the same manifest, extraction and cache checks as first-use download.
use gsm_packages::agent_runtime::{AgentRuntime, Manifest};
use std::path::PathBuf;

fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if args.len() != 3 {
        return Err("Usage: install_agent_runtime <manifest.json> <runtime.zip> <shared-data>".into());
    }
    let manifest = Manifest::read(&args[0])?;
    let runtime = AgentRuntime::new(&args[2]);
    let first = runtime.ensure_from_archive(&manifest, &args[1])?;
    // A nonexistent archive proves that the second call only reads the cache.
    let reused = runtime.ensure_from_archive(&manifest, &args[2].join("unavailable.zip"))?;
    if first != reused { return Err("Installed runtime was not reused".into()); }
    println!("{}", first.display());
    Ok(())
}
