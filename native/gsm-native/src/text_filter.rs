#[derive(Debug, PartialEq, Eq)]
pub struct TextFilterOutput {
    pub text: String,
    pub all_blocks: Vec<String>,
    pub compare_blocks: Vec<Option<String>>,
}

pub fn filter_text(
    source_text: &str,
    blocks: &[String],
    language: &str,
    previous_blocks: &[String],
    historic_compare_blocks: &[String],
) -> TextFilterOutput {
    let language = normalize_language(language);
    let source_text = normalize_source_text(source_text);
    let mut filtered_blocks = Vec::with_capacity(blocks.len());
    let mut compare_blocks = Vec::with_capacity(blocks.len());

    for block in blocks {
        let (filtered, compare) = filter_block(block, language);
        filtered_blocks.push(filtered);
        compare_blocks.push(compare);
    }

    let mut previous_compare = previous_blocks
        .iter()
        .filter_map(|block| normalize_compare_block(block, language))
        .collect::<Vec<_>>();
    for block in historic_compare_blocks {
        if !block.is_empty() && !previous_compare.contains(block) {
            previous_compare.push(block.clone());
        }
    }

    let duplicate_prefix_len = compare_blocks
        .iter()
        .map_while(Option::as_ref)
        .take_while(|block| previous_compare.contains(*block))
        .count();

    let all_blocks = blocks
        .iter()
        .zip(&filtered_blocks)
        .filter_map(|(block, filtered)| {
            filtered
                .as_ref()
                .map(|_| block.trim().replace("BLANK_LINE", "\n"))
        })
        .collect::<Vec<_>>();

    let selected_indexes = compare_blocks
        .iter()
        .enumerate()
        .filter_map(|(index, compare)| {
            (index >= duplicate_prefix_len && compare.is_some()).then_some(index)
        })
        .collect::<Vec<_>>();

    let text =
        join_selected_blocks_with_source_separators(&source_text, blocks, &selected_indexes, "\n");
    TextFilterOutput {
        text,
        all_blocks,
        compare_blocks,
    }
}

fn normalize_language(language: &str) -> &str {
    language.split(['-', '_']).next().unwrap_or(language)
}

fn normalize_source_text(text: &str) -> String {
    text.replace("BLANK_LINE", "\n")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

fn normalize_compare_block(block: &str, language: &str) -> Option<String> {
    if block.contains("BLANK_LINE") || block == "\n" {
        return Some("\n".to_owned());
    }
    let (_, compare) = filter_block(block, language);
    compare
}

fn filter_block(block: &str, language: &str) -> (Option<String>, Option<String>) {
    if block.contains("BLANK_LINE") {
        return (Some("\n".to_owned()), Some("\n".to_owned()));
    }

    let mut filtered = String::new();
    let mut compare = String::new();
    for character in block.chars() {
        let comparable = is_comparable(character, language);
        if comparable {
            compare.push(character);
        }
        if comparable || (language == "ja" && is_japanese_punctuation(character)) {
            filtered.push(character);
        }
    }

    (
        (!filtered.is_empty()).then_some(filtered),
        (!compare.is_empty()).then_some(compare),
    )
}

pub(crate) fn is_comparable(character: char, language: &str) -> bool {
    match language {
        "ja" => is_hiragana(character) || is_katakana(character) || is_han(character),
        "zh" => is_han(character),
        "ko" => ('\u{ac00}'..='\u{d7af}').contains(&character),
        "ar" => matches!(
            character as u32,
            0x0600..=0x06ff | 0x0750..=0x077f | 0x08a0..=0x08ff | 0xfb50..=0xfdff | 0xfe70..=0xfeff
        ),
        "ru" => matches!(
            character as u32,
            0x0400..=0x04ff | 0x0500..=0x052f | 0x2de0..=0x2dff | 0xa640..=0xa69f | 0x1c80..=0x1c8f
        ),
        "el" => matches!(character as u32, 0x0370..=0x03ff | 0x1f00..=0x1fff),
        "he" => matches!(character as u32, 0x0590..=0x05ff | 0xfb1d..=0xfb4f),
        "th" => ('\u{0e00}'..='\u{0e7f}').contains(&character),
        _ => is_latin_extended(character),
    }
}

pub fn contains_japanese_text(text: &str) -> bool {
    text.chars().any(|character| {
        is_hiragana(character)
            || is_katakana(character)
            || ('\u{4e01}'..='\u{9fff}').contains(&character)
    })
}

pub fn contains_kanji(text: &str) -> bool {
    text.chars().any(is_han)
}

fn is_hiragana(character: char) -> bool {
    ('\u{3041}'..='\u{3096}').contains(&character)
}

fn is_katakana(character: char) -> bool {
    ('\u{30a1}'..='\u{30fa}').contains(&character)
}

fn is_han(character: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&character)
}

