import asyncio
import datetime
import json
import os
import threading

import flask
import webbrowser

from GameSentenceMiner.ai.ai_prompting import get_ai_prompt_result
from GameSentenceMiner.obs import get_current_game
from GameSentenceMiner.util.gsm_utils import TEXT_REPLACEMENTS_FILE
from GameSentenceMiner.util.text_log import get_line_by_id, get_all_lines
from flask import render_template, request, jsonify, send_from_directory
from GameSentenceMiner import obs
from GameSentenceMiner.util.configuration import logger, get_config, gsm_state, gsm_status
from GameSentenceMiner.web.service import handle_texthooker_button

# Import from new modules
from GameSentenceMiner.web.events import (
    EventItem, EventManager, EventProcessor, event_manager, event_queue, event_processor
)
from GameSentenceMiner.web.stats import (
    is_kanji, interpolate_color, get_gradient_color, calculate_kanji_frequency,
    calculate_heatmap_data, calculate_total_chars_per_game, calculate_reading_time_per_game,
    calculate_reading_speed_per_game, generate_game_colors, format_large_number,
    calculate_actual_reading_time, calculate_daily_reading_time, calculate_time_based_streak,
    format_time_human_readable, calculate_current_game_stats, calculate_all_games_stats
)
from GameSentenceMiner.web.websockets import (
    WebsocketServerThread, websocket_queue, paused, websocket_server_thread,
    plaintext_websocket_server_thread, overlay_server_thread, websocket_server_threads,
    handle_exit_signal
)
from GameSentenceMiner.web.database_api import register_database_api_routes

# Global configuration
port = get_config().general.texthooker_port
url = f"http://localhost:{port}"
websocket_port = 55001

server_start_time = datetime.datetime.now().timestamp()

app = flask.Flask(__name__)

# Register database API routes
register_database_api_routes(app)

# Load data from the JSON file
def load_data_from_file():
    if os.path.exists(TEXT_REPLACEMENTS_FILE):
        with open(TEXT_REPLACEMENTS_FILE, 'r', encoding='utf-8') as file:
            return json.load(file)
    return {"enabled": True, "args": {"replacements": {}}}

# Save data to the JSON file
def save_data_to_file(data):
    with open(TEXT_REPLACEMENTS_FILE, 'w', encoding='utf-8') as file:
        json.dump(data, file, indent=4, ensure_ascii=False)


@app.route('/load-data', methods=['GET'])
def load_data():
    try:
        data = load_data_from_file()
        return jsonify(data), 200
    except Exception as e:
        return jsonify({"error": f"Failed to load data: {str(e)}"}), 500


@app.route('/save-data', methods=['POST'])
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
    placeholder = '<script>'
    replacement = f'<script>const serverStartTime = {timestamp};'
    return html_content.replace(placeholder, replacement)


@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(app.root_path, 'static'),
                               'favicon.ico', mimetype='image/vnd.microsoft.icon')


@app.route('/<path:filename>')
def serve_static(filename):
    return send_from_directory('pages', filename)


@app.route('/')
def index():
    return send_from_directory('templates', 'index.html')


@app.route('/texthooker')
def texthooker():
    return send_from_directory('templates', 'index.html')


@app.route('/textreplacements')
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

@app.route('/database')
def database():
    return flask.render_template('database.html')


@app.route('/data', methods=['GET'])
def get_data():
    return jsonify([event.to_dict() for event in event_manager])


@app.route('/get_ids', methods=['GET'])
def get_ids():
    return jsonify(event_manager.get_ids())


@app.route('/clear_history', methods=['POST'])
def clear_history():
    temp_em = EventManager()
    temp_em.clear_history()
    temp_em.close_connection()
    return jsonify({'message': 'History cleared successfully'}), 200


async def add_event_to_texthooker(line):
    new_event = event_manager.add_gameline(line)
    await websocket_server_thread.send_text({
        'event': 'text_received',
        'sentence': line.text,
        'data': new_event.to_serializable()
    })
    if get_config().advanced.plaintext_websocket_port:
        await plaintext_websocket_server_thread.send_text(line.text)


