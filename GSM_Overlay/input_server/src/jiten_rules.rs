// Modified Rust port of Jiten's declarative token rewrite engine.
// Original: Sirush and Jiten contributors, Apache-2.0.
// See ../../third_party/jiten-parser/{README.md,LICENSE,manifest.json}.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pin {
    pub word_id: i64,
    pub reading_index: Option<u8>,
}

#[derive(Clone, Debug)]
pub struct Token {
    pub surface: String,
    pub headword: String,
    pub normalized: String,
    pub reading: String,
    pub pos: Vec<String>,
    pub start: usize,
    pub end: usize,
    pub pin: Option<Pin>,
    // A pin-only correction can reject Sudachi's original homograph (クズ/葛).
    pub lookup_lemma: bool,
    pub applied_rules: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
enum Phase {
    Early,
    Late,
    Cleanup,
    Reading,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
enum Pos {
    Unknown,
    Noun,
    Verb,
    IAdjective,
    Adverb,
    Particle,
    Conjunction,
    Auxiliary,
    Adnominal,
    Interjection,
    Symbol,
    Prefix,
    Filler,
    Name,
    Pronoun,
    NaAdjective,
    Suffix,
    CommonNoun,
    SupplementarySymbol,
    BlankSpace,
    Expression,
    NominalAdjective,
    Numeral,
    PrenounAdjectival,
    Counter,
    AdverbTo,
    NounSuffix,
}

impl Pos {
    // Same top-level Sudachi mapping as Jiten.Core/Data/PosMapper.cs.
    fn from_sudachi(pos: &str) -> Self {
        match pos {
            "名詞" => Self::Noun,
            "動詞" => Self::Verb,
            "形容詞" => Self::IAdjective,
            "副詞" => Self::Adverb,
            "助詞" => Self::Particle,
            "接続詞" => Self::Conjunction,
            "助動詞" => Self::Auxiliary,
            "感動詞" => Self::Interjection,
            "記号" => Self::Symbol,
            "接頭辞" | "接頭詞" => Self::Prefix,
            "フィラー" => Self::Filler,
            "代名詞" => Self::Pronoun,
            "形状詞" => Self::NaAdjective,
            "接尾辞" => Self::Suffix,
            "普通名詞" => Self::CommonNoun,
            "補助記号" => Self::SupplementarySymbol,
            "空白" => Self::BlankSpace,
            "表現" | "連語" => Self::Expression,
            "形動" => Self::NominalAdjective,
            "数詞" => Self::Numeral,
            "連体詞" => Self::PrenounAdjectival,
            "助数詞" => Self::Counter,
            "副詞的と" => Self::AdverbTo,
            "名詞接尾辞" => Self::NounSuffix,
            "連体形容詞" => Self::Adnominal,
            "固有名詞" => Self::Name,
            _ => Self::Unknown,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Unknown => "*",
            Self::Noun => "名詞",
            Self::Verb => "動詞",
            Self::IAdjective => "形容詞",
            Self::Adverb => "副詞",
            Self::Particle => "助詞",
            Self::Conjunction => "接続詞",
            Self::Auxiliary => "助動詞",
            Self::Adnominal => "連体形容詞",
            Self::Interjection => "感動詞",
            Self::Symbol => "記号",
            Self::Prefix => "接頭辞",
            Self::Filler => "フィラー",
            Self::Name => "固有名詞",
            Self::Pronoun => "代名詞",
            Self::NaAdjective => "形状詞",
            Self::Suffix => "接尾辞",
            Self::CommonNoun => "普通名詞",
            Self::SupplementarySymbol => "補助記号",
            Self::BlankSpace => "空白",
            Self::Expression => "表現",
            Self::NominalAdjective => "形動",
            Self::Numeral => "数詞",
            Self::PrenounAdjectival => "連体詞",
            Self::Counter => "助数詞",
            Self::AdverbTo => "副詞的と",
            Self::NounSuffix => "名詞接尾辞",
        }
    }
}

impl Token {
    fn part_of_speech(&self) -> Pos {
        Pos::from_sudachi(self.pos.first().map(String::as_str).unwrap_or("*"))
    }

