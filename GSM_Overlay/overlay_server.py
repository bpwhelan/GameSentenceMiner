#!/usr/bin/env python3
"""
GSM Overlay Server

A Python middleware that handles:
1. Gamepad/controller input at the OS level (works regardless of window focus)
2. Text tokenization using MeCab for word-based navigation

Requires: pip install inputs websockets

Usage:
    python overlay_server.py [--port 55003]
"""

import asyncio
import json
import sys
import os
import time
import threading
from typing import Dict, Set, Optional, Any, List
from dataclasses import dataclass, field
from enum import Enum
import argparse

# Add parent directory to path for MeCab imports
script_dir = os.path.dirname(os.path.abspath(__file__))
gsm_root = os.path.dirname(script_dir)
if gsm_root not in sys.path:
    sys.path.insert(0, gsm_root)

try:
    import inputs
except ImportError:
    print("ERROR: 'inputs' library not found. Install with: pip install inputs")
    print("On Windows, you may also need to run as administrator for some controllers.")
    sys.exit(1)

# Patch inputs GamePad polling to avoid busy spin on Windows.
# This keeps the inputs backend but adds a short sleep when no events are ready.
def _install_inputs_sleep_patch(poll_interval: float = 0.004) -> None:
    if not hasattr(inputs, "GamePad"):
        return
    if getattr(inputs.GamePad, "_gsm_sleep_patch", False):
        return

    def _iter(self):
        while True:
            if inputs.WIN:
                self._GamePad__check_state()
            event = self._do_iter()
            if event:
                yield event
            else:
                time.sleep(poll_interval)

    inputs.GamePad.__iter__ = _iter
    inputs.GamePad._gsm_sleep_patch = True

try:
    import websockets
except ImportError:
    print("ERROR: 'websockets' library not found. Install with: pip install websockets")
    sys.exit(1)

try:
    from websockets.asyncio.server import ServerConnection, serve
    from websockets.exceptions import ConnectionClosed
except Exception:
    # Backward compatibility with older websockets versions.
    from websockets.server import WebSocketServerProtocol as ServerConnection, serve
    ConnectionClosed = websockets.ConnectionClosed

# Try to import MeCab controller
mecab_controller = None
try:
    from GameSentenceMiner.mecab.mecab_controller import MecabController
    mecab_controller = MecabController()
    print("[OverlayServer] MeCab tokenizer initialized successfully")
except ImportError as e:
    print(f"[OverlayServer] MeCab not available: {e}")
    print("[OverlayServer] Tokenization will fall back to character-by-character")
except Exception as e:
    print(f"[OverlayServer] Failed to initialize MeCab: {e}")
    print("[OverlayServer] Tokenization will fall back to character-by-character")


class ButtonCode(Enum):
    """Standard gamepad button mappings (Xbox layout)"""
    A = 0
    B = 1
    X = 2
    Y = 3
    LB = 4
    RB = 5
    LT = 6  # Treated as button when > threshold
    RT = 7  # Treated as button when > threshold
    BACK = 8
    START = 9
    LS = 10  # Left stick click
    RS = 11  # Right stick click
    DPAD_UP = 12
    DPAD_DOWN = 13
    DPAD_LEFT = 14
    DPAD_RIGHT = 15
    GUIDE = 16


# Mapping from inputs library event codes to our standard button codes
BUTTON_MAP = {
    'BTN_SOUTH': ButtonCode.A,      # A / Cross
    'BTN_EAST': ButtonCode.B,       # B / Circle
    'BTN_WEST': ButtonCode.X,       # X / Square  
    'BTN_NORTH': ButtonCode.Y,      # Y / Triangle
    'BTN_TL': ButtonCode.LB,        # Left Bumper
    'BTN_TR': ButtonCode.RB,        # Right Bumper
    'BTN_SELECT': ButtonCode.BACK,  # Back / Select / View
    'BTN_START': ButtonCode.START,  # Start / Menu
    'BTN_THUMBL': ButtonCode.LS,    # Left Stick Click
    'BTN_THUMBR': ButtonCode.RS,    # Right Stick Click
    'BTN_MODE': ButtonCode.GUIDE,   # Xbox / PS button
}

