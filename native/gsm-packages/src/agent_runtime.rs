//! On-demand Agent / Frida runtime, shared with the other text-hook downloads.
//! The desktop ships a pinned manifest; verified immutable packages survive app
//! updates and profile switches. Never replace a helper used by a detached game.
use gsm_settings::{read_object, with_lock, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

pub const FRIDA_VERSION: &str = "17.16.4";
pub const HOST_PROTOCOL: u32 = 2;
const LICENSES: &[&str] = &[
    "licenses/NOTICE.md",
    "licenses/FRIDA-COPYING",
    "licenses/COPYING.LIB",
];

pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub frida_version: String,
    pub host_protocol: u32,
    pub platform: String,
    pub archive: Archive,
    pub files: Vec<RuntimeFile>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Archive {
    pub url: String,
    pub sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RuntimeFile {
    pub path: String,
    pub sha256: String,
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
impl Manifest {
    pub fn read(path: &Path) -> Result<Self> {
        let manifest: Self = serde_json::from_value(read_object(path)?)
            .map_err(|e| format!("Invalid Agent runtime manifest: {e}"))?;
        manifest.validate()?;
        Ok(manifest)
    }
    pub fn executable_name(&self) -> &'static str {
        if self.platform.starts_with("win32-") {
            "gsm-agent-host.exe"
        } else {
            "gsm-agent-host"
        }
    }
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1
            || self.host_protocol != HOST_PROTOCOL
            || self.frida_version != FRIDA_VERSION
            || self.platform != platform()
        {
            return Err(
                "Agent runtime does not match this desktop's platform or Frida version".into(),
            );
        }
        let prefix = "https://github.com/bpwhelan/GameSentenceMiner/releases/download/v";
        let release = self
            .archive
            .url
            .strip_prefix(prefix)
            .ok_or("Invalid Agent runtime download URL")?;
        let (version, filename) = release
            .split_once('/')
            .ok_or("Missing Agent runtime release")?;
        semver::Version::parse(version).map_err(|_| "Invalid Agent runtime release version")?;
        if !valid_hash(&self.archive.sha256)
            || filename
                != format!(
                    "gsm-agent-runtime-{}-{}.zip",
                    self.platform, self.archive.sha256
                )
        {
            return Err("Invalid Agent runtime archive name or checksum".into());
        }
        let expected: HashSet<_> = LICENSES
            .iter()
            .copied()
            .chain([self.executable_name()])
            .collect();
        let mut seen = HashSet::new();
        for file in &self.files {
            if !expected.contains(file.path.as_str())
                || !seen.insert(file.path.as_str())
                || !valid_hash(&file.sha256)
            {
                return Err("Invalid Agent runtime file or checksum".into());
            }
        }
        if seen != expected {
            return Err("Agent runtime executable or licenses missing".into());
        }
        Ok(())
    }
    fn verify(&self, directory: &Path) -> Result<()> {
        if fs::symlink_metadata(directory)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Agent runtime directory is a link".into());
        }
        for file in &self.files {
            let path = directory.join(&file.path);
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if !metadata.is_file() || crate::hash(&path)? != file.sha256 {
                return Err(format!(
                    "Agent runtime file checksum mismatch: {}",
                    file.path
                ));
            }
        }
        Ok(())
    }
}

