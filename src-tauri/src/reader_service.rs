//! Native Rust Home Reader & Dictionary lookup/search IPC service.
//! Replaces `electron-src/main/services/reader.ts` and `reader_dictionary.ts`.

use crate::dictionary_host::{
    apply_profile_data_directory, evaluate_raw, overlay_data_path,
    strip_windows_verbatim_prefix, use_windows_native_extensions, DictionaryManager,
    LoadedExtension,
};
use reqwest::Method;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex as StdMutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::sync::Mutex as AsyncMutex;

pub const LOOKUP_PAGE_LABEL: &str = "gsm-reader-lookup";
pub const DICTIONARY_SEARCH_LABEL: &str = "gsm-dictionary-search";
pub const LEGACY_PREFS_LABEL: &str = "gsm-legacy-prefs";

#[derive(Default)]
pub struct ReaderState {
    prepare_lock: AsyncMutex<()>,
    search_lock: AsyncMutex<()>,
    last_used: Arc<StdMutex<Option<Instant>>>,
    in_flight: Arc<AtomicUsize>,
}

struct LookupLease {
    last_used: Arc<StdMutex<Option<Instant>>>,
    in_flight: Arc<AtomicUsize>,
}

impl LookupLease {
    fn acquire(state: &ReaderState) -> Self {
        state.in_flight.fetch_add(1, Ordering::SeqCst);
        *state.last_used.lock().unwrap() = Some(Instant::now());
        Self {
            last_used: state.last_used.clone(),
            in_flight: state.in_flight.clone(),
        }
    }
}

impl Drop for LookupLease {
    fn drop(&mut self) {
        *self.last_used.lock().unwrap() = Some(Instant::now());
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

pub async fn release_idle_lookup(app: &AppHandle, idle_for: Duration) -> bool {
    let Some(state) = app.try_state::<ReaderState>() else {
        return false;
    };
    let Ok(_guard) = state.prepare_lock.try_lock() else {
        return false;
    };
    if state.in_flight.load(Ordering::SeqCst) > 0 {
        return false;
    }
    let expired = state
        .last_used
        .lock()
        .unwrap()
        .is_some_and(|at| at.elapsed() >= idle_for);
    if !expired {
        return false;
    }
    let Some(window) = app.get_webview_window(LOOKUP_PAGE_LABEL) else {
        *state.last_used.lock().unwrap() = None;
        return false;
    };
    // The setup request returns as soon as the import starts. Its worker belongs
    // to this document even after the guide is paused or the Hub is hidden.
    if evaluate_raw(app, &window, "window.__gsmDictionaryBusy === true").await == Ok(json!(true)) {
        return false;
    }
    if destroy_reader_window(app, &window).await.is_ok() {
        *state.last_used.lock().unwrap() = None;
        return true;
    }
    false
}

pub(crate) async fn destroy_reader_window(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let label = window.label().to_owned();
    window.destroy().map_err(|e| e.to_string())?;
    // Destruction is queued on the UI thread. Reusing the label before that
    // event finishes fails intermittently after a dictionary has been disabled.
    for _ in 0..250 {
        if app.get_webview_window(&label).is_none() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Err(format!("Timed out closing dictionary window {label}"))
}

/// Recursively flatten structured dictionary definition objects into readable plain text.
pub fn dictionary_text(value: &Value, depth: usize) -> String {
    if depth > 12 {
        return String::new();
    }
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            let mut out = String::new();
            for item in items {
                out.push_str(&dictionary_text(item, depth + 1));
            }
            out
        }
        Value::Object(map) => {
            if map.get("tag").and_then(Value::as_str) == Some("br") {
                return "\n".to_string();
            }
            let inner = map
                .get("content")
                .or_else(|| map.get("text"))
                .or_else(|| map.get("value"))
                .unwrap_or(&Value::Null);
            let mut content = if inner.is_null() {
                String::new()
            } else {
                dictionary_text(inner, depth + 1)
            };
            if matches!(
                map.get("tag").and_then(Value::as_str),
                Some("li" | "div" | "p")
            ) {
                content.push('\n');
            }
            content
        }
        _ => String::new(),
    }
}

fn value_as_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// Normalize Yomitan or Hachidori raw lookup payloads into the Home Reader entry schema.
pub fn normalize_dictionary_result(value: &Value, reader: &str) -> Value {
    let source = value
        .get("dictionaryEntries")
        .or_else(|| value.get("entries"))
        .or_else(|| value.get("results"))
        .or_else(|| value.get("result").and_then(|r| r.get("entries")))
        .and_then(Value::as_array);

    let mut entries: Vec<Value> = Vec::new();
    if let Some(items) = source {
        for item in items.iter().take(30) {
            if !item.is_object() {
                continue;
            }
            let head = item
                .get("headwords")
                .and_then(|h| h.get(0))
                .or_else(|| item.get("term"))
                .unwrap_or(item);
            let definitions = item
                .get("definitions")
                .or_else(|| item.get("term").and_then(|t| t.get("glossaries")))
                .or_else(|| item.get("glossary"))
                .or_else(|| item.get("senses"))
                .unwrap_or(&Value::Null);
            let grouped: Vec<&Value> = match definitions {
                Value::Array(arr) => arr.iter().collect(),
                Value::Null => Vec::new(),
                other => vec![other],
            };

            let term_str = head
                .get("term")
                .or_else(|| head.get("expression"))
                .or_else(|| head.get("spelling"))
                .or_else(|| item.get("expression"))
                .map(value_as_string)
                .unwrap_or_default();
            let reading_str = head
                .get("reading")
                .or_else(|| item.get("reading"))
                .map(value_as_string)
                .unwrap_or_default();

            for definition in grouped {
                let raw_strings = definition
                    .get("entries")
                    .or_else(|| definition.get("glossary"))
                    .unwrap_or(definition);
                let parsed_hachidori: Option<Value> =
                    if reader == "hachidori" && raw_strings.is_string() {
                        raw_strings
                            .as_str()
                            .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    } else {
                        None
                    };
                let effective = parsed_hachidori.as_ref().unwrap_or(raw_strings);
                let list: Vec<&Value> = match effective {
                    Value::Array(arr) => arr.iter().collect(),
                    Value::Null => Vec::new(),
                    other => vec![other],
                };
                let content: Vec<Value> = list
                    .into_iter()
                    .map(|val| dictionary_text(val, 0).trim().to_string())
                    .filter(|s| !s.is_empty())
                    .take(20)
                    .map(Value::String)
                    .collect();
                if content.is_empty() {
                    continue;
                }
                let dict_name = definition
                    .get("dictionary")
                    .or_else(|| item.get("dictionary"))
                    .or_else(|| item.get("dictionaryName"))
                    .map(value_as_string)
                    .unwrap_or_default();
                entries.push(json!({
                    "term": term_str,
                    "reading": reading_str,
                    "dictionary": dict_name,
                    "definitions": content,
                }));
                if entries.len() >= 30 {
                    break;
                }
            }
            if entries.len() >= 30 {
                break;
            }
        }
    }

    let matched_length = value
        .get("originalTextLength")
        .or_else(|| value.get("matchedLength"))
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
        .or_else(|| {
            value
                .get("results")
                .and_then(|r| r.get(0))
                .and_then(|r| r.get("matched"))
                .and_then(Value::as_str)
                .map(|s| s.encode_utf16().count() as u64)
        })
        .unwrap_or(0);

    json!({
        "reader": reader,
        "entries": entries,
        "matchedLength": matched_length,
    })
}

pub fn reader_route(action: &str) -> Result<(Method, &'static str, Duration), String> {
    match action {
        "state" => Ok((Method::GET, "/get_ids", Duration::from_secs(20))),
        "select" => Ok((Method::POST, "/update_checkboxes", Duration::from_secs(20))),
        "audio" => Ok((Method::POST, "/play-audio", Duration::from_secs(20))),
        "screenshot" => Ok((Method::POST, "/get-screenshot", Duration::from_secs(20))),
        "translate" => Ok((Method::POST, "/translate-line", Duration::from_secs(90))),
        "saveClip" => Ok((Method::POST, "/save-clip", Duration::from_secs(20))),
        "createMedia" => Ok((Method::POST, "/create-media", Duration::from_secs(20))),
        "pauseIntake" => Ok((
            Method::POST,
            "/set_text_intake_paused",
            Duration::from_secs(20),
        )),
        "stats" => Ok((
            Method::POST,
            "/set_stats_gathering_enabled",
            Duration::from_secs(20),
        )),
        _ => Err("Unknown reader action.".into()),
    }
}

pub async fn reader_connection(app: &AppHandle) -> Result<Value, String> {
    let paths = crate::desktop_services::paths_for(app);
    let config_path = paths.active.join("config.json");
    let base_raw = gsm_settings::gsm_config::gsm_backend_url(&config_path, "/");
    let base = url::Url::parse(&base_raw).map_err(|e| format!("Invalid backend URL: {e}"))?;
    let mut socket = base
        .join("/ws/texthooker")
        .map_err(|e| format!("Invalid websocket URL: {e}"))?;
    let _ = socket.set_scheme("ws");

    let ws_port_url =
        gsm_settings::gsm_config::gsm_backend_url(&config_path, "/get_websocket_port");
    let http = app
        .state::<crate::desktop_state::DesktopState>()
        .http
        .clone();
    if let Ok(resp) = http
        .get(&ws_port_url)
        .timeout(Duration::from_millis(2500))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(data) = resp.json::<Value>().await {
                if let Some(port) = data.get("direct_port").and_then(Value::as_u64) {
                    if (1..=65535).contains(&port) {
                        let _ = socket.set_port(Some(port as u16));
                    }
                }
            }
        }
    }

    let base_dir = strip_windows_verbatim_prefix(&paths.active);
    let digest = Sha256::digest(base_dir.to_string_lossy().as_bytes());
    let mut hex = String::with_capacity(16);
    for &b in &digest[..8] {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    Ok(json!({
        "baseUrl": base.origin().ascii_serialization(),
        "websocketUrl": socket.to_string(),
        "storageKey": format!("gsm-reader-history-{hex}"),
    }))
}

