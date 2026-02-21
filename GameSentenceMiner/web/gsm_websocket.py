import asyncio
import json
import queue
import socket
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Set

import websockets

from GameSentenceMiner.util.config.configuration import get_config, is_windows, logger
from GameSentenceMiner.util.port_diagnostics import (
    describe_port_owners,
    find_port_owners,
    is_address_in_use_error,
    is_probably_gsm_process,
    terminate_process,
)

# Constants for server identification
ID_HOOKER = "texthooker"
ID_PLAINTEXT = "plaintext"
ID_OVERLAY = "overlay"

# Internal compatibility listener ids
ID_OVERLAY_LEGACY = "overlay_legacy"
ID_PLAINTEXT_LEGACY = "plaintext_legacy"

# Canonical websocket paths on the multiplex ingress endpoint
WS_PATH_HOOKER = "/ws/texthooker"
WS_PATH_OVERLAY = "/ws/overlay"
WS_PATH_PLAINTEXT = "/ws/plaintext"


def _normalize_ws_path(path: Optional[str]) -> str:
    normalized = str(path or "/").split("?", 1)[0].strip()
    if not normalized:
        normalized = "/"
    if not normalized.startswith("/"):
        normalized = f"/{normalized}"
    if len(normalized) > 1:
        normalized = normalized.rstrip("/")
    return normalized.lower()


def _resolve_server_id_from_path(path: Optional[str]) -> Optional[str]:
    normalized = _normalize_ws_path(path)
    path_map = {
        "/": ID_PLAINTEXT, 
        "/jl": ID_PLAINTEXT,
        "/ws/jl": ID_PLAINTEXT,
        "/ws": ID_HOOKER,
        WS_PATH_HOOKER: ID_HOOKER,
        "/hooker": ID_HOOKER,
        "/texthooker": ID_HOOKER,
        "/api/ws/text/origin": ID_HOOKER,
        WS_PATH_OVERLAY: ID_OVERLAY,
        "/overlay": ID_OVERLAY,
        WS_PATH_PLAINTEXT: ID_PLAINTEXT,
        "/plaintext": ID_PLAINTEXT,
    }
    return path_map.get(normalized)


def _extract_ws_path(websocket, fallback_path: Optional[str] = None) -> str:
    if fallback_path:
        return _normalize_ws_path(fallback_path)

    request = getattr(websocket, "request", None)
    request_path = getattr(request, "path", None)
    if request_path:
        return _normalize_ws_path(request_path)

    websocket_path = getattr(websocket, "path", None)
    if websocket_path:
        return _normalize_ws_path(websocket_path)

    return "/"


@dataclass(frozen=True)
class EndpointSpec:
    read_mode: bool = False
    message_callback: Optional[Callable[[str], Any]] = None
    enable_backup: bool = True


class _PortConflictSupport:
    def _notify_port_conflict_once(self, server_name: str, port: int, owner_summary: str):
        conflict_key = f"{server_name}:{port}:{owner_summary}"
        if conflict_key in self._notified_conflicts:
            return

        self._notified_conflicts.add(conflict_key)
        try:
            from GameSentenceMiner.util.platform import notification

            notification.send_error_notification(
                f"{server_name} websocket port {port} is in use ({owner_summary})."
            )
        except Exception as notify_error:
            logger.debug(f"[{server_name}] Failed to send port conflict notification: {notify_error}")

    def _try_recover_orphaned_gsm_owner(self, port: int, owners) -> bool:
        for owner in owners:
            if owner.pid in (None, 0):
                continue
            if owner.pid in self._termination_attempted_pids:
                continue
            if not is_probably_gsm_process(owner):
                continue

            self._termination_attempted_pids.add(owner.pid)
            if terminate_process(owner.pid):
                logger.warning(
                    f"[{self.server_name}] Terminated stale GSM process PID {owner.pid} on port {port}; retrying bind."
                )
                return True
            logger.warning(
                f"[{self.server_name}] Could not terminate stale GSM process PID {owner.pid} on port {port}."
            )
        return False

    def _handle_bind_conflict(self, port: int, bind_host: str, error: OSError) -> bool:
        owners = find_port_owners(port, bind_host)
        if self._try_recover_orphaned_gsm_owner(port, owners):
            return True

        owner_summary = describe_port_owners(owners)
        conflict_signature = (port, owner_summary)
        if self._last_conflict_signature != conflict_signature:
            self._last_conflict_signature = conflict_signature
            logger.error(
                f"[{self.server_name}] Port {port} is already in use by {owner_summary}. "
                "Close that process or change this port in Settings > Advanced."
            )
            if is_windows():
                logger.error(
                    f"[{self.server_name}] PowerShell check: "
                    f"Get-NetTCPConnection -LocalPort {port} | Select-Object LocalAddress,State,OwningProcess"
                )
                logger.error(
                    f"[{self.server_name}] To stop a stale owner: Stop-Process -Id <PID> -Force"
                )
            logger.debug(f"[{self.server_name}] Underlying bind error: {error}")
            self._notify_port_conflict_once(self.server_name, port, owner_summary)
        else:
            logger.debug(f"[{self.server_name}] Port {port} still occupied by {owner_summary}.")
        return False