pub struct AgentRuntime {
    root: PathBuf,
}
impl AgentRuntime {
    pub fn new(shared: &Path) -> Self {
        Self {
            root: shared.join("texthook/frida"),
        }
    }
    pub fn is_cached(&self, manifest: &Manifest) -> bool {
        if manifest.validate().is_err() {
            return false;
        }
        let destination = self
            .root
            .join(&manifest.frida_version)
            .join(&manifest.platform)
            .join(&manifest.archive.sha256);
        manifest.verify(&destination).is_ok()
    }
    /// Development/offline staging follows exactly the same verification and
    /// shared-cache path, without requiring an unpublished build on GitHub.
    pub fn ensure_from_archive(&self, manifest: &Manifest, archive: &Path) -> Result<PathBuf> {
        self.ensure_with(manifest, |destination| {
            fs::copy(archive, destination)
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
    }
    pub fn ensure(
        &self,
        manifest: &Manifest,
        progress: &dyn Fn(u64, Option<u64>),
    ) -> Result<PathBuf> {
        self.ensure_with(manifest, |archive| {
            crate::download(
                &manifest.archive.url,
                archive,
                Some(&manifest.archive.sha256),
                progress,
            )
        })
        .map_err(|e| {
            format!("Could not prepare Agent / Frida. Check your connection and retry: {e}")
        })
    }
    fn ensure_with(
        &self,
        manifest: &Manifest,
        download: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<PathBuf> {
        manifest.validate()?;
        let root = self
            .root
            .join(&manifest.frida_version)
            .join(&manifest.platform);
        // Lock per archive across processes/profiles. A valid cache needs no network.
        with_lock(
            &root.join(format!("{}.json", manifest.archive.sha256)),
            || {
                let destination = root.join(&manifest.archive.sha256);
                if manifest.verify(&destination).is_ok() {
                    return Ok(destination.join(manifest.executable_name()));
                }
                let stage = root.join(format!(".install-{}", uuid::Uuid::new_v4()));
                fs::create_dir(&stage).map_err(|e| e.to_string())?;
                let result = (|| {
                    let archive = stage.join("runtime.zip");
                    download(&archive)?;
                    if crate::hash(&archive)? != manifest.archive.sha256 {
                        return Err("Agent runtime archive checksum mismatch".into());
                    }
                    let expected = manifest
                        .files
                        .iter()
                        .map(|file| file.path.clone())
                        .collect();
                    crate::extract(&archive, &stage, Some(&expected))?;
                    fs::remove_file(&archive).map_err(|e| e.to_string())?;
                    manifest.verify(&stage)?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(
                            stage.join(manifest.executable_name()),
                            fs::Permissions::from_mode(0o755),
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    if destination.exists() {
                        // Preserve broken generations too: Windows may still have a
                        // detached helper open. Never overwrite or kill that process.
                        fs::rename(
                            &destination,
                            root.join(format!(".invalid-{}", uuid::Uuid::new_v4())),
                        )
                        .map_err(|e| {
                            format!("Close the old Agent session before repairing its runtime: {e}")
                        })?;
                    }
                    fs::rename(&stage, &destination).map_err(|e| e.to_string())?;
                    Ok(destination.join(manifest.executable_name()))
                })();
                // Only this invocation's freshly-created staging directory is removed.
                let _ = fs::remove_dir_all(stage);
                result
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        io::{Cursor, Write},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };
    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }
    fn fixture() -> (Manifest, Vec<u8>) {
        let mut manifest = Manifest {
            schema_version: 1,
            frida_version: FRIDA_VERSION.into(),
            host_protocol: HOST_PROTOCOL,
            platform: platform(),
            archive: Archive {
                url: String::new(),
                sha256: String::new(),
            },
            files: vec![],
        };
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for name in LICENSES.iter().copied().chain([manifest.executable_name()]) {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(name.as_bytes()).unwrap();
            manifest.files.push(RuntimeFile {
                path: name.into(),
                sha256: digest(name.as_bytes()),
            });
        }
        let bytes = zip.finish().unwrap().into_inner();
        manifest.archive.sha256 = digest(&bytes);
        manifest.archive.url = format!("https://github.com/bpwhelan/GameSentenceMiner/releases/download/v2026.11.0/gsm-agent-runtime-{}-{}.zip", platform(), manifest.archive.sha256);
        (manifest, bytes)
    }
    #[test]
    fn caches_offline_across_desktop_versions_and_repairs_tampering() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = AgentRuntime::new(dir.path());
        let (mut manifest, bytes) = fixture();
        let install = || {
            runtime
                .ensure_with(&manifest, |path| {
                    fs::write(path, &bytes).map_err(|e| e.to_string())
                })
                .unwrap()
        };
        assert!(!runtime.is_cached(&manifest));
        let executable = install();
        assert!(runtime.is_cached(&manifest));
        assert!(executable.starts_with(dir.path().join("texthook/frida")));
        fs::write(&executable, b"corrupt").unwrap();
        assert!(!runtime.is_cached(&manifest));
        assert_eq!(install(), executable);
        assert!(runtime.is_cached(&manifest));
        manifest.archive.url = manifest.archive.url.replace("v2026.11.0/", "v2026.12.0/");
        assert_eq!(
            runtime
                .ensure_with(&manifest, |_| panic!("cached runtime must work offline"))
                .unwrap(),
            executable
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(
                fs::metadata(executable).unwrap().permissions().mode() & 0o111,
                0
            );
        }
    }
    #[test]
    fn rejects_bad_download_and_per_file_hash_without_publishing() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = AgentRuntime::new(dir.path());
        let (mut manifest, bytes) = fixture();
        assert!(runtime
            .ensure_with(&manifest, |p| fs::write(p, b"partial")
                .map_err(|e| e.to_string()))
            .is_err());
        manifest.files[0].sha256 = "0".repeat(64);
        assert!(runtime
            .ensure_with(&manifest, |p| fs::write(p, &bytes)
                .map_err(|e| e.to_string()))
            .is_err());
        let root = runtime.root.join(FRIDA_VERSION).join(platform());
        assert!(!root.join(&manifest.archive.sha256).exists());
        assert!(!fs::read_dir(root).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".install-")));
    }
    #[test]
    fn concurrent_profiles_only_download_once() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = AgentRuntime::new(dir.path());
        let (manifest, bytes) = fixture();
        let downloads = Arc::new(AtomicUsize::new(0));
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        runtime
                            .ensure_with(&manifest, |path| {
                                downloads.fetch_add(1, Ordering::SeqCst);
                                fs::write(path, &bytes).map_err(|e| e.to_string())
                            })
                            .unwrap()
                    })
                })
                .collect();
            let paths: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
            assert!(paths.iter().all(|p| p == &paths[0]));
        });
        assert_eq!(downloads.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn rejects_wrong_platform_version_protocol_and_unsafe_manifest() {
        let (manifest, _) = fixture();
        for change in 0..7 {
            let mut invalid = manifest.clone();
            match change {
                0 => invalid.platform = "other".into(),
                1 => invalid.frida_version = "0.0.0".into(),
                2 => invalid.host_protocol += 1,
                3 => invalid.files[0].path = "../escape".into(),
                4 => invalid.archive.url = "http://example.com/runtime.zip".into(),
                5 => {
                    invalid.files.pop();
                }
                _ => invalid.files.push(invalid.files[0].clone()),
            }
            assert!(invalid.validate().is_err());
        }
    }
}
