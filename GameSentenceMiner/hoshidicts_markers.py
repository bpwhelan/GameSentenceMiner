from __future__ import annotations

import re

FIELD_KEYS = (
    "expression",
    "reading",
    "definition",
    "sentence",
    "frequency",
    "pitch",
    "audio",
)
FIELD_OVERWRITE_MODES = (
    "coalesce",
    "coalesce-new",
    "skip",
    "append",
    "prepend",
    "overwrite",
)

MARKER_PATTERN = re.compile(r"\{([^{}]+)\}")
BREAK_PATTERN = re.compile(r"<br\s*/?>", re.IGNORECASE)
PITCH_POSITION_MARKER = "{pitch-position}"

# The single Hoshidicts marker registry: every supported Yomitan marker maps to
# the semantic key that owns its rendered value. Markers keyed "unsupported"
# render as empty text; markers keyed by their own id render their own value.
MARKERS = {
    "expression": "expression",
    "reading": "reading",
    "furigana": "furigana",
    "furigana-plain": "furigana-plain",
    "definition": "definition",
    "main-definition": "definition",
    "glossary": "definition",
    "glossary-brief": "definition",
    "glossary-no-dictionary": "definition",
    "glossary-plain": "definition",
    "glossary-plain-no-dictionary": "definition",
    "glossary-first": "definition",
    "glossary-first-brief": "definition",
    "glossary-first-no-dictionary": "definition",
    "jpmn-primary-definition": "definition",
    "sentence": "sentence",
    "sentence-furigana": "sentence-furigana",
    "sentence-furigana-plain": "sentence-furigana",
    "cloze-prefix": "sentence",
    "cloze-body": "sentence",
    "cloze-suffix": "sentence",
    "frequency": "frequency",
    "frequencies": "frequency",
    "frequency-harmonic-rank": "frequency-harmonic-rank",
    "frequency-harmonic-occurrence": "frequency-harmonic-occurrence",
    "frequency-average-rank": "frequency-average-rank",
    "frequency-average-occurrence": "frequency-average-occurrence",
    "pitch": "pitch",
    "pitch-accent": "pitch",
    "pitch-accents": "pitch",
    "pitch-accent-graphs": "pitch",
    "pitch-accent-graphs-jj": "pitch",
    "pitch-accent-categories": "pitch-categories",
    "pitch-position": "pitch-position",
    "pitch-accent-positions": "pitch-position",
    "audio": "audio",
    "dictionary": "dictionary",
    "dictionary-alias": "dictionary-alias",
    "conjugation": "conjugation",
    "document-title": "document-title",
    "part-of-speech": "part-of-speech",
    "phonetic-transcriptions": "phonetic-transcriptions",
    "popup-selection-text": "popup-selection-text",
    "search-query": "search-query",
    "tags": "tags",
    "character": "unsupported",
    "clipboard-image": "unsupported",
    "clipboard-text": "unsupported",
    "cloze-body-kana": "unsupported",
    "kunyomi": "unsupported",
    "onyomi": "unsupported",
    "onyomi-hiragana": "unsupported",
    "screenshot": "unsupported",
    "stroke-count": "unsupported",
    "url": "unsupported",
}
# Yomitan registers these per installed dictionary, so they cannot be enumerated.
DYNAMIC_MARKER_KEYS = {
    "single-glossary-": "definition",
    "single-frequency-": "frequency",
}
# Markers whose value fills a different mining field than the key they render.
_SEMANTIC_KEYS = {
    "furigana": "expression",
    "furigana-plain": "reading",
    "sentence-furigana": "sentence",
    "pitch-position": "pitch",
}


def marker_key(marker: str) -> str | None:
    """Semantic key owning a marker's value, or None when it is not a marker."""
    marker = marker.casefold()
    key = MARKERS.get(marker)
    if key is not None:
        return key
    return next(
        (
            dynamic_key
            for prefix, dynamic_key in DYNAMIC_MARKER_KEYS.items()
            if marker.startswith(prefix) and len(marker) > len(prefix)
        ),
        None,
    )


