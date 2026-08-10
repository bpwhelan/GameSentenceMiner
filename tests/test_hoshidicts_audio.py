import ipaddress
import json
import socket
from pathlib import Path

import pytest
from flask import Flask

from GameSentenceMiner import hoshidicts_audio
from GameSentenceMiner.web import hoshidicts_api


class FakeResponse:
    def __init__(
        self,
        body: bytes,
        *,
        content_type: str = "text/html",
        status_code: int = 200,
        headers: dict[str, str] | None = None,
    ):
        self._body = body
        self.status_code = status_code
        self.headers = {"Content-Type": content_type, **(headers or {})}

    def iter_content(self, chunk_size=64 * 1024):
        yield from (self._body[index : index + chunk_size] for index in range(0, len(self._body), chunk_size))

    def close(self):
        pass


def _profile(*sources, **overrides):
    profile = hoshidicts_audio.default_hoshidicts_audio_profile()
    profile.update(overrides)
    if sources:
        profile["sources"] = list(sources)
    return profile


def _source(source_id: str, source_type: str, *, url: str = "", voice: str = ""):
    return {
        "id": source_id,
        "type": source_type,
        "url": url,
        "voice": voice,
    }


def _mp3(payload: bytes = b"pronunciation") -> bytes:
    frame = b"\xff\xfb\x90\x64" + payload
    return b"ID3\x04\x00\x00\x00\x00\x00\x00" + frame.ljust(417, b"\x00")


def _opus(payload: bytes = b"pronunciation") -> bytes:
    packet = b"OpusHead" + payload
    return b"OggS" + (b"\x00" * 22) + bytes((1, len(packet))) + packet


@pytest.fixture(autouse=True)
def _stable_public_dns(monkeypatch):
    hoshidicts_audio.clear_audio_cache()

    def getaddrinfo(host, port, *_args, **_kwargs):
        if host in {"localhost", "localhost."}:
            address = "127.0.0.1"
        else:
            try:
                socket.inet_pton(socket.AF_INET, host)
                address = host
            except OSError:
                address = "93.184.216.34"
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, port or 0))]

    monkeypatch.setattr(hoshidicts_audio.socket, "getaddrinfo", getaddrinfo)
    yield
    hoshidicts_audio.clear_audio_cache()


@pytest.fixture
def audio_api_client():
    app = Flask(__name__)
    hoshidicts_api.register_hoshidicts_api_routes(app)
    return app.test_client()


def test_audio_profile_defaults_and_strict_normalization(tmp_path):
    assert hoshidicts_audio.load_hoshidicts_audio_profile(tmp_path / "missing.json") == _profile()

    normalized = hoshidicts_audio.normalize_hoshidicts_audio_profile(
        {
            "version": 1,
            "enabled": False,
            "autoPlay": True,
            "volume": 25,
            "sources": [
                {"id": " direct ", "type": "custom", "url": " https://audio.test/{term} "},
                {"id": "tts", "type": "text-to-speech", "voice": " ja-JP "},
                {"id": "jisho", "type": "jisho", "url": None, "voice": None},
            ],
        }
    )

    assert normalized == {
        "version": 1,
        "enabled": False,
        "autoPlay": True,
        "volume": 25,
        "sources": [
            _source("direct", "custom", url="https://audio.test/{term}"),
            _source("tts", "text-to-speech", voice="ja-JP"),
            _source("jisho", "jisho"),
        ],
    }

    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="unique"):
        hoshidicts_audio.normalize_hoshidicts_audio_profile(
            {
                "sources": [
                    {"id": "same", "type": "jisho"},
                    {"id": "same", "type": "jpod101"},
                ]
            }
        )
    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="volume"):
        hoshidicts_audio.normalize_hoshidicts_audio_profile({"volume": 1.5})
    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="version"):
        hoshidicts_audio.normalize_hoshidicts_audio_profile({"version": True})
    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="URL"):
        hoshidicts_audio.normalize_hoshidicts_audio_profile(
            {"sources": [{"id": "bad", "type": "custom", "url": "file:///tmp/audio.mp3"}]}
        )
    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="URL"):
        hoshidicts_audio.normalize_hoshidicts_audio_profile(
            {"sources": [{"id": "bad", "type": "custom", "url": "http://{term}/audio.mp3"}]}
        )
    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="URL"):
        hoshidicts_audio.normalize_hoshidicts_audio_profile(
            {
                "sources": [
                    {
                        "id": "bad-template",
                        "type": "custom-json",
                        "url": "http://127.0.0.1:5050/?term={term}&reading={reading",
                    }
                ]
            }
        )

    oversized = tmp_path / "audio-profile.json"
    oversized.write_bytes(b" " * (hoshidicts_audio.MAX_PROFILE_BYTES + 1))
    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="invalid size"):
        hoshidicts_audio.load_hoshidicts_audio_profile(oversized)
    assert hoshidicts_audio.load_hoshidicts_audio_profile_or_default(oversized) == _profile()


