import asyncio
import re

import pyperclip
import requests
import websockets
from websockets import InvalidStatus
from rapidfuzz import fuzz

from GameSentenceMiner.util.gsm_utils import do_text_replacements, TEXT_REPLACEMENTS_FILE, run_new_thread
from GameSentenceMiner.util.configuration import *
from GameSentenceMiner.util.text_log import *
from GameSentenceMiner.web.texthooking_page import add_event_to_texthooker, send_word_coordinates_to_overlay, overlay_server_thread

if get_config().wip.overlay_websocket_send:
    import GameSentenceMiner.wip.get_overlay_coords as get_overlay_coords


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

async def monitor_clipboard():
    global current_line, last_clipboard
    current_line = pyperclip.paste()
    send_message_on_resume = False
    while True:
        if not get_config().general.use_clipboard:
            gsm_status.clipboard_enabled = False
            await asyncio.sleep(5)
            continue
        if not get_config().general.use_both_clipboard_and_websocket and any(websocket_connected.values()):
            gsm_status.clipboard_enabled = False
            await asyncio.sleep(1)
            send_message_on_resume = True
            continue
        elif send_message_on_resume:
            logger.info("No Websocket Connections, resuming Clipboard Monitoring.")
            send_message_on_resume = False
        gsm_status.clipboard_enabled = True
        current_clipboard = pyperclip.paste()

        if current_clipboard and current_clipboard != current_line and current_clipboard != last_clipboard:
            last_clipboard = current_clipboard
            await handle_new_text_event(current_clipboard)

        await asyncio.sleep(0.05)


async def listen_websockets():
    async def listen_on_websocket(uri):
        global current_line, current_line_time, reconnecting, websocket_connected
        try_other = False
        websocket_connected[uri] = False
        while True:
            if not get_config().general.use_websocket:
                await asyncio.sleep(1)
                continue
            websocket_url = f'ws://{uri}'
            if try_other:
                websocket_url = f'ws://{uri}/api/ws/text/origin'
            try:
                async with websockets.connect(websocket_url, ping_interval=None) as websocket:
                    logger.info(f"TextHooker Websocket {uri} Connected!")
                    gsm_status.websockets_connected.append(websocket_url)
                    if reconnecting:
                        logger.info(f"Texthooker WebSocket {uri} connected Successfully!" + " Disabling Clipboard Monitor." if (get_config().general.use_clipboard and not get_config().general.use_both_clipboard_and_websocket) else "")
                        reconnecting = False
                    websocket_connected[uri] = True
                    line_time = None
                    while True:
                        message = await websocket.recv()
                        if not message:
                            continue
                        logger.debug(message)
                        try:
                            data = json.loads(message)
                            if "sentence" in data:
                                current_clipboard = data["sentence"]
                            if "time" in data:
                                line_time = datetime.fromisoformat(data["time"])
                        except json.JSONDecodeError or TypeError:
                            current_clipboard = message
                        logger.info
                        if current_clipboard != current_line:
                            try:
                                await handle_new_text_event(current_clipboard, line_time if line_time else None)
                            except Exception as e: 
                                logger.error(f"Error handling new text event: {e}", exc_info=True)
            except (websockets.ConnectionClosed, ConnectionError, InvalidStatus, ConnectionResetError, Exception) as e:
                if websocket_url in gsm_status.websockets_connected:
                    gsm_status.websockets_connected.remove(websocket_url)
                if isinstance(e, InvalidStatus):
                    e: InvalidStatus
                    if e.response.status_code == 404:
                        logger.info(f"Texthooker WebSocket: {uri} connection failed. Attempting some fixes...")
                        try_other = True
                elif websocket_connected[uri]:
                    if not (isinstance(e, ConnectionResetError) or isinstance(e, ConnectionError) or isinstance(e, InvalidStatus) or isinstance(e, websockets.ConnectionClosed)):
                        logger.debug(f"Unexpected error in Texthooker WebSocket {uri} connection: {e}, Can be ignored")
                    else:
                        logger.warning(f"Texthooker WebSocket {uri} disconnected. Attempting to reconnect...")
                    websocket_connected[uri] = False
                    await asyncio.sleep(1)

    websocket_tasks = []
    if ',' in get_config().general.websocket_uri:
        for uri in get_config().general.websocket_uri.split(','):
            websocket_tasks.append(listen_on_websocket(uri))
    else:
        websocket_tasks.append(listen_on_websocket(get_config().general.websocket_uri))

    websocket_tasks.append(listen_on_websocket(f"localhost:{get_config().advanced.ocr_websocket_port}"))

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
    current_line = current_clipboard
    logger.info(f"Current Line: {current_line} last raw clipboard: {last_raw_clipboard}")
    # Only apply this logic if merging is enabled
    if get_config().general.merge_matching_sequential_text:
        logger.info(f"Handling new text event: {current_line}")
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
    add_line(current_line_after_regex, line_time if line_time else datetime.now())
    if len(get_text_log().values) > 0:
        await add_event_to_texthooker(get_text_log()[-1])
    if get_config().wip.overlay_websocket_port and get_config().wip.overlay_websocket_send and overlay_server_thread.has_clients():
        boxes = await find_box_for_sentence(current_line_after_regex)
        if boxes:
            await send_word_coordinates_to_overlay(boxes)

async def find_box_for_sentence(sentence):
    boxes = []
    logger.info(f"Finding Box for Sentence: {sentence}")
    boxes, font_size = await get_overlay_coords.find_box_for_sentence(sentence)
    # logger.info(f"Found Boxes: {boxes}, Font Size: {font_size}")
    # if boxes:
        # x1, y1, x2, y2 = box
        # boxes.append({'sentence': sentence, 'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'fontSize': font_size})
        # x1, y1, x2, y2 = box
        # requests.post("http://localhost:3000/open-overlay", json={"sentence": sentence, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "fontSize": font_size})
    return boxes

def reset_line_hotkey_pressed():
    global current_line_time
    logger.info("LINE RESET HOTKEY PRESSED")
    current_line_time = datetime.now()
    gsm_state.last_mined_line = None


def run_websocket_listener():
    asyncio.run(listen_websockets())


async def start_text_monitor():
    run_new_thread(run_websocket_listener)
    if get_config().general.use_websocket:
        if get_config().general.use_both_clipboard_and_websocket:
            logger.info("Listening for Text on both WebSocket and Clipboard.")
        else:
            logger.info("Both WebSocket and Clipboard monitoring are enabled. WebSocket will take precedence if connected.")
    await monitor_clipboard()
    await asyncio.sleep(1)