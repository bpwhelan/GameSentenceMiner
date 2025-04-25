import datetime
import json
import os
from dataclasses import dataclass

import flask

from GameSentenceMiner.text_log import GameLine, get_line_by_id
from flask import request, jsonify, send_from_directory
import webbrowser
from GameSentenceMiner import obs
from GameSentenceMiner.configuration import logger, get_config
from GameSentenceMiner.util import TEXT_REPLACEMENTS_FILE

port = get_config().general.texthooker_port
url = f"http://localhost:{port}"


@dataclass
class EventItem:
    line: 'GameLine'
    id: str
    text: str
    time: datetime.datetime
    timestamp: float
    checked: bool = False

    def to_dict(self):
        return {
            'id': self.id,
            'text': self.text,
            'time': self.time,
            'timestamp': self.timestamp,
            'checked': self.checked
        }

class EventManager:
    events: list[EventItem]
    events_dict: dict[str, EventItem] = {}
    line_for_audio: GameLine = None
    line_for_screenshot: GameLine = None

    def __init__(self):
        self.events = []
        self.events_dict = {}

    def __iter__(self):
        return iter(self.events)

    def replace_events(self, new_events: list[EventItem]):
        self.events = new_events

    def add_gameline(self, line: GameLine):
        new_event = EventItem(line, line.id, line.text, line.time, line.time.timestamp(), False)
        self.events_dict[line.id] = new_event
        self.events.append(new_event)

    def get_events(self):
        return self.events

    def add_event(self, event):
        self.events.append(event)

    def get(self, event_id):
        return self.events_dict.get(event_id)

event_manager = EventManager()

server_start_time = datetime.datetime.now().timestamp()

app = flask.Flask(__name__)

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
    with open(os.path.join(app.root_path, 'static', 'utility.html'), encoding='utf-8') as file:
        return file.read()

@app.route('/texthooker')
def texthooker():
    with open(os.path.join(app.root_path, 'static', 'utility.html'), encoding='utf-8') as file:
        return file.read()

@app.route('/textreplacements')
def textreplacements():
    with open(os.path.join(app.root_path, 'static', 'text_replacements.html'), encoding='utf-8') as file:
        return file.read()

@app.route('/data', methods=['GET'])
def get_data():
    return jsonify([event.to_dict() for event in event_manager])


def add_event_to_texthooker(line: GameLine):
    logger.info("Adding event to web server: %s", line.text)
    event_manager.add_gameline(line)


@app.route('/update', methods=['POST'])
def update_event():
    data = request.get_json()
    event_id = data.get('id')
    checked = data.get('checked')

    logger.info(event_id)
    logger.info(checked)

    if event_id is None or checked is None:
        return jsonify({'error': 'Missing id or checked status'}), 400

    logger.info(event_manager.get(event_id))

    event_manager.get(event_id).checked = checked

    return jsonify({'error': 'Event not found'}), 404

@app.route('/get-screenshot', methods=['Post'])
def get_screenshot():
    """Endpoint to get a screenshot of the current game screen."""
    data = request.get_json()
    event_id = data.get('id')
    if event_id is None:
        return jsonify({'error': 'Missing id'}), 400
    event_manager.line_for_screenshot = get_line_by_id(event_id)
    obs.save_replay_buffer()
    return jsonify({}), 200

@app.route('/play-audio', methods=['POST'])
def play_audio():
    """Endpoint to play audio for a specific event."""
    data = request.get_json()
    event_id = data.get('id')
    if event_id is None:
        return jsonify({'error': 'Missing id'}), 400
    event_manager.line_for_audio = get_line_by_id(event_id)
    obs.save_replay_buffer()
    return jsonify({}), 200


# @app.route('/store-events', methods=['POST'])
# def store_events():
#     data = request.get_json()
#     events_data = data.get('events', [])
#
#     if not isinstance(events_data, list):
#         return jsonify({'error': 'Invalid data format. Expected an array of events.'}), 400
#
#     for event_data in events_data:
#         if not all(k in event_data for k in ('id', 'text', 'time', 'checked')):
#              return jsonify({'error': 'Invalid event structure. Missing keys.'}), 400
#         if not (isinstance(event_data['id'], (int, float)) and
#                 isinstance(event_data['text'], str) and
#                 isinstance(event_data['time'], str) and
#                 isinstance(event_data['checked'], bool)):
#             return jsonify({'error': 'Invalid event structure. Incorrect data types.'}), 400
#
#     event_manager.replace_events([EventItem(item['id'], item['text'], item['time'], item.get(['timestamp'], 0), item['checked']) for item in data])
#
#     return jsonify({'message': 'Events successfully stored on server.', 'receivedEvents': data}), 200


def get_selected_lines():
    return [item.line for item in event_manager if item.checked]

def are_lines_selected():
    return any(item.checked for item in event_manager)

def reset_checked_lines():
    for item in event_manager:
        item.checked = False

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

    app.run(port=port, debug=False) # debug=True provides helpful error messages during development

if __name__ == '__main__':
    start_web_server()