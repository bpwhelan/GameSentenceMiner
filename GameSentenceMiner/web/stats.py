import datetime
import json
from collections import defaultdict
from typing import List, Dict

from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.configuration import get_stats_config, logger, get_config
from GameSentenceMiner.util.games_table import GamesTable


def build_game_display_name_mapping(all_lines):
    """
    Build a mapping of game_name -> display_name (title_original if available).

    This centralizes the logic for converting OBS scene names to clean game titles
    for display in charts and statistics.

    Args:
        all_lines: List of GameLinesTable records

    Returns:
        dict: Mapping of game_name to display_name (title_original from games table)
    """
    game_name_to_display = {}
    unique_game_names = set(line.game_name or "Unknown Game" for line in all_lines)

    logger.debug(
        f"Building display name mapping for {len(unique_game_names)} unique games"
    )

    for game_name in unique_game_names:
        # Find any line with this game_name to get game_id
        sample_line = next(
            (
                line
                for line in all_lines
                if (line.game_name or "Unknown Game") == game_name
            ),
            None,
        )
        if sample_line:
            game_metadata = GamesTable.get_by_game_line(sample_line)
            if game_metadata and game_metadata.title_original:
                game_name_to_display[game_name] = game_metadata.title_original
                logger.debug(
                    f"Mapped '{game_name}' -> '{game_metadata.title_original}'"
                )
            else:
                game_name_to_display[game_name] = game_name
                logger.debug(f"No metadata for '{game_name}', using original name")

    return game_name_to_display


def is_kanji(char):
    """Check if a character is a kanji (CJK Unified Ideographs)."""
    # Validate input is a single character
    if not isinstance(char, str) or len(char) != 1:
        logger.warning(
            f"is_kanji() received invalid input: {repr(char)} (type: {type(char)}, length: {len(char) if isinstance(char, str) else 'N/A'})"
        )
        return False

    try:
        code_point = ord(char)
        # CJK Unified Ideographs (most common kanji range)
        # U+4E00-U+9FAF covers the main kanji characters
        return 0x4E00 <= code_point <= 0x9FAF
    except (TypeError, ValueError) as e:
        logger.warning(f"is_kanji() failed to process character {repr(char)}: {e}")
        return False


def interpolate_color(color1, color2, factor):
    """Interpolate between two hex colors."""

    # Convert hex to RGB
    def hex_to_rgb(hex_color):
        hex_color = hex_color.lstrip("#")
        return tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))

    # Convert RGB to hex
    def rgb_to_hex(rgb):
        return f"#{int(rgb[0]):02x}{int(rgb[1]):02x}{int(rgb[2]):02x}"

    rgb1 = hex_to_rgb(color1)
    rgb2 = hex_to_rgb(color2)

    # Interpolate each channel
    rgb_result = tuple(rgb1[i] + factor * (rgb2[i] - rgb1[i]) for i in range(3))

    return rgb_to_hex(rgb_result)


def get_gradient_color(frequency, max_frequency):
    """Get color from gradient based on frequency."""
    if max_frequency == 0:
        return "#ebedf0"  # Default color for no encounters

    # kanji with 300+ encounters should always get cyan color cause i think u should know them
    if frequency > 300:
        return "#2ee6e0"

    # Normalize frequency to 0-1 range with square root transformation
    # This creates a smoother, more visually pleasing gradient by spreading
    # out the lower frequencies (since kanji frequency follows Zipf's law)
    ratio = (frequency / max_frequency) ** 0.5

    # Define gradient colors: least seen → most seen
    # #e6342e (red) → #e6dc2e (yellow) → #3be62f (green) → #2ee6e0 (cyan)
    colors = ["#e6342e", "#e6dc2e", "#3be62f", "#2ee6e0"]

    if ratio == 0:
        return "#ebedf0"  # No encounters

    # Scale ratio to fit the 3 gradient segments
    scaled_ratio = ratio * (len(colors) - 1)
    segment = int(scaled_ratio)
    local_ratio = scaled_ratio - segment

    # Clamp segment to valid range
    if segment >= len(colors) - 1:
        return colors[-1]

    # Interpolate between adjacent colors
    return interpolate_color(colors[segment], colors[segment + 1], local_ratio)


def calculate_kanji_frequency(all_lines):
    """Calculate frequency of kanji characters across all lines with gradient coloring."""
    kanji_count = defaultdict(int)

    for line in all_lines:
        if line.line_text:
            # Ensure line_text is a string and handle any encoding issues
            try:
                line_text = str(line.line_text) if line.line_text else ""
                for char in line_text:
                    if is_kanji(char):
                        kanji_count[char] += 1
            except Exception as e:
                logger.warning(
                    f"Error processing line text for kanji frequency: {repr(line.line_text)}, error: {e}"
                )
                continue

    if not kanji_count:
        return {"kanji_data": [], "unique_count": 0}

    # Find max frequency for gradient calculation
    max_frequency = max(kanji_count.values())

    # Sort kanji by frequency (most frequent first)
    sorted_kanji = sorted(kanji_count.items(), key=lambda x: x[1], reverse=True)

    # Add gradient colors to each kanji
    kanji_data = []
    for kanji, count in sorted_kanji:
        color = get_gradient_color(count, max_frequency)
        kanji_data.append({"kanji": kanji, "frequency": count, "color": color})

    return {
        "kanji_data": kanji_data,
        "unique_count": len(sorted_kanji),
        "max_frequency": max_frequency,
    }


def calculate_heatmap_data(all_lines, filter_year=None):
    """Calculate heatmap data for reading activity."""
    heatmap_data = defaultdict(lambda: defaultdict(int))

    for line in all_lines:
        date_obj = datetime.date.fromtimestamp(float(line.timestamp))
        year = str(date_obj.year)

        # Filter by year if specified
        if filter_year and year != filter_year:
            continue

        date_str = date_obj.strftime("%Y-%m-%d")
        char_count = len(line.line_text) if line.line_text else 0
        heatmap_data[year][date_str] += char_count

    return dict(heatmap_data)


def calculate_mining_heatmap_data(all_lines, filter_year=None):
    """
    Calculate heatmap data for mining activity.
    Counts lines where screenshot_in_anki OR audio_in_anki is not empty.
    """
    heatmap_data = defaultdict(lambda: defaultdict(int))

    for line in all_lines:
        # Check if line has been mined (either screenshot or audio in Anki)
        has_screenshot = line.screenshot_in_anki and line.screenshot_in_anki.strip()
        has_audio = line.audio_in_anki and line.audio_in_anki.strip()

        if not (has_screenshot or has_audio):
            continue  # Skip lines that haven't been mined

        date_obj = datetime.date.fromtimestamp(float(line.timestamp))
        year = str(date_obj.year)

        # Filter by year if specified
        if filter_year and year != filter_year:
            continue

        date_str = date_obj.strftime("%Y-%m-%d")
        heatmap_data[year][date_str] += 1  # Count mined lines, not characters

    return dict(heatmap_data)


