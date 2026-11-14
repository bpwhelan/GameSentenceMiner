//! Native Rust smoke verification runner for `GSM_SMOKE_TEST=1`.
//! Executes end-to-end desktop, runtime, dictionary, legacy transfer, and overlay
//! checks directly inside the Tauri process without spawning `node.exe`.

use crate::desktop_state::DesktopState;
use crate::dictionary_host::{
    apply_profile_data_directory, apply_shared_webview_options, evaluate_raw, overlay_data_path,
    use_windows_native_extensions, DictionaryManager,
};
use crate::overlay_host::{OVERLAY_MAIN_LABEL, OVERLAY_SETTINGS_LABEL};
use crate::reader_service::{DICTIONARY_SEARCH_LABEL, LOOKUP_PAGE_LABEL};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub fn spawn_if_requested(app: AppHandle) {
    let Some(result_path) = std::env::var_os("GSM_TEST_RESULT").map(PathBuf::from) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let outcome = run_smoke(&app).await;
        let (code, payload) = match outcome {
            Ok(detail) => (0, json!({ "code": 0, "detail": detail })),
            Err(err) => {
                eprintln!("[smoke] FAILED: {err}");
                (1, json!({ "code": 1, "error": err }))
            }
        };
        if let Some(parent) = result_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&result_path, payload.to_string());
        app.exit(code);
    });
}

async fn wait_window_ready(
    app: &AppHandle,
    label: &str,
    timeout: Duration,
) -> Result<WebviewWindow, String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(win) = app.get_webview_window(label) {
            if let Ok(Ok(val)) = tokio::time::timeout(
                Duration::from_millis(800),
                evaluate_raw(app, &win, "document.readyState === 'complete'"),
            )
            .await
            {
                if val.as_bool() == Some(true) {
                    return Ok(win);
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(75)).await;
    }
    Err(format!(
        "Timed out waiting for window {label} to become ready"
    ))
}

