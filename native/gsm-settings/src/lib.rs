//! Native persistence boundary. Existing mining profiles keep their schema;
//! workspace edits patch only the selected section, without migrating profiles.
pub mod gsm_config;
pub mod notifications;
pub mod onboarding;
pub mod paths;
pub mod preferences;
pub mod profiles;
pub mod runtime_state;
pub mod workspace;
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
pub type Result<T> = std::result::Result<T, String>;

pub fn read_object(path: &Path) -> Result<Value> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
                .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
            if !value.is_object() {
                return Err(format!("Expected an object in {}", path.display()));
            }
            Ok(value)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("Cannot read {}: {e}", path.display())),
    }
}

/// Writers use a separate lock file because atomic replacement changes the
/// document's file identity. The lock covers the entire read/modify/write.
pub fn with_lock<T>(path: &Path, action: impl FnOnce() -> Result<T>) -> Result<T> {
    fs::create_dir_all(path.parent().ok_or("Missing parent directory")?)
        .map_err(|e| e.to_string())?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("json.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    action()
}

/// Publish complete, flushed bytes without deleting the old destination first.
pub fn write_atomic(path: &Path, value: &Value) -> Result<()> {
    let directory = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let temporary = directory.join(format!(".settings-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        replace(&temporary, path)?;
        #[cfg(unix)]
        fs::File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to).map_err(|e| e.to_string())
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
