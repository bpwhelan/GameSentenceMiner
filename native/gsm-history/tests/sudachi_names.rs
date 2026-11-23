use gsm_history::History;
use serde_json::json;
use std::fs;

#[test]
fn sudachi_sources_reuse_the_installed_hash_and_restore_a_missing_csv() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    let people = json!({"characters":{"main":[{"name":"Katou Umi","name_original":"加藤 うみ",
        "aliases":["ウミ","a,b","加藤"],"image_base64":"data:image/png;base64,unused"}],
        "side":[{"name":"Katou Umi","name_original":"加藤 うみ"}]}});
    db.execute("INSERT INTO games(id,obs_scene_name,title_original,vndb_character_data) VALUES('g','scene','ゲーム',?)",
        [people.to_string()]).unwrap();
    let history = History::default();
    let generation = history.generation().unwrap();
    let write = || {
        history
            .export_sudachi_names(&path, "g", generation)
            .unwrap()
    };
    assert!(write());
    let root = dir.path().join("dictionaries/sudachi");
    let csv = root.join("csv/g.csv");
    let meta = root.join("metadata/g.json");
    let rows = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_path(&csv)
        .unwrap()
        .records()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows[0].get(0), Some("a,b"));
    assert_eq!(rows[0].len(), 19);
    assert!(rows
        .iter()
        .any(|r| &r[0] == "加藤うみ" && &r[11] == "カトウウミ"));
    assert!(!rows.iter().any(|r| &r[0] == "加藤"));
    let metadata: serde_json::Value = serde_json::from_slice(&fs::read(&meta).unwrap()).unwrap();
    assert_eq!(metadata["row_count"], rows.len());
    assert_eq!(metadata["title"], "ゲーム");
    assert!(!write());
    fs::remove_file(&csv).unwrap();
    assert!(write());
    history.close().unwrap();
    assert!(history
        .export_sudachi_names(&path, "g", generation)
        .is_err());
    assert!(history
        .export_sudachi_names(&path, "../outside", history.generation().unwrap())
        .is_err());
}
