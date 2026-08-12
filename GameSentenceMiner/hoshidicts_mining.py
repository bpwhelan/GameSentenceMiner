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

from GameSentenceMiner import hoshidicts_anki as _anki
from GameSentenceMiner import hoshidicts_audio as _audio
from GameSentenceMiner import hoshidicts_audio_profile as _audio_profile
from GameSentenceMiner.hoshidicts_anki import (
    MEDIA_TIMEOUT_SECONDS,
    NOTE_TIMEOUT_SECONDS,
    browse_word,
    check_duplicates,
    find_field,
    find_overwrite_target,
    invoke,
    is_duplicate_error,
    name_list,
    note_options,
    store_dictionary_media,
    store_media,
)
from GameSentenceMiner.hoshidicts_markers import (
    BREAK_PATTERN,
    FIELD_KEYS,
    FIELD_OVERWRITE_MODES,
    MARKER_PATTERN,
    PITCH_POSITION_MARKER,
    marker_semantic,
    overwrite_field,
    overwritten_note_fields,
    render_template,
    semantic_field_targets,
    template_uses_audio,
    templates_use_marker_keys,
)
from GameSentenceMiner.hoshidicts_mining_note import (
    HoshidictsMiningError,
    MAX_TERM_LENGTH,
    bounded_string,
    definition_html,
    first_dictionary,
    frequency_html,
    highlight_sentence_match,
    main_definition_html,
    pitch_html,
    pitch_positions_text,
    plain_definition_html,
    single_frequency_html,
    single_frequency_number_text,
    split_sentence_match,
    validate_hoshidicts_mining_request,
)
from GameSentenceMiner.util.config.configuration import get_app_directory, get_config

HOSHIDICTS_MINING_PROFILE_FILE = "mining-profile.json"
HOSHIDICTS_MINING_PROFILE_VERSION = 3
MAX_PROFILE_BYTES = 64 * 1024
MAX_BROWSE_REQUEST_BYTES = 64 * 1024
MINING_STATUS_CACHE_SECONDS = 2.0

GENERIC_FIELD_ALIASES = {
    "expression": ("Expression", "Word", "Term", "Front"),
    "reading": ("Reading", "Word Reading", "WordReading", "Kana"),
    "definition": ("Definition", "Definitions", "Meaning", "Glossary"),
    "sentence": ("Sentence", "Context", "Example Sentence"),
    "frequency": ("Frequency", "Frequencies"),
    "pitch": ("Pitch Accent", "PitchAccent", "Pitch", "Accent"),
    "audio": ("WordAudio", "PronunciationAudio", "Pronunciation", "Audio"),
}

