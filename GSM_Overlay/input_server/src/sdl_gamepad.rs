//! Windows input through SDL's controller-specific HID drivers and generic joystick API.
//! WGI's generic parser can mistake Switch report counters for button bits. Keep
//! decoding in SDL, which understands both simple and full Switch input reports.
use super::{
    is_device_blacklisted, normalize_stick, raw_gamepad, send_broadcast, should_send_axis,
    ButtonCode, Config, GamepadState, SharedDeviceBlacklist, SharedStates,
};
use sdl2::{
    controller::{Axis, Button, GameController},
    event::Event,
    joystick::Joystick,
};
use serde_json::json;
use std::{
    collections::HashMap,
    thread,
    time::{Duration, Instant},
};
use tokio::sync::broadcast;
use tracing::{error, info, warn};

enum Handle {
    Controller(GameController),
    Joystick(Joystick),
}

struct Device {
    handle: Handle,
    name: String,
}

impl Device {
    fn open(
        index: u32,
        controllers: &sdl2::GameControllerSubsystem,
        joysticks: &sdl2::JoystickSubsystem,
    ) -> Result<Self, String> {
        let handle = if controllers.is_game_controller(index) {
            Handle::Controller(controllers.open(index).map_err(|e| e.to_string())?)
        } else {
            Handle::Joystick(joysticks.open(index).map_err(|e| e.to_string())?)
        };
        let name = match &handle {
            Handle::Controller(controller) => controller.name(),
            Handle::Joystick(joystick) => joystick.name(),
        };
        Ok(Self { handle, name })
    }

    fn id(&self) -> usize {
        match &self.handle {
            Handle::Controller(controller) => controller.instance_id() as usize,
            Handle::Joystick(joystick) => joystick.instance_id() as usize,
        }
    }

    fn mapped(&self) -> bool {
        matches!(self.handle, Handle::Controller(_))
    }
}

fn configure_hints() {
    for (name, value) in [
        ("SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS", "1"),
        ("SDL_JOYSTICK_HIDAPI", "1"),
        ("SDL_JOYSTICK_HIDAPI_SWITCH", "1"),
        // This service initializes SDL without a video window. SDL's Raw Input
        // and Xbox HID drivers can claim an XInput device first and leave it
        // listed but idle; let the Windows XInput backend poll Xbox pads.
        ("SDL_JOYSTICK_RAWINPUT", "0"),
        ("SDL_JOYSTICK_HIDAPI_XBOX", "0"),
        ("SDL_JOYSTICK_HIDAPI_XBOX_360", "0"),
        ("SDL_JOYSTICK_HIDAPI_XBOX_360_WIRELESS", "0"),
        ("SDL_JOYSTICK_HIDAPI_XBOX_ONE", "0"),
        ("SDL_GAMECONTROLLER_USE_BUTTON_LABELS", "0"),
    ] {
        sdl2::hint::set_with_priority(name, value, &sdl2::hint::Hint::Override);
    }
}

pub(super) fn input_thread(
    tx: broadcast::Sender<String>,
    states: &'static SharedStates,
    blacklist: SharedDeviceBlacklist,
    cfg: Config,
) {
    if let Err(error) = run(tx, states, blacklist, cfg) {
        error!("SDL gamepad input failed: {error}");
    }
}