async fn wait_hub_visibility(app: &AppHandle, visible: bool) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let handle = app.clone();
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.run_on_main_thread(move || {
                let result = handle
                    .get_webview_window(crate::app_lifecycle::HUB_WINDOW_LABEL)
                    .ok_or_else(|| "Closing the hub destroyed it".to_owned())
                    .and_then(|hub| hub.is_visible().map_err(|e| e.to_string()));
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
            if rx.await.map_err(|e| e.to_string())?? == visible {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| format!("Hub stopped responding while waiting for visible={visible}"))?
}

async fn smoke_close_to_tray(app: &AppHandle, hub: &WebviewWindow) -> Result<(), String> {
    service_call(
        app,
        "settings.saveSettings",
        &[json!({"quitOnWindowClose":false})],
    )
    .await?;
    crate::tray::ensure_created(app)?;
    evaluate_raw(app, hub, "window.__gsmCloseToTrayCount = 0").await?;

    crate::tray::show_main_window(app);
    wait_hub_visibility(app, true).await?;
    // First close exercises the still-running notification; the second skips it.
    for cycle in 1..=2 {
        eprintln!("[smoke] Closing hub to tray (cycle {cycle})");
        hub.close().map_err(|e| e.to_string())?;
        wait_hub_visibility(app, false).await?;
        if app
            .state::<DesktopState>()
            .quitting
            .load(std::sync::atomic::Ordering::SeqCst)
            || app.tray_by_id(crate::tray::CANONICAL_TRAY_ID).is_none()
        {
            return Err("Closing the hub stopped GSM or removed its tray icon".into());
        }
        crate::tray::show_main_window(app);
        wait_hub_visibility(app, true).await?;
        if evaluate_raw(app, hub, "++window.__gsmCloseToTrayCount").await? != json!(cycle) {
            return Err("Reopening the hub lost its renderer state".into());
        }
    }
    #[cfg(windows)]
    crate::windows_notifications::close_all(app);
    Ok(())
}

async fn run_smoke(app: &AppHandle) -> Result<Value, String> {
    if std::env::var_os("GSM_PROFILE_DIR").is_none() {
        return Err("Native smoke tests require an isolated GSM_PROFILE_DIR".into());
    }
    #[cfg(windows)]
    if std::env::var_os("GSM_FIXTURE_RESULT").is_some() {
        return run_capture_fixture(app).await;
    }
    // Never attach test overlays to an already-running user's backend.
    let endpoint = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = endpoint.local_addr().map_err(|e| e.to_string())?.port();
    let config =
        json!({"current_profile":"Smoke", "configs":{"Smoke":{"general":{"single_port":port}}}});
    std::fs::write(
        app.state::<crate::settings::Settings>()
            .paths
            .active
            .join("config.json"),
        config.to_string(),
    )
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        while let Ok((socket, _)) = endpoint.accept().await {
            tauri::async_runtime::spawn(async move {
                use futures_util::{SinkExt, StreamExt};
                use tokio_tungstenite::tungstenite::Message;
                let Ok(mut socket) = tokio_tungstenite::accept_async(socket).await else {
                    return;
                };
                let mut settings = serde_json::Map::new();
                while let Some(Ok(frame)) = socket.next().await {
                    if let Message::Text(text) = frame {
                        let Ok(message) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        let reply = match message["type"].as_str() {
                            Some("set-gsm-overlay-config") => {
                                if let Some(patch) = message["settings"].as_object() {
                                    settings.extend(patch.clone());
                                }
                                json!({"type":"gsm-overlay-config-updated","settings":settings})
                            }
                            Some("get-gsm-overlay-config") => {
                                json!({"type":"gsm-overlay-config-updated","settings":settings})
                            }
                            Some("quick-action-request") => {
                                json!({"type":"quick-action-result","request_id":message["request_id"],"success":true,"action":message["action"]})
                            }
                            _ => continue,
                        };
                        if socket
                            .send(Message::Text(reply.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            });
        }
    });
    if let Ok(fixture_dir) = std::env::var("GSM_LEGACY_FIXTURE") {
        if !fixture_dir.trim().is_empty() {
            return run_legacy_transfer_smoke(app, Path::new(&fixture_dir)).await;
        }
    }
    if let Ok(reader) = std::env::var("GSM_SMOKE_DICTIONARY") {
        if !reader.trim().is_empty() {
            return run_dictionary_smoke(app, reader.trim()).await;
        }
    }
    let suite = std::env::var("GSM_SMOKE_SUITE")
        .or_else(|_| std::env::var("GSM_SMOKE_SCENARIO"))
        .unwrap_or_else(|_| "foundation".into());
    run_suite_smoke(app, &suite).await
}

#[cfg(windows)]
async fn run_capture_fixture(app: &AppHandle) -> Result<Value, String> {
    let desktop = app.state::<DesktopState>();
    let directory = crate::desktop_services::paths_for(app)
        .active
        .join("capture-fixture");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    std::fs::write(directory.join("index.html"),"<!doctype html><meta charset='utf-8'><body style='margin:0;background:white;color:black;font:48px Meiryo,sans-serif'><div style='position:absolute;left:70px;top:100px'>日本語の文章を読みます。<br>今日はとても良い天気です。</div>").map_err(|e|e.to_string())?;
    desktop.assets.mount("capture-fixture", &directory)?;
    let token = desktop.register_window("capture-fixture", "smoke");
    let window = WebviewWindowBuilder::new(
        app,
        "capture-fixture",
        WebviewUrl::External(desktop.assets.url(&format!(
            "{}/capture-fixture/index.html",
            crate::assets::origin()
        ))?),
    )
    .title("GSM capture verification")
    .decorations(false)
    .inner_size(1000., 500.)
    .visible(true)
    .initialization_script(crate::overlay_preload::render_desktop_preload(&token))
    .build()
    .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(1000u32, 500u32))
        .map_err(|e| e.to_string())?;
    wait_window_ready(app, "capture-fixture", Duration::from_secs(15)).await?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize as u64;
    std::fs::write(
        std::env::var("GSM_FIXTURE_RESULT").unwrap(),
        json!({"hwnd":hwnd}).to_string(),
    )
    .map_err(|e| e.to_string())?;
    let control = std::env::var("GSM_FIXTURE_CONTROL").map_err(|e| e.to_string())?;
    let stop = std::env::var("GSM_FIXTURE_STOP").map_err(|e| e.to_string())?;
    let mut previous = String::new();
    let deadline = Instant::now() + Duration::from_secs(600);
    while !Path::new(&stop).exists() && Instant::now() < deadline {
        if let Ok(raw) = std::fs::read_to_string(&control) {
            if raw != previous {
                if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                    if let (Some(w), Some(h)) = (value["width"].as_u64(), value["height"].as_u64())
                    {
                        window
                            .set_size(tauri::PhysicalSize::new(
                                w.clamp(100, 4000) as u32,
                                h.clamp(100, 4000) as u32,
                            ))
                            .map_err(|e| e.to_string())?;
                    }
                    if value["color"].is_string() {
                        evaluate_raw(
                            app,
                            &window,
                            &format!("document.body.style.background={}", value["color"]),
                        )
                        .await?;
                    }
                    previous = raw;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    window.destroy().map_err(|e| e.to_string())?;
    Ok(json!({"fixture":"capture"}))
}

async fn run_dictionary_smoke(app: &AppHandle, reader: &str) -> Result<Value, String> {
    let phase = std::env::var("GSM_SMOKE_PHASE").unwrap_or_else(|_| "import".into());
    let overlay_data = overlay_data_path(app);
    std::fs::create_dir_all(&overlay_data).map_err(|e| e.to_string())?;
    std::fs::write(
        overlay_data.join("settings.json"),
        json!({ "dictionaryReaderSelection": reader, "openSettingsOnStartup": false,
            "mainBoxStartupWarningAcknowledged": true, "pushToShowEnforcedDialogDismissed": true,
            "showFurigana": false, "showTextIndicators": true, "liveStatsEnabled": true,
            "gamepadEnabled": false, "gamepadControllerEnabled": false,
            "gamepadKeyboardEnabled": false })
        .to_string(),
    )
    .map_err(|e| e.to_string())?;

    // Warm up the dictionary host and create the hidden lookup page.
    let _ = crate::reader_service::try_invoke(app, "gsm-hub", "reader.lookup", &[json!("日本")])
        .await
        .ok_or("reader.lookup not handled")?
        .map_err(|e| format!("warmup lookup: {e}"))?;

    let host_win = wait_window_ready(app, LOOKUP_PAGE_LABEL, Duration::from_secs(30))
        .await
        .map_err(|e| format!("wait lookup page: {e}"))?;

    if reader == "hachidori" {
        evaluate_raw(
            app,
            &host_win,
            r#"(async()=>{
                for (let i = 0; i < 200; i++) {
                    const st = await chrome.runtime.sendMessage({
                        target: 'hoshidicts-offscreen',
                        type: 'hd_status',
                        requestId: `smoke-ready-${i}`
                    });
                    if (st?.ok && st.ready && !st.loading) return st;
                    await new Promise(r => setTimeout(r, 100));
                }
                throw new Error('Hachidori engine did not become ready');
            })()"#,
        )
        .await
        .map_err(|e| format!("wait hachidori ready: {e}"))?;
    }

    if phase == "import" {
        let profile_dir = std::env::var("GSM_PROFILE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                app.state::<crate::settings::Settings>()
                    .paths
                    .active
                    .clone()
            });
        let zip_bytes = std::fs::read(profile_dir.join("dictionary.zip"))
            .map_err(|e| format!("Failed reading dictionary.zip fixture: {e}"))?;
        let archive_b64 = STANDARD.encode(&zip_bytes);

        if reader == "yomitan" {
            // Close any onboarding/welcome popups so the import owns settings changes cleanly.
            for (lbl, w) in app.webview_windows() {
                if lbl != LOOKUP_PAGE_LABEL {
                    if let Ok(u) = w.url() {
                        let s = u.as_str();
                        if s.ends_with("/settings.html") || s.ends_with("/welcome.html") {
                            let _ = w.destroy();
                        }
                    }
                }
            }
            let script = format!(
                r#"(async()=>{{
                    const {{DictionaryWorker}}=await import('./js/dictionary/dictionary-worker.js');
                    const {{API}}=await import('./js/comm/api.js');
                    const {{WebExtension}}=await import('./js/extension/web-extension.js');
                    const bytes=Uint8Array.from(atob({archive}),c=>c.charCodeAt(0));
                    const imported=await new DictionaryWorker().importDictionary(
                        bytes.buffer,
                        {{prefixWildcardsSupported:false,yomitanVersion:chrome.runtime.getManifest().version}},
                        ()=>{{}}
                    );
                    const api=new API(new WebExtension());
                    const options=await api.optionsGetFull();
                    options.profiles[options.profileCurrent].options.dictionaries.push({{
                        name:'hachidori-fixture',
                        alias:'',
                        enabled:true,
                        allowSecondarySearches:false,
                        definitionsCollapsible:'not-collapsible',
                        partsOfSpeechFilter:true,
                        useDeinflections:true
                    }});
                    await api.setAllSettings(options,'native-smoke');
                    await api.triggerDatabaseUpdated('dictionary','import');
                    return {{title:imported.result?.title,errors:(imported.errors||[]).map(e=>e.message||String(e))}};
                }})()"#,
                archive = json!(archive_b64)
            );
            let imported = evaluate_raw(app, &host_win, &script).await?;
            if imported["title"].as_str() != Some("hachidori-fixture") {
                return Err(format!("Unexpected Yomitan import result: {imported}"));
            }
        } else {
            let script = format!(
                r#"(async()=>{{
                    for (let i = 0; i < 100; i++) {{
                        const st = await chrome.runtime.sendMessage({{
                            target: 'hoshidicts-offscreen',
                            type: 'hd_status',
                            requestId: `smoke-status-${{i}}`
                        }});
                        if (st?.ok && st.ready && !st.loading) break;
                        await new Promise(r => setTimeout(r, 100));
                    }}
                    const bytes=Uint8Array.from(atob({archive}),c=>c.charCodeAt(0));
                    const blobUrl=URL.createObjectURL(new Blob([bytes]));
                    try {{
                        return await chrome.runtime.sendMessage({{
                            target:'hoshidicts-offscreen',
                            type:'hd_import',
                            blobUrl,
                            fileName:'hachidori-fixture.zip',
                            requestId:'native-import'
                        }});
                    }} finally {{
                        URL.revokeObjectURL(blobUrl);
                    }}
                }})()"#,
                archive = json!(archive_b64)
            );
            let imported = evaluate_raw(app, &host_win, &script)
                .await
                .map_err(|e| format!("hachidori import eval: {e}"))?;
            if imported["ok"].as_bool() != Some(true) {
                return Err(format!("Unexpected Hachidori import result: {imported}"));
            }
        }
    }

    let lookup =
        crate::reader_service::try_invoke(app, "gsm-hub", "reader.lookup", &[json!("食べる")])
            .await
            .ok_or("reader.lookup not handled")?
            .map_err(|e| format!("lookup 食べる: {e}"))?;

    if lookup["reader"].as_str() != Some(reader) {
        return Err(format!("Expected reader {reader}, got {lookup}"));
    }
    let has_to_eat = lookup["entries"].as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry["definitions"].as_array().is_some_and(|defs| {
                defs.iter()
                    .any(|d| d.as_str().is_some_and(|s| s.contains("to eat")))
            })
        })
    });
    if !has_to_eat {
        return Err(format!(
            "Dictionary lookup for 食べる missing 'to eat': {lookup}"
        ));
    }

    let host = app.state::<crate::overlay_host::OverlayHost>();
    host.start(app, None, "smoke").await?;
    let overlay = wait_window_ready(app, OVERLAY_MAIN_LABEL, Duration::from_secs(25)).await?;
    host.handle_ws2_text(
        app,
        &json!({"type":"capture_status","available":true,"window_state":"active"}).to_string(),
    )
    .await;
    if !overlay.is_visible().unwrap_or(false) {
        return Err("Dictionary fixture overlay is hidden".into());
    }
    evaluate_raw(app, &overlay, include_str!("../smoke/overlay.js")).await?;
    evaluate_raw(
        app,
        &overlay,
        &format!("window.__gsmSmokeOverlay.lookup({})", json!(reader)),
    )
    .await?;
    if phase == "import" {
        let other = if reader == "yomitan" {
            "hachidori"
        } else {
            "yomitan"
        };
        for next in [other, reader] {
            let previous_document = evaluate_raw(app, &overlay, "performance.timeOrigin").await?;
            host.apply_setting_updates(
                app,
                serde_json::from_value(json!({"dictionaryReaderSelection":next})).unwrap(),
                false,
            );
            let deadline = Instant::now() + Duration::from_secs(45);
            let mut ready = false;
            while Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(150)).await;
                if evaluate_raw(app, &overlay, &format!("performance.timeOrigin !== {} && document.readyState === 'complete' && typeof dictionaryReader !== 'undefined' && dictionaryReader === {}", previous_document, json!(next))).await == Ok(json!(true)) {
                    ready = true; break;
                }
            }
            if !ready {
                return Err(format!("Live dictionary switch to {next} did not finish"));
            }
        }
        // A successful setting change must retain real lookup capability.
        evaluate_raw(app, &overlay, include_str!("../smoke/overlay.js")).await?;
        evaluate_raw(
            app,
            &overlay,
            &format!("window.__gsmSmokeOverlay.lookup({})", json!(reader)),
        )
        .await?;
    }
    host.stop(app).await;

    if phase == "import" {
        let _ = crate::reader_service::try_invoke(
            app,
            "gsm-hub",
            "reader.openDictionary",
            &[json!({ "text": "食べる", "context": "日本語を食べる" })],
        )
        .await
        .ok_or("reader.openDictionary not handled")?
        .map_err(|e| format!("openDictionary: {e}"))?;
        let search_window =
            wait_window_ready(app, DICTIONARY_SEARCH_LABEL, Duration::from_secs(20))
                .await
                .map_err(|e| format!("wait search window: {e}"))?;
        if !search_window.is_visible().unwrap_or(false) {
            return Err("Dictionary search opened hidden".into());
        }
    }

    for (_, w) in app.webview_windows() {
        let _ = w.destroy();
    }
    Ok(json!({ "reader": reader, "phase": phase }))
}

