"""Benchmark OBS/WinAPI screenshot capture performance across a matrix of options.

Three capture methods are supported:

  obs_source  — OBS websocket request to the best video source in the current scene
  obs_scene   — OBS websocket request using the scene name itself as the source
  winapi      — Win32 PrintWindow API, bypassing OBS entirely (Windows only)

Default run compares these three with jpg q=90 source-res pp=none so you can
see the latency difference at a glance.  Pass CLI flags to run any combination
of methods, formats, compressions, resolutions, and preprocessing modes.

Usage
-----
    # default 3-way comparison
    python scripts/benchmark_obs_screenshot_capture.py

    # OBS methods only, full format/compression matrix
    python scripts/benchmark_obs_screenshot_capture.py --methods obs_source obs_scene \\
        --formats jpg png --compressions 75 90 95 --preprocess none grayscale

    # WinAPI only with explicit window title
    python scripts/benchmark_obs_screenshot_capture.py --methods winapi --window "Game Title"

    # custom resolution comparison
    python scripts/benchmark_obs_screenshot_capture.py --widths 1280 1920 --heights 720 1080
"""

from __future__ import annotations

import argparse
import enum
import io
import math
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

obs = None
connect_to_obs_sync = None


def ensure_gsm_imports() -> None:
    global obs, connect_to_obs_sync
    if obs is not None:
        return
    from GameSentenceMiner import obs as gsm_obs
    from GameSentenceMiner.obs import connect_to_obs_sync as gsm_connect

    obs = gsm_obs
    connect_to_obs_sync = gsm_connect


def ensure_obs_connected() -> None:
    ensure_gsm_imports()
    if getattr(obs, "obs_service", None):
        return
    connect_to_obs_sync(start_manager=False)
    if not getattr(obs, "obs_service", None):
        raise RuntimeError("Failed to connect to OBS. Make sure OBS is running with the websocket server enabled.")


# ---------------------------------------------------------------------------
# Stats helpers
# ---------------------------------------------------------------------------


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        raise ValueError("percentile() requires at least one value")
    if fraction <= 0:
        return min(values)
    if fraction >= 1:  # NOSONAR(S2583) real upper-bound guard; Sonar misreads it as constant
        return max(values)
    s = sorted(values)
    idx = (len(s) - 1) * fraction
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)


def _fps(seconds: float) -> float:
    return 1.0 / seconds if seconds > 0 else float("inf")


def summarize_timings(latencies: list[float]) -> dict[str, float]:
    if not latencies:
        raise ValueError("No timings recorded")
    n = len(latencies)
    s = sorted(latencies)
    bucket = max(1, math.ceil(n * 0.01))
    fps_vals = sorted(_fps(v) for v in latencies)
    total = sum(latencies)
    avg = total / n
    return {
        "count": float(n),
        "total_s": total,
        "avg_s": avg,
        "median_s": statistics.median(latencies),
        "stdev_s": statistics.pstdev(latencies) if n > 1 else 0.0,
        "min_s": s[0],
        "max_s": s[-1],
        "p05_s": percentile(s, 0.05),
        "p95_s": percentile(s, 0.95),
        "p99_s": percentile(s, 0.99),
        "throughput_fps": n / total if total > 0 else float("inf"),
        "avg_fps": _fps(avg),
        "median_fps": _fps(statistics.median(latencies)),
        "low_1pct_fps": statistics.fmean(fps_vals[:bucket]),
        "high_1pct_fps": statistics.fmean(fps_vals[-bucket:]),
    }


def ms(s: float) -> float:
    return s * 1_000.0


# ---------------------------------------------------------------------------
# Capture methods
# ---------------------------------------------------------------------------


class CaptureMethod(enum.Enum):
    OBS_SOURCE = "obs_source"  # websocket → best video source auto-detected in scene
    OBS_SCENE = "obs_scene"  # websocket → scene name used directly as the OBS source
    WINAPI = "winapi"  # Win32 PrintWindow, bypasses OBS entirely
    GRAPHICS_CAPTURE = "graphics_capture"  # Windows Graphics Capture (WGC) via windows-capture


@dataclass
class CaptureConfig:
    method: CaptureMethod
    img_format: str = "jpg"
    compression: int = 90
    width: int | None = None
    height: int | None = None
    preprocess_mode: str = "none"

    @property
    def label(self) -> str:
        if self.width and self.height:
            res = f"{self.width}x{self.height}"
        elif self.width:
            res = f"{self.width}xauto"
        elif self.height:
            res = f"autox{self.height}"
        else:
            res = "source"
        if self.method in (CaptureMethod.WINAPI, CaptureMethod.GRAPHICS_CAPTURE):
            return f"{self.method.value} {res}"
        return f"{self.method.value} {self.img_format} q={self.compression} {res} pp={self.preprocess_mode}"


