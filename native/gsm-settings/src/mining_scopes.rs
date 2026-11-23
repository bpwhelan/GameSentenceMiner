//! Own the scope of mining settings. Existing consumers read fully resolved
//! profiles from config.json. Globals, inheritance and those projections commit
//! together under the same file lock.
use crate::{read_object, with_lock, write_atomic, Result, MINING_DEFAULTS};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::LazyLock};

mod schema;
use schema::{available_options, editable, range, validate_value, Scope, FIELDS};

const LAYERS: &str = "profile_layers";

fn get<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(root, |v, k| v.get(k))
}
fn set(root: &mut Value, path: &str, value: Value) -> Result<()> {
    let mut place = root;
    for part in path.split('.') {
        if place.is_null() {
            *place = json!({});
        }
        place = place
            .as_object_mut()
            .ok_or_else(|| format!("Invalid settings section for {path}"))?
            .entry(part)
            .or_insert(Value::Null);
    }
    *place = value;
    Ok(())
}
fn profiles(doc: &Value) -> Result<&serde_json::Map<String, Value>> {
    doc["configs"]
        .as_object()
        .ok_or_else(|| "Invalid mining profile collection".into())
}
fn current(doc: &Value) -> Result<&str> {
    doc["current_profile"]
        .as_str()
        .filter(|n| doc["configs"][*n].is_object())
        .ok_or_else(|| "Missing current profile".into())
}
pub fn parent<'a>(doc: &'a Value, name: &str) -> Option<&'a str> {
    doc[LAYERS]["scenes"][name]["parent"].as_str()
}

pub fn scene_id<'a>(doc: &'a Value, name: &str) -> Option<&'a str> {
    doc[LAYERS]["scenes"][name]["sceneId"]
        .as_str()
        .filter(|id| !id.is_empty())
}

