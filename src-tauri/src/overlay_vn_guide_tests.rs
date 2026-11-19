use super::*;

async fn setup(mode: &str) -> (tempfile::TempDir, VnGuideController, Map<String, Value>) {
    let dir = tempfile::tempdir().unwrap();
    let game = dir.path().join("game");
    fs::create_dir(&game).unwrap();
    fs::write(
        game.join("guide.json"),
        json!({"title":"Test Game","routes":[
            {"id":"one","title":"Route One","reviewed":true},
            {"id":"two","title":"Route Two"}
        ]})
        .to_string(),
    )
    .unwrap();
    let route = json!([{"simpleJp":"大丈夫"},{"simpleJp":"セーブ1"},
        {"simpleJp":"進む"},{"simpleJp":"セーブ1にロード"}]);
    for id in ["one", "two"] {
        fs::write(game.join(format!("route_{id}.json")), route.to_string()).unwrap();
    }
    let settings = json!({"vnGuideEnabled":true,"vnGuideUrl":game.to_string_lossy(),
        "vnGuideMode":mode,"vnGuideAutoAdvance":true})
    .as_object()
    .unwrap()
    .clone();
    let mut ctrl = VnGuideController::new(reqwest::Client::new(), dir.path());
    let state = ctrl.configure(&settings, false).await;
    assert_eq!(state["error"], "");
    (dir, ctrl, settings)
}

fn frame(texts: &[&str], id: &str) -> Value {
    json!({"type":"word_coordinates","is_final":true,"line_id":id,"presence_id":id,
        "data":texts.iter().enumerate().map(|(i,text)|json!({"text":text,
            "bounding_rect":{"x1":0.4,"x3":0.6,"y1":0.3+i as f64*0.13,"y3":0.33+i as f64*0.13}
        })).collect::<Vec<_>>()})
}

fn detect(ctrl: &mut VnGuideController) {
    ctrl.observe(&frame(&["大丈夫", "やめよう"], "first-menu"));
    assert_eq!(ctrl.snapshot()["detected"], true);
}

fn advance_choice(ctrl: &mut VnGuideController) {
    ctrl.tracker
        .as_mut()
        .unwrap()
        .armed
        .as_mut()
        .unwrap()
        .since_ms = now_ms() - 1500;
    ctrl.observe(&frame(&["新しい会話"], "dialogue"));
    assert_eq!(ctrl.snapshot()["index"], 2);
}

#[tokio::test]
async fn choice_click_through_follows_live_detection_and_opt_out() {
    let (_dir, mut ctrl, mut settings) = setup("hotkey").await;
    ctrl.set_available(true, None);
    assert_eq!(ctrl.snapshot()["choiceClickThrough"], false);
    detect(&mut ctrl);
    assert_eq!(ctrl.snapshot()["visible"], false);
    assert_eq!(ctrl.snapshot()["choiceClickThrough"], true);
    settings.insert("vnGuideClickThroughOnChoice".into(), json!(false));
    assert_eq!(ctrl.configure(&settings, false).await["choiceClickThrough"], false);
    settings.remove("vnGuideClickThroughOnChoice");
    assert_eq!(ctrl.configure(&settings, false).await["choiceClickThrough"], true);
    ctrl.set_available(false, None);
    ctrl.set_available(true, None);
    assert_eq!(ctrl.snapshot()["choiceClickThrough"], false);
    detect(&mut ctrl);
    assert_eq!(ctrl.snapshot()["choiceClickThrough"], true);
    advance_choice(&mut ctrl);
    assert_eq!(ctrl.snapshot()["choiceClickThrough"], false);
}

