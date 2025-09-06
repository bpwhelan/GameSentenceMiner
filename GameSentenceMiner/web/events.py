import asyncio
from collections import defaultdict
import datetime
import json
import os
import queue
import sqlite3
import threading
from dataclasses import dataclass

from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.text_log import GameLine, initial_time
from GameSentenceMiner.util.configuration import logger, DB_PATH


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
            event = EventItem(line, event_id, text, timestamp,
                              False, timestamp < initial_time)
            self.events.append(event)
            self.ids.append(event_id)
            self.events_dict[event_id] = event

    def __iter__(self):
        return iter(self.events)

    def replace_events(self, new_events: list[EventItem]):
        self.events = new_events

    def add_gameline(self, line: GameLine):
        new_event = EventItem(line, line.id, line.text,
                              line.time, False, False)
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
        self.cursor.execute("DELETE FROM events WHERE time < ?",
                            (initial_time.isoformat(),))
        logger.info(f"Cleared history before {initial_time.isoformat()}")
        self.conn.commit()
        # Clear the in-memory events as well
        event_manager.events = [
            event for event in event_manager if not event.history]
        event_manager.events_dict = {
            event.id: event for event in event_manager.events}


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


# Global instances
event_manager = EventManager()
event_queue = queue.Queue()

# Initialize the EventProcessor with the queue and event manager
event_processor = EventProcessor(event_queue, DB_PATH)
event_processor.start()