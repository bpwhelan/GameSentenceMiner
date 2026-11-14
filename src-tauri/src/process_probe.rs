//! Direct Win32/OS process, PE bitness, and window title helpers without shelling out.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchedProcess {
    pub pid: u32,
    pub exe_name: String,
    pub working_set_bytes: u64,
}

/// Detect `"x86"`, `"x64"`, or `"unknown"` directly from a PE header without spawning external tools.
pub fn pe_bitness(path: &Path) -> &'static str {
    let Ok(mut file) = File::open(path) else {
        return "unknown";
    };
    let mut dos = [0u8; 64];
    if file.read_exact(&mut dos).is_err() {
        return "unknown";
    }
    if dos[0..2] != [0x4d, 0x5a] {
        return "unknown";
    }
    let pe_offset = u32::from_le_bytes([dos[0x3c], dos[0x3d], dos[0x3e], dos[0x3f]]) as u64;
    if file.seek(SeekFrom::Start(pe_offset)).is_err() {
        return "unknown";
    }
    let mut pe = [0u8; 6];
    if file.read_exact(&mut pe).is_err() {
        return "unknown";
    }
    if &pe[0..4] != b"PE\0\0" {
        return "unknown";
    }
    match u16::from_le_bytes([pe[4], pe[5]]) {
        0x014c => "x86",
        0x8664 => "x64",
        _ => "unknown",
    }
}

#[cfg(windows)]
pub fn normalize_exe_name(name: &str) -> String {
    let trimmed = name.trim();
    let base = Path::new(trimmed)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(trimmed);
    base.to_lowercase()
}

#[cfg(not(windows))]
pub fn normalize_exe_name(name: &str) -> String {
    name.trim().strip_suffix(".exe").unwrap_or(name.trim()).to_owned()
}

#[cfg(windows)]
fn utf16_z(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

#[cfg(windows)]
fn working_set_bytes_for_pid(pid: u32) -> u64 {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};

    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid)
            .or_else(|_| OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid))
        else {
            return 0;
        };
        let mut pmc = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        let bytes = if GetProcessMemoryInfo(handle, &mut pmc, pmc.cb).is_ok() {
            pmc.WorkingSetSize as u64
        } else {
            0
        };
        let _ = CloseHandle(handle);
        bytes
    }
}

#[cfg(windows)]
pub fn find_processes_by_exe(exe_name: &str) -> Vec<MatchedProcess> {
    use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    let target = normalize_exe_name(exe_name);
    if target.is_empty() {
        return Vec::new();
    }

    let mut matches = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return matches;
        };
        if snapshot == INVALID_HANDLE_VALUE {
            return matches;
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let exe = utf16_z(&entry.szExeFile);
                if exe.eq_ignore_ascii_case(&target) {
                    let pid = entry.th32ProcessID;
                    matches.push(MatchedProcess {
                        pid,
                        exe_name: exe,
                        working_set_bytes: working_set_bytes_for_pid(pid),
                    });
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }

    matches.sort_by(|a, b| b.working_set_bytes.cmp(&a.working_set_bytes));
    matches
}

#[cfg(not(windows))]
pub fn find_processes_by_exe(exe_name: &str) -> Vec<MatchedProcess> {
    let target = normalize_exe_name(exe_name);
    if target.is_empty() {
        return Vec::new();
    }
    let mut matches = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return matches;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let proc_dir = entry.path();
        let exe_match = std::fs::read_link(proc_dir.join("exe"))
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .filter(|name| name.eq_ignore_ascii_case(&target) || name.eq_ignore_ascii_case(exe_name))
            .or_else(|| {
                std::fs::read_to_string(proc_dir.join("comm"))
                    .ok()
                    .map(|c| c.trim().to_owned())
                    .filter(|name| name.eq_ignore_ascii_case(&target))
            });
        if let Some(exe_name) = exe_match {
            matches.push(MatchedProcess {
                pid,
                exe_name,
                working_set_bytes: 0,
            });
        }
    }
    matches
}

