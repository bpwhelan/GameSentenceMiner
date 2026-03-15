"""
Statistics Calculation Module

Pure computation functions for reading statistics. These functions operate on
lists of GameLinesTable records or pre-aggregated data and return plain dicts /
values.  They have **no** Flask dependency and can be called from API handlers,
cron jobs, or tests.

Functions that deal with *rollup aggregation* (combining daily snapshots with
today's live data) live in ``rollup_stats.py`` instead.
"""

from __future__ import annotations

import datetime
from collections import defaultdict
from typing import Dict, Sequence, Tuple

from GameSentenceMiner.util.config.configuration import (
    get_stats_config,
    logger,
)
from GameSentenceMiner.util.stats.stats_util import (
    has_cards,
    MAX_SEC_PER_CHAR as _MAX_SEC_PER_CHAR,
    FLOOR_SECONDS as _FLOOR_SECONDS,
    ABSOLUTE_CEILING as _ABSOLUTE_CEILING,
    MIN_CHARS_FOR_SPEED as _MIN_CHARS_FOR_SPEED,
    MIN_SAMPLES_FOR_IQR as _MIN_SAMPLES_FOR_IQR,
)
from GameSentenceMiner.util.text_utils import is_kanji


# ---------------------------------------------------------------------------
# Lazy import helper
# ---------------------------------------------------------------------------


def _get_games_table():
    """Lazy import to avoid circular import with db module."""
    from GameSentenceMiner.util.database.games_table import GamesTable

    return GamesTable


# ---------------------------------------------------------------------------
# Game display-name mapping
# ---------------------------------------------------------------------------


def build_game_display_name_mapping(all_lines) -> Dict[str, str]:
    """Build a mapping of game_name -> display_name (title_original if available).

    Centralises the logic for converting OBS scene names to clean game titles
    for display in charts and statistics.
    """
    game_name_to_display: Dict[str, str] = {}
    unique_game_names = set(line.game_name or "Unknown Game" for line in all_lines)

    logger.debug(
        f"Building display name mapping for {len(unique_game_names)} unique games"
    )

    for game_name in unique_game_names:
        sample_line = next(
            (
                line
                for line in all_lines
                if (line.game_name or "Unknown Game") == game_name
            ),
            None,
        )
        if sample_line:
            game_metadata = _get_games_table().get_by_game_line(sample_line)
            if game_metadata and game_metadata.title_original:
                game_name_to_display[game_name] = game_metadata.title_original
            else:
                game_name_to_display[game_name] = game_name

    return game_name_to_display


# ---------------------------------------------------------------------------
# Kanji frequency calculation
# ---------------------------------------------------------------------------


def calculate_kanji_frequency(all_lines) -> Dict:
    """Calculate frequency of kanji characters across all lines with gradient colouring."""
    kanji_count: Dict[str, int] = defaultdict(int)

    for line in all_lines:
        if line.line_text:
            try:
                line_text = str(line.line_text) if line.line_text else ""
                for char in line_text:
                    if is_kanji(char):
                        kanji_count[char] += 1
            except Exception as e:
                logger.warning(
                    f"Error processing line text for kanji frequency: "
                    f"{repr(line.line_text)}, error: {e}"
                )
                continue

    if not kanji_count:
        return {"kanji_data": [], "unique_count": 0}

    max_frequency = max(kanji_count.values())
    sorted_kanji = sorted(kanji_count.items(), key=lambda x: x[1], reverse=True)

    kanji_data = []
    for kanji, count in sorted_kanji:
        color = get_gradient_color(count, max_frequency)
        kanji_data.append({"kanji": kanji, "frequency": count, "color": color})

    return {
        "kanji_data": kanji_data,
        "unique_count": len(sorted_kanji),
        "max_frequency": max_frequency,
    }


# ---------------------------------------------------------------------------
# Colour / gradient utilities
# ---------------------------------------------------------------------------


