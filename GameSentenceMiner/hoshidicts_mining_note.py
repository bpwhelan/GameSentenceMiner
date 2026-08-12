from __future__ import annotations

import base64
import binascii
import hashlib
import html
import json
import math
import re
from typing import Any

MAX_REQUEST_BYTES = 64 * 1024 * 1024
MAX_TEXT_LENGTH = MAX_REQUEST_BYTES
MAX_TERM_LENGTH = 4096
MAX_GLOSSARIES = 1_048_576
MAX_METADATA_GROUPS = 1_048_576
MAX_METADATA_VALUES = 1_048_576
MAX_DICTIONARY_STYLES = 256
MAX_DICTIONARY_STYLE_BYTES = 256 * 1024
MAX_DICTIONARY_STYLE_NESTING = 32
MAX_DICTIONARY_ALIASES = 256
MAX_FREQUENCY_DICTIONARIES = 256
MAX_DICTIONARY_MEDIA = 256
MAX_DICTIONARY_MEDIA_BYTES = 4 * 1024 * 1024
MAX_AUDIO_SOURCE_ID_LENGTH = 128
MAX_AUDIO_CANDIDATES = 32
_AUDIO_SOURCE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
_AUDIO_CANDIDATE_ID_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_DICTIONARY_MEDIA_EXTENSIONS = {
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpeg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
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
    frequency_mode = value.get("frequencyMode")
    if frequency_mode not in {None, "rank-based", "occurrence-based"}:
        raise HoshidictsMiningError("Hoshidicts frequency mode is invalid.")
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
        "frequencyMode": frequency_mode,
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


def _validate_dictionary_styles(value: Any) -> dict[str, str]:
    if value is None:
        return {}
    if isinstance(value, list):
        if len(value) > MAX_DICTIONARY_STYLES:
            raise HoshidictsMiningError("Hoshidicts dictionary styles are invalid.")
        entries = []
        for item in value:
            if not isinstance(item, dict):
                raise HoshidictsMiningError("Hoshidicts dictionary styles are invalid.")
            entries.append(
                (
                    item.get("dictionary"),
                    item.get("styles", item.get("css")),
                )
            )
    elif isinstance(value, dict):
        if len(value) > MAX_DICTIONARY_STYLES:
            raise HoshidictsMiningError("Hoshidicts dictionary styles are invalid.")
        entries = []
        for dictionary, styles in value.items():
            if isinstance(styles, dict):
                styles = styles.get("styles", styles.get("css"))
            entries.append((dictionary, styles))
    else:
        raise HoshidictsMiningError("Hoshidicts dictionary styles are invalid.")

    output = {}
    for raw_dictionary, raw_styles in entries:
        dictionary = bounded_string(
            raw_dictionary,
            "Hoshidicts dictionary style name",
            MAX_TERM_LENGTH,
            allow_empty=False,
        )
        styles = bounded_string(
            raw_styles,
            "Hoshidicts dictionary styles",
            MAX_DICTIONARY_STYLE_BYTES,
        )
        if len(styles.encode("utf-8")) > MAX_DICTIONARY_STYLE_BYTES:
            raise HoshidictsMiningError("Hoshidicts dictionary styles are invalid.")
        output[dictionary] = styles
    return output


def _validate_dictionary_aliases(value: Any) -> dict[str, str]:
    if value is None:
        return {}
    if isinstance(value, list):
        if len(value) > MAX_DICTIONARY_ALIASES:
            raise HoshidictsMiningError("Hoshidicts dictionary aliases are invalid.")
        entries = [
            (item.get("dictionary"), item.get("alias", item.get("displayName")))
            for item in value
            if isinstance(item, dict)
        ]
        if len(entries) != len(value):
            raise HoshidictsMiningError("Hoshidicts dictionary aliases are invalid.")
    elif isinstance(value, dict):
        if len(value) > MAX_DICTIONARY_ALIASES:
            raise HoshidictsMiningError("Hoshidicts dictionary aliases are invalid.")
        entries = list(value.items())
    else:
        raise HoshidictsMiningError("Hoshidicts dictionary aliases are invalid.")

    aliases = {}
    for raw_dictionary, raw_alias in entries:
        dictionary = bounded_string(
            raw_dictionary,
            "Hoshidicts dictionary alias name",
            MAX_TERM_LENGTH,
            allow_empty=False,
        )
        alias = bounded_string(
            raw_alias,
            "Hoshidicts dictionary alias",
            MAX_TERM_LENGTH,
            allow_empty=False,
        )
        aliases[dictionary] = alias
    return aliases


def _validate_frequency_dictionaries(value: Any) -> list[str] | None:
    if value is None:
        return None
    entries = require_list(
        value,
        "Hoshidicts frequency dictionaries",
        MAX_FREQUENCY_DICTIONARIES,
    )
    dictionaries = []
    seen = set()
    for raw_dictionary in entries:
        dictionary = bounded_string(
            raw_dictionary,
            "Hoshidicts frequency dictionary name",
            MAX_TERM_LENGTH,
            allow_empty=False,
        )
        if dictionary in seen:
            continue
        seen.add(dictionary)
        dictionaries.append(dictionary)
    return dictionaries


def _validate_dictionary_media(value: Any) -> list[dict[str, str]]:
    if value is None:
        return []
    entries = require_list(value, "Hoshidicts dictionary media", MAX_DICTIONARY_MEDIA)
    output = []
    seen = set()
    for item in entries:
        if not isinstance(item, dict):
            raise HoshidictsMiningError("Hoshidicts dictionary media is invalid.")
        dictionary = bounded_string(
            item.get("dictionary"),
            "Hoshidicts dictionary media name",
            MAX_TERM_LENGTH,
            allow_empty=False,
        )
        path = bounded_string(
            item.get("path"),
            "Hoshidicts dictionary media path",
            MAX_TERM_LENGTH,
            allow_empty=False,
        )
        media_type = bounded_string(
            item.get("mediaType"),
            "Hoshidicts dictionary media type",
            64,
            allow_empty=False,
        ).lower()
        extension = _DICTIONARY_MEDIA_EXTENSIONS.get(media_type)
        encoded = bounded_string(
            item.get("dataBase64"),
            "Hoshidicts dictionary media data",
            ((MAX_DICTIONARY_MEDIA_BYTES + 2) // 3) * 4,
            allow_empty=False,
        )
        if extension is None:
            raise HoshidictsMiningError("Hoshidicts dictionary media is invalid.")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HoshidictsMiningError("Hoshidicts dictionary media is invalid.") from exc
        if not data or len(data) > MAX_DICTIONARY_MEDIA_BYTES:
            raise HoshidictsMiningError("Hoshidicts dictionary media is invalid.")
        key = (dictionary, path)
        if key in seen:
            continue
        seen.add(key)
        output.append(
            {
                "dictionary": dictionary,
                "path": path,
                "mediaType": media_type,
                "dataBase64": encoded,
                "filename": (
                    f"yomitan_dictionary_media_{hashlib.sha1(data, usedforsecurity=False).hexdigest()}{extension}"
                ),
            }
        )
    return output


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
            "candidateId",
        }:
            raise HoshidictsMiningError("Hoshidicts audio selection is invalid.")
        source_id = bounded_string(
            audio_selection.get("sourceId"),
            "Hoshidicts audio source ID",
            MAX_AUDIO_SOURCE_ID_LENGTH,
            allow_empty=False,
        )
        candidate_index = audio_selection.get("candidateIndex")
        candidate_id = audio_selection.get("candidateId")
        if (
            _AUDIO_SOURCE_ID_PATTERN.fullmatch(source_id) is None
            or not isinstance(candidate_index, int)
            or isinstance(candidate_index, bool)
            or not 0 <= candidate_index < MAX_AUDIO_CANDIDATES
            or not isinstance(candidate_id, str)
            or _AUDIO_CANDIDATE_ID_PATTERN.fullmatch(candidate_id) is None
        ):
            raise HoshidictsMiningError("Hoshidicts audio selection is invalid.")
        audio_selection = {
            "sourceId": source_id,
            "candidateIndex": candidate_index,
            "candidateId": candidate_id,
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
        "dictionaryStyles": _validate_dictionary_styles(value.get("dictionaryStyles")),
        "dictionaryAliases": _validate_dictionary_aliases(value.get("dictionaryAliases")),
        "frequencyDictionaries": _validate_frequency_dictionaries(value.get("frequencyDictionaries")),
        "dictionaryMedia": _validate_dictionary_media(value.get("dictionaryMedia")),
        "popupSelectionText": bounded_string(
            value.get("popupSelectionText", ""),
            "Hoshidicts popup selection text",
            MAX_TEXT_LENGTH,
        ),
        "documentTitle": bounded_string(
            value.get("documentTitle", ""),
            "Hoshidicts document title",
            MAX_TERM_LENGTH,
        ),
        "searchQuery": bounded_string(
            value.get("searchQuery", ""),
            "Hoshidicts search query",
            MAX_TEXT_LENGTH,
        ),
    }
    if not _utf16_suffix(sentence, match_offset).startswith(normalized["matched"]):
        raise HoshidictsMiningError("Hoshidicts match offset does not point at the matched text.")
    return normalized


def _append_structured_text(value: Any, output: list[str], state: list[int]) -> None:
    if state[0] >= MAX_STRUCTURED_CONTENT_NODES:
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


STRUCTURED_CONTENT_TAGS = {
    "a",
    "br",
    "code",
    "details",
    "div",
    "em",
    "li",
    "ol",
    "p",
    "rp",
    "rt",
    "ruby",
    "small",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
}
STRUCTURED_CONTENT_STYLE_PROPERTIES = {
    "background": "background",
    "backgroundColor": "background-color",
    "borderColor": "border-color",
    "borderRadius": "border-radius",
    "borderStyle": "border-style",
    "borderWidth": "border-width",
    "clipPath": "clip-path",
    "color": "color",
    "cursor": "cursor",
    "fontSize": "font-size",
    "fontStyle": "font-style",
    "fontWeight": "font-weight",
    "listStyleType": "list-style-type",
    "margin": "margin",
    "marginBottom": "margin-bottom",
    "marginLeft": "margin-left",
    "marginRight": "margin-right",
    "marginTop": "margin-top",
    "padding": "padding",
    "paddingBottom": "padding-bottom",
    "paddingLeft": "padding-left",
    "paddingRight": "padding-right",
    "paddingTop": "padding-top",
    "textAlign": "text-align",
    "textDecorationColor": "text-decoration-color",
    "textDecorationLine": "text-decoration-line",
    "textDecorationStyle": "text-decoration-style",
    "textEmphasis": "text-emphasis",
    "textShadow": "text-shadow",
    "verticalAlign": "vertical-align",
    "whiteSpace": "white-space",
    "wordBreak": "word-break",
}
STRUCTURED_CONTENT_EM_PROPERTIES = {
    "marginBottom",
    "marginLeft",
    "marginRight",
    "marginTop",
}
MAX_STRUCTURED_CONTENT_NODES = 1_048_576
MAX_STRUCTURED_CONTENT_DEPTH = 64


def _plain_glossary_html(value: str) -> str:
    lines = [line.strip() for line in value.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return "<br>".join(html.escape(line) for line in lines if line)


def _structured_data_attribute_name(value: str) -> str | None:
    value = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", value)
    value = re.sub(r"_+", "-", value)
    value = re.sub(r"[^A-Za-z0-9_-]+", "-", value).strip("-").lower()
    return f"data-sc-{value}" if value else None


def _structured_style_attribute(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    declarations = []
    for key, raw_style_value in value.items():
        property_name = STRUCTURED_CONTENT_STYLE_PROPERTIES.get(key)
        if property_name is None:
            continue
        if key == "textDecorationLine" and isinstance(raw_style_value, list):
            if not all(isinstance(item, str) for item in raw_style_value):
                continue
            style_value = " ".join(raw_style_value)
        elif isinstance(raw_style_value, str):
            style_value = raw_style_value
        elif (
            key in STRUCTURED_CONTENT_EM_PROPERTIES
            and isinstance(raw_style_value, (int, float))
            and not isinstance(raw_style_value, bool)
            and math.isfinite(raw_style_value)
        ):
            style_value = f"{raw_style_value}em"
        else:
            continue
        if style_value:
            declarations.append(f"{property_name}: {style_value}")
    return "; ".join(declarations)


def _structured_content_attributes(value: dict[str, Any], tag: str) -> str:
    attributes = []
    class_name = "gloss-link" if tag == "a" else f"gloss-sc-{tag}"
    attributes.append(("class", class_name))

    data = value.get("data")
    if isinstance(data, dict):
        for raw_key, raw_value in data.items():
            if not isinstance(raw_key, str) or not isinstance(raw_value, (str, int, float, bool)):
                continue
            key = _structured_data_attribute_name(raw_key)
            if key is not None:
                attributes.append((key, str(raw_value).lower() if isinstance(raw_value, bool) else str(raw_value)))

    lang = value.get("lang")
    if isinstance(lang, str) and lang:
        attributes.append(("lang", lang))
    title = value.get("title")
    if isinstance(title, str) and title:
        attributes.append(("title", title))
    style = _structured_style_attribute(value.get("style"))
    if style:
        attributes.append(("style", style))
    if tag in {"td", "th"}:
        for source, target in (("colSpan", "colspan"), ("rowSpan", "rowspan")):
            span = value.get(source)
            if isinstance(span, int) and not isinstance(span, bool) and span > 0:
                attributes.append((target, str(span)))
    if tag == "details" and value.get("open") is True:
        attributes.append(("open", None))
    if tag == "a":
        href = value.get("href")
        if isinstance(href, str):
            attributes.append(("href", href))
            attributes.append(("data-external", "false" if href.startswith("?") else "true"))

    return "".join(
        f" {key}" if attribute_value is None else f' {key}="{html.escape(attribute_value, quote=True)}"'
        for key, attribute_value in attributes
    )


def _structured_content_html(
    value: Any,
    state: list[int] | None = None,
    depth: int = 0,
    *,
    dictionary: str = "",
    dictionary_media: dict[tuple[str, str], str] | None = None,
) -> str:
    if state is None:
        state = [0]
    if state[0] >= MAX_STRUCTURED_CONTENT_NODES or depth > MAX_STRUCTURED_CONTENT_DEPTH:
        return ""
    state[0] += 1
    if isinstance(value, str):
        return html.escape(value)
    if isinstance(value, (int, float, bool)):
        return html.escape(str(value))
    if isinstance(value, list):
        return "".join(
            _structured_content_html(
                item,
                state,
                depth + 1,
                dictionary=dictionary,
                dictionary_media=dictionary_media,
            )
            for item in value
        )
    if not isinstance(value, dict):
        return ""
    if value.get("type") == "text" and isinstance(value.get("text"), str):
        return _plain_glossary_html(value["text"])
    if value.get("type") == "structured-content":
        return _structured_content_html(
            value.get("content"),
            state,
            depth + 1,
            dictionary=dictionary,
            dictionary_media=dictionary_media,
        )

    tag = str(value.get("tag") or "").lower()
    if value.get("type") == "image":
        tag = "img"
    if tag == "img":
        path = value.get("path")
        filename = (
            dictionary_media.get((dictionary, path)) if dictionary_media is not None and isinstance(path, str) else None
        )
        if not isinstance(filename, str) or not filename:
            return ""
        width = value.get("preferredWidth", value.get("width", 100))
        height = value.get("preferredHeight", value.get("height", 100))
        width = width if isinstance(width, (int, float)) and not isinstance(width, bool) and width > 0 else 100
        height = height if isinstance(height, (int, float)) and not isinstance(height, bool) and height > 0 else 100
        appearance = value.get("appearance", "auto")
        image_rendering = value.get("imageRendering", "pixelated" if value.get("pixelated") is True else "auto")
        return (
            '<a class="gloss-image-link" target="_blank" rel="noreferrer noopener" '
            f'href="{html.escape(filename, quote=True)}" '
            f'data-path="{html.escape(path, quote=True)}" '
            f'data-dictionary="{html.escape(dictionary, quote=True)}" data-image-load-state="loaded" '
            'data-has-aspect-ratio="true" '
            f'data-image-rendering="{html.escape(str(image_rendering), quote=True)}" '
            f'data-appearance="{html.escape(str(appearance), quote=True)}" '
            f'data-background="{str(value.get("background", True)).lower()}" '
            f'data-collapsed="{str(value.get("collapsed", False)).lower()}" '
            f'data-collapsible="{str(value.get("collapsible", True)).lower()}">'
            f'<span class="gloss-image-container" style="width: {width}em">'
            f'<span class="gloss-image-sizer" style="padding-top: {height / width * 100}%"></span>'
            f'<span class="gloss-image-background" style="--image: url(&quot;{html.escape(filename, quote=True)}&quot;)"></span>'
            '<span class="gloss-image-container-overlay"></span>'
            f'<img class="gloss-image" src="{html.escape(filename, quote=True)}" '
            'style="width: 100%; height: 100%"></span>'
            '<span class="gloss-image-link-text">Image</span></a>'
        )
    content = _structured_content_html(
        value.get("content"),
        state,
        depth + 1,
        dictionary=dictionary,
        dictionary_media=dictionary_media,
    )
    if tag in IGNORED_STRUCTURED_TAGS:
        return ""
    if tag not in STRUCTURED_CONTENT_TAGS:
        return content
    attributes = _structured_content_attributes(value, tag)
    if tag == "br":
        return f"<br{attributes}>"
    if tag == "a":
        content = f'<span class="gloss-link-text">{content}</span>'
        href = value.get("href")
        if isinstance(href, str) and not href.startswith("?"):
            content += '<span class="gloss-link-external-icon icon" data-icon="external-link"></span>'
    rendered = f"<{tag}{attributes}>{content}</{tag}>"
    if tag == "table":
        return f'<div class="gloss-sc-table-container">{rendered}</div>'
    return rendered


def _render_glossary_content(
    value: str,
    dictionary: str,
    dictionary_media: dict[tuple[str, str], str],
) -> str:
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return _plain_glossary_html(value)
    if isinstance(parsed, str):
        return _plain_glossary_html(parsed)
    if isinstance(parsed, list):
        state = [1]
        parts = []
        for item in parsed:
            if isinstance(item, str):
                if state[0] >= MAX_STRUCTURED_CONTENT_NODES:
                    break
                state[0] += 1
                rendered_item = _plain_glossary_html(item)
            else:
                rendered_item = _structured_content_html(
                    item,
                    state,
                    1,
                    dictionary=dictionary,
                    dictionary_media=dictionary_media,
                )
            if rendered_item and isinstance(item, dict) and item.get("type") == "structured-content":
                rendered_item = f'<span class="structured-content">{rendered_item}</span>'
            parts.append(rendered_item)
        rendered = "".join(parts)
    else:
        rendered = _structured_content_html(
            parsed,
            dictionary=dictionary,
            dictionary_media=dictionary_media,
        )
    if rendered:
        return (
            f'<span class="structured-content">{rendered}</span>'
            if (isinstance(parsed, dict) and parsed.get("type") == "structured-content")
            else rendered
        )
    return _plain_glossary_html(_glossary_text(value))


def _dictionary_groups(result: dict[str, Any]) -> list[tuple[str, list[dict[str, str]]]]:
    groups: dict[str, list[dict[str, str]]] = {}
    for glossary in result["term"]["glossaries"]:
        groups.setdefault(glossary["dictionary"], []).append(glossary)
    return list(groups.items())


def first_dictionary(result: dict[str, Any]) -> str:
    groups = _dictionary_groups(result)
    return groups[0][0] if groups else ""


def _glossary_entry_html(
    glossary: dict[str, str],
    dictionary: str,
    dictionary_alias: str,
    dictionary_media: dict[tuple[str, str], str],
    *,
    brief: bool = False,
    no_dictionary: bool = False,
) -> str:
    labels = []
    if not brief:
        labels.extend(
            value
            for value in (
                glossary["definitionTags"],
                glossary["termTags"],
            )
            if value
        )
        if dictionary and not no_dictionary:
            labels.append(dictionary_alias)
    prefix = f'<i class="yomitan-glossary-meta">({html.escape(", ".join(labels))})</i> ' if labels else ""
    return prefix + _render_glossary_content(
        glossary["glossary"],
        dictionary,
        dictionary_media,
    )


def _css_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\a ")


def _css_scan(value: str, start: int = 0):
    """Yield (index, character, nesting) for characters outside comments and strings."""
    quote = None
    escaped = False
    comment = False
    parentheses = 0
    brackets = 0
    index = start
    while index < len(value):
        character = value[index]
        following = value[index + 1] if index + 1 < len(value) else ""
        if comment:
            if character == "*" and following == "/":
                comment = False
                index += 2
                continue
        elif quote is not None:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                quote = None
        elif character == "/" and following == "*":
            comment = True
            index += 2
            continue
        elif character in {'"', "'"}:
            quote = character
        elif character == "(":
            parentheses += 1
        elif character == ")" and parentheses:
            parentheses -= 1
        elif character == "[":
            brackets += 1
        elif character == "]" and brackets:
            brackets -= 1
        else:
            yield index, character, parentheses + brackets
        index += 1


def _css_next_delimiter(value: str, start: int) -> tuple[int, str] | None:
    return next(
        (
            (index, character)
            for index, character, nesting in _css_scan(value, start)
            if not nesting and character in {"{", ";"}
        ),
        None,
    )


def _css_matching_brace(value: str, opening: int) -> int | None:
    depth = 1
    for index, character, _nesting in _css_scan(value, opening + 1):
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return index
    return None


def _split_css_selectors(value: str) -> list[str]:
    selectors = []
    start = 0
    for index, character, nesting in _css_scan(value):
        if character == "," and not nesting:
            selectors.append(value[start:index].strip())
            start = index + 1
    selectors.append(value[start:].strip())
    return [selector for selector in selectors if selector]


def _split_css_leading_trivia(value: str) -> tuple[str, str]:
    index = 0
    while index < len(value):
        while index < len(value) and value[index].isspace():
            index += 1
        if not value.startswith("/*", index):
            break
        closing = value.find("*/", index + 2)
        if closing < 0:
            return value, ""
        index = closing + 2
    return value[:index], value[index:]


def _scope_dictionary_css(styles: str, selector: str, depth: int = 0) -> str:
    if depth >= MAX_DICTIONARY_STYLE_NESTING:
        return ""
    output = []
    cursor = 0
    while cursor < len(styles):
        delimiter = _css_next_delimiter(styles, cursor)
        if delimiter is None:
            output.append(styles[cursor:])
            break
        index, character = delimiter
        if character == ";":
            output.append(styles[cursor : index + 1])
            cursor = index + 1
            continue
        closing = _css_matching_brace(styles, index)
        if closing is None:
            output.append(styles[cursor:])
            break
        prelude = styles[cursor:index]
        leading, rule_prelude = _split_css_leading_trivia(prelude)
        stripped = rule_prelude.strip()
        body = styles[index + 1 : closing]
        lowered = stripped.casefold()
        if lowered.startswith("@scope"):
            output.append(leading + _scope_dictionary_css(body, selector, depth + 1))
        elif lowered.startswith(("@media", "@supports", "@container", "@layer", "@document")):
            output.append(f"{leading}{rule_prelude}{{{_scope_dictionary_css(body, selector, depth + 1)}}}")
        elif lowered.startswith("@") or not stripped:
            output.append(f"{leading}{rule_prelude}{{{body}}}")
        else:
            scoped_selectors = ", ".join(f"{selector} {item}" for item in _split_css_selectors(stripped))
            output.append(f"{leading}{scoped_selectors}{{{body}}}")
        cursor = closing + 1
    return "".join(output)


def _dictionary_style_html(dictionary: str, styles: str) -> str:
    if not styles.strip():
        return ""
    selector = f'.yomitan-glossary [data-dictionary="{_css_string(dictionary)}"]'
    return f"<style>{_scope_dictionary_css(styles, selector)}</style>"


def definition_html(
    result: dict[str, Any],
    *,
    first_only: bool = False,
    brief: bool = False,
    no_dictionary: bool = False,
    selected_dictionary: str | None = None,
) -> str:
    groups = _dictionary_groups(result)
    if selected_dictionary is not None:
        groups = [group for group in groups if group[0] == selected_dictionary]
    if first_only:
        groups = groups[:1]
    if not groups:
        return ""
    pages = []
    style_blocks = []
    dictionary_styles = result.get("dictionaryStyles", {})
    dictionary_aliases = result.get("dictionaryAliases", {})
    dictionary_media = {
        (entry["dictionary"], entry["path"]): entry["filename"] for entry in result.get("dictionaryMedia", [])
    }
    for dictionary, glossaries in groups:
        dictionary_alias = dictionary_aliases.get(dictionary, dictionary)
        entries = [
            _glossary_entry_html(
                glossary,
                dictionary,
                dictionary_alias,
                dictionary_media,
                brief=brief,
                no_dictionary=no_dictionary,
            )
            for glossary in glossaries
        ]
        content = (
            entries[0] if len(entries) == 1 else "<ul>" + "".join(f"<li>{entry}</li>" for entry in entries) + "</ul>"
        )
        pages.append(f'<li data-dictionary="{html.escape(dictionary, quote=True)}">{content}</li>')
        styles = dictionary_styles.get(dictionary) if isinstance(dictionary_styles, dict) else None
        if isinstance(styles, str):
            style_blocks.append(_dictionary_style_html(dictionary, styles))

    details = []
    term = result["term"]
    if not brief and term["rules"]:
        details.append(f"Rules: {html.escape(term['rules'])}")
    if not brief and result["trace"]:
        details.append("Deinflection: " + " &gt; ".join(html.escape(step["name"]) for step in result["trace"]))
    details_html = f'<small class="yomitan-glossary-details">{"<br>".join(details)}</small>' if details else ""
    return (
        '<div style="text-align: left;" class="yomitan-glossary"><ol>'
        + "".join(pages)
        + "</ol>"
        + "".join(style_blocks)
        + details_html
        + "</div>"
    )


def main_definition_html(result: dict[str, Any]) -> str:
    return definition_html(result, first_only=True)


def plain_definition_html(
    result: dict[str, Any],
    *,
    no_dictionary: bool = False,
    selected_dictionary: str | None = None,
) -> str:
    groups = _dictionary_groups(result)
    if selected_dictionary is not None:
        groups = [group for group in groups if group[0] == selected_dictionary]
    rendered_groups = []
    dictionary_aliases = result.get("dictionaryAliases", {})
    for dictionary, glossaries in groups:
        lines = []
        if not no_dictionary:
            lines.append(f"({html.escape(dictionary_aliases.get(dictionary, dictionary))})")
        lines.extend(
            rendered
            for glossary in glossaries
            if (rendered := _plain_glossary_html(_glossary_text(glossary["glossary"])))
        )
        if lines:
            rendered_groups.append("<br>".join(lines))
    return "<br>".join(rendered_groups)


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


def _frequency_number_text(value: int | float) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def single_frequency_html(
    result: dict[str, Any],
    selected_dictionary: str,
) -> str:
    items = []
    dictionary_aliases = result.get("dictionaryAliases", {})
    for group in result["term"]["frequencies"]:
        dictionary = group["dictionary"]
        if dictionary != selected_dictionary:
            continue
        dictionary_alias = html.escape(dictionary_aliases.get(dictionary, dictionary))
        for frequency in group["frequencies"]:
            display_value = frequency["displayValue"]
            value = display_value if display_value is not None else _frequency_number_text(frequency["value"])
            items.append(f"<li>{dictionary_alias}: {html.escape(value)}</li>")
    if not items:
        return ""
    return '<ul style="text-align: left;">' + "".join(items) + "</ul>"


def single_frequency_number_text(
    result: dict[str, Any],
    selected_dictionary: str,
) -> str:
    for group in result["term"]["frequencies"]:
        if group["dictionary"] != selected_dictionary or not group["frequencies"]:
            continue
        frequency = group["frequencies"][0]
        display_value = frequency["displayValue"]
        if display_value is not None:
            match = re.match(r"^[0-9]+", display_value)
            if match is not None:
                parsed = int(match.group(0))
                if parsed > 0:
                    return str(parsed)
        value = frequency["value"]
        return _frequency_number_text(value) if value > 0 else ""
    return ""


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
