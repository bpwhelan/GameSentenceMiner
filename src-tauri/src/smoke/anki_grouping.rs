use super::*;
use crate::gui_dialog::{self, Dialog};

pub(super) fn fixture() -> Dialog {
    Dialog::AnkiFieldGrouping {
        expression: "読む".into(),
        candidates: vec![
            json!({"note_id":101,"sentence":"最初の文","tags":["VN"]}),
            json!({"note_id":102,"sentence":"次の文","tags":["Book"]}),
        ],
        default_order: Some("back".into()),
        default_delete_duplicate: Some(false),
    }
}

pub(super) async fn run(app: &AppHandle) -> Result<Value, String> {
    let started = Instant::now();
    let owner = app.clone();
    let choice =
        tauri::async_runtime::spawn(async move { gui_dialog::open(&owner, fixture()).await });
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if Instant::now() > deadline {
            return Err("Grouping dialog did not render".into());
        }
        if let Some(win) = app
            .webview_windows()
            .into_values()
            .find(|w| w.label().starts_with("anki-grouping-"))
        {
            let evaluated = app.state::<DesktopState>().evaluate(&win,r#"
                const target = document.querySelector('form select');
                if (!target || target.options.length !== 2) return false;
                if (document.querySelectorAll('select')[1].value !== 'back' || document.querySelector('input').checked) throw Error('Wrong defaults');
                target.value = '1'; target.dispatchEvent(new Event('change', {bubbles:true}));
                setTimeout(() => document.querySelector('button[title]').click(), 0);
                return true;
            "#).await;
            if evaluated? == true {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let answer = tokio::time::timeout(Duration::from_secs(10), choice)
        .await
        .map_err(|_| "Grouping reply timed out")?
        .map_err(|e| e.to_string())??;
    let elapsed = started.elapsed().as_secs_f64() * 1000.;
    if answer
        != json!({"target_note_id":102,"order":"back","delete_duplicate":false,"overwrite":true})
    {
        return Err(answer.to_string());
    }
    Ok(json!({"elapsed_ms":elapsed}))
}
