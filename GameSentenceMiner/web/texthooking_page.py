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
from GameSentenceMiner.web.gsm_websocket import (
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
    line = get_line_by_id(event_id)
    if not line:
        return jsonify({'error': 'Invalid id'}), 400
    gsm_state.line_for_screenshot = line
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
    line = get_line_by_id(event_id)
    if not line:
        return jsonify({'error': 'Invalid id'}), 400
    gsm_state.line_for_audio = line
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
    text = data.get('text', '').strip()
    if event_id is None:
        return jsonify({'error': 'Missing id'}), 400
    line = get_line_by_id(event_id)
    if line is None:
        return jsonify({'error': 'Invalid id'}), 400
    line_to_translate = text if text else line.text
    translation = get_ai_prompt_result(get_all_lines(), line_to_translate,
                                       line, get_current_game())
    line.set_TL(translation)
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


@app.route('/overview')
def overview():
    """Renders the overview page."""
    from GameSentenceMiner.util.configuration import get_master_config, get_stats_config
    return render_template('overview.html',
                         config=get_config(),
                         master_config=get_master_config(),
                         stats_config=get_stats_config())

@app.route('/stats')
def stats():
    """Renders the stats page."""
    from GameSentenceMiner.util.configuration import get_master_config, get_stats_config
    return render_template('stats.html',
                         config=get_config(),
                         master_config=get_master_config(),
                         stats_config=get_stats_config())

@app.route('/goals')
def goals():
    """Renders the goals page."""
    from GameSentenceMiner.util.configuration import get_master_config, get_stats_config
    return render_template('goals.html',
                         config=get_config(),
                         master_config=get_master_config(),
                         stats_config=get_stats_config())


@app.route('/api/anki_stats_combined')
def api_anki_stats_combined():
    """
    Unified API endpoint that combines all Anki statistics in a single response.
    This reduces page load time by eliminating multiple HTTP requests.
    
    Returns:
        {
            "kanji_stats": {...},
            "game_stats": [...],
            "nsfw_sfw_retention": {...},
            "mining_heatmap": {...},
            "earliest_date": int
        }
    """
    from GameSentenceMiner.anki import invoke
    from GameSentenceMiner.web.stats import calculate_kanji_frequency, calculate_mining_heatmap_data, is_kanji
    from GameSentenceMiner.util.db import GameLinesTable
    from collections import defaultdict
    import concurrent.futures
    
    start_timestamp = int(request.args.get('start_timestamp')) if request.args.get('start_timestamp') else None
    end_timestamp = int(request.args.get('end_timestamp')) if request.args.get('end_timestamp') else None
    
    combined_response = {
        "kanji_stats": {},
        "game_stats": [],
        "nsfw_sfw_retention": {},
        "mining_heatmap": {},
        "earliest_date": 0
    }
    
    try:
        # Fetch GSM lines once (used by multiple calculations)
        try:
            all_lines = (
                GameLinesTable.get_lines_filtered_by_timestamp(start_timestamp / 1000, end_timestamp / 1000)
                if start_timestamp is not None and end_timestamp is not None
                else GameLinesTable.all()
            )
        except Exception as e:
            logger.warning(f"Failed to filter lines by timestamp: {e}, fetching all lines instead")
            all_lines = GameLinesTable.all()
        
        # Get earliest date
        try:
            card_ids = invoke("findCards", query="")
            if card_ids:
                cards_info = invoke("cardsInfo", cards=card_ids)
                created_times = [card.get("created", 0) for card in cards_info if "created" in card]
                earliest_date = min(created_times) if created_times else 0
            else:
                earliest_date = 0
        except Exception as e:
            logger.error(f"Failed to fetch earliest date from Anki: {e}")
            earliest_date = 0
        
        # Get all kanji from Anki first field
        try:
            note_ids = invoke("findNotes", query="")
            anki_kanji_set = set()
            if note_ids:
                # Filter notes by creation time if provided
                batch_size = 1000
                for i in range(0, len(note_ids), batch_size):
                    batch_ids = note_ids[i:i+batch_size]
                    notes_info = invoke("notesInfo", notes=batch_ids)
                    for note in notes_info:
                        # Anki note creation time is in the 'mod' or 'created' field (in ms or s)
                        note_created = note.get("created", None) or note.get("mod", None)
                        # Anki's 'created' is in ms, 'mod' is in ms; timestamps are in ms, so compare directly
                        if start_timestamp and end_timestamp and note_created is not None:
                            # Ensure all are integers
                            note_created_int = int(note_created)
                            start_ts = int(start_timestamp)
                            end_ts = int(end_timestamp)
                            if not (start_ts <= note_created_int <= end_ts):
                                continue
                        fields = note.get("fields", {})
                        first_field = next(iter(fields.values()), None)
                        if first_field and "value" in first_field:
                            first_field_value = first_field["value"]
                            for char in first_field_value:
                                if is_kanji(char):
                                    anki_kanji_set.add(char)
        except Exception as e:
            logger.error(f"Failed to fetch kanji from Anki: {e}")
            anki_kanji_set = set()
        
        # Calculate kanji statistics
        gsm_kanji_stats = calculate_kanji_frequency(all_lines)
        gsm_kanji_list = gsm_kanji_stats.get("kanji_data", [])
        gsm_kanji_set = set([k["kanji"] for k in gsm_kanji_list])
        
        # Find missing kanji
        missing_kanji = [
            {"kanji": k["kanji"], "frequency": k["frequency"]}
            for k in gsm_kanji_list if k["kanji"] not in anki_kanji_set
        ]
        missing_kanji.sort(key=lambda x: x["frequency"], reverse=True)
        
        # Calculate coverage
        anki_kanji_count = len(anki_kanji_set)
        gsm_kanji_count = len(gsm_kanji_set)
        coverage_percent = (anki_kanji_count / gsm_kanji_count * 100) if gsm_kanji_count else 0.0
        
        combined_response["kanji_stats"] = {
            "missing_kanji": missing_kanji,
            "anki_kanji_count": anki_kanji_count,
            "gsm_kanji_count": gsm_kanji_count,
            "coverage_percent": round(coverage_percent, 1)
        }
        
        # Get game stats
        try:
            # Find all cards with Game:: parent tag (capital G)
            query = "tag:Game::*"
            card_ids = invoke("findCards", query=query)
            game_stats = []
            
            if card_ids:
                # Get card info to filter by date and extract tags
                cards_info = invoke("cardsInfo", cards=card_ids)
                
                # Filter cards by timestamp if provided
                if start_timestamp and end_timestamp:
                    cards_info = [
                        card for card in cards_info
                        if start_timestamp <= card.get('created', 0) <= end_timestamp
                    ]
                
                if cards_info:
                    # Get all unique note IDs and fetch note info in one batch call
                    note_ids = list(set(card['note'] for card in cards_info))
                    notes_info_list = invoke("notesInfo", notes=note_ids)
                    notes_info = {note['noteId']: note for note in notes_info_list}
                    
                    # Create card-to-note mapping for later use
                    card_to_note = {str(card['cardId']): card['note'] for card in cards_info}
                    
                    # Group cards by game (extract game name from tags)
                    game_cards = {}
                    for card in cards_info:
                        note_id = card['note']
                        note_info = notes_info.get(note_id)
                        if not note_info:
                            continue
                        
                        tags = note_info.get('tags', [])
                        
                        # Find game tag (format: Game::GameName)
                        game_tag = None
                        for tag in tags:
                            if tag.startswith('Game::'):
                                tag_parts = tag.split('::')
                                if len(tag_parts) >= 2:
                                    game_tag = tag_parts[1]
                                    break
                        
                        if game_tag:
                            if game_tag not in game_cards:
                                game_cards[game_tag] = []
                            game_cards[game_tag].append(card['cardId'])
                    
                    # Calculate statistics for each game
                    for game_name, card_ids in game_cards.items():
                        # Get review history for all cards in this game
                        reviews_data = invoke("getReviewsOfCards", cards=card_ids)
                        
                        # Group reviews by note ID and calculate per-note retention
                        note_stats = {}
                        
                        for card_id_str, reviews in reviews_data.items():
                            if not reviews:
                                continue
                            
                            note_id = card_to_note.get(card_id_str)
                            if not note_id:
                                continue
                            
                            # Filter reviews by timestamp if provided
                            filtered_reviews = reviews
                            if start_timestamp and end_timestamp:
                                filtered_reviews = [
                                    r for r in reviews
                                    if start_timestamp <= r.get('time', 0) <= end_timestamp
                                ]
                            
                            for review in filtered_reviews:
                                # Only count review-type entries (type=1)
                                review_type = review.get('type', -1)
                                if review_type != 1:
                                    continue
                                
                                if note_id not in note_stats:
                                    note_stats[note_id] = {'passed': 0, 'failed': 0, 'total_time': 0}
                                
                                note_stats[note_id]['total_time'] += review['time']
                                
                                # Ease: 1=Again, 2=Hard, 3=Good, 4=Easy
                                if review['ease'] == 1:
                                    note_stats[note_id]['failed'] += 1
                                else:
                                    note_stats[note_id]['passed'] += 1
                        
                        if note_stats:
                            # Calculate per-note retention and average them
                            retention_sum = 0
                            total_time = 0
                            total_reviews = 0
                            
                            for note_id, stats in note_stats.items():
                                passed = stats['passed']
                                failed = stats['failed']
                                total = passed + failed
                                
                                if total > 0:
                                    note_retention = passed / total
                                    retention_sum += note_retention
                                    total_time += stats['total_time']
                                    total_reviews += total
                            
                            # Average retention across all notes
                            note_count = len(note_stats)
                            avg_retention = (retention_sum / note_count) * 100 if note_count > 0 else 0
                            avg_time_seconds = (total_time / total_reviews / 1000.0) if total_reviews > 0 else 0
                            
                            game_stats.append({
                                'game_name': game_name,
                                'avg_time_per_card': round(avg_time_seconds, 2),
                                'retention_pct': round(avg_retention, 1),
                                'total_reviews': total_reviews,
                                'mined_lines': 0  # Set to 0 until proper name matching is implemented
                            })
                    
                    # Sort by game name
                    game_stats.sort(key=lambda x: x['game_name'])
            
            combined_response["game_stats"] = game_stats
        except Exception as e:
            logger.error(f"Failed to fetch game stats from Anki: {e}")
            combined_response["game_stats"] = []
        
        # Get NSFW/SFW retention
        try:
            def calculate_retention_for_cards(card_ids, start_timestamp, end_timestamp):
                if not card_ids:
                    return 0.0, 0, 0.0
                
                # Get card info to filter by date
                cards_info = invoke("cardsInfo", cards=card_ids)
                
                # Use card['created'] (milliseconds since epoch) for date filtering
                if start_timestamp and end_timestamp:
                    cards_info = [
                        card for card in cards_info
                        if start_timestamp <= card.get('created', 0) <= end_timestamp
                    ]
                
                if not cards_info:
                    return 0.0, 0, 0.0
                
                # Create card-to-note mapping
                card_to_note = {str(card['cardId']): card['note'] for card in cards_info}
                
                # Get review history for all cards
                reviews_data = invoke("getReviewsOfCards", cards=card_ids)
                
                # Group reviews by note ID and calculate per-note retention
                note_stats = {}
                
                for card_id_str, reviews in reviews_data.items():
                    if not reviews:
                        continue
                    
                    note_id = card_to_note.get(card_id_str)
                    if not note_id:
                        continue
                    
                    # Filter reviews by timestamp if provided
                    filtered_reviews = reviews
                    if start_timestamp and end_timestamp:
                        filtered_reviews = [
                            r for r in reviews
                            if start_timestamp <= r.get('time', 0) <= end_timestamp
                        ]
                    
                    for review in filtered_reviews:
                        # Only count review-type entries (type=1)
                        review_type = review.get('type', -1)
                        if review_type != 1:
                            continue
                        
                        if note_id not in note_stats:
                            note_stats[note_id] = {'passed': 0, 'failed': 0, 'total_time': 0}
                        
                        note_stats[note_id]['total_time'] += review['time']
                        
                        # Ease: 1=Again, 2=Hard, 3=Good, 4=Easy
                        if review['ease'] == 1:
                            note_stats[note_id]['failed'] += 1
                        else:
                            note_stats[note_id]['passed'] += 1
                
                if not note_stats:
                    return 0.0, 0, 0.0
                
                # Calculate per-note retention and average them
                retention_sum = 0
                total_reviews = 0
                total_time = 0
                
                for note_id, stats in note_stats.items():
                    passed = stats['passed']
                    failed = stats['failed']
                    total = passed + failed
                    
                    if total > 0:
                        note_retention = passed / total
                        retention_sum += note_retention
                        total_reviews += total
                        total_time += stats['total_time']
                
                # Average retention across all notes
                note_count = len(note_stats)
                avg_retention = (retention_sum / note_count) * 100 if note_count > 0 else 0
                avg_time_seconds = (total_time / total_reviews / 1000.0) if total_reviews > 0 else 0
                
                return avg_retention, total_reviews, avg_time_seconds
            
            # Query for NSFW cards (must have both Game and NSFW tags)
            nsfw_query = "tag:Game tag:NSFW"
            nsfw_card_ids = invoke("findCards", query=nsfw_query)
            
            # Query for SFW cards (must have Game tag but NOT NSFW tag)
            sfw_query = "tag:Game -tag:NSFW"
            sfw_card_ids = invoke("findCards", query=sfw_query)
            
            # Calculate retention for both categories
            nsfw_retention, nsfw_reviews, nsfw_avg_time = calculate_retention_for_cards(
                nsfw_card_ids, start_timestamp, end_timestamp
            )
            sfw_retention, sfw_reviews, sfw_avg_time = calculate_retention_for_cards(
                sfw_card_ids, start_timestamp, end_timestamp
            )
            
            combined_response["nsfw_sfw_retention"] = {
                'nsfw_retention': round(nsfw_retention, 1),
                'sfw_retention': round(sfw_retention, 1),
                'nsfw_reviews': nsfw_reviews,
                'sfw_reviews': sfw_reviews,
                'nsfw_avg_time': round(nsfw_avg_time, 2),
                'sfw_avg_time': round(sfw_avg_time, 2)
            }
        except Exception as e:
            logger.error(f"Failed to fetch NSFW/SFW retention stats from Anki: {e}")
            combined_response["nsfw_sfw_retention"] = {
                'nsfw_retention': 0,
                'sfw_retention': 0,
                'nsfw_reviews': 0,
                'sfw_reviews': 0,
                'nsfw_avg_time': 0,
                'sfw_avg_time': 0
            }
        
        # Calculate mining heatmap
        mining_heatmap = calculate_mining_heatmap_data(all_lines)
        combined_response["mining_heatmap"] = mining_heatmap
        
        combined_response["earliest_date"] = earliest_date
        
        return jsonify(combined_response)
        
    except Exception as e:
        logger.error(f"Error fetching combined Anki stats: {e}")
        logger.error(f"Error details: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


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
    
def reset_buttons():
    async def send_reset_message():
        await websocket_server_thread.send_text({
            'event': 'reset_buttons',
        })
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
    app.run(host=get_config().advanced.localhost_bind_address, port=port, debug=False)


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