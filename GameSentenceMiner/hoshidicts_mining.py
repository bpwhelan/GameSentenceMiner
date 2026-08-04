"""Typed HoshiDicts base-note creation through AnkiConnect."""

from __future__ import annotations

import base64
import binascii
import hashlib
import html
import json
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import asdict, dataclass, replace
from typing import Any, Callable, Optional

import requests

from GameSentenceMiner.util.config.configuration import get_config, gsm_state, logger
from GameSentenceMiner.util.models.model import (
    DictionaryMineLookup,
    DictionaryMineMedia,
    DictionaryMineReadiness,
    DictionaryMineRequest,
    DictionaryMineResult,
)
from GameSentenceMiner.util.text_log import get_line_by_id

HOSHI_SOURCE_TAG = "gsm_hoshidicts"
HOSHI_FINGERPRINT_TAG_PREFIX = "gsm_hoshi_id_"
HOSHI_LINE_TAG_PREFIX = "gsm_line_id_"

MAX_REQUEST_STRING_BYTES = 32 * 1024
MAX_SENTENCE_BYTES = 128 * 1024
MAX_GLOSSARY_BYTES = 256 * 1024
MAX_MEDIA_ITEMS = 4
MAX_MEDIA_BYTES = 2 * 1024 * 1024
MAX_TOTAL_MEDIA_BYTES = 8 * 1024 * 1024
MAX_IDEMPOTENCY_ENTRIES = 512
SUPPORTED_MEDIA_TYPES = {
    "image/gif": ("gif", (b"GIF87a", b"GIF89a")),
    "image/jpeg": ("jpg", (b"\xff\xd8\xff",)),
    "image/png": ("png", (b"\x89PNG\r\n\x1a\n",)),
    "image/webp": ("webp", (b"RIFF",)),
}


class DictionaryMineValidationError(ValueError):
    pass


@dataclass(frozen=True)
class _MiningConfiguration:
    deck: str
    model: str
    expression_field: str
    reading_field: str
    glossary_field: str
    sentence_field: str
    dictionary_field: str
    frequency_field: str
    pitch_field: str


@dataclass
class _PendingRequest:
    signature: str
    event: threading.Event
    result: Optional[DictionaryMineResult] = None


@dataclass(frozen=True)
class _CachedResult:
    signature: str
    result: DictionaryMineResult


def _bounded_string(
    value: Any,
    label: str,
    *,
    required: bool = False,
    max_bytes: int = MAX_REQUEST_STRING_BYTES,
) -> str:
    if not isinstance(value, str):
        raise DictionaryMineValidationError(f"{label} must be a string.")
    if "\x00" in value or any(ord(character) < 32 and character not in "\r\n\t" for character in value):
        raise DictionaryMineValidationError(f"{label} contains unsupported control characters.")
    if len(value.encode("utf-8")) > max_bytes:
        raise DictionaryMineValidationError(f"{label} is too large.")
    normalized = value.strip()
    if required and not normalized:
        raise DictionaryMineValidationError(f"{label} is required.")
    return normalized


def _uuid_string(value: Any, label: str) -> str:
    normalized = _bounded_string(value, label, required=True, max_bytes=128)
    try:
        return str(uuid.UUID(normalized))
    except (ValueError, AttributeError) as error:
        raise DictionaryMineValidationError(f"{label} must be a UUID.") from error


def _bounded_values(value: Any, label: str, maximum: int = 64) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or len(value) > maximum:
        raise DictionaryMineValidationError(f"{label} must be a bounded list.")
    return tuple(_bounded_string(str(item), f"{label} item", max_bytes=1024) for item in value if str(item).strip())


