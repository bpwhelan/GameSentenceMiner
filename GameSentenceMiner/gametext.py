import asyncio
import atexit
import json
import os
import threading
import time
import uuid
from collections import defaultdict, deque
from dataclasses import replace
from datetime import datetime, timedelta

import websockets

from GameSentenceMiner import obs
from GameSentenceMiner.text_pipeline.models import (
    IngressAck,
    IngressStatus,
    SourceKind,
    TextDomainEvent,
    TextEventKind,
    TextObservation,
    TextRecordSnapshot,
    TextStreamSnapshot,
    normalize_utc,
)
from GameSentenceMiner.text_pipeline.runtime import AuthoritativeTextRuntime
from GameSentenceMiner.util.clients.discord_rpc import discord_rpc_manager
from GameSentenceMiner.util.communication.electron_ipc import send_message
from GameSentenceMiner.util.concurrency.actor import MailboxFull
from GameSentenceMiner.util.concurrency.work_pool import submit_background_work
from GameSentenceMiner.util.config.configuration import (
    get_config,
    get_master_config,
    gsm_state,
    gsm_status,
    is_dev,
    logger,
)
from GameSentenceMiner.util.database.db import DB_PRIORITY_HIGH, GameLinesTable, gsm_db
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.gsm_utils import SleepManager
from GameSentenceMiner.util.platform.notification import (
    announce_text_intake_state,
    send_text_intake_paused_notification,
    send_text_intake_resumed_notification,
)
from GameSentenceMiner.util.platform.windows_clipboard import WindowsClipboardListener
from GameSentenceMiner.util.stats.live_stats import live_stats_tracker
from GameSentenceMiner.util.text_log import (
    GameLine,
    TextSource,
    game_log,
    to_local_naive_datetime,
)
from GameSentenceMiner.util.text_processing import apply_text_processing

pyperclip = None
try:
    import pyperclipfix as pyperclip
except Exception:
    logger.warning("failed to import pyperclip, clipboard monitoring will not work!")


# ---------------------------------------------------------------------------
# Module state
# ---------------------------------------------------------------------------

# The most recent raw text handed to the pipeline. Read by external callers
# (e.g. the clipboard monitor) to avoid re-submitting unchanged clipboard text.
current_line = ""
current_line_time = datetime.now()

last_clipboard = ""

websocket_connected = {}
websocket_tasks = {}  # Track active websocket listener tasks by URI
current_websocket_uris = set()  # URIs we currently have listeners for
_config_monitor_task = None  # Long-lived task watching config for URI changes
text_monitor_initialized = False

# In-house text sources (OCR, texthook). Like a connected websocket, an active
# in-house source pauses clipboard intake so the same line isn't ingested twice.
inhouse_sources_active = {}

# Skip-spam detection is enforced at the shared ingress boundary so clipboard,
# websocket, OCR, and integrated hooks all take the same path.
message_timestamps = defaultdict(lambda: deque(maxlen=60))
rate_limit_active = defaultdict(bool)
_rate_limit_lock = threading.Lock()
SKIP_SPAM_WINDOW_SECONDS = 1.0
SKIP_SPAM_EVENT_THRESHOLD = 5
SKIP_SPAM_RECOVERY_SECONDS = 0.3

# When stats collection is disabled in advanced config, remind the user on the
# first few received lines each startup so it's obvious nothing is being stored.
_dont_collect_stats_notice_count = 0
_DONT_COLLECT_STATS_NOTICE_LIMIT = 10

# The coordinator owns correlation. These counters preserve the existing one-time
# Electron warning without keeping a second mutable text-history cache here.
_OCR_HOOK_REDUNDANCY_THRESHOLD = 3
_ocr_hook_redundancy_count = 0
_ocr_hook_redundancy_warned = False

_text_runtime: AuthoritativeTextRuntime | None = None
_text_runtime_lock = threading.RLock()
_projected_lines: dict[str, GameLine] = {}
_overlay_dispatcher = None

DEFAULT_TEXTHOOK_MAX_BUFFER_SIZE = 3000
MAX_TEXTHOOK_MAX_BUFFER_SIZE = 100_000
MAX_JAPANESE_QUOTE_PAIRS = 10


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def get_authoritative_text_runtime() -> AuthoritativeTextRuntime:
    global _text_runtime
    with _text_runtime_lock:
        if _text_runtime is None:
            _text_runtime = AuthoritativeTextRuntime(
                _project_text_domain_event,
                retention_provider=lambda: timedelta(
                    seconds=max(0, float(getattr(gsm_state, "replay_buffer_length", 0) or 0)) + 5
                ),
            )
        _text_runtime.start()
        return _text_runtime


def get_text_stream_snapshot() -> TextStreamSnapshot:
    return get_authoritative_text_runtime().snapshot(timeout=1.0)


def freeze_authoritative_text_line(line_id: str) -> bool:
    with _text_runtime_lock:
        runtime = _text_runtime
    if runtime is None:
        return False
    events = runtime.freeze(str(line_id), timeout=1.0)
    runtime.wait_projected(timeout=1.0)
    return bool(events)


