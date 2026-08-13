import json
from pathlib import Path

import pytest
from flask import Flask

from GameSentenceMiner import hoshidicts_audio, hoshidicts_audio_profile
from GameSentenceMiner.web import hoshidicts_api
from tests.test_hoshidicts_factories import (
    FakeResponse,
    make_audio_profile,
    make_audio_source,
    mp3_bytes,
    opus_bytes,
)

HoshidictsAudioError = hoshidicts_audio_profile.HoshidictsAudioError


@pytest.fixture(autouse=True)
def _clear_audio_caches():
    hoshidicts_audio.clear_audio_cache()
    yield
    hoshidicts_audio.clear_audio_cache()


@pytest.fixture
def audio_api_client():
    app = Flask(__name__)
    hoshidicts_api.register_hoshidicts_api_routes(app)
    return app.test_client()


def _respond(monkeypatch, response):
    """Answer every provider request with one response or a request handler."""
    monkeypatch.setattr(
        hoshidicts_audio,
        "_provider_request",
        response if callable(response) else (lambda *_args, **_kwargs: response),
    )


def test_audio_profile_load_merges_defaults(tmp_path):
    assert hoshidicts_audio_profile.load_hoshidicts_audio_profile(tmp_path / "missing.json") == make_audio_profile()

    profile_path = tmp_path / "audio-profile.json"
    profile_path.write_text(
        json.dumps(
            {
                "version": 1,
                "enabled": False,
                "sources": [{"id": "jpod101", "type": "jpod101", "url": "", "voice": ""}],
            }
        ),
        encoding="utf-8",
    )

    loaded = hoshidicts_audio_profile.load_hoshidicts_audio_profile(profile_path)
    assert loaded["enabled"] is False
    # autoPlay and volume were omitted, so they come from the defaults.
    assert loaded["autoPlay"] is make_audio_profile()["autoPlay"]
    assert loaded["volume"] == make_audio_profile()["volume"]
    assert loaded["sources"] == [{"id": "jpod101", "type": "jpod101", "url": "", "voice": ""}]


@pytest.mark.parametrize(
    "value",
    ["not an object", {"sources": "nope"}, {"sources": [{"type": "jpod101"}]}],
)
def test_audio_profile_load_rejects_a_shape_the_pipeline_cannot_index(tmp_path, value):
    profile_path = tmp_path / "audio-profile.json"
    profile_path.write_text(json.dumps(value), encoding="utf-8")

    with pytest.raises(HoshidictsAudioError):
        hoshidicts_audio_profile.load_hoshidicts_audio_profile(profile_path)


def test_audio_profile_file_size_is_bounded(tmp_path):
    oversized = tmp_path / "audio-profile.json"
    oversized.write_bytes(b" " * (hoshidicts_audio_profile.MAX_PROFILE_BYTES + 1))

    with pytest.raises(HoshidictsAudioError, match="invalid size"):
        hoshidicts_audio_profile.load_hoshidicts_audio_profile(oversized)
    assert hoshidicts_audio_profile.load_hoshidicts_audio_profile_or_default(oversized) == make_audio_profile()


def test_profile_path_uses_the_hoshidicts_data_directory(monkeypatch, tmp_path):
    monkeypatch.setattr(hoshidicts_audio_profile, "get_app_directory", lambda: str(tmp_path))
    assert hoshidicts_audio_profile.get_hoshidicts_audio_profile_path() == (
        Path(tmp_path) / "dictionaries" / "hoshidicts" / "audio-profile.json"
    )


def test_jpod101_candidate_matches_yomitan_kana_behavior():
    profile = make_audio_profile(make_audio_source("jp", "jpod101"))

    candidates = hoshidicts_audio.get_audio_candidates("食べる", "たべる", "jp", profile=profile)
    kana_candidates = hoshidicts_audio.get_audio_candidates("かな", "かな", "jp", profile=profile)

    assert candidates[0]["index"] == 0
    assert candidates[0]["name"] == ""
    assert len(candidates[0]["candidateId"]) == 64
    assert "playbackUrl" not in candidates[0]
    assert hoshidicts_audio._resolve_source_candidates(profile["sources"][0], "食べる", "たべる")[0]["url"] == (
        "https://assets.languagepod101.com/dictionary/japanese/"
        "audiomp3.php?kanji=%E9%A3%9F%E3%81%B9%E3%82%8B&kana=%E3%81%9F%E3%81%B9%E3%82%8B"
    )
    assert hoshidicts_audio._resolve_source_candidates(profile["sources"][0], "かな", "かな")[0]["url"].endswith(
        "?kana=%E3%81%8B%E3%81%AA"
    )
    assert kana_candidates[0]["index"] == 0
    assert len(kana_candidates[0]["candidateId"]) == 64