fn run(
    tx: broadcast::Sender<String>,
    states: &SharedStates,
    blacklist: SharedDeviceBlacklist,
    cfg: Config,
) -> Result<(), String> {
    configure_hints();
    let sdl = sdl2::init()?;
    let controllers = sdl.game_controller()?;
    let joysticks = sdl.joystick()?;
    controllers.set_event_state(true);
    joysticks.set_event_state(true);
    let mut pump = sdl.event_pump()?;
    let mut devices = HashMap::new();
    let register = |index, devices: &mut HashMap<usize, Device>| {
        match Device::open(index, &controllers, &joysticks) {
            Ok(device) => {
                let id = device.id();
                // SDL emits both joystick and controller connection events. Open
                // once, but allow a previously raw device to gain a mapping.
                if devices
                    .get(&id)
                    .is_some_and(|old| old.mapped() || !device.mapped())
                {
                    return;
                }
                if !is_device_blacklisted(&blacklist, &device.name) {
                    states
                        .blocking_lock()
                        .insert(id, GamepadState::new(device.name.clone()));
                    send_broadcast(
                        &tx,
                        json!({"type": "gamepad_connected", "device": device.name}).to_string(),
                        "gamepad_connected(sdl)",
                    );
                    info!(
                        "gamepad connected (SDL, mapped={}): {}",
                        device.mapped(),
                        device.name
                    );
                }
                devices.insert(id, device);
            }
            Err(error) => warn!("cannot open SDL gamepad {index}: {error}"),
        }
    };
    for index in 0..joysticks.num_joysticks()? {
        register(index, &mut devices);
    }
    info!("SDL gamepad input initialized; background input and Switch HID decoding enabled");
    loop {
        for event in pump.poll_iter() {
            match event {
                Event::JoyDeviceAdded { which, .. }
                | Event::ControllerDeviceAdded { which, .. } => {
                    register(which, &mut devices);
                }
                Event::JoyDeviceRemoved { which, .. }
                | Event::ControllerDeviceRemoved { which, .. } => {
                    if let Some(device) = devices.remove(&(which as usize)) {
                        if states.blocking_lock().remove(&(which as usize)).is_some() {
                            send_broadcast(
                                &tx,
                                json!({"type": "gamepad_disconnected", "device": device.name})
                                    .to_string(),
                                "gamepad_disconnected(sdl)",
                            );
                        }
                    }
                }
                _ => {
                    let Some(id) = event_device(&event) else {
                        continue;
                    };
                    let Some(device) = devices.get(&id) else {
                        continue;
                    };
                    if is_device_blacklisted(&blacklist, &device.name) {
                        continue;
                    }
                    let outgoing = {
                        let mut states = states.blocking_lock();
                        let state = states
                            .entry(id)
                            .or_insert_with(|| GamepadState::new(device.name.clone()));
                        translate_event(state, device.mapped(), &event, &cfg, Instant::now())
                    };
                    for payload in outgoing {
                        send_broadcast(&tx, payload, "gamepad(sdl)");
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(4));
    }
}

fn event_device(event: &Event) -> Option<usize> {
    match event {
        Event::ControllerButtonDown { which, .. }
        | Event::ControllerButtonUp { which, .. }
        | Event::ControllerAxisMotion { which, .. }
        | Event::JoyButtonDown { which, .. }
        | Event::JoyButtonUp { which, .. }
        | Event::JoyAxisMotion { which, .. }
        | Event::JoyHatMotion { which, .. } => Some(*which as usize),
        _ => None,
    }
}

fn button_id(button: Button) -> u64 {
    let standard = match button {
        Button::A => ButtonCode::A,
        Button::B => ButtonCode::B,
        Button::X => ButtonCode::X,
        Button::Y => ButtonCode::Y,
        Button::Back => ButtonCode::BACK,
        Button::Start => ButtonCode::START,
        Button::Guide => ButtonCode::GUIDE,
        Button::LeftStick => ButtonCode::LS,
        Button::RightStick => ButtonCode::RS,
        Button::LeftShoulder => ButtonCode::LB,
        Button::RightShoulder => ButtonCode::RB,
        Button::DPadUp => ButtonCode::DPAD_UP,
        Button::DPadDown => ButtonCode::DPAD_DOWN,
        Button::DPadLeft => ButtonCode::DPAD_LEFT,
        Button::DPadRight => ButtonCode::DPAD_RIGHT,
        // Capture/share, paddles and touchpad remain bindable without reusing 0..16.
        other => return 17 + (other as u64 - Button::Misc1 as u64),
    };
    standard as u64
}

fn signed_axis(value: i16) -> f32 {
    f32::from(value) / if value < 0 { 32768.0 } else { 32767.0 }
}

fn button_event(
    state: &mut GamepadState,
    button: u64,
    pressed: bool,
    name: String,
) -> Option<String> {
    if state.buttons.get(&button).copied().unwrap_or(false) == pressed {
        return None;
    }
    state.buttons.insert(button, pressed);
    Some(json!({"type": "button", "device": state.device_name, "button": button, "pressed": pressed, "name": name}).to_string())
}

fn translate_event(
    state: &mut GamepadState,
    mapped: bool,
    event: &Event,
    cfg: &Config,
    now: Instant,
) -> Vec<String> {
    let mut outgoing = Vec::new();
    match *event {
        Event::ControllerButtonDown { button, .. } | Event::ControllerButtonUp { button, .. }
            if mapped =>
        {
            if let Some(event) = button_event(
                state,
                button_id(button),
                matches!(event, Event::ControllerButtonDown { .. }),
                format!("{button:?}"),
            ) {
                outgoing.push(event);
            }
        }
        Event::ControllerAxisMotion { axis, value, .. } if mapped => {
            let (name, direction) = match axis {
                Axis::LeftX => ("left_x", 1.0),
                Axis::LeftY => ("left_y", -1.0),
                Axis::RightX => ("right_x", 1.0),
                Axis::RightY => ("right_y", -1.0),
                Axis::TriggerLeft => ("lt", 1.0),
                Axis::TriggerRight => ("rt", 1.0),
            };
            let trigger = matches!(axis, Axis::TriggerLeft | Axis::TriggerRight);
            let value = if trigger {
                f32::from(value.max(0)) / 32767.0
            } else {
                normalize_stick(signed_axis(value) * direction, cfg.deadzone)
            };
            state.axes.insert(name.into(), value);
            if should_send_axis(state, name, value, cfg, now) {
                outgoing.push(json!({"type": "axis", "device": state.device_name, "axis": name, "value": value}).to_string());
            }
            if trigger {
                let button = if axis == Axis::TriggerLeft {
                    ButtonCode::LT
                } else {
                    ButtonCode::RT
                };
                if let Some(event) = button_event(
                    state,
                    button as u64,
                    value > cfg.trigger_threshold,
                    format!("{button:?}"),
                ) {
                    outgoing.push(event);
                }
            }
        }
        Event::JoyButtonDown { button_idx, .. } | Event::JoyButtonUp { button_idx, .. }
            if !mapped =>
        {
            if let Some(event) = raw_gamepad::button_event(
                state,
                u32::from(button_idx),
                matches!(event, Event::JoyButtonDown { .. }),
            ) {
                outgoing.push(event);
            }
        }
        Event::JoyAxisMotion {
            axis_idx, value, ..
        } if !mapped => {
            outgoing.extend(raw_gamepad::axis_events(
                state,
                0x10000 + u32::from(axis_idx),
                signed_axis(value),
                cfg,
                now,
            ));
        }
        Event::JoyHatMotion {
            hat_idx,
            state: hat,
            ..
        } if !mapped => {
            let bits = hat.to_raw();
            let x = f32::from((bits & 2 != 0) as u8) - f32::from((bits & 8 != 0) as u8);
            let y = f32::from((bits & 4 != 0) as u8) - f32::from((bits & 1 != 0) as u8);
            let code = 0x20000 + u32::from(hat_idx) * 2;
            outgoing.extend(raw_gamepad::axis_events(state, code, x, cfg, now));
            outgoing.extend(raw_gamepad::axis_events(state, code + 1, y, cfg, now));
        }
        // Mapped devices emit both Controller* and Joy* events. Never forward
        // their Joy* stream as additional buttons or axes.
        _ => {}
    }
    outgoing
}

#[cfg(test)]
mod tests {
    use super::*;
    use sdl2::joystick::HatState;
    use serde_json::Value;

    fn apply(state: &mut GamepadState, mapped: bool, event: Event) -> Vec<Value> {
        translate_event(state, mapped, &event, &Config::default(), Instant::now())
            .iter()
            .map(|event| serde_json::from_str(event).unwrap())
            .collect()
    }

    fn button_edges(events: &[Value]) -> Vec<(u64, bool)> {
        events
            .iter()
            .filter(|event| event["type"] == "button")
            .map(|event| {
                (
                    event["button"].as_u64().unwrap(),
                    event["pressed"].as_bool().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn headless_server_keeps_xbox_on_xinput() {
        configure_hints();
        // SDL checks these hints before joystick initialization. Raw Input can
        // claim an Xbox pad ahead of the native XInput backend; the HID Xbox
        // driver has the same priority issue for some Windows devices.
        assert_eq!(
            sdl2::hint::get("SDL_JOYSTICK_RAWINPUT").as_deref(),
            Some("0")
        );
        assert_eq!(
            sdl2::hint::get("SDL_JOYSTICK_HIDAPI_XBOX").as_deref(),
            Some("0")
        );
        assert_eq!(
            sdl2::hint::get("SDL_JOYSTICK_HIDAPI_XBOX_360").as_deref(),
            Some("0")
        );
        assert_eq!(
            sdl2::hint::get("SDL_JOYSTICK_HIDAPI_XBOX_360_WIRELESS").as_deref(),
            Some("0")
        );
        assert_eq!(
            sdl2::hint::get("SDL_JOYSTICK_HIDAPI_XBOX_ONE").as_deref(),
            Some("0")
        );
        assert_eq!(
            sdl2::hint::get("SDL_JOYSTICK_HIDAPI_SWITCH").as_deref(),
            Some("1")
        );
    }

    #[test]
    fn sdl_virtual_devices_stay_idle_and_deliver_single_button_edges() {
        configure_hints();
        let sdl = sdl2::init().unwrap();
        let controllers = sdl.game_controller().unwrap();
        let joysticks = sdl.joystick().unwrap();
        controllers.set_event_state(true);
        joysticks.set_event_state(true);
        let mut pump = sdl.event_pump().unwrap();

        for (kind, mapped, expected_button) in [
            (
                sdl2::sys::SDL_JoystickType::SDL_JOYSTICK_TYPE_UNKNOWN,
                false,
                32,
            ),
            (
                sdl2::sys::SDL_JoystickType::SDL_JOYSTICK_TYPE_GAMECONTROLLER,
                true,
                0,
            ),
        ] {
            // SDL virtual devices exist only in this test process. Creating one
            // exercises discovery and native event delivery without hardware.
            let index = unsafe { sdl2::sys::SDL_JoystickAttachVirtual(kind, 6, 21, 1) };
            assert!(index >= 0, "{}", sdl2::get_error());
            let device = Device::open(index as u32, &controllers, &joysticks).unwrap();
            assert_eq!(device.mapped(), mapped);
            let mut state = GamepadState::new(device.name.clone());
            let mut poll = || {
                pump.poll_iter()
                    .filter(|event| event_device(event) == Some(device.id()))
                    .flat_map(|event| apply(&mut state, device.mapped(), event))
                    .collect::<Vec<_>>()
            };
            // Connection and repeated idle polling must never press buttons.
            for _ in 0..4 {
                assert!(button_edges(&poll()).is_empty());
            }

            // The SDL-owned pointer remains valid while `device` is open, and
            // button 0 is within this virtual device's declared 21 buttons.
            let joystick = unsafe { sdl2::sys::SDL_JoystickFromInstanceID(device.id() as i32) };
            assert!(!joystick.is_null());
            assert_eq!(
                unsafe { sdl2::sys::SDL_JoystickSetVirtualButton(joystick, 0, 1) },
                0
            );
            assert_eq!(button_edges(&poll()), [(expected_button, true)]);
            assert!(button_edges(&poll()).is_empty());
            assert_eq!(
                unsafe { sdl2::sys::SDL_JoystickSetVirtualButton(joystick, 0, 0) },
                0
            );
            assert_eq!(button_edges(&poll()), [(expected_button, false)]);
            assert!(button_edges(&poll()).is_empty());

            drop(device);
            assert_eq!(unsafe { sdl2::sys::SDL_JoystickDetachVirtual(index) }, 0);
        }
    }

    #[test]
    fn mapped_controller_ignores_duplicate_joystick_reports() {
        let mut state = GamepadState::new("Nintendo Switch Pro Controller".into());
        for button_idx in 0..16 {
            assert!(apply(
                &mut state,
                true,
                Event::JoyButtonDown {
                    timestamp: 0,
                    which: 1,
                    button_idx
                }
            )
            .is_empty());
        }
        let press = Event::ControllerButtonDown {
            timestamp: 0,
            which: 1,
            button: Button::A,
        };
        assert_eq!(
            button_edges(&apply(&mut state, true, press.clone())),
            [(0, true)]
        );
        assert!(apply(&mut state, true, press).is_empty());
        assert_eq!(
            button_edges(&apply(
                &mut state,
                true,
                Event::ControllerButtonUp {
                    timestamp: 0,
                    which: 1,
                    button: Button::A
                }
            )),
            [(0, false)]
        );
    }

    #[test]
    fn mapped_axes_keep_gsm_direction_and_trigger_ranges() {
        let mut state = GamepadState::new("pad".into());
        let axis = |axis, value| Event::ControllerAxisMotion {
            timestamp: 0,
            which: 1,
            axis,
            value,
        };
        apply(&mut state, true, axis(Axis::LeftY, i16::MIN));
        assert_eq!(state.axes["left_y"], 1.0);
        apply(&mut state, true, axis(Axis::RightY, i16::MAX));
        assert_eq!(state.axes["right_y"], -1.0);
        assert!(button_edges(&apply(&mut state, true, axis(Axis::TriggerLeft, 0))).is_empty());
        assert_eq!(
            button_edges(&apply(&mut state, true, axis(Axis::TriggerLeft, i16::MAX))),
            [(6, true)]
        );
        assert_eq!(
            button_edges(&apply(&mut state, true, axis(Axis::TriggerLeft, 0))),
            [(6, false)]
        );
    }

    #[test]
    fn unmapped_joystick_buttons_axes_and_hats_remain_bindable() {
        let mut state = GamepadState::new("Generic joystick".into());
        assert_eq!(
            button_edges(&apply(
                &mut state,
                false,
                Event::JoyButtonDown {
                    timestamp: 0,
                    which: 1,
                    button_idx: 18
                }
            )),
            [(86, true)]
        );
        assert_eq!(
            button_edges(&apply(
                &mut state,
                false,
                Event::JoyButtonUp {
                    timestamp: 0,
                    which: 1,
                    button_idx: 18
                }
            )),
            [(86, false)]
        );
        assert_eq!(
            button_edges(&apply(
                &mut state,
                false,
                Event::JoyAxisMotion {
                    timestamp: 0,
                    which: 1,
                    axis_idx: 0,
                    value: i16::MIN
                }
            )),
            [(196641, true)]
        );
        let hat = |state| Event::JoyHatMotion {
            timestamp: 0,
            which: 1,
            hat_idx: 0,
            state,
        };
        let edges = button_edges(&apply(&mut state, false, hat(HatState::RightUp)));
        assert_eq!(edges, [(393250, true), (393252, true)]);
        assert_eq!(
            button_edges(&apply(&mut state, false, hat(HatState::Centered))),
            [(393250, false), (393252, false)]
        );
    }
}