#[cfg(feature = "profile-upgrade")]
pub(crate) fn prepare(doc: &mut Value, previous: &Value, file: &Path) -> Result<()> {
    if !doc[LAYERS].is_null() && doc[LAYERS]["version"] != 1 {
        return Err("Unsupported mining settings version".into());
    }
    let active = current(doc)?.to_owned();
    if doc[LAYERS].is_null() {
        // Legacy desktop consumers used the root overlay for every game.
        let overlay = doc["overlay"].clone();
        for entry in doc["configs"].as_object_mut().unwrap().values_mut() {
            for (k, v) in overlay.as_object().ok_or("Invalid overlay configuration")? {
                if MINING_DEFAULTS["overlay"].get(k).is_some() {
                    set(entry, &format!("overlay.{k}"), v.clone())?;
                }
            }
        }
    }
    let mut shared_values = doc[LAYERS]["global"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut conflict = false;
    for (key, field) in FIELDS.iter().filter(|(_, f)| f.scope == Scope::Shared) {
        if !shared_values.contains_key(key) {
            let chosen = get(&doc["configs"][&active], key).unwrap_or(&field.default);
            conflict |= profiles(doc)?
                .values()
                .any(|p| get(p, key).is_some_and(|v| v != chosen));
            shared_values.insert(key.clone(), chosen.clone());
        }
    }
    if conflict {
        // Retain the exact original document, including keys supplied by plugins.
        let mut backup = file.with_file_name("config.pre-scopes.json");
        if backup.try_exists().map_err(|e| e.to_string())? {
            backup =
                file.with_file_name(format!("config.pre-scopes-{}.json", uuid::Uuid::new_v4()));
        }
        write_atomic(&backup, previous)?;
        doc[LAYERS]["migrationBackup"] = json!(backup.file_name().unwrap().to_string_lossy());
        doc[LAYERS]["migrationProfile"] = json!(active);
    }
    doc[LAYERS]["version"] = json!(1);
    doc[LAYERS]["global"] = Value::Object(shared_values);
    if doc[LAYERS]["scenes"].is_null() {
        doc[LAYERS]["scenes"] = json!({});
    }
    resolve(doc)
}

fn resolve(doc: &mut Value) -> Result<()> {
    let layers = &doc[LAYERS];
    if layers.is_null() {
        return Ok(());
    }
    if layers["version"] != 1 {
        return Err("Unsupported mining settings version".into());
    }
    let global = layers["global"]
        .as_object()
        .ok_or("Invalid global settings")?
        .clone();
    let scenes = layers["scenes"]
        .as_object()
        .ok_or("Invalid scene settings")?
        .clone();
    for (child, link) in &scenes {
        let base = link["parent"].as_str().ok_or("Missing base profile")?;
        let overrides = link["overrides"]
            .as_object()
            .ok_or("Invalid scene overrides")?;
        let configs = profiles(doc)?;
        if !configs.contains_key(child) || !configs.contains_key(base) || scenes.contains_key(base)
        {
            return Err(format!("Invalid base profile for {child}"));
        }
        let changes: Vec<_> = FIELDS
            .iter()
            .filter(|(_, f)| f.scope == Scope::Profile)
            .filter_map(|(k, _)| {
                overrides
                    .get(k)
                    .or_else(|| get(&configs[base], k))
                    .map(|v| (k, v.clone()))
            })
            .collect();
        let entry = &mut doc["configs"][child];
        for (key, v) in changes {
            set(entry, key, v)?;
        }
    }
    let overlay = doc["overlay"].clone();
    for p in doc["configs"]
        .as_object_mut()
        .ok_or("Invalid mining profiles")?
        .values_mut()
    {
        for (key, value) in &global {
            if FIELDS.get(key).is_some_and(|f| f.scope == Scope::Shared) {
                set(p, key, value.clone())?;
            }
        }
        for key in [
            "websocket_port",
            "monitor_to_capture",
            "monitor_to_capture_id",
            "monitor_to_capture_bounds",
        ] {
            if let Some(value) = overlay.get(key) {
                set(p, &format!("overlay.{key}"), value.clone())?;
            }
        }
    }
    let name = current(doc)?.to_owned();
    activate(doc, &name)?;
    Ok(())
}

pub fn activate(doc: &mut Value, name: &str) -> Result<()> {
    if !profiles(doc)?.contains_key(name) {
        return Err("Profile no longer exists".into());
    }
    doc["current_profile"] = json!(name);
    if doc[LAYERS].is_object() {
        doc["overlay"] = doc["configs"][name]["overlay"].clone();
    }
    Ok(())
}

/// Apply edits from an existing desktop control to the same layer as the editor.
pub fn update<T>(path: &Path, edit: impl FnOnce(&mut Value) -> Result<T>) -> Result<T> {
    with_lock(path, || {
        let before = read_object(path)?;
        let mut doc = before.clone();
        let result = edit(&mut doc)?;
        if doc != before {
            if doc[LAYERS].is_object() {
                // Older editors write the active overlay at the root.
                if before["current_profile"] == doc["current_profile"]
                    && before["overlay"] != doc["overlay"]
                {
                    let name = current(&doc)?.to_owned();
                    for (k, _) in FIELDS
                        .iter()
                        .filter(|(k, f)| k.starts_with("overlay.") && f.scope == Scope::Profile)
                    {
                        if let Some(v) = get(&doc, k)
                            .filter(|v| get(&before, k) != Some(*v))
                            .cloned()
                        {
                            set(&mut doc["configs"][&name], k, v)?;
                        }
                    }
                }
                let mut edits = Vec::new();
                for (name, p) in profiles(&doc)? {
                    let Some(old) = before["configs"].get(name) else {
                        continue;
                    };
                    for (key, field) in FIELDS.iter().filter(|(_, f)| f.scope != Scope::Root) {
                        if let Some(value) = get(p, key).filter(|v| get(old, key) != Some(*v)) {
                            edits.push((name.clone(), key, field.scope, value.clone()));
                        }
                    }
                }
                for (name, key, scope, value) in edits {
                    if scope == Scope::Shared {
                        doc[LAYERS]["global"][key] = value;
                    } else if parent(&doc, &name).is_some() {
                        doc[LAYERS]["scenes"][&name]["overrides"][key] = value;
                    }
                }
                resolve(&mut doc)?;
            }
            write_atomic(path, &doc)?;
        }
        Ok(result)
    })
}

#[derive(Clone, Copy, PartialEq)]
enum View {
    Scope,
    Mining,
    Obs,
}

impl View {
    fn from_request(request: &Value) -> Result<Self> {
        match request["view"].as_str() {
            None => Ok(Self::Scope),
            Some("mining") => Ok(Self::Mining),
            Some("obs") => Ok(Self::Obs),
            _ => Err("Unknown settings view".into()),
        }
    }

    fn includes(self, key: &str) -> bool {
        match self {
            Self::Scope => true,
            Self::Mining => !["obs.", "overlay.", "text_processing."]
                .iter()
                .any(|prefix| key.starts_with(prefix)),
            Self::Obs => key.starts_with("obs."),
        }
    }

    fn shows(self, scope: Scope, target: Option<&str>) -> bool {
        match scope {
            Scope::Profile => target.is_some(),
            _ => self != Self::Scope || target.is_none(),
        }
    }
}

fn snapshot(doc: &Value, target: Option<&str>, view: View) -> Result<Value> {
    let profiles = profiles(doc)?;
    if target.is_some_and(|n| !profiles.contains_key(n)) {
        return Err("Profile no longer exists".into());
    }
    let mut fields = Vec::new();
    for (key, f) in FIELDS
        .iter()
        .filter(|(k, f)| editable(k) && view.includes(k) && view.shows(f.scope, target))
    {
        let value = match f.scope {
            Scope::Root => get(doc, key),
            Scope::Shared => doc[LAYERS]["global"].get(key),
            Scope::Profile => get(&profiles[target.unwrap()], key),
        }
        .unwrap_or(&f.default);
        fields.push(json!({"path":key,"value":value,"global":f.scope != Scope::Profile,"options":available_options(key,doc,value),"range":range(key),
            "baseValue":target.and_then(|n|parent(doc,n)).and_then(|n|get(&profiles[n],key)),
            "pinned":target.is_some_and(|n|doc[LAYERS]["scenes"][n]["overrides"].get(key).is_some())}));
    }
    if let Some(n) = target.filter(|n| view.includes("profiles.scenes") && parent(doc, n).is_none())
    {
        fields.push(json!({"path":"profiles.scenes","value":profiles[n]["scenes"],"options":[],"pinned":false}));
    }
    let choices: Vec<_> = profiles
        .iter()
        .map(|(n, p)| json!({"name":n,"parent":parent(doc,n),"scenes":p["scenes"]}))
        .collect();
    Ok(
        json!({"target":target,"active":current(doc)?,"profiles":choices,"fields":fields,
        "sourceDefaults":if view == View::Mining { Some(&FIELDS["general.websocket_sources"].default) } else { None },
        "ankiFields":if view == View::Mining { target.and_then(|n|get(&profiles[n],"anki.available_fields")) } else { None },
        "animatedLockFps":target.and_then(|n| {
            (get(&profiles[n], "screenshot.animated").and_then(Value::as_bool) == Some(true))
                .then(|| get(&profiles[n], "screenshot.animated_settings.fps").and_then(Value::as_u64))
                .flatten()
        }),
        "migrationBackup":doc[LAYERS]["migrationBackup"],"migrationProfile":doc[LAYERS]["migrationProfile"]}),
    )
}

/// Launcher profile pickers choose the base group even when a game has overrides.
pub fn base_profiles(path: &Path) -> Result<Value> {
    let doc = read_object(path)?;
    let mut groups = BTreeMap::<String, Vec<String>>::new();
    for (name, profile) in profiles(&doc)? {
        let scenes = groups
            .entry(parent(&doc, name).unwrap_or(name).to_owned())
            .or_default();
        for scene in profile["scenes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !scenes.iter().any(|s| s == scene) {
                scenes.push(scene.to_owned());
            }
        }
    }
    let name = current(&doc)?;
    Ok(
        json!({"profiles":groups.keys().collect::<Vec<_>>(),"profileScenes":groups,"currentProfile":parent(&doc,name).unwrap_or(name)}),
    )
}