def test_languagepod101_and_jisho_discover_only_matching_audio(monkeypatch):
    languagepod_html = b"""
        <div class="dc-result-row">
          <span class="dc-vocab_kana">other</span><audio><source src="/bad.mp3"></audio>
        </div>
        <div class="dc-result-row">
          <span class="dc-vocab_kana">\xe3\x81\x9f\xe3\x81\xb9\xe3\x82\x8b</span>
          <audio><source src="/good.mp3"></audio>
        </div>
    """
    jisho_html = b"""
        <audio id="audio_\xe9\xa3\x9f\xe3\x81\xb9\xe3\x82\x8b:\xe3\x81\x9f\xe3\x81\xb9\xe3\x82\x8b">
          <source src="//cdn.example.com/taberu.mp3">
        </audio>
    """
    responses = [FakeResponse(languagepod_html), FakeResponse(jisho_html)]

    def request(method, url, **kwargs):
        response = responses.pop(0)
        if "japanesepod101" in url:
            assert method == "POST"
            assert kwargs["data"]["search_query"] == "食べる"
        return response

    _respond(monkeypatch, request)

    languagepod = hoshidicts_audio._resolve_source_candidates(
        make_audio_source("pod", "language-pod-101"), "食べる", "たべる"
    )
    jisho = hoshidicts_audio._resolve_source_candidates(make_audio_source("jisho", "jisho"), "食べる", "たべる")

    assert [item["url"] for item in languagepod] == ["https://www.japanesepod101.com/good.mp3"]
    assert [item["url"] for item in jisho] == ["https://cdn.example.com/taberu.mp3"]


def test_jisho_percent_encodes_the_search_term(monkeypatch):
    requested = []

    def request(method, url, **kwargs):
        requested.append(url)
        return FakeResponse(b"")

    _respond(monkeypatch, request)

    hoshidicts_audio._resolve_source_candidates(make_audio_source("jisho", "jisho"), "何?", "なに")

    # Leaving the "?" raw would drop it into the query string and search "何".
    assert requested == ["https://jisho.org/search/%E4%BD%95%3F"]


def test_custom_url_substitution_encodes_values_and_custom_json_is_exact(monkeypatch):
    direct = make_audio_source(
        "direct",
        "custom",
        url="https://audio.test/play?term={term}&reading={reading}&lang={language}&x={unknown}",
    )
    assert (
        hoshidicts_audio._resolve_source_candidates(direct, "食 &?#/べる", "た/べ?る")[0]["url"]
        == "https://audio.test/play?term=%E9%A3%9F%20%26%3F%23%2F%E3%81%B9%E3%82%8B"
        "&reading=%E3%81%9F%2F%E3%81%B9%3F%E3%82%8B&lang=ja&x={unknown}"
    )
    assert hoshidicts_audio_profile.substitute_custom_url(
        "http://127.0.0.1:5050/?expression={expression}&reading={reading}",
        "食べる",
        "たべる",
    ) == ("http://127.0.0.1:5050/?expression=%E9%A3%9F%E3%81%B9%E3%82%8B&reading=%E3%81%9F%E3%81%B9%E3%82%8B")

    _respond(
        monkeypatch,
        FakeResponse(
            json.dumps(
                {
                    "type": "audioSourceList",
                    "audioSources": [
                        {"url": "https://cdn.test/a.mp3", "name": "Tokyo"},
                        {"url": "http://127.0.0.1:9000/b.ogg"},
                    ],
                }
            ).encode(),
            content_type="application/json",
        ),
    )
    json_source = make_audio_source("json", "custom-json", url="https://api.test/{term}")

    candidates = hoshidicts_audio._resolve_source_candidates(json_source, "食べる", "たべる")

    assert [(item["name"], item["url"]) for item in candidates] == [
        ("Tokyo", "https://cdn.test/a.mp3"),
        ("", "http://127.0.0.1:9000/b.ogg"),
    ]

    _respond(
        monkeypatch,
        FakeResponse(
            json.dumps({"type": "audioSourceList", "audioSources": [], "extra": True}).encode(),
            content_type="application/json",
        ),
    )
    hoshidicts_audio.clear_audio_cache()
    with pytest.raises(HoshidictsAudioError, match="custom JSON"):
        hoshidicts_audio._resolve_source_candidates(json_source, "食べる", "たべる")


