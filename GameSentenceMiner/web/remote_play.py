from __future__ import annotations

import hmac
import json
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Protocol
from urllib.parse import urlsplit

from GameSentenceMiner.util.config.configuration import logger

REMOTE_PLAY_STUN_URLS = [
    "stun:stun.cloudflare.com:3478",
    "stun:stun.l.google.com:19302",
]


@dataclass(frozen=True)
class NormalizedPointer:
    x: float
    y: float
    inside_video: bool


def map_letterboxed_pointer(
    pointer_x: float,
    pointer_y: float,
    display_width: float,
    display_height: float,
    source_width: float,
    source_height: float,
) -> NormalizedPointer:
    if min(display_width, display_height, source_width, source_height) <= 0:
        raise ValueError("Display and source dimensions must be greater than zero.")

    scale = min(display_width / source_width, display_height / source_height)
    video_width = source_width * scale
    video_height = source_height * scale
    offset_x = (display_width - video_width) / 2
    offset_y = (display_height - video_height) / 2
    normalized_x = (pointer_x - offset_x) / video_width
    normalized_y = (pointer_y - offset_y) / video_height
    inside_video = 0 <= normalized_x <= 1 and 0 <= normalized_y <= 1
    return NormalizedPointer(
        x=max(0.0, min(1.0, normalized_x)),
        y=max(0.0, min(1.0, normalized_y)),
        inside_video=inside_video,
    )


class RemotePlayAccess:
    def __init__(self, token_ttl_seconds: float = 15 * 60):
        self._token_ttl_seconds = token_ttl_seconds
        self._token: str | None = None
        self._expires_at = 0.0
        self._lock = threading.Lock()

    def issue_token(self) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._token = token
            self._expires_at = time.monotonic() + self._token_ttl_seconds
        return token

    def validate(self, candidate: str | None) -> bool:
        with self._lock:
            token = self._token
            expires_at = self._expires_at
        return bool(token and candidate and time.monotonic() <= expires_at and hmac.compare_digest(token, candidate))


class InputBackend(Protocol):
    @property
    def available(self) -> bool: ...

    def prepare(self) -> bool: ...

    def dispatch(self, event_type: str, payload: dict) -> bool: ...

    def release_all(self) -> None: ...


class RemoteInputGate:
    def __init__(self, backend: InputBackend):
        self._backend = backend
        self.enabled = False

    def set_enabled(self, enabled: bool) -> bool:
        if enabled and not self.enabled:
            prepare = getattr(self._backend, "prepare", None)
            if prepare is not None and not prepare():
                return False
        if not enabled and self.enabled:
            self._backend.release_all()
        self.enabled = enabled
        return self.enabled == enabled

    def handle(self, event_type: str, payload: dict) -> bool:
        if event_type == "key_down" and payload.get("code") == "Escape":
            self.stop("escape")
            return False
        if not self.enabled:
            return False
        return self._backend.dispatch(event_type, payload)

    def stop(self, _reason: str) -> None:
        was_enabled = self.enabled
        self.enabled = False
        if was_enabled:
            self._backend.release_all()


def is_remote_play_origin_allowed(origin: str | None, forwarded_host: str | None) -> bool:
    if not origin or not forwarded_host:
        return False
    parsed = urlsplit(origin)
    return parsed.scheme in {"http", "https"} and parsed.netloc.casefold() == forwarded_host.casefold()