def calculate_reading_speed_heatmap_data(all_lines, filter_year=None):
    """
    Calculate daily average reading speed (chars/hour) for heatmap visualization.
    Returns both heatmap data and maximum reading speed for percentage-based coloring.
    
    Args:
        all_lines: List of GameLinesTable records
        filter_year: Optional year filter (string)
    
    Returns:
        tuple: (heatmap_data dict, max_reading_speed float)
            heatmap_data format: {year: {date: speed_in_chars_per_hour}}
    """
    # Group lines by date
    daily_data = defaultdict(lambda: {"chars": 0, "timestamps": []})
    
    for line in all_lines:
        date_obj = datetime.date.fromtimestamp(float(line.timestamp))
        year = str(date_obj.year)
        
        # Filter by year if specified
        if filter_year and year != filter_year:
            continue
        
        date_str = date_obj.strftime("%Y-%m-%d")
        char_count = len(line.line_text) if line.line_text else 0
        
        daily_data[date_str]["chars"] += char_count
        daily_data[date_str]["timestamps"].append(float(line.timestamp))
    
    # Calculate reading speed for each day
    heatmap_data = defaultdict(lambda: defaultdict(int))
    max_speed = 0
    
    for date_str, data in daily_data.items():
        if len(data["timestamps"]) >= 2 and data["chars"] > 0:
            # Calculate actual reading time for this day
            reading_time_seconds = calculate_actual_reading_time(data["timestamps"])
            reading_time_hours = reading_time_seconds / 3600
            
            if reading_time_hours > 0:
                # Calculate speed (chars per hour)
                speed = int(data["chars"] / reading_time_hours)
                
                # Extract year from date string
                year = date_str.split("-")[0]
                heatmap_data[year][date_str] = speed
                
                # Track maximum speed
                max_speed = max(max_speed, speed)
    
    return dict(heatmap_data), max_speed


def calculate_total_chars_per_game(all_lines, game_name_to_display=None):
    """Calculate total characters read per game."""
    if game_name_to_display is None:
        # Fallback for backward compatibility
        game_name_to_display = build_game_display_name_mapping(all_lines)

    game_data = defaultdict(lambda: {"total_chars": 0, "first_time": None})

    for line in all_lines:
        game_name = line.game_name or "Unknown Game"
        display_name = game_name_to_display.get(game_name, game_name)
        timestamp = float(line.timestamp)
        char_count = len(line.line_text) if line.line_text else 0

        game_data[display_name]["total_chars"] += char_count

        if game_data[display_name]["first_time"] is None:
            game_data[display_name]["first_time"] = timestamp

    # Sort by first appearance time and filter out games with no characters
    char_data = []
    for game, data in game_data.items():
        if data["total_chars"] > 0:
            char_data.append((game, data["total_chars"], data["first_time"]))

    # Sort by first appearance time
    char_data.sort(key=lambda x: x[2])

    return {
        "labels": [item[0] for item in char_data],
        "totals": [item[1] for item in char_data],
    }


def calculate_reading_time_per_game(all_lines, game_name_to_display=None):
    """Calculate total reading time per game in hours using AFK timer logic."""
    if game_name_to_display is None:
        # Fallback for backward compatibility
        game_name_to_display = build_game_display_name_mapping(all_lines)

    game_data = defaultdict(lambda: {"timestamps": [], "first_time": None})

    for line in all_lines:
        game_name = line.game_name or "Unknown Game"
        display_name = game_name_to_display.get(game_name, game_name)
        timestamp = float(line.timestamp)

        game_data[display_name]["timestamps"].append(timestamp)
        if game_data[display_name]["first_time"] is None:
            game_data[display_name]["first_time"] = timestamp

    # Calculate actual reading time for each game
    time_data = []
    for game, data in game_data.items():
        if len(data["timestamps"]) >= 2:
            # Use actual reading time calculation
            reading_time_seconds = calculate_actual_reading_time(data["timestamps"])
            hours = reading_time_seconds / 3600  # Convert to hours
            if hours > 0:
                time_data.append((game, hours, data["first_time"]))

    # Sort by first appearance time
    time_data.sort(key=lambda x: x[2])

    return {
        "labels": [item[0] for item in time_data],
        "totals": [
            round(item[1], 2) for item in time_data
        ],  # Round to 2 decimals for hours
    }


def calculate_reading_speed_per_game(all_lines, game_name_to_display=None):
    """Calculate average reading speed per game (chars/hour) using AFK timer logic."""
    if game_name_to_display is None:
        # Fallback for backward compatibility
        game_name_to_display = build_game_display_name_mapping(all_lines)

    game_data = defaultdict(lambda: {"chars": 0, "timestamps": [], "first_time": None})

    for line in all_lines:
        game_name = line.game_name or "Unknown Game"
        display_name = game_name_to_display.get(game_name, game_name)
        timestamp = float(line.timestamp)
        char_count = len(line.line_text) if line.line_text else 0

        game_data[display_name]["chars"] += char_count
        game_data[display_name]["timestamps"].append(timestamp)

        if game_data[display_name]["first_time"] is None:
            game_data[display_name]["first_time"] = timestamp

    # Calculate speeds using actual reading time
    speed_data = []
    for game, data in game_data.items():
        if len(data["timestamps"]) >= 2 and data["chars"] > 0:
            # Use actual reading time calculation
            reading_time_seconds = calculate_actual_reading_time(data["timestamps"])
            hours = reading_time_seconds / 3600  # Convert to hours
            if hours > 0:
                speed = data["chars"] / hours
                speed_data.append((game, speed, data["first_time"]))

    # Sort by first appearance time
    speed_data.sort(key=lambda x: x[2])

    return {
        "labels": [item[0] for item in speed_data],
        "totals": [
            round(item[1], 0) for item in speed_data
        ],  # Round to whole numbers for chars/hour
    }


def generate_game_colors(game_count):
    """Generate visually distinct colors for games using HSL color space."""
    colors = []

    # Predefined set of good colors for the first few games
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

    # Use predefined colors first
    for i in range(min(game_count, len(predefined_colors))):
        colors.append(predefined_colors[i])

    # Generate additional colors using HSL if needed
    if game_count > len(predefined_colors):
        remaining = game_count - len(predefined_colors)
        for i in range(remaining):
            # Distribute hue evenly across the color wheel
            hue = (i * 360 / remaining) % 360
            # Use varied saturation and lightness for visual distinction
            saturation = 65 + (i % 3) * 10  # 65%, 75%, 85%
            lightness = 45 + (i % 2) * 10  # 45%, 55%

            # Convert HSL to hex
            colors.append(f"hsl({hue:.0f}, {saturation}%, {lightness}%)")

    return colors


