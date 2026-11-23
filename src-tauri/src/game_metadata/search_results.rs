use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

pub(super) const ANILIST_QUERY: &str = "query ($search: String!, $type: MediaType) {
    Page(page: 1, perPage: 10) { media(search: $search, type: $type) {
        id idMal title { romaji english native } description(asHtml: false)
        coverImage { large medium } format status averageScore siteUrl
    } }
}";

pub(super) fn id(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        other => other.to_string(),
    }
}
fn field<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or("")
}
fn string_or_empty(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or_else(|| "".into())
}

pub(super) fn vndb(row: Value) -> Value {
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[/?[^\]]+\]").unwrap());
    let desc = TAG
        .replace_all(field(&row, "description"), "")
        .chars()
        .take(200)
        .collect::<String>();
    let developers: Vec<_> = row["developers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v["name"].as_str().filter(|s| !s.is_empty()))
        .collect();
    let mut result = json!({"id":string_or_empty(&row,"id"),"title":string_or_empty(&row,"title"),"title_en":string_or_empty(&row,"title"),
        "title_jp":string_or_empty(&row,"alttitle"),"cover_url":row["image"]["url"],"source":"vndb",
        "source_url":format!("https://vndb.org/{}",field(&row,"id")),"description":desc,"media_type":"Visual Novel","rating":row["rating"],
        "released":row["released"],"developers":developers});
    result["_raw"] = row;
    result
}

pub(super) fn anilist_description(description: &str) -> String {
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    static SPOILER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)~!.+?!~").unwrap());
    let plain = TAG.replace_all(description, "");
    SPOILER.replace_all(&plain, "").into_owned()
}

pub(super) fn anilist(row: Value, kind: &str) -> Value {
    let desc: String = anilist_description(field(&row, "description"))
        .chars()
        .take(200)
        .collect();
    let titles = &row["title"];
    let media = if kind == "ANIME" { "Anime" } else { "Manga" };
    let id = row.get("id").map(id).unwrap_or_default();
    let mut result = json!({"id":id,"title":titles["romaji"].as_str().filter(|s|!s.is_empty()).map(Value::from)
        .unwrap_or_else(||string_or_empty(titles,"english")),"title_en":string_or_empty(titles,"english"),"title_jp":string_or_empty(titles,"native"),
        "cover_url":row["coverImage"]["large"].as_str().filter(|s|!s.is_empty()).map(Value::from).unwrap_or_else(||row["coverImage"]["medium"].clone()),
        "source":"anilist","source_url":row.get("siteUrl").cloned().unwrap_or_else(||format!("https://anilist.co/{}/{id}",kind.to_ascii_lowercase()).into()),
        "description":desc,"media_type":media,"format":row["format"],"status":row["status"],"score":row["averageScore"],"mal_id":row["idMal"]});
    result["_raw"] = row;
    result
}

pub(super) fn igdb_url(value: &str) -> String {
    gsm_history::library::igdb_slug(value)
        .map(|s| format!("https://www.igdb.com/games/{s}"))
        .unwrap_or_default()
}
pub(super) fn cover(s: &str) -> Option<String> {
    if s.is_empty() {
        return None;
    }
    let url = if s.starts_with("//") {
        format!("https:{s}")
    } else if s.starts_with('/') {
        format!("https://images.igdb.com{s}")
    } else {
        s.to_owned()
    };
    Some(url.replace("t_cover_big/", "t_cover_big_2x/"))
}
pub(super) fn igdb(row: Value) -> Value {
    let string = |key: &str| row.get(key).map(id).unwrap_or_default().trim().to_owned();
    let title = string("title");
    let title_for = |key: &str| {
        let v = string(key);
        if v.is_empty() {
            title.clone()
        } else {
            v
        }
    };
    let slug = string("igdb_slug");
    let url = igdb_url(
        row["igdb_url"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(&slug),
    );
    let id = string("igdb_id");
    let kind = field(&row, "result_type").trim();
    let kind = if kind.is_empty() { "Game" } else { kind };
    let image = cover(field(&row, "cover_url"));
    let platforms = row["platforms"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let normalized = json!({"id":id,"igdb_id":id,"igdb_slug":slug,"slug":slug,"source_url":url,"igdb_url":url,"title":title,
        "title_original":title_for("title_original"),"title_romaji":title_for("title_romaji"),"title_english":title_for("title_english"),
        "year":string("year"),"result_type":kind,"platforms":platforms,"cover_url":image});
    let mut result = json!({"id":id,"title":title,"title_en":normalized["title_english"],"title_jp":normalized["title_original"],
        "cover_url":image,"source":"igdb","source_url":url,"description":"","media_type":kind,"result_type":kind,"platforms":platforms,"year":normalized["year"]});
    result["_raw"] = normalized;
    result
}
