from __future__ import annotations

import base64
import hashlib
import html
import json
import re
import threading
import time
import unicodedata
from copy import deepcopy
from pathlib import Path
from typing import Any

from GameSentenceMiner import hoshidicts_audio as _audio
from GameSentenceMiner import hoshidicts_mining_note as _note
from GameSentenceMiner.util.config.configuration import get_app_directory, get_config

HOSHIDICTS_MINING_PROFILE_FILE = "mining-profile.json"
HOSHIDICTS_MINING_PROFILE_VERSION = 3
LEGACY_HOSHIDICTS_MINING_PROFILE_VERSIONS = (1, 2)
MAX_PROFILE_BYTES = 64 * 1024
MAX_ANKI_OPTION_NAMES = 4096
MAX_DUPLICATE_CHECK_NOTES = 16
ANKI_CONNECT_TIMEOUT_SECONDS = 1.25
MINING_STATUS_CACHE_SECONDS = 2.0
MINING_STATUS_WAIT_SECONDS = (ANKI_CONNECT_TIMEOUT_SECONDS * 2) + 0.5

# Keep the original module surface stable while the pure request and rendering
# pipeline lives in a focused, dependency-free module.
HoshidictsMiningError = _note.HoshidictsMiningError
MAX_REQUEST_BYTES = _note.MAX_REQUEST_BYTES
MAX_DUPLICATE_CHECK_REQUEST_BYTES = MAX_REQUEST_BYTES
MAX_TEXT_LENGTH = _note.MAX_TEXT_LENGTH
MAX_TERM_LENGTH = _note.MAX_TERM_LENGTH
MAX_GLOSSARIES = _note.MAX_GLOSSARIES
MAX_METADATA_GROUPS = _note.MAX_METADATA_GROUPS
MAX_METADATA_VALUES = _note.MAX_METADATA_VALUES
MAX_DICTIONARY_STYLES = _note.MAX_DICTIONARY_STYLES
MAX_DICTIONARY_STYLE_BYTES = _note.MAX_DICTIONARY_STYLE_BYTES
IGNORED_STRUCTURED_TAGS = _note.IGNORED_STRUCTURED_TAGS
BLOCK_STRUCTURED_TAGS = _note.BLOCK_STRUCTURED_TAGS
_bounded_string = _note.bounded_string
_require_list = _note.require_list
_validate_glossary = _note._validate_glossary
_validate_frequency_group = _note._validate_frequency_group
_validate_pitch_group = _note._validate_pitch_group
_utf16_suffix = _note._utf16_suffix
_highlight_sentence_match = _note.highlight_sentence_match
validate_hoshidicts_mining_request = _note.validate_hoshidicts_mining_request
_append_structured_text = _note._append_structured_text
_glossary_text = _note._glossary_text
_definition_html = _note.definition_html
_main_definition_html = _note.main_definition_html
_plain_definition_html = _note.plain_definition_html
_first_dictionary = _note.first_dictionary
_frequency_html = _note.frequency_html
_pitch_html = _note.pitch_html
_pitch_positions_text = _note.pitch_positions_text

FIELD_KEYS = (
    "expression",
    "reading",
    "definition",
    "sentence",
    "frequency",
    "pitch",
    "audio",
)

FIELD_TEMPLATE_MARKERS = {
    "expression": "{expression}",
    "reading": "{reading}",
    "definition": "{definition}",
    "sentence": "{sentence}",
    "frequency": "{frequency}",
    "pitch": "{pitch}",
    "audio": "{audio}",
}
PITCH_POSITION_FIELD_TEMPLATE_MARKER = "{pitch-position}"
FIELD_TEMPLATE_MARKER_PATTERN = re.compile(r"\{([^{}]+)\}")
FIELD_TEMPLATE_BREAK_PATTERN = re.compile(r"<br\s*/?>", re.IGNORECASE)
FIELD_TEMPLATE_MARKER_KEYS = {
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
    "frequency-harmonic-rank": "frequency",
    "frequency-harmonic-occurrence": "frequency",
    "frequency-average-rank": "frequency",
    "frequency-average-occurrence": "frequency",
    "pitch": "pitch",
    "pitch-accent": "pitch",
    "pitch-accents": "pitch",
    "pitch-accent-graphs": "pitch",
    "pitch-accent-graphs-jj": "pitch",
    "pitch-accent-categories": "pitch",
    "pitch-position": "pitch-position",
    "pitch-accent-positions": "pitch-position",
    "audio": "audio",
    "dictionary": "dictionary",
    "dictionary-alias": "dictionary",
}
UNSUPPORTED_FIELD_TEMPLATE_MARKERS = {
    "character",
    "clipboard-image",
    "clipboard-text",
    "cloze-body-kana",
    "conjugation",
    "document-title",
    "kunyomi",
    "onyomi",
    "onyomi-hiragana",
    "part-of-speech",
    "phonetic-transcriptions",
    "popup-selection-text",
    "screenshot",
    "search-query",
    "stroke-count",
    "tags",
    "url",
}

DUPLICATE_SCOPES = ("collection", "deck", "deck-root")
DUPLICATE_BEHAVIORS = ("prevent", "overwrite", "new")
FIELD_OVERWRITE_MODES = (
    "coalesce",
    "coalesce-new",
    "skip",
    "append",
    "prepend",
    "overwrite",
)

OPTIONAL_FIELD_ALIASES = {
    "reading": ("Reading", "Word Reading", "WordReading", "Kana"),
    "definition": ("Definition", "Definitions", "Meaning", "Glossary"),
    "frequency": ("Frequency", "Frequencies"),
    "pitch": ("Pitch Accent", "PitchAccent", "Pitch", "Accent"),
    "audio": ("WordAudio", "PronunciationAudio", "Pronunciation", "Audio"),
}

GENERIC_FIELD_ALIASES = {
    "expression": ("Expression", "Word", "Term", "Front"),
    "reading": OPTIONAL_FIELD_ALIASES["reading"],
    "definition": OPTIONAL_FIELD_ALIASES["definition"],
    "sentence": ("Sentence", "Context", "Example Sentence"),
    "frequency": OPTIONAL_FIELD_ALIASES["frequency"],
    "pitch": OPTIONAL_FIELD_ALIASES["pitch"],
    "audio": OPTIONAL_FIELD_ALIASES["audio"],
}

KIKU_LAPIS_FIELD_MAP = {
    "expression": "Expression",
    "reading": "ExpressionReading",
    "definition": "Glossary",
    "sentence": "Sentence",
    "frequency": "Frequency",
    "pitch": "PitchPosition",
}
KIKU_RICH_FIELD_TEMPLATES = {
    "ExpressionFurigana": ("expression-furigana", "{furigana-plain}"),
    "MainDefinition": ("main-definition", "{main-definition}"),
    "Glossary": ("glossary", "{glossary}"),
    "SentenceFurigana": ("sentence-furigana", "{sentence-furigana-plain}"),
    "ExpressionAudio": ("audio", "{audio}"),
}
FIELD_TEMPLATE_SUGGESTION_SLOTS = (
    "expression",
    "expression-furigana",
    "reading",
    "main-definition",
    "glossary",
    "definition",
    "sentence",
    "sentence-furigana",
    "frequency",
    "pitch",
    "audio",
)


def default_hoshidicts_mining_profile() -> dict[str, Any]:
    return {
        "version": HOSHIDICTS_MINING_PROFILE_VERSION,
        "enabled": True,
        "deck": "Default",
        "model": "",
        "fields": {key: "" for key in FIELD_KEYS},
        "disabledFields": [],
        "fieldTemplates": None,
        "tags": ["hoshidicts"],
        "checkForDuplicates": True,
        "duplicateScope": "collection",
        "duplicateScopeCheckAllModels": False,
        "duplicateBehavior": "prevent",
        "fieldOverwriteModes": {key: "coalesce" for key in FIELD_KEYS},
    }


def get_hoshidicts_mining_profile_path() -> Path:
    return Path(get_app_directory()) / "dictionaries" / "hoshidicts" / HOSHIDICTS_MINING_PROFILE_FILE