def test_jpod101_candidate_matches_yomitan_kana_behavior(monkeypatch):
    profile = _profile(_source("jp", "jpod101"))

    candidates = hoshidicts_audio.get_audio_candidates("食べる", "たべる", "jp", profile=profile)
    kana_candidates = hoshidicts_audio.get_audio_candidates("かな", "かな", "jp", profile=profile)

    assert candidates[0]["index"] == 0
    assert candidates[0]["name"] == ""
    assert len(candidates[0]["candidateId"]) == 64
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
    responses = [
        FakeResponse(languagepod_html),
        FakeResponse(jisho_html),
    ]

    def request(method, url, **kwargs):
        response = responses.pop(0)
        if "japanesepod101" in url:
            assert method == "POST"
            assert kwargs["data"]["search_query"] == "食べる"
        return response

    monkeypatch.setattr(hoshidicts_audio, "_pinned_request", request)

    languagepod = hoshidicts_audio._resolve_source_candidates(_source("pod", "language-pod-101"), "食べる", "たべる")
    jisho = hoshidicts_audio._resolve_source_candidates(_source("jisho", "jisho"), "食べる", "たべる")

    assert [item["url"] for item in languagepod] == ["https://www.japanesepod101.com/good.mp3"]
    assert [item["url"] for item in jisho] == ["https://cdn.example.com/taberu.mp3"]


def test_custom_url_substitution_encodes_values_and_custom_json_is_exact(monkeypatch):
    direct = _source(
        "direct",
        "custom",
        url="https://audio.test/play?term={term}&reading={reading}&lang={language}&x={unknown}",
    )
    assert (
        hoshidicts_audio._resolve_source_candidates(direct, "食 &?#/べる", "た/べ?る")[0]["url"]
        == "https://audio.test/play?term=%E9%A3%9F%20%26%3F%23%2F%E3%81%B9%E3%82%8B"
        "&reading=%E3%81%9F%2F%E3%81%B9%3F%E3%82%8B&lang=ja&x={unknown}"
    )
    assert hoshidicts_audio._substitute_custom_url(
        "http://127.0.0.1:5050/?expression={expression}&reading={reading}",
        "食べる",
        "たべる",
    ) == ("http://127.0.0.1:5050/?expression=%E9%A3%9F%E3%81%B9%E3%82%8B&reading=%E3%81%9F%E3%81%B9%E3%82%8B")

    response = FakeResponse(
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
    )
    monkeypatch.setattr(hoshidicts_audio, "_pinned_request", lambda *_args, **_kwargs: response)

    candidates = hoshidicts_audio._resolve_source_candidates(
        _source("json", "custom-json", url="https://api.test/{term}"),
        "食べる",
        "たべる",
    )

    assert [(item["name"], item["url"]) for item in candidates] == [
        ("Tokyo", "https://cdn.test/a.mp3"),
        ("", "http://127.0.0.1:9000/b.ogg"),
    ]

    invalid = FakeResponse(
        json.dumps({"type": "audioSourceList", "audioSources": [], "extra": True}).encode(),
        content_type="application/json",
    )
    monkeypatch.setattr(hoshidicts_audio, "_pinned_request", lambda *_args, **_kwargs: invalid)
    hoshidicts_audio.clear_audio_cache()
    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="custom JSON"):
        hoshidicts_audio._resolve_source_candidates(
            _source("json", "custom-json", url="https://api.test/{term}"),
            "食べる",
            "たべる",
        )


