//! Preserve Anki's original HTML, including existing groups and malformed fragments.
use caseless::Caseless;
use regex::{Captures, Regex};
use std::{borrow::Cow, sync::LazyLock};

macro_rules! pattern {
    ($source:literal) => {{
        static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new($source).unwrap());
        &*RE
    }};
}

pub(super) fn space(c: char) -> bool {
    c.is_whitespace() || matches!(c, '\x1c'..='\x1f')
}

fn entity(reference: &str) -> Cow<'_, str> {
    let name = &reference[1..];
    if let Some(number) = name.strip_prefix('#') {
        let number = number.trim_end_matches(';');
        let (digits, radix) = match number.strip_prefix(['x', 'X']) {
            Some(hex) => (hex, 16),
            None => (number, 10),
        };
        let n = u32::from_str_radix(digits, radix).unwrap_or(u32::MAX);
        let c = match n {
            0 | 0xd800..=0xdfff | 0x110000.. => char::REPLACEMENT_CHARACTER,
            0x80..=0x9f => web_atoms::C1_REPLACEMENTS[(n - 0x80) as usize]
                .unwrap_or_else(|| char::from_u32(n).unwrap()),
            1..=8 | 11 | 14..=31 | 127 | 0xfdd0..=0xfdef => return Cow::Borrowed(""),
            _ if n & 0xffff >= 0xfffe => return Cow::Borrowed(""),
            _ => char::from_u32(n).unwrap(),
        };
        return Cow::Owned(c.to_string());
    }
    // The table also contains zero-valued prefix entries. Use the longest
    // complete name, preserving the suffix of a semicolonless reference.
    let mut prefix = name;
    while !prefix.is_empty() {
        if let Some(&(first, second)) = web_atoms::NAMED_ENTITIES.get(prefix) {
            if first != 0 {
                let mut result = char::from_u32(first).unwrap().to_string();
                if second != 0 {
                    result.push(char::from_u32(second).unwrap());
                }
                result.push_str(&name[prefix.len()..]);
                return Cow::Owned(result);
            }
        }
        prefix = &prefix[..prefix.char_indices().next_back().unwrap().0];
    }
    Cow::Borrowed(reference)
}

fn unescape(text: &str) -> Cow<'_, str> {
    if !text.contains('&') {
        return Cow::Borrowed(text);
    }
    pattern!(r"&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\x0c <&#;]{1,32};?)")
        .replace_all(text, |m: &Captures| entity(&m[0]).into_owned())
}

pub(super) fn plain(input: &str) -> String {
    let mut text = Cow::Borrowed(input);
    for (prefix, regex, replacement) in [
        ("[", pattern!(r"\[.*?\]"), ""),
        ("{{c", pattern!(r"\{\{c\d+::(.*?)(::.*?)?\}\}"), "$1"),
        ("<", pattern!(r"<.*?>"), ""),
    ] {
        if text.contains(prefix) {
            text = Cow::Owned(regex.replace_all(&text, replacement).into_owned());
        }
    }
    if text.contains('&') {
        unescape(&text).into_owned()
    } else {
        text.into_owned()
    }
}

pub(super) fn word(input: &str) -> String {
    plain(input)
        .chars()
        .filter(|&c| !space(c))
        .default_case_fold()
        .collect()
}

fn group_attribute() -> &'static Regex {
    pattern!(r#"(?i)\bdata-group-id[\s\x1c-\x1f]*=[\s\x1c-\x1f]*(?:"(\d+)"|'(\d+)'|(\d+))"#)
}

fn attribute_id(m: &Captures) -> Option<u64> {
    m.get(1)
        .or_else(|| m.get(2))
        .or_else(|| m.get(3))?
        .as_str()
        .parse()
        .ok()
}

pub(super) fn bounds(value: &str, min: &mut u64, max: &mut u64) -> Option<()> {
    for m in group_attribute().captures_iter(value) {
        let id = attribute_id(&m)?;
        *min = (*min).min(id);
        *max = (*max).max(id);
    }
    Some(())
}

// Called only after every ID has been checked for representability and overflow.
pub(super) fn shift_ids(value: &str) -> Cow<'_, str> {
    group_attribute().replace_all(value, |m: &Captures| {
        let quote = if m.get(1).is_some() {
            "\""
        } else if m.get(2).is_some() {
            "'"
        } else {
            ""
        };
        format!(
            "data-group-id={quote}{}{quote}",
            attribute_id(m).unwrap() + 1
        )
    })
}