def format_large_number(num):
    """Format large numbers with appropriate units (K for thousands, M for millions)."""
    if num >= 1000000:
        return f"{num / 1000000:.1f}M"
    elif num >= 1000:
        return f"{num / 1000:.1f}K"
    else:
        return str(int(num))


def calculate_actual_reading_time(timestamps, afk_timer_seconds=None):
    """
    Calculate actual reading time using AFK timer logic.

    Args:
        timestamps: List of timestamps (as floats)
        afk_timer_seconds: Maximum time between entries to count as active reading.
                          If None, uses config value. Defaults to 120 seconds (2 minutes).

    Returns:
        float: Actual reading time in seconds
    """
    if not timestamps or len(timestamps) < 2:
        return 0.0

    if afk_timer_seconds is None:
        afk_timer_seconds = get_stats_config().afk_timer_seconds

    # Sort timestamps to ensure chronological order
    sorted_timestamps = sorted(timestamps)
    total_reading_time = 0.0

    # Calculate time between consecutive entries
    for i in range(1, len(sorted_timestamps)):
        time_gap = sorted_timestamps[i] - sorted_timestamps[i - 1]

        # Cap the gap at AFK timer limit
        if time_gap > afk_timer_seconds:
            total_reading_time += afk_timer_seconds
        else:
            total_reading_time += time_gap

    return total_reading_time


def calculate_daily_reading_time(lines):
    """
    Calculate actual reading time per day using AFK timer logic.

    Args:
        lines: List of game lines

    Returns:
        dict: Dictionary mapping date strings to reading time in hours
    """
    daily_timestamps = defaultdict(list)

    # Group timestamps by day
    for line in lines:
        date_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime(
            "%Y-%m-%d"
        )
        daily_timestamps[date_str].append(float(line.timestamp))

    # Calculate reading time for each day
    daily_reading_time = {}
    for date_str, timestamps in daily_timestamps.items():
        if len(timestamps) >= 2:
            reading_time_seconds = calculate_actual_reading_time(timestamps)
            daily_reading_time[date_str] = (
                reading_time_seconds / 3600
            )  # Convert to hours
        else:
            daily_reading_time[date_str] = 0.0

    return daily_reading_time


def calculate_time_based_streak(lines, streak_requirement_hours=None):
    """
    Calculate reading streak based on time requirements rather than daily activity.

    Args:
        lines: List of game lines
        streak_requirement_hours: Minimum hours of reading per day to maintain streak.
                                If None, uses config value. Defaults to 1.0.

    Returns:
        int: Current streak in days
    """
    if streak_requirement_hours is None:
        # Prefer stats_config if available, fallback to config.advanced, then 1.0
        try:
            streak_requirement_hours = get_stats_config().streak_requirement_hours
        except AttributeError:
            streak_requirement_hours = getattr(
                get_config().advanced, "streak_requirement_hours", 1.0
            )
    # Add debug logging
    logger.debug(
        f"Calculating streak with requirement: {streak_requirement_hours} hours"
    )
    logger.debug(f"Processing {len(lines)} lines for streak calculation")

    # Calculate daily reading time
    daily_reading_time = calculate_daily_reading_time(lines)

    if not daily_reading_time:
        logger.debug("No daily reading time data available")
        return 0

    logger.debug(
        f"Daily reading time data: {dict(list(daily_reading_time.items())[:5])}"
    )  # Show first 5 days

    # Check streak from today backwards
    today = datetime.date.today()
    current_streak = 0

    check_date = today
    consecutive_days_checked = 0
    while consecutive_days_checked < 365:  # Check max 365 days back
        date_str = check_date.strftime("%Y-%m-%d")
        reading_hours = daily_reading_time.get(date_str, 0.0)

        logger.debug(
            f"Checking {date_str}: {reading_hours:.4f} hours vs requirement {streak_requirement_hours}"
        )

        if reading_hours >= streak_requirement_hours:
            current_streak += 1
            logger.debug(
                f"Day {date_str} qualifies for streak. Current streak: {current_streak}"
            )
        else:
            logger.debug(
                f"Day {date_str} breaks streak. Reading hours {reading_hours:.4f} < requirement {streak_requirement_hours}"
            )
            break

        check_date -= datetime.timedelta(days=1)
        consecutive_days_checked += 1

    logger.debug(f"Final calculated streak: {current_streak} days")
    return current_streak


def format_time_human_readable(hours):
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


