//! Backend update policy and complete dependency maintenance sequences.
use super::*;

const INDEX_URL: &str = "https://pypi.org/pypi/GameSentenceMiner/json";
fn post(version: &str, bundled: &str) -> Option<u64> {
    let version = version.split('+').next().unwrap_or(version);
    regex::Regex::new(&format!(r"(?i)^{}\.post(\d+)$", regex::escape(bundled)))
        .unwrap()
        .captures(version)
        .and_then(|c| c[1].parse().ok())
}
pub(super) fn select_latest(bundled: &str, releases: &Value) -> String {
    releases
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, files)| {
            files
                .as_array()
                .is_some_and(|files| files.iter().any(|f| f["yanked"] != true))
        })
        .filter_map(|(version, _)| post(version, bundled).map(|n| (n, version)))
        .max_by_key(|(n, _)| *n)
        .map(|(_, version)| version.clone())
        .unwrap_or_else(|| bundled.into())
}
fn latest_from_index(bundled: &str, development: bool, url: &str, events: &Events) -> String {
    if development {
        return bundled.into();
    }
    let result: Result<Value> = (|| {
        let response = crate::client(5)?
            .get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        response
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("Backend release index exceeds 16 MiB".into());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if !value["releases"].is_object() {
            return Err("Backend release index has no releases".into());
        }
        Ok(value)
    })();
    match result {
        Ok(value) => select_latest(bundled, &value["releases"]),
        Err(error) => {
            events(
                "log",
                json!({"stream":"stderr","message":format!("Could not query compatible backend releases; using bundled {bundled}: {error}")}),
            );
            bundled.into()
        }
    }
}
pub(super) fn needs_update(
    installed: Option<&str>,
    bundled: &str,
    latest: &str,
    force: bool,
) -> bool {
    force
        || installed.is_none_or(|installed| {
            !compatible_version(installed, bundled)
                || post(latest, bundled) > post(installed, bundled)
        })
}
impl Python {
    pub fn install_requirement(
        &self,
        python: &Path,
        args: &Value,
        events: Events,
    ) -> Result<Value> {
        let requirement = args["requirement"].as_str().unwrap_or("").trim();
        if requirement.is_empty()
            || requirement.starts_with('-')
            || requirement.contains(['\0', '\n', '\r'])
        {
            return Err("Enter a valid Python package requirement.".into());
        }
        with_lock(&self.base.join("python-install.json"), || {
            self.ensure_module_uv(python, events.clone())?;
            let mut command = vec![
                "-m".into(),
                "uv".into(),
                "pip".into(),
                "install".into(),
                "--upgrade".into(),
            ];
            if args["reinstall"] == true {
                command.push("--force-reinstall".into());
            }
            command.push(requirement.into());
            self.command(
                python,
                command,
                HashMap::new(),
                None,
                Duration::from_secs(3600),
                events,
            )?;
            Ok(
                json!({"success":true,"message":format!("Package {requirement} installed successfully")}),
            )
        })
    }
    pub fn update_check(&self, args: &Value, events: Events) -> Result<Value> {
        let python = args["pythonPath"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.path());
        let installed = if args.get("knownInstalledVersion").is_some() {
            args["knownInstalledVersion"].as_str().map(str::to_owned)
        } else {
            self.installed_version(&python, "GameSentenceMiner")
        };
        let bundled = self
            .version()
            .ok_or("Could not determine bundled backend version.")?;
        let latest = latest_from_index(&bundled, self.development, INDEX_URL, &events);
        Ok(json!({"currentVersion":installed,"latestVersion":latest,
            "updateAvailable":needs_update(installed.as_deref(), &bundled, &latest, args["force"] == true)}))
    }
    fn clean_cache_best_effort(&self, python: &Path, events: Events) {
        if let Err(error) = self.run(python, &["-m", "uv", "cache", "clean"], events.clone()) {
            events(
                "log",
                json!({"stream":"stderr","message":format!("Could not clean uv cache: {error}")}),
            );
        }
    }
    fn maintenance_locked(&self, python: &Path, args: &Value, events: Events) -> Result<Value> {
        let mode = args["mode"].as_str().unwrap();
        let selection = self.extras(&args["extras"]);
        let extras = &selection["selectedExtras"];
        let check = if mode == "update" {
            self.update_check(
                &json!({"pythonPath":python,"force":args["force"]}),
                events.clone(),
            )?
        } else {
            Value::Null
        };
        let changed = mode != "update" || check["updateAvailable"] == true;
        if changed {
            self.ensure_pip(python, events.clone())
                .map_err(|e| format!("Managed Python tooling failed: {e}"))?;
            // pip is healthy here; a failed uv download is an installation
            // failure, not evidence that the whole environment is damaged.
            self.ensure_module_uv(python, events.clone())?;
            if mode == "startup_repair" {
                self.clean_cache_best_effort(python, events.clone());
            }
            let replace_backend = mode != "reset_dependencies";
            let apply = || -> Result<()> {
                stage(
                    &events,
                    "lock_sync",
                    "running",
                    Some(0.05),
                    "Synchronizing Python dependencies...",
                );
                self.sync(
                    python,
                    extras,
                    false,
                    &json!({"reinstall":mode != "update","deferValidation":replace_backend}),
                    events.clone(),
                )?;
                stage(
                    &events,
                    "lock_sync",
                    "completed",
                    Some(1.0),
                    "Python dependencies synchronized.",
                );
                if replace_backend {
                    stage(
                        &events,
                        "gsm_package",
                        "running",
                        Some(0.05),
                        "Installing the GSM backend package...",
                    );
                    self.install(python, &self.specifier()?, true, extras, events.clone())?;
                    stage(
                        &events,
                        "gsm_package",
                        "completed",
                        Some(1.0),
                        "GSM backend package installed.",
                    );
                }
                Ok(())
            };
            if let Err(error) = apply() {
                if mode != "update" {
                    return Err(error);
                }
                events(
                    "log",
                    json!({"stream":"stderr","message":format!("Dependency update failed; cleaning the cache and retrying once: {error}")}),
                );
                self.clean_cache_best_effort(python, events.clone());
                apply()?;
            }
            if mode == "update" {
                self.clean_cache_best_effort(python, events.clone());
            }
        } else {
            for id in ["verify_runtime", "lock_sync", "gsm_package"] {
                stage(
                    &events,
                    id,
                    "skipped",
                    Some(1.0),
                    "Python backend is already up to date.",
                );
            }
        }
        let installed = self.installed_version(python, "GameSentenceMiner");
        if changed
            && mode != "reset_dependencies"
            && !installed
                .as_ref()
                .zip(self.version().as_ref())
                .is_some_and(|(installed, bundled)| compatible_version(installed, bundled))
        {
            return Err(
                "Backend installation did not produce a compatible package version.".into(),
            );
        }
        Ok(
            json!({"pythonPath":python,"installedVersion":installed,"latestVersion":check["latestVersion"],"changed":changed,
            "selectedExtras":extras,"ignoredExtras":selection["ignoredExtras"]}),
        )
    }
    pub fn maintain(&self, args: &Value, events: Events) -> Result<Value> {
        if !matches!(
            args["mode"].as_str(),
            Some("update" | "repair" | "reset_dependencies" | "startup_repair")
        ) {
            return Err("Unknown Python maintenance operation".into());
        }
        if args["readOnlyEnvironment"] == true {
            return Err("Stop managed Python processes before updating their environment.".into());
        }
        let mut python = args["pythonPath"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.path());
        if !python.is_file() {
            python = self.ensure(false, events.clone())?;
        }
        let result = with_lock(&self.base.join("python-install.json"), || {
            self.maintenance_locked(&python, args, events.clone())
        });
        if result
            .as_ref()
            .err()
            .is_some_and(|e| e.starts_with("Managed Python tooling failed:"))
        {
            // Only a tooling failure triggers an environment rebuild. A failed
            // network request or package conflict must not discard a usable venv.
            python = self.ensure(true, events.clone())?;
            return with_lock(&self.base.join("python-install.json"), || {
                self.maintenance_locked(&python, args, events)
            });
        }
        result
    }
    pub fn environment_info(&self) -> Result<Value> {
        let python = self.path();
        let version = self.probe(&python, &["--version"])?;
        let pip = self.probe(&python, &["-m", "pip", "--version"])?;
        Ok(
            json!({"success":true,"pythonPath":python,"pythonVersion":version.trim(),"pipVersion":pip.trim()}),
        )
    }
    pub fn installed_packages(&self) -> Result<Value> {
        let output = self.probe(
            &self.path(),
            &["-m", "uv", "--no-progress", "pip", "list", "--format=json"],
        )?;
        let packages: Value = serde_json::from_str(&output)
            .map_err(|e| format!("Invalid installed package list: {e}"))?;
        if !packages.is_array() {
            return Err("Invalid installed package list".into());
        }
        Ok(json!({"success":true,"packages":packages}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_post_releases_local_versions_and_release_boundaries() {
        let base = "2026.11.0";
        let releases = json!({"2026.11.0.post2":[{"yanked":false}],"2026.11.0.post9":[{"yanked":true}],"2026.11.0.post10":[],"2026.12.0":[{}],"2026.11.0rc1":[{}]});
        assert_eq!(select_latest(base, &releases), "2026.11.0.post2");
        assert!(!needs_update(
            Some("2026.11.0.post3+local"),
            base,
            "2026.11.0.post2",
            false
        ));
        assert!(!needs_update(Some("2026.11.0+local"), base, base, false));
        assert!(needs_update(Some(base), base, "2026.11.0.post2", false));
        assert!(needs_update(Some("2026.10.0"), base, base, false));
        assert!(needs_update(None, base, base, false));
        assert!(needs_update(Some(base), base, base, true));
        assert!(!needs_update(
            Some("2026.11.0b1"),
            "2026.11.0-beta.1",
            "2026.11.0-beta.1",
            false
        ));
    }
    #[test]
    fn malformed_index_falls_back_and_development_does_not_fetch() {
        use std::io::Write;
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/json", socket.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut client, _) = socket.accept().unwrap();
            let mut request = [0; 1024];
            let _ = client.read(&mut request);
            client
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
        });
        let logs = Arc::new(Mutex::new(Vec::new()));
        let saved = logs.clone();
        let events: Events = Arc::new(move |_, value| saved.lock().unwrap().push(value));
        assert_eq!(
            latest_from_index("2026.11.0", true, "invalid://not-contacted", &events),
            "2026.11.0"
        );
        assert!(logs.lock().unwrap().is_empty());
        assert_eq!(
            latest_from_index("2026.11.0", false, &url, &events),
            "2026.11.0"
        );
        server.join().unwrap();
        assert_eq!(logs.lock().unwrap().len(), 1);
    }
}
