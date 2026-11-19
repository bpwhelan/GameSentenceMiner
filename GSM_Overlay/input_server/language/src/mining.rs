//! Sudachi Mode B words as stored in GSM's historical vocabulary tables.
use regex::Regex;
use std::{
    borrow::Cow,
    sync::{Arc, LazyLock},
};
use sudachi::analysis::{stateless_tokenizer::StatelessTokenizer, Mode, Tokenize};
use sudachi::dic::dictionary::JapaneseDictionary;

pub struct MiningDictionary(pub(crate) Arc<JapaneseDictionary>);

pub fn analysis_text(input: &str) -> Cow<'_, str> {
    // Match the Python client's ordered replacements. A removed tag can join
    // two pieces of sound/type markup, so a single regex pass isn't equivalent.
    static MARKUP: LazyLock<[Regex; 3]> = LazyLock::new(|| {
        [
            Regex::new(r"<[^<>]+>").unwrap(),
            Regex::new(r"\[sound:[^\]]+\]").unwrap(),
            Regex::new(r"\[\[type:[^\]]+\]\]").unwrap(),
        ]
    });
    let input = input.trim_matches(|c: char| c.is_whitespace() || matches!(c, '\x1c'..='\x1f'));
    let mut text = Cow::Borrowed(input);
    if text.contains('\n') {
        text = Cow::Owned(text.replace('\n', " "));
    }
    if text.contains('～') {
        text = Cow::Owned(text.replace('～', "~"));
    }
    if text.contains(['<', '[']) {
        for re in MARKUP.iter() {
            if let Cow::Owned(replaced) = re.replace_all(&text, "") {
                text = Cow::Owned(replaced);
            }
        }
        let trimmed =
            text.trim_matches(|c: char| c.is_whitespace() || matches!(c, '\x1c'..='\x1f'));
        if trimmed.len() != text.len() {
            return Cow::Owned(trimmed.to_owned());
        }
    }
    text
}

fn stored_pos<'a>(primary: &'a str, secondary: Option<&str>) -> Option<&'a str> {
    match primary {
        "記号" | "補助記号" | "空白" | "その他" => None,
        "感動詞" if secondary == Some("フィラー") => Some("フィラー"),
        "フィラー" => Some("感動詞"),
        "接頭詞" => Some("接頭辞"),
        "名詞" | "動詞" | "形容詞" | "形状詞" | "副詞" | "助動詞" | "助詞" | "感動詞"
        | "接続詞" | "接頭辞" | "接尾辞" | "連体詞" | "代名詞" => Some(primary),
        _ => Some(""),
    }
}

impl MiningDictionary {
    pub fn visit_words(
        &self,
        text: &str,
        mut visit: impl FnMut(&str, &str, &str),
    ) -> Result<(), String> {
        let tokenizer = StatelessTokenizer::new(self.0.clone());
        let morphemes = tokenizer
            .tokenize(text, Mode::B, false)
            .map_err(|e| e.to_string())?;
        for morph in morphemes.iter() {
            let tags = morph.part_of_speech();
            let Some(pos) = stored_pos(
                tags.first().map(String::as_str).unwrap_or(""),
                tags.get(1).map(String::as_str),
            ) else {
                continue;
            };
            let surface = morph.surface();
            if surface.trim().is_empty() {
                continue;
            }
            let lemma = morph.dictionary_form();
            let word = if lemma.is_empty() { &surface } else { lemma };
            if !word.trim().is_empty() {
                visit(word, morph.reading_form(), pos);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strips_markup_in_client_order_and_retains_plain_text_by_reference() {
        assert!(matches!(analysis_text(" 日本 "), Cow::Borrowed("日本")));
        assert_eq!(
            analysis_text(" [so<b>und:声]～\n[[type:語]] 日本<b>  "),
            "~  日本"
        );
        assert_eq!(analysis_text(" [sound:] <> \x1e"), "[sound:] <>");
    }
    #[test]
    fn preserves_historical_parts_of_speech() {
        assert_eq!(stored_pos("記号", None), None);
        assert_eq!(stored_pos("感動詞", Some("フィラー")), Some("フィラー"));
        assert_eq!(stored_pos("フィラー", None), Some("感動詞"));
        assert_eq!(stored_pos("接頭詞", None), Some("接頭辞"));
        assert_eq!(stored_pos("unrecognized", None), Some(""));
    }
}
