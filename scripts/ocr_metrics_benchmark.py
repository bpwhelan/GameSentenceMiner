import argparse
from collections import Counter
import csv
import difflib
import json
import shutil
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageFilter, ImageEnhance, ImageOps
import re

try:
    import regex as unicode_regex
except Exception:
    unicode_regex = None

try:
    from rapidfuzz.distance import Levenshtein

    def levenshtein_distance(a: str, b: str) -> int:
        return Levenshtein.distance(a, b)
except Exception:

    def levenshtein_distance(a: str, b: str) -> int:
        if a == b:
            return 0
        if not a:
            return len(b)
        if not b:
            return len(a)
        if len(a) < len(b):
            a, b = b, a
        previous = list(range(len(b) + 1))
        for i, ca in enumerate(a, start=1):
            current = [i]
            for j, cb in enumerate(b, start=1):
                insertions = previous[j] + 1
                deletions = current[j - 1] + 1
                substitutions = previous[j - 1] + (ca != cb)
                current.append(min(insertions, deletions, substitutions))
            previous = current
        return previous[-1]


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

run = None
get_app_directory = None
get_ocr_ocr1 = None
get_ocr_ocr2 = None

try:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except Exception:
    matplotlib = None
    plt = None


ENGINE_ALIASES = {
    "lens": "glens",
    "law": "glens",
}

# ---------------------------------------------------------------------------
# Image preprocessing filter definitions for --test-filter mode
# ---------------------------------------------------------------------------


def _apply_grayscale(img: Image.Image) -> Image.Image:
    return img.convert("L").convert("RGB")


def _apply_grayscale_autocontrast(img: Image.Image) -> Image.Image:
    return ImageOps.autocontrast(img.convert("L").convert("RGB"), cutoff=2)


def _apply_grayscale_unsharp(img: Image.Image) -> Image.Image:
    return img.convert("L").convert("RGB").filter(ImageFilter.UnsharpMask(radius=2, percent=200, threshold=3))


def _apply_grayscale_sharpen(img: Image.Image) -> Image.Image:
    return img.convert("L").convert("RGB").filter(ImageFilter.SHARPEN)


def _apply_threshold(img: Image.Image, threshold: int = 128) -> Image.Image:
    return img.convert("L").point(lambda p: 255 if p >= threshold else 0).convert("RGB")


def _apply_upscale_2x(img: Image.Image) -> Image.Image:
    return img.resize((img.width * 2, img.height * 2), Image.Resampling.LANCZOS)


def _apply_upscale_2x_gray(img: Image.Image) -> Image.Image:
    return img.resize((img.width * 2, img.height * 2), Image.Resampling.LANCZOS).convert("L").convert("RGB")


# Each entry: name (slug), description, apply callable (Image -> Image)
# Top 3 performing filters (active by default).
FILTER_CONFIGS: list[dict] = [
    {
        "name": "grayscale",
        "description": "Convert to grayscale",
        "apply": _apply_grayscale,
    },
    {
        "name": "autocontrast",
        "description": "Auto-contrast histogram stretch (cutoff=2%)",
        "apply": lambda img: ImageOps.autocontrast(img, cutoff=2),
    },
    {
        "name": "original",
        "description": "No preprocessing (baseline)",
        "apply": lambda img: img.copy(),
    },
]

# Additional filters — extend FILTER_CONFIGS with these to run the full suite:
_EXTRA_FILTER_CONFIGS: list[dict] = [
    {
        "name": "grayscale_autocontrast",
        "description": "Grayscale + auto-contrast (cutoff=2%)",
        "apply": _apply_grayscale_autocontrast,
    },
    {
        "name": "grayscale_unsharp",
        "description": "Grayscale + unsharp mask (radius=2, 200%)",
        "apply": _apply_grayscale_unsharp,
    },
    {
        "name": "grayscale_sharpen",
        "description": "Grayscale + sharpen kernel",
        "apply": _apply_grayscale_sharpen,
    },
    {
        "name": "gaussian_blur_r1",
        "description": "Gaussian blur radius=1 (light denoise)",
        "apply": lambda img: img.filter(ImageFilter.GaussianBlur(radius=1)),
    },
    {
        "name": "gaussian_blur_r2",
        "description": "Gaussian blur radius=2",
        "apply": lambda img: img.filter(ImageFilter.GaussianBlur(radius=2)),
    },
    {
        "name": "unsharp_mask",
        "description": "Unsharp mask (radius=2, percent=150, threshold=3)",
        "apply": lambda img: img.filter(ImageFilter.UnsharpMask(radius=2, percent=150, threshold=3)),
    },
    {
        "name": "unsharp_mask_strong",
        "description": "Unsharp mask strong (radius=2, percent=300, threshold=2)",
        "apply": lambda img: img.filter(ImageFilter.UnsharpMask(radius=2, percent=300, threshold=2)),
    },
    {
        "name": "sharpen",
        "description": "PIL SHARPEN kernel",
        "apply": lambda img: img.filter(ImageFilter.SHARPEN),
    },
    {
        "name": "edge_enhance",
        "description": "PIL EDGE_ENHANCE filter",
        "apply": lambda img: img.filter(ImageFilter.EDGE_ENHANCE),
    },
    {
        "name": "contrast2x",
        "description": "2x contrast enhancement",
        "apply": lambda img: ImageEnhance.Contrast(img).enhance(2.0),
    },
    {
        "name": "contrast3x",
        "description": "3x contrast enhancement",
        "apply": lambda img: ImageEnhance.Contrast(img).enhance(3.0),
    },
    {
        "name": "brightness_up",
        "description": "1.3x brightness",
        "apply": lambda img: ImageEnhance.Brightness(img).enhance(1.3),
    },
    {
        "name": "brightness_down",
        "description": "0.8x brightness reduction",
        "apply": lambda img: ImageEnhance.Brightness(img).enhance(0.8),
    },
    {
        "name": "equalize",
        "description": "Histogram equalisation",
        "apply": lambda img: ImageOps.equalize(img),
    },
    {
        "name": "median_filter",
        "description": "Median filter size=3 (salt-and-pepper denoise)",
        "apply": lambda img: img.filter(ImageFilter.MedianFilter(size=3)),
    },
    {
        "name": "threshold_128",
        "description": "Binary threshold at 128 (grayscale)",
        "apply": lambda img: _apply_threshold(img, 128),
    },
    {
        "name": "threshold_180",
        "description": "Binary threshold at 180 (lighter text)",
        "apply": lambda img: _apply_threshold(img, 180),
    },
    {
        "name": "upscale_2x",
        "description": "Upscale 2x with LANCZOS resampling",
        "apply": _apply_upscale_2x,
    },
    {
        "name": "upscale_2x_gray",
        "description": "Upscale 2x then grayscale",
        "apply": _apply_upscale_2x_gray,
    },
    {
        "name": "sharpness2x",
        "description": "2x sharpness (ImageEnhance)",
        "apply": lambda img: ImageEnhance.Sharpness(img).enhance(2.0),
    },
    {
        "name": "color_desat50",
        "description": "50% colour desaturation",
        "apply": lambda img: ImageEnhance.Color(img).enhance(0.5),
    },
]

