use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

static SPOILER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)\[spoiler\].*?\[/spoiler\]").unwrap());
static ANILIST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)~!.*?!~").unwrap());
static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\[url=[^\]]+\]([^\[]*)\[/url\]").unwrap());
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

pub(super) fn role(name: &str) -> Option<(i32, &'static str, &'static str)> {
    Some(match name {
        "main" => (100, "Protagonist", "#4CAF50"),
        "primary" => (75, "Main Character", "#2196F3"),
        "side" => (50, "Side Character", "#FF9800"),
        "appears" => (25, "Minor Role", "#9E9E9E"),
        _ => return None,
    })
}

fn physical(c: &Value) -> String {
    fn display(v: &Value) -> Option<String> {
        match v {
            Value::String(s) if !s.is_empty() => Some(s.clone()),
            Value::Number(n) if n.as_f64() != Some(0.0) => Some(n.to_string()),
            _ => None,
        }
    }
    let mut parts = Vec::new();
    match c["sex"]
        .as_str()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "m" | "male" => parts.push("♂ Male".into()),
        "f" | "female" => parts.push("♀ Female".into()),
        _ => {}
    }
    for (key, unit) in [("age", " years"), ("height", "cm"), ("weight", "kg")] {
        if let Some(v) = display(&c[key]) {
            parts.push(format!("{v}{unit}"));
        }
    }
    if let Some(v) = display(&c["blood_type"]) {
        parts.push(format!("Blood Type {v}"));
    }
    match &c["birthday"] {
        Value::String(s) if !s.is_empty() => parts.push(format!("Birthday: {s}")),
        Value::Array(a) if a.len() >= 2 => {
            let text = |v: &Value| {
                v.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string())
            };
            let month = a[0]
                .as_u64()
                .and_then(|n| n.checked_sub(1))
                .and_then(|n| MONTHS.get(n as usize))
                .map(|s| s.to_string())
                .unwrap_or_else(|| text(&a[0]));
            parts.push(format!("Birthday: {month} {}", text(&a[1])));
        }
        _ => {}
    }
    parts.join(" • ")
}

pub(super) fn definition(c: &Value, game: &str, image: Option<&str>, spoiler: u8) -> Value {
    let mut out = Vec::new();
    let text = |key: &str| c[key].as_str().filter(|s| !s.is_empty());
    if let Some(n) = text("name_original") {
        out.push(json!({"tag":"div","style":{"fontWeight":"bold","fontSize":"1.2em"},"content":n}));
    }
    if let Some(n) = text("name") {
        out.push(json!({"tag":"div","style":{"fontStyle":"italic","color":"#666","marginBottom":"8px"},"content":n}));
    }
    if let Some(img) = image {
        out.push(json!({"tag":"img","path":img,"width":80,"height":100,"sizeUnits":"px","collapsible":false,"collapsed":false,"background":false}));
    }
    if !game.is_empty() {
        out.push(json!({"tag":"div","style":{"fontSize":"0.9em","color":"#888","marginTop":"4px"},"content":format!("From: {game}")}));
    }
    if let Some((_, label, color)) = text("role").and_then(role) {
        out.push(json!({"tag":"span","style":{"background":color,"color":"white","padding":"2px 6px","borderRadius":"3px","fontSize":"0.85em","marginTop":"4px"},"content":label}));
    }
    if spoiler > 0 {
        if let Some(description) = text("description").filter(|s| !s.trim().is_empty()) {
            let vndb;
            let anilist;
            let description = if spoiler == 1 {
                vndb = SPOILER.replace_all(description, "");
                anilist = ANILIST.replace_all(&vndb, "");
                anilist.trim()
            } else {
                description
            };
            if !description.is_empty() {
                out.push(json!({"tag":"details","content":[{"tag":"summary","content":"Description"},
                {"tag":"div","style":{"fontSize":"0.9em","marginTop":"4px"},"content":LINK.replace_all(description,"$1") }]}));
            }
        }
        let mut info = Vec::new();
        let physical = physical(c);
        if !physical.is_empty() {
            info.push(json!({"tag":"li","style":{"fontWeight":"bold"},"content":physical}));
        }
        for (key, label) in [
            ("personality", "Personality"),
            ("roles", "Role"),
            ("engages_in", "Activities"),
            ("subject_of", "Subject of"),
        ] {
            let traits: Vec<_> = c[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| {
                    t.as_str().or_else(|| {
                        (t["spoiler"].as_i64().unwrap_or(0) <= i64::from(spoiler))
                            .then(|| t["name"].as_str())
                            .flatten()
                    })
                })
                .filter(|s| !s.is_empty())
                .collect();
            if !traits.is_empty() {
                info.push(json!({"tag":"li","content":format!("{label}: {}",traits.join(", "))}));
            }
        }
        if !info.is_empty() {
            out.push(json!({"tag":"details","content":[{"tag":"summary","content":"Character Information"},
            {"tag":"ul","style":{"marginTop":"4px","paddingLeft":"20px"},"content":info}]}));
        }
    }
    json!({"type":"structured-content","content":out})
}
