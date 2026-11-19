//! Give unsigned Windows development builds a stable notification-area identity.
//! Only the desktop gets a stable copy. Helpers stay in their immutable builds
//! because detached game hooks can legitimately outlive the desktop.
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

const FILES: [&str; 3] = [
    "gsm-desktop.exe",
    "agent-runtime.json",
    "gsm_overlay_server.exe",
];

fn stable_directory(executable: &Path, root: &Path, arch: &str) -> Option<PathBuf> {
    let builds = root
        .join("src-tauri/target/desktop-runs")
        .canonicalize()
        .ok()?;
    let source = executable.parent()?;
    let prefix = format!("win32-{arch}-");
    let hash = source.file_name()?.to_str()?.strip_prefix(&prefix)?;
    if source.parent()? != builds
        || hash.len() != 20
        || !hash.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    Some(builds.join(format!("{prefix}current")))
}

fn prepare(source: &Path, destination: &Path) -> io::Result<PathBuf> {
    let executable = destination.join(FILES[0]);
    let marker = destination.join("build-source.txt");
    let identity = source.to_string_lossy();
    // Validate the whole build before replacing anything. Publish its identity last
    // so an interrupted copy is retried, never mistaken for a completed update.
    for name in FILES {
        if !source.join(name).is_file() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("Missing build file: {name}"),
            ));
        }
    }
    if fs::read_to_string(&marker).ok().as_deref() == Some(identity.as_ref())
        && executable.is_file()
    {
        return Ok(executable);
    }
    let staged = destination.join(format!("{}.next", FILES[0]));
    fs::copy(source.join(FILES[0]), &staged)?;
    let previous_identity = fs::read(&marker).ok();
    if marker.exists() {
        fs::remove_file(&marker)?;
    }
    // Replace only the desktop. Windows refuses this while the old app runs.
    // A detached helper must never block replacing the desktop or be terminated
    // just to install a development build.
    if let Err(error) = fs::rename(staged, &executable) {
        if let Some(identity) = previous_identity {
            fs::write(&marker, identity)?;
        }
        return Err(error);
    }
    fs::write(marker, identity.as_bytes())?;
    Ok(executable)
}

pub fn helper_path(executable: &Path, name: &str) -> Result<PathBuf, String> {
    let directory = executable
        .parent()
        .ok_or("Desktop has no parent directory")?;
    let directory_name = directory
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    let Some(arch) = directory_name
        .strip_prefix("win32-")
        .and_then(|v| v.strip_suffix("-current"))
    else {
        return Ok(executable.with_file_name(name));
    };
    let directory = directory.canonicalize().map_err(|e| e.to_string())?;
    let source = fs::read_to_string(directory.join("build-source.txt"))
        .map_err(|e| format!("Cannot locate this desktop build's helpers: {e}"))?;
    let source = PathBuf::from(source)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let prefix = format!("win32-{arch}-");
    let hash = source
        .file_name()
        .and_then(|v| v.to_str())
        .and_then(|v| v.strip_prefix(&prefix));
    if source.parent() != directory.parent()
        || !hash.is_some_and(|v| v.len() == 20 && v.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("Invalid development helper build directory".into());
    }
    let helper = source.join(name);
    if !helper.is_file() {
        return Err(format!("Missing development helper: {}", helper.display()));
    }
    Ok(helper)
}

