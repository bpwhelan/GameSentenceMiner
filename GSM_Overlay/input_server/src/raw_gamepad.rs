//! Stable fallback bindings for controls missing from the backend's standard layout.
//! Keep the entire native code: truncating it merges unrelated buttons/hats/axes.
use super::{normalize_stick, should_send_axis, Config, GamepadState};
use serde_json::json;
use std::time::Instant;

// Reserve 0..31 for standard buttons. Each native code gets three distinct IDs:
// a button, negative axis direction, and positive axis direction. These fit
// exactly in a JavaScript Number, including when the native code is u32::MAX.
fn button_id(code: u32) -> u64 {
    32 + u64::from(code) * 3
}

fn update_button(state: &mut GamepadState, button: u64, pressed: bool) -> Option<String> {
    if state.buttons.get(&button).copied().unwrap_or(false) == pressed {
        return None;
    }
    state.buttons.insert(button, pressed);
    Some(
        json!({
            "type": "button", "device": state.device_name,
            "button": button, "pressed": pressed, "name": format!("Button {button}")
        })
        .to_string(),
    )
}

pub(super) fn button_event(state: &mut GamepadState, code: u32, pressed: bool) -> Option<String> {
    update_button(state, button_id(code), pressed)
}

pub(super) fn axis_events(
    state: &mut GamepadState,
    code: u32,
    value: f32,
    cfg: &Config,
    now: Instant,
) -> Vec<String> {
    let mut events = Vec::new();
    let value = normalize_stick(value, cfg.deadzone);
    let name = format!("raw_{code}");
    state.axes.insert(name.clone(), value);
    if should_send_axis(state, &name, value, cfg, now) {
        events.push(
            json!({"type": "axis", "device": state.device_name, "axis": name, "value": value})
                .to_string(),
        );
    }

    let directions = [
        (button_id(code) + 1, value < -cfg.trigger_threshold),
        (button_id(code) + 2, value > cfg.trigger_threshold),
    ];
    // Release before pressing the opposite direction so capture never sees a
    // spurious two-button chord when a hat jumps directly across its center.
    for pressed in [false, true] {
        for (button, down) in directions {
            if down == pressed {
                if let Some(event) = update_button(state, button, down) {
                    events.push(event);
                }
            }
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::HashSet;

    fn buttons(events: Vec<String>) -> Vec<(u64, bool)> {
        events
            .iter()
            .map(|event| serde_json::from_str::<Value>(event).unwrap())
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
    fn native_ids_do_not_collide_with_standard_buttons_or_axis_directions() {
        let mut ids: HashSet<u64> = (0..32).collect();
        for code in [0, 1, 255, 256, 65536, 131072, u32::MAX] {
            for id in button_id(code)..=button_id(code) + 2 {
                assert!(ids.insert(id));
                assert!(id < (1u64 << 53));
            }
        }
    }

    #[test]
    fn unmapped_buttons_emit_press_release_and_deduplicate_analog_events() {
        let mut state = GamepadState::new("Generic pad".into());
        let pressed = button_event(&mut state, 257, true).unwrap();
        let pressed: Value = serde_json::from_str(&pressed).unwrap();
        assert_eq!(pressed["button"], 803);
        assert_eq!(pressed["pressed"], true);
        assert_eq!(pressed["device"], "Generic pad");
        assert!(button_event(&mut state, 257, true).is_none());
        assert!(button_event(&mut state, 257, false).is_some());
        assert!(!state.buttons[&803]);
        assert!(button_event(&mut state, 257, false).is_none());
    }

    #[test]
    fn unmapped_axes_are_bindable_in_both_directions_and_release_at_center() {
        let mut state = GamepadState::new("Generic pad".into());
        let cfg = Config::default();
        let now = Instant::now();
        assert_eq!(
            buttons(axis_events(&mut state, 65536, -0.9, &cfg, now)),
            [(196641, true)]
        );
        assert_eq!(state.axes["raw_65536"], -0.9);
        assert!(buttons(axis_events(&mut state, 65536, -0.8, &cfg, now)).is_empty());
        assert_eq!(
            buttons(axis_events(&mut state, 65536, 1.0, &cfg, now)),
            [(196641, false), (196642, true)]
        );
        assert_eq!(
            buttons(axis_events(&mut state, 65536, 0.05, &cfg, now)),
            [(196642, false)]
        );
        assert_eq!(state.axes["raw_65536"], 0.0);
    }
}