class WebsocketServerThread(_PortConflictSupport, threading.Thread):
    def __init__(
        self,
        name: str,
        read_mode: bool,
        get_port_func: Callable[[], int],
        msg_queue: queue.Queue,
        is_paused_func: Callable[[], bool],
        message_callback: Optional[Callable[[str], Any]] = None,
    ):
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
        self._last_conflict_signature = None
        self._notified_conflicts = set()
        self._termination_attempted_pids = set()

        self.clients: Set[Any] = set()
        self.backedup_text = []

    @property
    def loop(self):
        self._loop_ready_event.wait()
        return self._loop

    async def _send_text_coroutine(self, message: str):
        if not self.clients:
            self.backedup_text.append(message)
            if len(self.backedup_text) > self.max_backup_messages:
                self.backedup_text.pop(0)
            return

        tasks = [asyncio.create_task(client.send(message)) for client in self.clients]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _handler(self, websocket):
        self.clients.add(websocket)
        logger.debug(f"[{self.server_name}] Client connected. Total: {len(self.clients)}")

        try:
            if self.backedup_text:
                for message in self.backedup_text:
                    await websocket.send(message)
                self.backedup_text.clear()

            async for message in websocket:
                if self.message_callback:
                    try:
                        callback_result = self.message_callback(message)
                        if asyncio.iscoroutine(callback_result):
                            asyncio.create_task(callback_result)
                        await websocket.send("True")
                    except Exception as callback_error:
                        logger.error(f"[{self.server_name}] Error in message callback: {callback_error}")
                        await websocket.send("False")
                elif self.read_mode and not self.is_paused_func():
                    self.msg_queue.put(message)
                    await websocket.send("True")
                else:
                    await websocket.send("False")

        except (
            websockets.exceptions.ConnectionClosedError,
            websockets.exceptions.ConnectionClosedOK,
            EOFError,
            ConnectionResetError,
            OSError,
        ):
            pass
        except Exception as error:
            logger.warning(f"[{self.server_name}] Error in handler: {error}")
        finally:
            self.clients.discard(websocket)
            logger.debug(f"[{self.server_name}] Client disconnected.")

    async def send_payload(self, text: Any):
        if text is None:
            return None

        if isinstance(text, (dict, list)):
            text = json.dumps(text)

        future = asyncio.run_coroutine_threadsafe(self._send_text_coroutine(text), self.loop)
        return asyncio.wrap_future(future)

    def has_clients(self) -> bool:
        return len(self.clients) > 0

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
                port = -1
                bind_host = get_config().advanced.localhost_bind_address
                try:
                    port = self.get_port_func()
                    logger.background(f"[{self.server_name}] Starting on port {port}...")

                    async with websockets.serve(
                        self._handler,
                        bind_host,
                        port,
                        max_size=1000000000,
                        max_queue=2048,
                    ):
                        retry_manager.reset()
                        self._last_conflict_signature = None
                        self._notified_conflicts.clear()
                        self._termination_attempted_pids.clear()
                        await self._stop_event.wait()

                    logger.info(f"[{self.server_name}] Websocket Server Stopped.")
                    return

                except OSError as error:
                    if is_address_in_use_error(error):
                        if self._handle_bind_conflict(port, bind_host, error):
                            retry_manager.reset()
                            continue
                    else:
                        logger.error(f"[{self.server_name}] OS Error (Port {port}): {error}")
                except Exception as error:
                    logger.error(f"[{self.server_name}] Unexpected error: {error}")

                await retry_manager.async_sleep()

        asyncio.run(main())


