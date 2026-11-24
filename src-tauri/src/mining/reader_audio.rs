use super::{
    reader_media::{select, Selection},
    MiningService,
};
use crate::{notification_audio::NotificationAudio, settings::Settings, text_intake::Intake};
use gsm_mining::{config::ProfileConfig, ffmpeg::MediaTools, gateway::StatusCode};
use rodio::{Decoder, Player};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    path::Path,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};
use tempfile::TempPath;
use uuid::Uuid;

type Asset = Arc<TempPath>;

const MAX_CACHED_LINES: usize = 64;

#[derive(Default)]
struct State {
    lines: HashMap<String, [Option<Asset>; 2]>,
    line_order: VecDeque<String>,
    tokens: VecDeque<(String, Asset)>,
    playing: Option<(String, Arc<Player>)>,
    generation: u64,
}

impl State {
    fn cache_line(&mut self, id: String, vad: bool, file: Asset) {
        if let Some(pos) = self.line_order.iter().position(|existing| existing == &id) {
            self.line_order.remove(pos);
        }
        self.line_order.push_back(id.clone());
        self.lines.entry(id).or_default()[vad as usize] = Some(file);
        while self.lines.len() > MAX_CACHED_LINES {
            let Some(oldest) = self.line_order.pop_front() else {
                break;
            };
            self.lines.remove(&oldest);
        }
    }
}

#[derive(Default)]
pub(super) struct Playback(Mutex<State>);

impl Playback {
    fn begin(&self, browser: bool, emit: impl Fn(&str, &str)) -> Option<u64> {
        let mut state = self.0.lock().unwrap();
        state.generation = state.generation.wrapping_add(1);
        if let Some((id, player)) = state.playing.take() {
            player.stop();
            emit("stopped", &id);
            if !browser {
                return None;
            }
        }
        Some(state.generation)
    }

    fn play_source(
        &self,
        source: impl rodio::Source + Send + 'static,
        mixer: &rodio::mixer::Mixer,
        id: &str,
        generation: u64,
        emit: impl Fn(&str, &str),
    ) {
        let player = Arc::new(Player::connect_new(mixer));
        {
            let mut state = self.0.lock().unwrap();
            if state.generation != generation {
                return;
            }
            player.append(source);
            state.playing = Some((id.to_owned(), player.clone()));
            emit("playing", id);
        }
        player.sleep_until_end();
        let mut state = self.0.lock().unwrap();
        if state.generation == generation {
            state.playing.take();
            emit("stopped", id);
        }
    }

    fn cached(&self, id: &str, vad: bool) -> Option<Asset> {
        let state = self.0.lock().unwrap();
        state.lines.get(id)?[vad as usize]
            .as_ref()
            .filter(|p| p.is_file())
            .cloned()
    }
    fn ready(&self, app: &AppHandle, id: &str, file: Asset) {
        let token = Uuid::new_v4().simple().to_string();
        let mut state = self.0.lock().unwrap();
        if state.tokens.len() == 16 {
            state.tokens.pop_front();
        }
        state.tokens.push_back((token.clone(), file));
        drop(state);
        app.state::<Intake>().clip_event(&json!({"event":"audio_ready","line_id":id,"audio_url":format!("/texthooker/audio/{token}")}));
    }
}

pub(crate) fn asset(app: &AppHandle, token: &str) -> Option<Asset> {
    app.state::<Arc<MiningService>>()
        .audio_playback
        .0
        .lock()
        .unwrap()
        .tokens
        .iter()
        .find(|(key, _)| key == token)
        .map(|(_, file)| file.clone())
}

pub(crate) fn queue(app: &AppHandle, body: &Value) -> (StatusCode, Value) {
    let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
        return (StatusCode::BAD_REQUEST, json!({"error":"Missing id"}));
    };
    let service = app.state::<Arc<MiningService>>().inner().clone();
    let config = match service.load_config() {
        Ok(config) => config,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, json!({"error":error})),
    };
    let Some(selection) = select(app, &service, &config, id) else {
        return (StatusCode::BAD_REQUEST, json!({"error":"Invalid id"}));
    };
    let browser = !body["playback_mode"]
        .as_str()
        .is_some_and(|s| s.eq_ignore_ascii_case("native"));
    let vad = body["trim_with_vad"].as_bool().unwrap_or(false);
    let external = !browser && !config.advanced.video_player_path.is_empty();
    let cache = if external {
        None
    } else {
        service.audio_playback.cached(id, vad)
    };
    let reply = if cache.is_some() {
        json!({"queued":false,"line_id":id,"from_cache":true})
    } else {
        json!({"queued":true,"line_id":id})
    };
    let Ok(permit) = service.exports.queue.clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"Audio playback queue is full"}),
        );
    };
    let Some(generation) = service
        .audio_playback
        .begin(browser, |state, line| audio_state(app, state, line))
    else {
        return (StatusCode::OK, reply);
    };
    if browser {
        if let Some(file) = cache.as_ref() {
            service.audio_playback.ready(app, id, file.clone());
            return (StatusCode::OK, reply);
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let id = selection.line.id.clone();
        let result = async {
            let shared = app.state::<Settings>().paths.shared.clone();
            let media = MediaTools::discover(Some(&shared), service.temp_dir());
            if external {
                return play_external(&app, &service, selection, config, media).await;
            }
            let file = match cache {
                Some(file) => file,
                None => prepare(&app, &service, selection, config, vad, media.clone()).await?,
            };
            if browser {
                service.audio_playback.ready(&app, &id, file);
            } else {
                let host = app.clone();
                let line = id.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    play(&host, file, &line, generation, &media)
                })
                .await
                .map_err(|e| e.to_string())??;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            crate::desktop_log::warn(&app, "audio playback", &error);
            app.state::<Intake>()
                .clip_event(&json!({"event":"audio_error","line_id":id,"error":error}));
        }
    });
    (StatusCode::OK, reply)
}

