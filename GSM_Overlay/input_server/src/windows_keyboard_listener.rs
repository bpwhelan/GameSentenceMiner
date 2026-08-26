use rdev::{
    Button as MouseButton, Event as KeyboardEvent, EventType as KeyboardEventType,
    Key as KeyboardKey,
};
use std::cell::RefCell;
use std::io;
use std::mem::MaybeUninit;
use std::ptr::null_mut;
use std::time::SystemTime;
use winapi::shared::minwindef::{LPARAM, LRESULT, WPARAM};
use winapi::um::errhandlingapi::GetLastError;
use winapi::um::winuser::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_EXTENDED, MSG, MSLLHOOKSTRUCT,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MBUTTONDOWN, WM_MBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    WM_XBUTTONDOWN, WM_XBUTTONUP,
};

type KeyboardCallback = Box<dyn FnMut(KeyboardEvent)>;

thread_local! {
    // Low-level hook callbacks run on the thread that installed the hook. Keeping
    // the callback thread-local avoids global mutable callback state.
    static KEYBOARD_CALLBACK: RefCell<Option<KeyboardCallback>> = RefCell::new(None);
}

/// Listen for physical keyboard transitions without resolving typed text.
///
/// `rdev::listen` 0.5.3 resolves `Event.name` on every Windows key-down by
/// calling `AttachThreadInput` for the foreground thread. Windows resets key
/// state when input threads are attached, which can interfere with games that
/// poll keyboard state under heavy input. GSM only consumes `EventType`, so this
/// listener reads the virtual-key code directly and always leaves `name` unset.
pub fn listen<T>(callback: T) -> Result<(), io::Error>
where
    T: FnMut(KeyboardEvent) + 'static,
{
    KEYBOARD_CALLBACK.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "keyboard listener is already running on this thread",
            ));
        }
        *slot = Some(Box::new(callback));
        Ok(())
    })?;

    let keyboard_hook_handle =
        unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), null_mut(), 0) };
    if keyboard_hook_handle.is_null() {
        let error = io::Error::from_raw_os_error(unsafe { GetLastError() } as i32);
        clear_callback();
        return Err(error);
    }

    let mouse_hook_handle =
        unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), null_mut(), 0) };
    if mouse_hook_handle.is_null() {
        let error = io::Error::from_raw_os_error(unsafe { GetLastError() } as i32);
        unsafe {
            UnhookWindowsHookEx(keyboard_hook_handle);
        }
        clear_callback();
        return Err(error);
    }

    let message_loop_result = run_message_loop();
    unsafe {
        UnhookWindowsHookEx(mouse_hook_handle);
        UnhookWindowsHookEx(keyboard_hook_handle);
    }
    clear_callback();
    message_loop_result
}

