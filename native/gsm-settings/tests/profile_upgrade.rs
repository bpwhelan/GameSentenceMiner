use gsm_settings::{paths::Paths, profile_config, read_object};
use serde_json::json;
use std::fs;
use tempfile::tempdir;

#[test]
#[ignore = "driven by scripts/benchmark_profile_upgrade.py"]
fn benchmark_worker() {
    use std::io::{self, BufRead, Write};
    println!("ready {}", std::process::id());
    for line in io::stdin().lock().lines() {
        let (dir, count, _): (std::path::PathBuf, usize, bool) =
            serde_json::from_str(&line.unwrap()).unwrap();
        let paths = Paths {
            active: dir.clone(),
            shared: dir.clone(),
            has_profile: true,
        };
        let start = std::time::Instant::now();
        for _ in 0..count {
            profile_config::prepare(&paths, &dir, "2026.11.0").unwrap();
        }
        println!(
            "{}",
            json!({"ms":start.elapsed().as_secs_f64()*1000./count as f64})
        );
        io::stdout().flush().unwrap();
    }
}

#[test]
fn upgrades_every_profile_and_keeps_user_fields_on_reopen() {
    let tmp = tempdir().unwrap();
    let paths = Paths {
        active: tmp.path().join("profile"),
        shared: tmp.path().join("shared"),
        has_profile: true,
    };
    fs::create_dir(&paths.active).unwrap();
    let path = paths.active.join("config.json");
    let existing = json!({
        "current_profile":"Game", "version":"2.17.9", "stats":{"session_gap_seconds":3600,"custom":42},
        "configs":{
            "Default":{"name":"Default", "general":{"single_port":8130}},
            "Game":{"overlay":{"periodic":true}, "vad":{"selected_vad_model":"WHISPER","backup_vad_model":"SILERO"},
                "general":{"texthooker_port":55000,"websocket_uri":"localhost:9001, custom:443,custom:443,ws://localhost:23"},
                "anki":{"update_anki":false,"sentence_field":"Context","sentence_field_overwrite":false,"sentence_field_append":true,
                    "previous_image":{"name":"Old","custom":"keep","append":true}},
                "custom":{"nested":[1,null,3]}}
        }
    });
    fs::write(&path, existing.to_string()).unwrap();
    assert!(profile_config::prepare(&paths, tmp.path(), "2026.11.0").unwrap());
    let doc = read_object(&path).unwrap();
    let game = &doc["configs"]["Game"];
    assert_eq!(game["name"], "Game");
    assert_eq!(doc["stats"]["custom"], 42);
    assert_eq!(doc["stats"]["session_gap_seconds"], 1800);
    assert_eq!(doc["configs"]["Default"]["general"]["single_port"], 7275);
    assert_eq!(read_object(&paths.active.join("config.pre-scopes.json")).unwrap(), existing);
    assert_eq!(doc["overlay"]["periodic"], true);
    assert_eq!(game["vad"]["backup_vad_model"], "OFF");
    assert_eq!(game["general"]["single_port"], 7275);
    assert_eq!(
        game["general"]["websocket_sources"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(game["general"]["websocket_sources"][2]["name"], "Custom 2");
    assert_eq!(game["anki"]["enabled"], false);
    assert_eq!(
        game["anki"]["sentence"],
        json!({"name":"Context","core":true,"enabled":true,"overwrite":false,"append":true})
    );
    assert_eq!(game["anki"]["previous_image"]["append"], false);
    assert_eq!(game["anki"]["previous_image"]["custom"], "keep");
    assert_eq!(game["custom"], json!({"nested":[1,null,3]}));
    assert!(!profile_config::prepare(&paths, tmp.path(), "2026.11.0").unwrap());
}

#[test]
fn recovers_corrupt_json_and_creates_portable_defaults() {
    let tmp = tempdir().unwrap();
    let paths = Paths {
        active: tmp.path().join("profile"),
        shared: tmp.path().into(),
        has_profile: true,
    };
    fs::create_dir(&paths.active).unwrap();
    let path = paths.active.join("config.json");
    fs::write(&path, b"{bad").unwrap();
    assert!(profile_config::prepare(&paths, tmp.path(), "2026.11.0").unwrap());
    assert_eq!(
        fs::read(paths.active.join("config.json.bak")).unwrap(),
        b"{bad"
    );
    let doc = read_object(&path).unwrap();
    let profile = &doc["configs"]["Default"];
    assert_eq!(profile["general"]["target_language"], "ja");
    assert_eq!(profile["anki"]["sentence"]["name"], "Sentence");
    assert_eq!(
        std::path::Path::new(profile["paths"]["folder_to_watch"].as_str().unwrap()),
        paths.active.join("recordings")
    );
    assert!(!profile_config::prepare(&paths, tmp.path(), "2026.11.0").unwrap());
}

#[test]
fn missing_settings_cannot_disable_existing_vocabulary() {
    let tmp = tempdir().unwrap();
    let paths = Paths {
        active: tmp.path().into(),
        shared: tmp.path().into(),
        has_profile: true,
    };
    fs::write(paths.active.join("gsm.db"), []).unwrap();
    for _ in 0..2 {
        profile_config::prepare(&paths, tmp.path(), "2026.11.0").unwrap();
        let doc = read_object(&paths.active.join("config.json")).unwrap();
        assert!(doc["experimental"].get("enable_tokenization").is_none());
        assert!(doc["experimental"]
            .get("enable_experimental_features")
            .is_none());
    }
}

#[test]
fn old_toml_and_flat_json_keep_their_source_and_custom_options() {
    for legacy_toml in [true, false] {
        let tmp = tempdir().unwrap();
        let paths = Paths {
            active: tmp.path().join("profile"),
            shared: tmp.path().into(),
            has_profile: true,
        };
        let source = if legacy_toml {
            "config.toml"
        } else {
            "config.json"
        };
        let input = if legacy_toml {
            "[anki]\nsentence_field = 'Dialog'\n[anki_overwrites]\noverwrite_sentence = false\n[websocket]\nuri = 'localhost:2333'"
        } else {
            r#"{"anki":{"sentence_field":"Dialog","overwrite_sentence":false},"general":{"websocket_uri":"localhost:2333"},"privateSetting":{"version":12}}"#
        };
        fs::write(tmp.path().join(source), input).unwrap();
        profile_config::prepare(&paths, tmp.path(), "2026.11.0").unwrap();
        assert_eq!(fs::read(tmp.path().join(source)).unwrap(), input.as_bytes());
        let root = read_object(&paths.active.join("config.json")).unwrap();
        let p = &root["configs"]["Default"];
        assert_eq!(p["anki"]["sentence"]["name"], "Dialog");
        assert_eq!(p["anki"]["sentence"]["overwrite"], false);
        assert_eq!(
            p["general"]["websocket_sources"][0]["name"],
            "LunaTranslator"
        );
        if !legacy_toml {
            assert_eq!(p["privateSetting"]["version"], 12);
        }
    }
}
