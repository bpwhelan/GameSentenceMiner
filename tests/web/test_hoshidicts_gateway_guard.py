from GameSentenceMiner.web.hoshidicts_api import MAX_LOOKUP_STATS_REQUEST_BYTES
from GameSentenceMiner.web.texthooking_page import (
    _hoshidicts_gateway_body_limit,
    _is_loopback_address,
)


def test_hoshidicts_gateway_limits_mutating_request_bodies():
    assert _hoshidicts_gateway_body_limit("/api/hoshidicts/audio/candidates") == 32 * 1024
    assert _hoshidicts_gateway_body_limit("/api/hoshidicts/audio/media") == 32 * 1024
    assert _hoshidicts_gateway_body_limit("/api/hoshidicts/mine") == 64 * 1024 * 1024
    assert _hoshidicts_gateway_body_limit("/api/hoshidicts/mining/check") == 64 * 1024 * 1024
    assert _hoshidicts_gateway_body_limit("/api/hoshidicts/mining/browse") == 64 * 1024
    assert _hoshidicts_gateway_body_limit("/api/hoshidicts/mining/status") is None


def test_gateway_bounds_lookup_stats_request_body():
    # The POST /api/hoshidicts/lookup-stats endpoint caps its own body at the
    # Flask layer (request.max_content_length = MAX_LOOKUP_STATS_REQUEST_BYTES),
    # but the single-port gateway forwards the FULL body before Flask ever sees
    # it. Without a gateway limit for this path, an oversized POST is read
    # unbounded into memory (the `else: payload = await incoming_request.read()`
    # branch). The gateway must bound it too, mirroring the endpoint cap.
    limit = _hoshidicts_gateway_body_limit("/api/hoshidicts/lookup-stats")
    assert limit is not None
    assert limit == MAX_LOOKUP_STATS_REQUEST_BYTES


def test_hoshidicts_gateway_accepts_only_loopback_clients():
    assert _is_loopback_address("127.0.0.1") is True
    assert _is_loopback_address("::1") is True
    assert _is_loopback_address("::ffff:127.0.0.1") is True
    assert _is_loopback_address("192.168.1.25") is False
    assert _is_loopback_address(None) is False
