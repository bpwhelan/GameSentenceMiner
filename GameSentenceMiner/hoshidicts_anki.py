from __future__ import annotations

import html
from typing import Any

from GameSentenceMiner.hoshidicts_mining_note import (
    HoshidictsMiningError,
    bounded_string,
    require_list,
)

ANKI_CONNECT_TIMEOUT_SECONDS = 1.25
NOTE_TIMEOUT_SECONDS = 10
MEDIA_TIMEOUT_SECONDS = 30
MAX_OPTION_NAMES = 4096


def get_anki_module():
    # Import lazily so loading Hoshidicts does not pull in GSM's Anki stack.
    from GameSentenceMiner import anki

    return anki


def invoke(action: str, *, timeout: float = ANKI_CONNECT_TIMEOUT_SECONDS, **params: Any) -> Any:
    return get_anki_module().invoke(action, timeout=timeout, **params)


def name_list(value: Any, label: str) -> list[str]:
    """Validate an AnkiConnect list of deck, note type or field names."""
    output = []
    seen = set()
    for item in require_list(value, label, MAX_OPTION_NAMES):
        name = bounded_string(item, label, 255, allow_empty=False)
        key = name.casefold()
        if key not in seen:
            seen.add(key)
            output.append(name)
    return output


def find_field(available_fields: list[str], requested: str) -> str | None:
    requested_key = requested.casefold()
    return next(
        (field for field in available_fields if field.casefold() == requested_key),
        None,
    )


def root_deck_name(deck_name: str) -> str:
    return deck_name.split("::", 1)[0]


def escape_query_value(value: str) -> str:
    """Escape a value for use inside a quoted Anki search term.

    ``*`` and ``_`` stay wildcards inside quotes, and a trailing backslash would
    escape the closing quote, so both have to be neutralised.
    """
    escaped = value.replace("\\", "\\\\")
    for character in ('"', "*", "_", ":"):
        escaped = escaped.replace(character, f"\\{character}")
    return escaped


def browse_word(word: str) -> None:
    """Open Anki's browser with a literal, collection-wide word search."""
    # Fields are stored as HTML, so the search text has to match that encoding.
    invoke("guiBrowse", query=f'"{escape_query_value(html.escape(word, quote=False))}"')


def store_media(filename: str, data_base64: str, *, label: str) -> str:
    stored_filename = invoke(
        "storeMediaFile",
        filename=filename,
        data=data_base64,
        timeout=MEDIA_TIMEOUT_SECONDS,
    )
    if not isinstance(stored_filename, str) or not stored_filename:
        raise HoshidictsMiningError(f"Anki did not return a stored {label} filename.", 502)
    return stored_filename


def store_dictionary_media(request: dict[str, Any]) -> None:
    for media in request.get("dictionaryMedia", []):
        try:
            media["filename"] = store_media(
                media["filename"],
                media["dataBase64"],
                label="dictionary media",
            )
        except HoshidictsMiningError:
            raise
        except Exception as exc:
            raise HoshidictsMiningError(
                f"Could not store Hoshidicts dictionary media: {exc}",
                502,
            ) from exc


def note_options(profile: dict[str, Any], deck_name: str) -> dict[str, Any]:
    duplicate_scope = profile["duplicateScope"]
    duplicate_scope_deck_name = None
    duplicate_scope_check_children = False
    if duplicate_scope == "deck-root":
        duplicate_scope = "deck"
        duplicate_scope_deck_name = root_deck_name(deck_name)
        duplicate_scope_check_children = True
    return {
        "allowDuplicate": not profile["checkForDuplicates"] or profile["duplicateBehavior"] != "prevent",
        "duplicateScope": duplicate_scope,
        "duplicateScopeOptions": {
            "deckName": duplicate_scope_deck_name,
            "checkChildren": duplicate_scope_check_children,
            "checkAllModels": profile["duplicateScopeCheckAllModels"],
        },
    }


def is_duplicate_error(value: Any) -> bool:
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


def _check_results(value: Any, expected_count: int, *, detailed: bool) -> list[Any]:
    valid = isinstance(value, list) and len(value) == expected_count
    if valid:
        valid = (
            all(isinstance(item, dict) and isinstance(item.get("canAdd"), bool) for item in value)
            if detailed
            else all(isinstance(item, bool) for item in value)
        )
    if not valid:
        raise HoshidictsMiningError("AnkiConnect returned invalid duplicate check results.", 502)
    return value


