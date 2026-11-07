"""Compare a recorded OCR benchmark session with its texthook reference stream.

Run from the repository root with:
    uv run python scripts/analyze_ocr_benchmark.py

With no path, the newest GSM benchmark session is selected. Pass a session
folder or events.csv path to review a specific recording. The default output
is analysis.md beside the CSV; use --output - to print the complete report.
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


@dataclass(frozen=True)
class Event:
    sequence: int
    source: str
    engine: str
    model: str
    phase: str
    scene: str
    suppressed: bool
    captured_at: datetime
    text: str
    metadata: dict

    @property
    def group(self) -> tuple[str, str, str, str]:
        return self.source, self.engine, self.model, self.phase

    @property
    def group_label(self) -> str:
        parts = [self.source, self.engine]
        if self.model:
            parts.append(self.model)
        if self.phase:
            parts.append(self.phase)
        return " / ".join(parts)


def _parse_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = f"{value[:-1]}+00:00"
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _load_events(csv_path: Path) -> list[Event]:
    events = []
    with csv_path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            # A live recorder can append while this tool reads. Ignore a
            # partially-written final record rather than misaligning the rest.
            if not row.get("sequence") or not row.get("source"):
                continue
            try:
                sequence = int(row["sequence"])
            except ValueError:
                continue
            metadata_raw = row.get("metadata_json") or "{}"
            try:
                metadata = json.loads(metadata_raw)
            except (TypeError, json.JSONDecodeError):
                metadata = {}
            if not isinstance(metadata, dict):
                metadata = {}

            captured_at = _parse_datetime(row.get("captured_at_utc", ""))
            captured_at = captured_at or _parse_datetime(row.get("recorded_at_utc", ""))
            if captured_at is None:
                continue

            model_data = metadata.get("ocr_model")
            if not isinstance(model_data, dict):
                model_data = {}
            events.append(
                Event(
                    sequence=sequence,
                    source=row.get("source", ""),
                    engine=row.get("engine") or metadata.get("ocr_engine") or "unknown",
                    model=row.get("model") or model_data.get("size", ""),
                    phase=metadata.get("overlay_phase", "") if row.get("source") == "overlay" else "",
                    scene=row.get("scene") or metadata.get("ocr_scene") or "",
                    suppressed=(row.get("suppressed") or "").casefold() == "true",
                    captured_at=captured_at,
                    text=row.get("text") or "",
                    metadata=metadata,
                )
            )
    return events


def _automatic_ocr_events(events: list[Event]) -> tuple[list[Event], int, int]:
    """Return automatic OCR candidates, plus ignored manual and detection counts."""
    candidates = []
    manual_count = 0
    detection_count = 0
    manual_sources = {"ocr_manual", "screen_cropper", "secondary", "hotkey", "manual"}
    for event in events:
        if event.source in manual_sources:
            manual_count += 1
            continue
        if event.source not in {"ocr", "overlay"}:
            continue
        if event.metadata.get("overlay_manual") is True or not event.suppressed:
            manual_count += 1
            continue
        if event.source == "overlay" and event.phase == "local_detection":
            detection_count += 1
            continue
        candidates.append(event)
    return candidates, manual_count, detection_count


def _deduplicate_overlay_attempts(candidates: list[Event]) -> tuple[list[Event], dict[tuple, int]]:
    """Keep one representative per overlay workflow, engine, and phase."""
    grouped: dict[tuple, list[Event]] = defaultdict(list)
    passthrough = []
    for event in candidates:
        if event.source != "overlay":
            passthrough.append(event)
            continue
        workflow_id = event.metadata.get("workflow_id") or f"event-{event.sequence}"
        grouped[(event.engine, event.model, event.phase, workflow_id)].append(event)

    representatives = []
    raw_attempts: dict[tuple, int] = defaultdict(int)
    for (engine, model, phase, _workflow), attempts in grouped.items():
        group = ("overlay", engine, model, phase)
        raw_attempts[group] += len(attempts)
        successful = [attempt for attempt in attempts if attempt.metadata.get("success") is not False]
        nonempty = [attempt for attempt in successful if attempt.text.strip()]
        pool = nonempty or successful or attempts
        representatives.append(
            max(
                pool,
                key=lambda attempt: (
                    int(attempt.metadata.get("attempt", 0) or 0),
                    attempt.captured_at,
                    attempt.sequence,
                ),
            )
        )
    return passthrough + representatives, raw_attempts


def _compact(text: str) -> str:
    """Normalize width and remove whitespace, while keeping punctuation."""
    return "".join(char for char in unicodedata.normalize("NFKC", text) if not char.isspace())


def _letters_and_numbers(text: str) -> str:
    """Normalize width and ignore spacing/punctuation for a lenient comparison."""
    return "".join(
        char
        for char in unicodedata.normalize("NFKC", text)
        if not char.isspace() and not unicodedata.category(char).startswith("P")
    )


def _levenshtein(left: str, right: str) -> int:
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_char in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_char != right_char),
                )
            )
        previous = current
    return previous[-1]


def _score(reference: str, candidate: str) -> dict:
    reference_compact = _compact(reference)
    candidate_compact = _compact(candidate)
    reference_lenient = _letters_and_numbers(reference)
    candidate_lenient = _letters_and_numbers(candidate)
    strict_distance = _levenshtein(reference_compact, candidate_compact)
    lenient_distance = _levenshtein(reference_lenient, candidate_lenient)
    return {
        "strict_exact": reference_compact == candidate_compact,
        "lenient_exact": reference_lenient == candidate_lenient,
        "strict_distance": strict_distance,
        "strict_cer": strict_distance / max(1, len(reference_compact)),
        "lenient_distance": lenient_distance,
        "lenient_cer": lenient_distance / max(1, len(reference_lenient)),
        "reference_chars": len(reference_lenient),
    }


def _scene_compatible(reference: Event, candidate: Event) -> bool:
    return not (reference.scene and candidate.scene and reference.scene.casefold() != candidate.scene.casefold())


def _align(
    hooks: list[Event], candidates: list[Event], window_seconds: float
) -> tuple[dict[tuple[int, tuple[str, str, str, str]], Event], set[int]]:
    """Associate each OCR event with its nearest hook in the same scene."""
    assigned: dict[tuple[int, tuple[str, str, str, str]], list[tuple[float, Event]]] = defaultdict(list)
    unmatched = set()
    for candidate in candidates:
        possible = [hook for hook in hooks if _scene_compatible(hook, candidate)]
        if not possible:
            unmatched.add(candidate.sequence)
            continue
        hook = min(possible, key=lambda item: abs((candidate.captured_at - item.captured_at).total_seconds()))
        delta = abs((candidate.captured_at - hook.captured_at).total_seconds())
        if delta > window_seconds:
            unmatched.add(candidate.sequence)
            continue
        assigned[(hook.sequence, candidate.group)].append((delta, candidate))

    selected = {}
    for (hook_sequence, group), readings in assigned.items():
        # For repeated OCR scans around one hook event, compare the closest
        # emitted result. This avoids selecting an answer by similarity itself.
        _, candidate = min(readings, key=lambda pair: (pair[0], pair[1].sequence))
        selected[(hook_sequence, group)] = candidate
    return selected, unmatched


def _percent(value: float) -> str:
    return f"{value * 100:.1f}%"


def _maybe_percent(value: float | None) -> str:
    return _percent(value) if value is not None else "n/a"


def _pretty_text(text: str) -> str:
    escaped = text.replace("|", "\\|").replace("\r\n", "\n").replace("\r", "\n")
    return escaped.replace("\n", "<br>") or "*empty result*"


def _build_report(
    csv_path: Path,
    events: list[Event],
    hooks: list[Event],
    candidates: list[Event],
    manual_count: int,
    detection_count: int,
    raw_attempts: dict[tuple, int],
    window_seconds: float,
    include_exact: bool,
) -> tuple[str, str]:
    selected, unmatched = _align(hooks, candidates, window_seconds)
    groups = sorted({candidate.group for candidate in candidates}, key=lambda key: (key[0], key[1], key[2], key[3]))

    summary_rows = []
    for group in groups:
        reference_pairs = []
        blank_count = 0
        for hook in hooks:
            candidate = selected.get((hook.sequence, group))
            if candidate is None:
                continue
            if not candidate.text.strip():
                blank_count += 1
                continue
            reference_pairs.append((hook, candidate, _score(hook.text, candidate.text)))
        exact_count = sum(score["strict_exact"] for _, _, score in reference_pairs)
        lenient_count = sum(score["lenient_exact"] for _, _, score in reference_pairs)
        reference_chars = sum(score["reference_chars"] for _, _, score in reference_pairs)
        error_chars = sum(score["lenient_distance"] for _, _, score in reference_pairs)
        cer_values = [score["lenient_cer"] for _, _, score in reference_pairs]
        event_count = sum(1 for item in candidates if item.group == group)
        raw_count = raw_attempts.get(group, event_count)
        matched_refs = len({hook.sequence for hook, _, _ in reference_pairs})
        summary_rows.append(
            {
                "group": group,
                "label": " / ".join(part for part in (group[0], group[1], group[2], group[3]) if part),
                "events": event_count,
                "attempts": raw_count,
                "reads": len(reference_pairs),
                "coverage": matched_refs / max(1, len(hooks)),
                "strict_exact": exact_count / len(reference_pairs) if reference_pairs else None,
                "lenient_exact": lenient_count / len(reference_pairs) if reference_pairs else None,
                "weighted_cer": error_chars / reference_chars if reference_chars else None,
                "median_cer": statistics.median(cer_values) if cer_values else None,
                "blank": blank_count,
                "missed": len(hooks) - matched_refs,
            }
        )

    duration_seconds = 0.0
    if events:
        stamps = [event.captured_at for event in events]
        duration_seconds = max(0.0, (max(stamps) - min(stamps)).total_seconds())
    minutes, seconds = divmod(int(duration_seconds), 60)
    snapshot_time = datetime.now().astimezone().isoformat(timespec="seconds")
    try:
        session = json.loads((csv_path.parent / "session.json").read_text(encoding="utf-8"))
        settings = session.get("settings") or {}
    except (OSError, json.JSONDecodeError):
        settings = {}
    overlay_settings = settings.get("overlay") or {}
    vita_settings = settings.get("vita_ocr") or {}
    setting_labels = [
        ("OCR1", settings.get("ocr1")),
        ("OCR2", settings.get("ocr2")),
        ("two-pass", settings.get("two_pass")),
        ("language", settings.get("language")),
        ("scan interval", settings.get("scan_rate")),
        ("overlay engine", overlay_settings.get("engine")),
        ("starting VOCR model", vita_settings.get("model")),
    ]
    setting_summary = ", ".join(f"{label} {value}" for label, value in setting_labels if value is not None)

    lines = [
        "# OCR Benchmark Review",
        "",
        f"- CSV: `{csv_path}`",
        f"- Snapshot generated: {snapshot_time}",
        f"- Events read: {len(events)}; duration: {minutes}m {seconds:02d}s; texthook references: {len(hooks)}",
        f"- Matching window: up to {window_seconds:g}s from captured time; scene names must agree when both are present.",
        f"- Automatic OCR candidates: {len(candidates)}; ignored manual rows: {manual_count}; geometry-only detections: {detection_count}; unmatched candidates: {len(unmatched)}.",
        *([f"- Settings at session start: {setting_summary}."] if setting_summary else []),
        "",
        "Exact compares NFKC-normalized text after removing whitespace. Relaxed exact and CER also ignore punctuation, so ellipsis/quote style differences do not count as character errors.",
        "Overlay retries are grouped by workflow, engine, and phase; the last successful nonempty attempt represents that group. Each OCR candidate is assigned to its nearest hook in the same scene. When multiple readings map to one hook and group, the closest timestamp is scored.",
        "",
        "## Results by engine",
        "",
        "| Source / engine / model / phase | Readings / hooks | Coverage | Exact | Relaxed exact | Weighted CER | Median CER | Blank hook matches | Unmatched hooks |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in summary_rows:
        lines.append(
            f"| {row['label']} | {row['reads']}/{len(hooks)} ({row['events']} events, {row['attempts']} attempts) | "
            f"{_percent(row['coverage'])} | {_maybe_percent(row['strict_exact'])} | {_maybe_percent(row['lenient_exact'])} | "
            f"{_maybe_percent(row['weighted_cer'])} | {_maybe_percent(row['median_cer'])} | {row['blank']} | {row['missed']} |"
        )

    active_groups = {row["group"] for row in summary_rows if row["events"] >= 3}

    if not hooks:
        lines.extend(["", "No texthook reference rows were found, so OCR accuracy could not be scored."])

    lines.extend(["", "## Differences for manual review", ""])
    difference_count = 0
    for hook in hooks:
        readings = []
        for group in groups:
            candidate = selected.get((hook.sequence, group))
            if candidate is None:
                if group in active_groups:
                    readings.append((group, None, None))
                continue
            score = _score(hook.text, candidate.text)
            if candidate.text.strip() and score["lenient_exact"]:
                continue
            readings.append((group, candidate, score))
        if not readings and not include_exact:
            continue
        difference_count += 1
        time_label = hook.captured_at.astimezone().strftime("%H:%M:%S")
        lines.append(f"### Hook #{hook.sequence} at {time_label}")
        lines.append("")
        lines.append(f"**Texthook:** {_pretty_text(hook.text)}")
        lines.append("")
        if not readings:
            lines.append("All available OCR readings matched after punctuation normalization.")
        else:
            for group, candidate, score in readings:
                if candidate is None:
                    group_label = " / ".join(part for part in (group[0], group[1], group[2], group[3]) if part)
                    lines.append(f"- **{group_label}** — *no reading within window*")
                    continue
                if not candidate.text.strip():
                    output = "*empty result*"
                else:
                    output = _pretty_text(candidate.text)
                delta = abs((candidate.captured_at - hook.captured_at).total_seconds())
                lines.append(
                    f"- **{candidate.group_label}** — {delta:.2f}s; relaxed CER {_percent(score['lenient_cer'])}; "
                    f"strict CER {_percent(score['strict_cer'])}: {output}"
                )
        lines.append("")
    if difference_count == 0:
        lines.append("No unmatched or text-different hook readings were found.")

    if unmatched:
        unmatched_events = [candidate for candidate in candidates if candidate.sequence in unmatched]
        lines.extend(["", "## OCR events outside the matching window", ""])
        for candidate in unmatched_events[:100]:
            time_label = candidate.captured_at.astimezone().strftime("%H:%M:%S")
            lines.append(
                f"- #{candidate.sequence} {time_label} — {candidate.group_label}: {_pretty_text(candidate.text)}"
            )
        if len(unmatched_events) > 100:
            lines.append(f"- … {len(unmatched_events) - 100} more omitted")

    report = "\n".join(lines).rstrip() + "\n"
    headline_rows = [
        (
            f"Read {len(events)} events across {minutes}m {seconds:02d}s; {len(hooks)} texthook lines; "
            f"matching window up to {window_seconds:g}s."
        ),
        "Engine summary:",
    ]
    if summary_rows:
        headline_rows.extend(
            f"  {row['label']}: {row['reads']}/{len(hooks)} paired, {row['coverage'] * 100:.1f}% coverage, "
            f"{_maybe_percent(row['lenient_exact'])} relaxed exact, {_maybe_percent(row['weighted_cer'])} weighted CER"
            for row in summary_rows
        )
    headline_rows.append(
        f"Manual rows ignored: {manual_count}; geometry detections ignored: {detection_count}; unmatched OCR events: {len(unmatched)}."
    )
    return report, "\n".join(headline_rows)


def _session_csv(path: Path | None) -> Path:
    if path is not None:
        path = path.expanduser().resolve()
        csv_path = path / "events.csv" if path.is_dir() else path
    else:
        from GameSentenceMiner.util.data_directory import resolve_data_directory

        root = Path(resolve_data_directory()) / "ocr-benchmarks"
        sessions = (
            [folder for folder in root.iterdir() if folder.is_dir() and (folder / "events.csv").is_file()]
            if root.exists()
            else []
        )
        if not sessions:
            raise FileNotFoundError(f"No OCR benchmark sessions found under {root}")

        def last_recorded_change(folder: Path) -> float:
            paths = [folder / "events.csv", folder / "session.json"]
            return max(path.stat().st_mtime for path in paths if path.exists())

        csv_path = max(sessions, key=last_recorded_change) / "events.csv"
    if not csv_path.is_file():
        raise FileNotFoundError(f"OCR benchmark CSV not found: {csv_path}")
    return csv_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", help="session folder or events.csv; defaults to the newest GSM session")
    parser.add_argument(
        "--window-seconds",
        type=float,
        default=2.0,
        help="maximum time gap for pairing OCR and hook events (default: 2)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Markdown report path; defaults to analysis.md beside events.csv; use - for stdout",
    )
    parser.add_argument(
        "--include-exact",
        action="store_true",
        help="include hook lines whose OCR matches after punctuation normalization",
    )
    args = parser.parse_args()
    if args.window_seconds < 0:
        parser.error("--window-seconds must be nonnegative")

    try:
        csv_path = _session_csv(Path(args.path) if args.path else None)
        events = _load_events(csv_path)
    except (FileNotFoundError, OSError, ValueError) as error:
        parser.exit(2, f"error: {error}\n")

    hooks = sorted(
        (event for event in events if event.source == "texthook" and event.text.strip()),
        key=lambda event: (event.captured_at, event.sequence),
    )
    candidates, manual_count, detection_count = _automatic_ocr_events(events)
    candidates, raw_attempts = _deduplicate_overlay_attempts(candidates)
    report, summary = _build_report(
        csv_path,
        events,
        hooks,
        candidates,
        manual_count,
        detection_count,
        raw_attempts,
        args.window_seconds,
        args.include_exact,
    )

    print(summary)
    if args.output == "-":
        print(report)
    else:
        output_path = Path(args.output).expanduser() if args.output else csv_path.parent / "analysis.md"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(report, encoding="utf-8")
        print(f"Detailed report: {output_path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
