"""GSM message-bus client (Python side).

Connects to the Electron-hosted broker (see electron-src/main/runtime/message_bus.ts)
over a localhost WebSocket and speaks the shared envelope. Used by both the GSM
backend and the OCR subprocess; it replaces the stdout/stdin line protocols in
electron_ipc.py and ocr_ipc.py.

The client can run on the process-owned AsyncTransportRuntime so synchronous
callers (most of GSM) can use thread-safe publish()/request() while connection,
reconnect, and dispatch happen in the background. Standalone users may still
let the client create its one transport loop. Connection details come from env
vars injected by ProcessManager at spawn:

    GSM_BROKER_PORT, GSM_BROKER_TOKEN, GSM_CLIENT_ID
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import uuid
from concurrent.futures import Future
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

import websockets

if TYPE_CHECKING:
    from GameSentenceMiner.util.concurrency.transport import AsyncTransportRuntime

try:
    from GameSentenceMiner.util.config.configuration import logger
except Exception:  # pragma: no cover - fallback for standalone use
    from loguru import logger

BUS_PROTOCOL_VERSION = 1
MAIN = "main"
BROADCAST = "*"

# Handlers receive the full decoded envelope (a dict). Request handlers return the
# response payload (or raise to signal failure).
EventHandler = Callable[[Dict[str, Any]], Any]
RequestHandler = Callable[[Dict[str, Any]], Any]


def is_bus_available() -> bool:
    """True when the broker connection env was injected (i.e. launched by Electron)."""
    return bool(os.environ.get("GSM_BROKER_PORT") and os.environ.get("GSM_BROKER_TOKEN"))


class BusClient:
    def __init__(
        self,
        client_id: Optional[str] = None,
        port: Optional[int] = None,
        token: Optional[str] = None,
        host: str = "127.0.0.1",
        version: str = "",
    ):
        self.client_id = client_id or os.environ.get("GSM_CLIENT_ID") or "python"
        self.host = host
        self.port = int(port or os.environ.get("GSM_BROKER_PORT") or 0)
        self.token = token or os.environ.get("GSM_BROKER_TOKEN") or ""
        self.version = version

        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._ws: Optional[Any] = None
        self._runtime: Optional[AsyncTransportRuntime] = None
        self._owns_runtime = False
        self._main_future: Optional[Future[Any]] = None
        self._stop = False
        self._connected = threading.Event()

        self._subscribers: Dict[str, List[EventHandler]] = {}
        self._request_handlers: Dict[str, RequestHandler] = {}
        self._pending: Dict[str, "asyncio.Future[Any]"] = {}
        self._handler_tasks: set = set()  # strong refs so fire-and-forget handler tasks aren't GC'd

    # -- lifecycle ----------------------------------------------------------

    def start(self, runtime: Optional[AsyncTransportRuntime] = None) -> "BusClient":
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
            except Exception:
                pass
        future = self._main_future
        if future and not future.done():
            try:
                future.result(timeout=2)
            except Exception:
                pass
        runtime = self._runtime
        if runtime is not None and self._owns_runtime:
            runtime.stop(timeout=3)
        self._main_future = None
        self._runtime = None
        self._owns_runtime = False

    def wait_connected(self, timeout: Optional[float] = None) -> bool:
        return self._connected.wait(timeout)

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

    def handle(self, topic: str, handler: RequestHandler) -> None:
        self._request_handlers[topic] = handler

    # -- sending ------------------------------------------------------------

    def publish(self, dst: str, topic: str, data: Any = None, kind: str = "event") -> Future[Any] | None:
        return self._send_threadsafe(self._envelope(dst, topic, kind, data))

    def request(self, dst: str, topic: str, data: Any = None, timeout: float = 15.0) -> Any:
        """Blocking request/response for synchronous callers."""
        loop = self._loop
        if not loop:
            raise RuntimeError("BusClient not started")
        coro = self.request_async(dst, topic, data, timeout)
        fut: Future = asyncio.run_coroutine_threadsafe(coro, loop)
        return fut.result(timeout + 1.0)

    async def request_async(self, dst: str, topic: str, data: Any = None, timeout: float = 15.0) -> Any:
        msg = self._envelope(dst, topic, "request", data)
        loop = asyncio.get_running_loop()
        waiter: "asyncio.Future[Any]" = loop.create_future()
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
                async with websockets.connect(url, max_size=None) as ws:
                    self._ws = ws
                    await self._send(self._hello())
                    self._connected.set()
                    backoff = 1.0
                    logger.debug(f"BusClient '{self.client_id}' connected to {url}")
                    async for raw in ws:
                        await self._on_raw(raw)
            except Exception as e:
                if not self._stop:
                    logger.debug(f"BusClient '{self.client_id}' disconnected: {e}")
            finally:
                self._connected.clear()
                self._ws = None
            if self._stop:
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    def _hello(self) -> Dict[str, Any]:
        return {
            "v": BUS_PROTOCOL_VERSION,
            "id": str(uuid.uuid4()),
            "src": self.client_id,
            "dst": MAIN,
            "kind": "hello",
            "topic": "bus.hello",
            "data": {"token": self.token, "pid": os.getpid(), "version": self.version},
        }

    def _envelope(self, dst: str, topic: str, kind: str, data: Any, corr: Optional[str] = None) -> Dict[str, Any]:
        msg: Dict[str, Any] = {
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

    async def _send(self, msg: Dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            logger.debug(f"BusClient '{self.client_id}' dropping frame (not connected): {msg.get('topic')}")
            return
        await ws.send(json.dumps(msg, ensure_ascii=False))

    def _send_threadsafe(self, msg: Dict[str, Any]) -> Future[Any] | None:
        loop = self._loop
        if not loop:
            return None
        return asyncio.run_coroutine_threadsafe(self._send(msg), loop)

    async def _on_raw(self, raw: Any) -> None:
        try:
            msg = json.loads(raw)
        except Exception:
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
            await self._dispatch_request(msg)
            return

        if kind in ("event", "command"):
            self._dispatch_event(msg)
            return

        # 'ack'/'error'/'hello' are informational here.
        if kind == "error":
            logger.warning(f"BusClient '{self.client_id}' bus error: {msg.get('error')}")

    def _dispatch_event(self, msg: Dict[str, Any]) -> None:
        for handler in list(self._subscribers.get(msg.get("topic", ""), [])):
            try:
                result = handler(msg)
                if asyncio.iscoroutine(result):
                    task = asyncio.create_task(result)
                    self._handler_tasks.add(task)
                    task.add_done_callback(self._handler_tasks.discard)
            except Exception as e:
                logger.warning(f"BusClient handler for '{msg.get('topic')}' raised: {e}")

    async def _dispatch_request(self, msg: Dict[str, Any]) -> None:
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
        except Exception as e:
            reply = self._envelope(msg.get("src", MAIN), topic, "response", None, corr=msg.get("id"))
            reply["ok"] = False
            reply["error"] = str(e)
            await self._send(reply)


# Process-wide singleton for convenience (mirrors the Node `bus` facade).
_client: Optional[BusClient] = None


def get_bus() -> BusClient:
    global _client
    if _client is None:
        _client = BusClient()
    return _client


def start_bus(runtime: Optional[AsyncTransportRuntime] = None, **kwargs: Any) -> BusClient:
    """Create (if needed) and start the singleton bus client."""
    global _client
    if _client is None:
        _client = BusClient(**kwargs)
    return _client.start(runtime)
