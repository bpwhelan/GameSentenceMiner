import asyncio
import json
import queue
import threading
import websockets
from typing import Callable, Dict, Optional, Any

from GameSentenceMiner.util.config.configuration import logger, get_config

# Constants for server identification
ID_HOOKER = 'texthooker'
ID_PLAINTEXT = 'plaintext'
ID_OVERLAY = 'overlay'

class WebsocketServerThread(threading.Thread):
    def __init__(self, 
                 name: str, 
                 read_mode: bool, 
                 get_port_func: Callable[[], int], 
                 msg_queue: queue.Queue,
                 is_paused_func: Callable[[], bool],
                 message_callback: Optional[Callable[[str], None]] = None):
        super().__init__(daemon=True, name=f"WS-Thread-{name}")
        self.server_name = name
        self.read_mode = read_mode
        self.get_port_func = get_port_func
        self.msg_queue = msg_queue
        self.is_paused_func = is_paused_func
        self.message_callback = message_callback
        self.max_backup_messages = 100
        
        self._loop = None
        self._stop_event = None
        self._loop_ready_event = threading.Event()
        
        self.clients = set()
        self.backedup_text = []

    @property
    def loop(self):
        self._loop_ready_event.wait()
        return self._loop

    async def _send_text_coroutine(self, message):
        """Internal coroutine to send text to all connected clients."""
        if not self.clients:
            self.backedup_text.append(message)
            if len(self.backedup_text) > self.max_backup_messages:
                self.backedup_text.pop(0)
            return
        
        # Create tasks for all clients to avoid one slow client blocking others
        tasks = [asyncio.create_task(client.send(message)) for client in self.clients]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _handler(self, websocket):
        """Main handler for individual websocket connections."""
        self.clients.add(websocket)
        logger.debug(f"[{self.server_name}] Client connected. Total: {len(self.clients)}")
        try:
            # Send any backed-up messages immediately upon connection
            if self.backedup_text:
                for message in self.backedup_text:
                    await websocket.send(message)
                self.backedup_text.clear()

            async for message in websocket:
                # If there's a callback, use it instead of the queue
                if self.message_callback:
                    try:
                        asyncio.create_task(self.message_callback(message))
                        await websocket.send('True')
                    except Exception as e:
                        logger.error(f"[{self.server_name}] Error in message callback: {e}")
                        await websocket.send('False')
                elif self.read_mode and not self.is_paused_func():
                    self.msg_queue.put(message)
                    await websocket.send('True')
                else:
                    await websocket.send('False')

        except (websockets.exceptions.ConnectionClosedError, 
                websockets.exceptions.ConnectionClosedOK,
                EOFError,
                ConnectionResetError,
                OSError):
            pass # Expected disconnects
        except Exception as e:
            logger.warning(f"[{self.server_name}] Error in handler: {e}")
        finally:
            self.clients.discard(websocket)
            logger.debug(f"[{self.server_name}] Client disconnected.")

    async def send_payload(self, text):
        """Public method called from other threads to schedule sending data."""
        if text is not None:
            if isinstance(text, (dict, list)):
                text = json.dumps(text)
            
            future = asyncio.run_coroutine_threadsafe(
                self._send_text_coroutine(text), self.loop)
            
            return asyncio.wrap_future(future)

    def stop_server(self):
        if self._loop and self._stop_event:
            self.loop.call_soon_threadsafe(self._stop_event.set)

    def run(self):
        async def main():
            self._loop = asyncio.get_running_loop()
            self._stop_event = asyncio.Event()
            self._loop_ready_event.set()
            
            from GameSentenceMiner.util.gsm_utils import SleepManager
            retry_manager = SleepManager(initial_delay=1.0, name=f"WS_Server_{self.server_name}")
            
            while True:
                try:
                    port = self.get_port_func()
                    logger.info(f"[{self.server_name}] Starting on port {port}...")
                    
                    async with websockets.serve(
                        self._handler,
                        get_config().advanced.localhost_bind_address,
                        port,
                        max_size=1000000000,
                    ):
                        retry_manager.reset()
                        await self._stop_event.wait()
                    
                    logger.info(f"[{self.server_name}] Websocket Server Stopped.")
                    return # Exit thread if stopped cleanly

                except OSError as e:
                    logger.error(f"[{self.server_name}] OS Error (Port {port}): {e}")
                except Exception as e:
                    logger.error(f"[{self.server_name}] Unexpected error: {e}")
                
                await retry_manager.async_sleep()

        asyncio.run(main())