# D-Pad is often reported as hat/axis, not buttons
DPAD_MAP = {
    ('ABS_HAT0Y', -1): ButtonCode.DPAD_UP,
    ('ABS_HAT0Y', 1): ButtonCode.DPAD_DOWN,
    ('ABS_HAT0X', -1): ButtonCode.DPAD_LEFT,
    ('ABS_HAT0X', 1): ButtonCode.DPAD_RIGHT,
}


# Katakana to Hiragana conversion table
KATAKANA_TO_HIRAGANA = {
    'ア': 'あ', 'イ': 'い', 'ウ': 'う', 'エ': 'え', 'オ': 'お',
    'カ': 'か', 'キ': 'き', 'ク': 'く', 'ケ': 'け', 'コ': 'こ',
    'サ': 'さ', 'シ': 'し', 'ス': 'す', 'セ': 'せ', 'ソ': 'そ',
    'タ': 'た', 'チ': 'ち', 'ツ': 'つ', 'テ': 'て', 'ト': 'と',
    'ナ': 'な', 'ニ': 'に', 'ヌ': 'ぬ', 'ネ': 'ね', 'ノ': 'の',
    'ハ': 'は', 'ヒ': 'ひ', 'フ': 'ふ', 'ヘ': 'へ', 'ホ': 'ほ',
    'マ': 'ま', 'ミ': 'み', 'ム': 'む', 'メ': 'め', 'モ': 'も',
    'ヤ': 'や', 'ユ': 'ゆ', 'ヨ': 'よ',
    'ラ': 'ら', 'リ': 'り', 'ル': 'る', 'レ': 'れ', 'ロ': 'ろ',
    'ワ': 'わ', 'ヲ': 'を', 'ン': 'ん',
    'ガ': 'が', 'ギ': 'ぎ', 'グ': 'ぐ', 'ゲ': 'げ', 'ゴ': 'ご',
    'ザ': 'ざ', 'ジ': 'じ', 'ズ': 'ず', 'ゼ': 'ぜ', 'ゾ': 'ぞ',
    'ダ': 'だ', 'ヂ': 'ぢ', 'ヅ': 'づ', 'デ': 'で', 'ド': 'ど',
    'バ': 'ば', 'ビ': 'び', 'ブ': 'ぶ', 'ベ': 'べ', 'ボ': 'ぼ',
    'パ': 'ぱ', 'ピ': 'ぴ', 'プ': 'ぷ', 'ペ': 'ぺ', 'ポ': 'ぽ',
    'ァ': 'ぁ', 'ィ': 'ぃ', 'ゥ': 'ぅ', 'ェ': 'ぇ', 'ォ': 'ぉ',
    'ャ': 'ゃ', 'ュ': 'ゅ', 'ョ': 'ょ', 'ッ': 'っ',
    'ヴ': 'ゔ', 'ー': 'ー',
}


def katakana_to_hiragana(text: str) -> str:
    """Convert katakana to hiragana."""
    return ''.join(KATAKANA_TO_HIRAGANA.get(c, c) for c in text)


def is_kanji(char: str) -> bool:
    """Check if a character is kanji."""
    code = ord(char)
    return (0x4E00 <= code <= 0x9FFF or  # CJK Unified Ideographs
            0x3400 <= code <= 0x4DBF or  # CJK Unified Ideographs Extension A
            0x20000 <= code <= 0x2A6DF)  # CJK Unified Ideographs Extension B


def is_hiragana(char: str) -> bool:
    """Check if a character is hiragana."""
    code = ord(char)
    return 0x3040 <= code <= 0x309F


def is_katakana(char: str) -> bool:
    """Check if a character is katakana."""
    code = ord(char)
    return 0x30A0 <= code <= 0x30FF


def has_kanji(text: str) -> bool:
    """Check if text contains any kanji."""
    return any(is_kanji(c) for c in text)


