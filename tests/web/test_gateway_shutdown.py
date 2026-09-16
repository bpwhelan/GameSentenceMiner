import asyncio
import socket
import threading
from types import SimpleNamespace

import pytest
from aiohttp import ClientSession
from websockets.asyncio.server import serve

from GameSentenceMiner.util.concurrency.transport import AsyncTransportRuntime
from GameSentenceMiner.web import texthooking_page


@pytest.fixture
def gateway(monkeypatch):
    runtime = AsyncTransportRuntime(name="test-gateway-shutdown")
    runtime.start()
    cleanup_finished = threading.Event()
    original_cleanup = texthooking_page.web.AppRunner.cleanup

    async def delayed_cleanup(runner):
        await asyncio.sleep(0.05)
        await original_cleanup(runner)
        cleanup_finished.set()

    async def echo(ws):
        async for message in ws:
            await ws.send(message)

    async def start_upstream():
        return await serve(echo, "127.0.0.1", 0, close_timeout=0.1)

    upstream = runtime.submit(start_upstream()).result(timeout=2)
    ingress_port = upstream.sockets[0].getsockname()[1]
    external_port = texthooking_page._find_free_port("127.0.0.1")
    monkeypatch.setattr(texthooking_page.web.AppRunner, "cleanup", delayed_cleanup)
    monkeypatch.setattr(texthooking_page, "_run_waitress_server", lambda *_args: None)
    monkeypatch.setattr(texthooking_page, "_wait_for_tcp_port", lambda *_args: True)
    monkeypatch.setattr(texthooking_page, "_legacy_notice_server", None)
    monkeypatch.setattr(texthooking_page, "_legacy_notice_thread", None)
    monkeypatch.setattr(texthooking_page, "_waitress_servers", [])
    monkeypatch.setattr(texthooking_page, "_waitress_threads", [])
    monkeypatch.setattr(
        texthooking_page,
        "websocket_manager",
        SimpleNamespace(_transport_runtime=runtime, get_ingress_port=lambda: ingress_port),
    )
    assert texthooking_page._try_start_single_port_gateway("127.0.0.1", external_port)
    future = texthooking_page._single_port_gateway_future
    clients = []

    async def connect():
        client = ClientSession()
        clients.append(client)
        ws = await client.ws_connect(f"http://127.0.0.1:{external_port}/ws")
        await ws.send_str("before restart")
        assert await ws.receive_str() == "before restart"
        return ws

    yield SimpleNamespace(
        runtime=runtime,
        port=external_port,
        future=future,
        cleanup_finished=cleanup_finished,
        connect=lambda: runtime.submit(connect()).result(timeout=2),
    )

    async def finish():
        for client in clients:
            await client.close()
        upstream.close()
        await upstream.wait_closed()

    runtime.submit(finish()).result(timeout=2)
    texthooking_page.stop_web_server(timeout=3)
    runtime.stop(timeout=3)


def test_stop_waits_until_gateway_cleanup_has_finished(gateway):
    texthooking_page.stop_web_server(timeout=3)

    assert gateway.cleanup_finished.is_set(), "HTTP cleanup must finish before the shared loop can stop"
    assert gateway.future.done()
    assert not gateway.future.cancelled()
    assert not texthooking_page._single_port_gateway_active


def test_stop_closes_idle_websockets_and_allows_same_port_restart(gateway, caplog):
    gateway.connect()  # Leave the client idle, without a receive loop answering the close frame.

    texthooking_page.stop_web_server(timeout=3)

    assert gateway.cleanup_finished.is_set()
    assert gateway.future.done()
    assert not gateway.future.cancelled()
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", gateway.port))

    assert texthooking_page._try_start_single_port_gateway("127.0.0.1", gateway.port)
    gateway.connect()
    texthooking_page.stop_web_server(timeout=3)
    assert not any("Unhandled exception" in record.message for record in caplog.records)


def test_shutdown_timeout_does_not_cancel_cleanup_and_can_be_joined_again(gateway):
    texthooking_page.stop_web_server(timeout=0.001)

    assert not gateway.future.cancelled()
    texthooking_page.stop_web_server(timeout=3)
    assert gateway.cleanup_finished.is_set()
    assert gateway.future.done()
    assert not gateway.future.cancelled()


def test_cancelling_a_proxy_request_drains_its_relay_tasks(gateway):
    gateway.connect()

    async def cancel_request():
        tasks = asyncio.all_tasks()
        relays = [task for task in tasks if ".pipe_" in task.get_coro().__qualname__]
        handlers = [task for task in tasks if task.get_coro().__qualname__ == "RequestHandler._handle_request"]
        assert len(relays) == 2
        assert len(handlers) == 1
        handlers[0].cancel()
        await asyncio.gather(*handlers, return_exceptions=True)
        assert all(task.done() for task in relays)

    gateway.runtime.submit(cancel_request()).result(timeout=3)
    texthooking_page.stop_web_server(timeout=3)
    assert gateway.cleanup_finished.is_set()
