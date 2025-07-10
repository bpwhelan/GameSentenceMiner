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

from GameSentenceMiner.util.gsm_utils import TEXT_REPLACEMENTS_FILE
from GameSentenceMiner.util.text_log import GameLine, get_line_by_id, initial_time
from flask import request, jsonify, send_from_directory
import webbrowser
from GameSentenceMiner import obs
from GameSentenceMiner.util.configuration import logger, get_config, DB_PATH, gsm_state, gsm_status
from GameSentenceMiner.web.service import handle_texthooker_button

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

    def __init__(self):
        self.events = []
        self.ids = []
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
            self.ids.append(event_id)
            self.events_dict[event_id] = event

    def __iter__(self):
        return iter(self.events)

    def replace_events(self, new_events: list[EventItem]):
        self.events = new_events

    def add_gameline(self, line: GameLine):
        new_event = EventItem(line, line.id, line.text, line.time, False, False)
        self.events_dict[line.id] = new_event
        self.ids.append(line.id)
        self.events.append(new_event)
        # self.store_to_db(new_event)
        # event_queue.put(new_event)
        return new_event

    def reset_checked_lines(self):
        for event in self.events:
            event.checked = False

    def get_events(self):
        return self.events

    def add_event(self, event):
        self.events.append(event)
        self.ids.append(event.id)
        event_queue.put(event)

    def get(self, event_id):
        return self.events_dict.get(event_id)

    def get_ids(self):
        return self.ids

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
    return send_from_directory('templates', 'index.html')

@app.route('/texthooker')
def texthooker():
    return send_from_directory('templates', 'index.html')

@app.route('/textreplacements')
def textreplacements():
    return flask.render_template('text_replacements.html')

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


async def add_event_to_texthooker(line: GameLine):
    new_event = event_manager.add_gameline(line)
    await websocket_server_thread.send_text({
        'event': 'text_received',
        'sentence': line.text,
        'data': new_event.to_serializable()
    })
    if get_config().advanced.plaintext_websocket_port:
        await plaintext_websocket_server_thread.send_text(line.text)


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
    if gsm_state.previous_line_for_screenshot and gsm_state.line_for_screenshot.id == gsm_state.previous_line_for_screenshot.id or gsm_state.previous_line_for_audio:
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
    gsm_state.line_for_audio = get_line_by_id(event_id)
    if gsm_state.previous_line_for_audio and gsm_state.line_for_audio == gsm_state.previous_line_for_audio or gsm_state.previous_line_for_screenshot:
        handle_texthooker_button(gsm_state.previous_replay)
    else:
        obs.save_replay_buffer()
    return jsonify({}), 200


@app.route('/get_status', methods=['GET'])
def get_status():
    return jsonify(gsm_status.to_dict()), 200


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

    app.run(port=port, debug=False) # debug=True provides helpful error messages during development


websocket_server_thread = None
websocket_queue = queue.Queue()
paused = False


class WebsocketServerThread(threading.Thread):
    def __init__(self, read, ws_port):
        super().__init__(daemon=True)
        self._loop = None
        self.read = read
        self.clients = set()
        self._event = threading.Event()
        self.ws_port = ws_port
        self.backedup_text = []

    @property
    def loop(self):
        self._event.wait()
        return self._loop

    async def send_text_coroutine(self, message):
        if not self.clients:
            self.backedup_text.append(message)
            return
        for client in self.clients:
            await client.send(message)

    async def server_handler(self, websocket):
        self.clients.add(websocket)
        try:
            if self.backedup_text:
                for message in self.backedup_text:
                    await websocket.send(message)
                self.backedup_text.clear()
            async for message in websocket:
                if self.read and not paused:
                    websocket_queue.put(message)
                    try:
                        await websocket.send('True')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
                else:
                    try:
                        await websocket.send('False')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
        except websockets.exceptions.ConnectionClosedError:
            pass
        finally:
            self.clients.remove(websocket)

    async def send_text(self, text):
        if text:
            if isinstance(text, dict):
                text = json.dumps(text)
            return asyncio.run_coroutine_threadsafe(
                self.send_text_coroutine(text), self.loop)

    def stop_server(self):
        self.loop.call_soon_threadsafe(self._stop_event.set)

    def run(self):
        async def main():
            self._loop = asyncio.get_running_loop()
            self._stop_event = stop_event = asyncio.Event()
            self._event.set()
            while True:
                try:
                    self.server = start_server = websockets.serve(self.server_handler,
                                                                  "0.0.0.0",
                                                                  self.ws_port,
                                                                  max_size=1000000000)
                    async with start_server:
                        await stop_event.wait()
                    return
                except Exception as e:
                    logger.warning(f"WebSocket server encountered an error: {e}. Retrying...")
                    await asyncio.sleep(1)

        asyncio.run(main())

def handle_exit_signal(loop):
    logger.info("Received exit signal. Shutting down...")
    for task in asyncio.all_tasks(loop):
        task.cancel()

async def texthooker_page_coro():
    global websocket_server_thread, plaintext_websocket_server_thread
    # Run the WebSocket server in the asyncio event loop
    flask_thread = threading.Thread(target=start_web_server)
    flask_thread.daemon = True
    flask_thread.start()

    websocket_server_thread = WebsocketServerThread(read=True, ws_port=get_config().advanced.texthooker_communication_websocket_port)
    websocket_server_thread.start()

    if get_config().advanced.plaintext_websocket_port:
        plaintext_websocket_server_thread = WebsocketServerThread(read=False, ws_port=get_config().advanced.plaintext_websocket_port)
        plaintext_websocket_server_thread.start()

    # Keep the main asyncio event loop running (for the WebSocket server)

def run_text_hooker_page():
    try:
        asyncio.run(texthooker_page_coro())
    except KeyboardInterrupt:
        logger.info("Shutting down due to KeyboardInterrupt.")

if __name__ == '__main__':
    asyncio.run(texthooker_page_coro())