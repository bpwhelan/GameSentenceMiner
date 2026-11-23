"""Python thin shim for the native Rust mining runtime (`src-tauri/src/mining`).

When GSM is launched by the Tauri desktop shell with ``GSM_NATIVE_MINING=1``
(the default; pass ``GSM_NATIVE_MINING=python`` to fall back to the Python
mining stack), Rust owns:
- The single-port HTTP+WS gateway (AnkiBeacon push + HTTP/WS proxy to Python)
- AnkiConnect polling, card matching, replay saving/cutting, VAD, screenshots,
  animation/video encoding, AI prompting, furigana, and AnkiConnect updates.

Python continues to host the Flask/Waitress web UI, WebSockets, live text
intake, and the PyQt6 confirmation & session-review dialogs (until the UI pass).
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any

from GameSentenceMiner.native.runtime import backend_manages
from GameSentenceMiner.util.config.configuration import logger


def native_mining_enabled() -> bool:
    """Return True when the Rust desktop owns the mining stack."""
    return backend_manages("GSM_NATIVE_MINING")


def external_gateway_port() -> int | None:
    """Return the port bound by the Rust single-port gateway, if active."""
    raw = os.environ.get("GSM_EXTERNAL_GATEWAY_PORT", "").strip()
    if not raw:
        return None
    try:
        port = int(raw)
        return port if 0 < port <= 65535 else None
    except ValueError:
        return None


def _datetime_to_epoch(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        val = float(value)
        return val if val > 0.0 else None
    if isinstance(value, datetime):
        if value.year <= 1970:
            return None
        try:
            val = float(value.timestamp())
            return val if val > 0.0 else None
        except (OSError, OverflowError, ValueError):
            return None
    return None


def _serialize_line(line: Any) -> dict[str, Any] | None:
    if line is None:
        return None
    time_epoch = _datetime_to_epoch(getattr(line, "time", None)) or 0.0
    first_seen_epoch = _datetime_to_epoch(getattr(line, "first_seen_time", None))
    mined_epoch = _datetime_to_epoch(getattr(line, "mined_time", None))
    prev_line = getattr(line, "prev", None)
    next_line = getattr(line, "next", None)
    clip = getattr(line, "clip", None)
    clip_end = getattr(clip, "clip_end_time", None) if clip is not None else None
    raw_padding = getattr(line, "source_padding", 0.0)
    if callable(raw_padding):
        try:
            raw_padding = raw_padding()
        except (OSError, RuntimeError, TypeError, ValueError):
            raw_padding = 0.0
    return {
        "id": str(getattr(line, "id", "") or ""),
        "text": str(getattr(line, "text", "") or ""),
        "time_epoch": time_epoch,
        "index": int(getattr(line, "index", 0) or 0),
        "scene": str(getattr(line, "scene", "") or ""),
        "source": getattr(line, "source", None),
        "source_padding": float(raw_padding or 0.0),
        "mined_time_epoch": mined_epoch,
        "excluded_from_stats": bool(getattr(line, "excluded_from_stats", False)),
        "session_id": str(getattr(line, "session_id", "") or ""),
        "first_seen_time_epoch": first_seen_epoch,
        "translation": str(getattr(line, "translation", "") or ""),
        "prev_id": str(getattr(prev_line, "id", "")) if prev_line is not None else None,
        "next_id": str(getattr(next_line, "id", "")) if next_line is not None else None,
        "clip_folder": getattr(clip, "folder", None) if clip is not None else None,
        "clip_path": getattr(clip, "clip_path", None) if clip is not None else None,
        "clip_end_time_epoch": _datetime_to_epoch(clip_end),
    }


def _request(topic: str, data: dict[str, Any], *, timeout: float = 30.0) -> Any:
    from GameSentenceMiner.util.communication.bus_client import MAIN, get_bus

    return get_bus().request(MAIN, topic, data, timeout=timeout)


def register_gateway_upstreams(http_port: int, ws_port: int, direct_ws_port: int = 0) -> bool:
    """Tell the Rust single-port gateway where Python's internal Waitress & WS listeners live."""
    if external_gateway_port() is None:
        return False
    try:
        reply = _request(
            "mining.gateway.register",
            {
                "httpPort": int(http_port),
                "wsPort": int(ws_port),
                "directWsPort": int(direct_ws_port),
            },
            timeout=5.0,
        )
        return bool(isinstance(reply, dict) and reply.get("ok"))
    except (OSError, RuntimeError, TimeoutError, ValueError) as exc:
        logger.warning(f"Failed registering Python web upstreams with Rust gateway: {exc}")
        return False


