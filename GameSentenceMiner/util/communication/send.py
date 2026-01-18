# import json

# from GameSentenceMiner.util.communication.electron_ipc import websocket, Message

# async def send_restart_signal():
#     if websocket:
#         await websocket.send(json.dumps(Message(function="restart").to_json()))
        
        
# async def send_notification_signal(title: str, message: str, timeout: int):
#     if websocket:
#         await websocket.send(json.dumps(Message(
#             function="notification",
#             data={
#                 "title": title,
#                 "message": message,
#                 "timeout": timeout
#             }
#         ).to_json()))