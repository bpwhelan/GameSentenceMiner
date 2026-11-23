//! Application identity, icon style/seasonal resolution, Windows taskbar details, and Linux AppImage desktop integration.
use chrono::{Datelike, Local, NaiveDate};
use gsm_settings::preferences::Preferences;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};

const AVAILABLE_ICON_STYLES: [&str; 4] = ["gsm", "gsm_cute", "gsm_jacked", "gsm_cursed"];

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SeasonalEvent {
    Halloween,
}

#[derive(Default)]
pub struct IconPresentation {
    use_rare_icon: bool,
    random_style: Mutex<String>,
    icon_downloads: Mutex<HashMap<String, Option<Instant>>>,
}

impl IconPresentation {
    pub fn new() -> Self {
        let roll = uuid::Uuid::new_v4().as_bytes()[0];
        // ~1% chance matching Electron's `Math.random() < 0.01` rare startup icon.
        let use_rare_icon = roll < 3;
        Self {
            use_rare_icon,
            random_style: Mutex::new(String::new()),
            icon_downloads: Mutex::new(HashMap::new()),
        }
    }

    pub fn refresh_random_style(&self, configured_style: &str) {
        let mut guard = self.random_style.lock().unwrap();
        if configured_style.contains("random") {
            let idx = (uuid::Uuid::new_v4().as_bytes()[1] as usize) % AVAILABLE_ICON_STYLES.len();
            *guard = AVAILABLE_ICON_STYLES[idx].to_owned();
        } else {
            guard.clear();
        }
    }

    pub fn resolved_random_style(&self, configured_style: &str) -> String {
        if !configured_style.contains("random") {
            return configured_style.to_owned();
        }
        let mut guard = self.random_style.lock().unwrap();
        if guard.is_empty() {
            let idx = (uuid::Uuid::new_v4().as_bytes()[1] as usize) % AVAILABLE_ICON_STYLES.len();
            *guard = AVAILABLE_ICON_STYLES[idx].to_owned();
        }
        guard.clone()
    }
}

pub fn get_seasonal_event(disabled: bool, date: NaiveDate) -> Option<SeasonalEvent> {
    if disabled {
        return None;
    }
    let launch_year = date.year() == 2026;
    let month = date.month();
    let day = date.day();
    let in_window = (month == 10 && day >= if launch_year { 24 } else { 15 })
        || (month == 11 && day <= if launch_year { 7 } else { 1 });
    in_window.then_some(SeasonalEvent::Halloween)
}

pub fn active_seasonal_event(disabled: bool) -> Option<SeasonalEvent> {
    get_seasonal_event(disabled, Local::now().date_naive())
}

pub fn resolve_seasonal_icon_style(style: &str, event: Option<SeasonalEvent>) -> String {
    if style == "gsm" && event == Some(SeasonalEvent::Halloween) {
        "gsm-halloween".into()
    } else {
        style.to_owned()
    }
}

pub fn strip_style_bracket_suffix(style: &str) -> &str {
    match style.find('[') {
        Some(idx) if style[idx..].contains(']') => &style[..idx],
        _ => style,
    }
}

pub fn icon_extension() -> &'static str {
    if cfg!(windows) {
        "ico"
    } else {
        "png"
    }
}

pub fn resolve_tray_style_name(configured_icon_style: &str, resolved_random_style: &str) -> String {
    let effective = if configured_icon_style.contains("random") {
        resolved_random_style
    } else {
        configured_icon_style
    };
    if configured_icon_style.contains("[tray]") {
        effective.replace("[tray]", "")
    } else {
        "gsm".into()
    }
}

pub fn get_window_icon_path(
    assets_dir: &Path,
    configured_icon_style: &str,
    resolved_random_style: &str,
    seasonal_event: Option<SeasonalEvent>,
    use_rare_icon: bool,
) -> PathBuf {
    let effective = if configured_icon_style.contains("random") {
        resolved_random_style
    } else {
        configured_icon_style
    };
    let clean_style = strip_style_bracket_suffix(effective);
    let seasonal_style = resolve_seasonal_icon_style(clean_style, seasonal_event);
    let ext = icon_extension();
    if use_rare_icon && seasonal_style == clean_style {
        return assets_dir.join(format!("gsm_rare.{ext}"));
    }
    assets_dir.join(format!("{seasonal_style}.{ext}"))
}

pub fn get_tray_base_icon_path(
    assets_dir: &Path,
    configured_icon_style: &str,
    resolved_random_style: &str,
    seasonal_event: Option<SeasonalEvent>,
) -> PathBuf {
    let tray_style = resolve_tray_style_name(configured_icon_style, resolved_random_style);
    let style = resolve_seasonal_icon_style(&tray_style, seasonal_event);
    assets_dir.join(format!("{style}.{}", icon_extension()))
}