async fn smoke_jiten_broker(app: &AppHandle) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let endpoint = format!(
        "http://{}/private/api/reader/parse",
        listener.local_addr().map_err(|e| e.to_string())?
    );
    let server = tauri::async_runtime::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer).await;
            let body = json!({"tokens":[[{"wordId":1,"readingIndex":0,"start":0,"length":1}]],"vocabulary":[{"wordId":1,"readingIndex":0,"knownState":[0]}]}).to_string();
            let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
        }
    });
    let outcome = async {
        let cache = app.state::<crate::overlay_host::OverlayHost>().jiten_cache(app);
        let initial = cache.parse("猫", "smoke-key", &endpoint).await?;
        let hits = cache.stats().cache_hits;
        let dictionaries = app.state::<DictionaryManager>();
        let extension = dictionaries.load_jiten_extension(app).await?;
        dictionaries.open_jiten_options(app).await?;
        let label = format!("gsm-dict-options-{}", extension.id);
        let options = wait_window_ready(app,&label,Duration::from_secs(20)).await?;
        let result = evaluate_raw(app,&options,&format!(r#"(async()=>{{const response=await fetch({},{{method:'POST',headers:{{'Authorization':'ApiKey smoke-key','Content-Type':'application/json'}},body:JSON.stringify({{text:['猫']}})}}); return await response.json();}})()"#,json!(endpoint))).await?;
        let _ = options.destroy();
        if result != initial || cache.stats().cache_hits <= hits { return Err("Jiten extension request bypassed the shared overlay cache".into()); }
        Ok(())
    }.await;
    server.abort();
    outcome
}

async fn run_legacy_transfer_smoke(app: &AppHandle, fixture_dir: &Path) -> Result<Value, String> {
    let phase = std::env::var("GSM_SMOKE_PHASE").unwrap_or_else(|_| "import".into());
    let source_raw = std::fs::read_to_string(fixture_dir.join("fixture.json"))
        .map_err(|e| format!("Failed reading fixture.json: {e}"))?;
    let source: Value = serde_json::from_str(&source_raw).map_err(|e| e.to_string())?;
    let profile_path = PathBuf::from(
        source["profile"]
            .as_str()
            .ok_or("Missing fixture profile")?,
    );
    let ext_path = PathBuf::from(
        source["extensionPath"]
            .as_str()
            .ok_or("Missing fixture extensionPath")?,
    );
    let kind = source["kind"].as_str().unwrap_or("yomitan");
    let source_id = source["id"].as_str().unwrap_or("");
    std::env::set_var("GSM_OVERLAY_DATA_PATH", &profile_path);

    let dm = app.state::<DictionaryManager>();
    let desktop = app.state::<DesktopState>();

    if use_windows_native_extensions() {
        #[cfg(windows)]
        {
            let ext = dm.load_windows_extension(app, &ext_path).await?;
            let url = format!("chrome-extension://{}/index.html", ext.id);
            let parsed = desktop.assets.url(&url)?;
            let label = "gsm-transfer-win-smoke";
            let token = desktop.register_window(label, "dictionary");
            let preload = crate::overlay_preload::render_desktop_preload(&token);
            let mut builder = apply_shared_webview_options(
                WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
                    .visible(false)
                    .initialization_script_for_all_frames(preload),
            );
            builder = apply_profile_data_directory(builder, &profile_path)?;
            let page = builder.build().map_err(|e| e.to_string())?;
            let _ = wait_window_ready(app, label, Duration::from_secs(20)).await?;
            verify_transferred_indexeddb(app, &page, kind, &phase, false).await?;
            let _ = page.destroy();
            desktop.unregister_window(label);
            return Ok(json!({ "mode": "windows-native", "kind": kind, "phase": phase }));
        }
    }

    if phase != "reopen" {
        if kind == "hachidori" {
            let portable_dir = profile_path.join("portable-dictionaries");
            std::fs::create_dir_all(&portable_dir).map_err(|e| e.to_string())?;
            let manifest: Value = serde_json::from_str(
                &std::fs::read_to_string(ext_path.join("manifest.json"))
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let id = if manifest.get("key").and_then(Value::as_str).is_some() {
                source_id
            } else {
                "gsm-upgraded-extension"
            };
            std::fs::write(
                portable_dir.join(format!("{id}-local.json")),
                json!({
                    "dictionaryState": { "dictionaries": [] },
                    "options": { "language": "en", "enabled": false },
                    "nativeOnly": true
                })
                .to_string(),
            )
            .map_err(|e| e.to_string())?;
        }

        desktop.assets.mount("fixture-prepare", &ext_path)?;
        let _ = desktop.assets.mount_dictionary("fixture-prepare", kind)?;
        let prep_url = desktop
            .assets
            .url("chrome-extension://fixture-prepare/__gsm_migration__.html")?;
        let prep_label = "gsm-transfer-prep";
        let prep_token = desktop.register_window(prep_label, "dictionary");
        let prep_preload = crate::overlay_preload::render_desktop_preload(&prep_token);
        let mut prep_builder = apply_shared_webview_options(
            WebviewWindowBuilder::new(app, prep_label, WebviewUrl::External(prep_url))
                .visible(false)
                .initialization_script_for_all_frames(prep_preload),
        );
        prep_builder = apply_profile_data_directory(prep_builder, &profile_path)?;
        let prep_win = prep_builder.build().map_err(|e| e.to_string())?;
        let _ = wait_window_ready(app, prep_label, Duration::from_secs(20)).await?;
        let _ = evaluate_raw(
            app,
            &prep_win,
            r#"(async()=>{
                const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
                const opening=indexedDB.open('gsm-migration-fixture',3);opening.onupgradeneeded=()=>opening.result.createObjectStore('terms');
                (await request(opening)).close();
                const logs=indexedDB.open('hachidori-debug-log',1);logs.onupgradeneeded=()=>logs.result.createObjectStore('events');
                const db=await request(logs);const tx=db.transaction('events','readwrite');tx.objectStore('events').put('native diagnostic','native');
                await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
            })()"#,
        )
        .await?;
        let _ = prep_win.destroy();
        desktop.unregister_window(prep_label);
        desktop.assets.unmount("fixture-prepare");
    }

    let ext = dm.load_portable_extension(app, &ext_path).await?;
    let target_url = format!("{}/__gsm_migration__.html", ext.base);
    let parsed = desktop.assets.url(&target_url)?;
    let label = "gsm-transfer-portable-smoke";
    let token = desktop.register_window(label, "dictionary");
    let preload_base = crate::overlay_preload::render_desktop_preload(&token);
    let dict_preload = dm.portable_preload_for_window(label, &ext, &target_url, 999_050);
    let mut builder = apply_shared_webview_options(
        WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
            .visible(false)
            .initialization_script_for_all_frames(format!("{preload_base}\n;{dict_preload}")),
    );
    builder = apply_profile_data_directory(builder, &profile_path)?;
    let page = builder.build().map_err(|e| e.to_string())?;
    let _ = wait_window_ready(app, label, Duration::from_secs(20)).await?;

    let summary_path = profile_path
        .join("portable-dictionaries")
        .join(format!("{}-legacy-transfer.json", ext.id));
    let summary: Value = serde_json::from_str(
        &std::fs::read_to_string(&summary_path)
            .map_err(|e| format!("Missing transfer summary: {e}"))?,
    )
    .map_err(|e| e.to_string())?;
    let expected_records = if kind == "hachidori" { 7 } else { 3 };
    if summary["records"].as_u64() != Some(expected_records) {
        return Err(format!("Unexpected transfer record count: {summary}"));
    }

    verify_transferred_indexeddb(app, &page, kind, &phase, true).await?;
    let _ = page.destroy();
    desktop.unregister_window(label);
    Ok(json!({ "mode": "portable", "kind": kind, "phase": phase }))
}

