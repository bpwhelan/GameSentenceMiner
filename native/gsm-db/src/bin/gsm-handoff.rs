//! Runs inside the per-user Windows installer before it writes any application files.
use gsm_db::{backup, Result};
use gsm_settings::paths::{
    default_base_dir, installed, normalize_data_dir, pointer_file_path, same_directory,
};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn save_file(source: &Path, target: &Path) -> Result<()> {
    if source.try_exists()? {
        fs::create_dir_all(target.parent().ok_or("Missing backup directory")?)?;
        fs::copy(source, target)?;
        fs::OpenOptions::new()
            .write(true)
            .open(target)?
            .sync_all()?;
    }
    Ok(())
}

fn prepare(pointer: &Path, default: &Path, from: &str, to: &str) -> Result<PathBuf> {
    // Read both generations of pointer without performing the normal first-launch repair.
    let legacy = default.join("data_dir.json");
    let effective = if pointer.try_exists()? {
        pointer
    } else {
        &legacy
    };
    let settings = gsm_settings::read_object(effective)?;
    if effective.try_exists()? {
        normalize_data_dir(
            settings["dataDir"]
                .as_str()
                .ok_or("Invalid GSM data directory pointer")?,
        )?;
    }
    let active = installed(pointer, default, false)?;
    let parent = active.join("backup/electron-handoff");
    fs::create_dir_all(&parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".pending-")
        .tempdir_in(&parent)?;
    let stage = staging.path();
    save_file(pointer, &stage.join("bootstrap/data_dir.json"))?;
    save_file(&legacy, &stage.join("legacy/data_dir.json"))?;
    for name in [
        "config.json",
        "electron/config.json",
        "owocr_config_gsm.ini",
    ] {
        save_file(&active.join(name), &stage.join(name))?;
    }
    let db = active.join("gsm.db");
    if db.try_exists()? {
        backup::snapshot(&db, &stage.join("gsm.db"))?;
    }
    let previous = match settings.get("legacyDatabaseDir").and_then(|v| v.as_str()) {
        Some(raw) => Some(normalize_data_dir(raw)?),
        None if effective == legacy => Some(default.to_owned()),
        None => None,
    };
    if let Some(other) = &previous {
        let source = other.join("gsm.db");
        if !same_directory(other, &active) && source.try_exists()? {
            backup::snapshot(&source, &stage.join("legacy-gsm.db"))?;
        }
    }
    gsm_settings::write_atomic(
        &stage.join("snapshot.json"),
        &json!({
            "sourceVersion": from, "targetVersion": to, "dataDir": active,
            "pointer": pointer, "legacyPointer": legacy, "legacyDatabaseDir": previous
        }),
    )?;
    let name = stage
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Missing backup name")?;
    let complete = parent.join(format!(
        "{}-{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        name.trim_start_matches(".pending-")
    ));
    fs::rename(stage, &complete)?;
    Ok(complete)
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let [from, to, install, electron] = args.as_slice() else {
        return Err("Expected versions and application locations".into());
    };
    let install = fs::canonicalize(install)?;
    let electron = Path::new(electron);
    if electron.is_file() {
        let original = fs::canonicalize(electron.parent().ok_or("Missing Electron directory")?)?;
        if install.starts_with(&original) || original.starts_with(&install) {
            return Err("Choose a Tauri installation folder separate from Electron.".into());
        }
    }
    #[cfg(windows)]
    {
        // Check only processes with the identity of the previous desktop. Never terminate them.
        let shell = PathBuf::from(std::env::var_os("SystemRoot").ok_or("Missing SystemRoot")?)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let status = std::process::Command::new(shell)
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "for ($i=0; $i -lt 20; $i++) { if (!(Get-Process -Name GameSentenceMiner -ErrorAction SilentlyContinue)) { exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1"])
            .status()?;
        if !status.success() {
            return Err("Exit GameSentenceMiner from its tray menu and retry.".into());
        }
    }
    let location = prepare(&pointer_file_path()?, &default_base_dir()?, from, to)?;
    println!("{}", location.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn preserves_wal_settings_and_both_generations_of_location() {
        let temp = tempfile::tempdir().unwrap();
        let default = temp.path().join("default");
        let active = temp.path().join("ゲーム data");
        let pointer = temp.path().join("bootstrap/data_dir.json");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&default).unwrap();
        let legacy = default.join("data_dir.json");
        fs::write(&legacy, json!({"dataDir":active}).to_string()).unwrap();
        fs::write(active.join("config.json"), b"original").unwrap();
        let db = Connection::open(default.join("gsm.db")).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode=WAL; CREATE TABLE marker(n); INSERT INTO marker VALUES(42)",
        )
        .unwrap();
        let saved = prepare(&pointer, &default, "1", "2").unwrap();
        assert!(!pointer.exists());
        assert_eq!(
            fs::read(saved.join("legacy/data_dir.json")).unwrap(),
            fs::read(legacy).unwrap()
        );
        let copy = Connection::open(saved.join("legacy-gsm.db")).unwrap();
        assert_eq!(
            copy.query_row("SELECT n FROM marker", [], |r| r.get::<_, i32>(0))
                .unwrap(),
            42
        );
        fs::write(active.join("config.json"), b"later").unwrap();
        gsm_settings::write_atomic(&pointer, &json!({"version":2,"dataDir":active})).unwrap();
        let retry = prepare(&pointer, &default, "1", "2").unwrap();
        assert_ne!(saved, retry);
        assert_eq!(fs::read(saved.join("config.json")).unwrap(), b"original");
        assert_eq!(fs::read(retry.join("config.json")).unwrap(), b"later");
        assert!(retry.join("bootstrap/data_dir.json").is_file());
    }

    #[test]
    fn corrupt_database_never_publishes_a_partial_snapshot() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("gsm.db"), b"damaged").unwrap();
        assert!(prepare(&root.path().join("pointer.json"), root.path(), "1", "2").is_err());
        assert_eq!(
            fs::read_dir(root.path().join("backup/electron-handoff"))
                .unwrap()
                .count(),
            0
        );
    }
}