# Kiku's Yomitan setup uses a dictionary-specific ``single-glossary-*`` marker
# for MainDefinition. Hoshidicts' equivalent is ``main-definition``, which
# renders the first dictionary group in the configured lookup order.
KIKU_FIELD_TEMPLATES = {
    "Expression": ("expression", "{expression}"),
    "ExpressionFurigana": ("expression-furigana", "{furigana-plain}"),
    "ExpressionReading": ("reading", "{reading}"),
    "ExpressionAudio": ("audio", "{audio}"),
    "SelectionText": ("selection-text", "{popup-selection-text}"),
    "MainDefinition": ("main-definition", "{main-definition}"),
    "Glossary": ("glossary", "{glossary}"),
    "Sentence": (
        "sentence",
        "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}",
    ),
    "SentenceFurigana": ("sentence-furigana", "{sentence-furigana-plain}"),
    "PitchPosition": ("pitch", "{pitch-accent-positions}"),
    "PitchCategories": ("pitch-categories", "{pitch-accent-categories}"),
    "Frequency": ("frequency", "{frequencies}"),
    "FreqSort": ("frequency-sort", "{frequency-harmonic-rank}"),
    "MiscInfo": ("document-title", "{document-title}"),
}
# Compatibility for legacy semantic profiles. Kiku mappings themselves are
# maintained only in KIKU_FIELD_TEMPLATES above.
KIKU_LAPIS_FIELD_MAP = {
    ("definition" if slot == "glossary" else slot): field_name
    for field_name, (slot, _template) in KIKU_FIELD_TEMPLATES.items()
    if slot in {"expression", "reading", "glossary", "sentence", "frequency", "pitch"}
}
FIELD_TEMPLATE_SUGGESTION_SLOTS = (
    "expression",
    "expression-furigana",
    "reading",
    "audio",
    "selection-text",
    "main-definition",
    "glossary",
    "definition",
    "sentence",
    "sentence-furigana",
    "pitch",
    "pitch-categories",
    "frequency",
    "frequency-sort",
    "document-title",
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
    """Fill in defaults for a profile Electron already validated.

    manager.ts normalizes this profile field by field before writing
    mining-profile.json, so only the shape the card builder indexes through is
    re-checked here. The raise is deliberate: a half-restored profile that fell
    back to defaults would silently send cards to deck "Default", and
    hoshidicts-backup.ts copies this file verbatim out of a user-picked ZIP.
    """
    if not isinstance(value, dict):
        raise HoshidictsMiningError("Hoshidicts mining profile must be an object.")
    if value.get("version", HOSHIDICTS_MINING_PROFILE_VERSION) != HOSHIDICTS_MINING_PROFILE_VERSION:
        raise HoshidictsMiningError("Hoshidicts mining profile version is unsupported.")

    profile = {**default_hoshidicts_mining_profile(), **value}
    profile["version"] = HOSHIDICTS_MINING_PROFILE_VERSION
    raw_fields = profile.get("fields")
    raw_tags = profile.get("tags")
    raw_templates = profile.get("fieldTemplates")
    if (
        not isinstance(raw_fields, dict)
        or not isinstance(raw_tags, list)
        or (raw_templates is not None and not isinstance(raw_templates, dict))
    ):
        raise HoshidictsMiningError("Hoshidicts mining profile is invalid.")
    for field_name, raw_template in (raw_templates or {}).items():
        if (
            not isinstance(raw_template, dict)
            or not isinstance(raw_template.get("value"), str)
            or raw_template.get("overwriteMode") not in FIELD_OVERWRITE_MODES
        ):
            raise HoshidictsMiningError(f'Hoshidicts field template "{field_name}" is invalid.')
    raw_overwrite_modes = profile.get("fieldOverwriteModes")
    if not isinstance(raw_overwrite_modes, dict):
        raise HoshidictsMiningError("Hoshidicts mining profile is invalid.")
    profile["fields"] = {key: str(raw_fields.get(key) or "") for key in FIELD_KEYS}
    profile["fieldOverwriteModes"] = {key: raw_overwrite_modes.get(key, "coalesce") for key in FIELD_KEYS}
    profile["tags"] = _unique_tags([str(raw_tag) for raw_tag in raw_tags])
    return profile


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
            add_match(alias, key, f"{{{key}}}")
    for field_name, (slot, marker) in KIKU_FIELD_TEMPLATES.items():
        matches_by_field_name[_field_name_key(field_name)] = [(slot, marker)]
    add_match(str(config.anki.word_field or "").strip(), "expression", "{expression}")
    add_match(str(config.anki.sentence_field or "").strip(), "sentence", "{sentence}")

    suggestions = {}
    used_semantics = set()
    for field_name in available_fields:
        matches = list(matches_by_field_name.get(_field_name_key(field_name), []))
        matches.sort(key=lambda item: FIELD_TEMPLATE_SUGGESTION_SLOTS.index(item[0]))
        markers = []
        for semantic, marker in matches:
            if semantic in used_semantics:
                continue
            used_semantics.add(semantic)
            markers.append(marker)
        suggestions[field_name] = "<br>".join(markers)
    return suggestions


def _automatic_field_templates(
    suggested: dict[str, str],
    profile: dict[str, Any],
    available_fields: list[str],
) -> tuple[dict[str, dict[str, str]], dict[str, str]]:
    """Field templates for a profile that has no saved per-target templates."""
    assignments: dict[str, list[tuple[str, str]]] = {}
    initial_modes = {}
    for field_name, template in suggested.items():
        entries: list[tuple[str, str]] = []
        identities = set()
        for segment in BREAK_PATTERN.split(template):
            if not segment:
                continue
            semantics = [
                semantic
                for match in MARKER_PATTERN.finditer(segment)
                if (semantic := marker_semantic(match.group(1))) is not None
            ]
            semantic = semantics[0] if semantics and len(set(semantics)) == 1 else ""
            identity = semantic or f"template:{segment.casefold()}"
            if identity in identities:
                continue
            identities.add(identity)
            entries.append((semantic, segment))
        entries.sort(key=lambda item: FIELD_KEYS.index(item[0]) if item[0] in FIELD_KEYS else len(FIELD_KEYS))
        assignments[field_name] = entries
        initial_modes[field_name] = (
            profile["fieldOverwriteModes"][entries[0][0]] if entries and entries[0][0] in FIELD_KEYS else "coalesce"
        )

    invalid_fields: dict[str, str] = {}
    disabled_fields = set(profile.get("disabledFields", []))
    for key in FIELD_KEYS:
        override = str(profile.get("fields", {}).get(key, "") or "").strip()
        if key in disabled_fields or override:
            for entries in assignments.values():
                entries[:] = [entry for entry in entries if entry[0] != key]
        if key in disabled_fields or not override:
            continue
        target = find_field(available_fields, override)
        if target is None:
            invalid_fields[key] = override
            continue
        marker = PITCH_POSITION_MARKER if key == "pitch" and target.casefold() == "pitchposition" else f"{{{key}}}"
        assignments[target].append((key, marker))

    resolved_templates = {}
    for field_name, entries in assignments.items():
        entries.sort(key=lambda item: FIELD_KEYS.index(item[0]) if item[0] in FIELD_KEYS else len(FIELD_KEYS))
        overwrite_key = next((semantic for semantic, _marker in entries if semantic in FIELD_KEYS), None)
        resolved_templates[field_name] = {
            "value": "<br>".join(marker for _semantic, marker in entries),
            "overwriteMode": (
                profile["fieldOverwriteModes"][overwrite_key]
                if overwrite_key is not None
                else initial_modes[field_name]
            ),
        }
    return resolved_templates, invalid_fields


def _saved_field_templates(
    saved_templates: dict[str, dict[str, str]],
    available_fields: list[str],
) -> tuple[dict[str, dict[str, str]], list[str]]:
    saved_by_key: dict[str, tuple[str, dict[str, str]]] = {}
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
            resolved_templates[field_name] = {"value": "", "overwriteMode": "coalesce"}
            continue
        used_fields.add(saved[0])
        resolved_templates[field_name] = dict(saved[1])
    return resolved_templates, [field for field in saved_templates if field not in used_fields]


def _resolve_mining_fields(
    available_fields: list[str],
    profile: dict[str, Any],
    config: Any,
) -> dict[str, Any]:
    suggested = _suggest_field_templates(available_fields, config)
    saved_templates = profile.get("fieldTemplates")
    if saved_templates is not None:
        resolved_templates, stale_fields = _saved_field_templates(saved_templates, available_fields)
        invalid_fields: dict[str, str] = {}
        disabled_fields: set[str] = set()
    else:
        resolved_templates, invalid_fields = _automatic_field_templates(suggested, profile, available_fields)
        stale_fields = []
        disabled_fields = set(profile.get("disabledFields", []))

    resolved_fields = semantic_field_targets(resolved_templates)
    automatic_templates = {
        field_name: {"value": value, "overwriteMode": "coalesce"} for field_name, value in suggested.items()
    }
    return {
        "automaticFields": semantic_field_targets(automatic_templates),
        "automaticFieldTemplates": suggested,
        "resolvedFields": resolved_fields,
        "resolvedFieldTemplates": resolved_templates,
        "invalidFields": invalid_fields,
        "staleFields": stale_fields,
        "unmappedFields": [key for key in FIELD_KEYS if key not in disabled_fields and not resolved_fields[key]],
    }


def browse_hoshidicts_word(payload: Any) -> dict[str, bool]:
    """Open Anki's browser with a literal, collection-wide word search."""
    if not isinstance(payload, dict):
        raise HoshidictsMiningError("Anki browse request must be an object.")
    word = bounded_string(
        payload.get("word"),
        "Hoshidicts browse word",
        MAX_TERM_LENGTH,
        allow_empty=False,
    ).strip()
    if not word:
        raise HoshidictsMiningError("Hoshidicts browse word is invalid.")
    if not get_config().anki.enabled:
        raise HoshidictsMiningError("GSM Anki integration is disabled.", 503)
    try:
        browse_word(word)
    except Exception as exc:
        raise HoshidictsMiningError(f"Could not open Anki through GSM: {exc}", 502) from exc
    return {"success": True}


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


def _invalid_field_message(key: str, field: str, model: str) -> str:
    return f'Hoshidicts {key} field "{field}" is not in note type "{model}".'


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
            selected_note_type = bounded_string(model, "Hoshidicts note type", 255).strip() or config_model
        options = _empty_mining_options(
            selected_note_type=selected_note_type,
            gsm_anki_enabled=gsm_anki_enabled,
        )
        successful_calls = 0
        failures: list[Exception] = []
        note_types: list[str] = []
        note_types_loaded = False
        try:
            note_types = name_list(invoke("modelNames"), "Anki note type list")
            note_types_loaded = True
            successful_calls += 1
        except Exception as exc:
            failures.append(exc)
            options["warnings"].append(f"Could not load Anki note types: {exc}")

        try:
            options["decks"] = name_list(invoke("deckNames"), "Anki deck list")
            successful_calls += 1
        except Exception as exc:
            failures.append(exc)
            options["warnings"].append(f"Could not load Anki decks: {exc}")

        options["noteTypes"] = note_types

        def finish() -> dict[str, Any]:
            options["connected"] = successful_calls > 0
            if not options["connected"] and failures:
                options["error"] = f"Could not connect to Anki through GSM: {failures[0]}"
            elif not gsm_anki_enabled:
                options["error"] = "GSM Anki integration is disabled."
            return options

        if not selected_note_type:
            return finish()

        selected_model = selected_note_type
        if note_types_loaded:
            selected_model = find_field(note_types, selected_note_type) or ""
        if not selected_model:
            options["connected"] = successful_calls > 0
            options["error"] = f'Anki note type "{selected_note_type}" does not exist.'
            return options

        options["selectedNoteType"] = selected_model
        try:
            fields = name_list(
                invoke("modelFieldNames", modelName=selected_model),
                "Anki field list",
            )
            successful_calls += 1
            options["fields"] = fields
            resolution_profile = profile
            if model is not None and selected_model.casefold() != saved_effective_model.casefold():
                resolution_profile = _without_saved_field_mappings(profile)
            resolution = _resolve_mining_fields(fields, resolution_profile, config)
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
                f'Hoshidicts field template "{field}" is not in note type "{selected_model}".'
                for field in resolution["staleFields"]
            )
        except Exception as exc:
            failures.append(exc)
            options["warnings"].append(f"Could not load Anki fields: {exc}")
        return finish()
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

    raw_model_fields = invoke("modelFieldNames", modelName=model)
    raw_decks = invoke("deckNames")
    try:
        model_fields = name_list(raw_model_fields, "Anki field list")
        decks = name_list(raw_decks, "Anki deck list")
    except HoshidictsMiningError as exc:
        raise HoshidictsMiningError(str(exc), 503) from exc
    deck = find_field(decks, profile["deck"])
    if deck is None:
        raise HoshidictsMiningError(f'Anki deck "{profile["deck"]}" does not exist.', 503)

    resolution = _resolve_mining_fields(model_fields, profile, config)
    if resolution["invalidFields"]:
        key, field = next(iter(resolution["invalidFields"].items()))
        raise HoshidictsMiningError(_invalid_field_message(key, field, model), 503)
    if model_fields and not resolution["resolvedFieldTemplates"][model_fields[0]]["value"].strip():
        raise HoshidictsMiningError(
            f'The first Anki field "{model_fields[0]}" is empty. Map it to a value before mining.',
            503,
        )

    return {
        "profile": profile,
        "config": config,
        "anki": _anki.get_anki_module(),
        "deck": deck,
        "model": model,
        "modelFields": model_fields,
        "fields": resolution["resolvedFields"],
        "fieldTemplates": resolution["resolvedFieldTemplates"],
        "unmappedFields": resolution["unmappedFields"],
    }