async fn verify_transferred_indexeddb(
    app: &AppHandle,
    page: &WebviewWindow,
    kind: &str,
    phase: &str,
    portable: bool,
) -> Result<(), String> {
    let result = evaluate_raw(
        app,
        page,
        r#"(async()=>{
            const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
            const db=await request(indexedDB.open('gsm-migration-fixture'));
            const tx=db.transaction(['terms','media','compound'],'readwrite');
            const term=await request(tx.objectStore('terms').get(1));
            const media=await request(tx.objectStore('media').get('sample'));
            const compound=await request(tx.objectStore('compound').get(['食べる','たべる']));
            const deleted=await request(tx.objectStore('terms').get(99));
            const nextKey=await request(tx.objectStore('terms').add({expression:'next'}));
            db.close();
            return {
                term,
                compound,
                deleted:deleted??null,
                nextKey,
                date:media.date.toISOString(),
                bytes:[...media.bytes],
                blob:await media.blob.text(),
                mime:media.blob.type,
                large:media.large.toString()
            };
        })()"#,
    )
    .await?;

    let expected_next = if phase == "reopen" { 101 } else { 100 };
    if result["term"]["definition"].as_str() != Some("to eat")
        || result["compound"]["value"].as_i64() != Some(42)
        || !result["deleted"].is_null()
        || result["nextKey"].as_i64() != Some(expected_next)
        || result["date"].as_str() != Some("2026-01-02T03:04:05.000Z")
        || result["blob"].as_str() != Some("日本語")
        || result["mime"].as_str() != Some("text/plain")
    {
        return Err(format!(
            "Transferred IndexedDB verification failed: {result}"
        ));
    }

    if !portable && kind == "hachidori" {
        let opfs = evaluate_raw(
            app,
            page,
            r#"(async()=>{
                const root=await navigator.storage.getDirectory();
                const generation=await root.getDirectoryHandle('.hdw-generation-fixture');
                const dictionary=await generation.getDirectoryHandle('日本語');
                const file=await (await dictionary.getFileHandle('index.json')).getFile();
                const names=[];
                for await(const [name] of dictionary) names.push(name);
                return {text:await file.text(),names};
            })()"#,
        )
        .await?;
        if opfs["text"].as_str() != Some("日本語 dictionary") {
            return Err(format!("OPFS verification failed: {opfs}"));
        }
    }
    Ok(())
}

