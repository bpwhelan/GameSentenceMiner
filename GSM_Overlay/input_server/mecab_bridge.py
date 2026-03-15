#!/usr/bin/env python3
"""
JSON-lines bridge process for MeCab tokenization and furigana.

Protocol (stdin -> stdout):
- {"op":"health"}
- {"op":"tokenize","text":"..."}
- {"op":"get_furigana","text":"..."}
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Optional, Set


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _iter_parents(start: str, max_depth: int = 8) -> List[str]:
    out: List[str] = []
    current = os.path.abspath(start)
    for _ in range(max_depth):
        out.append(current)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return out


def _find_project_root() -> Optional[str]:
    search_roots: List[str] = []
    seen: Set[str] = set()

    def push(path: str) -> None:
        candidate = os.path.abspath(path)
        if candidate in seen:
            return
        seen.add(candidate)
        search_roots.append(candidate)

    for env_key in ("GSM_ROOT", "GSM_PROJECT_ROOT"):
        value = (os.environ.get(env_key) or "").strip()
        if value:
            push(value)

    push(SCRIPT_DIR)
    push(os.getcwd())

    for root in list(search_roots):
        for parent in _iter_parents(root):
            controller_path = os.path.join(
                parent, "GameSentenceMiner", "mecab", "mecab_controller.py"
            )
            if os.path.isfile(controller_path):
                return parent
    return None


GSM_ROOT = _find_project_root()
if GSM_ROOT and GSM_ROOT not in sys.path:
    sys.path.insert(0, GSM_ROOT)
    print(f"[mecab_bridge] Added project root to sys.path: {GSM_ROOT}", file=sys.stderr, flush=True)

mecab_controller = None
MECAB_AVAILABLE = False

try:
    from GameSentenceMiner.mecab.mecab_controller import MecabController

    mecab_controller = MecabController()
    MECAB_AVAILABLE = True
    print(f"[mecab_bridge] MeCab initialized (python={sys.executable})", file=sys.stderr, flush=True)
except Exception as exc:
    print(
        f"[mecab_bridge] MeCab unavailable (python={sys.executable}): {exc}",
        file=sys.stderr,
        flush=True,
    )

get_recent_character_name_index = None
merge_tokens_with_character_names = None
tokens_to_furigana_segments = None

try:
    from GameSentenceMiner.util.yomitan_dict.character_names import (
        get_recent_character_name_index,
        merge_tokens_with_character_names,
        tokens_to_furigana_segments,
    )
except Exception as exc:
    print(
        f"[mecab_bridge] Character-name helpers unavailable: {exc}",
        file=sys.stderr,
        flush=True,
    )


def fallback_tokens(text: str) -> List[Dict[str, Any]]:
    tokens: List[Dict[str, Any]] = []
    for i, ch in enumerate(text):
        if not ch.isspace():
            tokens.append({"word": ch, "start": i, "end": i + 1})
    return tokens


def _text_contains_kanji(text: str) -> bool:
    for char in text:
        code = ord(char)
        if (
            0x4E00 <= code <= 0x9FFF
            or 0x3400 <= code <= 0x4DBF
            or 0x20000 <= code <= 0x2A6DF
        ):
            return True
    return False


def _katakana_to_hiragana(text: str) -> str:
    out: List[str] = []
    for char in text:
        code = ord(char)
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(char)
    return "".join(out)


def _tokens_to_furigana_segments_default(
    tokens: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    segments: List[Dict[str, Any]] = []

    for token in tokens:
        word = str(token.get("word") or "")
        start = token.get("start")
        end = token.get("end")
        if not word or not isinstance(start, int) or not isinstance(end, int):
            continue

        reading = str(token.get("reading") or "").strip()
        reading_hiragana = _katakana_to_hiragana(reading) if reading else ""
        has_reading = (
            bool(reading_hiragana)
            and reading_hiragana != word
            and _text_contains_kanji(word)
        )
        segments.append(
            {
                "text": word,
                "start": start,
                "end": end,
                "hasReading": has_reading,
                "reading": reading_hiragana if has_reading else None,
            }
        )

    return segments


def _tokenize_via_mecab(text: str) -> List[Dict[str, Any]]:
    if mecab_controller is None:
        return fallback_tokens(text)

    parsed = mecab_controller.translate(text)
    tokens: List[Dict[str, Any]] = []
    position = 0

    for token in parsed:
        word = token.word if hasattr(token, "word") else str(token)
        word_len = len(word)
        if not word:
            continue
        if word.isspace():
            position += word_len
            continue

        token_data: Dict[str, Any] = {
            "word": word,
            "start": position,
            "end": position + word_len,
        }

        reading = getattr(token, "katakana_reading", None)
        if reading:
            token_data["reading"] = reading

        headword = getattr(token, "headword", None)
        if headword:
            token_data["headword"] = headword

        pos = getattr(token, "part_of_speech", None)
        if pos:
            token_data["pos"] = str(pos)

        tokens.append(token_data)
        position += word_len

    return tokens


def _apply_character_name_overrides(
    text: str,
    tokens: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    if (
        not text
        or not tokens
        or get_recent_character_name_index is None
        or merge_tokens_with_character_names is None
    ):
        return tokens

    try:
        name_index = get_recent_character_name_index()
        return merge_tokens_with_character_names(text, tokens, name_index)
    except Exception as exc:
        print(
            f"[mecab_bridge] character-name merge failed: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return tokens


def tokenize_text(text: str) -> List[Dict[str, Any]]:
    try:
        return _apply_character_name_overrides(text, _tokenize_via_mecab(text))
    except Exception as exc:
        print(f"[mecab_bridge] tokenize failed: {exc}", file=sys.stderr, flush=True)
        return _apply_character_name_overrides(text, fallback_tokens(text))


def fallback_furigana(text: str) -> List[Dict[str, Any]]:
    return [
        {
            "text": text,
            "start": 0,
            "end": len(text),
            "hasReading": False,
            "reading": None,
        }
    ]


def get_furigana(text: str) -> List[Dict[str, Any]]:
    try:
        converter = tokens_to_furigana_segments or _tokens_to_furigana_segments_default
        segments = converter(tokenize_text(text))
        return segments if segments else fallback_furigana(text)
    except Exception as exc:
        print(f"[mecab_bridge] furigana failed: {exc}", file=sys.stderr, flush=True)
        return fallback_furigana(text)


def emit(payload: Dict[str, Any]) -> None:
    # Keep stdout ASCII-safe so parent process can parse reliably on Windows
    # regardless of active console code page.
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def handle_request(req: Dict[str, Any]) -> Dict[str, Any]:
    op = req.get("op")

    if op == "health":
        return {"ok": True, "mecabAvailable": MECAB_AVAILABLE}

    if op == "tokenize":
        text = str(req.get("text") or "")
        return {
            "ok": True,
            "mecabAvailable": MECAB_AVAILABLE,
            "tokens": tokenize_text(text),
        }

    if op == "get_furigana":
        text = str(req.get("text") or "")
        return {
            "ok": True,
            "mecabAvailable": MECAB_AVAILABLE,
            "segments": get_furigana(text),
        }

    return {
        "ok": False,
        "mecabAvailable": MECAB_AVAILABLE,
        "error": f"unknown op: {op}",
    }


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("request must be a JSON object")
            emit(handle_request(req))
        except Exception as exc:
            emit({"ok": False, "mecabAvailable": MECAB_AVAILABLE, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
