from __future__ import annotations

import json

import pytest

from GameSentenceMiner.sudachi import (
    PartOfSpeech,
    SudachiClient,
    SudachiUnavailableError,
)


class FakeSocket:
    def __init__(self, *, available: bool = True, externally_enabled: bool = False) -> None:
        self.available = available
        self.sent: list[dict] = []
        self._incoming = [
            {
                "type": "service_info",
                "service": "gsm_input_service",
                "protocolVersion": 1,
                "features": {
                    "enabled": ["gamepad", "sudachi"] if externally_enabled else ["gamepad"],
                },
            }
        ]

    def send(self, raw: str) -> None:
        message = json.loads(raw)
        self.sent.append(message)
        if message["type"] == "configure_features":
            self._incoming.append(
                {
                    "type": "service_features_changed",
                    "features": {"enabled": ["gamepad", "sudachi"]},
                }
            )
        elif message["type"] == "configure_sudachi":
            self._incoming.append(
                {
                    "type": "sudachi_configuration",
                    "dictionary": message["dictionary"],
                }
            )
        elif message["type"] == "tokenize":
            self._incoming.append(
                {
                    "type": "tokens",
                    "requestId": message["requestId"],
                    "text": message["text"],
                    "tokens": [
                        {
                            "word": "食べ",
                            "headword": "食べる",
                            "reading": "タベ",
                            "pos": "動詞,一般,*,*,下一段-バ行,連用形-一般",
                            "start": 0,
                            "end": 2,
                        },
                        {
                            "word": "た",
                            "headword": "た",
                            "reading": "タ",
                            "pos": "助動詞,*,*,*,助動詞-タ,終止形-一般",
                            "start": 2,
                            "end": 3,
                        },
                        {
                            "word": "。",
                            "headword": "。",
                            "pos": "補助記号,句点,*,*,*,*",
                            "start": 3,
                            "end": 4,
                        },
                    ],
                    "sudachiAvailable": self.available,
                    "featureDisabled": False,
                }
            )

    def recv(self, timeout: float | None = None) -> str:
        del timeout
        return json.dumps(self._incoming.pop(0), ensure_ascii=False)

    def close(self) -> None:
        pass


def test_client_leases_sudachi_and_maps_native_token_fields() -> None:
    socket = FakeSocket()
    client = SudachiClient(
        endpoint="ws://127.0.0.1:7276",
        dictionary="core",
        connect_factory=lambda *_args, **_kwargs: socket,
    )

    tokens = client.translate("食べた。")

    assert [token.word for token in tokens] == ["食べ", "た", "。"]
    assert tokens[0].headword == "食べる"
    assert tokens[0].katakana_reading == "タベ"
    assert tokens[0].part_of_speech is PartOfSpeech.verb
    assert tokens[1].part_of_speech is PartOfSpeech.bound_auxiliary
    assert tokens[2].part_of_speech is PartOfSpeech.symbol
    assert socket.sent[:2] == [
        {"type": "configure_features", "features": ["sudachi"]},
        {"type": "configure_sudachi", "dictionary": "core"},
    ]


def test_reading_and_hiragana_preserve_existing_python_contract() -> None:
    socket = FakeSocket()
    client = SudachiClient(connect_factory=lambda *_args, **_kwargs: socket)

    assert client.reading("食べた。") == " 食[た]べた。"
    assert client.to_hiragana("食べた。") == "たべた。"

    tokenize_messages = [message for message in socket.sent if message["type"] == "tokenize"]
    assert len(tokenize_messages) == 1


def test_html_is_removed_before_tokenization() -> None:
    socket = FakeSocket()
    client = SudachiClient(connect_factory=lambda *_args, **_kwargs: socket)

    client.translate("<b>食べた。</b>")

    tokenize_message = next(message for message in socket.sent if message["type"] == "tokenize")
    assert tokenize_message["text"] == "食べた。"


def test_unavailable_service_raises_instead_of_storing_character_fallbacks() -> None:
    socket = FakeSocket(available=False)
    client = SudachiClient(connect_factory=lambda *_args, **_kwargs: socket)

    with pytest.raises(SudachiUnavailableError):
        client.translate("食べた。")


def test_sudachi_filler_subcategory_preserves_tokenization_filter_contract() -> None:
    assert PartOfSpeech.from_sudachi("感動詞,フィラー,*,*,*,*") is PartOfSpeech.filler


def test_availability_probe_reuses_an_external_lease_without_configuring_sudachi() -> None:
    socket = FakeSocket(externally_enabled=True)
    client = SudachiClient(connect_factory=lambda *_args, **_kwargs: socket)

    assert client.is_available_without_loading() is True
    assert socket.sent == []


def test_availability_probe_does_not_load_disabled_sudachi() -> None:
    socket = FakeSocket(externally_enabled=False)
    client = SudachiClient(connect_factory=lambda *_args, **_kwargs: socket)

    assert client.is_available_without_loading() is False
    assert socket.sent == []


def test_configured_dictionary_is_sent_when_gsm_acquires_sudachi() -> None:
    socket = FakeSocket()
    client = SudachiClient(connect_factory=lambda *_args, **_kwargs: socket)
    client.configure(dictionary="full")

    client.translate("食べた。")

    assert {"type": "configure_sudachi", "dictionary": "full"} in socket.sent
    tokenize_message = next(message for message in socket.sent if message["type"] == "tokenize")
    assert tokenize_message["dictionary"] == "full"


def test_external_sudachi_reuse_does_not_acquire_or_reconfigure_the_service() -> None:
    socket = FakeSocket(externally_enabled=True)
    client = SudachiClient(connect_factory=lambda *_args, **_kwargs: socket)
    client.configure(acquire_feature=False)

    client.translate("食べた。")

    assert [message["type"] for message in socket.sent] == ["tokenize"]
    assert "dictionary" not in socket.sent[0]


def test_changing_dictionary_reconnects_and_invalidates_cached_tokens() -> None:
    first_socket = FakeSocket()
    second_socket = FakeSocket()
    sockets = iter((first_socket, second_socket))
    client = SudachiClient(connect_factory=lambda *_args, **_kwargs: next(sockets))

    client.translate("食べた。")
    client.configure(dictionary="full")
    client.translate("食べた。")

    assert any(message.get("dictionary") == "small" for message in first_socket.sent)
    assert any(message.get("dictionary") == "full" for message in second_socket.sent)
    assert sum(message["type"] == "tokenize" for message in first_socket.sent + second_socket.sent) == 2