pub async fn reader_request(
    app: &AppHandle,
    action: &str,
    payload: Option<Value>,
) -> Result<Value, String> {
    let (method, route_path, timeout) = reader_route(action)?;
    let body = payload.unwrap_or_else(|| json!({}));
    if !body.is_object() {
        return Err("Invalid reader request.".into());
    }
    let serialized =
        serde_json::to_string(&body).map_err(|_| "Invalid reader request.".to_string())?;
    if serialized.len() > 300_000 {
        return Err("Invalid reader request.".into());
    }

    let paths = crate::desktop_services::paths_for(app);
    let url =
        gsm_settings::gsm_config::gsm_backend_url(&paths.active.join("config.json"), route_path);
    let http = app
        .state::<crate::desktop_state::DesktopState>()
        .http
        .clone();

    let mut req = http.request(method.clone(), &url).timeout(timeout);
    if method == Method::POST {
        req = req
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(serialized);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        if let Ok(err_json) = serde_json::from_str::<Value>(&text) {
            if let Some(msg) = err_json.get("error").and_then(|v| v.as_str()) {
                return Err(msg.to_string());
            }
        }
        return Err(format!("HTTP {status}"));
    }

    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(val) => Ok(val),
        Err(_) => Ok(Value::String(text)),
    }
}