class WebsocketManager:
    """
    Central manager for multiple WebSocket servers.
    Access this via the global instance `websocket_manager`.
    """
    def __init__(self):
        self._servers: Dict[str, WebsocketServerThread] = {}
        self._queue = queue.Queue()
        self._paused = False
    
    @property
    def queue(self) -> queue.Queue:
        """Access the queue where incoming messages are stored."""
        return self._queue

    @property
    def paused(self) -> bool:
        return self._paused

    @paused.setter
    def paused(self, value: bool):
        self._paused = value
        logger.info(f"Websocket Manager paused state set to: {self._paused}")

    def start_server(self, server_id: str, read: bool, port_getter: Callable[[], int], message_callback: Optional[Callable[[str], None]] = None):
        """
        Starts a new websocket server thread.
        
        Args:
            server_id: Unique identifier for this server
            read: Whether to read messages from clients (vs write-only)
            port_getter: Function that returns the port number
            message_callback: Optional callback function for handling messages directly
        """
        if server_id in self._servers:
            logger.warning(f"Server '{server_id}' is already running.")
            return

        thread = WebsocketServerThread(
            name=server_id,
            read_mode=read,
            get_port_func=port_getter,
            msg_queue=self._queue,
            is_paused_func=lambda: self._paused,
            message_callback=message_callback
        )
        thread.start()
        self._servers[server_id] = thread

    def stop_server(self, server_id: str):
        """Stops a specific server thread."""
        if server_id in self._servers:
            self._servers[server_id].stop_server()
            del self._servers[server_id]

    def stop_all(self):
        """Stops all running server threads."""
        for server_id in list(self._servers.keys()):
            self.stop_server(server_id)

    async def send(self, server_id: str, message: Any):
        """
        Sends a message to clients connected to a specific server.
        Returns the Future object or None if server doesn't exist.
        """
        if server_id in self._servers:
            return await self._servers[server_id].send_payload(message)
        else:
            logger.debug(f"Attempted to send to non-existent server: {server_id}")

    def has_clients(self, server_id: str) -> bool:
        if server_id in self._servers:
            return len(self._servers[server_id].clients) > 0
        return False
    
    def get_overlay_server(self) -> Optional[WebsocketServerThread]:
        return self._servers.get(ID_OVERLAY)
    
    def get_hooker_server(self) -> Optional[WebsocketServerThread]:
        return self._servers.get(ID_HOOKER)
    
    def get_plaintext_server(self) -> Optional[WebsocketServerThread]:
        return self._servers.get(ID_PLAINTEXT)

# -----------------------------------------------------------------------------
# Initialization
# -----------------------------------------------------------------------------

# Create the singleton instance
websocket_manager = WebsocketManager()

# Start the 'Hooker' (Text Hooker Communication) Server
websocket_manager.start_server(
    server_id=ID_HOOKER,
    read=True,
    port_getter=lambda: get_config().get_field_value('advanced', 'texthooker_communication_websocket_port')
)

# Start the 'Overlay' Server with message callback
async def _overlay_message_handler(message: str):
    """Handler for overlay websocket messages."""
    from GameSentenceMiner.web.overlay_handler import overlay_handler
    await overlay_handler.handle_message(message)

websocket_manager.start_server(
    server_id=ID_OVERLAY,
    read=True,
    port_getter=lambda: get_config().get_field_value('overlay', 'websocket_port'),
    message_callback=_overlay_message_handler
)

# Start the 'Plaintext' Server (if configured)
if get_config().advanced.plaintext_websocket_port:
    websocket_manager.start_server(
        server_id=ID_PLAINTEXT,
        read=False,
        port_getter=lambda: get_config().get_field_value('advanced', 'plaintext_websocket_port')
    )

def cleanup_websockets():
    """Call this function when the application exits."""
    logger.info("Shutting down WebSocket Manager...")
    websocket_manager.stop_all()
