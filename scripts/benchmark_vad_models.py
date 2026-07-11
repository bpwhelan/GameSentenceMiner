from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
import traceback
from dataclasses import asdict, dataclass, is_dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


MODEL_NAMES = ("firered", "silero", "whisper")


@dataclass(frozen=True)
class TimingSummary:
    count: int
    mean_seconds: float
    median_seconds: float
    min_seconds: float
    max_seconds: float
    p95_seconds: float


@dataclass(frozen=True)
class RunRecord:
    detection_seconds: float
    render_seconds: float | None
    segments: list[dict[str, Any]]
    transcript: str
    text_similarity: float
    output_audio: str
    output_bytes: int


@dataclass(frozen=True)
class ModelBenchmark:
    model: str
    cold_run: RunRecord | None
    warmup_runs: int
    timed_runs: list[RunRecord]
    detection_summary: TimingSummary | None
    render_summary: TimingSummary | None
    failures: list[str]


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        raise ValueError("percentile() requires at least one value")
    if fraction <= 0:
        return min(values)
    if fraction >= 1:
        return max(values)

    sorted_values = sorted(values)
    if len(sorted_values) == 1:
        return sorted_values[0]

    index = (len(sorted_values) - 1) * fraction
    lower_index = int(math.floor(index))
    upper_index = int(math.ceil(index))
    if lower_index == upper_index:
        return sorted_values[lower_index]

    lower_value = sorted_values[lower_index]
    upper_value = sorted_values[upper_index]
    return lower_value + (upper_value - lower_value) * (index - lower_index)


def summarize(values: list[float]) -> TimingSummary | None:
    if not values:
        return None
    return TimingSummary(
        count=len(values),
        mean_seconds=statistics.fmean(values),
        median_seconds=statistics.median(values),
        min_seconds=min(values),
        max_seconds=max(values),
        p95_seconds=percentile(values, 0.95),
    )


def parse_models(raw_value: str) -> list[str]:
    models = []
    for item in raw_value.split(","):
        model = item.strip().lower()
        if not model:
            continue
        if model not in MODEL_NAMES:
            raise argparse.ArgumentTypeError(
                f"Unsupported model '{model}'. Expected a comma-separated subset of: {', '.join(MODEL_NAMES)}."
            )
        if model not in models:
            models.append(model)
    if not models:
        raise argparse.ArgumentTypeError("At least one model must be selected.")
    return models


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Benchmark GSM's FireRed, Silero, and Whisper VAD processors on one audio file. "
            "The default benchmark times detection only; use --render-trims to include trim rendering."
        )
    )
    parser.add_argument("audio_path", type=Path, help="Audio file to benchmark.")
    parser.add_argument(
        "--models",
        type=parse_models,
        default=list(MODEL_NAMES),
        help="Comma-separated models to benchmark. Default: firered,silero,whisper.",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=5,
        help="Timed iterations after cold run and warmup. Default: 5.",
    )
    parser.add_argument(
        "--warmup",
        type=int,
        default=2,
        help="Warmup iterations excluded from timing. Default: 2.",
    )
    parser.add_argument(
        "--text",
        default="",
        help="Optional mined text passed to VAD processors. Empty by default to benchmark detection only.",
    )
    parser.add_argument(
        "--language",
        default="ja",
        help="Whisper target language code. Default: ja.",
    )
    parser.add_argument(
        "--whisper-model",
        default="base",
        help="faster-whisper model name or local path. Default: base.",
    )
    parser.add_argument(
        "--disable-whisper-vad-filter",
        action="store_true",
        help="Disable faster-whisper's internal VAD filter during Whisper transcription.",
    )
    parser.add_argument(
        "--allow-gpu",
        action="store_true",
        help="Allow GPU inference when GSM detects CUDA. Default forces CPU for repeatability.",
    )
    parser.add_argument(
        "--render-trims",
        action="store_true",
        help="Also render each detected trim to audio and time that step separately.",
    )
    parser.add_argument(
        "--keep-outputs",
        action="store_true",
        help="Keep rendered trim outputs from --render-trims. By default they are deleted after timing.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=REPO_ROOT / "temp" / "vad-benchmark",
        help="Directory for temporary wav files and optional rendered trims.",
    )
    parser.add_argument(
        "--output-extension",
        default="opus",
        choices=("opus", "mp3", "ogg", "aac", "m4a"),
        help="Trim output extension when --render-trims is used. Default: opus.",
    )
    parser.add_argument(
        "--firered-threshold",
        type=float,
        default=0.4,
        help="FireRed speech probability threshold. Default: 0.4.",
    )
    parser.add_argument(
        "--firered-min-speech-frame",
        type=int,
        default=20,
        help="FireRed minimum speech frames. Each frame shift is 10 ms. Default: 20.",
    )
    parser.add_argument(
        "--json-output",
        type=Path,
        help="Optional path to write full benchmark results as JSON.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print full benchmark results as JSON instead of the human-readable summary.",
    )
    parser.add_argument(
        "--verbose-errors",
        action="store_true",
        help="Include tracebacks in model failure output.",
    )
    return parser