def interpolate_color(color1: str, color2: str, factor: float) -> str:
    """Interpolate between two hex colours."""

    def hex_to_rgb(hex_color: str) -> Tuple[int, ...]:
        hex_color = hex_color.lstrip("#")
        return tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))

    def rgb_to_hex(rgb: Tuple[float, ...]) -> str:
        return f"#{int(rgb[0]):02x}{int(rgb[1]):02x}{int(rgb[2]):02x}"

    rgb1 = hex_to_rgb(color1)
    rgb2 = hex_to_rgb(color2)
    rgb_result = tuple(rgb1[i] + factor * (rgb2[i] - rgb1[i]) for i in range(3))
    return rgb_to_hex(rgb_result)


def get_gradient_color(frequency: int, max_frequency: int) -> str:
    """Get colour from gradient based on frequency."""
    if max_frequency == 0:
        return "#ebedf0"

    # Kanji with 300+ encounters always get cyan
    if frequency > 300:
        return "#2ee6e0"

    # Square-root transformation for smoother gradient (Zipf's law)
    ratio = (frequency / max_frequency) ** 0.5

    colors = ["#e6342e", "#e6dc2e", "#3be62f", "#2ee6e0"]

    if ratio == 0:
        return "#ebedf0"

    scaled_ratio = ratio * (len(colors) - 1)
    segment = int(scaled_ratio)
    local_ratio = scaled_ratio - segment

    if segment >= len(colors) - 1:
        return colors[-1]

    return interpolate_color(colors[segment], colors[segment + 1], local_ratio)


# ---------------------------------------------------------------------------
# Game colour generation
# ---------------------------------------------------------------------------


def generate_game_colors(game_count: int) -> list[str]:
    """Generate visually distinct colours for games using HSL colour space."""
    colors: list[str] = []

    predefined_colors = [
        "#3498db",
        "#e74c3c",
        "#2ecc71",
        "#f1c40f",
        "#9b59b6",
        "#1abc9c",
        "#e67e22",
        "#34495e",
        "#16a085",
        "#27ae60",
        "#2980b9",
        "#8e44ad",
        "#d35400",
        "#c0392b",
        "#7f8c8d",
    ]

    for i in range(min(game_count, len(predefined_colors))):
        colors.append(predefined_colors[i])

    if game_count > len(predefined_colors):
        remaining = game_count - len(predefined_colors)
        for i in range(remaining):
            hue = (i * 360 / remaining) % 360
            saturation = 65 + (i % 3) * 10
            lightness = 45 + (i % 2) * 10
            colors.append(f"hsl({hue:.0f}, {saturation}%, {lightness}%)")

    return colors


# ---------------------------------------------------------------------------
# Hourly activity aggregations (used by daily_rollup cron job)
# ---------------------------------------------------------------------------


def calculate_hourly_activity(all_lines) -> list[int]:
    """Calculate reading activity aggregated by hour of day (0-23).

    Returns character count for each hour across all days.
    """
    if not all_lines:
        return [0] * 24

    hourly_chars = [0] * 24

    for line in all_lines:
        hour = datetime.datetime.fromtimestamp(float(line.timestamp)).hour
        char_count = len(line.line_text) if line.line_text else 0
        hourly_chars[hour] += char_count

    return hourly_chars


def calculate_hourly_reading_speed(all_lines) -> list[int]:
    """Calculate average reading speed (chars/hour) by hour of day (0-23)."""
    if not all_lines:
        return [0] * 24

    hourly_data: dict = defaultdict(
        lambda: {"chars": 0, "timestamps": [], "line_texts": []}
    )

    for line in all_lines:
        hour = datetime.datetime.fromtimestamp(float(line.timestamp)).hour
        char_count = len(line.line_text) if line.line_text else 0

        hourly_data[hour]["chars"] += char_count
        hourly_data[hour]["timestamps"].append(float(line.timestamp))
        hourly_data[hour]["line_texts"].append(line.line_text or "")

    hourly_speeds = [0] * 24

    for hour in range(24):
        if hour in hourly_data and len(hourly_data[hour]["timestamps"]) >= 2:
            chars = hourly_data[hour]["chars"]
            timestamps = hourly_data[hour]["timestamps"]

            reading_time_seconds = calculate_actual_reading_time(
                timestamps, line_texts=hourly_data[hour]["line_texts"]
            )
            reading_time_hours = reading_time_seconds / 3600

            if reading_time_hours > 0:
                hourly_speeds[hour] = int(chars / reading_time_hours)

    return hourly_speeds