def test_local_audio_yomichan_contract_discovers_and_downloads_opus(monkeypatch):
    discovery_url = "http://127.0.0.1:5050/?term=%E9%A3%9F%E3%81%B9%E3%82%8B&reading=%E3%81%9F%E3%81%B9%E3%82%8B"
    # Local Audio Server v1.7.0 can advertise localhost media URLs even when
    # Yomitan configured discovery through 127.0.0.1.
    media_url = "http://localhost:5050/nhk16/taberu.opus"
    audio = _opus()
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

    monkeypatch.setattr(hoshidicts_audio, "_pinned_request", request)
    profile = _profile(
        _source(
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
        }
    ]
    expected_media = hoshidicts_audio.AudioMedia(
        data=audio,
        content_type="audio/ogg",
        extension="ogg",
    )
    assert mined_media == expected_media
    assert media == expected_media
    assert calls == [("GET", discovery_url), ("GET", media_url)]


def test_custom_json_truncates_large_yomitan_audio_lists(monkeypatch):
    response = FakeResponse(
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
    )
    monkeypatch.setattr(
        hoshidicts_audio,
        "_pinned_request",
        lambda *_args, **_kwargs: response,
    )
    profile = _profile(
        _source(
            "local-audio",
            "custom-json",
            url="http://127.0.0.1:5050/?term={term}&reading={reading}",
        )
    )

    candidates = hoshidicts_audio.get_audio_candidates("食べる", "たべる", "local-audio", profile=profile)

    assert len(candidates) == hoshidicts_audio.MAX_AUDIO_SOURCES
    assert candidates[-1]["name"] == "Recording 31"


def test_media_download_is_bounded_validated_and_cached(monkeypatch):
    body = _mp3()
    calls = []

    def request(method, url, **kwargs):
        calls.append((method, url))
        return FakeResponse(body, content_type="audio/mpeg")

    monkeypatch.setattr(hoshidicts_audio, "_pinned_request", request)
    profile = _profile(_source("direct", "custom", url="https://audio.test/{term}.mp3"))

    mined = hoshidicts_audio.get_mining_audio("食べる", "たべる", profile=profile)
    first = hoshidicts_audio.get_audio_media("食べる", "たべる", "direct", 0, profile=profile)
    second = hoshidicts_audio.get_audio_media("食べる", "たべる", "direct", 0, profile=profile)

    assert mined == first
    assert first.data == body
    assert first.content_type == "audio/mpeg"
    assert first.extension == "mp3"
    assert second == first
    assert calls == [("GET", "https://audio.test/%E9%A3%9F%E3%81%B9%E3%82%8B.mp3")]

    monkeypatch.setattr(
        hoshidicts_audio,
        "_pinned_request",
        lambda *_args, **_kwargs: FakeResponse(b"<html>missing</html>", content_type="text/html"),
    )
    hoshidicts_audio.clear_audio_cache()
    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="valid audio"):
        hoshidicts_audio.get_audio_media("食べる", "たべる", "direct", 0, profile=profile)

    for header_only in (
        b"OggS" + b"\x00" * 64,
        b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64,
        b"\x1aE\xdf\xa3" + b"\x00" * 64,
        b"\xff\xfb",
    ):
        monkeypatch.setattr(
            hoshidicts_audio,
            "_pinned_request",
            lambda *_args, _body=header_only, **_kwargs: FakeResponse(
                _body,
                content_type="audio/mpeg",
            ),
        )
        hoshidicts_audio.clear_audio_cache()
        with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="valid audio"):
            hoshidicts_audio.get_audio_media("食べる", "たべる", "direct", 0, profile=profile)


def test_provider_redirects_and_streamed_responses_are_bounded(monkeypatch):
    redirect_calls = []

    def redirecting(method, url, **_kwargs):
        redirect_calls.append((method, url))
        return FakeResponse(
            b"",
            status_code=302,
            headers={"Location": f"/redirect-{len(redirect_calls)}"},
        )

    monkeypatch.setattr(hoshidicts_audio, "_pinned_request", redirecting)
    profile = _profile(_source("direct", "custom", url="https://audio.test/start"))
    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="redirected too many"):
        hoshidicts_audio.get_audio_media("食べる", "たべる", "direct", 0, profile=profile)
    assert len(redirect_calls) == hoshidicts_audio.MAX_REDIRECTS + 1

    oversized_json = FakeResponse(
        b"x" * (hoshidicts_audio.MAX_CUSTOM_JSON_BYTES + 1),
        content_type="application/json",
    )
    monkeypatch.setattr(
        hoshidicts_audio,
        "_pinned_request",
        lambda *_args, **_kwargs: oversized_json,
    )
    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="too large"):
        hoshidicts_audio._resolve_source_candidates(
            _source("json", "custom-json", url="https://api.test/audio"),
            "食べる",
            "たべる",
        )

    monkeypatch.setattr(hoshidicts_audio, "MAX_AUDIO_BYTES", 8)
    oversized_audio = FakeResponse(_mp3(), content_type="audio/mpeg")
    monkeypatch.setattr(
        hoshidicts_audio,
        "_pinned_request",
        lambda *_args, **_kwargs: oversized_audio,
    )
    hoshidicts_audio.clear_audio_cache()
    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="too large"):
        hoshidicts_audio.get_audio_media("食べる", "たべる", "direct", 0, profile=profile)


