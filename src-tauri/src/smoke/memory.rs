//! Repeatable process-tree memory checkpoints, driven by benchmark_desktop_memory.py.
use super::*;

async fn checkpoint(app: &AppHandle, name: &str) -> Result<(), String> {
    let root = PathBuf::from(
        std::env::var_os("GSM_MEMORY_CHECKPOINT_DIR")
            .ok_or("Missing memory checkpoint directory")?,
    );
    let windows: Vec<_> = app
        .webview_windows()
        .into_values()
        .map(|w| {
            json!({
                "label":w.label(), "visible":w.is_visible().unwrap_or(false)
            })
        })
        .collect();
    let metrics = if let Some(hub) = app.get_webview_window(crate::app_lifecycle::HUB_WINDOW_LABEL)
    {
        evaluate_raw(app, &hub, "({nodes:document.querySelectorAll('*').length,lines:document.querySelectorAll('.reading-line').length,heap:performance.memory?.usedJSHeapSize ?? null})").await?
    } else {
        Value::Null
    };
    std::fs::write(
        root.join(format!("{name}.ready.json")),
        json!({"name":name,"windows":windows,"renderer":metrics}).to_string(),
    )
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(90), async {
        while !root.join(format!("{name}.continue")).is_file() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| format!("Memory checkpoint timed out: {name}"))
}

pub(super) async fn run(app: &AppHandle) -> Result<Value, String> {
    let hub = crate::app_lifecycle::create_hub_window(app)?;
    wait_window_ready(app, hub.label(), Duration::from_secs(30)).await?;
    crate::desktop_state::focus_window(&hub)?;
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            if evaluate_raw(
                app,
                &hub,
                "document.querySelectorAll('.reading-line').length",
            )
            .await?
                == json!(1000)
            {
                return Ok::<(), String>(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| "Transcript fixture did not load")??;
    checkpoint(app, "home-visible").await?;
    hub.hide().map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if evaluate_raw(
                app,
                &hub,
                "document.querySelectorAll('.reading-line').length",
            )
            .await?
                == json!(0)
            {
                return Ok::<(), String>(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| "Native hiding did not suspend transcript presentation")??;
    checkpoint(app, "home-hidden").await?;
    if evaluate_raw(
        app,
        &hub,
        "document.querySelectorAll('.reading-line').length",
    )
    .await?
        != json!(0)
    {
        return Err("Hidden Home retained its transcript DOM".into());
    }
    let overlay = app.state::<crate::overlay_host::OverlayHost>();
    overlay.start(app, Some(false), "memory").await?;
    wait_window_ready(app, OVERLAY_MAIN_LABEL, Duration::from_secs(30)).await?;
    wait_overlay_dictionary(app).await?;
    checkpoint(app, "overlay-warm").await?;
    overlay.stop(app).await;
    overlay.start(app, Some(false), "memory").await?;
    tokio::time::sleep(Duration::from_secs(35)).await;
    if app.get_webview_window(OVERLAY_MAIN_LABEL).is_none() || overlay.status()["isRunning"] != true
    {
        return Err("An old idle timer destroyed a re-enabled overlay".into());
    }
    overlay.stop(app).await;
    tokio::time::sleep(Duration::from_secs(35)).await;
    if app.get_webview_window(OVERLAY_MAIN_LABEL).is_some() {
        return Err("Disabled overlay did not release its webview".into());
    }
    checkpoint(app, "overlay-disabled").await?;
    // Check both renderer state preservation and cold overlay recreation.
    crate::desktop_state::focus_window(&hub)?;
    overlay.start(app, Some(false), "memory").await?;
    wait_overlay_dictionary(app).await?;
    if evaluate_raw(
        app,
        &hub,
        "document.querySelectorAll('.reading-line').length",
    )
    .await?
        != json!(1000)
    {
        return Err("Reopening Home lost its transcript".into());
    }
    checkpoint(app, "reopened").await?;
    overlay.stop(app).await;
    Ok(json!({"suite":"memory","transcript_lines":1000}))
}