#[tokio::test]
async fn hotkey_mode_never_reveals_automatically() {
    let (_dir, mut ctrl, settings) = setup("hotkey").await;
    ctrl.set_available(true, None);
    detect(&mut ctrl);
    assert_eq!(
        ctrl.snapshot()["visible"],
        false,
        "detection is not a hotkey"
    );
    ctrl.command("jump", Some(&json!(1)), &settings).await;
    assert_eq!(ctrl.snapshot()["visible"], false);
    assert_eq!(ctrl.snapshot()["saveNotice"], false);
    ctrl.command("jump", Some(&json!(3)), &settings).await;
    assert_eq!(
        ctrl.snapshot()["visible"],
        false,
        "load instructions also wait for a hotkey"
    );
    ctrl.command("toggle", None, &settings).await;
    assert_eq!(ctrl.snapshot()["visible"], true);
}

#[tokio::test]
async fn window_titles_and_capture_heartbeats_do_not_cancel_manual_guide_previews() {
    for action in ["toggle", "next"] {
        let (_dir, mut ctrl, settings) = setup("auto").await;
        ctrl.set_available(true, Some("Muv-Luv EXTRA"));
        ctrl.command(action, None, &settings).await;
        let before = ctrl.snapshot();
        assert_eq!(before["visible"], true);
        for title in ["Muv-Luv - AGES 7.0", "Muv-Luv - AGES 7.0 - Power Save Mode"] {
            ctrl.observe(&json!({"type":"window_state","data":"active","game":title}));
            ctrl.set_available(true, Some("Muv-Luv EXTRA"));
            let after = ctrl.snapshot();
            assert_eq!(
                after["visible"], true,
                "{action} preview was cancelled by a title update"
            );
            assert_eq!(after["index"], before["index"]);
        }
        // Minimizing suspends the preview; returning to the same scene restores it.
        ctrl.set_available(false, None);
        assert_eq!(ctrl.snapshot()["visible"], false);
        ctrl.set_available(true, Some("Muv-Luv EXTRA"));
        assert_eq!(ctrl.snapshot()["visible"], true);
        // An actual scene switch still invalidates the old preview.
        ctrl.set_available(true, Some("Another game"));
        assert!(!ctrl.peek);
    }
}

#[tokio::test]
async fn window_title_updates_preserve_an_armed_choice() {
    let (_dir, mut ctrl, _settings) = setup("auto").await;
    ctrl.set_available(true, Some("Muv-Luv EXTRA"));
    detect(&mut ctrl);
    ctrl.observe(&json!({"type":"window_state","data":"active","game":"Muv-Luv - AGES 7.0"}));
    ctrl.set_available(true, Some("Muv-Luv EXTRA"));
    assert_eq!(ctrl.snapshot()["detected"], true);
    advance_choice(&mut ctrl);
}

#[tokio::test]
async fn save_notice_waits_for_capture_and_is_only_automatic() {
    let (_dir, mut ctrl, settings) = setup("auto").await;
    ctrl.command("jump", Some(&json!(1)), &settings).await;
    assert_eq!(
        ctrl.save_notice_until, None,
        "do not spend the notice while no game is available"
    );
    ctrl.set_available(true, None);
    assert_eq!(ctrl.snapshot()["saveNotice"], true);
    ctrl.save_notice_until = Some(now_ms() - 1);
    assert!(
        ctrl.set_available(true, None),
        "expiry must publish a hide without new game text"
    );
    assert_eq!(ctrl.snapshot()["visible"], false);
    let mut always = settings.clone();
    always.insert("vnGuideMode".into(), json!("always"));
    ctrl.configure(&always, false).await;
    ctrl.command("jump", Some(&json!(1)), &always).await;
    assert_eq!(ctrl.snapshot()["visible"], true);
    assert_eq!(
        ctrl.snapshot()["saveNotice"],
        false,
        "Always shows the actual choice and its save reminder"
    );
}

