use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::http::{Request, Response};

#[derive(Default)]
pub struct Assets(
    pub Mutex<HashMap<String, PathBuf>>,
    pub Mutex<HashMap<String, String>>,
    pub Mutex<HashMap<(String, String), Vec<u8>>>,
    pub Mutex<HashSet<String>>,
);
pub fn origin() -> &'static str {
    if cfg!(windows) {
        "http://gsm.localhost"
    } else {
        "gsm://localhost"
    }
}
pub fn dictionary_origin(name: &str) -> String {
    if cfg!(windows) {
        format!("http://gsm-{name}.localhost")
    } else {
        format!("gsm-{name}://localhost")
    }
}
pub fn yomitan_font_request(request: &Request<Vec<u8>>) -> bool {
    percent_decode(request.uri().path())
        .ok()
        .is_some_and(|path| {
            gsm_packages::downloads::contains(&format!("yomitan/{}", path.trim_start_matches('/')))
        })
}
impl Assets {
    pub fn unmount(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
        self.1.lock().unwrap().remove(id);
        self.2.lock().unwrap().retain(|(mount, _), _| mount != id);
    }
    pub fn mount(&self, id: &str, directory: &Path) -> Result<(), String> {
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("Invalid resource mount".into());
        }
        self.0.lock().unwrap().insert(
            id.into(),
            directory.canonicalize().map_err(|e| e.to_string())?,
        );
        Ok(())
    }
    pub fn mount_dictionary(&self, id: &str, name: &str) -> Result<String, String> {
        if !matches!(name, "yomitan" | "hachidori" | "jiten") {
            return Err("Unknown dictionary host".into());
        }
        self.1.lock().unwrap().insert(id.into(), name.into());
        Ok(dictionary_origin(name))
    }
    pub fn document(&self, id: &str, filename: &str, content: &str) -> Result<(), String> {
        if !self.0.lock().unwrap().contains_key(id) {
            return Err("Unknown dictionary".into());
        }
        self.2
            .lock()
            .unwrap()
            .insert((id.into(), filename.into()), content.as_bytes().to_vec());
        Ok(())
    }
    pub fn url(&self, value: &str) -> Result<url::Url, String> {
        let input = url::Url::parse(value).map_err(|e| e.to_string())?;
        if input.scheme() == "file" {
            let path = input.to_file_path().map_err(|_| "Invalid file URL")?;
            let canonical = path.canonicalize().map_err(|e| e.to_string())?;
            let roots = self.0.lock().unwrap();
            let (id, relative) = roots
                .iter()
                .find_map(|(id, root)| canonical.strip_prefix(root).ok().map(|p| (id, p)))
                .ok_or_else(|| {
                    format!(
                        "Page is outside registered application resources: {}",
                        path.display()
                    )
                })?;
            let dictionaries = self.1.lock().unwrap();
            let name = dictionaries.get(id);
            let mut output = url::Url::parse(
                &name
                    .map(|name| dictionary_origin(name))
                    .unwrap_or_else(|| origin().into()),
            )
            .unwrap();
            {
                let mut segments = output.path_segments_mut().unwrap();
                if name.is_none() {
                    segments.push(id);
                }
                for part in relative.components() {
                    segments.push(&part.as_os_str().to_string_lossy());
                }
            }
            output.set_query(input.query());
            output.set_fragment(input.fragment());
            return Ok(output);
        }
        if input.scheme() == "chrome-extension" {
            let id = input.host_str().ok_or("Missing dictionary identifier")?;
            if self.3.lock().unwrap().contains(id) {
                return Ok(input);
            }
            if !self.0.lock().unwrap().contains_key(id) {
                return Err("Dictionary is not registered".into());
            }
            let dictionaries = self.1.lock().unwrap();
            let base = dictionaries
                .get(id)
                .map(|name| dictionary_origin(name))
                .unwrap_or_else(|| format!("{}/{id}", origin()));
            let mut output =
                url::Url::parse(&format!("{}{}", base, input.path())).map_err(|e| e.to_string())?;
            output.set_query(input.query());
            output.set_fragment(input.fragment());
            return Ok(output);
        }
        Ok(input)
    }
    pub fn response(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let response = |status, mime: &str, bytes: Vec<u8>| {
            Response::builder()
                .status(status)
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                .header("Cross-Origin-Resource-Policy", "cross-origin")
                .header("X-Content-Type-Options", "nosniff")
                .body(bytes)
                .unwrap()
        };
        let Ok(url) = url::Url::parse(&request.uri().to_string()) else {
            return response(400, "text/plain", vec![]);
        };
        let Ok(decoded) = percent_decode(url.path()) else {
            return response(400, "text/plain", vec![]);
        };
        let mut components = decoded.trim_start_matches('/').splitn(2, '/');
        let mut id = components.next().unwrap_or_default().to_owned();
        let mut relative = components.next().unwrap_or_default().to_owned();
        let dictionaries = self.1.lock().unwrap();
        let mut is_yomitan = false;
        if let Some((key, name)) = dictionaries.iter().find(|(_, name)| {
            url.origin().ascii_serialization() == dictionary_origin(name)
                || url.scheme() == format!("gsm-{name}")
        }) {
            id = key.clone();
            relative = decoded.trim_start_matches('/').into();
            is_yomitan = name == "yomitan";
        }
        drop(dictionaries);
        if relative == "__gsm_migration__.html" && self.0.lock().unwrap().contains_key(&id) {
            return response(
                200,
                "text/html; charset=utf-8",
                b"<!doctype html><meta charset=utf-8><title>GSM dictionary transfer</title>"
                    .to_vec(),
            );
        }
        if relative.starts_with("__gsm_") {
            if let Some(bytes) = self.2.lock().unwrap().get(&(id.clone(), relative.clone())) {
                let mime = mime_guess::from_path(&relative).first_or_octet_stream();
                return response(200, mime.as_ref(), bytes.clone());
            }
        }
        let Some(root) = self.0.lock().unwrap().get(&id).cloned() else {
            return response(404, "text/plain", b"Unknown resource".to_vec());
        };
        let candidate = root.join(&relative);
        let asset = format!("yomitan/{relative}");
        let path = if is_yomitan && gsm_packages::downloads::contains(&asset) {
            let bundled = candidate.canonicalize().ok().filter(|path| path.starts_with(&root));
            match gsm_packages::download_cache().and_then(|cache| {
                gsm_packages::downloads::ensure_asset(&cache, &asset, bundled.as_deref())
            }) {
                Ok(path) => path,
                Err(error) => {
                    crate::desktop_log::stderr_only(
                        "assets",
                        "WARNING",
                        format!("Could not load {asset}: {error}"),
                    );
                    return response(503, "text/plain", vec![]);
                }
            }
        } else {
            let Ok(path) = candidate.canonicalize() else {
                return response(404, "text/plain", vec![]);
            };
            if !path.starts_with(&root) || !path.is_file() {
                return response(403, "text/plain", vec![]);
            }
            path
        };
        let Ok(bytes) = std::fs::read(&path) else {
            return response(404, "text/plain", vec![]);
        };
        // WebKit does not install Tauri IPC in an embedded dictionary frame.
        // Initialize the popup's dictionary API before its first module runs.
        if is_yomitan && relative == "popup.html" {
            let html = String::from_utf8_lossy(&bytes).replacen(
                "<head>",
                r#"<head><script src="/__gsm_popup_bridge__.js"></script>"#,
                1,
            );
            return response(200, "text/html; charset=utf-8", html.into_bytes());
        }
        response(
            200,
            mime_guess::from_path(&path)
                .first_or_octet_stream()
                .as_ref(),
            bytes,
        )
    }
}
fn percent_decode(value: &str) -> Result<String, ()> {
    let mut bytes = Vec::new();
    let mut input = value.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let a = (input.next().ok_or(())? as char).to_digit(16).ok_or(())?;
            let b = (input.next().ok_or(())? as char).to_digit(16).ok_or(())?;
            bytes.push((a * 16 + b) as u8);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).map_err(|_| ())
}
pub fn trusted(url: &url::Url) -> bool {
    (url.scheme() == "gsm" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("gsm.localhost"))
        || ["yomitan", "hachidori", "jiten"].iter().any(|name| {
            url.origin().ascii_serialization() == dictionary_origin(name)
                || (url.scheme() == format!("gsm-{name}") && url.host_str() == Some("localhost"))
        })
        || (cfg!(debug_assertions)
            && std::env::var("VITE_DEV_SERVER_URL")
                .ok()
                .and_then(|value| url::Url::parse(&value).ok())
                .is_some_and(|dev| dev.origin() == url.origin()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_remote_origins_and_encoded_traversal() {
        assert!(!trusted(&url::Url::parse("https://example.com").unwrap()));
        assert!(!trusted(
            &url::Url::parse("http://gsm.localhost.evil.test").unwrap()
        ));
        assert_eq!(percent_decode("/%2e%2e/secret").unwrap(), "/../secret");
        assert!(percent_decode("/%ff").is_err());
    }
}