fn tokens() -> &'static Regex {
    pattern!(r"<[^>]+>")
}

fn ungrouped(output: &mut String, fragment: &str, id: u64) {
    if fragment.is_empty() {
        return;
    }
    let stripped = tokens().replace_all(fragment, "");
    let content = unescape(&stripped);
    if content.chars().any(|c| !space(c)) {
        use std::fmt::Write;
        write!(output, "<span data-group-id=\"{id}\">{fragment}</span>").unwrap();
    } else {
        output.push_str(fragment);
    }
}

fn opens_group_level(name: &str, token: &str) -> bool {
    if token.ends_with("/>") {
        return false;
    }
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

pub(super) fn append(output: &mut String, value: &str, id: u64, image: bool) {
    if image {
        let mut start = 0;
        for m in pattern!(r"(?i)<img\b[^>]*>").find_iter(value) {
            if !group_attribute().is_match(m.as_str()) {
                use std::fmt::Write;
                let name_end = m.start() + "<img".len();
                output.push_str(&value[start..name_end]);
                write!(output, " data-group-id=\"{id}\"").unwrap();
                start = name_end;
            }
        }
        output.push_str(&value[start..]);
        return;
    }
    let mut start = 0;
    let mut depth = 0usize;
    for token in tokens().find_iter(value) {
        let tag = token.as_str();
        if depth > 0
            && pattern!(r"^<[\s\x1c-\x1f]*/[\s\x1c-\x1f]*[a-zA-Z][\w:-]*[\s\x1c-\x1f]*>")
                .is_match(tag)
        {
            depth -= 1;
            if depth == 0 {
                output.push_str(&value[start..token.end()]);
                start = token.end();
            }
            continue;
        }
        let Some(m) = pattern!(r"^<[\s\x1c-\x1f]*([a-zA-Z][\w:-]*)\b").captures(tag) else {
            continue;
        };
        if depth > 0 {
            depth += usize::from(opens_group_level(&m[1], tag));
        } else if group_attribute().is_match(tag) {
            ungrouped(output, &value[start..token.start()], id);
            start = token.start();
            if opens_group_level(&m[1], tag) {
                depth = 1;
            } else {
                output.push_str(tag);
                start = token.end();
            }
        }
    }
    if depth == 0 {
        ungrouped(output, &value[start..], id);
    } else {
        output.push_str(&value[start..]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_keeps_search_and_display_semantics() {
        assert_eq!(
            word("<b>Straße</b> {{c2::猫::hint}}[sound:x] &nbsp;&#x41;\x1c"),
            "strasse猫a"
        );
        assert_eq!(
            plain("&NotEqualTilde; &notit; &#0; &#x80; &#x1f; &unknown;"),
            "≂̸ ¬it; � €  &unknown;"
        );
        assert_eq!(plain("<a\nb>x</a>"), "<a\nb>x");
    }
    #[test]
    fn wrappers_preserve_nested_unclosed_and_empty_groups() {
        let mut out = String::new();
        append(
            &mut out,
            "&nbsp;<br><b DATA-group-ID='2'>x<i>y</i></b>tail",
            8,
            false,
        );
        assert_eq!(
            out,
            "&nbsp;<br><b DATA-group-ID='2'>x<i>y</i></b><span data-group-id=\"8\">tail</span>"
        );
        out.clear();
        append(&mut out, "<em data-group-id=1>open<br>x", 8, false);
        assert_eq!(out, "<em data-group-id=1>open<br>x");
    }

    #[test]
    fn reads_real_group_attributes_and_preserves_quote_style_during_renumbering() {
        let text =
            r#"<img DATA-GROUP-ID = '01'><span data-group-id=2>text</span><b data-group-id="5">x"#;
        let (mut min, mut max) = (3, 3);
        assert_eq!(bounds(text, &mut min, &mut max), Some(()));
        assert_eq!((min, max), (1, 5));
        assert_eq!(
            shift_ids(text),
            r#"<img data-group-id='2'><span data-group-id=3>text</span><b data-group-id="6">x"#
        );
        assert_eq!(bounds("<i data-group-id='９'>", &mut min, &mut max), None);
        assert_eq!(
            bounds("<i data-group-id=18446744073709551616>", &mut min, &mut max),
            None
        );
    }
}
