//! Bounded replacement rules with Python's anchors and replacement templates.
use super::{append, check_deadline, enabled_value};
use fancy_regex::{Captures, Regex, RegexBuilder};
use serde_json::Value;
use std::sync::LazyLock;
use std::time::Instant;

/// Retain compiled user expressions for this batch only. A very large saved
/// rule list can still run without pinning all its compiled automata in memory.
pub(super) struct Rules {
    cached: Vec<std::cell::OnceCell<Result<Option<Rule>, String>>>,
}

impl Rules {
    pub fn new(config: &Value) -> Self {
        let rules = config["rules"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        Self {
            cached: (0..rules.len().min(16))
                .map(|_| Default::default())
                .collect(),
        }
    }
    pub fn apply(
        &self,
        config: &Value,
        mut text: String,
        deadline: Instant,
    ) -> Result<String, String> {
        for (i, value) in config["rules"].as_array().into_iter().flatten().enumerate() {
            check_deadline(deadline)?;
            let uncached;
            let rule = if let Some(slot) = self.cached.get(i) {
                slot.get_or_init(|| Rule::from_config(value))
                    .as_ref()
                    .map_err(Clone::clone)?
            } else {
                uncached = Rule::from_config(value)?;
                &uncached
            };
            if let Some(rule) = rule {
                text = rule.apply(text, deadline)?;
            }
        }
        Ok(text)
    }
}

struct Rule {
    regex: Regex,
    replacement: Replacement,
    pattern: String,
    insensitive: bool,
    nonempty: std::sync::OnceLock<Option<Regex>>,
}

impl Rule {
    fn from_config(rule: &Value) -> Result<Option<Self>, String> {
        let find = rule["find"].as_str().unwrap_or("");
        if find.is_empty()
            || rule
                .get("enabled")
                .is_some_and(|value| !enabled_value(value))
        {
            return Ok(None);
        }
        let mode = rule["mode"].as_str().unwrap_or("plain").trim();
        let regex_rule =
            mode.eq_ignore_ascii_case("regex") || mode.eq_ignore_ascii_case("regex_replace");
        let template = rule["replace"].as_str().unwrap_or("");
        let mut pattern = if regex_rule {
            find.to_owned()
        } else {
            regex::escape(find)
        };
        if regex_rule
            && template.is_empty()
            && matches!(pattern.replace(' ', "").as_str(), "<.*>" | "<.+>")
        {
            pattern = r"<[^>]*>".into();
        }
        if enabled_value(&rule["whole_word"]) {
            pattern = format!(r"\b{pattern}\b");
        }
        Self::new(
            &pattern,
            template,
            !regex_rule,
            !enabled_value(&rule["case_sensitive"]),
        )
    }