def get_text_runtime_health() -> dict[str, object]:
    with _text_runtime_lock:
        if _text_runtime is None:
            return {"state": "created", "healthy": True, "actors": {}}
        health = _text_runtime.health_snapshot()
        if _overlay_dispatcher is not None:
            health["overlay"] = _overlay_dispatcher.health_snapshot()
        return health


def stop_authoritative_text_runtime() -> bool:
    global _text_runtime, _overlay_dispatcher
    with _text_runtime_lock:
        runtime = _text_runtime
        _text_runtime = None
    text_stopped = True if runtime is None else runtime.stop()
    overlay = _overlay_dispatcher
    _overlay_dispatcher = None
    overlay_stopped = True if overlay is None else overlay.stop()
    return text_stopped and overlay_stopped


atexit.register(stop_authoritative_text_runtime)


def _log_info(message: str, *, colors: bool = False) -> None:
    if colors:
        try:
            color_logger = logger.opt(colors=True)
            if color_logger is not None and hasattr(color_logger, "info"):
                color_logger.info(message)
                return
        except Exception:
            pass
    logger.info(message)


def get_texthook_max_buffer_size() -> int:
    """Return the shared text-hook limit, with a safe fallback for old configs."""
    try:
        configured = getattr(getattr(get_config(), "general", None), "texthook_max_buffer_size", None)
        value = int(configured)
    except (AttributeError, TypeError, ValueError):
        return DEFAULT_TEXTHOOK_MAX_BUFFER_SIZE
    if value < 1:
        return DEFAULT_TEXTHOOK_MAX_BUFFER_SIZE
    return min(value, MAX_TEXTHOOK_MAX_BUFFER_SIZE)


def guard_text_input(line) -> tuple[str | None, str | None]:
    """Block quote-heavy backlogs and cap text before the processing pipeline."""
    text = line if isinstance(line, str) else str(line)
    opening_quotes = 0
    closing_quotes = 0
    for character in text:
        if character == "「":
            opening_quotes += 1
        elif character == "」":
            closing_quotes += 1
        if opening_quotes > MAX_JAPANESE_QUOTE_PAIRS and closing_quotes > MAX_JAPANESE_QUOTE_PAIRS:
            return None, "too many Japanese quote pairs"

    max_buffer_size = get_texthook_max_buffer_size()
    if len(text) > max_buffer_size:
        return text[:max_buffer_size], "truncated"
    return text, None


def _send_text_received_preview_event(
    raw_text: str,
    processed_text: str,
    line_time: datetime,
    source: str | None,
    source_display_name: str | None,
) -> None:
    if not os.environ.get("GSM_ELECTRON"):
        return
    try:
        send_message(
            "text_received",
            {
                "text": raw_text,
                "processed_text": processed_text,
                "time": line_time.isoformat(),
                "source": source or "",
                "source_display_name": source_display_name or "",
            },
        )
    except Exception as exc:
        logger.debug(f"Failed to send text preview event to Electron: {exc}")


def _note_authoritative_duplicate(source_kind: SourceKind, matched_source: str | None) -> None:
    """Warn once when the coordinator repeatedly identifies auto-OCR hook echoes."""
    global _ocr_hook_redundancy_count, _ocr_hook_redundancy_warned
    if _ocr_hook_redundancy_warned or source_kind is not SourceKind.OCR or matched_source != SourceKind.TEXTHOOK.value:
        return
    _ocr_hook_redundancy_count += 1
    if _ocr_hook_redundancy_count < _OCR_HOOK_REDUNDANCY_THRESHOLD:
        return
    _ocr_hook_redundancy_warned = True
    if os.environ.get("GSM_ELECTRON"):
        try:
            send_message("ocr_hook_redundant", {})
        except Exception as exc:
            logger.debug(f"Failed to send OCR/hook redundancy warning: {exc}")


async def _add_event_to_texthooker(new_line):
    from GameSentenceMiner.web.texthooking_page import add_event_to_texthooker

    await add_event_to_texthooker(new_line)


# ---------------------------------------------------------------------------
# Text intake pause/resume
# ---------------------------------------------------------------------------


def is_text_monitor_initialized() -> bool:
    return text_monitor_initialized


def is_text_intake_paused() -> bool:
    return bool(getattr(gsm_state, "text_input_paused", False))


def set_text_intake_paused(paused: bool) -> bool:
    new_state = bool(paused)
    old_state = is_text_intake_paused()
    gsm_state.text_input_paused = new_state
    if new_state != old_state:
        logger.info(f"GSM text intake {'paused' if new_state else 'resumed'}.")
        announce_text_intake_state(new_state)
        if new_state:
            send_text_intake_paused_notification(should_relay_outputs_when_text_intake_paused())
        else:
            send_text_intake_resumed_notification()
    return new_state


def toggle_text_intake_paused() -> bool:
    return set_text_intake_paused(not is_text_intake_paused())


def should_relay_outputs_when_text_intake_paused() -> bool:
    hotkeys_config = getattr(get_config(), "hotkeys", None)
    return bool(getattr(hotkeys_config, "relay_outputs_when_text_intake_paused", True))


