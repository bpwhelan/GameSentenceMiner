//! Provision the shared Windows media tools, including installs made by older GSM versions.
use gsm_settings::Result;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    time::SystemTime,
};

struct Bundle {
    url: &'static str,
    digest: &'static str,
    bin: &'static str,
    files: &'static str,
}

const X64: Bundle = Bundle {
    url: "https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-full_build-shared.zip",
    digest: "4296b396bdfd5fbc3dfc75ab4c8703354a56963232d65c4182993543df2d2f45",
    bin: "ffmpeg-8.1.1-full_build-shared/bin/",
    files: include_str!("../assets/ffmpeg/x64.sha256"),
};
const ARM64: Bundle = Bundle {
    url: "https://r2.gamesentenceminer.com/ffmpeg-8.0-essentials-shared-win-arm64.zip",
    digest: "e1a0844299abfde1ef9d079dc283fefbe5f880df93da57d8d0a443668fb06e88",
    bin: "ffmpeg-8.0-essentials-shared-win-arm64/bin/",
    files: include_str!("../assets/ffmpeg/arm64.sha256"),
};

struct Entry<'a> {
    name: &'a str,
    size: u64,
    digest: &'a str,
}

impl Bundle {
    fn entries(&self) -> impl Iterator<Item = Entry<'_>> {
        self.files.lines().map(|line| {
            let mut fields = line.split_ascii_whitespace();
            let digest = fields.next().expect("packaged FFmpeg digest");
            let size = fields
                .next()
                .and_then(|n| n.parse().ok())
                .expect("packaged FFmpeg size");
            let name = fields.next().expect("packaged FFmpeg filename");
            Entry { name, size, digest }
        })
    }
}

#[derive(Serialize, Deserialize)]
struct Receipt {
    archive: String,
    modified: Vec<SystemTime>,
}

fn file_times(root: &Path, bundle: &Bundle) -> Option<Vec<SystemTime>> {
    bundle
        .entries()
        .map(|entry| {
            let meta = root.join(entry.name).symlink_metadata().ok()?;
            (meta.is_file() && meta.len() == entry.size)
                .then(|| meta.modified().ok())
                .flatten()
        })
        .collect()
}

fn unpack(archive: &Path, root: &Path, bundle: &Bundle) -> Result<()> {
    let file = File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    fs::create_dir(root).map_err(|e| e.to_string())?;
    // The whitelist names both the archive member and the flat destination. Headers,
    // import libraries, ffplay and documentation never need to be decompressed.
    for entry in bundle.entries() {
        let mut input = zip
            .by_name(&format!("{}{name}", bundle.bin, name = entry.name))
            .map_err(|e| format!("Missing FFmpeg archive entry {}: {e}", entry.name))?;
        if input.size() != entry.size {
            return Err(format!("Unexpected size for {}", entry.name));
        }
        let mut out = File::create_new(root.join(entry.name)).map_err(|e| e.to_string())?;
        if io::copy(&mut input, &mut out).map_err(|e| e.to_string())? != entry.size {
            return Err(format!("Incomplete FFmpeg file {}", entry.name));
        }
    }
    Ok(())
}

fn save_receipt(path: &Path, bundle: &Bundle, modified: Vec<SystemTime>) -> Result<()> {
    let receipt = Receipt {
        archive: bundle.digest.into(),
        modified,
    };
    gsm_settings::write_atomic(
        path,
        &serde_json::to_value(receipt).map_err(|e| e.to_string())?,
    )
}

