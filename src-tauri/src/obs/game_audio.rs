use crate::{obs::Obs, text_intake::hotkeys::Hotkeys};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use windows::{
    core::Interface,
    Win32::{Media::Audio::*, System::Com::*},
};

#[derive(Clone, Copy, Default)]
pub(super) struct Preferences {
    minimize: bool,
    covered: bool,
    delay: Duration,
}
impl Preferences {
    pub(super) fn from_profile(profile: &Value) -> Self {
        let settings = &profile["advanced"];
        Self {
            minimize: settings["mute_game_on_minimize"] == true,
            covered: settings["mute_game_on_background"] == true,
            delay: Duration::from_secs(
                settings["mute_game_on_background_delay_seconds"]
                    .as_i64()
                    .unwrap_or(5)
                    .clamp(0, 300) as u64,
            ),
        }
    }
}

#[derive(Default)]
pub(super) struct Policy {
    target: Option<(u64, u32)>,
    covered_since: Option<Instant>,
    latched: bool,
    minimized: bool,
}
impl Policy {
    pub(super) fn desired(
        &mut self,
        target: Option<(u64, u32)>,
        state: &str,
        prefs: Preferences,
        now: Instant,
    ) -> Option<u32> {
        let was_minimized = target == self.target && self.minimized;
        self.minimized = target.is_some() && prefs.minimize && state == "minimized";
        if target != self.target
            || !prefs.covered
            || matches!(state, "active" | "closed" | "unknown")
        {
            self.covered_since = None;
            self.latched = false;
        }
        self.target = target;
        let (_, pid) = target?;
        if prefs.covered && state == "obscured" {
            self.latched |= was_minimized
                || now.duration_since(*self.covered_since.get_or_insert(now)) >= prefs.delay;
        } else {
            self.covered_since = None;
        }
        (self.latched || self.minimized).then_some(pid)
    }
}

struct Com;
impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

// Each session has its own mute bit. Remember exactly which sessions GSM
// changed, including changes made before a later SetMute error.
fn visit_sessions(
    pid: u32,
    mut visit: impl FnMut(String, ISimpleAudioVolume) -> windows::core::Result<()>,
) -> windows::core::Result<()> {
    unsafe {
        let init = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _com = if init.is_ok() {
            Some(Com)
        } else if init == windows::Win32::Foundation::RPC_E_CHANGED_MODE {
            None
        } else {
            init.ok()?;
            None
        };
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        let mut result = Ok(());
        for i in 0..devices.GetCount()? {
            let endpoint = || -> windows::core::Result<_> {
                let manager: IAudioSessionManager2 = devices.Item(i)?.Activate(CLSCTX_ALL, None)?;
                let list = manager.GetSessionEnumerator()?;
                Ok((list.GetCount()?, list))
            };
            let (count, list) = match endpoint() {
                Ok(entry) => entry,
                Err(e) => {
                    result = Err(e);
                    continue;
                }
            };
            for j in 0..count {
                // A session can disappear during enumeration. Other endpoints
                // and other sessions of this game still need to be updated.
                let Ok(session) = list
                    .GetSession(j)
                    .and_then(|s| s.cast::<IAudioSessionControl2>())
                else {
                    continue;
                };
                if session.GetProcessId().ok() == Some(pid) {
                    let update = || -> windows::core::Result<_> {
                        let name = session.GetSessionInstanceIdentifier()?;
                        let id = name.to_string();
                        CoTaskMemFree(Some(name.as_ptr().cast()));
                        Ok((id?, session.cast()?))
                    };
                    if let Err(e) = update().and_then(|(id, volume)| visit(id, volume)) {
                        result = Err(e);
                    }
                }
            }
        }
        result
    }
}

