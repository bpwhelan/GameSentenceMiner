//! Install the three Windows OneOCR runtime files without replacing other OCR assets.
use anyhow::{Context, Result, ensure};
use reqwest::Url;
use std::{
    fs::{self, File},
    io::{self, Read, Seek},
    path::{Path, PathBuf},
};

const FILES: [&str; 3] = ["oneocr.dll", "oneocr.onemodel", "onnxruntime.dll"];
const FAMILY: &str = "Microsoft.ScreenSketch_8wekyb3d8bbwe";
const FALLBACK: &str = "https://r2.gamesentenceminer.com/oneocr.zip";
const FALLBACK_SHA: &str = "a9e7758e4b6665834edda2ed42c0175e7af58497b091853add6fb6224c0f6a84";
type Progress<'a> = &'a dyn Fn(u64, Option<u64>);

pub fn directory() -> Result<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|p| PathBuf::from(p).join(".config/oneocr"))
        .context("Cannot determine the OneOCR directory")
}

fn present(path: &Path) -> bool {
    path.metadata().is_ok_and(|m| m.is_file() && m.len() != 0)
}

fn complete(root: &Path) -> bool {
    FILES.iter().all(|name| present(&root.join(name)))
}

fn installed_source() -> Option<PathBuf> {
    use windows::{Management::Deployment::PackageManager, core::HSTRING};
    let packages = PackageManager::new()
        .ok()?
        .FindPackagesByUserSecurityIdPackageFamilyName(&HSTRING::new(), &FAMILY.into())
        .ok()?;
    packages
        .into_iter()
        .filter_map(|pkg| pkg.InstalledPath().ok())
        .map(|p| PathBuf::from(p.to_os_string()).join("SnippingTool"))
        .find(|root| complete(root))
}

fn store_url(markup: &str) -> Option<Url> {
    // The index labels each link with its package filename, including a numeric
    // four-component version. Accept only matching signed-store delivery hosts.
    markup
        .split("<a href=\"")
        .skip(1)
        .filter_map(|entry| {
            let (href, anchor) = entry.split_once('"')?;
            let (_, text) = anchor.split_once('>')?;
            let (filename, _) = text.split_once("</a>")?;
            let version = filename
                .strip_prefix("Microsoft.ScreenSketch_")?
                .split('_')
                .next()?;
            let components: [u32; 4] = version
                .split('.')
                .map(str::parse)
                .collect::<Result<Vec<_>, _>>()
                .ok()?
                .try_into()
                .ok()?;
            if !filename.ends_with("_8wekyb3d8bbwe.msixbundle") {
                return None;
            }
            let mut url = Url::parse(&href.replace("&amp;", "&")).ok()?;
            let host = url.host_str()?;
            if !(host == "delivery.mp.microsoft.com"
                || host.ends_with(".delivery.mp.microsoft.com"))
                || !matches!(url.scheme(), "http" | "https")
                || url.port().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return None;
            }
            url.set_scheme("https").ok()?;
            Some((components, url))
        })
        .max_by_key(|(v, _)| *v)
        .map(|(_, url)| url)
}

fn extract_member<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    member: &str,
    output: &Path,
) -> Result<()> {
    let mut file = zip.by_name(member)?;
    let size = file.size();
    ensure!(
        size > 0 && size <= gsm_downloads::MAX_BYTES,
        "Invalid size of {member}"
    );
    let mut dest = File::create(output)?;
    ensure!(
        io::copy(&mut file.by_ref().take(size + 1), &mut dest)? == size,
        "Incomplete {member}"
    );
    Ok(())
}

fn extract_files(archive: &Path, prefix: &str, root: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(File::open(archive)?)?;
    for name in FILES {
        extract_member(&mut zip, &format!("{prefix}{name}"), &root.join(name))?;
    }
    Ok(())
}

fn extract_bundle(archive: &Path, root: &Path) -> Result<()> {
    let mut bundle = zip::ZipArchive::new(File::open(archive)?)?;
    let suffix = if cfg!(target_arch = "aarch64") {
        "_arm64.msix"
    } else {
        "_x64.msix"
    };
    let package = bundle
        .file_names()
        .find(|n| n.starts_with("SnippingTool") && n.ends_with(suffix))
        .context("OneOCR bundle lacks the desktop architecture")?
        .to_owned();
    let inner = root.join("snippingtool.msix");
    extract_member(&mut bundle, &package, &inner)?;
    extract_files(&inner, "SnippingTool/", root)
}

fn store_bundle(stage: &Path, progress: Progress<'_>) -> Result<()> {
    let response = super::http_client()?
        .post("https://store.rg-adguard.net/api/GetFiles")
        .header("origin", "https://store.rg-adguard.net")
        .header("referer", "https://store.rg-adguard.net/")
        .form(&[("type", "PackageFamilyName"), ("url", FAMILY)])
        .send()?
        .error_for_status()?;
    let mut markup = String::new();
    response.take(4 * 1024 * 1024).read_to_string(&mut markup)?;
    let url = store_url(&markup).context("No Snipping Tool store bundle found")?;
    let path = stage.join("snippingtool.msixbundle");
    gsm_downloads::download(
        url.as_str(),
        &path,
        None,
        gsm_downloads::MAX_BYTES,
        progress,
    )
    .map_err(anyhow::Error::msg)?;
    extract_bundle(&path, stage)
}

