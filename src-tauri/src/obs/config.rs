pub(super) static SETTINGS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
use super::*;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct Paths {
    pub base: PathBuf,
    pub recordings: PathBuf,
    pub policy: PathBuf,
}
impl Paths {
    pub fn root(&self) -> PathBuf {
        self.base.join("obs-studio")
    }
    pub fn obs(&self) -> PathBuf {
        self.root().join("config/obs-studio")
    }
    pub fn desktop(&self) -> PathBuf {
        self.base.join("obs-service.json")
    }
    pub fn import_settings(&self) -> Result<(), String> {
        if self.desktop().exists() {
            return Ok(());
        }
        let previous = read_json(&self.base.join("electron/config.json"))?;
        write_json(
            &self.desktop(),
            &json!({"schemaVersion":1,"autoUpdateOBS":previous["autoUpdateOBS"]==true,"windowSceneSwitcher":previous.get("windowSceneSwitcher").cloned().unwrap_or_else(||json!({"schemaVersion":1,"collections":[]}))}),
        )
    }
    pub fn executable(&self) -> PathBuf {
        self.root().join("bin/64bit/obs64.exe")
    }
    pub fn profile(&self) -> Result<Value, String> {
        let value = read_json(&self.base.join("config.json"))?;
        let profiles = &value["configs"];
        Ok(
            profiles[value["current_profile"].as_str().unwrap_or("Default")]
                .as_object()
                .map(|v| json!(v))
                .unwrap_or_else(|| profiles["Default"].clone()),
        )
    }
    pub fn settings(&self) -> Result<Value, String> {
        Ok(self.profile()?["obs"].clone())
    }
    pub fn launch_command(&self, fallback: bool) -> Result<(PathBuf, Vec<String>), String> {
        let config = self.settings()?;
        let default = if cfg!(windows) {
            self.executable()
        } else if cfg!(target_os = "macos") {
            "/opt/homebrew/bin/obs".into()
        } else {
            "/usr/bin/obs".into()
        };
        let raw = config["obs_path"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(str::trim)
            .map(str::to_owned)
            .unwrap_or_else(|| default.to_string_lossy().into_owned());
        if Path::new(&raw).is_file() {
            return Ok((Path::new(&raw).canonicalize().map_err(err)?, vec![]));
        }
        let words = process::split_command(&raw)?;
        let exe = words.first().ok_or("No OBS executable configured")?;
        if (exe.contains('/') || exe.contains('\\')) && !Path::new(exe).is_file() {
            if fallback {
                return Ok((
                    process::resolve_executable(Path::new("obs")).unwrap_or_else(|| "obs".into()),
                    vec![],
                ));
            }
            return Err(format!("OBS executable not found: {exe}"));
        }
        Ok((
            process::resolve_executable(Path::new(exe)).unwrap_or_else(|| exe.into()),
            words[1..].to_vec(),
        ))
    }
    pub fn managed(&self) -> Result<bool, String> {
        let settings = self.settings()?;
        let host = settings["host"].as_str().unwrap_or("localhost");
        let configured = settings["obs_path"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.executable());
        Ok(cfg!(windows)
            && process::same_path(&configured, &self.executable())
            && ["localhost", "127.0.0.1", "::1"].contains(&host))
    }
    pub fn connection(&self) -> Result<(String, String), String> {
        let settings = self.settings()?;
        let host = settings["host"].as_str().unwrap_or("localhost");
        let mut port = settings["port"]
            .as_u64()
            .or_else(|| settings["port"].as_str()?.parse().ok())
            .filter(|p| *p > 0 && *p < 65536)
            .unwrap_or(7274);
        let mut password = settings["password"].as_str().unwrap_or("").to_owned();
        if self.managed()? && settings["open_obs"] != false {
            let server = read_json(&self.obs().join("plugin_config/obs-websocket/config.json"))?;
            if let Some(p) = server["server_port"]
                .as_u64()
                .or_else(|| server["server_port"].as_str()?.parse().ok())
                .filter(|p| *p > 0 && *p < 65536)
            {
                port = p;
            }
            if password.is_empty() || password == "your_password" {
                if let Some(p) = server["server_password"].as_str() {
                    password = p.into();
                }
            }
        }
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.into()
        };
        Ok((format!("ws://{host}:{port}"), password))
    }
    pub fn seed(&self) -> Result<(), String> {
        if !self.managed()? {
            return Ok(());
        }
        let version = runtime::read_version(&self.executable())?
            .and_then(|v| runtime::version(&v))
            .map(|v| (v[0] << 24) | (v[1] << 16) | v[2]);
        let global = format!("[General]\nFirstRun=true\n{}Pre19Defaults=false\nPre21Defaults=false\nPre23Defaults=false\nPre24.1Defaults=false\n\n[Basic]\nProfile=GSM\nProfileDir=GSM\nSceneCollection=Untitled\nSceneCollectionFile=Untitled\n\n[BasicWindow]\nSysTrayEnabled=true\nSysTrayWhenStarted=true\n",version.map(|v|format!("LastVersion={v}\n")).unwrap_or_default());
        for name in ["global.ini", "user.ini"] {
            write_missing(&self.obs().join(name), global.as_bytes())?;
        }
        for name in ["GSM", "Untitled"] {
            let target = self.obs().join(format!("basic/profiles/{name}/basic.ini"));
            let safe = self.recordings.to_string_lossy().replace('\\', "/");
            write_missing(&target, format!("[SimpleOutput]\nFilePath={safe}\nRecRB=true\nRecRBTime=300\nRecRBSize=512\nRecAudioEncoder=opus\nRecRBPrefix=GSM\n").as_bytes())?;
            let old = fs::read_to_string(&target).map_err(err)?;
            let unsafe_path = self.recordings.to_string_lossy();
            let fixed = old.replace(
                &format!("FilePath={unsafe_path}"),
                &format!("FilePath={safe}"),
            );
            if old != fixed {
                atomic_write(&target, fixed.as_bytes())?;
            }
        }
        write_missing(
            &self.obs().join("basic/scenes/Untitled.json"),
            include_bytes!("default-scene.json"),
        )?;
        Ok(())
    }
    pub fn prepare_port(&self) -> Result<(), String> {
        if !self.managed()? {
            return Ok(());
        }
        let settings = self.settings()?;
        let preferred = settings["port"]
            .as_u64()
            .or_else(|| settings["port"].as_str()?.parse().ok())
            .filter(|p| *p > 0 && *p < 65536)
            .unwrap_or(7274) as u16;
        let socket = std::net::TcpListener::bind(("127.0.0.1", preferred))
            .or_else(|_| std::net::TcpListener::bind(("127.0.0.1", 0)))
            .map_err(err)?;
        let port = socket.local_addr().map_err(err)?.port();
        let target = self.obs().join("plugin_config/obs-websocket/config.json");
        let mut server = read_json(&target)?;
        if !server.is_object() {
            server = json!({});
        }
        server["server_enabled"] = json!(true);
        server["auth_required"] = json!(false);
        server["alerts_enabled"] = json!(false);
        server["first_load"] = json!(false);
        server["server_port"] = json!(port);
        if server["server_password"].as_str().unwrap_or("").is_empty() {
            server["server_password"] =
                json!(settings["password"].as_str().unwrap_or("your_password"));
        }
        write_json(&target, &server)
    }
    pub fn snapshot(&self, reason: &str) -> Result<(), String> {
        let destination = self.base.join("backup/obs");
        fs::create_dir_all(&destination).map_err(err)?;
        let name = format!(
            "{}-{}",
            chrono::Utc::now()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                .replace([':', '.'], "-"),
            uuid::Uuid::new_v4()
        );
        let temporary = destination.join(format!(".pending-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&temporary).map_err(err)?;
        let result = (|| {
            copy_tree(&self.obs().join("basic"), &temporary.join("basic"), &|_| {
                true
            })?;
            for (source, relative) in [
                (self.obs().join("global.ini"), "global.ini"),
                (self.obs().join("user.ini"), "user.ini"),
                (self.base.join("config.json"), "gsm/config.json"),
                (
                    self.base.join("electron/config.json"),
                    "gsm/electron-config.json",
                ),
                (self.desktop(), "gsm/obs-service.json"),
            ] {
                copy_tree(&source, &temporary.join(relative), &|_| true)?;
            }
            write_json(
                &temporary.join("snapshot.json"),
                &json!({"version":1,"reason":reason,"createdAt":chrono::Utc::now().to_rfc3339()}),
            )?;
            fs::rename(&temporary, destination.join(name)).map_err(err)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&temporary);
        }
        result?;
        let pattern = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f\d-]{36}$").unwrap();
        let mut snapshots: Vec<_> = fs::read_dir(&destination)
            .map_err(err)?
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_type().is_ok_and(|t| t.is_dir())
                    && pattern.is_match(&e.file_name().to_string_lossy())
            })
            .map(|e| e.path())
            .collect();
        snapshots.sort();
        for old in snapshots.iter().rev().skip(20) {
            fs::remove_dir_all(old).map_err(err)?;
        }
        Ok(())
    }
}
pub fn read_json(path: &Path) -> Result<Value, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(err(e)),
    }
}
pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    atomic_write(path, &serde_json::to_vec_pretty(value).map_err(err)?)
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Missing parent directory")?).map_err(err)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(err)?;
        file.write_all(bytes).map_err(err)?;
        file.sync_all().map_err(err)?;
        drop(file);
        fs::rename(&temporary, path).map_err(err)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn write_missing(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        Ok(())
    } else {
        atomic_write(path, bytes)
    }
}
pub fn copy_tree(
    source: &Path,
    target: &Path,
    filter: &dyn Fn(&Path) -> bool,
) -> Result<(), String> {
    if !source.exists() || !filter(source) {
        return Ok(());
    }
    let meta = fs::symlink_metadata(source).map_err(err)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        fs::create_dir_all(target).map_err(err)?;
        for entry in fs::read_dir(source).map_err(err)? {
            let e = entry.map_err(err)?;
            copy_tree(&e.path(), &target.join(e.file_name()), filter)?;
        }
    } else if meta.is_file() {
        fs::create_dir_all(target.parent().unwrap()).map_err(err)?;
        fs::copy(source, target).map_err(err)?;
    }
    Ok(())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    pub struct Fixture(pub Paths);
    impl Fixture {
        pub fn new() -> Self {
            let base = std::env::temp_dir().join(format!("gsm-obs-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&base).unwrap();
            let paths = Paths {
                recordings: base.join("recordings"),
                policy: base.join("policy.json"),
                base,
            };
            write_json(&paths.policy, &json!({"version":"33.0.2"})).unwrap();
            Self(paths)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0.base);
        }
    }
    #[test]
    fn current_profile_and_connection_are_native() {
        let fixture = Fixture::new();
        let p = &fixture.0;
        write_json(&p.base.join("config.json"),&json!({"current_profile":"Game","configs":{"Default":{"obs":{"port":1111}},"Game":{"obs":{"host":"::1","port":4321,"password":"secret","open_obs":false}}}})).unwrap();
        assert_eq!(
            p.connection().unwrap(),
            ("ws://[::1]:4321".into(), "secret".into())
        );
    }
    #[test]
    fn missing_profile_uses_default() {
        let f = Fixture::new();
        write_json(&f.0.base.join("config.json"),&json!({"current_profile":"gone","configs":{"Default":{"obs":{"port":1234,"open_obs":false}}}})).unwrap();
        assert_eq!(f.0.connection().unwrap().0, "ws://localhost:1234");
    }
    #[test]
    fn settings_import_is_once_and_preserves_legacy_file() {
        let f = Fixture::new();
        let old = f.0.base.join("electron/config.json");
        let rules =
            json!({"schemaVersion":1,"collections":[{"collectionName":"日本語","rules":[]}]});
        let original = json!({"autoUpdateOBS":true,"windowSceneSwitcher":rules,"theme":"custom"});
        write_json(&old, &original).unwrap();
        f.0.import_settings().unwrap();
        assert_eq!(
            read_json(&f.0.desktop()).unwrap()["windowSceneSwitcher"],
            rules
        );
        write_json(&f.0.desktop(), &json!({"autoUpdateOBS":false})).unwrap();
        f.0.import_settings().unwrap();
        assert_eq!(read_json(&f.0.desktop()).unwrap()["autoUpdateOBS"], false);
        assert_eq!(read_json(&old).unwrap(), original);
    }
    #[test]
    fn malformed_configuration_is_not_silently_overwritten() {
        let f = Fixture::new();
        atomic_write(&f.0.base.join("config.json"), b"broken").unwrap();
        assert!(f.0.connection().is_err());
    }
    #[test]
    fn snapshots_preserve_settings_and_only_expire_owned_backups() {
        let f = Fixture::new();
        let source = f.0.obs().join("basic/scenes/Game.json");
        write_json(&source, &json!({"name":"日本語"})).unwrap();
        let custom = f.0.base.join("backup/obs/my-backup");
        fs::create_dir_all(&custom).unwrap();
        for n in 0..22 {
            f.0.snapshot(&format!("snapshot {n}")).unwrap();
        }
        let snapshots: Vec<_> = fs::read_dir(f.0.base.join("backup/obs"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().join("snapshot.json").is_file())
            .collect();
        assert_eq!(snapshots.len(), 20);
        assert!(custom.is_dir());
        assert_eq!(
            read_json(&snapshots[0].path().join("basic/scenes/Game.json")).unwrap()["name"],
            "日本語"
        );
    }
    #[test]
    fn seed_retains_existing_scene_and_profile() {
        if !cfg!(windows) {
            return;
        }
        let f = Fixture::new();
        let file = f.0.obs().join("basic/profiles/GSM/basic.ini");
        atomic_write(
            &file,
            b"[SimpleOutput]\nFilePath=D:/custom\nRecRBTime=900\n",
        )
        .unwrap();
        let scene = f.0.obs().join("basic/scenes/Untitled.json");
        write_json(&scene, &json!({"name":"mine"})).unwrap();
        f.0.seed().unwrap();
        assert!(fs::read_to_string(file).unwrap().contains("RecRBTime=900"));
        assert_eq!(read_json(&scene).unwrap()["name"], "mine");
    }
    #[test]
    fn busy_preferred_port_gets_a_persisted_free_alternative() {
        if !cfg!(windows) {
            return;
        }
        let f = Fixture::new();
        let bound = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = bound.local_addr().unwrap().port();
        write_json(
            &f.0.base.join("config.json"),
            &json!({"configs":{"Default":{"obs":{"port":port}}}}),
        )
        .unwrap();
        f.0.prepare_port().unwrap();
        let config = read_json(&f.0.obs().join("plugin_config/obs-websocket/config.json")).unwrap();
        assert_ne!(config["server_port"], port);
        assert_eq!(config["auth_required"], false);
    }
}
