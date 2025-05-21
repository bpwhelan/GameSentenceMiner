import asyncio
import re

import pyperclip
import websockets
from websockets import InvalidStatus

from GameSentenceMiner import util
from GameSentenceMiner.configuration import *
from GameSentenceMiner.text_log import *
from GameSentenceMiner.util import do_text_replacements, TEXT_REPLACEMENTS_FILE

from GameSentenceMiner.web.texthooking_page import add_event_to_texthooker

current_line = ''
current_line_after_regex = ''
current_line_time = datetime.now()

reconnecting = False
websocket_connected = {}

async def monitor_clipboard():
    global current_line
    current_line = pyperclip.paste()
    send_message_on_resume = False
    while True:
        if not get_config().general.use_clipboard:
            await asyncio.sleep(5)
            continue
        if not get_config().general.use_both_clipboard_and_websocket and any(websocket_connected.values()):
            await asyncio.sleep(1)
            send_message_on_resume = True
            continue
        elif send_message_on_resume:
            logger.info("No Websocket Connections, resuming Clipboard Monitoring.")
            send_message_on_resume = False
        current_clipboard = pyperclip.paste()

        if current_clipboard and current_clipboard != current_line:
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
                    if reconnecting:
                        logger.info(f"Texthooker WebSocket {uri} connected Successfully!" + " Disabling Clipboard Monitor." if (get_config().general.use_clipboard and not get_config().general.use_both_clipboard_and_websocket) else "")
                        reconnecting = False
                    websocket_connected[uri] = True
                    try_other = True
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
                        if current_clipboard != current_line:
                            await handle_new_text_event(current_clipboard, line_time if line_time else None)
            except (websockets.ConnectionClosed, ConnectionError, InvalidStatus, ConnectionResetError, Exception) as e:
                if isinstance(e, InvalidStatus):
                    e: InvalidStatus
                    if e.response.status_code == 404:
                        logger.info(f"Texthooker WebSocket: {uri} connection failed. Attempting some fixes...")
                        try_other = True
                else:
                    if not (isinstance(e, ConnectionResetError) or isinstance(e, ConnectionError) or isinstance(e, InvalidStatus) or isinstance(e, websockets.ConnectionClosed)):
                        logger.error(f"Unexpected error in Texthooker WebSocket {uri} connection: {e}")
                    if websocket_connected[uri]:
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

async def handle_new_text_event(current_clipboard, line_time=None):
    global current_line, current_line_time, current_line_after_regex
    current_line = current_clipboard
    if get_config().general.texthook_replacement_regex:
        current_line_after_regex = re.sub(get_config().general.texthook_replacement_regex, '', current_line)
    else:
        current_line_after_regex = current_line
    current_line_after_regex = do_text_replacements(current_line, TEXT_REPLACEMENTS_FILE)
    logger.info(f"Line Received: {current_line_after_regex}")
    current_line_time = line_time if line_time else datetime.now()
    add_line(current_line_after_regex, line_time)
    if len(get_text_log().values) > 0:
        await add_event_to_texthooker(get_text_log()[-1])

def reset_line_hotkey_pressed():
    global current_line_time
    logger.info("LINE RESET HOTKEY PRESSED")
    current_line_time = datetime.now()
    util.set_last_mined_line("")


def run_websocket_listener():
    asyncio.run(listen_websockets())


async def start_text_monitor():
    util.run_new_thread(run_websocket_listener)
    if get_config().general.use_websocket:
        if get_config().general.use_both_clipboard_and_websocket:
            logger.info("Listening for Text on both WebSocket and Clipboard.")
        else:
            logger.info("Both WebSocket and Clipboard monitoring are enabled. WebSocket will take precedence if connected.")
    await monitor_clipboard()
    await asyncio.sleep(1)