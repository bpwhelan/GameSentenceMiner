from __future__ import annotations

import asyncio
from typing import Awaitable

import flask
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from GameSentenceMiner.web.texthooking_page import _create_wsgi_bridge_handler


def _run(coro: Awaitable[None]) -> None:
    asyncio.run(coro)


def test_wsgi_bridge_preserves_method_headers_query_and_json_body():
    flask_app = flask.Flask(__name__)

    @flask_app.route("/echo", methods=["POST"])
    def echo():
        return flask.jsonify(
            {
                "method": flask.request.method,
                "path": flask.request.path,
                "query": flask.request.args.get("value"),
                "header": flask.request.headers.get("X-Test"),
                "json": flask.request.get_json(),
            }
        ), 201

    async def _exercise() -> None:
        aiohttp_app = web.Application()
        aiohttp_app.router.add_route("*", "/{tail:.*}", _create_wsgi_bridge_handler(flask_app))

        client = TestClient(TestServer(aiohttp_app))
        await client.start_server()
        try:
            response = await client.post(
                "/echo?value=123",
                json={"hello": "world"},
                headers={"X-Test": "bridge"},
            )

            assert response.status == 201
            assert response.headers["Content-Type"].startswith("application/json")
            payload = await response.json()
            assert payload == {
                "method": "POST",
                "path": "/echo",
                "query": "123",
                "header": "bridge",
                "json": {"hello": "world"},
            }
        finally:
            await client.close()

    _run(_exercise())


def test_wsgi_bridge_streams_flask_response_body():
    flask_app = flask.Flask(__name__)

    @flask_app.route("/binary", methods=["GET"])
    def binary():
        def _generate():
            yield b"\x00\x01"
            yield b"gsm"

        return flask.Response(_generate(), mimetype="application/octet-stream")

    async def _exercise() -> None:
        aiohttp_app = web.Application()
        aiohttp_app.router.add_route("*", "/{tail:.*}", _create_wsgi_bridge_handler(flask_app))

        client = TestClient(TestServer(aiohttp_app))
        await client.start_server()
        try:
            response = await client.get("/binary")

            assert response.status == 200
            assert response.headers["Content-Type"].startswith("application/octet-stream")
            assert await response.read() == b"\x00\x01gsm"
        finally:
            await client.close()

    _run(_exercise())
