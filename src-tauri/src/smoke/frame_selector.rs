use super::*;

async fn ready(app: &AppHandle) -> Result<WebviewWindow, String> {
    let end = Instant::now() + Duration::from_secs(35);
    while Instant::now() < end {
        if let Some(win) = app.webview_windows().into_values().find(|w| {
            w.label().starts_with("screenshot-")
                && app
                    .state::<DesktopState>()
                    .window_scope(w.label())
                    .is_some()
        }) {
            let result=app.state::<DesktopState>().evaluate(&win,"return Array.from(document.querySelectorAll('.screenshot-frames img')).filter(i => i.complete && i.naturalWidth > 0).length").await;
            if result
                .as_ref()
                .is_err_and(|e| e == "Window is closed" || e == "Webview closed")
            {
                continue;
            }
            let result = result?;
            if result.as_u64().unwrap_or(0) > 1 {
                return Ok(win);
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("Screenshot selector did not render decoded frames".into())
}

pub(super) async fn folder(app: &AppHandle, ids: [&str; 2]) -> Result<(), String> {
    let service = app
        .state::<std::sync::Arc<crate::mining::MiningService>>()
        .inner()
        .clone();
    let config = service.load_config()?;
    let lines = crate::mining::reader_media::select_many(app, &service, &config, &ids);
    if lines.len() != 2 {
        return Err("Could not resolve both media lines".into());
    }
    let host = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        crate::mining::media_folder::create(&host, &service, config, lines, false).await
    });
    let window = ready(app).await?;
    app.state::<DesktopState>()
        .evaluate(
            &window,
            "setTimeout(() => document.querySelector('.screenshot-frames button').click(),25); return true",
        )
        .await?;
    let folder = tokio::time::timeout(Duration::from_secs(40), task)
        .await
        .map_err(|_| "Media folder timed out")?
        .map_err(|e| e.to_string())??;
    if std::fs::read_to_string(folder.join("sentence.txt")).map_err(|e| e.to_string())?
        != "保存する台詞次の行"
    {
        return Err("Wrong sentence in media folder".into());
    }
    let files = std::fs::read_dir(&folder)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for ext in ["jpg", "wav", "mp4"] {
        if !files.iter().any(|e| {
            e.path().extension().is_some_and(|s| s == ext)
                && e.metadata().is_ok_and(|m| m.len() > 0)
        }) {
            return Err(format!("Media folder lacks {ext}: {files:?}"));
        }
    }
    Ok(())
}

pub(super) async fn run(
    app: &AppHandle,
    port: u16,
    selected: &Value,
    folder: &Path,
    manifest: &Value,
) -> Result<(), String> {
    let desktop = app.state::<DesktopState>();
    let reply: Value = desktop
        .http
        .post(format!("http://127.0.0.1:{port}/get-screenshot"))
        .json(&json!({"id":selected}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if reply != json!({}) {
        return Err(format!("Screenshot request failed: {reply}"));
    }
    let window = ready(app).await?;
    // Cancel through the real window so the shell never opens an external viewer.
    desktop.evaluate(&window,"setTimeout(() => document.querySelector('.screenshot-selector footer button').click(), 25); return true").await?;
    let source = folder.join(
        manifest["clip"]["file"]
            .as_str()
            .ok_or("Missing recording")?,
    );
    let host = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        crate::gui_dialog::open(
            &host,
            crate::gui_dialog::Dialog::ScreenshotSelector {
                video_path: source.to_string_lossy().into_owned(),
                timestamp: 4.1,
                mode: Some("middle".into()),
            },
        )
        .await
    });
    let deadline = Instant::now() + Duration::from_secs(25);
    while app.get_webview_window(window.label()).is_some() {
        if Instant::now() > deadline {
            return Err("Screenshot cancellation did not close the window".into());
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    let window = ready(app).await?;
    desktop.evaluate(&window,"document.querySelectorAll('.screenshot-frames button')[0].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); true").await?;
    desktop
        .evaluate(
            &window,
            "document.querySelectorAll('.screenshot-frames button')[1].click(); true",
        )
        .await?;
    desktop.evaluate(&window,"document.querySelector('.screenshot-choices li button:nth-last-child(2)').click(); true").await?;
    desktop
        .evaluate(
            &window,
            "setTimeout(() => document.querySelector('.screenshot-selector footer button:last-child').click(),25); return true",
        )
        .await?;
    let value = tokio::time::timeout(Duration::from_secs(30), task)
        .await
        .map_err(|_| "No selected screenshots returned")?
        .map_err(|e| e.to_string())??;
    let items = value["items"]
        .as_array()
        .filter(|x| x.len() == 2)
        .ok_or_else(|| format!("Missing screenshot selection {value}"))?;
    if items[0]["start"].as_f64() <= items[1]["start"].as_f64() {
        return Err(format!("Wrong exported frame order: {items:?}"));
    }
    for item in items {
        let path = item["path"].as_str().ok_or("Missing exported image")?;
        if !std::fs::read(path)
            .map_err(|e| e.to_string())?
            .starts_with(&[0xff, 0xd8])
        {
            return Err("Missing JPEG image".into());
        }
    }
    Ok(())
}
