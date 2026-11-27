use super::*;
use futures_util::{SinkExt, StreamExt};

pub(super) async fn run(app: &AppHandle) -> Result<Value, String> {
    for action in ["ensure", "prepare", "reinstall", "ensureUv"] {
        let result =
            crate::python_install::dispatch(app, json!({"action":action,"params":{}})).await;
        if !result.as_ref().is_err_and(|error| error.contains("disabled")) {
            return Err(format!("Python operation {action} was not disabled: {result:?}"));
        }
    }
    let mining = app.state::<std::sync::Arc<crate::mining::MiningService>>();
    let port = mining
        .bound_gateway_port()
        .ok_or("Native gateway unavailable")?;
    let base = format!("http://127.0.0.1:{port}");
    let http = &app.state::<DesktopState>().http;
    let fetch = |path: &'static str| {
        let request = http.get(format!("{base}{path}"));
        async move {
            request
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await
        }
    };
    let err = |e: reqwest::Error| e.to_string();
    if fetch("/get_status").await.map_err(err)?["ready"] != false {
        return Err("Desktop announced readiness before startup completed".into());
    }
    let start = Instant::now();
    crate::app_lifecycle::boot_desktop_backend(app.clone()).await;
    let boot_ms = start.elapsed().as_secs_f64() * 1000.0;
    let before = fetch("/get_status").await.map_err(err)?;
    if before["ready"] != true
        || before["text_runtime"]["owner"] != "desktop"
        || before["text_runtime"]["accepted_lines"] != 0
    {
        return Err(format!("Unexpected startup state: {before}"));
    }
    for (route, body, message) in [
        (
            "language",
            json!({"language":123}),
            "Unsupported learning language.",
        ),
        (
            "dictionary",
            json!({"action":"select","reader":"invalid"}),
            "Invalid dictionary reader.",
        ),
        (
            "sudachi",
            json!({"action":"install","dictionary":"invalid"}),
            "Invalid Sudachi dictionary edition.",
        ),
    ] {
        let response = http
            .post(format!("{base}/api/onboarding/{route}"))
            .json(&body)
            .send()
            .await
            .map_err(err)?;
        if response.status().as_u16() != 400
            || response.json::<Value>().await.map_err(err)?["error"] != message
        {
            return Err(format!("Invalid onboarding request mishandled for {route}"));
        }
    }
    let sudachi = http
        .post(format!("{base}/api/onboarding/sudachi"))
        .json(&json!({"action":"status"}))
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json::<Value>()
        .await
        .map_err(err)?;
    if sudachi["state"] != "setup_required" || sudachi["type"] != "sudachi_status" {
        return Err(format!("Unexpected dictionary state: {sudachi}"));
    }
    #[cfg(windows)]
    {
        let shared = &app.state::<crate::settings::Settings>().paths.shared;
        for tool in ["ffmpeg.exe", "ffprobe.exe"] {
            let output = tokio::process::Command::new(shared.join("ffmpeg").join(tool))
                .arg("-version")
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(format!("Installed {tool} failed its version check"));
            }
        }
        let root = gsm_overlay::models::oneocr::directory().map_err(|e| e.to_string())?;
        if root.strip_prefix(shared).is_err() || !root.join("oneocr.onemodel").is_file() {
            return Err("Expected isolated OneOCR runtime".into());
        }
    }
    let invalid = http
        .post(format!("{base}/set_text_intake_paused"))
        .json(&json!({"paused":1}))
        .send()
        .await
        .map_err(err)?;
    if invalid.status().as_u16() != 400
        || invalid.json::<Value>().await.map_err(err)?["error"] != "'paused' must be a boolean"
    {
        return Err("Invalid pause value was accepted".into());
    }
    let text_url = format!("{base}/api/text");
    for (content_type, body, status) in [
        ("application/json", "{", 400),
        ("text/plain", "   ", 400),
        ("application/octet-stream", "text", 415),
    ] {
        let response = http
            .post(&text_url)
            .header("Content-Type", content_type)
            .body(body)
            .send()
            .await
            .map_err(err)?;
        if response.status().as_u16() != status {
            return Err(format!(
                "Expected {status} from text intake, got {}",
                response.status()
            ));
        }
    }
    let browser = http
        .post(&text_url)
        .header("Origin", "https://example.invalid")
        .json(&json!({"text":"第四行"}))
        .send()
        .await
        .map_err(err)?;
    if browser.status().as_u16() != 403 {
        return Err("Text intake accepted a browser-origin request".into());
    }
    let set_pause = |paused| {
        let request = http
            .post(format!("{base}/set_text_intake_paused"))
            .json(&json!({"paused":paused}));
        async move {
            request
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await
        }
    };
    for (paused, text) in [(true, "第一行"), (true, "第二行"), (false, "第三行")] {
        if set_pause(paused).await.map_err(err)?["paused"] != paused
            || fetch("/get_ids").await.map_err(err)?["text_intake_paused"] != paused
        {
            return Err("Pause response and reader state disagree".into());
        }
        if text == "第一行" {
            let reply = http
                .post(format!("{base}/api/onboarding/language"))
                .json(&json!({"language":"ja"}))
                .send()
                .await
                .map_err(err)?
                .error_for_status()
                .map_err(err)?
                .json::<Value>()
                .await
                .map_err(err)?;
            if reply != json!({"success":true,"language":"ja"})
                || fetch("/get_ids").await.map_err(err)?["text_intake_paused"] != true
            {
                return Err("Reloading the learning language lost live intake state".into());
            }
        }
        let request = http.post(&text_url);
        let request = match text {
            "第一行" => request.json(&json!({"sentence":text})),
            "第二行" => request
                .header("Content-Type", "text/plain; charset=utf-8")
                .body(text),
            _ => request.json(&json!({"text":text})),
        };
        let ack: Value = request
            .send()
            .await
            .map_err(err)?
            .error_for_status()
            .map_err(err)?
            .json()
            .await
            .map_err(err)?;
        if ack["status"] != "accepted" || ack["raw_text"] != text {
            return Err(format!("HTTP text intake failed: {ack}"));
        }
    }
    for (enabled, text) in [(false, "第四行"), (true, "第五行")] {
        let reply = http
            .post(format!("{base}/set_stats_gathering_enabled"))
            .json(&json!({"enabled":enabled}))
            .send()
            .await
            .map_err(err)?
            .error_for_status()
            .map_err(err)?
            .json::<Value>()
            .await
            .map_err(err)?;
        if reply["enabled"] != enabled {
            return Err(format!("Unexpected statistics toggle response: {reply}"));
        }
        // Use the same entry point as the Agent callback. A direct intake call
        // would skip the broker and pass even with all hook text stuck in its queue.
        let (mut feed, _) =
            tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws/texthooker"))
                .await
                .map_err(|e| e.to_string())?;
        feed.send(tungstenite::Message::text(
            r#"{"event":"text_v2_snapshot_request"}"#,
        ))
        .await
        .map_err(|e| e.to_string())?;
        let snapshot = next_event(&mut feed, "event", "text_v2_snapshot").await?;
        if !snapshot["lines"].as_array().is_some_and(|lines| {
            lines.iter().any(|line| {
                line["text"] == "第三行"
                    && line["source_display_name"] == "HTTP"
                    && line["relay_only"] == false
            })
        }) {
            return Err(format!("HTTP text missing from Text Feed: {snapshot}"));
        }
        crate::runtime::observe_hook(
            app,
            json!({"engine":"agent","hookId":"agent","exeName":"fixture.exe","text":text}),
        );
        let append = next_event(&mut feed, "event", "text_v2_append").await?;
        if append["data"]["text"] != text {
            return Err(format!("Agent text missing from Text Feed: {append}"));
        }
    }
    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws/overlay"))
            .await
            .map_err(|e| e.to_string())?;
    socket
        .send(tungstenite::Message::text(
            json!({"type":"quick-action-request","action":"state","request_id":"smoke"})
                .to_string(),
        ))
        .await
        .map_err(|e| e.to_string())?;
    let state = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(frame) = socket.next().await {
            let frame = frame.map_err(|e| e.to_string())?;
            if let Some(reply) = frame
                .to_text()
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
            {
                if reply["request_id"] == "smoke" {
                    return Ok(reply);
                }
            }
        }
        Err("Overlay socket closed".to_owned())
    })
    .await
    .map_err(|_| "Timed out waiting for overlay state")??;
    if state["type"] != "quick-action-result"
        || state["paused"] != false
        || state["canReplay"] != true
    {
        return Err(format!("Overlay and reader state disagree: {state}"));
    }
    socket
        .send(tungstenite::Message::text(
            r#"{"type":"get-live-stats-today","reason":"refresh"}"#,
        ))
        .await
        .map_err(|e| e.to_string())?;
    let today = next_event(&mut socket, "scope", "today").await?;
    if today["reason"] != "refresh"
        || !today["values"]["total_characters"].is_number()
        || today["period_start"].as_f64() >= today["period_end"].as_f64()
    {
        return Err(format!("Invalid Today overlay snapshot: {today}"));
    }
    crate::text_intake::flush_history(app).await?;
    let status = fetch("/get_status").await.map_err(err)?;
    if status["text_runtime"]["accepted_lines"] != 5
        || status["text_runtime"]["projected"]
            .as_u64()
            .unwrap_or_default()
            < 5
        || !status["last_line_received"].is_string()
    {
        return Err(format!("Status missed dialogue: {status}"));
    }
    let clients = crate::runtime::get(app)?
        .call("bus.clients", json!({}))
        .await?;
    let process = crate::runtime::get(app)?
        .call("process.state", json!({"id":"backend"}))
        .await?;
    if process["pid"].is_u64()
        || clients
            .as_array()
            .is_some_and(|v| v.iter().any(|c| c == "backend"))
    {
        return Err("Python backend was launched".into());
    }
    if std::env::var("GSM_SMOKE_PHASE").as_deref() == Ok("reopen") {
        if let Some(path) = std::env::var_os("GSM_SMOKE_BENCHMARK_READY") {
            let path = std::path::PathBuf::from(path);
            tokio::fs::write(
                &path,
                json!({"pid":std::process::id(),"port":port}).to_string(),
            )
            .await
            .map_err(|e| e.to_string())?;
            let done = path.with_extension("done");
            tokio::time::timeout(std::time::Duration::from_secs(100), async {
                while !done.is_file() {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            })
            .await
            .map_err(|_| "HTTP benchmark timed out")?;
        }
    }
    Ok(json!({"boot_ms":boot_ms,"status":status,"process":process}))
}

async fn next_event(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    field: &str,
    expected: &str,
) -> Result<Value, String> {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(frame) = socket.next().await {
            let frame = frame.map_err(|e| e.to_string())?;
            if let Some(value) = frame
                .to_text()
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
            {
                if value[field] == expected {
                    return Ok(value);
                }
            }
        }
        Err(format!("Socket closed before {expected}"))
    })
    .await
    .map_err(|_| format!("Timed out waiting for {expected}"))?
}
