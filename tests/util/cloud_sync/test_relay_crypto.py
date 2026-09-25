import pytest

from GameSentenceMiner.util.cloud_sync.crypto import SyncCipher, new_sync_key


def test_roundtrip_and_random_nonces():
    cipher = SyncCipher(new_sync_key())
    data = {"records": [{"text": "日本語", "setting": "secret preference"}]}
    first = cipher.encrypt(data, "event:one")
    second = cipher.encrypt(data, "event:one")
    assert first != second
    assert "日本語" not in first
    assert cipher.decrypt(first, "event:one") == data


def test_wrong_key_context_and_modified_payload_are_rejected():
    cipher = SyncCipher(new_sync_key())
    payload = cipher.encrypt({"records": []}, "event:one")
    for other, context, value in [
        (SyncCipher(new_sync_key()), "event:one", payload),
        (cipher, "event:two", payload),
        (cipher, "event:one", payload[:-4] + "AAAA"),
    ]:
        with pytest.raises(ValueError):
            other.decrypt(value, context)


@pytest.mark.parametrize("key", ["", "password", "a" * 43, "!" * 43])
def test_only_generated_256_bit_key_format_is_accepted(key):
    with pytest.raises(ValueError):
        SyncCipher(key)
