//! Shared native desktop state, window targeting, documentation windows, and relaunch control.
use crate::assets::Assets;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

const DOCS_HOSTNAME: &str = "docs.gamesentenceminer.com";

type EvalReply = oneshot::Sender<Result<Value, String>>;

pub struct DesktopState {
    pub app_root: PathBuf,
    pub profile_dir: Option<PathBuf>,
    pub assets: Arc<Assets>,
    pub runtime_state: gsm_settings::runtime_state::RuntimeState,
    pub http: reqwest::Client,
    docs_seq: AtomicU64,
    eval_seq: AtomicU64,
    window_tokens: Mutex<HashMap<String, String>>,
    window_scopes: Mutex<HashMap<String, String>>,
    evaluations: Mutex<HashMap<u64, (String, EvalReply)>>,
    relaunch: Arc<Mutex<Option<Vec<String>>>>,
    pub quitting: AtomicBool,
}

impl DesktopState {
    pub fn with_runtime(
        app_root: PathBuf,
        profile_dir: Option<PathBuf>,
        assets: Arc<Assets>,
        relaunch: Arc<Mutex<Option<Vec<String>>>>,
    ) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("GameSentenceMiner")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            app_root,
            profile_dir,
            assets,
            runtime_state: gsm_settings::runtime_state::RuntimeState::new(),
            http,
            docs_seq: AtomicU64::new(1),
            eval_seq: AtomicU64::new(1),
            window_tokens: Mutex::new(HashMap::new()),
            window_scopes: Mutex::new(HashMap::new()),
            evaluations: Mutex::new(HashMap::new()),
            relaunch,
            quitting: AtomicBool::new(false),
        }
    }

    pub fn assets_dir(&self) -> PathBuf {
        resolve_assets_dir(&self.app_root)
    }

    pub fn next_docs_label(&self) -> String {
        let id = self.docs_seq.fetch_add(1, Ordering::Relaxed);
        format!("docs-{id}")
    }

    pub fn register_window(&self, label: impl Into<String>, scope: impl Into<String>) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        self.register_window_with_token(label, scope, token.clone());
        token
    }

    pub fn register_window_with_token(
        &self,
        label: impl Into<String>,
        scope: impl Into<String>,
        token: String,
    ) {
        let label = label.into();
        self.window_tokens
            .lock()
            .unwrap()
            .insert(label.clone(), token);
        self.window_scopes
            .lock()
            .unwrap()
            .insert(label, scope.into());
    }

    pub fn unregister_window(&self, label: &str) {
        self.window_tokens.lock().unwrap().remove(label);
        self.window_scopes.lock().unwrap().remove(label);
        let mut evaluations = self.evaluations.lock().unwrap();
        let stale: Vec<u64> = evaluations
            .iter()
            .filter_map(|(id, (owner, _))| (owner == label).then_some(*id))
            .collect();
        for id in stale {
            if let Some((_, sender)) = evaluations.remove(&id) {
                let _ = sender.send(Err("Webview closed".into()));
            }
        }
    }

    pub fn window_scope(&self, label: &str) -> Option<String> {
        self.window_scopes.lock().unwrap().get(label).cloned()
    }

    pub fn desktop_labels(&self) -> Vec<String> {
        self.window_scopes
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(label, scope)| (scope == "desktop").then(|| label.clone()))
            .collect()
    }

    pub fn authorize(&self, window: &WebviewWindow, token: &str) -> Result<(), String> {
        // The nonce is installed only in local application documents. Checking it
        // does not synchronously query WebView2 from inside a protocol callback,
        // which can deadlock when a dictionary uses a separate persistent profile.
        if self
            .window_tokens
            .lock()
            .unwrap()
            .get(window.label())
            .is_some_and(|expected| expected == token)
        {
            Ok(())
        } else {
            Err("This page does not have desktop access".into())
        }
    }

    pub fn set_relaunch(&self, args: Vec<String>) {
        *self.relaunch.lock().unwrap() = Some(args);
    }

    pub async fn evaluate(&self, window: &WebviewWindow, source: &str) -> Result<Value, String> {
        let id = self.eval_seq.fetch_add(1, Ordering::Relaxed);
        let token = self
            .window_tokens
            .lock()
            .unwrap()
            .get(window.label())
            .cloned()
            .ok_or("Window is closed")?;
        let (tx, rx) = oneshot::channel();
        self.evaluations
            .lock()
            .unwrap()
            .insert(id, (window.label().into(), tx));
        struct EvalGuard<'a> {
            state: &'a DesktopState,
            id: u64,
        }
        impl Drop for EvalGuard<'_> {
            fn drop(&mut self) {
                self.state.evaluations.lock().unwrap().remove(&self.id);
            }
        }
        let _guard = EvalGuard { state: self, id };
        let script = format!(
            "(() => {{ const reply=(result,error)=>window.__TAURI_INTERNALS__.invoke('evaluation_result',{{id:{id},result,error,token:{token}}}); (async()=>{{\n{source}\n}})().then(result => reply(result ?? null, null), error => reply(null, String(error) + '\\n' + (error?.stack || ''))); }})();",
            token = json!(token)
        );
        if let Err(error) = window.eval(&script) {
            return Err(error.to_string());
        }
        let result = tokio::time::timeout(Duration::from_secs(60), rx).await;
        result
            .map_err(|_| "Webview operation timed out")?
            .map_err(|_| "Webview closed")?
    }

    pub fn resolve_evaluation(
        &self,
        label: &str,
        id: u64,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<(), String> {
        let mut pending = self.evaluations.lock().unwrap();
        if pending.get(&id).is_some_and(|(owner, _)| owner != label) {
            return Err("Evaluation belongs to another window".into());
        }
        if let Some((_, sender)) = pending.remove(&id) {
            let _ = sender.send(error.map_or(Ok(result.unwrap_or(Value::Null)), Err));
        }
        Ok(())
    }
}