@dataclass
class BenchResult:
    config: CaptureConfig
    latencies: list[float] = field(default_factory=list)
    failures: int = 0
    image_size: tuple[int, int] | None = None
    image_bytes: int = 0
    cpu_pct: float | None = None  # avg process CPU% over the timed run


# ---------------------------------------------------------------------------
# Win32 API capture
# ---------------------------------------------------------------------------


def _find_window_handle(window_title: str) -> tuple:
    """Return (hwnd, matched_title) or (None, None). Terminal windows are skipped."""
    try:
        import win32gui
        import win32process

        import psutil
    except ImportError as exc:
        raise RuntimeError(f"win32 / psutil dependencies not available: {exc}") from exc

    handle = win32gui.FindWindow(None, window_title)
    if handle:
        return handle, window_title

    handles: list[tuple] = []

    def _cb(hwnd, _):
        title = win32gui.GetWindowText(hwnd)
        if window_title in title:
            handles.append((hwnd, title))
        return True

    win32gui.EnumWindows(_cb, None)

    skip = {"cmd.exe", "powershell.exe", "windowsterminal.exe"}
    for hwnd, title in handles:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        try:
            if psutil.Process(pid).name().lower() not in skip:
                return hwnd, title
        except psutil.NoSuchProcess:
            continue

    return None, None


def _do_winapi_capture(hwnd: int, width: int | None = None, height: int | None = None):
    """Capture via the same optimized WinAPI helper used by production code."""
    from GameSentenceMiner.obs.screenshot_capture import _capture_hwnd_winapi

    return _capture_hwnd_winapi(hwnd, width=width, height=height)


def _do_graphics_capture(hwnd: int, width: int | None = None, height: int | None = None):
    """Capture via Windows Graphics Capture (windows-capture package)."""
    from GameSentenceMiner.obs.screenshot_capture import _capture_hwnd_windows_graphics_capture

    return _capture_hwnd_windows_graphics_capture(hwnd, width=width, height=height)


# ---------------------------------------------------------------------------
# Unified capture_once dispatcher
# ---------------------------------------------------------------------------


def capture_once(
    config: CaptureConfig,
    *,
    source_name: str | None = None,
    scene_name: str | None = None,
    window_handle: int | None = None,
    last: bool = False,
) -> tuple[float, tuple[int, int], int]:
    """Return (elapsed_s, image_size, decoded_png_bytes). Raises on failure."""
    t0 = time.perf_counter()

    if config.method == CaptureMethod.WINAPI:
        if not window_handle:
            raise RuntimeError("No window handle available for winapi capture.")
        img = _do_winapi_capture(window_handle, width=config.width, height=config.height)

    elif config.method == CaptureMethod.GRAPHICS_CAPTURE:
        if not window_handle:
            raise RuntimeError("No window handle available for graphics_capture.")
        img = _do_graphics_capture(window_handle, width=config.width, height=config.height)

    elif config.method == CaptureMethod.OBS_SCENE:
        if not scene_name:
            raise RuntimeError("No scene name available for obs_scene capture.")
        img = obs.get_screenshot_PIL(
            source_name=scene_name,
            compression=config.compression,
            img_format=config.img_format,
            width=config.width,
            height=config.height,
            preprocess_mode=config.preprocess_mode,
            force_obs=True,  # scene capture doesn't support WinAPI fallback
        )

    else:  # OBS_SOURCE
        if not source_name:
            raise RuntimeError("No source name available for obs_source capture.")
        img = obs.get_screenshot_PIL(
            source_name=source_name,
            compression=config.compression,
            img_format=config.img_format,
            width=config.width,
            height=config.height,
            preprocess_mode=config.preprocess_mode,
            force_obs=True,
        )

    elapsed = time.perf_counter() - t0
    if img is None:
        raise RuntimeError("Capture returned None")

    if last:
        img.show()

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return elapsed, img.size, buf.tell()


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Benchmark OBS/WinAPI screenshot capture across a matrix of options.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--iterations",
        type=int,
        default=50,
        help="Number of timed captures per config.",
    )
    p.add_argument(
        "--warmup",
        type=int,
        default=3,
        help="Warmup captures to run before timing (per config).",
    )
    p.add_argument(
        "--methods",
        nargs="+",
        default=["winapi", "graphics_capture", "obs_source"],
        choices=["obs_source", "obs_scene", "winapi", "graphics_capture"],
        help="Capture methods to benchmark.",
    )
    p.add_argument(
        "--formats",
        nargs="+",
        default=["jpg"],
        choices=["jpg", "png"],
        help="Image formats to test (OBS methods only).",
    )
    p.add_argument(
        "--compressions",
        nargs="+",
        type=int,
        default=[90],
        help="Compression/quality values to test (OBS methods only, 0-100).",
    )
    p.add_argument(
        "--widths",
        nargs="+",
        type=int,
        default=None,
        help="Output widths to test. Omit for source resolution.",
    )
    p.add_argument(
        "--heights",
        nargs="+",
        type=int,
        default=None,
        help="Output heights paired with --widths by index. If omitted, aspect ratio is preserved.",
    )
    p.add_argument(
        "--preprocess",
        nargs="+",
        default=["none"],
        choices=["none", "grayscale", "grayscale_unsharp"],
        dest="preprocess_modes",
        help="Preprocessing modes to test (OBS methods only).",
    )
    p.add_argument(
        "--source",
        default=None,
        help="OBS source name for obs_source captures. Auto-detected if omitted.",
    )
    p.add_argument(
        "--window",
        default=None,
        help=(
            "Window title (or partial) for winapi capture. Auto-detected from OBS source window settings if omitted."
        ),
    )
    p.add_argument(
        "--keep-going",
        action="store_true",
        help="Continue on capture failure. Failures are excluded from stats.",
    )
    p.add_argument(
        "--top",
        type=int,
        default=10,
        help="How many fastest configs to highlight in the final ranking.",
    )
    p.add_argument(
        "--no-pace-winapi",
        action="store_true",
        default=True,
        help=(
            "Disable pacing WinAPI/graphics_capture captures to the first measured obs_source average. "
            "By default, these methods sleep max(0, obs_source_avg - capture_time) "
            "after each timed capture so wall time reflects the slower OBS cadence."
        ),
    )
    return p


