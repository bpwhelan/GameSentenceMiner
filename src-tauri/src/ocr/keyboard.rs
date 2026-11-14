//! Passive OCR bindings. These keys are never reserved through RegisterHotKey.
use serde_json::Value;
use std::collections::HashSet;

const ACTIONS: [(&str, &str); 6] = [
    ("manualOcrHotkey", "manual_ocr"),
    ("menuOcrHotkey", "menu_ocr"),
    ("areaSelectOcrHotkey", "area_select_ocr"),
    ("addAreaOcrHotkey", "add_ocr_area"),
    ("wholeWindowOcrHotkey", "whole_window_ocr"),
    ("globalPauseHotkey", "toggle_pause"),
];

struct Binding {
    key: String,
    shift: bool,
    ctrl: bool,
    alt: bool,
    meta: bool,
    action: &'static str,
}
#[derive(Default)]
pub struct Keyboard {
    bindings: Vec<Binding>,
    held: HashSet<String>,
}
impl Keyboard {
    pub fn new(settings: &Value) -> Self {
        let bindings = ACTIONS
            .iter()
            .filter_map(|(name, action)| {
                let raw = settings[*name].as_str()?;
                let normalized = if raw == " " {
                    "Space".to_owned()
                } else if let Some(prefix) = raw.strip_suffix("+ ") {
                    format!("{prefix}+Space")
                } else {
                    raw.to_owned()
                };
                let value = normalized.trim();
                let mut shift = false;
                let mut ctrl = false;
                let mut alt = false;
                let mut meta = false;
                let mut key = None;
                let plus = value.ends_with('+');
                let parts = if plus {
                    &value[..value.len() - 1]
                } else {
                    value
                };
                for token in parts.split('+').filter(|s| !s.trim().is_empty()) {
                    match token.trim().to_ascii_lowercase().as_str() {
                        "shift" => shift = true,
                        "ctrl" | "control" => ctrl = true,
                        "alt" | "option" => alt = true,
                        "cmd" | "command" | "meta" | "super" | "win" | "windows" => meta = true,
                        "commandorcontrol" | "cmdorctrl" => {
                            if cfg!(target_os = "macos") {
                                meta = true;
                            } else {
                                ctrl = true;
                            }
                        }
                        _ if key.is_none() => key = Some(token.trim()),
                        _ => return None,
                    }
                }
                let token = if plus {
                    if key.is_some() {
                        return None;
                    }
                    "+"
                } else {
                    key?
                };
                let (key, implicit_shift) = key_code(token)?;
                Some(Binding {
                    key,
                    shift: shift || implicit_shift,
                    ctrl,
                    alt,
                    meta,
                    action,
                })
            })
            .collect();
        Self {
            bindings,
            held: HashSet::new(),
        }
    }
    pub fn keys(&self) -> Vec<String> {
        let mut keys: Vec<_> = self.bindings.iter().map(|b| b.key.clone()).collect();
        keys.sort();
        keys.dedup();
        keys
    }
    pub fn receive(&mut self, event: &Value, visible: bool) -> Vec<&'static str> {
        if event["type"] != "keyboard_event" {
            return vec![];
        }
        let Some(key) = event["key"].as_str() else {
            return vec![];
        };
        if event["pressed"] != true {
            self.held.remove(key);
            return vec![];
        }
        if !self.held.insert(key.into()) || !visible {
            return vec![];
        }
        let modifiers = &event["modifiers"];
        // Exact modifiers: plain A must not also trigger for Ctrl+A/AltGr+A.
        self.bindings
            .iter()
            .filter(|b| {
                b.key == key
                    && b.shift == (modifiers["shift"] == true)
                    && b.ctrl == (modifiers["ctrl"] == true)
                    && b.alt == (modifiers["alt"] == true)
                    && b.meta == (modifiers["meta"] == true)
            })
            .map(|b| b.action)
            .collect()
    }
}

