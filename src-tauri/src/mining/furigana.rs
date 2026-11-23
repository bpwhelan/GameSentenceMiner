//! Japanese furigana generation for Anki cards using the desktop's shared
//! `gsm-sudachi` LanguageService.

use gsm_mining::text::preserve_html_tags_for_furigana;
use gsm_sudachi::{LanguageService, Request};
use std::sync::Arc;

fn is_kanji(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2A6DF
    )
}

fn format_anki_furigana(segments: &[serde_json::Value]) -> String {
    let mut out = String::new();
    let mut prev_had_reading = false;

    for seg in segments {
        let surface = seg["text"].as_str().unwrap_or("");
        if surface.is_empty() {
            continue;
        }
        let reading = seg["reading"].as_str().filter(|r| !r.is_empty());
        if let Some(reading) = reading {
            // Anki's {{furigana:Field}} syntax attaches `[reading]` to the token
            // after the previous space. Insert a separating space before kanji
            // tokens when preceded by non-whitespace/non-punctuation characters.
            if !out.is_empty() {
                let last = out.chars().last().unwrap_or(' ');
                if !last.is_whitespace()
                    && !matches!(last, '「' | '『' | '（' | '(' | '[' | '【' | '、' | '。' | '・' | '\n')
                {
                    out.push(' ');
                }
            }
            // Strip matching kana prefix/suffix (okurigana) so `食べる[たべる]` becomes `食[た]べる`.
            let surface_chars: Vec<char> = surface.chars().collect();
            let reading_chars: Vec<char> = reading.chars().collect();
            let mut prefix = 0usize;
            while prefix < surface_chars.len()
                && prefix < reading_chars.len()
                && !is_kanji(surface_chars[prefix])
                && surface_chars[prefix] == reading_chars[prefix]
            {
                prefix += 1;
            }
            let mut s_end = surface_chars.len();
            let mut r_end = reading_chars.len();
            while s_end > prefix
                && r_end > prefix
                && !is_kanji(surface_chars[s_end - 1])
                && surface_chars[s_end - 1] == reading_chars[r_end - 1]
            {
                s_end -= 1;
                r_end -= 1;
            }

            let lead: String = surface_chars[..prefix].iter().collect();
            let core: String = surface_chars[prefix..s_end].iter().collect();
            let core_reading: String = reading_chars[prefix..r_end].iter().collect();
            let tail: String = surface_chars[s_end..].iter().collect();

            out.push_str(&lead);
            if !core.is_empty() && !core_reading.is_empty() {
                out.push_str(&core);
                out.push('[');
                out.push_str(&core_reading);
                out.push(']');
            } else {
                out.push_str(&core);
            }
            out.push_str(&tail);
            prev_had_reading = true;
        } else {
            let _ = prev_had_reading;
            out.push_str(surface);
            prev_had_reading = false;
        }
    }
    out
}

/// Annotate plain Japanese text (or HTML-tagged sentence) with Anki furigana
/// `漢字[かんじ]`. Falls back to the original text if Sudachi is unavailable.
pub async fn generate_sentence_furigana(
    language: &Arc<LanguageService>,
    original_html: &str,
    plain_text: &str,
) -> String {
    let trimmed = plain_text.trim();
    if trimmed.is_empty() || !trimmed.chars().any(is_kanji) {
        return original_html.to_string();
    }
    let reply = match language
        .execute(Request::Analyze {
            text: trimmed.to_string(),
            furigana: true,
        })
        .await
    {
        Ok(value) => value,
        Err(_) => return original_html.to_string(),
    };
    let Some(segments) = reply.as_array() else {
        return original_html.to_string();
    };
    let annotated = format_anki_furigana(segments);
    if annotated.trim().is_empty() {
        return original_html.to_string();
    }
    if original_html.contains('<') && original_html.contains('>') {
        preserve_html_tags_for_furigana(original_html, &annotated)
    } else {
        annotated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_okurigana_and_separating_spaces() {
        let segs = vec![
            json!({"text": "今日", "reading": "きょう"}),
            json!({"text": "は", "reading": null}),
            json!({"text": "食べる", "reading": "たべる"}),
        ];
        assert_eq!(format_anki_furigana(&segs), "今日[きょう]は 食[た]べる");
    }
}