#[tokio::test]
async fn expired_confirmation_does_not_expose_the_next_choice_or_skip_it() {
    for mode in ["auto", "hotkey"] {
        let (_dir, mut ctrl, settings) = setup(mode).await;
        ctrl.set_available(true, None);
        ctrl.command("toggle", None, &settings).await;
        detect(&mut ctrl);
        advance_choice(&mut ctrl);
        assert_eq!(ctrl.snapshot()["loggedChoice"], "大丈夫");
        ctrl.logged_until = now_ms() - 1;
        assert!(ctrl.set_available(true, None));
        assert_eq!(
            ctrl.snapshot()["visible"],
            false,
            "confirmation expiry must hide previews too"
        );
        ctrl.command("next", None, &settings).await;
        assert_eq!(
            ctrl.snapshot()["index"],
            2,
            "Next reveals the pending step before advancing"
        );
        assert_eq!(ctrl.snapshot()["loggedChoice"], Value::Null);
        assert_eq!(ctrl.snapshot()["visible"], true);
    }
}

#[tokio::test]
async fn dismissed_choice_does_not_suppress_the_next_menu() {
    let (_dir, mut ctrl, settings) = setup("auto").await;
    ctrl.set_available(true, None);
    detect(&mut ctrl);
    ctrl.command("hide", None, &settings).await;
    ctrl.observe(&frame(&["大丈夫", "やめよう"], "first-menu"));
    assert_eq!(ctrl.snapshot()["visible"], false);
    advance_choice(&mut ctrl);
    ctrl.observe(&frame(&["進む", "戻る"], "next-menu"));
    assert_eq!(ctrl.snapshot()["visible"], true);
    assert_eq!(ctrl.snapshot()["saveInstructions"], json!(["セーブ1"]));
}

#[tokio::test]
async fn suspended_choice_is_reported_as_remembered() {
    let (_dir, mut ctrl, _settings) = setup("auto").await;
    ctrl.set_available(true, None);
    detect(&mut ctrl);
    ctrl.set_available(false, None);
    ctrl.set_available(true, None);
    assert_eq!(ctrl.snapshot()["rememberedChoice"], true);
    assert_eq!(
        ctrl.snapshot()["detected"],
        false,
        "a suspended scan is not a fresh detection"
    );
}

#[tokio::test]
async fn completion_is_visible_and_continuation_preserves_route_progress() {
    let (dir, mut ctrl, settings) = setup("auto").await;
    ctrl.set_available(true, None);
    assert_eq!(ctrl.snapshot()["nextRoute"], Value::Null);
    ctrl.command("jump", Some(&json!(4)), &settings).await;
    assert_eq!(ctrl.snapshot()["complete"], true);
    assert_eq!(ctrl.snapshot()["visible"], true);
    assert_eq!(ctrl.snapshot()["nextRoute"]["id"], "two");
    let (state, route) = ctrl.command("next", None, &settings).await;
    assert_eq!(route.as_deref(), Some("two"));
    assert_eq!(state["index"], 0);
    assert_eq!(
        state["reviewed"], false,
        "missing review metadata must not claim an upstream review"
    );
    let mut reopened = VnGuideController::new(reqwest::Client::new(), dir.path());
    assert_eq!(reopened.configure(&settings, false).await["complete"], true);
}

#[tokio::test]
async fn invalid_jump_preserves_position_and_a_valid_jump_clears_the_error() {
    let (_dir, mut ctrl, settings) = setup("auto").await;
    ctrl.command("jump", Some(&json!(2)), &settings).await;
    for value in [json!(-1), json!(1.5), json!(99), Value::Null] {
        let (state, _) = ctrl.command("jump", Some(&value), &settings).await;
        assert_eq!(state["index"], 2);
        assert!(!state["error"].as_str().unwrap().is_empty());
    }
    let (state, _) = ctrl.command("jump", Some(&json!(0)), &settings).await;
    assert_eq!(state["error"], "");
    assert_eq!(state["index"], 0);
}

#[tokio::test]
async fn failed_progress_write_is_visible_and_retryable() {
    let (dir, mut ctrl, settings) = setup("auto").await;
    ctrl.store.progress_file = dir.path().join("directory-instead-of-file");
    fs::create_dir(&ctrl.store.progress_file).unwrap();
    let (state, _) = ctrl.command("next", None, &settings).await;
    assert!(state["error"]
        .as_str()
        .unwrap()
        .contains("save guide progress"));
    ctrl.store.progress_file = dir.path().join("vn-guide-progress.json");
    let (state, _) = ctrl.command("back", None, &settings).await;
    assert_eq!(state["error"], "");
    assert_eq!(state["index"], 0);
}