/// Exercise the real coordinator, capture worker, local recognition and result
/// delivery. The backend is isolated so no test text reaches the user's history.
#[cfg(windows)]
async fn run_ocr_flow_smoke(app: &AppHandle, bus_info: &Value) -> Result<Value, String> {
    use crate::ocr_coordinator::{self, OcrRunMode, OcrStartSource};
    use tokio_tungstenite::tungstenite::Message;
    let desktop = app.state::<DesktopState>();
    let token = desktop.register_window("gsm-ocr-smoke-target", "smoke");
    let paths = crate::desktop_services::paths_for(app);
    let fixture = paths.active.join("ocr-smoke");
    std::fs::create_dir_all(&fixture).map_err(|e| e.to_string())?;
    std::fs::write(fixture.join("index.html"), "<!doctype html><meta charset='utf-8'><body style='margin:0;background:white;color:black;font:48px Meiryo,sans-serif;padding:50px'>日本語の文章を読みます</body>").map_err(|e| e.to_string())?;
    desktop.assets.mount("ocr-smoke", &fixture)?;
    let url = desktop
        .assets
        .url(&format!("{}/ocr-smoke/index.html", crate::assets::origin()))?;
    let window = WebviewWindowBuilder::new(app, "gsm-ocr-smoke-target", WebviewUrl::External(url))
        .title("GSM OCR verification")
        .inner_size(850.0, 360.0)
        .visible(true)
        .initialization_script_for_all_frames(crate::overlay_preload::render_desktop_preload(
            &token,
        ))
        .build()
        .map_err(|e| e.to_string())?;
    wait_window_ready(app, "gsm-ocr-smoke-target", Duration::from_secs(15)).await?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize as u64;
    let scene = "Native OCR Smoke";
    let area_path = paths.active.join("ocr_config/NativeOCRSmoke.json");
    std::fs::create_dir_all(area_path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&area_path, json!({"scene":scene,"coordinate_system":"percentage","rectangles":[{"coordinates":[0.0,0.0,1.0,1.0],"is_excluded":false}]}).to_string()).map_err(|e| e.to_string())?;
    ocr_coordinator::save_ocr_config(
        app,
        &json!({"ocr1":"oneocr","ocr2":"oneocr","twoPassOCR":false,"disableNativeOcr":false,"sendToClipboard":false,"manualOcrHotkey":"","wholeWindowOcrHotkey":"","areaSelectOcrHotkey":"","addAreaOcrHotkey":"","globalPauseHotkey":""}),
    )?;
    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}", bus_info["port"]))
            .await
            .map_err(|e| e.to_string())?;
    socket.send(Message::Text(json!({"v":1,"id":"hello-ocr","src":"backend","dst":"main","kind":"hello","topic":"bus.hello","data":{"token":bus_info["token"]}}).to_string().into())).await.map_err(|e| e.to_string())?;
    let welcome = socket
        .next()
        .await
        .ok_or("No backend welcome")?
        .map_err(|e| e.to_string())?;
    if serde_json::from_str::<Value>(welcome.to_text().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?["topic"]
        != "bus.welcome"
    {
        return Err("OCR smoke backend was not welcomed".into());
    }
    let (result_tx, mut result_rx) = tokio::sync::mpsc::channel(2);
    let server = tauri::async_runtime::spawn(async move {
        while let Some(Ok(message)) = socket.next().await {
            let Ok(request) = serde_json::from_str::<Value>(message.to_text().unwrap_or("")) else {
                continue;
            };
            if request["kind"] != "request" {
                continue;
            }
            let data = match request["topic"].as_str() {
                Some("ocr.native.context") => {
                    json!({"available":true,"scene":scene,"target_id":hwnd,"capture_kind":"window","process_path":scene})
                }
                Some("ocr.native.result") => {
                    let _ = result_tx.send(request["data"].clone()).await;
                    json!({"status":"accepted"})
                }
                _ => continue,
            };
            if socket.send(Message::Text(json!({"v":1,"id":uuid::Uuid::new_v4().to_string(),"src":"backend","dst":"main","kind":"response","topic":request["topic"],"corr":request["id"],"ok":true,"data":data}).to_string().into())).await.is_err() { break; }
        }
    });
    let outcome = async {
        if std::env::var("GSM_SMOKE_SUITE").as_deref() == Ok("ocr-hotkeys") {
            ocr_coordinator::save_ocr_config(app, &json!({"areaSelectOcrHotkey":"F15", "gamepadHotkeysEnabled":false}))?;
            ocr_coordinator::start_ocr(app, OcrStartSource::User, OcrRunMode::Manual).await?;
            window.set_focus().map_err(|e| e.to_string())?;
            tokio::time::sleep(Duration::from_secs(2)).await;
            use windows::{core::w, Win32::{Foundation::{LPARAM, WPARAM}, UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*}}};
            let input = [KEYBD_EVENT_FLAGS(0), KEYEVENTF_KEYUP].map(|flags| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_F15, dwFlags: flags, ..Default::default() } },
            });
            if unsafe { SendInput(&input, std::mem::size_of::<INPUT>() as i32) } != 2 {
                return Err("Could not inject F15 into the OCR fixture".into());
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(picker) = unsafe { FindWindowW(w!("GsmNativeOcrSelection"), None) } {
                    let mut owner = 0;
                    unsafe { GetWindowThreadProcessId(picker, Some(&mut owner)); }
                    if owner == std::process::id() {
                        unsafe { PostMessageW(Some(picker), WM_KEYDOWN, WPARAM(VK_ESCAPE.0 as usize), LPARAM(0)) }.map_err(|e| e.to_string())?;
                        return Ok(json!({"hotkey":"F15","areaSelectorOpened":true,"controllerHotkeysEnabled":false}));
                    }
                }
                if Instant::now() >= deadline {
                    return Err("F15 did not open the native area selector for a visible capture target".into());
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        // Both manual and automatic scanning must traverse the same native path.
        let mut results = Vec::new();
        for mode in [OcrRunMode::Manual, OcrRunMode::Auto] {
            ocr_coordinator::start_ocr(app, OcrStartSource::User, mode.clone()).await?;
            if mode == OcrRunMode::Manual {
                ocr_coordinator::try_send(app, "ocr.manual-ocr", &[]);
            }
            let payload = tokio::time::timeout(Duration::from_secs(45), result_rx.recv())
                .await
                .map_err(|_| "Native OCR produced no result within 45 seconds")?
                .ok_or("OCR smoke backend closed")?;
            let text = payload["text"].as_str().unwrap_or("");
            if !text.contains("日本語") || payload["ocr_scene"] != scene {
                return Err(format!(
                    "Native OCR returned unexpected text or scene: {payload}"
                ));
            }
            results.push(json!({"mode":mode.as_str(),"text":text}));
            ocr_coordinator::stop_ocr_sync(app, "smoke", None);
        }
        Ok(json!({"ocr":results,"runtime":"native"}))
    }
    .await;
    ocr_coordinator::stop_ocr_sync(app, "smoke-cleanup", None);
    server.abort();
    let _ = window.close();
    desktop.unregister_window("gsm-ocr-smoke-target");
    desktop.assets.unmount("ocr-smoke");
    outcome
}

#[cfg(not(windows))]
async fn run_ocr_flow_smoke(_app: &AppHandle, _bus_info: &Value) -> Result<Value, String> {
    Err("The local OneOCR flow check requires Windows".into())
}

