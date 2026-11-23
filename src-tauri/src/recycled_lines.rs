//! Desktop ownership of the recycled-line indicator, from scene selection to the overlay verdict.
use gsm_history::recycled::Lines;
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

#[derive(Default, Clone, PartialEq, Eq)]
pub struct Context {
    scene: String,
    profile: String,
    enabled: bool,
}

impl Context {
    pub fn update(&mut self, scene: &str, profile: &str, enabled: bool) -> bool {
        if self.scene == scene && self.profile == profile && self.enabled == enabled {
            return false;
        }
        self.scene.clear();
        self.scene.push_str(scene);
        self.profile.clear();
        self.profile.push_str(profile);
        self.enabled = enabled;
        true
    }
}

#[derive(Default)]
struct State {
    started: bool,
    context: Context,
    lines: Option<Lines>,
    full_load: bool,
    needs_load: bool,
    retry_at: Option<Instant>,
}

impl State {
    fn select(&mut self, context: &Context) {
        if self.context == *context {
            return;
        }
        self.full_load = context.enabled
            && !self.context.enabled
            && !context.scene.is_empty()
            && context.scene == self.context.scene
            && !self.context.profile.is_empty();
        self.context.clone_from(context);
        // Drop the old scene before allocating its replacement.
        self.lines = (context.enabled && !context.scene.is_empty()).then(Lines::default);
        self.needs_load = self.lines.is_some();
        self.retry_at = None;
    }
}

pub struct Recycled {
    db: PathBuf,
    desired: watch::Receiver<Context>,
    state: Mutex<State>,
}

impl Recycled {
    pub fn started(&self) -> bool {
        self.state.lock().unwrap().started
    }

    // The OBS watch lock is released before reading SQLite. A scan or an intake event arriving
    // before the background watcher also synchronizes here, before that line can be persisted.
    fn with_lines<T>(&self, app: &AppHandle, f: impl FnOnce(&mut State) -> T) -> T {
        let mut state = self.state.lock().unwrap();
        if !state.started {
            return f(&mut state);
        }
        loop {
            state.select(&self.desired.borrow());
            if !state.needs_load || state.retry_at.is_some_and(|at| Instant::now() < at) {
                break;
            }
            let start = Instant::now();
            let loaded = Lines::load(&self.db, &state.context.scene, state.full_load);
            if *self.desired.borrow() != state.context {
                continue;
            }
            match loaded {
                Ok(loaded) => {
                    let count = loaded.len();
                    state.lines.as_mut().unwrap().apply_loaded_history(loaded);
                    state.retry_at = None;
                    state.needs_load = false;
                    crate::desktop_log::info(
                        app,
                        "recycled-lines",
                        format!(
                            "Loaded {count} previous lines for game '{}' in {} ms",
                            state.context.scene,
                            start.elapsed().as_millis()
                        ),
                    );
                }
                Err(error) => {
                    if state.retry_at.is_none() {
                        crate::desktop_log::warn(
                            app,
                            "recycled-lines",
                            format!(
                                "Could not load previous lines for '{}': {error}. Will retry.",
                                state.context.scene
                            ),
                        );
                    }
                    state.retry_at = Some(Instant::now() + Duration::from_secs(5));
                }
            }
            break;
        }
        f(&mut state)
    }

    pub fn observe(
        &self,
        app: &AppHandle,
        record: &gsm_intake::Record,
        append: bool,
        previous: Option<&str>,
    ) {
        self.with_lines(app, |state| {
            if let Some(lines) = &mut state.lines {
                if record.scene.as_ref() != state.context.scene {
                    if append {
                        lines.break_sequence();
                    }
                } else if let Ok(id) = uuid::Uuid::parse_str(&record.line_id) {
                    lines.observe(id, &record.text, append, previous);
                }
            }
        });
    }

    pub fn verdict(&self, app: &AppHandle, scene: &str, line_id: &str, text: &str) -> bool {
        self.with_lines(app, |state| {
            scene == state.context.scene
                && state
                    .lines
                    .as_ref()
                    .is_some_and(|lines| lines.verdict(line_id, text))
        })
    }

    pub fn expire(&self, id: &str) {
        if let Some(lines) = &mut self.state.lock().unwrap().lines {
            if let Ok(id) = uuid::Uuid::parse_str(id) {
                lines.expire(id);
            }
        }
    }

    pub fn reset_session(&self) {
        if let Some(lines) = &mut self.state.lock().unwrap().lines {
            lines.reset_session();
        }
    }
}

pub fn register(app: &AppHandle, db: PathBuf) {
    app.manage(Recycled {
        db,
        desired: app.state::<crate::obs::Obs>().recycled_context(),
        state: Mutex::default(),
    });
}

pub fn start(app: &AppHandle) {
    let service = app.state::<Recycled>();
    service.state.lock().unwrap().started = true;
    let mut desired = service.desired.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            desired.borrow_and_update();
            let handle = app.clone();
            let retry = tauri::async_runtime::spawn_blocking(move || {
                handle
                    .state::<Recycled>()
                    .with_lines(&handle, |state| state.retry_at)
            })
            .await;
            let changed = match retry {
                Ok(Some(at)) => match tokio::time::timeout_at(at.into(), desired.changed()).await {
                    Ok(changed) => changed,
                    Err(_) => continue,
                },
                Ok(None) => desired.changed().await,
                Err(_) => return,
            };
            if changed.is_err() {
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preload_only_on_scene_profile_or_setting_change() {
        let mut state = State::default();
        let mut ctx = Context::default();
        ctx.update("Scene", "Default", true);
        state.select(&ctx);
        assert!(state.needs_load && !state.full_load);
        state.needs_load = false;
        assert!(!ctx.update("Scene", "Default", true));
        state.select(&ctx);
        assert!(!state.needs_load);
        ctx.update("Scene", "Default", false);
        state.select(&ctx);
        assert!(state.lines.is_none() && !state.needs_load);
        ctx.update("Scene", "Default", true);
        state.select(&ctx);
        assert!(state.needs_load && state.full_load);
        ctx.update("Scene", "Second profile", true);
        state.select(&ctx);
        assert!(state.needs_load && !state.full_load);
        ctx.update("Next", "Second profile", true);
        state.select(&ctx);
        assert!(state.needs_load && !state.full_load);
        ctx.update("", "Default", true);
        state.select(&ctx);
        assert!(state.lines.is_none() && !state.needs_load);
    }
}
