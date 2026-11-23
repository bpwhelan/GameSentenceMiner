use gsm_settings::{
    mining_scopes as scopes, paths::Paths, profile_config, read_object, write_atomic,
};
use serde_json::{json, Value};
use tempfile::tempdir;

#[test]
fn scene_overrides_and_shared_connections_survive_reopen_and_other_settings_writers() {
    let tmp = tempdir().unwrap();
    let paths = Paths {
        active: tmp.path().into(),
        shared: tmp.path().into(),
        has_profile: true,
    };
    let file = tmp.path().join("config.json");
    let old = json!({"current_profile":"VN","configs":{"Default":{"ai":{"api_key":"old"}},"VN":{"ai":{"api_key":"chosen"},"custom":{"plugin":true},"scenes":["Game"]}}});
    write_atomic(&file, &old).unwrap();
    profile_config::prepare(&paths, tmp.path(), "2026.11.0").unwrap();
    assert_eq!(
        read_object(&tmp.path().join("config.pre-scopes.json")).unwrap(),
        old
    );
    let act = |a: Value| scopes::apply(&file, &a);
    let edit = |target: Value, path, old: Value, value: Value, pinned| json!({"op":"edit","target":target,"changes":[{"path":path,"before":old,"value":value,"pinned":pinned}]});
    act(json!({"op":"createScene","base":"VN","name":"Game","follow":true})).unwrap();
    act(edit(
        json!(null),
        "ai.api_key",
        json!("chosen"),
        json!("new"),
        false,
    ))
    .unwrap();
    assert!(act(edit(
        json!("Game"),
        "ai.api_key",
        json!("new"),
        json!("bad"),
        false
    ))
    .is_err());
    act(edit(
        json!("Game"),
        "audio.end_offset",
        json!(0.5),
        json!(0.5),
        false,
    ))
    .unwrap();
    act(edit(
        json!("VN"),
        "audio.end_offset",
        json!(0.5),
        json!(1.5),
        false,
    ))
    .unwrap();
    assert!(act(edit(
        json!("VN"),
        "audio.end_offset",
        json!(0.5),
        json!(2.5),
        false
    ))
    .is_err());
    act(edit(
        json!("VN"),
        "audio.beginning_offset",
        json!(-0.5),
        json!(-1.0),
        false,
    ))
    .unwrap();
    let read = || read_object(&file).unwrap();
    assert_eq!(read()["configs"]["Game"]["custom"]["plugin"], true);
    assert_eq!(read()["configs"]["Game"]["audio"]["end_offset"], 0.5);
    assert_eq!(read()["configs"]["Game"]["audio"]["beginning_offset"], -1.0);
    assert_eq!(read()["configs"]["Default"]["ai"]["api_key"], "new");
    act(json!({"op":"edit","target":"Game","changes":[{"path":"audio.end_offset","before":0.5,"pinned":true,"inherit":true}]})).unwrap();
    assert_eq!(read()["configs"]["Game"]["audio"]["end_offset"], 1.5);
    scopes::update(&file, |doc| {
        doc["current_profile"] = json!("Game");
        Ok(())
    })
    .unwrap();
    gsm_settings::gsm_config::save_target_language(&file, "ko").unwrap();
    act(edit(
        json!("VN"),
        "general.target_language",
        json!("ja"),
        json!("fr"),
        false,
    ))
    .unwrap();
    assert_eq!(
        read()["configs"]["Game"]["general"]["target_language"],
        "ko"
    );
    assert!(!profile_config::prepare(&paths, tmp.path(), "2026.11.0").unwrap());
    assert!(act(json!({"op":"createScene","base":"Game","name":"Nested","follow":true})).is_err());
    assert!(act(json!({"op":"delete","target":"VN"})).is_err());
    act(json!({"op":"createScene","base":"VN","name":"Frozen","follow":false})).unwrap();
    act(edit(
        json!("VN"),
        "audio.end_offset",
        json!(1.5),
        json!(3.0),
        false,
    ))
    .unwrap();
    assert_eq!(read()["configs"]["Frozen"]["audio"]["end_offset"], 1.5);
    assert_eq!(read()["configs"]["Game"]["audio"]["end_offset"], 3.0);
    act(edit(
        json!("Game"),
        "overlay.periodic",
        json!(false),
        json!(true),
        false,
    ))
    .unwrap();
    assert_eq!(read()["overlay"]["periodic"], true);
    let view = scopes::base_profiles(&file).unwrap();
    assert_eq!(view["currentProfile"], "VN");
    assert!(!view["profiles"]
        .as_array()
        .unwrap()
        .contains(&json!("Game")));
    scopes::relate_scene(&file, "Game", "Other", true).unwrap();
    assert_eq!(scopes::parent(&read(), "Game"), Some("Other"));
    assert_eq!(
        read()["configs"]["Game"]["general"]["target_language"],
        "ko"
    );
}

