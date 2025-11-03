import asyncio
import datetime
import json
import os
import threading

import flask
import webbrowser
from flask import make_response

from GameSentenceMiner.ai.ai_prompting import get_ai_prompt_result
from GameSentenceMiner.obs import get_current_game
from GameSentenceMiner.util.gsm_utils import TEXT_REPLACEMENTS_FILE
from GameSentenceMiner.util.text_log import get_line_by_id, get_all_lines
from flask import render_template, request, jsonify, send_from_directory
from GameSentenceMiner import obs
from GameSentenceMiner.util.configuration import (
    logger,
    get_config,
    gsm_state,
    gsm_status,
)
from GameSentenceMiner.web.service import handle_texthooker_button

# Import from new modules
from GameSentenceMiner.web.events import EventManager, event_manager
from GameSentenceMiner.web.stats import (
    is_kanji,
    interpolate_color,
    get_gradient_color,
    calculate_kanji_frequency,
    calculate_heatmap_data,
    calculate_total_chars_per_game,
    calculate_reading_time_per_game,
    calculate_reading_speed_per_game,
    generate_game_colors,
    format_large_number,
    calculate_actual_reading_time,
    calculate_daily_reading_time,
    calculate_time_based_streak,
    format_time_human_readable,
    calculate_current_game_stats,
    calculate_all_games_stats,
)
from GameSentenceMiner.web.gsm_websocket import (
    WebsocketServerThread,
    websocket_queue,
    paused,
    websocket_server_thread,
    plaintext_websocket_server_thread,
    overlay_server_thread,
    websocket_server_threads,
    handle_exit_signal,
)
from GameSentenceMiner.web.database_api import register_database_api_routes
from GameSentenceMiner.web.jiten_database_api import register_jiten_database_api_routes
from GameSentenceMiner.web.stats_api import register_stats_api_routes

# Global configuration
port = get_config().general.texthooker_port
url = f"http://localhost:{port}"
websocket_port = 55001

server_start_time = datetime.datetime.now().timestamp()

app = flask.Flask(__name__)

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
    logger.info("Flask compression enabled with Brotli support")
except ImportError:
    logger.warning(
        "flask-compress not installed. Run 'pip install flask-compress' for better performance."
    )


# Add cache control headers for static files
@app.after_request
def add_cache_headers(response):
    """Add cache control headers to static assets for better performance."""
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


# Register database API routes
register_database_api_routes(app)
register_jiten_database_api_routes(app)
register_stats_api_routes(app)

# Register Anki API routes
from GameSentenceMiner.web.anki_api_endpoints import register_anki_api_endpoints

register_anki_api_endpoints(app)


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
            "ids": list(event_manager.get_ids()),
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
    await websocket_server_thread.send_text(
        {
            "event": "text_received",
            "sentence": line.text,
            "data": new_event.to_serializable(),
        }
    )
    if get_config().advanced.plaintext_websocket_port:
        await plaintext_websocket_server_thread.send_text(line.text)
    await check_for_lines_outside_replay_buffer()


async def send_word_coordinates_to_overlay(boxes):
    if boxes and len(boxes) > 0 and overlay_server_thread:
        await overlay_server_thread.send_text(boxes)


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
    """Endpoint to get a screenshot of the current game screen."""
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
        handle_texthooker_button(gsm_state.previous_replay)
    else:
        obs.save_replay_buffer()
    return jsonify({}), 200


@app.route("/play-audio", methods=["POST"])
def play_audio():
    """Endpoint to play audio for a specific event."""
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
        handle_texthooker_button(gsm_state.previous_replay)
    else:
        obs.save_replay_buffer()
    return jsonify({}), 200


