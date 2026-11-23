// A message-only window sleeps in GetMessageW until a clipboard change or shutdown.
use tokio::sync::{oneshot, watch};
use windows::{
    core::w,
    Win32::{
        Foundation::{LPARAM, WPARAM},
        System::{
            DataExchange::{AddClipboardFormatListener, RemoveClipboardFormatListener},
            Threading::GetCurrentThreadId,
        },
        UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, GetMessageW, PostThreadMessageW,
            HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLIPBOARDUPDATE, WM_QUIT,
        },
    },
};

struct Pump(u32);
impl Drop for Pump {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.0, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

pub struct Listener {
    _pump: Pump,
    changes: watch::Receiver<u64>,
}
impl Listener {
    pub async fn start() -> Option<Self> {
        let (ready, started) = oneshot::channel();
        let (tx, changes) = watch::channel(0u64);
        std::thread::Builder::new()
            .name("gsm-clipboard".into())
            .spawn(move || unsafe {
                let Ok(window) = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("STATIC"),
                    w!(""),
                    WINDOW_STYLE::default(),
                    0,
                    0,
                    0,
                    0,
                    Some(HWND_MESSAGE),
                    None,
                    None,
                    None,
                ) else {
                    return;
                };
                if AddClipboardFormatListener(window).is_ok() {
                    // The receiver owns the quit message, including cancellation during startup.
                    if ready.send(Pump(GetCurrentThreadId())).is_ok() {
                        let mut msg = MSG::default();
                        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                            if msg.message == WM_CLIPBOARDUPDATE {
                                tx.send_modify(|n| *n = n.wrapping_add(1));
                            }
                            DispatchMessageW(&msg);
                        }
                    }
                    let _ = RemoveClipboardFormatListener(window);
                }
                let _ = DestroyWindow(window);
            })
            .ok()?;
        Some(Self {
            _pump: started.await.ok()?,
            changes,
        })
    }
    pub async fn changed(&mut self) -> Result<(), watch::error::RecvError> {
        self.changes.changed().await
    }
}