#[derive(Default)]
pub(super) struct Audio {
    automatic: Option<u32>,
    manual: HashSet<u32>,
    changed: HashMap<u32, HashSet<String>>,
    stopped: bool,
}
impl Audio {
    fn apply(&mut self, pid: u32) -> windows::core::Result<()> {
        let mute = self.automatic == Some(pid) || self.manual.contains(&pid);
        if !mute && !self.changed.contains_key(&pid) {
            return Ok(());
        }
        let owned = self.changed.entry(pid).or_default();
        visit_sessions(pid, |id, volume| {
            update_session(
                owned,
                id,
                mute,
                || unsafe { Ok(volume.GetMute()?.as_bool()) },
                |value| unsafe { volume.SetMute(value, std::ptr::null()) },
            )
        })?;
        if !mute || owned.is_empty() {
            self.changed.remove(&pid);
        }
        Ok(())
    }

    fn sync(&mut self, wanted: Option<u32>) -> windows::core::Result<()> {
        if self.stopped {
            return Ok(());
        }
        self.automatic = wanted;
        let obsolete: Vec<_> = self
            .changed
            .keys()
            .copied()
            .filter(|pid| Some(*pid) != wanted && !self.manual.contains(pid))
            .collect();
        let mut result = Ok(());
        for pid in obsolete.into_iter().chain(wanted) {
            if let Err(e) = self.apply(pid) {
                result = Err(e);
            }
        }
        result
    }
}

fn update_session(
    owned: &mut HashSet<String>,
    id: String,
    mute: bool,
    is_muted: impl FnOnce() -> windows::core::Result<bool>,
    set_mute: impl FnOnce(bool) -> windows::core::Result<()>,
) -> windows::core::Result<()> {
    if mute && !is_muted()? {
        set_mute(true)?;
        owned.insert(id);
    } else if !mute && owned.contains(&id) {
        set_mute(false)?;
        owned.remove(&id);
    }
    Ok(())
}

#[derive(Default)]
pub(super) struct Monitor {
    pub(super) policy: Policy,
    target: Option<u32>,
    retry_at: Option<Instant>,
}

impl Monitor {
    pub(super) async fn update(&mut self, app: &AppHandle, wanted: Option<u32>) {
        if self.target == wanted && self.retry_at.is_none_or(|at| Instant::now() < at) {
            return;
        }
        self.target = wanted;
        let obs = app.state::<Obs>().inner().clone();
        let result =
            tauri::async_runtime::spawn_blocking(move || obs.0.audio.lock().unwrap().sync(wanted))
                .await;
        let retry = !matches!(result, Ok(Ok(())));
        if retry {
            crate::desktop_log::warn(
                app,
                "game audio",
                format!("Could not update captured game mute: {result:?}"),
            );
        }
        // Newly opened audio streams can appear while the game stays minimized.
        self.retry_at =
            (wanted.is_some() || retry).then(|| Instant::now() + Duration::from_secs(1));
    }
}

pub(crate) fn toggle(app: &AppHandle) -> Result<(), String> {
    let obs = app.state::<Obs>();
    let game = obs.game_session();
    let pid = game["target_pid"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 1 && *n != std::process::id())
        .ok_or("No captured game process")?;
    let mut audio = obs.0.audio.lock().unwrap();
    if audio.stopped {
        return Ok(());
    }
    if !audio.manual.remove(&pid) {
        audio.manual.insert(pid);
    }
    audio.apply(pid).map_err(|e| e.to_string())
}

pub(crate) fn focus(app: &AppHandle, pid: u32) {
    if !app.state::<Hotkeys>().unmute_on_focus() {
        return;
    }
    let obs = app.state::<Obs>();
    if obs.game_session()["target_pid"] != pid || !obs.0.audio.lock().unwrap().manual.remove(&pid) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let obs = app.state::<Obs>();
        let mut audio = obs.0.audio.lock().unwrap();
        // Recheck both mute owners under the lock before touching the mixer.
        if let Err(e) = audio.apply(pid) {
            crate::desktop_log::warn(&app, "game audio", e.to_string());
        }
    });
}

