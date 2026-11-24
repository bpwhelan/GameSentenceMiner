use super::WebviewKind;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use webview2_com::{GetProcessExtendedInfosCompletedHandler, Microsoft::Web::WebView2::Win32::*};
use windows::core::{Interface, BOOL, PWSTR};
use windows::Win32::Foundation::HANDLE;

#[derive(Default)]
pub(super) struct Process {
    pub(super) kind: Option<WebviewKind>,
    pub(super) window_labels: Vec<String>,
}

fn renderer_frames(
    process: &ICoreWebView2ProcessExtendedInfo,
) -> windows::core::Result<(bool, Vec<u32>)> {
    unsafe {
        // The iterator refers to the collection's frame storage.
        let collection = process.AssociatedFrameInfos()?;
        let frames = collection.GetIterator()?;
        let mut current = BOOL::default();
        let mut extension = false;
        let mut top_frames = Vec::new();
        while frames.HasCurrent(&mut current).is_ok() && current.as_bool() {
            let frame = frames.GetCurrent()?;
            let mut source = PWSTR::null();
            if frame.Source(&mut source).is_ok() {
                extension |= webview2_com::take_pwstr(source).starts_with("chrome-extension://");
            }
            if let Ok(frame) = frame.cast::<ICoreWebView2FrameInfo2>() {
                let mut id = 0;
                if frame.FrameId(&mut id).is_ok() {
                    top_frames.push(id);
                }
                // An out-of-process iframe can carry its parent frame's window label.
                let mut parent = frame.ParentFrameInfo().ok();
                while let Some(frame) =
                    parent.and_then(|frame| frame.cast::<ICoreWebView2FrameInfo2>().ok())
                {
                    if frame.FrameId(&mut id).is_ok() {
                        top_frames.push(id);
                    }
                    parent = frame.ParentFrameInfo().ok();
                }
            }
            let mut next = BOOL::default();
            frames.MoveNext(&mut next)?;
        }
        Ok((extension, top_frames))
    }
}

type ProcessFrames = Vec<(u32, WebviewKind, Vec<u32>)>;

fn process_frames(
    list: ICoreWebView2ProcessExtendedInfoCollection,
) -> windows::core::Result<ProcessFrames> {
    unsafe {
        let mut count = 0;
        list.Count(&mut count)?;
        let mut rows = Vec::new();
        for index in 0..count {
            let process = list.GetValueAtIndex(index)?;
            let info = process.ProcessInfo()?;
            let (mut pid, mut kind) = (0, COREWEBVIEW2_PROCESS_KIND::default());
            info.ProcessId(&mut pid)?;
            info.Kind(&mut kind)?;
            if pid <= 0 {
                continue;
            }
            let (kind, frames) = match kind {
                COREWEBVIEW2_PROCESS_KIND_RENDERER => {
                    let (extension, frames) = renderer_frames(&process).unwrap_or_default();
                    (
                        if extension {
                            WebviewKind::Extension
                        } else {
                            WebviewKind::Renderer
                        },
                        frames,
                    )
                }
                COREWEBVIEW2_PROCESS_KIND_BROWSER => (WebviewKind::Browser, Vec::new()),
                COREWEBVIEW2_PROCESS_KIND_GPU => (WebviewKind::Gpu, Vec::new()),
                COREWEBVIEW2_PROCESS_KIND_UTILITY => (WebviewKind::Utility, Vec::new()),
                _ => (WebviewKind::Other, Vec::new()),
            };
            rows.push((pid as u32, kind, frames));
        }
        Ok(rows)
    }
}