#[test]
fn text_workspace_edits_stay_with_the_original_scene_and_detect_conflicts() {
    let root = tempdir().unwrap();
    let paths = Paths {
        active: root.path().into(),
        shared: root.path().into(),
        has_profile: true,
    };
    let file = root.path().join("config.json");
    profile_config::prepare(&paths, root.path(), "2026.11.0").unwrap();
    scopes::apply(
        &file,
        &json!({"op":"createScene","base":"Default","name":"Game"}),
    )
    .unwrap();
    scopes::update(&file, |doc| scopes::activate(doc, "Game")).unwrap();
    let workspace = gsm_settings::workspace::Workspace::new(root.path());
    let loaded = workspace.named_text().unwrap();
    assert_eq!(loaded["name"], "Game");
    let before = &loaded["config"];
    let mut after = before.clone();
    after["remove_numbers"] = json!(!before["remove_numbers"].as_bool().unwrap());
    scopes::update(&file, |doc| scopes::activate(doc, "Default")).unwrap();
    workspace.save_named_text("Game", before, &after).unwrap();
    assert_eq!(workspace.text().unwrap(), *before);
    let saved = read_object(&file).unwrap();
    assert_eq!(
        saved["profile_layers"]["scenes"]["Game"]["overrides"]["text_processing.remove_numbers"],
        after["remove_numbers"]
    );
    let mut changed = after.clone();
    changed["remove_repeated_chars_config"]["repeat_count"] = json!(2);
    workspace.save_named_text("Game", &after, &changed).unwrap();
    let mut stale = after.clone();
    stale["remove_repeated_chars_config"]["repeat_count"] = json!(3);
    assert!(workspace.save_named_text("Game", &after, &stale).is_err());
}

#[test]
fn standalone_writer_merges_visible_edits_and_preserves_hidden_game_layers() {
    let root = tempdir().unwrap();
    let paths = Paths {
        active: root.path().into(),
        shared: root.path().into(),
        has_profile: true,
    };
    let file = root.path().join("config.json");
    profile_config::prepare(&paths, root.path(), "2026.11.0").unwrap();
    scopes::apply(
        &file,
        &json!({"op":"createScene","base":"Default","name":"Game"}),
    )
    .unwrap();
    let mut visible = read_object(&file).unwrap();
    visible.as_object_mut().unwrap().remove("profile_layers");
    let mut after = visible.clone();
    after["current_profile"] = json!("Game");
    after["configs"]["Game"]["audio"]["enabled"] = json!(false);
    gsm_settings::profile_editor::save_standalone_edits(&file, &visible, &after).unwrap();
    let saved = read_object(&file).unwrap();
    assert_eq!(saved["current_profile"], "Game");
    assert_eq!(
        saved["profile_layers"]["scenes"]["Game"]["overrides"]["audio.enabled"],
        false
    );
    assert_eq!(saved["configs"]["Default"]["audio"]["enabled"], true);
}

#[test]
fn key_settings_share_connections_and_keep_game_offsets_in_one_transaction() {
    let tmp = tempdir().unwrap();
    let paths = Paths {
        active: tmp.path().into(),
        shared: tmp.path().into(),
        has_profile: true,
    };
    let file = tmp.path().join("config.json");
    profile_config::prepare(&paths, tmp.path(), "2026.11.0").unwrap();
    scopes::apply(
        &file,
        &json!({"op":"createScene","base":"Default","name":"Game","follow":true}),
    )
    .unwrap();
    let view = json!({"target":"Game","view":"mining"});
    let snapshot = scopes::read(&file, &view).unwrap();
    let fields = snapshot["fields"].as_array().unwrap();
    let port = fields
        .iter()
        .find(|f| f["path"] == "general.single_port")
        .unwrap();
    assert_eq!(port["global"], true);
    assert!(!fields
        .iter()
        .any(|f| ["obs.", "overlay.", "text_processing."]
            .iter()
            .any(|prefix| f["path"].as_str().unwrap().starts_with(prefix))));
    let offset = fields
        .iter()
        .find(|f| f["path"] == "audio.end_offset")
        .unwrap();
    let mut req = json!({"target":"Game","view":"mining","op":"edit","changes":[
        {"path":"general.single_port","before":port["value"],"value":7891,"pinned":false},
        {"path":"audio.end_offset","before":99,"value":1.25,"pinned":false}
    ]});
    let before = read_object(&file).unwrap();
    assert!(scopes::apply(&file, &req).is_err());
    assert_eq!(read_object(&file).unwrap(), before);
    req["changes"][1]["before"] = offset["value"].clone();
    scopes::apply(&file, &req).unwrap();
    let saved = read_object(&file).unwrap();
    assert_eq!(saved["configs"]["Default"]["general"]["single_port"], 7891);
    assert_eq!(saved["configs"]["Game"]["audio"]["end_offset"], 1.25);
    assert_eq!(
        saved["configs"]["Default"]["audio"]["end_offset"],
        offset["value"]
    );
    let obs = scopes::read(&file, &json!({"view":"obs"})).unwrap();
    assert!(obs["fields"]
        .as_array()
        .unwrap()
        .iter()
        .all(|f| f["path"].as_str().unwrap().starts_with("obs.")));
}
