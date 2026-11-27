use super::{media_tools, string, DesktopState, Editor, MiningService, Settings};
use crate::{
    anki_connect::Collection,
    gui_dialog::{self, Dialog},
    mining::{pipeline, session_review::parse_game_line_value},
};
use gsm_mining::{
    config::{AnkiCard, ProfileConfig},
    policy::{image_tags, normalize_anki_sentence_line_breaks, sentence_for_current_card_html},
    text::{media_filename_for_game, parse_iso_to_epoch, remove_html_and_cloze_tags, GameLine},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

struct Entry {
    path: PathBuf,
    data: Value,
}

impl Entry {
    fn read(path: PathBuf) -> Result<Self, String> {
        let data = gsm_settings::read_object(&path.join("review.json"))?;
        if data["version"] != 1 || !data.is_object() {
            return Err("Unsupported saved review".into());
        }
        Ok(Self { path, data })
    }

    fn matches(&self, profile: &ProfileConfig, status: &str) -> bool {
        self.data["status"] == status
            && self.data["profile_name"] == profile.name
            && self.data["anki_url"] == profile.anki.url
            && !crate::mining::session_review::initializing(&self.path)
    }

    fn config(&self, mut profile: ProfileConfig) -> ProfileConfig {
        // Python and Rust saved the same manifest with different representations of Anki field settings.
        let snapshot = json!({"anki":self.data["anki_config"],"audio":self.data["audio_config"],"screenshot":self.data["screenshot_config"]});
        let compatible =
            ProfileConfig::from_profile_object(&profile.name, snapshot.as_object().unwrap());
        profile.anki = serde_json::from_value(snapshot["anki"].clone()).unwrap_or(compatible.anki);
        profile.anki.url = string(&self.data["anki_url"]).into();
        profile.audio =
            serde_json::from_value(snapshot["audio"].clone()).unwrap_or(compatible.audio);
        profile.screenshot =
            serde_json::from_value(snapshot["screenshot"].clone()).unwrap_or(compatible.screenshot);
        profile.ai.anki_field = string(&self.data["translation_field"]).into();
        profile.ai.enabled &= !profile.ai.anki_field.is_empty();
        profile
    }

    fn media(&self, name: &Value) -> Option<PathBuf> {
        inside_file(&self.path, string(name))
    }

    fn note_id(&self) -> Result<u64, String> {
        self.data["note_id"]
            .as_u64()
            .or_else(|| string(&self.data["note_id"]).parse().ok())
            .filter(|&n| n > 0)
            .ok_or_else(|| "Invalid saved Anki note ID".into())
    }

    fn persist(&self) -> Result<(), String> {
        let path = self.path.join("review.json");
        gsm_settings::with_lock(&path, || gsm_settings::write_atomic(&path, &self.data))
    }

    fn finish(&mut self) -> Result<(), String> {
        self.data["status"] = json!("reviewed");
        self.persist()?;
        let future = self.path.join("future");
        let future_clean = !future.exists() || fs::remove_dir_all(&future).is_ok();
        if future_clean && names(&self.data["cleanup_pending"]).is_empty() {
            let _ = fs::remove_dir_all(&self.path);
        }
        Ok(())
    }
}

fn root(app: &AppHandle) -> PathBuf {
    app.state::<Settings>().paths.active.join("session_review")
}

fn entries(app: &AppHandle, config: &ProfileConfig, status: &str) -> Vec<Entry> {
    let mut rows: Vec<_> = fs::read_dir(root(app))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|ty| ty.is_dir()))
        .filter_map(|entry| Entry::read(entry.path()).ok())
        .filter(|entry| entry.matches(config, status))
        .collect();
    rows.sort_by(|a, b| string(&a.data["created_at"]).cmp(string(&b.data["created_at"])));
    rows
}

fn active(app: &AppHandle) -> Result<ProfileConfig, String> {
    app.state::<Arc<MiningService>>().load_config()
}

