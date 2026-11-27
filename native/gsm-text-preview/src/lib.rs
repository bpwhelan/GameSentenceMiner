//! Preview the submitted settings against the active profile's language.
pub mod correlation;
mod hook_ranking;
pub use hook_ranking::HookFinder;
mod language;
mod replacements;
#[allow(dead_code)]
mod text_cleanup;

use gsm_settings::workspace::text_defaults;
use serde_json::Value;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;

pub const SIZE_LIMIT: usize = 4 * 1024 * 1024;
const SIZE_ERROR: &str = "Processed text exceeds the size limit.";
static DEFAULTS: LazyLock<Value> = LazyLock::new(text_defaults);

pub fn process(payload: &Value, target_language: &str) -> Result<String, String> {
    let text = payload["text"]
        .as_str()
        .ok_or("Preview requires text and settings")?;
    let config = &payload["config"];
    if !config.is_object() {
        return Err("Preview requires text and settings".into());
    }
    if serde_json::to_vec(payload)
        .map_err(|error| error.to_string())?
        .len()
        > SIZE_LIMIT
    {
        return Err("Preview input exceeds the size limit.".into());
    }
    LineFilters::new(Arc::new(config.clone()), target_language)?.process(text, &Value::Null)
}

/// A profile's ordered steps, compiled replacement expressions and language ranges.
pub struct LineFilters {
    config: Arc<Value>,
    steps: Vec<(String, bool)>,
    target: language::Target,
    rules: replacements::Rules,
}
impl LineFilters {
    pub fn new(config: Arc<Value>, language: &str) -> Result<Self, String> {
        Ok(Self {
            steps: processor_order(&config)?
                .into_iter()
                .map(|s| (s.to_owned(), processor_enabled(&config, s)))
                .collect(),
            target: language::Target::new(language),
            rules: replacements::Rules::new(&config["string_replacement"]),
            config,
        })
    }
    pub fn matches(&self, config: &Arc<Value>, language: &str) -> bool {
        Arc::ptr_eq(&self.config, config) && self.target.code() == language
    }
    pub fn process(&self, text: &str, overrides: &Value) -> Result<String, String> {
        let config = &self.config;
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut text = text.to_owned();
        let processors = Processors {
            config,
            target: &self.target,
            rules: &self.rules,
            deadline,
        };
        let mode = overrides["language_filter_mode"]
            .as_str()
            .filter(|mode| matches!(*mode, "blocks" | "trim" | "strict"))
            .unwrap_or_else(|| language_mode(config));
        for (processor, enabled) in &self.steps {
            if text.is_empty() {
                break;
            }
            check_deadline(deadline)?;
            if overrides[processor].as_bool().unwrap_or(*enabled) {
                text = processors.apply(text, processor, mode)?;
            }
        }
        check_deadline(deadline)?;
        Ok(text)
    }
}

fn language_mode(config: &Value) -> &str {
    nested(config, "language_filter_config", "mode")
        .as_str()
        .unwrap_or("")
}

fn processor_enabled(config: &Value, processor: &str) -> bool {
    enabled_value(match processor {
        "string_replacement" => &config[processor]["enabled"],
        "remove_repeated_lines" => setting(config, "remove_repeated_lines_v2"),
        _ => setting(config, processor),
    })
}

struct Processors<'a> {
    config: &'a Value,
    target: &'a language::Target,
    rules: &'a replacements::Rules,
    deadline: Instant,
}

impl<'a> Processors<'a> {
    fn apply(&self, text: String, processor: &str, mode: &str) -> Result<String, String> {
        let config = self.config;
        let result = match processor {
            "string_replacement" => {
                self.rules
                    .apply(&config["string_replacement"], text, self.deadline)?
            }
            "remove_repeated_chars" => text_cleanup::remove_repeated_chars(
                &text,
                integer_setting(config, "remove_repeated_chars_config", "repeat_count")?,
                enabled_value(nested(
                    config,
                    "remove_repeated_chars_config",
                    "keep_non_repeated",
                )),
            ),
            "remove_repeated_lines" => {
                let count =
                    integer_setting(config, "remove_repeated_lines_config", "repeat_count")?;
                let result = text_cleanup::remove_repeated_lines(&text, count);
                // Auto mode preserves single-character words such as いい.
                if count < 2 && result.chars().count() == 1 {
                    text
                } else {
                    result
                }
            }
            "remove_control_chars" => text
                .chars()
                .filter(|&ch| !ch.is_ascii_control() || matches!(ch, '\n' | '\r' | '\t'))
                .collect(),
            "language_filter" => self.target.filter(text, mode),
            "remove_non_japanese" => text.chars().filter(|&ch| shift_jis_encodable(ch)).collect(),
            "remove_newlines" => lines(&text).map(|(line, _)| line).collect(),
            "remove_numbers" => text.chars().filter(|ch| !ch.is_ascii_digit()).collect(),
            "remove_english" => text
                .chars()
                .filter(|ch| !ch.is_ascii_alphabetic())
                .collect(),
            "remove_curly_braces" => replacements::remove_curly_braces(text, self.deadline)?,
            "remove_angle_brackets" => {
                static TAGS: LazyLock<regex::Regex> =
                    LazyLock::new(|| regex::Regex::new(r"<[^>]*>").unwrap());
                TAGS.replace_all(&text, "").into_owned()
            }
            "extract_bracketed_text" => extract_dialogue(&text).to_owned(),
            "extract_lines" => extract_lines(
                text,
                integer_setting(config, "extract_lines_config", "max_lines")?,
                enabled_value(nested(config, "extract_lines_config", "from_end")),
            ),
            "unicode_normalize" => {
                match nested(config, "unicode_normalize_config", "form").as_str() {
                    Some("NFD") => text.nfd().collect(),
                    Some("NFC") => text.nfc().collect(),
                    Some("NFKD") => text.nfkd().collect(),
                    _ => text.nfkc().collect(),
                }
            }
            _ => text,
        };
        if result.len() > SIZE_LIMIT {
            return Err(SIZE_ERROR.into());
        }
        Ok(result)
    }
}