def normalize_hoshidicts_mining_profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HoshidictsMiningError("Hoshidicts mining profile must be an object.")
    source_version = value.get("version", LEGACY_HOSHIDICTS_MINING_PROFILE_VERSIONS[0])
    if source_version not in {
        *LEGACY_HOSHIDICTS_MINING_PROFILE_VERSIONS,
        HOSHIDICTS_MINING_PROFILE_VERSION,
    }:
        raise HoshidictsMiningError("Hoshidicts mining profile version is unsupported.")

    raw_fields = value.get("fields", {})
    if not isinstance(raw_fields, dict):
        raise HoshidictsMiningError("Hoshidicts mining fields must be an object.")

    fields = {}
    for key in FIELD_KEYS:
        fields[key] = _bounded_string(
            raw_fields.get(key, ""),
            f"Hoshidicts {key} field",
            255,
        ).strip()

    raw_disabled_fields = value.get("disabledFields", [])
    if not isinstance(raw_disabled_fields, list) or len(raw_disabled_fields) > len(FIELD_KEYS):
        raise HoshidictsMiningError("Hoshidicts disabled mining fields are invalid.")
    disabled_fields = []
    for raw_field in raw_disabled_fields:
        if raw_field not in FIELD_KEYS:
            raise HoshidictsMiningError("Hoshidicts disabled mining field is invalid.")
        if raw_field not in disabled_fields:
            disabled_fields.append(raw_field)

    raw_tags = value.get("tags", ["hoshidicts"])
    if not isinstance(raw_tags, list) or len(raw_tags) > 32:
        raise HoshidictsMiningError("Hoshidicts mining tags are invalid.")
    tags = []
    seen_tags = set()
    for raw_tag in raw_tags:
        tag = _bounded_string(raw_tag, "Hoshidicts mining tag", 255).strip()
        key = tag.casefold()
        if tag and key not in seen_tags:
            seen_tags.add(key)
            tags.append(tag)

    duplicate_policy = value.get("duplicatePolicy", "prevent")
    if duplicate_policy not in {"prevent", "allow"}:
        raise HoshidictsMiningError("Hoshidicts duplicate policy is invalid.")

    check_for_duplicates = value.get("checkForDuplicates", True)
    if not isinstance(check_for_duplicates, bool):
        raise HoshidictsMiningError("Hoshidicts duplicate check setting is invalid.")
    duplicate_scope = value.get("duplicateScope", "collection")
    if duplicate_scope not in DUPLICATE_SCOPES:
        raise HoshidictsMiningError("Hoshidicts duplicate scope is invalid.")
    duplicate_scope_check_all_models = value.get("duplicateScopeCheckAllModels", False)
    if not isinstance(duplicate_scope_check_all_models, bool):
        raise HoshidictsMiningError("Hoshidicts duplicate note type setting is invalid.")
    duplicate_behavior = value.get("duplicateBehavior")
    if duplicate_behavior is None:
        duplicate_behavior = "new" if duplicate_policy == "allow" else "prevent"
    if duplicate_behavior not in DUPLICATE_BEHAVIORS:
        raise HoshidictsMiningError("Hoshidicts duplicate behavior is invalid.")
    raw_overwrite_modes = value.get("fieldOverwriteModes", {})
    if not isinstance(raw_overwrite_modes, dict):
        raise HoshidictsMiningError("Hoshidicts field overwrite modes are invalid.")
    field_overwrite_modes = {}
    for key in FIELD_KEYS:
        mode = raw_overwrite_modes.get(key, "coalesce")
        if mode not in FIELD_OVERWRITE_MODES:
            raise HoshidictsMiningError(f"Hoshidicts {key} overwrite mode is invalid.")
        field_overwrite_modes[key] = mode

    field_templates = None
    if source_version == HOSHIDICTS_MINING_PROFILE_VERSION:
        raw_field_templates = value.get("fieldTemplates")
        if raw_field_templates is not None:
            if not isinstance(raw_field_templates, dict) or len(raw_field_templates) > MAX_ANKI_OPTION_NAMES:
                raise HoshidictsMiningError("Hoshidicts field templates are invalid.")
            field_templates = {}
            for raw_field_name, raw_template in raw_field_templates.items():
                field_name = _bounded_string(
                    raw_field_name,
                    "Hoshidicts field template name",
                    255,
                    allow_empty=False,
                )
                if not isinstance(raw_template, dict):
                    raise HoshidictsMiningError(f'Hoshidicts field template "{field_name}" is invalid.')
                template_value = raw_template.get("value")
                if not isinstance(template_value, str):
                    raise HoshidictsMiningError(f'Hoshidicts field template "{field_name}" is invalid.')
                overwrite_mode = raw_template.get("overwriteMode", "coalesce")
                if overwrite_mode not in FIELD_OVERWRITE_MODES:
                    raise HoshidictsMiningError(f'Hoshidicts field template "{field_name}" overwrite mode is invalid.')
                field_templates[field_name] = {
                    "value": template_value,
                    "overwriteMode": overwrite_mode,
                }

    return {
        "version": HOSHIDICTS_MINING_PROFILE_VERSION,
        "enabled": value.get("enabled", True) is not False,
        "deck": _bounded_string(
            value.get("deck", "Default"),
            "Hoshidicts deck",
            255,
        ).strip()
        or "Default",
        "model": _bounded_string(
            value.get("model", ""),
            "Hoshidicts note type",
            255,
        ).strip(),
        "fields": fields,
        "disabledFields": disabled_fields,
        "fieldTemplates": field_templates,
        "tags": tags,
        "checkForDuplicates": check_for_duplicates,
        "duplicateScope": duplicate_scope,
        "duplicateScopeCheckAllModels": duplicate_scope_check_all_models,
        "duplicateBehavior": duplicate_behavior,
        "fieldOverwriteModes": field_overwrite_modes,
    }


def load_hoshidicts_mining_profile(
    profile_path: Path | None = None,
) -> dict[str, Any]:
    path = profile_path or get_hoshidicts_mining_profile_path()
    try:
        stat = path.stat()
    except FileNotFoundError:
        return default_hoshidicts_mining_profile()
    if not path.is_file() or stat.st_size <= 0 or stat.st_size > MAX_PROFILE_BYTES:
        raise HoshidictsMiningError("Hoshidicts mining profile has an invalid size.")
    try:
        parsed = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise HoshidictsMiningError(f"Could not read the Hoshidicts mining profile: {exc}") from exc
    return normalize_hoshidicts_mining_profile(parsed)


def _find_model_field(
    available_fields: list[str],
    requested: str,
) -> str | None:
    requested_key = requested.casefold()
    return next(
        (field for field in available_fields if field.casefold() == requested_key),
        None,
    )


def _field_name_key(value: str) -> str:
    return "".join(character for character in value.casefold() if character.isalnum())


def _yomitan_kebab_case(value: str) -> str:
    characters = []
    for character in value:
        if character == "_" or character.isspace():
            characters.append("-")
        elif character == "-" or unicodedata.category(character)[0] in {"L", "N"}:
            characters.append(character)
    return re.sub(r"-+", "-", "".join(characters)).strip("-").lower()


def _field_template_marker_key(marker: str) -> str | None:
    marker = marker.casefold()
    key = FIELD_TEMPLATE_MARKER_KEYS.get(marker)
    if key is not None:
        return key
    if marker in UNSUPPORTED_FIELD_TEMPLATE_MARKERS:
        return "unsupported"
    if marker.startswith("single-frequency-") and len(marker) > len("single-frequency-"):
        return "frequency"
    if marker.startswith("single-glossary-") and len(marker) > len("single-glossary-"):
        return "definition"
    return None


def _suggest_field_templates(
    available_fields: list[str],
    config: Any,
) -> dict[str, str]:
    matches_by_field_name: dict[str, list[tuple[str, str]]] = {}

    def add_match(field_name: str, semantic: str, marker: str) -> None:
        field_key = _field_name_key(field_name)
        if not field_key:
            return
        matches = matches_by_field_name.setdefault(field_key, [])
        if not any(existing_semantic == semantic for existing_semantic, _marker in matches):
            matches.append((semantic, marker))

    for key, field_aliases in GENERIC_FIELD_ALIASES.items():
        for alias in field_aliases:
            add_match(alias, key, FIELD_TEMPLATE_MARKERS[key])
    for key in ("expression", "reading", "sentence", "frequency", "pitch"):
        marker = PITCH_POSITION_FIELD_TEMPLATE_MARKER if key == "pitch" else FIELD_TEMPLATE_MARKERS[key]
        add_match(KIKU_LAPIS_FIELD_MAP[key], key, marker)
    glossary_key = _field_name_key(KIKU_LAPIS_FIELD_MAP["definition"])
    matches_by_field_name[glossary_key] = [
        match for match in matches_by_field_name.get(glossary_key, []) if match[0] != "definition"
    ]
    for field_name, (slot, marker) in KIKU_RICH_FIELD_TEMPLATES.items():
        add_match(field_name, slot, marker)
    add_match(
        str(config.anki.word_field or "").strip(),
        "expression",
        "{expression}",
    )
    add_match(
        str(config.anki.sentence_field or "").strip(),
        "sentence",
        "{sentence}",
    )

    has_expression_target = any(
        any(
            semantic in {"expression", "expression-furigana"}
            for semantic, _marker in matches_by_field_name.get(_field_name_key(field_name), [])
        )
        for field_name in available_fields
    )
    suggestions = {}
    used_semantics = set()
    for index, field_name in enumerate(available_fields):
        matches = list(matches_by_field_name.get(_field_name_key(field_name), []))
        if index == 0 and not has_expression_target:
            matches.append(("expression", "{expression}"))
        matches.sort(key=lambda item: FIELD_TEMPLATE_SUGGESTION_SLOTS.index(item[0]))
        markers = []
        for semantic, marker in matches:
            if semantic in used_semantics:
                continue
            used_semantics.add(semantic)
            markers.append(marker)
        suggestions[field_name] = "<br>".join(markers)
    return suggestions