_status_cache_lock = threading.Lock()
_status_cache_key: str | None = None
_status_cache_value: dict[str, Any] | None = None
_status_cache_expires_at = 0.0


def _mining_status_cache_key(profile: dict[str, Any], config: Any) -> str:
    return json.dumps(
        [
            profile,
            [
                bool(config.anki.enabled),
                str(config.anki.note_type or ""),
                str(config.anki.word_field or ""),
                str(config.anki.sentence_field or ""),
            ],
        ],
        sort_keys=True,
        default=str,
    )


def _clear_mining_status_cache() -> None:
    global _status_cache_expires_at, _status_cache_key, _status_cache_value
    with _status_cache_lock:
        _status_cache_key = None
        _status_cache_value = None
        _status_cache_expires_at = 0.0


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
    with _status_cache_lock:
        if _status_cache_key == cache_key and _status_cache_value is not None and now < _status_cache_expires_at:
            return deepcopy(_status_cache_value)

    # Concurrent callers may both compute this; the 2 s cache keeps that rare and
    # the duplicate work is one AnkiConnect round trip.
    status = _compute_mining_status(profile, config)
    with _status_cache_lock:
        _status_cache_key = cache_key
        _status_cache_value = deepcopy(status)
        _status_cache_expires_at = time.monotonic() + MINING_STATUS_CACHE_SECONDS
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
    prefix, highlighted, suffix = split_sentence_match(request)
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
    fallback = highlight_sentence_match(request)
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
        raw_sentence = _raw_highlight_sentence_match(request)
        preserved = anki._preserve_html_tags_for_furigana(raw_sentence, reading)
        if not isinstance(preserved, str) or not preserved:
            return fallback, fallback
        return (
            _render_anki_furigana(preserved, ruby=True, source=raw_sentence),
            _render_anki_furigana(preserved, ruby=False),
        )
    except Exception:
        return fallback, fallback


