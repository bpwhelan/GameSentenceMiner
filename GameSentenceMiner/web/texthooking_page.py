import asyncio
import datetime
import flask
import json
import logging
import os
import socket
import textwrap
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from flask import render_template, request, jsonify, send_from_directory
from waitress import serve

from GameSentenceMiner import obs
from GameSentenceMiner.ai.ai_prompting import get_ai_prompt_result
from GameSentenceMiner.obs import get_current_game
from GameSentenceMiner.util.config.configuration import (
    logger,
    get_config,
    gsm_state,
    gsm_status,
)
from GameSentenceMiner.util.gsm_utils import TEXT_REPLACEMENTS_FILE
from GameSentenceMiner.util.text_log import get_line_by_id, get_all_lines
# Import from new modules
from GameSentenceMiner.web.events import EventManager, event_manager
from GameSentenceMiner.web.gsm_websocket import (
    websocket_manager,
    EndpointSpec,
    ID_OVERLAY,
    ID_HOOKER,
    ID_PLAINTEXT,
    _overlay_message_handler,
)

server_start_time = datetime.datetime.now().timestamp()
_legacy_notice_server = None
_legacy_notice_thread = None
_single_port_gateway_active = False
_single_port_gateway_port = None
_ws_invalid_upgrade_filter_installed = False

app = flask.Flask(__name__, static_folder="static", static_url_path="/static")

# Local development/desktop renderer origins that may call this Flask server.
_LOCAL_CORS_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
}


def _is_single_port_experiment_enabled() -> bool:
    # Single-port mode is now the default runtime.
    return True


def _get_single_port() -> int:
    try:
        port = int(get_config().general.single_port or 7275)
    except Exception:
        port = 7275
    return 7275 if port <= 0 else port


def _get_legacy_texthooker_port() -> int:
    try:
        port = int(get_config().general.texthooker_port or 55000)
    except Exception:
        port = 55000
    return 55000 if port < 0 else port


class _WebsocketInvalidUpgradeLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if "opening handshake failed" in message:
            return False

        if record.exc_info and len(record.exc_info) >= 2 and record.exc_info[1] is not None:
            exc_text = str(record.exc_info[1])
            if "InvalidUpgrade" in record.exc_info[1].__class__.__name__:
                return False
            if "invalid Connection header: keep-alive" in exc_text:
                return False
            return True

        return "invalid Connection header: keep-alive" not in message


def _install_ws_invalid_upgrade_suppression():
    global _ws_invalid_upgrade_filter_installed
    if _ws_invalid_upgrade_filter_installed:
        return

    log_filter = _WebsocketInvalidUpgradeLogFilter()
    for logger_name in ("websockets.server", "websockets.asyncio.server"):
        ws_logger = logging.getLogger(logger_name)
        ws_logger.addFilter(log_filter)
        ws_logger.setLevel(logging.CRITICAL)
        ws_logger.propagate = False
    _ws_invalid_upgrade_filter_installed = True


if _is_single_port_experiment_enabled():
    _install_ws_invalid_upgrade_suppression()


def _find_free_port(bind_host: str) -> int:
    family = socket.AF_INET6 if ":" in str(bind_host) else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        bind_address = (bind_host, 0, 0, 0) if family == socket.AF_INET6 else (bind_host, 0)
        sock.bind(bind_address)
        return int(sock.getsockname()[1])


def _run_waitress_server(host: str, bind_port: int):
    try:
        serve(
            app,
            host=host,
            port=bind_port,
            threads=8,
            backlog=10,
        )
    except Exception as waitress_error:
        logger.error(f"Internal waitress server crashed on {host}:{bind_port}: {waitress_error}")
        raise


