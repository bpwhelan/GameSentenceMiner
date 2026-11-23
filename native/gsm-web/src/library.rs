use super::{Reply, Reports};
use base64::{
    alphabet,
    engine::{general_purpose::GeneralPurpose, GeneralPurposeConfig},
    Engine,
};
pub use gsm_history::library::Edit as GameEdit;
use gsm_history::library::Outcome;
pub use gsm_history::library::Removal as GameRemoval;
use percent_encoding::percent_decode_str;
use serde_json::Value;
use std::borrow::Cow;

pub struct Cover {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy)]
pub enum SceneOperation {
    Migrate,
    Delete,
    Merge,
}

impl SceneOperation {
    pub fn route(path: &str) -> Option<Self> {
        match path {
            "/api/migrate-lines" => Some(Self::Migrate),
            "/api/delete-games" => Some(Self::Delete),
            "/api/merge_games" => Some(Self::Merge),
            _ => None,
        }
    }
    fn parse(self, body: &Value) -> Result<gsm_history::library::SceneEdit, Reply> {
        use gsm_history::library::SceneEdit;
        if matches!(self, Self::Merge)
            && !body["target_game"].as_str().is_some_and(|s| !s.is_empty())
        {
            return Err(Reply::error(400, "No target game specified for merging"));
        }
        let (key, missing) = match self {
            Self::Migrate => ("line_ids", "No line IDs provided"),
            Self::Delete => ("game_names", "No games specified for deletion"),
            Self::Merge => ("games_to_merge", "No games specified for merging"),
        };
        let value = &body[key];
        if value.is_null() || value == "" || value.as_array().is_some_and(Vec::is_empty) {
            return Err(Reply::error(400, missing));
        }
        let items = value.as_array().ok_or_else(|| {
            Reply::error(
                400,
                if matches!(self, Self::Migrate) {
                    "line_ids must be a list"
                } else {
                    "game_names must be a list"
                },
            )
        })?;
        match self {
            Self::Migrate => {
                let target = body["target_game"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| Reply::error(400, "No target game specified"))?;
                Ok(SceneEdit::Migrate {
                    ids: items.clone(),
                    target: target.into(),
                })
            }
            Self::Delete | Self::Merge => {
                let names = items
                    .iter()
                    .map(|v| v.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
                    .ok_or_else(|| Reply::error(400, "Game names must be strings"))?;
                Ok(if matches!(self, Self::Merge) {
                    SceneEdit::Merge {
                        names,
                        target: body["target_game"].as_str().unwrap().into(),
                    }
                } else {
                    SceneEdit::Delete(names)
                })
            }
        }
    }
}

pub fn game_cover_route(path: &str) -> Option<String> {
    game_action_id(path,"/image")
}

pub fn game_action_id(path:&str, suffix:&str) -> Option<String> {
    let raw = path.strip_prefix("/api/games/")?.strip_suffix(suffix)?;
    let id = percent_decode_str(raw).decode_utf8().ok()?;
    (!id.is_empty() && !id.contains('/')).then(|| id.into_owned())
}

fn image_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(&b"WEBP"[..]) {
        "image/webp"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else {
        "image/png"
    }
}

fn decode_cover(encoded: &str) -> gsm_history::Result<Cover> {
    let (declared, payload) = if let Some(uri) = encoded.strip_prefix("data:") {
        let (header, payload) = uri.split_once(',').unwrap_or((uri, ""));
        (
            header.split(';').next().filter(|s| s.contains('/')),
            payload,
        )
    } else {
        (None, encoded)
    };
    let allowed = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=');
    let payload = if payload.bytes().all(allowed) {
        Cow::Borrowed(payload.as_bytes())
    } else {
        Cow::Owned(payload.bytes().filter(|&b| allowed(b)).collect::<Vec<_>>())
    };
    let decoder = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
    );
    let bytes = decoder.decode(payload)?;
    let content_type = declared
        .filter(|s| s.bytes().all(|b| b.is_ascii_graphic()))
        .unwrap_or_else(|| image_type(&bytes))
        .to_owned();
    Ok(Cover {
        content_type,
        bytes,
    })
}