def calculate_current_game_stats(all_lines):
    """Calculate statistics for the currently active game (most recent entry)."""
    if not all_lines:
        return None

    # Sort lines by timestamp to find the most recent
    sorted_lines = sorted(all_lines, key=lambda line: float(line.timestamp))

    # Get the current game line (most recent entry)
    current_game_line = sorted_lines[-1]
    current_game_name = current_game_line.game_name or "Unknown Game"

    # Filter lines for current game
    current_game_lines = [
        line
        for line in all_lines
        if (line.game_name or "Unknown Game") == current_game_name
    ]

    if not current_game_lines:
        return None

    # Fetch game metadata from games table using game_id relationship
    logger.debug(
        f"Current game line: game_name='{current_game_line.game_name}', game_id='{current_game_line.game_id}'"
    )
    game_metadata = GamesTable.get_by_game_line(current_game_line)
    if game_metadata:
        logger.debug(
            f"Found game metadata: id={game_metadata.id}, title_original='{game_metadata.title_original}', deck_id={game_metadata.deck_id}, has_image={bool(game_metadata.image)}"
        )
    else:
        logger.debug(f"No game metadata found for game_name='{current_game_name}'")

    # Calculate basic statistics
    total_characters = sum(
        len(line.line_text) if line.line_text else 0 for line in current_game_lines
    )
    total_sentences = len(current_game_lines)

    # Calculate actual reading time using AFK timer
    timestamps = [float(line.timestamp) for line in current_game_lines]
    min_timestamp = min(timestamps)
    max_timestamp = max(timestamps)
    total_time_seconds = calculate_actual_reading_time(timestamps)
    total_time_hours = total_time_seconds / 3600

    # Calculate reading speed (with edge case handling)
    reading_speed = (
        int(total_characters / total_time_hours) if total_time_hours > 0 else 0
    )

    # Calculate sessions (gaps of more than session_gap_seconds = new session)
    sorted_timestamps = sorted(timestamps)
    sessions = 1
    session_gap = get_stats_config().session_gap_seconds
    for i in range(1, len(sorted_timestamps)):
        time_gap = sorted_timestamps[i] - sorted_timestamps[i - 1]
        if time_gap > session_gap:
            sessions += 1

    # Calculate daily activity for progress trend
    daily_activity = defaultdict(int)
    for line in current_game_lines:
        date_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime(
            "%Y-%m-%d"
        )
        daily_activity[date_str] += len(line.line_text) if line.line_text else 0

    # Calculate monthly progress (last 30 days)
    today = datetime.date.today()
    monthly_chars = 0
    for i in range(30):
        date = today - datetime.timedelta(days=i)
        date_str = date.strftime("%Y-%m-%d")
        monthly_chars += daily_activity.get(date_str, 0)

    # Calculate reading streak using time-based requirements
    current_streak = calculate_time_based_streak(current_game_lines)

    # Calculate progress percentage if game metadata is available
    # game_metadata.character_count should contain jiten.moe's total character count
    progress_percentage = 0
    if (
        game_metadata
        and game_metadata.character_count
        and game_metadata.character_count > 0
    ):
        progress_percentage = min(
            100, (total_characters / game_metadata.character_count) * 100
        )
        logger.debug(
            f"Game progress: {current_game_name}, Mined: {total_characters}, Total: {game_metadata.character_count}, Progress: {progress_percentage:.1f}%"
        )
    else:
        logger.debug(
            f"Game progress: {current_game_name}, No character_count available (metadata={bool(game_metadata)}, count={game_metadata.character_count if game_metadata else 'N/A'})"
        )

    # Build result dictionary with game metadata
    result = {
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
        "current_streak": current_streak,
        "first_date": datetime.date.fromtimestamp(min_timestamp).strftime("%Y-%m-%d"),
        "last_date": datetime.date.fromtimestamp(max_timestamp).strftime("%Y-%m-%d"),
        "daily_activity": dict(daily_activity),
        "progress_percentage": round(progress_percentage, 1),
    }

    # Add game metadata if available
    if game_metadata:
        result["title_original"] = game_metadata.title_original or ""
        result["title_romaji"] = game_metadata.title_romaji or ""
        result["title_english"] = game_metadata.title_english or ""
        result["type"] = game_metadata.type or ""
        result["description"] = game_metadata.description or ""
        result["image"] = game_metadata.image or ""
        result["game_character_count"] = (
            game_metadata.character_count or 0
        )  # Jiten.moe total
        result["links"] = game_metadata.links or []  # Add links array
        result["completed"] = game_metadata.completed or False  # Add completion status

        # Debug logging for image data
        logger.debug(
            f"Game metadata for '{current_game_name}': has_image={bool(game_metadata.image)}, image_length={len(game_metadata.image) if game_metadata.image else 0}"
        )
    else:
        result["title_original"] = ""
        result["title_romaji"] = ""
        result["title_english"] = ""
        result["type"] = ""
        result["description"] = ""
        result["image"] = ""
        result["game_character_count"] = 0  # No jiten data available
        result["links"] = []  # Empty links array when no metadata
        logger.debug(f"No game metadata found for '{current_game_name}'")

    return result


def calculate_average_daily_reading_time(all_lines):
    """
    Calculate average reading time per day based only on days with reading activity.

    Args:
        all_lines: List of game lines

    Returns:
        float: Average reading time in hours per active day, 0 if no active days
    """
    if not all_lines:
        return 0.0

    # Calculate daily reading time using existing function
    daily_reading_time = calculate_daily_reading_time(all_lines)

    if not daily_reading_time:
        return 0.0

    # Count only days with reading activity > 0
    active_days = [
        day_hours for day_hours in daily_reading_time.values() if day_hours > 0
    ]

    if not active_days:
        return 0.0

    # Calculate average: total hours / number of active days
    total_hours = sum(active_days)
    average_hours = total_hours / len(active_days)

    return average_hours


def calculate_hourly_activity(all_lines):
    """
    Calculate reading activity aggregated by hour of day (0-23).
    Returns character count for each hour across all days.
    """
    if not all_lines:
        return [0] * 24

    hourly_chars = [0] * 24

    for line in all_lines:
        # Get hour from timestamp (0-23)
        hour = datetime.datetime.fromtimestamp(float(line.timestamp)).hour
        char_count = len(line.line_text) if line.line_text else 0
        hourly_chars[hour] += char_count

    return hourly_chars


def calculate_hourly_reading_speed(all_lines):
    """
    Calculate average reading speed (chars/hour) aggregated by hour of day (0-23).
    Returns average reading speed for each hour across all days.
    """
    if not all_lines:
        return [0] * 24

    # Group lines by hour and collect timestamps for each hour
    hourly_data = defaultdict(lambda: {"chars": 0, "timestamps": []})

    for line in all_lines:
        hour = datetime.datetime.fromtimestamp(float(line.timestamp)).hour
        char_count = len(line.line_text) if line.line_text else 0

        hourly_data[hour]["chars"] += char_count
        hourly_data[hour]["timestamps"].append(float(line.timestamp))

    # Calculate average reading speed for each hour
    hourly_speeds = [0] * 24

    for hour in range(24):
        if hour in hourly_data and len(hourly_data[hour]["timestamps"]) >= 2:
            chars = hourly_data[hour]["chars"]
            timestamps = hourly_data[hour]["timestamps"]

            # Calculate actual reading time for this hour across all days
            reading_time_seconds = calculate_actual_reading_time(timestamps)
            reading_time_hours = reading_time_seconds / 3600

            # Calculate speed (chars per hour)
            if reading_time_hours > 0:
                hourly_speeds[hour] = int(chars / reading_time_hours)

    return hourly_speeds


def calculate_peak_daily_stats(all_lines):
    """
    Calculate peak daily statistics: most chars read in a day and most hours studied in a day.

    Args:
        all_lines: List of game lines

    Returns:
        dict: Dictionary containing max_daily_chars and max_daily_hours
    """
    if not all_lines:
        return {"max_daily_chars": 0, "max_daily_hours": 0.0}

    # Calculate daily reading time using existing function
    daily_reading_time = calculate_daily_reading_time(all_lines)

    # Calculate daily character counts
    daily_chars = defaultdict(int)
    for line in all_lines:
        date_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime(
            "%Y-%m-%d"
        )
        char_count = len(line.line_text) if line.line_text else 0
        daily_chars[date_str] += char_count

    # Find maximums
    max_daily_chars = max(daily_chars.values()) if daily_chars else 0
    max_daily_hours = max(daily_reading_time.values()) if daily_reading_time else 0.0

    return {"max_daily_chars": max_daily_chars, "max_daily_hours": max_daily_hours}


