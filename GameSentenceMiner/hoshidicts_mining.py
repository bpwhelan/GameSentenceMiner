from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any

from GameSentenceMiner.util.config.configuration import get_app_directory, get_config

HOSHIDICTS_MINING_PROFILE_FILE = "mining-profile.json"
HOSHIDICTS_MINING_PROFILE_VERSION = 1
MAX_PROFILE_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 256 * 1024
MAX_TEXT_LENGTH = 128 * 1024
MAX_TERM_LENGTH = 4096
MAX_GLOSSARIES = 64
MAX_METADATA_GROUPS = 64
MAX_METADATA_VALUES = 64
MAX_ANKI_OPTION_NAMES = 4096

FIELD_KEYS = (
    "expression",
    "reading",
    "definition",
    "sentence",
    "frequency",
    "pitch",
)

OPTIONAL_FIELD_ALIASES = {
    "reading": ("Reading", "Word Reading", "WordReading", "Kana"),
    "definition": ("Definition", "Definitions", "Meaning", "Glossary"),
    "frequency": ("Frequency", "Frequencies"),
    "pitch": ("Pitch Accent", "PitchAccent", "Pitch", "Accent"),
}

GENERIC_FIELD_ALIASES = {
    "expression": ("Expression", "Word", "Term", "Front"),
    "reading": OPTIONAL_FIELD_ALIASES["reading"],
    "definition": OPTIONAL_FIELD_ALIASES["definition"],
    "sentence": ("Sentence", "Context", "Example Sentence"),
    "frequency": OPTIONAL_FIELD_ALIASES["frequency"],
    "pitch": OPTIONAL_FIELD_ALIASES["pitch"],
}

KIKU_LAPIS_FIELD_MAP = {
    "expression": "Expression",
    "reading": "ExpressionReading",
    "definition": "Glossary",
    "sentence": "Sentence",
    "frequency": "Frequency",
    "pitch": "PitchPosition",
}

IGNORED_STRUCTURED_TAGS = {
    "audio",
    "button",
    "canvas",
    "iframe",
    "img",
    "input",
    "script",
    "source",
    "style",
    "svg",
    "video",
}

BLOCK_STRUCTURED_TAGS = {
    "br",
    "div",
    "li",
    "ol",
    "p",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
}


class HoshidictsMiningError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def default_hoshidicts_mining_profile() -> dict[str, Any]:
    return {
        "version": HOSHIDICTS_MINING_PROFILE_VERSION,
        "enabled": True,
        "deck": "Default",
        "model": "",
        "fields": {key: "" for key in FIELD_KEYS},
        "tags": ["hoshidicts"],
        "duplicatePolicy": "prevent",
    }


def get_hoshidicts_mining_profile_path() -> Path:
    return Path(get_app_directory()) / "dictionaries" / "hoshidicts" / HOSHIDICTS_MINING_PROFILE_FILE


def _bounded_string(
    value: Any,
    label: str,
    maximum: int,
    *,
    allow_empty: bool = True,
) -> str:
    if not isinstance(value, str):
        raise HoshidictsMiningError(f"{label} must be a string.")
    if "\x00" in value or len(value) > maximum or (not allow_empty and not value):
        raise HoshidictsMiningError(f"{label} is invalid.")
    return value


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
    if not stat.is_file() or stat.st_size <= 0 or stat.st_size > MAX_PROFILE_BYTES:
        raise HoshidictsMiningError("Hoshidicts mining profile has an invalid size.")
    try:
        parsed = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise HoshidictsMiningError(f"Could not read the Hoshidicts mining profile: {exc}") from exc
    return normalize_hoshidicts_mining_profile(parsed)


def _require_list(value: Any, label: str, maximum: int) -> list[Any]:
    if not isinstance(value, list) or len(value) > maximum:
        raise HoshidictsMiningError(f"{label} is invalid.")
    return value


