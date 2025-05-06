import asyncio
import datetime
import json
import os
import queue
import sqlite3
import threading
from dataclasses import dataclass

import flask
import websockets

from GameSentenceMiner.text_log import GameLine, get_line_by_id, initial_time
from flask import request, jsonify, send_from_directory
import webbrowser
from GameSentenceMiner import obs
from GameSentenceMiner.configuration import logger, get_config, DB_PATH
from GameSentenceMiner.util import TEXT_REPLACEMENTS_FILE

port = get_config().general.texthooker_port
url = f"http://localhost:{port}"
websocket_port = 55001


@dataclass
class EventItem:
    line: 'GameLine'
    id: str
    text: str
    time: datetime.datetime
    checked: bool = False
    history: bool = False

    def to_dict(self):
        return {
            'id': self.id,
            'text': self.text,
            'time': self.time,
            'checked': self.checked,
            'history': self.history,
        }

    def to_serializable(self):
        return {
            'id': self.id,
            'text': self.text,
            'time': self.time.isoformat(),
            'checked': self.checked,
            'history': self.history,
        }

class EventManager:
    events: list[EventItem]
    events_dict: dict[str, EventItem] = {}
    line_for_audio: GameLine = None
    line_for_screenshot: GameLine = None

    def __init__(self):
        self.events = []
        self.events_dict = {}
        self._connect()
        self._create_table()
        self._load_events_from_db()
        # self.close_connection()

    def _connect(self):
        self.conn = sqlite3.connect(DB_PATH)
        self.cursor = self.conn.cursor()

    def _create_table(self):
        self.cursor.execute("""
            CREATE TABLE IF NOT EXISTS events (
                event_id TEXT PRIMARY KEY,
                line_id TEXT,
                text TEXT,
                time TEXT
            )
        """)
        self.conn.commit()

    def _load_events_from_db(self):
        self.cursor.execute("SELECT * FROM events")
        rows = self.cursor.fetchall()
        for row in rows:
            event_id, line_id, text, timestamp = row
            timestamp = datetime.datetime.fromisoformat(timestamp)
            line = GameLine(line_id, text, timestamp, None, None, 0)
            event = EventItem(line, event_id, text, timestamp, False, timestamp < initial_time)
            self.events.append(event)
            self.events_dict[event_id] = event

    def __iter__(self):
        return iter(self.events)

    def replace_events(self, new_events: list[EventItem]):
        self.events = new_events

    def add_gameline(self, line: GameLine):
        new_event = EventItem(line, line.id, line.text, line.time, False, False)
        self.events_dict[line.id] = new_event
        self.events.append(new_event)
        # self.store_to_db(new_event)
        event_queue.put(new_event)
        return new_event

    def reset_checked_lines(self):
        for event in self.events:
            event.checked = False

    def get_events(self):
        return self.events

    def add_event(self, event):
        self.events.append(event)
        event_queue.put(event)

    def get(self, event_id):
        return self.events_dict.get(event_id)

    def close_connection(self):
        if self.conn:
            self.conn.close()

    def clear_history(self):
        self.cursor.execute("DELETE FROM events WHERE time < ?", (initial_time.isoformat(),))
        logger.info(f"Cleared history before {initial_time.isoformat()}")
        self.conn.commit()
        # Clear the in-memory events as well
        event_manager.events = [event for event in event_manager if not event.history]
        event_manager.events_dict = {event.id: event for event in event_manager.events}

class EventProcessor(threading.Thread):
    def __init__(self, event_queue, db_path):
        super().__init__()
        self.event_queue = event_queue
        self.db_path = db_path
        self.conn = None
        self.cursor = None
        self.daemon = True

    def _connect(self):
        self.conn = sqlite3.connect(self.db_path)
        self.cursor = self.conn.cursor()

    def run(self):
        self._connect()
        while True:
            try:
                event = self.event_queue.get()
                if event is None:  # Exit signal
                    break
                self._store_to_db(event)
            except Exception as e:
                logger.error(f"Error processing event: {e}")
        self._close_connection()

    def _store_to_db(self, event):
        self.cursor.execute("""
            INSERT INTO events (event_id, line_id, text, time)
            VALUES (?, ?, ?, ?)
        """, (event.id, event.line.id, event.text, event.time.isoformat()))
        self.conn.commit()

    def _close_connection(self):
        if self.conn:
            self.conn.close()