    fn new(
        pattern: &str,
        template: &str,
        literal: bool,
        insensitive: bool,
    ) -> Result<Option<Self>, String> {
        let pattern = python_pattern(pattern);
        let Ok(regex) = compile(&pattern, insensitive) else {
            // A malformed regex is a no-op in the settings preview.
            return Ok(None);
        };
        let replacement = if literal {
            Replacement::Literal(template.to_owned())
        } else {
            match parse_template(template, &regex) {
                Ok(parts) => Replacement::Groups(parts),
                Err(TemplateError::Invalid) => return Ok(None),
                Err(TemplateError::UnknownGroup(name)) => {
                    return Err(format!("Unknown regex replacement group: {name}"));
                }
            }
        };

        Ok(Some(Self {
            regex,
            replacement,
            pattern,
            insensitive,
            nonempty: Default::default(),
        }))
    }
    fn apply(&self, input: String, deadline: Instant) -> Result<String, String> {
        let mut output = String::with_capacity(input.len());
        let mut previous = 0;
        let mut start = 0;

        loop {
            check_deadline(deadline)?;
            let Some(captures) = find(&self.regex, &input, start)? else {
                break;
            };
            let found = captures.get(0).unwrap();
            append(&mut output, &input[previous..found.start()])?;
            self.replacement.expand(&captures, &mut output)?;
            previous = found.end();
            start = previous;
            if found.start() == previous {
                let Some(next) = input[previous..].chars().next() else {
                    break;
                };
                // Python permits a consuming match immediately after a zero-width
                // match at the same position. \G anchors this second search.
                let consuming = self.nonempty.get_or_init(|| {
                    compile(&format!(r"\G(?:{})(?<!\G)", self.pattern), self.insensitive).ok()
                });
                if let Some(regex) = consuming {
                    if let Some(captures) = find(regex, &input, previous)? {
                        self.replacement.expand(&captures, &mut output)?;
                        previous = captures.get(0).unwrap().end();
                        start = previous;
                        continue;
                    }
                }
                start += next.len_utf8();
            }
        }
        append(&mut output, &input[previous..])?;
        Ok(output)
    }
}
pub(super) fn remove_curly_braces(mut text: String, deadline: Instant) -> Result<String, String> {
    if !text.contains('{') {
        return Ok(text);
    }
    static RULES: LazyLock<[Rule; 3]> = LazyLock::new(|| {
        [
            (r"\{(\w+)(.*?)\}(.*?)\{/\1\}", r"\3"),
            (r"\{([^}]?)[:/](.*?)\}", r"\1"),
            (r"\{.*?\}", ""),
        ]
        .map(|(pattern, template)| {
            Rule::new(pattern, template, false, false)
                .expect("valid built-in expression")
                .unwrap()
        })
    });
    for rule in RULES.iter() {
        text = rule.apply(text, deadline)?;
    }
    Ok(text)
}

fn compile(pattern: &str, insensitive: bool) -> fancy_regex::Result<Regex> {
    RegexBuilder::new(pattern)
        .case_insensitive(insensitive)
        .backtrack_limit(1_000_000)
        .build()
}

fn find<'text>(
    regex: &Regex,
    text: &'text str,
    start: usize,
) -> Result<Option<Captures<'text>>, String> {
    regex
        .captures_from_pos(text, start)
        .map_err(|error| format!("Text processing regex failed: {error}"))
}

fn python_pattern(pattern: &str) -> String {
    // Python's Unicode word class is alphanumeric plus underscore.
    const WORD: &str = r"[\p{L}\p{N}_]";
    const BOUNDARY: &str =
        r"(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))";
    let mut chars = pattern.chars().peekable();
    let mut result = String::with_capacity(pattern.len());
    let mut in_class = false;
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => match chars.next() {
                Some('Z') if !in_class => result.push_str(r"\z"),
                Some('w') => result.push_str(WORD),
                Some('W') => result.push_str(r"[^\p{L}\p{N}_]"),
                Some('s') => result.push_str(r"[\s\x1c-\x1f]"),
                Some('S') => result.push_str(r"[^\s\x1c-\x1f]"),
                Some('b') if in_class => result.push_str(r"\x08"),
                Some('b') => result.push_str(BOUNDARY),
                Some('B') if !in_class => {
                    result.push_str("(?!\\A\\z)(?!");
                    result.push_str(BOUNDARY);
                    result.push(')');
                }
                escaped => {
                    result.push('\\');
                    result.extend(escaped);
                }
            },
            '[' if !in_class => {
                in_class = true;
                result.push(ch);
                if chars.next_if_eq(&'^').is_some() {
                    result.push('^');
                }
                if chars.next_if_eq(&']').is_some() {
                    result.push_str(r"\]");
                }
            }
            '[' => result.push_str(r"\["),
            ']' if in_class => {
                in_class = false;
                result.push(ch);
            }
            '$' if !in_class => result.push_str(r"(?:$|(?=\n\z))"),
            _ => result.push(ch),
        }
    }
    result
}

enum Replacement {
    Literal(String),
    Groups(Vec<Part>),
}

enum Part {
    Text(String),
    Group(usize),
}

