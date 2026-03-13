import argparse
import contextlib
import datetime
import importlib
import json
import os
import shutil
import sqlite3
import statistics
import sys
import time
import types
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def _normalise_windows_path(path: Path) -> Path:
    path_str = str(path)
    if os.name == "nt" and path_str.startswith("\\\\?\\"):
        return Path(path_str[4:])
    return path

_VALID_ENDPOINTS = (
    "stats",
    "today",
    "game",
    "anki_page",
    "anki_combined",
    "goals_page",
)
_DEFAULT_ENDPOINTS = ("stats", "today", "game")
_BENCHMARK_TABLES = (
    "game_lines",
    "daily_stats_rollup",
    "games",
    "third_party_stats",
    "anki_notes",
    "anki_cards",
    "anki_reviews",
)
_TEMP_ROOT = _normalise_windows_path(REPO_ROOT) / ".tmp_test_env" / "benchmark"
_ANKI_PAGE_SECTIONS = "earliest_date,kanji_stats,game_stats"
_ANKI_COMBINED_SECTIONS = "earliest_date,kanji_stats,game_stats,reading_impact"


@dataclass(frozen=True)
class BenchmarkSelection:
    game_id: str | None
    today_date: str


@dataclass(frozen=True)
class EndpointMeasurement:
    endpoint: str
    url: str
    status_code: int
    response_bytes: int
    samples_ms: list[float]
    min_ms: float
    mean_ms: float
    max_ms: float


class _NoopLogger:
    def __getattr__(self, _name: str):
        def _noop(*_args, **_kwargs):
            return None

        return _noop

    def patch(self, *_args, **_kwargs):
        return self

    def log(self, *_args, **_kwargs):
        return None


