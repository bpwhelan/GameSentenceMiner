"""Read-only migration must not revive deleted files or follow unsafe paths."""

from pathlib import Path
import runpy
import struct
from types import SimpleNamespace

import pytest


MODULE = runpy.run_path(str(Path(__file__).parents[1] / "assets/scripts/legacy_dictionary_export.py"))


def pickle_file(parent, data_path, name):
    def string(value):
        raw = value.encode()
        return struct.pack("<I", len(raw)) + raw + b"\0" * (-len(raw) % 4)

    body = struct.pack("<Q", parent) + string(data_path) + string(name) + struct.pack("<Q", 0)
    return struct.pack("<I", len(body)) + body


def fixture(tmp_path, monkeypatch, file_records):
    source = tmp_path / "File System"
    destination = tmp_path / "export"
    for directory in [source / "Origins", source / "000/t/Paths", destination / "blobs"]:
        directory.mkdir(parents=True)

    def record(key, value, sequence, live=True):
        return SimpleNamespace(user_key=key, value=value, seq=sequence, state=SimpleNamespace(value=int(live)))

    rows = {
        source / "Origins": [record(b"ORIGIN:chrome-extension_fixture_0", b"000", 1)],
        source / "000/t/Paths": [record(*args) for args in file_records],
    }

    class Database:
        _files = []

        def __init__(self, path):
            self.path = path

        def iterate_records_raw(self):
            return iter(rows[self.path])

        def close(self):
            pass

    monkeypatch.setattr(MODULE["leveldb"], "RawLevelDb", Database)
    return source, destination


def test_filesystem_uses_latest_names_and_ignores_deleted_files(tmp_path, monkeypatch):
    source, destination = fixture(
        tmp_path,
        monkeypatch,
        [
            (b"0", pickle_file(0, "", ""), 1),
            (b"1", pickle_file(0, "", "日本語"), 2),
            (b"2", pickle_file(1, "00/00001", "old.bin"), 3),
            (b"2", pickle_file(1, "00/00001", "new.bin"), 4),
            (b"3", b"", 6, False),
            (b"3", pickle_file(1, "00/deleted", "deleted.bin"), 5),
        ],
    )
    (source / "000/t/00").mkdir()
    (source / "000/t/00/00001").write_bytes(b"\x00\xff\x01")
    manifest = {"databases": [], "batches": []}
    MODULE["export_filesystem"](source, destination, "chrome-extension_fixture_0", manifest)
    import json

    entries = [
        json.loads((destination / batch["file"]).read_text(encoding="utf-8"))[0] for batch in manifest["batches"]
    ]
    assert [entry["key"] for entry in entries] == ["/dicts/日本語", "/dicts/日本語/new.bin"]
    assert next((destination / "blobs").glob("*.bin")).read_bytes() == b"\x00\xff\x01"


@pytest.mark.parametrize(
    "parent,data_path,name", [(1, "", "loop"), (99, "", "orphan"), (0, "", ".."), (0, "../../outside", "data")]
)
def test_filesystem_rejects_broken_parents_and_escaping_paths(tmp_path, monkeypatch, parent, data_path, name):
    source, destination = fixture(tmp_path, monkeypatch, [(b"1", pickle_file(parent, data_path, name), 1)])
    with pytest.raises(ValueError):
        MODULE["export_filesystem"](source, destination, "chrome-extension_fixture_0", {"databases": [], "batches": []})
