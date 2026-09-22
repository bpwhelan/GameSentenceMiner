"""HTTP client for the encrypted, expiring relay protocol. No plaintext fallback."""

import json
import re
import time
import uuid
from urllib.parse import urlsplit

import requests

from GameSentenceMiner.util.cloud_sync.store import validate_record


class SyncProtocolError(RuntimeError):
    pass


def validate_relay_url(url):
    value = str(url or "").strip().rstrip("/")
    parsed = urlsplit(value)
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (
        not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or (parsed.scheme != "https" and not (local and parsed.scheme == "http"))
    ):
        raise ValueError("Sync requires an HTTPS relay URL (HTTP is allowed on localhost for development).")
    return value


def _integer(value):
    return type(value) is int and 0 <= value < 2**53


class RelayClient:
    def __init__(self, store, cipher, api_url, token, timeout=30, settings_provider=None, settings_apply=None):
        self.store, self.cipher = store, cipher
        self.url = f"{validate_relay_url(api_url)}/api/sync/v2/{cipher.room}"
        self.token, self.timeout = token, timeout
        self.settings_provider = settings_provider or (dict)
        self.settings_apply = settings_apply or (lambda values: None)

    def request(self, path, body=None, method=None):
        method = method or ("POST" if body is not None else "GET")
        for attempt in range(3):
            try:
                with requests.request(
                    method,
                    self.url + path,
                    json=body,
                    headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
                    timeout=self.timeout,
                    allow_redirects=False,
                    stream=True,
                ) as response:
                    if response.status_code in {429, 502, 503, 504} and attempt < 2:
                        time.sleep(0.5 * (2**attempt))
                        continue
                    chunks, size = [], 0
                    for chunk in response.iter_content(64 * 1024):
                        size += len(chunk)
                        if size > 1_200_000:
                            raise SyncProtocolError("Relay response exceeds the size limit.")
                        chunks.append(chunk)
                    try:
                        result = json.loads(b"".join(chunks))
                    except (ValueError, UnicodeError) as exc:
                        raise SyncProtocolError("Relay returned an invalid response.") from exc
                    if not 200 <= response.status_code < 300:
                        if isinstance(result, dict) and result.get("error") == "resync_required":
                            raise SyncProtocolError(
                                "Sync history expired. Prepare a device transfer on an up-to-date device, then sync again."
                            )
                        raise SyncProtocolError(f"Relay request failed (HTTP {response.status_code}).")
                    if not isinstance(result, dict):
                        raise SyncProtocolError("Relay returned an invalid response.")
                    return result
            except (requests.Timeout, requests.ConnectionError):
                if attempt == 2:
                    raise SyncProtocolError("Relay is unavailable; local changes remain queued.") from None
                time.sleep(0.5 * (2**attempt))
            except requests.RequestException:
                raise SyncProtocolError("Could not contact the configured relay.") from None

    def remote_state(self):
        state = self.request("/state")
        if (
            state.get("protocol") != 2
            or not isinstance(state.get("generation"), str)
            or not state["generation"]
            or not _integer(state.get("head"))
            or not _integer(state.get("floor"))
            or state["floor"] > state["head"]
        ):
            raise SyncProtocolError("The server does not support GSM encrypted sync v2.")
        return state

    def _records(self, payload, context, snapshot_metadata=None):
        document = self.cipher.decrypt(payload, context)
        if snapshot_metadata is not None and document.get("snapshot") != snapshot_metadata:
            raise SyncProtocolError("The encrypted device transfer manifest does not match the relay response.")
        records = document.get("records")
        if document.get("protocol") != 2 or not isinstance(records, list) or len(records) > 5000:
            raise SyncProtocolError("Unsupported encrypted sync document.")
        for record in records:
            validate_record(record)
        return records

    def _bootstrap(self, remote):
        snapshot = remote.get("snapshot")
        if (
            not isinstance(snapshot, dict)
            or not re.fullmatch("[a-f0-9]{32}", str(snapshot.get("id", "")))
            or not _integer(snapshot.get("base"))
            or not remote["floor"] <= snapshot["base"] <= remote["head"]
            or not _integer(snapshot.get("parts"))
            or not 1 <= snapshot["parts"] <= 1024
        ):
            raise SyncProtocolError(
                "A device transfer is needed. Prepare one on an up-to-date device, then sync again."
            )
        self.store.clear_staging()
        try:
            received = 0
            for part in range(snapshot["parts"]):
                chunk = self.request(f"/snapshot/{snapshot['id']}/{part}")
                metadata = {
                    "id": snapshot["id"],
                    "generation": remote["generation"],
                    "base": snapshot["base"],
                    "parts": snapshot["parts"],
                    "part": part,
                }
                records = self._records(chunk.get("payload"), f"snapshot:{snapshot['id']}:{part}", metadata)
                self.store.stage_records(records)
                received += len(records)
            latest = self.remote_state()
            if (
                latest["generation"] != remote["generation"]
                or latest["floor"] > snapshot["base"]
                or not latest.get("snapshot")
                or latest["snapshot"]["id"] != snapshot["id"]
            ):
                raise SyncProtocolError("The device transfer changed or expired; retry sync.")
            # No imported row/cursor is visible until every part authenticates.
            stats = self.store.accept_staged(remote["generation"], snapshot["base"])
            return {**stats, "received": received}
        finally:
            self.store.clear_staging()

    def _outgoing(self):
        outgoing, size = [], 0
        for item in self.store.pending():
            payload = item["payload"]
            if payload is None:
                payload = self.cipher.encrypt(
                    {"protocol": 2, "records": [json.loads(item["record"])]}, f"event:{item['id']}"
                )
                self.store.set_payload(item["id"], payload)
            if outgoing and size + len(payload) > 900_000:
                break
            outgoing.append({"id": item["id"], "payload": payload})
            size += len(payload) + 100
        return outgoing

    def _apply_preferences(self):
        current = self.settings_provider()
        self.store.capture_settings(current)
        desired = self.store.settings_to_apply(current)
        if desired:
            self.settings_apply(desired)
            self.store.mark_settings_applied(desired)
        return len(desired)

    def sync(self, max_rounds=5, publish_snapshot=False, reseed=False):
        remote = self.remote_state()
        local = self.store.state()
        self.store.capture_lines(seed=not local.get("seeded", False))
        self.store.update_state(seeded=True)
        same_generation = local.get("generation") == remote["generation"]
        in_window = remote["floor"] <= local.get("cursor", 0) <= remote["head"]
        bootstrap_stats = {"upserts": 0, "deletes": 0, "received": 0}
        if not same_generation or not in_window:
            if remote.get("snapshot"):
                bootstrap_stats = self._bootstrap(remote)
            elif remote["head"] == 0 and (not local.get("generation") or reseed):
                self.store.update_state(generation=remote["generation"], cursor=0, needs_snapshot=True)
            else:
                self._bootstrap(remote)  # Clear recovery error; never silently skip history.
        applied_settings = self._apply_preferences()
        self.store.capture_settings(self.settings_provider())
        sent = rounds = 0
        received, upserts, deletes = bootstrap_stats["received"], bootstrap_stats["upserts"], bootstrap_stats["deletes"]
        has_more = False
        while max_rounds is None or rounds < max(1, int(max_rounds)):
            self.store.capture_lines()
            self.store.capture_settings(self.settings_provider())
            state = self.store.state()
            outgoing = self._outgoing()
            body = self.request(
                "/exchange",
                {"generation": state["generation"], "cursor": state["cursor"], "changes": outgoing, "limit": 100},
            )
            changes, accepted = body.get("changes"), body.get("accepted_ids")
            expected = {item["id"] for item in outgoing}
            if (
                body.get("protocol") != 2
                or body.get("generation") != state["generation"]
                or not isinstance(accepted, list)
                or any(not isinstance(item, str) for item in accepted)
                or len(accepted) != len(expected)
                or set(accepted) != expected
                or not isinstance(changes, list)
                or len(changes) > 100
                or type(body.get("has_more")) is not bool
                or not _integer(body.get("cursor"))
            ):
                raise SyncProtocolError("Invalid relay acknowledgement; changes remain queued.")
            records, cursor = [], state["cursor"]
            for change in changes:
                if (
                    not isinstance(change, dict)
                    or change.get("seq") != cursor + 1
                    or not re.fullmatch("[a-f0-9]{32}", str(change.get("id", "")))
                ):
                    raise SyncProtocolError("Relay returned a non-contiguous change page.")
                records.extend(self._records(change.get("payload"), f"event:{change['id']}"))
                cursor = change["seq"]
            if body["cursor"] != cursor or (body["has_more"] and not changes):
                raise SyncProtocolError("Relay returned an invalid download cursor.")
            # Capture config edits made while the request was in flight.
            self.store.capture_settings(self.settings_provider())
            stats = self.store.accept(records, accepted, state["generation"], cursor)
            applied_settings += self._apply_preferences()
            sent += len(accepted)
            received += len(records)
            upserts += stats["upserts"]
            deletes += stats["deletes"]
            rounds += 1
            has_more = body["has_more"]
            self.store.capture_lines()
            if not has_more and not self.store.pending_count():
                break
        pending = self.store.pending_count()
        complete = not has_more and not pending
        snapshot = None
        if complete and (publish_snapshot or self.store.state().get("needs_snapshot")):
            snapshot = self.publish_transfer()
            self.store.update_state(needs_snapshot=False)
        return {
            "status": "success" if complete else "partial",
            "rounds": rounds,
            "since_seq": self.store.state()["cursor"],
            "sent_changes": sent,
            "acked_changes": sent,
            "received_changes": received,
            "applied_remote_upserts": upserts,
            "applied_remote_deletes": deletes,
            "applied_settings": applied_settings,
            "pending_changes_after": pending,
            "has_more_after_last_round": has_more,
            "stop_reason": "completed" if complete else "round_limit_reached",
            "snapshot": snapshot,
        }

    def publish_transfer(self):
        state = self.store.freeze_snapshot(settings_keys=set(self.settings_provider()))
        identity = uuid.uuid4().hex
        try:
            parts = max(1, sum(1 for _ in self.store.staged_pages()))
            if parts > 1024:
                raise SyncProtocolError("Device transfer exceeds the relay size limit.")
            self.request(
                "/snapshot/start",
                {"generation": state["generation"], "base": state["cursor"], "parts": parts, "id": identity},
            )
            pages = self.store.staged_pages()
            for part in range(parts):
                records = next(pages, [])
                metadata = {
                    "id": identity,
                    "generation": state["generation"],
                    "base": state["cursor"],
                    "parts": parts,
                    "part": part,
                }
                payload = self.cipher.encrypt(
                    {"protocol": 2, "records": records, "snapshot": metadata}, f"snapshot:{identity}:{part}"
                )
                self.request(f"/snapshot/{identity}/{part}", {"payload": payload}, "PUT")
            return self.request(f"/snapshot/{identity}/commit", {}).get("snapshot")
        finally:
            self.store.clear_staging()
