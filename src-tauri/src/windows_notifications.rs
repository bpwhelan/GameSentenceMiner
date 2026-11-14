//! Native notifications have a separate Windows identity from the retired
//! Electron toast activator. Reusing that identity starts electron.exe -Embedding.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use tauri::Manager;
use windows::{
    core::{IInspectable, Interface, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    Win32::System::Registry::*,
    UI::Notifications::{
        ToastActivatedEventArgs, ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification,
        ToastNotificationManager,
    },
};

static ACTIVE: OnceLock<Mutex<HashMap<i64, ToastNotification>>> = OnceLock::new();

fn identity(app: &tauri::AppHandle) -> String {
    format!(
        "{}.native{}{}",
        app.config().identifier,
        if cfg!(debug_assertions) { ".dev" } else { "" },
        if cfg!(debug_assertions) && std::env::var_os("GSM_SMOKE_TEST").is_some() {
            ".test"
        } else {
            ""
        }
    )
}

fn register(app: &tauri::AppHandle, id: &str) -> windows::core::Result<()> {
    unsafe {
        let mut key = HKEY::default();
        RegCreateKeyW(
            HKEY_CURRENT_USER,
            &HSTRING::from(format!("Software\\Classes\\AppUserModelId\\{id}")),
            &mut key,
        )
        .ok()?;
        let result = (|| {
            for (name, text) in [
                ("DisplayName", "GSM".to_owned()),
                (
                    "IconUri",
                    app.state::<crate::desktop_state::DesktopState>()
                        .assets_dir()
                        .join("gsm.ico")
                        .to_string_lossy()
                        .into_owned(),
                ),
            ] {
                let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
                let bytes = std::slice::from_raw_parts(text.as_ptr() as *const u8, text.len() * 2);
                RegSetValueExW(key, &HSTRING::from(name), None, REG_SZ, Some(bytes)).ok()?;
            }
            Ok(())
        })();
        let _ = RegCloseKey(key);
        result
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn xml(params: &Value) -> String {
    let text = |key| escape(params[key].as_str().unwrap_or_default());
    let duration = if params["timeoutType"] == "never" {
        "long"
    } else {
        "short"
    };
    let mut xml = format!("<toast duration=\"{duration}\" launch=\"tap\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text>", text("title"), text("body"));
    if let Some(icon) = params["icon"]
        .as_str()
        .and_then(|path| url::Url::from_file_path(path).ok())
    {
        xml += &format!(
            "<image placement=\"appLogoOverride\" src=\"{}\"/>",
            escape(icon.as_str())
        );
    }
    xml += "</binding></visual>";
    if params["silent"].as_bool().unwrap_or(false) {
        xml += "<audio silent=\"true\"/>";
    }
    if let Some(actions) = params["actions"].as_array() {
        xml += "<actions>";
        for (index, action) in actions.iter().take(5).enumerate() {
            xml += &format!(
                "<action content=\"{}\" arguments=\"{index}\" activationType=\"foreground\"/>",
                escape(action["text"].as_str().unwrap_or_default())
            );
        }
        xml += "</actions>";
    }
    xml += "</toast>";
    xml
}

pub fn apply(app: &tauri::AppHandle, params: &Value, close: bool) -> Result<(), String> {
    let target = app.clone();
    let params = params.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(on_main(&target, &params, close).map_err(|error| error.to_string()));
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())?
}

fn on_main(app: &tauri::AppHandle, params: &Value, close: bool) -> windows::core::Result<()> {
    let id = params["id"].as_i64().unwrap_or_default();
    let identity = identity(app);
    let active = ACTIVE.get_or_init(Default::default);
    if close {
        let toast = active.lock().unwrap().remove(&id);
        if let Some(toast) = toast {
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(&identity))?
                .Hide(&toast)?;
        }
        ToastNotificationManager::History()?.RemoveGroupedTagWithId(
            &HSTRING::from(id.to_string()),
            &HSTRING::from("GSM"),
            &HSTRING::from(identity),
        )?;
        return Ok(());
    }
    register(app, &identity)?;
    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(xml(params)))?;
    let toast = ToastNotification::CreateToastNotification(&document)?;
    toast.SetTag(&HSTRING::from(id.to_string()))?;
    toast.SetGroup(&HSTRING::from("GSM"))?;
    let target = app.clone();
    toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
        move |_, args| {
            let action = args
                .as_ref()
                .and_then(|args| args.cast::<ToastActivatedEventArgs>().ok())
                .and_then(|args| args.Arguments().ok())
                .map(|args| args.to_string())
                .filter(|args| !args.is_empty())
                .unwrap_or("tap".into());
            if id == crate::game_privileges::GAME_PRIVILEGE_TOAST_ID {
                crate::game_privileges::handle_toast_activated(&target);
            } else {
                crate::app_lifecycle::on_notification_action(&target, id, &action);
            }
            Ok(())
        },
    ))?;
    let target = app.clone();
    toast.Dismissed(&TypedEventHandler::<
        ToastNotification,
        ToastDismissedEventArgs,
    >::new(move |_, _| {
        if let Some(active) = ACTIVE.get() {
            active.lock().unwrap().remove(&id);
        }
        if id >= 0 {
            crate::app_lifecycle::on_notification_action(&target, id, "close");
        }
        Ok(())
    }))?;
    let target = app.clone();
    toast.Failed(
        &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, _| {
            if let Some(active) = ACTIVE.get() {
                active.lock().unwrap().remove(&id);
            }
            if id >= 0 {
                crate::app_lifecycle::on_notification_action(&target, id, "failed");
            }
            Ok(())
        }),
    )?;
    active.lock().unwrap().insert(id, toast.clone());
    if let Err(error) =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(identity))?.Show(&toast)
    {
        active.lock().unwrap().remove(&id);
        return Err(error);
    }
    Ok(())
}

pub fn close_all(app: &tauri::AppHandle) {
    let ids = ACTIVE
        .get()
        .map(|active| active.lock().unwrap().keys().copied().collect::<Vec<_>>())
        .unwrap_or_default();
    for id in ids {
        let _ = apply(app, &json!({"id":id}), true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_text_and_actions_remain_literal_xml() {
        let result = xml(
            &json!({"title":"GSM <restart>", "body":"A&B", "silent":true, "timeoutType":"never", "actions":[{"text":"Restart Now"},{"text":"Cancel \"Restart\""}]}),
        );
        assert!(result.contains("GSM &lt;restart&gt;"));
        assert!(result.contains("A&amp;B"));
        assert!(result.contains("content=\"Restart Now\" arguments=\"0\""));
        assert!(result.contains("content=\"Cancel &quot;Restart&quot;\" arguments=\"1\""));
        assert!(result.contains("<audio silent=\"true\"/>"));
    }
}