def _validate_glossary(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise HoshidictsMiningError("Hoshidicts glossary is invalid.")
    return {
        "dictionary": _bounded_string(
            value.get("dictionary", ""),
            "Hoshidicts glossary dictionary",
            MAX_TERM_LENGTH,
            allow_empty=False,
        ),
        "glossary": _bounded_string(
            value.get("glossary", ""),
            "Hoshidicts glossary",
            MAX_TEXT_LENGTH,
        ),
        "definitionTags": _bounded_string(
            value.get("definitionTags", ""),
            "Hoshidicts definition tags",
            MAX_TERM_LENGTH,
        ),
        "termTags": _bounded_string(
            value.get("termTags", ""),
            "Hoshidicts term tags",
            MAX_TERM_LENGTH,
        ),
    }


def _validate_frequency_group(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HoshidictsMiningError("Hoshidicts frequency group is invalid.")
    frequencies = []
    for item in _require_list(
        value.get("frequencies", []),
        "Hoshidicts frequencies",
        MAX_METADATA_VALUES,
    ):
        if not isinstance(item, dict) or not isinstance(item.get("value"), int) or isinstance(item.get("value"), bool):
            raise HoshidictsMiningError("Hoshidicts frequency is invalid.")
        frequencies.append(
            {
                "value": item["value"],
                "displayValue": _bounded_string(
                    item.get("displayValue", ""),
                    "Hoshidicts frequency display value",
                    MAX_TERM_LENGTH,
                ),
            }
        )
    return {
        "dictionary": _bounded_string(
            value.get("dictionary", ""),
            "Hoshidicts frequency dictionary",
            MAX_TERM_LENGTH,
            allow_empty=False,
        ),
        "frequencies": frequencies,
    }


def _validate_pitch_group(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HoshidictsMiningError("Hoshidicts pitch group is invalid.")
    pitches = []
    for item in _require_list(
        value.get("pitches", []),
        "Hoshidicts pitches",
        MAX_METADATA_VALUES,
    ):
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("position"), int)
            or isinstance(item.get("position"), bool)
        ):
            raise HoshidictsMiningError("Hoshidicts pitch value is invalid.")
        pitches.append(
            {
                "position": item["position"],
                "pattern": _bounded_string(
                    item.get("pattern", ""),
                    "Hoshidicts pitch pattern",
                    MAX_TERM_LENGTH,
                ),
                "nasal": [
                    marker
                    for marker in _require_list(
                        item.get("nasal", []),
                        "Hoshidicts nasal markers",
                        MAX_METADATA_VALUES,
                    )
                    if isinstance(marker, int) and not isinstance(marker, bool)
                ],
                "devoice": [
                    marker
                    for marker in _require_list(
                        item.get("devoice", []),
                        "Hoshidicts devoice markers",
                        MAX_METADATA_VALUES,
                    )
                    if isinstance(marker, int) and not isinstance(marker, bool)
                ],
            }
        )
    transcriptions = [
        _bounded_string(
            item,
            "Hoshidicts pitch transcription",
            MAX_TERM_LENGTH,
        )
        for item in _require_list(
            value.get("transcriptions", []),
            "Hoshidicts pitch transcriptions",
            MAX_METADATA_VALUES,
        )
    ]
    return {
        "dictionary": _bounded_string(
            value.get("dictionary", ""),
            "Hoshidicts pitch dictionary",
            MAX_TERM_LENGTH,
            allow_empty=False,
        ),
        "pitches": pitches,
        "transcriptions": transcriptions,
    }


def _utf16_suffix(text: str, offset: int) -> str:
    encoded = text.encode("utf-16-le")
    byte_offset = offset * 2
    if byte_offset > len(encoded):
        raise HoshidictsMiningError("Hoshidicts match offset is out of range.")
    try:
        return encoded[byte_offset:].decode("utf-16-le")
    except UnicodeDecodeError as exc:
        raise HoshidictsMiningError("Hoshidicts match offset splits a Unicode character.") from exc


def validate_hoshidicts_mining_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HoshidictsMiningError("Hoshidicts mining request must be an object.")
    sentence = _bounded_string(
        value.get("sentence", ""),
        "Hoshidicts sentence",
        MAX_TEXT_LENGTH,
        allow_empty=False,
    )
    match_offset = value.get("matchOffset")
    if not isinstance(match_offset, int) or isinstance(match_offset, bool) or match_offset < 0:
        raise HoshidictsMiningError("Hoshidicts match offset is invalid.")

    result = value.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("term"), dict):
        raise HoshidictsMiningError("Hoshidicts lookup result is invalid.")
    term = result["term"]
    glossaries = [
        _validate_glossary(item)
        for item in _require_list(
            term.get("glossaries", []),
            "Hoshidicts glossaries",
            MAX_GLOSSARIES,
        )
    ]
    if not glossaries:
        raise HoshidictsMiningError("Hoshidicts lookup result has no definitions.")

    normalized = {
        "matched": _bounded_string(
            result.get("matched", ""),
            "Hoshidicts matched text",
            MAX_TERM_LENGTH,
            allow_empty=False,
        ),
        "deinflected": _bounded_string(
            result.get("deinflected", ""),
            "Hoshidicts deinflected text",
            MAX_TERM_LENGTH,
        ),
        "trace": [
            {
                "name": _bounded_string(
                    item.get("name", "") if isinstance(item, dict) else None,
                    "Hoshidicts trace name",
                    1024,
                    allow_empty=False,
                ),
                "description": _bounded_string(
                    item.get("description", "") if isinstance(item, dict) else None,
                    "Hoshidicts trace description",
                    MAX_TERM_LENGTH,
                ),
            }
            for item in _require_list(
                result.get("trace", []),
                "Hoshidicts trace",
                32,
            )
        ],
        "term": {
            "expression": _bounded_string(
                term.get("expression", ""),
                "Hoshidicts expression",
                MAX_TERM_LENGTH,
                allow_empty=False,
            ),
            "reading": _bounded_string(
                term.get("reading", ""),
                "Hoshidicts reading",
                MAX_TERM_LENGTH,
            ),
            "rules": _bounded_string(
                term.get("rules", ""),
                "Hoshidicts rules",
                MAX_TERM_LENGTH,
            ),
            "glossaries": glossaries,
            "frequencies": [
                _validate_frequency_group(item)
                for item in _require_list(
                    term.get("frequencies", []),
                    "Hoshidicts frequency groups",
                    MAX_METADATA_GROUPS,
                )
            ],
            "pitches": [
                _validate_pitch_group(item)
                for item in _require_list(
                    term.get("pitches", []),
                    "Hoshidicts pitch groups",
                    MAX_METADATA_GROUPS,
                )
            ],
        },
        "sentence": sentence,
        "matchOffset": match_offset,
    }
    if not _utf16_suffix(sentence, match_offset).startswith(normalized["matched"]):
        raise HoshidictsMiningError("Hoshidicts match offset does not point at the matched text.")
    return normalized


