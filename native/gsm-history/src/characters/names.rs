use std::sync::LazyLock;

// Ordered romanization rules from jaconv, licensed under the accompanying MIT notice.
static ROMAJI: LazyLock<Vec<(&'static str, &'static str)>> = LazyLock::new(|| {
    include_str!("romaji.tsv")
        .lines()
        .map(|line| line.split_once('\t').expect("two columns"))
        .collect()
});

pub fn hiragana(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'ァ'..='ヶ' | 'ヽ'..='ヾ' => char::from_u32(c as u32 - 0x60).unwrap(),
            _ => c,
        })
        .collect()
}
pub fn katakana(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'ぁ'..='ゖ' => char::from_u32(c as u32 + 0x60).unwrap(),
            _ => c,
        })
        .collect()
}
pub fn contains_kanji(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(c, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}'))
}

pub fn reading(original: &str, romanized: &str) -> String {
    if !contains_kanji(original) {
        return hiragana(original);
    }
    let mut text = romanized.to_lowercase();
    if text.len() > 1 && text.ends_with('h') {
        text.pop();
        text.push('う');
    }
    for &(from, to) in ROMAJI.iter() {
        if text.contains(from) {
            text = text.replace(from, to);
        }
    }
    text.chars()
        .map(|c| match c {
            'a' => 'あ',
            'i' => 'い',
            'u' => 'う',
            'e' => 'え',
            'o' => 'お',
            'n' => 'ん',
            'l' => 'る',
            '~' => '〜',
            '-' => 'ー',
            c if "sdfghjklqwrtypzxcvbnm".contains(c) => 'っ',
            _ => c,
        })
        .collect()
}
