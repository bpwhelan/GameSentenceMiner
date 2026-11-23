pub(crate) mod geometry;
use crate::{assets, desktop_state::DesktopState, mining::MiningService, settings::Settings};
use gsm_mining::{
    config::ProfileConfig,
    ffmpeg::MediaTools,
    frame_selector::{self, Export, Layout, Position, Preview},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::{oneshot, watch};

#[derive(Default)]
pub(crate) struct Selectors(Mutex<HashMap<String, Arc<Session>>>);

#[derive(Default)]
struct Frames {
    previews: HashMap<i64, Arc<Preview>>,
    recent: VecDeque<i64>,
    exporting: bool,
}

struct Session {
    source: PathBuf,
    layout: Layout,
    media: MediaTools,
    config: ProfileConfig,
    dir: tempfile::TempDir,
    closed: AtomicBool,
    generation: watch::Sender<u64>,
    frames: Mutex<Frames>,
    done: Mutex<Option<oneshot::Sender<Option<Export>>>>,
}

impl Session {
    fn finish(&self, selection: Option<Export>) {
        self.closed.store(true, Ordering::Release);
        self.generation.send_modify(|v| *v = v.wrapping_add(1));
        if let Some(done) = self.done.lock().unwrap().take() {
            let _ = done.send(selection);
        }
    }

    async fn page(&self, label: &str, input: &Value) -> Result<Value, String> {
        let page = input["page"].as_i64().ok_or("Missing screenshot page")?;
        let revision = input["revision"].as_u64().ok_or("Missing page revision")?;
        let positions = self.layout.page(page);
        if positions.is_empty() {
            return Err("No frames on this page".into());
        }
        let pins = indices(&input["selected"])?;
        let cancel = self.generation.subscribe();
        let cached = {
            let frames = self.frames.lock().unwrap();
            if frames.exporting
                || self.closed.load(Ordering::Acquire)
                || revision <= *self.generation.borrow()
            {
                return Err("Screenshot page superseded".into());
            }
            if !pins.iter().all(|i| frames.previews.contains_key(i)) {
                return Err("Selected screenshot is unavailable".into());
            }
            self.generation.send_replace(revision);
            positions
                .iter()
                .all(|p| frames.previews.contains_key(&p.index))
        };
        let decoded = if cached {
            Vec::new()
        } else {
            frame_selector::decode_page(
                &self.media,
                &self.config,
                &self.source,
                &positions,
                self.dir.path(),
                cancel,
                revision,
            )
            .await?
        };
        let mut frames = self.frames.lock().unwrap();
        if frames.exporting || self.closed.load(Ordering::Acquire) || revision != *self.generation.borrow() {
            return Err("Screenshot page superseded".into());
        }
        frames
            .previews
            .extend(decoded.into_iter().map(|p| (p.position.index, p)));
        frames.recent.retain(|&p| p != page);
        frames.recent.push_back(page);
        if frames.recent.len() > 2 {
            frames.recent.pop_front();
        }
        let mut retained = pins.into_iter().collect::<HashSet<_>>();
        for p in &frames.recent {
            retained.extend(self.layout.page(*p).iter().map(|x| x.index));
        }
        frames.previews.retain(|i, _| retained.contains(i));
        let images=positions.iter().map(|Position{index,seconds}| {
            let preview=&frames.previews[index];
            let name=preview.path.file_name().unwrap().to_string_lossy();
            json!({"index":index,"seconds":seconds,"url":format!("{}/{label}/{name}",assets::origin())})
        }).collect::<Vec<_>>();
        Ok(
            json!({"page":page,"frames":images,"reference":self.layout.reference,
            "earlier":!self.layout.page(page.saturating_sub(1)).is_empty(),"later":!self.layout.page(page.saturating_add(1)).is_empty()}),
        )
    }

    async fn save(self: &Arc<Self>, input: &Value) -> Result<(), String> {
        let chosen = indices(&input["selected"])?;
        let previews = {
            let mut frames = self.frames.lock().unwrap();
            if frames.exporting || self.closed.load(Ordering::Acquire) {
                return Err("Screenshot selector is busy".into());
            }
            let previews = chosen
                .iter()
                .map(|i| {
                    frames
                        .previews
                        .get(i)
                        .cloned()
                        .ok_or("Selected screenshot is unavailable")
                })
                .collect::<Result<Vec<_>, _>>()?;
            if previews.is_empty() {
                return Err("Select at least one screenshot".into());
            }
            frames.exporting = true;
            // Wake obsolete decoders without consuming the renderer's next revision on retry.
            self.generation.send_modify(|_| {});
            previews
        };
        let session = self.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            frame_selector::export(&session.media, &session.config, &previews, || {
                session.closed.load(Ordering::Acquire)
            })
        })
        .await;
        match result.map_err(|e| e.to_string()).and_then(|result| result) {
            Ok(selection) => {
                self.finish(Some(selection));
                Ok(())
            }
            Err(error) => {
                self.frames.lock().unwrap().exporting = false;
                Err(error)
            }
        }
    }
}

