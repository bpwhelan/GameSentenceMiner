//! Share Jiten API requests from WebView2 extension pages/workers with the
//! overlay cache. Only the dedicated controller listens for service workers:
//! WebView2 broadcasts their requests to every matching view in the environment.
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use webview2_com::{Microsoft::Web::WebView2::Win32::*, WebResourceRequestedEventHandler};
use windows::{
    core::{Interface, HSTRING, PWSTR},
    Win32::{System::Com::IStream, UI::Shell::SHCreateMemStream},
};

type Pending = (
    ICoreWebView2Environment,
    ICoreWebView2WebResourceRequestedEventArgs,
    ICoreWebView2Deferral,
);
thread_local! { static PENDING: RefCell<HashMap<u64, Pending>> = RefCell::new(HashMap::new()); }
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

unsafe fn respond(
    environment: &ICoreWebView2Environment,
    args: &ICoreWebView2WebResourceRequestedEventArgs,
    status: i32,
    body: &[u8],
) {
    let stream = SHCreateMemStream(Some(body));
    let headers = HSTRING::from("Content-Type: application/json\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization, X-Api-Key, Accept, X-GSM-Request-Id\r\n");
    if let Ok(response) = environment.CreateWebResourceResponse(
        stream.as_ref(),
        status,
        &HSTRING::from(if status == 200 {
            "OK"
        } else {
            "Service Unavailable"
        }),
        &headers,
    ) {
        let _ = args.SetResponse(&response);
    }
}

pub fn install(app: &AppHandle, window: &WebviewWindow, workers: bool) -> Result<(), String> {
    let app = app.clone();
    window
        .with_webview(move |view| unsafe {
            let install = || -> windows::core::Result<()> {
                let webview = view.controller().CoreWebView2()?;
                let sources = if workers {
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL
                } else {
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT
                };
                let webview22 = webview.cast::<ICoreWebView2_22>()?;
                for filter in [
                    "http://*/reader/*",
                    "https://*/reader/*",
                    "http://*/srs/*",
                    "https://*/srs/*",
                    "http://*/set-card-sentence",
                    "https://*/set-card-sentence",
                ] {
                    webview22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                        &HSTRING::from(filter),
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                        sources,
                    )?;
                }
                let environment = view.environment();
                let mut token = 0;
                webview.add_WebResourceRequested(
                    &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let request = args.Request()?;
                        let mut raw = PWSTR::null();
                        request.Uri(&mut raw)?;
                        let url = webview2_com::take_pwstr(raw);
                        if crate::overlay_jiten::broker_route(&url).is_none() {
                            return Ok(());
                        }
                        let mut raw = PWSTR::null();
                        request.Method(&mut raw)?;
                        let method = webview2_com::take_pwstr(raw);
                        if !matches!(method.as_str(), "GET" | "POST" | "OPTIONS") {
                            return Ok(());
                        }
                        let headers = request.Headers()?;
                        let header = |name: &str| -> String {
                            let mut value = PWSTR::null();
                            if headers.GetHeader(&HSTRING::from(name), &mut value).is_ok() {
                                webview2_com::take_pwstr(value)
                            } else {
                                String::new()
                            }
                        };
                        let auth = header("Authorization");
                        let key = header("X-Api-Key");
                        let key = if !key.is_empty() {
                            key
                        } else if auth
                            .get(..7)
                            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("ApiKey "))
                        {
                            auth[7..].trim().to_owned()
                        } else {
                            return Ok(());
                        };
                        let request_id = header("X-GSM-Request-Id");
                        if method == "OPTIONS" {
                            respond(&environment, &args, 200, b"{}");
                            return Ok(());
                        }
                        if PENDING.with(|pending| pending.borrow().len() >= 128) {
                            respond(
                                &environment,
                                &args,
                                503,
                                br#"{"error_message":"Jiten request queue full"}"#,
                            );
                            return Ok(());
                        }
                        let mut body = Vec::new();
                        if let Ok(content) = request.Content() {
                            let stream: IStream = content.cast()?;
                            loop {
                                let mut buffer = [0u8; 8192];
                                let mut count = 0;
                                stream
                                    .Read(
                                        buffer.as_mut_ptr().cast(),
                                        buffer.len() as u32,
                                        Some(&mut count),
                                    )
                                    .ok()?;
                                if count == 0 {
                                    break;
                                }
                                body.extend_from_slice(&buffer[..count as usize]);
                                if body.len() > 1024 * 1024 {
                                    respond(
                                        &environment,
                                        &args,
                                        413,
                                        br#"{"error_message":"Jiten request body too large"}"#,
                                    );
                                    return Ok(());
                                }
                            }
                        }
                        let deferral = args.GetDeferral()?;
                        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
                        PENDING.with(|pending| {
                            pending
                                .borrow_mut()
                                .insert(id, (environment.clone(), args, deferral))
                        });
                        let cache = app
                            .state::<crate::overlay_host::OverlayHost>()
                            .jiten_cache(&app);
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let result = tokio::time::timeout(
                                std::time::Duration::from_secs(90),
                                cache.browser_request(
                                    &url,
                                    &method,
                                    &key,
                                    (!request_id.is_empty()).then_some(request_id.as_str()),
                                    &body,
                                ),
                            )
                            .await;
                            let (status, bytes) = match result {
                                Ok(Ok(value)) => (200, value.to_string().into_bytes()),
                                Ok(Err(error)) => (
                                    crate::overlay_jiten::browser_error_status(&error) as i32,
                                    br#"{"error_message":"Jiten request unavailable"}"#.to_vec(),
                                ),
                                _ => (
                                    503,
                                    br#"{"error_message":"Jiten request temporarily unavailable"}"#
                                        .to_vec(),
                                ),
                            };
                            let _ = app.run_on_main_thread(move || {
                                if let Some((environment, args, deferral)) =
                                    PENDING.with(|pending| pending.borrow_mut().remove(&id))
                                {
                                    respond(&environment, &args, status, &bytes);
                                    let _ = deferral.Complete();
                                }
                            });
                        });
                        Ok(())
                    })),
                    &mut token,
                )?;
                Ok(())
            };
            if let Err(error) = install() {
                eprintln!("[jiten] Could not install shared browser broker: {error}");
            }
        })
        .map_err(|e| e.to_string())
}