def build_config(args: argparse.Namespace) -> SimpleNamespace:
    return SimpleNamespace(
        vad=SimpleNamespace(
            use_cpu_for_inference_v2=not args.allow_gpu,
            whisper_model=args.whisper_model,
            use_vad_filter_for_whisper=not args.disable_whisper_vad_filter,
            cut_and_splice_segments=False,
            beginning_offset=0.0,
            trim_beginning=True,
            splice_padding=0.1,
            firered_smooth_window_size=5,
            firered_speech_threshold=args.firered_threshold,
            firered_min_speech_frame=args.firered_min_speech_frame,
            firered_max_speech_frame=2000,
            firered_min_silence_frame=20,
            firered_merge_silence_frame=0,
            firered_extend_speech_frame=0,
        ),
        audio=SimpleNamespace(extension=args.output_extension, end_offset=0.0),
        general=SimpleNamespace(target_language=args.language),
    )


def install_benchmark_config(args: argparse.Namespace):
    from GameSentenceMiner import vad
    from GameSentenceMiner.util.media import ffmpeg

    config = build_config(args)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    vad.get_config = lambda: config
    vad.get_temporary_directory = lambda: str(args.output_dir)
    ffmpeg.get_config = lambda: config
    return vad, ffmpeg


def create_processor(vad_module, model_name: str):
    if model_name == "firered":
        return vad_module.FireRedVADProcessor()
    if model_name == "silero":
        return vad_module.SileroVADProcessor()
    if model_name == "whisper":
        return vad_module.WhisperVADProcessor()
    raise ValueError(f"Unsupported model: {model_name}")


def segment_to_dict(segment: Any) -> dict[str, Any]:
    if is_dataclass(segment):
        return asdict(segment)
    if hasattr(segment, "__dict__"):
        return dict(segment.__dict__)
    return {"value": str(segment)}


def output_path_for(args: argparse.Namespace, audio_path: Path, model_name: str, phase: str, index: int) -> Path:
    suffix = f".{model_name}.{phase}-{index}.{args.output_extension}"
    return args.output_dir / f"{audio_path.stem}{suffix}"


def run_once(
    args: argparse.Namespace,
    vad_module,
    processor,
    audio_path: Path,
    model_name: str,
    phase: str,
    index: int,
) -> RunRecord:
    start = time.perf_counter()
    detection = processor._detect_voice_activity(str(audio_path), args.text)
    detection_seconds = time.perf_counter() - start

    render_seconds = None
    output_audio = ""
    output_bytes = 0

    if args.render_trims and detection.segments:
        output_path = output_path_for(args, audio_path, model_name, phase, index)
        output_path.unlink(missing_ok=True)

        render_start = time.perf_counter()
        result = processor._render_decision(
            (detection.segments[0].start, detection.segments[-1].end),
            detection,
            str(audio_path),
            str(output_path),
        )
        render_seconds = time.perf_counter() - render_start

        output_audio = str(getattr(result, "output_audio", "") or "")
        rendered_path = Path(output_audio) if output_audio else output_path
        if rendered_path.exists():
            output_bytes = rendered_path.stat().st_size
            if not args.keep_outputs:
                rendered_path.unlink(missing_ok=True)

    return RunRecord(
        detection_seconds=detection_seconds,
        render_seconds=render_seconds,
        segments=[segment_to_dict(segment) for segment in detection.segments],
        transcript=getattr(detection, "transcript", "") or "",
        text_similarity=float(getattr(detection, "text_similarity", 100.0) or 0.0),
        output_audio=output_audio if args.keep_outputs else "",
        output_bytes=output_bytes,
    )


def record_failure(error: BaseException, verbose: bool) -> str:
    if verbose:
        return traceback.format_exc()
    return f"{type(error).__name__}: {error}"


def run_phase(
    args: argparse.Namespace,
    vad_module,
    processor,
    audio_path: Path,
    model_name: str,
    phase: str,
    count: int,
) -> tuple[list[RunRecord], list[str]]:
    records: list[RunRecord] = []
    failures: list[str] = []
    for index in range(count):
        try:
            records.append(run_once(args, vad_module, processor, audio_path, model_name, phase, index))
        except Exception as error:  # noqa: BLE001 - benchmark should continue and report per-model failures.
            failures.append(record_failure(error, args.verbose_errors))
    return records, failures