async def send_word_coordinates_to_overlay(boxes):
    if boxes and len(boxes) > 0 and overlay_server_thread:
        await overlay_server_thread.send_text(boxes)


@app.route('/update_checkbox', methods=['POST'])
def update_event():
    data = request.get_json()
    event_id = data.get('id')

    if event_id is None:
        return jsonify({'error': 'Missing id'}), 400
    event = event_manager.get(event_id)
    event_manager.get(event_id).checked = not event.checked
    return jsonify({'message': 'Event updated successfully'}), 200


@app.route('/get-screenshot', methods=['Post'])
def get_screenshot():
    """Endpoint to get a screenshot of the current game screen."""
    data = request.get_json()
    event_id = data.get('id')
    if event_id is None:
        return jsonify({'error': 'Missing id'}), 400
    gsm_state.line_for_screenshot = get_line_by_id(event_id)
    if gsm_state.previous_line_for_screenshot and gsm_state.line_for_screenshot == gsm_state.previous_line_for_screenshot or gsm_state.previous_line_for_audio and gsm_state.line_for_screenshot == gsm_state.previous_line_for_audio:
        handle_texthooker_button(gsm_state.previous_replay)
    else:
        obs.save_replay_buffer()
    return jsonify({}), 200


@app.route('/play-audio', methods=['POST'])
def play_audio():
    """Endpoint to play audio for a specific event."""
    data = request.get_json()
    event_id = data.get('id')
    if event_id is None:
        return jsonify({'error': 'Missing id'}), 400
    print(f"Playing audio for event ID: {event_id}")
    gsm_state.line_for_audio = get_line_by_id(event_id)
    print(f"gsm_state.line_for_audio: {gsm_state.line_for_audio}")
    if gsm_state.previous_line_for_audio and gsm_state.line_for_audio == gsm_state.previous_line_for_audio or gsm_state.previous_line_for_screenshot and gsm_state.line_for_audio == gsm_state.previous_line_for_screenshot:
        handle_texthooker_button(gsm_state.previous_replay)
    else:
        obs.save_replay_buffer()
    return jsonify({}), 200


@app.route("/translate-line", methods=['POST'])
def translate_line():
    data = request.get_json()
    event_id = data.get('id')
    if event_id is None:
        return jsonify({'error': 'Missing id'}), 400
    line_to_translate = get_line_by_id(event_id)
    translation = get_ai_prompt_result(get_all_lines(), line_to_translate.text,
                                       line_to_translate, get_current_game())
    line_to_translate.set_TL(translation)
    return jsonify({'TL': translation}), 200

@app.route('/translate-multiple', methods=['POST'])
def translate_multiple():
    data = request.get_json()
    event_ids = data.get('ids', [])
    if not event_ids:
        return jsonify({'error': 'Missing ids'}), 400

    lines = [get_line_by_id(event_id) for event_id in event_ids if get_line_by_id(event_id) is not None]

    text = "\n".join(line.text for line in lines)
    
    translate_multiple_lines_prompt = f"""
**Professional Game Localization Task**
Translate the following lines of game dialogue into natural-sounding, context-aware {get_config().general.get_native_language_name()}:

**Output Requirements**
- Maintain the original tone and style of the dialogue.
- Ensure that the translation is contextually appropriate for the game.
- Pay attention to character names and any specific terminology used in the game.
- Maintain Formatting and newline structure of the given lines. It should be very human readable as a dialogue.
- Do not include any notes, alternatives, explanations, or any other surrounding text. Absolutely nothing but the translated lines.

**Lines to Translate:**
"""

    translation = get_ai_prompt_result(get_all_lines(), text,
                                        lines[0], get_current_game(), custom_prompt=translate_multiple_lines_prompt)

    return translation, 200

