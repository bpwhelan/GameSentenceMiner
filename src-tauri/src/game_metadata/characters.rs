//! Preserve provider order, spoiler metadata and original portrait bytes in the
//! character document consumed by Yomitan and the translation context.
use super::{get_json, Sources};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{stream, StreamExt};
use gsm_history::library::CharacterSource;
use image::ImageFormat;
use regex::Regex;
use serde_json::{json, Value};
use std::{collections::HashSet, io::Cursor, sync::LazyLock, time::Duration};

const VNDB_FIELDS: &str = "id,name,original,aliases,description,blood_type,height,weight,age,birthday,sex,gender,image.url,vns.role,vns.spoiler,vns.id,traits.id,traits.name,traits.group_name,traits.spoiler";
const ANILIST_CHARACTERS: &str = "query ($id: Int!, $type: MediaType, $page: Int, $perPage: Int) {
    Media(id:$id,type:$type) { characters(page:$page,perPage:$perPage,sort:[ROLE,RELEVANCE,ID]) {
        pageInfo { hasNextPage } edges { role node {
            id name { full native alternative } image { large medium } description gender age
        } }
    } }
}";

pub(super) fn from_jiten(data: &Value) -> Option<CharacterSource> {
    let kind = data["media_type_string"].as_str()?;
    let links = data["links"]
        .as_array()?
        .iter()
        .filter_map(|item| item.as_str().or_else(|| item["url"].as_str()));
    for url in links {
        if kind == "Visual Novel" {
            if let Some(id) = number_after(url, "vndb.org/v") {
                return Some(CharacterSource::Vndb(format!("v{id}")));
            }
        } else if matches!(kind, "Anime" | "Manga") {
            for (prefix, manga) in [("anilist.co/anime/", false), ("anilist.co/manga/", true)] {
                if let Some(id) = number_after(url, prefix).and_then(|s| s.parse().ok()) {
                    return Some(CharacterSource::Anilist { id, manga });
                }
            }
        }
    }
    None
}

fn number_after<'a>(url: &'a str, prefix: &str) -> Option<&'a str> {
    let suffix = url.split_once(prefix)?.1;
    let len = suffix.bytes().take_while(u8::is_ascii_digit).count();
    (len > 0).then(|| &suffix[..len])
}

impl Sources {
    pub(super) async fn characters(&self, source: &CharacterSource) -> Option<Value> {
        let mut result = match source {
            CharacterSource::Vndb(id) => json!({"vn_id":id}),
            CharacterSource::Anilist { id, manga } => {
                json!({"media_id":id,"media_type":if *manga {"MANGA"} else {"ANIME"}})
            }
        };
        let mut groups = serde_json::Map::new();
        let mut page = 1;
        let mut count = 0;
        loop {
            let (items, more) = match source {
                CharacterSource::Vndb(id) => {
                    let req=self.http.post(format!("{}/character",self.vndb)).json(&json!({
                        "filters":["vn","=",["id","=",id]],"fields":VNDB_FIELDS,"results":100,"page":page
                    }));
                    let mut data = get_json(req, 10).await?;
                    (
                        super::take_rows(&mut data, "/results"),
                        data["more"].as_bool().unwrap_or(false),
                    )
                }
                CharacterSource::Anilist { id, .. } => {
                    let req=self.http.post(&self.anilist).json(&json!({"query":ANILIST_CHARACTERS,
                        "variables":{"id":id,"type":result["media_type"],"page":page,"perPage":25}}));
                    let mut data = get_json(req, 15).await?;
                    if data.get("errors").is_some() {
                        return None;
                    }
                    let media = data.pointer_mut("/data/Media")?;
                    if !media.is_object() {
                        return None;
                    }
                    (
                        super::take_rows(media, "/characters/edges"),
                        media
                            .pointer("/characters/pageInfo/hasNextPage")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    )
                }
            };
            // A provider promising another page without returning any rows
            // cannot advance the cursor.
            if items.is_empty() && more {
                return None;
            }
            let normalized = items.into_iter().filter_map(|item| match source {
                CharacterSource::Vndb(id) => vndb(&item, id),
                CharacterSource::Anilist { .. } => anilist(&item),
            });
            let mut rows = stream::iter(normalized.map(|mut row| async move {
                if let Some(url) = row["image_url"].as_str() {
                    if let Some(image) = self.portrait(url).await {
                        row["image_base64"] = image.into();
                    }
                }
                row
            }))
            .buffered(4);
            while let Some(row) = rows.next().await {
                let key = match row["role"].as_str() {
                    Some("main") => "main",
                    Some("primary") => "primary",
                    _ => "side",
                };
                groups
                    .entry(key)
                    .or_insert_with(|| Value::Array(vec![]))
                    .as_array_mut()?
                    .push(row);
                count += 1;
            }
            if !more {
                break;
            }
            page += 1;
        }
        result["characters"] = Value::Object(groups);
        result["character_count"] = count.into();
        Some(result)
    }