class MultiplexWebsocketServerThread(_PortConflictSupport, threading.Thread):
    def __init__(
        self,
        name: str,
        get_port_func: Callable[[], int],
        msg_queue: queue.Queue,
        is_paused_func: Callable[[], bool],
        endpoint_specs: Dict[str, EndpointSpec],
    ):
        super().__init__(daemon=True, name=f"WS-Thread-{name}")
        self.server_name = name
        self.get_port_func = get_port_func
        self.msg_queue = msg_queue
        self.is_paused_func = is_paused_func
        self.endpoint_specs = endpoint_specs
        self.max_backup_messages = 100

        self._loop = None
        self._stop_event = None
        self._loop_ready_event = threading.Event()
        self._last_conflict_signature = None
        self._notified_conflicts = set()
        self._termination_attempted_pids = set()

        self.clients_by_server_id: Dict[str, Set[Any]] = {}
        self.backup_by_server_id: Dict[str, list] = {}

    @property
    def loop(self):
        self._loop_ready_event.wait()
        return self._loop

    def _get_clients(self, server_id: str) -> Set[Any]:
        return self.clients_by_server_id.setdefault(server_id, set())

    def _get_backup(self, server_id: str) -> list:
        return self.backup_by_server_id.setdefault(server_id, [])

    def _resolve_target_server_id(self, websocket, path: Optional[str]) -> Optional[str]:
        request_path = _extract_ws_path(websocket, path)
        return _resolve_server_id_from_path(request_path)

    async def _handle_incoming_message(self, server_id: str, websocket, message: str):
        endpoint_spec = self.endpoint_specs.get(server_id)
        if not endpoint_spec:
            await websocket.send("False")
            return

        if endpoint_spec.message_callback:
            try:
                callback_result = endpoint_spec.message_callback(message)
                if asyncio.iscoroutine(callback_result):
                    asyncio.create_task(callback_result)
                await websocket.send("True")
            except Exception as callback_error:
                logger.error(f"[{self.server_name}] Error in {server_id} callback: {callback_error}")
                await websocket.send("False")
            return

        if endpoint_spec.read_mode and not self.is_paused_func():
            self.msg_queue.put(message)
            await websocket.send("True")
            return

        await websocket.send("False")

    async def _handler(self, websocket, path=None):
        server_id = self._resolve_target_server_id(websocket, path)
        if not server_id:
            ws_path = _extract_ws_path(websocket, path)
            logger.warning(f"[{self.server_name}] Rejecting client on unsupported websocket path '{ws_path}'.")
            await websocket.close(code=1008, reason="Unsupported websocket path")
            return

        clients = self._get_clients(server_id)
        clients.add(websocket)
        logger.debug(
            f"[{self.server_name}] Client connected on '{server_id}'. "
            f"Total for endpoint: {len(clients)}"
        )

        try:
            backup = self._get_backup(server_id)
            if backup:
                for message in backup:
                    await websocket.send(message)
                backup.clear()

            async for message in websocket:
                await self._handle_incoming_message(server_id, websocket, message)

        except (
            websockets.exceptions.ConnectionClosedError,
            websockets.exceptions.ConnectionClosedOK,
            EOFError,
            ConnectionResetError,
            OSError,
        ):
            pass
        except Exception as error:
            logger.warning(f"[{self.server_name}] Error in handler for {server_id}: {error}")
        finally:
            clients.discard(websocket)
            logger.debug(
                f"[{self.server_name}] Client disconnected from '{server_id}'. "
                f"Remaining: {len(clients)}"
            )

    async def _send_text_coroutine(self, server_id: str, message: str):
        clients = self._get_clients(server_id)
        endpoint_spec = self.endpoint_specs.get(server_id)

        if not clients:
            if endpoint_spec and endpoint_spec.enable_backup:
                backup = self._get_backup(server_id)
                backup.append(message)
                if len(backup) > self.max_backup_messages:
                    backup.pop(0)
            return

        tasks = [asyncio.create_task(client.send(message)) for client in clients]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def send_payload(self, text: Any, server_id: str = ID_HOOKER):
        if text is None:
            return None

        if isinstance(text, (dict, list)):
            text = json.dumps(text)

        future = asyncio.run_coroutine_threadsafe(
            self._send_text_coroutine(server_id, text), self.loop
        )
        return asyncio.wrap_future(future)

    def has_clients(self, server_id: str) -> bool:
        return len(self._get_clients(server_id)) > 0

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
                port = -1
                bind_host = get_config().advanced.localhost_bind_address
                try:
                    port = self.get_port_func()
                    logger.background(f"[{self.server_name}] Starting multiplex websocket server on port {port}...")

                    async with websockets.serve(
                        self._handler,
                        bind_host,
                        port,
                        max_size=1000000000,
                        max_queue=2048,
                    ):
                        retry_manager.reset()
                        self._last_conflict_signature = None
                        self._notified_conflicts.clear()
                        self._termination_attempted_pids.clear()
                        await self._stop_event.wait()

                    logger.info(f"[{self.server_name}] Multiplex websocket server stopped.")
                    return

                except OSError as error:
                    if is_address_in_use_error(error):
                        if self._handle_bind_conflict(port, bind_host, error):
                            retry_manager.reset()
                            continue
                    else:
                        logger.error(f"[{self.server_name}] OS Error (Port {port}): {error}")
                except Exception as error:
                    logger.error(f"[{self.server_name}] Unexpected error: {error}")

                await retry_manager.async_sleep()

        asyncio.run(main())


