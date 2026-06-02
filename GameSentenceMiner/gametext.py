import asyncio
import json
import os
import uuid

import websockets
from collections import defaultdict, deque
from datetime import datetime, timedelta
from rapidfuzz import fuzz

from GameSentenceMiner import obs
from GameSentenceMiner.util.clients.discord_rpc import discord_rpc_manager
from GameSentenceMiner.util.communication.electron_ipc import send_message
from GameSentenceMiner.util.config.configuration import (
    get_config,
    gsm_status,
    logger,
    gsm_state,
    is_dev,
)
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.write_queue import db_write_queue
from GameSentenceMiner.util.text_processing import apply_text_processing
from GameSentenceMiner.util.gsm_utils import SleepManager
from GameSentenceMiner.util.overlay.get_overlay_coords import get_overlay_processor
from GameSentenceMiner.util.platform.notification import (
    announce_text_intake_state,
    send_text_intake_paused_notification,
    send_text_intake_resumed_notification,
)
from GameSentenceMiner.util.stats.live_stats import live_stats_tracker
from GameSentenceMiner.util.text_log import (
    GameLine,
    TextSource,
    add_line,
)

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

# Sequential-merge bookkeeping (only used when merge_matching_sequential_text is on).
current_sequence_start_time = None
last_raw_clipboard = ""
timer = None

last_clipboard = ""

websocket_connected = {}
websocket_tasks = {}  # Track active websocket listener tasks by URI
current_websocket_uris = set()  # URIs we currently have listeners for
_config_monitor_task = None  # Long-lived task watching config for URI changes
text_monitor_initialized = False

# Rate-based spam detection: keep the last 60 message timestamps per source.
message_timestamps = defaultdict(lambda: deque(maxlen=60))
rate_limit_active = defaultdict(bool)

# De-duplication of incoming text events. Every source (clipboard, websocket, and
# Electron IPC such as OCR / texthook) funnels through handle_new_text_event, so a
# single recent-history check here covers all of them -- including IPC events that
# never touch the clipboard or a websocket.
_DEDUP_WINDOW_SECONDS = 2.0
_recent_text_events = deque(maxlen=20)  # entries of (text, arrival_datetime)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _get_overlay_websocket():
    from GameSentenceMiner.web.gsm_websocket import ID_OVERLAY, websocket_manager

    return ID_OVERLAY, websocket_manager


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
# De-duplication
# ---------------------------------------------------------------------------


def _is_duplicate_text_event(text: str) -> bool:
    """Return True when this exact text was already accepted recently.

    Two kinds of duplicates are dropped:
      * An immediate repeat of the last accepted line (e.g. OCR re-reading an
        unchanged screen), regardless of how much time has passed.
      * The same line echoed by a second source within a short window (e.g. OCR
        delivering over IPC while the clipboard picks up the same text moments
        later).

    Dialogue that legitimately recurs later, with other lines in between, is
    still accepted because it is no longer the most recent line.
    """
    if not text:
        return False
    if _recent_text_events and _recent_text_events[-1][0] == text:
        return True
    now = datetime.now()
    for previous_text, previous_time in _recent_text_events:
        if previous_text == text and (now - previous_time).total_seconds() <= _DEDUP_WINDOW_SECONDS:
            return True
    return False


def _record_text_event(text: str) -> None:
    _recent_text_events.append((text, datetime.now()))


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------


def is_message_rate_limited(source="clipboard"):
    """
    Aggressive rate-based spam detection optimized for game texthookers.
    Uses multiple time windows for faster detection and recovery.

    Args:
        source (str): The source of the message (clipboard, websocket, etc.)

    Returns:
        bool: True if message should be dropped due to rate limiting
    """
    current_time = datetime.now()
    timestamps = message_timestamps[source]

    # Add current message timestamp
    timestamps.append(current_time)

    # Check multiple time windows for aggressive detection
    half_second_ago = current_time - timedelta(milliseconds=500)
    one_second_ago = current_time - timedelta(seconds=1)

    # Count messages in different time windows
    last_500ms = sum(1 for ts in timestamps if ts > half_second_ago)
    last_1s = sum(1 for ts in timestamps if ts > one_second_ago)

    # Very aggressive thresholds for game texthookers:
    # - 5+ messages in 500ms = instant spam detection
    # - 8+ messages in 1 second = spam detection
    spam_detected = last_500ms >= 5 or last_1s >= 8

    if spam_detected:
        if not rate_limit_active[source]:
            logger.warning(f"Rate limiting activated for {source}: {last_500ms} msgs/500ms, {last_1s} msgs/1s")
            rate_limit_active[source] = True
        return True

    # If rate limiting is active, check if we can deactivate it immediately
    if rate_limit_active[source]:
        # Very fast recovery: allow if current 500ms window has <= 2 messages
        if last_500ms <= 2:
            logger.background(f"Rate limiting deactivated for {source}: rate normalized ({last_500ms} msgs/500ms)")
            rate_limit_active[source] = False
            return False  # Allow this message through
        else:
            # Still too fast, keep dropping
            return True

    return False