# ---------------------------------------------------------------------------
# Heatmap calculations
# ---------------------------------------------------------------------------


def calculate_heatmap_data(
    all_lines, filter_year: str | None = None
) -> Dict[str, Dict[str, int]]:
    """Calculate heatmap data for reading activity (characters per day)."""
    heatmap_data: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for line in all_lines:
        date_obj = datetime.date.fromtimestamp(float(line.timestamp))
        year = str(date_obj.year)

        if filter_year and year != filter_year:
            continue

        date_str = date_obj.isoformat()
        char_count = len(line.line_text) if line.line_text else 0
        heatmap_data[year][date_str] += char_count

    return dict(heatmap_data)


def calculate_mining_heatmap_data(
    all_lines, filter_year: str | None = None
) -> Dict[str, Dict[str, int]]:
    """Calculate heatmap data for mining activity (mined lines per day)."""
    heatmap_data: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for line in all_lines:
        if not has_cards(line):
            continue

        date_obj = datetime.date.fromtimestamp(float(line.timestamp))
        year = str(date_obj.year)

        if filter_year and year != filter_year:
            continue

        date_str = date_obj.isoformat()
        heatmap_data[year][date_str] += 1

    return dict(heatmap_data)


def calculate_reading_speed_heatmap_data(
    all_lines, filter_year: str | None = None
) -> Tuple[Dict[str, Dict[str, int]], int]:
    """Calculate daily average reading speed (chars/hour) for heatmap visualisation.

    Returns:
        (heatmap_data, max_reading_speed)
    """
    daily_data: Dict[str, Dict] = defaultdict(
        lambda: {"chars": 0, "timestamps": [], "line_texts": []}
    )

    for line in all_lines:
        date_obj = datetime.date.fromtimestamp(float(line.timestamp))
        year = str(date_obj.year)

        if filter_year and year != filter_year:
            continue

        date_str = date_obj.isoformat()
        char_count = len(line.line_text) if line.line_text else 0

        daily_data[date_str]["chars"] += char_count
        daily_data[date_str]["timestamps"].append(float(line.timestamp))
        daily_data[date_str]["line_texts"].append(line.line_text or "")

    heatmap_data: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    max_speed = 0

    for date_str, data in daily_data.items():
        if len(data["timestamps"]) >= 2 and data["chars"] > 0:
            reading_time_seconds = calculate_actual_reading_time(
                data["timestamps"], line_texts=data["line_texts"]
            )
            reading_time_hours = reading_time_seconds / 3600

            if reading_time_hours > 0:
                speed = int(data["chars"] / reading_time_hours)
                year = date_str.split("-")[0]
                heatmap_data[year][date_str] = speed
                max_speed = max(max_speed, speed)

    return dict(heatmap_data), max_speed