def should_drop_text_input_completely() -> bool:
    return is_text_intake_paused() and not should_relay_outputs_when_text_intake_paused()


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------


def is_message_rate_limited(source="clipboard"):
    """Drop skip-spam bursts while resuming quickly after the source goes quiet.

    Args:
        source (str): The source of the message (clipboard, websocket, etc.)

    Returns:
        bool: True if message should be dropped due to rate limiting
    """
    source_key = str(source or "unknown").strip().lower() or "unknown"
    current_time = time.monotonic()
    activated = False
    recovered = False

    with _rate_limit_lock:
        timestamps = message_timestamps[source_key]

        if rate_limit_active[source_key]:
            quiet_for = current_time - timestamps[-1] if timestamps else SKIP_SPAM_RECOVERY_SECONDS
            if quiet_for >= SKIP_SPAM_RECOVERY_SECONDS:
                timestamps.clear()
                rate_limit_active[source_key] = False
                recovered = True
            else:
                timestamps.append(current_time)
                return True

        cutoff = current_time - SKIP_SPAM_WINDOW_SECONDS
        while timestamps and timestamps[0] <= cutoff:
            timestamps.popleft()
        timestamps.append(current_time)

        if len(timestamps) >= SKIP_SPAM_EVENT_THRESHOLD:
            rate_limit_active[source_key] = True
            activated = True

    if recovered:
        logger.info(f"Skip-spam filtering deactivated for {source_key}; text intake resumed.")
    if activated:
        logger.warning(
            f"Skip-spam filtering activated for {source_key}: "
            f"{SKIP_SPAM_EVENT_THRESHOLD} events within {SKIP_SPAM_WINDOW_SECONDS:g} second."
        )
    return activated


# ---------------------------------------------------------------------------
# In-house text sources (OCR / texthook)
# ---------------------------------------------------------------------------


def set_inhouse_source_active(source: str, active: bool) -> None:
    """Mark an in-house text source (e.g. "ocr", "texthook") active or inactive.

    Mirrors websocket connect/disconnect: while any in-house source is active,
    clipboard intake pauses (unless use_both_clipboard_and_websocket is set), so
    the same line isn't ingested from both the bus and the clipboard.
    """
    key = (source or "").strip().lower()
    if not key:
        return
    inhouse_sources_active[key] = bool(active)
    logger.info(f"In-house text source '{key}' {'started' if active else 'stopped'}.")

    # Report the actual clipboard outcome, not just this source's state: a still
    # connected websocket or another active source keeps the clipboard paused even
    # when this one stops, and use_both_clipboard_and_websocket disables pausing.
    if get_config().general.use_both_clipboard_and_websocket:
        logger.info("Clipboard stays active (use_both_clipboard_and_websocket is enabled).")
        return
    blockers = _clipboard_pause_blockers()
    if blockers:
        logger.info(f"Clipboard monitoring remains paused; still active: {', '.join(blockers)}.")
    else:
        logger.info("No other text sources active; clipboard monitoring will resume shortly.")


def is_inhouse_source_active() -> bool:
    return any(inhouse_sources_active.values())


def _clipboard_pause_blockers() -> list[str]:
    """Human-readable list of sources currently keeping clipboard polling paused."""
    blockers = []
    connected_ws = [resolve_websocket_source_name(uri) for uri, ok in websocket_connected.items() if ok]
    blockers.extend(f"websocket: {name}" for name in connected_ws)
    blockers.extend(source for source, ok in inhouse_sources_active.items() if ok)
    return blockers


def should_pause_clipboard_for_other_source() -> bool:
    """True when a connected websocket or active in-house source should pause clipboard."""
    if get_config().general.use_both_clipboard_and_websocket:
        return False
    return any(websocket_connected.values()) or is_inhouse_source_active()


# ---------------------------------------------------------------------------
# Clipboard monitoring
# ---------------------------------------------------------------------------


