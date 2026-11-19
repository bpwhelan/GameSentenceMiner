"""GSM message-bus client (Python side).

Connects to the Rust desktop broker (native/gsm-runtime)
over a localhost WebSocket and speaks the shared envelope. Used by both the GSM
backend and the OCR subprocess; it replaces the stdout/stdin line protocols in
electron_ipc.py and ocr_ipc.py.

The client can run on the process-owned AsyncTransportRuntime so synchronous
callers (most of GSM) can use thread-safe publish()/request() while connection,
reconnect, and dispatch happen in the background. Standalone users may still
let the client create its one transport loop. Connection details come from env
vars injected by the native supervisor for each process lifetime:

    GSM_BROKER_PORT, GSM_BROKER_TOKEN, GSM_CLIENT_ID
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import CancelledError, Future
from typing import TYPE_CHECKING, Any

import websockets

if TYPE_CHECKING:
    from GameSentenceMiner.util.concurrency.transport import AsyncTransportRuntime

try:
    from GameSentenceMiner.util.config.configuration import logger
except Exception:  # noqa: BLE001 - standalone transports must work without app configuration
    from loguru import logger

BUS_PROTOCOL_VERSION = 1
MAIN = "main"
BROADCAST = "*"

# Handlers receive the full decoded envelope (a dict). Request handlers return the
# response payload (or raise to signal failure).
EventHandler = Callable[[dict[str, Any]], Any]
RequestHandler = Callable[[dict[str, Any]], Any]


def is_bus_available() -> bool:
    """True when the broker connection env was injected (i.e. launched by the desktop supervisor)."""
    return bool(os.environ.get("GSM_BROKER_PORT") and os.environ.get("GSM_BROKER_TOKEN"))


class BusClient:
    def __init__(
        self,
        client_id: str | None = None,
        port: int | None = None,
        token: str | None = None,
        host: str = "127.0.0.1",
        version: str = "",
    ):
        self.client_id = client_id or os.environ.get("GSM_CLIENT_ID") or "python"
        self._process_id = os.getpid()
        self.host = host
        self.port = int(port or os.environ.get("GSM_BROKER_PORT") or 0)
        self.token = token or os.environ.get("GSM_BROKER_TOKEN") or ""
        self.version = version

        self._loop: asyncio.AbstractEventLoop | None = None
        self._ws: Any | None = None
        self._runtime: AsyncTransportRuntime | None = None
        self._owns_runtime = False
        self._main_future: Future[Any] | None = None
        self._stop = False
        self._connected = threading.Event()
        self._first_connection: Future[None] = Future()

        self._subscribers: dict[str, list[EventHandler]] = {}
        self._request_handlers: dict[str, RequestHandler] = {}
        self._concurrent_request_topics: set[str] = set()
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._handler_tasks: set = set()  # strong refs so fire-and-forget handler tasks aren't GC'd

    # -- lifecycle ----------------------------------------------------------

    def start(self, runtime: AsyncTransportRuntime | None = None) -> BusClient:
        if self._main_future and not self._main_future.done():
            return self
        if not self.port or not self.token:
            logger.warning("BusClient: no broker port/token; not connecting.")
            return self
        self._stop = False
        if runtime is not None:
            self._runtime = runtime
            self._main_future = runtime.submit(self._main())
            return self
        from GameSentenceMiner.util.concurrency.transport import AsyncTransportRuntime

        self._runtime = AsyncTransportRuntime(name=f"gsm-bus-transport-{self.client_id}")
        self._owns_runtime = True
        self._runtime.start()
        self._main_future = self._runtime.submit(self._main())
        return self

    def stop(self) -> None:
        self._stop = True
        loop = self._loop
        ws = self._ws
        if loop and ws:
            try:
                asyncio.run_coroutine_threadsafe(ws.close(), loop)
            except RuntimeError as error:
                logger.debug(f"BusClient close could not be scheduled: {error}")
        future = self._main_future
        if future and not future.done():
            try:
                future.result(timeout=2)
            except (TimeoutError, CancelledError, RuntimeError) as error:
                logger.debug(f"BusClient stop is completing with transport shutdown: {error}")
        runtime = self._runtime
        if runtime is not None and self._owns_runtime:
            runtime.stop(timeout=3)
        self._main_future = None
        self._runtime = None
        self._owns_runtime = False

    def wait_connected(self, timeout: float | None = None) -> bool:
        return self._connected.wait(timeout)

    def on_first_connection(self, callback: Callable[[], None]) -> None:
        """Schedule startup work after the authenticated welcome, including late subscribers."""
        self._first_connection.add_done_callback(lambda _: callback())

    def submit(self, coro):
        """Run a client-owned service on the existing transport event loop."""
        if self._runtime is None:
            coro.close()
            raise RuntimeError("BusClient not started")
        return self._runtime.submit(coro)

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    # -- registration -------------------------------------------------------

    def subscribe(self, topic: str, handler: EventHandler) -> Callable[[], None]:
        self._subscribers.setdefault(topic, []).append(handler)

        def unsubscribe() -> None:
            handlers = self._subscribers.get(topic)
            if handlers and handler in handlers:
                handlers.remove(handler)

        return unsubscribe

    def handle(self, topic: str, handler: RequestHandler, *, concurrent: bool = False) -> None:
        """Opt slow, independent requests out of ordered transport dispatch."""
        self._request_handlers[topic] = handler
        if concurrent:
            self._concurrent_request_topics.add(topic)
        else:
            self._concurrent_request_topics.discard(topic)

    # -- sending ------------------------------------------------------------

    def publish(self, dst: str, topic: str, data: Any = None, kind: str = "event") -> Future[Any] | None:
        return self._send_threadsafe(self._envelope(dst, topic, kind, data))

    def request(self, dst: str, topic: str, data: Any = None, timeout: float | None = 15.0) -> Any:
        """Blocking request/response for synchronous callers."""
        loop = self._loop
        if not loop:
            raise RuntimeError("BusClient not started")
        coro = self.request_async(dst, topic, data, timeout)
        fut: Future = asyncio.run_coroutine_threadsafe(coro, loop)
        return fut.result(None if timeout is None else timeout + 1.0)

    async def request_async(self, dst: str, topic: str, data: Any = None, timeout: float | None = 15.0) -> Any:
        if not self.connected:
            raise ConnectionError("Desktop bus is not connected")
        msg = self._envelope(dst, topic, "request", data)
        loop = asyncio.get_running_loop()
        waiter: asyncio.Future[Any] = loop.create_future()
        self._pending[msg["id"]] = waiter
        try:
            await self._send(msg)
            return await asyncio.wait_for(waiter, timeout)
        finally:
            self._pending.pop(msg["id"], None)

    # -- internals ----------------------------------------------------------

    async def _main(self) -> None:
        self._loop = asyncio.get_running_loop()
        backoff = 1.0
        url = f"ws://{self.host}:{self.port}"
        while not self._stop:
            try:
                async with websockets.connect(url, max_size=8 * 1024 * 1024) as ws:
                    self._ws = ws
                    await self._send(self._hello())
                    welcome = json.loads(await asyncio.wait_for(ws.recv(), timeout=10.0))
                    if (
                        welcome.get("v") != BUS_PROTOCOL_VERSION
                        or welcome.get("kind") != "ack"
                        or welcome.get("topic") != "bus.welcome"
                        or welcome.get("dst") != self.client_id
                    ):
                        raise RuntimeError("Desktop bus rejected the handshake")
                    self._connected.set()
                    if not self._first_connection.done():
                        self._first_connection.set_result(None)
                    backoff = 1.0
                    logger.debug(f"BusClient '{self.client_id}' connected to {url}")
                    async for raw in ws:
                        await self._on_raw(raw)
            except Exception as e:  # noqa: BLE001 - keep transport and extension callbacks isolated
                if not self._stop:
                    logger.debug(f"BusClient '{self.client_id}' disconnected: {e}")
            finally:
                self._connected.clear()
                self._ws = None
                for waiter in list(self._pending.values()):
                    if not waiter.done():
                        waiter.set_exception(ConnectionError("Desktop bus disconnected"))
                self._pending.clear()
            if self._stop:
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    def _hello(self) -> dict[str, Any]:
        return {
            "v": BUS_PROTOCOL_VERSION,
            "id": str(uuid.uuid4()),
            "src": self.client_id,
            "dst": MAIN,
            "kind": "hello",
            "topic": "bus.hello",
            "data": {"token": self.token, "pid": os.getpid(), "version": self.version},
        }

    def _envelope(self, dst: str, topic: str, kind: str, data: Any, corr: str | None = None) -> dict[str, Any]:
        msg: dict[str, Any] = {
            "v": BUS_PROTOCOL_VERSION,
            "id": str(uuid.uuid4()),
            "src": self.client_id,
            "dst": dst,
            "kind": kind,
            "topic": topic,
        }
        if data is not None:
            msg["data"] = data
        if corr is not None:
            msg["corr"] = corr
        return msg

    async def _send(self, msg: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            logger.debug(f"BusClient '{self.client_id}' dropping frame (not connected): {msg.get('topic')}")
            return
        await ws.send(json.dumps(msg, ensure_ascii=False))

    def _send_threadsafe(self, msg: dict[str, Any]) -> Future[Any] | None:
        loop = self._loop
        if not loop:
            return None
        return asyncio.run_coroutine_threadsafe(self._send(msg), loop)

    async def _on_raw(self, raw: Any) -> None:
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            logger.warning(f"BusClient '{self.client_id}' got non-JSON frame")
            return
        kind = msg.get("kind")

        if kind == "response":
            corr = msg.get("corr")
            waiter = self._pending.get(corr) if corr else None
            if waiter and not waiter.done():
                if msg.get("ok") is False:
                    waiter.set_exception(RuntimeError(msg.get("error") or "Request failed"))
                else:
                    waiter.set_result(msg.get("data"))
            return

        if kind == "request":
            if msg.get("topic") in self._concurrent_request_topics:
                task = asyncio.create_task(self._dispatch_request(msg))
                self._handler_tasks.add(task)
                task.add_done_callback(self._handler_tasks.discard)
            else:
                await self._dispatch_request(msg)
            return

        if kind in ("event", "command"):
            self._dispatch_event(msg)
            return

        # 'ack'/'error'/'hello' are informational here.
        if kind == "error":
            logger.warning(f"BusClient '{self.client_id}' bus error: {msg.get('error')}")

    def _dispatch_event(self, msg: dict[str, Any]) -> None:
        for handler in list(self._subscribers.get(msg.get("topic", ""), [])):
            try:
                result = handler(msg)
                if asyncio.iscoroutine(result):
                    task = asyncio.create_task(result)
                    self._handler_tasks.add(task)
                    task.add_done_callback(self._handler_tasks.discard)
            except Exception as e:  # noqa: BLE001 - keep transport and extension callbacks isolated
                logger.warning(f"BusClient handler for '{msg.get('topic')}' raised: {e}")

    async def _dispatch_request(self, msg: dict[str, Any]) -> None:
        topic = msg.get("topic", "")
        handler = self._request_handlers.get(topic)
        if not handler:
            await self._send(
                self._envelope(msg.get("src", MAIN), topic, "response", None, corr=msg.get("id"))
                | {"ok": False, "error": f"No handler for '{topic}'"}
            )
            return
        try:
            result = handler(msg)
            if asyncio.iscoroutine(result):
                result = await result
            reply = self._envelope(msg.get("src", MAIN), topic, "response", result, corr=msg.get("id"))
            reply["ok"] = True
            await self._send(reply)
        except Exception as e:  # noqa: BLE001 - return handler failures to the requester
            reply = self._envelope(msg.get("src", MAIN), topic, "response", None, corr=msg.get("id"))
            reply["ok"] = False
            reply["error"] = str(e)
            await self._send(reply)


# Process-wide singleton for convenience (mirrors the Node `bus` facade).
_client: BusClient | None = None


def owns_backend_connection() -> bool:
    """Subprocesses can inherit the backend environment, but cannot use its socket."""
    return (
        _client is not None
        and _client.client_id == "backend"
        and _client._process_id == os.getpid()
        and _client._main_future is not None
    )


def get_bus() -> BusClient:
    global _client
    if _client is None:
        _client = BusClient()
    return _client


def start_bus(runtime: AsyncTransportRuntime | None = None, **kwargs: Any) -> BusClient:
    """Create (if needed) and start the singleton bus client."""
    global _client
    if _client is None:
        _client = BusClient(**kwargs)
    return _client.start(runtime)
