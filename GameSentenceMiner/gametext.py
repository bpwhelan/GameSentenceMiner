import asyncio
import json
import uuid

# import pyperclip
import websockets
from collections import defaultdict, deque
from datetime import datetime, timedelta
from rapidfuzz import fuzz

from GameSentenceMiner import obs
from GameSentenceMiner.util.clients.discord_rpc import discord_rpc_manager
from GameSentenceMiner.util.config.configuration import (
    get_config,
    gsm_status,
    logger,
    gsm_state,
    is_dev,
)
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.text_processing import apply_text_processing
from GameSentenceMiner.util.gsm_utils import SleepManager
from GameSentenceMiner.util.overlay.get_overlay_coords import get_overlay_processor
from GameSentenceMiner.util.platform.notification import (
    announce_text_intake_state,
    send_text_intake_paused_notification,
    send_text_intake_resumed_notification,
)
from GameSentenceMiner.util.stats.live_stats import live_stats_tracker
from GameSentenceMiner.util.text_log import GameLine, TextSource, add_line


def _get_overlay_websocket():
    from GameSentenceMiner.web.gsm_websocket import ID_OVERLAY, websocket_manager

    return ID_OVERLAY, websocket_manager


async def _add_event_to_texthooker(new_line):
    from GameSentenceMiner.web.texthooking_page import add_event_to_texthooker

    await add_event_to_texthooker(new_line)


pyperclip = None
try:
    import pyperclipfix as pyperclip
except Exception:
    logger.warning("failed to import pyperclip, clipboard monitoring will not work!")

current_line = ""
current_line_after_regex = ""
current_line_time = datetime.now()
# Track the start time for the current sequence
current_sequence_start_time = None
# Track the last raw clipboard text for prefix comparison
last_raw_clipboard = ""
timer = None

last_clipboard = ""

reconnecting = False
websocket_connected = {}
websocket_tasks = {}  # Track active websocket tasks by URI
current_websocket_uris = set()  # Track current URIs from config
text_monitor_initialized = False

# Rate-based spam detection globals
message_timestamps = defaultdict(lambda: deque(maxlen=60))  # Store last 60 message timestamps per source
rate_limit_active = defaultdict(bool)  # Track if rate limiting is active per source


def is_ocr_websocket_uri(uri: str) -> bool:
    """Return True when a websocket URI targets GSM's internal OCR feed."""
    ocr_uri = f"localhost:{get_config().advanced.ocr_websocket_port}"
    return uri.strip() == ocr_uri


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


def resolve_websocket_source_name(uri: str) -> str:
    """Resolve a user-facing source label for a websocket URI."""
    websocket_source_name = ""
    if is_ocr_websocket_uri(uri):
        websocket_source_name = "GSM OCR"
    try:
        if not websocket_source_name:
            for source in get_config().general.websocket_sources:
                if source.uri.strip() == uri:
                    websocket_source_name = source.name.strip() if source.name else ""
                    break
    except Exception:
        pass
    if not websocket_source_name:
        # Fallback to well-known port names
        from GameSentenceMiner.util.config.configuration import WELL_KNOWN_WS_SOURCES

        port = uri.split(":")[-1].strip() if ":" in uri else ""
        websocket_source_name = WELL_KNOWN_WS_SOURCES.get(port, "")
    if not websocket_source_name:
        websocket_source_name = uri
    return websocket_source_name


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
    send_message_on_resume = False
    time_received = datetime.now()
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
        current_clipboard = pyperclip.paste()

        if current_clipboard and current_clipboard != current_line and current_clipboard != last_clipboard:
            # Check for rate limiting before processing
            if is_message_rate_limited("clipboard"):
                continue  # Drop message due to rate limiting
            last_clipboard = current_clipboard
            await handle_new_text_event(
                current_clipboard,
                line_time=time_received,
                source_display_name="Clipboard",
            )
        time_received = datetime.now()
        await asyncio.sleep(0.2)


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


async def listen_websockets():
    """Main websocket listener that manages connections and adapts to config changes."""
    global websocket_tasks, current_websocket_uris

    # Start config monitoring task
    asyncio.create_task(monitor_websocket_config_changes())

    # Initial setup of websocket connections
    await update_websocket_connections()


