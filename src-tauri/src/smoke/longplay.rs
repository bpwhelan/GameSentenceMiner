use super::*;

pub(super) async fn clip_capture(app: &AppHandle) -> Result<Value, String> {
    let end = std::env::var("GSM_SMOKE_CLIP_END")
        .map_err(|e| e.to_string())?
        .parse::<i64>()
        .map_err(|e| e.to_string())?;
    let port = app
        .state::<std::sync::Arc<crate::mining::MiningService>>()
        .bound_gateway_port()
        .ok_or("Gateway not running")?;
    let empty = app
        .state::<DesktopState>()
        .http
        .post(format!("http://127.0.0.1:{port}/create-media"))
        .json(&json!({"ids":[]}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if empty.status().as_u16() != 400 {
        return Err(format!("Empty media selection returned {}", empty.status()));
    }
    let mut selected = Value::Null;
    let mut following = Value::Null;
    for (i, text) in ["前々", "前の行", "保存する台詞", "次の行", "最後"]
        .into_iter()
        .enumerate()
    {
        let stamp = chrono::DateTime::from_timestamp(end - 10 + i as i64 * 2, 0)
            .ok_or("Invalid fixture epoch")?;
        let reply = crate::text_intake::submit(
            app,
            json!({"source":"manual","text":text,"captured_at":stamp}),
            None,
        )
        .await?;
        if reply["status"] != "accepted" {
            return Err(format!("Clip line rejected: {reply}"));
        }
        if i == 2 {
            selected = reply["line_id"].clone();
        }
        if i == 3 {
            following = reply["line_id"].clone();
        }
    }
    let http = &app.state::<DesktopState>().http;
    let url = format!("http://127.0.0.1:{port}/save-clip");
    let save = || http.post(&url).json(&json!({"id":selected})).send();
    let queued: Value = save()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if queued["queued"] != true {
        return Err(format!("Clip did not queue: {queued}"));
    }
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        let listing: Value = http
            .get(format!("http://127.0.0.1:{port}/api/clips"))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        if listing["clips"][0]["lines"][0]["id"] == selected
            && listing["clips"][0]["size_bytes"].as_u64().unwrap_or(0) > 0
        {
            break;
        }
        if Instant::now() > deadline {
            return Err(format!("Clip was not published: {listing}"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let again: Value = save()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if again["already_saved"] != true || again["queued"] != false {
        return Err(format!("Saving the same clip twice: {again}"));
    }
    let url = format!("http://127.0.0.1:{port}/trim-video");
    for body in [json!({}), json!({"id":"missing"})] {
        let status = http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .status();
        if status.as_u16() != 400 {
            return Err(format!("Bad trim request returned {status}"));
        }
    }
    // Replay the same selection twice, then use a manifest-only line with its original clock.
    let folder = PathBuf::from(
        again["folder"]
            .as_str()
            .ok_or("Missing saved clip folder")?,
    );
    let mut manifest: Value = serde_json::from_slice(
        &std::fs::read(folder.join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let archived = folder.with_file_name("archived");
    std::fs::create_dir(&archived).map_err(|e| e.to_string())?;
    let filename = manifest["clip"]["file"]
        .as_str()
        .ok_or("Missing clip filename")?;
    std::fs::copy(folder.join(filename), archived.join(filename)).map_err(|e| e.to_string())?;
    for line in manifest["lines"]
        .as_array_mut()
        .ok_or("Missing clip lines")?
    {
        if line["id"] == selected {
            line["id"] = json!("archived-line");
        }
    }
    std::fs::write(archived.join("manifest.json"), manifest.to_string())
        .map_err(|e| e.to_string())?;
    let exports = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .join("output")
        .join(chrono::Local::now().format("%Y-%m/%d").to_string());
    for (i, id) in [&selected, &selected, &json!("archived-line")]
        .into_iter()
        .enumerate()
    {
        let reply: Value = http
            .post(&url)
            .json(&json!({"id":id,"show_in_explorer":false}))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        if reply["queued"] != true || reply["line_id"] != *id {
            return Err(format!("Trim request failed: {reply}"));
        }
        let deadline = Instant::now() + Duration::from_secs(45);
        while std::fs::read_dir(&exports)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| {
                e.file_name().to_string_lossy().contains("保存する台詞")
                    && e.metadata().is_ok_and(|m| m.len() > 0)
            })
            .count()
            < i + 1
        {
            if Instant::now() > deadline {
                return Err(format!("Trim {i} did not publish an MP4 in {exports:?}"));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    playback(app, port, &selected).await?;
    super::frame_selector::run(app, port, &selected, &folder, &manifest).await?;
    super::frame_selector::folder(
        app,
        [selected.as_str().unwrap(), following.as_str().unwrap()],
    )
    .await?;
    Ok(again)
}

async fn playback(app: &AppHandle, port: u16, id: &Value) -> Result<(), String> {
    let http = &app.state::<DesktopState>().http;
    let base = format!("http://127.0.0.1:{port}");
    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws/texthooker"))
            .await
            .map_err(|e| e.to_string())?;
    let mut first = String::new();
    for i in 0..17 {
        let result: Value = http
            .post(format!("{base}/play-audio"))
            .json(&json!({"id":id,"playback_mode":"browser"}))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        if result["queued"] != (i == 0) || (i > 0 && result["from_cache"] != true) {
            return Err(format!("Audio cache request {i}: {result}"));
        }
        let url = tokio::time::timeout(Duration::from_secs(30), async {
            while let Some(frame) = socket.next().await {
                let frame = frame.map_err(|e| e.to_string())?;
                let value: Value = serde_json::from_slice(&frame.into_data()).unwrap_or_default();
                if value["line_id"] == *id {
                    if value["event"] == "audio_error" {
                        return Err(value.to_string());
                    }
                    if value["event"] == "audio_ready" {
                        return value["audio_url"]
                            .as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| "Missing audio URL".into());
                    }
                }
            }
            Err("Reader socket closed".into())
        })
        .await
        .map_err(|_| "Audio playback timed out")??;
        if i == 0 {
            first = format!("{base}{url}");
            let response = http.get(&first).send().await.map_err(|e| e.to_string())?;
            let tag = response
                .headers()
                .get("etag")
                .ok_or("Missing audio validator")?
                .clone();
            let len = response.content_length().ok_or("Missing audio length")?;
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            if len < 44 || !bytes.starts_with(b"RIFF") {
                return Err("Missing PCM wave audio".into());
            }
            let cached = http
                .get(&first)
                .header("If-None-Match", tag)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if cached.status().as_u16() != 304 {
                return Err("Matching audio ETag ignored".into());
            }
            let replaced = http
                .get(&first)
                .header("If-Range", "\"another-audio\"")
                .header("Range", "bytes=4-11")
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if replaced.status().as_u16() != 200 || replaced.content_length() != Some(len) {
                return Err("Mismatched audio range validator accepted".into());
            }
            let head = http.head(&first).send().await.map_err(|e| e.to_string())?;
            if head
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                != Some(len)
            {
                return Err("Incorrect audio HEAD length".into());
            }
            let partial = http
                .get(&first)
                .header("Range", "bytes=4-11")
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if partial.status().as_u16() != 206
                || partial.bytes().await.map_err(|e| e.to_string())? != bytes.slice(4..12)
            {
                return Err("Incorrect audio byte range".into());
            }
            let outside = http
                .get(&first)
                .header("Range", format!("bytes={len}-"))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if outside.status().as_u16() != 416 {
                return Err("Invalid audio range accepted".into());
            }
        }
    }
    if http
        .get(first)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .status()
        .as_u16()
        != 404
    {
        return Err("Expired audio token remained available".into());
    }
    Ok(())
}

pub(super) async fn run(app: &AppHandle) -> Result<Value, String> {
    let dir = &app.state::<crate::settings::Settings>().paths.active;
    let obs = app.state::<crate::obs::Obs>();
    let recording = dir.join("capture.mkv");
    if !obs.longplay_event(
        app,
        "RecordStateChanged",
        &json!({"outputActive":true, "outputState":"OBS_WEBSOCKET_OUTPUT_STARTED"}),
    ) {
        return Err("Native longplay did not start".into());
    }
    for line in ["第一行", "最終行"] {
        let reply =
            crate::text_intake::submit(app, json!({"source":"manual","text":line}), None).await?;
        if reply["status"] != "accepted" {
            return Err(format!("Text intake failed: {reply}"));
        }
    }
    // OBS can omit the file path in STOPPED and supply it in the StopRecord response.
    let issued = Instant::now();
    obs.longplay_event(
        app,
        "RecordStateChanged",
        &json!({"outputActive":false,"outputState":"OBS_WEBSOCKET_OUTPUT_STOPPED"}),
    );
    obs.longplay_event(
        app,
        "RecordStateChanged",
        &json!({"outputActive":true,"outputState":"OBS_WEBSOCKET_OUTPUT_STARTED"}),
    );
    let writer = app.state::<crate::longplay::Service>();
    writer.receipt(issued, false, recording.to_str(), "Fixture".into());
    let reply =
        crate::text_intake::submit(app, json!({"source":"manual","text":"次の録画"}), None).await?;
    if reply["status"] != "accepted" {
        return Err(format!("Second recording rejected: {reply}"));
    }
    let next = dir.join("next.mkv");
    obs.longplay_event(app, "RecordFileChanged", &json!({"newOutputPath":next}));
    writer.finish().await?;
    let read =
        |p: PathBuf| std::fs::read_to_string(p.with_extension("srt")).map_err(|e| e.to_string());
    let first = read(recording)?;
    let second = read(next)?;
    let text = |s: &str| {
        s.lines()
            .filter(|s| s.chars().any(|c| !c.is_ascii()))
            .collect::<Vec<_>>()
            .join("|")
    };
    if text(&first) != "第一行|最終行" || text(&second) != "次の録画" {
        return Err(format!("Subtitle mismatch: {first:?}, {second:?}"));
    }
    let service = app.state::<std::sync::Arc<crate::mining::MiningService>>();
    let port = service
        .bound_gateway_port()
        .ok_or("Beacon gateway unavailable")?;
    let url = format!("http://127.0.0.1:{port}/anki/events");
    let http = &app.state::<DesktopState>().http;
    // Exercise the Text Feed's library against a directory containing a legacy manifest.
    let clip = dir.join("output/Clips/2026-11-21/fixture");
    std::fs::create_dir_all(&clip).map_err(|e| e.to_string())?;
    std::fs::write(
        clip.join("manifest.json"),
        serde_json::to_vec(
            &json!({"clip":{"file":"clip.mkv","end_time":"2026-11-21T10:00:05"},
        "lines":[{"id":"a","text":"保存","role":"selected","time":"2026-11-21T10:00:00"}]}),
        )
        .unwrap(),
    )
    .map_err(|e| e.to_string())?;
    let base = format!("http://127.0.0.1:{port}/api/clips");
    let library: Value = http
        .get(&base)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if library
        != json!({"clips":[{"id":"2026-11-21/fixture","size_bytes":0,"lines":[{"id":"a","text":"保存"}]}]})
    {
        return Err(format!("Invalid saved clip catalogue: {library}"));
    }
    let response = http
        .post(format!("{base}/open"))
        .json(&json!({"id":"missing"}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status().as_u16() != 404 {
        return Err("Missing clip opened".into());
    }
    let trash: Value = http
        .post(format!("{base}/trash"))
        .json(&json!({"ids":["missing"]}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if trash != json!({"trashed":[],"failed":[{"id":"missing","error":"Clip not found."}]}) {
        return Err(format!("Invalid saved clip trash response: {trash}"));
    }
    let post = |payload: Value| http.post(&url).json(&payload).send();
    let status = |r: Result<reqwest::Response, reqwest::Error>| {
        r.map(|v| v.status().as_u16()).map_err(|e| e.to_string())
    };
    let plain: Value = http
        .post(format!("http://127.0.0.1:{port}/translate-line"))
        .json(&json!({"id":reply["line_id"]}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if plain["TL"] != "Next recording" {
        return Err(format!("Plain Text Feed translation failed: {plain}"));
    }
    let config = gsm_mining::config::ProfileConfig::load_active(&dir.join("config.json"))
        .map_err(|e| e.to_string())?;
    let fixture = config.anki.url.trim_end_matches('/');
    let polls_url = format!("{fixture}/fixture/mining-polls");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let polls: u64 = http.get(&polls_url).send().await?.json().await?;
            if polls > 0 {
                return Ok::<(), reqwest::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| "Polling did not seed its initial baseline")?
    .map_err(|e| e.to_string())?;
    http.post(polls_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    wait_for_mining_logs(
        dir,
        &[
            "Note 44: Mining started via AnkiConnect polling",
            "Note 44: Mining failed after",
            "Note 44: Mining completed (final_note=44",
        ],
    )
    .await?;

    if status(post(json!({"event":"heartbeat","session_id":"fixture"})).await)? != 204 {
        return Err("Beacon heartbeat failed".into());
    }
    let duplicate = json!({"event":"note_added","session_id":"fixture","note_id":44,
        "note_type_name":"Mining","fields":{"Vocabulary":"録画","Sentence":"次の<b>録画</b>"},
        "card_ids":[2],"tags":["fixture-mining"]});
    if status(post(duplicate).await)? != 202 {
        return Err("The polling note was not delivered by Beacon".into());
    }

    let event = json!({"event":"note_added","session_id":"fixture","note_id":42});
    if status(post(event.clone()).await)? != 202 {
        return Err("Beacon delivery failed".into());
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        tokio::time::sleep(Duration::from_millis(20)).await;
        match status(post(event.clone()).await)? {
            202 => break,
            200 if Instant::now() < deadline => continue,
            code => return Err(format!("Beacon redelivery failed: {code}")),
        }
    }
    let full = json!({"event":"note_added","session_id":"fixture","note_id":43,"note_type_name":"Basic",
        "fields":{"Sentence":"日本語"},"card_ids":[1],"tags":[]});
    if status(post(full).await)? != 202 {
        return Err("Inline Beacon note rejected".into());
    }
    let lookups = format!("{fixture}/fixture/lookups");
    loop {
        let calls: Vec<u64> = http
            .get(&lookups)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        if calls == [44, 44, 42, 42] {
            break;
        }
        if Instant::now() > deadline {
            return Err(format!("Unexpected Anki lookups: {calls:?}"));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if status(post(event).await)? != 200 {
        return Err("Deleted note was mined again".into());
    }
    let expected = [
        "Note 42: Mining started via AnkiBeacon",
        "Note 42: Mining failed after",
        "Note 42: Skipped because the note no longer exists in Anki",
        "Note 43: Skipped by the profile's Anki tag rules",
        "Note 44: Selected dialogue via recent dialogue",
        "Note 44: Anki update completed",
        "Note 44: Saved card link to dialogue history",
        "Note 44: Skipped duplicate mining delivery",
    ];
    wait_for_mining_logs(dir, &expected).await?;
    Ok(json!({"subtitles":3,"lookups":4}))
}

async fn wait_for_mining_logs(dir: &std::path::Path, expected: &[&str]) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let log = std::fs::read_to_string(dir.join("logs/desktop.log")).unwrap_or_default();
        if expected.iter().all(|message| log.contains(message)) {
            return Ok(());
        }
        if Instant::now() > deadline {
            let missing: Vec<_> = expected
                .iter()
                .filter(|message| !log.contains(**message))
                .collect();
            return Err(format!("Missing persisted mining diagnostics: {missing:?}"));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