def test_local_audio_yomichan_contract_discovers_and_downloads_opus(monkeypatch):
    discovery_url = "http://127.0.0.1:5050/?term=%E9%A3%9F%E3%81%B9%E3%82%8B&reading=%E3%81%9F%E3%81%B9%E3%82%8B"
    # Local Audio Server v1.7.0 can advertise localhost media URLs even when
    # Yomitan configured discovery through 127.0.0.1.
    media_url = "http://localhost:5050/nhk16/taberu.opus"
    audio = opus_bytes()
    calls = []

    def request(method, url, **_kwargs):
        calls.append((method, url))
        if url == discovery_url:
            return FakeResponse(
                json.dumps(
                    {
                        "type": "audioSourceList",
                        "audioSources": [{"name": "NHK16", "url": media_url}],
                    }
                ).encode(),
                content_type="application/json",
            )
        if url == media_url:
            return FakeResponse(audio, content_type="audio/ogg")
        raise AssertionError(f"Unexpected local audio URL: {url}")

    _respond(monkeypatch, request)
    profile = make_audio_profile(
        make_audio_source(
            "local-audio",
            "custom-json",
            url="http://127.0.0.1:5050/?term={term}&reading={reading}",
        )
    )

    mined_media = hoshidicts_audio.get_mining_audio("食べる", "たべる", profile=profile)
    candidates = hoshidicts_audio.get_audio_candidates("食べる", "たべる", "local-audio", profile=profile)
    media = hoshidicts_audio.get_audio_media(
        "食べる",
        "たべる",
        "local-audio",
        candidates[0]["index"],
        candidates[0]["candidateId"],
        profile=profile,
    )

    assert candidates == [
        {
            "index": 0,
            "name": "NHK16",
            "candidateId": candidates[0]["candidateId"],
            "playbackUrl": media_url,
        }
    ]
    expected_media = hoshidicts_audio.AudioMedia(data=audio, content_type="audio/ogg", extension="ogg")
    assert mined_media == expected_media
    assert media == expected_media
    assert calls == [("GET", discovery_url), ("GET", media_url)]


def test_custom_json_truncates_large_yomitan_audio_lists(monkeypatch):
    _respond(
        monkeypatch,
        FakeResponse(
            json.dumps(
                {
                    "type": "audioSourceList",
                    "audioSources": [
                        {
                            "name": f"Recording {index}",
                            "url": f"http://127.0.0.1:5050/jpod/{index}.mp3",
                        }
                        for index in range(hoshidicts_audio.MAX_AUDIO_SOURCES + 1)
                    ],
                }
            ).encode(),
            content_type="application/json",
        ),
    )
    profile = make_audio_profile(
        make_audio_source(
            "local-audio",
            "custom-json",
            url="http://127.0.0.1:5050/?term={term}&reading={reading}",
        )
    )

    candidates = hoshidicts_audio.get_audio_candidates("食べる", "たべる", "local-audio", profile=profile)

    assert len(candidates) == hoshidicts_audio.MAX_AUDIO_SOURCES
    assert candidates[-1]["name"] == "Recording 31"


def test_media_download_is_bounded_validated_and_cached(monkeypatch):
    body = mp3_bytes()
    calls = []

    def request(method, url, **_kwargs):
        calls.append((method, url))
        return FakeResponse(body, content_type="audio/mpeg")

    _respond(monkeypatch, request)
    profile = make_audio_profile(make_audio_source("direct", "custom", url="https://audio.test/{term}.mp3"))

    mined = hoshidicts_audio.get_mining_audio("食べる", "たべる", profile=profile)
    first = hoshidicts_audio.get_audio_media("食べる", "たべる", "direct", 0, profile=profile)
    second = hoshidicts_audio.get_audio_media("食べる", "たべる", "direct", 0, profile=profile)

    assert mined == first
    assert first.data == body
    assert first.content_type == "audio/mpeg"
    assert first.extension == "mp3"
    assert second == first
    assert calls == [("GET", "https://audio.test/%E9%A3%9F%E3%81%B9%E3%82%8B.mp3")]


