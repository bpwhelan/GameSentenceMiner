//! Native persistence for desktop preferences, mining profiles, and game overrides.
pub mod gsm_config;
pub mod mining_scopes;
#[path = "profile_config/editor.rs"]
pub mod profile_editor;
pub mod notifications;
pub mod onboarding;
pub mod paths;
pub mod preferences;
pub mod profiles;
#[cfg(feature = "profile-upgrade")]
pub mod profile_config;
pub mod runtime_state;
pub mod workspace;
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
pub type Result<T> = std::result::Result<T, String>;

static MINING_DEFAULTS: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/mining-defaults.json")).expect("embedded mining defaults")
});

pub fn default_stats() -> &'static Value {
    &MINING_DEFAULTS["stats"]
}

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
        publish_flushed(&temporary, path)
    })();
    let _ = fs::remove_file(temporary);
    result
}

/// Atomically publish a staged file whose contents have already been flushed.
pub fn publish_flushed(from: &Path, to: &Path) -> Result<()> {
    replace(from, to)?;
    #[cfg(unix)]
    fs::File::open(to.parent().ok_or("Missing destination directory")?)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
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
    let source: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // Readers can briefly prevent replacement. Keep the flushed source and
    // the original destination intact between attempts.
    let mut delays = [40, 80, 160, 320, 640].into_iter();
    loop {
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } != 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(5 | 32 | 33)) {
            if let Some(delay) = delays.next() {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                continue;
            }
        }
        return Err(format!("Could not replace {}: {error}", to.display()));
    }
}