def _append_structured_text(value: Any, output: list[str], state: list[int]) -> None:
    if state[0] >= 4096:
        return
    if isinstance(value, str):
        output.append(value)
        state[0] += 1
        return
    if isinstance(value, (int, float, bool)):
        output.append(str(value))
        state[0] += 1
        return
    if isinstance(value, list):
        for child in value:
            _append_structured_text(child, output, state)
        return
    if not isinstance(value, dict):
        return
    tag = str(value.get("tag") or "").lower()
    if tag in IGNORED_STRUCTURED_TAGS:
        return
    if value.get("type") == "text" and isinstance(value.get("text"), str):
        output.append(value["text"])
        state[0] += 1
    elif "content" in value:
        _append_structured_text(value["content"], output, state)
    if tag in BLOCK_STRUCTURED_TAGS:
        output.append("\n")


def _glossary_text(value: str) -> str:
    parsed: Any = value
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        pass
    output: list[str] = []
    _append_structured_text(parsed, output, [0])
    return "\n".join(line.strip() for line in "".join(output).splitlines() if line.strip())


def _definition_html(result: dict[str, Any]) -> str:
    term = result["term"]
    groups: dict[str, list[dict[str, str]]] = {}
    for glossary in term["glossaries"]:
        groups.setdefault(glossary["dictionary"], []).append(glossary)

    sections = []
    for dictionary, glossaries in groups.items():
        items = []
        for glossary in glossaries:
            text = _glossary_text(glossary["glossary"])
            tags = " ".join(
                item
                for item in (
                    glossary["definitionTags"],
                    glossary["termTags"],
                )
                if item
            )
            suffix = f" <small>{html.escape(tags)}</small>" if tags else ""
            items.append(f"<li>{html.escape(text)}{suffix}</li>")
        sections.append(f"<div><b>{html.escape(dictionary)}</b><ol>{''.join(items)}</ol></div>")

    details = []
    if term["rules"]:
        details.append(f"Rules: {html.escape(term['rules'])}")
    if result["trace"]:
        details.append("Deinflection: " + " &gt; ".join(html.escape(step["name"]) for step in result["trace"]))
    if details:
        sections.append(f"<small>{'<br>'.join(details)}</small>")
    return "".join(sections)