fn processor_order(config: &Value) -> Result<Vec<&str>, String> {
    let order = setting(config, "processor_order")
        .as_array()
        .ok_or("Preview processor order must be an array.")?;
    let mut order: Vec<_> = order.iter().filter_map(Value::as_str).collect();
    if !order.contains(&"language_filter") {
        // Migrate the old order before an enabled step can discard line boundaries.
        let index = order
            .iter()
            .position(|step| matches!(*step, "remove_non_japanese" | "remove_newlines"))
            .unwrap_or(order.len());
        order.insert(index, "language_filter");
    }
    Ok(order)
}

fn setting<'a>(config: &'a Value, key: &str) -> &'a Value {
    config.get(key).unwrap_or(&DEFAULTS[key])
}

fn nested<'a>(config: &'a Value, section: &str, key: &str) -> &'a Value {
    config[section].get(key).unwrap_or(&DEFAULTS[section][key])
}

fn enabled_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}

fn integer_setting(config: &Value, section: &str, key: &str) -> Result<i64, String> {
    let value = nested(config, section, key);
    // Saved profiles can contain numeric strings or floating-point values.
    let number = value
        .as_i64()
        .or_else(|| value.as_f64().map(|number| number as i64))
        .or_else(|| value.as_str()?.trim().parse().ok())
        .or_else(|| value.as_bool().map(i64::from));
    number.ok_or_else(|| format!("Invalid preview setting: {section}.{key}"))
}

fn check_deadline(deadline: Instant) -> Result<(), &'static str> {
    if Instant::now() >= deadline {
        return Err("Text processing preview timed out.");
    }
    Ok(())
}

fn append(output: &mut String, text: &str) -> Result<(), &'static str> {
    if text.len() > SIZE_LIMIT - output.len() {
        return Err(SIZE_ERROR);
    }
    output.push_str(text);
    Ok(())
}

fn shift_jis_encodable(ch: char) -> bool {
    // The old port captured Python's shiftjis codec ranges, including the
    // exclusions that differ from Windows code page 932.
    static RANGES: LazyLock<Vec<(u32, u32)>> =
        LazyLock::new(|| serde_json::from_str(include_str!("shift_jis_ranges.json")).unwrap());
    let value = ch as u32;
    RANGES
        .get(RANGES.partition_point(|&(_, end)| end < value))
        .is_some_and(|&(start, _)| start <= value)
}

fn extract_dialogue(text: &str) -> &str {
    if let Some((prefix, rest)) = text.split_once('「') {
        if prefix.chars().count() <= 8 && !prefix.contains(['\r', '\n', '」']) {
            return rest.strip_suffix('」').unwrap_or(text);
        }
    }
    text
}

fn extract_lines(text: String, max_lines: i64, from_end: bool) -> String {
    let lines: Vec<_> = lines(&text).map(|(line, _)| line).collect();
    let count = usize::try_from(max_lines.unsigned_abs()).unwrap_or(usize::MAX);
    if lines.len() <= count {
        return text;
    }
    match (from_end, max_lines.cmp(&0)) {
        (true, std::cmp::Ordering::Greater) => lines[lines.len() - count..].join("\n"),
        (true, _) => lines[count..].join("\n"),
        (false, std::cmp::Ordering::Less) => lines[..lines.len() - count].join("\n"),
        (false, _) => lines[..count].join("\n"),
    }
}

/// Python splitlines, retaining the exact separators for language filtering.
fn lines(mut rest: &str) -> impl Iterator<Item = (&str, &str)> {
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let Some(offset) = rest.find(|ch| {
            matches!(
                ch,
                '\n' | '\r' | '\x0b' | '\x0c' | '\x1c'
                    ..='\x1e' | '\u{85}' | '\u{2028}' | '\u{2029}'
            )
        }) else {
            return Some((std::mem::take(&mut rest), ""));
        };
        let (line, tail) = rest.split_at(offset);
        let length = if tail.starts_with("\r\n") {
            2
        } else {
            tail.chars().next().unwrap().len_utf8()
        };
        let (ending, remaining) = tail.split_at(length);
        rest = remaining;
        Some((line, ending))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preview_matches_python_fixtures() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/parity.json")).unwrap();
        let mut failures = Vec::new();
        for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let language = case["target_language"].as_str().unwrap_or("ja");
            let result = process(case, language);
            if result.as_deref().ok() != case["expected"].as_str() {
                failures.push(format!(
                    "case {index} {} with input {}: expected {}, got {result:?}",
                    case["name"], case["text"], case["expected"]
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn rejects_invalid_requests_and_bounded_expansion() {
        assert!(process(&json!({"text":5,"config":{}}), "ja").is_err());
        let large_replacement = "a".repeat(SIZE_LIMIT / 2);
        let request = json!({"text":"aaaa","config":{"string_replacement":{
            "enabled":true,"rules":[{"find":"a","replace":large_replacement}]
        }}});
        assert_eq!(process(&request, "ja").unwrap_err(), SIZE_ERROR);
    }
}