pub fn bootstrap(args: &[String]) -> Result<Option<i32>, String> {
    // Smoke runs own isolated profiles and must coexist with the user's desktop.
    // Keep their immutable executable instead of replacing its stable launch copy.
    if std::env::var_os("GSM_SMOKE_TEST").is_some() {
        return Ok(None);
    }
    let Some(root) = crate::app_root_override() else {
        return Ok(None);
    };
    let executable = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        arch => arch,
    };
    let Some(destination) = stable_directory(&executable, &root, arch) else {
        return Ok(None);
    };
    fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(destination.join("launch.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    let stable = prepare(executable.parent().unwrap(), &destination)
        .map_err(|e| format!("Cannot update the stable GSM launch copy. Close other development GSM instances and retry: {e}"))?;
    let mut command = Command::new(stable);
    command.args(crate::game_privileges::clean_relaunch_args(&args[1..]));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    // Keep npm start's lifetime/exit status, but don't hold the update lock while
    // the desktop runs. A second launch of the same build can reach single-instance handling.
    drop(lock);
    Ok(Some(
        child.wait().map_err(|e| e.to_string())?.code().unwrap_or(1),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(base: &Path, hash: &str, content: &str) -> PathBuf {
        let path = base.join(format!("win32-x64-{hash}"));
        fs::create_dir_all(&path).unwrap();
        for name in FILES {
            fs::write(path.join(name), content).unwrap();
        }
        path.canonicalize().unwrap()
    }

    #[test]
    fn builds_share_a_launch_path_and_update_matching_helpers() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("src-tauri/target/desktop-runs");
        let first = build(&base, "01234567890123456789", "first");
        let second = build(&base, "abcdef01234567890123", "second");
        let destination = stable_directory(&first.join(FILES[0]), temp.path(), "x64").unwrap();
        assert_eq!(
            Some(destination.clone()),
            stable_directory(&second.join(FILES[0]), temp.path(), "x64")
        );
        fs::create_dir_all(&destination).unwrap();
        let executable = prepare(&first, &destination).unwrap();
        assert_eq!(prepare(&second, &destination).unwrap(), executable);
        assert_eq!(fs::read_to_string(&executable).unwrap(), "second");
        for name in &FILES[1..] {
            assert_eq!(helper_path(&executable, name).unwrap(), second.join(name));
            assert_eq!(fs::read_to_string(second.join(name)).unwrap(), "second");
            assert!(!destination.join(name).exists());
        }
        assert!(stable_directory(&executable, temp.path(), "x64").is_none());
        assert!(stable_directory(&first.join(FILES[0]), temp.path(), "arm64").is_none());
    }

    #[test]
    fn incomplete_build_does_not_replace_the_previous_launch_copy() {
        let temp = tempfile::tempdir().unwrap();
        let first = build(temp.path(), "01234567890123456789", "first");
        let second = build(temp.path(), "abcdef01234567890123", "second");
        let destination = temp.path().join("current");
        fs::create_dir(&destination).unwrap();
        prepare(&first, &destination).unwrap();
        fs::remove_file(second.join(FILES[2])).unwrap();
        assert!(prepare(&second, &destination).is_err());
        assert_eq!(
            fs::read_to_string(destination.join(FILES[0])).unwrap(),
            "first"
        );
    }

    #[test]
    #[cfg(windows)]
    fn detached_helper_cannot_block_a_new_desktop_build() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("src-tauri/target/desktop-runs");
        let first = build(&base, "01234567890123456789", "first");
        let second = build(&base, "abcdef01234567890123", "second");
        let destination = stable_directory(&first.join(FILES[0]), temp.path(), "x64").unwrap();
        fs::create_dir(&destination).unwrap();
        prepare(&first, &destination).unwrap();
        // Simulate a detached helper left by the previous launcher implementation.
        fs::copy(first.join(FILES[1]), destination.join(FILES[1])).unwrap();
        let running_helper = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(destination.join(FILES[1]))
            .unwrap();
        let desktop = prepare(&second, &destination).unwrap();
        assert_eq!(fs::read_to_string(&desktop).unwrap(), "second");
        assert_eq!(
            fs::read_to_string(destination.join(FILES[1])).unwrap(),
            "first"
        );
        assert_eq!(
            helper_path(&desktop, FILES[1]).unwrap(),
            second.join(FILES[1])
        );
        drop(running_helper);
    }

    #[test]
    #[cfg(windows)]
    fn running_build_is_reusable_but_cannot_be_overwritten() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let first = build(temp.path(), "01234567890123456789", "first");
        let second = build(temp.path(), "abcdef01234567890123", "second");
        let destination = temp.path().join("current");
        fs::create_dir(&destination).unwrap();
        let executable = prepare(&first, &destination).unwrap();
        let running = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&executable)
            .unwrap();
        assert_eq!(prepare(&first, &destination).unwrap(), executable);
        assert!(prepare(&second, &destination).is_err());
        assert_eq!(prepare(&first, &destination).unwrap(), executable);
        assert_eq!(fs::read_to_string(&executable).unwrap(), "first");
        assert_eq!(
            fs::read_to_string(destination.join("build-source.txt")).unwrap(),
            first.to_string_lossy()
        );
        drop(running);
        prepare(&second, &destination).unwrap();
        assert_eq!(fs::read_to_string(executable).unwrap(), "second");
    }

    #[test]
    fn helper_resolution_requires_the_matching_build_for_stable_launches() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("src-tauri/target/desktop-runs");
        let source = build(&base, "01234567890123456789", "first");
        // Cargo, immutable smoke builds and other ordinary launches use siblings.
        assert_eq!(
            helper_path(&source.join(FILES[0]), FILES[1]).unwrap(),
            source.join(FILES[1])
        );
        let stable = stable_directory(&source.join(FILES[0]), temp.path(), "x64").unwrap();
        fs::create_dir(&stable).unwrap();
        let desktop = prepare(&source, &stable).unwrap();
        fs::remove_file(source.join(FILES[1])).unwrap();
        assert!(helper_path(&desktop, FILES[1]).is_err());
        fs::write(
            stable.join("build-source.txt"),
            temp.path().to_string_lossy().as_bytes(),
        )
        .unwrap();
        assert!(helper_path(&desktop, FILES[1]).is_err());
        fs::remove_file(stable.join("build-source.txt")).unwrap();
        assert!(helper_path(&desktop, FILES[1]).is_err());
    }
}
