//! Compile and cache the same dashboard templates and serve the packaged asset bytes.
use super::*;
use minijinja::{value::Kwargs, Environment};
use std::sync::LazyLock;

pub struct Asset {
    pub bytes: &'static [u8],
    pub gzip: Option<&'static [u8]>,
    pub content_type: &'static str,
    pub etag: &'static str,
    pub gzip_etag: &'static str,
    pub modified: u64,
}

include!(concat!(env!("OUT_DIR"), "/assets.rs"));
include!(concat!(env!("OUT_DIR"), "/templates.rs"));

static TEMPLATES: LazyLock<Environment<'static>> = LazyLock::new(|| {
    let mut env = Environment::new();
    env.set_loader(|name| Ok(template_source(name)));
    env.add_function(
        "url_for",
        |endpoint: String, args: Kwargs| -> std::result::Result<String, minijinja::Error> {
            let filename: String = args.get("filename")?;
            args.assert_all_used()?;
            if endpoint != "static" {
                return Err(minijinja::Error::new(
                    minijinja::ErrorKind::InvalidOperation,
                    "unknown endpoint",
                ));
            }
            Ok(format!("/static/{filename}"))
        },
    );
    env
});

pub enum Page {
    Stats,
    Overview,
    Game(String),
    Static(&'static str),
}

impl Page {
    pub fn parse(path: &str) -> Option<Self> {
        Some(match path {
            "/stats" => Self::Stats,
            "/overview" => Self::Overview,
            "/goals" => Self::Static("goals.html"),
            "/games" => Self::Static("games.html"),
            "/search" => Self::Static("search.html"),
            "/tools" => Self::Static("database.html"),
            "/select_areas" => Self::Static("select_areas.html"),
            "/anki_stats" => Self::Static("anki_stats.html"),
            _ => {
                let id = percent_decode_str(path.strip_prefix("/game/")?)
                    .decode_utf8()
                    .ok()?;
                if id.is_empty() || id.contains('/') {
                    return None;
                }
                Self::Game(id.into_owned())
            }
        })
    }

    pub fn render(&self, reports: &Reports) -> Result<Option<String>> {
        let (name, context) = match self {
            Self::Static(name) => (*name, Value::Null),
            Self::Game(id) => {
                if !reports.history.game_exists(&reports.database, id)? {
                    return Ok(None);
                }
                ("game_stats.html", json!({"game_id":id}))
            }
            Self::Stats | Self::Overview => {
                let prefs = reports.preferences()?;
                let mut context = json!({
                    "master_config":{"experimental":{"enable_tokenization":prefs.tokenization}},
                    "config":{"advanced":{"streak_requirement_hours":prefs.streak_hours}},
                    "stats_config":{"session_gap_seconds":prefs.gap as i64,"reading_hours_target":prefs.hours_target,
                    "character_count_target":prefs.chars_target,"games_target":prefs.games_target}
                });
                if matches!(self, Self::Stats) {
                    context["first_rollup_date"] =
                        json!(reports.history.first_rollup_date(&reports.database)?);
                    ("stats.html", context)
                } else {
                    ("overview.html", context)
                }
            }
        };
        Ok(Some(
            TEMPLATES
                .get_template(name)?
                .render(minijinja::value::Serde(context))?,
        ))
    }
}
