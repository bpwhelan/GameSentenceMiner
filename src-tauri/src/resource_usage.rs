mod webview;

use gsm_overlay::engines::ModelUsageSnapshot;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
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

fn process_memory(process: HANDLE) -> Option<(u64, u64)> {
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
    .map(|()| {
        (
            counters.PrivateWorkingSetSize as u64,
            counters.PrivateUsage as u64,
        )
    })
}

/// Private working set of the GSM desktop process, used to attribute model load deltas.
pub(crate) fn current_process_private_working_set() -> Option<u64> {
    let process = unsafe { windows::Win32::System::Threading::GetCurrentProcess() };
    process_memory(process).map(|(resident, _)| resident)
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum WebviewKind {
    Browser,
    Gpu,
    Renderer,
    Extension,
    Utility,
    Other,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebviewUsage {
    pid: u32,
    kind: WebviewKind,
    window_labels: Vec<String>,
    #[serde(flatten)]
    usage: ProcessUsage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupUsage {
    group: Group,
    #[serde(flatten)]
    usage: ProcessUsage,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    processes: Vec<WebviewUsage>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessUsage {
    cpu_percent: Option<f64>,
    private_working_set_bytes: Option<u64>,
    private_commit_bytes: Option<u64>,
}

#[derive(Deserialize, Serialize)]
struct ExtensionUsage {
    id: String,
    name: String,
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct ResourceUsage {
    groups: Vec<GroupUsage>,
    models: Vec<ModelUsageSnapshot>,
    extensions: Option<Vec<ExtensionUsage>>,
}

fn measure_groups(
    mut webviews: BTreeMap<u32, webview::Process>,
) -> Result<Vec<GroupUsage>, String> {
    let mut processes = managed_processes(std::process::id()).map_err(|error| error.to_string())?;
    for &pid in webviews.keys() {
        processes.entry(pid).or_insert(Group::Webview);
    }
    let processes: Vec<_> = processes
        .into_iter()
        .map(|(pid, group)| {
            let handle = unsafe {
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                    .map(|handle| Owned::new(handle))
            };
            (pid, group, handle.ok())
        })
        .collect();
    let started = Instant::now();
    let initial: Vec<_> = processes
        .iter()
        .map(|(_, _, process)| process.as_ref().and_then(|handle| cpu_time(**handle).ok()))
        .collect();
    std::thread::sleep(Duration::from_millis(400));
    let elapsed = started.elapsed().as_secs_f64();
    let logical_cores = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) }.max(1);
    let cpu_scale = 100.0 / (10_000_000.0 * elapsed * f64::from(logical_cores));

    let mut totals = BTreeMap::new();
    for ((pid, group, process), before) in processes.into_iter().zip(initial) {
        let row = totals.entry(group).or_insert(GroupUsage {
            group,
            usage: ProcessUsage {
                cpu_percent: Some(0.0),
                private_working_set_bytes: Some(0),
                private_commit_bytes: Some(0),
            },
            processes: Vec::new(),
        });
        let cpu = process.as_ref().and_then(|handle| cpu_time(**handle).ok());
        let memory = process.as_ref().and_then(|handle| process_memory(**handle));
        let usage = ProcessUsage {
            cpu_percent: before
                .zip(cpu)
                .map(|(before, after)| after.saturating_sub(before) as f64 * cpu_scale),
            private_working_set_bytes: memory.map(|(resident, _)| resident),
            private_commit_bytes: memory.map(|(_, commit)| commit),
        };
        row.usage.cpu_percent = row
            .usage
            .cpu_percent
            .zip(usage.cpu_percent)
            .map(|(total, value)| total + value);
        row.usage.private_working_set_bytes = row
            .usage
            .private_working_set_bytes
            .zip(usage.private_working_set_bytes)
            .map(|(total, value)| total + value);
        row.usage.private_commit_bytes = row
            .usage
            .private_commit_bytes
            .zip(usage.private_commit_bytes)
            .map(|(total, value)| total + value);

        if group == Group::Webview {
            let metadata = webviews.remove(&pid).unwrap_or_default();
            let kind = webview::classify(metadata.kind, process.as_deref().copied());
            row.processes.push(WebviewUsage {
                pid,
                kind,
                window_labels: metadata.window_labels,
                usage,
            });
        }
    }
    Ok(totals.into_values().collect())
}

async fn installed_extensions(app: &AppHandle) -> Option<Vec<ExtensionUsage>> {
    let controller = app.get_webview_window(crate::dictionary_host::EXTENSION_CONTROLLER_LABEL)?;
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        crate::browser_extensions::list(&controller),
    )
    .await
    .ok()?
    .ok()?;
    let mut extensions: Vec<ExtensionUsage> = serde_json::from_value(result).ok()?;
    for extension in &mut extensions {
        if crate::dictionary_host::extension_kind(&extension.name) == "hachidori" {
            extension.kind = Some("hachidori".into());
        }
    }
    extensions.sort_by(|a, b| a.name.cmp(&b.name));
    Some(extensions)
}

fn loaded_models(app: &AppHandle) -> Vec<ModelUsageSnapshot> {
    let mut models = gsm_overlay::engines::loaded_models_snapshot();
    if let Some(service) = app.try_state::<std::sync::Arc<crate::mining::MiningService>>() {
        models.extend(
            service
                .vad
                .loaded_models_snapshot()
                .into_iter()
                .map(|model| ModelUsageSnapshot {
                    id: model.id.to_owned(),
                    category: "vad",
                    name: model.name.to_owned(),
                    detail: None,
                    instances: 1,
                    file_bytes: model.file_bytes,
                    estimated_ram_bytes: model.estimated_ram_bytes,
                    idle_seconds: model.idle_seconds,
                    unloads_on_idle: true,
                    storage: "ram",
                }),
        );
    }
    if let Some(model) = app
        .try_state::<std::sync::Arc<gsm_sudachi::LanguageService>>()
        .and_then(|service| service.memory_snapshot())
        .filter(|snapshot| snapshot.loaded)
    {
        models.push(ModelUsageSnapshot {
            id: "sudachi".into(),
            category: "dictionary",
            name: "Sudachi".into(),
            detail: Some(model.edition),
            instances: 1,
            file_bytes: model.file_bytes,
            estimated_ram_bytes: model.estimated_ram_bytes,
            idle_seconds: model.idle_seconds.unwrap_or_default(),
            unloads_on_idle: true,
            storage: model.storage,
        });
    }
    models
}

pub(crate) async fn measure(app: &AppHandle) -> Result<ResourceUsage, String> {
    let groups = async {
        let webviews = webview::processes(app).await;
        tauri::async_runtime::spawn_blocking(move || measure_groups(webviews))
            .await
            .map_err(|error| error.to_string())?
    };
    let (groups, extensions) = tokio::join!(groups, installed_extensions(app));
    Ok(ResourceUsage {
        groups: groups?,
        models: loaded_models(app),
        extensions,
    })
}
