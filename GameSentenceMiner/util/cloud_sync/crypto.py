"""Authenticated encryption for the relay. The random pairing key stays local."""

import base64
import hashlib
import json
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAX_PLAINTEXT = 500_000


def new_sync_key() -> str:
    return "gsm2_" + base64.urlsafe_b64encode(os.urandom(32)).decode("ascii").rstrip("=")


class SyncCipher:
    def __init__(self, key: str):
        try:
            if not isinstance(key, str) or not key.startswith("gsm2_") or len(key) != 48:
                raise ValueError
            raw = base64.b64decode(key[5:] + "=", altchars=b"-_", validate=True)
            if len(raw) != 32 or base64.urlsafe_b64encode(raw).decode().rstrip("=") != key[5:]:
                raise ValueError
        except (ValueError, TypeError) as exc:
            raise ValueError("Use a generated GSM sync key (gsm2_ followed by 43 characters).") from exc
        self.room = hashlib.sha256(b"gsm-sync-room-v2\0" + raw).hexdigest()
        encryption_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"gsm-sync-aes256-v2").derive(raw)
        self._aes = AESGCM(encryption_key)

    def _aad(self, context: str) -> bytes:
        return f"gsm-sync/v2/{self.room}/{context}".encode()

    def encrypt(self, value: dict, context: str) -> str:
        plaintext = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(plaintext) > MAX_PLAINTEXT:
            raise ValueError("Sync record exceeds the encrypted transfer size limit.")
        nonce = os.urandom(12)
        return base64.b64encode(nonce + self._aes.encrypt(nonce, plaintext, self._aad(context))).decode("ascii")

    def decrypt(self, value: str, context: str) -> dict:
        try:
            if not isinstance(value, str) or len(value) > 700_000:
                raise ValueError
            encrypted = base64.b64decode(value, validate=True)
            plaintext = self._aes.decrypt(encrypted[:12], encrypted[12:], self._aad(context))
            if len(plaintext) > MAX_PLAINTEXT:
                raise ValueError
            decoded = json.loads(plaintext)
            if not isinstance(decoded, dict):
                raise TypeError
            return decoded
        except (InvalidTag, ValueError, TypeError, UnicodeError) as exc:
            raise ValueError("Cannot authenticate sync data. Check the pairing key and relay.") from exc