pub fn relate_scene(path: &Path, scene: &str, base: &str, create: bool) -> Result<()> {
    update(path, |doc| {
        if parent(doc, base).is_some() {
            return Err("Choose a base profile for this scene".into());
        }
        let game = profiles(doc)?
            .iter()
            .find(|(n, p)| {
                parent(doc, n).is_some()
                    && p["scenes"]
                        .as_array()
                        .is_some_and(|s| s.iter().any(|v| v == scene))
            })
            .map(|(n, _)| n.clone());
        if !profiles(doc)?.contains_key(base) {
            if !create {
                return Err("Profile no longer exists".into());
            }
            let mut next = profiles(doc)?
                .get("Default")
                .ok_or("Default profile is missing")?
                .clone();
            next["name"] = json!(base);
            next["scenes"] = json!([]);
            doc["configs"][base] = next;
        }
        for (n, p) in doc["configs"].as_object_mut().unwrap() {
            if game.as_ref() == Some(n) {
                continue;
            }
            let mut scenes = p["scenes"].as_array().cloned().unwrap_or_default();
            scenes.retain(|s| s.as_str().is_none_or(|s| s.trim() != scene));
            if n == base {
                scenes.push(json!(scene));
            }
            p["scenes"] = json!(scenes);
        }
        if let Some(n) = game {
            doc[LAYERS]["scenes"][n]["parent"] = json!(base);
        }
        Ok(())
    })
}