# ---------------------------------------------------------------------------
# Config building and target resolution
# ---------------------------------------------------------------------------


def build_configs(args: argparse.Namespace, selected_methods: list[CaptureMethod]) -> list[CaptureConfig]:
    resolutions: list[tuple[int | None, int | None]] = [(None, None)]
    if args.widths:
        heights = args.heights or []
        resolutions = [
            (w, heights[i] if i < len(heights) else (heights[-1] if heights else None))
            for i, w in enumerate(args.widths)
        ]

    configs: list[CaptureConfig] = []
    for method in selected_methods:
        if method in (CaptureMethod.WINAPI, CaptureMethod.GRAPHICS_CAPTURE):
            for w, h in resolutions:
                configs.append(CaptureConfig(method=method, width=w, height=h))
            continue
        for fmt in args.formats:
            for comp in args.compressions:
                for w, h in resolutions:
                    for pp in args.preprocess_modes:
                        configs.append(
                            CaptureConfig(
                                method=method,
                                img_format=fmt,
                                compression=comp,
                                width=w,
                                height=h,
                                preprocess_mode=pp,
                            )
                        )
    return configs


def resolve_capture_targets(
    args: argparse.Namespace, selected_methods: list[CaptureMethod]
) -> tuple[str | None, str | None, int | None]:
    """Return (source_name, scene_name, window_handle)."""
    source_name: str | None = None
    scene_name: str | None = None
    window_handle: int | None = None

    _winapi_methods = {CaptureMethod.WINAPI, CaptureMethod.GRAPHICS_CAPTURE}
    needs_obs = any(m not in _winapi_methods for m in selected_methods)
    if needs_obs:
        ensure_obs_connected()
        scene_name = obs.get_current_scene()
        if CaptureMethod.OBS_SOURCE in selected_methods:
            if args.source:
                source_name = args.source
            else:
                best = obs.get_best_source_for_screenshot(log_missing_source=True, suppress_errors=False)
                if not isinstance(best, dict) or not best.get("sourceName"):
                    raise RuntimeError("No active video source found in OBS. Pass --source explicitly.")
                source_name = best["sourceName"]

    _needs_window = _winapi_methods.intersection(selected_methods)
    if _needs_window:
        window_title = args.window
        if not window_title:
            # Try to resolve the actual window title from OBS source window settings
            if not needs_obs:
                ensure_obs_connected()
                scene_name = obs.get_current_scene()
            window_info = obs.get_window_info_from_source(scene_name=scene_name) if scene_name else None
            if window_info and window_info.get("title"):
                window_title = window_info["title"]
                print(f"Window   : auto-detected title '{window_title}' from OBS source settings")
            elif source_name:
                window_title = source_name
                print(f"Window   : falling back to OBS source name '{window_title}' as window title")

        if not window_title:
            raise RuntimeError("Could not determine window title for capture. Pass --window explicitly.")

        hwnd, matched_title = _find_window_handle(window_title)
        if not hwnd:
            raise RuntimeError(
                f"No window matching '{window_title}' found. Pass --window with an exact or partial window title."
            )
        print(f"Window   : capturing '{matched_title}' (hwnd={hwnd})")
        window_handle = hwnd

    return source_name, scene_name, window_handle


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------