async def monitor_clipboard():
    global current_line, last_clipboard
    if not pyperclip:
        logger.warning("Clipboard monitoring is disabled because pyperclip is not available.")
        return
    try:
        current_line = await asyncio.to_thread(pyperclip.paste)
    except Exception as e:
        logger.error(f"Error accessing clipboard: {e}")
        return
    # Treat whatever is already on the clipboard at startup as seen, so we don't
    # ingest stale content on launch.
    last_clipboard = current_line
    send_message_on_resume = False
    loop = asyncio.get_running_loop()
    clipboard_changed = asyncio.Event()
    native_listener = WindowsClipboardListener(
        lambda: loop.call_soon_threadsafe(clipboard_changed.set),
    )
    native_listener_active = native_listener.start()
    intake_was_active = False

    async def wait_for_clipboard_change(timeout: float) -> None:
        if not native_listener_active:
            await asyncio.sleep(timeout)
            return
        try:
            await asyncio.wait_for(clipboard_changed.wait(), timeout=timeout)
        except TimeoutError:
            pass

    try:
        while True:
            if not get_config().general.use_clipboard:
                gsm_status.clipboard_enabled = False
                intake_was_active = False
                clipboard_changed.clear()
                await wait_for_clipboard_change(5)
                continue
            if should_pause_clipboard_for_other_source():
                gsm_status.clipboard_enabled = False
                intake_was_active = False
                clipboard_changed.clear()
                await wait_for_clipboard_change(5)
                send_message_on_resume = True
                continue
            elif send_message_on_resume:
                logger.info("No other text source active; Clipboard Monitoring resumed.")
                send_message_on_resume = False
            gsm_status.clipboard_enabled = True

            # Check once immediately after startup/resume. Afterwards native
            # Windows notifications wake us; the sleep is only the fallback.
            if not intake_was_active:
                intake_was_active = True
            else:
                await wait_for_clipboard_change(0.2)
                if native_listener_active:
                    clipboard_changed.clear()

            try:
                current_clipboard = await asyncio.to_thread(pyperclip.paste)
            except Exception as error:
                logger.debug(f"Error reading clipboard: {error}")
                continue

            # Only act when the clipboard actually changes; cross-source de-dup is
            # handled centrally in handle_new_text_event.
            if current_clipboard and current_clipboard != last_clipboard:
                last_clipboard = current_clipboard
                await handle_new_text_event(
                    current_clipboard,
                    line_time=datetime.now(),
                    source_display_name="Clipboard",
                )
    finally:
        native_listener.stop()


# ---------------------------------------------------------------------------
# Websocket source management
# ---------------------------------------------------------------------------


def resolve_websocket_source_name(uri: str) -> str:
    """Resolve a user-facing source label for a websocket URI."""
    try:
        for source in get_config().general.websocket_sources:
            if source.uri.strip() == uri:
                if source.name and source.name.strip():
                    return source.name.strip()
                break
    except Exception:
        pass

    # Fall back to well-known port names, then the raw URI.
    from GameSentenceMiner.util.config.configuration import WELL_KNOWN_WS_SOURCES

    port = uri.split(":")[-1].strip() if ":" in uri else ""
    return WELL_KNOWN_WS_SOURCES.get(port) or uri


def _has_connected_websocket(websocket_url: str) -> bool:
    connected = getattr(gsm_status, "websockets_connected", None)
    if isinstance(connected, dict):
        return websocket_url in connected
    if isinstance(connected, list):
        return websocket_url in connected
    return False


def _mark_websocket_connected(websocket_url: str, websocket_source_name: str) -> None:
    connected = getattr(gsm_status, "websockets_connected", None)
    if isinstance(connected, dict):
        connected[websocket_url] = websocket_source_name
        return
    if isinstance(connected, list):
        if websocket_url not in connected:
            connected.append(websocket_url)


def _mark_websocket_disconnected(websocket_url: str) -> None:
    connected = getattr(gsm_status, "websockets_connected", None)
    if isinstance(connected, dict):
        connected.pop(websocket_url, None)
        return
    if isinstance(connected, list) and websocket_url in connected:
        connected.remove(websocket_url)


def get_output_websocket_ports():
    """Get all output websocket ports that GSM uses to send data (not receive)."""
    config = get_config()
    output_ports = set()

    # Unified web+websocket public port.
    if hasattr(config.general, "single_port"):
        output_ports.add(str(config.general.single_port))

    # Legacy texthooker port may still be used by users temporarily.
    if hasattr(config.general, "texthooker_port"):
        output_ports.add(str(config.general.texthooker_port))

    return output_ports


def is_output_uri(uri):
    """Check if a URI points to one of GSM's output websockets (prevent self-connection)."""
    output_ports = get_output_websocket_ports()

    # Extract port from URI (handles formats like "localhost:8080" or "127.0.0.1:8080")
    uri_parts = uri.split(":")
    if len(uri_parts) >= 2:
        port = uri_parts[-1].strip()
        if port in output_ports:
            logger.warning(f"Skipping URI {uri} - this is a GSM output port (port {port}), not an input source!")
            return True

    return False


def _get_enabled_websocket_uris() -> set:
    """Collect the set of enabled, non-output websocket URIs from config."""
    uris = set()
    for source in get_config().general.websocket_sources:
        if source.enabled:
            uri = source.uri.strip()
            if uri and not is_output_uri(uri):
                uris.add(uri)
    return uris


async def listen_websockets():
    """Set up websocket listeners and start watching config for changes."""
    global _config_monitor_task

    await update_websocket_connections()

    # Keep a reference so the monitor task is not garbage collected.
    if _config_monitor_task is None or _config_monitor_task.done():
        _config_monitor_task = asyncio.create_task(monitor_websocket_config_changes())


async def update_websocket_connections():
    """Start/stop websocket listener tasks to match the current config."""
    global current_websocket_uris

    config_uris = _get_enabled_websocket_uris()

    # Stop listeners for URIs that are no longer configured.
    for uri in current_websocket_uris - config_uris:
        task_info = websocket_tasks.pop(uri, None)
        if task_info:
            task_info["stop_event"].set()
            logger.info(f"Removed websocket URI from config: {uri}")

    # Start listeners for newly configured URIs.
    for uri in config_uris - current_websocket_uris:
        stop_event = asyncio.Event()
        task = asyncio.create_task(listen_on_websocket(uri, stop_event=stop_event))
        websocket_tasks[uri] = {"task": task, "stop_event": stop_event}
        logger.info(f"Added new websocket URI from config: {uri}")

    current_websocket_uris = config_uris.copy()