def check_duplicates(notes: list[dict[str, Any]], first_model_field: str) -> list[dict[str, Any]]:
    check_notes = [_duplicate_check_note(note, first_model_field, allow_duplicate=False) for note in notes]
    legacy_results = None
    try:
        details = _check_results(
            invoke("canAddNotesWithErrorDetail", notes=check_notes),
            len(notes),
            detailed=True,
        )
    except Exception as exc:
        if "unsupported action" not in str(exc).casefold():
            raise
        # Older AnkiConnect builds only report a boolean, so compare the answers
        # with and without duplicates allowed to recognise a duplicate.
        allow_notes = [_duplicate_check_note(note, first_model_field, allow_duplicate=True) for note in notes]
        legacy_results = list(
            zip(
                _check_results(invoke("canAddNotes", notes=allow_notes), len(notes), detailed=False),
                _check_results(invoke("canAddNotes", notes=check_notes), len(notes), detailed=False),
            )
        )

    results = []
    for item in details if legacy_results is None else legacy_results:
        raw_error = item.get("error") if isinstance(item, dict) else None
        error = raw_error if isinstance(raw_error, str) and raw_error else None
        results.append(
            {
                "duplicate": is_duplicate_error(error) if isinstance(item, dict) else item[0] != item[1],
                "addable": item.get("canAdd") is True if isinstance(item, dict) else item == (True, True),
                "error": error,
            }
        )
    return results


def duplicate_note_query(
    note: dict[str, Any],
    first_model_field: str,
    duplicate_scope: str,
) -> str:
    parts = []
    if duplicate_scope in {"deck", "deck-root"}:
        deck = note["deckName"] if duplicate_scope == "deck" else root_deck_name(note["deckName"])
        parts.append(f'"deck:{escape_query_value(deck)}"')
    field_value = str(note["fields"].get(first_model_field, ""))
    parts.append(f'"{first_model_field.lower()}:{escape_query_value(field_value)}"')
    return " ".join(parts)


def _positive_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _valid_note_ids(value: Any) -> list[int]:
    if not isinstance(value, list) or any(_positive_int(item) is None for item in value):
        raise HoshidictsMiningError("AnkiConnect returned invalid duplicate note IDs.", 502)
    return value


def _note_info_fields(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict) or not isinstance(value.get("fields"), dict):
        return None
    fields = {}
    for field_name, raw_value in value["fields"].items():
        if isinstance(raw_value, dict):
            raw_value = raw_value.get("value")
        if isinstance(field_name, str) and isinstance(raw_value, str):
            fields[field_name] = raw_value
    return fields


def _scoped_note_ids(
    note_infos: list[Any],
    duplicate_scope: str,
    deck_name: str,
) -> set[int] | None:
    """Note IDs with a card inside the deck scope, or None for the collection."""
    if duplicate_scope == "collection":
        return None
    card_ids = [
        card_id
        for info in note_infos
        if isinstance(info, dict) and isinstance(info.get("cards"), list)
        for card_id in info["cards"]
        if _positive_int(card_id) is not None
    ]
    if not card_ids:
        return set()
    card_infos = invoke("cardsInfo", cards=card_ids)
    if not isinstance(card_infos, list):
        raise HoshidictsMiningError("AnkiConnect returned invalid duplicate card details.", 502)
    target_deck = deck_name.casefold()
    target_root = root_deck_name(deck_name).casefold()
    matching_note_ids = set()
    for card in card_infos:
        if not isinstance(card, dict) or not isinstance(card.get("deckName"), str):
            continue
        note_id = _positive_int(card.get("note", card.get("noteId")))
        card_deck = card["deckName"].casefold()
        in_scope = (
            card_deck == target_deck
            if duplicate_scope == "deck"
            else card_deck == target_root or card_deck.startswith(f"{target_root}::")
        )
        if note_id is not None and in_scope:
            matching_note_ids.add(note_id)
    return matching_note_ids


def find_overwrite_target(
    note: dict[str, Any],
    first_model_field: str,
    *,
    duplicate_scope: str,
    deck: str,
    model: str,
) -> dict[str, Any] | None:
    """First existing note of the same type inside the configured scope."""
    note_ids = _valid_note_ids(
        invoke("findNotes", query=duplicate_note_query(note, first_model_field, duplicate_scope))
    )
    if not note_ids:
        return None
    note_infos = invoke("notesInfo", notes=note_ids)
    if not isinstance(note_infos, list):
        raise HoshidictsMiningError("AnkiConnect returned invalid duplicate note details.", 502)
    scoped_note_ids = _scoped_note_ids(note_infos, duplicate_scope, deck)
    infos_by_id = {
        info["noteId"]: info
        for info in note_infos
        if isinstance(info, dict) and _positive_int(info.get("noteId")) is not None
    }
    for note_id in note_ids:
        if scoped_note_ids is not None and note_id not in scoped_note_ids:
            continue
        info = infos_by_id.get(note_id)
        if not isinstance(info, dict) or not isinstance(info.get("modelName"), str):
            continue
        fields = _note_info_fields(info)
        if fields is None or info["modelName"].casefold() != model.casefold():
            continue
        return {"noteId": note_id, "fields": fields}
    return None
