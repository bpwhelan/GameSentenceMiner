import asyncio
from fractions import Fraction
from types import SimpleNamespace

import pytest
from av import VideoFrame


def test_quality_encoder_exceeds_old_cap_and_still_adapts():
    from GameSentenceMiner.web.remote_play_media import RemoteVideoEncoder

    encoder = RemoteVideoEncoder(8_000_000)
    frame = VideoFrame(1280, 720, "yuv420p")
    frame.pts = 0
    frame.time_base = Fraction(1, 30)
    assert encoder.encode(frame)[0]
    assert encoder.codec.bit_rate == 8_000_000
    encoder.target_bitrate = 900_000
    assert encoder.target_bitrate == 900_000
    encoder.target_bitrate = 50_000_000
    assert encoder.target_bitrate == 8_000_000


def test_audio_frames_preserve_stereo_timing_and_bound_backlog():
    from GameSentenceMiner.web.remote_play_media import GameAudioTrack

    async def run():
        track = GameAudioTrack()
        for index in range(20):
            track.push_pcm(bytes([index]) * 3840, index * 960)
        assert track._frames.qsize() <= 5
        frame = await track.recv()
        assert frame.sample_rate == 48000
        assert frame.layout.name == "stereo"
        assert frame.samples == 960
        assert frame.pts >= 15 * 960
        assert frame.time_base == Fraction(1, 48000)
        track.stop()
        from aiortc.mediastreams import MediaStreamError

        with pytest.raises(MediaStreamError):
            await track.recv()

    asyncio.run(run())


def test_failed_media_start_is_cleaned_up():
    from GameSentenceMiner.web.remote_play import RemotePlaySessionManager

    class Media:
        stopped = False

        async def start(self):
            raise RuntimeError("capture failed")

        async def stop(self):
            self.stopped = True

    media = Media()
    manager = RemotePlaySessionManager(media_factory=lambda: media)
    sent = []

    async def send(message):
        sent.append(message)

    asyncio.run(manager._accept_offer(SimpleNamespace(send=send), {"sdp": "bad"}))
    assert media.stopped
    assert sent


def test_real_peer_receives_both_media_tracks():
    """Exercise SDP, the private encoder seam, RTP and decoded A/V locally."""
    import json

    from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription, VideoStreamTrack

    from GameSentenceMiner.web.remote_play import RemotePlaySessionManager

    async def run():
        class Media:
            audio_error = ""

            def __init__(self):
                self.video = VideoStreamTrack()
                self.audio_track = AudioStreamTrack()

            async def start(self):
                return self.video

            async def stop(self):
                self.video.stop()
                self.audio_track.stop()

        client = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        manager = RemotePlaySessionManager(
            media_factory=Media, peer_factory=lambda: RTCPeerConnection(RTCConfiguration(iceServers=[]))
        )
        received = {}
        messages = []

        @client.on("track")
        def on_track(track):
            received[track.kind] = track

        async def send(encoded):
            messages.append(json.loads(encoded))

        try:
            client.addTransceiver("video", direction="recvonly")
            client.addTransceiver("audio", direction="recvonly")
            await client.setLocalDescription(await client.createOffer())
            await manager._accept_offer(
                SimpleNamespace(send=send),
                {
                    "sdp": client.localDescription.sdp,
                    "quality": "ultra",
                },
            )
            answer = next(message for message in messages if message["type"] == "answer")
            assert "VP8/90000" in answer["sdp"]
            assert any(message.get("available") is True for message in messages)
            await client.setRemoteDescription(RTCSessionDescription(answer["sdp"], "answer"))
            frames = await asyncio.wait_for(asyncio.gather(received["video"].recv(), received["audio"].recv()), 10)
            assert frames[0].width == 640
            assert frames[1].sample_rate == 48000
            sender = next(s for s in manager._peer.getSenders() if s.track.kind == "video")
            assert sender._RTCRtpSender__encoder.max_bitrate == 16_000_000
        finally:
            await manager._close_peer_and_media()
            await client.close()

    asyncio.run(run())


def test_audio_stops_when_selected_game_changes():
    from aiortc.mediastreams import MediaStreamError

    from GameSentenceMiner.web.remote_play_media import GameAudioTrack

    async def run():
        track = GameAudioTrack()
        track._target_pid = 100
        track._target_getter = lambda: SimpleNamespace(pid=200)
        track.push_pcm(bytes(3840), 0)
        with pytest.raises(MediaStreamError):
            await track.recv()
        assert track.readyState == "ended"

    asyncio.run(run())