def _field_template_marker_semantic(marker: str) -> str | None:
    key = _field_template_marker_key(marker)
    if key == "pitch-position":
        return "pitch"
    if key == "furigana":
        return "expression"
    if key == "furigana-plain":
        return "reading"
    if key == "sentence-furigana":
        return "sentence"
    return key if key in FIELD_KEYS else None


def _semantic_field_targets(field_templates: dict[str, dict[str, str]]) -> dict[str, str]:
    targets = {key: "" for key in FIELD_KEYS}
    priorities = {key: -1 for key in FIELD_KEYS}
    for target, template in field_templates.items():
        for match in FIELD_TEMPLATE_MARKER_PATTERN.finditer(template["value"]):
            marker = match.group(1).casefold()
            key = _field_template_marker_semantic(marker)
            if key is None:
                continue
            priority = 1
            if marker in FIELD_TEMPLATE_MARKERS or marker in {"glossary", "reading", "sentence"}:
                priority = 2
            if priority > priorities[key]:
                targets[key] = target
                priorities[key] = priority
    return targets


def _resolve_target_field_templates(
    model: str,
    available_fields: list[str],
    profile: dict[str, Any],
    config: Any,
) -> dict[str, Any]:
    suggested = _suggest_field_templates(available_fields, config)
    saved_templates = profile.get("fieldTemplates")
    stale_fields = []
    invalid_fields: dict[str, str] = {}

    if saved_templates is not None:
        saved_by_key = {}
        for field, template in saved_templates.items():
            saved_by_key.setdefault(field.casefold(), (field, template))
        used_fields = set()
        resolved_templates = {}
        for field_name in available_fields:
            saved = (
                (field_name, saved_templates[field_name])
                if field_name in saved_templates
                else saved_by_key.get(field_name.casefold())
            )
            if saved is None:
                resolved_templates[field_name] = {
                    "value": "",
                    "overwriteMode": "coalesce",
                }
                continue
            used_fields.add(saved[0])
            resolved_templates[field_name] = dict(saved[1])
        stale_fields = [field for field in saved_templates if field not in used_fields]
    else:
        assignments: dict[str, list[tuple[str, str]]] = {}
        initial_modes = {}
        for field_name, template in suggested.items():
            entries = []
            for match in FIELD_TEMPLATE_MARKER_PATTERN.finditer(template):
                semantic = _field_template_marker_semantic(match.group(1))
                if semantic is not None and not any(existing == semantic for existing, _marker in entries):
                    entries.append((semantic, match.group(0)))
            entries.sort(key=lambda item: FIELD_KEYS.index(item[0]))
            assignments[field_name] = entries
            initial_modes[field_name] = profile["fieldOverwriteModes"][entries[0][0]] if entries else "coalesce"

        disabled_fields = set(profile.get("disabledFields", []))
        for key in FIELD_KEYS:
            override = str(profile.get("fields", {}).get(key, "") or "").strip()
            if key in disabled_fields or override:
                for entries in assignments.values():
                    entries[:] = [entry for entry in entries if entry[0] != key]
            if key in disabled_fields:
                continue
            if not override:
                continue
            target = _find_model_field(available_fields, override)
            if target is None:
                invalid_fields[key] = override
                continue
            marker = (
                PITCH_POSITION_FIELD_TEMPLATE_MARKER
                if key == "pitch" and target.casefold() == "pitchposition"
                else FIELD_TEMPLATE_MARKERS[key]
            )
            assignments[target].append((key, marker))

        resolved_templates = {}
        for field_name, entries in assignments.items():
            entries.sort(key=lambda item: FIELD_KEYS.index(item[0]))
            resolved_templates[field_name] = {
                "value": "<br>".join(marker for _semantic, marker in entries),
                "overwriteMode": (
                    profile["fieldOverwriteModes"][entries[0][0]] if entries else initial_modes[field_name]
                ),
            }

    resolved_fields = _semantic_field_targets(resolved_templates)
    disabled_fields = set(profile.get("disabledFields", [])) if saved_templates is None else set()
    unmapped_fields = [key for key in FIELD_KEYS if key not in disabled_fields and not resolved_fields[key]]
    return {
        "automaticFieldTemplates": suggested,
        "resolvedFieldTemplates": resolved_templates,
        "resolvedFields": resolved_fields,
        "invalidFields": invalid_fields,
        "staleFields": stale_fields,
        "unmappedFields": unmapped_fields,
    }


def _get_anki_module():
    from GameSentenceMiner import anki

    return anki


def _empty_mining_options(
    *,
    selected_note_type: str = "",
    gsm_anki_enabled: bool = False,
    error: str | None = None,
) -> dict[str, Any]:
    return {
        "connected": False,
        "gsmAnkiEnabled": gsm_anki_enabled,
        "decks": [],
        "noteTypes": [],
        "selectedNoteType": selected_note_type,
        "fields": [],
        "suggestedFields": {key: "" for key in FIELD_KEYS},
        "resolvedFields": {key: "" for key in FIELD_KEYS},
        "suggestedFieldTemplates": {},
        "resolvedFieldTemplates": {},
        "warnings": [],
        "error": error,
    }


def _validate_anki_name_list(value: Any, label: str) -> list[str]:
    names = _require_list(value, label, MAX_ANKI_OPTION_NAMES)
    output = []
    seen = set()
    for value in names:
        name = _bounded_string(
            value,
            label,
            255,
            allow_empty=False,
        )
        key = name.casefold()
        if key not in seen:
            seen.add(key)
            output.append(name)
    return output


def _resolve_mining_fields(
    model: str,
    available_fields: list[str],
    profile: dict[str, Any],
    config: Any,
) -> dict[str, Any]:
    target_resolution = _resolve_target_field_templates(model, available_fields, profile, config)
    suggested_templates = {
        field_name: {"value": value, "overwriteMode": "coalesce"}
        for field_name, value in target_resolution["automaticFieldTemplates"].items()
    }
    return {
        "automaticFields": _semantic_field_targets(suggested_templates),
        "resolvedFields": target_resolution["resolvedFields"],
        "automaticFieldTemplates": target_resolution["automaticFieldTemplates"],
        "resolvedFieldTemplates": target_resolution["resolvedFieldTemplates"],
        "invalidFields": target_resolution["invalidFields"],
        "staleFields": target_resolution["staleFields"],
        "unmappedFields": target_resolution["unmappedFields"],
    }


def _invalid_field_message(key: str, field: str, model: str) -> str:
    return f'Hoshidicts {key} field "{field}" is not in note type "{model}".'


def _stale_field_template_message(field: str, model: str) -> str:
    return f'Hoshidicts field template "{field}" is not in note type "{model}".'


def _without_saved_field_mappings(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        **profile,
        "fields": {key: "" for key in FIELD_KEYS},
        "disabledFields": [],
        "fieldTemplates": None,
        "fieldOverwriteModes": {key: "coalesce" for key in FIELD_KEYS},
    }


