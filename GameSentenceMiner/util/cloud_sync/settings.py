"""Explicit, opt-in preferences for the default profile; never whole config files."""

import copy
import dataclasses
import json
from functools import lru_cache

LANGUAGE_FIELDS = ("native_language", "target_language")
ANKI_FIELDS = (
    "sentence",
    "sentence_audio",
    "picture",
    "word",
    "previous_sentence",
    "previous_image",
    "video",
    "sentence_furigana",
    "game_name",
)
TEXT_FIELDS = (
    "string_replacement",
    "processor_order",
    "remove_repeated_chars",
    "remove_repeated_chars_config",
    "remove_repeated_lines",
    "remove_repeated_lines_config",
    "remove_control_chars",
    "remove_non_japanese",
    "remove_newlines",
    "remove_numbers",
    "remove_english",
    "remove_curly_braces",
    "remove_angle_brackets",
    "extract_bracketed_text",
    "extract_lines",
    "extract_lines_config",
    "unicode_normalize",
    "unicode_normalize_config",
)
GROUPS = {
    "language": tuple(f"general.{name}" for name in LANGUAGE_FIELDS),
    "anki": tuple(f"anki.{name}" for name in ANKI_FIELDS),
    "text_processing": tuple(f"text_processing.{name}" for name in TEXT_FIELDS),
}


def _plain(value):
    return dataclasses.asdict(value) if dataclasses.is_dataclass(value) else copy.deepcopy(value)


def export_portable_settings(profile, groups):
    result = {}
    for group in groups:
        if group not in GROUPS:
            raise ValueError(f"Unknown settings sync group: {group}")
        for key in GROUPS[group]:
            section, name = key.split(".")
            value = _plain(getattr(getattr(profile, section), name))
            if section == "anki":
                value = {field: value[field] for field in ("name", "enabled", "overwrite", "append")}
            result[key] = value
    return result


def _validate_shape(value, template):
    if isinstance(template, dict):
        if not isinstance(value, dict) or set(value) != set(template):
            raise ValueError("Invalid synced settings fields.")
        for key in template:
            _validate_shape(value[key], template[key])
    elif isinstance(template, list):
        if not isinstance(value, list) or len(value) > 1000:
            raise ValueError("Invalid synced settings list.")
        for item in value:
            _validate_shape(item, template[0] if template else "")
    elif type(value) is not type(template):
        raise ValueError("Invalid synced setting type.")
    elif isinstance(value, str) and len(value) > 20_000:
        raise ValueError("Synced setting is too long.")


@lru_cache(maxsize=1)
def _templates():
    from GameSentenceMiner.util.config.configuration import ProfileConfig

    templates = export_portable_settings(ProfileConfig(), GROUPS)
    templates["text_processing.string_replacement"]["rules"] = [
        {"enabled": True, "mode": "plain", "find": "", "replace": "", "case_sensitive": False, "whole_word": False}
    ]
    return templates


def validate_setting(key, value):
    templates = _templates()
    if key not in templates:
        raise ValueError(f"Setting is not portable: {key}")
    template = templates[key]
    _validate_shape(value, template)
    if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > 100_000:
        raise ValueError("Synced setting exceeds the size limit.")
    if key.endswith("unicode_normalize_config") and value["form"] not in {"NFC", "NFD", "NFKC", "NFKD"}:
        raise ValueError("Invalid Unicode normalization form.")
    if key.startswith("anki."):
        if key in {"anki.sentence", "anki.sentence_audio", "anki.picture", "anki.word"} and not value["enabled"]:
            raise ValueError("Core Anki fields must remain enabled.")
        if value["overwrite"] and value["append"]:
            raise ValueError("Anki fields cannot overwrite and append at the same time.")


def apply_portable_settings(profile, values, groups):
    allowed = {key for group in groups for key in GROUPS.get(group, ())}
    for key, value in values.items():
        if key not in allowed:
            raise ValueError(f"Setting is not enabled for sync: {key}")
        validate_setting(key, value)
    updated = copy.deepcopy(profile)
    for key, value in values.items():
        section, name = key.split(".")
        owner = getattr(updated, section)
        existing = getattr(owner, name)
        if dataclasses.is_dataclass(existing):
            merged = dataclasses.asdict(existing)
            merged.update(copy.deepcopy(value))
            value = type(existing).from_dict(merged)
        setattr(owner, name, copy.deepcopy(value))
    if any(key.startswith("anki.") for key in values):
        updated.anki.__post_init__()
    for section in {key.split(".")[0] for key in values}:
        setattr(profile, section, getattr(updated, section))


def preserve_synced_settings(baseline, edited, latest, groups):
    """Merge a background sync into an open editor without losing local edits."""
    before = export_portable_settings(baseline, groups)
    current = export_portable_settings(edited, groups)
    incoming = export_portable_settings(latest, groups)
    updates = {key: value for key, value in incoming.items() if current[key] == before[key] and value != current[key]}
    apply_portable_settings(edited, updates, groups)
