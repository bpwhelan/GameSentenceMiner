"""Shared builders for the Clips to mine tests."""

import json
from datetime import datetime, timedelta

from GameSentenceMiner.util import clips

BASE = datetime(2026, 9, 27, 12, 0, 0)


def write_clip(root, name, entries, end_seconds, *, day="2026-09-27"):
    """Write a clip folder from (id, text, role, seconds_after_BASE) entries, without real video."""
    folder = root / day / name
    folder.mkdir(parents=True)
    manifest = {
        "lines": [
            {"id": i, "text": t, "time": (BASE + timedelta(seconds=s)).isoformat(), "role": r, "scene": "FFVII"}
            for i, t, r, s in entries
        ],
        "clip": {"file": "clip.mkv", "end_time": (BASE + timedelta(seconds=end_seconds)).isoformat()},
    }
    (folder / clips.MANIFEST_NAME).write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    (folder / "clip.mkv").write_bytes(b"clip")
    return folder