class WebsocketManager:
    """
    Central manager for websocket transport.

    Primary transport is multiplexed on one ingress port with websocket paths:
      - /ws/hooker (also /)
      - /ws/overlay
      - /ws/plaintext

    Optional legacy listeners can be enabled on separate ports for compatibility.
    """

    def __init__(self):
        self._servers: Dict[str, Any] = {}
        self._queue = queue.Queue()
        self._paused = False

        self._broadcast_targets: Dict[str, list] = {
            ID_HOOKER: [ID_HOOKER],
            ID_OVERLAY: [ID_HOOKER, ID_OVERLAY_LEGACY],
            ID_PLAINTEXT: [ID_HOOKER, ID_PLAINTEXT_LEGACY],
        }

    @property
    def queue(self) -> queue.Queue:
        return self._queue

    @property
    def paused(self) -> bool:
        return self._paused

    @paused.setter
    def paused(self, value: bool):
        self._paused = value
        logger.info(f"Websocket Manager paused state set to: {self._paused}")

    def _iter_server_targets(self, channel_id: str):
        for server_id in self._broadcast_targets.get(channel_id, [channel_id]):
            server = self._servers.get(server_id)
            if server:
                yield server_id, server

    def start_server(
        self,
        server_id: str,
        read: bool,
        port_getter: Callable[[], int],
        message_callback: Optional[Callable[[str], Any]] = None,
    ):
        """Starts a compatibility websocket listener on a dedicated port."""
        if server_id in self._servers:
            logger.warning(f"Server '{server_id}' is already running.")
            return

        thread = WebsocketServerThread(
            name=server_id,
            read_mode=read,
            get_port_func=port_getter,
            msg_queue=self._queue,
            is_paused_func=lambda: self._paused,
            message_callback=message_callback,
        )
        thread.start()
        self._servers[server_id] = thread

    def start_multiplex_server(
        self,
        port_getter: Callable[[], int],
        endpoint_specs: Dict[str, EndpointSpec],
    ):
        if ID_HOOKER in self._servers:
            logger.warning("Multiplex server is already running.")
            return

        thread = MultiplexWebsocketServerThread(
            name=ID_HOOKER,
            get_port_func=port_getter,
            msg_queue=self._queue,
            is_paused_func=lambda: self._paused,
            endpoint_specs=endpoint_specs,
        )
        thread.start()
        self._servers[ID_HOOKER] = thread

    def stop_server(self, server_id: str):
        if server_id in self._servers:
            self._servers[server_id].stop_server()
            del self._servers[server_id]

    def stop_all(self):
        for server_id in list(self._servers.keys()):
            self.stop_server(server_id)

    async def send(self, server_id: str, message: Any):
        result = None
        targets = list(self._iter_server_targets(server_id))
        if not targets:
            logger.debug(f"Attempted to send to non-existent server/channel: {server_id}")
            return None

        for _, target_server in targets:
            if isinstance(target_server, MultiplexWebsocketServerThread):
                current_result = await target_server.send_payload(message, server_id=server_id)
            else:
                current_result = await target_server.send_payload(message)
            if result is None:
                result = current_result

        return result

    def has_clients(self, server_id: str) -> bool:
        for _, target_server in self._iter_server_targets(server_id):
            if isinstance(target_server, MultiplexWebsocketServerThread):
                if target_server.has_clients(server_id):
                    return True
            elif target_server.has_clients():
                return True
        return False

    def get_ingress_port(self) -> int:
        hooker = self._servers.get(ID_HOOKER)
        if hooker:
            return hooker.get_port_func()
        return get_config().get_field_value("general", "single_port")

    def get_hooker_server(self) -> Optional[Any]:
        return self._servers.get(ID_HOOKER)

    def get_overlay_server(self) -> Optional[Any]:
        for _, server in self._iter_server_targets(ID_OVERLAY):
            return server
        return None

    def get_plaintext_server(self) -> Optional[Any]:
        for _, server in self._iter_server_targets(ID_PLAINTEXT):
            return server
        return None


