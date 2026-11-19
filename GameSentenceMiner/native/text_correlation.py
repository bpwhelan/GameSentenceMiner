"""Select the Rust dialogue classifier available to this mining process."""

import json

from GameSentenceMiner.native import ocr
from GameSentenceMiner.native.runtime import NativeMode, backend_manages, get_native_mode


def _desktop(incoming, newest, open_line, previous, deadline_ns, windows):
    from GameSentenceMiner.util.communication import bus_client

    data = {
        "incoming": incoming,
        "newest": newest,
        "open": open_line,
        "previous": previous,
        "deadline_ns": deadline_ns,
        "windows": windows,
    }
    if len(json.dumps(data, ensure_ascii=False).encode("utf-8")) > 7 * 1024 * 1024:
        return None
    # The outer ingress actor has a 250 ms default deadline. A read-only
    # desktop decision can be computed locally if the desktop is busy.
    reply = bus_client.get_bus().request(bus_client.MAIN, "text.classify", data, timeout=0.1)
    if not isinstance(reply, list) or len(reply) != 3:
        return None
    action, reason, suffix = reply
    if action not in ("append", "revise", "duplicate_newest", "duplicate_open") or not isinstance(reason, str):
        return None
    if (action in ("revise", "duplicate_open") and open_line is None) or (
        action == "duplicate_newest" and newest is None
    ):
        return None
    if suffix is not None and (action != "append" or not isinstance(suffix, str)):
        return None
    return tuple(reply)


def implementation():
    mode = get_native_mode("text")
    if mode is NativeMode.PYTHON:
        return None, False
    classify = getattr(ocr._extension, "classify_dialogue", None)
    if classify is None and backend_manages("GSM_NATIVE_TEXT_CORRELATION"):
        classify = _desktop
    return classify, mode is NativeMode.SHADOW


def _line(record):
    if record is None:
        return None
    return (
        record.text,
        record.source_kind.value,
        record.source_instance,
        record.scene,
        record.first_seen_monotonic_ns,
        record.relay_only,
        record.state.value == "frozen",
        record.stats_status == "skipped",
    )


def decide(classify, observation, text, scene, now_ns, newest, current, previous, deadline_ns, windows):
    incoming = (
        text,
        observation.source_kind.value,
        observation.source_instance,
        scene,
        now_ns,
        observation.relay_only,
        observation.remove_matching_prefix,
        observation.merge_fragments,
        bool(observation.metadata.get("speech_final")),
        bool(observation.metadata.get("skip_landing_confirmed")),
    )
    latest = _line(newest)
    prior = (previous[0], newest is not None and previous[1] == newest.line_id) if previous else None
    try:
        return classify(incoming, latest, latest if current is newest else _line(current), prior, deadline_ns, windows)
    except (ValueError, TypeError, OverflowError, OSError, RuntimeError):
        # Decisions are read-only. Legacy strings, out-of-range timestamps and
        # a lost desktop reply can all be evaluated locally before publication.
        return None
