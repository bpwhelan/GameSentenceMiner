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


# The mining payload is built by reader.js, which already applies these caps
# (:447-546), and the route is behind local_hoshidicts_only. Coerce each field
# to the shape the card builder indexes rather than re-deriving the caps.


def _text(value: Any, maximum: int = MAX_TEXT_LENGTH) -> str:
    return value.replace("\x00", "")[:maximum] if isinstance(value, str) else ""


def _items(value: Any, maximum: int) -> list[Any]:
    return value[:maximum] if isinstance(value, list) else []


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _integers(value: Any) -> list[int]:
    return [item for item in _items(value, MAX_METADATA_VALUES) if isinstance(item, int) and not isinstance(item, bool)]


def _glossary(value: Any) -> dict[str, str]:
    item = _record(value)
    return {
        "dictionary": _text(item.get("dictionary"), MAX_TERM_LENGTH),
        "glossary": _text(item.get("glossary")),
        "definitionTags": _text(item.get("definitionTags"), MAX_TERM_LENGTH),
        "termTags": _text(item.get("termTags"), MAX_TERM_LENGTH),
    }


def _frequency_group(value: Any) -> dict[str, Any]:
    group = _record(value)
    mode = group.get("frequencyMode")
    frequencies = []
    for raw in _items(group.get("frequencies"), MAX_METADATA_VALUES):
        item = _record(raw)
        number = item.get("value")
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
            continue
        display = item.get("displayValue")
        frequencies.append(
            {
                "value": number,
                "displayValue": None if display is None else _text(display, MAX_TERM_LENGTH),
            }
        )
    return {
        "dictionary": _text(group.get("dictionary"), MAX_TERM_LENGTH),
        "frequencyMode": mode if mode in {"rank-based", "occurrence-based"} else None,
        "frequencies": frequencies,
    }


def _pitch_group(value: Any) -> dict[str, Any]:
    group = _record(value)
    pitches = []
    for raw in _items(group.get("pitches"), MAX_METADATA_VALUES):
        item = _record(raw)
        position = item.get("position")
        if not isinstance(position, int) or isinstance(position, bool):
            continue
        pitches.append(
            {
                "position": position,
                "pattern": _text(item.get("pattern"), MAX_TERM_LENGTH),
                "nasal": _integers(item.get("nasal")),
                "devoice": _integers(item.get("devoice")),
            }
        )
    return {
        "dictionary": _text(group.get("dictionary"), MAX_TERM_LENGTH),
        "pitches": pitches,
        "transcriptions": [
            _text(item, MAX_TERM_LENGTH) for item in _items(group.get("transcriptions"), MAX_METADATA_VALUES)
        ],
    }


def _keyed_text(value: Any, maximum_entries: int, *keys: str) -> dict[str, str]:
    """Reads the {dictionary: text} maps, which arrive as a list or an object."""
    if isinstance(value, dict):
        entries = list(value.items())[:maximum_entries]
    else:
        entries = [
            (item.get("dictionary"), next((item[key] for key in keys if key in item), None))
            for item in (_record(raw) for raw in _items(value, maximum_entries))
        ]
    output = {}
    for raw_dictionary, raw_value in entries:
        if isinstance(raw_value, dict):
            raw_value = next((raw_value[key] for key in keys if key in raw_value), None)
        dictionary = _text(raw_dictionary, MAX_TERM_LENGTH)
        if dictionary:
            output[dictionary] = _text(raw_value, MAX_DICTIONARY_STYLE_BYTES)
    return output