fn run_message_loop() -> Result<(), io::Error> {
    loop {
        let mut message = MaybeUninit::<MSG>::zeroed();
        let result = unsafe { GetMessageW(message.as_mut_ptr(), null_mut(), 0, 0) };
        if result == -1 {
            return Err(io::Error::from_raw_os_error(
                unsafe { GetLastError() } as i32
            ));
        }
        if result == 0 {
            return Ok(());
        }

        let message = unsafe { message.assume_init() };
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

fn clear_callback() {
    KEYBOARD_CALLBACK.with(|slot| {
        *slot.borrow_mut() = None;
    });
}

unsafe extern "system" fn keyboard_hook(
    code: i32,
    message: WPARAM,
    hook_data_ptr: LPARAM,
) -> LRESULT {
    if code == HC_ACTION && hook_data_ptr != 0 {
        let hook_data = &*(hook_data_ptr as *const KBDLLHOOKSTRUCT);
        if let Some(event) = keyboard_event_from_message(message, hook_data) {
            KEYBOARD_CALLBACK.with(|slot| {
                if let Some(callback) = slot.borrow_mut().as_mut() {
                    callback(event);
                }
            });
        }
    }

    // This listener observes input only. Returning CallNextHookEx's result keeps
    // every transition flowing to the game and to the rest of the hook chain.
    CallNextHookEx(null_mut(), code, message, hook_data_ptr)
}

unsafe extern "system" fn mouse_hook(code: i32, message: WPARAM, hook_data_ptr: LPARAM) -> LRESULT {
    if code == HC_ACTION && hook_data_ptr != 0 {
        let hook_data = &*(hook_data_ptr as *const MSLLHOOKSTRUCT);
        if let Some(event) = mouse_event_from_message(message, hook_data) {
            KEYBOARD_CALLBACK.with(|slot| {
                if let Some(callback) = slot.borrow_mut().as_mut() {
                    callback(event);
                }
            });
        }
    }

    CallNextHookEx(null_mut(), code, message, hook_data_ptr)
}

fn keyboard_event_from_message(
    message: WPARAM,
    hook_data: &KBDLLHOOKSTRUCT,
) -> Option<KeyboardEvent> {
    let key = keyboard_key_from_hook(hook_data);
    let event_type = match message as u32 {
        WM_KEYDOWN | WM_SYSKEYDOWN => KeyboardEventType::KeyPress(key),
        WM_KEYUP | WM_SYSKEYUP => KeyboardEventType::KeyRelease(key),
        _ => return None,
    };

    Some(KeyboardEvent {
        time: SystemTime::now(),
        name: None,
        event_type,
    })
}

fn mouse_event_from_message(message: WPARAM, hook_data: &MSLLHOOKSTRUCT) -> Option<KeyboardEvent> {
    let message = message as u32;
    let (button, pressed) = match message {
        WM_LBUTTONDOWN => (MouseButton::Left, true),
        WM_LBUTTONUP => (MouseButton::Left, false),
        WM_MBUTTONDOWN => (MouseButton::Middle, true),
        WM_MBUTTONUP => (MouseButton::Middle, false),
        WM_RBUTTONDOWN => (MouseButton::Right, true),
        WM_RBUTTONUP => (MouseButton::Right, false),
        WM_XBUTTONDOWN | WM_XBUTTONUP => {
            let button_code = (hook_data.mouseData >> 16) as u8;
            (MouseButton::Unknown(button_code), message == WM_XBUTTONDOWN)
        }
        _ => return None,
    };

    Some(KeyboardEvent {
        time: SystemTime::now(),
        name: None,
        event_type: if pressed {
            KeyboardEventType::ButtonPress(button)
        } else {
            KeyboardEventType::ButtonRelease(button)
        },
    })
}

fn keyboard_key_from_hook(hook_data: &KBDLLHOOKSTRUCT) -> KeyboardKey {
    let extended = hook_data.flags & LLKHF_EXTENDED != 0;
    match hook_data.vkCode {
        0x08 => KeyboardKey::Backspace,
        0x09 => KeyboardKey::Tab,
        0x0D => KeyboardKey::Return,
        0x10 => {
            if hook_data.scanCode == 0x36 {
                KeyboardKey::ShiftRight
            } else {
                KeyboardKey::ShiftLeft
            }
        }
        0x11 => {
            if extended {
                KeyboardKey::ControlRight
            } else {
                KeyboardKey::ControlLeft
            }
        }
        0x12 => {
            if extended {
                KeyboardKey::AltGr
            } else {
                KeyboardKey::Alt
            }
        }
        0x13 => KeyboardKey::Pause,
        0x14 => KeyboardKey::CapsLock,
        0x1B => KeyboardKey::Escape,
        0x20 => KeyboardKey::Space,
        0x21 => KeyboardKey::PageUp,
        0x22 => KeyboardKey::PageDown,
        0x23 => KeyboardKey::End,
        0x24 => KeyboardKey::Home,
        0x25 => KeyboardKey::LeftArrow,
        0x26 => KeyboardKey::UpArrow,
        0x27 => KeyboardKey::RightArrow,
        0x28 => KeyboardKey::DownArrow,
        0x2C => KeyboardKey::PrintScreen,
        0x2D => KeyboardKey::Insert,
        0x2E => KeyboardKey::Delete,
        0x30 => KeyboardKey::Num0,
        0x31 => KeyboardKey::Num1,
        0x32 => KeyboardKey::Num2,
        0x33 => KeyboardKey::Num3,
        0x34 => KeyboardKey::Num4,
        0x35 => KeyboardKey::Num5,
        0x36 => KeyboardKey::Num6,
        0x37 => KeyboardKey::Num7,
        0x38 => KeyboardKey::Num8,
        0x39 => KeyboardKey::Num9,
        0x41 => KeyboardKey::KeyA,
        0x42 => KeyboardKey::KeyB,
        0x43 => KeyboardKey::KeyC,
        0x44 => KeyboardKey::KeyD,
        0x45 => KeyboardKey::KeyE,
        0x46 => KeyboardKey::KeyF,
        0x47 => KeyboardKey::KeyG,
        0x48 => KeyboardKey::KeyH,
        0x49 => KeyboardKey::KeyI,
        0x4A => KeyboardKey::KeyJ,
        0x4B => KeyboardKey::KeyK,
        0x4C => KeyboardKey::KeyL,
        0x4D => KeyboardKey::KeyM,
        0x4E => KeyboardKey::KeyN,
        0x4F => KeyboardKey::KeyO,
        0x50 => KeyboardKey::KeyP,
        0x51 => KeyboardKey::KeyQ,
        0x52 => KeyboardKey::KeyR,
        0x53 => KeyboardKey::KeyS,
        0x54 => KeyboardKey::KeyT,
        0x55 => KeyboardKey::KeyU,
        0x56 => KeyboardKey::KeyV,
        0x57 => KeyboardKey::KeyW,
        0x58 => KeyboardKey::KeyX,
        0x59 => KeyboardKey::KeyY,
        0x5A => KeyboardKey::KeyZ,
        0x5B => KeyboardKey::MetaLeft,
        0x5C => KeyboardKey::MetaRight,
        0x60 => KeyboardKey::Kp0,
        0x61 => KeyboardKey::Kp1,
        0x62 => KeyboardKey::Kp2,
        0x63 => KeyboardKey::Kp3,
        0x64 => KeyboardKey::Kp4,
        0x65 => KeyboardKey::Kp5,
        0x66 => KeyboardKey::Kp6,
        0x67 => KeyboardKey::Kp7,
        0x68 => KeyboardKey::Kp8,
        0x69 => KeyboardKey::Kp9,
        0x6A => KeyboardKey::KpMultiply,
        0x6B => KeyboardKey::KpPlus,
        0x6D => KeyboardKey::KpMinus,
        0x6E => KeyboardKey::KpDelete,
        0x6F => KeyboardKey::KpDivide,
        0x70 => KeyboardKey::F1,
        0x71 => KeyboardKey::F2,
        0x72 => KeyboardKey::F3,
        0x73 => KeyboardKey::F4,
        0x74 => KeyboardKey::F5,
        0x75 => KeyboardKey::F6,
        0x76 => KeyboardKey::F7,
        0x77 => KeyboardKey::F8,
        0x78 => KeyboardKey::F9,
        0x79 => KeyboardKey::F10,
        0x7A => KeyboardKey::F11,
        0x7B => KeyboardKey::F12,
        0x90 => KeyboardKey::NumLock,
        0x91 => KeyboardKey::ScrollLock,
        0xA0 => KeyboardKey::ShiftLeft,
        0xA1 => KeyboardKey::ShiftRight,
        0xA2 => KeyboardKey::ControlLeft,
        0xA3 => KeyboardKey::ControlRight,
        0xA4 => KeyboardKey::Alt,
        0xA5 => KeyboardKey::AltGr,
        0xBA => KeyboardKey::SemiColon,
        0xBB => KeyboardKey::Equal,
        0xBC => KeyboardKey::Comma,
        0xBD => KeyboardKey::Minus,
        0xBE => KeyboardKey::Dot,
        0xBF => KeyboardKey::Slash,
        0xC0 => KeyboardKey::BackQuote,
        0xDB => KeyboardKey::LeftBracket,
        0xDC => KeyboardKey::BackSlash,
        0xDD => KeyboardKey::RightBracket,
        0xDE => KeyboardKey::Quote,
        0xE2 => KeyboardKey::IntlBackslash,
        virtual_key => KeyboardKey::Unknown(virtual_key),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook_data(vk_code: u32, scan_code: u32, flags: u32) -> KBDLLHOOKSTRUCT {
        KBDLLHOOKSTRUCT {
            vkCode: vk_code,
            scanCode: scan_code,
            flags,
            time: 0,
            dwExtraInfo: 0,
        }
    }

    fn mouse_hook_data(mouse_data: u32) -> MSLLHOOKSTRUCT {
        let mut data: MSLLHOOKSTRUCT = unsafe { std::mem::zeroed() };
        data.mouseData = mouse_data;
        data
    }

    #[test]
    fn raw_events_preserve_key_edges_without_resolving_text() {
        let data = hook_data(0x57, 0x11, 0);
        let pressed = keyboard_event_from_message(WM_KEYDOWN as WPARAM, &data)
            .expect("key-down should produce an event");
        let released = keyboard_event_from_message(WM_KEYUP as WPARAM, &data)
            .expect("key-up should produce an event");

        assert_eq!(pressed.name, None);
        assert_eq!(
            pressed.event_type,
            KeyboardEventType::KeyPress(KeyboardKey::KeyW)
        );
        assert_eq!(released.name, None);
        assert_eq!(
            released.event_type,
            KeyboardEventType::KeyRelease(KeyboardKey::KeyW)
        );
    }

    #[test]
    fn hook_metadata_distinguishes_left_and_right_modifiers() {
        assert_eq!(
            keyboard_key_from_hook(&hook_data(0x10, 0x2A, 0)),
            KeyboardKey::ShiftLeft
        );
        assert_eq!(
            keyboard_key_from_hook(&hook_data(0x10, 0x36, 0)),
            KeyboardKey::ShiftRight
        );
        assert_eq!(
            keyboard_key_from_hook(&hook_data(0x11, 0x1D, LLKHF_EXTENDED)),
            KeyboardKey::ControlRight
        );
        assert_eq!(
            keyboard_key_from_hook(&hook_data(0x12, 0x38, LLKHF_EXTENDED)),
            KeyboardKey::AltGr
        );
    }

    #[test]
    fn extended_function_keys_keep_rdev_unknown_virtual_key_contract() {
        assert_eq!(
            keyboard_key_from_hook(&hook_data(0x7C, 0x64, 0)),
            KeyboardKey::Unknown(124)
        );
        assert_eq!(
            keyboard_key_from_hook(&hook_data(0x87, 0x76, 0)),
            KeyboardKey::Unknown(135)
        );
    }

    #[test]
    fn xbutton_messages_preserve_mouse4_and_mouse5_edges() {
        let mouse4 = mouse_hook_data(1u32 << 16);
        let mouse5 = mouse_hook_data(2u32 << 16);

        let mouse4_pressed = mouse_event_from_message(WM_XBUTTONDOWN as WPARAM, &mouse4)
            .expect("Mouse4 press should produce an event");
        let mouse5_released = mouse_event_from_message(WM_XBUTTONUP as WPARAM, &mouse5)
            .expect("Mouse5 release should produce an event");

        assert_eq!(
            mouse4_pressed.event_type,
            KeyboardEventType::ButtonPress(MouseButton::Unknown(1))
        );
        assert_eq!(
            mouse5_released.event_type,
            KeyboardEventType::ButtonRelease(MouseButton::Unknown(2))
        );
    }
}