pub(crate) fn shutdown(app: &AppHandle) {
    let obs = app.state::<Obs>();
    let mut audio = obs.0.audio.lock().unwrap();
    audio.stopped = true;
    audio.automatic = None;
    audio.manual.clear();
    for pid in audio.changed.keys().copied().collect::<Vec<_>>() {
        if let Err(e) = audio.apply(pid) {
            crate::desktop_log::warn(app, "game audio", e.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_only_owned_sessions_and_retries_failed_restores() {
        use std::cell::Cell;
        let mut owned = HashSet::new();
        let audible = Cell::new(false);
        let muted = Cell::new(true);
        let mut sync = |name: &str, volume: &Cell<bool>, mute, fail| {
            update_session(
                &mut owned,
                name.into(),
                mute,
                || Ok(volume.get()),
                |value| {
                    if fail {
                        return Err(windows::Win32::Foundation::E_FAIL.into());
                    }
                    volume.set(value);
                    Ok(())
                },
            )
        };
        sync("audible", &audible, true, false).unwrap();
        sync("muted", &muted, true, false).unwrap();
        assert!(audible.get());
        assert!(sync("audible", &audible, false, true).is_err());
        sync("audible", &audible, false, false).unwrap();
        sync("muted", &muted, false, false).unwrap();
        assert!(!audible.get());
        assert!(muted.get());
        assert!(owned.is_empty());
    }
    #[test]
    #[ignore = "requires a Windows render endpoint"]
    fn windows_mixer_restores_only_the_sessions_muted_by_gsm() -> windows::core::Result<()> {
        // Two silent render streams owned by this test process. One starts muted.
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            let _com = Com;
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
            let stream = || -> windows::core::Result<(IAudioClient, ISimpleAudioVolume)> {
                let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
                let format = client.GetMixFormat()?;
                let id = CoCreateGuid()?;
                let result =
                    client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 0, 0, format, Some(&id));
                CoTaskMemFree(Some(format.cast()));
                result?;
                let volume = client.GetService()?;
                Ok((client, volume))
            };
            let (_first, audible) = stream()?;
            let (_second, muted) = stream()?;
            audible.SetMute(false, std::ptr::null())?;
            muted.SetMute(true, std::ptr::null())?;
            let mut audio = Audio::default();
            let pid = std::process::id();
            audio.sync(Some(pid))?;
            assert!(audible.GetMute()?.as_bool());
            audio.manual.insert(pid);
            audio.sync(None)?;
            assert!(audible.GetMute()?.as_bool());
            audio.manual.remove(&pid);
            audio.apply(pid)?;
            assert!(!audible.GetMute()?.as_bool());
            assert!(muted.GetMute()?.as_bool());
        }
        Ok(())
    }
    #[test]
    fn mute_follows_the_captured_window_and_its_configured_delay() {
        let mut policy = Policy::default();
        let prefs = Preferences::from_profile(
            &serde_json::json!({"advanced":{"mute_game_on_minimize":true,"mute_game_on_background":true,"mute_game_on_background_delay_seconds":15}}),
        );
        let now = Instant::now();
        let game = Some((12, 42));
        let mut step = |target, state, seconds, settings| {
            policy.desired(target, state, settings, now + Duration::from_secs(seconds))
        };
        assert_eq!(step(game, "background", 0, prefs), None);
        assert_eq!(step(game, "obscured", 1, prefs), None);
        assert_eq!(step(game, "background", 15, prefs), None);
        assert_eq!(step(game, "obscured", 16, prefs), None);
        assert_eq!(step(game, "obscured", 31, prefs), Some(42));
        assert_eq!(step(game, "background", 32, prefs), Some(42));
        assert_eq!(step(game, "active", 33, prefs), None);
        assert_eq!(step(game, "minimized", 34, prefs), Some(42));
        assert_eq!(step(game, "background", 35, prefs), None);
        assert_eq!(step(game, "obscured", 36, prefs), None);
        assert_eq!(step(Some((13, 43)), "obscured", 51, prefs), None);
        assert_eq!(step(Some((13, 43)), "obscured", 67, prefs), Some(43));
        assert_eq!(
            step(Some((13, 43)), "minimized", 68, Preferences::default()),
            None
        );
    }
}
