"""Local LWW registers, persistent tombstones and an atomic upload outbox.

Versions are Lamport counters with a deterministic device tie-breaker; clocks
on different PCs need not agree. Local edits, remote records, acknowledgements
and the download cursor are committed through GSM's single SQLite writer.
"""

import hashlib
import json
import math
import time
import uuid


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def install_tracking(db):
    def install(conn):
        conn.execute("CREATE TABLE IF NOT EXISTS sync_v2_dirty (id TEXT PRIMARY KEY)")
        for operation, reference in (("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")):
            condition = ""
            if operation == "UPDATE":
                condition = "WHEN " + " OR ".join(
                    f"OLD.{field} IS NOT NEW.{field}"
                    for field in ("game_name", "line_text", "language", "timestamp", "note_ids")
                )
            conn.execute(f"""CREATE TRIGGER IF NOT EXISTS gsm_sync_v2_{operation.lower()}
                AFTER {operation} ON game_lines {condition} BEGIN
                INSERT OR IGNORE INTO sync_v2_dirty(id) VALUES({reference}.id); END""")
        conn.execute("CREATE TABLE IF NOT EXISTS sync_v2_state (scope TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute("""CREATE TABLE IF NOT EXISTS sync_v2_records (
            scope TEXT, kind TEXT, id TEXT, record TEXT NOT NULL, PRIMARY KEY(scope,kind,id))""")
        conn.execute("""CREATE TABLE IF NOT EXISTS sync_v2_outbox (
            scope TEXT, id TEXT, kind TEXT, record_id TEXT, record TEXT, payload TEXT,
            PRIMARY KEY(scope,id))""")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sync_v2_settings_seen (scope TEXT, id TEXT, value TEXT, PRIMARY KEY(scope,id))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sync_v2_staging (scope TEXT, position INTEGER, record TEXT, PRIMARY KEY(scope,position))"
        )

    db.run_transaction(install)


def validate_record(record):
    if not isinstance(record, dict) or set(record) != {"kind", "id", "version", "deleted", "data"}:
        raise ValueError("Invalid encrypted sync record.")
    kind, identity, version = record["kind"], record["id"], record["version"]
    if kind not in {"line", "setting"} or not isinstance(identity, str) or not 1 <= len(identity) <= 512:
        raise ValueError("Invalid sync record identity.")
    if (
        not isinstance(version, list)
        or len(version) != 2
        or type(version[0]) is not int
        or not 0 <= version[0] < 2**53 - 1
        or not isinstance(version[1], str)
        or not 1 <= len(version[1]) <= 128
        or type(record["deleted"]) is not bool
    ):
        raise ValueError("Invalid sync record version.")
    data = record["data"]
    if kind == "setting":
        from GameSentenceMiner.util.cloud_sync.settings import validate_setting

        if record["deleted"]:
            raise ValueError("Settings resets must contain the default value.")
        validate_setting(identity, data)
    elif record["deleted"]:
        if data is not None:
            raise ValueError("Deleted sync records cannot contain data.")
    else:
        if not isinstance(data, dict) or set(data) != {
            "game_name",
            "line_text",
            "language",
            "timestamp",
            "note_ids",
            "last_modified",
        }:
            raise ValueError("Invalid game line fields.")
        if any(not isinstance(data[key], str) for key in ("game_name", "line_text", "language")):
            raise ValueError("Invalid game line text.")
        if any(
            type(data[key]) not in (int, float) or not math.isfinite(data[key])
            for key in ("timestamp", "last_modified")
        ):
            raise ValueError("Invalid game line timestamp.")
        if not isinstance(data["note_ids"], list) or any(not isinstance(item, str) for item in data["note_ids"]):
            raise ValueError("Invalid game line note IDs.")
    if len(encode(record).encode("utf-8")) > 450_000:
        raise ValueError("Sync record exceeds the size limit.")


class RelayStore:
    def __init__(self, db, scope, device_id):
        self.db, self.scope, self.device_id = db, scope, device_id
        install_tracking(db)

    def _state(self, conn):
        row = conn.execute("SELECT value FROM sync_v2_state WHERE scope=?", (self.scope,)).fetchone()
        return json.loads(row[0]) if row else {}

    def _save_state(self, conn, state):
        conn.execute("INSERT OR REPLACE INTO sync_v2_state VALUES(?,?)", (self.scope, encode(state)))

    def state(self):
        return self.db.run_transaction(self._state)

    def update_state(self, **values):
        def update(conn):
            state = self._state(conn)
            state.update(values)
            self._save_state(conn, state)

        self.db.run_transaction(update)

    def _get_record(self, conn, kind, identity):
        row = conn.execute(
            "SELECT record FROM sync_v2_records WHERE scope=? AND kind=? AND id=?", (self.scope, kind, identity)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def _put_record(self, conn, record):
        conn.execute(
            "INSERT OR REPLACE INTO sync_v2_records VALUES(?,?,?,?)",
            (self.scope, record["kind"], record["id"], encode(record)),
        )

    def _local(self, conn, kind, identity, value, deleted=False, seed=False):
        old = self._get_record(conn, kind, identity)
        if old and old["data"] == value and old["deleted"] == deleted:
            return
        state = self._state(conn)
        if seed and not old:
            digest = hashlib.sha256(encode([value, deleted]).encode()).hexdigest()
            # Imported legacy tombstones must dominate unversioned old copies
            # of a line on newly paired devices.
            version = [0, f"tombstone:{digest}" if deleted else digest]
        else:
            state["clock"] = int(state.get("clock", 0)) + 1
            version = [state["clock"], self.device_id]
        record = {"kind": kind, "id": identity, "version": version, "deleted": deleted, "data": value}
        validate_record(record)
        self._put_record(conn, record)
        # Compact obsolete queued versions; acknowledgements always target the
        # immutable event ID, never the row ID that can acquire a newer edit.
        conn.execute(
            "DELETE FROM sync_v2_outbox WHERE scope=? AND kind=? AND record_id=?", (self.scope, kind, identity)
        )
        conn.execute(
            "INSERT INTO sync_v2_outbox VALUES(?,?,?,?,?,NULL)",
            (self.scope, uuid.uuid4().hex, kind, identity, encode(record)),
        )
        self._save_state(conn, state)

    def _capture_line(self, conn, identity, seed=False):
        row = conn.execute(
            "SELECT game_name,line_text,language,timestamp,note_ids,last_modified FROM game_lines WHERE id=?",
            (identity,),
        ).fetchone()
        data = None
        if row:
            try:
                notes = json.loads(row[4] or "[]")
            except (ValueError, TypeError):
                notes = []
            if not isinstance(notes, list):
                notes = [notes]
            data = dict(
                zip(
                    ("game_name", "line_text", "language", "timestamp", "note_ids", "last_modified"),
                    (
                        str(row[0] or ""),
                        str(row[1] or ""),
                        str(row[2] or ""),
                        float(row[3] or 0),
                        [str(note) for note in notes],
                        float(row[5] or 0),
                    ),
                )
            )
        self._local(conn, "line", identity, data, deleted=row is None, seed=seed)
        conn.execute("DELETE FROM sync_v2_dirty WHERE id=?", (identity,))

    def capture_lines(self, seed=False):
        def capture(conn):
            active = conn.execute("SELECT value FROM sync_v2_state WHERE scope='active_scope'").fetchone()
            if not active or active[0] != self.scope:
                # Switching relay/account must not miss edits captured while a
                # different scope was active, including lines deleted there.
                conn.execute("INSERT OR IGNORE INTO sync_v2_dirty SELECT id FROM game_lines")
                conn.execute(
                    """INSERT OR IGNORE INTO sync_v2_dirty SELECT id FROM sync_v2_records
                    WHERE scope=? AND kind='line' AND json_extract(record,'$.deleted')=0
                    AND id NOT IN (SELECT id FROM game_lines)""",
                    (self.scope,),
                )
                conn.execute("INSERT OR REPLACE INTO sync_v2_state VALUES('active_scope',?)", (self.scope,))
            if seed:
                conn.execute(
                    """INSERT OR IGNORE INTO sync_v2_dirty SELECT id FROM game_lines
                    WHERE id NOT IN (SELECT id FROM sync_v2_records WHERE scope=? AND kind='line')""",
                    (self.scope,),
                )
                # Preserve deletions queued before the v2 triggers were installed.
                if conn.execute("SELECT 1 FROM sqlite_master WHERE name='sync_game_line_changes'").fetchone():
                    conn.execute(
                        """INSERT OR IGNORE INTO sync_v2_dirty SELECT line_id FROM sync_game_line_changes
                        WHERE change_type='delete' AND line_id NOT IN
                        (SELECT id FROM sync_v2_records WHERE scope=? AND kind='line')""",
                        (self.scope,),
                    )
            ids = conn.execute("SELECT id FROM sync_v2_dirty LIMIT 1000").fetchall()
            for (identity,) in ids:
                self._capture_line(conn, identity, seed=seed)
            return len(ids)

        total = 0
        while True:
            count = self.db.run_transaction(capture)
            total += count
            if count < 1000:
                return total

    def pending(self, limit=100):
        def get(conn):
            return [
                dict(zip(("id", "record", "payload"), row))
                for row in conn.execute(
                    "SELECT id,record,payload FROM sync_v2_outbox WHERE scope=? ORDER BY rowid LIMIT ?",
                    (self.scope, limit),
                )
            ]

        return self.db.run_transaction(get)

    def set_payload(self, identity, payload):
        self.db.run_transaction(
            lambda conn: conn.execute(
                "UPDATE sync_v2_outbox SET payload=? WHERE scope=? AND id=? AND payload IS NULL",
                (payload, self.scope, identity),
            )
        )

    def pending_count(self):
        return self.db.run_transaction(
            lambda conn: conn.execute("SELECT COUNT(*) FROM sync_v2_outbox WHERE scope=?", (self.scope,)).fetchone()[0]
        )

    def accept(self, records, accepted_ids, generation, cursor):
        def apply(conn):
            upserts = deletes = 0
            for record in records:
                validate_record(record)
                kind, identity = record["kind"], record["id"]
                if kind == "line" and conn.execute("SELECT 1 FROM sync_v2_dirty WHERE id=?", (identity,)).fetchone():
                    self._capture_line(conn, identity)
                state = self._state(conn)
                state["clock"] = max(int(state.get("clock", 0)), record["version"][0])
                self._save_state(conn, state)
                old = self._get_record(conn, kind, identity)
                if old and tuple(old["version"]) >= tuple(record["version"]):
                    continue
                self._put_record(conn, record)
                if kind != "line":
                    continue
                if record["deleted"]:
                    conn.execute("DELETE FROM game_lines WHERE id=?", (identity,))
                    deletes += 1
                else:
                    data = record["data"]
                    conn.execute(
                        """INSERT INTO game_lines
                        (id,game_name,line_text,language,timestamp,note_ids,last_modified,original_game_name,game_id,created_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                        game_name=excluded.game_name,line_text=excluded.line_text,language=excluded.language,
                        timestamp=excluded.timestamp,note_ids=excluded.note_ids,last_modified=excluded.last_modified""",
                        (
                            identity,
                            data["game_name"],
                            data["line_text"],
                            data["language"],
                            data["timestamp"],
                            encode(data["note_ids"]),
                            data["last_modified"],
                            data["game_name"],
                            "",
                            time.time(),
                        ),
                    )
                    upserts += 1
                conn.execute("DELETE FROM sync_v2_dirty WHERE id=?", (identity,))
                if conn.execute("SELECT 1 FROM sqlite_master WHERE name='sync_game_line_changes'").fetchone():
                    conn.execute("DELETE FROM sync_game_line_changes WHERE line_id=?", (identity,))
            for identity in accepted_ids:
                conn.execute("DELETE FROM sync_v2_outbox WHERE scope=? AND id=?", (self.scope, identity))
            state = self._state(conn)
            state.update(generation=generation, cursor=cursor)
            self._save_state(conn, state)
            return {"upserts": upserts, "deletes": deletes}

        return self.db.run_transaction(apply)

    def snapshot_records(self):
        return self.db.run_transaction(
            lambda conn: [
                json.loads(row[0])
                for row in conn.execute(
                    "SELECT record FROM sync_v2_records WHERE scope=? ORDER BY kind,id", (self.scope,)
                )
            ]
        )

    def clear_staging(self):
        self.db.run_transaction(lambda conn: conn.execute("DELETE FROM sync_v2_staging WHERE scope=?", (self.scope,)))

    def stage_records(self, records):
        for record in records:
            validate_record(record)

        def stage(conn):
            start = conn.execute(
                "SELECT COALESCE(MAX(position),0) FROM sync_v2_staging WHERE scope=?", (self.scope,)
            ).fetchone()[0]
            conn.executemany(
                "INSERT INTO sync_v2_staging VALUES(?,?,?)",
                [(self.scope, start + index + 1, encode(record)) for index, record in enumerate(records)],
            )

        self.db.run_transaction(stage)

    def freeze_snapshot(self, settings_keys=None):
        def freeze(conn):
            conn.execute("DELETE FROM sync_v2_staging WHERE scope=?", (self.scope,))
            conn.execute(
                """INSERT INTO sync_v2_staging SELECT scope,ROW_NUMBER() OVER(ORDER BY kind,id),record
                FROM sync_v2_records WHERE scope=?""",
                (self.scope,),
            )
            if settings_keys is not None:
                placeholders = ",".join("?" for _ in settings_keys)
                predicate = f"AND json_extract(record,'$.id') NOT IN ({placeholders})" if settings_keys else ""
                conn.execute(
                    f"""DELETE FROM sync_v2_staging WHERE scope=?
                    AND json_extract(record,'$.kind')='setting' {predicate}""",
                    (self.scope, *settings_keys),
                )
            return self._state(conn)

        return self.db.run_transaction(freeze)

    def staged_pages(self, max_bytes=450_000):
        position = 0
        page, size = [], 0
        while True:
            rows = self.db.run_transaction(
                lambda conn, position=position: conn.execute(
                    "SELECT position,record FROM sync_v2_staging WHERE scope=? AND position>? ORDER BY position LIMIT 200",
                    (self.scope, position),
                ).fetchall()
            )
            if not rows:
                break
            for position, raw in rows:
                length = len(raw.encode("utf-8")) + 1
                if page and size + length > max_bytes:
                    yield page
                    page, size = [], 0
                page.append(json.loads(raw))
                size += length
        if page:
            yield page

    def accept_staged(self, generation, cursor):
        def apply(conn):
            records = (
                json.loads(row[0])
                for row in conn.execute(
                    "SELECT record FROM sync_v2_staging WHERE scope=? ORDER BY position", (self.scope,)
                )
            )
            return self.accept(records, [], generation, cursor)

        return self.db.run_transaction(apply)

    def capture_settings(self, values):
        def capture(conn):
            for (key,) in conn.execute(
                "SELECT DISTINCT record_id FROM sync_v2_outbox WHERE scope=? AND kind='setting'", (self.scope,)
            ).fetchall():
                if key not in values:
                    conn.execute(
                        "DELETE FROM sync_v2_outbox WHERE scope=? AND kind='setting' AND record_id=?", (self.scope, key)
                    )
            for key, value in values.items():
                row = conn.execute(
                    "SELECT value FROM sync_v2_settings_seen WHERE scope=? AND id=?", (self.scope, key)
                ).fetchone()
                old = self._get_record(conn, "setting", key)
                if ((row and json.loads(row[0]) != value) or (not row and not old)) and (
                    not old or old["data"] != value
                ):
                    self._local(conn, "setting", key, value, seed=not row)
                conn.execute(
                    "INSERT OR REPLACE INTO sync_v2_settings_seen VALUES(?,?,?)", (self.scope, key, encode(value))
                )

        self.db.run_transaction(capture)

    def settings_to_apply(self, current):
        def get(conn):
            result = {}
            for key, value in current.items():
                record = self._get_record(conn, "setting", key)
                seen = conn.execute(
                    "SELECT value FROM sync_v2_settings_seen WHERE scope=? AND id=?", (self.scope, key)
                ).fetchone()
                if record and seen and json.loads(seen[0]) == value and record["data"] != value:
                    result[key] = record["data"]
            return result

        return self.db.run_transaction(get)

    def mark_settings_applied(self, values):
        def mark(conn):
            for key, value in values.items():
                conn.execute(
                    "INSERT OR REPLACE INTO sync_v2_settings_seen VALUES(?,?,?)", (self.scope, key, encode(value))
                )

        self.db.run_transaction(mark)
