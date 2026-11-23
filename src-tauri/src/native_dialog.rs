use crate::{assets, desktop_state::DesktopState};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

pub(crate) struct Sessions<T>(Mutex<HashMap<String, Arc<Session<T>>>>);

impl<T> Default for Sessions<T> {
    fn default() -> Self {
        Self(Mutex::default())
    }
}

pub(crate) struct Session<T> {
    pub data: T,
    done: Mutex<Option<oneshot::Sender<Value>>>,
}

impl<T> Session<T> {
    pub fn resolve(&self, answer: Value) {
        if let Some(done) = self.done.lock().unwrap().take() {
            let _ = done.send(answer);
        }
    }
}

impl<T: Send + Sync + 'static> Sessions<T> {
    pub fn get(app: &AppHandle, label: &str) -> Result<Arc<Session<T>>, String> {
        app.state::<Self>()
            .0
            .lock()
            .unwrap()
            .get(label)
            .cloned()
            .ok_or_else(|| "Dialog is closed".into())
    }

    pub async fn open<'a>(
        app: &'a AppHandle,
        kind: &str,
        title: &str,
        (width, height): (f64, f64),
        data: T,
        asset_dir: Option<&Path>,
        customize: impl FnOnce(
            WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
        )
            -> Result<WebviewWindowBuilder<'a, tauri::Wry, AppHandle>, String>,
        can_close: impl Fn(&AppHandle, &str, &T) -> bool + Send + 'static,
    ) -> Result<Value, String> {
        let label = format!("{kind}-{}", uuid::Uuid::new_v4().simple());
        let desktop = app.state::<DesktopState>();
        let mut url = crate::app_lifecycle::desktop_renderer_url(app)?;
        url.query_pairs_mut().append_pair("window", kind);
        let page = url.clone();
        let profile = crate::dictionary_host::overlay_data_path(app);
        std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        let builder = customize(
            WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
                .title(title)
                .inner_size(width, height)
                .center()
                .always_on_top(true)
                .visible(std::env::var_os("GSM_SMOKE_TEST").is_none())
                .on_navigation(move |next| {
                    next.scheme() == page.scheme()
                        && next.host() == page.host()
                        && next.port_or_known_default() == page.port_or_known_default()
                        && next.path() == page.path()
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny),
        )?;
        let builder = crate::dictionary_host::apply_profile_data_directory(
            crate::dictionary_host::apply_shared_webview_options(builder),
            &profile,
        )?;
        if let Some(dir) = asset_dir {
            desktop.assets.mount(&label, dir)?;
        }
        let token = desktop.register_window(&label, "desktop");
        let preload = crate::overlay_preload::render_desktop_window_preload(
            &token,
            Some(&crate::desktop_state::theme_for_app(app)),
        );
        let windows = app.state::<Self>();
        let (done, result) = oneshot::channel();
        windows.0.lock().unwrap().insert(
            label.clone(),
            Arc::new(Session {
                data,
                done: Mutex::new(Some(done)),
            }),
        );
        let outcome = match builder.initialization_script(preload).build() {
            Ok(window) => {
                let owner = app.clone();
                let closed = label.clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. }
                        if !owner
                            .state::<DesktopState>()
                            .quitting
                            .load(std::sync::atomic::Ordering::Acquire) =>
                    {
                        if Self::get(&owner, &closed)
                            .is_ok_and(|s| !can_close(&owner, &closed, &s.data))
                        {
                            api.prevent_close();
                        }
                    }
                    WindowEvent::Destroyed => {
                        if let Ok(session) = Self::get(&owner, &closed) {
                            session.resolve(Value::Null);
                        }
                    }
                    _ => {}
                });
                let answer = result.await.unwrap_or(Value::Null);
                let _ = window.destroy();
                Ok(answer)
            }
            Err(error) => Err(error.to_string()),
        };
        windows.0.lock().unwrap().remove(&label);
        desktop.unregister_window(&label);
        desktop.assets.unmount(&label);
        outcome
    }
}

pub(crate) fn asset_url(label: &str, name: &str) -> String {
    format!("{}/{label}/{name}", assets::origin())
}

pub(crate) fn title(app: &AppHandle, label: &str, value: &Value) -> Result<Value, String> {
    let title = value.as_str().ok_or("Missing window title")?;
    let window: WebviewWindow = app.get_webview_window(label).ok_or("Dialog is closed")?;
    window.set_title(title).map_err(|e| e.to_string())?;
    Ok(Value::Null)
}