def _dynamic_glossary_values(
    request: dict[str, Any],
    field_templates: dict[str, dict[str, str]],
) -> dict[str, str]:
    used_markers = {
        match.group(1)
        for template in field_templates.values()
        for match in MARKER_PATTERN.finditer(template["value"])
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
        values[f"{{{marker}}}"] = (
            plain_definition_html(request, no_dictionary=no_dictionary, selected_dictionary=dictionary)
            if plain
            else definition_html(
                request,
                brief=brief,
                no_dictionary=no_dictionary,
                selected_dictionary=dictionary,
            )
        )
    return values


def _dynamic_frequency_values(
    request: dict[str, Any],
    field_templates: dict[str, dict[str, str]],
) -> dict[str, str]:
    used_markers = {
        marker
        for template in field_templates.values()
        for match in MARKER_PATTERN.finditer(template["value"])
        if (marker := match.group(1).casefold()).startswith("single-frequency-")
    }
    if not used_markers:
        return {}

    dictionaries = request.get("frequencyDictionaries")
    if dictionaries is None:
        # Older overlay builds did not include the configured dictionary
        # registry, so retain their current-result fallback for compatibility.
        dictionaries = list(dict.fromkeys(group["dictionary"] for group in request["term"]["frequencies"]))
    marker_options: dict[str, tuple[str, str]] = {}
    for dictionary in dictionaries:
        marker_name = _yomitan_kebab_case(dictionary)
        if not marker_name:
            continue
        # Yomitan registers these inline templates in this order for each
        # configured dictionary. Handlebars resolves duplicate inline names to
        # the last definition, so assignment order is significant here.
        marker_options[f"single-frequency-number-{marker_name}"] = (dictionary, "number")
        marker_options[f"single-frequency-{marker_name}"] = (dictionary, "display")

    values = {}
    for marker in used_markers:
        options = marker_options.get(marker)
        if options is None:
            continue
        dictionary, output = options
        values[f"{{{marker}}}"] = (
            single_frequency_number_text(request, dictionary)
            if output == "number"
            else single_frequency_html(request, dictionary)
        )
    return values


def _unique_marker_tokens(values: list[str]) -> list[str]:
    output = []
    seen = set()
    for value in values:
        for token in re.split(r"[\s,]+", value.strip()):
            if token and token not in seen:
                seen.add(token)
                output.append(token)
    return output


_PART_OF_SPEECH_NAMES = {
    "v1": "Ichidan verb",
    "v5": "Godan verb",
    "vk": "Kuru verb",
    "vs": "Suru verb",
    "vz": "Zuru verb",
    "adj-i": "I-adjective",
    "n": "Noun",
}


def _part_of_speech_text(request: dict[str, Any]) -> str:
    tokens = _unique_marker_tokens(
        [
            request["term"]["rules"],
            *[glossary["termTags"] for glossary in request["term"]["glossaries"]],
        ]
    )
    return ", ".join(html.escape(_PART_OF_SPEECH_NAMES.get(token, token)) for token in tokens) or "Unknown"


def _definition_tags_html(request: dict[str, Any]) -> str:
    tokens = _unique_marker_tokens(
        [
            value
            for glossary in request["term"]["glossaries"]
            for value in (glossary["definitionTags"], glossary["termTags"])
        ]
    )
    return ", ".join(
        f'<span class="tag" data-details="{html.escape(token, quote=True)}">{html.escape(token)}</span>'
        for token in tokens
    )


def _phonetic_transcriptions_html(request: dict[str, Any]) -> str:
    transcriptions = [
        transcription
        for group in request["term"]["pitches"]
        for transcription in group["transcriptions"]
        if transcription
    ]
    if not transcriptions:
        return ""
    return (
        "<ul>"
        + "".join(
            '<li class="pronunciation" data-pronunciation-type="phonetic-transcription">'
            f"{html.escape(transcription)}</li>"
            for transcription in transcriptions
        )
        + "</ul>"
    )


def _frequency_numbers(
    request: dict[str, Any],
    requested_mode: str | None,
) -> list[float]:
    numbers = []
    for group in request["term"]["frequencies"]:
        frequency_mode = group.get("frequencyMode")
        if requested_mode is not None and frequency_mode is not None and frequency_mode != requested_mode:
            continue
        for frequency in group["frequencies"]:
            display_value = frequency["displayValue"]
            if display_value is not None:
                match = re.match(r"^\d+", display_value)
                if match is not None:
                    parsed = int(match.group(0))
                    if parsed > 0:
                        numbers.append(float(parsed))
                        break
            value = frequency["value"]
            if value > 0:
                numbers.append(float(value))
                break
    return numbers


def _frequency_aggregate_text(
    request: dict[str, Any],
    requested_mode: str,
    *,
    harmonic: bool,
) -> str:
    numbers = _frequency_numbers(request, requested_mode)
    if not numbers:
        return "9999999" if requested_mode == "rank-based" else "0"
    if harmonic:
        value = len(numbers) / sum(1 / number for number in numbers)
    else:
        value = sum(numbers) / len(numbers)
    return str(int(value))


_SMALL_KANA = frozenset("ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ")
_VERB_OR_ADJECTIVE_RULES = frozenset({"v1", "v5", "vk", "vs", "vz", "adj-i"})


def _pitch_categories_text(request: dict[str, Any]) -> str:
    term = request["term"]
    word_classes = set(_unique_marker_tokens([term["rules"]]))
    is_verb_or_adjective = bool(word_classes & _VERB_OR_ADJECTIVE_RULES) and not (
        "vs" in word_classes and "n" in word_classes
    )
    reading = term["reading"] or term["expression"]
    mora_count = sum(1 for index, character in enumerate(reading) if character not in _SMALL_KANA or index == 0)
    categories = []
    seen = set()
    for group in term["pitches"]:
        for pitch in group["pitches"]:
            position = pitch["position"]
            if position == 0:
                category = "heiban"
            elif is_verb_or_adjective and position > 0:
                category = "kifuku"
            elif position == 1:
                category = "atamadaka"
            elif position > 1:
                category = "odaka" if position >= mora_count else "nakadaka"
            else:
                continue
            if category not in seen:
                seen.add(category)
                categories.append(category)
    return ",".join(categories)


def _field_template_values(
    request: dict[str, Any],
    *,
    audio_value: str = "",
    generate_expression_furigana: bool = True,
    sentence_furigana: tuple[str, str] | None = None,
) -> dict[str, str]:
    term = request["term"]
    highlighted_sentence = highlight_sentence_match(request)
    cloze_prefix, separator, highlighted_suffix = highlighted_sentence.partition("<b>")
    cloze_body, closing_separator, cloze_suffix = highlighted_suffix.partition("</b>")
    if not separator or not closing_separator:
        cloze_prefix = highlighted_sentence
        cloze_body = ""
        cloze_suffix = ""
    furigana_plain_value = (
        _expression_furigana_plain(term["expression"], term["reading"])
        if generate_expression_furigana
        else term["expression"]
    )
    sentence_furigana_html, sentence_furigana_plain = sentence_furigana or (
        highlighted_sentence,
        highlighted_sentence,
    )
    definition = definition_html(request)
    main_definition = main_definition_html(request)
    dictionary = first_dictionary(request)
    conjugation = " « ".join(html.escape(step["name"]) for step in request["trace"]) or html.escape(term["rules"])
    frequency = frequency_html(request)
    pitch_positions = pitch_positions_text(request)
    pitch_categories = _pitch_categories_text(request)
    return {
        "{expression}": html.escape(term["expression"]),
        "{reading}": html.escape(term["reading"]),
        "{furigana}": _render_anki_furigana(furigana_plain_value, ruby=True, source=term["expression"]),
        "{furigana-plain}": _render_anki_furigana(furigana_plain_value, ruby=False),
        "{definition}": definition,
        "{glossary}": definition,
        "{glossary-brief}": definition_html(request, brief=True),
        "{glossary-no-dictionary}": definition_html(request, no_dictionary=True),
        "{glossary-plain}": plain_definition_html(request),
        "{glossary-plain-no-dictionary}": plain_definition_html(request, no_dictionary=True),
        "{glossary-first}": main_definition,
        "{glossary-first-brief}": definition_html(request, first_only=True, brief=True),
        "{glossary-first-no-dictionary}": definition_html(request, first_only=True, no_dictionary=True),
        "{main-definition}": main_definition,
        "{jpmn-primary-definition}": main_definition,
        "{dictionary}": html.escape(dictionary),
        "{dictionary-alias}": html.escape(request.get("dictionaryAliases", {}).get(dictionary, dictionary)),
        "{conjugation}": conjugation,
        "{part-of-speech}": _part_of_speech_text(request),
        "{phonetic-transcriptions}": _phonetic_transcriptions_html(request),
        "{tags}": _definition_tags_html(request),
        "{popup-selection-text}": html.escape(request.get("popupSelectionText", "")),
        "{document-title}": html.escape(request.get("documentTitle", "")),
        "{search-query}": html.escape(request.get("searchQuery", "")),
        "{sentence}": highlighted_sentence,
        "{sentence-furigana}": sentence_furigana_html,
        "{sentence-furigana-plain}": sentence_furigana_plain,
        "{frequency}": frequency,
        "{frequencies}": frequency,
        "{frequency-harmonic-rank}": _frequency_aggregate_text(request, "rank-based", harmonic=True),
        "{frequency-harmonic-occurrence}": _frequency_aggregate_text(request, "occurrence-based", harmonic=True),
        "{frequency-average-rank}": _frequency_aggregate_text(request, "rank-based", harmonic=False),
        "{frequency-average-occurrence}": _frequency_aggregate_text(request, "occurrence-based", harmonic=False),
        "{pitch}": pitch_html(request),
        PITCH_POSITION_MARKER: pitch_positions,
        "{pitch-accent-positions}": pitch_positions,
        "{pitch-categories}": pitch_categories,
        "{pitch-accent-categories}": pitch_categories,
        "{audio}": audio_value,
        "{cloze-prefix}": cloze_prefix,
        "{cloze-body}": cloze_body,
        "{cloze-suffix}": cloze_suffix,
    }


def _template_values_for_fields(
    request: dict[str, Any],
    resolved: dict[str, Any],
    field_templates: dict[str, dict[str, str]],
    *,
    audio_value: str = "",
) -> dict[str, str]:
    sentence_furigana = None
    if templates_use_marker_keys(field_templates, {"sentence-furigana"}):
        sentence_furigana = _sentence_furigana_values(
            request,
            resolved["anki"],
            resolved.setdefault("sentenceReadingCache", {}),
        )
    values = _field_template_values(
        request,
        audio_value=audio_value,
        generate_expression_furigana=templates_use_marker_keys(
            field_templates,
            {"furigana", "furigana-plain"},
        ),
        sentence_furigana=sentence_furigana,
    )
    values.update(_dynamic_glossary_values(request, field_templates))
    values.update(_dynamic_frequency_values(request, field_templates))
    return values


def _build_hoshidicts_note(
    request: dict[str, Any],
    resolved: dict[str, Any],
) -> dict[str, Any]:
    if not resolved["modelFields"]:
        raise HoshidictsMiningError("The selected Anki note type has no fields.", 503)
    template_values = _template_values_for_fields(request, resolved, resolved["fieldTemplates"])
    fields = {
        field_name: render_template(resolved["fieldTemplates"][field_name]["value"], template_values)
        for field_name in resolved["modelFields"]
    }
    first_model_field = resolved["modelFields"][0]
    if not fields[first_model_field].strip():
        raise HoshidictsMiningError(
            f'The first Anki field "{first_model_field}" is empty. Map it to a value before mining.',
            422,
        )

    config = resolved["config"]
    anki = resolved["anki"]
    inherited_tags = (
        anki._prepare_anki_tags() if hasattr(anki, "_prepare_anki_tags") else list(config.anki.custom_tags or [])
    )
    return {
        "deckName": resolved["deck"],
        "modelName": resolved["model"],
        "fields": fields,
        "options": note_options(resolved["profile"], resolved["deck"]),
        "tags": _unique_tags(
            [
                *inherited_tags,
                *(config.anki.tags_to_check or []),
                *resolved["profile"]["tags"],
                "overlay",
            ]
        ),
    }


def _overwrite_target(note: dict[str, Any], first_model_field: str, resolved: dict[str, Any]):
    return find_overwrite_target(
        note,
        first_model_field,
        duplicate_scope=resolved["profile"]["duplicateScope"],
        deck=resolved["deck"],
        model=resolved["model"],
    )


def check_hoshidicts_notes(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HoshidictsMiningError("Duplicate check request must be an object.")
    raw_notes = payload.get("notes")
    if not isinstance(raw_notes, list) or not raw_notes:
        raise HoshidictsMiningError("Duplicate check notes must contain at least 1 item.")

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
    for note, item in zip(notes, check_duplicates(notes, first_model_field)):
        if item["duplicate"]:
            result = {
                "state": "duplicate",
                "canAdd": duplicate_behavior != "prevent",
                "duplicate": True,
            }
            if duplicate_behavior == "overwrite":
                target = _overwrite_target(note, first_model_field, resolved)
                result["canAdd"] = target is not None
                if target is None:
                    result["error"] = (
                        "A duplicate exists, but it uses a different note type "
                        "or is outside the selected deck scope and cannot be overwritten."
                    )
                else:
                    result["action"] = "overwrite"
        elif item["addable"] and not item["error"]:
            result = {"state": "addable", "canAdd": True, "duplicate": False}
        else:
            result = {
                "state": "invalid",
                "canAdd": False,
                "duplicate": False,
                "error": item["error"] or "Anki cannot add this note.",
            }
        results.append(result)
    return {
        "success": True,
        "checkForDuplicates": True,
        "duplicateBehavior": duplicate_behavior,
        "results": results,
    }


def _enrich_hoshidicts_note_audio(
    request: dict[str, Any],
    resolved: dict[str, Any],
    note_id: int,
    initial_fields: dict[str, str],
    *,
    overwritten: bool = False,
) -> dict[str, str]:
    def warning(status: str, message: str) -> dict[str, str]:
        return {"status": status, "warning": message}

    audio_templates = {
        target: template
        for target, template in resolved["fieldTemplates"].items()
        if template_uses_audio(template["value"])
    }
    if not audio_templates:
        return {"status": "skipped"}

    try:
        profile = _audio_profile.load_hoshidicts_audio_profile_or_default()
    except Exception as exc:
        return warning("failed", f"Could not load pronunciation audio settings: {exc}")
    if not profile["enabled"]:
        return {"status": "skipped"}

    pending_templates = {}
    for target, template in audio_templates.items():
        overwrite_mode = template["overwriteMode"]
        if overwritten and (
            overwrite_mode == "skip" or (overwrite_mode == "coalesce" and bool(initial_fields.get(target, "")))
        ):
            continue
        pending_templates[target] = template
    if overwritten and not pending_templates:
        return {"status": "preserved"}

    term = request["term"]
    try:
        media = _audio.get_mining_audio(
            term["expression"].strip(),
            term["reading"].strip(),
            request.get("audioSelection"),
            profile=profile,
        )
    except _audio.HoshidictsAudioError as exc:
        return warning("unavailable" if exc.status_code == 404 else "failed", str(exc))
    except Exception as exc:
        return warning("failed", f"Could not download pronunciation audio: {exc}")

    digest = hashlib.sha256(media.data).hexdigest()[:32]
    try:
        stored_filename = store_media(
            f"gsm_hoshidicts_{digest}.{media.extension}",
            base64.b64encode(media.data).decode("ascii"),
            label="pronunciation audio",
        )
        template_values = _template_values_for_fields(
            request,
            resolved,
            pending_templates,
            audio_value=f"[sound:{stored_filename}]",
        )
        updated_fields = {}
        for target, template in pending_templates.items():
            field_value = render_template(template["value"], template_values)
            if overwritten:
                field_value = overwrite_field(
                    initial_fields.get(target, ""),
                    field_value,
                    template["overwriteMode"],
                )
            updated_fields[target] = field_value
        invoke(
            "updateNoteFields",
            note={"id": note_id, "fields": updated_fields},
            timeout=MEDIA_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        action = "updated" if overwritten else "added"
        return warning(
            "failed",
            f"The note was {action}, but pronunciation audio could not be stored: {exc}",
        )
    return {"status": "stored", "filename": stored_filename}


def mine_hoshidicts_note(payload: Any) -> dict[str, Any]:
    request = validate_hoshidicts_mining_request(payload)
    resolved = _resolve_mining_configuration()
    store_dictionary_media(request)
    note = _build_hoshidicts_note(request, resolved)
    profile = resolved["profile"]
    overwritten = False
    existing_fields: dict[str, str] = {}
    if profile["checkForDuplicates"] and profile["duplicateBehavior"] == "overwrite":
        if not resolved["modelFields"]:
            raise HoshidictsMiningError("The selected Anki note type has no fields.", 503)
        first_model_field = resolved["modelFields"][0]
        duplicate_details = check_duplicates([note], first_model_field)[0]
        if duplicate_details["duplicate"]:
            target = _overwrite_target(note, first_model_field, resolved)
            if target is None:
                raise HoshidictsMiningError(
                    "This note is a duplicate, but the matching note uses a "
                    "different note type or is outside the selected deck scope.",
                    409,
                )
            note_id = target["noteId"]
            existing_fields = target["fields"]
            invoke(
                "updateNoteFields",
                note={
                    "id": note_id,
                    "fields": overwritten_note_fields(note, existing_fields, resolved["fieldTemplates"]),
                },
            )
            overwritten = True
        elif not duplicate_details["addable"] or duplicate_details["error"]:
            raise HoshidictsMiningError(
                duplicate_details["error"] or "Anki cannot add this note.",
                502,
            )

    if not overwritten:
        try:
            note_id = invoke("addNote", note=note, timeout=NOTE_TIMEOUT_SECONDS)
        except Exception as exc:
            if is_duplicate_error(exc):
                raise HoshidictsMiningError("This note already exists in Anki.", 409) from exc
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
        resolved["anki"].handle_incoming_anki_event(
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