event_manager = EventManager()
event_queue = queue.Queue()

# Initialize the EventProcessor with the queue and event manager
event_processor = EventProcessor(event_queue, DB_PATH)
event_processor.start()

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
    return flask.render_template('utility.html', websocket_port=websocket_port)

@app.route('/texthooker')
def texthooker():
    return flask.render_template('utility.html', websocket_port=websocket_port)

@app.route('/textreplacements')
def textreplacements():
    return flask.render_template('text_replacements.html')

@app.route('/data', methods=['GET'])
def get_data():
    return jsonify([event.to_dict() for event in event_manager])

@app.route('/clear_history', methods=['POST'])
def clear_history():
    temp_em = EventManager()
    temp_em.clear_history()
    temp_em.close_connection()
    return jsonify({'message': 'History cleared successfully'}), 200


async def add_event_to_texthooker(line: GameLine):
    new_event = event_manager.add_gameline(line)
    await broadcast_message({
        'event': 'text_received',
        'sentence': line.text,
        'data': new_event.to_serializable()
    })


@app.route('/update', methods=['POST'])
def update_event():
    data = request.get_json()
    event_id = data.get('id')
    checked = data.get('checked')

    if event_id is None or checked is None:
        return jsonify({'error': 'Missing id or checked status'}), 400

    event_manager.get(event_id).checked = checked
    return jsonify({'message': 'Event updated successfully'}), 200

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


connected_clients = set()

async def websocket_handler(websocket):
    logger.debug(f"Client connected: {websocket.remote_address}")
    connected_clients.add(websocket)
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                if 'type' in data and data['type'] == 'get_events':
                    initial_events = [{'id': 1, 'text': 'Initial event from WebSocket'}, {'id': 2, 'text': 'Another initial event'}]
                    await websocket.send(json.dumps({'event': 'initial_events', 'payload': initial_events}))
                elif 'update_checkbox' in data:
                    print(f"Received checkbox update: {data}")
                    # Handle checkbox update logic
                    pass
                await websocket.send(json.dumps({'response': f'Server received: {message}'}))
            except json.JSONDecodeError:
                await websocket.send(json.dumps({'error': 'Invalid JSON format'}))
    except websockets.exceptions.ConnectionClosedError:
        print(f"Client disconnected abruptly: {websocket.remote_address}")
    except websockets.exceptions.ConnectionClosedOK:
        print(f"Client disconnected gracefully: {websocket.remote_address}")
    finally:
        connected_clients.discard(websocket)

async def broadcast_message(message):
    if connected_clients:
        tasks = [client.send(json.dumps(message)) for client in connected_clients]
        await asyncio.gather(*tasks)

# async def main():
#     async with websockets.serve(websocket_handler, "localhost", 8765): # Choose a port for WebSocket
#         print("WebSocket server started on ws://localhost:8765/ws (adjust as needed)")
#         await asyncio.Future()  # Keep the server running

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
    event_manager.reset_checked_lines()

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

async def run_websocket_server(host="0.0.0.0", port=55001):
    global websocket_port
    while True:
        websocket_port = port
        try:
            async with websockets.serve(websocket_handler, host, port):
                logger.debug(f"WebSocket server started at ws://{host}:{port}/")
                await asyncio.Future()  # Keep the WebSocket server running
        except OSError as e:
            logger.debug(f"Port {port} is in use. Trying the next port...")
            port += 1



async def texthooker_page_coro():
    # Run the WebSocket server in the asyncio event loop
    flask_thread = threading.Thread(target=start_web_server)
    flask_thread.daemon = True
    flask_thread.start()

    # Keep the main asyncio event loop running (for the WebSocket server)
    await run_websocket_server()

def run_text_hooker_page():
    asyncio.run(texthooker_page_coro())

if __name__ == '__main__':
    asyncio.run(run_text_hooker_page())