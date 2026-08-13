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


def test_hoshidicts_gateway_accepts_only_loopback_clients():
    assert _is_loopback_address("127.0.0.1") is True
    assert _is_loopback_address("::1") is True
    assert _is_loopback_address("::ffff:127.0.0.1") is True
    assert _is_loopback_address("192.168.1.25") is False
    assert _is_loopback_address(None) is False
