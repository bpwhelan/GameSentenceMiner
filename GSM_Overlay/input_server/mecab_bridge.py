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
from typing import Any, Dict, List, Tuple


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
GSM_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if GSM_ROOT not in sys.path:
    sys.path.insert(0, GSM_ROOT)

mecab_controller = None
MECAB_AVAILABLE = False

try:
    from GameSentenceMiner.mecab.mecab_controller import MecabController

    mecab_controller = MecabController()
    MECAB_AVAILABLE = True
    print("[mecab_bridge] MeCab initialized", file=sys.stderr, flush=True)
except Exception as exc:
    print(f"[mecab_bridge] MeCab unavailable: {exc}", file=sys.stderr, flush=True)


def is_kanji(char: str) -> bool:
    code = ord(char)
    return (
        0x4E00 <= code <= 0x9FFF
        or 0x3400 <= code <= 0x4DBF
        or 0x20000 <= code <= 0x2A6DF
    )


def has_kanji(text: str) -> bool:
    return any(is_kanji(c) for c in text)


def katakana_to_hiragana(text: str) -> str:
    out: List[str] = []
    for c in text:
        code = ord(c)
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(c)
    return "".join(out)


def fallback_tokens(text: str) -> List[Dict[str, Any]]:
    tokens: List[Dict[str, Any]] = []
    for i, ch in enumerate(text):
        if not ch.isspace():
            tokens.append({"word": ch, "start": i, "end": i + 1})
    return tokens


def tokenize_text(text: str) -> List[Dict[str, Any]]:
    if mecab_controller is None:
        return fallback_tokens(text)

    try:
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
    except Exception as exc:
        print(f"[mecab_bridge] tokenize failed: {exc}", file=sys.stderr, flush=True)
        return fallback_tokens(text)


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
    if mecab_controller is None:
        return fallback_furigana(text)

    try:
        parsed = mecab_controller.translate(text)
        segments: List[Dict[str, Any]] = []
        position = 0

        for token in parsed:
            word = token.word if hasattr(token, "word") else str(token)
            word_len = len(word)
            if not word:
                continue

            segment: Dict[str, Any] = {
                "text": word,
                "start": position,
                "end": position + word_len,
                "hasReading": False,
                "reading": None,
            }

            if has_kanji(word):
                reading = getattr(token, "katakana_reading", None)
                if reading:
                    reading = katakana_to_hiragana(reading)
                    if reading != word:
                        segment["hasReading"] = True
                        segment["reading"] = reading

            segments.append(segment)
            position += word_len

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