async fn run_suite_smoke(app: &AppHandle, suite: &str) -> Result<Value, String> {
    if !matches!(
        suite,
        "runtime"
            | "foundation"
            | "home"
            | "windows"
            | "settings"
            | "workspace"
            | "overlay"
            | "obs"
            | "texthook"
            | "agent"
            | "ocr"
            | "ocr-flow"
            | "ocr-hotkeys"
            | "input"
            | "notifications"
    ) {
        return Err(format!("Unknown native smoke suite: {suite}"));
    }
    let bus_info =
        crate::runtime::dispatch(app, json!({ "action": "bus.info", "params": {} })).await?;
    if bus_info["port"].as_u64().unwrap_or(0) == 0
        || bus_info["token"].as_str().unwrap_or("").is_empty()
    {
        return Err(format!("Invalid runtime bus info: {bus_info}"));
    }

    // Verify core native desktop services directly in Rust.
    let settings = crate::desktop_services::invoke(app, "gsm-hub", "settings.getSettings", &[])
        .await
        .ok_or("settings.getSettings not handled")??;
    if !settings.is_object() {
        return Err("settings.getSettings did not return an object".into());
    }
    let obs_status = crate::desktop_services::invoke(app, "gsm-hub", "obs.state", &[])
        .await
        .ok_or("obs.state not handled")??;
    if !obs_status.is_object() {
        return Err("obs.state did not return an object".into());
    }
    let texthook_state = crate::desktop_services::invoke(app, "gsm-hub", "texthook.getStatus", &[])
        .await
        .ok_or("texthook.getStatus not handled")??;
    if !texthook_state.is_object() {
        return Err("texthook.getStatus did not return an object".into());
    }
    let agent_state = crate::agent::dispatch(app, json!({ "action": "state" })).await?;
    if !agent_state.is_object() {
        return Err("agent.getState did not return an object".into());
    }
    let ocr_state = crate::desktop_services::invoke(app, "gsm-hub", "ocr.get-running-state", &[])
        .await
        .ok_or("ocr.get-running-state not handled")??;
    if !ocr_state.is_object() {
        return Err("ocr.get-running-state did not return an object".into());
    }

    if matches!(suite, "ocr-flow" | "ocr-hotkeys") {
        return run_ocr_flow_smoke(app, &bus_info).await;
    }

    if suite == "home" {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let paths = crate::desktop_services::paths_for(app);
        std::fs::write(
            paths.active.join("config.json"),
            json!({"current_profile":"VN","configs":{
                "Default":{"general":{"single_port":9}},
                "VN":{"general":{"single_port":port,"texthooker_port":9}}
            }})
            .to_string(),
        )
        .map_err(|e| e.to_string())?;
        let server = tauri::async_runtime::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut request = BufReader::new(stream).lines();
            assert!(request
                .next_line()
                .await
                .unwrap()
                .unwrap()
                .starts_with("GET /get_status "));
            let mut accepts_identity = false;
            while let Some(line) = request.next_line().await.unwrap() {
                if line.is_empty() {
                    break;
                }
                accepts_identity |= line.split_once(':').is_some_and(|(name, value)| {
                    name.eq_ignore_ascii_case("accept-encoding") && value.trim() == "identity"
                });
            }
            // The single-port gateway can negotiate Brotli when Accept-Encoding is absent.
            let json = br#"{"ready":true,"obs_connected":true,"anki_connected":true}"#;
            let brotli = STANDARD
                .decode("GzgAWATqZKlfid+K0cxGEA1swIFbkEYw+rABR5FlHG53hNB+TKzd0PWuxAc=")
                .unwrap();
            let (encoding, body): (&str, &[u8]) = if accepts_identity {
                ("", json)
            } else {
                ("Content-Encoding: br\r\n", &brotli)
            };
            let mut stream = request.into_inner().into_inner();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{encoding}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(headers.as_bytes()).await.unwrap();
            stream.write_all(body).await.unwrap();
        });
        let status = crate::desktop_services::invoke(app, "gsm-hub", "get_gsm_status", &[])
            .await
            .ok_or("get_gsm_status not handled")??;
        server.await.map_err(|e| e.to_string())?;
        if status["ready"] != true
            || status["obs_connected"] != true
            || status["anki_connected"] != true
        {
            return Err(format!(
                "Home status did not use the active single-port backend: {status}"
            ));
        }
    }

    if suite == "input" {
        let input_app = app.clone();
        let (_, url) = tauri::async_runtime::spawn_blocking(move || {
            crate::input_server::wait_ready(&input_app, Duration::from_secs(20))
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Native input server did not start")?;
        let (mut socket, _) = tokio_tungstenite::connect_async(&url)
            .await
            .map_err(|e| e.to_string())?;
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({"type":"ping"}).to_string().into(),
            ))
            .await
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(Ok(message)) = socket.next().await {
                if message
                    .to_text()
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                    .is_some_and(|value| value["type"] == "pong")
                {
                    return Ok(());
                }
            }
            Err("Native input server closed without replying".to_string())
        })
        .await
        .map_err(|_| "Native input server did not answer ping")??;
        let _ = socket.close(None).await;
    }
    if suite == "notifications" {
        let current = service_call(app, "settings.notifications.get", &[]).await?;
        let mut preferences = current["preferences"].clone();
        preferences["volume"] = json!(37);
        service_call(app, "settings.notifications.save", &[preferences.clone()]).await?;
        let saved = service_call(app, "settings.notifications.get", &[]).await?;
        if saved["preferences"] != preferences {
            return Err("Notification preferences did not round-trip".into());
        }
    }
    if suite == "settings" {
        service_call(app, "settings.saveSettings", &[json!({"theme":"light"})]).await?;
        if service_call(app, "settings.getTheme", &[]).await? != "light" {
            return Err("Native theme persistence failed".into());
        }
        let status = service_call(
            app,
            "settings.onboarding.dictionary",
            &[json!({"action":"select","reader":"hachidori"})],
        )
        .await?;
        if status["reader"] != "hachidori" {
            return Err("Onboarding dictionary selection failed".into());
        }
        let status = service_call(
            app,
            "settings.onboarding.dictionary",
            &[json!({"action":"status"})],
        )
        .await?;
        if status["reader"] != "hachidori" {
            return Err("Onboarding dictionary status failed".into());
        }
    }
    if suite == "workspace" {
        let entry = json!({"game":"Native smoke", "text":"食べる"});
        service_call(app, "textprocess.exclusions.add", &[entry.clone()]).await?;
        let listed = service_call(app, "textprocess.exclusions.list", &[]).await?;
        if !listed.to_string().contains("食べる") {
            return Err("Workspace exclusion was not saved".into());
        }
        service_call(app, "textprocess.exclusions.remove", &[entry]).await?;
        let listed = service_call(app, "textprocess.exclusions.list", &[]).await?;
        if listed.to_string().contains("食べる") {
            return Err("Workspace exclusion was not removed".into());
        }
    }

    if matches!(
        suite,
        "foundation" | "home" | "windows" | "settings" | "workspace" | "overlay"
    ) {
        let hub = crate::app_lifecycle::create_hub_window(app)?;
        let _ = wait_window_ready(app, hub.label(), Duration::from_secs(20)).await?;
        let bridge_check = evaluate_raw(
            app,
            &hub,
            "({ hasIpc: typeof window.ipcRenderer?.invoke === 'function', hasFind: typeof window.__GSM_FIND__ === 'function' })",
        )
        .await?;
        if bridge_check["hasIpc"].as_bool() != Some(true)
            || bridge_check["hasFind"].as_bool() != Some(true)
        {
            return Err(format!("Hub preload bridge check failed: {bridge_check}"));
        }
        if suite == "windows" {
            smoke_close_to_tray(app, &hub).await?;
        }
    }

    if suite == "overlay" {
        let overlay_data = overlay_data_path(app);
        std::fs::create_dir_all(&overlay_data).map_err(|e| e.to_string())?;
        let guide_catalogue = overlay_data.join("test-catalogue");
        let guide_game = guide_catalogue.join("test-game");
        std::fs::create_dir_all(&guide_game).map_err(|e| e.to_string())?;
        for (file, data) in [
            (
                "catalog.json",
                json!({"vndb_id":"v93","title":"Test VN guide"}),
            ),
            (
                "guide.json",
                json!({"vndb_id":"v93","title":"Test VN guide","routes":[
                    {"id":"first","title":"First route","reviewed":true},
                    {"id":"second","title":"Second route","reviewed":true}
                ]}),
            ),
            (
                "route_first.json",
                json!([{"simpleJp":"公園に行く"},{"simpleJp":"図書館に行く"}]),
            ),
            ("route_second.json", json!([{"simpleJp":"家に帰る"}])),
        ] {
            std::fs::write(guide_game.join(file), data.to_string()).map_err(|e| e.to_string())?;
        }
        std::fs::write(
            overlay_data.join("settings.json"),
            json!({
                "dictionaryReaderSelection": "hachidori",
                "pushToShowEnforcedDialogDismissed": true,
                "mainBoxStartupWarningAcknowledged": true,
                "openSettingsOnStartup": false,
                "hideOnStartup": true,
                "manualMode": true,
                "showHotkey": "Control+Alt+Shift+F11",
                "enableJitenReader": true,
                "gamepadEnabled": false,
                "gamepadControllerEnabled": false,
                "gamepadKeyboardEnabled": false,
                "routeAllHotkeysThroughInputServer": false
                ,"vnGuideCatalogueSource":guide_catalogue.to_string_lossy()
            })
            .to_string(),
        )
        .map_err(|e| e.to_string())?;

        let started = crate::desktop_services::invoke(app, "gsm-hub", "runOverlay", &[])
            .await
            .ok_or("runOverlay not handled")??;
        if started.as_bool() != Some(true) {
            return Err(format!("Expected runOverlay to return true, got {started}"));
        }
        let status = crate::desktop_services::invoke(app, "gsm-hub", "getOverlayStatus", &[])
            .await
            .ok_or("getOverlayStatus not handled")??;
        if status["isRunning"].as_bool() != Some(true) || !status["pid"].is_null() {
            return Err(format!("Unexpected overlay status: {status}"));
        }
        let main_win = wait_window_ready(app, OVERLAY_MAIN_LABEL, Duration::from_secs(25)).await?;
        let initialized = evaluate_raw(
            app,
            &main_win,
            r#"(async()=>{
            for(let i=0;i<100;i++) {
                if(display?.physicalBounds?.width>0 && manualMode===true) return true;
                await new Promise(resolve=>setTimeout(resolve,50));
            }
            throw Error('Overlay did not receive its initial display and settings');
        })()"#,
        )
        .await?;
        if initialized != true {
            return Err("Overlay initialization failed".into());
        }
        let port = crate::input_server::port(app).ok_or("Input service endpoint missing")?;
        let endpoint = evaluate_raw(app, &main_win, "gamepadSettings.serverUrl").await?;
        if endpoint.as_str() != Some(format!("ws://localhost:{port}").as_str()) {
            return Err(format!(
                "Overlay tokenizer received stale input endpoint: {endpoint}"
            ));
        }
        let host = app.state::<crate::overlay_host::OverlayHost>();
        #[cfg(windows)]
        smoke_overlay_unclipped(app, &main_win).await?;
        let jiten_ready = evaluate_raw(app, &main_win, r#"new Promise((resolve,reject)=>{
            const requestId='native-smoke-jiten';
            const listener=event=>{if(event.source===window && event.data?.type==='gsm-jiten-settings-response' && event.data.requestId===requestId) {
                window.removeEventListener('message',listener); clearInterval(retry); clearTimeout(timeout); resolve(true);
            }};
            window.addEventListener('message',listener);
            const retry=setInterval(()=>window.postMessage({type:'gsm-jiten-settings-request',requestId},'*'),100);
            const timeout=setTimeout(()=>{clearInterval(retry);window.removeEventListener('message',listener);reject(Error('Jiten settings bridge did not load alongside the dictionary'));},8000);
        })"#).await?;
        if jiten_ready != true {
            return Err("Jiten bridge unavailable".into());
        }
        smoke_jiten_broker(app).await?;
        host.apply_setting_updates(app, serde_json::from_value(json!({
            "overlaySettingsProfilesEnabled":true,"overlayProfileSettings":{"VN":{"fontSize":72}}
        })).unwrap(), true);
        host.handle_ws2_text(
            app,
            &json!({"type":"gsm-profile-state-updated","currentProfileName":"VN",
            "profiles":[{"name":"Default","scenes":[]},{"name":"VN","scenes":["Game"]}]})
            .to_string(),
        )
        .await;
        let profile_font = evaluate_raw(app, &main_win, r#"(async()=>{for(let i=0;i<50;i++){
            if(document.getElementById('text').style.fontSize==='72px') return true; await new Promise(r=>setTimeout(r,20));} return false;})()"#).await?;
        if profile_font != true {
            return Err("Overlay did not apply backend profile settings".into());
        }
        let state = evaluate_raw(
            app,
            &main_win,
            "({ shell: window.gsmEnv?.shell, pinyin: window.require?.('pinyin-pro')?.pinyin('中文') })",
        )
        .await?;
        if state["shell"].as_str() != Some("tauri") || state["pinyin"].as_str() != Some("zhōng wén")
        {
            return Err(format!("Unexpected overlay window environment: {state}"));
        }

        let open_res =
            crate::desktop_services::invoke(app, "gsm-hub", "settings.openOverlaySettings", &[])
                .await
                .ok_or("settings.openOverlaySettings not handled")??;
        if open_res["success"].as_bool() != Some(true) {
            return Err(format!("openOverlaySettings failed: {open_res}"));
        }
        let settings_win =
            wait_window_ready(app, OVERLAY_SETTINGS_LABEL, Duration::from_secs(20)).await?;
        let mut visible = false;
        for _ in 0..40 {
            if settings_win.is_visible().map_err(|e| e.to_string())? {
                visible = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        if !visible {
            return Err("First-open overlay settings stayed hidden".into());
        }
        if app.tray_by_id(crate::overlay_tray::ID).is_none() {
            return Err("Overlay tray was not created".into());
        }
        #[cfg(windows)]
        {
            use windows::Win32::UI::Input::KeyboardAndMouse::*;
            host.apply_setting_updates(app, serde_json::from_value(json!({"overlaySettingsHotkey":"Control+Alt+Shift+F10","routeAllHotkeysThroughInputServer":false})).unwrap(),false);
            settings_win.hide().map_err(|e| e.to_string())?;
            let keys = [VK_CONTROL, VK_MENU, VK_SHIFT, VK_F10];
            let input: Vec<INPUT> = keys
                .iter()
                .copied()
                .map(|key| (key, KEYBD_EVENT_FLAGS(0)))
                .chain(keys.iter().rev().copied().map(|key| (key, KEYEVENTF_KEYUP)))
                .map(|(key, flags)| INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: key,
                            dwFlags: flags,
                            ..Default::default()
                        },
                    },
                })
                .collect();
            if unsafe { SendInput(&input, std::mem::size_of::<INPUT>() as i32) }
                != input.len() as u32
            {
                return Err("Could not inject the overlay settings shortcut".into());
            }
            for _ in 0..80 {
                if settings_win.is_visible().unwrap_or(false) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            if !settings_win.is_visible().unwrap_or(false) {
                return Err("Native settings shortcut did not reveal Overlay Settings".into());
            }
        }
        host.open_settings(app, Some("hotkeys")).await?;
        let hotkeys = evaluate_raw(
            app,
            &settings_win,
            r#"(async()=>{for(let i=0;i<40;i++) {
            if(window.GSMSettingsNavigation?.activePage?.id === 'interaction-hotkeys') return true;
            await new Promise(r=>setTimeout(r,25));
        } return false;})()"#,
        )
        .await?;
        if hotkeys != true {
            return Err("Overlay settings did not select Hotkeys".into());
        }
        smoke_vn_guide(app, &settings_win).await?;

        let theme =
            crate::desktop_services::invoke(app, OVERLAY_SETTINGS_LABEL, "settings.getTheme", &[])
                .await
                .ok_or("Overlay theme channel was not routed")??;
        if theme.as_str().is_none() {
            return Err(format!("Invalid overlay theme: {theme}"));
        }
        for monitor in crate::overlay_magpie::collect_displays(app).iter().rev() {
            let bounds = &monitor.physical_bounds;
            app.state::<crate::overlay_host::OverlayHost>().handle_ws2_text(app, &json!({
                "type":"native-overlay-command", "action":"configure", "config":{
                    "available":false, "settings":{
                        "monitor_to_capture":0,"monitor_to_capture_id":"0",
                        "monitor_to_capture_bounds":{"left":bounds.x,"top":bounds.y,"width":bounds.width,"height":bounds.height}
                    }
                }
            }).to_string()).await;
            let mut matched = false;
            for _ in 0..40 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let position = main_win.outer_position().map_err(|e| e.to_string())?;
                let size = main_win.inner_size().map_err(|e| e.to_string())?;
                let rendered = evaluate_raw(app, &main_win, "display?.physicalBounds").await?;
                if position.x == bounds.x as i32
                    && position.y == bounds.y as i32
                    && size.width == bounds.width as u32
                    && size.height == bounds.height as u32
                    && rendered["x"].as_f64() == Some(bounds.x)
                    && rendered["y"].as_f64() == Some(bounds.y)
                {
                    matched = true;
                    break;
                }
            }
            if !matched {
                return Err(format!(
                    "Overlay failed to follow monitor {}",
                    monitor.label
                ));
            }
        }
        evaluate_raw(app, &main_win, include_str!("../smoke/overlay.js")).await?;
        evaluate_raw(app, &main_win, "window.__gsmSmokeOverlay.geometry()").await?;
        host.handle_ws2_text(
            app,
            &json!({"type":"capture_status","available":true,"window_state":"active"}).to_string(),
        )
        .await;
        for state in [
            "obscured",
            "active",
            "minimized",
            "background",
            "closed",
            "active",
        ] {
            app.state::<crate::overlay_host::OverlayHost>()
                .handle_ws2_text(
                    app,
                    &json!({
                        "type":"window_state", "data":state, "target_hwnd":1, "occlusion_rects":[]
                    })
                    .to_string(),
                )
                .await;
            let expected = matches!(state, "active" | "background");
            let mut matched = false;
            for _ in 0..40 {
                tokio::time::sleep(Duration::from_millis(25)).await;
                if main_win.is_visible().map_err(|e| e.to_string())? == expected {
                    matched = true;
                    break;
                }
            }
            if !matched {
                return Err(format!("Overlay visibility did not follow {state}"));
            }
        }

        let stopped =
            crate::desktop_services::invoke(app, "gsm-hub", "setOverlayEnabled", &[json!(false)])
                .await
                .ok_or("setOverlayEnabled not handled")??;
        if stopped["isRunning"].as_bool() != Some(false) {
            return Err(format!(
                "setOverlayEnabled(false) did not stop overlay: {stopped}"
            ));
        }
        if app.tray_by_id(crate::overlay_tray::ID).is_some() {
            return Err("Overlay tray survived stop".into());
        }
        if app
            .get_webview_window(crate::overlay_host::OVERLAY_TEXTHOOKER_LABEL)
            .is_some()
        {
            return Err("Overlay Text Feed survived stop".into());
        }
    }

    for (_, w) in app.webview_windows() {
        let _ = w.destroy();
    }
    Ok(json!({ "suite": suite }))
}

