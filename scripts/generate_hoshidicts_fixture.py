#!/usr/bin/env python3
"""Build the deterministic, redistributable HoshiDicts test dictionary."""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = REPO_ROOT / "GSM_Overlay" / "hoshidicts_host" / "fixtures" / "tiny-yomitan"
FIXTURE_FILES = (
    "index.json",
    "term_bank_1.json",
    "term_meta_bank_1.json",
    "kanji_bank_1.json",
    "tag_bank_1.json",
    "styles.css",
    "media/sample.txt",
)
ZIP_TIMESTAMP = (2026, 1, 1, 0, 0, 0)
TEXT_SUFFIXES = frozenset({".css", ".json", ".txt"})


def fixture_bytes(source_path: Path) -> bytes:
    data = source_path.read_bytes()
    if source_path.suffix.lower() in TEXT_SUFFIXES:
        return data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return data


def build_fixture(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(
        output,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for relative_name in FIXTURE_FILES:
            source_path = source / relative_name
            info = zipfile.ZipInfo(relative_name, date_time=ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, fixture_bytes(source_path), compresslevel=9)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help="Directory containing the fixture source files",
    )
    parser.add_argument("output", type=Path, help="Output Yomitan ZIP path")
    args = parser.parse_args()
    build_fixture(args.source.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