fn key_code(token: &str) -> Option<(String, bool)> {
    let token = token.to_ascii_uppercase();
    if token.len() == 1 && token.as_bytes()[0].is_ascii_alphabetic() {
        return Some((format!("Key{token}"), false));
    }
    if token.len() == 1 && token.as_bytes()[0].is_ascii_digit() {
        return Some((format!("Digit{token}"), false));
    }
    if token
        .strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=24).contains(&n))
    {
        return Some((token, false));
    }
    let (key, shift) = match token.as_str() {
        "`" | "BACKQUOTE" | "GRAVE" => ("Backquote", false),
        "~" | "TILDE" => ("Backquote", true),
        " " | "SPACE" => ("Space", false),
        "ENTER" | "RETURN" => ("Enter", false),
        "ESC" | "ESCAPE" => ("Escape", false),
        "TAB" => ("Tab", false),
        "BACKSPACE" => ("Backspace", false),
        "DELETE" => ("Delete", false),
        "INSERT" => ("Insert", false),
        "HOME" => ("Home", false),
        "END" => ("End", false),
        "PAGEUP" => ("PageUp", false),
        "PAGEDOWN" => ("PageDown", false),
        "UP" | "ARROWUP" => ("ArrowUp", false),
        "DOWN" | "ARROWDOWN" => ("ArrowDown", false),
        "LEFT" | "ARROWLEFT" => ("ArrowLeft", false),
        "RIGHT" | "ARROWRIGHT" => ("ArrowRight", false),
        "-" => ("Minus", false),
        "_" => ("Minus", true),
        "=" => ("Equal", false),
        "+" => ("Equal", true),
        "[" => ("BracketLeft", false),
        "{" => ("BracketLeft", true),
        "]" => ("BracketRight", false),
        "}" => ("BracketRight", true),
        ";" => ("Semicolon", false),
        ":" => ("Semicolon", true),
        "'" => ("Quote", false),
        "\"" => ("Quote", true),
        "," => ("Comma", false),
        "<" => ("Comma", true),
        "." => ("Period", false),
        ">" => ("Period", true),
        "/" => ("Slash", false),
        "?" => ("Slash", true),
        "\\" => ("Backslash", false),
        "|" => ("Backslash", true),
        "!" => ("Digit1", true),
        "@" => ("Digit2", true),
        "#" => ("Digit3", true),
        "$" => ("Digit4", true),
        "%" => ("Digit5", true),
        "^" => ("Digit6", true),
        "&" => ("Digit7", true),
        "*" => ("Digit8", true),
        "(" => ("Digit9", true),
        ")" => ("Digit0", true),
        "CAPSLOCK" => ("CapsLock", false),
        _ => return None,
    };
    Some((key.into(), shift))
}

