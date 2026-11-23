use gsm_history::History;

#[test]
fn scheduled_metadata_uses_reading_dates_and_keeps_unplayed_and_untitled_games() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    let now = 200. * 86400.;
    db.execute_batch("INSERT INTO games(id,title_original,deck_id,vndb_id,anilist_id,status,completed) VALUES
        ('old','Old','1','','','',0),('idle','Idle','2','','','',0),('recent','Recent','','v3','4','in_progress',1),
        ('completed','Done','','v4','','completed',0),('empty','','5','','','',0),
        ('manga','Manga','','','6','',0),('none','None','','','','',0),('zero','Zero','','','7','',0);").unwrap();
    for (i, (id, days)) in [
        ("old", 31),
        ("old", 1),
        ("idle", 15),
        ("recent", 30),
        ("recent", 14),
        ("empty", 40),
        ("zero", 200),
        ("zero", 75),
    ]
    .into_iter()
    .enumerate()
    {
        db.execute(
            "INSERT INTO game_lines(id,game_id,timestamp) VALUES(?,?,?)",
            (i.to_string(), id, now - f64::from(days) * 86400.),
        )
        .unwrap();
    }
    let history = History::default();
    let plan = history.metadata_refresh_plan(&path, 0, now, false).unwrap();
    assert_eq!((plan.total, plan.unlinked, plan.skipped), (8, 1, 3));
    let selected = plan.games.iter().map(|g| g.id.as_str()).collect::<Vec<_>>();
    assert_eq!(selected, ["empty", "recent", "manga", "zero"]);
    assert_eq!(
        history
            .metadata_refresh_plan(&path, 0, now, true)
            .unwrap()
            .games
            .len(),
        7
    );
    history.close().unwrap();
    assert!(history.metadata_refresh_plan(&path, 0, now, false).is_err());
}

#[test]
fn weekly_upgrade_keeps_the_scene_and_does_not_replace_a_concurrent_manual_link() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute_batch(r#"INSERT INTO games(id,vndb_id,title_original,manual_overrides,links,obs_scene_name)
        VALUES('g','v17','My title','["title_original","links"]','["https://manual.invalid/"]','Scene');
        INSERT INTO game_lines(id,game_name,game_id) VALUES('stays','Scene','other');"#).unwrap();
    let history = History::default();
    let plan = history.metadata_refresh_plan(&path, 0, 0., true).unwrap();
    let g = &plan.games[0];
    let data = serde_json::json!({"deck_id":7,"title_original":"Remote","links":["https://remote.invalid/"],
        "character_count":0,"media_type_string":"Visual Novel"});
    let updated = history
        .apply_metadata_upgrade(&path, 0, g, 7, &data, None, None)
        .unwrap()
        .unwrap();
    assert_eq!(updated, ["deck_id", "game_type", "character_count"]);
    let row=db.query_row("SELECT title_original,json_extract(links,'$[0]'),json_extract(links,'$[1].deckId') FROM games WHERE id='g'",
        [],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?))).unwrap();
    assert_eq!(
        row,
        ("My title".into(), "https://manual.invalid/".into(), 7)
    );
    assert_eq!(
        db.query_row("SELECT game_id FROM game_lines WHERE id='stays'", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "other"
    );
    assert!(history
        .apply_metadata_upgrade(&path, 0, g, 9, &data, None, None)
        .unwrap()
        .is_none());
}
