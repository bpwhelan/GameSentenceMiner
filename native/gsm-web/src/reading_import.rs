use super::{Reply, Reports};
use chrono::NaiveDate;
use gsm_history::{ReadingEntry, Request};
use serde_json::{json, Value};
use std::borrow::Cow;

pub enum ReadingEdit {
    Add,
    Import,
    Delete(i64),
    DeleteSource(String),
}

impl ReadingEdit {
    pub fn route(path: &str, method: &str) -> Option<Self> {
        match (path, method) {
            ("/api/third-party-stats", method) if !matches!(method, "GET" | "HEAD") => {
                Some(Self::Add)
            }
            ("/api/import-stats", _) => Some(Self::Import),
            _ => {
                let tail = path.strip_prefix("/api/third-party-stats/")?;
                if let Some(source) = tail.strip_prefix("source/") {
                    let decoded = percent_encoding::percent_decode_str(source)
                        .decode_utf8()
                        .ok()?;
                    return (!decoded.is_empty() && !decoded.contains('/'))
                        .then(|| Self::DeleteSource(decoded.into_owned()));
                }
                if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                tail.parse().ok().map(Self::Delete)
            }
        }
    }

    pub fn deletes(&self) -> bool {
        matches!(self, Self::Delete(_) | Self::DeleteSource(_))
    }
}

fn date(s: &str) -> bool {
    s.as_bytes().get(4) == Some(&b'-')
        && !s.starts_with("0000")
        && NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

fn characters(value: Option<&Value>) -> Option<i64> {
    match value {
        None => Some(0),
        Some(Value::Bool(b)) => Some(i64::from(*b)),
        Some(Value::String(s)) => s.trim().parse().ok(),
        Some(n) => n.as_i64().or_else(|| {
            let v = n.as_f64()?;
            (v >= i64::MIN as f64 && v < -(i64::MIN as f64)).then_some(v as i64)
        }),
    }
}

fn seconds(value: Option<&Value>) -> Option<f64> {
    match value {
        None => Some(0.0),
        Some(Value::Bool(b)) => Some(f64::from(*b)),
        Some(Value::String(s)) => s.trim().parse().ok(),
        Some(n) => n.as_f64(),
    }
    .filter(|v| v.is_finite())
}

// Third-party importers may send numeric source IDs and display labels.
fn import_text(value: Option<&Value>) -> Cow<'_, str> {
    match value {
        None => "".into(),
        Some(Value::String(s)) => s.trim().into(),
        Some(Value::Bool(true)) => "True".into(),
        Some(Value::Bool(false)) => "False".into(),
        Some(Value::Null) => "None".into(),
        Some(other) => other.to_string().into(),
    }
}

fn entry(
    input: &Value,
    manual: bool,
    validated_day: Option<&str>,
) -> Result<Option<ReadingEntry>, String> {
    if !input.is_object() {
        return Err("must be an object".into());
    }
    let field = |k: &str| {
        if manual {
            Cow::Borrowed(input[k].as_str().unwrap_or("").trim())
        } else {
            import_text(input.get(k))
        }
    };
    let day = field("date");
    if day.is_empty() {
        return Err(if manual {
            "Date is required"
        } else {
            "'date' is required"
        }
        .into());
    }
    if Some(day.as_ref()) != validated_day && !date(&day) {
        return Err(if manual {
            "Date must be in YYYY-MM-DD format".into()
        } else {
            format!("'date' must be YYYY-MM-DD (got '{day}')")
        });
    }
    let (Some(chars), Some(time)) = (
        characters(input.get("characters_read")),
        seconds(input.get("time_read_seconds")),
    ) else {
        return Err(if manual {
            "characters_read must be int, time_read_seconds must be number"
        } else {
            "invalid number for characters_read or time_read_seconds"
        }
        .into());
    };
    if chars < 0 || time < 0.0 {
        return Err(if manual {
            "Values cannot be negative"
        } else {
            "values cannot be negative"
        }
        .into());
    }
    if chars == 0 && time == 0.0 {
        return if manual {
            Err("At least one of characters_read or time_read_seconds must be > 0".into())
        } else {
            Ok(None)
        };
    }
    let mut source = field("source");
    if source.is_empty() {
        if !manual {
            return Err("'source' is required".into());
        }
        source = "manual".into();
    }
    let label = field("label");
    let label = if label.is_empty() {
        if manual {
            "Manual entry".to_owned()
        } else {
            source.to_string()
        }
    } else {
        label.into_owned()
    };
    Ok(Some(ReadingEntry {
        date: day.into(),
        characters: chars,
        seconds: time,
        source: source.into(),
        label,
    }))
}

