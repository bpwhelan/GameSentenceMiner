use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};
use windows::core::Owned;
use windows::Win32::{
    Foundation::{FILETIME, HANDLE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX2},
        Threading::{
            GetActiveProcessorCount, GetProcessTimes, OpenProcess, ALL_PROCESSOR_GROUPS,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
enum Group {
    Desktop,
    Webview,
    Backend,
    Overlay,
    TextHook,
    Capture,
}

fn helper_group(name: &str) -> Option<Group> {
    match name {
        "msedgewebview2.exe" => Some(Group::Webview),
        "python.exe" | "pythonw.exe" | "uv.exe" => Some(Group::Backend),
        "gsm_overlay_server.exe" => Some(Group::Overlay),
        "lunahostcli32.exe" | "lunahostcli64.exe" | "gsm-agent-host.exe" => Some(Group::TextHook),
        "gsm-windows-audio-capture.exe"
        | "gsm-windows-speech-recognition.exe"
        | "gsm-windows-speech-recognition-sapi.exe"
        | "oneshotocr.exe" => Some(Group::Capture),
        _ => None,
    }
}

fn managed_processes(root: u32) -> windows::core::Result<BTreeMap<u32, Group>> {
    let mut children = HashMap::<u32, Vec<(u32, Group)>>::new();
    unsafe {
        let snapshot = Owned::new(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?);
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        Process32FirstW(*snapshot, &mut entry)?;
        loop {
            let end = entry
                .szExeFile
                .iter()
                .position(|&ch| ch == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_ascii_lowercase();
            if let Some(group) = helper_group(&name) {
                children
                    .entry(entry.th32ParentProcessID)
                    .or_default()
                    .push((entry.th32ProcessID, group));
            }
            if Process32NextW(*snapshot, &mut entry).is_err() {
                break;
            }
        }
    }

    // Follow the current desktop's known helper branches. OBS and launched
    // games can also be descendants, and have their own resource usage.
    let mut processes = BTreeMap::from([(root, Group::Desktop)]);
    let mut pending = vec![root];
    while let Some(parent) = pending.pop() {
        for (pid, group) in children.remove(&parent).into_iter().flatten() {
            if processes.insert(pid, group).is_none() {
                pending.push(pid);
            }
        }
    }
    Ok(processes)
}

fn filetime_ticks(value: FILETIME) -> u64 {
    u64::from(value.dwHighDateTime) << 32 | u64::from(value.dwLowDateTime)
}

fn cpu_time(process: HANDLE) -> windows::core::Result<u64> {
    let [mut created, mut exited, mut kernel, mut user] = [FILETIME::default(); 4];
    unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user)? };
    Ok(filetime_ticks(kernel) + filetime_ticks(user))
}

fn private_working_set(process: HANDLE) -> Option<u64> {
    let mut counters = PROCESS_MEMORY_COUNTERS_EX2 {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32,
        ..Default::default()
    };
    unsafe {
        GetProcessMemoryInfo(
            process,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX2).cast(),
            counters.cb,
        )
    }
    .ok()
    .map(|()| counters.PrivateWorkingSetSize as u64)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupUsage {
    group: Group,
    cpu_percent: Option<f64>,
    private_working_set_bytes: Option<u64>,
}

pub(crate) fn measure() -> Result<Vec<GroupUsage>, String> {
    let processes = managed_processes(std::process::id()).map_err(|error| error.to_string())?;
    let processes: Vec<_> = processes
        .into_iter()
        .map(|(pid, group)| {
            let handle = unsafe {
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                    .map(|handle| Owned::new(handle))
            };
            (group, handle.ok())
        })
        .collect();
    let started = Instant::now();
    let initial: Vec<_> = processes
        .iter()
        .map(|(_, process)| process.as_ref().and_then(|handle| cpu_time(**handle).ok()))
        .collect();
    std::thread::sleep(Duration::from_millis(400));
    let elapsed = started.elapsed().as_secs_f64();
    let logical_cores = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) }.max(1);
    let cpu_scale = 100.0 / (10_000_000.0 * elapsed * f64::from(logical_cores));

    let mut totals = BTreeMap::new();
    for ((group, process), before) in processes.into_iter().zip(initial) {
        let row = totals.entry(group).or_insert(GroupUsage {
            group,
            cpu_percent: Some(0.0),
            private_working_set_bytes: Some(0),
        });
        let cpu = process.as_ref().and_then(|handle| cpu_time(**handle).ok());
        row.cpu_percent = row
            .cpu_percent
            .zip(before)
            .zip(cpu)
            .map(|((total, before), after)| {
                total + after.saturating_sub(before) as f64 * cpu_scale
            });

        let memory = process
            .as_ref()
            .and_then(|handle| private_working_set(**handle));
        row.private_working_set_bytes = row
            .private_working_set_bytes
            .zip(memory)
            .map(|(total, bytes)| total + bytes);
    }
    Ok(totals.into_values().collect())
}
