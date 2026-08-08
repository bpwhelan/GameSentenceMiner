from __future__ import annotations

import html
import json
import math
import re
from typing import Any

MAX_REQUEST_BYTES = 256 * 1024
MAX_TEXT_LENGTH = 128 * 1024
MAX_TERM_LENGTH = 4096
MAX_GLOSSARIES = 64
MAX_METADATA_GROUPS = 64
MAX_METADATA_VALUES = 64
MAX_AUDIO_SOURCE_ID_LENGTH = 128
MAX_AUDIO_CANDIDATES = 32
_AUDIO_SOURCE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
_AUDIO_CANDIDATE_TOKEN_PATTERN = re.compile(r"^[a-f0-9]{64}$")

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


def bounded_string(
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


def require_list(value: Any, label: str, maximum: int) -> list[Any]:
    if not isinstance(value, list) or len(value) > maximum:
        raise HoshidictsMiningError(f"{label} is invalid.")
    return value


def _validate_glossary(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise HoshidictsMiningError("Hoshidicts glossary is invalid.")
    return {
        "dictionary": bounded_string(
            value.get("dictionary", ""),
            "Hoshidicts glossary dictionary",
            MAX_TERM_LENGTH,
            allow_empty=False,
        ),
        "glossary": bounded_string(
            value.get("glossary", ""),
            "Hoshidicts glossary",
            MAX_TEXT_LENGTH,
        ),
        "definitionTags": bounded_string(
            value.get("definitionTags", ""),
            "Hoshidicts definition tags",
            MAX_TERM_LENGTH,
        ),
        "termTags": bounded_string(
            value.get("termTags", ""),
            "Hoshidicts term tags",
            MAX_TERM_LENGTH,
        ),
    }


def _validate_frequency_group(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HoshidictsMiningError("Hoshidicts frequency group is invalid.")
    frequencies = []
    for item in require_list(
        value.get("frequencies", []),
        "Hoshidicts frequencies",
        MAX_METADATA_VALUES,
    ):
        if not isinstance(item, dict):
            raise HoshidictsMiningError("Hoshidicts frequency is invalid.")
        frequency_value = item.get("value")
        if (
            isinstance(frequency_value, bool)
            or not isinstance(frequency_value, (int, float))
            or (isinstance(frequency_value, float) and not math.isfinite(frequency_value))
        ):
            raise HoshidictsMiningError("Hoshidicts frequency is invalid.")
        display_value = item.get("displayValue")
        if display_value is not None:
            display_value = bounded_string(
                display_value,
                "Hoshidicts frequency display value",
                MAX_TERM_LENGTH,
            )
        frequencies.append(
            {
                "value": frequency_value,
                "displayValue": display_value,
            }
        )
    return {
        "dictionary": bounded_string(
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
    for item in require_list(
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
                "pattern": bounded_string(
                    item.get("pattern", ""),
                    "Hoshidicts pitch pattern",
                    MAX_TERM_LENGTH,
                ),
                "nasal": [
                    marker
                    for marker in require_list(
                        item.get("nasal", []),
                        "Hoshidicts nasal markers",
                        MAX_METADATA_VALUES,
                    )
                    if isinstance(marker, int) and not isinstance(marker, bool)
                ],
                "devoice": [
                    marker
                    for marker in require_list(
                        item.get("devoice", []),
                        "Hoshidicts devoice markers",
                        MAX_METADATA_VALUES,
                    )
                    if isinstance(marker, int) and not isinstance(marker, bool)
                ],
            }
        )
    transcriptions = [
        bounded_string(
            item,
            "Hoshidicts pitch transcription",
            MAX_TERM_LENGTH,
        )
        for item in require_list(
            value.get("transcriptions", []),
            "Hoshidicts pitch transcriptions",
            MAX_METADATA_VALUES,
        )
    ]
    return {
        "dictionary": bounded_string(
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


def highlight_sentence_match(request: dict[str, Any]) -> str:
    sentence = request["sentence"]
    matched = request["matched"]
    encoded = sentence.encode("utf-16-le")
    start = request["matchOffset"] * 2
    end = start + len(matched.encode("utf-16-le"))
    try:
        prefix = encoded[:start].decode("utf-16-le")
        highlighted = encoded[start:end].decode("utf-16-le")
        suffix = encoded[end:].decode("utf-16-le")
    except UnicodeDecodeError as exc:
        raise HoshidictsMiningError("Hoshidicts match offset splits a Unicode character.") from exc
    return f"{html.escape(prefix)}<b>{html.escape(highlighted)}</b>{html.escape(suffix)}"


def validate_hoshidicts_mining_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HoshidictsMiningError("Hoshidicts mining request must be an object.")
    sentence = bounded_string(
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
        for item in require_list(
            term.get("glossaries", []),
            "Hoshidicts glossaries",
            MAX_GLOSSARIES,
        )
    ]
    if not glossaries:
        raise HoshidictsMiningError("Hoshidicts lookup result has no definitions.")

    audio_selection = value.get("audioSelection")
    if audio_selection is not None:
        if not isinstance(audio_selection, dict) or set(audio_selection) != {
            "sourceId",
            "candidateIndex",
            "candidateToken",
        }:
            raise HoshidictsMiningError("Hoshidicts audio selection is invalid.")
        source_id = bounded_string(
            audio_selection.get("sourceId"),
            "Hoshidicts audio source ID",
            MAX_AUDIO_SOURCE_ID_LENGTH,
            allow_empty=False,
        )
        candidate_index = audio_selection.get("candidateIndex")
        candidate_token = audio_selection.get("candidateToken")
        if (
            _AUDIO_SOURCE_ID_PATTERN.fullmatch(source_id) is None
            or not isinstance(candidate_index, int)
            or isinstance(candidate_index, bool)
            or not 0 <= candidate_index < MAX_AUDIO_CANDIDATES
            or not isinstance(candidate_token, str)
            or _AUDIO_CANDIDATE_TOKEN_PATTERN.fullmatch(candidate_token) is None
        ):
            raise HoshidictsMiningError("Hoshidicts audio selection is invalid.")
        audio_selection = {
            "sourceId": source_id,
            "candidateIndex": candidate_index,
            "candidateToken": candidate_token,
        }

    normalized = {
        "matched": bounded_string(
            result.get("matched", ""),
            "Hoshidicts matched text",
            MAX_TERM_LENGTH,
            allow_empty=False,
        ),
        "deinflected": bounded_string(
            result.get("deinflected", ""),
            "Hoshidicts deinflected text",
            MAX_TERM_LENGTH,
        ),
        "trace": [
            {
                "name": bounded_string(
                    item.get("name", "") if isinstance(item, dict) else None,
                    "Hoshidicts trace name",
                    1024,
                    allow_empty=False,
                ),
                "description": bounded_string(
                    item.get("description", "") if isinstance(item, dict) else None,
                    "Hoshidicts trace description",
                    MAX_TERM_LENGTH,
                ),
            }
            for item in require_list(
                result.get("trace", []),
                "Hoshidicts trace",
                32,
            )
        ],
        "term": {
            "expression": bounded_string(
                term.get("expression", ""),
                "Hoshidicts expression",
                MAX_TERM_LENGTH,
                allow_empty=False,
            ),
            "reading": bounded_string(
                term.get("reading", ""),
                "Hoshidicts reading",
                MAX_TERM_LENGTH,
            ),
            "rules": bounded_string(
                term.get("rules", ""),
                "Hoshidicts rules",
                MAX_TERM_LENGTH,
            ),
            "glossaries": glossaries,
            "frequencies": [
                _validate_frequency_group(item)
                for item in require_list(
                    term.get("frequencies", []),
                    "Hoshidicts frequency groups",
                    MAX_METADATA_GROUPS,
                )
            ],
            "pitches": [
                _validate_pitch_group(item)
                for item in require_list(
                    term.get("pitches", []),
                    "Hoshidicts pitch groups",
                    MAX_METADATA_GROUPS,
                )
            ],
        },
        "sentence": sentence,
        "matchOffset": match_offset,
        "audioSelection": audio_selection,
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


def definition_html(result: dict[str, Any]) -> str:
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


def frequency_html(result: dict[str, Any]) -> str:
    groups = []
    for group in result["term"]["frequencies"]:
        values = [
            frequency["displayValue"] if frequency["displayValue"] is not None else str(frequency["value"])
            for frequency in group["frequencies"]
        ]
        if values:
            groups.append(
                f"<b>{html.escape(group['dictionary'])}</b>: " + ", ".join(html.escape(value) for value in values)
            )
    return "<br>".join(groups)


def pitch_html(result: dict[str, Any]) -> str:
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


def pitch_positions_text(result: dict[str, Any]) -> str:
    positions = []
    seen = set()
    for group in result["term"]["pitches"]:
        for pitch in group["pitches"]:
            position = pitch["position"]
            if position not in seen:
                seen.add(position)
                positions.append(str(position))
    return ", ".join(positions)