# -----------------------------------------------------------------------------
# Initialization
# -----------------------------------------------------------------------------


def _pick_free_port() -> int:
    """Bind to port 0 to let the OS choose an available port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# Use a free internal port for the WS ingress so it never collides with the
# single-port gateway's public port (single_port, default 7275).
_internal_ws_ingress_port: int = _pick_free_port()

websocket_manager = WebsocketManager()


async def _overlay_message_handler(message: str):
    """Handler for overlay websocket messages."""
    from GameSentenceMiner.web.overlay_handler import overlay_handler

    await overlay_handler.handle_message(message)


websocket_manager.start_multiplex_server(
    port_getter=lambda: _internal_ws_ingress_port,
    endpoint_specs={
        ID_HOOKER: EndpointSpec(read_mode=True, enable_backup=True),
        ID_OVERLAY: EndpointSpec(
            read_mode=True,
            message_callback=_overlay_message_handler,
            enable_backup=False,
        ),
        ID_PLAINTEXT: EndpointSpec(read_mode=False, enable_backup=True),
    },
)


def _start_legacy_listener_if_needed(
    server_id: str,
    read: bool,
    port_getter: Callable[[], int],
    message_callback: Optional[Callable[[str], Any]] = None,
):
    ingress_port = websocket_manager.get_ingress_port()
    legacy_port = port_getter()

    if not legacy_port or legacy_port <= 0:
        return

    if legacy_port == ingress_port:
        logger.info(
            f"[{server_id}] Legacy websocket port {legacy_port} matches multiplex ingress; "
            "using multiplex endpoint only."
        )
        return

    websocket_manager.start_server(
        server_id=server_id,
        read=read,
        port_getter=port_getter,
        message_callback=message_callback,
    )

_ENABLE_LEGACY_PORT_LISTENERS = False

if _ENABLE_LEGACY_PORT_LISTENERS:
    _start_legacy_listener_if_needed(
        server_id=ID_OVERLAY_LEGACY,
        read=True,
        port_getter=lambda: get_config().get_field_value("overlay", "websocket_port"),
        message_callback=_overlay_message_handler,
    )

    _start_legacy_listener_if_needed(
        server_id=ID_PLAINTEXT_LEGACY,
        read=False,
        port_getter=lambda: get_config().get_field_value("advanced", "plaintext_websocket_port"),
    )


def cleanup_websockets():
    """Call this function when the application exits."""
    logger.info("Shutting down WebSocket Manager...")
    websocket_manager.stop_all()