pub(super) async fn processes(app: &AppHandle) -> BTreeMap<u32, Process> {
    let seen_browsers = Arc::new(Mutex::new(HashSet::new()));
    let snapshots = futures_util::future::join_all(app.webview_windows().into_iter().map(
        |(label, webview)| {
            let seen_browsers = seen_browsers.clone();
            let (controller_tx, controller_rx) = tokio::sync::oneshot::channel();
            let (processes_tx, processes_rx) = tokio::sync::oneshot::channel();
            let _ = webview.with_webview(move |view| unsafe {
                let _ = (|| -> windows::core::Result<()> {
                    let core = view.controller().CoreWebView2()?;
                    let mut browser_pid = 0;
                    core.BrowserProcessId(&mut browser_pid)?;
                    if browser_pid == 0 {
                        return Ok(());
                    }
                    let mut frame = 0;
                    if let Ok(core20) = core.cast::<ICoreWebView2_20>() {
                        let _ = core20.FrameId(&mut frame);
                    }
                    let _ = controller_tx.send((browser_pid, frame));
                    let environment = view.environment().cast::<ICoreWebView2Environment13>()?;
                    let mut seen = seen_browsers.lock().unwrap();
                    if !seen.contains(&browser_pid) {
                        let callback = GetProcessExtendedInfosCompletedHandler::create(Box::new(
                            move |status, list| {
                                let rows = status.ok().and_then(|()| process_frames(list?).ok());
                                let _ = processes_tx.send(rows);
                                Ok(())
                            },
                        ));
                        environment.GetProcessExtendedInfos(&callback)?;
                        seen.insert(browser_pid);
                    }
                    Ok(())
                })();
            });
            async move {
                let timeout = Duration::from_secs(1);
                let (controller, rows) = tokio::join!(
                    tokio::time::timeout(timeout, controller_rx),
                    tokio::time::timeout(timeout, processes_rx),
                );
                Some((
                    label,
                    controller.ok()?.ok()?,
                    rows.ok().and_then(Result::ok).flatten(),
                ))
            }
        },
    ))
    .await;

    let mut windows = HashMap::new();
    let mut processes = BTreeMap::new();
    for (label, (browser_pid, frame), _) in snapshots.iter().flatten() {
        processes.entry(*browser_pid).or_insert_with(|| Process {
            kind: Some(WebviewKind::Browser),
            window_labels: Vec::new(),
        });
        if *frame != 0 {
            windows.insert((*browser_pid, *frame), label);
        }
    }
    for (_, (browser_pid, _), rows) in snapshots.iter().flatten() {
        for (pid, kind, frames) in rows.iter().flatten() {
            let mut window_labels: Vec<_> = frames
                .iter()
                .filter_map(|frame| {
                    windows
                        .get(&(*browser_pid, *frame))
                        .map(|label| (*label).clone())
                })
                .collect();
            window_labels.sort_unstable();
            window_labels.dedup();
            processes.insert(
                *pid,
                Process {
                    kind: Some(*kind),
                    window_labels,
                },
            );
        }
    }
    processes
}

pub(super) fn classify(kind: Option<WebviewKind>, process: Option<HANDLE>) -> WebviewKind {
    match kind {
        Some(WebviewKind::Renderer) | None => process
            .and_then(process_command_line)
            .as_deref()
            .and_then(command_line_kind)
            .or(kind)
            .unwrap_or(WebviewKind::Other),
        Some(kind) => kind,
    }
}

fn command_line_kind(command: &str) -> Option<WebviewKind> {
    let args = crate::game_launcher::split_windows_command_line(command);
    if args
        .iter()
        .any(|arg| arg == "--extension-process" || arg == "--renderer-sub-type=extension")
    {
        return Some(WebviewKind::Extension);
    }
    args.iter().find_map(|arg| match arg.as_str() {
        "--type=renderer" => Some(WebviewKind::Renderer),
        "--type=gpu-process" => Some(WebviewKind::Gpu),
        "--type=utility" => Some(WebviewKind::Utility),
        _ => None,
    })
}

#[repr(C)]
struct ProcessCommandLine {
    length: u16,
    capacity: u16,
    buffer: *const u16,
}

#[link(name = "ntdll")]
extern "system" {
    fn NtQueryInformationProcess(
        process: HANDLE,
        class: u32,
        output: *mut std::ffi::c_void,
        size: u32,
        required: *mut u32,
    ) -> i32;
}

fn process_command_line(process: HANDLE) -> Option<String> {
    // WebView2 exposes active frames, so extension workers without frames need
    // the Chromium launch flag. Query only GSM's known WebView2 processes.
    const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
    let mut required = 0;
    unsafe {
        NtQueryInformationProcess(
            process,
            PROCESS_COMMAND_LINE_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut required,
        );
    }
    if !(std::mem::size_of::<ProcessCommandLine>() as u32..=128 * 1024).contains(&required) {
        return None;
    }
    let mut bytes = vec![0_usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
    let status = unsafe {
        NtQueryInformationProcess(
            process,
            PROCESS_COMMAND_LINE_INFORMATION,
            bytes.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    };
    if status < 0 {
        return None;
    }
    let line = unsafe { &*bytes.as_ptr().cast::<ProcessCommandLine>() };
    let offset = (line.buffer as usize).checked_sub(bytes.as_ptr() as usize)?;
    let length = usize::from(line.length);
    if offset % 2 != 0
        || length % 2 != 0
        || offset.checked_add(length)? > std::mem::size_of_val(bytes.as_slice())
    {
        return None;
    }
    let wide = unsafe {
        std::slice::from_raw_parts(
            bytes.as_ptr().cast::<u8>().add(offset).cast::<u16>(),
            length / 2,
        )
    };
    Some(String::from_utf16_lossy(wide))
}
