use gsm_history::{
    library::{CharacterSource, MetadataProvider},
    History,
};
use serde_json::json;

#[test]
fn jiten_link_recovers_the_scene_and_commits_characters_with_the_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute_batch(r#"INSERT INTO games(id,title_original,manual_overrides,difficulty,links)
        VALUES('g','Original title','["difficulty"]','0','[]');
        INSERT INTO game_lines(id,game_name,game_id) VALUES('a','OBS','g'),('b','OBS','old'),('c','Other',NULL);"#).unwrap();
    let history = History::default();
    let data = json!({"deck_id":42,"title_original":"New title","media_type_string":"Visual Novel",
        "difficulty":4,"character_count":0,"links":["https://vndb.org/v17"]});
    let people = json!({"vn_id":"v17","character_count":0,"characters":{}});
    let provider = || MetadataProvider::Jiten {
        source: Some(CharacterSource::Vndb("v17".into())),
        characters: Some(people.clone()),
    };
    let pending = || {
        history
            .begin_metadata_link(&path, "g", false)
            .unwrap()
            .unwrap()
    };
    db.execute_batch(
        "CREATE TRIGGER reject_move BEFORE UPDATE OF game_id ON game_lines
        BEGIN SELECT RAISE(ABORT,'cannot move scene'); END;",
    )
    .unwrap();
    assert!(history
        .finish_metadata_link(&path, pending(), data.clone(), provider())
        .is_err());
    assert_eq!(
        db.query_row("SELECT title_original FROM games WHERE id='g'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "Original title"
    );
    db.execute_batch("DROP TRIGGER reject_move").unwrap();
    let reply = history
        .finish_metadata_link(&path, pending(), data, provider())
        .unwrap()
        .unwrap();
    assert_eq!(
        reply["updated_fields"],
        json!([
            "deck_id",
            "title_original",
            "game_type",
            "links",
            "character_count"
        ])
    );
    assert_eq!(reply["lines_updated"], 2);
    let values: String = db.query_row("SELECT json_array(obs_scene_name,title_original,deck_id,difficulty,character_count,
        json_extract(links,'$[1].deckId'),vndb_id,json_extract(vndb_character_data,'$.character_count')) FROM games WHERE id='g'",[],|r|r.get(0)).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&values).unwrap(),
        json!(["OBS", "New title", "42", "0", "0", 42, "v17", 0])
    );
}

#[test]
fn rechecks_manual_edits_and_merges_links_when_provider_returns() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute_batch("INSERT INTO games(id,title_original,image,manual_overrides) VALUES('g','My title','','[\"title_original\",\"image\",\"title_romaji\"]')").unwrap();
    let history = History::default();
    let metadata = json!({"title_original":"Remote","title_romaji":"Original","description":"Remote description","image":"new","media_type_string":"Game",
        "links":[{"url":"HTTPS://IGDB.COM/GAMES/ONE","linkType":1},{"url":"https://example.invalid/site"}]});
    let request = history
        .begin_metadata_link(&path, "g", false)
        .unwrap()
        .unwrap();
    assert!(request.fetch_cover);
    db.execute_batch("UPDATE games SET description='My edit',manual_overrides='[\"title_original\",\"image\",\"title_romaji\",\"description\"]' WHERE id='g'").unwrap();
    let result = history
        .finish_metadata_link(&path, request, metadata.clone(), MetadataProvider::Igdb)
        .unwrap()
        .unwrap();
    assert_eq!(
        result["updated_fields"],
        json!(["title_romaji", "game_type", "links", "image"])
    );
    assert_eq!(
        result["message"],
        "Game linked to IGDB metadata for \"My title\""
    );
    let again = history
        .begin_metadata_link(&path, "g", false)
        .unwrap()
        .unwrap();
    assert!(!again.fetch_cover);
    let overwrite = history
        .begin_metadata_link(&path, "g", true)
        .unwrap()
        .unwrap();
    let result = history
        .finish_metadata_link(&path, overwrite, metadata.clone(), MetadataProvider::Igdb)
        .unwrap()
        .unwrap();
    assert_eq!(
        result["message"],
        "Game linked to IGDB metadata for \"Remote\""
    );
    let count: i64 = db
        .query_row(
            "SELECT json_array_length(links) FROM games WHERE id='g'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
    history.close().unwrap();
    assert!(history
        .finish_metadata_link(&path, again, metadata, MetadataProvider::Igdb)
        .is_err());
}

#[test]
fn repull_uses_provider_priority_and_reads_overrides_again_before_commit() {
    use gsm_history::library::RepullSources;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let conn = gsm_db::open_profile(&path, "ja").unwrap();
    conn.execute_batch(
        r#"INSERT INTO games(id,deck_id,title_original,vndb_id,links)
        VALUES('g','42','Mine','v17','["https://www.igdb.com/games/test"]')"#,
    )
    .unwrap();
    let history = History::default();
    let target = history.begin_game_repull(&path, "g").unwrap().unwrap();
    assert_eq!(
        target.igdb.as_deref(),
        Some("https://www.igdb.com/games/test")
    );
    let sources = || RepullSources {
        jiten: Some(
            json!({"deck_id":42,"difficulty":0,"title_original":"Jiten","genres":["Drama"]}),
        ),
        vndb: Some(json!({"title_original":"VN","title_romaji":"VN","tags":["Magic"]})),
        igdb: Some(json!({"title_english":"IGDB","links":[{"url":"https://site.invalid/abc"}]})),
        anilist: Some(json!({"title_english":"AniList","release_date":"2020","genres":["Anime"]})),
        ..Default::default()
    };
    conn.execute_batch(
        r#"UPDATE games SET manual_overrides='["title_original","image"]' WHERE id='g'"#,
    )
    .unwrap();
    let result = history
        .finish_game_repull(&path, target, sources())
        .unwrap()
        .unwrap();
    assert_eq!(
        result["sources_used"],
        json!(["jiten", "vndb", "anilist", "igdb"])
    );
    assert_eq!(
        result["updated_fields"],
        json!([
            "difficulty",
            "genres",
            "tags",
            "links",
            "deck_id",
            "title_romaji",
            "title_english",
            "release_date",
            "game_type"
        ])
    );
    assert_eq!(result["skipped_fields"], json!(["title_original", "image"]));
    assert_eq!(result["message"], "Successfully repulled data for \"Mine\"");
    let target = history.begin_game_repull(&path, "g").unwrap().unwrap();
    conn.execute_batch("UPDATE games SET vndb_id='v18' WHERE id='g'")
        .unwrap();
    assert!(history
        .finish_game_repull(&path, target, sources())
        .is_err());
}