#[cfg(windows)]
async fn smoke_overlay_unclipped(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{CreateRectRgn, DeleteObject, GetRgnBox, GetWindowRgn},
    };

    let host = app.state::<crate::overlay_host::OverlayHost>();
    // The legacy preload reports only the immediate-text box. Hidden, it is
    // just 20x20 pixels of padding; shown, it still excludes OCR and widgets.
    for shape in [
        json!({"x":0,"y":0,"width":20,"height":20}),
        json!({"x":120,"y":240,"width":400,"height":80}),
    ] {
        if !host
            .handle_send(
                app,
                OVERLAY_MAIN_LABEL,
                "update-window-shape",
                &[shape.clone()],
            )
            .await
        {
            return Err("Legacy overlay shape message was not handled".into());
        }
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        unsafe {
            let region = CreateRectRgn(0, 0, 0, 0);
            if region.is_invalid() {
                return Err("Could not inspect the native overlay region".into());
            }
            let kind = GetWindowRgn(hwnd, region);
            let mut bounds = RECT::default();
            GetRgnBox(region, &mut bounds);
            let _ = DeleteObject(region.into());
            // GetWindowRgn returns ERROR (0) when no clipping region is set.
            if kind.0 != 0 {
                return Err(format!(
                    "Legacy text-box shape {shape} clipped the overlay to {},{},{},{}",
                    bounds.left, bounds.top, bounds.right, bounds.bottom
                ));
            }
        }
    }
    Ok(())
}