# ---------------------------------------------------------------------------
# Clipboard monitoring
# ---------------------------------------------------------------------------


async def monitor_clipboard():
    global current_line, last_clipboard
    if not pyperclip:
        logger.warning("Clipboard monitoring is disabled because pyperclip is not available.")
        return
    try:
        current_line = pyperclip.paste()
    except Exception as e:
        logger.error(f"Error accessing clipboard: {e}")
        return
    # Treat whatever is already on the clipboard at startup as seen, so we don't
    # ingest stale content on launch.
    last_clipboard = current_line
    send_message_on_resume = False
    while True:
        if not get_config().general.use_clipboard:
            gsm_status.clipboard_enabled = False
            await asyncio.sleep(5)
            continue
        if not get_config().general.use_both_clipboard_and_websocket and any(websocket_connected.values()):
            gsm_status.clipboard_enabled = False
            await asyncio.sleep(5)
            send_message_on_resume = True
            continue
        elif send_message_on_resume:
            logger.info("No Websocket Connections, resuming Clipboard Monitoring.")
            send_message_on_resume = False
        gsm_status.clipboard_enabled = True
        time_received = datetime.now()
        current_clipboard = pyperclip.paste()

        # Only act when the clipboard actually changes; cross-source de-dup is
        # handled centrally in handle_new_text_event.
        if current_clipboard and current_clipboard != last_clipboard:
            if is_message_rate_limited("clipboard"):
                await asyncio.sleep(0.2)
                continue
            last_clipboard = current_clipboard
            await handle_new_text_event(
                current_clipboard,
                line_time=time_received,
                source_display_name="Clipboard",
            )
        await asyncio.sleep(0.2)


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
    reconnect_sleep_manager = SleepManager(initial_delay=0.5, name=f"WebSocket_{uri}")

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

                websocket_source = f"websocket_{uri}"
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
                    if is_message_rate_limited(websocket_source):
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
# Sequential line merging
# ---------------------------------------------------------------------------


async def merge_sequential_lines(line, start_time=None, source=None, source_display_name=None):
    if not get_config().general.merge_matching_sequential_text:
        return
    logger.info(f"Merging Sequential Lines: {line}")
    # Use the sequence start time for the merged line.
    await add_line_to_text_log(
        line,
        start_time if start_time else datetime.now(),
        source=source,
        source_display_name=source_display_name,
    )


def schedule_merge(wait, coro, args):
    async def wrapper():
        await asyncio.sleep(wait)
        await coro(*args)

    return asyncio.create_task(wrapper())


def _schedule_sequential_merge(line_text, line_time, source, source_display_name):
    """Debounce rapidly-growing text (e.g. OCR streaming a sentence) into one line.

    A new fragment that extends (or closely matches) the previous one keeps the
    same sequence and just resets the flush timer; an unrelated line starts a new
    sequence while letting the previous sequence's pending flush fire.
    """
    global timer, current_sequence_start_time, last_raw_clipboard

    is_continuation = bool(timer) and (
        line_text.startswith(last_raw_clipboard) or fuzz.ratio(line_text, last_raw_clipboard) > 50
    )

    if is_continuation:
        # Same sequence: keep the original start time and restart the flush timer.
        timer.cancel()
    else:
        # New sequence: do not cancel any in-flight flush for the prior sequence.
        current_sequence_start_time = line_time if line_time else datetime.now()

    last_raw_clipboard = line_text
    timer = schedule_merge(
        2,
        merge_sequential_lines,
        [line_text, current_sequence_start_time, source, source_display_name],
    )


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
):
    """Single entry point for every text source (clipboard, websocket, IPC)."""
    global current_line
    current_line = current_clipboard

    if should_drop_text_input_completely():
        logger.debug("Text intake is paused; dropping incoming text without further processing.")
        return

    if _is_duplicate_text_event(current_clipboard):
        logger.debug(f"Dropping duplicate text event from [{source_display_name or source or 'Unknown'}].")
        return
    _record_text_event(current_clipboard)

    obs.update_current_game()
    discord_rpc_manager.update(obs.get_current_game(sanitize=False, update=False))

    if get_config().general.merge_matching_sequential_text:
        _schedule_sequential_merge(current_clipboard, line_time, source, source_display_name)
    else:
        await add_line_to_text_log(
            current_clipboard,
            line_time,
            dict_from_ocr=dict_from_ocr,
            source=source,
            source_display_name=source_display_name,
            copy_to_clipboard=copy_to_clipboard,
        )