pub fn get_status_tray_icon_path(
    assets_dir: &Path,
    state_suffix: &str,
    seasonal_event: Option<SeasonalEvent>,
) -> PathBuf {
    let style = resolve_seasonal_icon_style("gsm", seasonal_event);
    assets_dir.join(format!("{style}-{state_suffix}.{}", icon_extension()))
}

fn read_icon_prefs(app: &tauri::AppHandle) -> (String, bool) {
    let paths = &app.state::<crate::settings::Settings>().paths;
    let prefs = Preferences::new(&paths.active);
    let style = prefs
        .get("iconStyle")
        .ok()
        .flatten()
        .and_then(|v| v.as_str().map(str::to_owned))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "gsm".into());
    let disabled = prefs
        .get("seasonalEffectsDisabled")
        .ok()
        .flatten()
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    (style, disabled)
}

pub fn current_window_icon_path(app: &tauri::AppHandle) -> PathBuf {
    let (configured, disabled) = read_icon_prefs(app);
    let presentation = app.state::<IconPresentation>();
    let resolved = presentation.resolved_random_style(&configured);
    let assets_dir = app.state::<crate::desktop_state::DesktopState>().assets_dir();
    let desired = get_window_icon_path(
        &assets_dir,
        &configured,
        &resolved,
        active_seasonal_event(disabled),
        presentation.use_rare_icon,
    );
    available_icon(app, &desired).unwrap_or_else(|| assets_dir.join(format!("gsm.{}", icon_extension())))
}

fn available_icon(app: &tauri::AppHandle, desired: &Path) -> Option<PathBuf> {
    if desired.is_file() {
        return Some(desired.to_owned());
    }
    let id = format!("icons/{}", desired.file_name()?.to_str()?);
    if !gsm_packages::downloads::contains(&id) {
        return None;
    }
    let cache = gsm_packages::download_cache().ok()?;
    if let Some(path) = gsm_packages::downloads::cached_asset(&cache, &id, None) {
        return Some(path);
    }
    let style = app.state::<IconPresentation>();
    let mut downloads = style.icon_downloads.lock().unwrap();
    if downloads.get(&id).is_some_and(|state| {
        state.is_none_or(|retry| Instant::now() < retry)
    }) {
        return None;
    }
    downloads.insert(id.clone(), None);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = gsm_packages::downloads::ensure_asset(&cache, &id, None);
        let style = app.state::<IconPresentation>();
        let mut downloads = style.icon_downloads.lock().unwrap();
        if let Err(error) = result {
            downloads.insert(id.clone(), Some(Instant::now() + Duration::from_secs(60)));
            crate::desktop_log::stderr_only(
                "identity",
                "WARNING",
                format!("Could not load {id}: {error}"),
            );
            return;
        }
        downloads.remove(&id);
        drop(downloads);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || refresh_icon_presentation(&handle));
    });
    None
}

pub fn current_tray_icon_path(app: &tauri::AppHandle, state_suffix: Option<&str>) -> PathBuf {
    let (configured, disabled) = read_icon_prefs(app);
    let assets_dir = app.state::<crate::desktop_state::DesktopState>().assets_dir();
    let event = active_seasonal_event(disabled);
    if let Some(suffix) = state_suffix {
        let candidate = get_status_tray_icon_path(&assets_dir, suffix, event);
        if let Some(path) = available_icon(app, &candidate) {
            return path;
        }
        let fallback = get_status_tray_icon_path(&assets_dir, suffix, None);
        if fallback.is_file() {
            return fallback;
        }
    }
    let resolved = app
        .state::<IconPresentation>()
        .resolved_random_style(&configured);
    let desired = get_tray_base_icon_path(&assets_dir, &configured, &resolved, event);
    available_icon(app, &desired).unwrap_or_else(|| assets_dir.join(format!("gsm.{}", icon_extension())))
}

pub fn apply_icon_style(app: &tauri::AppHandle, next_icon_style: Option<&str>) -> Result<(), String> {
    if let Some(style) = next_icon_style {
        let trimmed = if style.trim().is_empty() { "gsm" } else { style.trim() };
        let paths = &app.state::<crate::settings::Settings>().paths;
        Preferences::new(&paths.active)
            .patch(&serde_json::json!({ "iconStyle": trimmed }))?;
        app.state::<IconPresentation>().refresh_random_style(trimmed);
    } else {
        let (configured, _) = read_icon_prefs(app);
        app.state::<IconPresentation>().refresh_random_style(&configured);
    }

    refresh_icon_presentation(app);
    Ok(())
}