def notify_replay_state(active: bool) -> None:
    if not native_mining_enabled():
        return
    try:
        _request("mining.replayState", {"active": bool(active)}, timeout=2.0)
    except (OSError, RuntimeError, TimeoutError, ValueError):
        logger.debug("Could not forward replay state to native mining", exc_info=True)


def notify_config_changed() -> None:
    if not native_mining_enabled():
        return
    try:
        _request("mining.configChanged", {}, timeout=2.0)
    except (OSError, RuntimeError, TimeoutError, ValueError):
        logger.debug("Could not notify native mining of config change", exc_info=True)


def get_mining_status() -> dict[str, Any] | None:
    if not native_mining_enabled():
        return None
    try:
        reply = _request("mining.status", {}, timeout=2.0)
        return reply if isinstance(reply, dict) else None
    except (OSError, RuntimeError, TimeoutError, ValueError):
        return None


def ai_translate(
    lines,
    sentence: str,
    current_line,
    game_title: str = "",
    *,
    force_refresh: bool = False,
    custom_prompt: str | None = None,
    translation_only: bool = False,
) -> str:
    payload: dict[str, Any] = {
        "action": "translate",
        "lines": [s for s in (_serialize_line(line) for line in (lines or [])) if s is not None],
        "sentence": sentence or "",
        "current_line": _serialize_line(current_line),
        "game_title": game_title or "",
        "force_refresh": bool(force_refresh),
        "translation_only": bool(translation_only),
    }
    if custom_prompt is not None:
        payload["custom_prompt"] = custom_prompt
    reply = _request("mining.ai", payload, timeout=120.0)
    return str((reply or {}).get("text") or "")


def ai_analyze(
    lines,
    sentence: str,
    current_line,
    game_title: str = "",
    *,
    mode: str = "sentence",
    question: str = "",
) -> str:
    payload = {
        "action": "analyze",
        "lines": [s for s in (_serialize_line(line) for line in (lines or [])) if s is not None],
        "sentence": sentence or "",
        "current_line": _serialize_line(current_line),
        "game_title": game_title or "",
        "mode": mode,
        "question": question,
    }
    reply = _request("mining.ai", payload, timeout=120.0)
    return str((reply or {}).get("text") or "")


def ai_overlay_translate(lines, blocks: list[dict], game_title: str) -> list[dict]:
    payload = {
        "action": "overlayTranslate",
        "lines": [s for s in (_serialize_line(line) for line in (lines or [])) if s is not None],
        "blocks": blocks,
        "game_title": game_title or "",
    }
    reply = _request("mining.ai", payload, timeout=120.0)
    result_blocks = (reply or {}).get("blocks")
    if not isinstance(result_blocks, list):
        raise TypeError("Native AI returned invalid overlay translation blocks")
    return result_blocks


def ai_character_summary(character_data: dict) -> str | None:
    reply = _request(
        "mining.ai",
        {"action": "characterSummary", "character_data": character_data},
        timeout=120.0,
    )
    text = (reply or {}).get("text")
    return str(text) if isinstance(text, str) and text.strip() else None


