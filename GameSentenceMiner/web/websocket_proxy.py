"""Helpers for safely terminating and recreating proxied WebSocket handshakes."""

from collections.abc import Mapping

_HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


def build_upstream_websocket_headers(
    incoming_headers: Mapping[str, str],
    *,
    upstream_host: str,
    upstream_port: int,
) -> dict[str, str]:
    """Return application headers for a fresh upstream WebSocket handshake.

    ``aiohttp.ClientSession.ws_connect`` owns every ``Sec-WebSocket-*`` header.
    Forwarding the outer client's extension offer can make the upstream server
    negotiate compression that the proxy client didn't enable, causing RSV-bit
    protocol errors as soon as the server sends a compressed frame.
    """
    headers = {
        key: value
        for key, value in incoming_headers.items()
        if key.lower() not in _HOP_BY_HOP_HEADERS and not key.lower().startswith("sec-websocket-")
    }
    headers["Host"] = f"{upstream_host}:{upstream_port}"
    return headers