def run_config(
    config: CaptureConfig,
    *,
    source_name: str | None,
    scene_name: str | None,
    window_handle: int | None,
    iterations: int,
    warmup: int,
    keep_going: bool,
    pacing_target_s: float | None = None,
) -> BenchResult:
    import psutil

    result = BenchResult(config=config)
    kwargs = dict(source_name=source_name, scene_name=scene_name, window_handle=window_handle)

    for _ in range(warmup):
        try:
            capture_once(config, **kwargs)
        except Exception:
            pass

    proc = psutil.Process()
    cpu_before = proc.cpu_times()
    wall_before = time.perf_counter()

    for i in range(iterations):
        try:
            if i == iterations - 1:
                kwargs["last"] = True
            elapsed, size, nbytes = capture_once(config, **kwargs)
            result.latencies.append(elapsed)
            if result.image_size is None:
                result.image_size = size
            result.image_bytes = nbytes
            if pacing_target_s is not None:
                time.sleep(max(0.0, pacing_target_s - elapsed))
        except Exception as exc:
            result.failures += 1
            if not keep_going:
                raise RuntimeError(f"Capture failed for '{config.label}': {exc}") from exc

    wall_elapsed = time.perf_counter() - wall_before
    cpu_after = proc.cpu_times()
    cpu_elapsed = (cpu_after.user + cpu_after.system) - (cpu_before.user + cpu_before.system)
    if wall_elapsed > 0:
        result.cpu_pct = (cpu_elapsed / wall_elapsed) * 100.0

    return result


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------


def print_result_detail(r: BenchResult, rank: int | None = None) -> None:
    prefix = f"[#{rank}] " if rank is not None else ""
    s = summarize_timings(r.latencies)
    size_str = f"{r.image_size[0]}x{r.image_size[1]}" if r.image_size else "?"
    kb = r.image_bytes / 1024.0
    cpu_str = f"{r.cpu_pct:.1f}%" if r.cpu_pct is not None else "n/a"
    print(f"{prefix}{r.config.label}")
    print(f"  Output size : {size_str}  |  Decoded PNG : {kb:.1f} KB")
    print(f"  Captures    : {len(r.latencies)}/{len(r.latencies) + r.failures}  failures={r.failures}")
    print(f"  CPU (proc)  : {cpu_str}  (avg process CPU% over timed run, 100%=1 core)")
    print(f"  Avg         : {ms(s['avg_s']):.2f} ms  ({s['avg_fps']:.1f} fps)")
    print(f"  Median      : {ms(s['median_s']):.2f} ms  ({s['median_fps']:.1f} fps)")
    print(f"  Stdev       : {ms(s['stdev_s']):.2f} ms")
    print(f"  Min / Max   : {ms(s['min_s']):.2f} ms / {ms(s['max_s']):.2f} ms")
    print(f"  P05 / P95   : {ms(s['p05_s']):.2f} ms / {ms(s['p95_s']):.2f} ms")
    print(f"  P99         : {ms(s['p99_s']):.2f} ms")
    print(f"  1%low fps   : {s['low_1pct_fps']:.1f}  |  1%high fps : {s['high_1pct_fps']:.1f}")
    print(f"  Throughput  : {s['throughput_fps']:.2f} captures/s")