def _dictionary_media(value: Any) -> list[dict[str, str]]:
    output = []
    seen = set()
    for raw in _items(value, MAX_DICTIONARY_MEDIA):
        item = _record(raw)
        dictionary = _text(item.get("dictionary"), MAX_TERM_LENGTH)
        path = _text(item.get("path"), MAX_TERM_LENGTH)
        media_type = _text(item.get("mediaType"), 64).lower()
        encoded = _text(item.get("dataBase64"), ((MAX_DICTIONARY_MEDIA_BYTES + 2) // 3) * 4)
        extension = _DICTIONARY_MEDIA_EXTENSIONS.get(media_type)
        key = (dictionary, path)
        if not dictionary or not path or extension is None or key in seen:
            continue
        # Still decoded here: the filename is a digest of the bytes, and an
        # undecodable payload would otherwise reach Anki as a broken attachment.
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            continue
        if not data or len(data) > MAX_DICTIONARY_MEDIA_BYTES:
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


def split_sentence_match(request: dict[str, Any]) -> tuple[str, str, str]:
    """Sentence split around the matched text, in the payload's UTF-16 offsets."""
    encoded = request["sentence"].encode("utf-16-le")
    start = request["matchOffset"] * 2
    end = start + len(request["matched"].encode("utf-16-le"))
    try:
        return (
            encoded[:start].decode("utf-16-le"),
            encoded[start:end].decode("utf-16-le"),
            encoded[end:].decode("utf-16-le"),
        )
    except UnicodeDecodeError as exc:
        raise HoshidictsMiningError("Hoshidicts match offset splits a Unicode character.") from exc


def highlight_sentence_match(request: dict[str, Any]) -> str:
    prefix, highlighted, suffix = split_sentence_match(request)
    return f"{html.escape(prefix)}<b>{html.escape(highlighted)}</b>{html.escape(suffix)}"


def validate_hoshidicts_mining_request(value: Any) -> dict[str, Any]:
    """Coerces one overlay-built mining payload into the shape Anki card building
    indexes. Only what the builder cannot recover from still raises."""
    request = _record(value)
    sentence = _text(request.get("sentence"))
    if not sentence:
        raise HoshidictsMiningError("Hoshidicts sentence is invalid.")

    raw_offset = request.get("matchOffset")
    if isinstance(raw_offset, bool) or not isinstance(raw_offset, (int, float)):
        raise HoshidictsMiningError("Hoshidicts match offset is invalid.")
    match_offset = int(raw_offset)
    if match_offset < 0:
        raise HoshidictsMiningError("Hoshidicts match offset is invalid.")

    result = _record(request.get("result"))
    term = _record(result.get("term"))
    glossaries = [_glossary(item) for item in _items(term.get("glossaries"), MAX_GLOSSARIES)]
    if not glossaries:
        raise HoshidictsMiningError("Hoshidicts lookup result has no definitions.")

    audio_selection = request.get("audioSelection")
    if audio_selection is not None:
        selection = _record(audio_selection)
        source_id = _text(selection.get("sourceId"), MAX_AUDIO_SOURCE_ID_LENGTH)
        candidate_index = selection.get("candidateIndex")
        candidate_id = selection.get("candidateId")
        if (
            not source_id
            or _AUDIO_SOURCE_ID_PATTERN.fullmatch(source_id) is None
            or not isinstance(candidate_index, int)
            or isinstance(candidate_index, bool)
            or candidate_index < 0
            or not isinstance(candidate_id, str)
            or _AUDIO_CANDIDATE_ID_PATTERN.fullmatch(candidate_id) is None
        ):
            # The id is a digest the audio pipeline matches against its own
            # candidate list, so a wrong one has to fail rather than default.
            raise HoshidictsMiningError("Hoshidicts audio selection is invalid.")
        audio_selection = {
            "sourceId": source_id,
            "candidateIndex": candidate_index,
            "candidateId": candidate_id,
        }

    matched = _text(result.get("matched"), MAX_TERM_LENGTH)
    normalized = {
        "matched": matched,
        "deinflected": _text(result.get("deinflected"), MAX_TERM_LENGTH),
        "trace": [
            {
                "name": _text(_record(item).get("name"), 1024),
                "description": _text(_record(item).get("description"), MAX_TERM_LENGTH),
            }
            for item in _items(result.get("trace"), 32)
        ],
        "term": {
            "expression": _text(term.get("expression"), MAX_TERM_LENGTH),
            "reading": _text(term.get("reading"), MAX_TERM_LENGTH),
            "rules": _text(term.get("rules"), MAX_TERM_LENGTH),
            "glossaries": glossaries,
            "frequencies": [_frequency_group(item) for item in _items(term.get("frequencies"), MAX_METADATA_GROUPS)],
            "pitches": [_pitch_group(item) for item in _items(term.get("pitches"), MAX_METADATA_GROUPS)],
        },
        "sentence": sentence,
        "matchOffset": match_offset,
        "audioSelection": audio_selection,
        "dictionaryStyles": _keyed_text(request.get("dictionaryStyles"), MAX_DICTIONARY_STYLES, "styles", "css"),
        "dictionaryAliases": _keyed_text(
            request.get("dictionaryAliases"), MAX_DICTIONARY_ALIASES, "alias", "displayName"
        ),
        "frequencyDictionaries": (
            None
            if request.get("frequencyDictionaries") is None
            else list(
                dict.fromkeys(
                    dictionary
                    for dictionary in (
                        _text(item, MAX_TERM_LENGTH)
                        for item in _items(request.get("frequencyDictionaries"), MAX_FREQUENCY_DICTIONARIES)
                    )
                    if dictionary
                )
            )
        ),
        "dictionaryMedia": _dictionary_media(request.get("dictionaryMedia")),
        "popupSelectionText": _text(request.get("popupSelectionText")),
        "documentTitle": _text(request.get("documentTitle"), MAX_TERM_LENGTH),
        "searchQuery": _text(request.get("searchQuery")),
    }
    # The card builder slices the sentence by this offset to highlight the match.
    if not _utf16_suffix(sentence, match_offset).startswith(matched):
        raise HoshidictsMiningError("Hoshidicts match offset does not point at the matched text.")
    return normalized


def _append_structured_text(value: Any, output: list[str], state: list[int], depth: int = 0) -> None:
    if state[0] >= MAX_STRUCTURED_CONTENT_NODES or depth > MAX_STRUCTURED_CONTENT_DEPTH:
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
            _append_structured_text(child, output, state, depth + 1)
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
        _append_structured_text(value["content"], output, state, depth + 1)
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
# Upper bound for a glossary image's height/width aspect-ratio percentage, so a
# subnormal/absurd width can't emit "padding-top: inf%" (or a runaway value).
MAX_IMAGE_ASPECT_PERCENT = 100_000
_STRUCTURED_HREF_PATTERN = re.compile(r"^(?:https?:|\?)", re.IGNORECASE)


def _plain_glossary_html(value: str) -> str:
    lines = [line.strip() for line in value.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return "<br>".join(html.escape(line) for line in lines if line)


def _structured_link_href(value: dict[str, Any]) -> str | None:
    """A structured-content link target, or None when the dictionary's is unusable.

    Yomitan's schema only permits http(s) and internal "?" query links, so an
    installed dictionary cannot smuggle a "javascript:" URL onto a mined card.
    """
    href = value.get("href")
    return href if isinstance(href, str) and _STRUCTURED_HREF_PATTERN.match(href) else None


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
        href = _structured_link_href(value)
        if href is not None:
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
        # A subnormal width (e.g. 1e-320) passes the ``> 0`` guard yet overflows
        # height/width to inf, emitting an invalid "padding-top: inf%". Clamp the
        # aspect-ratio percentage to a finite, bounded value.
        aspect_percent = height / width * 100
        if not math.isfinite(aspect_percent):
            aspect_percent = MAX_IMAGE_ASPECT_PERCENT
        aspect_percent = min(aspect_percent, MAX_IMAGE_ASPECT_PERCENT)
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
            f'<span class="gloss-image-sizer" style="padding-top: {aspect_percent}%"></span>'
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
        href = _structured_link_href(value)
        if href is not None and not href.startswith("?"):
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


def _frequency_number_text(value: int | float) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def frequency_html(result: dict[str, Any]) -> str:
    groups = []
    for group in result["term"]["frequencies"]:
        values = [
            frequency["displayValue"]
            if frequency["displayValue"] is not None
            else _frequency_number_text(frequency["value"])
            for frequency in group["frequencies"]
        ]
        if values:
            groups.append(
                f"<b>{html.escape(group['dictionary'])}</b>: " + ", ".join(html.escape(value) for value in values)
            )
    return "<br>".join(groups)


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