def get_hoshidicts_mining_options(model: str | None = None) -> dict[str, Any]:
    """Discover Anki mining choices without changing the saved mining profile."""
    selected_note_type = ""
    gsm_anki_enabled = False
    try:
        profile = load_hoshidicts_mining_profile()
        config = get_config()
        gsm_anki_enabled = bool(config.anki.enabled)
        config_model = str(config.anki.note_type or "").strip()
        saved_effective_model = profile["model"] or config_model
        if model is None:
            selected_note_type = saved_effective_model
        else:
            requested_model = _bounded_string(model, "Hoshidicts note type", 255).strip()
            selected_note_type = requested_model or config_model
        options = _empty_mining_options(
            selected_note_type=selected_note_type,
            gsm_anki_enabled=gsm_anki_enabled,
        )
        anki = _get_anki_module()
        successful_calls = 0
        failures: list[Exception] = []
        note_types: list[str] = []
        note_types_loaded = False
        try:
            note_types = _validate_anki_name_list(
                anki.invoke(
                    "modelNames",
                    timeout=ANKI_CONNECT_TIMEOUT_SECONDS,
                ),
                "Anki note type list",
            )
            note_types_loaded = True
            successful_calls += 1
        except Exception as exc:
            failures.append(exc)
            options["warnings"].append(f"Could not load Anki note types: {exc}")

        try:
            options["decks"] = _validate_anki_name_list(
                anki.invoke(
                    "deckNames",
                    timeout=ANKI_CONNECT_TIMEOUT_SECONDS,
                ),
                "Anki deck list",
            )
            successful_calls += 1
        except Exception as exc:
            failures.append(exc)
            options["warnings"].append(f"Could not load Anki decks: {exc}")

        options["noteTypes"] = note_types
        if not selected_note_type:
            options["connected"] = successful_calls > 0
            if not options["connected"] and failures:
                options["error"] = f"Could not connect to Anki through GSM: {failures[0]}"
            elif not gsm_anki_enabled:
                options["error"] = "GSM Anki integration is disabled."
            return options

        selected_model = selected_note_type
        if note_types_loaded:
            selected_model = next(
                (candidate for candidate in note_types if candidate.casefold() == selected_note_type.casefold()),
                "",
            )
        if not selected_model:
            options["connected"] = successful_calls > 0
            options["error"] = f'Anki note type "{selected_note_type}" does not exist.'
            return options

        options["selectedNoteType"] = selected_model
        try:
            fields = _validate_anki_name_list(
                anki.invoke(
                    "modelFieldNames",
                    timeout=ANKI_CONNECT_TIMEOUT_SECONDS,
                    modelName=selected_model,
                ),
                "Anki field list",
            )
            successful_calls += 1
            options["fields"] = fields
            resolution_profile = profile
            if model is not None and selected_model.casefold() != saved_effective_model.casefold():
                resolution_profile = _without_saved_field_mappings(profile)
            resolution = _resolve_mining_fields(
                selected_model,
                fields,
                resolution_profile,
                config,
            )
            options.update(
                {
                    "suggestedFields": resolution["automaticFields"],
                    "resolvedFields": resolution["resolvedFields"],
                    "suggestedFieldTemplates": resolution["automaticFieldTemplates"],
                    "resolvedFieldTemplates": resolution["resolvedFieldTemplates"],
                }
            )
            options["warnings"].extend(
                _invalid_field_message(key, field, selected_model) for key, field in resolution["invalidFields"].items()
            )
            options["warnings"].extend(
                _stale_field_template_message(field, selected_model) for field in resolution["staleFields"]
            )
        except Exception as exc:
            failures.append(exc)
            options["warnings"].append(f"Could not load Anki fields: {exc}")

        options["connected"] = successful_calls > 0
        if not options["connected"] and failures:
            options["error"] = f"Could not connect to Anki through GSM: {failures[0]}"
        elif not gsm_anki_enabled:
            options["error"] = "GSM Anki integration is disabled."
        return options
    except HoshidictsMiningError as exc:
        return _empty_mining_options(
            selected_note_type=selected_note_type,
            gsm_anki_enabled=gsm_anki_enabled,
            error=str(exc),
        )
    except Exception as exc:
        return _empty_mining_options(
            selected_note_type=selected_note_type,
            gsm_anki_enabled=gsm_anki_enabled,
            error=f"Could not connect to Anki through GSM: {exc}",
        )


def _resolve_mining_configuration(
    profile: dict[str, Any] | None = None,
    config: Any | None = None,
) -> dict[str, Any]:
    profile = profile or load_hoshidicts_mining_profile()
    config = config or get_config()
    if not profile["enabled"]:
        raise HoshidictsMiningError("Hoshidicts mining is disabled.", 503)
    if not config.anki.enabled:
        raise HoshidictsMiningError("GSM Anki integration is disabled.", 503)

    model = profile["model"] or str(config.anki.note_type or "").strip()
    if not model:
        raise HoshidictsMiningError(
            "Set an Anki note type in GSM or override it in Hoshidicts.",
            503,
        )

    anki = _get_anki_module()
    model_fields = anki.invoke(
        "modelFieldNames",
        timeout=ANKI_CONNECT_TIMEOUT_SECONDS,
        modelName=model,
    )
    try:
        model_fields = _validate_anki_name_list(
            model_fields,
            "Anki field list",
        )
    except HoshidictsMiningError as exc:
        raise HoshidictsMiningError(str(exc), 503) from exc

    try:
        decks = _validate_anki_name_list(
            anki.invoke(
                "deckNames",
                timeout=ANKI_CONNECT_TIMEOUT_SECONDS,
            ),
            "Anki deck list",
        )
    except HoshidictsMiningError as exc:
        raise HoshidictsMiningError(str(exc), 503) from exc
    deck = next(
        (item for item in decks if item.casefold() == profile["deck"].casefold()),
        None,
    )
    if deck is None:
        raise HoshidictsMiningError(
            f'Anki deck "{profile["deck"]}" does not exist.',
            503,
        )

    resolution = _resolve_mining_fields(model, model_fields, profile, config)
    if resolution["invalidFields"]:
        key, field = next(iter(resolution["invalidFields"].items()))
        raise HoshidictsMiningError(
            _invalid_field_message(key, field, model),
            503,
        )
    if model_fields:
        first_model_field = model_fields[0]
        if not resolution["resolvedFieldTemplates"][first_model_field]["value"].strip():
            raise HoshidictsMiningError(
                f'The first Anki field "{first_model_field}" is empty. Map it to a value before mining.',
                503,
            )

    return {
        "profile": profile,
        "config": config,
        "anki": anki,
        "deck": deck,
        "model": model,
        "modelFields": model_fields,
        "fields": resolution["resolvedFields"],
        "fieldTemplates": resolution["resolvedFieldTemplates"],
        "unmappedFields": resolution["unmappedFields"],
    }


_status_cache_lock = threading.Lock()
_status_cache_key: tuple[Any, ...] | None = None
_status_cache_value: dict[str, Any] | None = None
_status_cache_expires_at = 0.0
_status_in_flight: dict[tuple[Any, ...], threading.Event] = {}


def _mining_status_cache_key(
    profile: dict[str, Any],
    config: Any,
) -> tuple[Any, ...]:
    return (
        profile.get("enabled", True),
        profile.get("deck", ""),
        profile.get("model", ""),
        tuple((key, profile.get("fields", {}).get(key, "")) for key in FIELD_KEYS),
        tuple(profile.get("disabledFields", [])),
        (
            None
            if profile.get("fieldTemplates") is None
            else tuple(
                (
                    field_name,
                    template.get("value", ""),
                    template.get("overwriteMode", "coalesce"),
                )
                for field_name, template in profile["fieldTemplates"].items()
            )
        ),
        bool(config.anki.enabled),
        str(config.anki.note_type or ""),
        str(config.anki.word_field or ""),
        str(config.anki.sentence_field or ""),
    )


def _clear_mining_status_cache() -> None:
    global _status_cache_expires_at, _status_cache_key, _status_cache_value
    with _status_cache_lock:
        _status_cache_key = None
        _status_cache_value = None
        _status_cache_expires_at = 0.0
        events = list(_status_in_flight.values())
        _status_in_flight.clear()
    for event in events:
        event.set()


def _compute_mining_status(
    profile: dict[str, Any],
    config: Any,
) -> dict[str, Any]:
    try:
        resolved = _resolve_mining_configuration(profile, config)
        return {
            "available": True,
            "deck": resolved["deck"],
            "model": resolved["model"],
            "fields": resolved["fields"],
            "unmappedFields": resolved["unmappedFields"],
        }
    except HoshidictsMiningError as exc:
        return {"available": False, "error": str(exc)}
    except Exception as exc:
        return {
            "available": False,
            "error": f"Could not connect to Anki through GSM: {exc}",
        }


