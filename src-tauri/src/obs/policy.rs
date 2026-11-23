use super::*;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Settings {
    automatic: bool,
    disabled: bool,
    longplay: bool,
    enable_replay: bool,
    mute_desktop: bool,
    fps: u32,
    seconds: u32,
}
impl Settings {
    pub(super) fn from_profile(profile: &Value) -> Self {
        let obs = &profile["obs"];
        let fps = obs["recording_fps"].as_u64().unwrap_or(15).clamp(1, 120) as u32;
        let screenshot = &profile["screenshot"];
        let animated = screenshot["animated_settings"]["fps"]
            .as_u64()
            .unwrap_or(fps.into())
            .clamp(1, 120) as u32;
        Self {
            automatic: obs["automatically_manage_replay_buffer"] != false,
            disabled: obs["disable_recording"] == true,
            longplay: profile["features"]["generate_longplay"] == true,
            enable_replay: obs["replay_buffer_enabled"] != false,
            mute_desktop: obs["disable_desktop_audio_on_connect"] == true,
            fps: if screenshot["animated"] == true {
                fps.max(animated)
            } else {
                fps
            },
            seconds: obs["replay_buffer_duration_seconds"]
                .as_u64()
                .unwrap_or(300)
                .clamp(1, 86400) as u32,
        }
    }
}

#[derive(Default)]
pub(super) struct ReplayPolicy {
    pub(super) active: Option<bool>,
    pub(super) settings: Option<Settings>,
    expected: Option<(bool, Instant)>,
    external_stop: bool,
    inactive_since: Option<Instant>,
    no_output_since: Option<Instant>,
    epoch: Option<u64>,
    last_attempt: Option<Instant>,
    next_status_probe: Option<Instant>,
}

impl ReplayPolicy {
    fn needs_status_probe(&mut self, now: Instant) -> bool {
        if self.active.is_some() || self.next_status_probe.is_some_and(|next| now < next) {
            return false;
        }
        self.next_status_probe = Some(now + Duration::from_secs(1));
        true
    }

    pub(super) fn expect_method(&mut self, method: &str) {
        let direction = match method {
            "StartReplayBuffer" => Some(true),
            "StopReplayBuffer" => Some(false),
            "ToggleReplayBuffer" => self.active.map(|s| !s),
            _ => return,
        };
        self.expected = direction.map(|v| (v, Instant::now() + Duration::from_secs(8)));
    }
    pub(super) fn observe(&mut self, active: bool) {
        if self.active != Some(active) {
            let internal = self
                .expected
                .is_some_and(|(v, until)| v == active && Instant::now() <= until);
            self.external_stop = !active && self.active.is_some() && !internal;
            self.expected = None;
            self.active = Some(active);
        }
    }
    fn decision(&mut self, state: &Value, now: Instant) -> Option<(bool, bool)> {
        let settings = self.settings?;
        let epoch = state["scene_epoch"].as_u64();
        if self.epoch != epoch || !settings.automatic || settings.disabled {
            self.epoch = epoch;
            self.inactive_since = None;
            self.no_output_since = None;
        }
        if !settings.automatic || settings.disabled || text(state, "scene").is_empty() {
            return None;
        }
        let replay = self.active?;
        let inactive = state["window_inactive"].as_bool() == Some(true);
        let away = elapsed(&mut self.inactive_since, inactive, now);
        let empty = elapsed(&mut self.no_output_since, state["active"] == false, now);
        let desired = if away >= Duration::from_secs(300)
            || empty >= Duration::from_secs_f64((settings.seconds as f64 * 1.1).min(1800.0))
        {
            false
        } else if state["active"] == true && !self.external_stop {
            true
        } else {
            return None;
        };
        if desired == replay
            || self
                .last_attempt
                .is_some_and(|t| now.duration_since(t) < Duration::from_secs(5))
        {
            return None;
        }
        self.last_attempt = Some(now);
        Some((desired, settings.longplay))
    }
}

