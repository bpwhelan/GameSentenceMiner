use gsm_history::reports::JITEN_DIFFICULTY_LABELS;
use serde_json::{json, Value};

const MEDIA: &[&str] = &[
    "",
    "Anime",
    "Drama",
    "Movie",
    "Novel",
    "NonFiction",
    "VideoGame",
    "Visual Novel",
    "WebNovel",
    "Manga",
];
const GENRES: &[&str] = &[
    "",
    "Action",
    "Adventure",
    "Comedy",
    "Drama",
    "Ecchi",
    "Fantasy",
    "Horror",
    "Mecha",
    "Music",
    "Mystery",
    "Psychological",
    "Romance",
    "SciFi",
    "Slice of Life",
    "Sports",
    "Supernatural",
    "Thriller",
    "NSFW",
];

fn label<'a>(table: &'a [&str], value: &Value) -> Option<&'a str> {
    table
        .get(usize::try_from(value.as_u64()?).ok()?)
        .copied()
        .filter(|v| !v.is_empty())
}

pub(super) fn normalize(mut row: Value) -> Value {
    let media = &row["mediaType"];
    let media_name = label(MEDIA, media).map(str::to_owned).unwrap_or_else(|| {
        if media.is_null() || media == 0 || media == "" {
            String::new()
        } else {
            format!("Type {}", super::search_results::id(media))
        }
    });
    let genres: Vec<_> = row["genres"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|g| {
            label(GENRES, g)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Unknown-{}", super::search_results::id(g)))
        })
        .collect();
    let tags: Vec<_> = row["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tag| tag.get("name"))
        .collect();
    let raw = row
        .get("difficultyRaw")
        .filter(|v| !v.is_null())
        .unwrap_or(&row["difficulty"]);
    let bucket = raw
        .as_f64()
        .or_else(|| raw.as_str()?.trim().parse().ok())
        .filter(|v| v.is_finite())
        .map(|d| JITEN_DIFFICULTY_LABELS[(d.floor() as i64).clamp(0, 5) as usize]);
    let mut out = json!({"media_type_string":media_name,"genres":genres,"tags":tags,"difficulty_label":bucket});
    let fields = [
        ("deck_id", "deckId", Value::Null),
        ("title_original", "originalTitle", "".into()),
        ("title_romaji", "romajiTitle", "".into()),
        ("title_english", "englishTitle", "".into()),
        ("description", "description", "".into()),
        ("cover_name", "coverName", "".into()),
        ("media_type", "mediaType", Value::Null),
        ("character_count", "characterCount", 0.into()),
        ("difficulty", "difficulty", Value::Null),
        ("difficulty_raw", "difficultyRaw", Value::Null),
        ("links", "links", Value::Array(Vec::new())),
        ("aliases", "aliases", Value::Array(Vec::new())),
        ("release_date", "releaseDate", "".into()),
    ];
    for (key, remote, default) in fields {
        out[key] = row.get_mut(remote).map(Value::take).unwrap_or(default);
    }
    out
}

pub(super) fn search_result(row: Value) -> Value {
    let deck = normalize(row);
    let id = super::search_results::id(&deck["deck_id"]);
    let mut result = json!({"id":id,"title":deck["title_original"],"title_en":deck["title_english"],"title_jp":deck["title_original"],
        "cover_url":deck["cover_name"].as_str().filter(|s| !s.is_empty()),"source":"jiten",
        "source_url":format!("https://jiten.moe/decks/media/{id}/detail"),
        "description":deck["description"].as_str().unwrap_or("").chars().take(200).collect::<String>(),
        "media_type":deck["media_type_string"],"character_count":deck["character_count"],"difficulty":deck["difficulty"],
        "difficulty_label":deck["difficulty_label"]});
    result["_raw"] = deck;
    result
}