impl Reports {
    pub fn edit_reading_stats(&self, edit: ReadingEdit, body: Value) -> Reply {
        if std::env::var_os("GSM_DB_READ_ONLY").is_some_and(|v| v == "1") {
            return Reply::error(500, "Database is read-only");
        }
        match edit {
            ReadingEdit::Add => {
                if body.as_object().is_none_or(|m| m.is_empty()) {
                    return Reply::error(400, "No data provided");
                }
                let row = match entry(&body, true, None) {
                    Ok(Some(row)) => row,
                    Ok(None) => unreachable!("manual zero entries are validation errors"),
                    Err(error) => return Reply::error(400, &error),
                };
                match self.history.add_reading_entry(&self.database, &row) {
                    Ok(id) => Reply {
                        status: 201,
                        body: json!({"message":"Entry added successfully","id":id,"entry":{
                        "id":id,"date":row.date,"characters_read":row.characters,"time_read_seconds":row.seconds,"source":row.source,"label":row.label}}),
                    },
                    Err(e) => Reply::error(500, &format!("Failed to add entry: {e}")),
                }
            }
            ReadingEdit::Delete(id) => {
                match self.history.delete_reading_entry(&self.database, id) {
                    Ok(true) => Reply {
                        status: 200,
                        body: json!({"message":"Entry deleted successfully"}),
                    },
                    Ok(false) => Reply::error(404, "Entry not found"),
                    Err(_) => Reply::error(500, "Failed to delete entry"),
                }
            }
            ReadingEdit::DeleteSource(source) => {
                match self.history.delete_reading_source(&self.database, &source) {
                    Ok(n) => Reply {
                        status: 200,
                        body: json!({"message":format!("Deleted {n} entries from source '{source}'"),"deleted_count":n}),
                    },
                    Err(_) => Reply::error(500, "Failed to delete entries"),
                }
            }
            ReadingEdit::Import => self.import_reading_stats(body),
        }
    }

    fn import_reading_stats(&self, mut body: Value) -> Reply {
        if body.as_object().is_none_or(|m| m.is_empty()) {
            return Reply::error(400, "No JSON data provided");
        }
        let Value::Array(entries) = body["entries"].take() else {
            return Reply::error(400, "'entries' must be a non-empty array");
        };
        if entries.is_empty() {
            return Reply::error(400, "'entries' must be a non-empty array");
        }
        if entries.len() > 50_000 {
            return Reply::error(400, "Maximum 50000 entries per request");
        }
        let clear_source = body
            .get("clear_source")
            .filter(|v| match v {
                Value::Null | Value::Bool(false) => false,
                Value::Number(n) => n.as_f64() != Some(0.0),
                Value::String(s) => !s.is_empty(),
                Value::Array(a) => !a.is_empty(),
                Value::Object(m) => !m.is_empty(),
                Value::Bool(true) => true,
            })
            .map(|v| import_text(Some(v)).into_owned());
        let mut rows: Vec<ReadingEntry> = Vec::with_capacity(entries.len());
        let mut warnings = Vec::new();
        let (mut chars, mut time) = (0i128, 0.0);
        for (i, input) in entries.into_iter().enumerate() {
            let validated_day = rows.last().map(|row| row.date.as_str());
            match entry(&input, false, validated_day) {
                Ok(Some(row)) => {
                    chars += i128::from(row.characters);
                    time += row.seconds;
                    rows.push(row);
                }
                Ok(None) => {}
                Err(msg) => warnings.push(format!("Entry {i}: {msg}")),
            }
        }
        if !warnings.is_empty() && rows.is_empty() {
            return Reply {
                status: 400,
                body: json!({"error":"All entries failed validation","details":warnings}),
            };
        }
        let count = rows.len();
        let request = Request::ImportReadingStats { clear_source, rows };
        let cleared = match self.history.run(&self.database, request) {
            Ok(n) => n,
            Err(e) => return Reply::error(500, &format!("Import failed: {e}")),
        };
        let total = u64::try_from(chars)
            .map(Value::from)
            .unwrap_or_else(|_| json!(chars as f64));
        let rounded: f64 = format!("{time:.1}").parse().unwrap_or(time);
        let mut body = json!({"message":format!("Successfully imported {count} entries"),"imported_count":count,
            "total_characters":total,"total_time_seconds":rounded,"cleared_count":cleared});
        if !warnings.is_empty() {
            body["skipped_count"] = json!(warnings.len());
            body["warnings"] = json!(warnings);
        }
        Reply { status: 200, body }
    }
}
