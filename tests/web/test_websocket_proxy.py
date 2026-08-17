from GameSentenceMiner.web.websocket_proxy import build_upstream_websocket_headers


def test_upstream_headers_drop_client_websocket_negotiation_state():
    incoming_headers = {
        "Authorization": "Bearer local-token",
        "Connection": "keep-alive, Upgrade",
        "Cookie": "session=local",
        "Host": "127.0.0.1:7275",
        "Origin": "http://127.0.0.1:7275",
        "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
        "Sec-WebSocket-Key": "outer-client-key",
        "Sec-WebSocket-Protocol": "gsm-v1",
        "Sec-WebSocket-Version": "13",
        "Upgrade": "websocket",
        "X-GSM-Client": "overlay",
    }

    headers = build_upstream_websocket_headers(
        incoming_headers,
        upstream_host="127.0.0.1",
        upstream_port=65444,
    )

    assert headers == {
        "Authorization": "Bearer local-token",
        "Cookie": "session=local",
        "Host": "127.0.0.1:65444",
        "Origin": "http://127.0.0.1:7275",
        "X-GSM-Client": "overlay",
    }


def test_upstream_header_filter_is_case_insensitive():
    headers = build_upstream_websocket_headers(
        {
            "sec-websocket-extensions": "permessage-deflate",
            "SEC-WEBSOCKET-KEY": "outer-client-key",
            "uPgRaDe": "websocket",
        },
        upstream_host="localhost",
        upstream_port=1234,
    )

    assert headers == {"Host": "localhost:1234"}