fn is_latin_extended(character: char) -> bool {
    character.is_ascii_alphabetic()
        || matches!(
            character as u32,
            0x00c0..=0x00ff
                | 0x0100..=0x017f
                | 0x0180..=0x024f
                | 0x0250..=0x02af
                | 0x1d00..=0x1d7f
                | 0x1d80..=0x1dbf
                | 0x1e00..=0x1eff
                | 0x2c60..=0x2c7f
                | 0xa720..=0xa7ff
                | 0xab30..=0xab6f
        )
}

fn is_japanese_punctuation(character: char) -> bool {
    character == '\u{30fc}'
        || matches!(
            character as u32,
            0x3001
                | 0x3002
                | 0x300c
                | 0x300d
                | 0x300e
                | 0x300f
                | 0x3010
                | 0x3011
                | 0xff08
                | 0xff09
                | 0x3008
                | 0x3009
                | 0x300a
                | 0x300b
                | 0x3014
                | 0x3015
                | 0xff01
                | 0xff1f
                | 0xff0c
                | 0xff0e
                | 0x30fb
                | 0x2026
                | 0x301c
                | 0xff5e
        )
        || matches!(
            character,
            '!' | '?' | '\'' | '"' | '(' | ')' | '[' | ']' | '{' | '}' | '-'
        )
}

fn join_selected_blocks_with_source_separators(
    source_text: &str,
    blocks: &[String],
    selected_indexes: &[usize],
    fallback_separator: &str,
) -> String {
    if selected_indexes.is_empty() {
        return String::new();
    }

    let normalized_blocks = blocks
        .iter()
        .map(|block| normalize_source_text(block))
        .collect::<Vec<_>>();
    let mut spans = Vec::with_capacity(normalized_blocks.len());
    let mut cursor = 0;

    for block in &normalized_blocks {
        let Some(relative_index) = source_text[cursor..].find(block) else {
            return selected_indexes
                .iter()
                .filter_map(|index| normalized_blocks.get(*index))
                .map(|block| block.trim())
                .collect::<Vec<_>>()
                .join(fallback_separator);
        };
        let start = cursor + relative_index;
        let end = start + block.len();
        spans.push((start, end));
        cursor = end;
    }

    let mut result = String::new();
    let mut previous_selected: Option<usize> = None;
    for &selected in selected_indexes {
        let Some(block) = normalized_blocks.get(selected) else {
            continue;
        };
        let block = block.trim();
        if block.is_empty() {
            continue;
        }

        if let Some(previous) = previous_selected {
            if selected == previous + 1 {
                result.push_str(&source_text[spans[previous].1..spans[selected].0]);
            } else {
                result.push_str(fallback_separator);
            }
        }
        result.push_str(block);
        previous_selected = Some(selected);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn japanese_filter_preserves_punctuation_but_not_comparison_punctuation() {
        let output = filter_text(
            "「返しなさいよーーーっ！！」",
            &["「返しなさいよーーーっ！！」".to_owned()],
            "ja",
            &[],
            &[],
        );
        assert_eq!(output.text, "「返しなさいよーーーっ！！」");
        assert_eq!(
            output.compare_blocks,
            vec![Some("返しなさいよっ".to_owned())]
        );
    }

    #[test]
    fn only_a_duplicate_prefix_is_removed() {
        let output = filter_text(
            "新しい|以前の",
            &["新しい".to_owned(), "以前の".to_owned()],
            "ja",
            &["以前の".to_owned()],
            &[],
        );
        assert_eq!(output.text, "新しい|以前の");
    }

    #[test]
    fn common_kanji_range_includes_ideographic_one() {
        let output = filter_text("一日", &["一日".to_owned()], "ja", &[], &[]);
        assert_eq!(output.text, "一日");
        assert_eq!(output.compare_blocks, vec![Some("一日".to_owned())]);
    }
}