def session_review_extract_audio(
    *,
    video_path: str,
    game_line,
    next_line_time,
    anki_card_creation_time,
    mined_line=None,
    full_text: str = "",
    game_name: str = "",
) -> dict[str, Any]:
    payload = {
        "action": "extractAudio",
        "video_path": str(video_path),
        "game_line": _serialize_line(game_line),
        "next_line_time": _datetime_to_epoch(next_line_time),
        "anki_card_creation_time": _datetime_to_epoch(anki_card_creation_time),
        "mined_line": _serialize_line(mined_line),
        "full_text": full_text,
        "game_name": game_name,
    }
    reply = _request("mining.sessionReview", payload, timeout=120.0)
    if not isinstance(reply, dict):
        raise TypeError("Native session review audio extraction returned invalid payload")
    return reply


def session_review_capture_future_replay(targets: list[dict[str, Any]]) -> int:
    reply = _request(
        "mining.sessionReview",
        {"action": "captureFutureReplay", "targets": targets},
        timeout=60.0,
    )
    return int((reply or {}).get("attached", 0))


# --- Bus handlers served by Python for the Rust mining pipeline ---


def on_card_completed(message: dict[str, Any]) -> None:
    """Keep Python's in-memory live stats and status in sync after Rust finishes a card."""
    data = message.get("data")
    if not isinstance(data, dict):
        return
    line_id = str(data.get("lineId") or "")
    game_name = str(data.get("gameName") or "")
    excluded_from_stats = bool(data.get("excludedFromStats", False))
    translation = str(data.get("translation") or "")
    review_entry_id = str(data.get("reviewEntryId") or "")
    selected_ids = data.get("selectedLineIds") or []

    mined_line = None
    if line_id:
        try:
            from datetime import UTC

            from GameSentenceMiner.util.config.configuration import gsm_state
            from GameSentenceMiner.util.text_log import _freeze_authoritative_line, get_line_by_id

            mined_line = get_line_by_id(line_id)
            if mined_line is not None:
                mined_line.mined_time = datetime.now(UTC).astimezone().replace(tzinfo=None)
                if translation:
                    mined_line.TL = translation
                    mined_line.translation = translation
                gsm_state.last_mined_line = mined_line
                _freeze_authoritative_line(mined_line)
                if not game_name:
                    game_name = str(getattr(mined_line, "scene", "") or "")
                excluded_from_stats = excluded_from_stats or bool(getattr(mined_line, "excluded_from_stats", False))
        except (ImportError, OSError, RuntimeError, AttributeError):
            logger.debug("Line state sync after native card completion skipped", exc_info=True)

    if review_entry_id and mined_line is not None and not getattr(mined_line, "clip", None):
        try:
            import json

            from GameSentenceMiner import session_review, session_review_context
            from GameSentenceMiner.util.config.configuration import get_config
            from GameSentenceMiner.util.text_log import get_line_by_id

            folder = session_review.get_review_root() / review_entry_id
            review_json = folder / "review.json"
            if review_json.is_file():
                entry = session_review.ReviewEntry(folder, json.loads(review_json.read_text(encoding="utf-8")))
                selected = [
                    line for line in (get_line_by_id(str(sid)) for sid in selected_ids) if line is not None
                ] or [mined_line]
                session_review_context.register(entry, mined_line, selected, get_config())
        except (ImportError, OSError, RuntimeError, ValueError, AttributeError):
            logger.debug("Session review future context watch registration skipped", exc_info=True)

    from GameSentenceMiner.native.intake import native_reader

    if native_reader():
        from GameSentenceMiner.web.live_goals import publish_live_goals_update

        publish_live_goals_update(force=True)
    elif not excluded_from_stats:
        try:
            from GameSentenceMiner.util.stats.live_stats import live_stats_tracker

            if game_name:
                live_stats_tracker.add_mined_line(game_name=game_name)
            else:
                live_stats_tracker.add_mined_line()
        except (ImportError, OSError, RuntimeError, AttributeError):
            logger.debug("Live stats update after native card completion skipped", exc_info=True)