def marker_semantic(marker: str) -> str | None:
    """Mining field a marker fills, or None when it fills none of them."""
    key = marker_key(marker)
    if key in _SEMANTIC_KEYS:
        return _SEMANTIC_KEYS[key]
    return key if key in FIELD_KEYS else None


def marker_value(marker: str, values: dict[str, str]) -> str | None:
    """Rendered text for a marker, or None when it is an unknown brace literal."""
    folded = marker.casefold()
    for token in (f"{{{marker}}}", f"{{{folded}}}"):
        if token in values:
            return values[token]
    key = marker_key(folded)
    if key is None:
        return None
    if any(folded.startswith(prefix) for prefix in DYNAMIC_MARKER_KEYS):
        # A dictionary-specific marker with no matching dictionary renders empty.
        return ""
    return values.get(f"{{{key}}}", "")


def render_template(template: str, values: dict[str, str]) -> str:
    def replacement(match: re.Match[str]) -> str:
        value = marker_value(match.group(1), values)
        return match.group(0) if value is None else value

    rendered_segments = []
    for segment in BREAK_PATTERN.split(template):
        has_known_marker = any(
            marker_value(match.group(1), values) is not None for match in MARKER_PATTERN.finditer(segment)
        )
        rendered = MARKER_PATTERN.sub(replacement, segment)
        if has_known_marker and not rendered.strip():
            continue
        rendered_segments.append(rendered)
    return "<br>".join(rendered_segments)


def templates_use_marker_keys(
    field_templates: dict[str, dict[str, str]],
    marker_keys: set[str],
) -> bool:
    return any(
        marker_key(match.group(1)) in marker_keys
        for template in field_templates.values()
        for match in MARKER_PATTERN.finditer(template["value"])
    )


def template_uses_audio(template: str) -> bool:
    return any(marker_key(match.group(1)) == "audio" for match in MARKER_PATTERN.finditer(template))


def template_has_non_audio_content(template: str) -> bool:
    without_audio = MARKER_PATTERN.sub(
        lambda match: "" if marker_key(match.group(1)) in {"audio", "unsupported"} else match.group(0),
        template,
    )
    return bool(BREAK_PATTERN.sub("", without_audio).strip())


def semantic_field_targets(field_templates: dict[str, dict[str, str]]) -> dict[str, str]:
    targets = {key: "" for key in FIELD_KEYS}
    priorities = {key: -1 for key in FIELD_KEYS}
    for target, template in field_templates.items():
        for match in MARKER_PATTERN.finditer(template["value"]):
            marker = match.group(1).casefold()
            key = marker_semantic(marker)
            if key is None:
                continue
            # A marker naming its field outright beats an alias of the same field.
            priority = 2 if marker in FIELD_KEYS or marker == "glossary" else 1
            if priority > priorities[key]:
                targets[key] = target
                priorities[key] = priority
    return targets


def overwrite_field(existing_value: str, new_value: str, mode: str) -> str:
    if mode == "overwrite":
        return new_value
    if mode == "skip":
        return existing_value
    if mode == "append":
        return existing_value + new_value
    if mode == "prepend":
        return new_value + existing_value
    if mode == "coalesce-new":
        return new_value or existing_value
    return existing_value or new_value


def overwrite_modes(field_templates: dict[str, dict[str, str]]) -> dict[str, str]:
    """Overwrite mode per target field, excluding audio-only fields."""
    return {
        target: template["overwriteMode"]
        for target, template in field_templates.items()
        if not template_uses_audio(template["value"]) or template_has_non_audio_content(template["value"])
    }


def overwritten_note_fields(
    note: dict[str, dict[str, str]],
    existing_fields: dict[str, str],
    field_templates: dict[str, dict[str, str]],
) -> dict[str, str]:
    return {
        field: overwrite_field(existing_fields.get(field, ""), note["fields"].get(field, ""), mode)
        for field, mode in overwrite_modes(field_templates).items()
    }