def calculate_peak_session_stats(all_lines):
    """
    Calculate peak session statistics: longest session and most chars in a session.

    Args:
        all_lines: List of game lines

    Returns:
        dict: Dictionary containing longest_session_hours and max_session_chars
    """
    if not all_lines:
        return {"longest_session_hours": 0.0, "max_session_chars": 0}

    # Sort lines by timestamp
    sorted_lines = sorted(all_lines, key=lambda line: float(line.timestamp))

    # Get session gap from config
    session_gap = get_stats_config().session_gap_seconds

    # Group lines into sessions
    sessions = []
    current_session = []

    for line in sorted_lines:
        if not current_session:
            current_session = [line]
        else:
            # Check if this line belongs to the current session
            time_gap = float(line.timestamp) - float(current_session[-1].timestamp)
            if time_gap <= session_gap:
                current_session.append(line)
            else:
                # Start a new session
                if current_session:
                    sessions.append(current_session)
                current_session = [line]

    # Don't forget the last session
    if current_session:
        sessions.append(current_session)

    # Calculate session statistics
    longest_session_hours = 0.0
    max_session_chars = 0

    for session in sessions:
        if len(session) >= 2:
            # Calculate session duration using actual reading time
            timestamps = [float(line.timestamp) for line in session]
            session_time_seconds = calculate_actual_reading_time(timestamps)
            session_hours = session_time_seconds / 3600

            # Calculate session character count
            session_chars = sum(
                len(line.line_text) if line.line_text else 0 for line in session
            )

            # Update maximums
            longest_session_hours = max(longest_session_hours, session_hours)
            max_session_chars = max(max_session_chars, session_chars)
        elif len(session) == 1:
            # Single line session - count characters but no time
            session_chars = len(session[0].line_text) if session[0].line_text else 0
            max_session_chars = max(max_session_chars, session_chars)

    return {
        "longest_session_hours": longest_session_hours,
        "max_session_chars": max_session_chars,
    }


def calculate_game_milestones(all_lines=None):
    """
    Calculate oldest and newest games by release year from the games table.
    Returns games with earliest and latest release dates from all games in the database.

    Args:
        all_lines: Unused parameter (kept for API compatibility)

    Returns:
        dict: Dictionary containing oldest_game and newest_game data, or None if no games with release dates
    """
    from GameSentenceMiner.util.games_table import GamesTable

    # Get all games from the games table
    all_games = GamesTable.all()

    if not all_games:
        logger.debug("[MILESTONES] No games found in games table")
        return None

    logger.debug(f"[MILESTONES] Found {len(all_games)} total games in database")

    # Filter games that have valid release dates
    games_with_dates = []

    for game in all_games:
        if game.release_date and game.release_date.strip():
            logger.debug(
                f"[MILESTONES] Adding game: {game.title_original} (release: {game.release_date})"
            )

            # Get first played date for this game (if any)
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
        logger.debug("[MILESTONES] No games with release dates found")
        return None

    logger.debug(f"[MILESTONES] Found {len(games_with_dates)} games with release dates")

    # Sort by release date to find oldest and newest
    # Parse release dates for sorting (handle ISO format: "2009-10-15T00:00:00")
    def parse_release_date(game):
        try:
            # Extract just the date part (YYYY-MM-DD)
            date_str = game["release_date"].split("T")[0]
            return date_str
        except:
            return "9999-12-31"  # Put invalid dates at the end

    games_with_dates.sort(key=parse_release_date)

    oldest_game = games_with_dates[0] if games_with_dates else None
    newest_game = games_with_dates[-1] if games_with_dates else None

    # Ensure we don't return the same game for both oldest and newest if we have multiple games
    if (
        len(games_with_dates) > 1
        and oldest_game
        and newest_game
        and oldest_game["id"] == newest_game["id"]
    ):
        logger.warning(
            f"[MILESTONES] Same game detected for oldest and newest: {oldest_game['title_original']}"
        )
        # This shouldn't happen, but just in case
        newest_game = games_with_dates[-2] if len(games_with_dates) > 1 else oldest_game

    logger.debug(
        f"[MILESTONES] Oldest: {oldest_game['title_original'] if oldest_game else 'None'} ({parse_release_date(oldest_game) if oldest_game else 'None'})"
    )
    logger.debug(
        f"[MILESTONES] Newest: {newest_game['title_original'] if newest_game else 'None'} ({parse_release_date(newest_game) if newest_game else 'None'})"
    )

    # Format the release dates for display (extract date in YYYY-MM-DD format)
    def format_release_date(release_date_str):
        try:
            # Extract date part from "2009-10-15T00:00:00" -> "2009-10-15"
            return release_date_str.split("T")[0]
        except:
            return "Unknown"

    # Format first played dates
    def format_first_played(timestamp):
        if timestamp:
            return datetime.date.fromtimestamp(timestamp).strftime("%Y-%m-%d")
        return "Unknown"

    result = {}

    if oldest_game:
        result["oldest_game"] = {
            "title_original": oldest_game["title_original"],
            "title_romaji": oldest_game["title_romaji"],
            "title_english": oldest_game["title_english"],
            "type": oldest_game["type"],
            "image": oldest_game["image"],
            "release_date": format_release_date(oldest_game["release_date"]),
            "release_date_full": oldest_game["release_date"],
            "first_played": format_first_played(oldest_game["first_played"]),
            "difficulty": oldest_game["difficulty"],
        }

    if newest_game:
        result["newest_game"] = {
            "title_original": newest_game["title_original"],
            "title_romaji": newest_game["title_romaji"],
            "title_english": newest_game["title_english"],
            "type": newest_game["type"],
            "image": newest_game["image"],
            "release_date": format_release_date(newest_game["release_date"]),
            "release_date_full": newest_game["release_date"],
            "first_played": format_first_played(newest_game["first_played"]),
            "difficulty": newest_game["difficulty"],
        }

    return result if result else None


def calculate_completed_games_count():
    """
    Count the number of completed games from the games table.

    Returns:
        int: Number of games marked as completed
    """
    completed_games = GamesTable.get_all_completed()
    return len(completed_games)