    async fn portrait(&self, url: &str) -> Option<String> {
        let response = self
            .http
            .get(url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .ok()?;
        if response.status() != reqwest::StatusCode::OK {
            return None;
        }
        let bytes = response.bytes().await.ok()?;
        tokio::task::spawn_blocking(move || {
            let format = image::guess_format(&bytes).ok()?;
            let decoded = image::load_from_memory_with_format(&bytes, format).ok()?;
            let mime = match format {
                ImageFormat::Jpeg => "image/jpeg",
                ImageFormat::Png => "image/png",
                ImageFormat::Gif => "image/gif",
                ImageFormat::WebP => "image/webp",
                _ => {
                    let mut buf = Cursor::new(Vec::new());
                    decoded
                        .to_rgba8()
                        .write_to(&mut buf, ImageFormat::Png)
                        .ok()?;
                    return Some(format!(
                        "data:image/png;base64,{}",
                        STANDARD.encode(buf.into_inner())
                    ));
                }
            };
            Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
        })
        .await
        .ok()?
    }

    pub(super) async fn jiten_cover(&self, url: &str) -> Option<String> {
        let response = self
            .http
            .get(url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .ok()?;
        if response.status() != reqwest::StatusCode::OK {
            return None;
        }
        Some(format!(
            "data:image/jpeg;base64,{}",
            STANDARD.encode(response.bytes().await.ok()?)
        ))
    }
}

fn vndb(row: &Value, id: &str) -> Option<Value> {
    let entries = row["vns"].as_array().map(Vec::as_slice).unwrap_or_default();
    let vn = entries.iter().find(|v| v["id"] == id).or(entries.first());
    let role = vn.and_then(|v| v["role"].as_str()).unwrap_or("unknown");
    if role == "appears" || vn.and_then(|v| v["spoiler"].as_i64()).unwrap_or(0) > 2 {
        return None;
    }
    let mut out = json!({"id":row["id"],"name":row["name"],"name_original":row["original"],
        "aliases":row.get("aliases").cloned().unwrap_or_else(|| json!([])),"role":role});
    for key in [
        "description",
        "age",
        "blood_type",
        "height",
        "weight",
        "birthday",
    ] {
        if present(&row[key]) {
            out[key] = row[key].clone()
        }
    }
    for key in ["sex", "gender"] {
        if let Some(value) = row[key]
            .get(0)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            out[key] = match (key, value) {
                (_, "m") => "male",
                (_, "f") => "female",
                ("sex", "b") => "both",
                ("sex", "n") => "sexless",
                ("gender", "o") => "non-binary",
                ("gender", "a") => "ambiguous",
                _ => value,
            }
            .into();
        }
    }
    if let Some(url) = row
        .pointer("/image/url")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    {
        out["image_url"] = url.into()
    }
    let mut seen = HashSet::new();
    for item in row["traits"].as_array().into_iter().flatten() {
        let key = match item["group_name"].as_str() {
            Some("Personality") => "personality",
            Some("Role") => "roles",
            Some("Engages in") => "engages_in",
            Some("Subject of") => "subject_of",
            _ => continue,
        };
        let group = out
            .as_object_mut()?
            .entry(key)
            .or_insert_with(|| json!([]))
            .as_array_mut()?;
        if let Some(name) = item["name"].as_str().filter(|s| !s.is_empty()) {
            if seen.insert((key, name)) {
                group.push(
                    json!({"name":name,"spoiler":item.get("spoiler").cloned().unwrap_or(0.into())}),
                );
            }
        }
    }
    Some(out)
}

fn present(value: &Value) -> bool {
    match value {
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::Null => false,
    }
}

fn anilist(edge: &Value) -> Option<Value> {
    static SPOILER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)~!.+?!~").unwrap());
    let row = edge.get("node")?;
    if row.as_object()?.is_empty() {
        return None;
    }
    let role = match edge["role"].as_str() {
        Some("MAIN") => "main",
        Some("SUPPORTING") => "primary",
        _ => "side",
    };
    let name = &row["name"];
    let mut out = json!({"id":row["id"],"name":name.get("full").cloned().unwrap_or_else(||"".into()),
        "name_original":name.get("native").cloned().unwrap_or_else(||"".into()),"role":role,
        "aliases":name["alternative"].as_array().cloned().unwrap_or_default()});
    if let Some(desc) = row["description"].as_str().filter(|s| !s.is_empty()) {
        out["description"] = desc.into();
        out["description_has_spoilers"] = SPOILER.is_match(desc).into();
    }
    if let Some(gender) = row["gender"].as_str().filter(|s| !s.is_empty()) {
        out["sex"] = gender.to_lowercase().into()
    }
    if present(&row["age"]) {
        out["age"] = super::search_results::id(&row["age"]).into()
    }
    if let Some(url) = ["large", "medium"]
        .into_iter()
        .find_map(|k| row["image"][k].as_str().filter(|s| !s.is_empty()))
    {
        out["image_url"] = url.into();
    }
    Some(out)
}