pub fn read(path: &Path, request: &Value) -> Result<Value> {
    let doc = read_object(path)?;
    if doc[LAYERS]["version"] != 1 {
        return Err("Mining settings have not been prepared".into());
    }
    let target = if request.get("target").is_none() {
        Some(current(&doc)?)
    } else {
        request["target"].as_str()
    };
    snapshot(&doc, target, View::from_request(request)?)
}

fn edit_fields(doc: &mut Value, target: Option<&str>, changes: &Value, view: View) -> Result<()> {
    for change in changes.as_array().ok_or("Missing settings changes")? {
        let key = change["path"].as_str().ok_or("Missing setting path")?;
        if !view.includes(key) {
            return Err("Setting belongs to a different view".into());
        }
        if key == "profiles.scenes" {
            let name = target
                .filter(|n| parent(doc, n).is_none())
                .ok_or("Choose a base profile")?;
            if change.get("before") != doc["configs"][name].get("scenes") {
                return Err("Scene bindings changed while editing".into());
            }
            let mut scenes = Vec::new();
            for scene in change["value"]
                .as_array()
                .ok_or("Expected a list of scenes")?
            {
                let name = scene.as_str().ok_or("Invalid OBS scene name")?.trim();
                if !name.is_empty() && !scenes.contains(&name) {
                    scenes.push(name);
                }
            }
            doc["configs"][name]["scenes"] = json!(scenes);
            continue;
        }
        let field = FIELDS
            .get(key)
            .filter(|f| editable(key) && view.shows(f.scope, target))
            .ok_or("Setting belongs to a different scope")?;
        let link = target.filter(|n| field.scope == Scope::Profile && parent(doc, n).is_some());
        let pinned = link.is_some_and(|n| doc[LAYERS]["scenes"][n]["overrides"].get(key).is_some());
        let old = match field.scope {
            Scope::Root => get(doc, key),
            Scope::Shared => doc[LAYERS]["global"].get(key),
            Scope::Profile => get(&doc["configs"][target.unwrap()], key),
        }
        .unwrap_or(&field.default);
        if Some(old) != change.get("before") || change["pinned"].as_bool() != Some(pinned) {
            return Err(format!("Setting changed while editing: {key}"));
        }
        if change["inherit"] == true {
            let child = link.ok_or("Only scene settings inherit")?;
            doc[LAYERS]["scenes"][child]["overrides"]
                .as_object_mut()
                .ok_or("Invalid overrides")?
                .remove(key);
            continue;
        }
        let v = change.get("value").ok_or("Missing setting value")?;
        validate_value(key, v, &field.default)?;
        match (field.scope, link) {
            (Scope::Root, _) => set(doc, key, v.clone())?,
            (Scope::Shared, _) => {
                doc[LAYERS]["global"][key] = v.clone();
            }
            (_, Some(child)) => {
                doc[LAYERS]["scenes"][child]["overrides"][key] = v.clone();
            }
            _ => set(&mut doc["configs"][target.unwrap()], key, v.clone())?,
        }
    }
    Ok(())
}