async def monitor_websocket_config_changes():
    """Poll the config and reconcile websocket listeners when sources change.

    update_websocket_connections() diffs against current_websocket_uris, so calling
    it repeatedly is a no-op until the configured sources actually change.
    """
    while True:
        await asyncio.sleep(5)
        if not get_config().general.use_websocket:
            continue
        if _get_enabled_websocket_uris() != current_websocket_uris:
            await update_websocket_connections()


async def listen_on_websocket(uri, stop_event=None):
    """Listen to a single websocket connection."""
    try_other = False
    websocket_source_name = resolve_websocket_source_name(uri)
    # External websocket sources are niche now that OCR/texthook run in-house, so
    # reconnect passively: start slow and back off to a long idle poll.
    reconnect_sleep_manager = SleepManager(
        initial_delay=2.0, backoff_factor=2.0, name=f"WebSocket_{uri}", max_delay=5.0
    )

    while True:
        # Stop if this URI was removed from config.
        if stop_event and stop_event.is_set():
            logger.info(f"Stopping websocket listener for {uri} (removed from config)")
            if uri in websocket_connected:
                websocket_connected[uri] = False
            break

        if not get_config().general.use_websocket:
            await asyncio.sleep(5)
            continue

        websocket_url = f"ws://{uri}"
        if try_other:
            websocket_url = f"ws://{uri}/api/ws/text/origin"

        try:
            async with websockets.connect(websocket_url, ping_interval=None) as websocket:
                reconnect_sleep_manager.reset()

                if not _has_connected_websocket(websocket_url):
                    _mark_websocket_connected(websocket_url, websocket_source_name)
                _log_info(
                    f"<cyan>{websocket_source_name} connected Successfully!"
                    + (
                        " Disabling Clipboard Monitor."
                        if (
                            get_config().general.use_clipboard
                            and not get_config().general.use_both_clipboard_and_websocket
                        )
                        else ""
                    )
                    + "</cyan>",
                    colors=True,
                )
                websocket_connected[uri] = True

                async for message in websocket:
                    # Stop mid-connection if the URI was removed from config.
                    if stop_event and stop_event.is_set():
                        logger.info(f"Closing websocket connection to {uri} (removed from config)")
                        break

                    message_received_time = datetime.now()
                    if not message:
                        continue
                    if is_dev:
                        logger.debug(message)

                    line_time = None
                    dict_from_ocr = None
                    source = None
                    try:
                        data = json.loads(message)
                        current_clipboard = data.get("sentence", message)
                        if "time" in data:
                            line_time = datetime.fromisoformat(data["time"])
                        if "dict_from_ocr" in data:
                            dict_from_ocr = data["dict_from_ocr"]
                        if "source" in data:
                            source = data["source"]
                    except (json.JSONDecodeError, TypeError):
                        current_clipboard = message

                    try:
                        await handle_new_text_event(
                            current_clipboard,
                            line_time if line_time else message_received_time,
                            dict_from_ocr=dict_from_ocr,
                            source=source,
                            source_display_name=websocket_source_name,
                        )
                    except Exception as e:
                        logger.exception(f"Error handling new text event: {e}")

        except Exception as e:
            _mark_websocket_disconnected(websocket_url)
            websocket_connected[uri] = False
            if isinstance(e, websockets.InvalidStatus) and e.response and e.response.status_code == 404:
                logger.info(f"WebSocket {uri} returned 404, attempting alternate path.")
                try_other = True

            # Stop before reconnecting if the URI was removed from config.
            if stop_event and stop_event.is_set():
                break

            await reconnect_sleep_manager.async_sleep()


# ---------------------------------------------------------------------------
# Core text intake pipeline
# ---------------------------------------------------------------------------


async def handle_new_text_event(
    current_clipboard,
    line_time=None,
    dict_from_ocr=None,
    source=None,
    source_display_name=None,
    copy_to_clipboard=False,
    exclude_from_stats=False,
    observation_id=None,
    emitted_at=None,
    source_instance=None,
    revision_window_ms=None,
    merge_fragments=None,
    metadata_extra=None,
):
    """Single entry point for every text source (clipboard, websocket, IPC)."""
    global current_line
    guarded_line, guard_reason = guard_text_input(current_clipboard)
    if guarded_line is None:
        logger.warning(f"Blocked text input: {guard_reason}.")
        return
    current_line = guarded_line

    if should_drop_text_input_completely():
        logger.debug("Text intake is paused; dropping incoming text without further processing.")
        return

    await add_line_to_text_log(
        guarded_line,
        line_time,
        dict_from_ocr=dict_from_ocr,
        source=source,
        source_display_name=source_display_name,
        copy_to_clipboard=copy_to_clipboard,
        exclude_from_stats=exclude_from_stats,
        observation_id=observation_id,
        emitted_at=emitted_at,
        source_instance=source_instance,
        revision_window_ms=revision_window_ms,
        merge_fragments=(
            bool(get_config().general.merge_matching_sequential_text)
            if merge_fragments is None
            else bool(merge_fragments)
        ),
        metadata_extra=metadata_extra,
    )