def calculate_all_games_stats(all_lines):
    """Calculate aggregate statistics for all games combined."""
    if not all_lines:
        return None

    # Calculate basic statistics
    total_characters = sum(
        len(line.line_text) if line.line_text else 0 for line in all_lines
    )
    total_sentences = len(all_lines)

    # Calculate actual reading time using AFK timer
    timestamps = [float(line.timestamp) for line in all_lines]
    min_timestamp = min(timestamps)
    max_timestamp = max(timestamps)
    total_time_seconds = calculate_actual_reading_time(timestamps)
    total_time_hours = total_time_seconds / 3600

    # Calculate reading speed (with edge case handling)
    reading_speed = (
        int(total_characters / total_time_hours) if total_time_hours > 0 else 0
    )

    # Calculate sessions across all games (gaps of more than 1 hour = new session)
    sorted_timestamps = sorted(timestamps)
    sessions = 1
    session_gap = get_stats_config().session_gap_seconds
    for i in range(1, len(sorted_timestamps)):
        time_gap = sorted_timestamps[i] - sorted_timestamps[i - 1]
        if time_gap > session_gap:
            sessions += 1

    # Calculate daily activity for progress trend
    daily_activity = defaultdict(int)
    for line in all_lines:
        date_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime(
            "%Y-%m-%d"
        )
        daily_activity[date_str] += len(line.line_text) if line.line_text else 0

    # Calculate monthly progress (last 30 days)
    today = datetime.date.today()
    monthly_chars = 0
    for i in range(30):
        date = today - datetime.timedelta(days=i)
        date_str = date.strftime("%Y-%m-%d")
        monthly_chars += daily_activity.get(date_str, 0)

    # Calculate reading streak using time-based requirements
    current_streak = calculate_time_based_streak(all_lines)

    # Calculate average daily reading time
    avg_daily_time_hours = calculate_average_daily_reading_time(all_lines)

    # Count completed games from games table
    completed_games = calculate_completed_games_count()

    return {
        "total_characters": total_characters,
        "total_characters_formatted": format_large_number(total_characters),
        "total_sentences": total_sentences,
        "total_time_hours": total_time_hours,
        "total_time_formatted": format_time_human_readable(total_time_hours),
        "reading_speed": reading_speed,
        "reading_speed_formatted": format_large_number(reading_speed),
        "sessions": sessions,
        "completed_games": completed_games,
        "monthly_characters": monthly_chars,
        "monthly_characters_formatted": format_large_number(monthly_chars),
        "current_streak": current_streak,
        "avg_daily_time_hours": avg_daily_time_hours,
        "avg_daily_time_formatted": format_time_human_readable(avg_daily_time_hours),
        "first_date": datetime.date.fromtimestamp(min_timestamp).strftime("%Y-%m-%d"),
        "last_date": datetime.date.fromtimestamp(max_timestamp).strftime("%Y-%m-%d"),
        "daily_activity": dict(daily_activity),
    }


def aggregate_rollup_data(rollups: List) -> Dict:
    """
    Aggregate multiple daily rollup records into a single statistics object.

    Args:
        rollups: List of StatsRollupTable records

    Returns:
        Dictionary with aggregated statistics matching the stats API format
    """
    if not rollups:
        return {
            "total_lines": 0,
            "total_characters": 0,
            "total_sessions": 0,
            "unique_games_played": 0,
            "total_reading_time_seconds": 0.0,
            "total_active_time_seconds": 0.0,
            "average_reading_speed_chars_per_hour": 0.0,
            "peak_reading_speed_chars_per_hour": 0.0,
            "longest_session_seconds": 0.0,
            "shortest_session_seconds": 0.0,
            "average_session_seconds": 0.0,
            "max_chars_in_session": 0,
            "max_time_in_session_seconds": 0.0,
            "games_completed": 0,
            "games_started": 0,
            "anki_cards_created": 0,
            "lines_with_screenshots": 0,
            "lines_with_audio": 0,
            "lines_with_translations": 0,
            "unique_kanji_seen": 0,
            "kanji_frequency_data": {},
            "hourly_activity_data": {},
            "hourly_reading_speed_data": {},
            "game_activity_data": {},
            "games_played_ids": [],
        }

    # ADDITIVE fields - sum across all days
    total_lines = sum(r.total_lines for r in rollups)
    total_characters = sum(r.total_characters for r in rollups)
    total_sessions = sum(r.total_sessions for r in rollups)
    total_reading_time = sum(r.total_reading_time_seconds for r in rollups)
    total_active_time = sum(r.total_active_time_seconds for r in rollups)
    anki_cards_created = sum(r.anki_cards_created for r in rollups)
    lines_with_screenshots = sum(r.lines_with_screenshots for r in rollups)
    lines_with_audio = sum(r.lines_with_audio for r in rollups)
    lines_with_translations = sum(r.lines_with_translations for r in rollups)
    games_completed = sum(r.games_completed for r in rollups)

    # MAXIMUM fields - take highest value across all days
    peak_reading_speed = max(
        (r.peak_reading_speed_chars_per_hour for r in rollups), default=0.0
    )
    longest_session = max((r.longest_session_seconds for r in rollups), default=0.0)
    max_chars_in_session = max((r.max_chars_in_session for r in rollups), default=0)
    max_time_in_session = max(
        (r.max_time_in_session_seconds for r in rollups), default=0.0
    )

    # MINIMUM field - take smallest non-zero value
    shortest_session_values = [
        r.shortest_session_seconds for r in rollups if r.shortest_session_seconds > 0
    ]
    shortest_session = min(shortest_session_values) if shortest_session_values else 0.0

    # WEIGHTED AVERAGE - average reading speed weighted by active time
    if total_active_time > 0:
        weighted_speed_sum = sum(
            r.average_reading_speed_chars_per_hour * r.total_active_time_seconds
            for r in rollups
            if r.total_active_time_seconds > 0
        )
        avg_reading_speed = weighted_speed_sum / total_active_time
    else:
        avg_reading_speed = 0.0

    # WEIGHTED AVERAGE - average session duration weighted by number of sessions
    if total_sessions > 0:
        weighted_session_sum = sum(
            r.average_session_seconds * r.total_sessions
            for r in rollups
            if r.total_sessions > 0
        )
        avg_session_seconds = weighted_session_sum / total_sessions
    else:
        avg_session_seconds = 0.0

    # MERGE - Combine game IDs (union)
    all_games_played = set()
    for rollup in rollups:
        if rollup.games_played_ids:
            try:
                games_ids = (
                    json.loads(rollup.games_played_ids)
                    if isinstance(rollup.games_played_ids, str)
                    else rollup.games_played_ids
                )
                all_games_played.update(games_ids)
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    f"Failed to parse games_played_ids for rollup date {rollup.date}"
                )

    # MERGE - Combine game activity data (sum chars/time/lines per game)
    combined_game_activity = {}
    for rollup in rollups:
        if rollup.game_activity_data:
            try:
                game_data = (
                    json.loads(rollup.game_activity_data)
                    if isinstance(rollup.game_activity_data, str)
                    else rollup.game_activity_data
                )
                for game_id, activity in game_data.items():
                    if game_id in combined_game_activity:
                        combined_game_activity[game_id]["chars"] += activity.get(
                            "chars", 0
                        )
                        combined_game_activity[game_id]["time"] += activity.get(
                            "time", 0
                        )
                        combined_game_activity[game_id]["lines"] += activity.get(
                            "lines", 0
                        )
                    else:
                        combined_game_activity[game_id] = {
                            "title": activity.get("title", f"Game {game_id}"),
                            "chars": activity.get("chars", 0),
                            "time": activity.get("time", 0),
                            "lines": activity.get("lines", 0),
                        }
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    f"Failed to parse game_activity_data for rollup date {rollup.date}"
                )

    # MERGE - Combine kanji frequency data (sum frequencies)
    combined_kanji_frequency = {}
    for rollup in rollups:
        if rollup.kanji_frequency_data:
            try:
                kanji_data = (
                    json.loads(rollup.kanji_frequency_data)
                    if isinstance(rollup.kanji_frequency_data, str)
                    else rollup.kanji_frequency_data
                )
                for kanji, count in kanji_data.items():
                    combined_kanji_frequency[kanji] = (
                        combined_kanji_frequency.get(kanji, 0) + count
                    )
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    f"Failed to parse kanji_frequency_data for rollup date {rollup.date}"
                )

    # MERGE - Combine hourly activity data (sum characters per hour)
    combined_hourly_activity = {}
    for rollup in rollups:
        if rollup.hourly_activity_data:
            try:
                hourly_data = (
                    json.loads(rollup.hourly_activity_data)
                    if isinstance(rollup.hourly_activity_data, str)
                    else rollup.hourly_activity_data
                )
                for hour, chars in hourly_data.items():
                    combined_hourly_activity[hour] = (
                        combined_hourly_activity.get(hour, 0) + chars
                    )
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    f"Failed to parse hourly_activity_data for rollup date {rollup.date}"
                )

    # MERGE - Combine hourly reading speeds (average across days for each hour)
    hourly_speed_lists = defaultdict(list)
    for rollup in rollups:
        if rollup.hourly_reading_speed_data:
            try:
                speed_data = (
                    json.loads(rollup.hourly_reading_speed_data)
                    if isinstance(rollup.hourly_reading_speed_data, str)
                    else rollup.hourly_reading_speed_data
                )
                for hour, speed in speed_data.items():
                    if speed > 0:
                        hourly_speed_lists[hour].append(speed)
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    f"Failed to parse hourly_reading_speed_data for rollup date {rollup.date}"
                )

    # Average the speeds for each hour
    combined_hourly_speeds = {}
    for hour, speeds in hourly_speed_lists.items():
        combined_hourly_speeds[hour] = sum(speeds) / len(speeds) if speeds else 0

    return {
        "total_lines": total_lines,
        "total_characters": total_characters,
        "total_sessions": total_sessions,
        "unique_games_played": len(all_games_played),
        "total_reading_time_seconds": total_reading_time,
        "total_active_time_seconds": total_active_time,
        "average_reading_speed_chars_per_hour": avg_reading_speed,
        "peak_reading_speed_chars_per_hour": peak_reading_speed,
        "longest_session_seconds": longest_session,
        "shortest_session_seconds": shortest_session,
        "average_session_seconds": avg_session_seconds,
        "max_chars_in_session": max_chars_in_session,
        "max_time_in_session_seconds": max_time_in_session,
        "games_completed": games_completed,
        "games_started": len(all_games_played),
        "anki_cards_created": anki_cards_created,
        "lines_with_screenshots": lines_with_screenshots,
        "lines_with_audio": lines_with_audio,
        "lines_with_translations": lines_with_translations,
        "unique_kanji_seen": len(combined_kanji_frequency),
        "kanji_frequency_data": combined_kanji_frequency,
        "hourly_activity_data": combined_hourly_activity,
        "hourly_reading_speed_data": combined_hourly_speeds,
        "game_activity_data": combined_game_activity,
        "games_played_ids": list(all_games_played),
    }


