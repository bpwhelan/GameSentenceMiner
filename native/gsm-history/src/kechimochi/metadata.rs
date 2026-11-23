use indexmap::IndexMap;
use serde_json::{Map, Value};
use url::Url;

const LEGACY: &[(&str, &str)] = &[
    ("vNDB_ID", "VNDB ID"),
    ("aniList_ID", "AniList ID"),
    ("deck_id", "Jiten deck ID"),
    ("obs_scene_name", "OBS scene"),
    ("release_date", "Release Date"),
    ("title_romaji", "Romaji title"),
    ("title_english", "English title"),
    ("genres", "Genres"),
    ("tags", "Tags"),
];

fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Array(a) => a.iter().map(text).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    }
}

fn add_source(fields: &mut Map<String, Value>, raw: &str) {
    let raw = raw.trim();
    let Ok(url) = Url::parse(raw) else { return };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return;
    }
    let Some(host) = url.host_str() else {
        return;
    };
    let label = match host.strip_prefix("www.").unwrap_or(host) {
        "vndb.org" => "VNDB",
        "jiten.moe" => "Jiten.moe",
        "anilist.co" => "Anilist",
        "backloggd.com" => "Backloggd",
        "imdb.com" => "IMDb",
        "cmoa.jp" => "Cmoa",
        "bookwalker.jp" => "Bookwalker",
        "bookmeter.com" => "Bookmeter",
        "shonenjumpplus.com" => "Shonen Jump+",
        "dmm.co.jp" => "DMM",
        name => name,
    };
    let label = format!("Source ({label})");
    let mut key = label.clone();
    for number in 2.. {
        match fields.get(&key) {
            Some(existing)
                if existing
                    .as_str()
                    .is_some_and(|s| s.trim_end_matches('/') == raw.trim_end_matches('/')) =>
            {
                return
            }
            Some(_) => key = format!("{label} {number}"),
            None => {
                fields.insert(key, Value::from(raw));
                return;
            }
        }
    }
}

pub fn migrate(fields: &mut Map<String, Value>) {
    for &(old, new) in LEGACY {
        if let Some(mut value) = fields.remove(old) {
            if matches!(old, "genres" | "tags") {
                if let Some(array) = value
                    .as_str()
                    .and_then(|s| serde_json::from_str::<Vec<Value>>(s).ok())
                {
                    value = array.into();
                }
            }
            fields.entry(new).or_insert_with(|| text(&value).into());
        }
    }
    let links = fields.get("links").and_then(|v| match v {
        Value::String(raw) => serde_json::from_str::<Vec<String>>(raw).ok(),
        Value::Array(a) => a.iter().map(|v| v.as_str().map(str::to_owned)).collect(),
        _ => None,
    });
    if let Some(links) = links {
        fields.remove("links");
        for link in links {
            add_source(fields, &link);
        }
    }
}

fn positive_id(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('0') && s.bytes().all(|v| v.is_ascii_digit())
}
pub(super) fn for_game(
    raw: IndexMap<&str, Value>,
    kind: &str,
    characters: Option<i64>,
    difficulty: Option<String>,
) -> Map<String, Value> {
    let mut fields = raw.into_iter().map(|(k, v)| (k.into(), v)).collect();
    migrate(&mut fields);
    let vndb = fields
        .get("VNDB ID")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let vndb = vndb.strip_prefix('v').unwrap_or(&vndb);
    if positive_id(vndb) {
        add_source(&mut fields, &format!("https://vndb.org/v{vndb}"));
    }
    if let Some(id) = fields
        .get("Jiten deck ID")
        .and_then(Value::as_str)
        .filter(|s| positive_id(s))
    {
        let url = format!("https://jiten.moe/decks/{id}");
        add_source(&mut fields, &url);
    }
    if !fields.contains_key("Source (Anilist)") {
        let kind: String = kind
            .chars()
            .filter(|c| !c.is_whitespace() && !matches!(c, '_' | '-'))
            .flat_map(char::to_lowercase)
            .collect();
        let source = match kind.as_str() {
            "anime" | "movie" => Some("anime"),
            "manga" | "novel" | "webnovel" | "lightnovel" => Some("manga"),
            _ => None,
        };
        if let (Some(source), Some(id)) = (
            source,
            fields
                .get("AniList ID")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| positive_id(s)),
        ) {
            let url = format!("https://anilist.co/{source}/{id}");
            add_source(&mut fields, &url);
        }
    }
    if let Some(count) = characters.filter(|v| *v > 0) {
        let digits = count.to_string();
        let mut formatted = String::new();
        for (i, c) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i) % 3 == 0 {
                formatted.push(',');
            }
            formatted.push(c);
        }
        fields.insert("Character count".into(), formatted.into());
    }
    if let Some(value) = difficulty.and_then(|s| s.parse::<i64>().ok()) {
        fields.insert("GSM difficulty".into(), value.to_string().into());
    }
    fields
}