async def add_line_to_text_log(
    line,
    line_time=None,
    dict_from_ocr=None,
    source=None,
    skip_overlay=False,
    source_display_name=None,
    copy_to_clipboard=False,
    exclude_from_stats=False,
    observation_id=None,
    emitted_at=None,
    source_instance=None,
    revision_window_ms=None,
    merge_fragments=False,
    source_sequence=None,
    metadata_extra=None,
):
    return _ingest_line_sync(
        line,
        line_time=line_time,
        dict_from_ocr=dict_from_ocr,
        source=source,
        skip_overlay=skip_overlay,
        source_display_name=source_display_name,
        copy_to_clipboard=copy_to_clipboard,
        exclude_from_stats=exclude_from_stats,
        observation_id=observation_id,
        emitted_at=emitted_at,
        source_instance=source_instance,
        revision_window_ms=revision_window_ms,
        merge_fragments=merge_fragments,
        source_sequence=source_sequence,
        metadata_extra=metadata_extra,
    )


def _ingest_line_sync(
    line,
    line_time=None,
    dict_from_ocr=None,
    source=None,
    skip_overlay=False,
    source_display_name=None,
    copy_to_clipboard=False,
    exclude_from_stats=False,
    observation_id=None,
    emitted_at=None,
    source_instance=None,
    revision_window_ms=None,
    merge_fragments=False,
    wait_projected=True,
    source_sequence=None,
    metadata_extra=None,
):
    global current_line_time
    guarded_line, guard_reason = guard_text_input(line)
    observation_id = str(observation_id or uuid.uuid4())
    if guarded_line is None:
        logger.warning(f"Blocked text input from [{source_display_name or source or 'Unknown'}]: {guard_reason}.")
        return IngressAck(IngressStatus.REJECTED, observation_id, reason=guard_reason or "text blocked")
    if guard_reason == "truncated":
        logger.warning(
            f"Truncated text input from [{source_display_name or source or 'Unknown'}] "
            f"to {len(guarded_line)} characters."
        )

    source_kind = SourceKind.normalize(source, source_display_name)
    if is_message_rate_limited(source_kind.value):
        return IngressAck(IngressStatus.REJECTED, observation_id, reason="skip spam detected")

    current_line_after_regex = apply_text_processing(guarded_line, get_config().text_processing)
    current_line_time = line_time if line_time else datetime.now()
    now_utc = normalize_utc(datetime.now())
    captured_at = normalize_utc(current_line_time)
    emitted = normalize_utc(emitted_at) if isinstance(emitted_at, datetime) else now_utc
    source_key = source_instance or source_display_name or source or source_kind.value
    configured_merge_window = 2000 if merge_fragments else 100
    window_ms = configured_merge_window if revision_window_ms is None else max(0, int(revision_window_ms))
    paused = is_text_intake_paused()
    metadata = {
        "dict_from_ocr": dict_from_ocr,
        "scene": str(getattr(gsm_state, "current_game", "") or ""),
    }
    if isinstance(metadata_extra, dict):
        metadata.update(metadata_extra)
    observation = TextObservation(
        observation_id=observation_id,
        source_kind=source_kind,
        source_instance=str(source_key),
        raw_text=guarded_line,
        processed_text=current_line_after_regex,
        captured_at_utc=captured_at,
        emitted_at_utc=emitted,
        received_at_utc=now_utc,
        received_monotonic_ns=time.monotonic_ns(),
        source_display_name=str(source_display_name or source or "Unknown"),
        source_sequence=int(source_sequence) if source_sequence is not None else None,
        revision_window_ms=window_ms,
        merge_fragments=merge_fragments,
        copy_to_clipboard=bool(copy_to_clipboard),
        excluded_from_stats=bool(exclude_from_stats or paused),
        relay_only=bool(paused),
        skip_overlay=bool(skip_overlay),
        metadata=metadata,
    )
    result = get_authoritative_text_runtime().ingest(observation)
    if result.ack.status is IngressStatus.DUPLICATE:
        _note_authoritative_duplicate(source_kind, result.ack.matched_source)
    elif result.ack.status is IngressStatus.BACKPRESSURED:
        logger.warning(f"Text ingress backpressured for observation {observation.observation_id}")
    elif result.ack.status is IngressStatus.STALE_EXCLUDED:
        logger.warning(f"Excluded stale text observation {observation.observation_id} from the live stream")
    elif result.ack.status is IngressStatus.REJECTED:
        logger.warning(f"Rejected text observation {observation.observation_id}: {result.ack.reason}")
    if wait_projected:
        get_authoritative_text_runtime().wait_projected(timeout=1.0)
    return result.ack


def _parse_ingress_datetime(value, fallback: datetime | None = None) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value) / 1000 if float(value) > 10_000_000_000 else float(value))
        except (OSError, OverflowError, ValueError):
            pass
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            pass
    return fallback or datetime.now()


