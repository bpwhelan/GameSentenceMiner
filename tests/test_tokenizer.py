from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from GameSentenceMiner import tokenizer as tokenizer_module
from GameSentenceMiner.sudachi import SudachiUnavailableError
from GameSentenceMiner.util.config.configuration import Experimental


@pytest.mark.parametrize("method", ["translate", "reading", "to_hiragana"])
@pytest.mark.parametrize("enabled", [True, False])
def test_all_callers_use_shared_sudachi_independently_of_statistics(monkeypatch, method, enabled):
    backend = Mock()
    getattr(backend, method).return_value = "result"
    monkeypatch.setattr(tokenizer_module, "_load_sudachi", lambda: backend)
    monkeypatch.setattr(
        tokenizer_module,
        "get_master_config",
        lambda: SimpleNamespace(
            experimental=SimpleNamespace(enable_tokenization=enabled, tokenization_backend="mecab")
        ),
    )
    assert getattr(tokenizer_module.Tokenizer(), method)("日本語") == "result"
    getattr(backend, method).assert_called_once_with("日本語")
    backend.configure.assert_called_once_with(dictionary="small", acquire_feature=True)


@pytest.mark.parametrize("method", ["translate", "reading", "to_hiragana"])
def test_unavailable_sudachi_requires_setup_without_fallback(monkeypatch, method):
    backend = Mock()
    getattr(backend, method).side_effect = SudachiUnavailableError("Complete Japanese dictionary setup and retry.")
    monkeypatch.setattr(tokenizer_module, "_load_sudachi", lambda: backend)
    with pytest.raises(SudachiUnavailableError, match="setup"):
        getattr(tokenizer_module.Tokenizer(), method)("日本語")


@pytest.mark.parametrize("old", ["mecab", "MeCab", "unknown", None, "sudachi"])
def test_saved_backend_is_migrated_without_changing_dictionary(old):
    config = Experimental.from_dict({"tokenization_backend": old, "tokenization_sudachi_dictionary": "full"})
    assert config.to_dict()["tokenization_backend"] == "sudachi"
    assert config.tokenization_sudachi_dictionary == "full"
    assert tokenizer_module.normalize_tokenization_backend(old) == "sudachi"


def test_dictionary_normalization():
    for value in ("small", "core", "full"):
        assert tokenizer_module.normalize_sudachi_dictionary(value.upper()) == value
    assert tokenizer_module.normalize_sudachi_dictionary("unknown") == "small"