pub fn refresh_icon_presentation(app: &tauri::AppHandle) {
    let icon_path = current_window_icon_path(app);
    if icon_path.is_file() {
        if let Some(hub) = crate::desktop_state::find_hub_window(app) {
            if let Ok(image) = crate::native::icon_from_path(&icon_path) {
                let _ = hub.set_icon(image);
            }
            apply_window_app_details(app, &hub, &icon_path);
        }
    }
    crate::tray::refresh_presentation(app);
}

pub fn get_windows_app_id(is_packaged: bool) -> &'static str {
    if crate::PORTABLE_PREVIEW {
        "com.beangate.gamesentenceminer.preview"
    } else if is_packaged {
        "com.beangate.gamesentenceminer"
    } else {
        // The old Electron development shortcut may still claim the `.dev` ID.
        "com.beangate.gamesentenceminer.desktop.dev"
    }
}

pub fn quote_windows_argument(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '"')) {
        return arg.to_owned();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
        } else if ch == '"' {
            out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
            out.push('"');
            backslashes = 0;
        } else {
            out.extend(std::iter::repeat_n('\\', backslashes));
            out.push(ch);
            backslashes = 0;
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

pub fn init_process_identity(_app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        let app_id = get_windows_app_id(!crate::LOCAL_BUILD);
        let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(app_id)) };
    }
    #[cfg(all(target_os = "linux", not(feature = "portable-preview")))]
    {
        ensure_stable_appimage_desktop_entry();
    }
}

pub fn apply_window_app_details(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    icon_path: &Path,
) {
    #[cfg(windows)]
    {
        let profile_dir = app.state::<crate::desktop_state::DesktopState>().profile_dir.clone();
        let executable = std::env::current_exe().unwrap_or_default();
        let mut command_parts = vec![executable.to_string_lossy().into_owned()];
        if let Some(profile) = profile_dir.as_deref() {
            command_parts.push("-profile".into());
            command_parts.push(profile.to_string_lossy().into_owned());
        }
        let relaunch_cmd = command_parts
            .iter()
            .map(|p| quote_windows_argument(p))
            .collect::<Vec<_>>()
            .join(" ");
        let app_id = get_windows_app_id(!crate::LOCAL_BUILD).to_owned();
        let icon_resource = format!("{},0", icon_path.to_string_lossy());
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(hwnd) = target.hwnd() else {
                return;
            };
            unsafe {
                use std::os::windows::ffi::OsStrExt;
                use windows::core::{GUID, PWSTR};
                use windows::Win32::Foundation::PROPERTYKEY;
                use windows::Win32::System::Com::CoTaskMemAlloc;
                use windows::Win32::System::Com::StructuredStorage::{
                    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                };
                use windows::Win32::System::Variant::VT_LPWSTR;
                use windows::Win32::UI::Shell::PropertiesSystem::{
                    IPropertyStore, SHGetPropertyStoreForWindow,
                };

                let Ok(store) = SHGetPropertyStoreForWindow::<IPropertyStore>(hwnd) else {
                    return;
                };

                const PKEY_AUMID_FMTID: GUID = GUID::from_u128(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3);
                let set_str = |pid: u32, val: &str| {
                    let wide: Vec<u16> = std::ffi::OsStr::new(val)
                        .encode_wide()
                        .chain(Some(0))
                        .collect();
                    let byte_len = wide.len() * 2;
                    let ptr = CoTaskMemAlloc(byte_len) as *mut u16;
                    if ptr.is_null() {
                        return;
                    }
                    std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
                    let pv = PROPVARIANT {
                        Anonymous: PROPVARIANT_0 {
                            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                                vt: VT_LPWSTR,
                                wReserved1: 0,
                                wReserved2: 0,
                                wReserved3: 0,
                                Anonymous: PROPVARIANT_0_0_0 {
                                    pwszVal: PWSTR(ptr),
                                },
                            }),
                        },
                    };
                    let key = PROPERTYKEY {
                        fmtid: PKEY_AUMID_FMTID,
                        pid,
                    };
                    let _ = store.SetValue(&key, &pv);
                    let mut pv_mut = pv;
                    let _ = windows::Win32::System::Com::StructuredStorage::PropVariantClear(&mut pv_mut);
                };

                set_str(2, &relaunch_cmd);
                set_str(4, "GameSentenceMiner");
                set_str(3, &icon_resource);
                // Setting the ID tells Explorer to refresh the taskbar button.
                set_str(5, &app_id);
                let _ = store.Commit();
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window, icon_path);
    }
}