pub fn apply(path: &Path, req: &Value) -> Result<Value> {
    with_lock(path, || {
        let mut doc = read_object(path)?;
        if doc[LAYERS]["version"] != 1 {
            return Err("Mining settings have not been prepared".into());
        }
        let view = View::from_request(req)?;
        if view == View::Obs && req["op"] != "edit" {
            return Err("Expected an OBS settings edit".into());
        }
        let mut target = req["target"].as_str();
        if target.is_some_and(|n| !doc["configs"][n].is_object()) {
            return Err("Profile no longer exists".into());
        }
        match req["op"].as_str() {
            Some(op @ ("createProfile" | "createScene")) => {
                let base = req["base"]
                    .as_str()
                    .filter(|n| doc["configs"][*n].is_object() && parent(&doc, n).is_none())
                    .ok_or("Choose a base profile")?;
                let name = req["name"]
                    .as_str()
                    .map(str::trim)
                    .filter(|n| !n.is_empty() && !n.chars().any(char::is_control))
                    .ok_or("Enter a name")?;
                let scene = op == "createScene";
                let scene_id = req["sceneId"].as_str().filter(|id| !id.is_empty());
                let mut id = name.to_owned();
                if scene {
                    if doc[LAYERS]["scenes"]
                        .as_object()
                        .ok_or("Invalid scene collection")?
                        .keys()
                        .any(|n| match (self::scene_id(&doc, n), scene_id) {
                            (Some(a), Some(b)) => a == b,
                            _ => doc["configs"][n]["scenes"]
                                .as_array()
                                .is_some_and(|ss| ss.iter().any(|s| s == name)),
                        })
                    {
                        return Err("Scene already has settings".into());
                    }
                    if profiles(&doc)?.contains_key(name) {
                        id = format!("{name} ({base})");
                    }
                }
                if profiles(&doc)?.contains_key(&id) {
                    return Err("Name already in use".into());
                }
                let mut entry = doc["configs"][base].clone();
                entry["name"] = json!(id);
                entry["scenes"] = if scene { json!([name]) } else { json!([]) };
                if scene {
                    let mut overrides = serde_json::Map::new();
                    if req["follow"].as_bool() == Some(false) {
                        for (k, _) in FIELDS.iter().filter(|(_, f)| f.scope == Scope::Profile) {
                            if let Some(v) = get(&entry, k) {
                                overrides.insert(k.clone(), v.clone());
                            }
                        }
                    }
                    doc[LAYERS]["scenes"][&id] =
                        json!({"parent":base,"overrides":overrides,"sceneId":scene_id});
                }
                doc["configs"][&id] = entry;
                resolve(&mut doc)?;
                let result = snapshot(&doc, Some(&id), view)?;
                write_atomic(path, &doc)?;
                return Ok(result);
            }
            Some("edit") => edit_fields(&mut doc, target, &req["changes"], view)?,
            Some("delete") => {
                let name = target.ok_or("Choose a profile")?;
                if name == "Default"
                    || profiles(&doc)?.len() == 1
                    || profiles(&doc)?
                        .keys()
                        .any(|n| parent(&doc, n) == Some(name))
                {
                    return Err("Keep the default profile and profiles with linked scenes".into());
                }
                let fallback = parent(&doc, name).unwrap_or("Default").to_owned();
                doc["configs"].as_object_mut().unwrap().remove(name);
                doc[LAYERS]["scenes"].as_object_mut().unwrap().remove(name);
                if doc["current_profile"] == name {
                    let next = if profiles(&doc)?.contains_key(&fallback) {
                        &fallback
                    } else {
                        profiles(&doc)?.keys().next().unwrap()
                    };
                    doc["current_profile"] = json!(next);
                }
                target = None;
            }
            _ => return Err("Unknown mining settings action".into()),
        }
        resolve(&mut doc)?;
        let result = snapshot(&doc, target, view)?;
        write_atomic(path, &doc)?;
        Ok(result)
    })
}
