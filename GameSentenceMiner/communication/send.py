import json

from GameSentenceMiner.communication.websocket import websocket, Message

def send_restart_signal():
    if websocket and websocket.connected:
        websocket.send(json.dumps(Message(function="restart").to_json()))