async def update_websocket_connections():
    """Update websocket connections based on current config."""
    global websocket_tasks, current_websocket_uris

    # Get URIs from the new websocket_sources list
    config_uris = set()
    for source in get_config().general.websocket_sources:
        if source.enabled:
            uri = source.uri.strip()
            if uri and not is_output_uri(uri):
                config_uris.add(uri)

    # Determine which URIs to add and remove
    uris_to_add = config_uris - current_websocket_uris
    uris_to_remove = current_websocket_uris - config_uris

    # Stop tasks for removed URIs
    for uri in uris_to_remove:
        if uri in websocket_tasks:
            task_info = websocket_tasks[uri]
            task_info["stop_event"].set()  # Signal task to stop
            logger.info(f"Removed websocket URI from config: {uri}")
            del websocket_tasks[uri]

    # Start tasks for new URIs
    for uri in uris_to_add:
        stop_event = asyncio.Event()
        task = asyncio.create_task(listen_on_websocket(uri, max_sleep=1, stop_event=stop_event))
        websocket_tasks[uri] = {"task": task, "stop_event": stop_event}
        logger.info(f"Added new websocket URI from config: {uri}")

    # Always ensure OCR websocket is running (separate from user-configured URIs)
    ocr_uri = f"localhost:{get_config().advanced.ocr_websocket_port}"
    if ocr_uri not in websocket_tasks:
        stop_event = asyncio.Event()
        task = asyncio.create_task(listen_on_websocket(ocr_uri, max_sleep=0.5, stop_event=stop_event))
        websocket_tasks[ocr_uri] = {"task": task, "stop_event": stop_event}
        logger.info(f"Started OCR websocket listener on {ocr_uri}")

    # Update tracking
    current_websocket_uris = config_uris.copy()


async def monitor_websocket_config_changes():
    """Monitor config for websocket URI changes and update connections accordingly."""
    global current_websocket_uris
    last_config_uris = set()

    while True:
        await asyncio.sleep(5)

        if not get_config().general.use_websocket:
            continue

        # Get current URIs from websocket_sources
        config_uris = set()
        for source in get_config().general.websocket_sources:
            if source.enabled:
                uri = source.uri.strip()
                if uri and not is_output_uri(uri):
                    config_uris.add(uri)

        # Check if config has changed
        if config_uris != last_config_uris:
            await update_websocket_connections()
            last_config_uris = config_uris.copy()


async def listen_on_websocket(uri, max_sleep=1, stop_event=None):
    """Listen to a single websocket connection."""
    global current_line, current_line_time, websocket_connected
    try_other = False

    websocket_source_name = resolve_websocket_source_name(uri)

    reconnect_sleep_manager = SleepManager(initial_delay=0.5, name=f"WebSocket_{uri}")

    while True:
        # Check if this task should stop (URI removed from config)
        if stop_event and stop_event.is_set():
            logger.info(f"Stopping websocket listener for {uri} (removed from config)")
            if uri in websocket_connected:
                websocket_connected[uri] = False
            break

        if not get_config().general.use_websocket and not is_ocr_websocket_uri(uri):
            await asyncio.sleep(5)
            continue

        websocket_url = f"ws://{uri}"
        if try_other:
            websocket_url = f"ws://{uri}/api/ws/text/origin"

        try:
            async with websockets.connect(websocket_url, ping_interval=None) as websocket:
                reconnect_sleep_manager.reset()

                websocket_source = f"websocket_{uri}"
                if websocket_url not in gsm_status.websockets_connected:
                    gsm_status.websockets_connected.append(websocket_url)
                logger.opt(colors=True).info(
                    f"<cyan>{websocket_source_name} connected Successfully!"
                    + (
                        " Disabling Clipboard Monitor."
                        if (
                            get_config().general.use_clipboard
                            and not get_config().general.use_both_clipboard_and_websocket
                        )
                        else ""
                    )
                    + "</cyan>"
                )
                websocket_connected[uri] = True

                async for message in websocket:
                    # Check if task should stop mid-connection
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
                        if current_clipboard != current_line:
                            await handle_new_text_event(
                                current_clipboard,
                                line_time if line_time else message_received_time,
                                dict_from_ocr=dict_from_ocr,
                                source=source,
                                source_display_name=websocket_source_name,
                            )
                    except Exception as e:
                        logger.exception(f"Error handling new text event: {e}")

        except (
            websockets.ConnectionClosed,
            ConnectionError,
            websockets.InvalidStatus,
            ConnectionResetError,
            Exception,
        ) as e:
            if websocket_url in gsm_status.websockets_connected:
                gsm_status.websockets_connected.remove(websocket_url)
            websocket_connected[uri] = False
            if isinstance(e, websockets.InvalidStatus) and e.response and e.response.status_code == 404:
                logger.info(f"WebSocket {uri} returned 404, attempting alternate path.")
                try_other = True

            # Check if task should stop before reconnecting
            if stop_event and stop_event.is_set():
                break

            await reconnect_sleep_manager.async_sleep()


async def merge_sequential_lines(line, start_time=None, source=None, source_display_name=None):
    if not get_config().general.merge_matching_sequential_text:
        return
    logger.info(f"Merging Sequential Lines: {line}")
    # Use the sequence start time for the merged line
    await add_line_to_text_log(
        line,
        start_time if start_time else datetime.now(),
        source=source,
        source_display_name=source_display_name,
    )
    timer = None
    # Reset sequence tracking
    current_sequence_start_time = None
    last_raw_clipboard = ""


