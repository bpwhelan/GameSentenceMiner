//! Managed Python installation and package operations. The desktop service
//! only adapts native progress to the remaining installation UI.
mod maintenance;
use gsm_runtime::task::{self, Output};
use gsm_settings::{read_object, with_lock, write_atomic, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

pub const PYTHON_VERSION: &str = "3.13.2";
pub const UV_VERSION: &str = "0.13.4";
const GENERATION: &str = "3:3.13.2";
const SYNC_STAMP: &str = ".gsm-environment-v2.sha256";
pub type Events = Arc<dyn Fn(&str, Value) + Send + Sync>;
pub trait Runner: Send + Sync {
    fn run(
        &self,
        spec: Value,
        env: HashMap<String, String>,
        timeout: Duration,
        events: Events,
    ) -> Result<Output>;
}
struct NativeRunner;
impl Runner for NativeRunner {
    fn run(
        &self,
        spec: Value,
        env: HashMap<String, String>,
        timeout: Duration,
        events: Events,
    ) -> Result<Output> {
        task::run_with_progress(
            spec,
            env,
            vec![],
            timeout,
            64 * 1024 * 1024,
            Arc::new(move |stream, bytes| {
                events(
                    "log",
                    json!({"stream":stream,"message":String::from_utf8_lossy(bytes)}),
                )
            }),
        )
    }
}
pub struct Python {
    pub base: PathBuf,
    pub project: PathBuf,
    pub development: bool,
    runner: Arc<dyn Runner>,
    uv_release: String,
}
pub fn environment() -> HashMap<String, String> {
    let mut env: HashMap<_, _> = std::env::vars()
        .filter(|(key, _)| {
            let key = key.to_ascii_uppercase();
            !key.starts_with("PYTHON")
                && !key.starts_with("PYENV_")
                && !key.starts_with("CONDA_")
                && !key.starts_with("GSM_BROKER_")
                && !matches!(
                    key.as_str(),
                    "TCL_LIBRARY"
                        | "TK_LIBRARY"
                        | "VIRTUAL_ENV"
                        | "GSM_CLIENT_ID"
                        | "POETRY_ACTIVE"
                        | "POETRY_HOME"
                        | "PIPENV_ACTIVE"
                        | "PIP_CONFIG_FILE"
                        | "PIP_REQUIRE_VIRTUALENV"
                )
        })
        .collect();
    env.insert("PYTHONIOENCODING".into(), "utf-8".into());
    env
}
pub fn executable(venv: &Path) -> PathBuf {
    venv.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    })
}
pub fn venv_for(python: &Path) -> Result<PathBuf> {
    Ok(python
        .parent()
        .and_then(Path::parent)
        .ok_or("Invalid Python environment path")?
        .into())
}
pub fn normalized_extras(value: &Value) -> Vec<String> {
    let mut extras = vec![];
    for value in value.as_array().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            let value = value.trim().to_lowercase();
            if !value.is_empty() && !extras.contains(&value) {
                extras.push(value);
            }
        }
    }
    extras
}
fn compatible_version(installed: &str, bundled: &str) -> bool {
    let normalize = |value: &str| {
        let value = value.trim().to_lowercase();
        let alpha = regex::Regex::new(r"-(?:alpha|a)\.(\d+)")
            .unwrap()
            .replace_all(&value, "a$1")
            .into_owned();
        let beta = regex::Regex::new(r"-(?:beta|b)\.(\d+)")
            .unwrap()
            .replace_all(&alpha, "b$1")
            .into_owned();
        regex::Regex::new(r"-rc\.(\d+)")
            .unwrap()
            .replace_all(&beta, "rc$1")
            .into_owned()
    };
    regex::Regex::new(&format!(
        r"^{}(?:\.post\d+)?(?:\+[a-z0-9.-]+)?$",
        regex::escape(&normalize(bundled))
    ))
    .unwrap()
    .is_match(&normalize(installed))
}
fn stage(events: &Events, id: &str, status: &str, progress: Option<f64>, message: &str) {
    events(
        "stage",
        json!({"stageId":id,"status":status,"progressKind":if progress.is_some(){"estimated"}else{"indeterminate"},"progress":progress,"message":message}),
    );
}
pub fn progress(text: &str, current: f64) -> Option<Value> {
    let ansi = regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap();
    let cleaned = ansi.replace_all(text, "");
    let message = cleaned.lines().rev().find(|s| !s.trim().is_empty())?.trim();
    let lower = message.to_lowercase();
    let next = if ["resolved", "audited"].iter().any(|v| lower.contains(v)) {
        0.25
    } else if ["download", "fetch", "building", "compile"]
        .iter()
        .any(|v| lower.contains(v))
    {
        0.45
    } else if ["prepared", "extract"].iter().any(|v| lower.contains(v)) {
        0.65
    } else if ["installed", "uninstalled", "updated", "complete"]
        .iter()
        .any(|v| lower.contains(v))
    {
        0.85
    } else {
        (current + 0.02).min(0.9)
    };
    Some(json!({"progress":current.max(next),"message":message}))
}
impl Python {
    pub fn new(base: &Path, project: &Path, development: bool) -> Self {
        Self {
            base: base.into(),
            project: project.into(),
            development,
            runner: Arc::new(NativeRunner),
            uv_release: format!("https://github.com/astral-sh/uv/releases/download/{UV_VERSION}"),
        }
    }
    pub fn path(&self) -> PathBuf {
        executable(&self.base.join("python_venv"))
    }
    fn uv(&self) -> PathBuf {
        self.base
            .join("uv")
            .join(if cfg!(windows) { "uv.exe" } else { "uv" })
    }
    fn command(
        &self,
        command: &Path,
        args: Vec<String>,
        mut env: HashMap<String, String>,
        cwd: Option<&Path>,
        timeout: Duration,
        events: Events,
    ) -> Result<String> {
        let mut clean = environment();
        clean.extend(env.drain());
        events(
            "log",
            json!({"stream":"command","message":format!("{} {:?} (cwd: {})",command.display(),args,cwd.unwrap_or(&self.project).display())}),
        );
        let original = events.clone();
        let ratio = Mutex::new(0.08);
        let result = self.runner.run(
            json!({"command":command,"args":args,"cwd":cwd.unwrap_or(&self.project)}),
            clean,
            timeout,
            Arc::new(move |event, data| {
                original(event, data.clone());
                if event == "log" {
                    let mut ratio = ratio.lock().unwrap();
                    if let Some(value) = progress(data["message"].as_str().unwrap_or(""), *ratio) {
                        *ratio = value["progress"].as_f64().unwrap();
                        original("progress", value);
                    }
                }
            }),
        );
        let output = result.map_err(|error| {
            events(
                "log",
                json!({"stream":"lifecycle","message":format!("Command failed: {error}")}),
            );
            error
        })?;
        events(
            "log",
            json!({"stream":"lifecycle","message":format!("Command finished with exit code {:?}",output.code)}),
        );
        if output.code != Some(0) {
            return Err(format!(
                "{} failed with exit code {:?}: {}",
                command.display(),
                output.code,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().into())
    }
    fn run(&self, command: &Path, args: &[&str], events: Events) -> Result<String> {
        self.command(
            command,
            args.iter().map(|s| s.to_string()).collect(),
            HashMap::new(),
            None,
            Duration::from_secs(3600),
            events,
        )
    }
    fn probe(&self, command: &Path, args: &[&str]) -> Result<String> {
        self.command(
            command,
            args.iter().map(|s| s.to_string()).collect(),
            HashMap::new(),
            None,
            Duration::from_secs(15),
            Arc::new(|_, _| {}),
        )
    }
    fn project_document(&self) -> Result<toml::Value> {
        fs::read_to_string(self.project.join("pyproject.toml"))
            .map_err(|e| e.to_string())?
            .parse()
            .map_err(|e: toml::de::Error| e.to_string())
    }
    pub fn version(&self) -> Option<String> {
        self.project_document()
            .ok()?
            .get("project")?
            .get("version")?
            .as_str()
            .map(str::to_owned)
    }
    pub fn extras(&self, requested: &Value) -> Value {
        let requested = normalized_extras(requested);
        let Ok(document) = self.project_document() else {
            return json!({"selectedExtras":requested,"ignoredExtras":[],"allowedExtras":null});
        };
        let allowed: Vec<_> = document
            .get("project")
            .and_then(|p| p.get("optional-dependencies"))
            .and_then(toml::Value::as_table)
            .into_iter()
            .flatten()
            .map(|(k, _)| k.to_lowercase())
            .collect();
        json!({"selectedExtras":requested.iter().filter(|v|allowed.contains(v)).collect::<Vec<_>>(),"ignoredExtras":requested.iter().filter(|v|!allowed.contains(v)).collect::<Vec<_>>(),"allowedExtras":allowed})
    }
    pub fn specifier(&self) -> Result<String> {
        if self.development {
            return Ok(self.project.to_string_lossy().into());
        }
        for metadata in [
            self.project.join("prerelease.json"),
            self.project.join("assets/prerelease.json"),
            self.project.join("electron-src/assets/prerelease.json"),
        ] {
            if !metadata.exists() {
                continue;
            }
            let data = read_object(&metadata)?;
            let name = data["backendWheel"]["fileName"]
                .as_str()
                .ok_or("Missing prerelease wheel filename")?;
            let digest = data["backendWheel"]["sha256"]
                .as_str()
                .ok_or("Missing prerelease wheel hash")?;
            if !name.ends_with(".whl")
                || name.contains(['/', '\\', ':'])
                || Path::new(name).file_name() != Some(std::ffi::OsStr::new(name))
                || digest.len() != 64
                || !digest.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err("Invalid prerelease wheel metadata".into());
            }
            let assets = if metadata.parent() == Some(self.project.as_path()) {
                self.project.join("assets")
            } else {
                metadata.parent().unwrap().into()
            };
            let wheel = assets.join("python").join(name);
            if !crate::hash(&wheel)?.eq_ignore_ascii_case(digest) {
                return Err("Bundled prerelease backend wheel failed its integrity check".into());
            }
            return Ok(wheel.to_string_lossy().into());
        }
        let Some(version) = self.version() else {
            return Ok(self.project.to_string_lossy().into());
        };
        let mut parts: Vec<_> = version.split('.').map(str::parse::<u64>).collect();
        if parts.len() > 1 && parts.iter().all(std::result::Result::is_ok) {
            let last = parts.pop().unwrap().unwrap();
            if let Some(next) = last.checked_add(1) {
                let mut next_parts = parts
                    .into_iter()
                    .map(|v| v.unwrap().to_string())
                    .collect::<Vec<_>>();
                next_parts.push(next.to_string());
                return Ok(format!(
                    "GameSentenceMiner>={version},<{}",
                    next_parts.join(".")
                ));
            }
        }
        Ok(format!("GameSentenceMiner=={version}"))
    }
    pub fn sync_state(&self, venv: &Path, extras: &Value) -> Result<Value> {
        let mut digest = Sha256::new();
        digest.update(b"gsm-managed-environment-v2\0");
        for (index, name) in ["pyproject.toml", "uv.lock", ".python-version"]
            .iter()
            .enumerate()
        {
            if index > 0 {
                digest.update(b"\0");
            }
            digest.update(name.as_bytes());
            digest.update(b"\0");
            digest.update(fs::read(self.project.join(name)).map_err(|e| e.to_string())?);
        }
        let mut extras = normalized_extras(extras);
        extras.sort();
        digest.update(b"\0extras\0");
        digest.update(serde_json::to_vec(&extras).unwrap());
        let fingerprint = format!("{:x}", digest.finalize());
        let saved = match fs::read_to_string(venv.join(SYNC_STAMP)) {
            Ok(value) => value.trim().into(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.to_string()),
        };
        Ok(json!({"fingerprint":fingerprint,"changed":saved!=fingerprint}))
    }
    pub fn installed_version(&self, python: &Path, package: &str) -> Option<String> {
        self.command(
            python,
            vec![
                "-c".into(),
                "import sys; from importlib.metadata import version; print(version(sys.argv[1]))"
                    .into(),
                package.into(),
            ],
            HashMap::new(),
            None,
            Duration::from_secs(10),
            Arc::new(|_, _| {}),
        )
        .ok()
        .filter(|s| !s.is_empty())
    }
    fn usable(&self, python: &Path) -> bool {
        python.is_file()
            && self
                .command(
                    python,
                    vec!["--version".into()],
                    HashMap::new(),
                    None,
                    Duration::from_secs(15),
                    Arc::new(|_, _| {}),
                )
                .is_ok()
    }
    fn checked_directory(&self, name: &str) -> Result<PathBuf> {
        if name.contains(['/', '\\', ':'])
            || !matches!(name, "python_venv" | "uv")
                && !name.starts_with("python_venv.previous-")
                && !name.starts_with("python_venv.failed-")
        {
            return Err("Invalid managed directory".into());
        }
        let path = self.base.join(name);
        if path.exists() {
            let parent = fs::canonicalize(&self.base).map_err(|e| e.to_string())?;
            if fs::canonicalize(&path).map_err(|e| e.to_string())?.parent()
                != Some(parent.as_path())
                || fs::symlink_metadata(&path)
                    .map_err(|e| e.to_string())?
                    .file_type()
                    .is_symlink()
            {
                return Err(
                    "Managed environment directory cannot be a link outside its data root".into(),
                );
            }
        }
        Ok(path)
    }
    fn recover(&self) -> Result<()> {
        let journal = self.base.join("python-install-transaction.json");
        if !journal.exists() {
            return Ok(());
        }
        let state = read_object(&journal)?;
        let venv = self.checked_directory("python_venv")?;
        let backup = state["backup"]
            .as_str()
            .map(|name| self.checked_directory(name))
            .transpose()?;
        let committed = fs::read_to_string(venv.join(".gsm_venv_generation"))
            .ok()
            .is_some_and(|s| s.trim() == GENERATION)
            && self.usable(&self.path());
        if !committed && backup.as_ref().is_some_and(|p| p.exists()) {
            if venv.exists() {
                fs::rename(
                    &venv,
                    self.base
                        .join(format!("python_venv.failed-{}", uuid::Uuid::new_v4())),
                )
                .map_err(|e| e.to_string())?;
            }
            fs::rename(backup.unwrap(), &venv).map_err(|e| e.to_string())?;
        }
        fs::remove_file(journal).map_err(|e| e.to_string())
    }
    pub fn ensure(&self, rebuild: bool, events: Events) -> Result<PathBuf> {
        self.ensure_available(rebuild, false, events)
    }
    fn ensure_available(&self, rebuild: bool, read_only: bool, events: Events) -> Result<PathBuf> {
        with_lock(&self.base.join("python-install.json"), || {
            if read_only && self.base.join("python-install-transaction.json").exists() {
                return Err(
                    "Stop managed Python processes before recovering their environment.".into(),
                );
            }
            self.recover()?;
            let venv = self.checked_directory("python_venv")?;
            let marker = venv.join(".gsm_venv_generation");
            let stamp = fs::read_to_string(&marker).ok();
            if !rebuild
                && self.path().is_file()
                && (stamp.as_ref().is_some_and(|s| s.trim() == GENERATION)
                    || (stamp.is_none() && self.usable(&self.path())))
            {
                if stamp.is_none() {
                    fs::write(&marker, format!("{GENERATION}\n")).map_err(|e| e.to_string())?;
                }
                for id in ["uv", "python", "venv"] {
                    stage(
                        &events,
                        id,
                        "skipped",
                        Some(1.0),
                        "Existing managed Python environment is available.",
                    );
                }
                return Ok(self.path());
            }
            if read_only {
                return Err(
                    "Stop managed Python processes before rebuilding their environment.".into(),
                );
            }
            // Install tooling before moving a usable environment out of place.
            let uv = if cfg!(target_os = "macos") {
                None
            } else {
                Some(self.ensure_uv(events.clone())?)
            };
            let backup = venv
                .exists()
                .then(|| format!("python_venv.previous-{}", uuid::Uuid::new_v4()));
            let journal = self.base.join("python-install-transaction.json");
            write_atomic(&journal, &json!({"backup":backup}))?;
            if let Some(name) = &backup {
                fs::rename(&venv, self.base.join(name)).map_err(|e| {
                    format!(
                        "Cannot move the active Python environment; close its processes first: {e}"
                    )
                })?;
            }
            let result = (|| {
                stage(
                    &events,
                    "python",
                    "running",
                    None,
                    "Installing the managed Python interpreter...",
                );
                if let Some(uv) = uv {
                    let mut env = HashMap::new();
                    env.insert(
                        "UV_PYTHON_INSTALL_DIR".into(),
                        self.base.join("python-runtime").to_string_lossy().into(),
                    );
                    self.command(
                        &uv,
                        vec!["python".into(), "install".into(), PYTHON_VERSION.into()],
                        env.clone(),
                        None,
                        Duration::from_secs(3600),
                        events.clone(),
                    )?;
                    stage(
                        &events,
                        "python",
                        "completed",
                        Some(1.0),
                        "Managed Python interpreter is installed.",
                    );
                    stage(
                        &events,
                        "venv",
                        "running",
                        None,
                        "Creating the managed Python environment...",
                    );
                    for attempt in 0..4 {
                        let result = self.command(
                            &uv,
                            vec![
                                "venv".into(),
                                "--python".into(),
                                PYTHON_VERSION.into(),
                                "--seed".into(),
                                venv.to_string_lossy().into(),
                            ],
                            env.clone(),
                            None,
                            Duration::from_secs(3600),
                            events.clone(),
                        );
                        match result {
                            Ok(_) => break,
                            Err(error) if attempt < 3 && retryable(&error) => {
                                std::thread::sleep(Duration::from_millis(1500))
                            }
                            Err(error) => return Err(error),
                        }
                    }
                } else {
                    self.create_homebrew_venv(events.clone())?;
                }
                if !self.usable(&self.path()) {
                    return Err("Managed environment Python failed verification".into());
                }
                stage(
                    &events,
                    "venv",
                    "completed",
                    Some(1.0),
                    "Managed Python environment was created.",
                );
                self.ensure_pip(&self.path(), events.clone())?;
                fs::write(&marker, format!("{GENERATION}\n")).map_err(|e| e.to_string())?;
                fs::remove_file(&journal).map_err(|e| e.to_string())?;
                Ok(self.path())
            })();
            if result.is_err() {
                if venv.exists() {
                    let _ = fs::rename(
                        &venv,
                        self.base
                            .join(format!("python_venv.failed-{}", uuid::Uuid::new_v4())),
                    );
                }
                self.recover()?;
            }
            result
        })
    }
    fn ensure_uv(&self, events: Events) -> Result<PathBuf> {
        if self.uv().is_file()
            && self
                .probe(&self.uv(), &["--version"])
                .is_ok_and(|s| s.split_whitespace().nth(1) == Some(UV_VERSION))
        {
            stage(
                &events,
                "uv",
                "skipped",
                Some(1.0),
                "Managed uv runtime is available.",
            );
            return Ok(self.uv());
        }
        let target = uv_target()?;
        let archive = format!(
            "uv-{target}.{}",
            if cfg!(windows) { "zip" } else { "tar.gz" }
        );
        let staging = self
            .base
            .join(format!(".uv-stage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        let result = (|| {
            stage(
                &events,
                "uv",
                "running",
                None,
                "Downloading the managed uv runtime...",
            );
            let checksum = crate::client(30)?
                .get(format!("{}/{}.sha256", self.uv_release, archive))
                .send()
                .and_then(|r| r.error_for_status())
                .and_then(|r| r.text())
                .map_err(|e| e.to_string())?;
            let digest = checksum
                .split_whitespace()
                .next()
                .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
                .ok_or("Missing official uv checksum")?
                .to_lowercase();
            let file = staging.join(&archive);
            crate::download(
                &format!("{}/{}", self.uv_release, archive),
                &file,
                Some(&digest),
                &|bytes, total| {
                    events(
                        "stage",
                        json!({"stageId":"uv","status":"running","progressKind":"bytes","progress":total.filter(|n|*n>0).map(|n|bytes as f64/n as f64),"downloadedBytes":bytes,"totalBytes":total,"message":"Downloading managed uv runtime..."}),
                    )
                },
            )?;
            let binary = staging.join(if cfg!(windows) { "uv.exe" } else { "uv" });
            extract_uv(&file, &binary)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
            if !self
                .probe(&binary, &["--version"])?
                .split_whitespace()
                .nth(1)
                .is_some_and(|s| s == UV_VERSION)
            {
                return Err("Downloaded uv version failed verification".into());
            }
            let destination = self.checked_directory("uv")?;
            fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
            if self.uv().exists() {
                fs::rename(
                    self.uv(),
                    destination.join(format!("uv.previous-{}", uuid::Uuid::new_v4())),
                )
                .map_err(|e| e.to_string())?;
            }
            fs::rename(binary, self.uv()).map_err(|e| e.to_string())?;
            stage(
                &events,
                "uv",
                "completed",
                Some(1.0),
                "Managed uv runtime is installed.",
            );
            Ok(self.uv())
        })();
        let _ = fs::remove_dir_all(staging);
        result
    }
    fn create_homebrew_venv(&self, events: Events) -> Result<()> {
        let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
            .iter()
            .map(Path::new)
            .find(|p| p.is_file())
            .ok_or(
                "Homebrew is required on macOS. Install it from https://brew.sh/ and restart GSM.",
            )?;
        let mut env = HashMap::new();
        env.insert(
            "PATH".into(),
            format!(
                "{}:/usr/bin:/bin:/usr/sbin:/sbin:{}",
                brew.parent().unwrap().display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        );
        self.command(
            brew,
            vec!["install".into(), "python@3.13".into()],
            env.clone(),
            None,
            Duration::from_secs(3600),
            events.clone(),
        )?;
        let prefix = self.command(
            brew,
            vec!["--prefix".into(), "python@3.13".into()],
            env,
            None,
            Duration::from_secs(30),
            events.clone(),
        )?;
        self.run(
            &PathBuf::from(prefix).join("bin/python3.13"),
            &[
                "-m",
                "venv",
                self.base
                    .join("python_venv")
                    .to_str()
                    .ok_or("Invalid environment path")?,
            ],
            events,
        )?;
        Ok(())
    }
    pub fn ensure_pip(&self, python: &Path, events: Events) -> Result<()> {
        stage(
            &events,
            "verify_runtime",
            "running",
            None,
            "Verifying Python runtime tooling...",
        );
        if self.probe(python, &["-m", "pip", "--version"]).is_err() {
            self.run(python, &["-m", "ensurepip", "--upgrade"], events.clone())?;
            self.probe(python, &["-m", "pip", "--version"])?;
        }
        stage(
            &events,
            "verify_runtime",
            "completed",
            Some(1.0),
            "Managed Python runtime is verified.",
        );
        Ok(())
    }
    pub fn ensure_module_uv(&self, python: &Path, events: Events) -> Result<()> {
        if self.installed_version(python, "uv").as_deref() != Some(UV_VERSION) {
            self.run(
                python,
                &[
                    "-m",
                    "pip",
                    "install",
                    "--no-warn-script-location",
                    &format!("uv=={UV_VERSION}"),
                ],
                events,
            )?;
        }
        Ok(())
    }
    fn validate(&self, python: &Path, extras: &Value, events: Events) -> Result<()> {
        self.run(python, &["-m", "pip", "check"], events)?;
        let venv = venv_for(python)?;
        let state = self.sync_state(&venv, extras)?;
        fs::write(
            venv.join(SYNC_STAMP),
            format!("{}\n", state["fingerprint"].as_str().unwrap()),
        )
        .map_err(|e| e.to_string())
    }
    fn probe_onnx(&self, python: &Path, gpu: bool, events: Events) -> Result<()> {
        self.command(python,vec!["-c".into(),format!("import sys, onnxruntime as ort; actual = 'CUDAExecutionProvider' in ort.get_available_providers(); sys.exit(0 if actual == {} else 2)",if gpu{"True"}else{"False"})],HashMap::new(),None,Duration::from_secs(15),events).map(|_|())
    }
    pub fn sync(
        &self,
        python: &Path,
        extras: &Value,
        check: bool,
        options: &Value,
        events: Events,
    ) -> Result<()> {
        let selected = normalized_extras(extras);
        let args = self.sync_args(&selected, check, options["reinstall"] == true);
        let mut env = HashMap::new();
        env.insert(
            "VIRTUAL_ENV".into(),
            venv_for(python)?.to_string_lossy().into(),
        );
        self.command(
            python,
            args.clone(),
            env.clone(),
            None,
            Duration::from_secs(3600),
            events.clone(),
        )?;
        let gpu = selected.iter().any(|s| s == "gpu");
        if let Err(error) = self.probe_onnx(python, gpu, events.clone()) {
            if check {
                return Err(format!(
                    "The installed ONNX runtime does not match the selected runtime: {error}"
                ));
            }
            let mut repair = args;
            repair.extend([
                "--reinstall-package".into(),
                if gpu {
                    "onnxruntime-gpu".into()
                } else {
                    "onnxruntime".into()
                },
            ]);
            self.command(
                python,
                repair,
                env,
                None,
                Duration::from_secs(3600),
                events.clone(),
            )?;
            self.probe_onnx(python, gpu, events.clone())?;
        }
        if options["deferValidation"] != true {
            self.validate(python, extras, events)?;
        }
        Ok(())
    }
    fn sync_args(&self, extras: &[String], check: bool, reinstall: bool) -> Vec<String> {
        let mut args = vec!["-m", "uv", "sync", "--active", "--project"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        args.push(self.project.to_string_lossy().into());
        args.extend(
            [
                "--frozen",
                "--no-dev",
                "--no-editable",
                "--no-install-project",
                "--inexact",
            ]
            .map(str::to_owned),
        );
        if check {
            args.push("--check".into());
        } else if reinstall {
            args.push("--reinstall".into());
        }
        for extra in extras {
            args.extend(["--extra".into(), extra.clone()]);
        }
        args
    }
    pub fn install(
        &self,
        python: &Path,
        specifier: &str,
        reinstall: bool,
        extras: &Value,
        events: Events,
    ) -> Result<()> {
        let mut args = vec!["-m", "uv", "pip", "install", "--no-deps", "--upgrade"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if reinstall {
            args.push("--force-reinstall".into());
        }
        args.push(specifier.into());
        self.command(
            python,
            args,
            HashMap::new(),
            None,
            Duration::from_secs(3600),
            events.clone(),
        )?;
        self.validate(python, extras, events)
    }
    fn prepare_locked(&self, python: &Path, args: &Value, events: Events) -> Result<Value> {
        let installed = if args.get("knownInstalledVersion").is_some() {
            args["knownInstalledVersion"].as_str().map(str::to_owned)
        } else {
            self.installed_version(python, "GameSentenceMiner")
        };
        let bundled = self.version();
        let compatible = installed
            .as_ref()
            .zip(bundled.as_ref())
            .is_some_and(|(installed, bundled)| compatible_version(installed, bundled));
        let replace = installed.is_none()
            || (args["isPreRelease"] != true && bundled.is_some() && !compatible);
        let selection = self.extras(&args["extras"]);
        let extras = &selection["selectedExtras"];
        let changed = self.sync_state(&venv_for(python)?, extras)?["changed"] == true;
        if replace || changed {
            if args["readOnlyEnvironment"] == true {
                return Err(
                    "Stop managed Python processes before updating their environment.".into(),
                );
            }
            self.ensure_pip(python, events.clone())
                .map_err(|e| format!("Managed Python tooling failed: {e}"))?;
            self.ensure_module_uv(python, events.clone())?;
            let options = json!({"deferValidation":replace});
            stage(
                &events,
                "lock_sync",
                "running",
                None,
                "Synchronizing the locked Python dependencies...",
            );
            if changed
                || self
                    .sync(python, extras, true, &options, events.clone())
                    .is_err()
            {
                self.sync(python, extras, false, &options, events.clone())?;
            }
            stage(
                &events,
                "lock_sync",
                "completed",
                Some(1.0),
                "Python dependencies match the bundled lockfile.",
            );
        } else {
            for id in ["verify_runtime", "lock_sync"] {
                stage(
                    &events,
                    id,
                    "skipped",
                    Some(1.0),
                    "Existing Python environment is unchanged.",
                );
            }
        }
        let installed = if replace {
            stage(
                &events,
                "gsm_package",
                "running",
                None,
                "Installing the GSM backend package...",
            );
            self.install(python, &self.specifier()?, true, extras, events.clone())?;
            stage(
                &events,
                "gsm_package",
                "completed",
                Some(1.0),
                "GSM backend package is installed.",
            );
            self.installed_version(python, "GameSentenceMiner")
        } else {
            stage(
                &events,
                "gsm_package",
                "skipped",
                Some(1.0),
                "GSM backend package is already installed.",
            );
            installed
        };
        Ok(
            json!({"pythonPath":python,"installedVersion":installed,"selectedExtras":extras,"ignoredExtras":selection["ignoredExtras"]}),
        )
    }
    pub fn prepare(&self, args: &Value, events: Events) -> Result<Value> {
        let python = args["pythonPath"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.path());
        let result = with_lock(&self.base.join("python-install.json"), || {
            self.prepare_locked(&python, args, events.clone())
        });
        if result
            .as_ref()
            .err()
            .is_some_and(|e| e.starts_with("Managed Python tooling failed:"))
        {
            // The host refuses this operation while a managed backend is live.
            let python = self.ensure(true, events.clone())?;
            let mut fresh = args.clone();
            fresh
                .as_object_mut()
                .ok_or("Missing prepare parameters")?
                .remove("knownInstalledVersion");
            return with_lock(&self.base.join("python-install.json"), || {
                self.prepare_locked(&python, &fresh, events)
            });
        }
        result
    }
    pub fn call(&self, action: &str, args: &Value, events: Events) -> Result<Value> {
        let python = args["pythonPath"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.path());
        match action {
            "updateCheck" => self.update_check(args, events),
            "maintain" => self.maintain(args, events),
            "packageInstall" => self.install_requirement(&python, args, events),
            "info" => self.environment_info(),
            "packages" => self.installed_packages(),
            "prepare" => self.prepare(args, events),
            "present" => Ok(json!(self.path().is_file())),
            "path" => Ok(json!(self.path())),
            "project" => Ok(json!(self.project)),
            "version" => Ok(json!(self.version())),
            "specifier" => self.specifier().map(Value::String),
            "extras" => Ok(self.extras(&args["extras"])),
            "syncState" => self.sync_state(
                Path::new(
                    args["venvPath"]
                        .as_str()
                        .ok_or("Missing environment path")?,
                ),
                &args["extras"],
            ),
            "ensure" | "reinstall" => self
                .ensure_available(
                    action == "reinstall",
                    args["readOnlyEnvironment"] == true,
                    events,
                )
                .map(|p| json!(p)),
            "installedVersion" => Ok(json!(self.installed_version(
                &python,
                args["packageName"].as_str().ok_or("Missing package name")?
            ))),
            _ => with_lock(&self.base.join("python-install.json"), || {
                match action {
                    "ensurePip" => self.ensure_pip(&python, events)?,
                    "ensureUv" => self.ensure_module_uv(&python, events)?,
                    "sync" => self.sync(
                        &python,
                        &args["extras"],
                        args["checkOnly"] == true,
                        &args["options"],
                        events,
                    )?,
                    "install" => self.install(
                        &python,
                        args["specifier"]
                            .as_str()
                            .ok_or("Missing package specifier")?,
                        args["forceReinstall"] == true,
                        &args["extras"],
                        events,
                    )?,
                    "cleanCache" => {
                        let _ = self.run(&python, &["-m", "uv", "cache", "clean"], events);
                    }
                    "cleanCacheStrict" => {
                        self.run(&python, &["-m", "uv", "cache", "clean"], events)?;
                    }
                    "command" => {
                        let command = args["command"].as_str().ok_or("Missing command")?;
                        let argv = args["args"]
                            .as_array()
                            .ok_or("Missing arguments")?
                            .iter()
                            .map(|s| s.as_str().map(str::to_owned).ok_or("Invalid argument"))
                            .collect::<std::result::Result<Vec<_>, _>>()?;
                        let env = args["env"]
                            .as_object()
                            .into_iter()
                            .flatten()
                            .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.into())))
                            .collect();
                        return self
                            .command(
                                Path::new(command),
                                argv,
                                env,
                                args["cwd"].as_str().map(Path::new),
                                Duration::from_secs(3600),
                                events,
                            )
                            .map(Value::String);
                    }
                    _ => return Err(format!("Unknown native Python operation: {action}")),
                }
                Ok(Value::Null)
            }),
        }
    }
}
fn retryable(error: &str) -> bool {
    let error = error.to_lowercase();
    [
        "permission denied",
        "access is denied",
        "used by another process",
        "os error 5",
        "os error 32",
        "resource busy",
        "sharing violation",
    ]
    .iter()
    .any(|s| error.contains(s))
}
fn uv_target() -> Result<String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        _ => return Err("Unsupported managed Python architecture".into()),
    };
    let platform = if cfg!(windows) {
        "pc-windows-msvc"
    } else if cfg!(target_os = "macos") {
        "apple-darwin"
    } else {
        "unknown-linux-gnu"
    };
    Ok(format!("{arch}-{platform}"))
}
fn extract_uv(archive: &Path, binary: &Path) -> Result<()> {
    let wanted = if cfg!(windows) { "uv.exe" } else { "uv" };
    let mut found = false;
    let mut save = |name: &Path, size: u64, reader: &mut dyn Read| -> Result<()> {
        if name
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Unsafe uv archive entry".into());
        }
        if name.file_name() != Some(std::ffi::OsStr::new(wanted)) {
            return Ok(());
        }
        if found || size > 128 * 1024 * 1024 {
            return Err("Invalid uv executable entry".into());
        }
        found = true;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(binary)
            .map_err(|e| e.to_string())?;
        let copied = std::io::copy(&mut reader.take(128 * 1024 * 1024 + 1), &mut file)
            .map_err(|e| e.to_string())?;
        if copied != size || copied > 128 * 1024 * 1024 {
            return Err("Invalid uv executable size".into());
        }
        file.sync_all().map_err(|e| e.to_string())
    };
    if cfg!(windows) {
        let mut zip = zip::ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
            if entry.is_dir() {
                continue;
            }
            if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
                return Err("uv archive contains a link".into());
            }
            let path = entry.enclosed_name().ok_or("Unsafe uv archive")?.to_owned();
            let size = entry.size();
            save(&path, size, &mut entry)?;
        }
    } else {
        let reader =
            flate2::read::GzDecoder::new(fs::File::open(archive).map_err(|e| e.to_string())?);
        let mut tar = tar::Archive::new(reader);
        for entry in tar.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            if entry.header().entry_type().is_dir() {
                continue;
            }
            if !entry.header().entry_type().is_file() {
                return Err("uv archive contains a non-file entry".into());
            }
            let path = entry.path().map_err(|e| e.to_string())?.into_owned();
            let size = entry.size();
            save(&path, size, &mut entry)?;
        }
    }
    if found {
        Ok(())
    } else {
        Err("uv archive contains no executable".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    #[derive(Default)]
    struct FakeRunner {
        calls: Mutex<Vec<Value>>,
        fail_venv: AtomicBool,
        fail_check: AtomicBool,
        fail_tooling_once: AtomicBool,
        fail_onnx_once: AtomicBool,
        fail_sync: AtomicUsize,
        fail_install: AtomicUsize,
        missing_uv_network_failure: AtomicBool,
    }
    impl Runner for FakeRunner {
        fn run(
            &self,
            spec: Value,
            env: HashMap<String, String>,
            timeout: Duration,
            events: Events,
        ) -> Result<Output> {
            self.calls
                .lock()
                .unwrap()
                .push(json!({"spec":spec,"env":env,"timeout":timeout.as_secs_f64()}));
            let args = spec["args"].as_array().unwrap();
            if self.missing_uv_network_failure.load(Ordering::SeqCst)
                && (args.last() == Some(&json!("uv"))
                    || args.starts_with(&[json!("-m"), json!("pip"), json!("install")]))
            {
                return Err("Fixture uv download network timeout".into());
            }
            for (prefix, remaining) in [
                (
                    vec![json!("-m"), json!("uv"), json!("sync")],
                    &self.fail_sync,
                ),
                (
                    vec![json!("-m"), json!("uv"), json!("pip"), json!("install")],
                    &self.fail_install,
                ),
            ] {
                if args.starts_with(&prefix)
                    && remaining
                        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                        .is_ok()
                {
                    return Err("Fixture package download failed".into());
                }
            }
            if args == &vec![json!("-m"), json!("ensurepip"), json!("--upgrade")]
                && self.fail_tooling_once.swap(false, Ordering::Relaxed)
            {
                return Err("Fixture damaged pip".into());
            }
            if args == &vec![json!("-m"), json!("pip"), json!("--version")]
                && self.fail_tooling_once.load(Ordering::Relaxed)
            {
                return Err("Fixture missing pip".into());
            }
            if args
                .get(1)
                .and_then(Value::as_str)
                .is_some_and(|s| s.contains("onnxruntime"))
                && self.fail_onnx_once.swap(false, Ordering::Relaxed)
            {
                return Err("Fixture wrong ONNX flavor".into());
            }
            if args.first() == Some(&json!("venv")) {
                if self.fail_venv.load(Ordering::Relaxed) {
                    return Err("Fixture venv creation failed".into());
                }
                let python = executable(Path::new(args.last().unwrap().as_str().unwrap()));
                fs::create_dir_all(python.parent().unwrap()).unwrap();
                fs::write(python, "fixture").unwrap();
            }
            if args == &vec![json!("-m"), json!("pip"), json!("check")]
                && self.fail_check.load(Ordering::Relaxed)
            {
                return Err("Fixture dependency mismatch".into());
            }
            let stdout = if args == &vec![json!("--version")] {
                if spec["command"].as_str().unwrap().contains("uv") {
                    format!("uv {UV_VERSION}")
                } else {
                    format!("Python {PYTHON_VERSION}")
                }
            } else if args
                .get(1)
                .and_then(Value::as_str)
                .is_some_and(|s| s.contains("importlib.metadata"))
            {
                if args.last() == Some(&json!("uv")) {
                    UV_VERSION.into()
                } else {
                    "2026.11.0".into()
                }
            } else {
                String::new()
            };
            events(
                "log",
                json!({"stream":"stderr","message":"Resolved 3 packages"}),
            );
            Ok(Output {
                code: Some(0),
                stdout: stdout.into_bytes(),
                stderr: vec![],
            })
        }
    }
    fn fixture() -> (tempfile::TempDir, Python, Arc<FakeRunner>) {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        let base = directory.path().join("data");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(base.join("uv")).unwrap();
        fs::write(project.join("pyproject.toml"),"[project]\nversion = '2026.11.0'\n[project.optional-dependencies]\ngpu=[]\noneocr=[]\n").unwrap();
        fs::write(project.join("uv.lock"), "version = 1\n").unwrap();
        fs::write(project.join(".python-version"), "3.13.2\n").unwrap();
        let mut python = Python::new(&base, &project, false);
        fs::write(python.uv(), "fixture").unwrap();
        let runner = Arc::new(FakeRunner::default());
        python.runner = runner.clone();
        (directory, python, runner)
    }
    fn quiet() -> Events {
        Arc::new(|_, _| {})
    }
    #[test]
    fn native_maintenance_modes_replace_files_without_touching_profiles() {
        for mode in ["repair", "reset_dependencies", "startup_repair"] {
            let (_temp, python, runner) = fixture();
            python.ensure(false, quiet()).unwrap();
            runner.calls.lock().unwrap().clear();
            let saved = python.base.join("config.json");
            fs::write(&saved, "{\"preserve\": true}\n").unwrap();
            let result = python
                .maintain(
                    &json!({"mode":mode,"extras":["gpu","removed-extra"]}),
                    quiet(),
                )
                .unwrap();
            assert_eq!(result["selectedExtras"], json!(["gpu"]));
            assert_eq!(result["ignoredExtras"], json!(["removed-extra"]));
            assert_eq!(fs::read_to_string(saved).unwrap(), "{\"preserve\": true}\n");
            let calls = runner.calls.lock().unwrap();
            let sync = calls
                .iter()
                .find(|c| c["spec"]["args"][2] == "sync")
                .unwrap();
            assert!(sync["spec"]["args"]
                .as_array()
                .unwrap()
                .contains(&json!("--reinstall")));
            let installs = calls
                .iter()
                .filter(|c| c["spec"]["args"][3] == "install")
                .count();
            assert_eq!(installs, if mode == "reset_dependencies" { 0 } else { 1 });
        }
    }
    #[test]
    fn native_update_retries_package_failures_once_without_rebuilding_python() {
        for (sync_failures, install_failures, succeeds) in
            [(1, 0, true), (0, 1, true), (2, 0, false), (0, 2, false)]
        {
            let (_temp, mut python, runner) = fixture();
            python.development = true;
            python.ensure(false, quiet()).unwrap();
            runner.calls.lock().unwrap().clear();
            runner.fail_sync.store(sync_failures, Ordering::SeqCst);
            runner
                .fail_install
                .store(install_failures, Ordering::SeqCst);
            let result = python.maintain(&json!({"mode":"update","force":true}), quiet());
            assert_eq!(result.is_ok(), succeeds, "{result:?}");
            let calls = runner.calls.lock().unwrap();
            assert_eq!(
                calls
                    .iter()
                    .filter(|c| c["spec"]["args"][2] == "sync")
                    .count(),
                2
            );
            assert!(!calls.iter().any(|c| c["spec"]["args"][0] == "venv"));
        }
    }
    #[test]
    fn native_update_skips_unchanged_install_and_repairs_tooling_once() {
        let (_temp, mut python, runner) = fixture();
        python.development = true;
        python.ensure(false, quiet()).unwrap();
        runner.calls.lock().unwrap().clear();
        assert_eq!(
            python.maintain(&json!({"mode":"update"}), quiet()).unwrap()["changed"],
            false
        );
        assert!(!runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c["spec"]["args"][2] == "sync"));
        runner.calls.lock().unwrap().clear();
        runner.fail_tooling_once.store(true, Ordering::SeqCst);
        python.maintain(&json!({"mode":"repair"}), quiet()).unwrap();
        assert_eq!(
            runner
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c["spec"]["args"][0] == "venv")
                .count(),
            1
        );
    }
    #[test]
    fn custom_package_install_preserves_project_and_avoids_option_injection() {
        let (_temp, python, runner) = fixture();
        python.ensure(false, quiet()).unwrap();
        let manifest = fs::read(python.project.join("pyproject.toml")).unwrap();
        assert!(python
            .call(
                "packageInstall",
                &json!({"requirement":"--target=bad"}),
                quiet()
            )
            .is_err());
        python
            .call(
                "packageInstall",
                &json!({"requirement":"example==1.2","reinstall":true}),
                quiet(),
            )
            .unwrap();
        let calls = runner.calls.lock().unwrap();
        let install = calls
            .iter()
            .find(|c| c["spec"]["args"][3] == "install")
            .unwrap();
        assert!(install["spec"]["args"]
            .as_array()
            .unwrap()
            .contains(&json!("--force-reinstall")));
        assert_eq!(
            install["spec"]["args"].as_array().unwrap().last().unwrap(),
            "example==1.2"
        );
        assert_eq!(
            fs::read(python.project.join("pyproject.toml")).unwrap(),
            manifest
        );
    }
    #[test]
    fn a_uv_download_failure_never_rebuilds_a_healthy_environment() {
        let (_temp, python, runner) = fixture();
        python.ensure(false, quiet()).unwrap();
        runner.calls.lock().unwrap().clear();
        runner
            .missing_uv_network_failure
            .store(true, Ordering::SeqCst);
        assert!(python
            .maintain(&json!({"mode":"repair"}), quiet())
            .unwrap_err()
            .contains("network timeout"));
        assert!(!runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c["spec"]["args"][0] == "venv"));
        runner.calls.lock().unwrap().clear();
        assert!(python
            .prepare(&json!({"knownInstalledVersion":null}), quiet())
            .unwrap_err()
            .contains("network timeout"));
        assert!(!runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c["spec"]["args"][0] == "venv"));
    }
    #[test]
    fn adoption_and_concurrent_install_preserve_existing_environments() {
        let (_temp, python, runner) = fixture();
        fs::create_dir_all(python.path().parent().unwrap()).unwrap();
        fs::write(python.path(), "existing Python").unwrap();
        python.ensure(false, quiet()).unwrap();
        assert_eq!(
            fs::read_to_string(python.path()).unwrap(),
            "existing Python"
        );
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
        runner.calls.lock().unwrap().clear();
        python.ensure(false, quiet()).unwrap();
        assert!(runner.calls.lock().unwrap().is_empty());
        let (_temp, python, runner) = fixture();
        let python = Arc::new(python);
        let mut jobs = vec![];
        for _ in 0..4 {
            let python = python.clone();
            jobs.push(std::thread::spawn(move || {
                python.ensure(false, quiet()).unwrap()
            }));
        }
        for job in jobs {
            assert_eq!(job.join().unwrap(), python.path());
        }
        assert_eq!(
            runner
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c["spec"]["args"][0] == "venv")
                .count(),
            1
        );
    }
    #[test]
    fn failed_rebuild_restores_original_environment_and_interrupted_journal() {
        let (_temp, python, runner) = fixture();
        python.ensure(false, quiet()).unwrap();
        let original = python.base.join("python_venv/user-file");
        fs::write(&original, "keep").unwrap();
        runner.fail_venv.store(true, Ordering::Relaxed);
        assert!(python.ensure(true, quiet()).is_err());
        assert_eq!(fs::read_to_string(&original).unwrap(), "keep");
        assert!(!python.base.join("python-install-transaction.json").exists());
        let backup = "python_venv.previous-interrupted";
        fs::rename(python.base.join("python_venv"), python.base.join(backup)).unwrap();
        write_atomic(
            &python.base.join("python-install-transaction.json"),
            &json!({"backup":backup}),
        )
        .unwrap();
        python.ensure(false, quiet()).unwrap();
        assert_eq!(fs::read_to_string(original).unwrap(), "keep");
    }
    #[test]
    fn frozen_sync_and_metadata_replacement_stamp_only_after_validation() {
        let (_temp, python, runner) = fixture();
        python.ensure(false, quiet()).unwrap();
        let extras = json!(["GPU", "gpu"]);
        python
            .sync(
                &python.path(),
                &extras,
                true,
                &json!({"reinstall":true,"deferValidation":true}),
                quiet(),
            )
            .unwrap();
        let calls = runner.calls.lock().unwrap();
        let args = calls
            .iter()
            .find(|c| c["spec"]["args"][2] == "sync")
            .unwrap()["spec"]["args"]
            .as_array()
            .unwrap();
        for flag in [
            "--frozen",
            "--no-dev",
            "--no-install-project",
            "--inexact",
            "--check",
        ] {
            assert!(args.contains(&json!(flag)));
        }
        assert!(!args.contains(&json!("--reinstall")));
        drop(calls);
        assert!(!python.base.join("python_venv").join(SYNC_STAMP).exists());
        runner.fail_check.store(true, Ordering::Relaxed);
        assert!(python
            .install(
                &python.path(),
                "GameSentenceMiner==2026.11.0",
                true,
                &extras,
                quiet()
            )
            .is_err());
        assert!(!python.base.join("python_venv").join(SYNC_STAMP).exists());
        runner.fail_check.store(false, Ordering::Relaxed);
        python
            .install(
                &python.path(),
                "GameSentenceMiner==2026.11.0",
                true,
                &extras,
                quiet(),
            )
            .unwrap();
        assert_eq!(
            python
                .sync_state(&python.base.join("python_venv"), &extras)
                .unwrap()["changed"],
            false
        );
        assert_eq!(
            python
                .sync_state(&python.base.join("python_venv"), &json!([]))
                .unwrap()["changed"],
            true
        );
    }
    #[test]
    fn bundled_versions_extras_and_prerelease_hash_are_enforced() {
        let (_temp, python, _) = fixture();
        assert_eq!(
            python.specifier().unwrap(),
            "GameSentenceMiner>=2026.11.0,<2026.11.1"
        );
        let extras = python.extras(&json!([" GPU ", "gpu", "bad"]));
        assert_eq!(extras["selectedExtras"], json!(["gpu"]));
        assert_eq!(extras["ignoredExtras"], json!(["bad"]));
        let assets = python.project.join("assets");
        fs::create_dir_all(assets.join("python")).unwrap();
        let wheel = assets.join("python/backend.whl");
        fs::write(&wheel, "fixture").unwrap();
        write_atomic(&assets.join("prerelease.json"),&json!({"backendWheel":{"fileName":"backend.whl","sha256":crate::hash(&wheel).unwrap()}})).unwrap();
        assert_eq!(PathBuf::from(python.specifier().unwrap()), wheel);
        fs::write(&wheel, "damaged").unwrap();
        assert!(python.specifier().is_err());
        write_atomic(
            &assets.join("prerelease.json"),
            &json!({"backendWheel":{"fileName":"../backend.whl","sha256":"0".repeat(64)}}),
        )
        .unwrap();
        assert!(python.specifier().is_err());
        assert!(python.checked_directory("../python_venv").is_err());
    }
    #[test]
    fn native_progress_retains_monotonic_milestones() {
        assert_eq!(
            progress("\u{1b}[32mResolved 15 packages\u{1b}[0m", 0.1).unwrap(),
            json!({"progress":0.25,"message":"Resolved 15 packages"})
        );
        assert_eq!(
            progress("Downloading wheels", 0.25).unwrap()["progress"],
            0.45
        );
        assert_eq!(
            progress("Installed 3 packages", 0.45).unwrap()["progress"],
            0.85
        );
        assert_eq!(
            progress("Resolved 15 packages", 0.85).unwrap()["progress"],
            0.85
        );
    }
    #[test]
    fn unchanged_startup_keeps_post_releases_and_local_builds_without_subprocesses() {
        let (_temp, python, runner) = fixture();
        python.ensure(false, quiet()).unwrap();
        python
            .validate(&python.path(), &json!(["gpu"]), quiet())
            .unwrap();
        for version in ["2026.11.0", "2026.11.0.post12", "2026.11.0.post12+local.1"] {
            runner.calls.lock().unwrap().clear();
            let result=python.prepare(&json!({"knownInstalledVersion":version,"extras":["GPU","removed-extra"],"readOnlyEnvironment":true}),quiet()).unwrap();
            assert_eq!(result["installedVersion"], version);
            assert_eq!(result["selectedExtras"], json!(["gpu"]));
            assert_eq!(result["ignoredExtras"], json!(["removed-extra"]));
            assert!(
                runner.calls.lock().unwrap().is_empty(),
                "Unchanged launch must not install or run probes"
            );
        }
    }
    #[test]
    fn live_environment_is_never_rebuilt_or_resynced() {
        let (_temp, python, runner) = fixture();
        python.ensure(false, quiet()).unwrap();
        runner.calls.lock().unwrap().clear();
        let before = fs::read(python.path()).unwrap();
        assert!(python
            .prepare(
                &json!({"knownInstalledVersion":"2026.10.0","readOnlyEnvironment":true}),
                quiet()
            )
            .is_err());
        assert!(runner.calls.lock().unwrap().is_empty());
        assert_eq!(fs::read(python.path()).unwrap(), before);
        fs::write(python.base.join("python_venv/.gsm_venv_generation"), "old").unwrap();
        assert!(python
            .call("ensure", &json!({"readOnlyEnvironment":true}), quiet())
            .is_err());
        assert!(runner.calls.lock().unwrap().is_empty());
        assert_eq!(fs::read(python.path()).unwrap(), before);
    }
    #[test]
    fn native_startup_repairs_tooling_once_and_rechecks_package_metadata() {
        let (_temp, python, runner) = fixture();
        python.ensure(false, quiet()).unwrap();
        runner.calls.lock().unwrap().clear();
        runner.fail_tooling_once.store(true, Ordering::Relaxed);
        let result = python
            .prepare(
                &json!({"knownInstalledVersion":"2026.10.0","extras":[]}),
                quiet(),
            )
            .unwrap();
        assert_eq!(result["installedVersion"], "2026.11.0");
        let calls = runner.calls.lock().unwrap();
        assert_eq!(
            calls
                .iter()
                .filter(|c| c["spec"]["args"][0] == "venv")
                .count(),
            1
        );
        assert!(calls.iter().any(|c| c["spec"]["args"][2] == "sync"));
        assert_eq!(
            python
                .sync_state(&python.base.join("python_venv"), &json!([]))
                .unwrap()["changed"],
            false
        );
    }
    #[test]
    fn fingerprint_changes_with_inputs_but_not_extra_order() {
        let (_temp, python, _) = fixture();
        python.ensure(false, quiet()).unwrap();
        let venv = python.base.join("python_venv");
        let extras = json!(["gpu", "oneocr"]);
        python.validate(&python.path(), &extras, quiet()).unwrap();
        assert_eq!(
            python
                .sync_state(&venv, &json!([" ONEOCR ", "gpu", "gpu"]))
                .unwrap()["changed"],
            false
        );
        for name in ["pyproject.toml", "uv.lock", ".python-version"] {
            let path = python.project.join(name);
            let original = fs::read(&path).unwrap();
            fs::write(&path, [original.as_slice(), b"\n"].concat()).unwrap();
            assert_eq!(python.sync_state(&venv, &extras).unwrap()["changed"], true);
            fs::write(path, original).unwrap();
        }
        assert_eq!(python.sync_state(&venv, &extras).unwrap()["changed"], false);
    }
    #[test]
    fn onnx_check_is_read_only_and_sync_repairs_the_selected_flavor() {
        for gpu in [false, true] {
            let (_temp, python, runner) = fixture();
            python.ensure(false, quiet()).unwrap();
            let extras = if gpu { json!(["gpu"]) } else { json!([]) };
            runner.calls.lock().unwrap().clear();
            runner.fail_onnx_once.store(true, Ordering::Relaxed);
            assert!(python
                .sync(&python.path(), &extras, true, &json!({}), quiet())
                .is_err());
            assert!(!runner
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c["spec"]["args"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("--reinstall-package"))));
            runner.fail_onnx_once.store(true, Ordering::Relaxed);
            python
                .sync(&python.path(), &extras, false, &json!({}), quiet())
                .unwrap();
            assert!(runner
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c["spec"]["args"].as_array().unwrap().ends_with(&[
                    json!("--reinstall-package"),
                    json!(if gpu {
                        "onnxruntime-gpu"
                    } else {
                        "onnxruntime"
                    })
                ])));
        }
    }
}
