//! Read the card model used by mining. Anki's fields are ordered objects.
use crate::anki_connect::{self, Collection};
use serde::{
    de::{MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{json, value::RawValue, Value};
use std::fmt;
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
struct Request {
    url: reqwest::Url,
    #[serde(flatten)]
    action: Action,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum Action {
    Latest,
    Notes { notes: Vec<i64> },
}

#[derive(Deserialize)]
struct Field {
    value: String,
    order: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    note_id: i64,
    tags: Vec<String>,
    #[serde(deserialize_with = "ordered_fields")]
    fields: Vec<Value>,
    cards: Vec<i64>,
    #[serde(default)]
    model_name: String,
}

fn ordered_fields<'de, D: Deserializer<'de>>(de: D) -> Result<Vec<Value>, D::Error> {
    struct Fields;
    impl<'de> Visitor<'de> for Fields {
        type Value = Vec<Value>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("an Anki fields object")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut fields = Vec::with_capacity(map.size_hint().unwrap_or(0));
            while let Some((name, Field { value, order })) = map.next_entry::<String, Field>()? {
                fields.push(Value::Array(vec![name.into(), value.into(), order.into()]));
            }
            Ok(fields)
        }
    }
    de.deserialize_map(Fields)
}

fn project(raw: &RawValue) -> Result<Value, String> {
    let rows: Vec<&RawValue> = serde_json::from_str(raw.get()).map_err(|e| e.to_string())?;
    let rows = rows
        .into_iter()
        .map(|row| {
            match serde_json::from_str::<Note>(row.get()) {
                Ok(n) => Value::Array(vec![
                    n.note_id.into(),
                    n.tags.into(),
                    Value::Array(n.fields),
                    n.cards.into(),
                    n.model_name.into(),
                ]),
                // Historical shapes use the original per-note decoder. Retain object
                // order and keep malformed rows from discarding their valid siblings.
                Err(_) => Value::String(row.get().to_owned()),
            }
        })
        .collect();
    gsm_runtime::bounded_reply(Value::Array(rows))
}

fn last_id(raw: &RawValue) -> Result<Option<Value>, String> {
    struct Last;
    impl<'de> Visitor<'de> for Last {
        type Value = Option<&'de RawValue>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a sequence of note IDs")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut last = None;
            while let Some(id) = seq.next_element::<&RawValue>()? {
                last = Some(id);
            }
            Ok(last)
        }
    }
    if raw.get() == "null" {
        return Ok(None);
    }
    let last = (&mut serde_json::Deserializer::from_str(raw.get()))
        .deserialize_seq(Last)
        .map_err(|e| e.to_string())?;
    last.map(|v| serde_json::from_str(v.get()))
        .transpose()
        .map_err(|e| e.to_string())
}

pub async fn request(app: &AppHandle, epoch: u64, data: Value) -> Result<Value, String> {
    let req: Request = serde_json::from_value(data).map_err(|e| e.to_string())?;
    if !matches!(req.url.scheme(), "http" | "https") {
        return Err("Invalid AnkiConnect URL".into());
    }
    let mut owner = app.state::<crate::anki_sync::SyncLane>().session(epoch)?;
    let desktop = app.state::<crate::desktop_state::DesktopState>();
    let anki = Collection {
        client: &desktop.http,
        url: &req.url,
    };
    tokio::select! {
        biased;
        _ = owner.changed() => Err("Anki card read stopped with the backend session".into()),
        res = async {
            let rows = match req.action {
                Action::Latest => {
                    let id = anki.call("findNotes", json!({"query":"added:1"}), last_id).await?;
                    if let Some(id) = id {
                        let rows = anki.call("notesInfo", json!({"notes":[id]}), project).await?;
                        if rows.is_null() {
                            return Ok(json!({"fallback_note":id}));
                        }
                        if rows.as_array().is_some_and(|rows| rows.is_empty()) {
                            return Err("The latest Anki note disappeared before it could be read".into());
                        }
                        rows
                    } else {
                        json!([])
                    }
                }
                Action::Notes { notes } => {
                    // The existing invoke loop records and can cancel each busy
                    // attempt when the monitor stops, including in timing logs.
                    let body = json!({"action":"notesInfo","version":6,"params":{"notes":notes}});
                    match anki_connect::attempt(anki.client, anki.url, &body, project).await? {
                        Some(rows) => rows,
                        None => return Ok(json!({"result":null,"error":anki_connect::BUSY})),
                    }
                }
            };
            if rows.is_null() {
                return Ok(Value::Null);
            }
            let mut envelope = serde_json::Map::new();
            envelope.insert("result".into(), rows);
            envelope.insert("error".into(), Value::Null);
            Ok(Value::Object(envelope))
        } => res,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_uses_the_last_returned_id_even_when_unsorted() {
        let raw = RawValue::from_string(r#"[750, 800, "11"]"#.into()).unwrap();
        assert_eq!(last_id(&raw).unwrap(), Some(json!("11")));
        assert_eq!(
            last_id(&RawValue::from_string("[]".into()).unwrap()).unwrap(),
            None
        );
    }

    #[test]
    fn only_needed_data_survives_in_original_field_order() {
        let raw = RawValue::from_string(r#"[{"cards":[44],"extra":"unused","noteId":12,"tags":["read"],"fields":{"Z":{"order":9,"value":"first"},"A":{"order":0,"value":"second"}}},{"noteId":"3"}]"#.into()).unwrap();
        assert_eq!(
            project(&raw).unwrap(),
            json!([
                [
                    12,
                    ["read"],
                    [["Z", "first", 9], ["A", "second", 0]],
                    [44],
                    ""
                ],
                r#"{"noteId":"3"}"#
            ])
        );
    }
}
