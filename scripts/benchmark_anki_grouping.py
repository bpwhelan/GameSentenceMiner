"""Compare duplicate selection and merged Anki writes against an isolated collection."""

import hashlib
import html
import json
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from html.entities import html5
from types import SimpleNamespace
from unittest.mock import patch

import psutil
import requests

MODEL = 'Mining "Deck"\\A'
WORD = "Straße猫"
TARGET = 10
SOURCE = 5000


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def encode(result=None, error=None):
    return json.dumps({"result": result, "error": error}, ensure_ascii=False, separators=(",", ":")).encode()


def target_fields(groups):
    return {
        "Word": "<b>STRASSE</b>&#x732B;",
        "Sentence": "".join(f'<span data-group-id="{i}"><b>行{i}</b>\r\n空</span>' for i in range(1, groups + 1))
        + "<i>old</i>",
        "Picture": "".join(f"<IMG data-group-id='{i}' src='pic{i}.webp'>" for i in range(1, groups + 1))
        + "<img src='old.webp'>",
        "SentenceAudio": "[sound:old.mp3]",
        "Furigana": "空<br>そら",
        "Translation": " &nbsp;<br>",
    }


def note(i, fields):
    return {
        "noteId": i,
        "modelName": "Other" if (i - TARGET) % 4 == 2 else MODEL,
        "tags": ["mined", "漏れ"],
        "fields": {k: {"value": v, "order": p} for p, (k, v) in enumerate(fields.items())},
    }


@lru_cache(maxsize=1)
def entity_cases():
    return (
        [f"&{key}" for key in sorted(html5)]
        + [f"&#x{number:x};" for number in (*range(160), 0xFDD0, 0xFFFE, 0xD800, 0x10FFFF, 0x110000)]
        + ["&notit;", "&copyX", "&unknown;", "&amp;amp;"]
    )