class ObsVirtualCameraSession:
    def __init__(self):
        self.player = None
        self.track = None
        self._started_virtual_camera = False

    async def start(self):
        import asyncio

        from aiortc.contrib.media import MediaPlayer
        from GameSentenceMiner import obs

        service = obs.obs_service
        if service is None or service.connection_pool is None:
            raise RuntimeError("OBS is not connected.")

        status = await asyncio.to_thread(
            service.connection_pool.call,
            lambda client: client.get_virtual_cam_status(),
            1,
        )
        if not bool(getattr(status, "output_active", False)):
            await asyncio.to_thread(
                service.connection_pool.call,
                lambda client: client.start_virtual_cam(),
                1,
            )
            self._started_virtual_camera = True
            await asyncio.sleep(0.35)

        last_error = None
        for _attempt in range(3):
            try:
                self.player = await asyncio.to_thread(
                    MediaPlayer,
                    "video=OBS Virtual Camera",
                    format="dshow",
                    options={"framerate": "30", "rtbufsize": "100M"},
                )
                self.track = self.player.video
                if self.track is None:
                    raise RuntimeError("OBS Virtual Camera did not expose a video track.")
                return self.track
            except Exception as error:
                last_error = error
                await asyncio.sleep(0.25)
        await self.stop()
        raise RuntimeError(f"Could not open OBS Virtual Camera: {last_error}") from last_error

    async def stop(self) -> None:
        import asyncio

        from GameSentenceMiner import obs

        if self.track is not None:
            self.track.stop()
        self.track = None
        self.player = None
        if self._started_virtual_camera:
            service = obs.obs_service
            if service is not None and service.connection_pool is not None:
                try:
                    await asyncio.to_thread(
                        service.connection_pool.call,
                        lambda client: client.stop_virtual_cam(),
                        1,
                    )
                except Exception as error:
                    logger.debug(f"Could not stop the remote-play OBS Virtual Camera: {error}")
        self._started_virtual_camera = False


