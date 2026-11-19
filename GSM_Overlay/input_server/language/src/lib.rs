//! Shared Sudachi engine and local vocabulary database, owned by the desktop
//! in managed runs and by the input server in standalone runs.

mod jiten_rules;
pub mod mining;
mod sudachi;
mod vocabulary;

pub use sudachi::LanguageService;
pub use vocabulary::Request as VocabularyRequest;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// The desktop-managed input server relays these messages over inherited pipes.
pub const PIPE_ENV: &str = "GSM_DESKTOP_SUDACHI_PIPE";
pub const REQUEST_PREFIX: &str = "GSM_LANGUAGE_REQUEST:";
pub const REPLY_PREFIX: &str = "GSM_LANGUAGE_REPLY:";

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Status,
    Prepare { dictionary: Option<String> },
    Configure { dictionary: String },
    Analyze { text: String, furigana: bool },
    Vocabulary { request: VocabularyRequest },
}

#[derive(Deserialize, Serialize)]
pub struct PipeRequest {
    pub id: u64,
    pub request: Request,
}

#[derive(Deserialize, Serialize)]
pub struct PipeReply {
    pub id: u64,
    pub result: Result<Value, String>,
}