def calculate_actual_reading_time(
    timestamps: Sequence[float],
    line_texts: Sequence[str],
) -> float:
    """Calculate actual reading time with adaptive AFK detection.

    Stage 1 – Adaptive per-line cap
        Each line gets a maximum plausible reading time proportional to its
        character count.

    Stage 2 – Statistical outlier replacement (IQR)
        Per-line reading speeds are computed; outliers below the lower whisker
        are replaced by a median-speed estimate.

    Returns:
        Actual reading time in seconds.
    """
    if not timestamps or len(timestamps) < 2:
        return 0.0

    # --- Stage 1: Adaptive per-line cap ---
    sorted_pairs = sorted(zip(timestamps, line_texts), key=lambda p: p[0])

    gaps: list[list] = []
    for i in range(len(sorted_pairs) - 1):
        raw_gap = sorted_pairs[i + 1][0] - sorted_pairs[i][0]
        text = sorted_pairs[i][1] or ""
        char_count = len(text)

        max_time = max(_FLOOR_SECONDS, char_count * _MAX_SEC_PER_CHAR)
        max_time = min(max_time, _ABSOLUTE_CEILING)
        capped_gap = min(raw_gap, max_time)
        gaps.append([capped_gap, char_count])

    # --- Stage 2: IQR outlier filtering ---
    speeds: list[float] = []
    speed_indices: list[int] = []
    for i, (gap, char_count) in enumerate(gaps):
        if char_count >= _MIN_CHARS_FOR_SPEED and gap > 0:
            speeds.append(char_count / gap)
            speed_indices.append(i)

    if len(speeds) >= _MIN_SAMPLES_FOR_IQR:
        sorted_speeds = sorted(speeds)
        n = len(sorted_speeds)
        q1 = sorted_speeds[n // 4]
        q3 = sorted_speeds[3 * n // 4]
        iqr = q3 - q1
        lower_bound = q1 - 1.5 * iqr
        median_speed = sorted_speeds[n // 2]

        if median_speed > 0:
            for j, idx in enumerate(speed_indices):
                if speeds[j] < lower_bound:
                    char_count = gaps[idx][1]
                    gaps[idx][0] = char_count / median_speed

    return sum(gap for gap, _ in gaps)


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def format_large_number(num: int | float) -> str:
    """Format large numbers with appropriate units (K for thousands, M for millions)."""
    if num >= 1_000_000:
        return f"{num / 1_000_000:.1f}M"
    elif num >= 1_000:
        return f"{num / 1_000:.1f}K"
    else:
        return str(int(num))


def format_time_human_readable(hours: float) -> str:
    """Format time in human-readable format (hours and minutes)."""
    if hours < 1:
        minutes = int(hours * 60)
        return f"{minutes}m"
    elif hours < 24:
        whole_hours = int(hours)
        minutes = int((hours - whole_hours) * 60)
        if minutes > 0:
            return f"{whole_hours}h {minutes}m"
        else:
            return f"{whole_hours}h"
    else:
        days = int(hours / 24)
        remaining_hours = int(hours % 24)
        if remaining_hours > 0:
            return f"{days}d {remaining_hours}h"
        else:
            return f"{days}d"


# ---------------------------------------------------------------------------
# Current-game / milestone statistics
# ---------------------------------------------------------------------------


def calculate_current_game_stats(all_lines) -> dict | None:
    """Calculate statistics for the currently active game (most recent entry)."""
    if not all_lines:
        return None

    sorted_lines = sorted(all_lines, key=lambda line: float(line.timestamp))
    current_game_line = sorted_lines[-1]
    current_game_name = current_game_line.game_name or "Unknown Game"

    current_game_lines = [
        line
        for line in all_lines
        if (line.game_name or "Unknown Game") == current_game_name
    ]

    if not current_game_lines:
        return None

    game_metadata = _get_games_table().get_by_game_line(current_game_line)

    # Basic statistics
    total_characters = sum(
        len(line.line_text) if line.line_text else 0 for line in current_game_lines
    )
    total_sentences = len(current_game_lines)

    timestamps = [float(line.timestamp) for line in current_game_lines]
    line_texts = [line.line_text or "" for line in current_game_lines]
    min_timestamp = min(timestamps)
    max_timestamp = max(timestamps)
    total_time_seconds = calculate_actual_reading_time(
        timestamps, line_texts=line_texts
    )
    total_time_hours = total_time_seconds / 3600

    reading_speed = (
        int(total_characters / total_time_hours) if total_time_hours > 0 else 0
    )

    # Sessions
    sorted_timestamps = sorted(timestamps)
    sessions = 1
    session_gap = get_stats_config().session_gap_seconds
    for i in range(1, len(sorted_timestamps)):
        if sorted_timestamps[i] - sorted_timestamps[i - 1] > session_gap:
            sessions += 1

    # Daily activity
    daily_activity: Dict[str, int] = defaultdict(int)
    for line in current_game_lines:
        date_str = datetime.date.fromtimestamp(float(line.timestamp)).isoformat()
        daily_activity[date_str] += len(line.line_text) if line.line_text else 0

    # Monthly progress (last 30 days)
    today = datetime.date.today()
    monthly_chars = 0
    for i in range(30):
        date = today - datetime.timedelta(days=i)
        date_str = date.isoformat()
        monthly_chars += daily_activity.get(date_str, 0)

    # Progress percentage
    progress_percentage = 0.0
    if (
        game_metadata
        and game_metadata.character_count
        and game_metadata.character_count > 0
    ):
        progress_percentage = min(
            100, (total_characters / game_metadata.character_count) * 100
        )

    result: dict = {
        "game_name": current_game_name,
        "total_characters": total_characters,
        "total_characters_formatted": format_large_number(total_characters),
        "total_sentences": total_sentences,
        "total_time_hours": total_time_hours,
        "total_time_formatted": format_time_human_readable(total_time_hours),
        "reading_speed": reading_speed,
        "reading_speed_formatted": format_large_number(reading_speed),
        "sessions": sessions,
        "monthly_characters": monthly_chars,
        "monthly_characters_formatted": format_large_number(monthly_chars),
        "current_streak": 0,
        "first_date": datetime.date.fromtimestamp(min_timestamp).isoformat(),
        "last_date": datetime.date.fromtimestamp(max_timestamp).isoformat(),
        "daily_activity": dict(daily_activity),
        "progress_percentage": round(progress_percentage, 1),
    }

    # Game metadata
    if game_metadata:
        result.update(
            {
                "game_id": game_metadata.id or "",
                "title_original": game_metadata.title_original or "",
                "title_romaji": game_metadata.title_romaji or "",
                "title_english": game_metadata.title_english or "",
                "type": game_metadata.type or "",
                "description": game_metadata.description or "",
                "image": game_metadata.image or "",
                "game_character_count": game_metadata.character_count or 0,
                "links": game_metadata.links or [],
                "completed": game_metadata.completed or False,
                "genres": game_metadata.genres or [],
                "tags": game_metadata.tags or [],
            }
        )
    else:
        result.update(
            {
                "game_id": "",
                "title_original": "",
                "title_romaji": "",
                "title_english": "",
                "type": "",
                "description": "",
                "image": "",
                "game_character_count": 0,
                "links": [],
                "completed": False,
                "genres": [],
                "tags": [],
            }
        )

    return result


def calculate_game_milestones(all_lines=None) -> dict | None:
    """Calculate oldest and newest games by release year from the games table.

    Args:
        all_lines: Unused parameter (kept for API compatibility).
    """
    GamesTable = _get_games_table()
    all_games = GamesTable.all()

    if not all_games:
        return None

    def parse_release_date(game_dict: dict) -> str:
        try:
            return game_dict["release_date"].split("T")[0]
        except Exception:
            return "9999-12-31"

    def format_release_date(release_date_str: str) -> str:
        try:
            return release_date_str.split("T")[0]
        except Exception:
            return "Unknown"

    def format_first_played(timestamp: float | None) -> str:
        if timestamp:
            return datetime.date.fromtimestamp(timestamp).isoformat()
        return "Unknown"

    games_with_dates: list[dict] = []
    for game in all_games:
        if game.release_date and game.release_date.strip():
            first_played = GamesTable.get_start_date(game.id)
            games_with_dates.append(
                {
                    "id": game.id,
                    "title_original": game.title_original,
                    "title_romaji": game.title_romaji,
                    "title_english": game.title_english,
                    "type": game.type,
                    "image": game.image,
                    "release_date": game.release_date,
                    "first_played": first_played,
                    "difficulty": game.difficulty,
                }
            )

    if not games_with_dates:
        return None

    games_with_dates.sort(key=parse_release_date)

    oldest_game = games_with_dates[0]
    newest_game = games_with_dates[-1]

    if len(games_with_dates) > 1 and oldest_game["id"] == newest_game["id"]:
        newest_game = games_with_dates[-2]

    result: dict = {}

    def _build_milestone_entry(game: dict) -> dict:
        return {
            "title_original": game["title_original"],
            "title_romaji": game["title_romaji"],
            "title_english": game["title_english"],
            "type": game["type"],
            "image": game["image"],
            "release_date": format_release_date(game["release_date"]),
            "release_date_full": game["release_date"],
            "first_played": format_first_played(game["first_played"]),
            "difficulty": game["difficulty"],
        }

    if oldest_game:
        result["oldest_game"] = _build_milestone_entry(oldest_game)
    if newest_game:
        result["newest_game"] = _build_milestone_entry(newest_game)

    return result if result else None