pub fn find_primary_pid_by_exe(exe_name: &str) -> Option<u32> {
    const MIN_WORKING_SET_BYTES: u64 = 20_000 * 1024;
    let matches = find_processes_by_exe(exe_name);
    matches
        .iter()
        .find(|m| m.working_set_bytes > MIN_WORKING_SET_BYTES)
        .or_else(|| matches.first())
        .map(|m| m.pid)
}

#[cfg(test)]
pub fn is_process_running_by_name(exe_name: &str) -> bool {
    !find_processes_by_exe(exe_name).is_empty()
}

#[cfg(all(windows, test))]
pub fn is_pid_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    if pid == 0 {
        return false;
    }
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
        let _ = CloseHandle(handle);
        ok
    }
}

#[cfg(not(windows))]
pub fn is_pid_alive(pid: u32) -> bool {
    pid > 0 && Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(windows)]
pub fn process_executable_path(pid: u32) -> Option<PathBuf> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut len = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
        .ok()
        .map(|_| PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])));
        let _ = CloseHandle(handle);
        result
    }
}

#[cfg(not(windows))]
pub fn process_executable_path(pid: u32) -> Option<PathBuf> {
    if pid == 0 {
        return None;
    }
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(windows)]
pub fn window_title_for_pid(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };
    use windows::core::BOOL;

    if pid == 0 {
        return None;
    }

    struct Search {
        pid: u32,
        best: Option<String>,
    }

    unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam.0 as *mut Search);
        let mut owner_pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut owner_pid));
        if owner_pid != search.pid {
            return BOOL(1);
        }
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return BOOL(1);
        }
        let mut buf = vec![0u16; (len as usize) + 1];
        let copied = GetWindowTextW(hwnd, &mut buf);
        if copied > 0 {
            let title = String::from_utf16_lossy(&buf[..copied as usize]).trim().to_owned();
            if !title.is_empty() {
                search.best = Some(title);
                return BOOL(0);
            }
        }
        BOOL(1)
    }

    let mut search = Search { pid, best: None };
    unsafe {
        let _ = EnumWindows(Some(callback), LPARAM(&mut search as *mut Search as isize));
    }
    search.best
}

#[cfg(not(windows))]
pub fn window_title_for_pid(_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn pe_bitness_reads_current_executable_architecture() {
        let exe = std::env::current_exe().expect("current test binary path");
        let arch = pe_bitness(&exe);
        if cfg!(all(windows, target_arch = "x86_64")) {
            assert_eq!(arch, "x64");
        } else if cfg!(all(windows, target_arch = "x86")) {
            assert_eq!(arch, "x86");
        }
    }

    #[test]
    fn process_probe_finds_current_process_fast() {
        let pid = std::process::id();
        assert!(is_pid_alive(pid));
        let path = process_executable_path(pid).expect("current exe path via OS API");
        let exe_name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(is_process_running_by_name(&exe_name));

        let started = Instant::now();
        let found = find_processes_by_exe(&exe_name);
        let elapsed = started.elapsed();

        assert!(
            found.iter().any(|m| m.pid == pid),
            "expected current pid {pid} in matches for {exe_name}: {found:?}"
        );
        eprintln!(
            "[bench] process_probe find_processes_by_exe matches={} ms={:.3}",
            found.len(),
            elapsed.as_secs_f64() * 1000.0
        );
    }

    #[test]
    fn window_title_enum_for_pid_benchmark() {
        let pid = std::process::id();
        let started = Instant::now();
        for _ in 0..50 {
            let _ = window_title_for_pid(pid);
        }
        let per_call_us = started.elapsed().as_secs_f64() * 1e6 / 50.0;
        eprintln!("[bench] process_probe window_title_for_pid us_per_call={per_call_us:.1}");
    }
}