impl Replacement {
    fn expand(&self, captures: &Captures<'_>, output: &mut String) -> Result<(), &'static str> {
        match self {
            Self::Literal(value) => append(output, value),
            Self::Groups(parts) => {
                for part in parts {
                    match part {
                        Part::Text(text) => append(output, text)?,
                        Part::Group(index) => {
                            if let Some(value) = captures.get(*index) {
                                append(output, value.as_str())?;
                            }
                        }
                    }
                }
                Ok(())
            }
        }
    }
}

enum TemplateError {
    Invalid,
    UnknownGroup(String),
}

fn parse_template(template: &str, regex: &Regex) -> Result<Vec<Part>, TemplateError> {
    let chars: Vec<_> = template.chars().collect();
    let mut parts = Vec::new();
    let mut literal = String::new();
    let mut offset = 0;
    while let Some(&ch) = chars.get(offset) {
        let escaped_dollar = offset > 0 && chars[offset - 1] == '\\';
        offset += 1;
        let group = match ch {
            '$' if !escaped_dollar && chars.get(offset).is_some_and(char::is_ascii_digit) => {
                let start = offset;
                while chars.get(offset).is_some_and(char::is_ascii_digit) {
                    offset += 1;
                }
                Some(chars[start..offset].iter().collect::<String>())
            }
            '\\' => template_escape(&chars, &mut offset, &mut literal)?,
            _ => {
                literal.push(ch);
                None
            }
        };
        if let Some(name) = group {
            let index = group_index(regex, name)?;
            if !literal.is_empty() {
                parts.push(Part::Text(std::mem::take(&mut literal)));
            }
            parts.push(Part::Group(index));
        }
    }
    if !literal.is_empty() {
        parts.push(Part::Text(literal));
    }
    Ok(parts)
}

fn template_escape(
    chars: &[char],
    offset: &mut usize,
    literal: &mut String,
) -> Result<Option<String>, TemplateError> {
    let &ch = chars.get(*offset).ok_or(TemplateError::Invalid)?;
    *offset += 1;
    match ch {
        'g' if chars.get(*offset) == Some(&'<') => {
            let start = *offset + 1;
            let end = start
                + chars[start..]
                    .iter()
                    .position(|&c| c == '>')
                    .ok_or(TemplateError::Invalid)?;
            *offset = end + 1;
            return Ok(Some(chars[start..end].iter().collect()));
        }
        '0'..='9' => {
            let mut number = String::from(ch);
            let octal = |value: &char| matches!(value, '0'..='7');
            let is_octal = ch == '0'
                || (octal(&ch)
                    && chars.get(*offset).is_some_and(octal)
                    && chars.get(*offset + 1).is_some_and(octal));
            if !is_octal {
                if let Some(&digit) = chars.get(*offset).filter(|c| c.is_ascii_digit()) {
                    number.push(digit);
                    *offset += 1;
                }
                return Ok(Some(number));
            }
            for _ in 0..2 {
                let Some(&digit) = chars.get(*offset).filter(|c| octal(c)) else {
                    break;
                };
                number.push(digit);
                *offset += 1;
            }
            let value = u8::from_str_radix(&number, 8).map_err(|_| TemplateError::Invalid)?;
            literal.push(char::from(value));
        }
        'a' => literal.push('\x07'),
        'b' => literal.push('\x08'),
        'f' => literal.push('\x0c'),
        'n' => literal.push('\n'),
        'r' => literal.push('\r'),
        't' => literal.push('\t'),
        'v' => literal.push('\x0b'),
        '\\' => literal.push('\\'),
        ch if ch.is_ascii_alphabetic() => return Err(TemplateError::Invalid),
        _ => {
            literal.push('\\');
            literal.push(ch);
        }
    }
    Ok(None)
}

fn group_index(regex: &Regex, name: String) -> Result<usize, TemplateError> {
    if !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit()) {
        return name
            .parse()
            .ok()
            .filter(|&index| index < regex.captures_len())
            .ok_or(TemplateError::Invalid);
    }
    static IDENTIFIER: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\A[_\p{XID_Start}]\p{XID_Continue}*\z").unwrap());
    if !IDENTIFIER.is_match(&name) {
        return Err(TemplateError::Invalid);
    }
    regex
        .capture_names()
        .position(|group| group == Some(name.as_str()))
        .ok_or(TemplateError::UnknownGroup(name))
}