def _safe_text_preview(text: Any, limit: int = 30) -> str:
    """
    Return an ASCII-safe preview for console logs.
    Prevents UnicodeEncodeError on Windows CP932 consoles.
    """
    preview = str(text or "")[:limit]
    return preview.encode("unicode_escape", errors="backslashreplace").decode("ascii")


def get_furigana(text: str) -> List[Dict[str, Any]]:
    """
    Get furigana readings for text using MeCab.
    
    Returns a list of segments with their readings:
    [
        {"text": "日本語", "reading": "にほんご", "start": 0, "end": 3, "hasReading": true},
        {"text": "の", "reading": null, "start": 3, "end": 4, "hasReading": false},
        ...
    ]
    
    Only kanji-containing words get readings (hiragana/katakana don't need furigana).
    """
    segments = []
    
    if mecab_controller is not None:
        try:
            parsed = mecab_controller.translate(text)
            position = 0
            
            for token in parsed:
                word = token.word if hasattr(token, 'word') else str(token)
                word_len = len(word)
                
                # Skip empty tokens
                if not word:
                    continue
                
                segment = {
                    "text": word,
                    "start": position,
                    "end": position + word_len,
                    "hasReading": False,
                    "reading": None,
                }
                
                # Only add reading if word contains kanji
                if has_kanji(word):
                    reading = None
                    if hasattr(token, 'katakana_reading') and token.katakana_reading:
                        reading = katakana_to_hiragana(token.katakana_reading)
                    
                    # Only show reading if it's different from the word itself
                    if reading and reading != word:
                        segment["hasReading"] = True
                        segment["reading"] = reading
                
                segments.append(segment)
                position += word_len
            
            print(
                f"[OverlayServer] Generated furigana for "
                f"'{_safe_text_preview(text)}...' - {len(segments)} segments"
            )
            return segments
            
        except Exception as e:
            print(f"[OverlayServer] MeCab furigana failed: {e}")
    
    # Fallback: return text as single segment without reading
    print(f"[OverlayServer] Furigana fallback for '{_safe_text_preview(text)}...'")
    return [{
        "text": text,
        "start": 0,
        "end": len(text),
        "hasReading": False,
        "reading": None,
    }]


def tokenize_text(text: str) -> List[Dict[str, Any]]:
    """
    Tokenize Japanese text using MeCab.
    
    Returns a list of tokens with their positions for navigation:
    [
        {"word": "日本語", "start": 0, "end": 3, "reading": "ニホンゴ", "headword": "日本語"},
        {"word": "の", "start": 3, "end": 4, "reading": "ノ", "headword": "の"},
        ...
    ]
    
    Falls back to character-by-character if MeCab is unavailable.
    """
    tokens = []
    
    if mecab_controller is not None:
        try:
            parsed = mecab_controller.translate(text)
            position = 0
            
            for token in parsed:
                word = token.word if hasattr(token, 'word') else str(token)
                word_len = len(word)
                
                # Skip empty tokens
                if not word or word.isspace():
                    position += word_len
                    continue
                
                token_data = {
                    "word": word,
                    "start": position,
                    "end": position + word_len,
                }
                
                # Add optional fields if available
                if hasattr(token, 'katakana_reading') and token.katakana_reading:
                    token_data["reading"] = token.katakana_reading
                if hasattr(token, 'headword') and token.headword:
                    token_data["headword"] = token.headword
                if hasattr(token, 'part_of_speech') and token.part_of_speech:
                    token_data["pos"] = str(token.part_of_speech)
                    
                tokens.append(token_data)
                position += word_len
                
            print(
                f"[OverlayServer] Tokenized "
                f"'{_safe_text_preview(text)}...' into {len(tokens)} tokens"
            )
            return tokens
            
        except Exception as e:
            print(f"[OverlayServer] MeCab tokenization failed: {e}")
            # Fall through to character fallback
    
    # Fallback: each character is its own token
    print(f"[OverlayServer] Using character fallback for '{_safe_text_preview(text)}...'")
    for i, char in enumerate(text):
        if not char.isspace():
            tokens.append({
                "word": char,
                "start": i,
                "end": i + 1,
            })
    
    return tokens