pub fn reader_copy(app: &AppHandle, text: &str) -> Result<Value, String> {
    if text.encode_utf16().count() > 1_000_000 {
        return Err("Invalid clipboard text.".into());
    }
    app.clipboard()
        .write_text(text)
        .map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

pub async fn reader_history(app: &AppHandle, payload: Option<Value>) -> Result<Value, String> {
    let raw = payload.unwrap_or_else(|| json!({}));
    let query: gsm_history::reader_history::ReaderHistoryQuery =
        serde_json::from_value(raw).map_err(|_| "Invalid reader history request.".to_string())?;
    if query.scene.trim().is_empty() {
        return Ok(json!({ "lines": [], "hasMore": false, "nextCursor": Value::Null }));
    }
    let db_path = crate::desktop_services::paths_for(app)
        .active
        .join("gsm.db");
    if !db_path.exists() {
        return Ok(json!({ "lines": [], "hasMore": false, "nextCursor": Value::Null }));
    }
    let history = app.state::<Arc<gsm_history::History>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        history
            .run(&db_path, gsm_history::Request::ReaderHistory(query))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn adopt_or_load_extension(app: &AppHandle) -> Result<(String, LoadedExtension), String> {
    let manager = app.state::<DictionaryManager>();
    manager.load_selected_extension(app).await
}

fn extension_page_url(ext: &LoadedExtension, relative_page: &str) -> String {
    if use_windows_native_extensions() {
        format!(
            "chrome-extension://{}/{}",
            ext.id,
            relative_page.trim_start_matches('/')
        )
    } else {
        format!("{}/{}", ext.base, relative_page.trim_start_matches('/'))
    }
}

async fn prepare_reader(
    app: &AppHandle,
) -> Result<(String, LoadedExtension, WebviewWindow, LookupLease), String> {
    let state = app.state::<ReaderState>();
    let _guard = state.prepare_lock.lock().await;
    let lease = LookupLease::acquire(state.inner());

    let (reader, ext) = adopt_or_load_extension(app).await?;
    let manager = app.state::<DictionaryManager>();
    if reader == "hachidori" {
        manager.ensure_hachidori_engine(app, &ext).await?;
    }
    let overlay_data = overlay_data_path(app);
    let page_rel = if reader == "yomitan" {
        "templates-display.html"
    } else {
        "settings.html"
    };
    let target_url = format!("chrome-extension://{}/{page_rel}", ext.id);
    let prefix_ext = format!("chrome-extension://{}/", ext.id);
    let prefix_base = format!("{}/", ext.base);

    let needs_create_or_reload = match app.get_webview_window(LOOKUP_PAGE_LABEL) {
        Some(win) => {
            let cur = win.url().map(|u| u.to_string()).unwrap_or_default();
            if cur.starts_with(&prefix_ext) || cur.starts_with(&prefix_base) {
                return Ok((reader, ext, win, lease));
            }
            destroy_reader_window(app, &win).await?;
            true
        }
        None => true,
    };

    if needs_create_or_reload {
        let desktop = app.state::<crate::desktop_state::DesktopState>();
        let parsed = desktop.assets.url(&target_url)?;
        let token = uuid::Uuid::new_v4().to_string();
        desktop.register_window_with_token(LOOKUP_PAGE_LABEL, "dictionary", token.clone());
        let (loaded, mut ready) = tokio::sync::watch::channel(false);
        let expected_url = parsed.clone();

        let mut builder = crate::dictionary_host::apply_shared_webview_options(
            WebviewWindowBuilder::new(app, LOOKUP_PAGE_LABEL, WebviewUrl::External(parsed))
                .title("GSM Reader Lookup")
                .inner_size(1.0, 1.0)
                .visible(false)
                .skip_taskbar(true)
                .on_page_load(move |_, payload| {
                    if payload.url() == &expected_url && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        loaded.send_replace(true);
                    }
                }),
        );

        if !use_windows_native_extensions() {
            let preload_base = crate::overlay_preload::render_desktop_preload(&token);
            let dict_preload =
                manager.portable_preload_for_window(LOOKUP_PAGE_LABEL, &ext, &target_url, 999_003);
            builder = builder
                .initialization_script_for_all_frames(format!("{preload_base}\n;{dict_preload}"));
        }
        builder = apply_profile_data_directory(builder, &overlay_data)?;
        let win = builder.build().map_err(|e| e.to_string())?;
        // Evaluating against the initial about:blank document can lose the
        // result during navigation and stall for the IPC timeout. Use Tauri's
        // load event instead of a fixed startup sleep.
        let document_ready = tokio::time::timeout(Duration::from_secs(20), async {
            while !*ready.borrow_and_update() {
                ready.changed().await.map_err(|_| "Dictionary window closed")?;
            }
            Ok::<(), &str>(())
        }).await;
        if !matches!(document_ready, Ok(Ok(()))) {
            let _ = destroy_reader_window(app, &win).await;
            return Err("Dictionary page did not finish loading".into());
        }
        return Ok((reader, ext, win, lease));
    }

    unreachable!()
}

pub async fn attach_home_dictionary(app: &AppHandle, label: &str) -> Result<Value, String> {
    let window = app
        .get_webview_window(label)
        .ok_or("Reading window is closed.")?;
    let (_, ext) = adopt_or_load_extension(app).await?;
    let manager = app.state::<DictionaryManager>();
    // Enabled on a shared profile does not mean content scripts attached to this
    // document. The manager reloads once after loading the extension and records
    // the attachment so subsequent Home mounts don't reload again.
    manager.attach_reader_window(app, &window, &ext).await?;
    Ok(Value::Null)
}

#[allow(dead_code)]
pub async fn preserve_home_preferences(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<(), String> {
    let url_str = format!(
        "{}/renderer/__gsm_migration__.html",
        crate::assets::origin()
    );
    let parsed = url::Url::parse(&url_str).map_err(|e| e.to_string())?;
    window.navigate(parsed.clone()).map_err(|e| e.to_string())?;
    for _ in 0..40 {
        if let Ok(v) = evaluate_raw(
            app,
            window,
            "Boolean(localStorage.getItem('gsm-shared-reader-profile-v1'))",
        )
        .await
        {
            if v.as_bool() == Some(true) {
                return Ok(());
            }
            if v.as_bool() == Some(false) {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    if let Some(prev) = app.get_webview_window(LEGACY_PREFS_LABEL) {
        destroy_reader_window(app, &prev).await?;
    }
    let prev = WebviewWindowBuilder::new(app, LEGACY_PREFS_LABEL, WebviewUrl::External(parsed))
        .title("GSM Profile Transfer")
        .inner_size(1.0, 1.0)
        .visible(false)
        .skip_taskbar(true)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;

    let token = uuid::Uuid::new_v4().to_string();
    app.state::<crate::desktop_state::DesktopState>()
        .register_window_with_token(LEGACY_PREFS_LABEL, "desktop", token);

    let copy_res = async {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let saved = evaluate_raw(
            app,
            &prev,
            "Object.fromEntries(Object.entries(localStorage))",
        )
        .await
        .unwrap_or_else(|_| json!({}));
        let script = format!(
            "(() => {{ for (const [key, value] of Object.entries({})) {{ if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }} localStorage.setItem('gsm-shared-reader-profile-v1', '1'); }})()",
            saved
        );
        let _ = evaluate_raw(app, window, &script).await?;
        Ok::<(), String>(())
    }
    .await;

    let _ = prev.destroy();
    copy_res
}

pub async fn lookup_reader_dictionary(app: &AppHandle, text: &str) -> Result<Value, String> {
    if text.trim().is_empty() || text.encode_utf16().count() > 200 {
        return Err("Select up to 200 characters to look up.".into());
    }
    let (reader, _ext, host_page, _lease) = prepare_reader(app).await?;
    let arg_json = json!(text).to_string();
    let script = if reader == "yomitan" {
        format!(
            "(async () => {{\nconst {{API}} = await import('./js/comm/api.js');\nconst {{WebExtension}} = await import('./js/extension/web-extension.js');\nconst api = globalThis.__gsmReaderDictionaryApi ??= new API(new WebExtension());\nreturn api.termsFind({arg_json}, {{}}, {{current: true}});\n}})()"
        )
    } else {
        format!(
            "chrome.runtime.sendMessage({{target:'hoshidicts-offscreen',type:'hd_lookup',text:{arg_json}}})"
        )
    };

    for attempt in 0..=20u8 {
        let result = match evaluate_raw(app, &host_page, &script).await {
            Ok(val) => val,
            Err(err) if attempt == 0 => {
                // Allow extension page modules a brief moment to initialize on cold start.
                tokio::time::sleep(Duration::from_millis(200)).await;
                let _ = err;
                continue;
            }
            Err(err) => return Err(err),
        };
        if let Some(err_str) = result.get("error").and_then(Value::as_str) {
            if reader == "hachidori"
                && err_str.to_ascii_lowercase().contains("busy mutating")
                && attempt < 20
            {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            return Err(err_str.to_string());
        }
        return Ok(normalize_dictionary_result(&result, &reader));
    }

    Err("Dictionary lookup timed out.".into())
}

pub fn find_utf16_offset(haystack: &str, needle: &str) -> usize {
    match haystack.find(needle) {
        Some(byte_idx) => haystack[..byte_idx].encode_utf16().count(),
        None => 0,
    }
}

pub async fn open_reader_dictionary(
    app: &AppHandle,
    text: &str,
    context: &str,
) -> Result<Value, String> {
    if text.encode_utf16().count() > 200 || context.encode_utf16().count() > 100_000 {
        return Err("Invalid dictionary context.".into());
    }
    let state = app.state::<ReaderState>();
    let _search = state.search_lock.lock().await;
    let (reader, ext, _, _lease) = prepare_reader(app).await?;
    let utf16_offset = find_utf16_offset(context, text);

    let mut search_url =
        url::Url::parse(&extension_page_url(&ext, "search.html")).map_err(|e| e.to_string())?;
    search_url
        .query_pairs_mut()
        .append_pair("query", text)
        .append_pair("full", context)
        .append_pair("offset", &utf16_offset.to_string());

    let overlay_data = overlay_data_path(app);
    if let Some(existing) = app.get_webview_window(DICTIONARY_SEARCH_LABEL) {
        let current = existing
            .url()
            .map(|url| url.to_string())
            .unwrap_or_default();
        if !current.starts_with(&format!("chrome-extension://{}/", ext.id))
            && !current.starts_with(&format!("{}/", ext.base))
        {
            // Its navigation allowlist and portable preload belong to the old
            // reader, so a cross-reader search needs a newly initialized view.
            destroy_reader_window(app, &existing).await?;
        }
    }
    let win = if let Some(existing) = app.get_webview_window(DICTIONARY_SEARCH_LABEL) {
        existing.navigate(search_url).map_err(|e| e.to_string())?;
        existing
    } else {
        let token = uuid::Uuid::new_v4().to_string();
        app.state::<crate::desktop_state::DesktopState>()
            .register_window_with_token(DICTIONARY_SEARCH_LABEL, "dictionary", token.clone());

        let ext_origin_chrome = format!("chrome-extension://{}/", ext.id);
        let ext_origin_base = format!("{}/", ext.base);

        let mut builder = crate::dictionary_host::apply_shared_webview_options(
            WebviewWindowBuilder::new(
                app,
                DICTIONARY_SEARCH_LABEL,
                WebviewUrl::External(search_url),
            )
            .title("GSM · Dictionary")
            .inner_size(700.0, 720.0)
            .min_inner_size(420.0, 320.0)
            .visible(false),
        )
        .on_navigation(move |target| {
            let s = target.as_str();
            s.starts_with(&ext_origin_chrome) || s.starts_with(&ext_origin_base)
        })
        .on_new_window(|target, _| {
            if matches!(target.scheme(), "http" | "https") {
                let _ = crate::native::shell_open_external(target.as_str());
            }
            tauri::webview::NewWindowResponse::Deny
        });

        if !use_windows_native_extensions() {
            let preload_base = crate::overlay_preload::render_desktop_preload(&token);
            let dict_preload = app
                .state::<DictionaryManager>()
                .portable_preload_for_window(
                    DICTIONARY_SEARCH_LABEL,
                    &ext,
                    &format!("chrome-extension://{}/search.html", ext.id),
                    999_004,
                );
            builder = builder
                .initialization_script_for_all_frames(format!("{preload_base}\n;{dict_preload}"));
        }
        builder = apply_profile_data_directory(builder, &overlay_data)?;
        builder.build().map_err(|e| e.to_string())?
    };

    let _ = crate::desktop_state::focus_window(&win);

    if reader == "hachidori" {
        let context_json = json!(context).to_string();
        let handshake = format!(
            "new Promise((resolve, reject) => {{\n  const id = crypto.randomUUID(); let frame;\n  const listener = event => {{\n    if (event.source !== frame?.contentWindow || event.data?.type !== 'gsm.native-search.result' || event.data.id !== id) return;\n    clearInterval(interval); clearTimeout(timeout); window.removeEventListener('message', listener);\n    event.data.error ? reject(Error(event.data.error)) : resolve(null);\n  }};\n  window.addEventListener('message', listener);\n  const interval = setInterval(() => {{\n    frame = document.querySelector('iframe');\n    if (!frame?.contentWindow) return;\n    frame.contentWindow.postMessage({{type:'gsm.native-search', id, text:{context_json}, offset:{utf16_offset}}}, '*');\n  }}, 100);\n  const timeout = setTimeout(() => {{ clearInterval(interval); window.removeEventListener('message', listener); reject(Error('Dictionary search did not become ready.')); }}, 35000);\n}})"
        );
        let _ = evaluate_raw(app, &win, &handshake).await?;
    }

    Ok(Value::Null)
}

pub async fn try_dictionary_selection(
    app: &AppHandle,
    text: &str,
    context: &str,
) -> Option<Result<Value, String>> {
    Some(open_reader_dictionary(app, text, context).await)
}

pub async fn handle_ws2_anki_setup(app: &AppHandle, msg: &Value) -> Value {
    let req_id = msg
        .get("request_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64;
    let deadline = msg.get("deadline").and_then(Value::as_f64).unwrap_or(0.0);
    if !deadline.is_finite() || deadline <= now_ms {
        return json!({
            "type": "anki-setup-yomitan-result",
            "request_id": req_id,
            "success": false,
            "error": "Setup request expired. Retry from GSM settings."
        });
    }
    let input = msg.get("data").cloned().unwrap_or(Value::Null);
    let res = async {
        let (reader, _ext, win, _lease) = prepare_reader(app).await?;
        if reader != "yomitan" {
            return Err("Select Yomitan in dictionary settings, then retry.".to_string());
        }
        let script = format!(
            r#"(async () => {{
                const {{API}} = await import('./js/comm/api.js');
                const {{WebExtension}} = await import('./js/extension/web-extension.js');
                const api = new API(new WebExtension());
                const options = await api.optionsGetFull();
                const input = {input_json};
                const deadline = {deadline_num};
                function profileHasSetup(profile, input) {{
                    const anki = profile?.options?.anki;
                    if (!anki?.enable || anki.server !== input.server || anki.fieldTemplates !== null
                        || profile.options.general?.resultOutputMode !== 'group' || profile.conditionGroups?.length !== 0
                        || !Array.isArray(anki.tags) || !(input.tags || []).every((tag) => anki.tags.includes(tag))
                        || !Array.isArray(anki.cardFormats) || 'terms' in anki) return false;
                    const formats = anki.cardFormats.filter((format) => format.type === 'term');
                    return formats.length > 0 && formats.every((format) =>
                        format.model === input.model && format.deck === input.deck && format.fields
                        && Object.keys(format.fields).length === Object.keys(input.fields).length
                        && Object.entries(input.fields).every(([key, value]) =>
                            format.fields[key]?.value === value && format.fields[key]?.overwriteMode === 'coalesce'));
                }}
                function configureProfile(options, input) {{
                    const names = {{ lapis: 'Lapis', kiku: 'Kiku', senren: 'Senren' }};
                    const name = names[input?.preset];
                    if (!name || typeof input.model !== 'string' || input.model.toLowerCase() !== name.toLowerCase()
                        || typeof input.deck !== 'string' || !input.deck.trim()
                        || typeof input.server !== 'string' || !/^https?:\/\//.test(input.server)
                        || !input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)
                        || (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== 'string')))
                        || Object.keys(input.fields).length === 0 || Object.keys(input.fields).length > 128
                        || Object.entries(input.fields).some(([key, value]) => !key || typeof value !== 'string' || value.length > 20000)) {{
                        throw new Error('Invalid recommended Anki setup. Run setup again from GSM settings.');
                    }}
                    const next = structuredClone(options);
                    const active = next.profiles?.[next.profileCurrent];
                    if (!active?.options?.anki || !active.options.general) {{
                        throw new Error('Yomitan settings are not ready. Open its settings once and retry.');
                    }}
                    if (!Array.isArray(active.options.anki.cardFormats)) {{
                        throw new Error('Unsupported Yomitan settings format. Update the GSM overlay and retry.');
                    }}
                    const baseName = `GSM - ${{name}}`;
                    const existing = next.profiles.findIndex((profile) =>
                        (profile.name === baseName || profile.name.startsWith(`${{baseName}} (`))
                        && profileHasSetup(profile, input));
                    if (existing >= 0) {{
                        next.profileCurrent = existing;
                        return {{ options: next, profileName: next.profiles[existing].name }};
                    }}
                    const profile = structuredClone(active);
                    profile.name = baseName;
                    for (let suffix = 2; next.profiles.some((item) => item.name === profile.name); suffix++) {{
                        profile.name = `${{baseName}} (${{suffix}})`;
                    }}
                    profile.conditionGroups = [];
                    profile.options.anki.enable = true;
                    profile.options.anki.server = input.server;
                    profile.options.anki.fieldTemplates = null;
                    profile.options.anki.tags = [...new Set([...(profile.options.anki.tags || []), ...(input.tags || [])])];
                    const formats = profile.options.anki.cardFormats;
                    if (!formats.some((format) => format.type === 'term')) {{
                        formats.push({{ name: 'Expression', icon: 'big-circle', type: 'term' }});
                    }}
                    for (const format of formats) {{
                        if (format.type !== 'term') continue;
                        format.model = input.model;
                        format.deck = input.deck;
                        format.fields = Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [
                            key, {{ value, overwriteMode: 'coalesce' }},
                        ]));
                    }}
                    delete profile.options.anki.terms;
                    profile.options.general.resultOutputMode = 'group';
                    next.profileCurrent = next.profiles.length;
                    next.profiles.push(profile);
                    return {{ options: next, profileName: profile.name }};
                }}
                const result = configureProfile(options, input);
                if (Date.now() >= deadline) throw new Error('Setup request expired. Retry from GSM settings.');
                await api.setAllSettings(result.options, 'gsm-anki-setup');
                const saved = await api.optionsGetFull();
                const current = saved.profiles[saved.profileCurrent];
                if (current?.name !== result.profileName || !profileHasSetup(current, input)) {{
                    throw new Error('Yomitan did not keep the selected deck, note type and fields. Retry setup.');
                }}
                return {{ profileName: result.profileName }};
            }})()"#,
            input_json = input.to_string(),
            deadline_num = deadline,
        );
        evaluate_raw(app, &win, &script).await
    }
    .await;

    match res {
        Ok(val) => {
            let mut out = json!({
                "type": "anki-setup-yomitan-result",
                "request_id": req_id,
                "success": true,
            });
            if let (Some(dst), Some(src)) = (out.as_object_mut(), val.as_object()) {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            }
            out
        }
        Err(err) => json!({
            "type": "anki-setup-yomitan-result",
            "request_id": req_id,
            "success": false,
            "error": err,
        }),
    }
}