@app.route('/get_status', methods=['GET'])
def get_status():
    return jsonify(gsm_status.to_dict()), 200

@app.template_filter('datetimeformat')
def datetimeformat(value, format='%Y-%m-%d %H:%M:%S'):
    """Formats a timestamp into a human-readable string."""
    if value is None:
        return ""
    return datetime.datetime.fromtimestamp(float(value)).strftime(format)


@app.route('/stats')
def stats():
    """Renders the stats page."""
    return render_template('stats.html')

@app.route('/api/anki_stats')
def api_anki_stats():
    """
    API endpoint to provide Anki vs GSM kanji stats for the frontend.
    Returns:
        {
            "missing_kanji": [ { "kanji": "漢", "frequency": 42 }, ... ],
            "anki_kanji_count": 123,
            "gsm_kanji_count": 456,
            "coverage_percent": 27.0
        }
    """
    from GameSentenceMiner.anki import get_all_anki_first_field_kanji
    from GameSentenceMiner.web.stats import calculate_kanji_frequency, is_kanji
    from GameSentenceMiner.util.db import GameLinesTable

    # Get all GSM lines and calculate kanji frequency
    all_lines = GameLinesTable.all()
    gsm_kanji_stats = calculate_kanji_frequency(all_lines)
    gsm_kanji_list = gsm_kanji_stats.get("kanji_data", [])
    gsm_kanji_set = set([k["kanji"] for k in gsm_kanji_list])

    # Get all kanji in Anki (first field only)
    anki_kanji_set = get_all_anki_first_field_kanji()

    # Find missing kanji (in GSM but not in Anki)
    missing_kanji = [
        {"kanji": k["kanji"], "frequency": k["frequency"]}
        for k in gsm_kanji_list if k["kanji"] not in anki_kanji_set
    ]

    # Sort missing kanji by frequency descending
    missing_kanji.sort(key=lambda x: x["frequency"], reverse=True)

    # Coverage stats
    anki_kanji_count = len(anki_kanji_set)
    gsm_kanji_count = len(gsm_kanji_set)
    coverage_percent = (anki_kanji_count / gsm_kanji_count * 100) if gsm_kanji_count else 0.0

    return jsonify({
        "missing_kanji": missing_kanji,
        "anki_kanji_count": anki_kanji_count,
        "gsm_kanji_count": gsm_kanji_count,
        "coverage_percent": round(coverage_percent, 1)
    })

@app.route('/search')
def search():
    """Renders the search page."""
    return render_template('search.html')

@app.route('/anki_stats')
def anki_stats():
    """Renders the Anki statistics page."""
    return render_template('anki_stats.html')

@app.route('/get_websocket_port', methods=['GET'])
def get_websocket_port():
    return jsonify({"port": websocket_server_thread.get_ws_port_func()}), 200


def get_selected_lines():
    return [item.line for item in event_manager if item.checked]


def are_lines_selected():
    return any(item.checked for item in event_manager)


def reset_checked_lines():
    async def send_reset_message():
        await websocket_server_thread.send_text({
            'event': 'reset_checkboxes',
        })
    event_manager.reset_checked_lines()
    asyncio.run(send_reset_message())


def open_texthooker():
    webbrowser.open(url + '/texthooker')


def start_web_server():
    logger.debug("Starting web server...")
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)  # Set to ERROR to suppress most logs

    # Open the default browser
    if get_config().general.open_multimine_on_startup:
        open_texthooker()

    # FOR TEXTHOOKER DEVELOPMENT, UNCOMMENT THE FOLLOWING LINE WITH Flask-CORS INSTALLED:
    # from flask_cors import CORS
    # CORS(app, resources={r"/*": {"origins": "http://localhost:5174"}})
    app.run(host='0.0.0.0', port=port, debug=False)


async def texthooker_page_coro():
    global websocket_server_thread, plaintext_websocket_server_thread, overlay_server_thread
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


if __name__ == '__main__':
    asyncio.run(texthooker_page_coro())