@pytest.mark.parametrize(
    ("body", "content_type"),
    [
        pytest.param(b"<html>missing</html>", "text/html", id="html-error-page"),
        pytest.param(b"OggS" + b"\x00" * 64, "audio/mpeg", id="ogg-header-without-packet"),
        pytest.param(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64, "audio/mpeg", id="mp4-without-audio-track"),
        pytest.param(b"\x1aE\xdf\xa3" + b"\x00" * 64, "audio/mpeg", id="webm-without-audio-codec"),
        pytest.param(b"\xff\xfb", "audio/mpeg", id="truncated-mp3-frame"),
    ],
)
def test_media_download_rejects_content_that_is_not_audio(monkeypatch, body, content_type):
    _respond(monkeypatch, FakeResponse(body, content_type=content_type))
    profile = make_audio_profile(make_audio_source("direct", "custom", url="https://audio.test/{term}.mp3"))

    with pytest.raises(HoshidictsAudioError, match="valid audio"):
        hoshidicts_audio.get_audio_media("食べる", "たべる", "direct", 0, profile=profile)


def test_streamed_provider_responses_are_bounded(monkeypatch):
    profile = make_audio_profile(make_audio_source("direct", "custom", url="https://audio.test/start"))
    _respond(
        monkeypatch,
        FakeResponse(b"x" * (hoshidicts_audio.MAX_CUSTOM_JSON_BYTES + 1), content_type="application/json"),
    )
    with pytest.raises(HoshidictsAudioError, match="too large"):
        hoshidicts_audio._resolve_source_candidates(
            make_audio_source("json", "custom-json", url="https://api.test/audio"),
            "食べる",
            "たべる",
        )

    monkeypatch.setattr(hoshidicts_audio, "MAX_AUDIO_BYTES", 8)
    _respond(monkeypatch, FakeResponse(mp3_bytes(), content_type="audio/mpeg"))
    hoshidicts_audio.clear_audio_cache()
    with pytest.raises(HoshidictsAudioError, match="too large"):
        hoshidicts_audio.get_audio_media("食べる", "たべる", "direct", 0, profile=profile)


def test_explicit_loopback_provider_remains_supported(monkeypatch):
    _respond(monkeypatch, FakeResponse(mp3_bytes(), content_type="audio/mpeg"))
    profile = make_audio_profile(make_audio_source("local", "custom", url="http://127.0.0.1:9000/{term}.mp3"))

    media = hoshidicts_audio.get_audio_media("食べる", "たべる", "local", 0, profile=profile)

    assert media.data == mp3_bytes()


def test_provider_stream_has_an_overall_deadline(monkeypatch):
    class SlowResponse(FakeResponse):
        def iter_content(self, chunk_size=64 * 1024):
            del chunk_size
            yield b"ID3"
            yield b"still arriving"

    ticks = iter([0.0, 0.0, 1.1, 1.2])
    monkeypatch.setattr(hoshidicts_audio.time, "monotonic", lambda: next(ticks, 1.2))
    monkeypatch.setattr(hoshidicts_audio, "MAX_PROVIDER_REQUEST_SECONDS", 1.0)
    _respond(monkeypatch, SlowResponse(b"", content_type="audio/mpeg"))

    with pytest.raises(HoshidictsAudioError, match="timed out"):
        hoshidicts_audio._request_bytes("GET", "https://audio.test/slow", maximum=1024)


def test_candidate_id_rejects_a_reordered_dynamic_list(monkeypatch):
    responses = [
        FakeResponse(
            json.dumps({"type": "audioSourceList", "audioSources": [{"url": "https://cdn.test/a.mp3"}]}).encode(),
            content_type="application/json",
        ),
        FakeResponse(
            json.dumps({"type": "audioSourceList", "audioSources": [{"url": "https://cdn.test/b.mp3"}]}).encode(),
            content_type="application/json",
        ),
    ]
    _respond(monkeypatch, lambda *_args, **_kwargs: responses.pop(0))
    profile = make_audio_profile(make_audio_source("json", "custom-json", url="https://api.test/audio"))
    candidate = hoshidicts_audio.get_audio_candidates("食べる", "たべる", "json", profile=profile)[0]
    hoshidicts_audio.clear_audio_cache()

    with pytest.raises(HoshidictsAudioError, match="changed") as error:
        hoshidicts_audio.get_audio_media(
            "食べる",
            "たべる",
            "json",
            candidate["index"],
            candidate["candidateId"],
            profile=profile,
        )

    assert error.value.status_code == 409
    assert responses == []