def ingest_text_v2_payload(payload: dict) -> dict[str, object]:
    """Synchronous request/ack ingress used by Electron and future producers."""
    if not isinstance(payload, dict):
        return {
            "status": IngressStatus.REJECTED.value,
            "observation_id": "",
            "reason": "payload must be an object",
        }
    text = payload.get("text") or payload.get("sentence")
    if not isinstance(text, str) or not text.strip():
        return {
            "status": IngressStatus.REJECTED.value,
            "observation_id": str(payload.get("observation_id") or payload.get("observationId") or ""),
            "reason": "text is required",
        }

    source = str(payload.get("source") or "texthook")
    display_name = str(payload.get("source_display_name") or payload.get("sourceDisplayName") or "")
    captured_at = _parse_ingress_datetime(
        payload.get("captured_at") or payload.get("capturedAt") or payload.get("time")
    )
    emitted_at = _parse_ingress_datetime(
        payload.get("emitted_at") or payload.get("emittedAt"),
        fallback=datetime.now(),
    )
    dict_from_ocr = payload.get("dict_from_ocr")
    if payload.get("engine") == "mages":
        if isinstance(dict_from_ocr, dict) and dict_from_ocr.get("schema") == "gsm_overlay_coords_v1":
            logger.info(
                "MAGES text-position payload received: {} line box(es); forwarding directly to overlay.",
                len(dict_from_ocr.get("lines", [])),
            )
        else:
            logger.warning("MAGES text arrived without position data; overlay will fall back to OCR.")
    ack = _ingest_line_sync(
        text,
        line_time=captured_at,
        dict_from_ocr=dict_from_ocr,
        source=source,
        source_display_name=display_name or None,
        copy_to_clipboard=bool(payload.get("copyToClipboard", payload.get("copy_to_clipboard", False))),
        exclude_from_stats=bool(payload.get("exclude_from_stats", False)),
        observation_id=payload.get("observation_id") or payload.get("observationId"),
        emitted_at=emitted_at,
        source_instance=(
            payload.get("source_instance") or payload.get("sourceInstance") or payload.get("hookId") or display_name
        ),
        revision_window_ms=payload.get("revision_window_ms", payload.get("revisionWindowMs", 100)),
        merge_fragments=bool(payload.get("merge_fragments", payload.get("mergeFragments", False))),
        wait_projected=False,
        source_sequence=payload.get("source_sequence", payload.get("sourceSequence")),
        metadata_extra={key: payload[key] for key in ("hookId", "hookFunction", "engine", "exeName") if key in payload},
    )
    return ack.to_dict()


def _line_from_record(record: TextRecordSnapshot) -> GameLine:
    if not record.relay_only:
        return game_log.upsert_authoritative_line(record)
    line = _projected_lines.get(record.line_id)
    captured_at = to_local_naive_datetime(record.captured_at_utc)
    if line is None:
        line = GameLine(
            id=record.line_id,
            text=record.text,
            time=captured_at,
            prev=None,
            next=None,
            index=-1,
            scene=record.scene,
            source=record.source_kind.value,
            source_padding=TextSource.padding_seconds(record.source_kind.value),
        )
        _projected_lines[record.line_id] = line
    line.text = record.text
    line.revision = record.revision
    line.state = record.state.value
    line.session_id = record.session_id
    line.stream_sequence = record.stream_sequence
    line.first_seen_time = to_local_naive_datetime(record.first_seen_at_utc)
    line.finalized_time = to_local_naive_datetime(record.finalized_at_utc) if record.finalized_at_utc else None
    line.source_instance = record.source_instance
    line.excluded_from_stats = True
    return line


def _project_text_domain_event(event: TextDomainEvent) -> None:
    global current_line_time, _dont_collect_stats_notice_count
    record = event.record
    line = _line_from_record(record)
    source_label = record.source_display_name or record.source_kind.value
    current_line_time = to_local_naive_datetime(record.captured_at_utc)

    from GameSentenceMiner.web.texthooking_page import project_text_domain_event

    project_text_domain_event(event, line)
    if event.kind is TextEventKind.EXPIRED:
        if record.relay_only:
            _projected_lines.pop(record.line_id, None)
        else:
            game_log.remove_by_id(record.line_id)
        return
    if event.kind in (TextEventKind.APPENDED, TextEventKind.UPDATED):
        if event.kind is TextEventKind.APPENDED:
            log_message = f"<cyan>Line Received from [{source_label}]: {record.text}</cyan>"
        else:
            log_message = (
                f"<cyan>Line revised from [{source_label}] "
                f"seq={record.stream_sequence} rev={record.revision}: {record.text}</cyan>"
            )
        _log_info(log_message, colors=True)
        _send_text_received_preview_event(
            record.raw_text,
            record.text,
            current_line_time,
            record.source_kind.value,
            source_label,
        )
        gsm_status.last_line_received = record.first_seen_at_utc.astimezone().strftime("%Y-%m-%d %H:%M:%S")
        if event.kind is TextEventKind.APPENDED and record.copy_to_clipboard and record.text:
            from GameSentenceMiner.util.clipboard import copy as clipboard_copy

            clipboard_copy(record.text)
        _project_overlay_event(record, line)
        if get_config().advanced.dont_collect_stats:
            if (
                event.kind is TextEventKind.APPENDED
                and _dont_collect_stats_notice_count < _DONT_COLLECT_STATS_NOTICE_LIMIT
            ):
                _dont_collect_stats_notice_count += 1
                logger.info("stats is disabled in advanced config, skipping DB")
        elif not record.excluded_from_stats:
            # The tracker has a revision ledger, so provisional text can update
            # stats immediately without double-counting later corrections.
            live_stats_tracker.add_line(
                record.text,
                record.first_seen_at_utc.timestamp(),
                line_id=record.line_id,
                revision=record.revision,
            )
        _notify_discord_activity(record.scene)
        return

    if event.kind is not TextEventKind.FROZEN or record.relay_only:
        return

    obs.add_longplay_srt_line(current_line_time, line)
    if (
        not get_config().advanced.dont_collect_stats
        and not record.excluded_from_stats
        and "nostatspls" not in line.scene.lower()
    ):
        _persist_game_line_async(replace(line, prev=None, next=None))