pub fn game_edit_route(path: &str, method: &str) -> Option<GameEdit> {
    if path == "/api/games" {
        return Some(GameEdit::Create);
    }
    let tail = path.strip_prefix("/api/games/")?;
    let (id, complete) = match tail.strip_suffix("/mark-complete") {
        Some(id) => (id, true),
        None if method == "PUT" => (tail, false),
        _ => return None,
    };
    let id = percent_decode_str(id).decode_utf8().ok()?;
    if id.is_empty() || id.contains('/') {
        return None;
    }
    Some(if complete {
        GameEdit::Complete(id.into_owned())
    } else {
        GameEdit::Update(id.into_owned())
    })
}

pub fn game_removal_route(path: &str, method: &str) -> Option<(String, GameRemoval)> {
    let tail = path.strip_prefix("/api/games/")?;
    let (id, removal) = match tail.strip_suffix("/delete-lines") {
        Some(id) => (id, GameRemoval::DeleteLines),
        None if matches!(method, "DELETE" | "OPTIONS") => (tail, GameRemoval::Unlink),
        _ => return None,
    };
    let id = percent_decode_str(id).decode_utf8().ok()?;
    (!id.is_empty() && !id.contains('/')).then(|| (id.into_owned(), removal))
}

fn reply(outcome: Outcome, status: u16) -> Reply {
    match outcome {
        Outcome::Saved(body) => Reply { status, body },
        Outcome::Missing => Reply::error(404, "Game not found"),
        Outcome::Invalid(error) => Reply::error(400, &error),
    }
}

impl Reports {
    pub fn edit_scenes(&self, operation: SceneOperation, body: &Value) -> Option<Reply> {
        let edit = match operation.parse(body) {
            Ok(edit) => edit,
            Err(r) => return Some(r),
        };
        if std::env::var("GSM_DB_READ_ONLY").as_deref() == Ok("1") {
            return Some(Reply::error(500, "Database is read-only"));
        }
        let result = self.preferences().and_then(|p| {
            let Some(cleaner) = &p.cleaner else {
                return Ok(None);
            };
            self.history
                .edit_scenes(&self.database, edit, cleaner, p.gap, p.tokenization)
                .map(Some)
        });
        match result {
            Ok(value) => value.map(|o| {
                let mut r = reply(o, 200);
                if r.body["failed_games"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty())
                {
                    r.status = 207;
                }
                r
            }),
            Err(e) => Some(Reply::error(500, &e.to_string())),
        }
    }
    pub fn game_cover(&self, id: &str) -> gsm_history::Result<Option<Cover>> {
        self.history
            .game_cover(&self.database, id)?
            .map(|s| decode_cover(&s))
            .transpose()
    }
    pub fn edit_game(&self, edit: GameEdit, body: Value) -> Reply {
        if std::env::var("GSM_DB_READ_ONLY").as_deref() == Ok("1") {
            return Reply::error(500, "Database is read-only");
        }
        let status = if matches!(edit, GameEdit::Create) {
            201
        } else {
            200
        };
        match self.history.edit_game(&self.database, edit, &body) {
            Ok(outcome) => reply(outcome, status),
            Err(error) => Reply::error(500, &format!("Failed to edit game: {error}")),
        }
    }

    pub fn remove_game(&self, id: &str, removal: GameRemoval) -> Option<Reply> {
        if std::env::var("GSM_DB_READ_ONLY").as_deref() == Ok("1") {
            return Some(Reply::error(500, "Database is read-only"));
        }
        let result = self.preferences().and_then(|p| {
            self.history.remove_game(
                &self.database,
                id,
                removal,
                p.cleaner.as_ref(),
                p.gap,
                p.tokenization,
            )
        });
        match result {
            Ok(outcome) => outcome.map(|o| reply(o, 200)),
            Err(error) => Some(Reply::error(
                500,
                &format!("Failed to remove game: {error}"),
            )),
        }
    }
}