def get_hoshidicts_mining_status() -> dict[str, Any]:
    global _status_cache_expires_at, _status_cache_key, _status_cache_value
    try:
        profile = load_hoshidicts_mining_profile()
        config = get_config()
        cache_key = _mining_status_cache_key(profile, config)
    except HoshidictsMiningError as exc:
        return {"available": False, "error": str(exc)}
    except Exception as exc:
        return {
            "available": False,
            "error": f"Could not prepare Hoshidicts mining: {exc}",
        }

    now = time.monotonic()
    owner = False
    with _status_cache_lock:
        if _status_cache_key == cache_key and _status_cache_value is not None and now < _status_cache_expires_at:
            return deepcopy(_status_cache_value)
        event = _status_in_flight.get(cache_key)
        if event is None:
            event = threading.Event()
            _status_in_flight[cache_key] = event
            owner = True

    if not owner:
        event.wait(MINING_STATUS_WAIT_SECONDS)
        with _status_cache_lock:
            if _status_cache_key == cache_key and _status_cache_value is not None:
                return deepcopy(_status_cache_value)
        return {
            "available": False,
            "error": "Timed out while checking AnkiConnect through GSM.",
        }

    status = _compute_mining_status(profile, config)
    with _status_cache_lock:
        _status_cache_key = cache_key
        _status_cache_value = deepcopy(status)
        _status_cache_expires_at = time.monotonic() + MINING_STATUS_CACHE_SECONDS
        _status_in_flight.pop(cache_key, None)
        event.set()
    return status


def _unique_tags(values: list[Any]) -> list[str]:
    output = []
    seen = set()
    for value in values:
        tag = str(value or "").strip()
        key = tag.casefold()
        if tag and key not in seen:
            seen.add(key)
            output.append(tag)
    return output


_FURIGANA_HIGHLIGHT_OPEN = "<gsm-hoshidicts-match>"
_FURIGANA_HIGHLIGHT_CLOSE = "</gsm-hoshidicts-match>"
_FURIGANA_HIGHLIGHT_TAG_PATTERN = re.compile(
    f"({re.escape(_FURIGANA_HIGHLIGHT_OPEN)}|{re.escape(_FURIGANA_HIGHLIGHT_CLOSE)})"
)
_ANKI_FURIGANA_SEGMENT_PATTERN = re.compile(r"([^\s<>\[\]]+)\[([^\[\]<>]+)\]")


def _raw_highlight_sentence_match(request: dict[str, Any]) -> str:
    sentence = request["sentence"]
    encoded = sentence.encode("utf-16-le")
    start = request["matchOffset"] * 2
    end = start + len(request["matched"].encode("utf-16-le"))
    prefix = encoded[:start].decode("utf-16-le")
    highlighted = encoded[start:end].decode("utf-16-le")
    suffix = encoded[end:].decode("utf-16-le")
    return f"{prefix}{_FURIGANA_HIGHLIGHT_OPEN}{highlighted}{_FURIGANA_HIGHLIGHT_CLOSE}{suffix}"


def _render_anki_furigana_text(value: str, source: str | None) -> str:
    matches = list(_ANKI_FURIGANA_SEGMENT_PATTERN.finditer(value))
    if source is not None:
        aligned = []
        source_cursor = 0
        for match in matches:
            surface = match.group(1)
            surface_start = source.find(surface, source_cursor)
            if surface_start < 0:
                aligned = []
                break
            aligned.append(html.escape(source[source_cursor:surface_start]))
            aligned.append(f"<ruby>{html.escape(surface)}<rt>{html.escape(match.group(2))}</rt></ruby>")
            source_cursor = surface_start + len(surface)
        else:
            aligned.append(html.escape(source[source_cursor:]))
            return "".join(aligned)

    output = []
    cursor = 0
    for match in matches:
        output.append(html.escape(value[cursor : match.start()]))
        output.append(f"<ruby>{html.escape(match.group(1))}<rt>{html.escape(match.group(2))}</rt></ruby>")
        cursor = match.end()
    output.append(html.escape(value[cursor:]))
    return "".join(output)


def _render_anki_furigana(
    value: str,
    *,
    ruby: bool,
    source: str | None = None,
) -> str:
    value_parts = _FURIGANA_HIGHLIGHT_TAG_PATTERN.split(value)
    source_parts = _FURIGANA_HIGHLIGHT_TAG_PATTERN.split(source) if source is not None else None
    if source_parts is not None:
        value_tags = [part for part in value_parts if part in {_FURIGANA_HIGHLIGHT_OPEN, _FURIGANA_HIGHLIGHT_CLOSE}]
        source_tags = [part for part in source_parts if part in {_FURIGANA_HIGHLIGHT_OPEN, _FURIGANA_HIGHLIGHT_CLOSE}]
        if value_tags != source_tags or len(value_parts) != len(source_parts):
            source_parts = None

    output = []
    for index, part in enumerate(value_parts):
        if part == _FURIGANA_HIGHLIGHT_OPEN:
            output.append("<b>")
            continue
        if part == _FURIGANA_HIGHLIGHT_CLOSE:
            output.append("</b>")
            continue
        if not ruby:
            output.append(html.escape(part))
            continue
        source_part = source_parts[index] if source_parts is not None else None
        output.append(_render_anki_furigana_text(part, source_part))
    return "".join(output)


def _expression_furigana_plain(expression: str, reading: str) -> str:
    normalized_reading = reading.strip()
    if not normalized_reading:
        return expression
    try:
        # Import lazily: importing GameSentenceMiner.mecab constructs the shared
        # MeCab controller, which should not happen merely by loading this module.
        from GameSentenceMiner.mecab.format import format_output
        from GameSentenceMiner.mecab.kana_conv import to_katakana

        if to_katakana(expression) == to_katakana(normalized_reading):
            return expression
        return format_output(expression, normalized_reading).lstrip()
    except Exception:
        return expression


def _sentence_furigana_values(
    request: dict[str, Any],
    anki: Any,
    reading_cache: dict[str, str | None],
) -> tuple[str, str]:
    fallback = _highlight_sentence_match(request)
    sentence = request["sentence"]
    if sentence not in reading_cache:
        try:
            reading = anki.tokenizer.reading(sentence)
            reading_cache[sentence] = reading if isinstance(reading, str) and reading else None
        except Exception:
            reading_cache[sentence] = None
    reading = reading_cache[sentence]
    if reading is None:
        return fallback, fallback

    try:
        preserved = anki._preserve_html_tags_for_furigana(
            _raw_highlight_sentence_match(request),
            reading,
        )
        if not isinstance(preserved, str) or not preserved:
            return fallback, fallback
        return (
            _render_anki_furigana(
                preserved,
                ruby=True,
                source=_raw_highlight_sentence_match(request),
            ),
            _render_anki_furigana(preserved, ruby=False),
        )
    except Exception:
        return fallback, fallback


def _field_templates_use_marker_key(
    field_templates: dict[str, dict[str, str]],
    marker_keys: set[str],
) -> bool:
    return any(
        _field_template_marker_key(match.group(1)) in marker_keys
        for template in field_templates.values()
        for match in FIELD_TEMPLATE_MARKER_PATTERN.finditer(template["value"])
    )


def _dynamic_glossary_values(
    request: dict[str, Any],
    field_templates: dict[str, dict[str, str]],
) -> dict[str, str]:
    used_markers = {
        match.group(1)
        for template in field_templates.values()
        for match in FIELD_TEMPLATE_MARKER_PATTERN.finditer(template["value"])
        if match.group(1).startswith("single-glossary-")
    }
    if not used_markers:
        return {}

    dictionaries = list(dict.fromkeys(glossary["dictionary"] for glossary in request["term"]["glossaries"]))
    dictionary_markers = [
        (dictionary, f"single-glossary-{marker_name}")
        for dictionary in dictionaries
        if (marker_name := _yomitan_kebab_case(dictionary))
    ]
    marker_options: dict[str, tuple[str, bool, bool, bool]] = {}
    # Base names win collisions with a suffix variant from another dictionary;
    # this avoids interpreting a real dictionary ending in e.g. " Brief" as a
    # modifier for a shorter dictionary name.
    for dictionary, marker in dictionary_markers:
        marker_options.setdefault(marker, (dictionary, False, False, False))
    for dictionary, marker in dictionary_markers:
        marker_options.setdefault(f"{marker}-brief", (dictionary, True, False, False))
        marker_options.setdefault(f"{marker}-no-dictionary", (dictionary, False, True, False))
        marker_options.setdefault(f"{marker}-plain", (dictionary, False, False, True))
        marker_options.setdefault(f"{marker}-plain-no-dictionary", (dictionary, False, True, True))

    values = {}
    for marker in used_markers:
        options = marker_options.get(marker)
        if options is None:
            continue
        dictionary, brief, no_dictionary, plain = options
        rendered = (
            _plain_definition_html(
                request,
                no_dictionary=no_dictionary,
                selected_dictionary=dictionary,
            )
            if plain
            else _definition_html(
                request,
                brief=brief,
                no_dictionary=no_dictionary,
                selected_dictionary=dictionary,
            )
        )
        values[f"{{{marker}}}"] = rendered
    return values


