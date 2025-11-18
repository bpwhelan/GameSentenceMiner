import asyncio
import json
import re
from datetime import datetime, timedelta
from collections import defaultdict, deque


    # import pyperclip
import requests
import websockets
from websockets import InvalidStatus
from rapidfuzz import fuzz

from GameSentenceMiner.util.configuration import get_config, gsm_status, logger, gsm_state, is_dev
from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.games_table import GamesTable
from GameSentenceMiner.util.gsm_utils import do_text_replacements, TEXT_REPLACEMENTS_FILE, run_new_thread
from GameSentenceMiner import obs
from GameSentenceMiner.util.gsm_utils import add_srt_line
from GameSentenceMiner.util.text_log import add_line, get_text_log
from GameSentenceMiner.web.texthooking_page import add_event_to_texthooker, overlay_server_thread

from GameSentenceMiner.util.get_overlay_coords import get_overlay_processor

pyperclip = None
try:
    import pyperclipfix as pyperclip
except Exception:
    logger.warning("failed to import pyperclip, clipboard monitoring will not work!")

current_line = ''
current_line_after_regex = ''
current_line_time = datetime.now()
# Track the start time for the current sequence
current_sequence_start_time = None
# Track the last raw clipboard text for prefix comparison
last_raw_clipboard = ''
timer = None

last_clipboard = ''

reconnecting = False
websocket_connected = {}

# Rate-based spam detection globals
message_timestamps = defaultdict(lambda: deque(maxlen=60))  # Store last 60 message timestamps per source
rate_limit_active = defaultdict(bool)  # Track if rate limiting is active per source


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
            logger.info(f"Rate limiting deactivated for {source}: rate normalized ({last_500ms} msgs/500ms)")
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
            await handle_new_text_event(current_clipboard, line_time=time_received)
        time_received = datetime.now()
        await asyncio.sleep(0.2)


async def listen_websockets():
    async def listen_on_websocket(uri, max_sleep=1):
        global current_line, current_line_time, websocket_connected
        try_other = False
        websocket_names = {
            "9002": "GSM OCR",
            "9001": "Agent or TextractorSender",
            "6677": "textractor_websocket",
            "2333": "LunaTranslator"
        }
        likely_websocket_name = next((f" ({name})" for port, name in websocket_names.items() if port in uri), "")
        
        reconnect_sleep = .5
        
        while True:
            if not get_config().general.use_websocket:
                await asyncio.sleep(5)
                continue
            
            websocket_url = f'ws://{uri}'
            if try_other:
                websocket_url = f'ws://{uri}/api/ws/text/origin'
                
            try:
                async with websockets.connect(websocket_url, ping_interval=None) as websocket:
                    reconnect_sleep = 1
                    
                    websocket_source = f"websocket_{uri}"
                    if websocket_url not in gsm_status.websockets_connected:
                        gsm_status.websockets_connected.append(websocket_url)
                    logger.info(f"Texthooker WebSocket {uri}{likely_websocket_name} connected Successfully!" + (" Disabling Clipboard Monitor." if (get_config().general.use_clipboard and not get_config().general.use_both_clipboard_and_websocket) else ""))
                    websocket_connected[uri] = True
                    
                    async for message in websocket:
                        message_received_time = datetime.now()
                        if not message:
                            continue
                        if is_message_rate_limited(websocket_source):
                            continue
                        if is_dev:
                            logger.debug(message)
                        
                        line_time = None
                        try:
                            data = json.loads(message)
                            current_clipboard = data.get("sentence", message)
                            if "time" in data:
                                line_time = datetime.fromisoformat(data["time"])
                        except (json.JSONDecodeError, TypeError):
                            current_clipboard = message
                            
                        if current_clipboard != current_line:
                            await handle_new_text_event(current_clipboard, line_time if line_time else message_received_time)
                            
            except (websockets.ConnectionClosed, ConnectionError, websockets.InvalidStatus, ConnectionResetError, Exception) as e:
                if websocket_url in gsm_status.websockets_connected:
                    gsm_status.websockets_connected.remove(websocket_url)
                websocket_connected[uri] = False
                if isinstance(e, websockets.InvalidStatus) and e.response and e.response.status_code == 404:
                    logger.info(f"WebSocket {uri} returned 404, attempting alternate path.")
                    try_other = True
                
                await asyncio.sleep(reconnect_sleep)

                reconnect_sleep = min(reconnect_sleep * 2, max_sleep)

    websocket_tasks = []
    if ',' in get_config().general.websocket_uri:
        for uri in get_config().general.websocket_uri.split(','):
            websocket_tasks.append(listen_on_websocket(uri.strip())) # Use strip() to handle spaces
    else:
        websocket_tasks.append(listen_on_websocket(get_config().general.websocket_uri.strip()))

    websocket_tasks.append(listen_on_websocket(f"localhost:{get_config().advanced.ocr_websocket_port}", max_sleep=.5))

    await asyncio.gather(*websocket_tasks)
    
    
