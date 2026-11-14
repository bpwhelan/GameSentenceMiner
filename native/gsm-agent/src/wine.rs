use crate::frida::Cancellation;
use serde_json::Value;
use std::{
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
pub struct Wine {
    pub address: String,
    child: Child,
}
impl Drop for Wine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub fn launch(
    options: &Value,
    cancel: &Cancellation,
    log: &dyn Fn(&str),
) -> Result<Option<Wine>, String> {
    let launch = &options["wineLaunch"];
    if launch.is_null() {
        return Ok(None);
    }
    let arch = if options["arch"] == "x86" {
        "x86"
    } else {
        "x86_64"
    };
    let name = format!("frida-server-{}-windows-{arch}.exe", crate::FRIDA_VERSION);
    let cached = PathBuf::from(
        options["baseDir"]
            .as_str()
            .ok_or("Missing data directory")?,
    )
    .join("texthook/frida-server")
    .join(crate::FRIDA_VERSION)
    .join(&name);
    let override_key = if arch == "x86" {
        "GSM_FRIDA_SERVER_X86_PATH"
    } else {
        "GSM_FRIDA_SERVER_X64_PATH"
    };
    let override_path = std::env::var_os(override_key).map(PathBuf::from);
    if override_path.as_ref().is_some_and(|path| !path.is_file()) {
        return Err(format!("{override_key} does not point to a file"));
    }
    let server = override_path.unwrap_or(cached);
    if !server.is_file() {
        log("Downloading the native Wine bridge…");
        let url = format!(
            "https://github.com/frida/frida/releases/download/{}/{}.xz",
            crate::FRIDA_VERSION,
            name
        );
        let response = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|e| e.to_string())?
            .get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| e.to_string())?;
        let bytes = response.bytes().map_err(|e| e.to_string())?;
        use sha2::{Digest, Sha256};
        let expected = if arch == "x86" {
            "2b3b9c4176cc8939572ad9a003ed2e903fd49fa6d6e15d4d5f8ce18124d2c921"
        } else {
            "6480897078125ca80e1bec2e2559bc7c9ec67d2514e4415d75c80679ebf34c09"
        };
        if format!("{:x}", Sha256::digest(&bytes)) != expected {
            return Err("Agent Wine bridge checksum mismatch".into());
        }
        let mut unpack = lzma_rust2::XzReader::new(bytes.as_ref(), false);
        let mut output = vec![];
        std::io::Read::read_to_end(&mut unpack, &mut output).map_err(|e| e.to_string())?;
        if cancel.cancelled() {
            return Err("Agent startup cancelled".into());
        }
        crate::core::write_atomic(&server, &output)?;
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let address = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .to_string();
    drop(listener);
    let mut cmd = Command::new(
        launch["launcherPath"]
            .as_str()
            .ok_or("Missing Wine launcher")?,
    );
    cmd.env_clear();
    cmd.arg(&server)
        .args(["--listen", &address])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(env) = launch["env"].as_object() {
        for (k, v) in env {
            if let Some(v) = v.as_str() {
                cmd.env(k, v);
            }
        }
    }
    if launch["launcherKind"] == "umu"
        || launch["launcherPath"]
            .as_str()
            .is_some_and(|s| s.contains("umu"))
    {
        cmd.env("PROTON_VERB", "run");
    }
    let cwd = launch["env"]["STEAM_COMPAT_INSTALL_PATH"]
        .as_str()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| server.parent().unwrap().to_path_buf());
    cmd.current_dir(cwd);
    let mut wine = Wine {
        address: address.clone(),
        child: cmd.spawn().map_err(|e| e.to_string())?,
    };
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if cancel.cancelled() {
            return Err("Agent startup cancelled".into());
        }
        if TcpStream::connect_timeout(&address.parse().unwrap(), Duration::from_millis(100)).is_ok()
        {
            return Ok(Some(wine));
        }
        if wine.child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err("Agent Wine bridge exited before connecting".into());
        }
        if Instant::now() >= deadline {
            return Err("Agent Wine bridge did not start".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
}