def sentence(note_id, entities):
    if entities:
        return "|".join(entity_cases()[(note_id - TARGET) // 4 :: 256])
    return f"{{{{c1::第{note_id}文::hint}}}}<br>&amp;[extra]空"


@lru_cache(maxsize=32)
def search_page(ids, late, entities):
    def matching_word(note_id):
        if late:
            return note_id == TARGET + 1023
        return (note_id - TARGET) % 4 in (0, 2)

    return encode(
        [
            note(
                i,
                {
                    "Word": "<b>STRASSE</b>&#x732B;" if matching_word(i) else "猫科",
                    "Sentence": sentence(i, entities),
                    "Unrelated": "<div>dictionary entry</div>" * 85,
                },
            )
            for i in ids
        ]
    )


class Collection:
    def __init__(self, case):
        self.late = case == "group-auto-late"
        self.count = 1024 if case in ("group-chooser", "group-auto", "group-auto-late") else 8
        self.groups = 128 if case == "group-merge" else 1
        self.lock = threading.Lock()
        self.reset("")

    def reset(self, variant):
        self.variant = variant
        self.fields = target_fields(self.groups)
        if variant == "wide-id":
            self.fields["Sentence"] = '<span data-group-id="184467440737095516160">huge</span>'
        if variant == "old-field":
            self.fields["SentenceAudio"] = 17
        self.actions = []
        self.reads = 0
        self.busy = False
        self.deleted = []
        self.tags = []

    def reply(self, payload):
        with self.lock:
            if payload is None:
                return json.dumps(
                    {
                        "actions": self.actions,
                        "fields": self.fields,
                        "deleted": self.deleted,
                        "tags": self.tags,
                        "reads": self.reads,
                    }
                ).encode()
            if "reset" in payload:
                self.reset(payload["reset"])
                return b"null"
            action, params = payload["action"], payload["params"]
            assert payload["version"] == 6
            if action == "findNotes":
                assert params["query"] == r'note:"Mining \"Deck\"\\A" "Word:Straße猫"'
                ids = [SOURCE + 1, SOURCE, *reversed(range(TARGET, TARGET + self.count))]
                return encode([str(i) for i in [-1, *ids]] if self.variant == "string-id" else ids)
            if action == "notesInfo":
                self.reads += len(params["notes"])
                if params["notes"] == [TARGET]:
                    if self.variant == "missing":
                        return encode([])
                    row = note(TARGET, self.fields)
                    if self.variant == "string-id":
                        row["noteId"] = str(TARGET)
                    return encode([row])
                page = search_page(tuple(params["notes"]), self.late, self.variant == "entities")
                if self.variant == "string-id":
                    rows = json.loads(page)["result"]
                    for row in rows:
                        row["noteId"] = str(row["noteId"])
                    return encode(rows)
                return page
            self.actions.append(action)
            if action == "guiSelectedNotes":
                return encode([TARGET] if self.variant == "selected" else [])
            if action == "guiBrowse":
                assert params == {"query": "nid:1"}
            elif action == "updateNoteFields":
                assert params["note"]["id"] == TARGET and "Word" not in params["note"]["fields"]
                self.fields.update(params["note"]["fields"])
                if self.variant == "lost":
                    return None
            elif action == "addTags":
                assert params["notes"] == [TARGET]
                if self.variant == "busy" and not self.busy:
                    self.busy = True
                    return encode(error="A collection operation is active.")
                if self.variant == "reject":
                    return encode(error="fixture rejected tags")
                if self.variant == "blocked":
                    return encode(error="A collection operation is active.")
                self.tags.extend(params["tags"].split())
            elif action == "removeTags":
                assert params == {"notes": [TARGET], "tags": "overlay"}
            elif action == "deleteNotes":
                self.deleted.extend(params["notes"])
            else:
                raise AssertionError(action)
            return encode()


def measure(bus, desktop_pid, mode, case, port, iterations):
    from GameSentenceMiner import anki
    from scripts.benchmark_mining_history import sample_operation_memory

    url = f"http://127.0.0.1:{port}/group/{case}/{uuid.uuid4().hex}"
    cfg = SimpleNamespace(
        anki=SimpleNamespace(
            field_grouping_enabled=True,
            field_grouping_auto_merge=True,
            field_grouping_order="back",
            field_grouping_delete_duplicate=True,
            field_grouping_overwrite=False,
            remove_overlay_tag=True,
            field_grouping_additional_fields=["Translation", "word", "sentence"],
            word_field="Word",
            sentence_field="Sentence",
            picture_field="Picture",
            sentence_audio_field="SentenceAudio",
            sentence_furigana_field="Furigana",
            url=url,
        ),
        ai=SimpleNamespace(add_to_anki=True, anki_field="Translation"),
    )
    values = {
        "Word": WORD,
        "Picture": "<img src='new.webp'>",
        "SentenceAudio": "[sound:new.mp3]",
        "Furigana": "新\r行",
        "Translation": "context",
    }
    source = SimpleNamespace(
        noteId=SOURCE, modelName=MODEL, get_field=values.get, tags=["GSM", "marked", "Straße", "context", "LEECH"]
    )
    tags = [" generated ", "GSM", "STRASSE", "potential_leech"]
    patches = {"fields": {"Sentence": "新規\r\n<b>行</b>", "Word": "ignored"}}
    decision = {"target_note_id": TARGET, "order": "back", "delete_duplicate": True}
    processes = [psutil.Process(), psutil.Process(desktop_pid)]
    os.environ["GSM_NATIVE_ANKI_EDIT"] = "1"  # The previous desktop already owned prepared field writes.
    os.environ["GSM_NATIVE_ANKI_POLL"] = "1"
    os.environ["GSM_NATIVE_ANKI_GROUPING"] = "1" if mode == "rust" else "0"
    native_calls = 0
    request = bus.request

    def observed(dst, topic, data, timeout):
        nonlocal native_calls
        native_calls += topic == "anki.group"
        return request(dst, topic, data, timeout)

    def reset(variant=""):
        requests.post(url, json={"reset": variant}, timeout=3).raise_for_status()

    def state():
        return requests.get(url, timeout=3).json()

    def merge(chosen=decision, card=source, patch_fields=patches):
        return anki._apply_field_grouping_merge(card, patch_fields, tags, chosen, cfg).noteId

    def cycle():
        if case == "group-chooser":
            return anki._find_field_grouping_candidates(source)
        if case.startswith("group-auto"):
            return anki._resolve_field_grouping_decision(source)
        if case == "group-small":
            return merge(anki._resolve_field_grouping_decision(source))
        return merge()

    def cpu():
        return sum(sum(p.cpu_times()[:2]) for p in processes)

    with (
        patch.object(anki, "get_config", return_value=cfg),
        patch.object(bus, "request", observed),
        patch.object(anki.anki_actions, "open_browser_window", lambda _id: anki.invoke("guiBrowse", query="nid:1")),
    ):
        reset()
        expected = cycle()
        assert bool(native_calls) == (mode == "rust")
        snapshot = state()
        reads = snapshot.pop("reads")
        if case == "group-chooser":
            assert [x["note_id"] for x in expected] == list(range(TARGET, TARGET + 1024, 4))
            assert expected[0] == {
                "note_id": TARGET,
                "sentence": "第10文&空",
                "tags": ["mined", "漏れ"],
                "model_name": MODEL,
            }
        elif case.startswith("group-auto"):
            assert expected == {**decision, "target_note_id": TARGET + (1023 if case == "group-auto-late" else 0)}
        else:
            assert expected == TARGET and snapshot["deleted"] == [SOURCE]
            assert snapshot["tags"] == ["generated", "GSM", "STRASSE", "context"]
            assert '<span data-group-id="1">新規<br><b>行</b></span>' in snapshot["fields"]["Sentence"]
        reference = digest([expected, snapshot])
        wall = consumed = 0
        for _ in range(iterations):
            reset()
            start_cpu, start = cpu(), time.perf_counter()
            result = cycle()
            wall += time.perf_counter() - start
            consumed += cpu() - start_cpu
            persisted = state()
            persisted.pop("reads")
            assert digest([result, persisted]) == reference

        def memory_repeat():
            reset()
            cycle()

        memory = sample_operation_memory(desktop_pid, memory_repeat, "group")
        verified = {"digest": reference}
        if case == "group-chooser":
            reset("entities")
            displayed = cycle()
            assert len(displayed) == 256
            for item in displayed:
                assert item["sentence"] == html.unescape(sentence(item["note_id"], True)).strip()
            verified["entity_count"] = len(entity_cases())
            verified["entities"] = digest(displayed)
        if case == "group-small":
            for variant in (
                "selected",
                "busy",
                "reject",
                "missing",
                "wide-id",
                "lost",
                "overwrite",
                "string-id",
                "old-field",
            ):
                reset(variant)
                if variant == "string-id":
                    assert anki._resolve_field_grouping_decision(source) == decision
                if variant in ("reject", "missing", "lost"):
                    try:
                        merge()
                    except (RuntimeError, ValueError, requests.RequestException) as exc:
                        expected_error = {"reject": "rejected tags", "missing": "no longer exists"}.get(variant, "")
                        assert str(exc) and expected_error in str(exc)
                    else:
                        raise AssertionError(variant)
                else:
                    assert merge({**decision, "overwrite": variant == "overwrite"}) == TARGET
                observed_state = state()
                actions = observed_state["actions"]
                if variant == "busy":
                    assert actions.count("updateNoteFields") == 1 and actions.count("addTags") == 2
                if variant == "selected":
                    assert actions.index("guiBrowse") < actions.index("updateNoteFields")
                if variant in ("reject", "missing", "lost"):
                    assert "deleteNotes" not in actions
                if variant == "lost":
                    assert actions == ["guiSelectedNotes", "updateNoteFields"]
                if variant == "overwrite":
                    assert observed_state["fields"]["Sentence"] == "新規<br><b>行</b>"
                verified[variant] = digest([actions, observed_state["fields"], observed_state["deleted"]])
            if mode == "rust":
                reset()

                def concurrent(i):
                    return merge(
                        {**decision, "order": "front", "delete_duplicate": False},
                        SimpleNamespace(noteId=SOURCE + i, modelName=MODEL, get_field=values.get, tags=[]),
                        {"fields": {"Sentence": f"unique-{i}"}},
                    )

                with ThreadPoolExecutor(max_workers=4) as pool:
                    assert list(pool.map(concurrent, range(4))) == [TARGET] * 4
                merged_sentence = state()["fields"]["Sentence"]
                assert all(merged_sentence.count(f"unique-{i}") == 1 for i in range(4))
                reset("blocked")
                with ThreadPoolExecutor(max_workers=1) as pool:
                    pending = pool.submit(merge)
                    try:
                        deadline = time.monotonic() + 5
                        while "addTags" not in state()["actions"]:
                            assert time.monotonic() < deadline
                            time.sleep(0.01)
                    finally:
                        bus.request("main", "anki.sync.stop", {}, timeout=2)
                    error = pending.exception(timeout=3)
                    assert error and "stopped with the backend session" in str(error)
                assert "deleteNotes" not in state()["actions"]
        return {
            "result": verified,
            "wall_ms": wall * 1000 / iterations,
            "cpu_ms": consumed * 1000 / iterations,
            "notes_read": reads,
            **memory,
        }
