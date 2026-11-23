//! Keep terminal I/O and clipboard ownership off the intake and broker threads.
use gsm_intake::Record;
use std::sync::Arc;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::sync::mpsc;

pub(super) struct Output {
    app: AppHandle,
    record: Arc<Record>,
    append: bool,
}

impl Output {
    pub fn new(app: &AppHandle, record: &Arc<Record>, append: bool) -> Self {
        Self {
            app: app.clone(),
            record: record.clone(),
            append,
        }
    }

    fn deliver(self) {
        let r = self.record;
        let message = if self.append {
            format!("Line received from [{}]: {}", r.source_display_name, r.text)
        } else {
            format!(
                "Line revised from [{}] seq={} rev={}: {}",
                r.source_display_name, r.stream_sequence, r.revision, r.text
            )
        };
        crate::desktop_log::emit_rust(Some(&self.app), "text-intake", "TEXT_RECEIVED", &message);
        if self.append && r.copy_to_clipboard && !r.text.is_empty() && r.stats_status != "skipped" {
            if let Err(err) = self.app.clipboard().write_text(r.text.to_string()) {
                crate::desktop_log::warn(
                    &self.app,
                    "text-intake",
                    format!("Could not copy accepted line to clipboard: {err}"),
                );
            }
        }
    }
}

pub(super) type Sender = mpsc::Sender<Output>;
pub(super) fn start() -> Result<Sender, String> {
    let (sender, mut receiver) = mpsc::channel::<Output>(super::PROJECTION_CAPACITY);
    std::thread::Builder::new()
        .name("gsm-text-outputs".into())
        .spawn(move || {
            while let Some(output) = receiver.blocking_recv() {
                output.deliver();
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(sender)
}
