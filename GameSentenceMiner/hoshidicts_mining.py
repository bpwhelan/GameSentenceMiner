from __future__ import annotations

import base64
import hashlib
import json
import threading
import time
from copy import deepcopy
from pathlib import Path
from typing import Any

from GameSentenceMiner import hoshidicts_audio as _audio
from GameSentenceMiner import hoshidicts_mining_note as _note
from GameSentenceMiner.util.config.configuration import get_app_directory, get_config

HOSHIDICTS_MINING_PROFILE_FILE = "mining-profile.json"
HOSHIDICTS_MINING_PROFILE_VERSION = 1
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
MAX_DUPLICATE_CHECK_REQUEST_BYTES = MAX_REQUEST_BYTES * MAX_DUPLICATE_CHECK_NOTES
MAX_TEXT_LENGTH = _note.MAX_TEXT_LENGTH
MAX_TERM_LENGTH = _note.MAX_TERM_LENGTH
MAX_GLOSSARIES = _note.MAX_GLOSSARIES
MAX_METADATA_GROUPS = _note.MAX_METADATA_GROUPS
MAX_METADATA_VALUES = _note.MAX_METADATA_VALUES
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


def default_hoshidicts_mining_profile() -> dict[str, Any]:
    return {
        "version": HOSHIDICTS_MINING_PROFILE_VERSION,
        "enabled": True,
        "deck": "Default",
        "model": "",
        "fields": {key: "" for key in FIELD_KEYS},
        "disabledFields": [],
        "tags": ["hoshidicts"],
        "duplicatePolicy": "prevent",
    }


def get_hoshidicts_mining_profile_path() -> Path:
    return Path(get_app_directory()) / "dictionaries" / "hoshidicts" / HOSHIDICTS_MINING_PROFILE_FILE


def normalize_hoshidicts_mining_profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HoshidictsMiningError("Hoshidicts mining profile must be an object.")
    if value.get("version", HOSHIDICTS_MINING_PROFILE_VERSION) != HOSHIDICTS_MINING_PROFILE_VERSION:
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
        "tags": tags,
        "duplicatePolicy": duplicate_policy,
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
    automatic_fields = {key: "" for key in FIELD_KEYS}
    kiku_lapis_fields = {key: _find_model_field(available_fields, field) for key, field in KIKU_LAPIS_FIELD_MAP.items()}
    is_named_kiku_lapis = any(name in model.casefold() for name in ("kiku", "lapis"))
    has_kiku_lapis_signature = all(kiku_lapis_fields.values())
    if is_named_kiku_lapis or has_kiku_lapis_signature:
        automatic_fields.update({key: field or "" for key, field in kiku_lapis_fields.items()})

    inherited = {
        "expression": str(config.anki.word_field or "").strip(),
        "sentence": str(config.anki.sentence_field or "").strip(),
    }
    for key in FIELD_KEYS:
        if automatic_fields[key]:
            continue
        candidates = []
        if inherited.get(key):
            candidates.append(inherited[key])
        candidates.extend(GENERIC_FIELD_ALIASES[key])
        automatic_fields[key] = next(
            (
                resolved
                for candidate in candidates
                if (resolved := _find_model_field(available_fields, candidate)) is not None
            ),
            "",
        )

    disabled_fields = set(profile.get("disabledFields", []))
    resolved_fields = {key: "" for key in FIELD_KEYS}
    invalid_fields: dict[str, str] = {}
    unmapped_fields = []
    for key in FIELD_KEYS:
        if key in disabled_fields:
            continue
        override = str(profile.get("fields", {}).get(key, "") or "").strip()
        if override:
            resolved = _find_model_field(available_fields, override)
            if resolved is None:
                invalid_fields[key] = override
            else:
                resolved_fields[key] = resolved
            continue
        resolved_fields[key] = automatic_fields[key]
        if not resolved_fields[key]:
            unmapped_fields.append(key)

    return {
        "automaticFields": automatic_fields,
        "resolvedFields": resolved_fields,
        "invalidFields": invalid_fields,
        "unmappedFields": unmapped_fields,
    }


def _invalid_field_message(key: str, field: str, model: str) -> str:
    return f'Hoshidicts {key} field "{field}" is not in note type "{model}".'