def benchmark_model(args: argparse.Namespace, vad_module, audio_path: Path, model_name: str) -> ModelBenchmark:
    failures: list[str] = []
    processor = create_processor(vad_module, model_name)

    cold_run = None
    try:
        cold_run = run_once(args, vad_module, processor, audio_path, model_name, "cold", 0)
    except Exception as error:  # noqa: BLE001 - benchmark should continue with the next model.
        failures.append(record_failure(error, args.verbose_errors))
        return ModelBenchmark(
            model=model_name,
            cold_run=None,
            warmup_runs=0,
            timed_runs=[],
            detection_summary=None,
            render_summary=None,
            failures=failures,
        )

    warmup_runs, warmup_failures = run_phase(args, vad_module, processor, audio_path, model_name, "warmup", args.warmup)
    timed_runs, timed_failures = run_phase(
        args, vad_module, processor, audio_path, model_name, "timed", args.iterations
    )
    failures.extend(warmup_failures)
    failures.extend(timed_failures)

    detection_summary = summarize([record.detection_seconds for record in timed_runs])
    render_values = [record.render_seconds for record in timed_runs if record.render_seconds is not None]
    render_summary = summarize(render_values)

    return ModelBenchmark(
        model=model_name,
        cold_run=cold_run,
        warmup_runs=len(warmup_runs),
        timed_runs=timed_runs,
        detection_summary=detection_summary,
        render_summary=render_summary,
        failures=failures,
    )


def seconds_to_ms(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value * 1000.0:.1f} ms"


def print_run(label: str, record: RunRecord | None) -> None:
    if record is None:
        print(f"  {label}: failed")
        return
    print(
        f"  {label}: detect={seconds_to_ms(record.detection_seconds)} "
        f"render={seconds_to_ms(record.render_seconds)} segments={len(record.segments)}"
    )


def print_summary(label: str, summary: TimingSummary | None) -> None:
    if summary is None:
        print(f"  {label}: n/a")
        return
    print(
        f"  {label}: mean={seconds_to_ms(summary.mean_seconds)} "
        f"median={seconds_to_ms(summary.median_seconds)} "
        f"p95={seconds_to_ms(summary.p95_seconds)} "
        f"min={seconds_to_ms(summary.min_seconds)} "
        f"max={seconds_to_ms(summary.max_seconds)} "
        f"n={summary.count}"
    )


def print_human_report(results: list[ModelBenchmark]) -> None:
    for result in results:
        print(f"\n{result.model.upper()}")
        print_run("cold first run", result.cold_run)
        print(f"  warmups completed: {result.warmup_runs}")
        print_summary("timed detection", result.detection_summary)
        print_summary("timed render", result.render_summary)

        representative = result.timed_runs[-1] if result.timed_runs else result.cold_run
        if representative:
            segment_ranges = [
                f"{float(segment.get('start', 0.0)):.3f}-{float(segment.get('end', 0.0)):.3f}s"
                for segment in representative.segments
            ]
            print(f"  representative segments: {', '.join(segment_ranges) if segment_ranges else 'none'}")
            if representative.transcript:
                print(f"  representative transcript: {representative.transcript}")

        if result.failures:
            print(f"  failures: {len(result.failures)}")
            for failure in result.failures[:3]:
                print(f"    {failure}")


def main() -> int:
    parser = build_argument_parser()
    args = parser.parse_args()
    args.iterations = max(0, args.iterations)
    args.warmup = max(0, args.warmup)

    audio_path = args.audio_path.expanduser().resolve()
    if not audio_path.is_file():
        parser.error(f"Audio file does not exist: {audio_path}")

    vad_module, ffmpeg_module = install_benchmark_config(args)
    results = [benchmark_model(args, vad_module, audio_path, model_name) for model_name in args.models]

    payload = {
        "audio_path": str(audio_path),
        "audio_duration_seconds": ffmpeg_module.get_audio_length(str(audio_path)),
        "iterations": args.iterations,
        "warmup": args.warmup,
        "render_trims": args.render_trims,
        "results": [asdict(result) for result in results],
    }

    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"Audio: {audio_path}")
        print(f"Duration: {payload['audio_duration_seconds']:.3f}s")
        print(f"Timed iterations: {args.iterations}; warmups excluded: {args.warmup}")
        print_human_report(results)
        if args.json_output:
            print(f"\nJSON written to: {args.json_output}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
