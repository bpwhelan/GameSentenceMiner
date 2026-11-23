use serde_json::json;
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

const MARKER: &str = ".gsm-venv-retired.json";

fn metadata(path: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

/// Record when Tauri stopped using the managed environment. Keep it runnable
/// from its original path so an Electron rollback can still use it.
pub fn mark_retired(shared_data: &Path, desktop_version: &str, marked_at: &str) -> io::Result<()> {
    let venv = shared_data.join("python_venv");
    let Some(directory) = metadata(&venv)? else {
        return Ok(());
    };
    if !directory.is_dir() || is_link(&directory) {
        return Ok(());
    }
    let marker = venv.join(MARKER);
    let cfg = venv.join("pyvenv.cfg");
    if metadata(&marker)?.is_some()
        || !metadata(&cfg)?.is_some_and(|file| file.is_file() && !is_link(&file))
    {
        return Ok(());
    }
    let config = fs::read_to_string(&cfg)?;
    let python_version = config.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        let value = value.trim();
        (matches!(key.trim(), "version" | "version_info") && !value.is_empty()).then_some(value)
    });

    let mut temporary = tempfile::NamedTempFile::new_in(&venv)?;
    serde_json::to_writer_pretty(
        &mut temporary,
        &json!({
            "schemaVersion": 1,
            "markedAt": marked_at,
            "desktopVersion": desktop_version,
            "pythonVersion": python_version
        }),
    )?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    match temporary.persist_noclobber(marker) {
        Ok(_) => Ok(()),
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_the_existing_environment_once_without_moving_it() {
        let data = tempfile::tempdir().unwrap();
        let venv = data.path().join("python_venv");
        fs::create_dir(&venv).unwrap();
        let config = venv.join("pyvenv.cfg");
        let original = "home = somewhere\nversion_info = 3.13.2\n";
        fs::write(&config, original).unwrap();

        mark_retired(data.path(), "2026.11.0", "2026-11-23T18:00:00Z").unwrap();
        mark_retired(data.path(), "2026.12.0", "2026-12-01T18:00:00Z").unwrap();

        let marker = fs::read(venv.join(MARKER)).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&marker).unwrap(),
            json!({
                "schemaVersion": 1,
                "markedAt": "2026-11-23T18:00:00Z",
                "desktopVersion": "2026.11.0",
                "pythonVersion": "3.13.2"
            })
        );
        assert_eq!(fs::read_to_string(config).unwrap(), original);
    }

    #[test]
    fn leaves_clean_installs_and_unrecognized_directories_alone() {
        let data = tempfile::tempdir().unwrap();
        let venv = data.path().join("python_venv");
        mark_retired(data.path(), "2026.11.0", "2026-11-23T18:00:00Z").unwrap();
        assert!(!venv.exists());

        fs::create_dir(&venv).unwrap();
        mark_retired(data.path(), "2026.11.0", "2026-11-23T18:00:00Z").unwrap();
        assert!(!venv.join(MARKER).exists());
    }

    #[cfg(unix)]
    #[test]
    fn skips_linked_environments() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("pyvenv.cfg"), "version = 3.13.2\n").unwrap();
        std::os::unix::fs::symlink(outside.path(), data.path().join("python_venv")).unwrap();

        mark_retired(data.path(), "2026.11.0", "2026-11-23T18:00:00Z").unwrap();

        assert!(!outside.path().join(MARKER).exists());
    }
}