pub fn target_visible(target: Option<u64>) -> bool {
    let Some(target) = target.filter(|n| *n != 0) else {
        return false;
    };
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::HWND,
            Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
            UI::WindowsAndMessaging::{IsIconic, IsWindowVisible},
        };
        let hwnd = HWND(target as usize as *mut _);
        let mut cloaked: u32 = 0;
        // Shown windows remain eligible behind other apps. Minimized, hidden,
        // destroyed and DWM-cloaked windows (e.g. another desktop) do not.
        unsafe {
            IsWindowVisible(hwnd).as_bool()
                && !IsIconic(hwnd).as_bool()
                && DwmGetWindowAttribute(
                    hwnd,
                    DWMWA_CLOAKED,
                    (&mut cloaked as *mut u32).cast(),
                    std::mem::size_of::<u32>() as u32,
                )
                .is_ok()
                && cloaked == 0
        }
    }
    #[cfg(not(windows))]
    {
        xcap::Window::all().is_ok_and(|windows| {
            windows.iter().any(|w| {
                w.id().ok().map(u64::from) == Some(target) && !w.is_minimized().unwrap_or(true)
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn tilde_is_passive_scoped_shift_aware_and_edge_triggered() {
        let mut keyboard = Keyboard::new(
            &json!({"manualOcrHotkey":"`","menuOcrHotkey":"Shift+~","globalPauseHotkey":"Ctrl+P"}),
        );
        assert_eq!(keyboard.keys(), vec!["Backquote", "KeyP"]);
        let mut event =
            json!({"type":"keyboard_event","key":"Backquote","pressed":true,"modifiers":{}});
        assert!(keyboard.receive(&event, false).is_empty());
        assert!(keyboard.receive(&event, true).is_empty()); // held while restoring the game
        event["pressed"] = json!(false);
        keyboard.receive(&event, true);
        event["pressed"] = json!(true);
        assert_eq!(keyboard.receive(&event, true), vec!["manual_ocr"]);
        assert!(keyboard.receive(&event, true).is_empty());
        event["pressed"] = json!(false);
        keyboard.receive(&event, true);
        event["pressed"] = json!(true);
        event["modifiers"]["shift"] = json!(true);
        assert_eq!(keyboard.receive(&event, true), vec!["menu_ocr"]);
        event["pressed"] = json!(false);
        keyboard.receive(&event, true);
        event["pressed"] = json!(true);
        event["modifiers"]["ctrl"] = json!(true);
        assert!(keyboard.receive(&event, true).is_empty());
    }
    #[test]
    fn modified_bindings_are_passive_exact_and_visibility_gated() {
        for (key, modifier) in [
            ("Ctrl+A", "ctrl"),
            ("Control+A", "ctrl"),
            ("Alt+A", "alt"),
            ("Option+A", "alt"),
            ("Cmd+A", "meta"),
            ("Super+A", "meta"),
            ("Win+A", "meta"),
            ("Meta+A", "meta"),
            (
                "CommandOrControl+A",
                if cfg!(target_os = "macos") {
                    "meta"
                } else {
                    "ctrl"
                },
            ),
        ] {
            let mut keyboard = Keyboard::new(&json!({"manualOcrHotkey":key}));
            assert_eq!(keyboard.keys(), vec!["KeyA"], "{key}");
            let mut event = json!({"type":"keyboard_event","key":"KeyA","pressed":true,"modifiers":{modifier:true}});
            assert!(keyboard.receive(&event, false).is_empty());
            assert!(keyboard.receive(&event, true).is_empty()); // no trigger on restore while held
            event["pressed"] = json!(false);
            keyboard.receive(&event, true);
            event["pressed"] = json!(true);
            assert_eq!(keyboard.receive(&event, true), vec!["manual_ocr"], "{key}");
            event["pressed"] = json!(false);
            keyboard.receive(&event, true);
            event["pressed"] = json!(true);
            event["modifiers"]["shift"] = json!(true);
            assert!(keyboard.receive(&event, true).is_empty());
        }
        assert_eq!(
            Keyboard::new(&json!({"manualOcrHotkey":"Shift++"})).keys(),
            vec!["Equal"]
        );
    }
    #[test]
    fn every_extended_function_key_supports_plain_shift_and_control_bindings() {
        for number in 13..=24 {
            for (prefix, modifiers) in [
                ("", json!({})),
                ("Shift+", json!({"shift":true})),
                ("Ctrl+", json!({"ctrl":true})),
            ] {
                let key = format!("F{number}");
                let mut keyboard =
                    Keyboard::new(&json!({"manualOcrHotkey":format!("{prefix}{key}")}));
                assert_eq!(keyboard.keys(), vec![key.clone()]);
                let event =
                    json!({"type":"keyboard_event","key":key,"pressed":true,"modifiers":modifiers});
                assert_eq!(keyboard.receive(&event, true), vec!["manual_ocr"]);
                assert!(keyboard.receive(&event, true).is_empty());
            }
        }
    }
}
