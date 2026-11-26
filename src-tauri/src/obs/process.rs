use super::*;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(target_os = "macos")]
    if let (Ok(left), Ok(right)) = (a.metadata(), b.metadata()) {
        use std::os::unix::fs::MetadataExt;
        return (left.dev(), left.ino()) == (right.dev(), right.ino());
    }
    let normalize = |p: &Path| {
        p.canonicalize()
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('\\', "/")
            .to_owned()
    };
    if cfg!(windows) {
        normalize(a).eq_ignore_ascii_case(&normalize(b))
    } else {
        normalize(a) == normalize(b)
    }
}
pub fn resolve_executable(command: &Path) -> Option<PathBuf> {
    if command.is_file() {
        return command.canonicalize().ok();
    }
    if command.components().count() != 1 {
        return None;
    }
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let candidate = directory.join(command);
        if candidate.is_file() {
            return candidate.canonicalize().ok();
        }
        if cfg!(windows) && command.extension().is_none() {
            let candidate = candidate.with_extension("exe");
            if candidate.is_file() {
                return candidate.canonicalize().ok();
            }
        }
    }
    None
}
pub fn split_command(raw: &str) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::{LocalFree, HLOCAL},
                UI::Shell::CommandLineToArgvW,
            },
        };
        let wide: Vec<_> = raw.encode_utf16().chain(Some(0)).collect();
        let mut count = 0;
        let ptr = unsafe { CommandLineToArgvW(PCWSTR(wide.as_ptr()), &mut count) };
        if ptr.is_null() {
            return Err("Invalid OBS command".into());
        }
        let result = unsafe {
            std::slice::from_raw_parts(ptr, count as usize)
                .iter()
                .map(|p| p.to_string().map_err(err))
                .collect()
        };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(ptr.cast())));
        }
        result
    }
    #[cfg(not(windows))]
    {
        shell_words::split(raw).map_err(err)
    }
}
#[cfg(windows)]
pub fn image_path(pid: u32) -> Option<PathBuf> {
    use windows::{
        core::PWSTR,
        Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut text = vec![0u16; 32768];
        let mut len = text.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(text.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        result
            .ok()
            .map(|_| PathBuf::from(String::from_utf16_lossy(&text[..len as usize])))
    }
}
#[cfg(target_os = "linux")]
pub fn image_path(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}
#[cfg(target_os = "macos")]
pub fn image_path(pid: u32) -> Option<PathBuf> {
    crate::process_probe::process_executable_path(pid)
}
pub fn find(executable: &Path, remembered: Option<u32>) -> Result<Option<u32>, String> {
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
        };
        let _ = remembered;
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(err)?;
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut matches = vec![];
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let name = String::from_utf16_lossy(&entry.szExeFile)
                        .trim_end_matches('\0')
                        .to_owned();
                    if executable.file_name().is_some_and(|expected| {
                        name.eq_ignore_ascii_case(&expected.to_string_lossy())
                    }) && image_path(entry.th32ProcessID)
                        .is_some_and(|p| same_path(&p, executable))
                    {
                        matches.push(entry.th32ProcessID);
                    }
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
            if matches.len() > 1 {
                Err("Close extra copies of GSM's OBS before continuing".into())
            } else {
                Ok(matches.first().copied())
            }
        }
    }
    #[cfg(not(windows))]
    {
        Ok(remembered.filter(|pid| image_path(*pid).is_some_and(|p| same_path(&p, executable))))
    }
}
pub fn start(executable: &Path, args: &[String]) -> Result<u32, String> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(parent) = executable.parent().filter(|p| !p.as_os_str().is_empty()) {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(err)?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}
#[cfg(windows)]
fn windows_for_pid(pid: u32) -> Vec<windows::Win32::Foundation::HWND> {
    use windows::Win32::{
        Foundation::{HWND, LPARAM},
        UI::WindowsAndMessaging::{
            EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId,
        },
    };
    struct Find {
        pid: u32,
        windows: Vec<HWND>,
    }
    unsafe extern "system" fn callback(hwnd: HWND, param: LPARAM) -> windows::core::BOOL {
        let data = &mut *(param.0 as *mut Find);
        let mut process = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut process));
        if process == data.pid {
            let mut class = [0u16; 256];
            let n = GetClassNameW(hwnd, &mut class);
            let class = String::from_utf16_lossy(&class[..n.max(0) as usize]);
            let mut title = [0u16; 512];
            let length = GetWindowTextW(hwnd, &mut title).max(0) as usize;
            let title = String::from_utf16_lossy(&title[..length]);
            if class.contains("QWindow") && title.starts_with("OBS") {
                data.windows.push(hwnd);
            }
        }
        true.into()
    }
    let mut find = Find {
        pid,
        windows: vec![],
    };
    unsafe {
        let _ = EnumWindows(Some(callback), LPARAM(&mut find as *mut _ as isize));
    }
    find.windows
}
pub fn show(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetForegroundWindow, ShowWindow, SW_RESTORE,
        };
        let windows = windows_for_pid(pid);
        if windows.is_empty() {
            return Err("OBS has no available window".into());
        }
        for hwnd in windows {
            unsafe {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetForegroundWindow(hwnd);
            }
        }
    }
    let _ = pid;
    Ok(())
}
pub async fn close(pid: u32, executable: &Path) -> Result<(), String> {
    close_with_options(pid, executable, false).await
}
pub async fn close_with_options(
    pid: u32,
    executable: &Path,
    force_kill_on_timeout: bool,
) -> Result<(), String> {
    if !image_path(pid).is_some_and(|p| same_path(&p, executable)) {
        return Err("OBS process identity changed; refusing to close it".into());
    }
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::{LPARAM, WPARAM},
            UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE},
        };
        let windows = windows_for_pid(pid);
        if windows.is_empty() && !force_kill_on_timeout {
            return Err("Could not find OBS's main window for graceful shutdown".into());
        }
        for hwnd in windows {
            unsafe {
                let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }
    #[cfg(not(windows))]
    {
        let status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map_err(err)?;
        if !status.success() && !force_kill_on_timeout {
            return Err("Could not signal OBS".into());
        }
    }
    for _ in 0..100 {
        if !image_path(pid).is_some_and(|p| same_path(&p, executable)) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !force_kill_on_timeout {
        return Err("OBS did not exit after a graceful shutdown request".into());
    }
    force_terminate(pid, executable).await
}
async fn force_terminate(pid: u32, executable: &Path) -> Result<(), String> {
    if !image_path(pid).is_some_and(|p| same_path(&p, executable)) {
        return Ok(());
    }
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE},
        };
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, false, pid).map_err(err)?;
            let terminated = TerminateProcess(handle, 1);
            let _ = CloseHandle(handle);
            terminated.map_err(err)?;
        }
    }
    #[cfg(not(windows))]
    {
        let status = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status()
            .map_err(err)?;
        if !status.success() {
            return Err("Could not force-terminate OBS".into());
        }
    }
    for _ in 0..30 {
        if !image_path(pid).is_some_and(|p| same_path(&p, executable)) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("OBS did not exit after force termination".into())
}
pub fn foreground() -> Option<Value> {
    #[cfg(windows)]
    {
        window_snapshot(unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() })
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
pub(super) fn window_snapshot(hwnd: windows::Win32::Foundation::HWND) -> Option<Value> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };
    unsafe {
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == std::process::id() {
            return None;
        }
        let mut title = vec![0u16; GetWindowTextLengthW(hwnd).clamp(0, 32767) as usize + 1];
        let n = GetWindowTextW(hwnd, &mut title);
        if n == 0 {
            return None;
        }
        let path = image_path(pid);
        let name = path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().into_owned());
        return Some(
            json!({"hwnd":(hwnd.0 as usize).to_string(),"pid":pid,"title":String::from_utf16_lossy(&title[..n as usize]),"executablePath":path,"executableName":name,"capturedAt":chrono::Utc::now().timestamp_millis(),"sequence":0}),
        );
    }
}
pub fn restore(hwnd: &str) {
    #[cfg(windows)]
    {
        use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::SetForegroundWindow};
        if let Ok(value) = hwnd
            .strip_prefix("0x")
            .map(|h| usize::from_str_radix(h, 16))
            .unwrap_or_else(|| hwnd.parse::<usize>())
        {
            unsafe {
                let _ = SetForegroundWindow(HWND(value as *mut _));
            }
        }
    }
    let _ = hwnd;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_line_preserves_windows_quotes_and_unicode() {
        if cfg!(windows) {
            assert_eq!(
                split_command(r#""C:\Users\Game Name 日本語\obs64.exe" --profile "GSM profile""#)
                    .unwrap(),
                vec![
                    r"C:\Users\Game Name 日本語\obs64.exe".to_string(),
                    "--profile".into(),
                    "GSM profile".into()
                ]
            );
        }
    }
    #[test]
    fn process_identity_checks_the_executable_path() {
        let pid = std::process::id();
        let executable = std::env::current_exe().unwrap();
        let image = image_path(pid).expect("process executable path");
        assert!(same_path(&image, &executable), "process image {image:?}, current executable {executable:?}");
        assert_eq!(find(&executable, Some(pid)).unwrap(), Some(pid));
        assert_eq!(
            find(&executable.with_file_name("different-obs.exe"), Some(pid)).unwrap(),
            None
        );
    }
    #[tokio::test]
    async fn close_rejects_recycled_or_unrelated_process_before_signaling() {
        let error = close(std::process::id(), Path::new("unrelated-obs.exe"))
            .await
            .unwrap_err();
        assert!(error.contains("identity changed"));
        let force_error =
            close_with_options(std::process::id(), Path::new("unrelated-obs.exe"), true)
                .await
                .unwrap_err();
        assert!(force_error.contains("identity changed"));
    }
}