fn indices(value: &Value) -> Result<Vec<i64>, String> {
    let list = value.as_array().ok_or("Missing screenshot selection")?;
    list.iter()
        .map(|v| v.as_i64().ok_or_else(|| "Invalid frame index".into()))
        .collect()
}

pub(crate) async fn invoke(
    app: &AppHandle,
    label: &str,
    channel: &str,
    args: &[Value],
) -> Result<Value, String> {
    let session = app
        .state::<Selectors>()
        .0
        .lock()
        .unwrap()
        .get(label)
        .cloned()
        .ok_or("Screenshot window is closed")?;
    let payload = args.first().unwrap_or(&Value::Null);
    match channel {
        "screenshotSelector.page" => session.page(label, payload).await,
        "screenshotSelector.save" => {
            session.save(payload).await?;
            Ok(Value::Null)
        }
        "screenshotSelector.cancel" => {
            session.finish(None);
            Ok(Value::Null)
        }
        _ => Err("Unknown screenshot command".into()),
    }
}

pub(crate) async fn open(
    app: &AppHandle,
    source: PathBuf,
    reference: f64,
    mode: Option<String>,
) -> Result<Option<Export>, String> {
    let config = app.state::<Arc<MiningService>>().load_config()?;
    open_with_config(app, source, reference, mode, config).await
}

pub(crate) async fn open_with_config(
    app: &AppHandle,
    source: PathBuf,
    reference: f64,
    mode: Option<String>,
    config: ProfileConfig,
) -> Result<Option<Export>, String> {
    let service = app.state::<Arc<MiningService>>();
    let media = MediaTools::discover(
        Some(&app.state::<Settings>().paths.shared),
        service.temp_dir(),
    );
    let dir = tempfile::Builder::new()
        .prefix("gsm-screenshot-selector-")
        .tempdir_in(&media.temp_dir)
        .map_err(|e| e.to_string())?;
    let (done, result) = oneshot::channel();
    let session = tauri::async_runtime::spawn_blocking(move || {
        let mode = mode.as_deref().unwrap_or("beginning");
        let layout = Layout::probe(&media, &source, reference, mode)?;
        Ok::<_, String>(Arc::new(Session {
            source,
            layout,
            media,
            config,
            dir,
            closed: false.into(),
            generation: watch::channel(0).0,
            frames: Mutex::default(),
            done: Mutex::new(Some(done)),
        }))
    })
    .await
    .map_err(|e| e.to_string())??;
    let label = format!("screenshot-{}", uuid::Uuid::new_v4().simple());
    let desktop = app.state::<DesktopState>();
    let url = desktop.assets.url(&format!(
        "{}/renderer/index.html?window=screenshot-selector",
        assets::origin()
    ))?;
    let profile = crate::dictionary_host::overlay_data_path(app);
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    desktop.assets.mount(&label, session.dir.path())?;
    let token = desktop.register_window(&label, "desktop");
    let preload = crate::overlay_preload::render_desktop_window_preload(
        &token,
        Some(&crate::desktop_state::theme_for_app(app)),
    );
    app.state::<Selectors>()
        .0
        .lock()
        .unwrap()
        .insert(label.clone(), session.clone());
    let bounds = geometry::restore(app);
    let builder = crate::dictionary_host::apply_shared_webview_options(
        WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
            .title("GameSentenceMiner")
            .visible(std::env::var_os("GSM_SMOKE_TEST").is_none())
            .position(bounds.x, bounds.y)
            .inner_size(bounds.w, bounds.h)
            .min_inner_size(720., 520.)
            .always_on_top(true)
            .initialization_script(preload),
    );
    let window = crate::dictionary_host::apply_profile_data_directory(builder, &profile)
        .and_then(|b| b.build().map_err(|e| e.to_string()));
    let result = match window {
        Ok(window) => {
            let on_close = window.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::CloseRequested { .. }) {
                    geometry::save(&on_close);
                }
                if matches!(event, WindowEvent::Destroyed) {
                    session.finish(None);
                }
            });
            let value = result
                .await
                .map_err(|_| "Screenshot window closed".to_string());
            if app.get_webview_window(&label).is_some() {
                geometry::save(&window);
                let _ = window.destroy();
            }
            value
        }
        Err(e) => Err(e),
    };
    app.state::<Selectors>().0.lock().unwrap().remove(&label);
    desktop.unregister_window(&label);
    desktop.assets.unmount(&label);
    result
}