async fn service_call(app: &AppHandle, channel: &str, args: &[Value]) -> Result<Value, String> {
    crate::desktop_services::invoke(app, "gsm-hub", channel, args)
        .await
        .ok_or_else(|| format!("Native service did not handle {channel}"))?
}

async fn smoke_vn_guide(app: &AppHandle, settings_win: &WebviewWindow) -> Result<(), String> {
    let host = app.state::<crate::overlay_host::OverlayHost>();
    host.handle_ws2_text(app, &json!({"type":"capture_status","scene_name":"Guide game","available":true,"window_state":"active"}).to_string()).await;
    let picked = evaluate_raw(app, settings_win, r#"(async()=>{
        const ipc=require('electron').ipcRenderer;
        const select=document.getElementById('vn-guide-catalogue');
        for(let i=0;i<100 && select.options.length<2;i++) await new Promise(r=>setTimeout(r,50));
        if(select.options.length!==2 || !select.options[1].text.includes('Test VN guide'))
            throw Error('The picker ignored the saved local catalogue: '+document.getElementById('vn-guide-catalogue-status')?.textContent);
        select.value=select.options[1].value;
        select.dispatchEvent(new Event('change',{bubbles:true}));
        for(let i=0;i<100;i++){
            const state=await ipc.invoke('vn-guide-state');
            if(state.enabled && state.total===2 && !document.getElementById('vn-guide-next').disabled) return state;
            await new Promise(r=>setTimeout(r,50));
        }
        throw Error('Selecting a guide did not enable and load it: '+document.getElementById('vn-guide-status').textContent);
    })()"#).await?;
    if picked["routeId"] != "first" || picked["text"] != "公園に行く" || picked["visible"] != false
    {
        return Err(format!("Unexpected imported guide state: {picked}"));
    }
    host.handle_ws2_text(app, &json!({"type":"word_coordinates","is_final":true,"line_id":"guide-choice","presence_id":"guide-choice","data":[
        {"text":"公園に行く","bounding_rect":{"x1":0.4,"y1":0.40,"x3":0.6,"y3":0.44}},
        {"text":"家に帰る","bounding_rect":{"x1":0.4,"y1":0.48,"x3":0.6,"y3":0.52}}
    ]}).to_string()).await;
    let detected = evaluate_raw(
        app,
        settings_win,
        "require('electron').ipcRenderer.invoke('vn-guide-state')",
    )
    .await?;
    if detected["detected"] != true || detected["visible"] != true {
        return Err(format!(
            "Guide did not detect the OCR choice menu: {detected}"
        ));
    }
    let hud = wait_window_ready(
        app,
        crate::overlay_host::OVERLAY_VN_GUIDE_LABEL,
        Duration::from_secs(20),
    )
    .await?;
    let hud_text = evaluate_raw(app, &hud, r#"(async()=>{for(let i=0;i<50;i++){
        if(document.body.textContent.includes('公園に行く')) return true;await new Promise(r=>setTimeout(r,40));}return false;})()"#).await?;
    if hud_text != true {
        return Err("Detected guide choice did not reach its HUD".into());
    }
    host.handle_ws2_text(app, &json!({"type":"word_coordinates","is_final":true,"line_id":"guide-dialogue","presence_id":"guide-dialogue","data":[
        {"text":"公園に着いた。","bounding_rect":{"x1":0.2,"y1":0.8,"x3":0.5,"y3":0.84}}
    ]}).to_string()).await;
    let advanced = evaluate_raw(
        app,
        settings_win,
        "require('electron').ipcRenderer.invoke('vn-guide-state')",
    )
    .await?;
    if advanced["index"] != 1 {
        return Err(format!("Guide did not advance after choice: {advanced}"));
    }
    // Reveal the next instruction after its confirmation, then exercise actual HUD buttons.
    evaluate_raw(
        app,
        settings_win,
        "require('electron').ipcRenderer.invoke('vn-guide-command',{action:'next'})",
    )
    .await?;
    for (action, index) in [("back", 0), ("next", 1)] {
        evaluate_raw(
            app,
            &hud,
            &format!(
                r#"(async()=>{{
            const button=document.getElementById('{action}');
            for(let i=0;i<50 && button.disabled;i++)await new Promise(r=>setTimeout(r,40));
            if(button.disabled)throw Error('HUD button remained disabled: {action}');
            button.click();return true;
        }})()"#
            ),
        )
        .await?;
        let state = evaluate_raw(app, settings_win, &format!(r#"(async()=>{{
            for(let i=0;i<50;i++){{const state=await require('electron').ipcRenderer.invoke('vn-guide-state');
                if(state.index==={index})return true;await new Promise(r=>setTimeout(r,40));}}
            return false;
        }})()"#)).await?;
        if state != true {
            return Err(format!(
                "HUD {action} command did not change guide progress"
            ));
        }
    }
    for (scene, enabled) in [("Other game", false), ("Guide game", true)] {
        host.handle_ws2_text(app, &json!({"type":"capture_status","scene_name":scene,"available":false,"window_state":"closed"}).to_string()).await;
        let state = evaluate_raw(
            app,
            settings_win,
            "require('electron').ipcRenderer.invoke('vn-guide-state')",
        )
        .await?;
        if state["enabled"] != enabled || (enabled && state["index"] != 1) {
            return Err(format!(
                "Guide selection/progress did not follow scene {scene}: {state}"
            ));
        }
    }
    let invalid = evaluate_raw(app, settings_win, "require('electron').ipcRenderer.invoke('vn-guide-command',{action:'select-guide',value:'invalid'})").await?;
    if invalid["error"].as_str().is_none_or(str::is_empty) || invalid["total"] != 2 {
        return Err(format!(
            "Invalid guide selection did not preserve the loaded guide: {invalid}"
        ));
    }
    let route = evaluate_raw(app, settings_win, r#"(async()=>{
        const select=document.getElementById('vnGuideRoute');select.value='second';select.dispatchEvent(new Event('change',{bubbles:true}));
        for(let i=0;i<100;i++){const state=await require('electron').ipcRenderer.invoke('vn-guide-state');
            if(state.routeId==='second' && state.total===1)return state;await new Promise(r=>setTimeout(r,50));}
        throw Error('Route picker did not load second route');
    })()"#).await?;
    if route["text"] != "家に帰る" {
        return Err(format!("Unexpected route: {route}"));
    }
    Ok(())
}