def test_public_providers_cannot_redirect_to_private_networks(monkeypatch):
    calls = []

    def request(method, url, **_kwargs):
        calls.append((method, url))
        return FakeResponse(
            b"",
            status_code=302,
            headers={"Location": "http://127.0.0.1:8080/private.mp3"},
        )

    monkeypatch.setattr(hoshidicts_audio, "_pinned_request", request)
    profile = _profile(_source("direct", "custom", url="https://audio.test/start"))

    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="private network"):
        hoshidicts_audio.get_audio_media("食べる", "たべる", "direct", 0, profile=profile)

    assert calls == [("GET", "https://audio.test/start")]


def test_explicit_loopback_provider_remains_supported(monkeypatch):
    monkeypatch.setattr(
        hoshidicts_audio,
        "_pinned_request",
        lambda method, url, **_kwargs: FakeResponse(_mp3(), content_type="audio/mpeg"),
    )
    profile = _profile(_source("local", "custom", url="http://127.0.0.1:9000/{term}.mp3"))

    media = hoshidicts_audio.get_audio_media("食べる", "たべる", "local", 0, profile=profile)

    assert media.data == _mp3()


def test_explicit_loopback_provider_cannot_pivot_to_another_private_origin(monkeypatch):
    calls = []

    def request(method, url, **_kwargs):
        calls.append((method, url))
        if len(calls) == 1:
            return FakeResponse(
                b"",
                status_code=302,
                headers={"Location": "http://127.0.0.1:9001/private.mp3"},
            )
        return FakeResponse(_mp3(), content_type="audio/mpeg")

    monkeypatch.setattr(hoshidicts_audio, "_pinned_request", request)
    profile = _profile(_source("local", "custom", url="http://127.0.0.1:9000/{term}.mp3"))

    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="private network"):
        hoshidicts_audio.get_audio_media("食べる", "たべる", "local", 0, profile=profile)

    assert calls == [("GET", "http://127.0.0.1:9000/%E9%A3%9F%E3%81%B9%E3%82%8B.mp3")]


def test_private_custom_json_cannot_permit_a_different_private_origin(monkeypatch):
    calls = []

    def request(method, url, **_kwargs):
        calls.append((method, url))
        return FakeResponse(
            json.dumps(
                {
                    "type": "audioSourceList",
                    "audioSources": [{"url": "http://127.0.0.1:9001/private.mp3"}],
                }
            ).encode(),
            content_type="application/json",
        )

    monkeypatch.setattr(hoshidicts_audio, "_pinned_request", request)
    profile = _profile(_source("local-json", "custom-json", url="http://127.0.0.1:9000/list"))
    candidate = hoshidicts_audio.get_audio_candidates("食べる", "たべる", "local-json", profile=profile)[0]

    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="private network"):
        hoshidicts_audio.get_audio_media(
            "食べる",
            "たべる",
            "local-json",
            candidate["index"],
            candidate["candidateId"],
            profile=profile,
        )

    assert calls == [("GET", "http://127.0.0.1:9000/list")]


def test_pinned_adapter_connects_to_the_validated_address_and_keeps_tls_hostname():
    request = hoshidicts_audio.requests.Request("GET", "https://audio.example.test/file").prepare()
    adapter = hoshidicts_audio._PinnedAddressAdapter(
        ipaddress.ip_address("93.184.216.34"),
        "audio.example.test",
    )
    try:
        pool = adapter.get_connection_with_tls_context(request, True, proxies={})
        assert pool.host == "93.184.216.34"
        assert pool.assert_hostname == "audio.example.test"
        assert pool.conn_kw["server_hostname"] == "audio.example.test"
    finally:
        adapter.close()