FILTER_CONFIGS.extend(_EXTRA_FILTER_CONFIGS)


def ensure_gsm_imports() -> None:
    global run, get_app_directory, get_ocr_ocr1, get_ocr_ocr2
    if run is not None:
        return
    try:
        from GameSentenceMiner.owocr.owocr import run as gsm_run
        from GameSentenceMiner.util.config.configuration import (
            get_app_directory as gsm_get_app_directory,
        )
        from GameSentenceMiner.util.config.electron_config import (
            get_ocr_ocr1 as gsm_get_ocr_ocr1,
        )
        from GameSentenceMiner.util.config.electron_config import (
            get_ocr_ocr2 as gsm_get_ocr_ocr2,
        )
    except ModuleNotFoundError as e:
        raise RuntimeError(
            f"Missing dependency while importing GSM modules: {e}. "
            f"Python executable: {sys.executable}. "
            "Run this script in GSM's Python environment "
            "(for example: .venv\\Scripts\\python.exe scripts\\ocr_metrics_benchmark.py)."
        ) from e
    run = gsm_run
    get_app_directory = gsm_get_app_directory
    get_ocr_ocr1 = gsm_get_ocr_ocr1
    get_ocr_ocr2 = gsm_get_ocr_ocr2


def normalize_engine_name(name: str) -> str:
    cleaned = (name or "").strip().lower()
    return ENGINE_ALIASES.get(cleaned, cleaned)


def flatten_text(text) -> str:
    if text is None:
        return ""
    if isinstance(text, list):
        text = " ".join(str(x) for x in text if x is not None)
    return " ".join(str(text).replace("\r\n", "\n").replace("\r", "\n").split())


def strip_punctuation(text: str) -> str:
    raw = flatten_text(text)
    if unicode_regex is not None:
        # Unicode punctuation class
        return " ".join(unicode_regex.sub(r"\p{P}+", " ", raw).split())
    # Fallback: remove ASCII punctuation only
    return " ".join(re.sub(r"[^\w\s]+", " ", raw, flags=re.UNICODE).split())


def extract_japanese_chars(text: str) -> str:
    raw = flatten_text(text)
    if unicode_regex is not None:
        # Keep only Japanese scripts: Han (Kanji), Hiragana, Katakana.
        return "".join(unicode_regex.findall(r"[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]", raw))
    # Fallback ranges for common Japanese scripts.
    return "".join(re.findall(r"[\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF]", raw))


def preprocess_for_japanese_metrics(text: str) -> str:
    # Use one canonical regex-based path for both reference and predictions.
    return extract_japanese_chars(text)


def is_non_japanese_reference_gibberish(raw_reference_text: str, processed_reference_text: str) -> bool:
    # Treat non-empty OCR output with zero Japanese chars as gibberish for this benchmark.
    return bool(flatten_text(raw_reference_text)) and not processed_reference_text


def get_metrics_base_dir() -> Path:
    ensure_gsm_imports()
    base = Path(get_app_directory()) / "ocr_metrics"
    base.mkdir(parents=True, exist_ok=True)
    return base


def get_reference_cache_path(base_dir: Path, reference_engine: str) -> Path:
    return base_dir / f"reference_cache_{normalize_engine_name(reference_engine)}.json"


def load_reference_cache(cache_path: Path) -> dict:
    if not cache_path.exists():
        return {"entries": {}}
    try:
        with open(cache_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {"entries": {}}
    if not isinstance(data, dict):
        return {"entries": {}}
    if not isinstance(data.get("entries"), dict):
        data["entries"] = {}
    return data


def save_reference_cache(cache_path: Path, cache_data: dict) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache_data, f, ensure_ascii=False, indent=2)


def build_image_fingerprint(image_path: Path) -> dict:
    stat = image_path.stat()
    return {
        "size": int(stat.st_size),
        "mtime_ns": int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000))),
    }


def build_default_engines(reference_engine: str) -> list[str]:
    ensure_gsm_imports()
    # Keep defaults tightly focused for OCR bake-offs against Lens.
    seed = ["screenai", "oneocr", "meikiocr", "mlkitocr"]
    normalized = []
    for e in seed:
        name = normalize_engine_name(e)
        if name and name not in normalized and name != reference_engine:
            normalized.append(name)
    return normalized


def load_pending_samples(pending_dir: Path, max_samples: int | None) -> list[dict]:
    samples = []
    for metadata_path in sorted(pending_dir.glob("*.json")):
        try:
            with open(metadata_path, "r", encoding="utf-8") as f:
                metadata = json.load(f)
        except Exception:
            continue
        image_name = metadata.get("image_file")
        if not image_name:
            continue
        image_path = pending_dir / image_name
        if not image_path.exists():
            continue
        samples.append(
            {
                "metadata_path": metadata_path,
                "image_path": image_path,
                "metadata": metadata,
            }
        )
        if max_samples and len(samples) >= max_samples:
            break
    return samples


def find_latest_run_dir(archive_dir: Path) -> Path | None:
    run_dirs = [p for p in archive_dir.glob("run_*") if p.is_dir()]
    if not run_dirs:
        return None
    run_dirs.sort(key=lambda p: p.name, reverse=True)
    return run_dirs[0]