def schedule_merge(wait, coro, args):
    async def wrapper():
        await asyncio.sleep(wait)
        await coro(*args)

    task = asyncio.create_task(wrapper())
    return task


async def handle_new_text_event(
    current_clipboard,
    line_time=None,
    dict_from_ocr=None,
    source=None,
    source_display_name=None,
):
    global \
        current_line, \
        current_line_time, \
        current_line_after_regex, \
        timer, \
        current_sequence_start_time, \
        last_raw_clipboard
    current_line = current_clipboard
    if should_drop_text_input_completely():
        logger.debug("Text intake is paused; dropping incoming text without further processing.")
        return
    obs.update_current_game()
    discord_rpc_manager.update(obs.get_current_game(sanitize=False, update=False))
    # Only apply this logic if merging is enabled
    if get_config().general.merge_matching_sequential_text:
        # If no timer is active, this is the start of a new sequence
        if not timer:
            current_sequence_start_time = line_time if line_time else datetime.now()
            last_raw_clipboard = current_line
            # Start the timer
            timer = schedule_merge(
                2,
                merge_sequential_lines,
                [current_line[:], current_sequence_start_time, source, source_display_name],
            )
        else:
            # If the new text starts with the previous, reset the timer (do not update start time)
            if current_line.startswith(last_raw_clipboard) or fuzz.ratio(current_line, last_raw_clipboard) > 50:
                last_raw_clipboard = current_line
                timer.cancel()
                timer = schedule_merge(
                    2,
                    merge_sequential_lines,
                    [current_line[:], current_sequence_start_time, source, source_display_name],
                )
            else:
                # If not a prefix, treat as a new sequence
                # timer.cancel()
                current_sequence_start_time = line_time if line_time else datetime.now()
                last_raw_clipboard = current_line
                timer = schedule_merge(
                    2,
                    merge_sequential_lines,
                    [current_line[:], current_sequence_start_time, source, source_display_name],
                )
    else:
        await add_line_to_text_log(
            current_line,
            line_time,
            dict_from_ocr=dict_from_ocr,
            source=source,
            source_display_name=source_display_name,
        )


async def add_line_to_text_log(
    line,
    line_time=None,
    dict_from_ocr=None,
    source=None,
    skip_overlay=False,
    source_display_name=None,
):
    current_line_after_regex = apply_text_processing(line, get_config().text_processing)
    source_label = source_display_name or source or "Unknown"
    logger.opt(colors=True).info(f"<cyan>Line Received from [{source_label}]: {current_line_after_regex}</cyan>")
    current_line_time = line_time if line_time else datetime.now()
    if is_text_intake_paused():
        await _handle_paused_text_input(
            current_line_after_regex,
            current_line_time,
            source=source,
            source_label=source_label,
        )
        return

    live_stats_tracker.add_line(current_line_after_regex, current_line_time.timestamp())
    gsm_status.last_line_received = current_line_time.strftime("%Y-%m-%d %H:%M:%S")

    new_line = add_line(current_line_after_regex, current_line_time, source=source)
    if not new_line:
        return

    await _add_event_to_texthooker(new_line)
    id_overlay, websocket_manager = _get_overlay_websocket()
    if websocket_manager.has_clients(id_overlay) and not skip_overlay:
        if get_overlay_processor().ready:
            # Increment sequence to mark this as the latest request
            get_overlay_processor()._current_sequence += 1
            asyncio.run_coroutine_threadsafe(
                get_overlay_processor().find_box_and_send_to_overlay(
                    new_line,
                    dict_from_ocr=dict_from_ocr,
                    sequence=get_overlay_processor()._current_sequence,
                ),
                get_overlay_processor().processing_loop,
            )
    obs.add_longplay_srt_line(current_line_time, new_line)

    # Link the new_line to the games table, but skip if 'nostatspls' in scene
    if "nostatspls" not in new_line.scene.lower():
        if new_line.scene:
            # Get or create the game record
            game = GamesTable.get_or_create_by_name(new_line.scene)
            # Add the line with the game_id
            GameLinesTable.add_line(new_line, game_id=game.id)
        else:
            # Fallback if no scene is set
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


# def run_websocket_listener():
#     asyncio.run(listen_websockets())


async def start_text_monitor():
    global text_monitor_initialized
    text_monitor_initialized = False
    await listen_websockets()
    if get_config().general.use_websocket:
        if get_config().general.use_both_clipboard_and_websocket:
            logger.info("Listening for Text on both WebSocket and Clipboard.")
        else:
            logger.info(
                "Both WebSocket and Clipboard monitoring are enabled. WebSocket will take precedence if connected."
            )
    text_monitor_initialized = True
    await monitor_clipboard()
    while True:
        await asyncio.sleep(60)
