"""Windows game audio and per-session WebRTC video encoding.

Imported only when starting remote media, so aiortc remains lazy at GSM startup.
"""

import asyncio
import contextlib
import json
import queue
import subprocess
import threading
from fractions import Fraction

from aiortc import AudioStreamTrack, RTCRtpSender
from aiortc.codecs.vpx import Vp8Encoder
from aiortc.mediastreams import MediaStreamError
from av import AudioFrame

QUALITY_BITRATES = {"balanced": 4_000_000, "high": 8_000_000, "ultra": 16_000_000}


class RemoteVideoEncoder(Vp8Encoder):
    """Allow game-quality bitrates without overriding other aiortc sessions."""

    def __init__(self, max_bitrate: int):
        super().__init__()
        self.max_bitrate = max_bitrate
        self.target_bitrate = max_bitrate

    @property
    def target_bitrate(self):
        return self._Vp8Encoder__target_bitrate

    @target_bitrate.setter
    def target_bitrate(self, value):
        # Keep REMB congestion feedback effective on slower links. aiortc 1.14
        # also reads this private field for the libvpx buffer size.
        self._Vp8Encoder__target_bitrate = max(250_000, min(int(value), self.max_bitrate))


def configure_video_sender(peer, sender, quality):
    codecs = [codec for codec in RTCRtpSender.getCapabilities("video").codecs if codec.mimeType == "video/VP8"]
    transceiver = next(item for item in peer.getTransceivers() if item.sender is sender)
    transceiver.setCodecPreferences(codecs)
    # aiortc 1.14 has no public encoder factory / setParameters API. Keep the
    # compatibility seam here and exercise actual encoding in regression tests.
    if not hasattr(sender, "_RTCRtpSender__encoder"):
        raise RuntimeError("This aiortc version does not support remote-play quality settings.")
    sender._RTCRtpSender__encoder = RemoteVideoEncoder(QUALITY_BITRATES.get(quality, QUALITY_BITRATES["high"]))


class GameAudioTrack(AudioStreamTrack):
    """48 kHz stereo process-loopback PCM with at most 100 ms queued audio."""

    def __init__(self):
        super().__init__()
        self._frames = queue.Queue(maxsize=5)
        self._process = None
        self._threads = []
        self._finished = threading.Event()
        self._ready = threading.Event()
        self.error = ""
        self._target_pid = None
        self._target_getter = None
        self._last_target_check = 0.0

    def start_capture(self, helper, pid):
        self._process = subprocess.Popen(
            [str(helper), "--root-pid", str(pid), "--sample-rate", "48000", "--channels", "2"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        for target in (self._read_pcm, self._read_status):
            thread = threading.Thread(target=target, daemon=True, name="remote-play-audio")
            self._threads.append(thread)
            thread.start()
        if not self._ready.wait(5) or self.error or self._process.poll() is not None:
            self.stop()
            raise RuntimeError(self.error or "Game audio capture did not become ready.")

    def _read_status(self):
        try:
            for line in self._process.stderr:
                try:
                    event = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if event.get("code") == "audio_ready":
                    self._ready.set()
                elif event.get("level") == "error":
                    self.error = event.get("message", "Game audio capture failed.")
                    self._ready.set()
        finally:
            self._ready.set()

    def _read_pcm(self):
        pts = 0
        pending = bytearray()
        try:
            while not self._finished.is_set():
                chunk = self._process.stdout.read(3840 - len(pending))
                if not chunk:
                    break
                pending.extend(chunk)
                if len(pending) == 3840:
                    self.push_pcm(bytes(pending), pts)
                    pts += 960
                    pending.clear()
        finally:
            self._finished.set()

    def push_pcm(self, data, pts):
        if self._frames.full():
            try:
                self._frames.get_nowait()
            except queue.Empty:
                pass
        self._frames.put_nowait((data, pts))

    async def recv(self):
        while self.readyState == "live":
            now = asyncio.get_running_loop().time()
            if self._target_getter is not None and now - self._last_target_check >= 1:
                self._last_target_check = now
                target = await asyncio.to_thread(self._target_getter)
                if target is None or target.pid != self._target_pid:
                    self.stop()
                    break
            try:
                data, pts = self._frames.get_nowait()
            except queue.Empty:
                if self._finished.is_set():
                    self.stop()
                    break
                await asyncio.sleep(0.005)
                continue
            frame = AudioFrame(format="s16", layout="stereo", samples=960)
            frame.planes[0].update(data)
            frame.sample_rate = 48000
            frame.time_base = Fraction(1, 48000)
            frame.pts = pts
            return frame
        raise MediaStreamError

    def stop(self):
        super().stop()
        self._finished.set()
        process = self._process
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)
            for thread in self._threads:
                thread.join(timeout=1)
            process.stdout.close()
            process.stderr.close()
            self._process = None


async def open_game_audio():
    from GameSentenceMiner.windows_speech_recognition import get_target_window, resolve_native_helper

    helper = resolve_native_helper("audio")
    if helper is None:
        raise RuntimeError("Game audio helper is missing. Install a build with Windows helpers, or build them locally.")
    target = await asyncio.to_thread(get_target_window)
    if target is None:
        raise RuntimeError("Select a game capture window in OBS, then reconnect to enable game audio.")
    track = GameAudioTrack()
    track._target_pid = target.pid
    track._target_getter = get_target_window
    startup = asyncio.create_task(asyncio.to_thread(track.start_capture, helper, target.pid))
    try:
        await asyncio.shield(startup)
    except asyncio.CancelledError:
        # to_thread cannot cancel Popen startup. Wait for its bounded readiness
        # check before disposing it so a late helper cannot escape cleanup.
        with contextlib.suppress(Exception):
            await startup
        track.stop()
        raise
    except BaseException:
        track.stop()
        raise
    return track