def _default_db_path() -> Path:
    if sys.platform == "win32":
        appdata_dir = Path(os.getenv("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:
        appdata_dir = Path(os.path.expanduser("~/.config"))
    return appdata_dir / "GameSentenceMiner" / "gsm.db"


def _sqlite_uri(path: Path, mode: str) -> str:
    resolved = _normalise_windows_path(path).resolve()
    return f"file:{quote(resolved.as_posix(), safe='/:')}?mode={mode}"


def _connect_read_only(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(_sqlite_uri(path, "ro"), uri=True, check_same_thread=False)


def create_snapshot_db(source_db_path: Path, snapshot_target: Path) -> Path:
    """Create a stable benchmark snapshot using SQLite's backup API."""
    if snapshot_target.suffix.lower() == ".db":
        snapshot_path = snapshot_target
        snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        snapshot_target.mkdir(parents=True, exist_ok=True)
        snapshot_path = snapshot_target / source_db_path.name

    with _connect_read_only(source_db_path) as source_conn:
        with sqlite3.connect(snapshot_path, check_same_thread=False) as snapshot_conn:
            source_conn.backup(snapshot_conn)

    return snapshot_path


def parse_endpoint_names(raw_value: str) -> list[str]:
    endpoints = []
    for value in raw_value.split(","):
        cleaned = value.strip().lower()
        if not cleaned:
            continue
        if cleaned not in _VALID_ENDPOINTS:
            raise argparse.ArgumentTypeError(
                f"Unsupported endpoint '{cleaned}'. Expected one of: {', '.join(_VALID_ENDPOINTS)}."
            )
        if cleaned not in endpoints:
            endpoints.append(cleaned)

    if not endpoints:
        raise argparse.ArgumentTypeError("At least one endpoint must be selected.")

    return endpoints


def get_table_row_counts(db_path: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    with _connect_read_only(db_path) as conn:
        cursor = conn.cursor()
        for table_name in _BENCHMARK_TABLES:
            try:
                counts[table_name] = int(
                    cursor.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
                )
            except sqlite3.OperationalError:
                counts[table_name] = 0
    return counts


def select_hottest_game_id(db_path: Path) -> str | None:
    with _connect_read_only(db_path) as conn:
        cursor = conn.cursor()
        hottest = cursor.execute(
            """
            SELECT game_id
            FROM game_lines
            WHERE game_id IS NOT NULL AND game_id != ''
            GROUP BY game_id
            ORDER BY COUNT(*) DESC, game_id ASC
            LIMIT 1
            """
        ).fetchone()
        if hottest and hottest[0]:
            return str(hottest[0])

        fallback = cursor.execute(
            "SELECT id FROM games ORDER BY id ASC LIMIT 1"
        ).fetchone()
        if fallback and fallback[0]:
            return str(fallback[0])

    return None


def select_latest_activity_date(db_path: Path) -> str | None:
    with _connect_read_only(db_path) as conn:
        cursor = conn.cursor()
        latest = cursor.execute("SELECT MAX(timestamp) FROM game_lines").fetchone()
        latest_ts = latest[0] if latest else None
        if latest_ts is None:
            return None
        return datetime.date.fromtimestamp(float(latest_ts)).isoformat()


def resolve_selection(
    db_path: Path,
    endpoints: list[str],
    requested_game_id: str | None,
    requested_today_date: str,
) -> BenchmarkSelection:
    game_id = requested_game_id
    if "game" in endpoints and not game_id:
        game_id = select_hottest_game_id(db_path)
        if not game_id:
            raise RuntimeError(
                "Unable to choose a game for /api/game/<game_id>/stats. "
                "Pass --game-id or add at least one game to the benchmark DB."
            )

    if requested_today_date == "latest-activity":
        today_date = select_latest_activity_date(db_path)
        if today_date is None:
            today_date = datetime.date.today().isoformat()
    else:
        datetime.date.fromisoformat(requested_today_date)
        today_date = requested_today_date

    return BenchmarkSelection(game_id=game_id, today_date=today_date)


def _install_noop_logging_module() -> None:
    noop_logger = _NoopLogger()
    fake_logging_module = types.ModuleType("GameSentenceMiner.util.logging_config")
    fake_logging_module.logger = noop_logger
    fake_logging_module.get_logger = lambda *args, **kwargs: noop_logger
    fake_logging_module.initialize_logging = lambda *args, **kwargs: None
    fake_logging_module.cleanup_old_logs = lambda *args, **kwargs: None
    fake_logging_module.display = lambda *args, **kwargs: None
    fake_logging_module.background = lambda *args, **kwargs: None
    fake_logging_module.text_received = lambda *args, **kwargs: None
    fake_logging_module.LoggerManager = object
    sys.modules["GameSentenceMiner.util.logging_config"] = fake_logging_module


def _install_keyboard_stub() -> None:
    if "keyboard" in sys.modules:
        return

    fake_keyboard = types.ModuleType("keyboard")
    fake_keyboard.add_hotkey = lambda *args, **kwargs: None
    fake_keyboard.remove_hotkey = lambda *args, **kwargs: None
    fake_keyboard.on_press_key = lambda *args, **kwargs: None
    fake_keyboard.unhook_key = lambda *args, **kwargs: None
    fake_keyboard.hook = lambda *args, **kwargs: None
    fake_keyboard.unhook_all = lambda *args, **kwargs: None
    sys.modules["keyboard"] = fake_keyboard


def _configure_bootstrap_environment(bootstrap_root: Path) -> None:
    bootstrap_root.mkdir(parents=True, exist_ok=True)
    local_root = bootstrap_root / "Local"
    home_root = bootstrap_root / "home"
    xdg_root = bootstrap_root / "xdg"
    tmp_root = bootstrap_root / "tmp"

    for path in (local_root, home_root, xdg_root, tmp_root):
        path.mkdir(parents=True, exist_ok=True)

    os.environ["APPDATA"] = str(bootstrap_root)
    os.environ["LOCALAPPDATA"] = str(local_root)
    os.environ["HOME"] = str(home_root)
    os.environ["USERPROFILE"] = str(home_root)
    os.environ["XDG_CONFIG_HOME"] = str(xdg_root)
    os.environ["TMP"] = str(tmp_root)
    os.environ["TEMP"] = str(tmp_root)
    os.environ["TMPDIR"] = str(tmp_root)
    os.environ["GAME_SENTENCE_MINER_TESTING"] = "1"
    # The bootstrap DB must stay writable; the benchmark DB itself is rebound read-only.
    os.environ["GSM_DB_READ_ONLY"] = "0"


@dataclass
class BenchmarkClient:
    client: Any
    stats_api_module: Any
    benchmark_db: Any

    def close(self) -> None:
        self.benchmark_db.close()


def build_benchmark_client(
    benchmark_db_path: Path,
    bootstrap_root: Path,
    *,
    include_anki: bool = False,
    include_goals: bool = False,
) -> BenchmarkClient:
    """Build a minimal Flask client bound to a read-only benchmark DB."""
    _configure_bootstrap_environment(bootstrap_root)
    _install_noop_logging_module()
    _install_keyboard_stub()

    web_path = REPO_ROOT / "GameSentenceMiner" / "web"
    fake_web_package = types.ModuleType("GameSentenceMiner.web")
    fake_web_package.__path__ = [str(web_path)]
    sys.modules["GameSentenceMiner.web"] = fake_web_package

    flask = importlib.import_module("flask")
    stats_api = importlib.import_module("GameSentenceMiner.web.stats_api")
    db_module = importlib.import_module("GameSentenceMiner.util.database.db")
    games_module = importlib.import_module("GameSentenceMiner.util.database.games_table")
    game_daily_rollup_module = importlib.import_module(
        "GameSentenceMiner.util.database.game_daily_rollup_table"
    )
    stats_rollup_module = importlib.import_module(
        "GameSentenceMiner.util.database.stats_rollup_table"
    )
    third_party_module = importlib.import_module(
        "GameSentenceMiner.util.database.third_party_stats_table"
    )

    benchmark_db = db_module.SQLiteDB(str(benchmark_db_path), read_only=True)
    games_module.GamesTable.set_db(benchmark_db)
    db_module.GameLinesTable.set_db(benchmark_db)
    if include_goals:
        db_module.GoalsTable.set_db(benchmark_db)
    game_daily_rollup_module.GameDailyRollupTable.set_db(benchmark_db)
    stats_rollup_module.StatsRollupTable.set_db(benchmark_db)
    third_party_module.ThirdPartyStatsTable.set_db(benchmark_db)

    app = flask.Flask(
        __name__,
        template_folder=str(_normalise_windows_path(web_path / "templates")),
        static_folder=str(_normalise_windows_path(web_path / "static")),
    )
    stats_api.register_stats_api_routes(app)
    if include_anki:
        anki_api = importlib.import_module("GameSentenceMiner.web.anki_api_endpoints")
        anki_tables_module = importlib.import_module(
            "GameSentenceMiner.util.database.anki_tables"
        )
        anki_tables_module.AnkiNotesTable.set_db(benchmark_db)
        anki_tables_module.AnkiCardsTable.set_db(benchmark_db)
        anki_tables_module.AnkiReviewsTable.set_db(benchmark_db)
        anki_api.invalidate_anki_data_cache()
        anki_api.register_anki_api_endpoints(app)

        @app.route("/anki_stats")
        def anki_stats_page():
            return flask.render_template("anki_stats.html")

    if include_goals:
        goals_api = importlib.import_module("GameSentenceMiner.web.goals_api")
        goals_api.register_goals_api_routes(app)

        @app.route("/goals")
        def goals_page():
            return flask.render_template("goals.html")

    return BenchmarkClient(
        client=app.test_client(),
        stats_api_module=stats_api,
        benchmark_db=benchmark_db,
    )


@contextlib.contextmanager
def patched_today_date(stats_api_module: Any, target_date: str) -> Iterator[None]:
    """Patch module-local datetime so /api/today-stats can target a stable active day."""
    original_datetime = stats_api_module.datetime
    target = datetime.date.fromisoformat(target_date)

    class _PatchedDate(datetime.date):
        @classmethod
        def today(cls) -> "_PatchedDate":
            return cls(target.year, target.month, target.day)

    class _PatchedDateTime(datetime.datetime):
        @classmethod
        def now(cls, tz=None) -> "_PatchedDateTime":
            return cls(target.year, target.month, target.day, 17, 0, 0, tzinfo=tz)

    patched_module = types.SimpleNamespace(
        date=_PatchedDate,
        datetime=_PatchedDateTime,
        time=datetime.time,
        timedelta=datetime.timedelta,
    )

    stats_api_module.datetime = patched_module
    try:
        yield
    finally:
        stats_api_module.datetime = original_datetime


def benchmark_endpoint(
    client: Any,
    stats_api_module: Any,
    endpoint_name: str,
    urls: list[str],
    iterations: int,
    warmup: int,
    today_date: str,
) -> EndpointMeasurement:
    context = (
        patched_today_date(stats_api_module, today_date)
        if endpoint_name == "today"
        else contextlib.nullcontext()
    )

    samples_ms: list[float] = []
    response_bytes = 0
    status_code = 0
    url_summary = " -> ".join(urls)

    with context:
        for _ in range(max(warmup, 0)):
            total_bytes = 0
            for url in urls:
                response = client.get(url)
                status_code = response.status_code
                total_bytes += len(response.get_data())
                if response.status_code != 200:
                    raise RuntimeError(
                        f"Warmup request for {endpoint_name} ({url}) failed with {response.status_code}."
                    )
            response_bytes = total_bytes

        for _ in range(iterations):
            started_at = time.perf_counter()
            total_bytes = 0
            for url in urls:
                response = client.get(url)
                status_code = response.status_code
                total_bytes += len(response.get_data())
                if response.status_code != 200:
                    raise RuntimeError(
                        f"Benchmark request for {endpoint_name} ({url}) failed with {response.status_code}."
                    )
            elapsed_ms = (time.perf_counter() - started_at) * 1000.0
            response_bytes = total_bytes
            samples_ms.append(elapsed_ms)

    return EndpointMeasurement(
        endpoint=endpoint_name,
        url=url_summary,
        status_code=status_code,
        response_bytes=response_bytes,
        samples_ms=samples_ms,
        min_ms=min(samples_ms) if samples_ms else 0.0,
        mean_ms=statistics.mean(samples_ms) if samples_ms else 0.0,
        max_ms=max(samples_ms) if samples_ms else 0.0,
    )


def build_output_payload(
    source_db_path: Path,
    effective_db_path: Path,
    db_mode: str,
    row_counts: dict[str, int],
    selection: BenchmarkSelection,
    measurements: list[EndpointMeasurement],
) -> dict[str, Any]:
    return {
        "db_metadata": {
            "source_db_path": str(source_db_path),
            "benchmark_db_path": str(effective_db_path),
            "db_mode": db_mode,
            "row_counts": row_counts,
        },
        "selection": asdict(selection),
        "results": {measurement.endpoint: asdict(measurement) for measurement in measurements},
    }


def cleanup_snapshot_file(snapshot_path: Path) -> None:
    """Best-effort cleanup for snapshot files that may remain briefly locked on Windows."""
    for attempt in range(5):
        try:
            snapshot_path.unlink(missing_ok=True)
            return
        except PermissionError:
            if attempt == 4:
                return
            time.sleep(0.05)
        except OSError:
            return


def print_human_summary(payload: dict[str, Any]) -> None:
    db_metadata = payload["db_metadata"]
    selection = payload["selection"]

    print("Stats Benchmark")
    print(f"source_db_path: {db_metadata['source_db_path']}")
    print(f"benchmark_db_path: {db_metadata['benchmark_db_path']}")
    print(f"db_mode: {db_metadata['db_mode']}")

    row_counts = db_metadata["row_counts"]
    row_summary = ", ".join(f"{table}={count}" for table, count in row_counts.items())
    print(f"row_counts: {row_summary}")

    print(f"selected_game_id: {selection['game_id'] or '(none)'}")
    print(f"selected_today_date: {selection['today_date']}")

    for endpoint_name, result in payload["results"].items():
        print(
            f"{endpoint_name}: status={result['status_code']} bytes={result['response_bytes']} "
            f"min={result['min_ms']:.2f}ms mean={result['mean_ms']:.2f}ms max={result['max_ms']:.2f}ms"
        )


def run_benchmarks(args: argparse.Namespace) -> dict[str, Any]:
    source_db_path = Path(args.db_path).expanduser().resolve()
    if not source_db_path.exists():
        raise FileNotFoundError(f"Benchmark DB does not exist: {source_db_path}")

    _TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    run_id = f"{os.getpid()}_{int(time.time() * 1000)}"
    bootstrap_root = _TEMP_ROOT / f"bootstrap_appdata_{run_id}"
    snapshot_path = _TEMP_ROOT / f"snapshot_{run_id}.db"

    benchmark_db_path = source_db_path
    if args.db_mode == "snapshot":
        benchmark_db_path = create_snapshot_db(source_db_path, snapshot_path)

    try:
        row_counts = get_table_row_counts(benchmark_db_path)
        selection = resolve_selection(
            benchmark_db_path,
            args.endpoints,
            args.game_id,
            args.today_date,
        )

        benchmark_client = build_benchmark_client(
            benchmark_db_path,
            bootstrap_root,
            include_anki=any(endpoint.startswith("anki") for endpoint in args.endpoints),
            include_goals=any(endpoint.startswith("goals") for endpoint in args.endpoints),
        )
        try:
            endpoint_urls: dict[str, list[str]] = {
                "stats": ["/api/stats"],
                "today": ["/api/today-stats"],
                "game": [f"/api/game/{selection.game_id}/stats"],
                "anki_combined": [
                    f"/api/anki_stats_combined?sections={_ANKI_COMBINED_SECTIONS}"
                ],
                "anki_page": [
                    "/anki_stats",
                    f"/api/anki_stats_combined?sections={_ANKI_PAGE_SECTIONS}",
                ],
                "goals_page": [
                    "/goals",
                    "/api/goals/dashboard",
                ],
            }

            measurements = [
                benchmark_endpoint(
                    benchmark_client.client,
                    benchmark_client.stats_api_module,
                    endpoint_name=endpoint_name,
                    urls=endpoint_urls[endpoint_name],
                    iterations=args.iterations,
                    warmup=args.warmup,
                    today_date=selection.today_date,
                )
                for endpoint_name in args.endpoints
            ]
        finally:
            benchmark_client.close()

        payload = build_output_payload(
            source_db_path=source_db_path,
            effective_db_path=benchmark_db_path,
            db_mode=args.db_mode,
            row_counts=row_counts,
            selection=selection,
            measurements=measurements,
        )

        if args.json_out:
            json_path = Path(args.json_out).expanduser()
            json_path.parent.mkdir(parents=True, exist_ok=True)
            json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

        return payload
    finally:
        shutil.rmtree(bootstrap_root, ignore_errors=True)
        if args.db_mode == "snapshot":
            cleanup_snapshot_file(snapshot_path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Benchmark GSM stats endpoints and the Anki stats page critical path."
    )
    parser.add_argument(
        "--db-path",
        default=str(_default_db_path()),
        help="Path to the GSM sqlite database to benchmark.",
    )
    parser.add_argument(
        "--db-mode",
        choices=("snapshot", "direct-ro"),
        default="snapshot",
        help="Benchmark a disposable snapshot copy or the source DB directly in read-only mode.",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=5,
        help="Number of timed samples to collect per endpoint.",
    )
    parser.add_argument(
        "--warmup",
        type=int,
        default=1,
        help="Number of untimed warmup requests to run per endpoint before sampling.",
    )
    parser.add_argument(
        "--endpoints",
        type=parse_endpoint_names,
        default=list(_DEFAULT_ENDPOINTS),
        help="Comma-separated subset of stats,today,game,anki_page,anki_combined.",
    )
    parser.add_argument(
        "--game-id",
        default=None,
        help="Explicit game id for /api/game/<game_id>/stats. Defaults to the hottest game.",
    )
    parser.add_argument(
        "--today-date",
        default="latest-activity",
        help="Benchmark day for /api/today-stats: latest-activity or YYYY-MM-DD.",
    )
    parser.add_argument(
        "--json-out",
        default=None,
        help="Optional path for machine-readable benchmark output.",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        payload = run_benchmarks(args)
    except Exception as exc:
        print(f"Benchmark failed: {exc}", file=sys.stderr)
        return 1

    print_human_summary(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