def test_provider_stream_has_an_overall_deadline(monkeypatch):
    class SlowResponse(FakeResponse):
        def iter_content(self, chunk_size=64 * 1024):
            del chunk_size
            yield b"ID3"
            yield b"still arriving"

    ticks = iter([0.0, 0.0, 1.1, 1.2])
    monkeypatch.setattr(hoshidicts_audio.time, "monotonic", lambda: next(ticks, 1.2))
    monkeypatch.setattr(hoshidicts_audio, "MAX_PROVIDER_REQUEST_SECONDS", 1.0)
    monkeypatch.setattr(
        hoshidicts_audio,
        "_pinned_request",
        lambda *_args, **_kwargs: SlowResponse(b"", content_type="audio/mpeg"),
    )

    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="timed out"):
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
    monkeypatch.setattr(
        hoshidicts_audio,
        "_pinned_request",
        lambda *_args, **_kwargs: responses.pop(0),
    )
    profile = _profile(_source("json", "custom-json", url="https://api.test/audio"))
    candidate = hoshidicts_audio.get_audio_candidates("食べる", "たべる", "json", profile=profile)[0]
    hoshidicts_audio.clear_audio_cache()

    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="changed") as error:
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
    profile = _profile(
        _source("one", "custom", url="https://one.test/audio"),
        _source("two", "custom", url="https://two.test/audio"),
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
        raise hoshidicts_audio.HoshidictsAudioError("missing", 404)

    monkeypatch.setattr(hoshidicts_audio, "_download_candidate", unavailable)

    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="attempt limit"):
        hoshidicts_audio.get_mining_audio("食べる", "たべる", profile=profile)

    assert len(attempts) == hoshidicts_audio.MAX_MINING_AUDIO_ATTEMPTS


def test_provider_errors_do_not_echo_secret_urls(monkeypatch):
    monkeypatch.setattr(
        hoshidicts_audio,
        "_pinned_request",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            hoshidicts_audio.requests.ConnectionError("failed https://audio.test/file?apiKey=super-secret")
        ),
    )

    with pytest.raises(hoshidicts_audio.HoshidictsAudioError) as error:
        hoshidicts_audio._request_bytes(
            "GET",
            "https://audio.test/file?apiKey=super-secret",
            maximum=1024,
        )

    assert "super-secret" not in str(error.value)
    assert error.value.__cause__ is None


def test_mining_skips_tts_and_falls_through_downloadable_sources(monkeypatch):
    profile = _profile(
        _source("tts", "text-to-speech", voice="ja-JP"),
        _source("empty", "custom", url=""),
    )
    monkeypatch.setattr(
        hoshidicts_audio,
        "_pinned_request",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("TTS must remain local")),
    )

    with pytest.raises(hoshidicts_audio.HoshidictsAudioError, match="No pronunciation audio") as error:
        hoshidicts_audio.get_mining_audio("食べる", "たべる", profile=profile)

    assert error.value.status_code == 404


def test_audio_routes_never_accept_a_remote_url_from_the_client(monkeypatch, audio_api_client):
    profile = _profile(_source("safe", "custom", url="https://configured.test/{term}.mp3"))
    monkeypatch.setattr(hoshidicts_api, "load_hoshidicts_audio_profile", lambda: profile)
    monkeypatch.setattr(
        hoshidicts_api,
        "get_audio_media",
        lambda term, reading, source_id, candidate_index, candidate_id, *, profile: hoshidicts_audio.AudioMedia(
            data=_mp3(),
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
    assert media.data == _mp3()

    remote = audio_api_client.post(
        "/api/hoshidicts/audio/candidates",
        json={"term": "食べる", "reading": "たべる", "sourceId": "safe"},
        environ_base={"REMOTE_ADDR": "192.168.1.25"},
    )
    assert remote.status_code == 403


def test_audio_routes_require_json_content_type(audio_api_client):
    payload = {"term": "食べる", "reading": "たべる", "sourceId": "jpod101"}

    wrong_content_type = audio_api_client.post(
        "/api/hoshidicts/audio/candidates",
        data=json.dumps(payload),
        content_type="text/plain",
    )
    assert wrong_content_type.status_code == 415


def test_profile_path_uses_the_hoshidicts_data_directory(monkeypatch, tmp_path):
    monkeypatch.setattr(hoshidicts_audio, "get_app_directory", lambda: str(tmp_path))
    assert hoshidicts_audio.get_hoshidicts_audio_profile_path() == (
        Path(tmp_path) / "dictionaries" / "hoshidicts" / "audio-profile.json"
    )