pub fn theme_for_app(app: &tauri::AppHandle) -> String {
    app.try_state::<crate::settings::Settings>()
        .and_then(|s| {
            gsm_settings::preferences::Preferences::new(&s.paths.active)
                .get("theme")
                .ok()
                .flatten()
        })
        .and_then(|v| v.as_str().map(str::to_owned))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "gsm-dark".into())
}

pub fn resolve_assets_dir(app_root: &Path) -> PathBuf {
    let dev_assets = app_root.join("electron-src").join("assets");
    if dev_assets.join("gsm.ico").exists() || dev_assets.join("changelog").is_dir() {
        dev_assets
    } else {
        app_root.join("assets")
    }
}

pub fn is_allowed_docs_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    let Ok(parsed) = url::Url::parse(trimmed) else {
        return false;
    };
    parsed.scheme() == "https" && parsed.host_str() == Some(DOCS_HOSTNAME)
}

pub fn emit_to_window(app: &tauri::AppHandle, label: &str, channel: &str, args: &[Value]) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let script = format!(
        "window.__GSM_DESKTOP_DISPATCH__?.({}, {})",
        json!(channel),
        json!(args)
    );
    let _ = window.eval(&script);
}

pub fn emit_to_desktop_windows(app: &tauri::AppHandle, channel: &str, args: &[Value]) {
    let script = format!(
        "window.__GSM_DESKTOP_DISPATCH__?.({}, {})",
        json!(channel),
        json!(args)
    );
    let labels = desktop_window_labels(app);
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.eval(&script);
        }
    }
}

pub fn desktop_window_labels(app: &tauri::AppHandle) -> Vec<String> {
    if let Some(state) = app.try_state::<DesktopState>() {
        return state.desktop_labels();
    }
    app.webview_windows()
        .into_iter()
        .filter_map(|(label, win)| {
            if let Ok(url) = win.url() {
                if crate::assets::trusted(&url) {
                    return Some(label);
                }
            }
            None
        })
        .collect()
}