def calculate_live_stats_for_today(today_lines: List) -> Dict:
    """
    Calculate live statistics for today using existing stats.py functions.

    Args:
        today_lines: List of GameLinesTable records for today

    Returns:
        Dictionary with today's statistics in rollup format
    """
    if not today_lines:
        return aggregate_rollup_data([])  # Return empty stats

    # Import here to avoid circular dependency
    from GameSentenceMiner.util.cron.daily_rollup import (
        analyze_sessions,
        analyze_hourly_data,
        analyze_game_activity,
        analyze_kanji_data,
    )

    # Calculate basic stats
    total_lines = len(today_lines)
    total_characters = sum(
        len(line.line_text) if line.line_text else 0 for line in today_lines
    )

    # Calculate Anki integration stats
    lines_with_screenshots = sum(
        1
        for line in today_lines
        if line.screenshot_in_anki and line.screenshot_in_anki.strip()
    )
    lines_with_audio = sum(
        1 for line in today_lines if line.audio_in_anki and line.audio_in_anki.strip()
    )
    lines_with_translations = sum(
        1 for line in today_lines if line.translation and line.translation.strip()
    )
    anki_cards = sum(
        1
        for line in today_lines
        if (line.screenshot_in_anki and line.screenshot_in_anki.strip())
        or (line.audio_in_anki and line.audio_in_anki.strip())
    )

    # Analyze sessions
    session_stats = analyze_sessions(today_lines)

    # Calculate reading speeds
    total_time_seconds = session_stats["total_time"]
    total_time_hours = total_time_seconds / 3600 if total_time_seconds > 0 else 0
    average_speed = (
        (total_characters / total_time_hours) if total_time_hours > 0 else 0.0
    )

    # Calculate peak speed (best hourly speed)
    hourly_data = analyze_hourly_data(today_lines)
    peak_speed = (
        max(hourly_data["hourly_speeds"].values())
        if hourly_data["hourly_speeds"]
        else 0.0
    )

    # Analyze game activity
    today_str = datetime.date.today().strftime("%Y-%m-%d")
    game_activity = analyze_game_activity(today_lines, today_str)

    # Analyze kanji
    kanji_data = analyze_kanji_data(today_lines)

    return {
        "total_lines": total_lines,
        "total_characters": total_characters,
        "total_sessions": session_stats["count"],
        "unique_games_played": len(game_activity["game_ids"]),
        "total_reading_time_seconds": total_time_seconds,
        "total_active_time_seconds": session_stats["active_time"],
        "average_reading_speed_chars_per_hour": average_speed,
        "peak_reading_speed_chars_per_hour": peak_speed,
        "longest_session_seconds": session_stats["longest"],
        "shortest_session_seconds": session_stats["shortest"],
        "average_session_seconds": session_stats["average"],
        "max_chars_in_session": session_stats["max_chars"],
        "max_time_in_session_seconds": session_stats["max_time"],
        "games_completed": game_activity["completed"],
        "games_started": game_activity["started"],
        "anki_cards_created": anki_cards,
        "lines_with_screenshots": lines_with_screenshots,
        "lines_with_audio": lines_with_audio,
        "lines_with_translations": lines_with_translations,
        "unique_kanji_seen": kanji_data["unique_count"],
        "kanji_frequency_data": kanji_data["frequencies"],
        "hourly_activity_data": hourly_data["hourly_activity"],
        "hourly_reading_speed_data": hourly_data["hourly_speeds"],
        "game_activity_data": game_activity["details"],
        "games_played_ids": game_activity["game_ids"],
    }


