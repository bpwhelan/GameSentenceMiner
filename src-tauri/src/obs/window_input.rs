use super::*;
use windows::Win32::{
    Foundation::{HWND, LPARAM, POINT, RECT, WPARAM},
    Graphics::Gdi::ClientToScreen,
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

fn key(name: &str) -> Option<(usize, u16)> {
    Some(match name {
        "enter" | "return" => (0x0d, 0x1c),
        "space" => (0x20, 0x39),
        "ctrl" | "control" | "lctrl" => (0xa2, 0x1d),
        "escape" | "esc" => (0x1b, 0x01),
        "tab" => (0x09, 0x0f),
        _ => return None,
    })
}
fn post_pair(
    hwnd: HWND,
    down: u32,
    up: u32,
    pressed: WPARAM,
    released: WPARAM,
    a: LPARAM,
    b: LPARAM,
) -> bool {
    unsafe {
        PostMessageW(Some(hwnd), down, pressed, a).is_ok()
            && PostMessageW(Some(hwnd), up, released, b).is_ok()
    }
}
fn send(hwnd: HWND, action: &str, request: &Value, foreground: bool) -> bool {
    let pair = if action == "key" {
        let Some((vk, scan)) = key(text(request, "key")) else {
            return false;
        };
        if !foreground || request["post"] == true {
            let down = 1 | ((scan as isize) << 16);
            return post_pair(
                hwnd,
                WM_KEYDOWN,
                WM_KEYUP,
                WPARAM(vk),
                WPARAM(vk),
                LPARAM(down),
                LPARAM(down | (3 << 30)),
            );
        }
        [KEYEVENTF_SCANCODE, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP].map(|flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wScan: scan,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        })
    } else if action == "click" {
        let mut rect = RECT::default();
        if unsafe { GetClientRect(hwnd, &mut rect) }.is_err() || rect.right <= 0 || rect.bottom <= 0
        {
            return false;
        }
        let offset = |value: &Value, size: i32| {
            value
                .as_i64()
                .unwrap_or(i64::from(size / 2))
                .clamp(0, i64::from(size - 1)) as i32
        };
        let mut point = POINT {
            x: offset(&request["x"], rect.right),
            y: offset(&request["y"], rect.bottom),
        };
        if !foreground {
            let coords =
                LPARAM(((point.y as u16 as usize) << 16 | point.x as u16 as usize) as isize);
            return post_pair(
                hwnd,
                WM_LBUTTONDOWN,
                WM_LBUTTONUP,
                WPARAM(1),
                WPARAM(0),
                coords,
                coords,
            );
        }
        if unsafe {
            !ClientToScreen(hwnd, &mut point).as_bool()
                || GetForegroundWindow() != hwnd
                || SetCursorPos(point.x, point.y).is_err()
        } {
            return false;
        }
        [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP].map(|flags| INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        })
    } else {
        return false;
    };
    unsafe {
        GetForegroundWindow() == hwnd && SendInput(&pair, std::mem::size_of::<INPUT>() as i32) == 2
    }
}

impl Obs {
    pub(crate) fn overlay_input_request(&self, message: &Value) -> Option<Value> {
        let action = match text(message, "type") {
            "send-key-request" => "key",
            "send-click-request" => "click",
            "restore-focus-request" => "focus",
            _ => return None,
        };
        self.0.session.with_state(|state| {
            let hwnd = state["target_id"].as_u64()?;
            let pid = state["target_pid"].as_u64()?;
            if message["expected_target_hwnd"].as_u64() != Some(hwnd)
                || message["targetPid"].as_u64().is_some_and(|expected| expected != pid) {
                return None;
            }
            Some(json!({"action":action,"hwnd":hwnd,"pid":pid,"activate":true,"key":message["key"],"x":8,"y":8}))
        })
    }
    pub(super) fn checked_hwnd(&self, id: u64, pid: u32) -> Option<HWND> {
        if !self.0.session.with_state(|s| {
            s["target_id"].as_u64() == Some(id) && s["target_pid"].as_u64() == Some(pid.into())
        }) {
            return None;
        }
        let hwnd = HWND(usize::try_from(id).ok()? as *mut _);
        let mut owner = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut owner));
        }
        (pid != 0 && owner == pid).then_some(hwnd)
    }
    pub(crate) async fn target_input(&self, request: &Value) -> Result<Value, String> {
        let id = request["hwnd"].as_u64().ok_or("Missing window identity")?;
        let pid = request["pid"]
            .as_u64()
            .and_then(|p| u32::try_from(p).ok())
            .ok_or("Missing window owner")?;
        let action = text(request, "action");
        if !matches!(action, "focus" | "key" | "click")
            || (action == "key" && key(text(request, "key")).is_none())
        {
            return Err("Unsupported capture window action".into());
        }
        if action == "focus" || request["activate"] == true {
            for delay in [0, 80, 200] {
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
                let Some(hwnd) = self.checked_hwnd(id, pid) else {
                    return Ok(json!(false));
                };
                unsafe {
                    if IsIconic(hwnd).as_bool() {
                        let _ = ShowWindowAsync(hwnd, SW_RESTORE);
                    }
                    crate::windows_input::focus(hwnd);
                    if GetForegroundWindow() == hwnd {
                        break;
                    }
                }
            }
        }
        let Some(hwnd) = self.checked_hwnd(id, pid) else {
            return Ok(json!(false));
        };
        let foreground = unsafe { GetForegroundWindow() } == hwnd;
        if action == "focus" {
            return Ok(json!(foreground));
        }
        if request["activate"] == true && !foreground {
            return Ok(json!(false));
        }
        Ok(json!(send(hwnd, action, request, foreground)))
    }
}
