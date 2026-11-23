use crate::{assets, desktop_state::DesktopState};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

#[derive(Default)]
pub struct GroupingWindows(Mutex<HashMap<String, Session>>);

struct Session {
    form: Value,
    ids: Vec<u64>,
    done: Option<oneshot::Sender<Value>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Choice {
    candidate: usize,
    back: bool,
    delete_duplicate: bool,
    overwrite: bool,
}

impl Session {
    fn new(
        expression: String,
        candidates: Vec<Value>,
        back: bool,
        delete: bool,
        done: oneshot::Sender<Value>,
    ) -> Result<Self, String> {
        let mut ids = Vec::with_capacity(candidates.len());
        let mut options = Vec::with_capacity(candidates.len());
        for item in candidates {
            let id = item["note_id"]
                .as_u64()
                .or_else(|| item["note_id"].as_str()?.parse().ok())
                .ok_or("Invalid candidate note ID")?;
            ids.push(id);
            let sentence = item["sentence"]
                .as_str()
                .unwrap_or("")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            let mut chars = sentence.chars();
            let mut prefix: String = chars.by_ref().take(107).collect();
            if chars.take(4).count() == 4 {
                prefix.push_str("...");
            } else {
                prefix = sentence;
            }
            options.push(json!({"id":id.to_string(),"sentence":prefix,"tags":item["tags"]}));
        }
        Ok(Self {
            form: json!({"expression":expression,"options":options,"back":back,"deleteDuplicate":delete}),
            ids,
            done: Some(done),
        })
    }

    fn resolve(&mut self, payload: &Value) -> Result<(), String> {
        let result = if payload.is_null() {
            Value::Null
        } else {
            let choice: Choice =
                serde_json::from_value(payload.clone()).map_err(|e| e.to_string())?;
            let id = self
                .ids
                .get(choice.candidate)
                .ok_or("Invalid Anki target")?;
            let mut response = json!({"target_note_id":id,"order":if choice.back {"back"} else {"front"},"delete_duplicate":choice.delete_duplicate});
            if choice.overwrite {
                response["overwrite"] = true.into();
            }
            response
        };
        if let Some(done) = self.done.take() {
            let _ = done.send(result);
        }
        Ok(())
    }
}

impl GroupingWindows {
    pub fn invoke(&self, label: &str, channel: &str, args: &[Value]) -> Result<Value, String> {
        let mut windows = self.0.lock().unwrap();
        let session = windows
            .get_mut(label)
            .ok_or("Anki grouping window is closed")?;
        match channel {
            "ankiGrouping.options" => Ok(session.form.clone()),
            "ankiGrouping.resolve" => {
                session.resolve(args.first().ok_or("Missing grouping choice")?)?;
                Ok(Value::Null)
            }
            _ => Err("Unknown Anki grouping command".into()),
        }
    }
}

pub async fn open(
    app: &AppHandle,
    expression: String,
    candidates: Vec<Value>,
    order: Option<String>,
    delete: Option<bool>,
) -> Result<Value, String> {
    if candidates.is_empty() {
        return Ok(Value::Null);
    }
    let (done, result) = oneshot::channel();
    let session = Session::new(
        expression,
        candidates,
        order
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case("back")),
        delete.unwrap_or(true),
        done,
    )?;
    let label = format!("anki-grouping-{}", uuid::Uuid::new_v4().simple());
    let desktop = app.state::<DesktopState>();
    let url = desktop.assets.url(&format!(
        "{}/renderer/index.html?window=anki-grouping",
        assets::origin()
    ))?;
    let profile = crate::dictionary_host::overlay_data_path(app);
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let token = desktop.register_window(&label, "desktop");
    let preload = crate::overlay_preload::render_desktop_window_preload(
        &token,
        Some(&crate::desktop_state::theme_for_app(app)),
    );
    let windows = app.state::<GroupingWindows>();
    windows.0.lock().unwrap().insert(label.clone(), session);
    let builder = crate::dictionary_host::apply_shared_webview_options(
        WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
            .title("GameSentenceMiner")
            .visible(std::env::var_os("GSM_SMOKE_TEST").is_none())
            .inner_size(680., 420.)
            .min_inner_size(440., 360.)
            .center()
            .always_on_top(true)
            .initialization_script(preload),
    );
    let window = crate::dictionary_host::apply_profile_data_directory(builder, &profile)
        .and_then(|b| b.build().map_err(|e| e.to_string()));
    let outcome = match window {
        Ok(window) => {
            let owner = app.clone();
            let closed = label.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    owner
                        .state::<GroupingWindows>()
                        .0
                        .lock()
                        .unwrap()
                        .remove(&closed);
                }
            });
            let answer = result.await.unwrap_or(Value::Null);
            let _ = window.destroy();
            Ok(answer)
        }
        Err(e) => Err(e),
    };
    windows.0.lock().unwrap().remove(&label);
    desktop.unregister_window(&label);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_index_maps_to_original_note_without_js_precision_loss() {
        let (tx, mut rx) = oneshot::channel();
        let mut s = Session::new(
            "読む".into(),
            vec![json!({"note_id":"9007199254740993","sentence":"  読む\n 本 ","tags":["VN"]})],
            true,
            false,
            tx,
        )
        .unwrap();
        assert_eq!(s.form["options"][0]["sentence"], "読む 本");
        let mut choice =
            json!({"candidate":2,"back":true,"overwrite":true,"deleteDuplicate":false});
        assert!(s.resolve(&choice).is_err());
        choice["candidate"] = 0.into();
        s.resolve(&choice).unwrap();
        assert_eq!(
            rx.try_recv().unwrap(),
            json!({"target_note_id":9007199254740993u64,"order":"back","overwrite":true,"delete_duplicate":false})
        );
    }
}