fn copy_installed(stage: &Path) -> Result<()> {
    let source = installed_source().context("Snipping Tool runtime is unavailable")?;
    for name in FILES {
        fs::copy(source.join(name), stage.join(name))?;
    }
    Ok(())
}

fn provision(stage: &Path, progress: Progress<'_>) -> Result<()> {
    if copy_installed(stage).is_ok() {
        return Ok(());
    }
    if let Err(store_error) = store_bundle(stage, progress) {
        // The pinned GSM mirror contains x64 binaries. An ARM64 install needs the
        // matching Snipping Tool package, even if x64 emulation is available.
        ensure!(
            !cfg!(target_arch = "aarch64"),
            "Unable to install ARM64 OneOCR: {store_error:#}"
        );
        let path = stage.join("oneocr.zip");
        gsm_downloads::download(
            FALLBACK,
            &path,
            Some(FALLBACK_SHA),
            gsm_downloads::MAX_BYTES,
            progress,
        )
        .map_err(anyhow::Error::msg)
        .with_context(|| {
            format!("Store bundle unavailable ({store_error:#}). Downloading OneOCR mirror")
        })?;
        extract_files(&path, "", stage)?;
    }
    Ok(())
}

fn install(root: &Path, populate: impl FnOnce(&Path) -> Result<()>) -> Result<bool> {
    if complete(root) {
        return Ok(false);
    }
    fs::create_dir_all(root)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join(".install.lock"))?;
    lock.lock()?;
    if complete(root) {
        return Ok(false);
    }
    let stage = tempfile::tempdir_in(root)?;
    populate(stage.path())?;
    ensure!(complete(stage.path()), "Incomplete OneOCR runtime");
    // Publish a missing component last. A failure or crash before its rename
    // leaves the install visibly incomplete, allowing the next startup to repair it.
    let last = FILES
        .into_iter()
        .find(|name| !present(&root.join(name)))
        .context("OneOCR installation changed during repair")?;
    for name in FILES.into_iter().filter(|n| *n != last).chain([last]) {
        fs::rename(stage.path().join(name), root.join(name))?;
    }
    Ok(true)
}

pub fn prepare(root: &Path, progress: Progress<'_>) -> Result<bool> {
    install(root, |stage| provision(stage, progress))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Cursor, Write};

    #[test]
    fn store_bundle_installs_only_runtime_files_from_the_matching_architecture() {
        let dir = tempfile::tempdir().unwrap();
        let mut msix = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for name in FILES {
            msix.start_file(
                format!("SnippingTool/{name}"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            msix.write_all(name.as_bytes()).unwrap();
        }
        let inner = msix.finish().unwrap().into_inner();
        let archive = dir.path().join("store.msixbundle");
        let mut bundle = zip::ZipWriter::new(File::create(&archive).unwrap());
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        bundle
            .start_file(
                format!("SnippingTool_fixture_{arch}.msix"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        bundle.write_all(&inner).unwrap();
        bundle.finish().unwrap();
        let root = dir.path().join("installed");
        assert!(install(&root, |s| extract_bundle(&archive, s)).unwrap());
        assert!(!root.join("snippingtool.msix").exists());
        for name in FILES {
            assert_eq!(fs::read(root.join(name)).unwrap(), name.as_bytes());
        }
    }

    #[test]
    #[ignore = "Driven by scripts/benchmark_oneocr_bootstrap.py on a machine with Snipping Tool"]
    fn benchmark_worker() {
        println!("ready {}", std::process::id());
        for line in std::io::stdin().lock().lines() {
            let (root, count, _): (PathBuf, usize, bool) =
                serde_json::from_str(&line.unwrap()).unwrap();
            let started = std::time::Instant::now();
            let mut installed = false;
            for _ in 0..count {
                installed = install(&root, copy_installed).unwrap();
            }
            println!(
                "{}",
                serde_json::json!({"installed":installed, "ms":started.elapsed().as_secs_f64()*1000.0/count as f64})
            );
        }
    }
    #[test]
    fn selects_newest_store_package_and_rejects_lookalike_hosts() {
        let anchor = |version, host| {
            format!(
                "<a href=\"http://{host}/item?x=1&amp;y={version}\">Microsoft.ScreenSketch_{version}_neutral_~_8wekyb3d8bbwe.msixbundle</a>"
            )
        };
        let page = anchor("11.9.0.0", "tlu.dl.delivery.mp.microsoft.com")
            + &anchor("11.10.0.0", "tlu.dl.delivery.mp.microsoft.com")
            + &anchor("99.0.0.0", "attacker-delivery.mp.microsoft.com");
        assert_eq!(
            store_url(&page).unwrap().as_str(),
            "https://tlu.dl.delivery.mp.microsoft.com/item?x=1&y=11.10.0.0"
        );
    }
    #[test]
    fn broken_archive_preserves_older_files_and_retry_completes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(FILES[0]), b"old").unwrap();
        fs::write(root.join("unrelated"), b"keep").unwrap();
        assert!(
            install(root, |stage| {
                fs::write(stage.join(FILES[0]), b"partial")?;
                Ok(())
            })
            .is_err()
        );
        assert_eq!(fs::read(root.join(FILES[0])).unwrap(), b"old");
        assert!(
            install(root, |stage| {
                for name in FILES {
                    fs::write(stage.join(name), b"new")?;
                }
                Ok(())
            })
            .unwrap()
        );
        assert!(!install(root, |_| panic!("retrieved current bundle")).unwrap());
        assert_eq!(fs::read(root.join("unrelated")).unwrap(), b"keep");
    }
}