async def add_line_to_text_log(
    line,
    line_time=None,
    dict_from_ocr=None,
    source=None,
    skip_overlay=False,
    source_display_name=None,
    copy_to_clipboard=False,
):
    global current_line_time

    current_line_after_regex = apply_text_processing(line, get_config().text_processing)
    source_label = source_display_name or source or "Unknown"
    _log_info(f"<cyan>Line Received from [{source_label}]: {current_line_after_regex}</cyan>", colors=True)
    current_line_time = line_time if line_time else datetime.now()

    if copy_to_clipboard and current_line_after_regex:
        from GameSentenceMiner.util.clipboard import copy as clipboard_copy

        clipboard_copy(current_line_after_regex)

    _send_text_received_preview_event(
        line,
        current_line_after_regex,
        current_line_time,
        source,
        source_display_name,
    )
    if is_text_intake_paused():
        await _handle_paused_text_input(
            current_line_after_regex,
            current_line_time,
            source=source,
            source_label=source_label,
        )
        return

    # When the current game isn't actually being captured by OBS (e.g. manual OCR
    # left running for the screen cropper while not gaming), don't mine the line:
    # the clipboard copy above already ran, so just relay it to the texthooker/output
    # websocket clients and stop before stats/DB/overlay/persistence.
    # if not obs.is_game_capture_active():
    #     logger.info(
    #         f"Game not being captured by OBS; relaying line from [{source_label}] to texthooker/output only."
    #     )
    #     await _add_event_to_texthooker(
    #         _build_transient_output_line(current_line_after_regex, current_line_time, source=source)
    #     )
    #     from GameSentenceMiner.util.clipboard import copy as clipboard_copy

    #     if copy_to_clipboard and current_line_after_regex:
    #         from GameSentenceMiner.util.clipboard import copy as clipboard_copy

    #         clipboard_copy(current_line_after_regex)
    #     return

    live_stats_tracker.add_line(current_line_after_regex, current_line_time.timestamp())
    gsm_status.last_line_received = current_line_time.strftime("%Y-%m-%d %H:%M:%S")

    new_line = add_line(current_line_after_regex, current_line_time, source=source)
    if not new_line:
        return

    await _add_event_to_texthooker(new_line)
    id_overlay, websocket_manager = _get_overlay_websocket()
    if websocket_manager.has_clients(id_overlay) and not skip_overlay:
        overlay_processor = get_overlay_processor()
        if overlay_processor.ready:
            # Increment sequence to mark this as the latest request
            overlay_processor._current_sequence += 1
            asyncio.run_coroutine_threadsafe(
                overlay_processor.find_box_and_send_to_overlay(
                    new_line,
                    dict_from_ocr=dict_from_ocr,
                    sequence=overlay_processor._current_sequence,
                ),
                overlay_processor.processing_loop,
            )
    obs.add_longplay_srt_line(current_line_time, new_line)

    # Persist the line to SQLite asynchronously via the dedicated DB writer thread
    # so a slow/locked DB never stalls the text-intake pipeline.
    if "nostatspls" not in new_line.scene.lower():
        if new_line.scene:
            db_write_queue.submit(_persist_line_with_scene, new_line)
        else:
            db_write_queue.submit(GameLinesTable.add_line, new_line)


def _persist_line_with_scene(new_line: GameLine) -> None:
    """Look up/create the game record for the line's scene, then insert the line.

    Runs on the DB writer thread (never on the text-intake loop).
    """
    try:
        game = GamesTable.get_or_create_by_name(new_line.scene)
        GameLinesTable.add_line(new_line, game_id=game.id)
    except Exception:
        # Fall back to scene-less insert so we don't lose the line entirely.
        logger.exception(f"Failed to associate line with game '{new_line.scene}'; inserting without game_id.")
        GameLinesTable.add_line(new_line)


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
