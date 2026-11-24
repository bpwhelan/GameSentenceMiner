//! Hidden presentation views may shed browser caches; background services stay live.
//! Never trim process working sets or suspend a shared dictionary renderer.
use std::collections::HashMap;
use std::sync::{atomic::Ordering, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewWindow};

const HIDDEN_GRACE: Duration = Duration::from_secs(10);

#[derive(Default)]
struct ViewState {
    hidden_since: Option<Instant>,
    reduced: bool,
}

impl ViewState {
    fn observe(&mut self, inactive: bool, now: Instant) -> Option<bool> {
        let reduce = if inactive {
            now.saturating_duration_since(*self.hidden_since.get_or_insert(now)) >= HIDDEN_GRACE
        } else {
            self.hidden_since = None;
            false
        };
        if reduce == self.reduced {
            return None;
        }
        self.reduced = reduce;
        Some(reduce)
    }
}

#[derive(Default)]
pub struct MemoryPolicy(Mutex<HashMap<String, ViewState>>);

/// Native hiding/minimizing does not consistently change Page Visibility in
/// WebView2 (especially with the live overlay's browser flags). UI work must
/// honor the actual window state as well as browser visibility.
pub fn sync_visibility(window: &WebviewWindow) {
    let visible = window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false);
    let _ = window.eval(&format!(
        "if (window.__GSM_NATIVE_WINDOW_VISIBLE__ !== {visible}) {{ window.__GSM_NATIVE_WINDOW_VISIBLE__ = {visible}; window.dispatchEvent(new Event('gsm-native-visibilitychange')); }}"
    ));
}

fn presentation_view(label: &str, scope: Option<&str>, overlay_running: bool) -> bool {
    if label == crate::overlay_host::OVERLAY_MAIN_LABEL {
        return !overlay_running;
    }
    // Dictionary controllers, lookup pages, background/offscreen hosts, and OBS
    // service windows must be ready even while no UI is visible.
    label == crate::overlay_host::OVERLAY_TEXTHOOKER_LABEL
        || matches!(scope, Some("desktop" | "overlay" | "vn-guide" | "remote"))
        || label.starts_with("docs-")
}

fn set_reduced(window: &WebviewWindow, reduced: bool) {
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows::core::Interface;
        let label = window.label().to_owned();
        let _ = window.with_webview(move |view| unsafe {
            let result = (|| -> windows::core::Result<()> {
                let webview = view
                    .controller()
                    .CoreWebView2()?
                    .cast::<ICoreWebView2_19>()?;
                webview.SetMemoryUsageTargetLevel(if reduced {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                })
            })();
            if let Err(error) = result {
                eprintln!("[memory] Browser memory policy unavailable for {label}: {error}");
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (window, reduced);
}

pub fn restore(window: &WebviewWindow) {
    let Some(policy) = window.app_handle().try_state::<MemoryPolicy>() else {
        return;
    };
    let changed = policy
        .0
        .lock()
        .unwrap()
        .get_mut(window.label())
        .and_then(|state| state.observe(false, Instant::now()));
    if changed.is_some() {
        set_reduced(window, false);
    }
}

pub fn forget(app: &AppHandle, label: &str) {
    if let Some(policy) = app.try_state::<MemoryPolicy>() {
        policy.0.lock().unwrap().remove(label);
    }
}

pub fn start(app: &AppHandle) {
    app.manage(MemoryPolicy::default());
    let models_app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if models_app
                .state::<crate::desktop_state::DesktopState>()
                .quitting
                .load(Ordering::SeqCst)
            {
                break;
            }
            let vad = models_app
                .try_state::<std::sync::Arc<crate::mining::MiningService>>()
                .map(|service| service.vad.clone());
            let _ = tauri::async_runtime::spawn_blocking(move || {
                gsm_overlay::engines::release_idle_models(Duration::from_secs(60));
                if let Some(vad) = vad {
                    vad.unload_default_idle();
                }
            })
            .await;
            crate::reader_service::release_idle_lookup(&models_app, Duration::from_secs(120))
                .await;
        }
    });
    #[cfg(windows)]
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                if app
                    .state::<crate::desktop_state::DesktopState>()
                    .quitting
                    .load(Ordering::SeqCst)
                {
                    break;
                }
                let handle = app.clone();
                if app
                    .run_on_main_thread(move || {
                        let desktop = handle.state::<crate::desktop_state::DesktopState>();
                        let running = handle.state::<crate::overlay_host::OverlayHost>().status()
                            ["isRunning"]
                            == true;
                        let windows = handle.webview_windows();
                        let policy = handle.state::<MemoryPolicy>();
                        let mut states = policy.0.lock().unwrap();
                        states.retain(|label, _| windows.contains_key(label));
                        for (label, window) in windows {
                            if desktop.window_scope(&label).as_deref() == Some("desktop")
                                || label == crate::overlay_host::OVERLAY_TEXTHOOKER_LABEL
                            {
                                sync_visibility(&window);
                            }
                            let visible = window.is_visible().unwrap_or(true)
                                && !window.is_minimized().unwrap_or(false);
                            let inactive = !visible
                                && presentation_view(
                                    &label,
                                    desktop.window_scope(&label).as_deref(),
                                    running,
                                );
                            if let Some(reduced) = states
                                .entry(label)
                                .or_default()
                                .observe(inactive, Instant::now())
                            {
                                set_reduced(&window, reduced);
                            }
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_views_get_a_grace_period_and_restore_immediately() {
        let mut view = ViewState::default();
        let now = Instant::now();
        assert_eq!(view.observe(true, now), None);
        assert_eq!(view.observe(true, now + HIDDEN_GRACE), Some(true));
        assert_eq!(view.observe(true, now + HIDDEN_GRACE), None);
        assert_eq!(view.observe(false, now + HIDDEN_GRACE), Some(false));
        assert_eq!(view.observe(true, now + HIDDEN_GRACE), None);
    }

    #[test]
    fn live_overlay_and_dictionary_services_are_never_reduced() {
        assert!(!presentation_view(
            crate::overlay_host::OVERLAY_MAIN_LABEL,
            Some("overlay"),
            true
        ));
        assert!(presentation_view(
            crate::overlay_host::OVERLAY_MAIN_LABEL,
            Some("overlay"),
            false
        ));
        assert!(!presentation_view(
            "gsm-reader-lookup",
            Some("dictionary"),
            false
        ));
        assert!(!presentation_view(
            "gsm-hachidori-engine",
            Some("dictionary"),
            false
        ));
        assert!(!presentation_view("obs-service", None, false));
        assert!(presentation_view("gsm-hub", Some("desktop"), true));
        assert!(presentation_view("docs-1", None, true));
        assert!(presentation_view(
            crate::overlay_host::OVERLAY_TEXTHOOKER_LABEL,
            None,
            true,
        ));
    }
}
