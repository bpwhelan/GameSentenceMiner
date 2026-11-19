use gsm_settings::{read_object, with_lock, write_atomic, Result};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
pub const SENTINELS: &[&str] = &[
    "luna_builds/LunaHook32.dll",
    "luna_builds/LunaHook64.dll",
    "luna_builds/LunaHost32.dll",
    "luna_builds/LunaHost64.dll",
    "luna_builds/LunaHostCLI32.exe",
    "luna_builds/LunaHostCLI64.exe",
    "textractor_builds/_x64/TextractorCLI.exe",
    "textractor_builds/_x64/texthook.dll",
    "textractor_builds/_x64/LoaderDll.dll",
    "textractor_builds/_x64/LocaleEmulator.dll",
    "textractor_builds/_x86/TextractorCLI.exe",
    "textractor_builds/_x86/texthook.dll",
    "textractor_builds/_x86/LoaderDll.dll",
    "textractor_builds/_x86/LocaleEmulator.dll",
];
#[derive(Clone)]
pub struct Engines {
    pub root: PathBuf,
    pub base_url: String,
}
#[derive(Clone)]
pub struct Prepared {
    pub directory: PathBuf,
    pub manifest: Value,
    pub allow_downgrade: bool,
}
fn valid_hash(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
}
fn package(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.starts_with("packages/")
            && s.len() == 41
            && s[9..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    })
}
pub fn validate_manifest(value: &Value) -> Result<Value> {
    let version = value["version"].as_str().ok_or("Missing package version")?;
    if semver::Version::parse(version)
        .map_err(|e| e.to_string())?
        .to_string()
        != version
    {
        return Err("Invalid package version".into());
    }
    let files = value["files"].as_array().ok_or("Missing package files")?;
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for file in files {
        let name = file["path"].as_str().ok_or("Missing file path")?;
        if !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
            || name
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == ".." || s.ends_with('.'))
            || !(name == "NOTICE.md"
                || name.starts_with("luna_builds/")
                || name.starts_with("textractor_builds/"))
            || !seen.insert(name.to_lowercase())
            || !valid_hash(&file["sha256"])
        {
            return Err("Unsafe path, duplicate file or invalid SHA-256".into());
        }
        normalized
            .push(json!({"path":name,"sha256":file["sha256"].as_str().unwrap().to_lowercase()}));
    }
    if !SENTINELS.iter().all(|s| seen.contains(&s.to_lowercase())) {
        return Err("Required engine files missing".into());
    }
    let mut result = json!({"version":version,"files":normalized});
    if !value["archive"].is_null() {
        let archive = &value["archive"];
        if !valid_hash(&archive["sha256"])
            || !(archive["path"] == "texthook.zip"
                || archive["path"] == format!("versions/{version}/texthook.zip"))
        {
            return Err("Invalid archive path or SHA-256".into());
        }
        result["archive"] = json!({"path":archive["path"],"sha256":archive["sha256"].as_str().unwrap().to_lowercase()});
    }
    for key in ["notes", "engineVersions"] {
        if !value[key].is_null() {
            result[key] = value[key].clone();
        }
    }
    Ok(result)
}
pub fn catalog(value: Value) -> Result<Value> {
    if value["schemaVersion"] != 2 {
        return Err("Expected hook catalog schema 2".into());
    }
    let mut releases = Vec::new();
    let mut seen = HashSet::new();
    for item in value["releases"].as_array().ok_or("Missing releases")? {
        let manifest = validate_manifest(item)?;
        let version = manifest["version"].as_str().unwrap();
        if !seen.insert(version.to_owned())
            || manifest["archive"]["path"] != format!("versions/{version}/texthook.zip")
        {
            return Err("Duplicate version or mutable archive in catalog".into());
        }
        releases.push(manifest);
    }
    if !seen.contains(value["recommendedVersion"].as_str().unwrap_or("")) {
        return Err("Recommended engine version missing".into());
    }
    releases.sort_by(|a, b| {
        semver::Version::parse(b["version"].as_str().unwrap())
            .unwrap()
            .cmp(&semver::Version::parse(a["version"].as_str().unwrap()).unwrap())
    });
    Ok(
        json!({"schemaVersion":2,"recommendedVersion":value["recommendedVersion"],"releases":releases}),
    )
}
fn newer(a: &Value, b: &Value) -> bool {
    a.as_str()
        .and_then(|s| semver::Version::parse(s).ok())
        .zip(b.as_str().and_then(|s| semver::Version::parse(s).ok()))
        .is_some_and(|(a, b)| a > b)
}
impl Engines {
    pub fn new(shared: &Path) -> Self {
        Self {
            root: shared.join("texthook"),
            base_url: "https://r2.gamesentenceminer.com/texthook/zip".into(),
        }
    }
    fn pointer(&self) -> PathBuf {
        self.root.join("texthook_manifest.json")
    }
    pub fn local(&self) -> Option<Value> {
        let raw = read_object(&self.pointer()).ok()?;
        let mut value = validate_manifest(&raw).ok()?;
        for key in ["packageDirectory", "previousPackageDirectory"] {
            if !raw[key].is_null() {
                if !package(&raw[key]) {
                    return None;
                }
                value[key] = raw[key].clone();
            }
        }
        Some(value)
    }
    pub fn runtime_dir(&self) -> PathBuf {
        self.local()
            .and_then(|v| v["packageDirectory"].as_str().map(|s| self.root.join(s)))
            .unwrap_or(self.root.clone())
    }
    pub fn installed(&self) -> bool {
        let root = self.runtime_dir();
        self.local()
            .map(|v| {
                v["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|f| root.join(f["path"].as_str().unwrap()).is_file())
            })
            .unwrap_or_else(|| SENTINELS.iter().all(|s| root.join(s).is_file()))
    }
    pub fn local_status(&self) -> Value {
        json!({"installed":self.installed(),"version":self.local().map(|v|v["version"].clone()),"remoteVersion":null,"updateAvailable":false})
    }
    pub fn remote(&self) -> Result<Value> {
        let origin = format!("{}/texthook_manifest_v2.json", self.base_url);
        match crate::fetch_json(&origin).and_then(catalog) {
            Ok(value) => Ok(value),
            Err(error) => {
                let mut last = error;
                // This mutable index remains authoritative on its existing
                // origin. Validate the mirror before accepting it as a backup.
                for url in crate::downloads::sources(&origin, None).into_iter().filter(|url| url != &origin) {
                    match crate::fetch_json(&url).and_then(catalog) {
                        Ok(value) => return Ok(value),
                        Err(error) => last = error,
                    }
                }
                Err(last)
            }
        }
    }
    pub fn status(&self) -> Value {
        let mut status = self.local_status();
        if let Ok(catalog) = self.remote() {
            status["remoteVersion"] = catalog["recommendedVersion"].clone();
            status["updateAvailable"] = json!(
                status["installed"] == true && newer(&status["remoteVersion"], &status["version"])
            );
            status["availableVersions"] = Value::Array(
                catalog["releases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| {
                        let mut r = json!({"version":v["version"]});
                        for key in ["notes", "engineVersions"] {
                            if !v[key].is_null() {
                                r[key] = v[key].clone();
                            }
                        }
                        r
                    })
                    .collect(),
            );
        }
        status
    }
    pub fn prepare(&self, selected: Option<&str>, event: &dyn Fn(&str, Value)) -> Result<Prepared> {
        let local = self.local();
        let catalog = self.remote()?;
        let releases = catalog["releases"].as_array().unwrap();
        let repair = local
            .as_ref()
            .filter(|_| !self.installed())
            .and_then(|v| v["version"].as_str())
            .filter(|version| releases.iter().any(|r| r["version"] == *version));
        let version = selected
            .or(repair)
            .unwrap_or(catalog["recommendedVersion"].as_str().unwrap());
        let manifest = releases
            .iter()
            .find(|r| r["version"] == version)
            .ok_or("Requested package unavailable")?
            .clone();
        if selected.is_none()
            && local
                .as_ref()
                .is_some_and(|l| newer(&l["version"], &manifest["version"]))
        {
            return Err("Refusing automatic engine downgrade".into());
        }
        let prepared = Prepared {
            directory: self
                .root
                .join("packages")
                .join(uuid::Uuid::new_v4().simple().to_string()),
            manifest,
            allow_downgrade: selected.is_some(),
        };
        fs::create_dir_all(&prepared.directory).map_err(|e| e.to_string())?;
        let result = (|| {
            let archive = &prepared.manifest["archive"];
            let name = archive["path"].as_str().unwrap();
            let zip = prepared.directory.join("texthook.zip");
            crate::download(
                &format!("{}/{name}", self.base_url),
                &zip,
                archive["sha256"].as_str(),
                &|bytes, total| {
                    event(
                        "progress",
                        json!({"file":name,"fileIndex":0,"totalFiles":1,"bytesDownloaded":bytes,"bytesTotal":total}),
                    )
                },
            )?;
            event("verifying", Value::Null);
            let expected = prepared.manifest["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["path"].as_str().unwrap().to_owned())
                .collect();
            crate::extract(&zip, &prepared.directory, Some(&expected))?;
            fs::remove_file(zip).map_err(|e| e.to_string())?;
            self.verify(&prepared)?;
            write_atomic(
                &prepared.directory.join("texthook_manifest.json"),
                &prepared.manifest,
            )?;
            Ok(())
        })();
        if let Err(e) = result {
            let _ = self.discard(&prepared);
            return Err(e);
        }
        Ok(prepared)
    }
    fn assert_directory(&self, path: &Path) -> Result<()> {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Invalid package directory")?;
        if path.parent() != Some(self.root.join("packages").as_path())
            || !package(&json!(format!("packages/{name}")))
        {
            return Err("Invalid package directory".into());
        }
        // Never follow a substituted directory outside the owned package tree.
        if path.exists()
            && (fs::symlink_metadata(path)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
                || path.canonicalize().map_err(|e| e.to_string())?.parent()
                    != Some(
                        self.root
                            .join("packages")
                            .canonicalize()
                            .map_err(|e| e.to_string())?
                            .as_path(),
                    ))
        {
            return Err("Package path is a link".into());
        }
        Ok(())
    }
    fn verify(&self, p: &Prepared) -> Result<()> {
        self.assert_directory(&p.directory)?;
        let manifest = validate_manifest(&p.manifest)?;
        for file in manifest["files"].as_array().unwrap() {
            let path = p.directory.join(file["path"].as_str().unwrap());
            if crate::hash(&path)? != file["sha256"].as_str().unwrap() {
                return Err(format!("Engine file SHA-256 mismatch: {}", path.display()));
            }
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub fn activate(&self, p: &Prepared) -> Result<()> {
        with_lock(&self.pointer(), || {
            self.verify(p)?;
            let local = self.local();
            if !p.allow_downgrade
                && local
                    .as_ref()
                    .is_some_and(|v| newer(&v["version"], &p.manifest["version"]))
            {
                return Err("Refusing engine downgrade during activation".into());
            }
            let mut next = validate_manifest(&p.manifest)?;
            if !next["archive"].is_null() {
                next["archive"]["path"] = json!("texthook.zip");
            }
            next["packageDirectory"] = json!(format!(
                "packages/{}",
                p.directory.file_name().unwrap().to_string_lossy()
            ));
            if let Some(local) = local {
                if !local["packageDirectory"].is_null() {
                    next["previousPackageDirectory"] = local["packageDirectory"].clone();
                }
                write_atomic(&self.root.join("texthook_manifest.previous.json"), &local)?;
            }
            write_atomic(&self.pointer(), &next)
        })
    }
    pub fn discard(&self, p: &Prepared) -> Result<()> {
        with_lock(&self.pointer(), || {
            self.assert_directory(&p.directory)?;
            let local = self.local();
            if self.runtime_dir() != p.directory
                && !local
                    .as_ref()
                    .and_then(|v| v["previousPackageDirectory"].as_str())
                    .is_some_and(|s| self.root.join(s) == p.directory)
                && p.directory.exists()
            {
                fs::remove_dir_all(&p.directory).map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    }
}
