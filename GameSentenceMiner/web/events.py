import datetime
from dataclasses import dataclass

from GameSentenceMiner.util.text_log import GameLine


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
    ids: set[str] = set()
    events: list[EventItem]
    events_dict: dict[str, EventItem] = {}

    def __init__(self):
        self.events = []
        self.ids = set()
        self.timed_out_ids = set()
        self.events_dict = {}

    def __iter__(self):
        return iter(self.events)

    def replace_events(self, new_events: list[EventItem]):
        self.events = new_events
        self.events_dict = {event.id: event for event in new_events}
        self.ids = {event.id for event in new_events}

    def add_gameline(self, line: GameLine):
        new_event = EventItem(line, line.id, line.text,
                              line.time, False, False)
        self.events_dict[line.id] = new_event
        self.ids.add(line.id)
        self.events.append(new_event)
        return new_event

    def reset_checked_lines(self):
        for event in self.events:
            event.checked = False

    def get_events(self):
        return self.events

    def add_event(self, event):
        self.events.append(event)
        self.ids.add(event.id)

    def get(self, event_id):
        return self.events_dict.get(event_id)

    def get_ids(self):
        return self.ids

    def clear_history(self):
        # Clear the in-memory events
        self.events = [
            event for event in self.events if not event.history]
        self.events_dict = {
            event.id: event for event in self.events}
        self.ids = {event.id for event in self.events}

    def remove_lines_by_ids(self, ids: list[str], timed_out: bool = False):
        ids_to_remove = set(ids)
        
        self.events = [event for event in self.events if event.id not in ids_to_remove]
        
        for event_id in ids_to_remove:
            self.events_dict.pop(event_id, None)
        
        # Remove from set (much more efficient than rebuilding)
        self.ids -= ids_to_remove
        if timed_out:
            self.timed_out_ids.update(ids_to_remove)


# Global instance
event_manager = EventManager()