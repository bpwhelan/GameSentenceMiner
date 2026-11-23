use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
pub(super) const HELPER: &str = "GSM Helper - DONT TOUCH";
pub(super) fn helper_source(scene: &str, source: &str) -> bool {
    scene.trim().eq_ignore_ascii_case(HELPER) || ["window_getter", "game_window_getter", "capture_card_getter", "audio_input_getter"]
        .iter().any(|name| source.trim().eq_ignore_ascii_case(name))
}
const PIPEWIRE: &[&str] = &[
    "pipewire-screen-capture-source",
    "pipewire-window-capture-source",
    "pipewire-desktop-capture-source",
];
fn switchable(kind: &str) -> bool {
    matches!(kind, "window_capture" | "game_capture")
}
pub(super) fn video(kind: &str) -> bool {
    switchable(kind)
        || matches!(kind, "monitor_capture" | "dshow_input" | "xcomposite_input")
        || PIPEWIRE.contains(&kind)
}
fn capture_item(items: &[Value], only_switchable: bool) -> Option<&Value> {
    items
        .iter()
        .filter(|i| {
            if only_switchable {
                switchable(text(i, "inputKind"))
            } else {
                video(text(i, "inputKind"))
            }
        })
        .max_by_key(|i| {
            (
                i["sceneItemEnabled"] != false,
                text(i, "inputKind") == "game_capture",
            )
        })
}
fn input(name: String, kind: &str, settings: Value) -> Value {
    json!({"inputName":name,"inputKind":kind,"inputSettings":settings,"sceneItemEnabled":true})
}
fn windows_video(name: &str, mode: &str, selector: &str) -> Value {
    if mode == "window_capture" {
        input(
            format!("{name} - Window Capture"),
            mode,
            json!({"window":selector,"mode":"window","cursor":false,"method":2}),
        )
    } else {
        input(
            format!("{name} - Game Capture"),
            mode,
            json!({"window":selector,"capture_mode":"window","capture_cursor":false}),
        )
    }
}
fn plan(name: &str, selection: &Value, platform: &str) -> Result<Vec<Value>, String> {
    if platform == "linux" {
        let kind = text(selection, "pipewireInputKind");
        if selection["targetKind"] == "wayland_pipewire" && PIPEWIRE.contains(&kind) {
            return Ok(vec![input(
                format!("{name} - Screen Capture (PipeWire)"),
                kind,
                json!({"ShowCursor":false}),
            )]);
        }
        let selector = selection["captureValues"]["xcomposite_input"]
            .as_str()
            .unwrap_or(text(selection, "value"));
        if !selector.contains('\n') {
            return Err("No OBS XComposite or PipeWire capture source was selected".into());
        }
        return Ok(vec![input(
            format!("{name} - XComposite Window Capture"),
            "xcomposite_input",
            json!({"capture_window":selector,"show_cursor":false,"include_border":false,"exclude_alpha":false}),
        )]);
    }
    if platform != "win32" {
        return Err("Automatic capture setup is supported on Windows and Linux".into());
    }
    if selection["targetKind"] == "monitor" {
        let monitor = text(selection, "monitorId");
        if monitor.is_empty() || monitor == "DUMMY" {
            return Err("No OBS monitor was selected".into());
        }
        return Ok(vec![
            input(
                format!("{name} - Monitor Capture"),
                "monitor_capture",
                json!({"monitor_id":monitor,"method":0,"capture_cursor":false}),
            ),
            input(
                format!("{name} - Desktop Audio"),
                "wasapi_output_capture",
                json!({"device_id":"default"}),
            ),
        ]);
    }
    if selection["targetKind"] == "capture_card" || selection["videoDeviceId"].is_string() {
        let device = text(selection, "videoDeviceId");
        if device.is_empty() {
            return Err("No OBS video capture device was selected".into());
        }
        let base = selection["title"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(name);
        let wasapi = text(selection, "wasapiInputDeviceId");
        let direct = text(selection, "audioDeviceId");
        let mut settings = json!({"video_device_id":device});
        if wasapi.is_empty() && !direct.is_empty() {
            settings["audio_device_id"] = json!(direct);
        }
        let mut inputs = vec![input(
            format!("{base} - Video Capture Device"),
            "dshow_input",
            settings,
        )];
        if !wasapi.is_empty() {
            inputs.push(input(
                format!("{base} - Capture Card Audio"),
                "wasapi_input_capture",
                json!({"device_id":wasapi}),
            ));
        }
        return Ok(inputs);
    }
    let fallback = text(selection, "value");
    let fallback = if fallback.contains(':') && !fallback.starts_with('[') {
        fallback
    } else {
        ""
    };
    let game = selection["captureValues"]["game_capture"]
        .as_str()
        .unwrap_or(fallback);
    let window = selection["captureValues"]["window_capture"]
        .as_str()
        .unwrap_or(fallback);
    let mode = selection["captureMode"]
        .as_str()
        .filter(|s| switchable(s))
        .unwrap_or(if game.is_empty() {
            "window_capture"
        } else {
            "game_capture"
        });
    let selector = if mode == "game_capture" { game } else { window };
    if selector.is_empty() {
        return Err(format!("No OBS {mode} source was available for {name}"));
    }
    let audio = if window.is_empty() { game } else { window };
    Ok(vec![
        windows_video(name, mode, selector),
        input(
            format!("{name} - Audio Capture"),
            "wasapi_process_output_capture",
            json!({"window":audio}),
        ),
    ])
}
fn decode(selector: &str) -> String {
    selector.replace("#3A", ":").replace("#22", "#")
}
pub(super) fn selector_parts(selector: &str) -> (String, String, String) {
    let mut parts = selector.rsplitn(3, ':');
    let exe = parts.next().unwrap_or("");
    let class = parts.next().unwrap_or("");
    let title = parts.next().unwrap_or("");
    (decode(title), decode(class), decode(exe))
}
pub(super) fn game_info(title: &str) -> (String, String) {
    const MATCHERS: &[(&str, &str)] = &[
        (
            r"(?i)^(?:Eden|yuzu|suyu|Lichii)\b[^|]*\|\s*(?:[^|]*\|\s*)*([^|]+?)\s*\((?:64|32)-bit\)(?:\s*\||$)",
            r"(?:Eden|yuzu|suyu|Lichii)[^|]*\|.*{}.*\((?:64|32)-bit\).*",
        ),
        (r"(?i)^Vita3K.*?\|\s*(.+?)\s*\(", r"Vita3K.*?\|.*{}.*\(.*"),
        (
            r"(?i)^(?:Eden|yuzu|suyu|Lichii)\s*\|\s*v[\d.]+\s*\|\s*(.+?)\s*(?:\(64-bit\)|\(32-bit\)|\||$)",
            r"(?:Eden|yuzu|suyu|Lichii).*\|.*?\|.*{}.*",
        ),
        (
            r"(?i)^FPS:.*\|\s*([^|]+?)\s*\[\w+\]$",
            r"FPS:.*\|.*{}.*\[\w+\]",
        ),
        (
            r"(?i)^Cemu.*?\[TitleId:[^\]]+\]\s*(.+?)(?:\s*\[|$)",
            r"Cemu.*{}.*",
        ),
        (
            r"(?i)^Dolphin.*?\|\s*([^|]+?)\s*\([A-Z0-9]{6}\)$",
            r"Dolphin.*?\|.*{}.*\([A-Z0-9]{6}\)",
        ),
        (r"(?i)^PPSSPP.*?-[A-Z0-9\s]+:\s*(.+)$", r"PPSSPP.*?:.*{}"),
        (
            r"(?i)^(?:Azahar|Citra|Lime3DS|Mandarine|DeSmuME).*?\|\s*(.+?)$",
            r"(?:Azahar|Citra|Lime3DS|Mandarine|DeSmuME).*?\|.*{}",
        ),
        (
            r"(?i)^(?:mGBA|Flycast|Mesen)\s*-\s*(.+?)(?:\s*[\(\[].*|$)",
            r"(?:mGBA|Flycast|Mesen).*-.*{}.*",
        ),
        (
            r"(?i)^(.+?)(?:\s*[\(\[].*?)?\s*-\s*(?:VisualBoyAdvance|Project64|Snes9x|Rosalie's Mupen)",
            r"{}.*-.*(?:VisualBoyAdvance|Project64|Snes9x|Rosalie's Mupen).*",
        ),
        (r"(?i)^(.+?)\s*(?:-|)\s*ver\d", r"{}.*"),
        (
            r"(?i)^(.+?)\s+(?:プロローグ|エピローグ|体験版|デモ版|demo)",
            r".*{}.*",
        ),
    ];
    for (pattern, template) in MATCHERS {
        if let Some(capture) = regex::Regex::new(pattern).unwrap().captures(title) {
            let name = capture[1].trim();
            if !name.is_empty() {
                return (name.into(), template.replace("{}", &regex::escape(name)));
            }
        }
    }
    let name = title
        .split('|')
        .next()
        .unwrap_or(title)
        .split(" - ")
        .next()
        .unwrap_or(title)
        .trim();
    let name = if name.is_empty() { title.trim() } else { name };
    (name.into(), format!(".*{}.*", regex::escape(name)))
}
fn device_score(left: &str, right: &str) -> usize {
    let tokens = |s: &str| {
        s.to_lowercase()
            .replace("microphone (", "")
            .replace("digital audio interface (", "")
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|s| s.len() >= 3)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let a = tokens(left);
    let b = tokens(right);
    let ac = a.join("");
    let bc = b.join("");
    if ac.is_empty() || bc.is_empty() {
        0
    } else if ac == bc {
        500
    } else if ac.contains(&bc) || bc.contains(&ac) {
        300
    } else {
        let shared = a.iter().filter(|t| b.contains(t)).count();
        if shared >= 2 {
            shared * 100
        } else {
            0
        }
    }
}
impl Obs {
    pub(super) async fn scenes(&self, app: &tauri::AppHandle) -> Result<Vec<Value>, String> {
        let list = self.call(app, "GetSceneList", json!({})).await?;
        let scenes = list["scenes"]
            .as_array()
            .ok_or("OBS returned no scene list")?;
        Ok(scenes
            .iter()
            .filter(|s| !text(s, "sceneName").eq_ignore_ascii_case(HELPER))
            .map(|s| json!({"name":s["sceneName"],"id":s["sceneUuid"]}))
            .collect())
    }
    pub(crate) async fn current_scene(&self, app: &tauri::AppHandle) -> Result<Value, String> {
        let v = self.call(app, "GetCurrentProgramScene", json!({})).await?;
        Ok(json!({
            "name": v.get("currentProgramSceneName").unwrap_or(&v["sceneName"]),
            "id": v.get("currentProgramSceneUuid").unwrap_or(&v["sceneUuid"]),
        }))
    }
    pub(super) async fn items(
        &self,
        app: &tauri::AppHandle,
        id: &str,
    ) -> Result<Vec<Value>, String> {
        self.items_by_selector(app, json!({"sceneUuid":id})).await
    }
    pub(super) async fn items_by_selector(
        &self,
        app: &tauri::AppHandle,
        selector: Value,
    ) -> Result<Vec<Value>, String> {
        self.call(app, "GetSceneItemList", selector).await?["sceneItems"]
            .as_array()
            .cloned()
            .ok_or("OBS returned no scene items".into())
    }
    pub(super) async fn input_settings(
        &self,
        app: &tauri::AppHandle,
        item: &Value,
    ) -> Result<Value, String> {
        let selector = if item["sourceUuid"].is_string() {
            json!({"inputUuid":item["sourceUuid"]})
        } else {
            json!({"inputName":item["sourceName"]})
        };
        Ok(self.call(app, "GetInputSettings", selector).await?["inputSettings"].clone())
    }
    async fn upsert_input(
        &self,
        app: &tauri::AppHandle,
        scene: &str,
        input: Value,
    ) -> Result<(), String> {
        let name = text(&input, "inputName");
        match self
            .call(app, "GetInputSettings", json!({"inputName":name}))
            .await
        {
            Err(error) if error.ends_with("(600)") => {
                let mut create = input;
                create["sceneName"] = json!(scene);
                self.call(app, "CreateInput", create).await?;
                return Ok(());
            }
            Err(error) => return Err(error),
            Ok(_) => {}
        }
        self.call(
            app,
            "SetInputSettings",
            json!({"inputName":name,"inputSettings":input["inputSettings"],"overlay":false}),
        )
        .await?;
        match self
            .call(
                app,
                "GetSceneItemId",
                json!({"sceneName":scene,"sourceName":name}),
            )
            .await
        {
            Ok(value) => {
                self.call(app,"SetSceneItemEnabled",json!({"sceneName":scene,"sceneItemId":value["sceneItemId"],"sceneItemEnabled":input["sceneItemEnabled"]})).await?;
            }
            Err(error) if error.ends_with("(600)") => {
                self.call(app,"CreateSceneItem",json!({"sceneName":scene,"sourceName":name,"sceneItemEnabled":input["sceneItemEnabled"]})).await?;
            }
            Err(error) => return Err(error),
        }
        Ok(())
    }
    pub(super) async fn fit(&self, app: &tauri::AppHandle, id: &str) -> Result<Vec<Value>, String> {
        let video = self.call(app, "GetVideoSettings", json!({})).await?;
        let items = self.items(app, id).await?;
        if video["baseWidth"].as_u64().unwrap_or(0) > 0
            && video["baseHeight"].as_u64().unwrap_or(0) > 0
        {
            for item in &items {
                let desired = json!({"boundsType":"OBS_BOUNDS_SCALE_INNER","alignment":5,"boundsWidth":video["baseWidth"],"boundsHeight":video["baseHeight"],"positionX":0,"positionY":0});
                let current = &item["sceneItemTransform"];
                if desired.as_object().unwrap().iter().all(|(key, value)| {
                    current[key] == *value
                        || value
                            .as_f64()
                            .is_some_and(|v| current[key].as_f64() == Some(v))
                }) {
                    continue;
                }
                self.call(app,"SetSceneItemTransform",json!({"sceneUuid":id,"sceneItemId":item["sceneItemId"],"sceneItemTransform":desired})).await?;
            }
        }
        Ok(items)
    }
    async fn create_scene(
        &self,
        app: &tauri::AppHandle,
        selection: Value,
    ) -> Result<Value, String> {
        let _guard = self.0.scene_edit.lock().await;
        let title = text(&selection, "title").trim();
        let (suggested, pattern) = game_info(title);
        let requested = text(&selection, "sceneName").trim();
        let kind = text(&selection, "targetKind");
        let name = if !requested.is_empty() {
            requested.to_owned()
        } else if kind.is_empty() || kind == "window" {
            suggested
        } else {
            title.to_owned()
        };
        let name = if name.is_empty() {
            format!("Scene-{}", chrono::Utc::now().timestamp())
        } else {
            name
        };
        let inputs = plan(
            &name,
            &selection,
            if cfg!(windows) {
                "win32"
            } else if cfg!(target_os = "linux") {
                "linux"
            } else {
                "darwin"
            },
        )?;
        let created = self
            .call(app, "CreateScene", json!({"sceneName":name}))
            .await;
        let id = match created {
            Ok(scene) => text(&scene, "sceneUuid").to_owned(),
            Err(error) if error.ends_with("(601)") => {
                let list = self.scenes(app).await?;
                let scene = list
                    .iter()
                    .find(|s| s["name"] == name)
                    .ok_or("Existing scene disappeared")?;
                let id = text(scene, "id").to_owned();
                for item in self.items(app, &id).await? {
                    self.call(
                        app,
                        "RemoveSceneItem",
                        json!({"sceneUuid":id,"sceneItemId":item["sceneItemId"]}),
                    )
                    .await?;
                }
                id
            }
            Err(error) => return Err(error),
        };
        for input in &inputs {
            self.upsert_input(app, &name, input.clone()).await?;
        }
        self.expect_scene(&id);
        self.call(app, "SetCurrentProgramScene", json!({"sceneUuid":id}))
            .await?;
        if kind == "monitor" {
            self.fit(app, &id).await?;
        }
        if cfg!(windows) && (kind.is_empty() || kind == "window") {
            let collection = self.collection(app).await?;
            let selector = inputs
                .first()
                .map(|v| text(&v["inputSettings"], "window"))
                .unwrap_or("");
            let (_, _, executable) = selector_parts(selector);
            self.save_rule(&collection,json!({"sceneUuid":id,"sceneName":name,"titlePattern":pattern,"executableName":executable,"enabled":true,"source":"gsm-generated"}),false)?;
        } else {
            self.remove_rule(&id)?;
        }
        if kind == "wayland_pipewire" {
            rfd::AsyncMessageDialog::new().set_title("Wayland Capture Setup").set_description("In OBS, open the new Screen Capture (PipeWire) source's Properties, click Open Selector, and select the game window.").show().await;
        }
        if kind == "capture_card" {
            let paired =
                inputs.len() > 1 || inputs[0]["inputSettings"]["audio_device_id"].is_string();
            rfd::AsyncMessageDialog::new().set_title("Capture Card Scene Created").set_description(if paired{"Audio was paired automatically with this capture device. Capture-card scenes do not get automatic window-title switching rules."}else{"Audio was not auto-detected. Add audio in the source properties or using an Audio Input Capture source. Capture-card scenes do not get automatic window-title switching rules."}).show().await;
        }
        self.emit(app, "scene-switcher.stateChanged", Value::Null);
        Ok(Value::Null)
    }
    pub(super) async fn source_identity(
        &self,
        app: &tauri::AppHandle,
        id: &str,
    ) -> Result<(String, String), String> {
        let mut items = self.items(app, id).await?;
        items.sort_by_key(|i| !video(text(i, "inputKind")));
        for item in items {
            let settings = self.input_settings(app, &item).await?;
            let selector = text(&settings, "window");
            if !selector.is_empty() {
                let (mut title, _, exe) = selector_parts(selector);
                if let Ok(properties) = self
                    .call(
                        app,
                        "GetInputPropertiesListPropertyItems",
                        json!({"inputName":item["sourceName"],"propertyName":"window"}),
                    )
                    .await
                {
                    if let Some(found) = properties["propertyItems"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|p| p["itemValue"] == selector)
                    {
                        let name = text(found, "itemName");
                        title = name
                            .split_once(':')
                            .map(|(_, t)| t.trim())
                            .unwrap_or(name)
                            .into();
                    }
                }
                return Ok((title, exe));
            }
            let capture = text(&settings, "capture_window");
            if !capture.is_empty() {
                let parts: Vec<_> = capture.lines().map(str::trim).collect();
                return Ok((
                    parts.get(1).copied().unwrap_or("").into(),
                    parts.get(2).copied().unwrap_or("").into(),
                ));
            }
        }
        Ok((String::new(), String::new()))
    }
    pub(super) async fn screenshot(
        &self,
        app: &tauri::AppHandle,
        name: &str,
        width: u32,
        height: u32,
    ) -> Result<Value, String> {
        Ok(self.call(app,"GetSourceScreenshot",json!({"sourceName":name,"imageFormat":if width==8{"png"}else{"jpg"},"imageWidth":width,"imageHeight":height})).await?["imageData"].clone())
    }
    async fn preview(&self, app: &tauri::AppHandle, id: &str) -> Result<Value, String> {
        let scene = if id.is_empty() {
            self.current_scene(app).await?
        } else {
            self.scenes(app)
                .await?
                .into_iter()
                .find(|s| s["id"] == id)
                .ok_or("OBS scene no longer exists")?
        };
        let items = self.fit(app, text(&scene, "id")).await?;
        let item = capture_item(&items, false);
        let source = item.map(|v| text(v, "sourceName"));
        let image = match self.screenshot(app, text(&scene, "name"), 960, 540).await {
            Ok(v) => v,
            Err(error) => {
                if let Some(source) = source {
                    self.screenshot(app, source, 960, 540).await?
                } else {
                    return Err(error);
                }
            }
        };
        Ok(
            json!({"sceneName":scene["name"],"sceneId":scene["id"],"sourceName":source,"captureMode":item.filter(|i|switchable(text(i,"inputKind"))).map(|i|text(i,"inputKind")),"imageData":image}),
        )
    }
    pub(super) async fn cleanup_helpers(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let _guard = self.0.probe.lock().await;
        let items = match self
            .call(app, "GetSceneItemList", json!({"sceneName":HELPER}))
            .await
        {
            Ok(value) => value["sceneItems"].as_array().cloned().unwrap_or_default(),
            Err(error) if error.ends_with("(600)") => vec![],
            Err(error) => return Err(error),
        };
        for item in items {
            if [
                "window_getter",
                "game_window_getter",
                "monitor_getter",
                "capture_card_getter",
                "audio_input_getter",
            ]
            .contains(&text(&item, "sourceName"))
            {
                self.call(app,"SetSceneItemEnabled",json!({"sceneName":HELPER,"sceneItemId":item["sceneItemId"],"sceneItemEnabled":false})).await?;
                self.call(app, "RemoveInput", json!({"inputName":item["sourceName"]}))
                    .await?;
            }
        }
        self.0.state.lock().unwrap().probes_clean = true;
        Ok(())
    }
    async fn probe_property(
        &self,
        app: &tauri::AppHandle,
        name: &str,
        kind: &str,
        property: &str,
        created: &mut Vec<String>,
    ) -> Result<Vec<Value>, String> {
        match self
            .call(app, "GetInputSettings", json!({"inputName":name}))
            .await
        {
            Err(error) if error.ends_with("(600)") => {
                match self
                    .call(app, "CreateScene", json!({"sceneName":HELPER}))
                    .await
                {
                    Ok(_) => {}
                    Err(e) if e.ends_with("(601)") => {}
                    Err(e) => return Err(e),
                }
                self.call(app,"CreateInput",json!({"sceneName":HELPER,"inputName":name,"inputKind":kind,"inputSettings":{},"sceneItemEnabled":false})).await?;
                created.push(name.into());
            }
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        let items = self
            .call(app, "GetSceneItemList", json!({"sceneName":HELPER}))
            .await?;
        for item in items["sceneItems"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|i| i["sourceName"] == name && i["sceneItemEnabled"] != false)
        {
            self.call(app,"SetSceneItemEnabled",json!({"sceneName":HELPER,"sceneItemId":item["sceneItemId"],"sceneItemEnabled":false})).await?;
        }
        Ok(self
            .call(
                app,
                "GetInputPropertiesListPropertyItems",
                json!({"inputName":name,"propertyName":property}),
            )
            .await?["propertyItems"]
            .as_array()
            .cloned()
            .unwrap_or_default())
    }
    async fn devices(&self, app: &tauri::AppHandle, options: Value) -> Result<Value, String> {
        if !cfg!(windows) || !self.0.client.has_primary() {
            return Ok(json!([]));
        }
        let _guard = self.0.probe.lock().await;
        {
            let state = self.0.state.lock().unwrap();
            if options["refresh"] != true {
                if let Some((at, devices)) = &state.devices {
                    if at.elapsed() < Duration::from_secs(30) {
                        return Ok(devices.clone());
                    }
                }
            }
        }
        let enabled = self.0.state.lock().unwrap().probe_enabled;
        let mut created = vec![];
        let result:Result<Value,String>=async {
            let monitors=self.probe_property(app,"monitor_getter","monitor_capture","monitor_id",&mut created).await?;
            let mut options:Vec<Value>=monitors.into_iter().filter(|m|m["itemEnabled"]!=false && !text(m,"itemValue").is_empty() && m["itemValue"]!="DUMMY").map(|m|json!({"title":m["itemName"],"value":json!(["monitor",m["itemValue"]]).to_string(),"targetKind":"monitor","monitorId":m["itemValue"]})).collect();
            if enabled {
                let videos=self.probe_property(app,"capture_card_getter","dshow_input","video_device_id",&mut created).await?;
                let direct=self.probe_property(app,"capture_card_getter","dshow_input","audio_device_id",&mut created).await?;
                let audio=self.probe_property(app,"audio_input_getter","wasapi_input_capture","device_id",&mut created).await?;
                for video in videos {let title=text(&video,"itemName");if title.to_lowercase().contains("virtual camera")||title.eq_ignore_ascii_case("screen-capture-recorder"){continue;}
                    let best=|devices:&[Value]|devices.iter().filter(|d|d["itemValue"]!="default").filter_map(|d|{let score=device_score(title,text(d,"itemName"));(score>0).then_some((score,d["itemValue"].clone()))}).max_by_key(|(score,_)|*score).map(|(_,v)|v);
                    options.push(json!({"title":title,"value":json!(["capture_card",video["itemValue"]]).to_string(),"targetKind":"capture_card","videoDeviceId":video["itemValue"],"audioDeviceId":best(&direct),"wasapiInputDeviceId":best(&audio)}));
                }
            }
            options.sort_by(|a,b|text(a,"title").cmp(text(b,"title")));Ok(json!(options))
        }.await;
        // Release all probes created by this query even when enumeration fails.
        for name in created {
            let _ = self
                .call(app, "RemoveInput", json!({"inputName":name}))
                .await;
        }
        if let Ok(data) = &result {
            self.0.state.lock().unwrap().devices = Some((Instant::now(), data.clone()));
        }
        result
    }
    async fn windows(&self, app: &tauri::AppHandle) -> Result<Value, String> {
        if cfg!(target_os = "linux")
            && (std::env::var_os("WAYLAND_DISPLAY").is_some()
                || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland"))
        {
            let kinds = self.call(app, "GetInputKindList", json!({})).await?;
            let available = kinds["inputKinds"].as_array().cloned().unwrap_or_default();
            return Ok(json!(PIPEWIRE.iter().find(|kind|available.iter().any(|v|v.as_str()==Some(**kind))).map(|kind|vec![json!({"title":"Screen Capture (PipeWire)","value":format!("pipewire:{kind}"),"targetKind":"wayland_pipewire","pipewireInputKind":kind})]).unwrap_or_default()));
        }
        let windows = tauri::async_runtime::spawn_blocking(crate::capture_windows::list)
            .await
            .map_err(err)??;
        let mut options = vec![];
        for window in windows {
            let window = serde_json::to_value(window).map_err(err)?;
            let title = text(&window, "title");
            let class = text(&window, "windowClass");
            let path = text(&window, "processPath");
            let exe = path.rsplit(['\\', '/']).next().unwrap_or("");
            let encode = |s: &str| s.replace('#', "#22").replace(':', "#3A");
            let selector = if cfg!(windows) {
                format!("{}:{}:{}", encode(title), encode(class), encode(exe))
            } else {
                // xcap IDs are X11 XIDs on X11; they are not portal tokens.
                let id = text(&window, "id").split(':').nth(1).unwrap_or("");
                format!("{id}\r\n{title}\r\n{class}")
            };
            let captures = if cfg!(windows) {
                json!({"window_capture":selector,"game_capture":selector})
            } else {
                json!({"xcomposite_input":selector})
            };
            options.push(json!({"title":title,"value":selector,"targetKind":"window","captureValues":captures,"suggestedSceneName":game_info(title).0,"captureSource":window,"lastFocusedAt":window["lastFocusedAt"]}));
        }
        let devices = self.devices(app, json!({})).await.unwrap_or(json!([]));
        options.extend(devices.as_array().into_iter().flatten().cloned());
        Ok(json!(options))
    }
    pub(super) async fn scene_command(
        &self,
        app: &tauri::AppHandle,
        channel: &str,
        arg: Value,
    ) -> Result<Value, String> {
        let id = arg.as_str().unwrap_or("");
        match channel {
            "obs.getScenes" => Ok(json!(self.scenes(app).await?)),
            "obs.getActiveScene" => Ok(self
                .current_scene(app)
                .await
                .unwrap_or_else(|_| json!({"name":"","id":""}))),
            "obs.getCollection" => Ok(json!(self.collection(app).await?)),
            "obs.switchScene" | "obs.switchScene.id" => {
                if id.trim().is_empty() {
                    return Err("A scene name or UUID is required".into());
                }
                self.call(
                    app,
                    "SetCurrentProgramScene",
                    if channel.ends_with(".id") {
                        json!({"sceneUuid":id})
                    } else {
                        json!({"sceneName":id})
                    },
                )
                .await?;
                Ok(Value::Null)
            }
            "obs.saveReplay" => {
                self.save_replay(app).await?;
                Ok(Value::Null)
            }
            "obs.startRecording" => {
                let _lifecycle = self
                    .0
                    .lifecycle
                    .try_read()
                    .map_err(|_| "OBS is changing its runtime")?;
                if self.0.suspended.load(Ordering::SeqCst) {
                    return Err("OBS is being updated or closed".into());
                }
                let _recording = self.0.recording.lock().await;
                self.call(app, "StartRecord", json!({})).await?;
                Ok(Value::Null)
            }
            "obs.createScene" | "obs.createScene.Game" => self.create_scene(app, arg).await,
            "obs.renameScene" => {
                let id = text(&arg, "sceneUuid").trim();
                let name = text(&arg, "newSceneName").trim();
                if id.is_empty() || name.is_empty() {
                    return Err("A scene UUID and name are required".into());
                }
                self.call(
                    app,
                    "SetSceneName",
                    json!({"sceneUuid":id,"newSceneName":name}),
                )
                .await?;
                self.rename_rule(id, name)?;
                Ok(Value::Null)
            }
            "obs.removeScene" => {
                let answer = rfd::AsyncMessageDialog::new()
                    .set_title("Confirm Scene Removal")
                    .set_description("Are you sure you want to remove this scene?")
                    .set_buttons(rfd::MessageButtons::YesNo)
                    .show()
                    .await;
                if answer != rfd::MessageDialogResult::Yes {
                    return Ok(json!({"success":false,"canceled":true}));
                }
                self.call(app, "RemoveScene", json!({"sceneUuid":id}))
                    .await?;
                self.remove_rule(id)?;
                Ok(json!({"success":true}))
            }
            "obs.getSceneCaptureMode" => {
                let items = self.items(app, id).await?;
                Ok(json!(
                    capture_item(&items, true).map(|i| text(i, "inputKind"))
                ))
            }
            "obs.getScenePreviewSnapshot" => self.preview(app, id).await,
            "obs.switchSceneCaptureMode" => {
                let _guard = self.0.scene_edit.lock().await;
                let id = text(&arg, "sceneUuid");
                let mode = text(&arg, "targetMode");
                if !cfg!(windows) || !switchable(mode) {
                    return Err("Unsupported capture mode".into());
                }
                let scene = self
                    .scenes(app)
                    .await?
                    .into_iter()
                    .find(|s| s["id"] == id)
                    .ok_or("OBS scene no longer exists")?;
                let items = self.items(app, id).await?;
                let item = capture_item(&items, true).ok_or("No window capture source in scene")?;
                let settings = self.input_settings(app, item).await?;
                let selector = text(&settings, "window");
                if selector.is_empty() {
                    return Err("Capture source has no window selector".into());
                }
                self.upsert_input(
                    app,
                    text(&scene, "name"),
                    windows_video(text(&scene, "name"), mode, selector),
                )
                .await?;
                for item in items
                    .iter()
                    .filter(|i| switchable(text(i, "inputKind")) && i["inputKind"] != mode)
                {
                    self.call(
                        app,
                        "RemoveSceneItem",
                        json!({"sceneUuid":id,"sceneItemId":item["sceneItemId"]}),
                    )
                    .await?;
                }
                Ok(json!(mode))
            }
            "obs.getSceneActiveWindow" => {
                let scene = self.current_scene(app).await?;
                Ok(json!(
                    self.source_identity(app, text(&scene, "id")).await?.0
                ))
            }
            "obs.getExecutableNameFromSource" => Ok(self
                .source_identity(app, id)
                .await
                .ok()
                .map(|(_, exe)| json!(exe))
                .unwrap_or(Value::Null)),
            "obs.getWindowTitleFromSource" => Ok(self
                .source_identity(app, id)
                .await
                .ok()
                .map(|(title, _)| json!(title))
                .unwrap_or(Value::Null)),
            "obs.sceneHasVisibleOutput" => {
                let output: Result<Value, String> = async {
                    let data = self.screenshot(app, text(&arg, "name"), 8, 8).await?;
                    let raw = data.as_str().unwrap_or("");
                    if raw.is_empty() {
                        return Ok(json!(false));
                    }
                    let bytes = STANDARD
                        .decode(raw.split_once(',').map(|(_, s)| s).unwrap_or(raw))
                        .map_err(err)?;
                    let image = image::load_from_memory(&bytes).map_err(err)?.to_rgba8();
                    let mut pixels = image.pixels();
                    let first = pixels.next();
                    Ok(json!(pixels.any(|p| Some(p) != first)))
                }
                .await;
                Ok(output.unwrap_or(Value::Null))
            }
            "obs.getWindows" => self.windows(app).await,
            "obs.getCaptureDevices" => self.devices(app, arg).await,
            "obs.getWindowPreviews" => Ok(json!([])), // Native picker passes explicit window identities to capture.getWindowPreviews.
            "obs.getCaptureCardProbeEnabled" => {
                Ok(json!(self.0.state.lock().unwrap().probe_enabled))
            }
            "obs.setCaptureCardProbeEnabled" => {
                let enabled = arg
                    .as_bool()
                    .ok_or("Capture probe setting must be boolean")?;
                let _guard = self.0.probe.lock().await;
                {
                    let mut state = self.0.state.lock().unwrap();
                    state.probe_enabled = enabled;
                    state.devices = None;
                }
                if !enabled && self.0.client.has_primary() {
                    for name in ["capture_card_getter", "audio_input_getter"] {
                        let _ = self
                            .call(app, "RemoveInput", json!({"inputName":name}))
                            .await;
                    }
                }
                Ok(json!(enabled))
            }
            _ => Err(format!("Unknown native OBS command: {channel}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_mode_and_process_audio_preserve_selectors() {
        let p=plan("Game",&json!({"captureMode":"window_capture","captureValues":{"game_capture":"game:C:g.exe","window_capture":"window:C:g.exe"}}),"win32").unwrap();
        assert_eq!(p[0]["inputKind"], "window_capture");
        assert_eq!(p[0]["inputSettings"]["method"], 2);
        assert_eq!(p[1]["inputSettings"]["window"], "window:C:g.exe");
    }
    #[test]
    fn invalid_capture_selection_is_rejected_before_creating_scenes() {
        assert!(plan(
            "Game",
            &json!({"targetKind":"monitor","monitorId":"DUMMY"}),
            "win32"
        )
        .is_err());
        assert!(plan("Game", &json!({}), "win32").is_err());
    }
    #[test]
    fn monitor_gets_desktop_audio() {
        let p = plan(
            "Screen",
            &json!({"targetKind":"monitor","monitorId":"display1"}),
            "win32",
        )
        .unwrap();
        assert_eq!(p[0]["inputSettings"]["monitor_id"], "display1");
        assert_eq!(p[1]["inputKind"], "wasapi_output_capture");
    }
    #[test]
    fn capture_card_prefers_paired_wasapi_without_duplicating_audio() {
        let p=plan("Card",&json!({"targetKind":"capture_card","videoDeviceId":"v","audioDeviceId":"dshow","wasapiInputDeviceId":"wasapi"}),"win32").unwrap();
        assert_eq!(p.len(), 2);
        assert!(p[0]["inputSettings"]["audio_device_id"].is_null());
        assert_eq!(p[1]["inputSettings"]["device_id"], "wasapi");
    }
    #[test]
    fn linux_x11_and_portal_plans_keep_platform_specific_options() {
        let p = plan(
            "Game",
            &json!({"value":"123\r\nNineSols\r\nsteam_app_1809540"}),
            "linux",
        )
        .unwrap();
        assert_eq!(p[0]["inputKind"], "xcomposite_input");
        assert_eq!(p[0]["inputSettings"]["show_cursor"], false);
        let p = plan(
            "Game",
            &json!({"targetKind":"wayland_pipewire","pipewireInputKind":PIPEWIRE[0]}),
            "linux",
        )
        .unwrap();
        assert_eq!(p[0]["inputSettings"]["ShowCursor"], false);
    }
    #[test]
    fn obs_escaped_title_round_trip() {
        assert_eq!(
            selector_parts("A#3AB#22C:Class:game.exe"),
            ("A:B#C".into(), "Class".into(), "game.exe".into())
        );
    }
    #[test]
    fn title_rules_tolerate_emulator_version_changes() {
        for title in [
            "Lichii | v0.0.4 | MSVC 19.44 | ANONYMOUS;CODE (64-bit) | 1.0.0 | NVIDIA",
            "Lichii | v0.0.4 | ANONYMOUS;CODE | 1.0.0",
        ] {
            let (name, pattern) = game_info(title);
            assert_eq!(name, "ANONYMOUS;CODE");
            assert!(regress::Regex::with_flags(&pattern, "i")
                .unwrap()
                .find(&title.replace("v0.0.4", "v0.0.5"))
                .is_some());
        }
    }
    #[test]
    fn capture_card_audio_pairing_requires_meaningful_name_match() {
        assert_eq!(
            device_score("Elgato HD60 S", "Microphone (Elgato HD60 S)"),
            500
        );
        assert_eq!(device_score("USB Video", "Built-in Microphone"), 0);
    }
    #[test]
    fn previews_prefer_enabled_game_capture() {
        let items = vec![
            json!({"inputKind":"game_capture","sceneItemEnabled":false}),
            json!({"inputKind":"window_capture","sceneItemEnabled":true}),
        ];
        assert_eq!(
            capture_item(&items, true).unwrap()["inputKind"],
            "window_capture"
        );
    }
}