#[tokio::test]
async fn always_mode_replaces_confirmation_on_the_availability_tick() {
    let (_dir, mut ctrl, _settings) = setup("always").await;
    ctrl.set_available(true, None);
    detect(&mut ctrl);
    advance_choice(&mut ctrl);
    ctrl.logged_until = now_ms() - 1;
    assert!(ctrl.set_available(true, None));
    assert_eq!(ctrl.snapshot()["loggedChoice"], Value::Null);
    assert_eq!(ctrl.snapshot()["visible"], true);
    assert_eq!(ctrl.snapshot()["text"], "進む");
    assert_eq!(ctrl.snapshot()["saveNotice"], false);
}

#[tokio::test]
async fn update_checks_do_not_replace_progress_and_ignore_stale_routes() {
    let (dir, mut ctrl, settings) = setup("auto").await;
    assert!(ctrl.needs_periodic_update_check());
    let check = ctrl.begin_update_check(true).unwrap();
    assert!(ctrl.snapshot()["checkingUpdates"].as_bool().unwrap());
    assert!(!ctrl.needs_periodic_update_check());
    assert!(
        ctrl.begin_update_check(true).is_none(),
        "only one check per selection"
    );
    // Continue reading while the source request is in flight.
    ctrl.command("next", None, &settings).await;
    fs::write(
        dir.path().join("game/route_one.json"),
        json!([{"simpleJp":"変更された選択肢"}]).to_string(),
    )
    .unwrap();
    assert!(ctrl.finish_update_check(check.run().await));
    assert_eq!(ctrl.snapshot()["index"], 2);
    assert_eq!(ctrl.snapshot()["text"], "進む");
    assert_eq!(ctrl.snapshot()["updateAvailable"], true);
    assert_eq!(ctrl.snapshot()["checkingUpdates"], false);
    assert!(!ctrl.needs_periodic_update_check());

    let mut disabled = settings.clone();
    disabled.insert("vnGuideEnabled".into(), json!(false));
    ctrl.configure(&disabled, false).await;
    ctrl.configure(&settings, false).await;
    let reopened_check = ctrl.begin_update_check(false).unwrap();
    assert!(ctrl.finish_update_check(reopened_check.run().await));
    assert_eq!(
        ctrl.snapshot()["updateAvailable"],
        true,
        "reopening cached content must not forget an update"
    );

    let stale = ctrl.begin_update_check(true).unwrap();
    let mut next_route = settings.clone();
    next_route.insert("vnGuideRoute".into(), json!("two"));
    ctrl.configure(&next_route, false).await;
    assert!(!ctrl.finish_update_check(stale.run().await));
    assert_eq!(ctrl.snapshot()["updateAvailable"], false);
    assert_eq!(ctrl.snapshot()["routeId"], "two");
    assert!(
        ctrl.needs_periodic_update_check(),
        "each route gets its own initial check"
    );
}

#[tokio::test]
async fn unavailable_update_source_preserves_the_playable_cached_guide() {
    let (dir, mut ctrl, settings) = setup("auto").await;
    let check = ctrl.begin_update_check(true).unwrap();
    fs::remove_file(dir.path().join("game/route_one.json")).unwrap();
    assert!(ctrl.finish_update_check(check.run().await));
    assert!(!ctrl.snapshot()["updateError"].as_str().unwrap().is_empty());
    assert_eq!(ctrl.snapshot()["error"], "");
    assert_eq!(ctrl.snapshot()["checkingUpdates"], false);
    let (state, _) = ctrl.command("next", None, &settings).await;
    assert_eq!(state["index"], 2);
    assert_eq!(state["text"], "進む");
}