@dataclass
class GamepadState:
    """Current state of a gamepad"""
    device_name: str = ""
    buttons: Dict[int, bool] = field(default_factory=dict)
    axes: Dict[str, float] = field(default_factory=dict)
    last_axis_sent: Dict[str, float] = field(default_factory=dict)
    last_axis_sent_time: Dict[str, float] = field(default_factory=dict)
    connected: bool = True
    last_update: float = field(default_factory=time.time)
    
    def __post_init__(self):
        # Initialize all buttons to False
        for btn in ButtonCode:
            self.buttons[btn.value] = False
        # Initialize axes
        self.axes = {
            'left_x': 0.0,
            'left_y': 0.0,
            'right_x': 0.0,
            'right_y': 0.0,
            'lt': 0.0,
            'rt': 0.0,
        }


class GamepadServer:
    """WebSocket server that broadcasts gamepad events"""
    
    def __init__(self, port: int = 55003):
        self.port = port
        self.clients: Set[ServerConnection] = set()
        self.gamepads: Dict[str, GamepadState] = {}
        self.running = False
        self.input_thread: Optional[threading.Thread] = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        
        # Configuration
        self.deadzone = 0.15
        self.trigger_threshold = 0.5  # When triggers count as "pressed"
        self.axis_scale = 32768.0  # Signed 16-bit axis scale (handles -32768)
        self.axis_epsilon = 0.02  # Minimum change to broadcast axis update
        self.axis_min_interval = 1.0 / 120.0  # Max axis update rate per axis
        self.poll_interval = 0.01  # Gamepad poll sleep when no events (inputs backend)

        _install_inputs_sleep_patch(self.poll_interval)
        
        # D-Pad state tracking (for hat switch handling)
        self.dpad_state = {
            ButtonCode.DPAD_UP: False,
            ButtonCode.DPAD_DOWN: False,
            ButtonCode.DPAD_LEFT: False,
            ButtonCode.DPAD_RIGHT: False,
        }
        
    async def register(self, websocket: ServerConnection):
        """Register a new client connection"""
        self.clients.add(websocket)
        print(f"[GamepadServer] Client connected. Total clients: {len(self.clients)}")
        
        # Send current gamepad state to new client
        for device_name, state in self.gamepads.items():
            await websocket.send(json.dumps({
                'type': 'gamepad_connected',
                'device': device_name,
                'state': {
                    'buttons': state.buttons,
                    'axes': state.axes,
                }
            }))
    
    async def unregister(self, websocket: ServerConnection):
        """Unregister a client connection"""
        self.clients.discard(websocket)
        print(f"[GamepadServer] Client disconnected. Total clients: {len(self.clients)}")
    
    async def broadcast(self, message: dict):
        """Send a message to all connected clients"""
        if not self.clients:
            return
            
        message_str = json.dumps(message)
        
        # Send to all clients, removing any that have disconnected
        disconnected = set()
        for client in self.clients:
            try:
                await client.send(message_str)
            except ConnectionClosed:
                disconnected.add(client)
            except Exception as e:
                print(f"[GamepadServer] Error sending to client: {e}")
                disconnected.add(client)
        
        for client in disconnected:
            self.clients.discard(client)
            
    def normalize_axis(self, value: int) -> float:
        """Normalize axis value to -1.0 to 1.0 range with deadzone"""
        normalized = value / self.axis_scale
        if abs(normalized) < self.deadzone:
            return 0.0
        return max(-1.0, min(1.0, normalized))
    
    def normalize_trigger(self, value: int) -> float:
        """Normalize trigger value to 0.0 to 1.0 range"""
        # Triggers typically go from 0 to 255 or 0 to 1023
        normalized = value / 255.0 if value <= 255 else value / 1023.0
        return max(0.0, min(1.0, normalized))

    def should_send_axis(self, state: GamepadState, axis: str, value: float) -> bool:
        """Rate-limit axis broadcasts to reduce CPU usage and noise."""
        now = time.time()
        last_value = state.last_axis_sent.get(axis)
        last_time = state.last_axis_sent_time.get(axis, 0.0)

        if last_value is not None:
            if abs(value - last_value) < self.axis_epsilon and (now - last_time) < self.axis_min_interval:
                return False

        state.last_axis_sent[axis] = value
        state.last_axis_sent_time[axis] = now
        return True
    
    def process_event(self, event) -> Optional[dict]:
        """Process a single input event and return a message to broadcast"""
        device_name = str(event.device)
        
        # Create gamepad state if new device
        if device_name not in self.gamepads:
            self.gamepads[device_name] = GamepadState(device_name=device_name)
            return {
                'type': 'gamepad_connected',
                'device': device_name,
            }
        
        state = self.gamepads[device_name]
        state.last_update = time.time()
        
        # Handle different event types
        if event.ev_type == 'Key':
            # Button press/release
            button_code = BUTTON_MAP.get(event.code)
            if button_code:
                pressed = event.state == 1
                old_state = state.buttons.get(button_code.value, False)
                
                if pressed != old_state:
                    state.buttons[button_code.value] = pressed
                    return {
                        'type': 'button',
                        'device': device_name,
                        'button': button_code.value,
                        'pressed': pressed,
                        'name': button_code.name,
                    }
        
        elif event.ev_type == 'Absolute':
            # Axis movement (sticks, triggers, d-pad hat)
            code = event.code
            value = event.state
            
            # D-Pad (hat switch)
            if code in ('ABS_HAT0X', 'ABS_HAT0Y'):
                messages = []
                
                # Determine which d-pad buttons changed
                if code == 'ABS_HAT0Y':
                    # Up/Down
                    up_pressed = value == -1
                    down_pressed = value == 1
                    
                    if up_pressed != self.dpad_state[ButtonCode.DPAD_UP]:
                        self.dpad_state[ButtonCode.DPAD_UP] = up_pressed
                        state.buttons[ButtonCode.DPAD_UP.value] = up_pressed
                        messages.append({
                            'type': 'button',
                            'device': device_name,
                            'button': ButtonCode.DPAD_UP.value,
                            'pressed': up_pressed,
                            'name': 'DPAD_UP',
                        })
                    
                    if down_pressed != self.dpad_state[ButtonCode.DPAD_DOWN]:
                        self.dpad_state[ButtonCode.DPAD_DOWN] = down_pressed
                        state.buttons[ButtonCode.DPAD_DOWN.value] = down_pressed
                        messages.append({
                            'type': 'button',
                            'device': device_name,
                            'button': ButtonCode.DPAD_DOWN.value,
                            'pressed': down_pressed,
                            'name': 'DPAD_DOWN',
                        })
                        
                elif code == 'ABS_HAT0X':
                    # Left/Right
                    left_pressed = value == -1
                    right_pressed = value == 1
                    
                    if left_pressed != self.dpad_state[ButtonCode.DPAD_LEFT]:
                        self.dpad_state[ButtonCode.DPAD_LEFT] = left_pressed
                        state.buttons[ButtonCode.DPAD_LEFT.value] = left_pressed
                        messages.append({
                            'type': 'button',
                            'device': device_name,
                            'button': ButtonCode.DPAD_LEFT.value,
                            'pressed': left_pressed,
                            'name': 'DPAD_LEFT',
                        })
                    
                    if right_pressed != self.dpad_state[ButtonCode.DPAD_RIGHT]:
                        self.dpad_state[ButtonCode.DPAD_RIGHT] = right_pressed
                        state.buttons[ButtonCode.DPAD_RIGHT.value] = right_pressed
                        messages.append({
                            'type': 'button',
                            'device': device_name,
                            'button': ButtonCode.DPAD_RIGHT.value,
                            'pressed': right_pressed,
                            'name': 'DPAD_RIGHT',
                        })
                
                return messages if messages else None
            
            # Left stick
            elif code == 'ABS_X':
                state.axes['left_x'] = self.normalize_axis(value)
                if self.should_send_axis(state, 'left_x', state.axes['left_x']):
                    return {
                        'type': 'axis',
                        'device': device_name,
                        'axis': 'left_x',
                        'value': state.axes['left_x'],
                    }
            elif code == 'ABS_Y':
                state.axes['left_y'] = self.normalize_axis(value)
                if self.should_send_axis(state, 'left_y', state.axes['left_y']):
                    return {
                        'type': 'axis',
                        'device': device_name,
                        'axis': 'left_y',
                        'value': state.axes['left_y'],
                    }
            
            # Right stick
            elif code == 'ABS_RX':
                state.axes['right_x'] = self.normalize_axis(value)
                if self.should_send_axis(state, 'right_x', state.axes['right_x']):
                    return {
                        'type': 'axis',
                        'device': device_name,
                        'axis': 'right_x',
                        'value': state.axes['right_x'],
                    }
            elif code == 'ABS_RY':
                state.axes['right_y'] = self.normalize_axis(value)
                if self.should_send_axis(state, 'right_y', state.axes['right_y']):
                    return {
                        'type': 'axis',
                        'device': device_name,
                        'axis': 'right_y',
                        'value': state.axes['right_y'],
                    }
            
            # Triggers
            elif code == 'ABS_Z':
                state.axes['lt'] = self.normalize_trigger(value)
                # Also treat as button if above threshold
                lt_pressed = state.axes['lt'] > self.trigger_threshold
                if lt_pressed != state.buttons.get(ButtonCode.LT.value, False):
                    state.buttons[ButtonCode.LT.value] = lt_pressed
                    return {
                        'type': 'button',
                        'device': device_name,
                        'button': ButtonCode.LT.value,
                        'pressed': lt_pressed,
                        'name': 'LT',
                        'value': state.axes['lt'],
                    }
            elif code == 'ABS_RZ':
                state.axes['rt'] = self.normalize_trigger(value)
                rt_pressed = state.axes['rt'] > self.trigger_threshold
                if rt_pressed != state.buttons.get(ButtonCode.RT.value, False):
                    state.buttons[ButtonCode.RT.value] = rt_pressed
                    return {
                        'type': 'button',
                        'device': device_name,
                        'button': ButtonCode.RT.value,
                        'pressed': rt_pressed,
                        'name': 'RT',
                        'value': state.axes['rt'],
                    }
        
        return None
    
    def input_loop(self):
        """Background thread that reads gamepad input"""
        print("[GamepadServer] Input loop started")
        
        while self.running:
            try:
                # Get events from all gamepads
                events = inputs.get_gamepad()
                
                if not events:
                    print("[GamepadServer] No events received, retrying...")
                    time.sleep(5.0)
                    continue

                for event in events:
                    if not self.running:
                        break
                    
                    # Skip sync events
                    if event.ev_type == 'Sync':
                        continue
                    
                    # Process the event
                    messages = self.process_event(event)
                    
                    if messages:
                        # Handle single message or list of messages
                        if isinstance(messages, list):
                            for msg in messages:
                                if self.loop:
                                    asyncio.run_coroutine_threadsafe(
                                        self.broadcast(msg), 
                                        self.loop
                                    )
                        else:
                            if self.loop:
                                asyncio.run_coroutine_threadsafe(
                                    self.broadcast(messages), 
                                    self.loop
                                )
                                
            except inputs.UnpluggedError:
                # No gamepad connected, wait and retry
                print("[GamepadServer] No gamepad connected. Please connect a controller.")
                time.sleep(5.0)
                
            except Exception as e:
                print(f"[GamepadServer] Input error: {e}")
                time.sleep(5.0)
        
        print("[GamepadServer] Input loop stopped")
    
    async def handler(self, websocket: ServerConnection):
        """Handle a WebSocket connection"""
        await self.register(websocket)
        try:
            async for message in websocket:
                # Handle incoming messages from clients (e.g., configuration)
                try:
                    data = json.loads(message)
                    msg_type = data.get('type')
                    
                    if msg_type == 'ping':
                        await websocket.send(json.dumps({'type': 'pong'}))
                        
                    elif msg_type == 'get_state':
                        # Send current state of all gamepads
                        for device_name, state in self.gamepads.items():
                            await websocket.send(json.dumps({
                                'type': 'gamepad_state',
                                'device': device_name,
                                'buttons': state.buttons,
                                'axes': state.axes,
                            }))
                            
                    elif msg_type == 'tokenize':
                        # Tokenize text using MeCab
                        text = data.get('text', '')
                        block_index = data.get('blockIndex', 0)
                        
                        if text:
                            tokens = tokenize_text(text)
                            await websocket.send(json.dumps({
                                'type': 'tokens',
                                'blockIndex': block_index,
                                'text': text,
                                'tokens': tokens,
                                'mecabAvailable': mecab_controller is not None,
                            }))
                        else:
                            await websocket.send(json.dumps({
                                'type': 'tokens',
                                'blockIndex': block_index,
                                'text': '',
                                'tokens': [],
                                'mecabAvailable': mecab_controller is not None,
                            }))
                    
                    elif msg_type == 'get_furigana':
                        # Get furigana readings for text
                        text = data.get('text', '')
                        line_index = data.get('lineIndex', 0)
                        request_id = data.get('requestId')
                        
                        if text:
                            try:
                                segments = get_furigana(text)
                            except Exception as furigana_error:
                                print(
                                    "[GamepadServer] Furigana generation failed "
                                    f"for '{_safe_text_preview(text)}...': "
                                    f"{_safe_text_preview(furigana_error, limit=120)}"
                                )
                                segments = [{
                                    "text": text,
                                    "start": 0,
                                    "end": len(text),
                                    "hasReading": False,
                                    "reading": None,
                                }]
                            response = {
                                'type': 'furigana',
                                'lineIndex': line_index,
                                'text': text,
                                'segments': segments,
                                'mecabAvailable': mecab_controller is not None,
                            }
                            if request_id is not None:
                                response['requestId'] = request_id
                            await websocket.send(json.dumps(response))
                        else:
                            response = {
                                'type': 'furigana',
                                'lineIndex': line_index,
                                'text': '',
                                'segments': [],
                                'mecabAvailable': mecab_controller is not None,
                            }
                            if request_id is not None:
                                response['requestId'] = request_id
                            await websocket.send(json.dumps(response))
                            
                except json.JSONDecodeError:
                    pass
                except Exception as message_error:
                    print(
                        "[GamepadServer] Message handler error: "
                        f"{_safe_text_preview(message_error, limit=120)}"
                    )
        except ConnectionClosed:
            pass
        finally:
            await self.unregister(websocket)
    
    async def start(self):
        """Start the WebSocket server and input processing"""
        self.running = True
        self.loop = asyncio.get_event_loop()
        
        # Start input thread
        self.input_thread = threading.Thread(target=self.input_loop, daemon=True)
        self.input_thread.start()
        
        # Start WebSocket server
        print(f"[GamepadServer] Starting WebSocket server on port {self.port}")
        async with serve(self.handler, "localhost", self.port):
            print(f"[GamepadServer] Server running at ws://localhost:{self.port}")
            print("[GamepadServer] Waiting for gamepad input... (connect a controller)")
            await asyncio.Future()  # Run forever
    
    def stop(self):
        """Stop the server"""
        self.running = False
        if self.input_thread:
            self.input_thread.join(timeout=2.0)


def main():
    parser = argparse.ArgumentParser(description='GSM Overlay Gamepad Server')
    parser.add_argument('--port', type=int, default=55003, help='WebSocket server port')
    args = parser.parse_args()
    
    server = GamepadServer(port=args.port)
    
    try:
        asyncio.run(server.start())
    except KeyboardInterrupt:
        print("\n[GamepadServer] Shutting down...")
        server.stop()


if __name__ == '__main__':
    main()