def _wait_for_tcp_port(host: str, bind_port: int, timeout_seconds: float = 6.0) -> bool:
    deadline = datetime.datetime.now().timestamp() + timeout_seconds
    while datetime.datetime.now().timestamp() < deadline:
        try:
            with socket.create_connection((host, bind_port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def _try_start_single_port_gateway(host: str, external_port: int) -> bool:
    """
    Single-port mode:
      - Keep waitress and the websocket manager as-is on their internal ports.
      - Expose one public port that reverse-proxies HTTP + websocket paths.
    """
    global _single_port_gateway_active, _single_port_gateway_port

    try:
        from aiohttp import ClientSession, ClientTimeout, TCPConnector, WSMsgType, web
    except ImportError:
        logger.warning(
            "Single-port mode requested, but 'aiohttp' is not installed. "
            "Install with: pip install aiohttp"
        )
        return False

    internal_http_port = _find_free_port(host)
    ingress_ws_port = websocket_manager.get_ingress_port()
    upstream_host = "127.0.0.1" if host in {"0.0.0.0", "::", ""} else host

    if ingress_ws_port == external_port:
        # Prevent websocket->gateway self-loop and HTTP traffic landing on a WS-only listener.
        replacement_ws_port = _find_free_port(host)
        logger.warning(
            f"Single-port mode conflict detected: websocket ingress equals web port ({external_port}). "
            f"Rebinding websocket ingress internally to {replacement_ws_port}."
        )
        try:
            websocket_manager.stop_server(ID_HOOKER)
        except Exception as stop_error:
            logger.warning(f"Could not stop existing multiplex websocket server: {stop_error}")

        websocket_manager.start_multiplex_server(
            port_getter=lambda: replacement_ws_port,
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
        if not _wait_for_tcp_port(upstream_host, replacement_ws_port):
            logger.warning(
                f"Could not start replacement websocket ingress on {upstream_host}:{replacement_ws_port}."
            )
            return False
        ingress_ws_port = replacement_ws_port

    if internal_http_port == external_port:
        logger.warning(
            f"Single-port mode could not allocate internal HTTP port "
            f"(conflict on {internal_http_port}). Falling back to default waitress mode."
        )
        return False

    logger.success(
        f"Single-port mode enabled on {host}:{external_port}. "
        f"Internal HTTP: {upstream_host}:{internal_http_port}, websocket ingress: {upstream_host}:{ingress_ws_port}."
    )

    # Run waitress behind the gateway.
    waitress_thread = threading.Thread(
        target=_run_waitress_server,
        args=(host, internal_http_port),
        name="GSM-Waitress-Internal",
        daemon=True,
    )
    waitress_thread.start()
    if not _wait_for_tcp_port(upstream_host, internal_http_port):
        logger.warning(
            f"Single-port mode could not reach internal waitress on "
            f"{upstream_host}:{internal_http_port}. Falling back to default waitress mode."
        )
        return False

    hop_by_hop_headers = {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
    }

    async def proxy_http_request(client: ClientSession, incoming_request):
        if incoming_request.path == "/get_websocket_port":
            return web.json_response({"port": external_port})

        target = f"http://{upstream_host}:{internal_http_port}{incoming_request.rel_url}"
        payload = await incoming_request.read()
        forward_headers = {
            key: value
            for key, value in incoming_request.headers.items()
            if key.lower() not in hop_by_hop_headers
        }
        forward_headers["Connection"] = "close"
        forward_headers["Host"] = f"{upstream_host}:{internal_http_port}"

        try:
            async with client.request(
                incoming_request.method,
                target,
                data=payload,
                headers=forward_headers,
                allow_redirects=False,
            ) as upstream_response:
                response_body = await upstream_response.read()
                response_headers = {
                    key: value
                    for key, value in upstream_response.headers.items()
                    if key.lower() not in hop_by_hop_headers
                }
                # Avoid stale size metadata after proxy buffering/repackaging.
                response_headers.pop("Content-Length", None)
                response_headers.pop("content-length", None)
                return web.Response(
                    status=upstream_response.status,
                    body=response_body,
                    headers=response_headers,
                )
        except Exception as proxy_error:
            logger.warning(f"Single-port HTTP proxy error for {incoming_request.rel_url}: {proxy_error}")
            return web.json_response({"error": "Gateway proxy failed."}, status=502)

    def _is_expected_ws_proxy_close_error(error: Exception) -> bool:
        if isinstance(error, (asyncio.CancelledError, ConnectionResetError, BrokenPipeError)):
            return True
        if isinstance(error, OSError) and getattr(error, "errno", None) in {
            9,       # bad file descriptor
            32,      # broken pipe
            54,      # connection reset by peer (unix)
            10053,   # wsaconnaborted
            10054,   # wsaconnreset
            10058,   # wsashutdown
        }:
            return True
        error_text = str(error).lower()
        return any(
            token in error_text
            for token in (
                "cannot write to closing transport",
                "closing transport",
                "connection reset",
                "broken pipe",
                "closed transport",
            )
        )

    async def pipe_client_to_upstream(client_ws, upstream_ws):
        try:
            async for message in client_ws:
                try:
                    if message.type == WSMsgType.TEXT:
                        await upstream_ws.send_str(message.data)
                    elif message.type == WSMsgType.BINARY:
                        await upstream_ws.send_bytes(message.data)
                    elif message.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
                        break
                    elif message.type == WSMsgType.ERROR:
                        break
                except Exception as send_error:
                    if _is_expected_ws_proxy_close_error(send_error):
                        break
                    raise
        except Exception as pipe_error:
            if not _is_expected_ws_proxy_close_error(pipe_error):
                raise

    async def pipe_upstream_to_client(upstream_ws, client_ws):
        try:
            async for message in upstream_ws:
                try:
                    if message.type == WSMsgType.TEXT:
                        await client_ws.send_str(message.data)
                    elif message.type == WSMsgType.BINARY:
                        await client_ws.send_bytes(message.data)
                    elif message.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
                        break
                    elif message.type == WSMsgType.ERROR:
                        break
                except Exception as send_error:
                    if _is_expected_ws_proxy_close_error(send_error):
                        break
                    raise
        except Exception as pipe_error:
            if not _is_expected_ws_proxy_close_error(pipe_error):
                raise

    async def proxy_websocket_request(client: ClientSession, incoming_request):
        outgoing_ws = web.WebSocketResponse(heartbeat=20)
        await outgoing_ws.prepare(incoming_request)

        ws_target = f"ws://{upstream_host}:{ingress_ws_port}{incoming_request.rel_url}"
        forward_headers = {
            key: value
            for key, value in incoming_request.headers.items()
            if key.lower() not in hop_by_hop_headers
        }
        forward_headers["Host"] = f"{upstream_host}:{ingress_ws_port}"

        try:
            async with client.ws_connect(
                ws_target,
                headers=forward_headers,
                heartbeat=20,
                autoping=True,
                max_msg_size=0,
            ) as upstream_ws:
                relay_tasks = {
                    asyncio.create_task(pipe_client_to_upstream(outgoing_ws, upstream_ws)),
                    asyncio.create_task(pipe_upstream_to_client(upstream_ws, outgoing_ws)),
                }
                done, pending = await asyncio.wait(
                    relay_tasks,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                for task in done:
                    if task.cancelled():
                        continue
                    task_error = task.exception()
                    if task_error and not _is_expected_ws_proxy_close_error(task_error):
                        raise task_error
        except Exception as proxy_error:
            if _is_expected_ws_proxy_close_error(proxy_error):
                logger.debug(
                    f"Single-port websocket proxy closed for {incoming_request.rel_url}: {proxy_error}"
                )
            else:
                logger.warning(
                    f"Single-port websocket proxy error for {incoming_request.rel_url}: {proxy_error}"
                )
        finally:
            await outgoing_ws.close()

        return outgoing_ws

    client_session = None

    async def gateway_router(incoming_request):
        connection_header = incoming_request.headers.get("Connection", "")
        upgrade_header = incoming_request.headers.get("Upgrade", "")
        is_upgrade = (
            "upgrade" in connection_header.lower() and upgrade_header.lower() == "websocket"
        )
        if is_upgrade:
            return await proxy_websocket_request(client_session, incoming_request)
        return await proxy_http_request(client_session, incoming_request)

    async def gateway_main():
        global _single_port_gateway_active, _single_port_gateway_port
        nonlocal client_session
        app_gateway = web.Application(client_max_size=64 * 1024 * 1024)
        app_gateway.router.add_route("*", "/{tail:.*}", gateway_router)

        runner = web.AppRunner(app_gateway, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, host=host, port=external_port)
        timeout = ClientTimeout(total=None, sock_connect=5, sock_read=None)
        connector = TCPConnector(force_close=True, enable_cleanup_closed=True)
        # Preserve upstream encoding bytes (gzip/br) so browser decoding remains valid.
        client_session = ClientSession(
            timeout=timeout,
            connector=connector,
            auto_decompress=False,
        )
        await site.start()

        _single_port_gateway_active = True
        _single_port_gateway_port = external_port

        try:
            await asyncio.Event().wait()
        finally:
            _single_port_gateway_active = False
            _single_port_gateway_port = None
            await client_session.close()
            await runner.cleanup()

    try:
        if os.name == "nt":
            # aiohttp + Proactor on Windows can surface noisy connection reset callbacks.
            # Run this gateway on a selector loop for better compatibility.
            loop = asyncio.SelectorEventLoop()
            try:
                asyncio.set_event_loop(loop)
                loop.run_until_complete(gateway_main())
            finally:
                try:
                    loop.run_until_complete(loop.shutdown_asyncgens())
                except Exception:
                    pass
                loop.close()
                asyncio.set_event_loop(None)
        else:
            asyncio.run(gateway_main())
        return True
    except Exception as gateway_error:
        logger.warning(f"Single-port gateway failed to start: {gateway_error}")
        _single_port_gateway_active = False
        _single_port_gateway_port = None
        return False

# Configure Flask-Compress for Brotli compression
try:
    from flask_compress import Compress

    # Configure compression settings
    app.config["COMPRESS_MIMETYPES"] = [
        "text/html",
        "text/css",
        "text/xml",
        "text/plain",
        "application/json",
        "application/javascript",
        "application/x-javascript",
        "text/javascript",
    ]
    app.config["COMPRESS_LEVEL"] = 6  # Balance between speed and compression ratio
    app.config["COMPRESS_MIN_SIZE"] = 500  # Only compress files larger than 500 bytes
    app.config["COMPRESS_ALGORITHM"] = [
        "br",
        "gzip",
        "deflate",
    ]  # Prefer Brotli, fallback to gzip

    Compress(app)
    logger.background("Flask compression enabled with Brotli support")
except ImportError:
    logger.warning(
        "flask-compress not installed. Run 'pip install flask-compress' for better performance."
    )

# Configure Swagger/Flasgger for API documentation
try:
    from flasgger import Swagger
    
    swagger_config = {
        "headers": [],
        "specs": [
            {
                "endpoint": "apispec",
                "route": "/apispec.json",
                "rule_filter": lambda rule: True,
                "model_filter": lambda tag: True,
            }
        ],
        "static_url_path": "/flasgger_static",
        "swagger_ui": True,
        "specs_route": "/api/docs"
    }
    
    swagger_template = {
        "swagger": "2.0",
        "info": {
            "title": "GameSentenceMiner API",
            "description": "API documentation for GameSentenceMiner - A tool for mining sentences from Japanese games",
            "version": "1.0.0",
            "contact": {
                "name": "GameSentenceMiner",
                "url": "https://github.com/bpwhelan/GameSentenceMiner"
            }
        },
        "host": f"localhost:{_get_single_port()}",
        "basePath": "/",
        "schemes": ["http"],
        "tags": [
            {"name": "Database", "description": "Database operations and search"},
            {"name": "Statistics", "description": "Statistics and analytics endpoints"},
            {"name": "Anki", "description": "Anki integration endpoints"},
            {"name": "Jiten", "description": "Jiten.moe integration endpoints"},
            {"name": "Text Processing", "description": "Text replacement and processing"},
            {"name": "Goals", "description": "Goals and progress tracking"},
        ]
    }
    
    Swagger(app, config=swagger_config, template=swagger_template)
    logger.background("Swagger API documentation enabled at /api/docs")
except ImportError:
    logger.warning(
        "flasgger not installed. Run 'pip install flasgger' for API documentation support."
    )

# Add cache control headers for static files
@app.after_request
def add_cache_headers(response):
    """Add cache control headers to static assets for better performance."""
    origin = request.headers.get("Origin", "")
    if origin in _LOCAL_CORS_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,DELETE,OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Vary"] = "Origin"

    # Only add cache headers for static files (CSS, JS, images, fonts)
    if request.path.startswith("/static/"):
        # Check file extension
        if any(request.path.endswith(ext) for ext in [".css", ".js"]):
            # No cache for CSS/JS - always fetch fresh content
            response.cache_control.no_cache = True
            response.cache_control.no_store = True
            response.cache_control.must_revalidate = True
            response.headers["Cache-Control"] = (
                "no-cache, no-store, must-revalidate"
            )
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        elif any(
            request.path.endswith(ext)
            for ext in [
                ".jpg",
                ".jpeg",
                ".png",
                ".gif",
                ".svg",
                ".woff",
                ".woff2",
                ".ttf",
                ".eot",
                ".ico",
            ]
        ):
            # Cache images and fonts for longer (they rarely change)
            response.cache_control.max_age = 2592000  # 30 days
            response.cache_control.public = True
            response.headers["Cache-Control"] = "public, max-age=2592000, immutable"
    return response


# Load data from the JSON file
def load_data_from_file():
    if os.path.exists(TEXT_REPLACEMENTS_FILE):
        with open(TEXT_REPLACEMENTS_FILE, "r", encoding="utf-8") as file:
            return json.load(file)
    return {"enabled": True, "args": {"replacements": {}}}


# Save data to the JSON file
def save_data_to_file(data):
    with open(TEXT_REPLACEMENTS_FILE, "w", encoding="utf-8") as file:
        json.dump(data, file, indent=4, ensure_ascii=False)


@app.route("/load-data", methods=["GET"])
def load_data():
    try:
        data = load_data_from_file()
        return jsonify(data), 200
    except Exception as e:
        return jsonify({"error": f"Failed to load data: {str(e)}"}), 500


@app.route("/save-data", methods=["POST"])
def save_data():
    """
    Save text replacement data
    ---
    tags:
      - Text Processing
    parameters:
      - name: body
        in: body
        required: true
        schema:
          type: object
          properties:
            enabled:
              type: boolean
            args:
              type: object
    responses:
      200:
        description: Data saved successfully
      400:
        description: Invalid data format
      500:
        description: Failed to save data
    """
    try:
        data = request.get_json()
        if not isinstance(data, dict):
            return jsonify({"error": "Invalid data format"}), 400

        # Save updated data
        save_data_to_file(data)
        return jsonify({"message": "Data saved successfully"}), 200
    except Exception as e:
        return jsonify({"error": f"Failed to save data: {str(e)}"}), 500


def inject_server_start_time(html_content, timestamp):
    placeholder = "<script>"
    replacement = f"<script>const serverStartTime = {timestamp};"
    return html_content.replace(placeholder, replacement)


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(
        os.path.join(app.root_path, "static"),
        "favicon.ico",
        mimetype="image/vnd.microsoft.icon",
    )


@app.route("/<path:filename>")
def serve_static(filename):
    return send_from_directory("pages", filename)


@app.route("/")
def index():
    return send_from_directory("templates", "index.html")


@app.route("/texthooker")
def texthooker():
    return send_from_directory("templates", "index.html")


@app.route("/textreplacements")
def textreplacements():
    """
    Get text replacements configuration
    ---
    tags:
      - Text Processing
    responses:
      200:
        description: Text replacements configuration
        schema:
          type: object
          properties:
            enabled:
              type: boolean
            args:
              type: object
      404:
        description: Text replacements file not found
      500:
        description: Failed to load text replacements
    """
    # Serve the text replacements data as JSON for compatibility
    try:
        if not os.path.exists(TEXT_REPLACEMENTS_FILE):
            return jsonify({"error": "Text replacements file not found."}), 404
        with open(TEXT_REPLACEMENTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": f"Failed to load text replacements: {str(e)}"}), 500


@app.route("/database")
def database():
    return flask.render_template("database.html")


@app.route("/data", methods=["GET"])
def get_data():
    return jsonify([event.to_dict() for event in event_manager])


@app.route("/get_ids", methods=["GET"])
def get_ids():
    asyncio.run(check_for_lines_outside_replay_buffer())
    return jsonify(
        {
            "ids": event_manager.get_ordered_ids(),
            "timed_out_ids": list(event_manager.timed_out_ids),
        }
    )


@app.route("/clear_history", methods=["POST"])
def clear_history():
    temp_em = EventManager()
    temp_em.clear_history()
    temp_em.close_connection()
    return jsonify({"message": "History cleared successfully"}), 200


async def check_for_lines_outside_replay_buffer():
    time_window = (
        datetime.datetime.now()
        - datetime.timedelta(seconds=gsm_state.replay_buffer_length)
        - datetime.timedelta(seconds=5)
    )
    # logger.info(f"Checking for lines outside replay buffer time window: {time_window}")
    lines_outside_buffer = [
        line.id for line in event_manager.get_events() if line.time < time_window
    ]
    # logger.info(f"Lines outside replay buffer: {lines_outside_buffer}")
    event_manager.remove_lines_by_ids(lines_outside_buffer, timed_out=True)


async def add_event_to_texthooker(line):
    new_event = event_manager.add_gameline(line)
    await websocket_manager.send(
        ID_HOOKER,
        {
            "event": "text_received",
            "sentence": line.text,
            "data": new_event.to_serializable(),
        }
    )
    await websocket_manager.send(ID_PLAINTEXT, line.text)
    await check_for_lines_outside_replay_buffer()


async def send_word_coordinates_to_overlay(data):
    if data['data'] and len(data['data']) > 0 and websocket_manager.has_clients(ID_OVERLAY):
        await websocket_manager.send(ID_OVERLAY, data)


@app.route("/update_checkbox", methods=["POST"])
def update_event():
    data = request.get_json()
    event_id = data.get("id")

    if event_id is None:
        return jsonify({"error": "Missing id"}), 400
    event = event_manager.get(event_id)
    event_manager.get(event_id).checked = not event.checked
    return jsonify({"message": "Event updated successfully"}), 200


@app.route("/get-screenshot", methods=["Post"])
def get_screenshot():
    """
    Get screenshot of current game screen
    ---
    tags:
      - Text Processing
    parameters:
      - name: body
        in: body
        required: true
        schema:
          type: object
          properties:
            id:
              type: string
              description: Event ID
    responses:
      200:
        description: Screenshot captured successfully
      400:
        description: Missing or invalid event ID
      500:
        description: Failed to capture screenshot
    """
    data = request.get_json()
    event_id = data.get("id")
    if event_id is None:
        return jsonify({"error": "Missing id"}), 400
    line = get_line_by_id(event_id)
    if not line:
        return jsonify({"error": "Invalid id"}), 400
    gsm_state.line_for_screenshot = line
    if (
        gsm_state.previous_line_for_screenshot
        and gsm_state.line_for_screenshot == gsm_state.previous_line_for_screenshot
        or gsm_state.previous_line_for_audio
        and gsm_state.line_for_screenshot == gsm_state.previous_line_for_audio
    ):
        from GameSentenceMiner.web.service import handle_texthooker_button
        handle_texthooker_button(gsm_state.previous_replay)
    else:
        obs.save_replay_buffer()
    return jsonify({}), 200


@app.route("/play-audio", methods=["POST"])
def play_audio():
    """
    Play audio for a specific event
    ---
    tags:
      - Text Processing
    parameters:
      - name: body
        in: body
        required: true
        schema:
          type: object
          properties:
            id:
              type: string
              description: Event ID
    responses:
      200:
        description: Audio played successfully
      400:
        description: Missing or invalid event ID
      500:
        description: Failed to play audio
    """
    data = request.get_json()
    event_id = data.get("id")
    if event_id is None:
        return jsonify({"error": "Missing id"}), 400
    print(f"Playing audio for event ID: {event_id}")
    line = get_line_by_id(event_id)
    if not line:
        return jsonify({"error": "Invalid id"}), 400
    gsm_state.line_for_audio = line
    print(f"gsm_state.line_for_audio: {gsm_state.line_for_audio}")
    if (
        gsm_state.previous_line_for_audio
        and gsm_state.line_for_audio == gsm_state.previous_line_for_audio
        or gsm_state.previous_line_for_screenshot
        and gsm_state.line_for_audio == gsm_state.previous_line_for_screenshot
    ):
        from GameSentenceMiner.web.service import handle_texthooker_button
        handle_texthooker_button(gsm_state.previous_replay)
    else:
        obs.save_replay_buffer()
    return jsonify({}), 200


@app.route("/translate-line", methods=["POST"])
def translate_line():
    """
    Translate a single line using AI
    ---
    tags:
      - Text Processing
    parameters:
      - name: body
        in: body
        required: true
        schema:
          type: object
          properties:
            id:
              type: string
              description: Line ID to translate
            text:
              type: string
              description: Optional text override
    responses:
      200:
        description: Translation result
        schema:
          type: object
          properties:
            TL:
              type: string
              description: Translated text
      400:
        description: Invalid request or AI not configured
    """
    data = request.get_json()
    event_id = data.get("id")
    text = data.get("text", "").strip()
    if event_id is None:
        return jsonify({'error': 'Missing id'}), 400
    
    
    if get_config().ai.custom_texthooker_prompt:
        prompt = get_config().ai.custom_texthooker_prompt.strip()
    else:
        prompt = textwrap.dedent(f"""
        **Professional Game Localization Task**

        **Task Directive:**
        Translate ONLY the provided line of game dialogue specified below into natural-sounding, context-aware {get_config().general.get_native_language_name()}. The translation must preserve the original tone and intent of the source.

        **Output Requirements:**
        - Provide only the single, best {get_config().general.get_native_language_name()} translation.
        - Use expletives if they are natural for the context and enhance the translation's impact, but do not over-exaggerate.
        - Do not include notes, alternatives, explanations, or any other surrounding text. Absolutely nothing but the translated line.

        **Line to Translate:**
        """)

    if not get_config().ai.is_configured():
        return jsonify(
            {
                "error": 'AI translation is not properly configured. Please check your settings in the "AI" Tab.'
            }
        ), 400
    line = get_line_by_id(event_id)
    if line is None:
        return jsonify({"error": "Invalid id"}), 400
    line_to_translate = text if text else line.text
    translation = get_ai_prompt_result(
        get_all_lines(), line_to_translate, line, get_current_game(), custom_prompt=prompt
    )
    line.set_TL(translation)
    return jsonify({"TL": translation}), 200


@app.route("/translate-multiple", methods=["POST"])
def translate_multiple():
    """
    Translate multiple lines using AI
    ---
    tags:
      - Text Processing
    parameters:
      - name: body
        in: body
        required: true
        schema:
          type: object
          properties:
            ids:
              type: array
              items:
                type: string
              description: List of line IDs to translate
    responses:
      200:
        description: Translation result
        schema:
          type: string
      400:
        description: Invalid request or AI not configured
      500:
        description: Translation failed
    """
    data = request.get_json()
    event_ids = data.get("ids", [])
    if not event_ids:
        return jsonify({"error": "Missing ids"}), 400

    if not get_config().ai.is_configured():
        return jsonify(
            {
                "error": 'AI translation is not properly configured. Please check your settings in the "AI" Tab.'
            }
        ), 400

    lines = [
        get_line_by_id(event_id)
        for event_id in event_ids
        if get_line_by_id(event_id) is not None
    ]

    text = "\n".join(line.text for line in lines)
    
    language = get_config().general.get_native_language_name() if get_config().general.native_language else "English"
    
    translate_multiple_lines_prompt = textwrap.dedent(f"""
    **Professional Game Localization Task**
    Translate the following lines of game dialogue into natural-sounding, context-aware {language}:

    **Output Requirements**
    - Maintain the original tone and style of the dialogue.
    - Ensure that the translation is contextually appropriate for the game.
    - Pay attention to character names and any specific terminology used in the game.
    - Maintain Formatting and newline structure of the given lines. It should be very human readable as a dialogue.
    - Do not include any notes, alternatives, explanations, or any other surrounding text. Absolutely nothing but the translated lines.

    **Lines to Translate:**
    """)

    translation = get_ai_prompt_result(
        get_all_lines(),
        text,
        lines[0],
        get_current_game(),
        custom_prompt=translate_multiple_lines_prompt,
    )

    return translation, 200


@app.route("/get_status", methods=["GET"])
def get_status():
    """
    Get current GSM status
    ---
    tags:
      - Text Processing
    responses:
      200:
        description: Current status information
        schema:
          type: object
    """
    return jsonify(gsm_status.to_dict()), 200


@app.template_filter("datetimeformat")
def datetimeformat(value, format="%Y-%m-%d %H:%M:%S"):
    """Formats a timestamp into a human-readable string."""
    if value is None:
        return ""
    return datetime.datetime.fromtimestamp(float(value)).strftime(format)


@app.route("/overview")
def overview():
    """Renders the overview page."""
    from GameSentenceMiner.util.config.configuration import get_master_config, get_stats_config

    return render_template(
        "overview.html",
        config=get_config(),
        master_config=get_master_config(),
        stats_config=get_stats_config(),
    )


@app.route("/stats")
def stats():
    """Renders the stats page."""
    from GameSentenceMiner.util.config.configuration import get_master_config, get_stats_config
    from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable

    # Get first date from rollup table to avoid extra API call on page load
    first_rollup_date = StatsRollupTable.get_first_date()

    return render_template(
        "stats.html",
        config=get_config(),
        master_config=get_master_config(),
        stats_config=get_stats_config(),
        first_rollup_date=first_rollup_date,
    )


@app.route("/goals")
def goals():
    """Renders the goals page."""
    from GameSentenceMiner.util.config.configuration import get_master_config, get_stats_config

    return render_template(
        "goals.html",
        config=get_config(),
        master_config=get_master_config(),
        stats_config=get_stats_config(),
    )


@app.route("/search")
def search():
    """Renders the search page."""
    return render_template("search.html")


@app.route("/anki_stats")
def anki_stats():
    """Renders the Anki statistics page."""
    return render_template("anki_stats.html")


@app.route("/get_websocket_port", methods=["GET"])
def get_websocket_port():
    if _single_port_gateway_active and _single_port_gateway_port:
        return jsonify({"port": _single_port_gateway_port}), 200
    return jsonify({"port": websocket_manager.get_ingress_port()}), 200

def get_selected_lines():
    return [item.line for item in event_manager if item.checked]


def are_lines_selected():
    return any(item.checked for item in event_manager)


def reset_checked_lines():
    async def send_reset_message():
        await websocket_manager.send(
            ID_HOOKER,
            {
                "event": "reset_checkboxes",
            }
        )

    event_manager.reset_checked_lines()
    asyncio.run(send_reset_message())


def reset_buttons():
    async def send_reset_message():
        await websocket_manager.send(
            ID_HOOKER,
            {
                "event": "reset_buttons",
            }
        )

    asyncio.run(send_reset_message())


def open_texthooker():
    webbrowser.open(f"http://localhost:{_get_single_port()}/texthooker")


class _LegacyMovedPageHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send_moved_page(self, include_body: bool = True):
        current_port = _get_single_port()
        requested_host = (self.headers.get("Host") or "localhost").split(":", 1)[0] or "localhost"
        requested_path = self.path if self.path else "/"
        new_url = f"http://{requested_host}:{current_port}{requested_path}"

        message = textwrap.dedent(f"""
            <!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="refresh" content="3;url={new_url}">
                <meta charset="utf-8">
                <title>Page Moved - GameSentenceMiner</title>
                <style>
                    body {{
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        margin: 0;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    }}
                    .container {{
                        text-align: center;
                        background: white;
                        padding: 40px;
                        border-radius: 12px;
                        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                        max-width: 500px;
                    }}
                    h1 {{ color: #333; margin-top: 0; }}
                    p {{ color: #666; line-height: 1.6; }}
                    a {{ 
                        color: #667eea; 
                        text-decoration: none; 
                        font-weight: bold;
                    }}
                    a:hover {{ text-decoration: underline; }}
                    .redirect-note {{
                        margin-top: 20px;
                        font-size: 0.9em;
                        color: #999;
                    }}
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Page Moved</h1>
                    <p>GameSentenceMiner web UI has moved to port <strong>{current_port}</strong>.</p>
                    <p>You will be automatically redirected in 3 seconds...</p>
                    <p>Or click here: <a href="{new_url}">{new_url}</a></p>
                    <div class="redirect-note">
                        Update your bookmarks to the new address.
                    </div>
                </div>
            </body>
            </html>
        """).strip()

        payload = message.encode("utf-8")
        self.send_response(301)  # Moved Permanently
        self.send_header("Location", new_url)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        if include_body:
            self.wfile.write(payload)

    def do_GET(self):
        self._send_moved_page(include_body=True)

    def do_HEAD(self):
        self._send_moved_page(include_body=False)

    def do_POST(self):
        self._send_moved_page(include_body=True)

    def do_PUT(self):
        self._send_moved_page(include_body=True)

    def do_DELETE(self):
        self._send_moved_page(include_body=True)

    def do_OPTIONS(self):
        self._send_moved_page(include_body=True)

    def log_message(self, format, *args):
        # Keep this legacy compatibility server silent.
        return


def _start_legacy_moved_page_server():
    global _legacy_notice_server, _legacy_notice_thread
    if _legacy_notice_server is not None:
        return

    current_port = _get_single_port()
    legacy_port = _get_legacy_texthooker_port()

    if legacy_port <= 0:
        return
    if current_port == legacy_port:
        return

    host = get_config().advanced.localhost_bind_address
    try:
        _legacy_notice_server = ThreadingHTTPServer((host, legacy_port), _LegacyMovedPageHandler)
    except OSError as error:
        logger.warning(
            f"Could not start legacy moved-page server on {host}:{legacy_port}: {error}"
        )
        _legacy_notice_server = None
        return

    _legacy_notice_thread = threading.Thread(
        target=_legacy_notice_server.serve_forever,
        name=f"GSM-Legacy-{legacy_port}-Moved-Page",
        daemon=True,
    )
    _legacy_notice_thread.start()
    logger.info(
        f"Legacy moved-page server active on {host}:{legacy_port} "
        f"(current texthooker port: {current_port})."
    )


def start_web_server(debug=False):
    logger.debug("Starting web server...")

    log = logging.getLogger("werkzeug")
    log.setLevel(logging.ERROR)  # Set to ERROR to suppress most logs
    _start_legacy_moved_page_server()

    # Open the default browser
    if get_config().general.open_multimine_on_startup:
        open_texthooker()

    # FOR TEXTHOOKER DEVELOPMENT, UNCOMMENT THE FOLLOWING LINE WITH Flask-CORS INSTALLED:
    # from flask_cors import CORS
    # CORS(app, resources={r"/*": {"origins": "http://localhost:5174"}})
    host = get_config().advanced.localhost_bind_address
    single_port = _get_single_port()
    if _is_single_port_experiment_enabled():
        if _try_start_single_port_gateway(host, single_port):
            return
        logger.warning("Single-port gateway unavailable; continuing with default waitress mode.")

    _run_waitress_server(host, single_port)


async def texthooker_page_coro(wait=False, debug=False):
    # Run the WebSocket server in the asyncio event loop
    flask_thread = threading.Thread(target=start_web_server, args=(debug,))
    flask_thread.daemon = True
    flask_thread.start()

    # Keep the main asyncio event loop running (for the WebSocket server)
    if wait:
        await asyncio.Event().wait()

def run_text_hooker_page():
    try:
        asyncio.run(texthooker_page_coro())
    except KeyboardInterrupt:
        logger.info("Shutting down due to KeyboardInterrupt.")


if __name__ == "__main__":
    start_web_server(debug=True)
