//! Windows listener selection. Preferences take effect when the server starts.
#[cfg(target_os = "windows")]
use super::{gilrs_input_thread, sdl_gamepad, Config, SharedDeviceBlacklist, SharedStates};
use serde_json::Value;
use std::{fs, path::PathBuf};
#[cfg(target_os = "windows")]
use tokio::sync::broadcast;
#[cfg(target_os = "windows")]
use tracing::info;
use tracing::warn;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct InputSettings {
    xinput_enabled: bool,
    dinput_enabled: bool,
}

impl Default for InputSettings {
    fn default() -> Self {
        Self {
            xinput_enabled: true,
            dinput_enabled: false,
        }
    }
}

impl InputSettings {
    fn from_overlay_settings(value: &Value) -> Self {
        Self {
            xinput_enabled: value["gamepadXinputEnabled"].as_bool().unwrap_or(true),
            dinput_enabled: value["gamepadDinputEnabled"].as_bool().unwrap_or(false),
        }
    }

    fn load() -> Self {
        // Both managed and standalone launches supply this directory. Read it
        // before opening devices, even when the overlay itself is not running.
        let path = std::env::var_os("GSM_GAMEPAD_SETTINGS_PATH")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("GSM_OVERLAY_DATA_PATH")
                    .map(|directory| PathBuf::from(directory).join("settings.json"))
            });
        let Some(path) = path else {
            return Self::default();
        };
        match fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str::<Value>(&contents) {
                Ok(value) => Self::from_overlay_settings(&value),
                Err(error) => {
                    warn!(
                        "cannot read gamepad listener settings from {}: {error}",
                        path.display()
                    );
                    Self::default()
                }
            },
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    warn!(
                        "cannot read gamepad listener settings from {}: {error}",
                        path.display()
                    );
                }
                Self::default()
            }
        }
    }

    fn windows_backend(self) -> WindowsBackend {
        if self.dinput_enabled {
            WindowsBackend::Sdl {
                xinput: self.xinput_enabled,
            }
        } else if self.xinput_enabled {
            WindowsBackend::XInput
        } else {
            WindowsBackend::Disabled
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowsBackend {
    Disabled,
    XInput,
    Sdl { xinput: bool },
}

#[cfg(target_os = "windows")]
pub(super) fn input_thread(
    tx: broadcast::Sender<String>,
    states: &'static SharedStates,
    blacklist: SharedDeviceBlacklist,
    cfg: Config,
) {
    let backend = InputSettings::load().windows_backend();
    info!("Windows gamepad listener: {backend:?}");
    // Never initialize SDL on the default path. gilrs 0.10's XInput polling
    // thread survives dropping Gilrs, so switching requires a process restart
    // to actually stop listening and avoid accumulating background pollers.
    match backend {
        WindowsBackend::Disabled => {}
        WindowsBackend::XInput => gilrs_input_thread(tx, states, blacklist, cfg),
        WindowsBackend::Sdl { xinput } => {
            sdl_gamepad::input_thread(tx, states, blacklist, cfg, xinput)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn existing_settings_default_to_legacy_xinput_only() {
        for value in [
            json!({}),
            json!({"gamepadEnabled": true}),
            json!({
                "gamepadDinputEnabled": "true", "gamepadXinputEnabled": null
            }),
        ] {
            let settings = InputSettings::from_overlay_settings(&value);
            assert_eq!(settings, InputSettings::default());
            assert_eq!(settings.windows_backend(), WindowsBackend::XInput);
        }
    }

    #[test]
    fn listeners_can_be_enabled_independently_or_both_disabled() {
        for (xinput, dinput, backend) in [
            (true, false, WindowsBackend::XInput),
            (false, false, WindowsBackend::Disabled),
            (true, true, WindowsBackend::Sdl { xinput: true }),
            (false, true, WindowsBackend::Sdl { xinput: false }),
        ] {
            let settings = InputSettings::from_overlay_settings(&json!({
                "gamepadXinputEnabled": xinput, "gamepadDinputEnabled": dinput,
                "gamepadEnabled": false, "gamepadControllerEnabled": false,
            }));
            assert_eq!(settings.windows_backend(), backend);
        }
    }
}