async fn play_external(
    app: &AppHandle,
    service: &MiningService,
    selection: Selection,
    config: ProfileConfig,
    media: MediaTools,
) -> Result<(), String> {
    let input = selection.acquire(app, service).await?;
    let remove = config.paths.remove_video;
    let (mut child, input) = tauri::async_runtime::spawn_blocking(move || {
        let replay = input.line_replay(&selection);
        let (start, ..) =
            media.get_video_timings(replay.path, replay.line, replay.recording_end, &config);
        let player = &config.advanced.video_player_path;
        let mut cmd = tokio::process::Command::new(player);
        if start != 0.0 {
            if player.to_ascii_lowercase().contains("vlc") {
                cmd.args(["--start-time", &start.to_string(), "--one-instance"]);
            } else {
                cmd.arg(format!("--start={start}"));
            }
        }
        let child = cmd.arg(&input.path).spawn().map_err(|e| e.to_string())?;
        input.finished(remove);
        Ok::<_, String>((child, input))
    })
    .await
    .map_err(|e| e.to_string())??;
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;
        drop(input);
    });
    Ok(())
}

async fn prepare(
    app: &AppHandle,
    service: &MiningService,
    selection: Selection,
    config: ProfileConfig,
    vad: bool,
    media: MediaTools,
) -> Result<Asset, String> {
    let id = selection.line.id.clone();
    let input = selection.acquire(app, service).await?;
    let _slot = service
        .clip_saves
        .extraction
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(file) = service.audio_playback.cached(&id, vad) {
        return Ok(file);
    }
    let pauses = service.pause_history.clone();
    let models = service.vad.clone();
    let file = tauri::async_runtime::spawn_blocking(move || {
        let file = input
            .line_replay(&selection)
            .audio(&media, &config, &pauses, &models, vad)?;
        input.finished(config.paths.remove_video);
        Ok::<_, String>(Arc::new(file))
    })
    .await
    .map_err(|e| e.to_string())??;
    service
        .audio_playback
        .0
        .lock()
        .unwrap()
        .cache_line(id, vad, file.clone());
    Ok(file)
}

fn play(
    app: &AppHandle,
    file: Asset,
    id: &str,
    generation: u64,
    media: &MediaTools,
) -> Result<(), String> {
    let service = app.state::<Arc<MiningService>>();
    if service.audio_playback.0.lock().unwrap().generation != generation {
        return Ok(());
    }
    let wav;
    let path = if file
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("wav"))
    {
        file.as_ref().as_ref()
    } else {
        wav = tempfile::Builder::new()
            .suffix(".wav")
            .tempfile_in(&media.temp_dir)
            .map_err(|e| e.to_string())?
            .into_temp_path();
        media.playback_wav(file.as_ref(), &wav)?;
        wav.as_ref()
    };
    let decoder = Decoder::try_from(File::open::<&Path>(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    service.audio_playback.play_source(
        decoder,
        &app.state::<NotificationAudio>().mixer()?,
        id,
        generation,
        |state, line| audio_state(app, state, line),
    );
    Ok(())
}

fn audio_state(app: &AppHandle, state: &str, line: &str) {
    app.state::<Intake>()
        .clip_event(&json!({"event":"audio_state","state":state,"line_id":line}));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{num::NonZero, sync::mpsc, time::Duration};

    #[test]
    fn native_audio_finishes_or_toggles_off_once() {
        for toggle in [false, true] {
            let playback = Playback::default();
            let (send, receive) = mpsc::channel();
            let channels = NonZero::new(1).unwrap();
            let rate = NonZero::new(8_000).unwrap();
            let (mixer, mut output) = rodio::mixer::mixer(channels, rate);
            let source = rodio::buffer::SamplesBuffer::new(channels, rate, vec![0.1; 800]);
            let emit =
                |state: &str, id: &str| send.send((state.to_owned(), id.to_owned())).unwrap();
            let generation = playback.begin(false, emit).unwrap();
            std::thread::scope(|threads| {
                threads.spawn(|| playback.play_source(source, &mixer, "line", generation, emit));
                assert_eq!(
                    receive.recv_timeout(Duration::from_secs(2)).unwrap(),
                    ("playing".into(), "line".into())
                );
                if toggle {
                    assert!(playback.begin(false, emit).is_none());
                }
                // Advance the same Rodio mixer without opening a real speaker.
                for _ in 0..4_000 {
                    let _ = output.next();
                }
                assert_eq!(
                    receive.recv_timeout(Duration::from_secs(2)).unwrap(),
                    ("stopped".into(), "line".into())
                );
            });
            assert!(receive.try_recv().is_err());
            assert!(playback.0.lock().unwrap().playing.is_none());
        }
    }

    #[test]
    fn audio_cache_evicts_oldest_lines_past_limit() {
        let state = &mut State::default();
        for i in 0..(MAX_CACHED_LINES + 10) {
            let tmp = tempfile::NamedTempFile::new().unwrap().into_temp_path();
            state.cache_line(format!("line-{i}"), false, Arc::new(tmp));
        }
        assert_eq!(state.lines.len(), MAX_CACHED_LINES);
        assert!(!state.lines.contains_key("line-0"));
        assert!(state.lines.contains_key(&format!("line-{}", MAX_CACHED_LINES + 9)));
    }
}