def _template_values_for_fields(
    request: dict[str, Any],
    resolved: dict[str, Any],
    field_templates: dict[str, dict[str, str]],
    *,
    audio_value: str = "",
) -> dict[str, str]:
    sentence_furigana = None
    if _field_templates_use_marker_key(field_templates, {"sentence-furigana"}):
        sentence_furigana = _sentence_furigana_values(
            request,
            resolved["anki"],
            resolved.setdefault("sentenceReadingCache", {}),
        )
    values = _field_template_values(
        request,
        audio_value=audio_value,
        generate_expression_furigana=_field_templates_use_marker_key(
            field_templates,
            {"furigana", "furigana-plain"},
        ),
        sentence_furigana=sentence_furigana,
    )
    values.update(_dynamic_glossary_values(request, field_templates))
    return values


def _field_template_values(
    request: dict[str, Any],
    *,
    audio_value: str = "",
    generate_expression_furigana: bool = True,
    sentence_furigana: tuple[str, str] | None = None,
) -> dict[str, str]:
    term = request["term"]
    highlighted_sentence = _highlight_sentence_match(request)
    cloze_prefix, separator, highlighted_suffix = highlighted_sentence.partition("<b>")
    cloze_body, closing_separator, cloze_suffix = highlighted_suffix.partition("</b>")
    if not separator or not closing_separator:
        cloze_prefix = highlighted_sentence
        cloze_body = ""
        cloze_suffix = ""
    expression_value = term["expression"]
    reading_value = term["reading"]
    expression = html.escape(expression_value)
    reading = html.escape(reading_value)
    furigana_plain_value = (
        _expression_furigana_plain(expression_value, reading_value)
        if generate_expression_furigana
        else expression_value
    )
    furigana = _render_anki_furigana(
        furigana_plain_value,
        ruby=True,
        source=expression_value,
    )
    furigana_plain = _render_anki_furigana(furigana_plain_value, ruby=False)
    sentence_furigana_html, sentence_furigana_plain = sentence_furigana or (
        highlighted_sentence,
        highlighted_sentence,
    )
    definition = _definition_html(request)
    main_definition = _main_definition_html(request)
    glossary_brief = _definition_html(request, brief=True)
    glossary_no_dictionary = _definition_html(request, no_dictionary=True)
    glossary_plain = _plain_definition_html(request)
    glossary_plain_no_dictionary = _plain_definition_html(request, no_dictionary=True)
    glossary_first_brief = _definition_html(request, first_only=True, brief=True)
    glossary_first_no_dictionary = _definition_html(
        request,
        first_only=True,
        no_dictionary=True,
    )
    dictionary = html.escape(_first_dictionary(request))
    return {
        "{expression}": expression,
        "{reading}": reading,
        "{furigana}": furigana,
        "{furigana-plain}": furigana_plain,
        "{definition}": definition,
        "{glossary}": definition,
        "{glossary-brief}": glossary_brief,
        "{glossary-no-dictionary}": glossary_no_dictionary,
        "{glossary-plain}": glossary_plain,
        "{glossary-plain-no-dictionary}": glossary_plain_no_dictionary,
        "{glossary-first}": main_definition,
        "{glossary-first-brief}": glossary_first_brief,
        "{glossary-first-no-dictionary}": glossary_first_no_dictionary,
        "{main-definition}": main_definition,
        "{jpmn-primary-definition}": main_definition,
        "{dictionary}": dictionary,
        "{dictionary-alias}": dictionary,
        "{sentence}": highlighted_sentence,
        "{sentence-furigana}": sentence_furigana_html,
        "{sentence-furigana-plain}": sentence_furigana_plain,
        "{frequency}": _frequency_html(request),
        "{pitch}": _pitch_html(request),
        PITCH_POSITION_FIELD_TEMPLATE_MARKER: _pitch_positions_text(request),
        "{audio}": audio_value,
        "{cloze-prefix}": cloze_prefix,
        "{cloze-body}": cloze_body,
        "{cloze-suffix}": cloze_suffix,
    }


def _render_field_template(
    template: str,
    values: dict[str, str],
) -> str:
    def replacement(match: re.Match[str]) -> str:
        raw_marker = match.group(1)
        raw_key = f"{{{raw_marker}}}"
        if raw_key in values:
            return values[raw_key]
        marker = raw_marker.casefold()
        folded_key = f"{{{marker}}}"
        if folded_key in values:
            return values[folded_key]
        marker_key = _field_template_marker_key(marker)
        if marker_key == "audio":
            return values["{audio}"]
        if marker_key in {"pitch", "pitch-position"}:
            return values[PITCH_POSITION_FIELD_TEMPLATE_MARKER] if marker_key == "pitch-position" else values["{pitch}"]
        if marker_key == "frequency":
            return values["{frequency}"]
        if marker_key == "sentence":
            return values["{sentence}"]
        if marker_key == "definition":
            if marker.startswith("single-glossary-"):
                return ""
            if marker.startswith("glossary-first"):
                return values["{main-definition}"]
            return values["{definition}"]
        if marker_key == "dictionary":
            return values["{dictionary}"]
        if marker_key == "unsupported":
            return ""
        if marker_key == "furigana":
            return values["{furigana}"]
        if marker_key == "furigana-plain":
            return values["{furigana-plain}"]
        if marker_key == "sentence-furigana":
            return values["{sentence-furigana}"]
        if marker_key == "reading":
            return values["{reading}"]
        if marker_key == "expression":
            return values["{expression}"]
        return match.group(0)

    rendered_segments = []
    for segment in FIELD_TEMPLATE_BREAK_PATTERN.split(template):
        matches = list(FIELD_TEMPLATE_MARKER_PATTERN.finditer(segment))
        rendered = FIELD_TEMPLATE_MARKER_PATTERN.sub(replacement, segment)
        has_known_marker = any(
            f"{{{match.group(1).casefold()}}}" in values or _field_template_marker_key(match.group(1)) is not None
            for match in matches
        )
        if has_known_marker and not rendered.strip():
            continue
        rendered_segments.append(rendered)
    return "<br>".join(rendered_segments)


def _template_uses_audio(template: str) -> bool:
    return any(
        _field_template_marker_key(match.group(1)) == "audio"
        for match in FIELD_TEMPLATE_MARKER_PATTERN.finditer(template)
    )


def _template_has_non_audio_content(template: str) -> bool:
    without_audio = FIELD_TEMPLATE_MARKER_PATTERN.sub(
        lambda match: "" if _field_template_marker_key(match.group(1)) in {"audio", "unsupported"} else match.group(0),
        template,
    )
    return bool(FIELD_TEMPLATE_BREAK_PATTERN.sub("", without_audio).strip())


def _root_deck_name(deck_name: str) -> str:
    return deck_name.split("::", 1)[0]


def _anki_note_options(
    profile: dict[str, Any],
    deck_name: str,
    *,
    allow_duplicate: bool | None = None,
) -> dict[str, Any]:
    duplicate_scope = profile["duplicateScope"]
    duplicate_scope_deck_name = None
    duplicate_scope_check_children = False
    if duplicate_scope == "deck-root":
        duplicate_scope = "deck"
        duplicate_scope_deck_name = _root_deck_name(deck_name)
        duplicate_scope_check_children = True
    if allow_duplicate is None:
        allow_duplicate = not profile["checkForDuplicates"] or profile["duplicateBehavior"] != "prevent"
    return {
        "allowDuplicate": allow_duplicate,
        "duplicateScope": duplicate_scope,
        "duplicateScopeOptions": {
            "deckName": duplicate_scope_deck_name,
            "checkChildren": duplicate_scope_check_children,
            "checkAllModels": profile["duplicateScopeCheckAllModels"],
        },
    }


def _build_hoshidicts_note(
    request: dict[str, Any],
    resolved: dict[str, Any],
) -> dict[str, Any]:
    if not resolved["modelFields"]:
        raise HoshidictsMiningError("The selected Anki note type has no fields.", 503)
    template_values = _template_values_for_fields(
        request,
        resolved,
        resolved["fieldTemplates"],
    )
    fields = {
        field_name: _render_field_template(
            resolved["fieldTemplates"][field_name]["value"],
            template_values,
        )
        for field_name in resolved["modelFields"]
    }
    first_model_field = resolved["modelFields"][0]
    if not fields[first_model_field].strip():
        raise HoshidictsMiningError(
            f'The first Anki field "{first_model_field}" is empty. Map it to a value before mining.',
            503,
        )

    config = resolved["config"]
    anki = resolved["anki"]
    inherited_tags = (
        anki._prepare_anki_tags() if hasattr(anki, "_prepare_anki_tags") else list(config.anki.custom_tags or [])
    )
    tags = _unique_tags(
        [
            *inherited_tags,
            *(config.anki.tags_to_check or []),
            *resolved["profile"]["tags"],
            "overlay",
        ]
    )
    return {
        "deckName": resolved["deck"],
        "modelName": resolved["model"],
        "fields": fields,
        "options": _anki_note_options(resolved["profile"], resolved["deck"]),
        "tags": tags,
    }


