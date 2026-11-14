"""Runtime-only dictionary setup, shared by desktop onboarding and overlay settings."""

import threading

from .client import SudachiClient, SudachiUnavailableError

_lock = threading.Lock()
_installing = False
_install_error: str | None = None


def dictionary_status() -> dict:
    with _lock:
        if _installing:
            return {"state": "installing"}
        error = _install_error
    from GameSentenceMiner.tokenizer import get_sudachi_dictionary

    client = SudachiClient(dictionary=get_sudachi_dictionary())
    try:
        status = client.dictionary_setup()
        if error:
            status.update(state="error", error=error)
        return status
    except SudachiUnavailableError as exc:
        return {"state": "error", "error": str(exc)}
    finally:
        client.close()


def install_dictionary(dictionary: str | None = None) -> dict:
    global _installing, _install_error
    with _lock:
        if _installing:
            return {"state": "installing"}
        _installing, _install_error = True, None

    def install():
        global _installing, _install_error
        from GameSentenceMiner.tokenizer import get_sudachi_dictionary

        client = SudachiClient(dictionary=get_sudachi_dictionary())
        try:
            result = client.dictionary_setup(install=True, dictionary=dictionary)
            if result.get("state") != "ready":
                raise SudachiUnavailableError(result.get("error") or "Dictionary setup failed. Retry setup.")
        except Exception as exc:
            with _lock:
                _install_error = str(exc)
        finally:
            client.close()
            with _lock:
                _installing = False

    threading.Thread(target=install, name="sudachi-setup", daemon=True).start()
    return {"state": "installing"}