def snapshot_input_batch(samples: list[dict], batch_dir: Path) -> list[dict]:
    batch_dir.mkdir(parents=True, exist_ok=True)
    snapped = []
    for sample in samples:
        src_meta = Path(sample["metadata_path"])
        src_img = Path(sample["image_path"])
        if not src_meta.exists() or not src_img.exists():
            continue
        dst_meta = batch_dir / src_meta.name
        dst_img = batch_dir / src_img.name
        shutil.copy2(src_meta, dst_meta)
        shutil.copy2(src_img, dst_img)
        snapped.append(
            {
                "metadata_path": dst_meta,
                "image_path": dst_img,
                "source_metadata_path": src_meta,
                "source_image_path": src_img,
                "metadata": sample["metadata"],
            }
        )
    return snapped


def initialize_engines(required_engines: list[str]) -> tuple[list[str], list[str]]:
    ensure_gsm_imports()
    run.init_config(parse_args=False)
    run.engine_instances = []
    run.engine_keys = []
    run.engine_index = 0

    loaded = []
    missing = []
    for engine in required_engines:
        engine_name = normalize_engine_name(engine)
        run.engine_change_handler_name(engine_name, switch=False)
        available = [name.lower() for name in run.get_engine_names()]
        if engine_name in available:
            loaded.append(engine_name)
        else:
            missing.append(engine_name)
    return loaded, missing


def _get_engine_instance(engine_name: str):
    ensure_gsm_imports()
    target = normalize_engine_name(engine_name)
    for instance in getattr(run, "engine_instances", []) or []:
        name = str(getattr(instance, "name", "")).lower()
        if target == name or target in name or name in target:
            return instance
    raise RuntimeError(
        f"Engine '{target}' is not initialized. "
        f"Available: {[getattr(i, 'name', '?') for i in getattr(run, 'engine_instances', []) or []]}"
    )


def run_ocr_for_engine(image_path: Path, engine_name: str) -> tuple[str, float]:
    ensure_gsm_imports()
    engine_instance = _get_engine_instance(engine_name)
    with Image.open(image_path) as pil_img:
        img = pil_img.convert("RGB")
    start = time.perf_counter()
    result = engine_instance(img, 0)
    success, text, _coords, _crop_coords_list, _crop_coords, _response_dict = (list(result) + [None] * 6)[:6]
    elapsed_ms = (time.perf_counter() - start) * 1000.0
    if not success:
        if (
            str(getattr(engine_instance, "name", "")).lower() == "screenai"
            and isinstance(text, str)
            and "No OCR result returned by ScreenAI" in text
        ):
            text = ""
        else:
            raise RuntimeError(f"{engine_instance.name} OCR failed: {text}")
    return flatten_text(text), elapsed_ms


def run_ocr_with_image(pil_img: Image.Image, engine_name: str) -> tuple[str, float]:
    """Run OCR on a pre-processed PIL image without loading from disk."""
    ensure_gsm_imports()
    engine_instance = _get_engine_instance(engine_name)
    img = pil_img.convert("RGB")
    start = time.perf_counter()
    result = engine_instance(img, 0)
    success, text, _coords, _crop_coords_list, _crop_coords, _response_dict = (list(result) + [None] * 6)[:6]
    elapsed_ms = (time.perf_counter() - start) * 1000.0
    if not success:
        if (
            str(getattr(engine_instance, "name", "")).lower() == "screenai"
            and isinstance(text, str)
            and "No OCR result returned by ScreenAI" in text
        ):
            text = ""
        else:
            raise RuntimeError(f"{engine_instance.name} OCR failed: {text}")
    return flatten_text(text), elapsed_ms


def build_metrics(reference_text: str, predicted_text: str) -> dict:
    # CER should be based only on Japanese characters (no digits/whitespace/punctuation).
    ref = extract_japanese_chars(reference_text)
    pred = extract_japanese_chars(predicted_text)
    distance = levenshtein_distance(ref, pred)
    ref_len = max(1, len(ref))
    cer = distance / ref_len
    similarity = 1.0 - cer

    # Both CER variants intentionally use the same Japanese-only character set.
    ref_no_punct = extract_japanese_chars(ref)
    pred_no_punct = extract_japanese_chars(pred)
    distance_no_punct = levenshtein_distance(ref_no_punct, pred_no_punct)
    ref_no_punct_len = max(1, len(ref_no_punct))
    cer_no_punct = distance_no_punct / ref_no_punct_len
    similarity_no_punct = 1.0 - cer_no_punct

    return {
        "cer": cer,
        "similarity": similarity,
        "levenshtein_distance": distance,
        "reference_length": len(ref),
        "predicted_length": len(pred),
        "cer_no_punct": cer_no_punct,
        "similarity_no_punct": similarity_no_punct,
        "levenshtein_distance_no_punct": distance_no_punct,
        "reference_length_no_punct": len(ref_no_punct),
        "predicted_length_no_punct": len(pred_no_punct),
    }


def count_missed_reference_chars(reference_text: str, predicted_text: str) -> Counter:
    ref = extract_japanese_chars(reference_text)
    pred = extract_japanese_chars(predicted_text)
    counter: Counter = Counter()
    matcher = difflib.SequenceMatcher(a=ref, b=pred)
    for tag, i1, i2, _j1, _j2 in matcher.get_opcodes():
        if tag in ("delete", "replace"):
            for ch in ref[i1:i2]:
                if ch:
                    counter[ch] += 1
    return counter


def count_missed_char_confusions(reference_text: str, predicted_text: str) -> Counter:
    """
    Count missed-char confusion pairs from reference->predicted for Japanese-only streams.
    Examples:
      'あ' dropped          => ('あ', '∅')
      'あ' recognized as 'お' => ('あ', 'お')
    """
    ref = extract_japanese_chars(reference_text)
    pred = extract_japanese_chars(predicted_text)
    counter: Counter = Counter()
    matcher = difflib.SequenceMatcher(a=ref, b=pred)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag == "delete":
            for ch in ref[i1:i2]:
                counter[(ch, "∅")] += 1
            continue
        if tag == "replace":
            ref_chunk = ref[i1:i2]
            pred_chunk = pred[j1:j2]
            overlap = min(len(ref_chunk), len(pred_chunk))
            for idx in range(overlap):
                counter[(ref_chunk[idx], pred_chunk[idx])] += 1
            for idx in range(overlap, len(ref_chunk)):
                counter[(ref_chunk[idx], "∅")] += 1
            # Extra predicted chars are insertions; not counted as "missed reference chars".
    return counter