def _is_duplicate_anki_error(value: Any) -> bool:
    return "cannot create note because it is a duplicate" in str(value).casefold()


def _duplicate_check_note(
    note: dict[str, Any],
    first_model_field: str,
    *,
    allow_duplicate: bool,
) -> dict[str, Any]:
    return {
        **note,
        "fields": {first_model_field: note["fields"].get(first_model_field, "")},
        "options": {**note["options"], "allowDuplicate": allow_duplicate},
    }


def _validate_anki_check_results(
    value: Any,
    expected_count: int,
    *,
    detailed: bool,
) -> list[Any]:
    if not isinstance(value, list) or len(value) != expected_count:
        raise HoshidictsMiningError(
            "AnkiConnect returned invalid duplicate check results.",
            502,
        )
    valid = (
        all(isinstance(item, dict) and isinstance(item.get("canAdd"), bool) for item in value)
        if detailed
        else all(isinstance(item, bool) for item in value)
    )
    if not valid:
        raise HoshidictsMiningError(
            "AnkiConnect returned invalid duplicate check results.",
            502,
        )
    return value


def _check_anki_duplicates(
    notes: list[dict[str, Any]],
    first_model_field: str,
    anki: Any,
) -> list[dict[str, Any]]:
    check_notes = [_duplicate_check_note(note, first_model_field, allow_duplicate=False) for note in notes]
    legacy_results = None
    try:
        details = _validate_anki_check_results(
            anki.invoke(
                "canAddNotesWithErrorDetail",
                notes=check_notes,
                timeout=ANKI_CONNECT_TIMEOUT_SECONDS,
            ),
            len(notes),
            detailed=True,
        )
    except Exception as exc:
        if "unsupported action" not in str(exc).casefold():
            raise
        allow_notes = [_duplicate_check_note(note, first_model_field, allow_duplicate=True) for note in notes]
        allowed = _validate_anki_check_results(
            anki.invoke(
                "canAddNotes",
                notes=allow_notes,
                timeout=ANKI_CONNECT_TIMEOUT_SECONDS,
            ),
            len(notes),
            detailed=False,
        )
        prevented = _validate_anki_check_results(
            anki.invoke(
                "canAddNotes",
                notes=check_notes,
                timeout=ANKI_CONNECT_TIMEOUT_SECONDS,
            ),
            len(notes),
            detailed=False,
        )
        legacy_results = list(zip(allowed, prevented))

    results = []
    source = details if legacy_results is None else legacy_results
    for item in source:
        raw_error = item.get("error") if isinstance(item, dict) else None
        error = raw_error if isinstance(raw_error, str) and raw_error else None
        duplicate = _is_duplicate_anki_error(error) if isinstance(item, dict) else item[0] != item[1]
        addable = item.get("canAdd") is True if isinstance(item, dict) else item == (True, True)
        results.append(
            {
                "duplicate": duplicate,
                "addable": addable,
                "error": error,
            }
        )
    return results


def _escape_anki_query_value(value: str) -> str:
    return value.replace('"', "")


def _duplicate_note_query(
    note: dict[str, Any],
    first_model_field: str,
    profile: dict[str, Any],
) -> str:
    parts = []
    duplicate_scope = profile["duplicateScope"]
    if duplicate_scope == "deck":
        parts.append(f'"deck:{_escape_anki_query_value(note["deckName"])}"')
    elif duplicate_scope == "deck-root":
        root_deck = _root_deck_name(note["deckName"])
        parts.append(f'"deck:{_escape_anki_query_value(root_deck)}"')
    field_value = str(note["fields"].get(first_model_field, ""))
    parts.append(f'"{first_model_field.lower()}:{_escape_anki_query_value(field_value)}"')
    return " ".join(parts)


def _valid_note_ids(value: Any) -> list[int]:
    if not isinstance(value, list):
        raise HoshidictsMiningError(
            "AnkiConnect returned invalid duplicate note IDs.",
            502,
        )
    note_ids = []
    for item in value:
        if not isinstance(item, int) or isinstance(item, bool) or item <= 0:
            raise HoshidictsMiningError(
                "AnkiConnect returned invalid duplicate note IDs.",
                502,
            )
        note_ids.append(item)
    return note_ids


