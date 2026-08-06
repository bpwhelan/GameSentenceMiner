from __future__ import annotations

from types import SimpleNamespace

from GameSentenceMiner import tokenizer as tokenizer_module
from GameSentenceMiner.sudachi import SudachiUnavailableError
from GameSentenceMiner.util.config.configuration import Experimental


class _Backend:
    def __init__(self, name: str) -> None:
        self.name = name
        self.calls: list[tuple[str, str]] = []
        self.configuration_calls: list[tuple[str | None, bool]] = []

    def configure(self, *, dictionary: str | None = None, acquire_feature: bool = True) -> None:
        self.configuration_calls.append((dictionary, acquire_feature))

    def translate(self, text: str):
        self.calls.append(("translate", text))
        return [self.name]

    def reading(self, text: str) -> str:
        self.calls.append(("reading", text))
        return f"{self.name}:{text}"

    def to_hiragana(self, text: str) -> str:
        self.calls.append(("to_hiragana", text))
        return f"{self.name}:{text}"


def _make_tokenizer(
    monkeypatch,
    *,
    enabled: bool,
    configured: str,
    sudachi_available: bool,
    dictionary: str = "small",
):
    mecab = _Backend("mecab")
    sudachi = _Backend("sudachi")
    availability_calls: list[bool] = []
    release_calls: list[bool] = []

    monkeypatch.setattr(tokenizer_module, "is_tokenization_enabled", lambda: enabled)
    monkeypatch.setattr(tokenizer_module, "get_tokenization_backend", lambda: configured)
    monkeypatch.setattr(tokenizer_module, "get_sudachi_dictionary", lambda: dictionary)
    monkeypatch.setattr(tokenizer_module, "_load_mecab", lambda: mecab)
    monkeypatch.setattr(tokenizer_module, "_load_sudachi", lambda: sudachi)
    monkeypatch.setattr(
        tokenizer_module,
        "_release_own_sudachi_lease",
        lambda: release_calls.append(True),
    )
    monkeypatch.setattr(
        tokenizer_module,
        "_is_sudachi_available_without_loading",
        lambda: availability_calls.append(True) or sudachi_available,
    )
    return tokenizer_module.Tokenizer(), mecab, sudachi, availability_calls, release_calls


def test_enabled_tokenization_uses_configured_sudachi_without_probing(monkeypatch) -> None:
    tokenizer, _mecab, sudachi, availability_calls, release_calls = _make_tokenizer(
        monkeypatch,
        enabled=True,
        configured="sudachi",
        sudachi_available=False,
    )

    assert tokenizer.translate("文") == ["sudachi"]
    assert sudachi.calls == [("translate", "文")]
    assert sudachi.configuration_calls == [("small", True)]
    assert availability_calls == []
    assert release_calls == []


def test_enabled_tokenization_can_select_mecab(monkeypatch) -> None:
    tokenizer, mecab, _sudachi, availability_calls, release_calls = _make_tokenizer(
        monkeypatch,
        enabled=True,
        configured="mecab",
        sudachi_available=True,
    )

    assert tokenizer.reading("文") == "mecab:文"
    assert mecab.calls == [("reading", "文")]
    assert availability_calls == []
    assert release_calls == [True]


def test_disabled_tokenization_reuses_available_sudachi(monkeypatch) -> None:
    tokenizer, _mecab, sudachi, availability_calls, release_calls = _make_tokenizer(
        monkeypatch,
        enabled=False,
        configured="mecab",
        sudachi_available=True,
    )

    assert tokenizer.to_hiragana("文") == "sudachi:文"
    assert sudachi.calls == [("to_hiragana", "文")]
    assert sudachi.configuration_calls == [(None, False)]
    assert availability_calls == [True]
    assert release_calls == []


def test_disabled_tokenization_uses_mecab_without_loading_sudachi(monkeypatch) -> None:
    tokenizer, mecab, sudachi, availability_calls, release_calls = _make_tokenizer(
        monkeypatch,
        enabled=False,
        configured="sudachi",
        sudachi_available=False,
    )

    assert tokenizer.translate("文") == ["mecab"]
    assert mecab.calls == [("translate", "文")]
    assert sudachi.calls == []
    assert availability_calls == [True]
    assert release_calls == []


def test_unavailable_sudachi_falls_back_to_mecab(monkeypatch) -> None:
    tokenizer, mecab, sudachi, _availability_calls, _release_calls = _make_tokenizer(
        monkeypatch,
        enabled=True,
        configured="sudachi",
        sudachi_available=False,
    )
    sudachi.translate = lambda _text: (_ for _ in ()).throw(SudachiUnavailableError("service unavailable"))

    assert tokenizer.translate("文") == ["mecab"]
    assert mecab.calls == [("translate", "文")]


def test_tokenization_backend_defaults_to_sudachi(monkeypatch) -> None:
    master = SimpleNamespace(experimental=SimpleNamespace())
    monkeypatch.setattr(tokenizer_module, "get_master_config", lambda: master)

    assert tokenizer_module.get_tokenization_backend() == "sudachi"


def test_unknown_tokenization_backend_normalizes_to_sudachi() -> None:
    assert tokenizer_module.normalize_tokenization_backend("unknown") == "sudachi"


def test_sudachi_dictionary_normalization_supports_small_core_and_full() -> None:
    assert tokenizer_module.normalize_sudachi_dictionary("small") == "small"
    assert tokenizer_module.normalize_sudachi_dictionary("core") == "core"
    assert tokenizer_module.normalize_sudachi_dictionary("FULL") == "full"
    assert tokenizer_module.normalize_sudachi_dictionary("unknown") == "small"


def test_experimental_config_serializes_sudachi_default_and_mecab_selection() -> None:
    assert "enable_hoshidicts" not in Experimental().to_dict()
    assert Experimental().to_dict()["tokenization_backend"] == "sudachi"
    assert Experimental(tokenization_backend="mecab").to_dict()["tokenization_backend"] == "mecab"
    assert Experimental().to_dict()["tokenization_sudachi_dictionary"] == "small"
    assert Experimental(tokenization_sudachi_dictionary="full").to_dict()["tokenization_sudachi_dictionary"] == "full"