def write_graphs(
    summary_rows: list[dict],
    output_dir: Path,
    missed_confusions_by_engine: dict[str, Counter] | None = None,
) -> None:
    if not plt:
        return
    successful_rows = [r for r in summary_rows if (r.get("successes") or 0) > 0]
    if not successful_rows:
        return
    engine_names = [r["engine"] for r in successful_rows]
    cer_values = [r["avg_cer"] * 100.0 for r in successful_rows]
    runtime_values = [r["avg_runtime_ms"] for r in successful_rows]
    cer_no_punct_values = [r["avg_cer_no_punct"] * 100.0 for r in successful_rows]

    plt.figure(figsize=(12, 6))
    plt.bar(engine_names, cer_values)
    plt.title("Average CER % by Engine (lower is better)")
    plt.ylabel("CER (%)")
    plt.xticks(rotation=45, ha="right")
    plt.tight_layout()
    plt.savefig(output_dir / "avg_cer.png", dpi=160)
    plt.close()

    plt.figure(figsize=(12, 6))
    plt.bar(engine_names, runtime_values)
    plt.title("Average Runtime by Engine")
    plt.ylabel("Runtime (ms)")
    plt.xticks(rotation=45, ha="right")
    plt.tight_layout()
    plt.savefig(output_dir / "avg_runtime_ms.png", dpi=160)
    plt.close()

    plt.figure(figsize=(12, 6))
    plt.bar(engine_names, cer_no_punct_values)
    plt.title("Average CER % by Engine (No Punctuation, lower is better)")
    plt.ylabel("CER (%) (no punctuation)")
    plt.xticks(rotation=45, ha="right")
    plt.tight_layout()
    plt.savefig(output_dir / "avg_cer_no_punct.png", dpi=160)
    plt.close()

    if missed_confusions_by_engine:
        drop_counts = []
        for engine in engine_names:
            counter = missed_confusions_by_engine.get(engine, Counter())
            dropped_total = sum(count for (ref_ch, pred_ch), count in counter.items() if pred_ch == "∅")
            drop_counts.append(dropped_total)

        plt.figure(figsize=(12, 6))
        plt.bar(engine_names, drop_counts)
        plt.title("Dropped Reference Characters by Engine (ref -> ∅)")
        plt.ylabel("Dropped chars (count)")
        plt.xticks(rotation=45, ha="right")
        plt.tight_layout()
        plt.savefig(output_dir / "dropped_chars_count.png", dpi=160)
        plt.close()


def write_filter_graphs(filter_summary: list[dict], output_dir: Path) -> None:
    """Write bar charts comparing CER and runtime across preprocessing filters."""
    if not plt:
        return
    successful = [r for r in filter_summary if r.get("avg_cer") is not None]
    if not successful:
        return

    names = [r["filter"] for r in successful]
    cer_vals = [r["avg_cer"] * 100.0 for r in successful]
    cer_np_vals = [r["avg_cer_no_punct"] * 100.0 for r in successful]
    rt_vals = [r["avg_runtime_ms"] for r in successful]

    def _save_bar(values: list[float], title: str, ylabel: str, filename: str) -> None:
        plt.figure(figsize=(max(12, len(names) * 0.8), 6))
        bars = plt.bar(range(len(names)), values)
        if values:
            best_idx = int(min(range(len(values)), key=lambda i: values[i]))
            bars[best_idx].set_color("green")
        plt.xticks(range(len(names)), names, rotation=60, ha="right")
        plt.title(title)
        plt.ylabel(ylabel)
        plt.tight_layout()
        plt.savefig(output_dir / filename, dpi=160)
        plt.close()

    _save_bar(
        cer_vals,
        "Average CER % by Filter (lower is better)",
        "CER (%)",
        "filter_avg_cer.png",
    )
    _save_bar(
        cer_np_vals,
        "Average CER % by Filter, No Punctuation (lower is better)",
        "CER (%) (no punct)",
        "filter_avg_cer_no_punct.png",
    )
    _save_bar(
        rt_vals,
        "Average Runtime by Filter",
        "Runtime (ms)",
        "filter_avg_runtime_ms.png",
    )


