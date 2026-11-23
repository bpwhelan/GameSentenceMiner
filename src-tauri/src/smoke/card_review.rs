use super::*;
use crate::gui_dialog::{self, Dialog};

async fn wait(app: &AppHandle, label: &str, script: &str) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            if let Some(window) = app.get_webview_window(label) {
                if app
                    .state::<DesktopState>()
                    .evaluate(&window, script)
                    .await?
                    == true
                {
                    return Ok(());
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| format!("{label} did not complete the review action"))?
}

pub(super) async fn run(app: &AppHandle) -> Result<Value, String> {
    let started = Instant::now();
    let app_handle = app.clone();
    let audio = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .join("review-fixture.wav");
    let dialog: Dialog =
        serde_json::from_value(json!({"dialog":"ankiConfirmation","expression":"読む",
        "sentence":"本を読む","translation":"Read a book","audio_path":audio}))
        .map_err(|e| e.to_string())?;
    let answer =
        tauri::async_runtime::spawn(async move { gui_dialog::open(&app_handle, dialog).await });
    wait(app,"gsm-anki-confirmation",r#"
        const input = document.querySelector('textarea');
        const action = document.querySelector('.cr-actions button:not(.cr-primary)');
        if (!input || !action || !document.querySelector('.cr-wave-graph path')?.getAttribute('d')) return false;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '小説を読む');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => action.click(), 0);
        return true;
    "#).await?;
    let result = tokio::time::timeout(Duration::from_secs(10), answer)
        .await
        .map_err(|_| "No confirmation answer")?
        .map_err(|e| e.to_string())??;
    if result[0] != false || result[1] != "小説を読む" {
        return Err(format!("Unexpected confirmation answer: {result}"));
    }
    let confirmation_ms = started.elapsed().as_secs_f64() * 1000.;
    let started = Instant::now();
    gui_dialog::open(app, Dialog::SessionReview).await?;
    wait(app,"gsm-session-review",r#"
        const input = document.querySelector('textarea');
        const action = document.querySelector('.cr-actions .cr-primary');
        if (!input || !action) return false;
        if (!document.querySelector('.cr-queue button')?.textContent.includes('読む')) throw Error('Saved card missing');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '小説を読む');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => action.click(), 0);
        return true;
    "#).await?;
    let render_ms = started.elapsed().as_secs_f64() * 1000.;
    if tokio::time::timeout(Duration::from_secs(15), async {
        while app.get_webview_window("gsm-session-review").is_some() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .is_err()
    {
        let error = if let Some(window) = app.get_webview_window("gsm-session-review") {
            app.state::<DesktopState>().evaluate(&window,
                "return document.querySelector('[role=alert]')?.textContent ?? document.querySelector('.cr-status')?.textContent ?? '';"
            ).await.unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        return Err(format!("Session review did not save and close: {error}"));
    }
    Ok(json!({"confirmation_ms":confirmation_ms,"review_render_ms":render_ms}))
}
