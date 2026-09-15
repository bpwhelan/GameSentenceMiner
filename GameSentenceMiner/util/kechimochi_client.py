"""Client for Kechimochi's desktop HTTP automation API."""

from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

import requests

DEFAULT_KECHIMOCHI_URL = "http://127.0.0.1:3031"


class KechimochiSyncError(RuntimeError):
    pass


class KechimochiConnectionError(KechimochiSyncError):
    """Kechimochi's HTTP API is unreachable or timed out."""


class KechimochiHTTPError(KechimochiSyncError):
    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.status_code = status_code


def normalize_kechimochi_url(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Enter the Kechimochi HTTP API URL")
    try:
        parts = urlsplit(value.strip())
        port = parts.port
    except ValueError as exc:
        raise ValueError("Invalid Kechimochi HTTP API URL") from exc
    if (
        parts.scheme not in {"http", "https"}
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
        or (port is not None and port == 0)
        or any(character.isspace() for character in value.strip())
    ):
        raise ValueError("Use an http:// or https:// URL without credentials, query parameters, or fragments")
    path = parts.path.rstrip("/")
    path = path.removesuffix("/api")
    return urlunsplit((parts.scheme, parts.netloc.lower(), path, "", ""))


class KechimochiClient:
    def __init__(self, base_url: str = DEFAULT_KECHIMOCHI_URL, *, session=None):
        self.base_url = normalize_kechimochi_url(base_url)
        self.session = session or requests.Session()
        # Desktop automation must not send local data through an environment proxy.
        self.session.trust_env = False

    def close(self):
        self.session.close()

    def _request(self, method: str, path: str, **kwargs):
        try:
            response = self.session.request(
                method,
                f"{self.base_url}/api/{path}",
                headers={"Accept": "application/json", "X-Kechimochi-API": "1"},
                timeout=(5, 30),
                allow_redirects=False,
                **kwargs,
            )
        except requests.RequestException as exc:
            # Never automatically repeat a POST: the server may already have committed it.
            error_type = (
                KechimochiConnectionError
                if isinstance(exc, (requests.ConnectionError, requests.Timeout))
                else KechimochiSyncError
            )
            raise error_type(
                "Could not reach Kechimochi. Open it and enable its HTTP API; the next sync will retry safely."
            ) from exc
        if not 200 <= response.status_code < 300:
            hint = (
                " Check the HTTP API scope and allowed address in Kechimochi."
                if response.status_code == 403
                else " Check that this URL points to the Kechimochi HTTP API."
            )
            raise KechimochiHTTPError(
                f"Kechimochi {method} {path} failed (HTTP {response.status_code}).{hint}", response.status_code
            )
        try:
            return response.json()
        except ValueError as exc:
            raise KechimochiSyncError("Kechimochi returned an invalid JSON response") from exc

    def version(self) -> str:
        value = self._request("GET", "version")
        if not isinstance(value, str):
            raise KechimochiSyncError("Kechimochi returned an invalid API version")
        return value

    def _list(self, path, fields):
        value = self._request("GET", path)
        if not isinstance(value, list) or any(
            not isinstance(row, dict) or not fields.issubset(row) or type(row.get("id")) is not int or row["id"] <= 0
            for row in value
        ):
            raise KechimochiSyncError(f"Kechimochi returned an invalid {path} list")
        if len({row["id"] for row in value}) != len(value):
            raise KechimochiSyncError(f"Kechimochi returned duplicate IDs in {path}")
        return value

    def get_media(self):
        return self._list("media", {"title", "extra_data", "language", "content_type"})

    def get_logs(self):
        return self._list("logs", {"media_id", "date", "characters", "duration_minutes", "notes", "activity_type"})

    def _save(self, path, payload, record_id):
        if record_id is not None:
            self._request("PUT", f"{path}/{record_id}", json={**payload, "id": record_id})
            return record_id
        result = self._request("POST", path, json={**payload, "id": None})
        if type(result) is not int or result <= 0:
            raise KechimochiSyncError(f"Kechimochi did not return the new {path} ID; retry to reconcile it")
        return result

    def save_media(self, payload, media_id=None):
        return self._save("media", payload, media_id)

    def save_log(self, payload, log_id=None):
        return self._save("logs", payload, log_id)

    def delete_log(self, log_id):
        self._request("DELETE", f"logs/{log_id}")

    def upload_cover(self, media_id, image_bytes):
        return self._request("POST", f"covers/{media_id}", files={"file": ("gsm-cover.jpg", image_bytes, "image/jpeg")})
