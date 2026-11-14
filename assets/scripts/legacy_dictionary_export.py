"""Export a legacy dictionary without launching Chromium or opening it for writes.

The original profile is never changed. Latest LevelDB records are indexed on disk
so deleted/overwritten terms cannot reappear and large dictionaries stay bounded
in memory. A manifest is published only after every record has been decoded.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import hashlib
import io
import json
import math
import re
from pathlib import Path
import sqlite3
import sys
import uuid

VENDOR = Path(__file__).resolve().parent / "vendor"
sys.path[:0] = [str(VENDOR / "chromium-reader"), str(VENDOR / "simple-snappy")]

from ccl_chromium_reader import ccl_chromium_indexeddb as idb  # noqa: E402
from ccl_chromium_reader.serialization_formats import (  # noqa: E402
    ccl_blink_value_deserializer as blink,
    ccl_v8_value_deserializer as v8,
)
from ccl_chromium_reader.serialization_formats.ccl_easy_chromium_pickle import EasyPickleIterator  # noqa: E402
from ccl_chromium_reader.storage_formats import ccl_leveldb as leveldb  # noqa: E402

try:
    from cramjam import snappy

    # Native decompression keeps multi-gigabyte profiles practical. The vendor
    # fallback remains usable with an older managed Python installation.
    leveldb.ccl_simplesnappy.decompress = lambda stream: bytes(snappy.decompress_raw(stream.read()))
except ImportError:
    pass


def integer(stream: io.BytesIO) -> int:
    value = 0
    for shift in range(0, 70, 7):
        raw = stream.read(1)
        if not raw:
            raise ValueError("Incomplete IndexedDB integer")
        value |= (raw[0] & 127) << shift
        if raw[0] < 128:
            return value
    raise ValueError("Invalid IndexedDB integer")


def string(stream: io.BytesIO) -> str:
    length = integer(stream) * 2
    raw = stream.read(length)
    if len(raw) != length:
        raise ValueError("Incomplete IndexedDB string")
    return raw.decode("utf-16-be")


def key_path(raw: bytes | None):
    if raw is None:
        return None
    if not raw.startswith(b"\x00\x00"):
        return raw.decode("utf-16-be")
    stream = io.BytesIO(raw[3:])
    if raw[2] == 0:
        return None
    if raw[2] == 1:
        return string(stream)
    if raw[2] == 2:
        return [string(stream) for _ in range(integer(stream))]
    raise ValueError("Unknown IndexedDB key path")


@dataclasses.dataclass
class TypedBytes:
    kind: str
    value: bytes


@dataclasses.dataclass
class BigInteger:
    value: int


class DesktopDeserializer(v8.Deserializer):
    def _read_bigint(self):
        return BigInteger(super()._read_bigint())

    def _wrap_js_array_buffer_view(self, raw):
        # Upstream's forensic representation is a tuple. Retain the original
        # typed array instead: Emscripten's filesystem expects Uint8Array.
        tag = chr(self._read_le_varint()[0])
        offset = self._read_le_varint()[0]
        length = self._read_le_varint()[0]
        if self.version >= 14:
            self._read_le_varint()
        kinds = {
            "b": "Int8Array",
            "B": "Uint8Array",
            "C": "Uint8ClampedArray",
            "w": "Int16Array",
            "W": "Uint16Array",
            "d": "Int32Array",
            "D": "Uint32Array",
            "f": "Float32Array",
            "F": "Float64Array",
            "q": "BigInt64Array",
            "Q": "BigUint64Array",
            "?": "DataView",
        }
        if tag not in kinds or offset + length > len(raw):
            raise ValueError("Unsupported or incomplete typed array")
        return TypedBytes(kinds[tag], raw[offset : offset + length])


def cache_latest(source: Path, destination: Path, indexed: bool = True):
    connection = sqlite3.connect(destination)
    connection.execute("PRAGMA journal_mode=OFF")
    connection.execute("PRAGMA synchronous=OFF")
    connection.execute("PRAGMA cache_size=-65536")
    connection.execute(
        "CREATE TABLE records (key BLOB PRIMARY KEY, value BLOB, seq INTEGER, state INTEGER, db INTEGER, store INTEGER, kind INTEGER) WITHOUT ROWID"
    )
    database = leveldb.RawLevelDb(source)
    count = 0
    try:
        for record in database.iterate_records_raw():
            key = record.user_key
            database_id = store_id = kind = 0
            if indexed:
                database_id, store_id, kind, _ = idb.IndexedDb.read_prefix(io.BytesIO(key))
                if kind not in (0, 1, 3):
                    continue  # Indexes are rebuilt by the destination database.
            connection.execute(
                "INSERT INTO records VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,seq=excluded.seq,state=excluded.state WHERE excluded.seq > records.seq",
                (key, record.value, record.seq, record.state.value, database_id, store_id, kind),
            )
            count += 1
            if count % 5000 == 0:
                connection.commit()
            if count % 100000 == 0:
                print(json.dumps({"phase": "reading", "records": count}), flush=True)
        if any(getattr(item, "damage", []) for item in database._files):
            raise ValueError(
                "Saved dictionary data is damaged. Transfer stopped without modifying the original profile."
            )
    finally:
        database.close()
    connection.commit()
    print(json.dumps({"phase": "indexing", "records": count}), flush=True)
    connection.execute("CREATE INDEX by_store ON records(db,store,kind,state)")
    return connection


class DictionarySnapshot(idb.IndexedDb):
    def __init__(self, connection, blobs: Path):
        self.connection = connection
        self._blob_dir = blobs
        self._blob_lookup_cache = {}
        self._fetched_records = [
            leveldb.Record(key, value, seq, leveldb.KeyState.Live, leveldb.FileType.Log, "legacy", 0, False)
            for key, value, seq in connection.execute("SELECT key,value,seq FROM records WHERE kind=0 AND state=1")
        ]
        self._fetch_meta_data()

    def get_blob_info(self, database_id, store_id, raw_key, file_index):
        key = (database_id, store_id, raw_key, file_index)
        if key not in self._blob_lookup_cache:
            prefix = self.make_prefix(database_id, store_id, 3)
            row = self.connection.execute(
                "SELECT value FROM records WHERE key=? AND state=1", (prefix + raw_key,)
            ).fetchone()
            if row is None:
                raise KeyError("Missing dictionary media reference")
            stream = io.BytesIO(row[0])
            index = 0
            while stream.tell() < len(row[0]):
                self._blob_lookup_cache[(database_id, store_id, raw_key, index)] = (
                    idb.IndexedDBExternalObject.from_stream(stream)
                )
                index += 1
        return self._blob_lookup_cache[key]

    def schemas(self):
        for database in self.global_metadata.db_ids:
            dbid = database.dbid_no
            version_record = self.database_metadata._metas.get((dbid, idb.DatabaseMetadataType.IdbVersion))
            version = integer(io.BytesIO(version_record.value)) if version_record else 1
            stores = []
            for (db, storeid, kind), record in self.object_store_meta._metas.items():
                if db != dbid or kind != idb.ObjectStoreMetadataType.StoreName:
                    continue

                def meta(field):
                    record = self.object_store_meta._metas.get((dbid, storeid, field))
                    return record.value if record else None

                indexes = {}
                prefix = self.make_prefix(dbid, 0, 0, [100])
                for record in self._fetched_records:
                    if not record.key.startswith(prefix):
                        continue
                    stream = io.BytesIO(record.key[len(prefix) :])
                    target, index = integer(stream), integer(stream)
                    if target != storeid:
                        continue
                    field = stream.read(1)[0]
                    indexes.setdefault(index, {})[field] = record.value
                stores.append(
                    {
                        "id": storeid,
                        "name": record_name(meta(idb.ObjectStoreMetadataType.StoreName)),
                        "keyPath": key_path(meta(idb.ObjectStoreMetadataType.KeyPath)),
                        "autoIncrement": meta(idb.ObjectStoreMetadataType.AutoIncrementFlag) == b"\x01",
                        "nextKey": int.from_bytes(
                            meta(idb.ObjectStoreMetadataType.KeygeneratorCurrentNumber) or b"\x00", "little"
                        ),
                        "indexes": [
                            {
                                "name": record_name(fields[0]),
                                "keyPath": key_path(fields.get(2)),
                                "unique": fields.get(1) == b"\x01",
                                "multiEntry": fields.get(3) == b"\x01",
                            }
                            for fields in indexes.values()
                            if 0 in fields
                        ],
                    }
                )
            yield {"id": dbid, "name": database.name, "version": max(1, version), "stores": stores}

    def entries(self, database_id, store_id):
        prefix = self.make_prefix(database_id, store_id, 1)
        for raw_key, raw_value in self.connection.execute(
            "SELECT key,value FROM records WHERE db=? AND store=? AND kind=1 AND state=1", (database_id, store_id)
        ):
            key = idb.IdbKey(raw_key[len(prefix) :])
            stream = io.BytesIO(raw_value)
            integer(stream)  # Record version.
            precursor = self.read_record_precursor(key, database_id, store_id, stream.read(), None, None)
            if precursor is None:
                raise ValueError("Could not decode a live dictionary entry")
            _, serialized, _, _ = precursor
            value = DesktopDeserializer(serialized, host_object_delegate=blink.BlinkV8Deserializer().read).read()
            yield key, value


def record_name(raw):
    return raw.decode("utf-16-be")


class Encoder:
    def __init__(self, destination, database, database_id, store_id, raw_key):
        self.destination = destination
        self.database = database
        self.database_id = database_id
        self.store_id = store_id
        self.raw_key = raw_key

    def binary(self, value, kind, **metadata):
        digest = hashlib.sha256(value).hexdigest()
        filename = f"blobs/{digest}.bin"
        target = self.destination / filename
        if not target.exists():
            target.write_bytes(value)
        return {"$gsm": "binary", "kind": kind, "file": filename, **metadata}

    def encode(self, value):
        if isinstance(value, idb.IdbKey):
            return self.encode(value.value)
        if isinstance(value, BigInteger):
            return {"$gsm": "bigint", "value": str(value.value)}
        if value is None or isinstance(value, (str, bool, int)):
            return value
        if isinstance(value, float):
            return (
                value
                if math.isfinite(value)
                else {
                    "$gsm": "number",
                    "value": "NaN" if math.isnan(value) else "Infinity" if value > 0 else "-Infinity",
                }
            )
        if isinstance(value, TypedBytes):
            return self.binary(value.value, value.kind)
        if isinstance(value, bytes):
            return self.binary(value, "ArrayBuffer")
        if isinstance(value, datetime.datetime):
            return {
                "$gsm": "date",
                "value": value.replace(tzinfo=datetime.timezone.utc).isoformat()
                if value.tzinfo is None
                else value.isoformat(),
            }
        if isinstance(value, blink.BlobIndex):
            info = self.database.get_blob_info(self.database_id, self.store_id, self.raw_key, value.index_id)
            with self.database.get_blob(self.database_id, self.store_id, self.raw_key, value.index_id) as stream:
                return self.binary(stream.read(), "Blob", mime=info.mime_type)
        if value is v8.Deserializer.Undefined:
            return {"$gsm": "undefined"}
        if isinstance(value, (list, tuple)):
            return {"$gsm": "array", "value": [self.encode(item) for item in value]}
        if isinstance(value, dict):
            return {"$gsm": "object", "value": [[str(key), self.encode(item)] for key, item in value.items()]}
        raise TypeError(f"Unsupported dictionary value: {type(value).__name__}")


def source_snapshot(*directories: Path | None):
    """Detect concurrent Chromium writes without opening a database for writes."""
    result = {}
    for directory in directories:
        if directory and directory.is_dir():
            for filename in directory.rglob("*"):
                if filename.is_file() and filename.name != "LOCK":
                    stat = filename.stat()
                    result[str(filename)] = (stat.st_size, stat.st_mtime_ns)
    return result


def export_filesystem(source: Path, destination: Path, origin: str, manifest: dict):
    """Convert Hachidori's Chromium OPFS files into its native IDBFS format.

    Read latest live records only; Chromium can retain deleted dictionary files
    and stale names. Never follow data paths or parent links outside this origin.
    """
    if not (source / "Origins").is_dir():
        return
    origins = cache_latest(source / "Origins", destination / "origins.sqlite", indexed=False)
    try:
        row = origins.execute(
            "SELECT value FROM records WHERE key=? AND state=1", (f"ORIGIN:{origin}".encode(),)
        ).fetchone()
    finally:
        origins.close()
    if row is None:
        return
    folder = row[0].decode("utf-8")
    if not re.fullmatch(r"[0-9]+", folder):
        raise ValueError("Invalid dictionary filesystem origin")
    if any(item["name"] == "/dicts" for item in manifest["databases"]):
        raise ValueError(
            "Both legacy dictionary storage formats contain data; automatic transfer cannot choose between them"
        )
    entries = {}
    for kind in ("t", "p"):
        base = (source / folder / kind).resolve()
        if not base.is_relative_to(source.resolve()):
            raise ValueError("Dictionary filesystem origin escapes its profile")
        if not (base / "Paths").is_dir():
            continue
        paths = cache_latest(base / "Paths", destination / f"paths-{kind}.sqlite", indexed=False)
        records = {}
        try:
            for key, value in paths.execute("SELECT key,value FROM records WHERE state=1"):
                if not key.isdigit():
                    continue
                with EasyPickleIterator(value) as reader:
                    records[int(key)] = (
                        reader.read_uint64(),
                        reader.read_string(),
                        reader.read_string(),
                        reader.read_datetime(),
                    )
        finally:
            paths.close()
        for file_id, (_, data_path, _, timestamp) in records.items():
            if file_id == 0:
                continue
            parts, visited, current = [], set(), file_id
            while current != 0:
                if current in visited or current not in records:
                    raise ValueError("Broken dictionary filesystem parent chain")
                visited.add(current)
                parent, _, name, _ = records[current]
                if not name or name in (".", "..") or any(char in name for char in ("/", "\\", "\0")):
                    raise ValueError("Invalid dictionary filesystem name")
                parts.insert(0, name)
                current = parent
            filename = "/dicts/" + "/".join(parts)
            if filename in entries:
                raise ValueError("Conflicting dictionary filesystem entries")
            value = {"timestamp": timestamp, "mode": 0o100644 if data_path else 0o40755}
            encoder = Encoder(destination, None, 0, 0, None)
            encoded = encoder.encode(value)
            if data_path:
                original = (base / data_path.replace("\\", "/")).resolve()
                if not original.is_relative_to(base) or not original.is_file():
                    raise ValueError("Missing or unsafe dictionary filesystem data")
                digest = hashlib.sha256()
                # Bound memory even for dictionaries with multi-gigabyte files.
                temporary = destination / "blobs" / "filesystem.tmp"
                with original.open("rb") as stream, temporary.open("wb") as output:
                    while chunk := stream.read(8 * 1024 * 1024):
                        digest.update(chunk)
                        output.write(chunk)
                blob = f"blobs/{digest.hexdigest()}.bin"
                temporary.replace(destination / blob)
                encoded["value"].append(["contents", {"$gsm": "binary", "kind": "Uint8Array", "file": blob}])
            entries[filename] = encoded
    if not entries:
        return
    schema = {
        "name": "/dicts",
        "version": 21,
        "stores": [
            {
                "name": "FILE_DATA",
                "keyPath": None,
                "autoIncrement": False,
                "indexes": [{"name": "timestamp", "keyPath": "timestamp", "unique": False, "multiEntry": False}],
                "count": len(entries),
            }
        ],
    }
    manifest["databases"].append(schema)
    for key, value in sorted(entries.items()):
        filename = f"batch-{len(manifest['batches']):06d}.json"
        (destination / filename).write_text(
            json.dumps([{"key": key, "value": value}], ensure_ascii=False), encoding="utf-8"
        )
        manifest["batches"].append({"file": filename, "database": "/dicts", "store": "FILE_DATA", "count": 1})
    print(json.dumps({"phase": "filesystem", "entries": len(entries)}), flush=True)


def export_dictionary(source: Path, destination: Path, settings: Path | None = None, filesystem: Path | None = None):
    destination.mkdir(parents=True, exist_ok=False)
    (destination / "blobs").mkdir()
    if not source.is_dir() and not (settings and settings.is_dir()):
        raise FileNotFoundError("No legacy dictionary database or settings were found")
    blobs = source.with_name(source.name.removesuffix(".leveldb") + ".blob")
    before = source_snapshot(source, settings, blobs, filesystem)
    connection = cache_latest(source, destination / "snapshot.sqlite") if source.is_dir() else None
    database = DictionarySnapshot(connection, blobs) if connection else None
    manifest = {
        "format": 1,
        "snapshotId": uuid.uuid4().hex,
        "databases": list(database.schemas()) if database else [],
        "batches": [],
        "storage": {},
    }
    try:
        for schema in manifest["databases"]:
            for store in schema["stores"]:
                batch, size, count = [], 0, 0

                def flush():
                    filename = f"batch-{len(manifest['batches']):06d}.json"
                    (destination / filename).write_text("[" + ",".join(batch) + "]", encoding="utf-8")
                    manifest["batches"].append(
                        {"file": filename, "database": schema["name"], "store": store["name"], "count": len(batch)}
                    )

                for key, value in database.entries(schema["id"], store["id"]):
                    encoder = Encoder(destination, database, schema["id"], store["id"], key.raw_key)
                    entry = json.dumps(
                        {"key": encoder.encode(key.value), "value": encoder.encode(value)},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    batch.append(entry)
                    size += len(entry)
                    count += 1
                    if size >= 1024 * 1024 or len(batch) >= 500:
                        flush()
                        batch, size = [], 0
                if batch:
                    flush()
                store["count"] = count
                print(json.dumps({"store": store["name"], "count": count}), flush=True)
        if settings and settings.is_dir():
            storage = cache_latest(settings, destination / "settings.sqlite", indexed=False)
            try:
                manifest["storage"] = {
                    key.decode("utf-8"): json.loads(value)
                    for key, value in storage.execute("SELECT key,value FROM records WHERE state=1")
                }
            finally:
                storage.close()
        if filesystem:
            origin = source.name.removesuffix(".indexeddb.leveldb")
            export_filesystem(filesystem, destination, origin, manifest)
            manifest["filesystemVersion"] = 1
        if source_snapshot(source, settings, blobs, filesystem) != before:
            raise RuntimeError(
                "Saved dictionaries changed during transfer. Close the older GSM app and try again. "
                "The original profile has not been modified."
            )
        temporary = destination / "manifest.tmp"
        temporary.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        temporary.replace(destination / "manifest.json")
    finally:
        if connection:
            connection.close()


def identify_legacy_settings(directory: Path):
    """Identify saved dictionaries after an installer changes extension paths.

    Only small extension-settings stores are read. No settings values are
    returned to the caller or written to diagnostic output.
    """
    found = []
    if not directory.is_dir():
        return found
    for location in directory.iterdir():
        if not location.is_dir() or not re.fullmatch(r"[a-p]{32}", location.name):
            continue
        latest = {}
        database = leveldb.RawLevelDb(location)
        try:
            for record in database.iterate_records_raw():
                if record.user_key not in latest or record.seq > latest[record.user_key].seq:
                    latest[record.user_key] = record
            if any(getattr(item, "damage", []) for item in database._files):
                raise ValueError("Saved dictionary settings are damaged; transfer stopped.")
        finally:
            database.close()
        options_record = latest.get(b"options")
        if options_record is None or options_record.state != leveldb.KeyState.Live:
            continue
        options = json.loads(options_record.value)
        if isinstance(options, str):
            options = json.loads(options)
        if not isinstance(options, dict):
            continue
        kind = None
        if isinstance(options.get("profiles"), list) and isinstance(options.get("profileCurrent"), int):
            kind = "yomitan"
        elif any(key in latest for key in (b"dictionaryState", b"dictionaryUpdates", b"languageSelection")):
            kind = "hachidori"
        if kind:
            modified = max((item.stat().st_mtime for item in location.iterdir() if item.is_file()), default=0)
            found.append({"id": location.name, "kind": kind, "modified": modified})
    return sorted(found, key=lambda item: item["modified"], reverse=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path, nargs="?")
    parser.add_argument("--settings", type=Path)
    parser.add_argument("--filesystem", type=Path)
    parser.add_argument("--identify", action="store_true")
    args = parser.parse_args()
    if args.identify:
        print(json.dumps(identify_legacy_settings(args.source.resolve())))
    elif args.destination is None:
        parser.error("destination is required for an export")
    else:
        export_dictionary(args.source.resolve(), args.destination.resolve(), args.settings, args.filesystem)
