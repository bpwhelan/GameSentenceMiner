//! Windows dictionaries run as ordinary Chromium extensions in WebView2.
use serde_json::{json, Value};
use tauri::WebviewWindow;
use webview2_com::{
    BrowserExtensionEnableCompletedHandler, Microsoft::Web::WebView2::Win32::*,
    ProfileAddBrowserExtensionCompletedHandler, ProfileGetBrowserExtensionsCompletedHandler,
};
use windows::core::{Interface, HSTRING, PWSTR};

// Extension pages do not receive Tauri's page preload. Evaluate through the
// owning WebView2 controller instead of adding an IPC bridge to the extension.
pub async fn evaluate(window: &WebviewWindow, source: String) -> Result<Value, String> {
    let arguments = json!({"expression":format!("(async()=>{{\n{source}\n}})()"),"awaitPromise":true,"returnByValue":true,"userGesture":true});
    let result = devtools_command(window, "Runtime.evaluate", arguments).await?;
    if let Some(error) = result.get("exceptionDetails") {
        return Err(error["exception"]["description"].as_str().unwrap_or("Extension script failed").into());
    }
    Ok(result["result"]["value"].clone())
}

pub(crate) async fn devtools_command(window: &WebviewWindow, method: &'static str, arguments: Value) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.with_webview(move |view| unsafe {
        let sender=std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let completed=sender.clone();
        let result=(|| -> windows::core::Result<()> {
            let callback=webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status,response| {
                let result=status.map_err(|e|e.to_string())
                    .and_then(|_| serde_json::from_str(&response).map_err(|e|e.to_string()));
                if let Some(tx)=completed.lock().unwrap().take(){let _=tx.send(result);}Ok(())
            }));
            view.controller().CoreWebView2()?.CallDevToolsProtocolMethod(&HSTRING::from(method),&HSTRING::from(arguments.to_string()),&callback)
        })();
        if let Err(error)=result {if let Some(tx)=sender.lock().unwrap().take(){let _=tx.send(Err(error.to_string()));}}
    }).map_err(|e|e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(60), rx)
        .await
        .map_err(|_| "Extension script timed out".to_string())?
        .map_err(|e| e.to_string())?
}

pub async fn load(window: &WebviewWindow, directory: String) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.with_webview(move |view| unsafe {
        let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let completed = sender.clone();
        let result = (|| -> windows::core::Result<()> {
            let profile = view.controller().CoreWebView2()?.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile7>()?;
            let callback = ProfileAddBrowserExtensionCompletedHandler::create(Box::new(move |status, extension| {
                let result = (|| -> windows::core::Result<Value> {
                    status?;
                    let extension = extension.ok_or_else(|| windows::core::Error::from_hresult(windows::core::HRESULT(0x80004005u32 as i32)))?;
                    let mut id = PWSTR::null(); let mut name = PWSTR::null();
                    extension.Id(&mut id)?; extension.Name(&mut name)?;
                    Ok(json!({"id":webview2_com::take_pwstr(id),"name":webview2_com::take_pwstr(name)}))
                })().map_err(|e|e.to_string());
                if let Some(tx)=completed.lock().unwrap().take(){let _=tx.send(result);}
                Ok(())
            }));
            profile.AddBrowserExtension(&HSTRING::from(directory), &callback)
        })();
        if let Err(error)=result {if let Some(tx)=sender.lock().unwrap().take(){let _=tx.send(Err(error.to_string()));}}
    }).map_err(|e|e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(60), rx)
        .await
        .map_err(|_| "Browser extension did not finish loading".to_string())?
        .map_err(|e| e.to_string())?
}

pub async fn list(window: &WebviewWindow) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.with_webview(move |view| unsafe {
        let sender=std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));let completed=sender.clone();
        let result=(|| -> windows::core::Result<()> {
            let profile=view.controller().CoreWebView2()?.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile7>()?;
            let callback=ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |status,list| {
                let result=(|| -> windows::core::Result<Value> {
                    status?;let mut values=Vec::new();
                    if let Some(list)=list {let mut count=0;list.Count(&mut count)?;
                        for index in 0..count {let extension=list.GetValueAtIndex(index)?;let mut id=PWSTR::null();let mut name=PWSTR::null();let mut enabled=windows::core::BOOL::default();extension.Id(&mut id)?;extension.Name(&mut name)?;extension.IsEnabled(&mut enabled)?;
                            values.push(json!({"id":webview2_com::take_pwstr(id),"name":webview2_com::take_pwstr(name),"enabled":enabled.as_bool()}));}
                    }Ok(json!(values))
                })().map_err(|e|e.to_string());
                if let Some(tx)=completed.lock().unwrap().take(){let _=tx.send(result);}Ok(())
            }));profile.GetBrowserExtensions(&callback)
        })();
        if let Err(error)=result {if let Some(tx)=sender.lock().unwrap().take(){let _=tx.send(Err(error.to_string()));}}
    }).map_err(|e|e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| "Browser extension list timed out".to_string())?
        .map_err(|e| e.to_string())?
}

pub async fn enable(window: &WebviewWindow, id: String, enabled: bool) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |view| unsafe {
            let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
            let completed = sender.clone();
            let result = (|| -> windows::core::Result<()> {
                let profile = view
                    .controller()
                    .CoreWebView2()?
                    .cast::<ICoreWebView2_13>()?
                    .Profile()?
                    .cast::<ICoreWebView2Profile7>()?;
                let callback = ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(
                    move |status, list| {
                        let found =
                            (|| -> windows::core::Result<Option<ICoreWebView2BrowserExtension>> {
                                status?;
                                let Some(list) = list else { return Ok(None) };
                                let mut count = 0;
                                list.Count(&mut count)?;
                                for index in 0..count {
                                    let extension = list.GetValueAtIndex(index)?;
                                    let mut key = PWSTR::null();
                                    extension.Id(&mut key)?;
                                    if webview2_com::take_pwstr(key) == id {
                                        return Ok(Some(extension));
                                    }
                                }
                                Ok(None)
                            })();
                        let result = match found {
                            Ok(Some(extension)) => {
                                let done = completed.clone();
                                let callback = BrowserExtensionEnableCompletedHandler::create(
                                    Box::new(move |result| {
                                        if let Some(tx) = done.lock().unwrap().take() {
                                            let _ = tx.send(
                                                result
                                                    .map(|_| Value::Null)
                                                    .map_err(|e| e.to_string()),
                                            );
                                        }
                                        Ok(())
                                    }),
                                );
                                extension
                                    .Enable(enabled, &callback)
                                    .map_err(|e| e.to_string())
                            }
                            Ok(None) => Err("Browser extension is not installed".into()),
                            Err(error) => Err(error.to_string()),
                        };
                        if let Err(error) = result {
                            if let Some(tx) = completed.lock().unwrap().take() {
                                let _ = tx.send(Err(error));
                            }
                        }
                        Ok(())
                    },
                ));
                profile.GetBrowserExtensions(&callback)
            })();
            if let Err(error) = result {
                if let Some(tx) = sender.lock().unwrap().take() {
                    let _ = tx.send(Err(error.to_string()));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| "Browser extension did not respond".to_string())?
        .map_err(|e| e.to_string())?
}
