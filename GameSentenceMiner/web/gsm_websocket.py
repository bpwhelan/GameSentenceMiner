import asyncio
import json
import queue
import threading
import websockets

from GameSentenceMiner.util.configuration import logger, get_config


websocket_queue = queue.Queue()
paused = False


class WebsocketServerThread(threading.Thread):
    def __init__(self, read, get_ws_port_func):
        super().__init__(daemon=True)
        self._loop = None
        self.read = read
        self.clients = set()
        self._event = threading.Event()
        self.get_ws_port_func = get_ws_port_func
        self.backedup_text = []

    @property
    def loop(self):
        self._event.wait()
        return self._loop

    async def send_text_coroutine(self, message):
        if not self.clients:
            self.backedup_text.append(message)
            return
        for client in self.clients:
            await client.send(message)

    async def server_handler(self, websocket):
        self.clients.add(websocket)
        try:
            if self.backedup_text:
                for message in self.backedup_text:
                    await websocket.send(message)
                self.backedup_text.clear()
            async for message in websocket:
                if self.read and not paused:
                    websocket_queue.put(message)
                    try:
                        await websocket.send('True')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
                else:
                    try:
                        await websocket.send('False')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
        except (websockets.exceptions.ConnectionClosedError, 
                websockets.exceptions.ConnectionClosedOK,
                EOFError,
                ConnectionResetError,
                OSError) as e:
            # Handle various connection closure scenarios silently
            logger.debug(f"WebSocket connection closed: {type(e).__name__}")
        except Exception as e:
            # Log unexpected errors but don't crash
            logger.warning(f"Unexpected error in WebSocket handler: {e}")
        finally:
            self.clients.discard(websocket)

    async def send_text(self, text):
        if text:
            if isinstance(text, dict) or isinstance(text, list):
                text = json.dumps(text)
            return asyncio.run_coroutine_threadsafe(
                self.send_text_coroutine(text), self.loop)

    def has_clients(self):
        return len(self.clients) > 0

    def stop_server(self):
        self.loop.call_soon_threadsafe(self._stop_event.set)

    def run(self):
        async def main():
            self._loop = asyncio.get_running_loop()
            self._stop_event = stop_event = asyncio.Event()
            self._event.set()
            retry_count = 0
            max_retries = 5
            base_delay = 1
            
            while True:
                try:
                    self.server = start_server = websockets.serve(
                        self.server_handler,
                        get_config().advanced.localhost_bind_address,
                        self.get_ws_port_func(),
                        max_size=1000000000,
                    )
                    async with start_server:
                        # Reset retry count on successful start
                        retry_count = 0
                        await stop_event.wait()
                    return
                except OSError as e:
                    # Port binding issues, address in use, etc.
                    logger.error(f"WebSocket server OS error: {e}")
                    retry_count += 1
                    if retry_count > max_retries:
                        logger.error("WebSocket server failed after maximum retries. Stopping.")
                        return
                    delay = min(base_delay * (2 ** (retry_count - 1)), 30)
                    logger.warning(f"Retrying WebSocket server in {delay}s... (attempt {retry_count}/{max_retries})")
                    await asyncio.sleep(delay)
                except Exception as e:
                    logger.error(f"WebSocket server encountered an unexpected error: {e}. Retrying...")
                    retry_count += 1
                    if retry_count > max_retries:
                        logger.error("WebSocket server failed after maximum retries. Stopping.")
                        return
                    delay = min(base_delay * (2 ** (retry_count - 1)), 30)
                    await asyncio.sleep(delay)

        asyncio.run(main())


def handle_exit_signal(loop):
    logger.info("Received exit signal. Shutting down...")
    for task in asyncio.all_tasks(loop):
        task.cancel()


# Initialize WebSocket server threads
websocket_server_thread = WebsocketServerThread(read=True, get_ws_port_func=lambda: get_config(
).get_field_value('advanced', 'texthooker_communication_websocket_port'))
websocket_server_thread.start()

plaintext_websocket_server_thread = None
if get_config().advanced.plaintext_websocket_port:
    plaintext_websocket_server_thread = WebsocketServerThread(
        read=False, get_ws_port_func=lambda: get_config().get_field_value('advanced', 'plaintext_websocket_port'))
    plaintext_websocket_server_thread.start()

overlay_server_thread = WebsocketServerThread(
    read=False, get_ws_port_func=lambda: get_config().get_field_value('overlay', 'websocket_port'))
overlay_server_thread.start()

websocket_server_threads = [
    websocket_server_thread,
    plaintext_websocket_server_thread,
    overlay_server_thread
]