def _frequency_html(result: dict[str, Any]) -> str:
    groups = []
    for group in result["term"]["frequencies"]:
        values = [frequency["displayValue"] or str(frequency["value"]) for frequency in group["frequencies"]]
        if values:
            groups.append(
                f"<b>{html.escape(group['dictionary'])}</b>: " + ", ".join(html.escape(value) for value in values)
            )
    return "<br>".join(groups)


def _pitch_html(result: dict[str, Any]) -> str:
    groups = []
    for group in result["term"]["pitches"]:
        values = []
        for pitch in group["pitches"]:
            description = pitch["pattern"] or f"position {pitch['position']}"
            markers = []
            if pitch["nasal"]:
                markers.append("nasal " + ",".join(map(str, pitch["nasal"])))
            if pitch["devoice"]:
                markers.append("devoice " + ",".join(map(str, pitch["devoice"])))
            if markers:
                description += f" ({'; '.join(markers)})"
            values.append(description)
        values.extend(group["transcriptions"])
        if values:
            groups.append(
                f"<b>{html.escape(group['dictionary'])}</b>: " + ", ".join(html.escape(value) for value in values)
            )
    return "<br>".join(groups)


def _pitch_positions_text(result: dict[str, Any]) -> str:
    positions = []
    seen = set()
    for group in result["term"]["pitches"]:
        for pitch in group["pitches"]:
            position = pitch["position"]
            if position not in seen:
                seen.add(position)
                positions.append(str(position))
    return ", ".join(positions)


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


def _suggest_mining_fields(
    model: str,
    available_fields: list[str],
    config: Any,
) -> dict[str, str]:
    suggestions = {key: "" for key in FIELD_KEYS}
    kiku_lapis_fields = {key: _find_model_field(available_fields, field) for key, field in KIKU_LAPIS_FIELD_MAP.items()}
    is_named_kiku_lapis = any(name in model.casefold() for name in ("kiku", "lapis"))
    has_kiku_lapis_signature = all(kiku_lapis_fields.values())
    if is_named_kiku_lapis or has_kiku_lapis_signature:
        suggestions.update({key: field or "" for key, field in kiku_lapis_fields.items()})

    inherited = {
        "expression": str(config.anki.word_field or "").strip(),
        "sentence": str(config.anki.sentence_field or "").strip(),
    }
    for key in FIELD_KEYS:
        if suggestions[key]:
            continue
        candidates = []
        if inherited.get(key):
            candidates.append(inherited[key])
        candidates.extend(GENERIC_FIELD_ALIASES[key])
        suggestions[key] = next(
            (
                resolved
                for candidate in candidates
                if (resolved := _find_model_field(available_fields, candidate)) is not None
            ),
            "",
        )
    return suggestions


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
        note_types = _validate_anki_name_list(
            anki.invoke("modelNames", timeout=3),
            "Anki note type list",
        )
        decks = _validate_anki_name_list(
            anki.invoke("deckNames", timeout=3),
            "Anki deck list",
        )
        options.update(
            {
                "connected": True,
                "decks": decks,
                "noteTypes": note_types,
                "error": (None if gsm_anki_enabled else "GSM Anki integration is disabled."),
            }
        )
        if not selected_note_type:
            return options

        selected_model = next(
            (candidate for candidate in note_types if candidate.casefold() == selected_note_type.casefold()),
            None,
        )
        if selected_model is None:
            options["error"] = f'Anki note type "{selected_note_type}" does not exist.'
            return options

        fields = _validate_anki_name_list(
            anki.invoke(
                "modelFieldNames",
                timeout=3,
                modelName=selected_model,
            ),
            "Anki field list",
        )
        options.update(
            {
                "selectedNoteType": selected_model,
                "fields": fields,
                "suggestedFields": _suggest_mining_fields(
                    selected_model,
                    fields,
                    config,
                ),
            }
        )
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