@app.route("/translate-line", methods=["POST"])
def translate_line():
    data = request.get_json()
    event_id = data.get("id")
    text = data.get("text", "").strip()
    if event_id is None:
        return jsonify({'error': 'Missing id'}), 400
    
    
    if get_config().ai.custom_texthooker_prompt:
        prompt = get_config().ai.custom_texthooker_prompt.strip()
    else:
        prompt = f"""
        **Professional Game Localization Task**

        **Task Directive:**
        Translate ONLY the provided line of game dialogue specified below into natural-sounding, context-aware {get_config().general.get_native_language_name()}. The translation must preserve the original tone and intent of the source.

        **Output Requirements:**
        - Provide only the single, best {get_config().general.get_native_language_name()} translation.
        - Use expletives if they are natural for the context and enhance the translation's impact, but do not over-exaggerate.
        - Do not include notes, alternatives, explanations, or any other surrounding text. Absolutely nothing but the translated line.

        **Line to Translate:**
        """

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
    
    translate_multiple_lines_prompt = f"""
    **Professional Game Localization Task**
    Translate the following lines of game dialogue into natural-sounding, context-aware {language}:

    **Output Requirements**
    - Maintain the original tone and style of the dialogue.
    - Ensure that the translation is contextually appropriate for the game.
    - Pay attention to character names and any specific terminology used in the game.
    - Maintain Formatting and newline structure of the given lines. It should be very human readable as a dialogue.
    - Do not include any notes, alternatives, explanations, or any other surrounding text. Absolutely nothing but the translated lines.

    **Lines to Translate:**
    """

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
    from GameSentenceMiner.util.configuration import get_master_config, get_stats_config

    return render_template(
        "overview.html",
        config=get_config(),
        master_config=get_master_config(),
        stats_config=get_stats_config(),
    )


@app.route("/stats")
def stats():
    """Renders the stats page."""
    from GameSentenceMiner.util.configuration import get_master_config, get_stats_config
    from GameSentenceMiner.util.stats_rollup_table import StatsRollupTable

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
    from GameSentenceMiner.util.configuration import get_master_config, get_stats_config

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
    return jsonify({"port": websocket_server_thread.get_ws_port_func()}), 200


def get_selected_lines():
    return [item.line for item in event_manager if item.checked]


def are_lines_selected():
    return any(item.checked for item in event_manager)


def reset_checked_lines():
    async def send_reset_message():
        await websocket_server_thread.send_text(
            {
                "event": "reset_checkboxes",
            }
        )

    event_manager.reset_checked_lines()
    asyncio.run(send_reset_message())


def reset_buttons():
    async def send_reset_message():
        await websocket_server_thread.send_text(
            {
                "event": "reset_buttons",
            }
        )

    asyncio.run(send_reset_message())


def open_texthooker():
    webbrowser.open(url + "/texthooker")


def start_web_server():
    logger.debug("Starting web server...")
    import logging

    log = logging.getLogger("werkzeug")
    log.setLevel(logging.ERROR)  # Set to ERROR to suppress most logs

    # Open the default browser
    if get_config().general.open_multimine_on_startup:
        open_texthooker()

    # FOR TEXTHOOKER DEVELOPMENT, UNCOMMENT THE FOLLOWING LINE WITH Flask-CORS INSTALLED:
    # from flask_cors import CORS
    # CORS(app, resources={r"/*": {"origins": "http://localhost:5174"}})
    app.run(host=get_config().advanced.localhost_bind_address, port=port, debug=False)


async def texthooker_page_coro():
    global \
        websocket_server_thread, \
        plaintext_websocket_server_thread, \
        overlay_server_thread
    # Run the WebSocket server in the asyncio event loop
    flask_thread = threading.Thread(target=start_web_server)
    flask_thread.daemon = True
    flask_thread.start()

    # Keep the main asyncio event loop running (for the WebSocket server)


def run_text_hooker_page():
    try:
        asyncio.run(texthooker_page_coro())
    except KeyboardInterrupt:
        logger.info("Shutting down due to KeyboardInterrupt.")


if __name__ == "__main__":
    asyncio.run(texthooker_page_coro())
