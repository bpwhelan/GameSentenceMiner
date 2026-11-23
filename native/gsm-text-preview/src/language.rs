//! Script-based filtering, matching the preview in util/language_filter.py.
use super::lines;
use regex_syntax::hir::{Class, ClassUnicode, HirKind};
use std::sync::LazyLock;

/// A single Unicode character class needs only its sorted disjoint ranges.
pub(super) struct Characters(ClassUnicode);

impl Characters {
    pub(super) fn new(pattern: &str) -> Self {
        let hir = regex_syntax::Parser::new()
            .parse(pattern)
            .expect("valid built-in Unicode class");
        match hir.into_kind() {
            HirKind::Class(Class::Unicode(class)) => Self(class),
            _ => unreachable!("expected a nonempty Unicode character class"),
        }
    }

    pub(super) fn contains(&self, ch: char) -> bool {
        let ranges = self.0.ranges();
        ranges
            .get(ranges.partition_point(|r| r.end() < ch))
            .is_some_and(|r| r.start() <= ch)
    }
}

pub(super) struct Target {
    code: String,
    characters: std::cell::OnceCell<Option<Characters>>,
}

impl Target {
    pub(super) fn code(&self) -> &str {
        &self.code
    }
    pub(super) fn new(code: &str) -> Self {
        Self {
            code: code.into(),
            characters: Default::default(),
        }
    }

    pub(super) fn filter(&self, mut text: String, mode: &str) -> String {
        if !matches!(mode, "blocks" | "trim" | "strict") {
            return text;
        }
        let Some(target) = self.characters.get_or_init(|| compile(&self.code)) else {
            return text;
        };
        if mode == "strict" {
            text.retain(|c| target.contains(c));
            return text;
        }

        let trim = mode == "trim";
        let keep_fullwidth = trim && language_code(&self.code).eq_ignore_ascii_case("ja");
        let mut output = String::with_capacity(text.len());
        let mut previous_ending = "";
        for (line, ending) in lines(&text) {
            let mut matches = line.char_indices().filter(|&(_, c)| target.contains(c));
            let Some(first) = matches.next() else {
                continue;
            };
            let block = if trim {
                let (last, ch) = matches.next_back().unwrap_or(first);
                let end = last + ch.len_utf8();
                let before = line[..first.0]
                    .trim_end_matches(|ch| keep_at_trim_edge(ch, true, keep_fullwidth));
                let after = line[end..]
                    .trim_start_matches(|ch| keep_at_trim_edge(ch, false, keep_fullwidth));
                &line[before.len()..line.len() - after.len()]
            } else {
                line
            };
            output.push_str(previous_ending);
            output.push_str(block);
            previous_ending = ending;
        }
        output
    }
}

fn language_code(language: &str) -> &str {
    language
        .trim_matches(|ch: char| ch.is_whitespace() || matches!(ch, '\x1c'..='\x1f'))
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
}

fn compile(language: &str) -> Option<Characters> {
    let language = language_code(language).to_lowercase();
    let scripts: String = scripts_for(&language)?
        .split_whitespace()
        .map(|s| format!(r"\p{{scx={s}}}"))
        .collect();
    Some(Characters::new(&format!(
        r"[[{scripts}]&&[\p{{L}}\p{{M}}]]"
    )))
}

fn keep_at_trim_edge(ch: char, leading: bool, keep_fullwidth: bool) -> bool {
    // Japanese dialogue can contain full-width names and numbers at either edge.
    if keep_fullwidth && matches!(ch, 'Ａ'..='Ｚ' | 'ａ'..='ｚ' | '０'..='９') {
        return true;
    }
    static OPEN: LazyLock<Characters> = LazyLock::new(|| Characters::new(r"[\p{Ps}\p{Pi}]"));
    static CLOSE: LazyLock<Characters> =
        LazyLock::new(|| Characters::new(r"[\p{Pe}\p{Pf}\p{Po}\p{Pd}]"));
    let category = if leading { &OPEN } else { &CLOSE };
    "\"'…‥―—～〜!?！？".contains(ch) || category.contains(ch)
}

fn scripts_for(language: &str) -> Option<&'static str> {
    // Keep the script overrides and the remaining CommonLanguages codes in
    // sync with the Python reference. Unknown profile codes preserve the input.
    Some(match language {
        "ja" => "Hiragana Katakana Han",
        "zh" | "yue" | "gan" | "hak" | "nan" | "wuu" => "Han",
        "ko" => "Hangul",
        "ar" | "arq" | "arz" | "ary" | "apd" | "fa" | "dcc" | "ks" | "pbu" | "ps" | "skr"
        | "sd" | "azb" | "ur" | "ug" | "pnb" => "Arabic",
        "ru" | "uk" | "be" | "bg" | "mk" | "kk" => "Cyrillic",
        "sr" | "cnr" => "Cyrillic Latin",
        "mn" => "Cyrillic Mongolian",
        "el" => "Greek",
        "he" => "Hebrew",
        "th" => "Thai",
        "hi" | "bho" | "brx" | "hns" | "doi" | "bgc" | "kok" | "mag" | "mai" | "mr" | "ne" => {
            "Devanagari"
        }
        "as" | "bn" | "ctg" => "Bengali",
        "syl" => "Bengali Syloti_Nagri",
        "mni" => "Bengali Meetei_Mayek",
        "sat" => "Ol_Chiki Devanagari Bengali Oriya",
        "am" | "ti" => "Ethiopic",
        "hy" => "Armenian",
        "ka" => "Georgian",
        "gu" => "Gujarati",
        "pa" => "Gurmukhi",
        "kn" => "Kannada",
        "km" => "Khmer",
        "lo" => "Lao",
        "ml" => "Malayalam",
        "my" => "Myanmar",
        "or" => "Oriya",
        "si" => "Sinhala",
        "ta" => "Tamil",
        "te" => "Telugu",
        "bo" | "dz" => "Tibetan",
        _ if gsm_settings::gsm_config::is_learning_language(language) => "Latin",
        _ => return None,
    })
}
