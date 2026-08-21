import json

from GameSentenceMiner import hoshidicts_audio, hoshidicts_audio_profile
from tests.test_hoshidicts_factories import FakeResponse, make_audio_source, opus_bytes

HoshidictsAudioError = hoshidicts_audio_profile.HoshidictsAudioError


def generic_profile(*sources, **legacy):
    return {
        "version": 1,
        "autoPlay": False,
        "sources": list(sources),
        **legacy,
    }


def respond(monkeypatch, response):
    monkeypatch.setattr(
        hoshidicts_audio,
        "_provider_request",
        response if callable(response) else (lambda *_args, **_kwargs: response),
    )


def test_default_profile_is_generic_and_has_no_retired_controls():
    assert hoshidicts_audio_profile.default_hoshidicts_audio_profile() == {
        "version": 1,
        "autoPlay": False,
        "sources": [],
    }


def test_saved_legacy_enable_and_volume_keys_are_ignored(tmp_path):
    profile_path = tmp_path / "audio-profile.json"
    source = make_audio_source(
        "fast-audio",
        "custom-json",
        url="http://127.0.0.1:5050/?term={term}&reading={reading}",
    )
    profile_path.write_text(
        json.dumps(
            {
                "version": 1,
                "enabled": False,
                "volume": 3,
                "autoPlay": True,
                "sources": [source],
            }
        ),
        encoding="utf-8",
    )

    assert hoshidicts_audio_profile.load_hoshidicts_audio_profile(profile_path) == {
        "version": 1,
        "autoPlay": True,
        "sources": [source],
    }


def test_yomitan_audio_fast_custom_json_plays_and_mines_in_source_order(monkeypatch):
    manual_discovery_url = "http://127.0.0.1:5050/?term=%E9%A3%9F%E3%81%B9%E3%82%8B&reading=%E3%81%9F%E3%81%B9%E3%82%8B"
    manual_media_url = "http://127.0.0.1:5050/v1/media/taberu.opus"
    mining_empty_url = "http://127.0.0.1:5050/empty?term=%E8%81%9E%E3%81%8F&reading=%E3%81%8D%E3%81%8F"
    mining_discovery_url = "http://127.0.0.1:5050/?term=%E8%81%9E%E3%81%8F&reading=%E3%81%8D%E3%81%8F"
    mining_media_url = "http://127.0.0.1:5050/v1/media/kiku.opus"
    manual_audio = opus_bytes(b"manual")
    mining_audio = opus_bytes(b"mining")
    calls = []

    def request(method, url, **_kwargs):
        calls.append((method, url))
        if url == mining_empty_url:
            return FakeResponse(
                json.dumps({"type": "audioSourceList", "audioSources": []}).encode(),
                content_type="application/json",
            )
        if url in {manual_discovery_url, mining_discovery_url}:
            media_url = manual_media_url if url == manual_discovery_url else mining_media_url
            return FakeResponse(
                json.dumps(
                    {
                        "type": "audioSourceList",
                        "audioSources": [{"name": "First configured recording", "url": media_url}],
                    }
                ).encode(),
                content_type="application/json",
            )
        if url == manual_media_url:
            return FakeResponse(manual_audio, content_type="audio/ogg")
        if url == mining_media_url:
            return FakeResponse(mining_audio, content_type="audio/ogg")
        raise AssertionError(f"Unexpected yomitan-audio-fast URL: {url}")

    respond(monkeypatch, request)
    profile = generic_profile(
        make_audio_source(
            "empty-first",
            "custom-json",
            url="http://127.0.0.1:5050/empty?term={term}&reading={reading}",
        ),
        make_audio_source(
            "fast-audio",
            "custom-json",
            url="http://127.0.0.1:5050/?term={term}&reading={reading}",
        ),
    )

    candidates = hoshidicts_audio.get_audio_candidates("食べる", "たべる", "fast-audio", profile=profile)
    media = hoshidicts_audio.get_audio_media(
        "食べる",
        "たべる",
        "fast-audio",
        candidates[0]["index"],
        candidates[0]["candidateId"],
        profile=profile,
    )
    mined = hoshidicts_audio.get_mining_audio("聞く", "きく", profile=profile)

    assert candidates[0]["name"] == "First configured recording"
    assert candidates[0]["playbackUrl"] == manual_media_url
    assert media == hoshidicts_audio.AudioMedia(manual_audio, "audio/ogg", "ogg")
    assert mined == hoshidicts_audio.AudioMedia(mining_audio, "audio/ogg", "ogg")
    assert calls == [
        ("GET", manual_discovery_url),
        ("GET", manual_media_url),
        ("GET", mining_empty_url),
        ("GET", mining_discovery_url),
        ("GET", mining_media_url),
    ]


def test_media_download_does_not_validate_empty_provider_bytes(monkeypatch):
    respond(monkeypatch, FakeResponse(b"", content_type="audio/mpeg"))
    profile = generic_profile(
        make_audio_source("empty", "custom", url="https://empty.test/{term}.mp3"),
        enabled=True,
        volume=100,
    )

    media = hoshidicts_audio.get_audio_media("食べる", "たべる", "empty", 0, profile=profile)

    assert media == hoshidicts_audio.AudioMedia(b"", "audio/mpeg", "mp3")


def test_mining_has_no_audio_download_attempt_cap(monkeypatch):
    profile = generic_profile(
        make_audio_source("first", "custom", url="https://first.test/audio"),
        make_audio_source("second", "custom", url="https://second.test/audio"),
        enabled=True,
        volume=100,
    )

    def candidates(_term, _reading, source_id, **_kwargs):
        count = 32 if source_id == "first" else 1
        return [
            {
                "index": index,
                "name": "",
                "candidateId": f"{index:064x}",
                "playbackUrl": f"https://cdn.test/{source_id}/{index}.mp3",
            }
            for index in range(count)
        ]

    attempts = []
    expected = hoshidicts_audio.AudioMedia(b"last candidate", "audio/mpeg", "mp3")

    def download(_term, _reading, source_id, candidate_index, _candidate_id=None, **kwargs):
        attempts.append((source_id, candidate_index, kwargs.get("_deadline")))
        if source_id == "second":
            return expected
        raise HoshidictsAudioError("missing", 404)

    monkeypatch.setattr(hoshidicts_audio, "get_audio_candidates", candidates)
    monkeypatch.setattr(hoshidicts_audio, "get_audio_media", download)

    assert hoshidicts_audio.get_mining_audio("食べる", "たべる", profile=profile) == expected
    assert [(source_id, index) for source_id, index, _deadline in attempts] == [
        *[("first", index) for index in range(32)],
        ("second", 0),
    ]
