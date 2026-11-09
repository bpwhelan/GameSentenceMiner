"""Script-based filtering for captured text, without loading OCR engines or models."""

import unicodedata
from functools import lru_cache

import regex

from GameSentenceMiner.util.config.configuration import CommonLanguages

# Like OCR, matching identifies a writing system, not the language of a sentence.
# The remaining configured languages use Latin; unknown codes are left untouched.
_SCRIPT_GROUPS = {
    "Hiragana Katakana Han": "ja",
    "Han": "zh yue gan hak nan wuu",
    "Hangul": "ko",
    "Arabic": "ar arq arz ary apd fa dcc ks pbu ps skr sd azb ur ug pnb",
    "Cyrillic": "ru uk be bg mk kk",
    "Cyrillic Latin": "sr cnr",
    "Cyrillic Mongolian": "mn",
    "Greek": "el",
    "Hebrew": "he",
    "Thai": "th",
    "Devanagari": "hi bho brx hns doi bgc kok mag mai mr ne",
    "Bengali": "as bn ctg",
    "Bengali Syloti_Nagri": "syl",
    "Bengali Meetei_Mayek": "mni",
    "Ol_Chiki Devanagari Bengali Oriya": "sat",
    "Ethiopic": "am ti",
    "Armenian": "hy",
    "Georgian": "ka",
    "Gujarati": "gu",
    "Gurmukhi": "pa",
    "Kannada": "kn",
    "Khmer": "km",
    "Lao": "lo",
    "Malayalam": "ml",
    "Myanmar": "my",
    "Oriya": "or",
    "Sinhala": "si",
    "Tamil": "ta",
    "Telugu": "te",
    "Tibetan": "bo dz",
}
_LANGUAGE_SCRIPTS = {
    language: scripts for scripts, languages in _SCRIPT_GROUPS.items() for language in languages.split()
}
_KNOWN_LANGUAGES = frozenset(CommonLanguages.get_all_codes())
_LINE_ENDINGS = "\r\n\v\f\x1c\x1d\x1e\x85\u2028\u2029"


@lru_cache(maxsize=256)
def _target_characters(language: str):
    language = language.strip().lower().replace("_", "-").split("-")[0]
    scripts = _LANGUAGE_SCRIPTS.get(language)
    if scripts is None:
        if language not in _KNOWN_LANGUAGES:
            return None
        scripts = "Latin"
    script_pattern = "".join(r"\p{scx=" + script + "}" for script in scripts.split())
    # Script extensions cover long vowels, halfwidth kana and decomposed accents.
    # Restrict to letters/marks so punctuation alone does not count as target text.
    return regex.compile(r"[[" + script_pattern + r"]&&[\p{L}\p{M}]]", regex.VERSION1)


def _is_dialogue_punctuation(char: str, *, leading: bool = False) -> bool:
    categories = ("Ps", "Pi") if leading else ("Pe", "Pf", "Po", "Pd")
    return unicodedata.category(char) in categories or char in "\"'…‥―—～〜!?！？"


def filter_target_language(text: str, language: str, mode: str = "blocks") -> str:
    """Filter newline-delimited blocks, their edges, or every nonmatching character."""
    if not text or mode not in ("blocks", "trim", "strict"):
        return text
    pattern = _target_characters(language)
    if pattern is None:
        return text
    if mode == "strict":
        return "".join(pattern.findall(text))

    kept = []
    for line in text.splitlines(keepends=True):
        block = line.rstrip(_LINE_ENDINGS)
        first = pattern.search(block)
        if first is None:
            continue
        ending = line[len(block) :]
        if mode == "trim":
            start = first.start()
            end = first.end()
            for match in pattern.finditer(block, pos=end):
                end = match.end()
            # Keep quotes and sentence punctuation immediately beside target text.
            while start > 0 and _is_dialogue_punctuation(block[start - 1], leading=True):
                start -= 1
            while end < len(block) and _is_dialogue_punctuation(block[end]):
                end += 1
            block = block[start:end]
        kept.append((block, ending))
    if not kept:
        return ""
    # Remove discarded blocks with their separators; do not leave trailing blank rows.
    return "".join(block + ending for block, ending in kept[:-1]) + kept[-1][0]