    pub fn is_boundary(&self) -> bool {
        self.surface.trim().is_empty()
            || matches!(
                self.part_of_speech(),
                Pos::Symbol | Pos::SupplementarySymbol | Pos::BlankSpace
            )
    }
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pattern {
    text: Option<String>,
    text_any_of: Option<Vec<String>>,
    text_starts_with: Option<String>,
    text_ends_with: Option<String>,
    pos: Option<Vec<Pos>>,
    dict_form_any_of: Option<Vec<String>>,
    normalized_form_any_of: Option<Vec<String>>,
    reading_prefix: Option<String>,
    not_reading_prefix: Option<String>,
    #[serde(default = "default_true")]
    require_unpinned: bool,
}

#[derive(Deserialize)]
enum PosSection {
    None,
    SentenceEndingParticle,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Template {
    text: String,
    dict_form: Option<String>,
    normalized_form: Option<String>,
    pos: Option<Pos>,
    pos_section: Option<PosSection>,
    reading: Option<String>,
    pin: Option<i64>,
    pin_reading_index: Option<u8>,
    // Preserved in the import. GSM has no later compound lookup or conjugation
    // explanation stage to consume these flags (see the scope in the README).
    #[serde(default, rename = "hardPin")]
    _hard_pin: bool,
    #[serde(default, rename = "recoverConjugations")]
    _recover_conjugations: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Context {
    text_any_of: Option<Vec<String>>,
    text_ends_with_any_of: Option<Vec<String>>,
    text_starts_with_any_of: Option<Vec<String>>,
    pos_any_of: Option<Vec<Pos>>,
    #[serde(default)]
    clause_boundary: bool,
    #[serde(default)]
    negate: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Window {
    from: i32,
    to: i32,
    text_any_of: Option<Vec<String>>,
    pos_any_of: Option<Vec<Pos>>,
    #[serde(default)]
    negate: bool,
}

#[derive(Deserialize)]
enum GuardKind {
    CompoundExists,
    NonNameCompoundExists,
    CompoundAbsent,
    FrequencyRankUnder,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Guard {
    #[serde(rename = "kind")]
    _kind: GuardKind,
    #[serde(rename = "pattern")]
    _pattern: String,
    #[serde(rename = "rank")]
    _rank: Option<i32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rule {
    id: String,
    phase: Phase,
    #[serde(rename = "match")]
    patterns: Vec<Pattern>,
    replace: Vec<Template>,
    prev: Option<Context>,
    next: Option<Context>,
    window: Option<Window>,
    guard: Option<Guard>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    #[serde(rename = "notice")]
    _notice: String,
    upstream_commit: String,
    rules: Vec<Rule>,
}

#[derive(Default)]
struct Index {
    exact: HashMap<String, Vec<usize>>,
    residual: Vec<usize>,
}

struct Engine {
    bundle: Bundle,
    index: HashMap<Phase, Index>,
}

impl Engine {
    fn load(data: &str) -> Result<Self, String> {
        let bundle: Bundle =
            serde_json::from_str(data).map_err(|e| format!("Invalid embedded Jiten rules: {e}"))?;
        let mut engine = Self {
            bundle,
            index: HashMap::new(),
        };
        let mut ids = std::collections::HashSet::new();
        for (i, rule) in engine.bundle.rules.iter().enumerate() {
            if !ids.insert(&rule.id)
                || rule.patterns.is_empty()
                || rule.patterns.len() > 3
                || rule.replace.is_empty()
            {
                return Err(format!("Invalid Jiten rule {}", rule.id));
            }
            let index = engine.index.entry(rule.phase).or_default();
            let first = &rule.patterns[0];
            if let Some(text) = &first.text {
                index.exact.entry(text.clone()).or_default().push(i);
            } else if let Some(texts) = first.text_any_of.as_ref().filter(|ts| !ts.is_empty()) {
                for text in texts {
                    index.exact.entry(text.clone()).or_default().push(i);
                }
            } else {
                index.residual.push(i);
            }
        }
        Ok(engine)
    }

    fn run_phase(&self, input: Vec<Token>, text: &str, phase: Phase) -> Vec<Token> {
        let Some(index) = self.index.get(&phase) else {
            return input;
        };
        let mut output = Vec::with_capacity(input.len());
        let mut i = 0;
        while i < input.len() {
            // Upstream priority is exact-surface rules first, then residual rules,
            // each in table order. Only one rule fires at a position per phase.
            let exact = index
                .exact
                .get(&input[i].surface)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let matched = exact.iter().chain(&index.residual).find_map(|&r| {
                let rule = &self.bundle.rules[r];
                if rule.matches(&input, i) {
                    rule.build_outputs(&input[i..i + rule.patterns.len()], text)
                        .map(|out| (rule.patterns.len(), out))
                } else {
                    None
                }
            });
            if let Some((len, rewritten)) = matched {
                output.extend(rewritten);
                i += len;
            } else {
                output.push(input[i].clone());
                i += 1;
            }
        }
        output
    }
}

fn any<T: PartialEq>(list: &Option<Vec<T>>, value: &T) -> bool {
    list.as_ref().is_none_or(|values| values.contains(value))
}

impl Pattern {
    fn matches(&self, token: &Token) -> bool {
        !(self.require_unpinned && token.pin.is_some())
            && self.text.as_ref().is_none_or(|t| t == &token.surface)
            && any(&self.text_any_of, &token.surface)
            && self
                .text_starts_with
                .as_ref()
                .is_none_or(|t| token.surface.starts_with(t))
            && self
                .text_ends_with
                .as_ref()
                .is_none_or(|t| token.surface.ends_with(t))
            && any(&self.pos, &token.part_of_speech())
            && any(&self.dict_form_any_of, &token.headword)
            && any(&self.normalized_form_any_of, &token.normalized)
            && self
                .reading_prefix
                .as_ref()
                .is_none_or(|t| token.reading.starts_with(t))
            && self
                .not_reading_prefix
                .as_ref()
                .is_none_or(|t| !token.reading.starts_with(t))
    }
}

impl Context {
    fn matches(&self, token: Option<&Token>) -> bool {
        let matches =
            self.text_any_of
                .as_ref()
                .is_none_or(|ts| token.is_some_and(|t| ts.contains(&t.surface)))
                && self.text_ends_with_any_of.as_ref().is_none_or(|ts| {
                    token.is_some_and(|t| ts.iter().any(|s| t.surface.ends_with(s)))
                })
                && self.text_starts_with_any_of.as_ref().is_none_or(|ts| {
                    token.is_some_and(|t| ts.iter().any(|s| t.surface.starts_with(s)))
                })
                && self
                    .pos_any_of
                    .as_ref()
                    .is_none_or(|ps| token.is_some_and(|t| ps.contains(&t.part_of_speech())))
                && (!self.clause_boundary || token.is_none_or(Token::is_boundary));
        matches != self.negate
    }
}

impl Window {
    fn matches(&self, input: &[Token], i: usize) -> bool {
        let from = (i as i64 + self.from as i64).max(0) as usize;
        let to = (i as i64 + self.to as i64).min(input.len() as i64 - 1);
        let found = to >= from as i64
            && input[from..=to as usize].iter().any(|t| {
                any(&self.text_any_of, &t.surface) && any(&self.pos_any_of, &t.part_of_speech())
            });
        found != self.negate
    }
}

impl Rule {
    fn matches(&self, input: &[Token], i: usize) -> bool {
        let end = i + self.patterns.len();
        // Missing JMdict is unknown, including for CompoundAbsent. Never use
        // the learner's vocabulary snapshot as a substitute for a lexicon.
        if end > input.len() || self.guard.is_some() {
            return false;
        }
        let matched = &input[i..end];
        let prev = i
            .checked_sub(1)
            .and_then(|p| input.get(p))
            .filter(|t| t.end == input[i].start);
        let next = input.get(end).filter(|t| t.start == input[end - 1].end);
        self.patterns.iter().zip(matched).all(|(p, t)| p.matches(t))
            && matched.windows(2).all(|pair| pair[0].end == pair[1].start)
            && self.prev.as_ref().is_none_or(|c| c.matches(prev))
            && self.next.as_ref().is_none_or(|c| c.matches(next))
            && self.window.as_ref().is_none_or(|c| c.matches(input, i))
    }

    fn build_outputs(&self, matched: &[Token], text: &str) -> Option<Vec<Token>> {
        let mut cursor = matched.first()?.start;
        let end = matched.last()?.end;
        let mut output = Vec::with_capacity(self.replace.len());
        let mut applied: Vec<String> = Vec::new();
        for id in matched
            .iter()
            .flat_map(|t| &t.applied_rules)
            .chain(std::iter::once(&self.id))
        {
            if !applied.contains(id) {
                applied.push(id.clone());
            }
        }
        for (i, template) in self.replace.iter().enumerate() {
            let source_index = i.min(matched.len() - 1);
            let mut token = matched[source_index].clone();
            let changed = !template.text.is_empty();
            if changed {
                token.surface.clone_from(&template.text);
            }
            token.headword = template.dict_form.clone().unwrap_or_else(|| {
                if changed {
                    token.surface.clone()
                } else {
                    token.headword.clone()
                }
            });
            token.normalized = template.normalized_form.clone().unwrap_or_else(|| {
                if changed {
                    token.surface.clone()
                } else {
                    token.normalized.clone()
                }
            });
            if let Some(pos) = template.pos {
                token.pos.resize(token.pos.len().max(1), "*".into());
                token.pos[0] = pos.label().into();
            }
            if let Some(section) = &template.pos_section {
                token.pos.resize(token.pos.len().max(2), "*".into());
                token.pos[1] = match section {
                    PosSection::None => "*",
                    PosSection::SentenceEndingParticle => "終助詞",
                }
                .into();
            }
            if let Some(reading) = &template.reading {
                token.reading.clone_from(reading);
            }
            token.pin = template.pin.map(|word_id| Pin {
                word_id,
                reading_index: template.pin_reading_index,
            });
            // A constrained dictionary form (す[する] + ん) confirms the
            // lemma even when the output only supplies an ID. Keep that lemma
            // available to Anki; unconstrained homograph pins stay conservative.
            let confirms_lemma = self.patterns[source_index].dict_form_any_of.is_some();
            token.lookup_lemma = template.dict_form.is_some()
                || template.normalized_form.is_some()
                || if template.pin.is_some() {
                    confirms_lemma
                } else {
                    changed || token.lookup_lemma
                };
            token.start = cursor;
            cursor += token.surface.len();
            token.end = cursor;
            // Stronger than upstream's debug assertion: never change, skip, or
            // absorb raw characters, even with normalization or unusual Unicode.
            if cursor > end || text.get(token.start..token.end) != Some(token.surface.as_str()) {
                return None;
            }
            token.applied_rules.clone_from(&applied);
            output.push(token);
        }
        (cursor == end).then_some(output)
    }
}

fn engine() -> Result<&'static Engine, String> {
    static ENGINE: OnceLock<Result<Engine, String>> = OnceLock::new();
    ENGINE
        .get_or_init(|| {
            Engine::load(include_str!(
                "../../third_party/jiten-parser/token-rewrite-rules.json"
            ))
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub fn metadata() -> Result<Value, String> {
    let engine = engine()?;
    let guarded: Vec<_> = engine
        .bundle
        .rules
        .iter()
        .filter(|r| r.guard.is_some())
        .map(|r| &r.id)
        .collect();
    Ok(
        json!({ "name": "jiten-token-rewrites", "upstreamCommit": engine.bundle.upstream_commit,
        "importedRules": engine.bundle.rules.len(), "enabledRules": engine.bundle.rules.len() - guarded.len(),
        "unavailableDictionaryRules": guarded }),
    )
}

pub fn apply(mut tokens: Vec<Token>, text: &str) -> Result<Vec<Token>, String> {
    let engine = engine()?;
    for phase in [Phase::Early, Phase::Late, Phase::Cleanup, Phase::Reading] {
        tokens = engine.run_phase(tokens, text, phase);
    }
    Ok(tokens)
}

#[cfg(test)]
#[path = "jiten_rules_tests.rs"]
mod tests;