fn elapsed(start: &mut Option<Instant>, condition: bool, now: Instant) -> Duration {
    if condition {
        now.duration_since(*start.get_or_insert(now))
    } else {
        *start = None;
        Duration::ZERO
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(active: bool) -> ReplayPolicy {
        ReplayPolicy {
            active: Some(active),
            settings: Some(Settings::from_profile(
                &json!({"obs":{"replay_buffer_duration_seconds":100}}),
            )),
            ..Default::default()
        }
    }
    fn state(active: bool, inactive: bool, scene: u64) -> Value {
        json!({"scene":"Game","scene_epoch":scene,"active":active,"window_inactive":inactive})
    }

    #[test]
    fn missing_startup_status_is_retried_until_the_buffer_is_known() {
        let now = Instant::now();
        let mut policy = policy(false);
        policy.active = None;
        let capture = state(true, false, 1);

        assert!(policy.needs_status_probe(now));
        // OBS can answer before its replay output exists. Leave the status unknown.
        assert_eq!(policy.decision(&capture, now), None);
        assert!(!policy.needs_status_probe(now + Duration::from_millis(500)));

        let ready = now + Duration::from_secs(1);
        assert!(policy.needs_status_probe(ready));
        policy.active.get_or_insert(false);
        assert_eq!(policy.decision(&capture, ready), Some((true, false)));
        assert!(!policy.needs_status_probe(ready + Duration::from_secs(1)));
    }

    #[test]
    fn external_stop_blocks_automatic_restart_until_a_new_start() {
        let now = Instant::now();
        let mut policy = policy(true);
        policy.observe(false);
        assert_eq!(policy.decision(&state(true, false, 1), now), None);
        policy.observe(true);
        policy.expect_method("StopReplayBuffer");
        policy.observe(false);
        assert_eq!(
            policy.decision(&state(true, false, 1), now),
            Some((true, false))
        );
    }
    #[test]
    fn unknown_capture_and_scene_changes_cancel_the_no_output_timer() {
        let now = Instant::now();
        let mut policy = policy(true);
        let no_signal = state(false, false, 1);
        assert_eq!(policy.decision(&no_signal, now), None);
        let mut unknown = no_signal.clone();
        unknown["active"] = Value::Null;
        assert_eq!(
            policy.decision(&unknown, now + Duration::from_secs(120)),
            None
        );
        assert_eq!(
            policy.decision(&state(false, false, 2), now + Duration::from_secs(121)),
            None
        );
        assert_eq!(
            policy.decision(&state(false, false, 2), now + Duration::from_secs(232)),
            Some((false, false))
        );
    }
    #[test]
    fn background_window_has_five_minute_grace_and_active_window_resumes() {
        let now = Instant::now();
        let mut policy = policy(true);
        let away = state(true, true, 1);
        assert_eq!(policy.decision(&away, now), None);
        assert_eq!(policy.decision(&away, now + Duration::from_secs(299)), None);
        assert_eq!(
            policy.decision(&away, now + Duration::from_secs(300)),
            Some((false, false))
        );
        policy.expect_method("StopReplayBuffer");
        policy.observe(false);
        assert_eq!(policy.decision(&away, now + Duration::from_secs(400)), None);
        assert_eq!(
            policy.decision(&state(true, false, 1), now + Duration::from_secs(401)),
            Some((true, false))
        );
    }
}

impl Obs {
    pub(super) async fn apply_settings(
        self,
        app: tauri::AppHandle,
        mut rx: tokio::sync::watch::Receiver<Option<(String, Settings)>>,
    ) {
        let mut previous = None;
        let mut retry_settings = false;
        let mut last_directory = None;
        loop {
            let desired = rx.borrow_and_update().clone();
            if self.0.shutting_down.load(Ordering::Acquire) {
                return;
            }
            if let Some((id, settings)) = desired.as_ref() {
                let new_connection = previous
                    .as_ref()
                    .is_none_or(|(old, _): &(String, Settings)| old != id);
                if new_connection
                    || last_directory
                        .is_none_or(|at: Instant| at.elapsed() >= Duration::from_secs(15))
                {
                    if let Err(error) = self.sync_directory(id).await {
                        crate::desktop_log::warn(&app, "obs", error);
                    }
                    last_directory = Some(Instant::now());
                }
                if desired != previous || retry_settings {
                    let result = self
                        .configure_mining(&app, id, *settings, new_connection)
                        .await;
                    retry_settings = result.is_err();
                    if let Err(error) = result {
                        crate::desktop_log::warn(&app, "obs", error);
                    }
                }
            }
            previous = desired;
            tokio::select! {
                update=rx.changed()=>if update.is_err(){break},
                _=tokio::time::sleep(Duration::from_secs(15)), if previous.is_some()=>{}
            }
        }
    }

    async fn sync_directory(&self, id: &str) -> Result<(), String> {
        use std::path::Path;
        let _lifecycle = self
            .0
            .lifecycle
            .try_read()
            .map_err(|_| "OBS runtime is changing")?;
        let _recording = self.0.recording.lock().await;
        if self.0.shutting_down.load(Ordering::Acquire) {
            return Ok(());
        }
        let call = |method, data| self.policy_call(id, method, data);
        let current = call("GetRecordDirectory", Value::Null).await?;
        let current = current["recordDirectory"]
            .as_str()
            .ok_or("OBS did not return its recording directory")?;
        let original = config::recording_directory(Path::new(current));
        let repair_legacy_prefix = cfg!(windows) && current.starts_with("//?/");
        let fallback = config::recording_directory(&self.paths()?.base.join("recordings"));
        let (selected, changed) = tokio::task::spawn_blocking(move || {
            fn writable(dir: &Path) -> std::io::Result<()> {
                if !dir.is_absolute() {
                    return Err(std::io::Error::other("Recording path must be absolute"));
                }
                std::fs::create_dir_all(dir)?;
                use std::io::Write;
                tempfile::Builder::new()
                    .prefix(".gsm-write-check-")
                    .tempfile_in(dir)?
                    .write_all(b"GSM")
            }
            if writable(&original).is_ok() {
                return Ok((original, repair_legacy_prefix));
            }
            writable(&fallback).map_err(err)?;
            Ok::<_, String>((fallback, true))
        })
        .await
        .map_err(err)??;
        if changed {
            let path = selected
                .to_str()
                .ok_or("Invalid OBS recording path")?
                .replace('\\', "/");
            call("SetRecordDirectory", json!({"recordDirectory":path})).await?;
            let actual = call("GetRecordDirectory", Value::Null).await?;
            if !process::same_path(&selected, Path::new(text(&actual, "recordDirectory"))) {
                return Err("OBS did not accept its backup recording directory".into());
            }
            if call("GetReplayBufferStatus", Value::Null)
                .await
                .is_ok_and(|v| v["outputActive"] == true)
            {
                call("StopReplayBuffer", Value::Null).await?;
                let until = Instant::now() + Duration::from_secs(5);
                while call("GetReplayBufferStatus", Value::Null).await?["outputActive"] == true {
                    if Instant::now() >= until {
                        return Err("Replay buffer did not stop during directory change".into());
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                call("StartReplayBuffer", Value::Null).await?;
            }
        }
        self.0
            .session
            .media_settings(id, Some(selected.to_string_lossy().into_owned()), None);
        Ok(())
    }
    pub(super) async fn manage_replay(&self, app: &tauri::AppHandle) {
        if self.0.shutting_down.load(Ordering::Acquire) {
            return;
        }
        let Ok(_lifecycle) = self.0.lifecycle.try_read() else {
            return;
        };
        let Some(id) = self.0.client.primary_id() else {
            return;
        };
        // OBS can accept the socket before its replay output is ready. A failed
        // status query leaves an idle buffer with no event to bootstrap the policy.
        let needs_status = self
            .0
            .policy
            .lock()
            .unwrap()
            .needs_status_probe(Instant::now());
        if needs_status {
            self.refresh_replay_buffer_state(app, &id).await;
        }
        let Ok(_recording) = self.0.recording.try_lock() else {
            return;
        };
        let decision = {
            let mut policy = self.0.policy.lock().unwrap();
            self.0.session.with_state(|state| {
                if state["connection"] != id {
                    return None;
                }
                policy.decision(state, Instant::now())
            })
        };
        if let Some((active, longplay)) = decision {
            let action = if active {
                "StartReplayBuffer"
            } else {
                "StopReplayBuffer"
            };
            match self.policy_call(&id, action, Value::Null).await {
                Ok(_) if longplay => {
                    let action = if active {
                        outputs::Action::RecordStart
                    } else {
                        outputs::Action::RecordStop
                    };
                    if let Err(e) = self
                        .send_output(
                            app,
                            &id,
                            action,
                            tokio::time::Instant::now() + Duration::from_secs(30),
                        )
                        .await
                    {
                        crate::desktop_log::warn(app, "obs", e);
                    }
                }
                Err(e) => crate::desktop_log::warn(app, "obs", e),
                _ => {}
            }
        }
    }
    async fn policy_call(&self, id: &str, method: &str, data: Value) -> Result<Value, String> {
        self.0.policy.lock().unwrap().expect_method(method);
        self.0
            .client
            .call(
                id,
                method.into(),
                data,
                Duration::from_secs(if method == "StopRecord" { 30 } else { 8 }),
            )
            .await
            .map_err(|e| format!("{method}: {} ({})", e.message, e.code))
    }

    pub(super) async fn configure_mining(
        &self,
        app: &tauri::AppHandle,
        id: &str,
        settings: Settings,
        new_connection: bool,
    ) -> Result<(), String> {
        let _lifecycle = self
            .0
            .lifecycle
            .try_read()
            .map_err(|_| "OBS runtime is changing")?;
        let _recording = self.0.recording.lock().await;
        if self.0.shutting_down.load(Ordering::Acquire) {
            return Ok(());
        }
        if !self.0.session.is_connection(id) {
            return Err("OBS connection changed".into());
        }
        let mut warnings = Vec::new();
        if !settings.disabled {
            match self.configure_video(id, settings).await {
                Ok(true) => self
                    .0
                    .session
                    .media_settings(id, None, Some(settings.seconds)),
                Ok(false) => {}
                Err(error) => warnings.push(error),
            }
        }
        if settings.mute_desktop {
            if let Err(error) = self.disable_desktop_audio(id).await {
                warnings.push(error);
            }
        }
        if new_connection && settings.longplay && !settings.disabled {
            if let Err(error) = self
                .send_output(
                    app,
                    id,
                    outputs::Action::RecordStart,
                    tokio::time::Instant::now() + Duration::from_secs(8),
                )
                .await
            {
                warnings.push(error);
            }
        }
        if self.0.session.is_connection(id) {
            self.0.policy.lock().unwrap().settings = Some(settings);
        }
        if warnings.is_empty() {
            Ok(())
        } else {
            Err(warnings.join(", "))
        }
    }

    async fn configure_video(&self, id: &str, settings: Settings) -> Result<bool, String> {
        let call = |method: &'static str, data| self.policy_call(id, method, data);
        let mode = call(
            "GetProfileParameter",
            json!({"parameterCategory":"Output","parameterName":"Mode"}),
        )
        .await?;
        let category = if mode["parameterValue"].as_str().unwrap_or("Simple") == "Simple" {
            "SimpleOutput"
        } else {
            "AdvOut"
        };
        let param = |name| json!({"parameterCategory":category,"parameterName":name});
        if settings.enable_replay
            && call("GetProfileParameter", param("RecRB")).await?["parameterValue"]
                .as_str()
                .is_none_or(|v| !v.eq_ignore_ascii_case("true"))
        {
            let mut p = param("RecRB");
            p["parameterValue"] = json!("true");
            call("SetProfileParameter", p).await?;
        }
        let video = call("GetVideoSettings", Value::Null).await?;
        let fps_change = video["fpsNumerator"] != settings.fps || video["fpsDenominator"] != 1;
        let outputs = call("GetOutputList", Value::Null).await?;
        let output = outputs["outputs"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|v| v["outputKind"] == "replay_buffer")
            .and_then(|v| v["outputName"].as_str());
        let duration_change = if let Some(name) = output {
            let saved = call("GetProfileParameter", param("RecRBTime")).await?;
            let live = call("GetOutputSettings", json!({"outputName":name})).await?;
            saved["parameterValue"]
                .as_str()
                .and_then(|v| v.parse::<u32>().ok())
                != Some(settings.seconds)
                || live["outputSettings"]["max_time_sec"] != settings.seconds
        } else {
            false
        };
        if !fps_change && !duration_change {
            return Ok(output.is_some());
        }
        let mut resume = Vec::new();
        let update = async {
            for (needed, status, stop, start) in [
                (
                    output.is_some(),
                    "GetReplayBufferStatus",
                    "StopReplayBuffer",
                    "StartReplayBuffer",
                ),
                (fps_change, "GetRecordStatus", "StopRecord", "StartRecord"),
                (fps_change, "GetStreamStatus", "StopStream", "StartStream"),
            ] {
                if needed && call(status, Value::Null).await?["outputActive"] == true {
                    call(stop, Value::Null).await?;
                    resume.push((status, start));
                }
            }
            // OBS acknowledges a stop before its output has necessarily drained.
            for (status, _) in &resume {
                let deadline = Instant::now() + Duration::from_secs(5);
                while call(status, Value::Null).await?["outputActive"] == true {
                    if Instant::now() >= deadline {
                        return Err(format!("{status}: output is still active"));
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
            if fps_change {
                call(
                    "SetVideoSettings",
                    json!({"fpsNumerator":settings.fps,"fpsDenominator":1}),
                )
                .await?;
            }
            if duration_change {
                let mut p = param("RecRBTime");
                p["parameterValue"] = json!(settings.seconds.to_string());
                call("SetProfileParameter", p).await?;
                call(
                    "SetOutputSettings",
                    json!({"outputName":output,"outputSettings":{"max_time_sec":settings.seconds}}),
                )
                .await?;
                let verify = call("GetOutputSettings", json!({"outputName":output})).await?;
                let profile = call("GetProfileParameter", param("RecRBTime")).await?;
                if verify["outputSettings"]["max_time_sec"] != settings.seconds
                    || profile["parameterValue"]
                        .as_str()
                        .and_then(|s| s.parse().ok())
                        != Some(settings.seconds)
                {
                    return Err("OBS did not retain replay duration".into());
                }
            }
            Ok(())
        }
        .await;
        let mut errors: Vec<_> = update.err().into_iter().collect();
        for (_, start) in resume.into_iter().rev() {
            if let Err(e) = call(start, Value::Null).await {
                errors.push(e);
            }
        }
        if errors.is_empty() {
            Ok(output.is_some())
        } else {
            Err(errors.join(", "))
        }
    }
    async fn disable_desktop_audio(&self, id: &str) -> Result<(), String> {
        let inputs = self.policy_call(id, "GetInputList", Value::Null).await?;
        let input = inputs["inputs"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|v| {
                text(v, "inputName").to_lowercase().contains("desktop")
                    || matches!(
                        text(v, "inputKind"),
                        "wasapi_output_capture"
                            | "pulse_output_capture"
                            | "pulse_audio_output_capture"
                            | "coreaudio_output_capture"
                    )
            })
            .ok_or("Desktop audio input not found")?;
        self.policy_call(id,"SetInputAudioTracks",json!({"inputName":input["inputName"],"inputAudioTracks":{"1":false,"2":false,"3":false,"4":false,"5":false,"6":false}})).await?;
        Ok(())
    }
}
