use gsm_text_preview::correlation::{classify, Incoming, Line, Windows};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Request<'a> {
    #[serde(borrow)]
    incoming: Incoming<'a>,
    #[serde(borrow)]
    newest: Option<Line<'a>>,
    #[serde(borrow)]
    open: Option<Line<'a>>,
    previous: Option<(&'a str, bool)>,
    deadline_ns: Option<i64>,
    windows: Windows,
}

pub fn request(data: &Value) -> Result<Value, String> {
    let req = Request::deserialize(data).map_err(|e| e.to_string())?;
    Ok(json!(classify(
        &req.incoming,
        req.newest.as_ref(),
        req.open.as_ref(),
        req.previous,
        req.deadline_ns,
        &req.windows
    )
    .wire()))
}
