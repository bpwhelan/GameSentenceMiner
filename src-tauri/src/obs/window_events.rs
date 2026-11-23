//! Out-of-context events are delivered on Tauri's existing UI message pump.
//! Callbacks only signal work. Window titles and executable paths are resolved
//! outside the callback, which can be re-entered by Win32.
use super::*;
use std::cell::RefCell;
use tokio::sync::{mpsc, watch};
use windows::Win32::{
    Foundation::HWND,
    UI::{
        Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
        WindowsAndMessaging::{
            GetAncestor, GetForegroundWindow, IsWindowVisible, EVENT_OBJECT_DESTROY,
            EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_REORDER,
            EVENT_OBJECT_SHOW, EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND,
            EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MOVESIZEEND, GA_ROOT, WINEVENT_OUTOFCONTEXT,
        },
    },
};

struct Hooks {
    handles: Vec<HWINEVENTHOOK>,
    focus: watch::Sender<()>,
    emulator: mpsc::Sender<usize>,
    obs: Obs,
}
impl Drop for Hooks {
    fn drop(&mut self) {
        for handle in self.handles.drain(..) {
            unsafe {
                let _ = UnhookWinEvent(handle);
            }
        }
    }
}
thread_local! {static HOOKS: RefCell<Option<Hooks>> = const {RefCell::new(None)};}

unsafe extern "system" fn event(
    _: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _: u32,
    _: u32,
) {
    if hwnd.is_invalid() || child != 0 || (object != 0 && event != EVENT_OBJECT_REORDER) {
        return;
    }
    HOOKS.with_borrow(|hooks| {
        let Some(h) = hooks else { return };
        if event == EVENT_SYSTEM_FOREGROUND
            || (matches!(event, EVENT_OBJECT_NAMECHANGE | EVENT_OBJECT_SHOW)
                && hwnd == GetForegroundWindow())
        {
            h.focus.send_replace(());
        }
        if matches!(event, EVENT_OBJECT_NAMECHANGE | EVENT_OBJECT_SHOW) {
            let _ = h.emulator.try_send(hwnd.0 as usize);
        }
        h.obs.0.session.window_dirty.notify_one();
    });
}

pub(super) fn start(app: &tauri::AppHandle, obs: Obs) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let (focus, mut changes) = watch::channel(());
        let (emulator, mut titles) = mpsc::channel(128);
        let mut hooks = Hooks {
            handles: Vec::new(),
            focus,
            emulator,
            obs: obs.clone(),
        };
        for (first, last) in [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE),
            (EVENT_OBJECT_DESTROY, EVENT_OBJECT_REORDER),
            (EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZEEND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            (EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE),
        ] {
            let hook = unsafe {
                SetWinEventHook(first, last, None, Some(event), 0, 0, WINEVENT_OUTOFCONTEXT)
            };
            if hook.0.is_null() {
                crate::desktop_log::warn(
                    &handle,
                    "window",
                    "Window hook unavailable, using periodic foreground checks",
                );
                return;
            }
            hooks.handles.push(hook);
        }
        HOOKS.with_borrow_mut(|slot| *slot = Some(hooks));
        obs.0.session.window_hooks.store(true, Ordering::Relaxed);
        let focus_app = handle.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if let Some(snapshot) = process::foreground() {
                    obs.foreground(&focus_app, snapshot);
                }
                if changes.changed().await.is_err() {
                    break;
                }
            }
        });
        tauri::async_runtime::spawn(async move {
            while let Some(id) = titles.recv().await {
                let hwnd = HWND(id as *mut _);
                if unsafe {
                    GetAncestor(hwnd, GA_ROOT) != hwnd
                        || !IsWindowVisible(hwnd).as_bool()
                        || hwnd == GetForegroundWindow()
                } {
                    continue;
                }
                if let Some(s) = process::window_snapshot(hwnd) {
                    let exe = text(&s, "executableName");
                    if [
                        "eden.exe",
                        "yuzu.exe",
                        "suyu.exe",
                        "ryujinx.exe",
                        "lichii.exe",
                        "citron.exe",
                        "sudachi.exe",
                        "torzu.exe",
                    ]
                    .iter()
                    .any(|e| exe.eq_ignore_ascii_case(e))
                    {
                        crate::auto_launcher::notify_foreground_changed(
                            &handle,
                            exe,
                            text(&s, "title"),
                        );
                    }
                }
            }
        });
    })
    .map_err(err)
}
