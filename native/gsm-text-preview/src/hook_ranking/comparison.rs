use crate::language::Characters;
use caseless::Caseless;
use indexmap::IndexMap;
use rapidfuzz::distance::levenshtein;
use std::{collections::HashMap, sync::LazyLock};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Tier {
    Unmatched,
    Close,
    Filtered,
    Fuzzy,
    Exact,
}

impl Tier {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Unmatched => "unmatched",
            Self::Close => "close",
            Self::Filtered => "filtered",
            Self::Fuzzy => "fuzzy",
            Self::Exact => "exact",
        }
    }
}

pub(super) type Score = (Tier, f64, usize);

#[derive(Clone, Copy)]
pub(super) struct Hit {
    pub score: Score,
    pub block: usize,
}

fn strict(text: &str) -> String {
    text.nfc()
        .filter(|c| !c.is_whitespace() && !matches!(c, '\x1c'..='\x1f'))
        .collect()
}

fn relaxed(text: &str) -> String {
    static SEPARATORS: LazyLock<Characters> = LazyLock::new(|| Characters::new(r"[\p{P}\s]"));
    let folded: String = text
        .chars()
        .map(|c| match c {
            '〜' => '~',
            '⋯' => '…',
            other => other,
        })
        .nfkc()
        .default_case_fold()
        .collect();
    folded
        .trim_matches(|c| c == '~' || SEPARATORS.contains(c))
        .chars()
        .filter(|&c| !SEPARATORS.contains(c))
        .collect()
}

fn forms(text: &str) -> impl Iterator<Item = String> + '_ {
    let dialogue = text
        .strip_prefix('【')
        .and_then(|s| s.split_once('】'))
        .and_then(|(name, rest)| {
            ((1..=24).contains(&name.chars().count()) && rest.starts_with(['「', '『', '“', '"']))
                .then_some(rest)
        });
    std::iter::once(text).chain(dialogue).map(relaxed)
}

pub(super) struct Blocks {
    strict: HashMap<String, usize>,
    relaxed: HashMap<String, usize>,
    // Stable longest-first order resolves equal edit-distance scores.
    choices: Vec<(Vec<char>, usize)>,
    cache: HashMap<String, Option<Hit>>,
    cached_bytes: usize,
}

impl Blocks {
    pub fn new(blocks: &[String], batch: &super::Batch) -> Result<Self, String> {
        let mut strict_blocks = HashMap::new();
        let mut relaxed_blocks = IndexMap::new();
        for (index, block) in blocks.iter().enumerate() {
            batch.check()?;
            let key = strict(block);
            if !key.is_empty() {
                for form in forms(&key).filter(|s| !s.is_empty()) {
                    relaxed_blocks.entry(form).or_insert(index);
                }
                strict_blocks.entry(key).or_insert(index);
            }
        }
        let mut choices: Vec<_> = relaxed_blocks
            .iter()
            .filter_map(|(text, &index)| {
                let chars: Vec<_> = text.chars().collect();
                (chars.len() >= 4).then_some((chars, index))
            })
            .collect();
        choices.sort_by_key(|(chars, _)| std::cmp::Reverse(chars.len()));
        Ok(Self {
            strict: strict_blocks,
            relaxed: relaxed_blocks.into_iter().collect(),
            choices,
            cache: HashMap::new(),
            cached_bytes: 0,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.strict.is_empty()
    }

    pub fn closest(&mut self, text: &str, batch: &super::Batch) -> Result<Option<Hit>, String> {
        batch.check()?;
        if let Some(hit) = self.cache.get(text) {
            return Ok(*hit);
        }
        let strict = strict(text);
        let hit = if let Some(&block) = self.strict.get(&strict) {
            Some(Hit {
                score: (Tier::Exact, 1.0, relaxed(&strict).chars().count()),
                block,
            })
        } else {
            let mut best = None;
            for form in forms(&strict) {
                if let Some(hit) = self.closest_form(&form, batch)? {
                    if best.is_none_or(|prev: Hit| hit.score > prev.score) {
                        best = Some(hit);
                    }
                }
            }
            best
        };
        if self.cache.len() < 4096 && self.cached_bytes + text.len() <= 2 * 1024 * 1024 {
            self.cache.insert(text.into(), hit);
            self.cached_bytes += text.len();
        }
        Ok(hit)
    }

    fn closest_form(&self, form: &str, batch: &super::Batch) -> Result<Option<Hit>, String> {
        let length = form.chars().count();
        if let Some(&block) = self.relaxed.get(form) {
            return Ok(Some(Hit {
                score: (Tier::Fuzzy, 1.0, length),
                block,
            }));
        }
        // Even perfect overlap cannot reach 55% if the longer form is too long.
        // In particular, avoid building a distance table for an expanded replacement.
        if length < 4
            || self
                .choices
                .first()
                .is_none_or(|(chars, _)| chars.len() * 20 < length * 11)
        {
            return Ok(None);
        }
        let scorer = levenshtein::BatchComparator::new(form.chars());
        let mut best = None;
        let mut cutoff = 0.55;
        for (index, (choice, block)) in self.choices.iter().enumerate() {
            if index % 16 == 0 {
                batch.check()?;
            }
            if choice.len() * 20 < length * 11 {
                break;
            }
            if length * 20 < choice.len() * 11 {
                continue;
            }
            // Python RapidFuzz applies its cutoff to normalized distance before
            // subtracting from one. At 9 edits in 20 this affects the 0.55 edge.
            let longest = length.max(choice.len()) as f64;
            let max_distance = 1.0 - cutoff;
            let args =
                levenshtein::Args::default().score_cutoff((max_distance * longest).ceil() as usize);
            if let Some(edits) = scorer.distance_with_args(choice.iter().copied(), &args) {
                let distance = edits as f64 / longest;
                if distance > max_distance {
                    continue;
                }
                let similarity = 1.0 - distance;
                if best.is_none() || similarity > cutoff {
                    let tier = if similarity >= 0.86 {
                        Tier::Fuzzy
                    } else {
                        Tier::Close
                    };
                    best = Some(Hit {
                        score: (tier, similarity, length.min(choice.len())),
                        block: *block,
                    });
                    cutoff = similarity;
                }
            }
        }
        Ok(best)
    }
}