def _resolve_mining_configuration() -> dict[str, Any]:
    profile = load_hoshidicts_mining_profile()
    config = get_config()
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
        timeout=3,
        modelName=model,
    )
    if not isinstance(model_fields, list) or not all(isinstance(field, str) for field in model_fields):
        raise HoshidictsMiningError(
            "Anki returned an invalid field list for the selected note type.",
            503,
        )

    decks = anki.invoke("deckNames", timeout=3)
    if not isinstance(decks, list) or not all(isinstance(deck, str) for deck in decks):
        raise HoshidictsMiningError("Anki returned an invalid deck list.", 503)
    deck = next(
        (item for item in decks if item.casefold() == profile["deck"].casefold()),
        None,
    )
    if deck is None:
        raise HoshidictsMiningError(
            f'Anki deck "{profile["deck"]}" does not exist.',
            503,
        )

    inherited = {
        "expression": str(config.anki.word_field or "").strip(),
        "sentence": str(config.anki.sentence_field or "").strip(),
    }
    resolved_fields: dict[str, str | None] = {}
    unmapped = []
    for key in FIELD_KEYS:
        override = profile["fields"][key]
        if override:
            resolved = _find_model_field(model_fields, override)
            if resolved is None:
                raise HoshidictsMiningError(
                    f'Hoshidicts {key} field "{override}" is not in note type "{model}".',
                    503,
                )
            resolved_fields[key] = resolved
            continue
        if key in inherited:
            resolved = _find_model_field(model_fields, inherited[key])
            if resolved is None:
                raise HoshidictsMiningError(
                    f'GSM {key} field "{inherited[key]}" is not in note type "{model}".',
                    503,
                )
            resolved_fields[key] = resolved
            continue
        resolved_fields[key] = next(
            (
                resolved
                for alias in OPTIONAL_FIELD_ALIASES[key]
                if (resolved := _find_model_field(model_fields, alias)) is not None
            ),
            None,
        )
        if resolved_fields[key] is None:
            unmapped.append(key)

    return {
        "profile": profile,
        "config": config,
        "anki": anki,
        "deck": deck,
        "model": model,
        "fields": resolved_fields,
        "unmappedFields": unmapped,
    }


def get_hoshidicts_mining_status() -> dict[str, Any]:
    try:
        resolved = _resolve_mining_configuration()
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


def mine_hoshidicts_note(payload: Any) -> dict[str, Any]:
    request = validate_hoshidicts_mining_request(payload)
    resolved = _resolve_mining_configuration()
    term = request["term"]
    fields: dict[str, str] = {}
    _add_field_value(fields, resolved["fields"]["expression"], term["expression"])
    _add_field_value(fields, resolved["fields"]["reading"], term["reading"])
    _add_field_value(fields, resolved["fields"]["definition"], _definition_html(request))
    _add_field_value(fields, resolved["fields"]["sentence"], request["sentence"])
    _add_field_value(fields, resolved["fields"]["frequency"], _frequency_html(request))
    pitch_field = resolved["fields"]["pitch"]
    pitch_value = (
        _pitch_positions_text(request)
        if pitch_field and pitch_field.casefold() == "pitchposition"
        else _pitch_html(request)
    )
    _add_field_value(fields, pitch_field, pitch_value)

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
    note = {
        "deckName": resolved["deck"],
        "modelName": resolved["model"],
        "fields": fields,
        "options": {"allowDuplicate": resolved["profile"]["duplicatePolicy"] == "allow"},
        "tags": tags,
    }
    note_id = anki.invoke("addNote", note=note)
    if not isinstance(note_id, int) or isinstance(note_id, bool) or note_id <= 0:
        if resolved["profile"]["duplicatePolicy"] == "prevent":
            raise HoshidictsMiningError(
                "This note already exists, or Anki rejected it as a duplicate.",
                409,
            )
        raise HoshidictsMiningError("Anki did not return a note ID.", 502)

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
    }