pub fn write_data_dir_registry(data_dir: &Path, has_profile: bool) {
    if has_profile {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::w;
        use windows::Win32::System::Registry::{
            RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_SZ,
        };
        unsafe {
            let mut key = HKEY::default();
            if RegCreateKeyW(HKEY_CURRENT_USER, w!("Software\\GameSentenceMiner"), &mut key).is_ok()
            {
                let text: Vec<u16> = data_dir
                    .as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect();
                let bytes = std::slice::from_raw_parts(text.as_ptr() as *const u8, text.len() * 2);
                let _ = RegSetValueExW(key, w!("DataDir"), None, REG_SZ, Some(bytes));
                let _ = RegCloseKey(key);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = data_dir;
    }
}

#[cfg(all(target_os = "linux", not(feature = "portable-preview")))]
fn ensure_stable_appimage_desktop_entry() {
    let Some(appimage_path) = std::env::var_os("APPIMAGE")
        .map(|s| s.to_string_lossy().trim().to_owned())
        .filter(|s| !s.is_empty() && Path::new(s).exists())
    else {
        return;
    };
    let home = std::env::var("HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let data_home = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| Path::new(&home).join(".local/share").to_string_lossy().into_owned());
    let entry_path = Path::new(&data_home)
        .join("applications")
        .join("com.beangate.gamesentenceminer.desktop");
    let escaped_exec = format!(
        "\"{}\"",
        appimage_path
            .replace('\\', "\\\\")
            .replace('`', "\\`")
            .replace('"', "\\\"")
            .replace('$', "\\$")
    );
    let contents = format!(
        "[Desktop Entry]\nType=Application\nName=GameSentenceMiner\nExec={escaped_exec} --no-sandbox %U\nIcon=com.beangate.gamesentenceminer\nStartupWMClass=GameSentenceMiner\nNoDisplay=true\nX-GSM-Portal-Identity=true\n"
    );
    if let Some(parent) = entry_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(existing) = std::fs::read_to_string(&entry_path) {
        if !existing.contains("X-GSM-Portal-Identity=true") || existing == contents {
            return;
        }
    }
    let _ = std::fs::write(&entry_path, contents);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seasonal_halloween_windows_match_launch_and_standard_years() {
        assert_eq!(
            get_seasonal_event(false, NaiveDate::from_ymd_opt(2026, 10, 23).unwrap()),
            None
        );
        assert_eq!(
            get_seasonal_event(false, NaiveDate::from_ymd_opt(2026, 10, 24).unwrap()),
            Some(SeasonalEvent::Halloween)
        );
        assert_eq!(
            get_seasonal_event(false, NaiveDate::from_ymd_opt(2026, 11, 7).unwrap()),
            Some(SeasonalEvent::Halloween)
        );
        assert_eq!(
            get_seasonal_event(false, NaiveDate::from_ymd_opt(2026, 11, 8).unwrap()),
            None
        );
        assert_eq!(
            get_seasonal_event(false, NaiveDate::from_ymd_opt(2027, 10, 15).unwrap()),
            Some(SeasonalEvent::Halloween)
        );
        assert_eq!(
            get_seasonal_event(false, NaiveDate::from_ymd_opt(2027, 11, 2).unwrap()),
            None
        );
        assert_eq!(
            get_seasonal_event(true, NaiveDate::from_ymd_opt(2026, 10, 31).unwrap()),
            None
        );
    }

    #[test]
    fn resolves_tray_and_window_icon_styles() {
        assert_eq!(resolve_tray_style_name("gsm_cute", "gsm_cute"), "gsm");
        assert_eq!(
            resolve_tray_style_name("gsm_cute[tray]", "gsm_cute"),
            "gsm_cute"
        );
        assert_eq!(
            resolve_tray_style_name("random[tray]", "gsm_jacked"),
            "gsm_jacked"
        );
        assert_eq!(
            resolve_seasonal_icon_style("gsm", Some(SeasonalEvent::Halloween)),
            "gsm-halloween"
        );
        assert_eq!(
            resolve_seasonal_icon_style("gsm_cute", Some(SeasonalEvent::Halloween)),
            "gsm_cute"
        );
        assert_eq!(strip_style_bracket_suffix("gsm_cute[tray]"), "gsm_cute");
    }

    #[test]
    fn quotes_windows_command_line_arguments() {
        assert_eq!(quote_windows_argument("simple.exe"), "simple.exe");
        assert_eq!(
            quote_windows_argument(r"C:\Program Files\GSM\gsm.exe"),
            r#""C:\Program Files\GSM\gsm.exe""#
        );
        assert_eq!(quote_windows_argument(r#"C:\dir\"#), r#"C:\dir\"#);
        assert_eq!(
            quote_windows_argument(r#"C:\dir with space\"#),
            r#""C:\dir with space\\""#
        );
    }
}