def _note_info_fields(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    raw_fields = value.get("fields")
    if not isinstance(raw_fields, dict):
        return None
    fields = {}
    for field_name, raw_value in raw_fields.items():
        if not isinstance(field_name, str):
            continue
        if isinstance(raw_value, dict):
            raw_value = raw_value.get("value")
        if isinstance(raw_value, str):
            fields[field_name] = raw_value
    return fields


def _scope_note_ids(
    note_infos: list[Any],
    profile: dict[str, Any],
    deck_name: str,
    anki: Any,
) -> set[int] | None:
    duplicate_scope = profile["duplicateScope"]
    if duplicate_scope == "collection":
        return None
    card_ids = []
    for info in note_infos:
        if not isinstance(info, dict) or not isinstance(info.get("cards"), list):
            continue
        card_ids.extend(
            card_id
            for card_id in info["cards"]
            if isinstance(card_id, int) and not isinstance(card_id, bool) and card_id > 0
        )
    if not card_ids:
        return set()
    card_infos = anki.invoke(
        "cardsInfo",
        cards=card_ids,
        timeout=ANKI_CONNECT_TIMEOUT_SECONDS,
    )
    if not isinstance(card_infos, list):
        raise HoshidictsMiningError(
            "AnkiConnect returned invalid duplicate card details.",
            502,
        )
    target_deck = deck_name.casefold()
    target_root = _root_deck_name(deck_name).casefold()
    matching_note_ids = set()
    for card in card_infos:
        if not isinstance(card, dict) or not isinstance(card.get("deckName"), str):
            continue
        note_id = card.get("note", card.get("noteId"))
        if not isinstance(note_id, int) or isinstance(note_id, bool) or note_id <= 0:
            continue
        card_deck = card["deckName"].casefold()
        in_scope = (
            card_deck == target_deck
            if duplicate_scope == "deck"
            else card_deck == target_root or card_deck.startswith(f"{target_root}::")
        )
        if in_scope:
            matching_note_ids.add(note_id)
    return matching_note_ids


def _find_overwrite_target(
    note: dict[str, Any],
    first_model_field: str,
    resolved: dict[str, Any],
) -> dict[str, Any] | None:
    anki = resolved["anki"]
    note_ids = _valid_note_ids(
        anki.invoke(
            "findNotes",
            query=_duplicate_note_query(
                note,
                first_model_field,
                resolved["profile"],
            ),
            timeout=ANKI_CONNECT_TIMEOUT_SECONDS,
        )
    )
    if not note_ids:
        return None
    note_infos = anki.invoke(
        "notesInfo",
        notes=note_ids,
        timeout=ANKI_CONNECT_TIMEOUT_SECONDS,
    )
    if not isinstance(note_infos, list):
        raise HoshidictsMiningError(
            "AnkiConnect returned invalid duplicate note details.",
            502,
        )
    scoped_note_ids = _scope_note_ids(
        note_infos,
        resolved["profile"],
        resolved["deck"],
        anki,
    )
    infos_by_id = {
        info.get("noteId"): info
        for info in note_infos
        if isinstance(info, dict) and isinstance(info.get("noteId"), int) and not isinstance(info.get("noteId"), bool)
    }
    for note_id in note_ids:
        if scoped_note_ids is not None and note_id not in scoped_note_ids:
            continue
        info = infos_by_id.get(note_id)
        if not isinstance(info, dict):
            continue
        model_name = info.get("modelName")
        fields = _note_info_fields(info)
        if not isinstance(model_name, str) or model_name.casefold() != resolved["model"].casefold() or fields is None:
            continue
        return {"noteId": note_id, "fields": fields}
    return None


def _overwrite_field(existing_value: str, new_value: str, mode: str) -> str:
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


def _resolved_overwrite_modes(resolved: dict[str, Any]) -> dict[str, str]:
    field_templates = resolved.get("fieldTemplates")
    if isinstance(field_templates, dict):
        return {
            target: template["overwriteMode"]
            for target, template in field_templates.items()
            if not _template_uses_audio(template["value"]) or _template_has_non_audio_content(template["value"])
        }

    modes = {}
    for key in FIELD_KEYS:
        if key == "audio":
            continue
        target = resolved["fields"].get(key)
        if target and target not in modes:
            modes[target] = resolved["profile"]["fieldOverwriteModes"][key]
    return modes


def _overwritten_note_fields(
    note: dict[str, Any],
    existing_fields: dict[str, str],
    resolved: dict[str, Any],
) -> dict[str, str]:
    modes = _resolved_overwrite_modes(resolved)
    return {
        field: _overwrite_field(
            existing_fields.get(field, ""),
            note["fields"].get(field, ""),
            mode,
        )
        for field, mode in modes.items()
    }


def check_hoshidicts_notes(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HoshidictsMiningError("Duplicate check request must be an object.")
    raw_notes = payload.get("notes")
    if not isinstance(raw_notes, list) or not 1 <= len(raw_notes) <= MAX_DUPLICATE_CHECK_NOTES:
        raise HoshidictsMiningError(
            f"Duplicate check notes must contain between 1 and {MAX_DUPLICATE_CHECK_NOTES} items."
        )

    requests = [validate_hoshidicts_mining_request(note) for note in raw_notes]
    resolved = _resolve_mining_configuration()
    if not resolved["modelFields"]:
        raise HoshidictsMiningError("The selected Anki note type has no fields.", 503)
    notes = [_build_hoshidicts_note(request, resolved) for request in requests]
    profile = resolved["profile"]
    duplicate_behavior = profile["duplicateBehavior"]
    if not profile["checkForDuplicates"]:
        return {
            "success": True,
            "checkForDuplicates": False,
            "duplicateBehavior": duplicate_behavior,
            "results": [{"state": "addable", "canAdd": True, "duplicate": False} for _note_value in notes],
        }
    first_model_field = resolved["modelFields"][0]
    results = []
    duplicate_details = _check_anki_duplicates(
        notes,
        first_model_field,
        resolved["anki"],
    )
    for note, item in zip(notes, duplicate_details):
        duplicate = item["duplicate"]
        addable = item["addable"]
        error = item["error"]
        if duplicate:
            duplicate_result = {
                "state": "duplicate",
                "canAdd": duplicate_behavior != "prevent",
                "duplicate": True,
            }
            if duplicate_behavior == "overwrite":
                target = _find_overwrite_target(
                    note,
                    first_model_field,
                    resolved,
                )
                duplicate_result["canAdd"] = target is not None
                if target is None:
                    duplicate_result["error"] = (
                        "A duplicate exists, but it uses a different note type "
                        "or is outside the selected deck scope and cannot be overwritten."
                    )
                else:
                    duplicate_result["action"] = "overwrite"
            results.append(duplicate_result)
        elif addable and not error:
            results.append({"state": "addable", "canAdd": True, "duplicate": False})
        else:
            results.append(
                {
                    "state": "invalid",
                    "canAdd": False,
                    "duplicate": False,
                    "error": error or "Anki cannot add this note.",
                }
            )
    return {
        "success": True,
        "checkForDuplicates": True,
        "duplicateBehavior": duplicate_behavior,
        "results": results,
    }


def _audio_warning(status: str, message: str) -> dict[str, str]:
    return {
        "status": status,
        "warning": message,
    }


def _enrich_hoshidicts_note_audio(
    request: dict[str, Any],
    resolved: dict[str, Any],
    note_id: int,
    initial_fields: dict[str, str],
    *,
    overwritten: bool = False,
) -> dict[str, str]:
    audio_templates = {
        target: template
        for target, template in resolved["fieldTemplates"].items()
        if _template_uses_audio(template["value"])
    }
    if not audio_templates:
        return {"status": "skipped"}

    audio = _audio
    try:
        profile = audio.load_hoshidicts_audio_profile_or_default()
    except Exception as exc:
        return _audio_warning("failed", f"Could not load pronunciation audio settings: {exc}")
    if not profile["enabled"]:
        return {"status": "skipped"}

    pending_templates = {}
    for target, template in audio_templates.items():
        existing_value = initial_fields.get(target, "")
        overwrite_mode = template["overwriteMode"]
        if overwritten and (overwrite_mode == "skip" or (overwrite_mode == "coalesce" and bool(existing_value))):
            continue
        pending_templates[target] = template
    if overwritten and not pending_templates:
        return {"status": "preserved"}

    term = request["term"]
    try:
        media = audio.get_mining_audio(
            term["expression"].strip(),
            term["reading"].strip(),
            request.get("audioSelection"),
            profile=profile,
        )
    except audio.HoshidictsAudioError as exc:
        status = "unavailable" if exc.status_code == 404 else "failed"
        return _audio_warning(status, str(exc))
    except Exception as exc:
        return _audio_warning("failed", f"Could not download pronunciation audio: {exc}")

    digest = hashlib.sha256(media.data).hexdigest()[:32]
    filename = f"gsm_hoshidicts_{digest}.{media.extension}"
    try:
        stored_filename = resolved["anki"].invoke(
            "storeMediaFile",
            filename=filename,
            data=base64.b64encode(media.data).decode("ascii"),
            timeout=30,
        )
        if not isinstance(stored_filename, str) or not stored_filename:
            raise RuntimeError("Anki did not return a stored media filename")
        sound = f"[sound:{stored_filename}]"
        template_values = _template_values_for_fields(
            request,
            resolved,
            pending_templates,
            audio_value=sound,
        )
        updated_fields = {}
        for target, template in pending_templates.items():
            field_value = _render_field_template(
                template["value"],
                template_values,
            )
            if overwritten:
                field_value = _overwrite_field(
                    initial_fields.get(target, ""),
                    field_value,
                    template["overwriteMode"],
                )
            updated_fields[target] = field_value
        resolved["anki"].invoke(
            "updateNoteFields",
            note={
                "id": note_id,
                "fields": updated_fields,
            },
            timeout=30,
        )
    except Exception as exc:
        action = "updated" if overwritten else "added"
        return _audio_warning(
            "failed",
            f"The note was {action}, but pronunciation audio could not be stored: {exc}",
        )
    return {
        "status": "stored",
        "filename": stored_filename,
    }


def mine_hoshidicts_note(payload: Any) -> dict[str, Any]:
    request = validate_hoshidicts_mining_request(payload)
    resolved = _resolve_mining_configuration()
    note = _build_hoshidicts_note(request, resolved)
    anki = resolved["anki"]
    profile = resolved["profile"]
    overwritten = False
    existing_fields: dict[str, str] = {}
    if profile["checkForDuplicates"] and profile["duplicateBehavior"] == "overwrite":
        if not resolved["modelFields"]:
            raise HoshidictsMiningError(
                "The selected Anki note type has no fields.",
                503,
            )
        first_model_field = resolved["modelFields"][0]
        duplicate_details = _check_anki_duplicates(
            [note],
            first_model_field,
            anki,
        )[0]
        if duplicate_details["duplicate"]:
            target = _find_overwrite_target(
                note,
                first_model_field,
                resolved,
            )
            if target is None:
                raise HoshidictsMiningError(
                    "This note is a duplicate, but the matching note uses a "
                    "different note type or is outside the selected deck scope.",
                    409,
                )
            note_id = target["noteId"]
            existing_fields = target["fields"]
            overwritten_fields = _overwritten_note_fields(
                note,
                existing_fields,
                resolved,
            )
            anki.invoke(
                "updateNoteFields",
                note={"id": note_id, "fields": overwritten_fields},
                timeout=ANKI_CONNECT_TIMEOUT_SECONDS,
            )
            overwritten = True
        elif not duplicate_details["addable"] or duplicate_details["error"]:
            raise HoshidictsMiningError(
                duplicate_details["error"] or "Anki cannot add this note.",
                502,
            )

    if not overwritten:
        try:
            note_id = anki.invoke("addNote", note=note)
        except Exception as exc:
            if _is_duplicate_anki_error(exc):
                raise HoshidictsMiningError(
                    "This note already exists in Anki.",
                    409,
                ) from exc
            raise
    if not isinstance(note_id, int) or isinstance(note_id, bool) or note_id <= 0:
        raise HoshidictsMiningError("Anki did not return a note ID.", 502)

    audio_result = _enrich_hoshidicts_note_audio(
        request,
        resolved,
        note_id,
        existing_fields if overwritten else note["fields"],
        overwritten=overwritten,
    )
    if not overwritten:
        anki.handle_incoming_anki_event(
            {
                "event": "note_added",
                "session_id": "hoshidicts",
                "note_id": note_id,
            }
        )
    result = {
        "success": True,
        "noteId": note_id,
        "unmappedFields": resolved["unmappedFields"],
        "audio": audio_result,
    }
    if overwritten:
        result["overwritten"] = True
    return result