pub fn find_hub_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    if let Some(win) = app.get_webview_window("gsm-hub") {
        return Some(win);
    }
    if let Some(win) = app.get_webview_window("main") {
        return Some(win);
    }
    let mut fallback = None;
    for label in desktop_window_labels(app) {
        let Some(win) = app.get_webview_window(&label) else {
            continue;
        };
        if let Ok(url) = win.url() {
            let path = url.path();
            if path.contains("/renderer/") || path.ends_with("/index.html") {
                return Some(win);
            }
        }
        if fallback.is_none() && !label.starts_with("docs-") && !label.starts_with("agent-ui-") {
            fallback = Some(win);
        }
    }
    fallback
}

pub fn focus_window(window: &WebviewWindow) -> Result<(), String> {
    if window.is_minimized().unwrap_or(false) {
        window.unminimize().map_err(|e| e.to_string())?;
    }
    window.show().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        crate::window_platform::apply(window, "focus", &Value::Null)?;
    }
    #[cfg(not(windows))]
    {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn open_docs_window(
    app: &tauri::AppHandle,
    parent_label: &str,
    raw_url: &str,
) -> Result<(), String> {
    if !is_allowed_docs_url(raw_url) {
        return Err("Invalid documentation URL.".into());
    }
    let parsed = url::Url::parse(raw_url.trim()).map_err(|e| e.to_string())?;
    let label = app.state::<DesktopState>().next_docs_label();

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .title("GameSentenceMiner Documentation")
        .inner_size(1280.0, 920.0)
        .min_inner_size(800.0, 500.0)
        .menu(tauri::menu::Menu::new(app).map_err(|e| e.to_string())?)
        .on_navigation(|url| {
            if is_allowed_docs_url(url.as_str()) {
                true
            } else {
                let _ = crate::native::shell_open_external(url.as_str());
                false
            }
        })
        .on_new_window({
            let app = app.clone();
            let label = label.clone();
            move |url, _| {
                if is_allowed_docs_url(url.as_str()) {
                    if let Some(win) = app.get_webview_window(&label) {
                        let _ = win.navigate(url);
                    }
                } else {
                    let _ = crate::native::shell_open_external(url.as_str());
                }
                tauri::webview::NewWindowResponse::Deny
            }
        });

    if let Some(parent) = app.get_webview_window(parent_label) {
        builder = builder.parent(&parent).map_err(|e| e.to_string())?;
    } else if let Some(hub) = find_hub_window(app) {
        builder = builder.parent(&hub).map_err(|e| e.to_string())?;
    }

    let built = builder.build().map_err(|e| e.to_string())?;
    let _ = built.hide_menu();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn docs_url_validation_rejects_untrusted_origins_and_schemes() {
        assert!(is_allowed_docs_url(
            "https://docs.gamesentenceminer.com/docs/features/ocr"
        ));
        assert!(!is_allowed_docs_url(
            "http://docs.gamesentenceminer.com/docs/features/ocr"
        ));
        assert!(!is_allowed_docs_url("https://example.com/docs"));
        assert!(!is_allowed_docs_url("file:///etc/passwd"));
        assert!(!is_allowed_docs_url("   "));
    }

    #[test]
    fn resolves_dev_vs_packaged_assets_directory() {
        let dir = tempdir().unwrap();
        let dev = dir.path().join("electron-src").join("assets");
        std::fs::create_dir_all(&dev).unwrap();
        std::fs::write(dev.join("gsm.ico"), b"").unwrap();
        assert_eq!(resolve_assets_dir(dir.path()), dev);

        let packaged = tempdir().unwrap();
        std::fs::create_dir_all(packaged.path().join("assets")).unwrap();
        assert_eq!(
            resolve_assets_dir(packaged.path()),
            packaged.path().join("assets")
        );
    }
}
