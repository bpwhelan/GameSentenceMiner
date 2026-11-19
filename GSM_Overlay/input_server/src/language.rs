use gsm_sudachi::{LanguageService, PipeReply, PipeRequest, Request, REPLY_PREFIX, REQUEST_PREFIX};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

pub enum Language {
    Standalone(Arc<LanguageService>),
    Desktop(DesktopLanguage),
}

impl Language {
    pub async fn execute(&self, request: Request) -> Result<Value, String> {
        match self {
            Self::Standalone(service) => service.execute(request).await,
            Self::Desktop(desktop) => desktop.execute(request).await,
        }
    }

    pub async fn release_standalone(&self) {
        if let Self::Standalone(service) = self {
            service.release().await;
        }
    }
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, String>>>;

pub struct DesktopLanguage {
    pending: Arc<Mutex<Option<Pending>>>,
    next_id: AtomicU64,
}

impl DesktopLanguage {
    pub fn start() -> (Self, oneshot::Receiver<()>) {
        let pending = Arc::new(Mutex::new(Some(Pending::new())));
        let replies = pending.clone();
        let (closed, shutdown) = oneshot::channel();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                if line.trim() == "quit" {
                    break;
                }
                let Some(body) = line.strip_prefix(REPLY_PREFIX) else {
                    continue;
                };
                let Ok(reply) = serde_json::from_str::<PipeReply>(body) else {
                    break;
                };
                let sender = replies.lock().unwrap().as_mut().unwrap().remove(&reply.id);
                if let Some(sender) = sender {
                    let _ = sender.send(reply.result);
                }
            }
            replies.lock().unwrap().take();
            let _ = closed.send(());
        });
        (
            Self {
                pending,
                next_id: AtomicU64::new(1),
            },
            shutdown,
        )
    }

    async fn execute(&self, request: Request) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body =
            serde_json::to_string(&PipeRequest { id, request }).map_err(|e| e.to_string())?;
        let (send, receive) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .as_mut()
            .ok_or("GSM desktop language service is disconnected")?
            .insert(id, send);
        let written = tokio::task::spawn_blocking(move || {
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "{REQUEST_PREFIX}{body}").and_then(|_| stdout.flush())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result.map_err(|error| error.to_string()));
        if let Err(error) = written {
            if let Some(pending) = self.pending.lock().unwrap().as_mut() {
                pending.remove(&id);
            }
            return Err(format!(
                "Could not reach GSM desktop language service: {error}"
            ));
        }
        receive
            .await
            .map_err(|_| "GSM desktop language service disconnected".to_string())?
    }
}