def print_ranking_table(results: list[BenchResult], top: int) -> None:
    valid = [r for r in results if r.latencies]
    if not valid:
        print("No successful results to rank.")
        return

    ranked = sorted(valid, key=lambda r: summarize_timings(r.latencies)["avg_s"])
    col = max(len(r.config.label) for r in ranked)
    header = f"{'Rank':<5} {'Config':<{col}}  {'Avg ms':>8}  {'Median ms':>10}  {'P95 ms':>8}  {'FPS avg':>8}  {'CPU%':>6}  {'Fails':>6}"
    print(header)
    print("-" * len(header))

    for i, r in enumerate(ranked, 1):
        s = summarize_timings(r.latencies)
        marker = " *" if i <= top else "  "
        cpu_str = f"{r.cpu_pct:>5.1f}%" if r.cpu_pct is not None else "   n/a"
        print(
            f"{i:<5}{marker}{r.config.label:<{col}}  "
            f"{ms(s['avg_s']):>8.2f}  {ms(s['median_s']):>10.2f}  "
            f"{ms(s['p95_s']):>8.2f}  {s['avg_fps']:>8.1f}  {cpu_str}  {r.failures:>6}"
        )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    args = build_parser().parse_args()

    if args.iterations <= 0:
        raise SystemExit("--iterations must be > 0")
    if args.warmup < 0:
        raise SystemExit("--warmup must be >= 0")

    ensure_gsm_imports()

    selected_methods = [CaptureMethod(m) for m in args.methods]
    source_name, scene_name, window_handle = resolve_capture_targets(args, selected_methods)
    configs = build_configs(args, selected_methods)

    print(f"Python   : {sys.executable}")
    print(f"Scene    : {scene_name or '<unknown>'}")
    if source_name:
        print(f"Source   : {source_name}")
    print(f"Methods  : {[m.value for m in selected_methods]}")
    _winapi_methods = {CaptureMethod.WINAPI, CaptureMethod.GRAPHICS_CAPTURE}
    print(f"Configs  : {len(configs)}")
    print(f"Warmup   : {args.warmup} per config")
    print(f"Timed    : {args.iterations} per config")
    pace_winapi = not args.no_pace_winapi
    has_native_methods = bool(_winapi_methods.intersection(selected_methods))
    needs_obs = any(m not in _winapi_methods for m in selected_methods)
    if pace_winapi and has_native_methods and needs_obs:
        print("Pacing   : winapi/graphics_capture sleeps to match first successful obs_source avg")
    elif has_native_methods and not needs_obs:
        print("Pacing   : disabled (no OBS method for reference)")
    if any(m not in _winapi_methods for m in selected_methods):
        print(f"Formats  : {args.formats}")
        print(f"Compress : {args.compressions}")
        print(f"Preproc  : {args.preprocess_modes}")
    print("")

    results: list[BenchResult] = []
    total = len(configs)
    obs_source_pacing_target_s: float | None = None

    for idx, config in enumerate(configs, 1):
        print(f"[{idx}/{total}] {config.label} ...", end="", flush=True)
        t_start = time.perf_counter()
        pacing_target_s = None
        if pace_winapi and config.method in _winapi_methods:
            pacing_target_s = obs_source_pacing_target_s
            if pacing_target_s is None and needs_obs:
                print("  pacing unavailable until obs_source has a successful result", end="", flush=True)
        try:
            r = run_config(
                config,
                source_name=source_name,
                scene_name=scene_name,
                window_handle=window_handle,
                iterations=args.iterations,
                warmup=args.warmup,
                keep_going=args.keep_going,
                pacing_target_s=pacing_target_s,
            )
            wall = time.perf_counter() - t_start
            if r.latencies:
                s = summarize_timings(r.latencies)
                if config.method == CaptureMethod.OBS_SOURCE and obs_source_pacing_target_s is None:
                    obs_source_pacing_target_s = s["avg_s"]
                    pacing_note = f"  pacing-target={ms(obs_source_pacing_target_s):.1f}ms"
                elif pacing_target_s is not None:
                    avg_sleep_s = max(0.0, pacing_target_s - s["avg_s"])
                    pacing_note = f"  avg-sleep~{ms(avg_sleep_s):.1f}ms"
                else:
                    pacing_note = ""
                print(f"  avg={ms(s['avg_s']):.1f}ms  fps={s['avg_fps']:.1f}  wall={wall:.1f}s{pacing_note}")
            else:
                print(f"  all {r.failures} captures failed  wall={wall:.1f}s")
            results.append(r)
        except RuntimeError as exc:
            wall = time.perf_counter() - t_start
            print(f"  FAILED: {exc}  wall={wall:.1f}s")
            if not args.keep_going:
                return 1
            results.append(BenchResult(config=config, failures=args.iterations))

    print("")
    print("=" * 80)
    print("DETAILED RESULTS")
    print("=" * 80)
    for r in results:
        if r.latencies:
            print_result_detail(r)
            print("")

    print("=" * 80)
    print(f"RANKING (top {args.top} marked with *)")
    print("=" * 80)
    print_ranking_table(results, top=args.top)

    failed_configs = [r for r in results if not r.latencies]
    if failed_configs:
        print(f"\n{len(failed_configs)} config(s) produced no successful captures:")
        for r in failed_configs:
            print(f"  - {r.config.label}")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrupted.")
        raise SystemExit(1)
