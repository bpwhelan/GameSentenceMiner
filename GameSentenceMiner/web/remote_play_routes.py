from __future__ import annotations

import ipaddress

import requests
from flask import Flask, Response, jsonify, render_template, request

from GameSentenceMiner.web.remote_play import is_remote_play_origin_allowed, remote_play_manager

_YOMITAN_TOKENIZE_URL = "http://127.0.0.1:19633/tokenize"


def _no_store(response: Response) -> Response:
    response.headers["Cache-Control"] = "no-store"
    return response


def _public_host() -> str:
    return request.headers.get("X-GSM-Forwarded-Host") or request.host


def _client_address() -> str:
    remote_address = request.remote_addr or ""
    try:
        proxy_is_loopback = ipaddress.ip_address(remote_address).is_loopback
    except ValueError:
        proxy_is_loopback = False
    if proxy_is_loopback:
        forwarded = request.headers.get("X-GSM-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
    return remote_address


def _is_loopback_client() -> bool:
    try:
        return ipaddress.ip_address(_client_address()).is_loopback
    except ValueError:
        return False


def _authorized_request() -> bool:
    return is_remote_play_origin_allowed(
        request.headers.get("Origin"), _public_host()
    ) and remote_play_manager.access.validate(request.headers.get("X-GSM-Remote-Play-Token"))


def register_remote_play_routes(app: Flask) -> None:
    @app.get("/remote-play")
    def remote_play_page():
        return _no_store(Response(render_template("remote_play.html"), content_type="text/html; charset=utf-8"))

    @app.post("/api/remote-play/session")
    def issue_remote_play_session():
        if not _is_loopback_client() or not is_remote_play_origin_allowed(
            request.headers.get("Origin"), _public_host()
        ):
            return _no_store(jsonify({"error": "Remote-play sessions can only be issued from this computer."})), 403
        return _no_store(jsonify({"token": remote_play_manager.access.issue_token()}))

    @app.post("/api/remote-play/lookup")
    def proxy_remote_play_lookup():
        if not _authorized_request():
            return _no_store(jsonify({"error": "Remote-play authorization failed."})), 403

        payload = request.get_json(silent=True) or {}
        text = str(payload.get("text", "")).strip()
        if not text or len(text) > 1000:
            return _no_store(jsonify({"error": "Lookup text is required."})), 400
        try:
            scan_length = max(1, min(100, int(payload.get("scan_length", 10))))
        except (TypeError, ValueError):
            scan_length = 10

        try:
            upstream = requests.post(
                _YOMITAN_TOKENIZE_URL,
                json={"text": text, "scanLength": scan_length},
                timeout=3,
            )
        except requests.RequestException:
            return _no_store(jsonify({"error": "The Yomitan lookup service is unavailable."})), 502

        content_type = upstream.headers.get("Content-Type", "application/json")
        return _no_store(Response(upstream.content, status=upstream.status_code, content_type=content_type))