pub async fn handle_ws2_dictionary_setup(app: &AppHandle, msg: &Value) -> Value {
    let req_id = msg
        .get("request_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64;
    let deadline = msg.get("deadline").and_then(Value::as_f64).unwrap_or(0.0);
    if !deadline.is_finite() || deadline <= now_ms {
        return json!({
            "type": "dictionary-setup-result",
            "request_id": req_id,
            "success": false,
            "error": "Setup request expired. Retry."
        });
    }
    let data = msg.get("data").cloned().unwrap_or(Value::Null);
    let action = data.get("action").and_then(Value::as_str).unwrap_or("");
    let language = data.get("language").and_then(Value::as_str).unwrap_or("");
    if !matches!(action, "status" | "install" | "open" | "select") || language.is_empty() {
        return json!({
            "type": "dictionary-setup-result",
            "request_id": req_id,
            "success": false,
            "error": "Invalid dictionary setup request."
        });
    }

    let res = async {
        let overlay_data = overlay_data_path(app);
        let current_reader = crate::dictionary_host::reader_selection(&overlay_data).to_string();
        if action == "select" {
            let next_reader = data
                .get("reader")
                .and_then(Value::as_str)
                .ok_or("Invalid dictionary reader.")?;
            if !matches!(next_reader, "yomitan" | "hachidori") {
                return Err("Invalid dictionary reader.".to_string());
            }
            if let Some(host) = app.try_state::<crate::overlay_host::OverlayHost>() {
                let mut patch = serde_json::Map::new();
                patch.insert("dictionaryReaderSelection".into(), json!(next_reader));
                host.apply_setting_updates(app, patch, false);
            }
            return Ok(json!({
                "reader": next_reader,
                "restarting": next_reader != current_reader,
                "installed": [],
                "busy": false,
                "recommended": Value::Null,
            }));
        }

        if action == "open" {
            app
                .state::<DictionaryManager>()
                .open_selected_extension_options(app)
                .await?;
        }

        let resources_root = crate::dictionary_host::overlay_resources_root(app);
        let catalogue_path = resources_root.join("yomitan/data/recommended-dictionaries.json");
        let recommendation = std::fs::read_to_string(&catalogue_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|cat| {
                let terms = cat.get(language)?.get("terms")?.as_array()?;
                if language == "ja" {
                    terms
                        .iter()
                        .find(|item| {
                            item.get("name")
                                .and_then(Value::as_str)
                                .is_some_and(|n| n.to_ascii_lowercase().contains("jitendex"))
                        })
                        .or_else(|| terms.first())
                        .cloned()
                } else {
                    terms.first().cloned()
                }
            })
            .unwrap_or(Value::Null);

        let (reader, _ext, win, _lease) = prepare_reader(app).await?;
        if reader == "hachidori" {
            let enable_existing = action == "install";
            if action == "install" && language != "ja" {
                return Err("Open Hachidori settings to choose a language pack and dictionary.".into());
            }
            let status_script = format!(
                r#"(async () => {{
                    await import('./reader-options.js');
                    const api = globalThis.HDReaderOptions;
                    const language = {lang_json};
                    const enableExisting = {enable_bool};
                    let [run, state, stored] = await Promise.all([
                        chrome.runtime.sendMessage({{ target: 'hachidori-setup', type: 'hd_setup_install', sourceIds: [] }}),
                        chrome.runtime.sendMessage({{ target: 'hoshidicts-worker', type: 'hd_state_read' }}),
                        chrome.storage.local.get(['options', api.LANGUAGE_SELECTION_KEY]),
                    ]);
                    if (!run?.ok || !state?.ok) throw new Error(run?.error || state?.error || 'Hachidori is not ready. Retry in a moment.');
                    const profileId = api.activeProfileId(stored.options, stored[api.LANGUAGE_SELECTION_KEY]);
                    const profile = api.profiles(stored.options).find(item => item.id === profileId);
                    let dictionaries = api.projectDictionaryState(state.state, profileId)?.dictionaries || [];
                    if (enableExisting) {{
                        if (profile?.language !== language) throw new Error('Select your learning language in Hachidori settings before installing its dictionary.');
                        const existing = dictionaries.find(item => item.termCount > 0 && /^Jitendex(?:\.org)?(?:\s|$)/i.test(item.title));
                        if (existing?.enabled === false && run.finished !== false) {{
                            const reply = await chrome.runtime.sendMessage({{
                                target: 'hoshidicts-offscreen', type: 'hd_apply_state', requestId: crypto.randomUUID(),
                                baseRevision: state.state.revision, profileId,
                                dictionaries: dictionaries.map(item => item.id === existing.id ? {{ ...item, enabled: true }} : item),
                            }});
                            if (!reply?.ok) throw new Error(reply?.error || 'The dictionary could not be enabled. Retry from dictionary settings.');
                            dictionaries = api.projectDictionaryState(reply.state, profileId)?.dictionaries || [];
                        }}
                    }}
                    const installed = profile?.language === language ? dictionaries.filter(item => item.enabled !== false && item.termCount > 0).map(item => item.title) : [];
                    const recommendedInstalled = language === 'ja' && installed.some(title => /^Jitendex(?:\.org)?(?:\s|$)/i.test(title));
                    if (enableExisting && run.finished !== false && !recommendedInstalled) {{
                        const reply = await chrome.runtime.sendMessage({{ target: 'hachidori-setup', type: 'hd_setup_install', sourceIds: ['jitendex'] }});
                        if (!reply?.ok) throw new Error(reply?.error || 'Hachidori could not start the dictionary download.');
                        run = reply;
                    }}
                    return {{
                        reader: 'hachidori',
                        recommended: language === 'ja' ? {{ name: 'Jitendex', homepage: 'https://jitendex.org' }} : null,
                        installed, recommendedInstalled,
                        busy: run.finished === false,
                        error: recommendedInstalled ? undefined : (run.entries || []).find(item => item.error)?.error,
                    }};
                }})()"#,
                lang_json = json!(language),
                enable_bool = enable_existing,
            );
            evaluate_raw(app, &win, &status_script).await
        } else {
            let yomitan_act = if action == "install" { "install" } else { "status" };
            let script = format!(
                r#"(async () => {{
                    const action = {act_json};
                    const language = {lang_json};
                    const recommendation = {rec_json};
                    function matches(dictionary, recommendation, language) {{
                        if (!recommendation) return false;
                        return dictionary.downloadUrl === recommendation.downloadUrl
                            || dictionary.title === recommendation.name
                            || dictionary.title.startsWith(`${{recommendation.name}} [`)
                            || (language === 'ja' && /^Jitendex(?:\.org)?(?:\s|$)/i.test(dictionary.title));
                    }}
                    const {{ API }} = await import('./js/comm/api.js');
                    const {{ WebExtension }} = await import('./js/extension/web-extension.js');
                    const api = new API(new WebExtension());
                    let options = await api.optionsGetFull();
                    let dictionaries = await api.getDictionaryInfo();
                    const stored = await chrome.storage.local.get('gsmOnboardingDictionaries');
                    const known = stored.gsmOnboardingDictionaries || {{}};
                    function enabledTerms(options, dictionaries) {{
                        const current = options.profiles[options.profileCurrent].options;
                        if (!current.general.enable || current.general.language !== language) return [];
                        const enabled = new Set(current.dictionaries.filter(item => item.enabled).map(item => item.name));
                        return dictionaries.filter(item => enabled.has(item.title) && item.importSuccess !== false
                            && item.counts?.terms?.total > 0 && (!item.sourceLanguage || item.sourceLanguage === language
                                || (recommendation && (known[recommendation.downloadUrl] === item.title || matches(item, recommendation, language)))));
                    }}
                    if (action === 'install' && !window.__gsmDictionaryBusy) {{
                        window.__gsmDictionaryBusy = true;
                        window.__gsmDictionaryStage = 'downloading';
                        window.__gsmDictionaryError = undefined;
                        (async () => {{
                            try {{
                                if (!recommendation) throw new Error('No starter dictionary is available for this language. Import one from dictionary settings.');
                                let summary = dictionaries.find(item => (matches(item, recommendation, language)
                                    || item.title === known[recommendation.downloadUrl]) && item.importSuccess !== false);
                                if (!summary) {{
                                    const response = await fetch(recommendation.downloadUrl, {{ signal: AbortSignal.timeout(120000) }});
                                    if (!response.ok) throw new Error(`Dictionary download failed (${{response.status}}). Retry or import it from settings.`);
                                    const limit = 256 * 1024 * 1024;
                                    if (Number(response.headers.get('content-length')) > limit) throw new Error('Dictionary download exceeds 256 MiB. Import it from settings.');
                                    const reader = response.body.getReader();
                                    const chunks = [];
                                    let size = 0;
                                    while (true) {{
                                        const {{ value, done }} = await reader.read();
                                        if (done) break;
                                        size += value.byteLength;
                                        if (size > limit) {{ await reader.cancel(); throw new Error('Dictionary download exceeds 256 MiB. Import it from settings.'); }}
                                        chunks.push(value);
                                    }}
                                    window.__gsmDictionaryStage = 'importing';
                                    const {{ DictionaryWorker }} = await import('./js/dictionary/dictionary-worker.js');
                                    const archive = await new Blob(chunks).arrayBuffer();
                                    const result = await new DictionaryWorker().importDictionary(archive, {{
                                        prefixWildcardsSupported: options.global.database.prefixWildcardsSupported,
                                        yomitanVersion: chrome.runtime.getManifest().version,
                                    }}, () => {{}});
                                    if (!result.result || result.errors?.length) {{
                                        throw new Error(result.errors?.[0]?.message || 'Dictionary import did not finish. Check dictionary settings before retrying.');
                                    }}
                                    summary = result.result;
                                }}
                                await api.triggerDatabaseUpdated('dictionary', 'import');
                                const latestOpts = await api.optionsGetFull();
                                const index = latestOpts.profileCurrent;
                                const profile = latestOpts.profiles[index];
                                const {{ DictionaryController }} = await import('./js/pages/settings/dictionary-controller.js');
                                const dictionaryIndex = profile.options.dictionaries.findIndex(item => item.name === summary.title);
                                const targets = [
                                    {{ action: 'set', path: `profiles[${{index}}].options.general.language`, value: language }},
                                    {{ action: 'set', path: `profiles[${{index}}].options.general.enable`, value: true }},
                                    dictionaryIndex < 0
                                        ? {{ action: 'push', path: `profiles[${{index}}].options.dictionaries`, items: [DictionaryController.createDefaultDictionarySettings(summary.title, true, summary.styles)] }}
                                        : {{ action: 'set', path: `profiles[${{index}}].options.dictionaries[${{dictionaryIndex}}].enabled`, value: true }},
                                ];
                                if (summary.sequenced && !profile.options.general.mainDictionary) {{
                                    targets.push({{ action: 'set', path: `profiles[${{index}}].options.general.mainDictionary`, value: summary.title }});
                                }}
                                const changes = await api.modifySettings(targets.map(target => ({{ ...target, scope: 'global' }})), 'gsm-onboarding');
                                if (changes.some(change => change.error)) throw new Error('The dictionary was imported but could not be enabled. Retry from dictionary settings.');
                                known[recommendation.downloadUrl] = summary.title;
                                const [saved, inventory] = await Promise.all([api.optionsGetFull(), api.getDictionaryInfo()]);
                                if (!enabledTerms(saved, inventory).some(item => item.title === summary.title)) {{
                                    throw new Error('The dictionary was imported but could not be verified in the active profile. Retry or open dictionary settings.');
                                }}
                                await chrome.storage.local.set({{ gsmOnboardingDictionaries: known }});
                                window.__gsmDictionaryStage = 'complete';
                            }} catch (err) {{
                                window.__gsmDictionaryStage = 'failed';
                                window.__gsmDictionaryError = err?.message || String(err);
                            }} finally {{
                                window.__gsmDictionaryBusy = false;
                            }}
                        }})();
                    }}
                    const enabled = enabledTerms(options, dictionaries);
                    return {{
                        reader: 'yomitan',
                        recommended: recommendation ? {{ name: recommendation.name, homepage: recommendation.homepage }} : null,
                        installed: enabled.map(item => item.title),
                        recommendedInstalled: Boolean(recommendation && enabled.some(item =>
                            matches(item, recommendation, language) || known[recommendation.downloadUrl] === item.title)),
                        busy: window.__gsmDictionaryBusy === true,
                        stage: window.__gsmDictionaryStage,
                        error: window.__gsmDictionaryError,
                    }};
                }})()"#,
                act_json = json!(yomitan_act),
                lang_json = json!(language),
                rec_json = recommendation.to_string(),
            );
            evaluate_raw(app, &win, &script).await
        }
    }
    .await;

    match res {
        Ok(status) => json!({
            "type": "dictionary-setup-result",
            "request_id": req_id,
            "success": true,
            "status": status,
        }),
        Err(err) => json!({
            "type": "dictionary-setup-result",
            "request_id": req_id,
            "success": false,
            "error": err,
        }),
    }
}