def get_hoshidicts_mining_options(model: str | None = None) -> dict[str, Any]:
    """Discover Anki mining choices without changing the saved mining profile."""
    selected_note_type = ""
    gsm_anki_enabled = False
    try:
        profile = load_hoshidicts_mining_profile()
        config = get_config()
        gsm_anki_enabled = bool(config.anki.enabled)
        requested_model = _bounded_string(model, "Hoshidicts note type", 255).strip() if model is not None else ""
        selected_note_type = requested_model or profile["model"] or str(config.anki.note_type or "").strip()
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
            resolution = _resolve_mining_fields(
                selected_model,
                fields,
                profile,
                config,
            )
            options.update(
                {
                    "suggestedFields": resolution["automaticFields"],
                    "resolvedFields": resolution["resolvedFields"],
                }
            )
            options["warnings"].extend(
                _invalid_field_message(key, field, selected_model) for key, field in resolution["invalidFields"].items()
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

    return {
        "profile": profile,
        "config": config,
        "anki": anki,
        "deck": deck,
        "model": model,
        "modelFields": model_fields,
        "fields": resolution["resolvedFields"],
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


def _add_field_value(
    fields: dict[str, str],
    field_name: str | None,
    value: str,
) -> None:
    if not field_name or not value:
        return
    if field_name in fields and fields[field_name]:
        fields[field_name] = f"{fields[field_name]}<br>{value}"
    else:
        fields[field_name] = value


def _anki_note_options(allow_duplicate: bool) -> dict[str, Any]:
    return {
        "allowDuplicate": allow_duplicate,
        "duplicateScope": "collection",
        "duplicateScopeOptions": {
            "deckName": None,
            "checkChildren": False,
            "checkAllModels": False,
        },
    }


def _build_hoshidicts_note(
    request: dict[str, Any],
    resolved: dict[str, Any],
) -> dict[str, Any]:
    term = request["term"]
    field_values: dict[str, str] = {}
    _add_field_value(field_values, resolved["fields"]["expression"], term["expression"])
    _add_field_value(field_values, resolved["fields"]["reading"], term["reading"])
    _add_field_value(field_values, resolved["fields"]["definition"], _definition_html(request))
    _add_field_value(
        field_values,
        resolved["fields"]["sentence"],
        _highlight_sentence_match(request),
    )
    _add_field_value(field_values, resolved["fields"]["frequency"], _frequency_html(request))
    pitch_field = resolved["fields"]["pitch"]
    pitch_value = (
        _pitch_positions_text(request)
        if pitch_field and pitch_field.casefold() == "pitchposition"
        else _pitch_html(request)
    )
    _add_field_value(field_values, pitch_field, pitch_value)
    fields = {
        field_name: field_values[field_name] for field_name in resolved["modelFields"] if field_name in field_values
    }

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
        "options": _anki_note_options(resolved["profile"]["duplicatePolicy"] == "allow"),
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
    first_model_field = resolved["modelFields"][0]
    check_notes = [_duplicate_check_note(note, first_model_field, allow_duplicate=False) for note in notes]
    duplicate_policy = resolved["profile"]["duplicatePolicy"]
    anki = resolved["anki"]
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
            anki.invoke("canAddNotes", notes=allow_notes, timeout=ANKI_CONNECT_TIMEOUT_SECONDS),
            len(notes),
            detailed=False,
        )
        prevented = _validate_anki_check_results(
            anki.invoke("canAddNotes", notes=check_notes, timeout=ANKI_CONNECT_TIMEOUT_SECONDS),
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
        if duplicate:
            results.append(
                {
                    "state": "duplicate",
                    "canAdd": duplicate_policy == "allow",
                    "duplicate": True,
                }
            )
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
        "duplicatePolicy": duplicate_policy,
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
) -> dict[str, str]:
    audio_field = resolved["fields"]["audio"]
    if not audio_field:
        return {"status": "skipped"}

    audio = _audio
    try:
        profile = audio.load_hoshidicts_audio_profile_or_default()
    except Exception as exc:
        return _audio_warning("failed", f"Could not load pronunciation audio settings: {exc}")
    if not profile["enabled"]:
        return {"status": "skipped"}

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
        existing_value = initial_fields.get(audio_field, "")
        field_value = f"{existing_value}<br>{sound}" if existing_value else sound
        resolved["anki"].invoke(
            "updateNoteFields",
            note={
                "id": note_id,
                "fields": {audio_field: field_value},
            },
            timeout=30,
        )
    except Exception as exc:
        return _audio_warning("failed", f"The note was added, but pronunciation audio could not be stored: {exc}")
    return {
        "status": "stored",
        "filename": stored_filename,
    }


def mine_hoshidicts_note(payload: Any) -> dict[str, Any]:
    request = validate_hoshidicts_mining_request(payload)
    resolved = _resolve_mining_configuration()
    note = _build_hoshidicts_note(request, resolved)
    anki = resolved["anki"]
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
        note["fields"],
    )
    anki.handle_incoming_anki_event(
        {
            "event": "note_added",
            "session_id": "hoshidicts",
            "note_id": note_id,
        }
    )
    return {
        "success": True,
        "noteId": note_id,
        "unmappedFields": resolved["unmappedFields"],
        "audio": audio_result,
    }