def combine_rollup_and_live_stats(rollup_stats: Dict, live_stats: Dict) -> Dict:
    """
    Combine rollup statistics with live statistics for today.

    Args:
        rollup_stats: Aggregated rollup statistics (can be None)
        live_stats: Live calculated statistics for today (can be None)

    Returns:
        Combined statistics dictionary
    """
    if not rollup_stats and not live_stats:
        return aggregate_rollup_data([])  # Return empty stats
    elif not rollup_stats:
        return live_stats
    elif not live_stats:
        return rollup_stats

    # Combine both datasets
    combined = {}

    # ADDITIVE fields - sum rollup + live
    additive_fields = [
        "total_lines",
        "total_characters",
        "total_sessions",
        "total_reading_time_seconds",
        "total_active_time_seconds",
        "games_completed",
        "anki_cards_created",
        "lines_with_screenshots",
        "lines_with_audio",
        "lines_with_translations",
    ]

    for field in additive_fields:
        combined[field] = rollup_stats.get(field, 0) + live_stats.get(field, 0)

    # MAXIMUM fields - take highest value
    max_fields = [
        "peak_reading_speed_chars_per_hour",
        "longest_session_seconds",
        "max_chars_in_session",
        "max_time_in_session_seconds",
    ]

    for field in max_fields:
        combined[field] = max(rollup_stats.get(field, 0), live_stats.get(field, 0))

    # MINIMUM field - take smallest non-zero value
    rollup_shortest = rollup_stats.get("shortest_session_seconds", 0)
    live_shortest = live_stats.get("shortest_session_seconds", 0)
    if rollup_shortest > 0 and live_shortest > 0:
        combined["shortest_session_seconds"] = min(rollup_shortest, live_shortest)
    elif rollup_shortest > 0:
        combined["shortest_session_seconds"] = rollup_shortest
    elif live_shortest > 0:
        combined["shortest_session_seconds"] = live_shortest
    else:
        combined["shortest_session_seconds"] = 0.0

    # WEIGHTED AVERAGE - average reading speed weighted by active time
    rollup_time = rollup_stats.get("total_active_time_seconds", 0)
    live_time = live_stats.get("total_active_time_seconds", 0)
    total_time = rollup_time + live_time

    if total_time > 0:
        combined["average_reading_speed_chars_per_hour"] = (
            rollup_stats.get("average_reading_speed_chars_per_hour", 0) * rollup_time
            + live_stats.get("average_reading_speed_chars_per_hour", 0) * live_time
        ) / total_time
    else:
        combined["average_reading_speed_chars_per_hour"] = 0.0

    # WEIGHTED AVERAGE - average session duration weighted by session count
    rollup_sessions = rollup_stats.get("total_sessions", 0)
    live_sessions = live_stats.get("total_sessions", 0)
    total_sessions = rollup_sessions + live_sessions

    if total_sessions > 0:
        combined["average_session_seconds"] = (
            rollup_stats.get("average_session_seconds", 0) * rollup_sessions
            + live_stats.get("average_session_seconds", 0) * live_sessions
        ) / total_sessions
    else:
        combined["average_session_seconds"] = 0.0

    # MERGE - Combine unique games (union)
    rollup_games = set(rollup_stats.get("games_played_ids", []))
    live_games = set(live_stats.get("games_played_ids", []))
    all_games = rollup_games.union(live_games)
    combined["unique_games_played"] = len(all_games)
    combined["games_played_ids"] = list(all_games)
    combined["games_started"] = len(all_games)

    # MERGE - Combine kanji frequency data (sum frequencies)
    rollup_kanji = rollup_stats.get("kanji_frequency_data", {})
    live_kanji = live_stats.get("kanji_frequency_data", {})
    combined_kanji = {}

    for kanji, count in rollup_kanji.items():
        combined_kanji[kanji] = count
    for kanji, count in live_kanji.items():
        combined_kanji[kanji] = combined_kanji.get(kanji, 0) + count

    combined["kanji_frequency_data"] = combined_kanji
    combined["unique_kanji_seen"] = len(combined_kanji)

    # MERGE - Combine hourly activity data (sum characters per hour)
    rollup_hourly = rollup_stats.get("hourly_activity_data", {})
    live_hourly = live_stats.get("hourly_activity_data", {})
    combined_hourly = {}

    for hour in set(list(rollup_hourly.keys()) + list(live_hourly.keys())):
        combined_hourly[hour] = rollup_hourly.get(hour, 0) + live_hourly.get(hour, 0)

    combined["hourly_activity_data"] = combined_hourly

    # MERGE - Combine hourly reading speed data (average)
    rollup_speeds = rollup_stats.get("hourly_reading_speed_data", {})
    live_speeds = live_stats.get("hourly_reading_speed_data", {})
    combined_speeds = {}

    for hour in set(list(rollup_speeds.keys()) + list(live_speeds.keys())):
        speeds = []
        if hour in rollup_speeds and rollup_speeds[hour] > 0:
            speeds.append(rollup_speeds[hour])
        if hour in live_speeds and live_speeds[hour] > 0:
            speeds.append(live_speeds[hour])
        combined_speeds[hour] = sum(speeds) / len(speeds) if speeds else 0

    combined["hourly_reading_speed_data"] = combined_speeds

    # MERGE - Combine game activity data (sum chars/time/lines per game)
    rollup_games_activity = rollup_stats.get("game_activity_data", {})
    live_games_activity = live_stats.get("game_activity_data", {})
    combined_games_activity = {}

    for game_id in set(
        list(rollup_games_activity.keys()) + list(live_games_activity.keys())
    ):
        rollup_activity = rollup_games_activity.get(
            game_id, {"chars": 0, "time": 0, "lines": 0}
        )
        live_activity = live_games_activity.get(
            game_id, {"chars": 0, "time": 0, "lines": 0}
        )

        combined_games_activity[game_id] = {
            "title": rollup_activity.get("title")
            or live_activity.get("title", f"Game {game_id}"),
            "chars": rollup_activity.get("chars", 0) + live_activity.get("chars", 0),
            "time": rollup_activity.get("time", 0) + live_activity.get("time", 0),
            "lines": rollup_activity.get("lines", 0) + live_activity.get("lines", 0),
        }

    combined["game_activity_data"] = combined_games_activity

    return combined