/// Returns true when a new bundle was installed. An unchanged installation only
/// reads metadata. On a first run after upgrade, validate the old files by content.
fn ensure_with(
    shared: &Path,
    bundle: &Bundle,
    fetch: impl FnOnce(&Path) -> Result<PathBuf>,
) -> Result<bool> {
    let receipt_path = shared.join("ffmpeg-bundle.json");
    gsm_settings::with_lock(&receipt_path, || {
        let root = shared.join("ffmpeg");
        let backup = shared.join(".ffmpeg-rollback");
        // Recover either side of a prior interruption between the two directory renames.
        if backup.exists() {
            if root.exists() {
                fs::remove_dir_all(&backup)
                    .map_err(|e| format!("Removing previous FFmpeg bundle: {e}"))?;
            } else {
                fs::rename(&backup, &root).map_err(|e| format!("Restoring FFmpeg bundle: {e}"))?;
            }
        }
        if let Some(times) = file_times(&root, bundle) {
            let receipt = fs::read(&receipt_path)
                .ok()
                .and_then(|b| serde_json::from_slice::<Receipt>(&b).ok());
            if receipt
                .as_ref()
                .is_some_and(|r| r.archive == bundle.digest && r.modified == times)
            {
                return Ok(false);
            }
            if bundle
                .entries()
                .all(|e| crate::hash(&root.join(e.name)).as_deref() == Ok(e.digest))
            {
                save_receipt(&receipt_path, bundle, times)?;
                return Ok(false);
            }
        }
        let staging = tempfile::tempdir_in(shared).map_err(|e| e.to_string())?;
        let archive = fetch(staging.path())?;
        let install = staging.path().join("bin");
        unpack(&archive, &install, bundle)?;
        let times = file_times(&install, bundle).ok_or("Incomplete staged FFmpeg bundle")?;
        let previous = root.exists();
        if previous {
            fs::rename(&root, &backup)
                .map_err(|e| format!("Preserving previous FFmpeg bundle: {e}"))?;
        }
        if let Err(error) = fs::rename(&install, &root) {
            if previous {
                fs::rename(&backup, &root).map_err(|e| {
                    format!("Installing FFmpeg: {error}. Restoring previous bundle: {e}")
                })?;
            }
            return Err(format!("Installing FFmpeg: {error}"));
        }
        save_receipt(&receipt_path, bundle, times)?;
        if previous {
            fs::remove_dir_all(&backup)
                .map_err(|e| format!("Removing previous FFmpeg bundle: {e}"))?;
        }
        Ok(true)
    })
}

pub fn ensure_windows(shared: &Path, progress: &dyn Fn(u64, Option<u64>)) -> Result<bool> {
    let bundle = if cfg!(target_arch = "aarch64") {
        &ARM64
    } else {
        &X64
    };
    ensure_with(shared, bundle, |stage| {
        let archive = stage.join("bundle.zip");
        crate::download(bundle.url, &archive, Some(bundle.digest), progress)?;
        Ok(archive)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};

    const FIXTURE: Bundle = Bundle {
        url: "",
        digest: "fixture",
        bin: "pkg/bin/",
        files: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  3  ffmpeg.exe\n",
    };

    #[test]
    fn interrupted_upgrade_and_offline_repair() {
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path();
        let old = shared.join(".ffmpeg-rollback");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("ffmpeg.exe"), b"abc").unwrap();
        let offline = |_: &Path| Err("offline".into());
        assert!(!ensure_with(shared, &FIXTURE, offline).unwrap());
        let installed = shared.join("ffmpeg/ffmpeg.exe");
        assert_eq!(fs::read(&installed).unwrap(), b"abc");
        fs::write(&installed, b"damaged").unwrap();
        assert!(ensure_with(shared, &FIXTURE, offline).is_err());
        assert_eq!(fs::read(&installed).unwrap(), b"damaged");
        let archive = shared.join("update.zip");
        let mut zip = zip::ZipWriter::new(File::create(&archive).unwrap());
        zip.start_file(
            "pkg/bin/ffmpeg.exe",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"abc").unwrap();
        zip.start_file(
            "pkg/bin/ffplay.exe",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.finish().unwrap();
        assert!(ensure_with(shared, &FIXTURE, |_| Ok(archive.clone())).unwrap());
        assert!(!shared.join("ffmpeg/ffplay.exe").exists());
        assert_eq!(fs::read(&installed).unwrap(), b"abc");
        assert!(!old.exists());
        assert!(!ensure_with(shared, &FIXTURE, offline).unwrap());
    }

    #[test]
    #[ignore = "Driven by scripts/benchmark_ffmpeg_bootstrap.py with pinned release archives"]
    fn benchmark_worker() {
        println!("ready {}", std::process::id());
        for line in std::io::stdin().lock().lines() {
            let ((shared, archive, arch), count, _): ((PathBuf, PathBuf, String), usize, bool) =
                serde_json::from_str(&line.unwrap()).unwrap();
            let bundle = match arch.as_str() {
                "x64" => &X64,
                "arm64" => &ARM64,
                _ => panic!("unknown architecture"),
            };
            let start = std::time::Instant::now();
            let mut installed = false;
            for _ in 0..count {
                installed = ensure_with(&shared, bundle, |_| Ok(archive.clone())).unwrap();
            }
            println!(
                "{}",
                serde_json::json!({"installed":installed, "ms":start.elapsed().as_secs_f64()*1000.0/count as f64})
            );
        }
    }
}