fn pending(app: &AppHandle, id: &str) -> Result<(Entry, ProfileConfig), String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("Invalid saved review ID".into());
    }
    let profile = active(app)?;
    let path = root(app).join(id);
    if !fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
        return Err("This review is no longer pending".into());
    }
    let entry = Entry::read(path)?;
    if !entry.matches(&profile, "pending") {
        return Err("This review is no longer pending for the current profile".into());
    }
    Ok((entry, profile))
}

pub(super) fn count(app: &AppHandle) -> usize {
    active(app).map_or(0, |config| entries(app, &config, "pending").len())
}

pub(super) fn list(app: &AppHandle) -> Result<Value, String> {
    let profile = active(app)?;
    let queue = entries(app, &profile, "pending")
        .into_iter()
        .map(|entry| {
            json!({
                "id":entry.path.file_name().unwrap_or_default().to_string_lossy(),
                "expression":remove_html_and_cloze_tags(string(&entry.data["expression"])),
                "sentence":remove_html_and_cloze_tags(string(&entry.data["sentence"])),
                "scene":entry.data["scene"],"created":entry.data["created_at"]
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({"entries":queue}))
}

fn names(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn inside_file(directory: &Path, name: &str) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    let root = directory.canonicalize().ok()?;
    let path = root.join(name).canonicalize().ok()?;
    (path.starts_with(&root) && path.is_file()).then_some(path)
}

fn manifest(directory: &Path) -> Result<(Value, PathBuf, Vec<GameLine>), String> {
    let file =
        inside_file(directory, "manifest.json").ok_or("The saved replay manifest is missing")?;
    let data = gsm_settings::read_object(&file)?;
    let video = inside_file(directory, string(&data["clip"]["file"]))
        .ok_or("The saved replay is missing")?;
    let mut lines = data["lines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(parse_game_line_value)
        .collect::<Vec<_>>();
    lines.sort_by(|a, b| a.time_epoch.total_cmp(&b.time_epoch));
    Ok((data, video, lines))
}

pub(super) fn editor(app: &AppHandle, id: &str) -> Result<Editor, String> {
    let (entry, profile) = pending(app, id)?;
    let config = entry.config(profile);
    let (manifest, video, lines) = manifest(&entry.path)?;
    let data = &entry.data;
    let selected_ids = names(&data["selected_ids"]);
    let selected = lines
        .iter()
        .filter(|line| selected_ids.contains(&line.id))
        .collect::<Vec<_>>();
    let mut vad = data["vad"].clone();
    if vad.is_object() {
        vad["trimmed_audio_path"] = json!(entry.media(&vad["trimmed_audio_path"]));
    }
    let mut edit = data["audio_edit_context"].clone();
    if edit.is_object() {
        edit["source_audio_path"] =
            json!(entry.media(&edit["source_audio_path"]).unwrap_or_default());
        if edit["timing_fallback"].is_null() {
            edit["timing_fallback"] = false.into();
        }
    }
    let request = json!({
        "expression":data["expression"],"sentence":data["sentence"],"translation":data["translation"],
        "screenshot_path":entry.media(&data["screenshot"]),"previous_screenshot_path":entry.media(&data["previous_screenshot"]),
        "audio_path":entry.media(&data["audio"]),"vad_result":vad,"audio_edit_context":edit,
        "reusing_audio":entry.media(&data["audio"]).is_none() && file_missing(&vad["trimmed_audio_path"])
            && !string(&data["fields"][&config.anki.sentence_audio.name]).trim().is_empty(),
        "screenshot_timestamp":data["screenshot_time"],"previous_screenshot_timestamp":data["previous_screenshot_time"],
        "video_path":video,"anki_card_creation_time":manifest["clip"]["end_time"],"pauses":manifest["pauses"],
        "mined_line":lines.iter().find(|line|line.id == string(&data["line_id"])),
        "selected_lines":selected,"pending_animated":data["pending_animated"]
    });
    let mut editor = Editor::new(app, request, config, lines, true)?;
    set_future(&entry.path, &mut editor);
    Ok(editor)
}

fn file_missing(value: &Value) -> bool {
    value.as_str().is_none_or(|path| !Path::new(path).is_file())
}

pub(super) fn refresh_future(app: &AppHandle, id: &str, editor: &mut Editor) -> Result<(), String> {
    if editor.future.is_none() {
        set_future(&pending(app, id)?.0.path, editor);
    }
    Ok(())
}

fn set_future(path: &Path, editor: &mut Editor) {
    let directory = path.join("future");
    if fs::symlink_metadata(&directory).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
        if let Ok((data, video, lines)) = manifest(&directory) {
            if let Some(end) = parse_iso_to_epoch(string(&data["clip"]["end_time"])) {
                editor.request["future_pauses"] = data["pauses"].clone();
                editor.future = Some((video, end, lines));
            }
        }
    }
}

fn url(config: &ProfileConfig) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(&config.anki.url).map_err(|e| e.to_string())?;
    if matches!(url.scheme(), "http" | "https") {
        Ok(url)
    } else {
        Err("Invalid AnkiConnect URL".into())
    }
}

async fn call(anki: &Collection<'_>, action: &str, params: Value) -> Result<Value, String> {
    anki.call(action, params, |raw| {
        serde_json::from_str(raw.get()).map_err(|e| e.to_string())
    })
    .await
}

async fn current(
    anki: &Collection<'_>,
    entry: &Entry,
    config: &ProfileConfig,
) -> Result<Option<AnkiCard>, String> {
    if pipeline::anki_active_profile(anki.client, anki.url).await?
        != string(&entry.data["anki_profile"])
    {
        return Err(format!(
            "Open Anki profile {} to review this card.",
            string(&entry.data["anki_profile"])
        ));
    }
    let card = pipeline::fetch_card_by_id(anki.client, anki.url, entry.note_id()?).await?;
    if let Some(card) = &card {
        if card.model_name != entry.data["model_name"]
            || card.get_field(&config.anki.word.name) != entry.data["expression"].as_str()
        {
            return Err("This note's expression or note type changed in Anki.".into());
        }
    }
    Ok(card)
}

pub(super) async fn open_in_anki(app: &AppHandle, id: &str) -> Result<Value, String> {
    let (mut entry, profile) = pending(app, id)?;
    let config = entry.config(profile);
    let url = url(&config)?;
    let desktop = app.state::<DesktopState>();
    let anki = Collection {
        client: &desktop.http,
        url: &url,
    };
    if current(&anki, &entry, &config).await?.is_none() {
        entry.finish()?;
        return Ok(json!("missing"));
    }
    call(&anki, "guiEditNote", json!({"note":entry.note_id()?})).await?;
    Ok(json!("opened"))
}

pub(super) async fn discard(app: &AppHandle, id: &str, delete: bool) -> Result<Value, String> {
    let (mut entry, profile) = pending(app, id)?;
    let config = entry.config(profile);
    if delete {
        let url = url(&config)?;
        let desktop = app.state::<DesktopState>();
        let anki = Collection {
            client: &desktop.http,
            url: &url,
        };
        if current(&anki, &entry, &config).await?.is_some() {
            delete_note(&anki, entry.note_id()?).await?;
        }
        let owned = names(&entry.data["owned_media"]);
        invalidate_media(app, string(&entry.data["line_id"]), &owned);
        entry.data["cleanup_pending"] = json!(cleanup(&anki, owned).await);
        app.state::<Arc<MiningService>>()
            .forget_note(entry.note_id()?);
    }
    entry.finish()?;
    Ok(json!(if delete { "deleted" } else { "kept" }))
}

async fn delete_note(anki: &Collection<'_>, id: u64) -> Result<(), String> {
    call(anki, "deleteNotes", json!({"notes":[id]})).await?;
    if pipeline::fetch_card_by_id(anki.client, anki.url, id)
        .await?
        .is_some()
    {
        return Err("Anki did not delete the note".into());
    }
    Ok(())
}

async fn store(
    app: &AppHandle,
    anki: &Collection<'_>,
    entry: &mut Entry,
    path: &Path,
) -> Result<String, String> {
    let name = media_filename_for_game(&path.to_string_lossy(), string(&entry.data["scene"]));
    let mut owned = names(&entry.data["owned_media"]);
    if !owned.contains(&name) {
        owned.push(name.clone());
        entry.data["owned_media"] = json!(owned);
        entry.persist()?;
    }
    let stored = crate::anki_media::store_file(anki.client, anki.url, path, &name).await?;
    if stored != name && !owned.contains(&stored) {
        owned.push(stored.clone());
        entry.data["owned_media"] = json!(owned);
        entry.persist()?;
    }
    let _ = app;
    Ok(stored)
}

async fn images(
    app: &AppHandle,
    anki: &Collection<'_>,
    entry: &mut Entry,
    config: &ProfileConfig,
    result: &Value,
) -> Result<Vec<String>, String> {
    let (_, selection) = pipeline::parse_screenshot_return(result);
    let selection = selection.ok_or("The selected screenshots are unavailable")?;
    let mut uploaded = Vec::new();
    for item in selection.items {
        let tools = media_tools(app);
        let mut config = config.clone();
        config.screenshot.animated = false;
        let source = selection.source_path.clone();
        let scene = string(&entry.data["scene"]).to_owned();
        let image = PathBuf::from(item.path);
        let encoded = tauri::async_runtime::spawn_blocking(move || {
            tools.encode_screenshot(
                &image,
                Some(Path::new(&source)),
                Some(item.start),
                None,
                false,
                &scene,
                &config,
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        uploaded.push(store(app, anki, entry, &encoded).await?);
    }
    Ok(uploaded)
}

pub(super) async fn save(
    app: &AppHandle,
    id: &str,
    config: &ProfileConfig,
    values: Value,
) -> Result<Value, String> {
    let (mut entry, _) = pending(app, id)?;
    let url = url(config)?;
    let desktop = app.state::<DesktopState>();
    let anki = Collection {
        client: &desktop.http,
        url: &url,
    };
    let Some(note) = current(&anki, &entry, config).await? else {
        entry.finish()?;
        return Ok(json!("missing"));
    };
    let meta = &values[7];
    let mut fields = HashMap::new();
    let mut history_audio = None;
    let mut history_screenshot = None;
    let mut history_translation = None;
    let settings = &config.anki;
    let sentence = string(&values[1]);
    if settings.sentence.is_active() && sentence.trim() != string(&entry.data["sentence"]).trim() {
        let sentence = sentence_for_current_card_html(&note, sentence, settings);
        if settings.sentence_furigana.is_active() {
            let language = app.state::<Arc<gsm_sudachi::LanguageService>>();
            let plain = remove_html_and_cloze_tags(&sentence);
            let furigana =
                crate::mining::furigana::generate_sentence_furigana(&language, &sentence, &plain)
                    .await;
            fields.insert(settings.sentence_furigana.name.clone(), furigana);
        }
        fields.insert(settings.sentence.name.clone(), sentence);
    }
    let translation = string(&values[2]);
    if config.ai.enabled && translation.trim() != string(&entry.data["translation"]).trim() {
        fields.insert(config.ai.anki_field.clone(), translation.into());
        history_translation = Some(translation.into());
    }
    if settings.previous_sentence.is_active() && meta["line_selection_changed"] == true {
        let (_, _, lines) = manifest(&entry.path)?;
        if let Some(first) = parse_game_line_value(&meta["selected_lines"][0]) {
            let before = lines.iter().rev().find(|l| l.time_epoch < first.time_epoch);
            fields.insert(
                settings.previous_sentence.name.clone(),
                before.map_or_else(String::new, |l| l.text.clone()),
            );
        }
    }
    let voice = values[0] == true;
    let had_audio = !string(&entry.data["fields"][&settings.sentence_audio.name])
        .trim()
        .is_empty();
    let change_audio = settings.sentence_audio.is_active()
        && (voice != had_audio || (voice && meta["audio_changed"] == true));
    let may_change = [
        (change_audio, &settings.sentence_audio.name),
        (
            settings.picture.is_active() && meta["picture_changed"] == true,
            &settings.picture.name,
        ),
        (
            settings.previous_image.is_active() && meta["previous_changed"] == true,
            &settings.previous_image.name,
        ),
    ];
    for name in fields.keys().chain(
        may_change
            .iter()
            .filter_map(|(yes, name)| yes.then_some(*name)),
    ) {
        if !note.has_field(name) {
            return Err(format!("Anki field {name} is missing"));
        }
        if note.get_field(name) != entry.data["fields"][name].as_str().or(Some(""))
            && fields.get(name).map(String::as_str) != note.get_field(name)
        {
            return Err(format!(
                "The {name} field was changed in Anki. Restore it before saving the review."
            ));
        }
    }
    if change_audio {
        let name = if voice {
            let path = PathBuf::from(string(&values[6]));
            if path.as_os_str().is_empty() {
                return Err("The selected audio is unavailable".into());
            }
            store(app, &anki, &mut entry, &path).await?
        } else {
            String::new()
        };
        fields.insert(
            settings.sentence_audio.name.clone(),
            if voice {
                format!("[sound:{name}]")
            } else {
                String::new()
            },
        );
        history_audio = Some(name);
    }
    for (changed, field, value) in [
        ("picture_changed", &settings.picture, &values[3]),
        ("previous_changed", &settings.previous_image, &values[4]),
    ] {
        if field.is_active() && meta[changed] == true {
            let stored = images(app, &anki, &mut entry, config, value).await?;
            if changed == "picture_changed" {
                history_screenshot = stored.first().cloned();
            }
            fields.insert(field.name.clone(), image_tags(&stored));
        }
    }
    normalize_anki_sentence_line_breaks(&mut fields, settings);
    let Some(latest) = current(&anki, &entry, config).await? else {
        entry.finish()?;
        return Ok(json!("missing"));
    };
    for (name, value) in &fields {
        let current = latest
            .get_field(name)
            .ok_or_else(|| format!("Anki field {name} is missing"))?;
        if current != string(&entry.data["fields"][name]) && current != value {
            return Err(format!(
                "The {name} field was changed in Anki. Restore it before saving the review."
            ));
        }
    }
    let mut tags = Vec::new();
    if values[5] == true && !latest.tags.iter().any(|tag| tag == "NSFW") {
        tags.push("NSFW".to_owned());
    }
    let unvoiced = latest.tags.iter().any(|tag| tag == "unvoiced");
    if change_audio && settings.tag_unvoiced_cards && !voice && !unvoiced {
        tags.push("unvoiced".to_owned());
    }
    let note_id = entry.note_id()?;
    if !fields.is_empty() {
        pipeline::anki_gui_deselect_if_open(anki.client, anki.url, note_id).await;
        call(
            &anki,
            "updateNoteFields",
            json!({"note":{"id":note_id,"fields":fields}}),
        )
        .await?;
        let verified = current(&anki, &entry, config)
            .await?
            .ok_or("Anki removed the note during review")?;
        if fields
            .iter()
            .any(|(name, value)| verified.get_field(name) != Some(value))
        {
            return Err(
                "Anki did not retain every edited field. Close its note editor and save again."
                    .into(),
            );
        }
        for (name, value) in &fields {
            entry.data["fields"][name] = json!(value);
        }
        entry.persist()?;
    }
    if !tags.is_empty() {
        call(
            &anki,
            "addTags",
            json!({"notes":[note_id],"tags":tags.join(" ")}),
        )
        .await?;
    }
    if change_audio && settings.tag_unvoiced_cards && voice && unvoiced {
        call(
            &anki,
            "removeTags",
            json!({"notes":[note_id],"tags":"unvoiced"}),
        )
        .await?;
    }
    let final_id = group(app, &anki, &mut entry, config, &latest)
        .await?
        .unwrap_or(note_id);
    let line_id = string(&entry.data["line_id"]).to_owned();
    if !line_id.is_empty()
        && (final_id != note_id
            || history_audio.is_some()
            || history_screenshot.is_some()
            || history_translation.is_some())
    {
        app.state::<crate::text_intake::Intake>()
            .persist_card(gsm_history::mining::MinedLine {
                line_id: line_id.clone(),
                audio_in_anki: history_audio,
                screenshot_in_anki: history_screenshot,
                translation: history_translation,
                note_id: Some(gsm_history::mining::NoteId::Integer(final_id as i64)),
                screenshot_path: None,
                audio_path: None,
                replay_path: None,
            });
    }
    let owned = names(&entry.data["owned_media"]);
    let obsolete = owned
        .into_iter()
        .filter(|name| {
            !entry.data["fields"]
                .as_object()
                .into_iter()
                .flatten()
                .any(|(_, v)| string(v).contains(name))
        })
        .collect::<Vec<_>>();
    if change_audio || meta["picture_changed"] == true || meta["previous_changed"] == true {
        invalidate_media(app, &line_id, &obsolete);
    }
    entry.data["cleanup_pending"] = json!(cleanup(&anki, obsolete).await);
    entry.finish()?;
    crate::anki_sync::trigger_incremental(
        app.clone(),
        url,
        settings.word.name.clone(),
        settings.parent_tag.clone(),
        vec![final_id as i64],
    );
    Ok(json!("saved"))
}

async fn group(
    app: &AppHandle,
    anki: &Collection<'_>,
    entry: &mut Entry,
    config: &ProfileConfig,
    note: &AnkiCard,
) -> Result<Option<u64>, String> {
    let settings = &config.anki;
    if let Some(target) = entry.data["grouped_into"].as_u64() {
        delete_note(anki, note.note_id).await?;
        app.state::<Arc<MiningService>>().forget_note(note.note_id);
        return Ok(Some(target));
    }
    let word = remove_html_and_cloze_tags(string(&entry.data["expression"]));
    if !settings.field_grouping_enabled || word.trim().is_empty() {
        return Ok(None);
    }
    let oldest = settings.field_grouping_auto_merge;
    let candidates = crate::anki_group::find_candidates(
        app,
        anki.url,
        note.note_id,
        &word,
        &settings.word.name,
        &note.model_name,
        &settings.sentence.name,
        oldest,
    )
    .await?;
    let Some(candidates) = candidates.as_array().filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let choice = if oldest {
        json!({"target_note_id":candidates[0]["note_id"],"order":settings.field_grouping_order,
            "delete_duplicate":settings.field_grouping_delete_duplicate,"overwrite":settings.field_grouping_overwrite})
    } else {
        gui_dialog::open(
            app,
            Dialog::AnkiFieldGrouping {
                expression: word,
                candidates: candidates.clone(),
                default_order: Some(settings.field_grouping_order.clone()),
                default_delete_duplicate: Some(settings.field_grouping_delete_duplicate),
            },
        )
        .await?
    };
    let Some(target) = choice["target_note_id"].as_u64() else {
        return Ok(None);
    };
    let source = current(anki, entry, config)
        .await?
        .ok_or("The note disappeared before grouping")?;
    let back = string(&choice["order"]).eq_ignore_ascii_case("back");
    let overwrite = choice["overwrite"]
        .as_bool()
        .unwrap_or(settings.field_grouping_overwrite);
    let mut seen = HashSet::from([settings.word.name.trim().to_lowercase()]);
    let fields: Vec<_> = [
        (&settings.picture.name, true, false),
        (&settings.sentence.name, false, true),
        (&settings.sentence_audio.name, false, false),
        (&settings.sentence_furigana.name, false, true),
        (&config.ai.anki_field, false, false),
    ]
    .into_iter()
    .chain(
        settings
            .field_grouping_additional_fields
            .iter()
            .map(|name| (name, false, false)),
    )
    .filter_map(|(name, image, breaks)| {
        let name = name.trim();
        let value = source.get_field(name)?;
        (!value.trim().is_empty() && seen.insert(name.to_lowercase()))
            .then(|| (name.to_owned(), value.to_owned(), image, breaks))
    })
    .collect();
    if fields.is_empty() {
        return Err("No configured context fields contain data to merge".into());
    }
    let merged = crate::anki_group::merge_into(
        app,
        anki.url,
        note.note_id,
        target,
        fields,
        source.tags,
        back,
        overwrite,
        settings.remove_overlay_tag,
        false,
    )
    .await?;
    if merged != true {
        return Err("Anki grouping did not save the selected context".into());
    }
    if choice["delete_duplicate"] == true {
        entry.data["grouped_into"] = json!(target);
        entry.persist()?;
        delete_note(anki, note.note_id).await?;
        app.state::<Arc<MiningService>>().forget_note(note.note_id);
    }
    Ok(Some(target))
}

fn invalidate_media(app: &AppHandle, line: &str, obsolete: &[String]) {
    let service = app.state::<Arc<MiningService>>();
    let mut removed = HashSet::new();
    service.results.lock().unwrap().retain(|id, result| {
        let invalidate = id == line
            || obsolete.iter().any(|name| {
                name == &result.audio_in_anki
                    || name == &result.screenshot_in_anki
                    || name == &result.prev_screenshot_in_anki
                    || name == &result.video_in_anki
                    || result.screenshot_media_in_anki.contains(name)
                    || result.prev_screenshot_media_in_anki.contains(name)
            });
        if invalidate {
            removed.insert(id.clone());
        }
        !invalidate
    });
    service
        .sentence_audio_cache
        .lock()
        .unwrap()
        .retain(|_, item| !removed.contains(&item.line_id));
}

async fn cleanup(anki: &Collection<'_>, mut files: Vec<String>) -> Vec<String> {
    files.sort();
    files.dedup();
    if files.is_empty() {
        return files;
    }
    let Ok(models) = call(anki, "modelNames", json!({})).await else {
        return files;
    };
    let Some(models) = models.as_array() else {
        return files;
    };
    let mut templates = String::new();
    for model in models {
        for action in ["modelTemplates", "modelStyling"] {
            let Ok(value) = call(anki, action, json!({"modelName":model})).await else {
                return files;
            };
            templates.push_str(&value.to_string());
        }
    }
    let mut retry = Vec::new();
    for file in files {
        if file.is_empty()
            || file.starts_with('_')
            || file.contains(['*', '?', '"', '\\', '/', '\r', '\n'])
            || templates.contains(&file)
        {
            continue;
        }
        match call(anki, "findNotes", json!({"query":format!("\"{file}\"")})).await {
            Ok(notes) if notes.as_array().is_some_and(Vec::is_empty) => {
                if call(anki, "deleteMediaFile", json!({"filename":file}))
                    .await
                    .is_err()
                {
                    retry.push(file);
                }
            }
            Ok(notes) if notes.is_array() => {}
            _ => retry.push(file),
        }
    }
    retry
}

pub(super) async fn retry_cleanup(app: &AppHandle) -> Result<Value, String> {
    let config = active(app)?;
    let url = url(&config)?;
    let desktop = app.state::<DesktopState>();
    let anki = Collection {
        client: &desktop.http,
        url: &url,
    };
    let profile = pipeline::anki_active_profile(anki.client, anki.url).await?;
    let mut remaining = 0;
    for mut entry in entries(app, &config, "reviewed") {
        if entry.data["anki_profile"] != profile {
            continue;
        }
        let retry = cleanup(&anki, names(&entry.data["cleanup_pending"])).await;
        remaining += retry.len();
        entry.data["cleanup_pending"] = json!(retry);
        entry.finish()?;
    }
    Ok(json!(remaining))
}

pub(super) async fn capture_future(
    app: &AppHandle,
    config: &ProfileConfig,
    scene: &str,
    replay_seconds: Option<f64>,
    attempted: &mut HashMap<String, Instant>,
) {
    let mining = app.state::<Arc<MiningService>>();
    let Ok(_lane) = mining.card_lane.try_lock() else {
        return;
    };
    attempted.retain(|_, when| when.elapsed() < Duration::from_secs(3600));
    let limit = config
        .features
        .review_after_session
        .max_future_context_lines
        .clamp(1, 100) as usize;
    let now = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
    let buffer = replay_seconds.unwrap_or(config.obs.replay_buffer_duration_seconds as f64);
    let intake = app.state::<crate::text_intake::Intake>();
    let mut targets = Vec::new();
    let mut ids = Vec::new();
    for entry in entries(app, config, "pending") {
        if entry.data["scene"] != scene || entry.path.join("future").exists() {
            continue;
        }
        let Some(id) = entry.path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if attempted.contains_key(id) {
            continue;
        }
        let Ok((manifest, _, saved)) = manifest(&entry.path) else {
            continue;
        };
        let selected_ids = names(&entry.data["selected_ids"]);
        let selected = saved
            .iter()
            .filter(|line| selected_ids.contains(&line.id))
            .collect::<Vec<_>>();
        let (Some(first), Some(anchor)) = (selected.first(), selected.last()) else {
            continue;
        };
        if now >= first.time_epoch + buffer - 2.0 {
            continue;
        }
        let (_, lines) = intake.dialogue_context(&anchor.id, (limit + 2) as i32);
        let anchor_time = anchor.first_seen_time_epoch.unwrap_or(anchor.time_epoch);
        let following: Vec<_> = lines
            .iter()
            .filter(|line| {
                line.id != anchor.id
                    && line.scene == scene
                    && (anchor.session_id.is_empty() || line.session_id == anchor.session_id)
                    && line.first_seen_time_epoch.unwrap_or(line.time_epoch) > anchor_time
                    && !line.text.trim().is_empty()
            })
            .take(limit)
            .collect();
        if following.len() < limit
            || following
                .last()
                .is_some_and(|line| now < line.time_epoch + 2.0)
        {
            continue;
        }
        if following
            .iter()
            .all(|line| saved.iter().any(|old| old.id == line.id))
        {
            attempted.insert(id.into(), Instant::now());
            continue;
        }
        let future:Vec<_> = following.iter().map(|line|json!({"id":line.id,"text":line.text,
            "time":crate::mining::session_review::epoch_to_local_iso(line.time_epoch),"scene":line.scene,"source":line.source,
            "session_id":line.session_id,"role":"context"})).collect();
        targets
            .push(json!({"entry_id":id,"original_lines":manifest["lines"],"future_lines":future}));
        ids.push(id.to_owned());
    }
    if targets.is_empty() {
        return;
    }
    match mining
        .handle_request(
            app,
            "mining.sessionReview",
            json!({"action":"captureFutureReplay","targets":targets}),
        )
        .await
    {
        Ok(_) => attempted.extend(ids.into_iter().map(|id| (id, Instant::now()))),
        Err(error) => {
            attempted.extend(ids.into_iter().map(|id| (id, Instant::now())));
            crate::desktop_log::warn(
                app,
                "session review",
                format!("Could not save extra dialogue: {error}"),
            );
        }
    }
}