pub async fn try_invoke(
    app: &AppHandle,
    label: &str,
    channel: &str,
    args: &[Value],
) -> Option<Result<Value, String>> {
    match channel {
        "reader.attachDictionary" => Some(attach_home_dictionary(app, label).await),
        "reader.dictionaryTransfers" => {
            let list = app.state::<DictionaryManager>().list_transfers();
            Some(Ok(Value::Array(list)))
        }
        "reader.connection" => Some(reader_connection(app).await),
        "reader.history" => Some(reader_history(app, args.first().cloned()).await),
        "reader.request" => {
            let Some(action) = args.first().and_then(Value::as_str) else {
                return Some(Err("Unknown reader action.".into()));
            };
            let payload = args.get(1).cloned();
            Some(reader_request(app, action, payload).await)
        }
        "reader.copy" => {
            let Some(text) = args.first().and_then(Value::as_str) else {
                return Some(Err("Invalid clipboard text.".into()));
            };
            Some(reader_copy(app, text))
        }
        "reader.lookup" => {
            let Some(text) = args.first().and_then(Value::as_str) else {
                return Some(Err("Select up to 200 characters to look up.".into()));
            };
            Some(lookup_reader_dictionary(app, text).await)
        }
        "reader.openDictionary" => {
            let Some(obj) = args.first().and_then(Value::as_object) else {
                return Some(Err("Invalid dictionary context.".into()));
            };
            let (Some(text), Some(context)) = (
                obj.get("text").and_then(Value::as_str),
                obj.get("context").and_then(Value::as_str),
            ) else {
                return Some(Err("Invalid dictionary context.".into()));
            };
            Some(open_reader_dictionary(app, text, context).await)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn dictionary_text_and_normalization_work() {
        let structured = json!([
            {"tag": "div", "content": [{"tag": "span", "content": "to eat"}, {"tag": "br"}, "consume"]},
            {"tag": "li", "content": "gobble"}
        ]);
        assert_eq!(dictionary_text(&structured, 0), "to eat\nconsume\ngobble\n");

        let yomitan = json!({
            "originalTextLength": 3,
            "dictionaryEntries": [{
                "headwords": [{"term": "食べる", "reading": "たべる"}],
                "definitions": [{
                    "dictionary": "JMdict",
                    "entries": [{"tag": "li", "content": "to eat"}]
                }]
            }]
        });
        let norm_y = normalize_dictionary_result(&yomitan, "yomitan");
        assert_eq!(norm_y["reader"], "yomitan");
        assert_eq!(norm_y["matchedLength"], 3);
        assert_eq!(norm_y["entries"][0]["term"], "食べる");
        assert_eq!(norm_y["entries"][0]["reading"], "たべる");
        assert_eq!(norm_y["entries"][0]["dictionary"], "JMdict");
        assert_eq!(norm_y["entries"][0]["definitions"][0], "to eat");

        let hachidori = json!({
            "results": [{
                "matched": "食べる",
                "expression": "食べる",
                "reading": "たべる",
                "dictionaryName": "JMdict-HD",
                "glossary": "[\"to eat\",\"consume\"]"
            }]
        });
        let norm_h = normalize_dictionary_result(&hachidori, "hachidori");
        assert_eq!(norm_h["reader"], "hachidori");
        assert_eq!(norm_h["matchedLength"], 3);
        assert_eq!(norm_h["entries"][0]["term"], "食べる");
        assert_eq!(norm_h["entries"][0]["definitions"][1], "consume");
    }

    #[test]
    fn route_validation_and_utf16_offset_work() {
        assert_eq!(
            reader_route("translate").unwrap().2,
            Duration::from_secs(90)
        );
        assert_eq!(reader_route("state").unwrap().1, "/get_ids");
        assert!(reader_route("bad").is_err());

        // Emoji "😀" is 2 UTF-16 code units, matching JS String.prototype.indexOf
        assert_eq!(find_utf16_offset("😀食べる", "食べる"), 2);
        assert_eq!(find_utf16_offset("食べる", "XYZ"), 0);
    }

    #[test]
    fn bench_normalize_1k_dictionary_entries() {
        let big = json!({
            "originalTextLength": 2,
            "dictionaryEntries": (0..1000).map(|i| json!({
                "headwords": [{"term": format!("語{i}"), "reading": "ご"}],
                "definitions": [{
                    "dictionary": "JMdict",
                    "entries": [{"tag": "div", "content": ["meaning one", {"tag": "br"}, "meaning two"]}]
                }]
            })).collect::<Vec<_>>()
        });
        let start = Instant::now();
        for _ in 0..100 {
            let res = normalize_dictionary_result(&big, "yomitan");
            assert_eq!(res["entries"].as_array().unwrap().len(), 30);
        }
        let elapsed = start.elapsed();
        eprintln!(
            "[bench] reader_normalize_1k_entries_100x total_ms={:.3} us_per_call={:.2}",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1_000_000.0 / 100.0
        );
    }
}
