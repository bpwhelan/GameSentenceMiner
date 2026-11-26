use super::*;
use std::fs;
#[derive(Default)]
pub(super) struct Switcher {
    pub collection: String,
    pub connected_at: Option<Instant>,
    foreground: Value,
    rules_present: Option<(String, std::time::SystemTime, bool)>,
    manual_hold: String,
    resolved_context: String,
    expected: Option<(String, Instant)>,
    conflict: Value,
}
fn context(snapshot: &Value) -> String {
    json!([snapshot["hwnd"], snapshot["title"]]).to_string()
}
impl Switcher {
    fn update_foreground(&mut self, snapshot: Value) -> bool {
        if snapshot["capturedAt"].as_i64().unwrap_or(0)
            < self.foreground["capturedAt"].as_i64().unwrap_or(0)
        {
            return false;
        }
        let changed = context(&snapshot) != context(&self.foreground);
        self.foreground = snapshot;
        if changed {
            self.manual_hold.clear();
            self.resolved_context.clear();
            self.conflict = Value::Null;
        }
        changed
    }

    fn can_auto_switch(&self, foreground: &Value) -> bool {
        let key = context(foreground);
        key == context(&self.foreground) && key != self.manual_hold && key != self.resolved_context
    }
}
fn executable(raw: &str) -> String {
    raw.trim()
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}
fn validate(pattern: &str) -> Result<regress::Regex, String> {
    if pattern.trim().is_empty() {
        return Err("A window title regular expression is required".into());
    }
    if pattern.len() > 4096 {
        return Err("The window title regular expression is too long".into());
    }
    regress::Regex::with_flags(pattern, "i").map_err(err)
}
fn matches(rule: &Value, foreground: &Value) -> Value {
    let regex = match validate(text(rule, "titlePattern")) {
        Ok(r) => r,
        Err(error) => return json!({"matched":false,"executableVerified":false,"error":error}),
    };
    if rule["enabled"] != true || regex.find(text(foreground, "title")).is_none() {
        return json!({"matched":false,"executableVerified":false});
    }
    let needed = executable(text(rule, "executableName"));
    let actual = executable(
        foreground["executableName"]
            .as_str()
            .unwrap_or(text(foreground, "executablePath")),
    );
    json!({"matched":needed.is_empty() || actual.is_empty() || needed==actual,"executableVerified":!needed.is_empty() && !actual.is_empty()})
}
fn collections(data: &mut Value) -> &mut Vec<Value> {
    if !data["windowSceneSwitcher"].is_object() {
        data["windowSceneSwitcher"] = json!({"schemaVersion":1,"collections":[]});
    }
    if !data["windowSceneSwitcher"]["collections"].is_array() {
        data["windowSceneSwitcher"]["collections"] = json!([]);
    }
    data["windowSceneSwitcher"]["collections"]
        .as_array_mut()
        .unwrap()
}
fn collection_mut<'a>(data: &'a mut Value, name: &str) -> &'a mut Value {
    let list = collections(data);
    let index=list.iter().position(|c|c["collectionName"]==name).unwrap_or_else(||{list.push(json!({"collectionName":name,"collectionFileName":format!("{}.json",name.replace(' ',"_")),"migrationVersion":1,"legacySwitcherDisabled":true,"rules":[]}));list.len()-1});
    &mut list[index]
}
fn legacy_rules(data: &Value) -> Vec<Value> {
    let mut rules: Vec<Value> = vec![];
    let sources = data["sources"].as_array().cloned().unwrap_or_default();
    for legacy in data["modules"]["auto-scene-switcher"]["switches"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let name = text(legacy, "scene");
        let pattern = text(legacy, "window_title");
        if name.trim().is_empty() || pattern.trim().is_empty() {
            continue;
        }
        let Some(scene) = sources
            .iter()
            .find(|s| s["name"] == name && s["id"] == "scene" && s["uuid"].is_string())
        else {
            continue;
        };
        if let Some(existing) = rules.iter_mut().find(|r| r["sceneUuid"] == scene["uuid"]) {
            let joined = format!("(?:{})|(?:{})", text(existing, "titlePattern"), pattern);
            existing["titlePattern"] = json!(joined);
            existing["enabled"] = json!(validate(&joined).is_ok());
            continue;
        }
        let exe = scene["settings"]["items"]
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|i| {
                let source = sources.iter().find(|s| s["name"] == i["name"])?;
                let selector = source["settings"]["window"].as_str()?;
                Some(scenes::selector_parts(selector).2)
            });
        rules.push(json!({"sceneUuid":scene["uuid"],"sceneName":name,"titlePattern":pattern,"executableName":exe,"enabled":validate(pattern).is_ok(),"source":"obs-migration"}));
    }
    rules
}
impl Obs {
    pub(super) fn migration_pending(&self, paths: &config::Paths) -> Result<bool, String> {
        let directory = paths.obs().join("basic/scenes");
        if !cfg!(windows) || !directory.exists() {
            return Ok(false);
        }
        for entry in fs::read_dir(directory).map_err(err)? {
            let file = entry.map_err(err)?.path();
            if file.extension().is_some_and(|e| e == "json")
                && config::read_json(&file)?["modules"]["auto-scene-switcher"]["active"] == true
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub(super) fn migrate(&self, paths: &config::Paths) -> Result<(), String> {
        let _lock = config::SETTINGS_LOCK.lock().unwrap();
        if !cfg!(windows) {
            return Ok(());
        }
        let directory = paths.obs().join("basic/scenes");
        if !directory.exists() {
            return Ok(());
        }
        let mut settings = config::read_json(&paths.desktop())?;
        for entry in fs::read_dir(directory).map_err(err)? {
            let file = entry.map_err(err)?.path();
            if !file.extension().is_some_and(|e| e == "json") {
                continue;
            }
            let mut data = config::read_json(&file)?;
            let name = text(&data, "name").trim().to_owned();
            if name.is_empty() {
                continue;
            }
            let existing = collections(&mut settings).iter().any(|c| {
                c["collectionName"] == name && c["migrationVersion"].as_u64().unwrap_or(0) >= 1
            });
            let collection = collection_mut(&mut settings, &name);
            collection["collectionFileName"] = json!(file.file_name().unwrap().to_string_lossy());
            if !existing {
                collection["rules"] = json!(legacy_rules(&data));
            }
            collection["migrationVersion"] = json!(1);
            collection["legacySwitcherDisabled"] =
                json!(data["modules"]["auto-scene-switcher"]["active"] != true);
            // Store imported rules durably before disabling the previous switcher.
            config::write_json(&paths.desktop(), &settings)?;
            if data["modules"]["auto-scene-switcher"]["active"] == true {
                data["modules"]["auto-scene-switcher"]["active"] = json!(false);
                config::write_json(&file, &data)?;
            }
            collection_mut(&mut settings, &name)["legacySwitcherDisabled"] = json!(true);
            config::write_json(&paths.desktop(), &settings)?;
        }
        Ok(())
    }
    pub(super) fn save_rule(
        &self,
        collection: &str,
        mut rule: Value,
        manual: bool,
    ) -> Result<Value, String> {
        let _lock = config::SETTINGS_LOCK.lock().unwrap();
        if collection.is_empty()
            || text(&rule, "sceneUuid").trim().is_empty()
            || text(&rule, "sceneName").trim().is_empty()
        {
            return Err("A current OBS scene collection and scene are required".into());
        }
        validate(text(&rule, "titlePattern"))?;
        for key in ["sceneUuid", "sceneName", "titlePattern"] {
            rule[key] = json!(text(&rule, key).trim());
        }
        rule["executableName"] = json!(executable(text(&rule, "executableName")));
        if manual {
            rule["source"] = json!("manual");
        }
        let paths = self.paths()?;
        let mut data = config::read_json(&paths.desktop())?;
        let collection = collection_mut(&mut data, collection);
        if !collection["rules"].is_array() {
            collection["rules"] = json!([]);
        }
        let rules = collection["rules"].as_array_mut().unwrap();
        if let Some(existing) = rules
            .iter_mut()
            .find(|r| r["sceneUuid"] == rule["sceneUuid"])
        {
            if manual || existing["source"] != "manual" {
                *existing = rule.clone();
            }
        } else {
            rules.push(rule.clone());
        }
        config::write_json(&paths.desktop(), &data)?;
        let mut s = self.0.state.lock().unwrap();
        s.switcher.manual_hold.clear();
        s.switcher.resolved_context.clear();
        Ok(rule)
    }
    pub(super) fn remove_rule(&self, id: &str) -> Result<(), String> {
        self.edit_rules(id, None)
    }
    pub(super) fn rename_rule(&self, id: &str, name: &str) -> Result<(), String> {
        self.edit_rules(id, Some(name))
    }
    fn edit_rules(&self, id: &str, name: Option<&str>) -> Result<(), String> {
        let _lock = config::SETTINGS_LOCK.lock().unwrap();
        let paths = self.paths()?;
        let mut data = config::read_json(&paths.desktop())?;
        for collection in collections(&mut data) {
            if let Some(rules) = collection["rules"].as_array_mut() {
                if let Some(name) = name {
                    for rule in rules.iter_mut().filter(|r| r["sceneUuid"] == id) {
                        rule["sceneName"] = json!(name);
                    }
                } else {
                    rules.retain(|r| r["sceneUuid"] != id);
                }
            }
        }
        config::write_json(&paths.desktop(), &data)
    }
    pub(super) async fn collection(&self, app: &tauri::AppHandle) -> Result<String, String> {
        let value = self.call(app, "GetSceneCollectionList", json!({})).await?;
        let name = text(&value, "currentSceneCollectionName").trim();
        self.0.state.lock().unwrap().switcher.collection = name.into();
        Ok(name.into())
    }
    pub(super) fn expect_scene(&self, id: &str) {
        self.0.state.lock().unwrap().switcher.expected = Some((id.into(), Instant::now()));
    }
    pub(super) fn scene_event(&self, app: &tauri::AppHandle, data: &Value) {
        {
            let mut state = self.0.state.lock().unwrap();
            let s = &mut state.switcher;
            let expected = s.expected.as_ref().is_some_and(|(id, at)| {
                data["sceneUuid"] == id.as_str() && at.elapsed() < Duration::from_secs(3)
            });
            if expected {
                s.expected = None;
            } else if s
                .connected_at
                .is_some_and(|t| t.elapsed() > Duration::from_secs(2))
                && !s.foreground.is_null()
            {
                s.manual_hold = context(&s.foreground);
            }
        }
        self.emit(
            app,
            "obs.sceneChanged",
            json!({"name":data["sceneName"],"id":data["sceneUuid"]}),
        );
    }
    pub fn foreground(&self, app: &tauri::AppHandle, snapshot: Value) {
        if snapshot["pid"].as_u64() == Some(std::process::id() as u64)
            || !snapshot["hwnd"].is_string()
            || !snapshot["title"].is_string()
        {
            return;
        }
        crate::capture_windows::record_focus(&snapshot);
        let (fg_pid, fg_exe, title) = {
            let mut state = self.0.state.lock().unwrap();
            let s = &mut state.switcher;
            if !s.update_foreground(snapshot) {
                return;
            }
            let pid = s.foreground["pid"]
                .as_u64()
                .and_then(|p| u32::try_from(p).ok());
            let exe = s.foreground["executableName"].as_str().map(str::to_owned);
            (pid, exe, text(&s.foreground, "title").to_owned())
        };
        if let Some(window) = app.get_webview_window("obs-scene-conflict") {
            let _ = window.destroy();
        }
        self.0.scene_switch_requested.notify_one();
        crate::auto_launcher::notify_foreground_changed(
            app,
            fg_exe.as_deref().unwrap_or(""),
            &title,
        );
        crate::game_privileges::handle_foreground(app, fg_pid, fg_exe.as_deref());
        #[cfg(windows)]
        if let Some(pid) = fg_pid {
            crate::obs::game_audio::focus(app, pid);
        }
        self.emit(app, "scene-switcher.stateChanged", Value::Null);
    }
    #[cfg(windows)]
    pub(super) async fn run_scene_switcher(self, app: tauri::AppHandle) {
        loop {
            // One worker serializes OBS requests. A focus change during a request
            // leaves a permit for the latest window. Idle checks reconcile rule edits and retries.
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                self.0.scene_switch_requested.notified(),
            )
            .await;
            if self.0.shutting_down.load(Ordering::Acquire) {
                return;
            }
            if !self.0.client.has_primary()
                || self.0.suspended.load(Ordering::SeqCst)
                || self.0.updating.load(Ordering::SeqCst)
            {
                continue;
            }
            if let Err(error) = self.evaluate_scene_switch(&app).await {
                crate::desktop_log::warn(&app, "obs", format!("Scene switcher: {error}"));
            }
        }
    }
    #[cfg(windows)]
    async fn evaluate_scene_switch(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let (foreground, needs_collection) = {
            let state = self.0.state.lock().unwrap();
            let s = &state.switcher;
            if s.foreground.is_null() {
                return Ok(());
            }
            (s.foreground.clone(), s.collection.is_empty())
        };
        if needs_collection {
            self.collection(app).await?;
        }
        let name = self.0.state.lock().unwrap().switcher.collection.clone();
        let path = self.paths()?.desktop();
        let modified = fs::metadata(&path).and_then(|m| m.modified()).ok();
        let cached = self
            .0
            .state
            .lock()
            .unwrap()
            .switcher
            .rules_present
            .as_ref()
            .filter(|(collection, time, _)| collection == &name && Some(*time) == modified)
            .map(|(_, _, present)| *present);
        let present = match cached {
            Some(present) => present,
            None => {
                let _guard = config::SETTINGS_LOCK.lock().unwrap();
                let mut data = config::read_json(&path)?;
                let present = collections(&mut data).iter().any(|c| {
                    c["collectionName"] == name
                        && c["legacySwitcherDisabled"] == true
                        && c["rules"].as_array().is_some_and(|rules| !rules.is_empty())
                });
                self.0.state.lock().unwrap().switcher.rules_present =
                    modified.map(|m| (name.clone(), m, present));
                present
            }
        };
        if !present {
            return Ok(());
        }
        let scenes = self.scenes(app).await?;
        let rules = {
            let _settings_lock = config::SETTINGS_LOCK.lock().unwrap();
            let paths = self.paths()?;
            let mut data = config::read_json(&paths.desktop())?;
            let Some(collection) = collections(&mut data)
                .iter_mut()
                .find(|c| c["collectionName"] == name)
            else {
                return Ok(());
            };
            if collection["legacySwitcherDisabled"] != true {
                return Ok(());
            }
            // Only a successful, well-formed query may remove missing scenes from saved rules.
            let old = collection["rules"].clone();
            let mut rules = old.as_array().cloned().unwrap_or_default();
            rules.retain_mut(|r| {
                if let Some(scene) = scenes.iter().find(|s| s["id"] == r["sceneUuid"]) {
                    r["sceneName"] = scene["name"].clone();
                    true
                } else {
                    false
                }
            });
            collection["rules"] = json!(rules);
            if old != collection["rules"] {
                config::write_json(&paths.desktop(), &data)?;
                self.emit(app, "scene-switcher.stateChanged", Value::Null);
            }
            rules
        };
        let mut candidates: Vec<Value> = vec![];
        for rule in rules {
            let result = matches(&rule, &foreground);
            if result["matched"] == true
                && !candidates
                    .iter()
                    .any(|c| c["sceneUuid"] == rule["sceneUuid"])
            {
                let mut rule = rule;
                rule["executableVerified"] = result["executableVerified"].clone();
                candidates.push(rule);
            }
        }
        if candidates.len() > 1 {
            let conflict = json!({"requestId":uuid::Uuid::new_v4().to_string(),"foreground":foreground,"candidates":candidates});
            {
                let mut state = self.0.state.lock().unwrap();
                if !state.switcher.conflict.is_null()
                    || !state.switcher.can_auto_switch(&foreground)
                {
                    return Ok(());
                }
                state.switcher.conflict = conflict;
            }
            self.show_conflict(app)?;
        } else if let Some(candidate) = candidates.first() {
            if !self
                .0
                .state
                .lock()
                .unwrap()
                .switcher
                .can_auto_switch(&foreground)
            {
                return Ok(());
            }
            self.switch_for_foreground(app, text(candidate, "sceneUuid"), &foreground)
                .await?;
        }
        Ok(())
    }
    async fn switch_for_foreground(
        &self,
        app: &tauri::AppHandle,
        id: &str,
        foreground: &Value,
    ) -> Result<(), String> {
        let current = self.current_scene(app).await?;
        if current["id"] == id {
            return Ok(());
        }
        if process::foreground().is_some_and(|actual| context(&actual) != context(foreground)) {
            return Ok(());
        }
        if context(&self.0.state.lock().unwrap().switcher.foreground) != context(foreground) {
            return Ok(());
        }
        if self.0.suspended.load(Ordering::SeqCst) || self.0.updating.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.expect_scene(id);
        self.call(app, "SetCurrentProgramScene", json!({"sceneUuid":id}))
            .await?;
        Ok(())
    }
    fn show_conflict(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let desktop = app.state::<crate::desktop_state::DesktopState>();
        let label = "obs-scene-conflict";
        if app.get_webview_window(label).is_some() {
            return Ok(());
        }
        let url = desktop.assets.url(&format!(
            "{}/renderer/index.html?window=scene-switcher-picker",
            crate::assets::origin()
        ))?;
        let token = desktop.register_window(label, "desktop");
        let preload = crate::overlay_preload::render_desktop_window_preload(
            &token,
            Some(&crate::desktop_state::theme_for_app(app)),
        );
        let profile = crate::dictionary_host::overlay_data_path(app);
        fs::create_dir_all(&profile).map_err(err)?;
        let builder = crate::dictionary_host::apply_shared_webview_options(
            tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::External(url))
                .title("GameSentenceMiner")
                .inner_size(800., 500.)
                .min_inner_size(800., 500.)
                .always_on_top(true)
                .initialization_script(preload),
        );
        let window = crate::dictionary_host::apply_profile_data_directory(builder, &profile)?
            .build()
            .map_err(err)?;
        let controller = self.clone();
        let event_app = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let foreground = {
                    let mut state = controller.0.state.lock().unwrap();
                    let s = &mut state.switcher;
                    let old = s.conflict["foreground"].clone();
                    if !old.is_null() {
                        s.resolved_context = context(&old);
                        s.conflict = Value::Null;
                    }
                    old
                };
                if !foreground.is_null() {
                    process::restore(text(&foreground, "hwnd"));
                }
                if let Some(desktop) = event_app.try_state::<crate::desktop_state::DesktopState>() {
                    desktop.unregister_window(label);
                }
            }
        });
        Ok(())
    }
    pub(super) async fn switcher_command(
        &self,
        app: &tauri::AppHandle,
        channel: &str,
        arg: Value,
    ) -> Result<Value, String> {
        match channel {
            "scene-switcher.getState" => {
                if self.0.client.has_primary()
                    && self.0.state.lock().unwrap().switcher.collection.is_empty()
                {
                    let _ = self.collection(app).await;
                }
                let paths = self.paths()?;
                let data = config::read_json(&paths.desktop())?;
                let state = self.0.state.lock().unwrap();
                let s = &state.switcher;
                let collection = data["windowSceneSwitcher"]["collections"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|c| c["collectionName"] == s.collection);
                let rule = collection
                    .and_then(|c| c["rules"].as_array())
                    .into_iter()
                    .flatten()
                    .find(|r| r["sceneUuid"] == arg);
                Ok(
                    json!({"supported":cfg!(windows),"hookStatus":if cfg!(windows){"running"}else{"unsupported"},"obsConnected":self.0.client.has_primary(),"collectionName":s.collection,"migrationReady":collection.is_some_and(|c|c["legacySwitcherDisabled"]==true),"rule":rule,"foreground":s.foreground}),
                )
            }
            "scene-switcher.saveRule" => {
                let result = match self.collection(app).await {
                    Ok(name) => self.save_rule(&name, arg, true),
                    Err(error) => Err(error),
                };
                self.emit(app, "scene-switcher.stateChanged", Value::Null);
                Ok(match result {
                    Ok(rule) => json!({"success":true,"rule":rule}),
                    Err(error) => json!({"success":false,"error":error}),
                })
            }
            "scene-switcher.removeRule" => {
                self.remove_rule(arg.as_str().unwrap_or(""))?;
                self.emit(app, "scene-switcher.stateChanged", Value::Null);
                Ok(json!({"success":true}))
            }
            "scene-switcher.suggestRule" => {
                let (title, exe) = self
                    .source_identity(app, arg.as_str().unwrap_or(""))
                    .await?;
                if title.is_empty() {
                    Ok(Value::Null)
                } else {
                    Ok(json!({"titlePattern":scenes::game_info(&title).1,"executableName":exe}))
                }
            }
            "scene-switcher.matchSceneRules" => {
                let settings = self.settings()?;
                let rules: Vec<_> = settings["windowSceneSwitcher"]["collections"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .flat_map(|c| c["rules"].as_array().into_iter().flatten())
                    .filter(|r| r["sceneUuid"] == arg["sceneUuid"] && r["enabled"] == true)
                    .collect();
                if rules.is_empty() {
                    Ok(Value::Null)
                } else {
                    Ok(json!(
                        rules
                            .iter()
                            .any(|r| matches(r, &arg["foreground"])["matched"] == true)
                    ))
                }
            }
            "scene-switcher.testRule" => {
                let foreground = self.0.state.lock().unwrap().switcher.foreground.clone();
                let mut rule = arg;
                rule["enabled"] = json!(true);
                let mut result = matches(&rule, &foreground);
                result["foreground"] = foreground;
                Ok(result)
            }
            "scene-switcher.getPendingConflict" => {
                Ok(self.0.state.lock().unwrap().switcher.conflict.clone())
            }
            "scene-switcher.resolveConflict" => {
                let conflict = self.0.state.lock().unwrap().switcher.conflict.clone();
                let id = text(&arg, "sceneUuid");
                if conflict.is_null()
                    || conflict["requestId"] != arg["requestId"]
                    || (!id.is_empty()
                        && !conflict["candidates"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|c| c["sceneUuid"] == id))
                {
                    return Ok(json!({"success":false,"stale":true}));
                }
                if !id.is_empty() {
                    self.switch_for_foreground(app, id, &conflict["foreground"])
                        .await?;
                }
                {
                    let mut state = self.0.state.lock().unwrap();
                    state.switcher.resolved_context = context(&conflict["foreground"]);
                    state.switcher.conflict = Value::Null;
                }
                if let Some(window) = app.get_webview_window("obs-scene-conflict") {
                    let _ = window.destroy();
                }
                process::restore(text(&conflict["foreground"], "hwnd"));
                Ok(json!({"success":true}))
            }
            _ => Err(format!("Unknown native scene-switcher command: {channel}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rapid_focus_changes_replace_pending_matches_and_preserve_manual_holds_on_duplicates() {
        let mut s = Switcher::default();
        let first = json!({"hwnd":"1","title":"Game A","capturedAt":100});
        let next = json!({"hwnd":"2","title":"Game B","capturedAt":101});
        assert!(s.update_foreground(first.clone()));
        s.manual_hold = context(&first);
        assert!(!s.update_foreground(first.clone()));
        assert!(!s.can_auto_switch(&first));
        assert!(s.update_foreground(next.clone()));
        assert!(!s.update_foreground(first.clone()));
        assert!(!s.can_auto_switch(&first));
        assert!(s.can_auto_switch(&next));
    }

    #[test]
    fn javascript_lookaround_and_executable_matching_survive_migration() {
        let rule = json!({"titlePattern":"(?<=prefix )日本語(?= -)","executableName":"C:\\Games\\game.exe","enabled":true});
        assert_eq!(
            matches(
                &rule,
                &json!({"title":"prefix 日本語 - chapter","executableName":"GAME.EXE"})
            ),
            json!({"matched":true,"executableVerified":true})
        );
        assert_eq!(
            matches(
                &rule,
                &json!({"title":"prefix 日本語 - chapter","executableName":"other.exe"})
            )["matched"],
            false
        );
        assert_eq!(
            matches(&rule, &json!({"title":"prefix 日本語 - chapter"}))["executableVerified"],
            false
        );
    }
    #[test]
    fn invalid_or_disabled_rules_never_switch() {
        assert!(validate("(").is_err());
        assert!(validate("").is_err());
        assert_eq!(
            matches(
                &json!({"titlePattern":"Game","enabled":false}),
                &json!({"title":"Game"})
            )["matched"],
            false
        );
    }
    #[test]
    fn legacy_import_combines_patterns_by_stable_scene_identity() {
        let data = json!({"sources":[{"id":"scene","uuid":"game","name":"Game","settings":{"items":[{"name":"Capture"}]}},{"name":"Capture","settings":{"window":"Title:Class:game.exe"}}],"modules":{"auto-scene-switcher":{"active":true,"switches":[{"scene":"Game","window_title":"Title"},{"scene":"Game","window_title":"Other"}]}}});
        let rules = legacy_rules(&data);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0]["sceneUuid"], "game");
        assert_eq!(rules[0]["executableName"], "game.exe");
        assert_eq!(rules[0]["titlePattern"], "(?:Title)|(?:Other)");
    }
    #[test]
    fn metadata_enrichment_does_not_clear_manual_hold_context() {
        assert_eq!(
            context(&json!({"hwnd":"123","title":"Game"})),
            context(&json!({"hwnd":"123","title":"Game","executableName":"game.exe"}))
        );
    }
}
