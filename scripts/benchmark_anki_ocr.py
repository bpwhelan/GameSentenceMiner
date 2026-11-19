"""Prepare a stratified local Anki poster corpus or score ocr_corpus JSONL readings."""

import argparse
import html
import json
import random
import re
import shutil
import sqlite3
import unicodedata
from collections import defaultdict
from contextlib import closing
from pathlib import Path
from statistics import median, quantiles
from tempfile import TemporaryDirectory

from PIL import Image


def collection_snapshot(profile, temporary):
    """Read a stable copy, including committed WAL pages, while Anki owns its database."""
    source = profile / "collection.anki2"
    files = [source, Path(f"{source}-wal"), Path(f"{source}-journal")]

    def versions():
        result = {}
        for path in files:
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            result[path] = (stat.st_size, stat.st_mtime_ns)
        return result

    before = versions()
    for path in before:
        shutil.copyfile(path, temporary / path.name)
    if versions() != before:
        raise RuntimeError("Anki wrote to its collection during the snapshot. Run the sampler again.")
    return sqlite3.connect(temporary / source.name)


def prepare(profile, output):
    media = profile / "collection.media"
    posters = json.loads((media / "_kiku_animation_cache.json").read_text("utf-8"))["images"]
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError("Choose an empty output directory")
    groups = defaultdict(list)
    fields = defaultdict(dict)
    with TemporaryDirectory() as snapshot, closing(collection_snapshot(profile, Path(snapshot))) as db:
        for model, position, name in db.execute("select ntid, ord, name from fields"):
            fields[model][name] = position
        for model, values in db.execute("select mid, flds from notes order by id"):
            indexes = fields[model]
            if not {"Sentence", "Picture"} <= indexes.keys():
                continue
            parts = values.split("\x1f")
            sentence = html.unescape(re.sub("<[^>]*>", "", parts[indexes["Sentence"]])).strip()
            for filename in re.findall(r"""<img[^>]+src=["']([^"']+)""", parts[indexes["Picture"]]):
                filename = html.unescape(filename)
                title = re.match(r"(.+?)_20\d\d-", filename)
                poster = posters.get(filename, {}).get("poster")
                if (
                    title
                    and len(sentence) >= 5
                    and poster
                    and Path(poster).name == poster
                    and (media / poster).is_file()
                ):
                    groups[title[1]].append((poster, sentence))
    rng = random.Random(1711)
    refs = []
    for title, cases in sorted(groups.items()):
        if len(cases) < 5:
            continue
        unique = list(dict(cases).items())
        for poster, sentence in rng.sample(unique, min(4, len(unique))):
            name = f"{len(refs):03}.png"
            with Image.open(media / poster) as image:
                image.convert("RGB").save(output / name, compress_level=1)
            refs.append({"file": name, "title": title, "poster": poster, "sentence": sentence})
    if not refs:
        raise ValueError("No matching posters with Sentence and Picture fields were found")
    (output / "refs.json").write_text(json.dumps(refs, ensure_ascii=False), encoding="utf-8")


def normalize(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text) if c.isalnum())


def substring_edits(reference, text):
    """Minimum edit distance to a substring, ignoring unrelated UI at either end."""
    previous = [0] * (len(text) + 1)
    for i, expected in enumerate(reference, 1):
        row = [i]
        for j, actual in enumerate(text, 1):
            row.append(min(previous[j] + 1, row[-1] + 1, previous[j - 1] + (actual != expected)))
        previous = row
    return min(previous)


def score(folder, file, visible=None):
    refs = {r["file"]: normalize(r["sentence"]) for r in json.loads((folder / "refs.json").read_text("utf-8"))}
    rows = [json.loads(s) for s in file.read_text("utf-8-sig").splitlines()]
    first = [r for r in rows if r.get("repeat", 0) == 0]
    if len(first) != len(refs) or {r["file"] for r in first} != set(refs):
        raise ValueError(f"Incomplete or mismatched corpus: {file}")
    distances = [substring_edits(refs[r["file"]], normalize(r["result"]["text"])) for r in first]
    timing = {}
    for repeat in sorted({r.get("repeat", 0) for r in rows}):
        group = [r for r in rows if r.get("repeat", 0) == repeat]
        if len(group) != len(refs) or {r["file"] for r in group} != set(refs):
            raise ValueError(f"Incomplete reading {repeat}: {file}")
        values = [r["ms"] for r in group]
        timing[repeat] = {
            "p50_ms": round(median(values), 2),
            "p95_ms": round(quantiles(values, n=20, method="inclusive")[18], 2) if len(values) > 1 else values[0],
        }
    summary = {
        "images": len(first),
        "exact_sentences": distances.count(0),
        "sentence_edits_pct": round(100 * sum(distances) / sum(map(len, refs.values())), 2),
        "timings": timing,
    }
    if visible:
        labels = {k: normalize(v) for k, v in json.loads(visible.read_text("utf-8-sig")).items()}
        if not labels or not labels.keys() <= refs.keys() or not all(labels.values()):
            raise ValueError("Visible references must name corpus images and contain transcribed text")
        edits = [
            substring_edits(labels[r["file"]], normalize(r["result"]["text"])) for r in first if r["file"] in labels
        ]
        summary["visible"] = {
            "passages": len(edits),
            "exact": edits.count(0),
            "edits_pct": round(100 * sum(edits) / sum(map(len, labels.values())), 2),
        }
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    make = commands.add_parser("prepare")
    make.add_argument("anki_profile", type=Path)
    make.add_argument("output", type=Path)
    measure = commands.add_parser("score")
    measure.add_argument("corpus", type=Path)
    measure.add_argument("files", type=Path, nargs="+")
    measure.add_argument("--visible", type=Path, help="Optional JSON object mapping image names to visible passages")
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(args.anki_profile, args.output)
    else:
        print(json.dumps({file.stem: score(args.corpus, file, args.visible) for file in args.files}, indent=2))