def _decode_media(value: Any, total_bytes: int) -> tuple[DictionaryMineMedia, int]:
    if not isinstance(value, dict):
        raise DictionaryMineValidationError("Dictionary media must be an object.")
    dictionary_id = _bounded_string(
        value.get("dictionary_id"),
        "Dictionary media owner",
        required=True,
        max_bytes=256,
    )
    path = _bounded_string(value.get("path"), "Dictionary media path", required=True, max_bytes=1024)
    if (
        path.startswith(("/", "\\"))
        or "\\" in path
        or any(component in {"", ".", ".."} for component in path.split("/"))
    ):
        raise DictionaryMineValidationError("Dictionary media path is invalid.")
    mime_type = _bounded_string(value.get("mime_type"), "Dictionary media type", required=True, max_bytes=64)
    media_spec = SUPPORTED_MEDIA_TYPES.get(mime_type)
    if media_spec is None:
        raise DictionaryMineValidationError("Dictionary media type is unsupported.")
    data_base64 = _bounded_string(
        value.get("data_base64"),
        "Dictionary media data",
        required=True,
        max_bytes=((MAX_MEDIA_BYTES + 2) // 3) * 4 + 4,
    )
    try:
        decoded = base64.b64decode(data_base64, validate=True)
    except (ValueError, binascii.Error) as error:
        raise DictionaryMineValidationError("Dictionary media data is malformed.") from error
    if not decoded or len(decoded) > MAX_MEDIA_BYTES or total_bytes + len(decoded) > MAX_TOTAL_MEDIA_BYTES:
        raise DictionaryMineValidationError("Dictionary media exceeds the mining size limit.")
    if mime_type == "image/webp":
        valid_magic = len(decoded) >= 12 and decoded.startswith(b"RIFF") and decoded[8:12] == b"WEBP"
    else:
        valid_magic = any(decoded.startswith(magic) for magic in media_spec[1])
    if not valid_magic:
        raise DictionaryMineValidationError("Dictionary media content does not match its type.")
    canonical_base64 = base64.b64encode(decoded).decode("ascii")
    return (
        DictionaryMineMedia(
            dictionary_id=dictionary_id,
            path=path,
            mime_type=mime_type,
            data_base64=canonical_base64,
        ),
        total_bytes + len(decoded),
    )


def parse_dictionary_mine_request(payload: Any) -> DictionaryMineRequest:
    if not isinstance(payload, dict):
        raise DictionaryMineValidationError("Mining request must be an object.")
    backend = _bounded_string(payload.get("backend"), "Dictionary backend", required=True, max_bytes=32)
    if backend != "hoshidicts":
        raise DictionaryMineValidationError("Only HoshiDicts mining requests are accepted.")
    lookup_payload = payload.get("lookup")
    if not isinstance(lookup_payload, dict):
        raise DictionaryMineValidationError("Dictionary lookup selection is required.")
    lookup = DictionaryMineLookup(
        expression=_bounded_string(
            lookup_payload.get("expression"),
            "Expression",
            required=True,
        ),
        reading=_bounded_string(lookup_payload.get("reading", ""), "Reading"),
        matched_text=_bounded_string(lookup_payload.get("matched_text", ""), "Matched text"),
        dictionary_id=_bounded_string(
            lookup_payload.get("dictionary_id"),
            "Dictionary ID",
            required=True,
            max_bytes=256,
        ),
        dictionary_title=_bounded_string(
            lookup_payload.get("dictionary_title"),
            "Dictionary title",
            required=True,
            max_bytes=4096,
        ),
        glossary_id=_bounded_string(
            lookup_payload.get("glossary_id"),
            "Glossary ID",
            required=True,
            max_bytes=512,
        ),
        glossary_text=_bounded_string(
            lookup_payload.get("glossary_text"),
            "Selected glossary",
            required=True,
            max_bytes=MAX_GLOSSARY_BYTES,
        ),
        frequency=_bounded_values(lookup_payload.get("frequency"), "Frequency"),
        pitch=_bounded_values(lookup_payload.get("pitch"), "Pitch"),
    )
    raw_media = payload.get("media", [])
    if not isinstance(raw_media, list) or len(raw_media) > MAX_MEDIA_ITEMS:
        raise DictionaryMineValidationError("Dictionary media list is invalid.")
    media = []
    total_media_bytes = 0
    for raw_item in raw_media:
        item, total_media_bytes = _decode_media(raw_item, total_media_bytes)
        if item.dictionary_id != lookup.dictionary_id:
            raise DictionaryMineValidationError("Dictionary media belongs to a different dictionary.")
        media.append(item)
    return DictionaryMineRequest(
        request_id=_uuid_string(payload.get("request_id"), "Request ID"),
        idempotency_key=_uuid_string(payload.get("idempotency_key"), "Idempotency key"),
        session_id=_uuid_string(payload.get("session_id"), "Mining session ID"),
        backend=backend,
        line_id=_bounded_string(payload.get("line_id", ""), "Line ID", max_bytes=160),
        source_sentence=_bounded_string(
            payload.get("source_sentence", ""),
            "Source sentence",
            max_bytes=MAX_SENTENCE_BYTES,
        ),
        lookup=lookup,
        media=tuple(media),
    )


def encode_hoshi_line_tag(line_id: str) -> str:
    encoded = base64.urlsafe_b64encode(line_id.encode("utf-8")).decode("ascii").rstrip("=")
    return f"{HOSHI_LINE_TAG_PREFIX}{encoded}"


def decode_hoshi_line_tag(tag: str) -> Optional[str]:
    normalized = str(tag or "")
    if not normalized.startswith(HOSHI_LINE_TAG_PREFIX):
        return None
    encoded = normalized[len(HOSHI_LINE_TAG_PREFIX) :]
    if not encoded or len(encoded) > 384:
        return None
    try:
        padding = "=" * ((4 - len(encoded) % 4) % 4)
        decoded = base64.urlsafe_b64decode(encoded + padding).decode("utf-8")
    except (ValueError, UnicodeDecodeError, binascii.Error):
        return None
    return decoded if decoded and len(decoded.encode("utf-8")) <= 256 else None


def _request_signature(request: DictionaryMineRequest) -> str:
    content = {
        "backend": request.backend,
        "line_id": request.line_id,
        "source_sentence": request.source_sentence,
        "lookup": asdict(request.lookup),
        "media": [asdict(item) for item in request.media],
    }
    encoded = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _safe_request_id(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    value = payload.get("request_id")
    if not isinstance(value, str) or len(value.encode("utf-8")) > 128:
        return ""
    return value.strip()


class HoshiDictsMiningService:
    def __init__(
        self,
        *,
        config_getter: Callable[[], Any] = get_config,
        invoke: Optional[Callable[..., Any]] = None,
        line_resolver: Optional[Callable[[str], Any]] = None,
        tag_provider: Optional[Callable[[], list[str]]] = None,
        note_created: Optional[Callable[[int, str], None]] = None,
        readiness_ttl_seconds: float = 15.0,
    ):
        self.config_getter = config_getter
        self._invoke_override = invoke
        self._line_resolver_override = line_resolver
        self._tag_provider_override = tag_provider
        self._note_created_override = note_created
        self.readiness_ttl_seconds = max(0.0, float(readiness_ttl_seconds))
        self._state_lock = threading.Lock()
        self._creation_lock = threading.Lock()
        self._pending: dict[tuple[str, str], _PendingRequest] = {}
        self._completed: OrderedDict[tuple[str, str], _CachedResult] = OrderedDict()
        self._readiness_cache: Optional[tuple[str, float, DictionaryMineReadiness, Optional[_MiningConfiguration]]] = (
            None
        )

    def _invoke(self, action: str, **params):
        if self._invoke_override is not None:
            return self._invoke_override(action, **params)
        from GameSentenceMiner import anki

        return anki.invoke(action, **params)

    def _resolve_line(self, line_id: str):
        if not line_id:
            return None
        if self._line_resolver_override is not None:
            return self._line_resolver_override(line_id)
        line = get_line_by_id(line_id)
        if line is not None:
            return line
        overlay_line = getattr(gsm_state, "last_overlay_scan_line", None)
        if str(getattr(overlay_line, "id", "") or "") == line_id:
            return overlay_line
        return None

    def _tags(self) -> list[str]:
        if self._tag_provider_override is not None:
            return list(self._tag_provider_override() or [])
        from GameSentenceMiner import anki

        return list(anki._prepare_anki_tags())

    def _notify_note_created(self, note_id: int, session_id: str) -> None:
        if self._note_created_override is not None:
            self._note_created_override(note_id, session_id)
            return
        from GameSentenceMiner import anki

        anki.handle_incoming_anki_event(
            {
                "event": "note_added",
                "note_id": note_id,
                "session_id": f"hoshidicts:{session_id}",
            }
        )

    @staticmethod
    def _configuration(config: Any) -> tuple[_MiningConfiguration, tuple[str, ...]]:
        anki_config = getattr(config, "anki", None)
        if anki_config is None:
            raise DictionaryMineValidationError("Anki configuration is unavailable.")
        mapping = _MiningConfiguration(
            deck=str(getattr(anki_config, "hoshi_mining_deck", "") or "").strip(),
            model=str(getattr(anki_config, "note_type", "") or "").strip(),
            expression_field=str(getattr(anki_config, "word_field", "") or "").strip(),
            reading_field=str(getattr(anki_config, "hoshi_reading_field", "") or "").strip(),
            glossary_field=str(getattr(anki_config, "hoshi_glossary_field", "") or "").strip(),
            sentence_field=str(getattr(anki_config, "sentence_field", "") or "").strip(),
            dictionary_field=str(getattr(anki_config, "hoshi_dictionary_field", "") or "").strip(),
            frequency_field=str(getattr(anki_config, "hoshi_frequency_field", "") or "").strip(),
            pitch_field=str(getattr(anki_config, "hoshi_pitch_field", "") or "").strip(),
        )
        missing = []
        if not bool(getattr(anki_config, "enabled", False)):
            missing.append("Anki integration is disabled")
        required = {
            "Hoshi mining deck": mapping.deck,
            "Anki note type": mapping.model,
            "Expression field": mapping.expression_field,
            "Reading field": mapping.reading_field,
            "Glossary field": mapping.glossary_field,
            "Sentence field": mapping.sentence_field,
        }
        missing.extend(label for label, value in required.items() if not value)
        configured_fields = [
            mapping.expression_field,
            mapping.reading_field,
            mapping.glossary_field,
            mapping.sentence_field,
            mapping.dictionary_field,
            mapping.frequency_field,
            mapping.pitch_field,
        ]
        nonempty_fields = [field_name for field_name in configured_fields if field_name]
        if len(set(nonempty_fields)) != len(nonempty_fields):
            missing.append("Hoshi field mappings must use distinct Anki fields")
        return mapping, tuple(missing)

    @staticmethod
    def _configuration_signature(config: Any, mapping: _MiningConfiguration, missing: tuple[str, ...]) -> str:
        anki_config = getattr(config, "anki", None)
        content = {
            "mapping": asdict(mapping),
            "missing": missing,
            "enabled": bool(getattr(anki_config, "enabled", False)),
            "url": str(getattr(anki_config, "url", "") or ""),
        }
        return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()

    def _validate_environment(
        self,
        *,
        force: bool = False,
    ) -> tuple[DictionaryMineReadiness, Optional[_MiningConfiguration]]:
        config = self.config_getter()
        try:
            mapping, missing = self._configuration(config)
        except DictionaryMineValidationError as error:
            return (
                DictionaryMineReadiness(
                    ready=False,
                    status="invalid-config",
                    message=str(error),
                    missing=(str(error),),
                ),
                None,
            )
        signature = self._configuration_signature(config, mapping, missing)
        now = time.monotonic()
        with self._state_lock:
            cached = self._readiness_cache
            if not force and cached is not None and cached[0] == signature and cached[1] > now:
                return cached[2], cached[3]
        if missing:
            readiness = DictionaryMineReadiness(
                ready=False,
                status="invalid-config",
                message="Hoshi mining configuration is incomplete: " + ", ".join(missing),
                missing=missing,
            )
            context = None
        else:
            try:
                self._invoke("version")
                decks = self._invoke("deckNames") or []
                models = self._invoke("modelNames") or []
                fields = (
                    self._invoke("modelFieldNames", modelName=mapping.model) or [] if mapping.model in models else []
                )
            except Exception as error:
                readiness = DictionaryMineReadiness(
                    ready=False,
                    status="anki-unavailable",
                    message=f"AnkiConnect is unavailable: {error}",
                    missing=("AnkiConnect",),
                )
                context = None
            else:
                remote_missing = []
                if mapping.deck not in decks:
                    remote_missing.append(mapping.deck)
                if mapping.model not in models:
                    remote_missing.append(mapping.model)
                if mapping.model in models:
                    available_fields = set(fields)
                    configured_fields = [
                        mapping.expression_field,
                        mapping.reading_field,
                        mapping.glossary_field,
                        mapping.sentence_field,
                        mapping.dictionary_field,
                        mapping.frequency_field,
                        mapping.pitch_field,
                    ]
                    remote_missing.extend(
                        field_name
                        for field_name in configured_fields
                        if field_name and field_name not in available_fields
                    )
                if remote_missing:
                    readiness = DictionaryMineReadiness(
                        ready=False,
                        status="invalid-config",
                        message="Anki deck, model, or fields are missing: " + ", ".join(remote_missing),
                        missing=tuple(remote_missing),
                    )
                    context = None
                else:
                    readiness = DictionaryMineReadiness(
                        ready=True,
                        status="ready",
                        message="Hoshi mining is ready.",
                    )
                    context = mapping
        expires_at = now if readiness.status == "anki-unavailable" else now + self.readiness_ttl_seconds
        with self._state_lock:
            self._readiness_cache = (signature, expires_at, readiness, context)
        return readiness, context

    def readiness(self, *, force: bool = False) -> DictionaryMineReadiness:
        readiness, _context = self._validate_environment(force=force)
        return readiness

    @staticmethod
    def _result_for_request(result: DictionaryMineResult, request_id: str) -> DictionaryMineResult:
        return replace(result, request_id=request_id)

    def mine(self, payload: Any) -> DictionaryMineResult:
        request_id = _safe_request_id(payload)
        try:
            request = parse_dictionary_mine_request(payload)
        except DictionaryMineValidationError as error:
            return DictionaryMineResult(
                request_id=request_id,
                status="failed",
                message=str(error),
            )
        signature = _request_signature(request)
        key = (request.session_id, request.idempotency_key)
        owner = False
        with self._state_lock:
            cached = self._completed.get(key)
            if cached is not None:
                self._completed.move_to_end(key)
                if cached.signature != signature:
                    return DictionaryMineResult(
                        request_id=request.request_id,
                        status="failed",
                        message="The idempotency key was already used for a different mining selection.",
                    )
                return self._result_for_request(cached.result, request.request_id)
            pending = self._pending.get(key)
            if pending is None:
                pending = _PendingRequest(signature=signature, event=threading.Event())
                self._pending[key] = pending
                owner = True
            elif pending.signature != signature:
                return DictionaryMineResult(
                    request_id=request.request_id,
                    status="failed",
                    message="The idempotency key is already processing a different mining selection.",
                )
        if not owner:
            pending.event.wait()
            if pending.result is None:
                return DictionaryMineResult(
                    request_id=request.request_id,
                    status="failed",
                    message="The concurrent mining request did not produce a result.",
                )
            return self._result_for_request(pending.result, request.request_id)

        try:
            result = self._mine_once(request, signature)
        except Exception as error:
            logger.exception(f"Unexpected HoshiDicts mining failure: {error}")
            result = DictionaryMineResult(
                request_id=request.request_id,
                status="failed",
                message="Hoshi mining failed unexpectedly.",
            )
        with self._state_lock:
            pending.result = result
            self._pending.pop(key, None)
            if result.status in {"created", "duplicate", "opened-existing"}:
                self._completed[key] = _CachedResult(signature=signature, result=result)
                self._completed.move_to_end(key)
                while len(self._completed) > MAX_IDEMPOTENCY_ENTRIES:
                    self._completed.popitem(last=False)
            pending.event.set()
        return result

    @staticmethod
    def _normalize_tag(tag: Any) -> str:
        normalized = "_".join(str(tag or "").strip().split())
        return normalized[:255]

    def _build_tags(self, request: DictionaryMineRequest, fingerprint: str) -> list[str]:
        config = self.config_getter()
        anki_config = getattr(config, "anki", None)
        raw_tags = [
            *self._tags(),
            *(getattr(anki_config, "tags_to_check", None) or []),
            "overlay",
            HOSHI_SOURCE_TAG,
            f"{HOSHI_FINGERPRINT_TAG_PREFIX}{fingerprint}",
        ]
        if request.line_id:
            raw_tags.append(encode_hoshi_line_tag(request.line_id))
        tags = []
        seen = set()
        for raw_tag in raw_tags:
            tag = self._normalize_tag(raw_tag)
            key = tag.casefold()
            if tag and key not in seen:
                seen.add(key)
                tags.append(tag)
        return tags

    def _store_media(
        self,
        request: DictionaryMineRequest,
        fingerprint: str,
    ) -> tuple[list[str], list[str]]:
        filenames = []
        warnings = []
        for index, media in enumerate(request.media):
            extension = SUPPORTED_MEDIA_TYPES[media.mime_type][0]
            content_hash = hashlib.sha256(media.data_base64.encode("ascii")).hexdigest()[:10]
            filename = f"gsm_hoshi_{fingerprint}_{index}_{content_hash}.{extension}"
            try:
                stored = self._invoke(
                    "storeMediaFile",
                    filename=filename,
                    data=media.data_base64,
                    timeout=30,
                )
            except Exception as error:
                logger.warning(f"Could not store HoshiDicts media {index}: {error}")
                warnings.append("Dictionary media could not be stored.")
                continue
            stored_name = str(stored or "").strip()
            if not stored_name:
                warnings.append("Dictionary media could not be stored.")
                continue
            filenames.append(stored_name)
        return filenames, list(dict.fromkeys(warnings))

    def _mine_once(self, request: DictionaryMineRequest, signature: str) -> DictionaryMineResult:
        readiness, mapping = self._validate_environment()
        if not readiness.ready or mapping is None:
            return DictionaryMineResult(
                request_id=request.request_id,
                status=readiness.status,
                message=readiness.message,
            )
        line = self._resolve_line(request.line_id)
        source_sentence = str(getattr(line, "text", "") or "") if line is not None else request.source_sentence
        fingerprint_payload = {
            "deck": mapping.deck,
            "model": mapping.model,
            "expression": request.lookup.expression,
            "reading": request.lookup.reading,
            "glossary": request.lookup.glossary_text,
            "sentence": source_sentence,
            "dictionary_id": request.lookup.dictionary_id,
            "glossary_id": request.lookup.glossary_id,
            "media": [hashlib.sha256(item.data_base64.encode("ascii")).hexdigest() for item in request.media],
        }
        fingerprint = hashlib.sha256(
            json.dumps(
                fingerprint_payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()[:24]

        with self._creation_lock:
            query = f"tag:{HOSHI_SOURCE_TAG} tag:{HOSHI_FINGERPRINT_TAG_PREFIX}{fingerprint}"
            try:
                existing = self._invoke("findNotes", query=query) or []
            except requests.RequestException as error:
                return DictionaryMineResult(
                    request_id=request.request_id,
                    status="anki-unavailable",
                    message=f"AnkiConnect is unavailable: {error}",
                )
            except Exception as error:
                return DictionaryMineResult(
                    request_id=request.request_id,
                    status="failed",
                    message=f"Could not check for an existing Hoshi note: {error}",
                )
            existing_ids = sorted(
                int(note_id) for note_id in existing if isinstance(note_id, int) or str(note_id).isdigit()
            )
            if existing_ids:
                return DictionaryMineResult(
                    request_id=request.request_id,
                    status="duplicate",
                    note_id=existing_ids[0],
                    message="This Hoshi dictionary selection was already mined.",
                )

            media_filenames, warnings = self._store_media(request, fingerprint)
            glossary_html = html.escape(request.lookup.glossary_text, quote=False)
            if media_filenames:
                glossary_html += "".join(
                    f'<br><img src="{html.escape(filename, quote=True)}">' for filename in media_filenames
                )
            fields = {
                mapping.expression_field: html.escape(request.lookup.expression, quote=False),
                mapping.reading_field: html.escape(request.lookup.reading, quote=False),
                mapping.glossary_field: glossary_html,
                mapping.sentence_field: html.escape(source_sentence, quote=False),
            }
            optional_fields = (
                (mapping.dictionary_field, request.lookup.dictionary_title),
                (mapping.frequency_field, ", ".join(request.lookup.frequency)),
                (mapping.pitch_field, ", ".join(request.lookup.pitch)),
            )
            for field_name, value in optional_fields:
                if field_name:
                    fields[field_name] = html.escape(value, quote=False)
            note = {
                "deckName": mapping.deck,
                "modelName": mapping.model,
                "fields": fields,
                "options": {
                    "allowDuplicate": True,
                },
                "tags": self._build_tags(request, fingerprint),
            }
            try:
                note_id = self._invoke("addNote", note=note)
            except requests.RequestException as error:
                return DictionaryMineResult(
                    request_id=request.request_id,
                    status="anki-unavailable",
                    warnings=tuple(warnings),
                    message=f"AnkiConnect is unavailable: {error}",
                )
            except Exception as error:
                return DictionaryMineResult(
                    request_id=request.request_id,
                    status="failed",
                    warnings=tuple(warnings),
                    message=f"Anki rejected the Hoshi note: {error}",
                )
            try:
                normalized_note_id = int(note_id)
            except (TypeError, ValueError):
                return DictionaryMineResult(
                    request_id=request.request_id,
                    status="failed",
                    warnings=tuple(warnings),
                    message="Anki did not confirm the new note ID.",
                )
            if normalized_note_id <= 0:
                return DictionaryMineResult(
                    request_id=request.request_id,
                    status="failed",
                    warnings=tuple(warnings),
                    message="Anki did not confirm the new note ID.",
                )
            try:
                self._notify_note_created(normalized_note_id, request.session_id)
            except Exception as error:
                logger.warning(f"Could not queue Hoshi note {normalized_note_id} for enhancement: {error}")
                warnings.append("The note was created but automatic enhancement could not be queued.")
            return DictionaryMineResult(
                request_id=request.request_id,
                status="created",
                note_id=normalized_note_id,
                warnings=tuple(dict.fromkeys(warnings)),
                message="Hoshi dictionary note created.",
            )


hoshidicts_mining_service = HoshiDictsMiningService()


__all__ = [
    "HOSHI_FINGERPRINT_TAG_PREFIX",
    "HOSHI_LINE_TAG_PREFIX",
    "HOSHI_SOURCE_TAG",
    "HoshiDictsMiningService",
    "decode_hoshi_line_tag",
    "encode_hoshi_line_tag",
    "hoshidicts_mining_service",
    "parse_dictionary_mine_request",
]
