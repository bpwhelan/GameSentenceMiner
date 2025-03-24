import os.path
from dataclasses import dataclass, field
from typing import Dict, Optional, Any

from dataclasses_json import dataclass_json, Undefined
from websocket import WebSocket

from GameSentenceMiner.configuration import get_app_directory

CONFIG_FILE = os.path.join(get_app_directory(), "shared_config.json")
websocket: WebSocket = None

@dataclass_json(undefined=Undefined.RAISE)
@dataclass
class Message:
    """
    Represents a message for inter-process communication.
    Mimics the structure of IPC or HTTP calls.
    """
    function: str
    data: Dict[str, Any] = field(default_factory=dict)
    id: Optional[str] = None