def run_filter_benchmark(args) -> int:
    """
    For each image in the pending queue, obtain a reference text from the
    reference engine (lens by default, cached), then run the specified
    --model engine once per entry in FILTER_CONFIGS with the corresponding
    image transformation applied first.  Results are written to an archive
    run directory under filter_benchmark_<run_id>/.
    """
    ensure_gsm_imports()

    base_dir = get_metrics_base_dir()
    pending_dir = base_dir / "pending"
    archive_dir = base_dir / "archive"
    pending_dir.mkdir(parents=True, exist_ok=True)
    archive_dir.mkdir(parents=True, exist_ok=True)

    reference_engine = normalize_engine_name(args.reference_engine)
    reference_cache_path = get_reference_cache_path(base_dir, reference_engine)
    reference_cache = load_reference_cache(reference_cache_path)
    reference_cache.setdefault("engine", reference_engine)
    reference_cache.setdefault("updated_at_utc", None)
    reference_cache.setdefault("entries", {})

    model_engine = normalize_engine_name(args.model)

    # ---- Load pending samples (or rerun) -----------------------------------
    rerun_source_run = None
    if args.rerun:
        latest_run = find_latest_run_dir(archive_dir)
        if not latest_run:
            print(f"--rerun requested but no archived runs found in {archive_dir}")
            return 1
        pending_samples: list[dict] = []
        for candidate in [latest_run / "input_batch", latest_run / "processed_samples"]:
            if candidate.exists():
                pending_samples = load_pending_samples(candidate, args.max_samples or None)
                if pending_samples:
                    rerun_source_run = latest_run.name
                    break
        if not pending_samples:
            print(f"--rerun requested but no batch images found in {latest_run}")
            return 1
        print(f"Rerun source: {rerun_source_run}")
    else:
        pending_samples = load_pending_samples(pending_dir, args.max_samples or None)
        if not pending_samples:
            print(f"No pending OCR metric samples found in {pending_dir}")
            return 0

    # ---- Create run directory ----------------------------------------------
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = archive_dir / f"filter_benchmark_{run_id}"
    results_dir = run_dir / "results"
    input_batch_dir = run_dir / "input_batch"
    results_dir.mkdir(parents=True, exist_ok=True)
    input_batch_dir.mkdir(parents=True, exist_ok=True)

    pending_samples = snapshot_input_batch(pending_samples, input_batch_dir)
    if not pending_samples:
        print("No valid samples after input snapshot.")
        return 1

    # ---- Initialise engines ------------------------------------------------
    required_engines = list(dict.fromkeys([reference_engine, model_engine]))
    loaded_engines, missing_engines = initialize_engines(required_engines)
    if reference_engine not in loaded_engines:
        print(f"Reference engine '{reference_engine}' could not be loaded. Missing: {missing_engines}")
        return 1
    if model_engine not in loaded_engines:
        print(f"Model engine '{model_engine}' could not be loaded. Missing: {missing_engines}")
        return 1

    # ---- Preflight reference engine ----------------------------------------
    try:
        run_ocr_for_engine(pending_samples[0]["image_path"], reference_engine)
    except Exception as e:
        print(f"Reference engine preflight failed for '{reference_engine}': {e}")
        return 1

    # ---- Gather reference texts (with cache) --------------------------------
    reference_results: dict[str, str] = {}  # sample_id -> processed reference text
    reference_cache_hits = 0
    reference_cache_misses = 0
    skipped_non_japanese = 0
    valid_samples: list[dict] = []

    print(f"Gathering reference texts from '{reference_engine}' for {len(pending_samples)} sample(s)...")
    for sample in pending_samples:
        metadata = sample["metadata"]
        image_path = sample["image_path"]
        sample_id = str(metadata.get("sample_id", image_path.stem))
        image_file = metadata.get("image_file", image_path.name)
        fingerprint = build_image_fingerprint(image_path)
        cache_key = sample_id
        try:
            cached_entry = None if args.refresh_reference_cache else reference_cache["entries"].get(cache_key)
            if (
                cached_entry
                and cached_entry.get("image_file") == image_file
                and int(cached_entry.get("size", -1)) == fingerprint["size"]
                and int(cached_entry.get("mtime_ns", -1)) == fingerprint["mtime_ns"]
            ):
                raw_ref = flatten_text(cached_entry.get("text", ""))
                proc_ref = flatten_text(cached_entry.get("processed_text", ""))
                if not proc_ref and raw_ref:
                    proc_ref = preprocess_for_japanese_metrics(raw_ref)
                reference_cache_hits += 1
            else:
                raw_ref, ref_ms = run_ocr_for_engine(image_path, reference_engine)
                proc_ref = preprocess_for_japanese_metrics(raw_ref)
                reference_cache["entries"][cache_key] = {
                    "sample_id": sample_id,
                    "image_file": image_file,
                    "size": fingerprint["size"],
                    "mtime_ns": fingerprint["mtime_ns"],
                    "text": raw_ref,
                    "processed_text": proc_ref,
                    "runtime_ms": ref_ms,
                    "updated_at_utc": datetime.now(timezone.utc).isoformat(),
                }
                reference_cache_misses += 1

            if is_non_japanese_reference_gibberish(raw_ref, proc_ref):
                skipped_non_japanese += 1
                continue

            reference_results[sample_id] = proc_ref
            valid_samples.append(sample)
        except Exception as e:
            print(f"  Reference OCR failed for sample {sample_id}: {e}")

    if not valid_samples:
        print("No valid samples with Japanese reference text found.")
        return 1

    print(f"Valid samples: {len(valid_samples)}  (skipped non-Japanese: {skipped_non_japanese})")
    print(f"Reference cache  hits={reference_cache_hits}  misses={reference_cache_misses}")
    print(f"Testing {len(FILTER_CONFIGS)} filter(s) with engine '{model_engine}'...")

    # ---- Run model for each filter -----------------------------------------
    per_filter_rows: list[dict] = []

    for filter_cfg in FILTER_CONFIGS:
        filter_name = filter_cfg["name"]
        filter_desc = filter_cfg.get("description", filter_name)
        apply_fn = filter_cfg["apply"]
        print(f"  [{filter_name}] {filter_desc}")

        for sample in valid_samples:
            metadata = sample["metadata"]
            image_path = sample["image_path"]
            sample_id = str(metadata.get("sample_id", image_path.stem))
            reference_text = reference_results[sample_id]

            try:
                t_start = time.perf_counter()
                with Image.open(image_path) as raw_pil:
                    filtered_img = apply_fn(raw_pil.convert("RGB"))
                predicted_text, _ocr_ms = run_ocr_with_image(filtered_img, model_engine)
                runtime_ms = (time.perf_counter() - t_start) * 1000.0
                metrics = build_metrics(reference_text, predicted_text)
                per_filter_rows.append(
                    {
                        "filter": filter_name,
                        "sample_id": sample_id,
                        "predicted_text": predicted_text,
                        "reference_text": reference_text,
                        "runtime_ms": runtime_ms,
                        **metrics,
                    }
                )
            except Exception as e:
                per_filter_rows.append(
                    {
                        "filter": filter_name,
                        "sample_id": sample_id,
                        "predicted_text": "",
                        "reference_text": reference_text,
                        "runtime_ms": -1.0,
                        "cer": 1.0,
                        "similarity": 0.0,
                        "levenshtein_distance": -1,
                        "reference_length": len(reference_text),
                        "predicted_length": 0,
                        "cer_no_punct": 1.0,
                        "similarity_no_punct": 0.0,
                        "levenshtein_distance_no_punct": -1,
                        "reference_length_no_punct": len(extract_japanese_chars(reference_text)),
                        "predicted_length_no_punct": 0,
                        "error": str(e),
                    }
                )

    # ---- Summarise per filter ----------------------------------------------
    filter_summary: list[dict] = []
    for filter_cfg in FILTER_CONFIGS:
        filter_name = filter_cfg["name"]
        filter_desc = filter_cfg.get("description", filter_name)
        ok_rows = [r for r in per_filter_rows if r["filter"] == filter_name and r.get("runtime_ms", -1) >= 0]
        fail_rows = [r for r in per_filter_rows if r["filter"] == filter_name and r.get("runtime_ms", -1) < 0]
        filter_summary.append(
            {
                "filter": filter_name,
                "description": filter_desc,
                "samples": len(ok_rows) + len(fail_rows),
                "successes": len(ok_rows),
                "failures": len(fail_rows),
                "avg_cer": statistics.fmean(r["cer"] for r in ok_rows) if ok_rows else None,
                "avg_cer_no_punct": statistics.fmean(r["cer_no_punct"] for r in ok_rows) if ok_rows else None,
                "avg_similarity": statistics.fmean(r["similarity"] for r in ok_rows) if ok_rows else None,
                "avg_similarity_no_punct": statistics.fmean(r["similarity_no_punct"] for r in ok_rows)
                if ok_rows
                else None,
                "avg_runtime_ms": statistics.fmean(r["runtime_ms"] for r in ok_rows) if ok_rows else None,
            }
        )

    # Sort best-first by avg_cer (ascending), None last
    filter_summary_sorted = sorted(
        [r for r in filter_summary if r["avg_cer"] is not None],
        key=lambda r: r["avg_cer"],
    ) + [r for r in filter_summary if r["avg_cer"] is None]

    # ---- Write outputs -----------------------------------------------------
    with open(results_dir / "per_sample_results.json", "w", encoding="utf-8") as f:
        json.dump(per_filter_rows, f, ensure_ascii=False, indent=2)
    with open(results_dir / "filter_summary.json", "w", encoding="utf-8") as f:
        json.dump(
            {
                "run_id": run_id,
                "mode": "filter_benchmark",
                "model_engine": model_engine,
                "reference_engine": reference_engine,
                "reference_cache_path": str(reference_cache_path),
                "reference_cache_hits": reference_cache_hits,
                "reference_cache_misses": reference_cache_misses,
                "valid_samples": len(valid_samples),
                "skipped_non_japanese": skipped_non_japanese,
                "rerun_source_run": rerun_source_run,
                "filter_summary": filter_summary_sorted,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    if per_filter_rows:
        csv_fields = sorted({k for row in per_filter_rows for k in row.keys()})
        with open(results_dir / "per_sample_results.csv", "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=csv_fields)
            writer.writeheader()
            writer.writerows(per_filter_rows)

    write_filter_graphs(filter_summary_sorted, results_dir)

    reference_cache["updated_at_utc"] = datetime.now(timezone.utc).isoformat()
    save_reference_cache(reference_cache_path, reference_cache)

    # ---- Print ranked table ------------------------------------------------
    col_w = max((len(r["filter"]) for r in filter_summary_sorted), default=10)
    print(f"\nFilter benchmark complete.  Run dir: {run_dir}")
    print(f"Model: {model_engine}   Reference: {reference_engine}")
    print(f"\n{'Rank':<5} {'Filter':<{col_w}}  {'CER':>8}  {'CER_np':>8}  {'RT(ms)':>9}  Description")
    print("-" * (col_w + 50))
    for rank, row in enumerate(filter_summary_sorted, start=1):
        cer_s = f"{row['avg_cer'] * 100:.2f}%" if row["avg_cer"] is not None else "N/A"
        cer_np_s = f"{row['avg_cer_no_punct'] * 100:.2f}%" if row["avg_cer_no_punct"] is not None else "N/A"
        rt_s = f"{row['avg_runtime_ms']:.1f}" if row["avg_runtime_ms"] is not None else "N/A"
        marker = " <-- best" if rank == 1 else ""
        print(
            f"{rank:<5} {row['filter']:<{col_w}}  {cer_s:>8}  {cer_np_s:>8}  {rt_s:>9}ms  {row['description']}{marker}"
        )

    return 0


def main() -> int:
    start_time = time.time()
    parser = argparse.ArgumentParser(description="Run OCR metrics benchmark from captured GSM OCR samples.")
    parser.add_argument(
        "--reference-engine",
        default="glens",
        help="Reference engine (lens/law alias to glens).",
    )
    parser.add_argument("--engines", default="", help="Comma-separated engines to compare.")
    parser.add_argument(
        "--max-samples",
        type=int,
        default=0,
        help="Max pending samples to process (0 = all).",
    )
    parser.add_argument(
        "--rerun",
        action="store_true",
        help="Re-run the latest archived run batch instead of current pending samples.",
    )
    parser.add_argument(
        "--refresh-reference-cache",
        action="store_true",
        help="Ignore cached reference OCR values and recompute.",
    )
    parser.add_argument(
        "--test-filter",
        action="store_true",
        help=(
            "Filter-benchmark mode: run --model engine against lens reference results "
            "with every preprocessing filter in FILTER_CONFIGS applied to the input "
            "image.  Outputs a ranked table comparing CER across filters."
        ),
    )
    parser.add_argument(
        "--model",
        default="",
        help="Local OCR engine to test in --test-filter mode (e.g. oneocr, meikiocr, mlkitocr).",
    )
    args = parser.parse_args()
    print(f"Python executable: {sys.executable}")

    if args.test_filter:
        if not args.model.strip():
            parser.error("--test-filter requires --model <engine_name>")
        return run_filter_benchmark(args)

    base_dir = get_metrics_base_dir()
    pending_dir = base_dir / "pending"
    archive_dir = base_dir / "archive"
    pending_dir.mkdir(parents=True, exist_ok=True)
    archive_dir.mkdir(parents=True, exist_ok=True)

    reference_engine = normalize_engine_name(args.reference_engine)
    reference_cache_path = get_reference_cache_path(base_dir, reference_engine)
    reference_cache = load_reference_cache(reference_cache_path)
    reference_cache.setdefault("engine", reference_engine)
    reference_cache.setdefault("updated_at_utc", None)
    reference_cache.setdefault("entries", {})
    compare_engines = (
        [normalize_engine_name(x) for x in args.engines.split(",") if x.strip()]
        if args.engines.strip()
        else build_default_engines(reference_engine)
    )

    rerun_source_dir = None
    rerun_source_run = None
    if args.rerun:
        latest_run = find_latest_run_dir(archive_dir)
        if not latest_run:
            print(f"--rerun requested but no archived runs found in {archive_dir}")
            return 1
        candidate_dirs = [latest_run / "input_batch", latest_run / "processed_samples"]
        for candidate in candidate_dirs:
            if candidate.exists():
                pending_samples = load_pending_samples(candidate, args.max_samples or None)
                if pending_samples:
                    rerun_source_dir = candidate
                    rerun_source_run = latest_run.name
                    break
        if not rerun_source_dir:
            print(f"--rerun requested but no batch images found in {latest_run}")
            return 1
        print(f"Rerun source: {rerun_source_run} ({rerun_source_dir})")
    else:
        pending_samples = load_pending_samples(pending_dir, args.max_samples or None)
        if not pending_samples:
            print(f"No pending OCR metric samples found in {pending_dir}")
            return 0

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = archive_dir / f"run_{run_id}"
    results_dir = run_dir / "results"
    processed_dir = run_dir / "processed_samples"
    input_batch_dir = run_dir / "input_batch"
    results_dir.mkdir(parents=True, exist_ok=True)
    processed_dir.mkdir(parents=True, exist_ok=True)
    input_batch_dir.mkdir(parents=True, exist_ok=True)

    # Freeze exact inputs for reproducible reruns.
    pending_samples = snapshot_input_batch(pending_samples, input_batch_dir)
    if not pending_samples:
        print("No valid samples available after input snapshot.")
        return 1

    required_engines = [reference_engine] + compare_engines
    loaded_engines, missing_engines = initialize_engines(required_engines)
    if reference_engine not in loaded_engines:
        print(f"Reference engine '{reference_engine}' could not be loaded. Missing: {missing_engines}")
        return 1

    loaded_compare = [e for e in compare_engines if e in loaded_engines]
    per_sample_rows = []
    reference_failures = 0
    all_success = True
    reference_cache_hits = 0
    reference_cache_misses = 0
    skipped_non_japanese_references = 0
    missed_chars_by_engine: dict[str, Counter] = {engine: Counter() for engine in loaded_compare}
    missed_confusions_by_engine: dict[str, Counter] = {engine: Counter() for engine in loaded_compare}

    # Preflight once to avoid noisy per-sample spam when the reference engine is broken.
    try:
        run_ocr_for_engine(pending_samples[0]["image_path"], reference_engine)
    except Exception as e:
        print(f"Reference engine preflight failed for '{reference_engine}': {e}\nPython executable: {sys.executable}")
        return 1

    for sample in pending_samples:
        metadata = sample["metadata"]
        image_path = sample["image_path"]
        sample_id = metadata.get("sample_id", image_path.stem)
        image_file = metadata.get("image_file", image_path.name)
        fingerprint = build_image_fingerprint(image_path)
        cache_key = str(sample_id)
        try:
            cached_entry = None if args.refresh_reference_cache else reference_cache["entries"].get(cache_key)
            if (
                cached_entry
                and cached_entry.get("image_file") == image_file
                and int(cached_entry.get("size", -1)) == fingerprint["size"]
                and int(cached_entry.get("mtime_ns", -1)) == fingerprint["mtime_ns"]
            ):
                raw_cached_text = flatten_text(cached_entry.get("text", ""))
                processed_cached_text = flatten_text(cached_entry.get("processed_text", ""))
                if not processed_cached_text and raw_cached_text:
                    processed_cached_text = preprocess_for_japanese_metrics(raw_cached_text)
                reference_text = raw_cached_text
                processed_reference_text = processed_cached_text
                reference_ms = float(cached_entry.get("runtime_ms", 0.0))
                reference_cache_hits += 1
            else:
                reference_text, reference_ms = run_ocr_for_engine(image_path, reference_engine)
                processed_reference_text = preprocess_for_japanese_metrics(reference_text)
                reference_cache["entries"][cache_key] = {
                    "sample_id": sample_id,
                    "image_file": image_file,
                    "size": fingerprint["size"],
                    "mtime_ns": fingerprint["mtime_ns"],
                    "text": reference_text,
                    "processed_text": processed_reference_text,
                    "runtime_ms": reference_ms,
                    "updated_at_utc": datetime.now(timezone.utc).isoformat(),
                }
                reference_cache_misses += 1

            raw_reference_text = reference_text
            reference_text = processed_reference_text
            if is_non_japanese_reference_gibberish(raw_reference_text, reference_text):
                skipped_non_japanese_references += 1
                continue
        except Exception as e:
            all_success = False
            reference_failures += 1
            per_sample_rows.append(
                {
                    "sample_id": sample_id,
                    "engine": reference_engine,
                    "runtime_ms": -1.0,
                    "reference_engine": reference_engine,
                    "reference_runtime_ms": -1.0,
                    "reference_text": "",
                    "predicted_text": "",
                    "cer": 1.0,
                    "similarity": 0.0,
                    "levenshtein_distance": -1,
                    "reference_length": 0,
                    "predicted_length": 0,
                    "error": str(e),
                }
            )
            continue

        for engine_name in loaded_compare:
            try:
                predicted_text, runtime_ms = run_ocr_for_engine(image_path, engine_name)
                metrics = build_metrics(reference_text, predicted_text)
                missed_counter = count_missed_reference_chars(reference_text, predicted_text)
                confusion_counter = count_missed_char_confusions(reference_text, predicted_text)
                missed_chars_by_engine.setdefault(engine_name, Counter()).update(missed_counter)
                missed_confusions_by_engine.setdefault(engine_name, Counter()).update(confusion_counter)
                per_sample_rows.append(
                    {
                        "sample_id": sample_id,
                        "engine": engine_name,
                        "runtime_ms": runtime_ms,
                        "reference_engine": reference_engine,
                        "reference_runtime_ms": reference_ms,
                        "reference_text": reference_text,
                        "predicted_text": predicted_text,
                        "missed_char_total": int(sum(missed_counter.values())),
                        **metrics,
                    }
                )
            except Exception as e:
                all_success = False
                missed_counter = count_missed_reference_chars(reference_text, "")
                confusion_counter = count_missed_char_confusions(reference_text, "")
                missed_chars_by_engine.setdefault(engine_name, Counter()).update(missed_counter)
                missed_confusions_by_engine.setdefault(engine_name, Counter()).update(confusion_counter)
                per_sample_rows.append(
                    {
                        "sample_id": sample_id,
                        "engine": engine_name,
                        "runtime_ms": -1.0,
                        "reference_engine": reference_engine,
                        "reference_runtime_ms": reference_ms,
                        "reference_text": reference_text,
                        "predicted_text": "",
                        "missed_char_total": int(sum(missed_counter.values())),
                        "cer": 1.0,
                        "similarity": 0.0,
                        "levenshtein_distance": -1,
                        "reference_length": len(reference_text),
                        "predicted_length": 0,
                        "cer_no_punct": 1.0,
                        "similarity_no_punct": 0.0,
                        "levenshtein_distance_no_punct": -1,
                        "reference_length_no_punct": len(extract_japanese_chars(reference_text)),
                        "predicted_length_no_punct": 0,
                        "error": str(e),
                    }
                )

    # Transactional move: only archive pending files after complete success across
    # every image and every required engine. Reruns do not move source files.
    if all_success and not args.rerun:
        for sample in pending_samples:
            metadata_path = Path(sample.get("source_metadata_path", sample["metadata_path"]))
            image_path = Path(sample.get("source_image_path", sample["image_path"]))
            if metadata_path.exists():
                shutil.move(str(metadata_path), str(processed_dir / metadata_path.name))
            if image_path.exists():
                shutil.move(str(image_path), str(processed_dir / image_path.name))

    summary_rows = []
    engines_in_results = sorted({r["engine"] for r in per_sample_rows})
    for engine in engines_in_results:
        all_rows = [r for r in per_sample_rows if r["engine"] == engine]
        rows = [r for r in all_rows if r.get("runtime_ms", -1) >= 0]
        failures = [r for r in all_rows if r.get("runtime_ms", -1) < 0]
        first_error = next((r.get("error") for r in failures if r.get("error")), None)
        summary_rows.append(
            {
                "engine": engine,
                "samples": len(all_rows),
                "successes": len(rows),
                "failures": len(failures),
                "avg_cer": statistics.fmean(r["cer"] for r in rows) if rows else None,
                "avg_cer_no_punct": statistics.fmean(r["cer_no_punct"] for r in rows) if rows else None,
                "avg_similarity": statistics.fmean(r["similarity"] for r in rows) if rows else None,
                "avg_similarity_no_punct": statistics.fmean(r["similarity_no_punct"] for r in rows) if rows else None,
                "avg_runtime_ms": statistics.fmean(r["runtime_ms"] for r in rows) if rows else None,
                "first_error": first_error,
            }
        )

    with open(results_dir / "per_sample_results.json", "w", encoding="utf-8") as f:
        json.dump(per_sample_rows, f, ensure_ascii=False, indent=2)
    with open(results_dir / "summary.json", "w", encoding="utf-8") as f:
        json.dump(
            {
                "run_id": run_id,
                "rerun": bool(args.rerun),
                "rerun_source_run": rerun_source_run,
                "reference_engine": reference_engine,
                "reference_cache_path": str(reference_cache_path),
                "reference_cache_hits": reference_cache_hits,
                "reference_cache_misses": reference_cache_misses,
                "loaded_engines": loaded_engines,
                "missing_engines": missing_engines,
                "skipped_non_japanese_references": skipped_non_japanese_references,
                "samples_processed": len({r["sample_id"] for r in per_sample_rows}),
                "summary": summary_rows,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )
    missed_chars_output = {
        engine: [{"char": ch, "count": int(cnt)} for ch, cnt in counter.most_common()]
        for engine, counter in missed_chars_by_engine.items()
    }
    with open(results_dir / "missed_chars_by_engine.json", "w", encoding="utf-8") as f:
        json.dump(missed_chars_output, f, ensure_ascii=False, indent=2)
    missed_confusions_output = {
        engine: [
            {"reference_char": ref_ch, "predicted_char": pred_ch, "count": int(cnt)}
            for (ref_ch, pred_ch), cnt in counter.most_common()
        ]
        for engine, counter in missed_confusions_by_engine.items()
    }
    with open(results_dir / "missed_char_confusions_by_engine.json", "w", encoding="utf-8") as f:
        json.dump(missed_confusions_output, f, ensure_ascii=False, indent=2)

    if per_sample_rows:
        csv_fields = sorted({k for row in per_sample_rows for k in row.keys()})
        with open(results_dir / "per_sample_results.csv", "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=csv_fields)
            writer.writeheader()
            writer.writerows(per_sample_rows)

    write_graphs(
        summary_rows,
        results_dir,
        missed_confusions_by_engine=missed_confusions_by_engine,
    )
    reference_cache["updated_at_utc"] = datetime.now(timezone.utc).isoformat()
    save_reference_cache(reference_cache_path, reference_cache)

    final_status = "SUCCESS" if all_success else "FAILED"
    print(f"OCR metrics run status: {final_status}")
    print(f"Run directory: {run_dir}")
    if args.rerun:
        print(f"Rerun source run: {rerun_source_run}")
    print(f"Processed samples: {len({r['sample_id'] for r in per_sample_rows})}")
    if reference_failures:
        print(f"Samples with reference OCR failure: {reference_failures}")
    if all_success:
        print("Archived pending samples: yes (all engines succeeded on all images)")
    else:
        print("Archived pending samples: no (at least one engine failed on at least one image)")
    print(f"Loaded engines: {', '.join(loaded_engines)}")
    print(f"Reference cache hits/misses: {reference_cache_hits}/{reference_cache_misses}")
    print(f"Skipped non-Japanese reference samples: {skipped_non_japanese_references}")
    if missing_engines:
        print(f"Missing engines: {', '.join(missing_engines)}")
    for row in summary_rows:
        print(
            f"Engine {row['engine']}: successes={row['successes']}, failures={row['failures']}, "
            f"avg_cer={row['avg_cer']}, avg_cer_no_punct={row['avg_cer_no_punct']}"
        )
        if row.get("first_error"):
            print(f"  first_error: {row['first_error']}")
        if row["engine"] in missed_chars_by_engine:
            top_missed = missed_chars_by_engine[row["engine"]].most_common(10)
            if top_missed:
                top_missed_str = ", ".join([f"{ch}:{cnt}" for ch, cnt in top_missed])
                print(f"  top_missed_chars: {top_missed_str}")
        if row["engine"] in missed_confusions_by_engine:
            top_confusions = missed_confusions_by_engine[row["engine"]].most_common(10)
            if top_confusions:
                top_confusions_str = ", ".join([f"{r}->{p}:{c}" for (r, p), c in top_confusions])
                print(f"  top_missed_confusions: {top_confusions_str}")
    print(f"Total runtime: {time.time() - start_time:.2f} seconds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