def _project_overlay_event(record: TextRecordSnapshot, line: GameLine) -> None:
    from GameSentenceMiner.util.communication.overlay_dispatch import OverlayCommand

    # The compatibility GameLine may be revised again immediately; detach the
    # visual command so the actor never observes cross-thread mutation.
    detached_line = replace(line, prev=None, next=None)
    _get_overlay_dispatcher().submit(OverlayCommand(record, detached_line))


def _notify_discord_activity(scene: str) -> None:
    """Notify the optional Discord adapter only after all live projections queue.

    This is deliberately best-effort and non-blocking: a saturated background
    lane may skip a presence refresh, but it can never hold up the next text line.
    """
    discord_config = getattr(get_master_config(), "discord", None)
    if not bool(getattr(discord_config, "enabled", False)):
        return
    try:
        submit_background_work(discord_rpc_manager.update, scene, timeout=0)
    except (MailboxFull, RuntimeError):
        logger.debug("Skipping Discord activity refresh because background work is saturated")


def _get_overlay_dispatcher():
    global _overlay_dispatcher
    if _overlay_dispatcher is None:
        from GameSentenceMiner.util.communication.overlay_dispatch import OverlayDispatcher

        _overlay_dispatcher = OverlayDispatcher()
    return _overlay_dispatcher


def trigger_manual_overlay_scan() -> bool:
    """Route hotkey scans through the same latest-wins overlay owner."""
    from GameSentenceMiner.util.communication.overlay_dispatch import OverlayCommand

    return _get_overlay_dispatcher().submit(OverlayCommand(source=TextSource.HOTKEY))


def _persist_game_line_async(new_line: GameLine) -> None:
    """Persist a game line via the single DB writer without blocking the caller."""

    def _op(_conn):
        try:
            if new_line.scene:
                game_id = GamesTable.get_or_create_id_by_name(new_line.scene)
                GameLinesTable.add_line(new_line, game_id=game_id)
            else:
                GameLinesTable.add_line(new_line)
        except Exception as exc:
            logger.exception(f"Failed to persist game line {new_line.id}: {exc}")

    gsm_db.run_transaction(_op, priority=DB_PRIORITY_HIGH, wait=False)


def _build_transient_output_line(text: str, line_time: datetime, source: str | None = None) -> GameLine:
    line = GameLine(
        id=str(uuid.uuid4()),
        text=text,
        time=line_time,
        prev=None,
        next=None,
        index=-1,
        scene=gsm_state.current_game or "",
        source=source,
        source_padding=TextSource.padding_seconds(source),
    )
    line.excluded_from_stats = True
    return line


async def _handle_paused_text_input(
    processed_line: str,
    line_time: datetime,
    *,
    source: str | None = None,
    source_label: str = "Unknown",
) -> None:
    if not should_relay_outputs_when_text_intake_paused():
        logger.info(f"Text intake paused; ignored line from [{source_label}].")
        return

    logger.info(f"Text intake paused; relaying line from [{source_label}] to texthooker/output websocket clients only.")
    await _add_event_to_texthooker(_build_transient_output_line(processed_line, line_time, source=source))


def reset_line_hotkey_pressed():
    global current_line_time
    logger.info("LINE RESET HOTKEY PRESSED")
    current_line_time = datetime.now()
    gsm_state.last_mined_line = None


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def start_text_monitor():
    global text_monitor_initialized
    text_monitor_initialized = False
    await listen_websockets()
    if get_config().general.use_websocket:
        if get_config().general.use_both_clipboard_and_websocket:
            logger.info("Listening for text on both WebSocket and Clipboard.")
        else:
            logger.info("Listening for text on WebSocket; Clipboard is used only while no WebSocket is connected.")
    text_monitor_initialized = True
    # monitor_clipboard() runs forever; websocket listeners run as background
    # tasks on this same loop.
    await monitor_clipboard()