async def merge_sequential_lines(line, start_time=None):
    if not get_config().general.merge_matching_sequential_text:
        return
    logger.info(f"Merging Sequential Lines: {line}")
    # Use the sequence start time for the merged line
    await add_line_to_text_log(line, start_time if start_time else datetime.now())
    timer = None
    # Reset sequence tracking
    current_sequence_start_time = None
    last_raw_clipboard = ''
    
def schedule_merge(wait, coro, args):
    async def wrapper():
        await asyncio.sleep(wait)
        await coro(*args)
    task = asyncio.create_task(wrapper())
    return task


async def handle_new_text_event(current_clipboard, line_time=None):
    global current_line, current_line_time, current_line_after_regex, timer, current_sequence_start_time, last_raw_clipboard
    obs.update_current_game()
    current_line = current_clipboard
    # Only apply this logic if merging is enabled
    if get_config().general.merge_matching_sequential_text:
        logger.info(f"Current Line: {current_line} last raw clipboard: {last_raw_clipboard}")
        # If no timer is active, this is the start of a new sequence
        if not timer:
            logger.info("Starting a new sequence of text lines.")
            current_sequence_start_time = line_time if line_time else datetime.now()
            last_raw_clipboard = current_line
            # Start the timer
            timer = schedule_merge(2, merge_sequential_lines, [current_line[:], current_sequence_start_time])
        else:
            # If the new text starts with the previous, reset the timer (do not update start time)
            if current_line.startswith(last_raw_clipboard) or fuzz.ratio(current_line, last_raw_clipboard) > 50:
                logger.info(f"Current line starts with last raw clipboard: {current_line} starts with {last_raw_clipboard}")
                last_raw_clipboard = current_line
                timer.cancel()
                timer = schedule_merge(2, merge_sequential_lines, [current_line[:], current_sequence_start_time])
            else:
                logger.info(f"Current line does not start with last raw clipboard: {current_line} does not start with {last_raw_clipboard}")
                # If not a prefix, treat as a new sequence
                # timer.cancel()
                current_sequence_start_time = line_time if line_time else datetime.now()
                last_raw_clipboard = current_line
                timer = schedule_merge(2, merge_sequential_lines, [current_line[:], current_sequence_start_time])
    else:
        await add_line_to_text_log(current_line, line_time)

                
async def add_line_to_text_log(line, line_time=None):
    if get_config().general.texthook_replacement_regex:
        current_line_after_regex = re.sub(get_config().general.texthook_replacement_regex, '', line)
    else:
        current_line_after_regex = line
    current_line_after_regex = do_text_replacements(current_line_after_regex, TEXT_REPLACEMENTS_FILE)
    logger.info(f"Line Received: {current_line_after_regex}")
    current_line_time = line_time if line_time else datetime.now()
    gsm_status.last_line_received = current_line_time.strftime("%Y-%m-%d %H:%M:%S")
    new_line = add_line(current_line_after_regex, line_time if line_time else datetime.now())
    if len(get_text_log().values) > 0:
        await add_event_to_texthooker(get_text_log()[-1])
    if get_config().overlay.websocket_port and overlay_server_thread.has_clients():
        if get_overlay_processor().ready:
            asyncio.create_task(get_overlay_processor().find_box_and_send_to_overlay(current_line_after_regex))
    add_srt_line(line_time, new_line)
    
    # Link the game_line to the games table, but skip if 'nostatspls' in scene
    game_line = get_text_log()[-1]
    if 'nostatspls' not in game_line.scene.lower():
        if game_line.scene:
            # Get or create the game record
            game = GamesTable.get_or_create_by_name(game_line.scene)
            # Add the line with the game_id
            GameLinesTable.add_line(game_line, game_id=game.id)
        else:
            # Fallback if no scene is set
            GameLinesTable.add_line(game_line)

def reset_line_hotkey_pressed():
    global current_line_time
    logger.info("LINE RESET HOTKEY PRESSED")
    current_line_time = datetime.now()
    gsm_state.last_mined_line = None


# def run_websocket_listener():
#     asyncio.run(listen_websockets())


async def start_text_monitor():
    await listen_websockets()
    if get_config().general.use_websocket:
        if get_config().general.use_both_clipboard_and_websocket:
            logger.info("Listening for Text on both WebSocket and Clipboard.")
        else:
            logger.info("Both WebSocket and Clipboard monitoring are enabled. WebSocket will take precedence if connected.")
    await monitor_clipboard()
    while True:
        await asyncio.sleep(60)