class RemotePlaySessionManager:
    _INPUT_EVENTS = {"pointer_move", "pointer_button", "wheel", "key_down", "key_up"}

    def __init__(
        self,
        access: RemotePlayAccess | None = None,
        input_backend_factory: Callable[[], InputBackend] | None = None,
        media_factory: Callable[[], ObsVirtualCameraSession] = ObsVirtualCameraSession,
        peer_factory: Callable[[], Any] | None = None,
    ):
        self.access = access or RemotePlayAccess()
        self._input_backend_factory = input_backend_factory or self._default_input_backend_factory
        self._media_factory = media_factory
        self._peer_factory = peer_factory
        self._active_websocket = None
        self._send_lock = None
        self._loop = None
        self._input_gate: RemoteInputGate | None = None
        self._peer = None
        self._media = None

    def has_client(self) -> bool:
        return self._active_websocket is not None

    async def handle_connection(self, websocket) -> None:
        import asyncio

        headers = getattr(getattr(websocket, "request", None), "headers", {})
        origin = headers.get("Origin")
        forwarded_host = headers.get("X-GSM-Forwarded-Host") or headers.get("Host")
        if not is_remote_play_origin_allowed(origin, forwarded_host):
            await websocket.close(code=1008, reason="Origin not allowed")
            return

        try:
            raw_auth = await asyncio.wait_for(websocket.recv(), timeout=5)
            auth = json.loads(raw_auth)
        except (asyncio.TimeoutError, TypeError, json.JSONDecodeError):
            await websocket.close(code=1008, reason="Authentication required")
            return
        if (
            not isinstance(auth, dict)
            or auth.get("type") != "authenticate"
            or not self.access.validate(auth.get("token"))
        ):
            await websocket.close(code=1008, reason="Authentication failed")
            return
        if self._active_websocket is not None:
            await websocket.close(code=1013, reason="Remote play already has an active client")
            return

        self._active_websocket = websocket
        self._loop = asyncio.get_running_loop()
        self._send_lock = asyncio.Lock()
        backend = self._input_backend_factory()
        self._input_gate = RemoteInputGate(backend)
        await self._send_json(
            websocket,
            {
                "type": "authenticated",
                "input_available": bool(getattr(backend, "available", False)),
            },
        )

        try:
            async for raw_message in websocket:
                await self._handle_message(websocket, raw_message)
        except Exception as error:
            if not self._is_expected_disconnect(error):
                logger.warning(f"Remote play session ended unexpectedly: {error}")
        finally:
            await self._cleanup(websocket)

    async def _handle_message(self, websocket, raw_message: str) -> None:
        import asyncio

        try:
            message = json.loads(raw_message)
        except (TypeError, json.JSONDecodeError):
            await self._send_json(websocket, {"type": "error", "message": "Invalid remote-play message."})
            return
        if not isinstance(message, dict):
            return

        message_type = message.get("type")
        if message_type == "offer":
            await self._accept_offer(websocket, message)
            return
        if message_type == "input_enabled":
            enabled = bool(message.get("enabled"))
            peer_connected = self._peer is not None and self._peer.connectionState == "connected"
            accepted = not enabled or peer_connected
            if accepted:
                accepted = await asyncio.to_thread(self._input_gate.set_enabled, enabled)
            await self._send_json(
                websocket,
                {"type": "input_state", "enabled": self._input_gate.enabled, "accepted": accepted},
            )
            return
        if message_type == "stop_input":
            await asyncio.to_thread(self._input_gate.stop, str(message.get("reason", "client")))
            await self._send_json(websocket, {"type": "input_state", "enabled": False, "accepted": True})
            return
        if message_type in self._INPUT_EVENTS:
            await asyncio.to_thread(self._input_gate.handle, message_type, message)

    async def _accept_offer(self, websocket, message: dict) -> None:
        from aiortc import RTCSessionDescription

        await self._close_peer_and_media()
        await self._send_json(websocket, {"type": "stream_state", "state": "connecting"})
        try:
            media = self._media_factory()
            track = await media.start()
            peer = self._peer_factory() if self._peer_factory else self._create_peer()
            self._media = media
            self._peer = peer

            @peer.on("connectionstatechange")
            async def on_connectionstatechange():
                state = peer.connectionState
                await self._send_json(websocket, {"type": "stream_state", "state": state})
                if state in {"disconnected", "failed", "closed"} and self._input_gate is not None:
                    self._input_gate.stop(f"peer-{state}")

            peer.addTrack(track)
            await peer.setRemoteDescription(RTCSessionDescription(sdp=message["sdp"], type="offer"))
            answer = await peer.createAnswer()
            await peer.setLocalDescription(answer)
            await self._send_json(
                websocket,
                {"type": "answer", "sdp": peer.localDescription.sdp},
            )
        except Exception as error:
            await self._close_peer_and_media()
            logger.warning(f"Remote play could not start the OBS stream: {error}")
            await self._send_json(
                websocket,
                {"type": "error", "message": "Could not start the OBS Virtual Camera stream."},
            )

    @staticmethod
    def _create_peer():
        from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection

        return RTCPeerConnection(
            RTCConfiguration(
                iceServers=[RTCIceServer(urls=REMOTE_PLAY_STUN_URLS)],
            )
        )

    async def _close_peer_and_media(self) -> None:
        peer, self._peer = self._peer, None
        media, self._media = self._media, None
        if peer is not None:
            await peer.close()
        if media is not None:
            await media.stop()

    async def _cleanup(self, websocket) -> None:
        if websocket is not self._active_websocket:
            return
        if self._input_gate is not None:
            self._input_gate.stop("disconnect")
        await self._close_peer_and_media()
        self._input_gate = None
        self._active_websocket = None
        self._send_lock = None
        self._loop = None

    async def _send_json(self, websocket, payload: dict) -> None:
        if websocket is None:
            return
        encoded = json.dumps(payload, separators=(",", ":"))
        lock = self._send_lock
        if lock is None:
            await websocket.send(encoded)
            return
        async with lock:
            await websocket.send(encoded)

    def send_overlay_payload_nowait(self, payload: dict):
        import asyncio

        if self._loop is None or self._active_websocket is None:
            return None
        return asyncio.run_coroutine_threadsafe(
            self._send_json(self._active_websocket, {"type": "overlay", "payload": payload}),
            self._loop,
        )

    @staticmethod
    def _default_input_backend_factory():
        from GameSentenceMiner.util.platform.remote_input import create_remote_input_backend

        return create_remote_input_backend()

    @staticmethod
    def _is_expected_disconnect(error: Exception) -> bool:
        return error.__class__.__name__.startswith("ConnectionClosed") or isinstance(
            error,
            (ConnectionError, EOFError, OSError),
        )


remote_play_manager = RemotePlaySessionManager()
