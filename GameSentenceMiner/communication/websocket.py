import asyncio
import os.path

import websockets
import json
from enum import Enum

from websocket import WebSocket

from GameSentenceMiner.communication import Message
from GameSentenceMiner.configuration import get_app_directory, logger

CONFIG_FILE = os.path.join(get_app_directory(), "shared_config.json")
websocket: WebSocket = None
handle_websocket_message = None


class FunctionName(Enum):
    QUIT = "quit"
    START = "start"
    STOP = "stop"
    QUIT_OBS = "quit_obs"
    START_OBS = "start_obs"

async def do_websocket_connection(port):
    """
    Connects to the WebSocket server running in the Electron app.
    """
    global websocket

    uri = f"ws://localhost:{port}"  # Use the port from Electron
    logger.debug(f"Electron Communication : Connecting to server at {uri}...")
    try:
        async with websockets.connect(uri) as websocket:
            logger.debug(f"Connected to websocket server at {uri}")

            # Send an initial message
            message = Message(function="on_connect", data={"message": "Hello from Python!"})
            await websocket.send(message.to_json())
            logger.debug(f"> Sent: {message}")

            # Receive messages from the server
            while True:
                try:
                    response = await websocket.recv()
                    if response is None:
                        break
                    logger.debug(f"Electron Communication : < Received: {response}")
                    handle_websocket_message(Message.from_json(response))
                    await asyncio.sleep(1)  # keep the connection alive
                except websockets.ConnectionClosedOK:
                    logger.debug("Electron Communication : Connection closed by server")
                    break
                except websockets.ConnectionClosedError as e:
                    logger.debug(f"Electron Communication : Connection closed with error: {e}")
                    break
    except ConnectionRefusedError:
        logger.debug(f"Electron Communication : Error: Could not connect to server at {uri}.  Electron App not running..")
    except Exception as e:
        logger.debug(f"Electron Communication : An error occurred: {e}")

def connect_websocket():
    """
    Main function to run the WebSocket client.
    """
    # Load the port from the same config.json the Electron app uses
    try:
        with open(CONFIG_FILE, "r") as f:
            config = json.load(f)
            port = config["port"]
    except FileNotFoundError:
        print("Error: shared_config.json not found.  Using default port 8766.  Ensure Electron app creates this file.")
        port = 8766  # Default port, same as in Electron
    except json.JSONDecodeError:
        print("Error: shared_config.json was not valid JSON.  Using default port 8765.")
        port = 8766

    asyncio.run(do_websocket_connection(port))

def register_websocket_message_handler(handler):
    global handle_websocket_message
    handle_websocket_message = handler


if __name__ == "__main__":
    connect_websocket()
