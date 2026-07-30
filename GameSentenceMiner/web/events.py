import datetime
import threading
import uuid
from dataclasses import dataclass

from GameSentenceMiner.util.text_log import GameLine


@dataclass
class EventItem:
    line: "GameLine"
    id: str
    text: str
    time: datetime.datetime
    checked: bool = False
    history: bool = False
    excluded_from_stats: bool = False
    session_id: str = ""

    def to_dict(self):
        return {
            "id": self.id,
            "text": self.text,
            "time": self.time,
            "checked": self.checked,
            "history": self.history,
            "excluded_from_stats": self.excluded_from_stats,
            "session_id": self.session_id,
        }

    def to_serializable(self):
        return {
            "id": self.id,
            "text": self.text,
            "time": self.time.isoformat(),
            "checked": self.checked,
            "history": self.history,
            "excluded_from_stats": self.excluded_from_stats,
            "session_id": self.session_id,
        }


class EventManager:
    events: list[EventItem]
    events_dict: dict[str, EventItem] = {}

    def __init__(self):
        self.session_id = str(uuid.uuid4())
        self.events = []
        self.timed_out_ids = set()
        self.events_dict = {}
        self.session_events = []
        self.session_events_dict = {}
        self._lock = threading.RLock()

    def __iter__(self):
        return iter(self.get_session_events())

    def replace_events(self, new_events: list[EventItem]):
        with self._lock:
            self.events = list(new_events)
            self.events_dict = {event.id: event for event in new_events}
            self.session_events = list(new_events)
            self.session_events_dict = dict(self.events_dict)
            self.timed_out_ids.clear()

    def add_gameline(self, line: GameLine):
        new_event = EventItem(
            line,
            line.id,
            line.text,
            line.time,
            False,
            False,
            bool(getattr(line, "excluded_from_stats", False)),
            self.session_id,
        )
        with self._lock:
            self.events_dict[line.id] = new_event
            self.events.append(new_event)
            self.session_events_dict[line.id] = new_event
            self.session_events.append(new_event)
            self.timed_out_ids.discard(line.id)
        return new_event

    def reset_checked_lines(self):
        with self._lock:
            for event in self.session_events:
                event.checked = False

    def get_events(self):
        with self._lock:
            return list(self.events)

    def get_session_events(self):
        """Return every line received during this in-memory GSM session."""
        with self._lock:
            return list(self.session_events)

    def add_event(self, event):
        with self._lock:
            if not event.session_id:
                event.session_id = self.session_id
            self.events.append(event)
            self.events_dict[event.id] = event
            self.session_events.append(event)
            self.session_events_dict[event.id] = event
            self.timed_out_ids.discard(event.id)

    def get(self, event_id):
        with self._lock:
            return self.session_events_dict.get(event_id)

    def get_ordered_ids(self):
        with self._lock:
            return [event.id for event in self.session_events]

    def get_state(self):
        with self._lock:
            return {
                "session_id": self.session_id,
                "ids": [event.id for event in self.events],
                "timed_out_ids": [event.id for event in self.session_events if event.id in self.timed_out_ids],
            }

    def get_session_sync_state(self, known_ids, max_lines: int | None = None) -> dict:
        """Build one ordered, consistent snapshot for a connecting TextFeed."""
        known_id_set = {str(event_id) for event_id in known_ids if event_id}
        with self._lock:
            session_events = self.session_events[-max_lines:] if max_lines else self.session_events
            restored_id_set = {event.id for event in session_events}
            ordered_ids = [event.id for event in session_events]
            active_ids = [event.id for event in self.events if event.id in restored_id_set]
            timed_out_ids = [event.id for event in session_events if event.id in self.timed_out_ids]
            missing_events = [event.to_serializable() for event in session_events if event.id not in known_id_set]

        return {
            "session_id": self.session_id,
            "ordered_ids": ordered_ids,
            "active_ids": active_ids,
            "timed_out_ids": timed_out_ids,
            "missing_events": missing_events,
        }

    def clear_history(self):
        with self._lock:
            self.events = [event for event in self.events if not event.history]
            self.events_dict = {event.id: event for event in self.events}
            self.session_events = [event for event in self.session_events if not event.history]
            self.session_events_dict = {event.id: event for event in self.session_events}
            self.timed_out_ids.intersection_update(self.session_events_dict)

    def remove_lines_by_ids(self, ids: list[str], timed_out: bool = False):
        ids_to_remove = set(ids)
        with self._lock:
            self.events = [event for event in self.events if event.id not in ids_to_remove]
            for event_id in ids_to_remove:
                self.events_dict.pop(event_id, None)

            if timed_out:
                archived_ids = ids_to_remove.intersection(self.session_events_dict)
                self.timed_out_ids.update(archived_ids)
                return

            self.session_events = [event for event in self.session_events if event.id not in ids_to_remove]
            for event_id in ids_to_remove:
                self.session_events_dict.pop(event_id, None)
                self.timed_out_ids.discard(event_id)


# Global instance
event_manager = EventManager()
