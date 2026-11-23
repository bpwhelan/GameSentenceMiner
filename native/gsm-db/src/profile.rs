//! Profile database files. Recovery runs before the first desktop database handle opens.
use crate::{backup, Result};
use chrono::{Local, NaiveDate};
use gsm_settings::paths::{
    is_legacy_database_migration_pending, normalize_data_dir, same_directory,
};
use rusqlite::{Connection, TransactionBehavior};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, ErrorKind, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tempfile::{Builder, NamedTempFile};

pub fn recover_legacy_database(pointer: &Path, selected: &Path, portable: bool) -> Result<bool> {
    if !is_legacy_database_migration_pending(pointer, selected, portable)? {
        return Ok(false);
    }
    // Standalone and earlier GSM releases use this SQLite lock before opening gsm.db.
    let mut lock = Connection::open(pointer.with_file_name("database-migration.lock"))?;
    lock.busy_timeout(Duration::from_secs(30))?;
    let tx = lock.transaction_with_behavior(TransactionBehavior::Exclusive)?;
    let recovered = gsm_settings::with_lock(pointer, || {
        let mut doc = gsm_settings::read_object(pointer)?;
        let Some(source) = doc["legacyDatabaseDir"].as_str().filter(|s| !s.is_empty()) else {
            return Ok(false);
        };
        let target = normalize_data_dir(doc["dataDir"].as_str().ok_or("Invalid dataDir")?)?;
        if !same_directory(&target, selected) {
            return Ok(false);
        }
        let source_dir = normalize_data_dir(source)?;
        if !same_directory(&source_dir, &target) {
            let source_file = source_dir.join("gsm.db");
            if source_file.try_exists().map_err(|e| e.to_string())? {
                replace_from_legacy(&source_file, &target)
                    .map_err(|e| format!("Recovering {}: {e}", source_file.display()))?;
            }
        }
        doc.as_object_mut()
            .expect("read_object")
            .remove("legacyDatabaseDir");
        gsm_settings::write_atomic(pointer, &doc)?;
        Ok(true)
    })?;
    tx.commit()?;
    Ok(recovered)
}

fn replace_from_legacy(source: &Path, directory: &Path) -> Result<()> {
    fs::create_dir_all(directory)?;
    let stage = NamedTempFile::new_in(directory)?;
    backup::stage(source, &stage)?;
    let mut existing = Vec::with_capacity(4);
    for name in ["gsm.db", "gsm.db-wal", "gsm.db-shm", "gsm.db-journal"] {
        if directory.join(name).try_exists()? {
            existing.push(name);
        }
    }
    if !existing.is_empty() {
        let parent = directory.join("backup/data-directory-migration");
        fs::create_dir_all(&parent)?;
        let archive = Builder::new().prefix("").tempdir_in(&parent)?;
        // Copy every previous file, even a damaged DB, before unlinking sidecars.
        for name in &existing {
            let path = archive.path().join(name);
            let mut prior = File::open(directory.join(name))?;
            let mut saved = File::create(path)?;
            io::copy(&mut prior, &mut saved)?;
            saved.set_modified(prior.metadata()?.modified()?)?;
            saved.sync_all()?;
        }
        backup::sync_directory(archive.path())?;
        let _archive_path = archive.keep();
        backup::sync_directory(&parent)?;
        for name in existing.into_iter().filter(|name| *name != "gsm.db") {
            fs::remove_file(directory.join(name))?;
        }
    }
    backup::publish(stage, &directory.join("gsm.db"))
}

/// Each caller owns a distinct artifact, including simultaneous Settings ZIP exports.
pub fn manual_backup(source: &Path) -> Result<(PathBuf, String)> {
    let directory = source
        .parent()
        .ok_or("Missing database directory")?
        .join("backup");
    fs::create_dir_all(&directory)?;
    let stamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let mut staged = NamedTempFile::new_in(&directory)?;
    backup::stage(source, &staged)?;
    for i in 0.. {
        let suffix = if i == 0 {
            String::new()
        } else {
            format!("_{i}")
        };
        let path = directory.join(format!("gsm_backup_{stamp}{suffix}.db"));
        match staged.persist_noclobber(&path) {
            Ok(_) => {
                backup::sync_directory(&directory)?;
                return Ok((path, stamp));
            }
            Err(e) if e.error.kind() == ErrorKind::AlreadyExists => staged = e.file,
            Err(e) => return Err(e.error.into()),
        }
    }
    unreachable!()
}

struct BackupLock(PathBuf);
impl Drop for BackupLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn legacy_lock(directory: &Path) -> io::Result<Option<BackupLock>> {
    let path = directory.join(".gsm_backup.lock");
    let create = || OpenOptions::new().write(true).create_new(true).open(&path);
    let mut file = match create() {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            // Preserve the six-hour abandoned-lock recovery of older GSM versions.
            let stale = fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > Duration::from_secs(6 * 3600));
            if !stale || fs::remove_file(&path).is_err() {
                return Ok(None);
            }
            match create() {
                Ok(file) => file,
                Err(e) if e.kind() == ErrorKind::AlreadyExists => return Ok(None),
                Err(e) => return Err(e),
            }
        }
        Err(e) => return Err(e),
    };
    let guard = BackupLock(path);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    write!(file, "{} {now}", std::process::id())?;
    Ok(Some(guard))
}

pub fn daily_backup(
    source: &Path,
    directory: &Path,
    day: NaiveDate,
    keep: usize,
) -> Result<Option<PathBuf>> {
    if !source.try_exists()? {
        return Ok(None);
    }
    fs::create_dir_all(directory)?;
    // A native snapshot can take longer than the old sentinel's expiry.
    // Keep native contenders out until publication and pruning have finished.
    let mutex = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join(".gsm_backup.guard"))?;
    match mutex.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Ok(None),
        Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
    }
    let Some(_lock) = legacy_lock(directory)? else {
        return Ok(None);
    };
    let path = directory.join(format!("gsm_{day}.db.gz"));
    let created = if path.try_exists()? {
        None
    } else {
        backup::compressed_snapshot(source, &path)?;
        Some(path)
    };
    let mut backups = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        if !name
            .to_str()
            .is_some_and(|n| n.starts_with("gsm_") && n.ends_with(".db.gz"))
        {
            continue;
        }
        let meta = entry.metadata()?;
        if meta.is_file() {
            backups.push((meta.modified()?, entry.path()));
        }
    }
    backups.sort_unstable_by(|a, b| b.cmp(a));
    for (_, old) in backups.into_iter().skip(keep.max(1)) {
        if let Err(e) = fs::remove_file(&old) {
            eprintln!(
                "Could not remove old database backup {}: {e}",
                old.display()
            );
        }
    }
    Ok(created)
}