def test_mining_audio_has_a_download_attempt_budget(monkeypatch):
    profile = make_audio_profile(
        make_audio_source("one", "custom", url="https://one.test/audio"),
        make_audio_source("two", "custom", url="https://two.test/audio"),
    )
    monkeypatch.setattr(
        hoshidicts_audio,
        "_resolve_source_candidates",
        lambda *_args, **_kwargs: [
            {"url": f"https://cdn.test/{index}.mp3", "name": ""} for index in range(hoshidicts_audio.MAX_AUDIO_SOURCES)
        ],
    )
    attempts = []

    def unavailable(candidate, _source, *, deadline=None):
        attempts.append((candidate["index"], deadline))
        raise HoshidictsAudioError("missing", 404)

    monkeypatch.setattr(hoshidicts_audio, "_download_candidate", unavailable)

    with pytest.raises(HoshidictsAudioError, match="attempt limit"):
        hoshidicts_audio.get_mining_audio("食べる", "たべる", profile=profile)

    assert len(attempts) == hoshidicts_audio.MAX_MINING_AUDIO_ATTEMPTS


def test_provider_errors_do_not_echo_secret_urls(monkeypatch):
    _respond(
        monkeypatch,
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            hoshidicts_audio.requests.ConnectionError("failed https://audio.test/file?apiKey=super-secret")
        ),
    )

    with pytest.raises(HoshidictsAudioError) as error:
        hoshidicts_audio._request_bytes(
            "GET",
            "https://audio.test/file?apiKey=super-secret",
            maximum=1024,
        )

    assert "super-secret" not in str(error.value)
    assert error.value.__cause__ is None


def test_mining_skips_tts_and_falls_through_downloadable_sources(monkeypatch):
    profile = make_audio_profile(
        make_audio_source("tts", "text-to-speech", voice="ja-JP"),
        make_audio_source("empty", "custom", url=""),
    )
    _respond(
        monkeypatch,
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("TTS must remain local")),
    )

    with pytest.raises(HoshidictsAudioError, match="No pronunciation audio") as error:
        hoshidicts_audio.get_mining_audio("食べる", "たべる", profile=profile)

    assert error.value.status_code == 404


def test_audio_routes_never_accept_a_remote_url_from_the_client(monkeypatch, audio_api_client):
    profile = make_audio_profile(make_audio_source("safe", "custom", url="https://configured.test/{term}.mp3"))
    monkeypatch.setattr(hoshidicts_api, "load_hoshidicts_audio_profile_or_default", lambda: profile)
    monkeypatch.setattr(
        hoshidicts_api,
        "get_audio_media",
        lambda term, reading, source_id, candidate_index, candidate_id, *, profile: hoshidicts_audio.AudioMedia(
            data=mp3_bytes(),
            content_type="audio/mpeg",
            extension="mp3",
        ),
    )
    candidates = audio_api_client.post(
        "/api/hoshidicts/audio/candidates",
        json={"term": "食べる", "reading": "たべる", "sourceId": "safe"},
    )
    assert candidates.status_code == 200
    candidate = candidates.get_json()["candidates"][0]
    assert candidate["index"] == 0
    assert candidate["name"] == ""
    assert len(candidate["candidateId"]) == 64

    rejected = audio_api_client.post(
        "/api/hoshidicts/audio/media",
        json={
            "term": "食べる",
            "reading": "たべる",
            "sourceId": "safe",
            "candidateIndex": 0,
            "candidateId": candidate["candidateId"],
            "url": "https://attacker.test/audio.mp3",
        },
    )
    assert rejected.status_code == 400
    assert "unexpected" in rejected.get_json()["error"]

    null_candidate_id = audio_api_client.post(
        "/api/hoshidicts/audio/media",
        json={
            "term": "食べる",
            "reading": "たべる",
            "sourceId": "safe",
            "candidateIndex": 0,
            "candidateId": None,
        },
    )
    assert null_candidate_id.status_code == 400
    assert "candidate ID" in null_candidate_id.get_json()["error"]

    media = audio_api_client.post(
        "/api/hoshidicts/audio/media",
        json={
            "term": "食べる",
            "reading": "たべる",
            "sourceId": "safe",
            "candidateIndex": 0,
            "candidateId": candidate["candidateId"],
        },
    )
    assert media.status_code == 200
    assert media.mimetype == "audio/mpeg"
    assert media.data == mp3_bytes()

    remote = audio_api_client.post(
        "/api/hoshidicts/audio/candidates",
        json={"term": "食べる", "reading": "たべる", "sourceId": "safe"},
        environ_base={"REMOTE_ADDR": "192.168.1.25"},
    )
    assert remote.status_code == 403


def test_audio_routes_require_json_content_type(audio_api_client):
    wrong_content_type = audio_api_client.post(
        "/api/hoshidicts/audio/candidates",
        data=json.dumps({"term": "食べる", "reading": "たべる", "sourceId": "jpod101"}),
        content_type="text/plain",
    )

    assert wrong_content_type.status_code == 415
