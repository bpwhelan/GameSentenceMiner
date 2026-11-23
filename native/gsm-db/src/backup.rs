//! Verified online snapshots including committed WAL pages.
use crate::Result;
use flate2::{write::GzEncoder, Compression};
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use std::{fs::File, io, path::Path, time::Duration};

#[derive(Debug)]
pub struct IntegrityError(String);

impl std::fmt::Display for IntegrityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SQLite integrity check failed: {}", self.0)
    }
}

impl std::error::Error for IntegrityError {}

pub fn snapshot(source: &Path, destination: &Path) -> Result<()> {
    let parent = destination.parent().ok_or("Missing backup directory")?;
    let temporary = tempfile::NamedTempFile::new_in(parent)?;
    stage(source, &temporary)?;
    publish(temporary, destination)
}

pub fn compressed_snapshot(source: &Path, destination: &Path) -> Result<()> {
    let parent = destination.parent().ok_or("Missing backup directory")?;
    let temporary = tempfile::NamedTempFile::new_in(parent)?;
    copy_verified(source, temporary.path())?;
    let compressed = tempfile::NamedTempFile::new_in(parent)?;
    let mut encoder = GzEncoder::new(compressed.as_file(), Compression::fast());
    io::copy(&mut File::open(temporary.path())?, &mut encoder)?;
    encoder.finish()?;
    compressed.as_file().sync_all()?;
    publish(compressed, destination)
}

fn copy_verified(source: &Path, private_file: &Path) -> Result<()> {
    let mut source = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    source.busy_timeout(Duration::from_secs(5))?;
    let snapshot = source.transaction()?;
    let mut out = Connection::open(private_file)?;
    // This intermediate is private and disposable. Only the verified artifact
    // must survive a power failure.
    out.execute_batch("PRAGMA synchronous=OFF")?;
    {
        let backup = Backup::new(&snapshot, &mut out)?;
        let mut last_progress = std::time::Instant::now();
        loop {
            match backup.step(512)? {
                StepResult::Done => break,
                StepResult::More => last_progress = std::time::Instant::now(),
                _ if last_progress.elapsed() < Duration::from_secs(30) => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                _ => return Err("SQLite backup remained busy for 30 seconds".into()),
            }
        }
    }
    snapshot.commit()?;
    let message: String = out.query_row("PRAGMA quick_check(1)", [], |r| r.get(0))?;
    if message != "ok" {
        return Err(IntegrityError(message).into());
    }
    out.close().map_err(|(_, e)| e)?;
    Ok(())
}

pub(super) fn stage(source: &Path, temporary: &tempfile::NamedTempFile) -> Result<()> {
    copy_verified(source, temporary.path())?;
    Ok(temporary.as_file().sync_all()?)
}

/// Publish a verified, flushed snapshot from the destination directory.
pub fn publish(temporary: tempfile::NamedTempFile, destination: &Path) -> Result<()> {
    Ok(gsm_settings::publish_flushed(&temporary.into_temp_path(), destination)?)
}

pub(super) fn sync_directory(_directory: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(_directory)?.sync_all()?;
    Ok(())
}
