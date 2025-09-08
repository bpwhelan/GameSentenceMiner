import datetime
from collections import defaultdict

from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.configuration import logger, get_config


def is_kanji(char):
    """Check if a character is a kanji (CJK Unified Ideographs)."""
    # Validate input is a single character
    if not isinstance(char, str) or len(char) != 1:
        logger.warning(f"is_kanji() received invalid input: {repr(char)} (type: {type(char)}, length: {len(char) if isinstance(char, str) else 'N/A'})")
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
        hex_color = hex_color.lstrip('#')
        return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))
    
    # Convert RGB to hex
    def rgb_to_hex(rgb):
        return f"#{int(rgb[0]):02x}{int(rgb[1]):02x}{int(rgb[2]):02x}"
    
    rgb1 = hex_to_rgb(color1)
    rgb2 = hex_to_rgb(color2)
    
    # Interpolate each channel
    rgb_result = tuple(
        rgb1[i] + factor * (rgb2[i] - rgb1[i])
        for i in range(3)
    )
    
    return rgb_to_hex(rgb_result)

def get_gradient_color(frequency, max_frequency):
    """Get color from gradient based on frequency."""
    if max_frequency == 0:
        return "#ebedf0"  # Default color for no encounters
    
    # kanji with 500+ encounters should always get cyan color cause i think u should know them
    if frequency > 500:
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
                logger.warning(f"Error processing line text for kanji frequency: {repr(line.line_text)}, error: {e}")
                continue
    
    if not kanji_count:
        return {
            "kanji_data": [],
            "unique_count": 0
        }
    
    # Find max frequency for gradient calculation
    max_frequency = max(kanji_count.values())
    
    # Sort kanji by frequency (most frequent first)
    sorted_kanji = sorted(kanji_count.items(), key=lambda x: x[1], reverse=True)
    
    # Add gradient colors to each kanji
    kanji_data = []
    for kanji, count in sorted_kanji:
        color = get_gradient_color(count, max_frequency)
        kanji_data.append({
            "kanji": kanji,
            "frequency": count,
            "color": color
        })
    
    return {
        "kanji_data": kanji_data,
        "unique_count": len(sorted_kanji),
        "max_frequency": max_frequency
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
            
        date_str = date_obj.strftime('%Y-%m-%d')
        char_count = len(line.line_text) if line.line_text else 0
        heatmap_data[year][date_str] += char_count
    
    return dict(heatmap_data)


def calculate_total_chars_per_game(all_lines):
    """Calculate total characters read per game."""
    game_data = defaultdict(lambda: {'total_chars': 0, 'first_time': None})
    
    for line in all_lines:
        game = line.game_name or "Unknown Game"
        timestamp = float(line.timestamp)
        char_count = len(line.line_text) if line.line_text else 0
        
        game_data[game]['total_chars'] += char_count
        
        if game_data[game]['first_time'] is None:
            game_data[game]['first_time'] = timestamp
    
    # Sort by first appearance time and filter out games with no characters
    char_data = []
    for game, data in game_data.items():
        if data['total_chars'] > 0:
            char_data.append((game, data['total_chars'], data['first_time']))
    
    # Sort by first appearance time
    char_data.sort(key=lambda x: x[2])
    
    return {
        "labels": [item[0] for item in char_data],
        "totals": [item[1] for item in char_data]
    }

def calculate_reading_time_per_game(all_lines):
    """Calculate total reading time per game in hours using AFK timer logic."""
    game_data = defaultdict(lambda: {'timestamps': [], 'first_time': None})
    
    for line in all_lines:
        game = line.game_name or "Unknown Game"
        timestamp = float(line.timestamp)
        
        game_data[game]['timestamps'].append(timestamp)
        if game_data[game]['first_time'] is None:
            game_data[game]['first_time'] = timestamp
    
    # Calculate actual reading time for each game
    time_data = []
    for game, data in game_data.items():
        if len(data['timestamps']) >= 2:
            # Use actual reading time calculation
            reading_time_seconds = calculate_actual_reading_time(data['timestamps'])
            hours = reading_time_seconds / 3600  # Convert to hours
            if hours > 0:
                time_data.append((game, hours, data['first_time']))
    
    # Sort by first appearance time
    time_data.sort(key=lambda x: x[2])
    
    return {
        "labels": [item[0] for item in time_data],
        "totals": [round(item[1], 2) for item in time_data]  # Round to 2 decimals for hours
    }

def calculate_reading_speed_per_game(all_lines):
    """Calculate average reading speed per game (chars/hour) using AFK timer logic."""
    game_data = defaultdict(lambda: {'chars': 0, 'timestamps': [], 'first_time': None})
    
    for line in all_lines:
        game = line.game_name or "Unknown Game"
        timestamp = float(line.timestamp)
        char_count = len(line.line_text) if line.line_text else 0
        
        game_data[game]['chars'] += char_count
        game_data[game]['timestamps'].append(timestamp)
        
        if game_data[game]['first_time'] is None:
            game_data[game]['first_time'] = timestamp
    
    # Calculate speeds using actual reading time
    speed_data = []
    for game, data in game_data.items():
        if len(data['timestamps']) >= 2 and data['chars'] > 0:
            # Use actual reading time calculation
            reading_time_seconds = calculate_actual_reading_time(data['timestamps'])
            hours = reading_time_seconds / 3600  # Convert to hours
            if hours > 0:
                speed = data['chars'] / hours
                speed_data.append((game, speed, data['first_time']))
    
    # Sort by first appearance time
    speed_data.sort(key=lambda x: x[2])
    
    return {
        "labels": [item[0] for item in speed_data],
        "totals": [round(item[1], 0) for item in speed_data]  # Round to whole numbers for chars/hour
    }

def generate_game_colors(game_count):
    """Generate visually distinct colors for games using HSL color space."""
    colors = []
    
    # Predefined set of good colors for the first few games
    predefined_colors = [
        '#3498db', '#e74c3c', '#2ecc71', '#f1c40f', '#9b59b6',
        '#1abc9c', '#e67e22', '#34495e', '#16a085', '#27ae60',
        '#2980b9', '#8e44ad', '#d35400', '#c0392b', '#7f8c8d'
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
            lightness = 45 + (i % 2) * 10   # 45%, 55%
            
            # Convert HSL to hex
            colors.append(f'hsl({hue:.0f}, {saturation}%, {lightness}%)')
    
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
        afk_timer_seconds = get_config().advanced.afk_timer_seconds
    
    # Sort timestamps to ensure chronological order
    sorted_timestamps = sorted(timestamps)
    total_reading_time = 0.0
    
    # Calculate time between consecutive entries
    for i in range(1, len(sorted_timestamps)):
        time_gap = sorted_timestamps[i] - sorted_timestamps[i-1]
        
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
        date_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime('%Y-%m-%d')
        daily_timestamps[date_str].append(float(line.timestamp))
    
    # Calculate reading time for each day
    daily_reading_time = {}
    for date_str, timestamps in daily_timestamps.items():
        if len(timestamps) >= 2:
            reading_time_seconds = calculate_actual_reading_time(timestamps)
            daily_reading_time[date_str] = reading_time_seconds / 3600  # Convert to hours
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
        streak_requirement_hours = getattr(get_config().advanced, 'streak_requirement_hours', 1.0)
    
    # Add debug logging
    logger.debug(f"Calculating streak with requirement: {streak_requirement_hours} hours")
    logger.debug(f"Processing {len(lines)} lines for streak calculation")
    
    # Calculate daily reading time
    daily_reading_time = calculate_daily_reading_time(lines)
    
    if not daily_reading_time:
        logger.debug("No daily reading time data available")
        return 0
    
    logger.debug(f"Daily reading time data: {dict(list(daily_reading_time.items())[:5])}")  # Show first 5 days
    
    # Check streak from today backwards
    today = datetime.date.today()
    current_streak = 0
    
    check_date = today
    consecutive_days_checked = 0
    while consecutive_days_checked < 365:  # Check max 365 days back
        date_str = check_date.strftime('%Y-%m-%d')
        reading_hours = daily_reading_time.get(date_str, 0.0)
        
        logger.debug(f"Checking {date_str}: {reading_hours:.4f} hours vs requirement {streak_requirement_hours}")
        
        if reading_hours >= streak_requirement_hours:
            current_streak += 1
            logger.debug(f"Day {date_str} qualifies for streak. Current streak: {current_streak}")
        else:
            logger.debug(f"Day {date_str} breaks streak. Reading hours {reading_hours:.4f} < requirement {streak_requirement_hours}")
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
    
    # Get the current game (game with most recent entry)
    current_game_name = sorted_lines[-1].game_name or "Unknown Game"
    
    # Filter lines for current game
    current_game_lines = [line for line in all_lines if (line.game_name or "Unknown Game") == current_game_name]
    
    if not current_game_lines:
        return None
    
    # Calculate basic statistics
    total_characters = sum(len(line.line_text) if line.line_text else 0 for line in current_game_lines)
    total_sentences = len(current_game_lines)
    
    # Calculate actual reading time using AFK timer
    timestamps = [float(line.timestamp) for line in current_game_lines]
    min_timestamp = min(timestamps)
    max_timestamp = max(timestamps)
    total_time_seconds = calculate_actual_reading_time(timestamps)
    total_time_hours = total_time_seconds / 3600
    
    # Calculate reading speed (with edge case handling)
    reading_speed = int(total_characters / total_time_hours) if total_time_hours > 0 else 0
    
    # Calculate sessions (gaps of more than session_gap_seconds = new session)
    sorted_timestamps = sorted(timestamps)
    sessions = 1
    for i in range(1, len(sorted_timestamps)):
        time_gap = sorted_timestamps[i] - sorted_timestamps[i-1]
        if time_gap > get_config().advanced.session_gap_seconds:
            sessions += 1
    
    # Calculate daily activity for progress trend
    daily_activity = defaultdict(int)
    for line in current_game_lines:
        date_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime('%Y-%m-%d')
        daily_activity[date_str] += len(line.line_text) if line.line_text else 0
    
    # Calculate monthly progress (last 30 days)
    today = datetime.date.today()
    monthly_chars = 0
    for i in range(30):
        date = today - datetime.timedelta(days=i)
        date_str = date.strftime('%Y-%m-%d')
        monthly_chars += daily_activity.get(date_str, 0)
    
    # Calculate reading streak using time-based requirements
    current_streak = calculate_time_based_streak(current_game_lines)
    
    return {
        'game_name': current_game_name,
        'total_characters': total_characters,
        'total_characters_formatted': format_large_number(total_characters),
        'total_sentences': total_sentences,
        'total_time_hours': total_time_hours,
        'total_time_formatted': format_time_human_readable(total_time_hours),
        'reading_speed': reading_speed,
        'reading_speed_formatted': format_large_number(reading_speed),
        'sessions': sessions,
        'monthly_characters': monthly_chars,
        'monthly_characters_formatted': format_large_number(monthly_chars),
        'current_streak': current_streak,
        'first_date': datetime.date.fromtimestamp(min_timestamp).strftime('%Y-%m-%d'),
        'last_date': datetime.date.fromtimestamp(max_timestamp).strftime('%Y-%m-%d'),
        'daily_activity': dict(daily_activity)
    }

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
    active_days = [day_hours for day_hours in daily_reading_time.values() if day_hours > 0]
    
    if not active_days:
        return 0.0
    
    # Calculate average: total hours / number of active days
    total_hours = sum(active_days)
    average_hours = total_hours / len(active_days)
    
    return average_hours

def calculate_all_games_stats(all_lines):
    """Calculate aggregate statistics for all games combined."""
    if not all_lines:
        return None
    
    # Calculate basic statistics
    total_characters = sum(len(line.line_text) if line.line_text else 0 for line in all_lines)
    total_sentences = len(all_lines)
    
    # Calculate actual reading time using AFK timer
    timestamps = [float(line.timestamp) for line in all_lines]
    min_timestamp = min(timestamps)
    max_timestamp = max(timestamps)
    total_time_seconds = calculate_actual_reading_time(timestamps)
    total_time_hours = total_time_seconds / 3600
    
    # Calculate reading speed (with edge case handling)
    reading_speed = int(total_characters / total_time_hours) if total_time_hours > 0 else 0
    
    # Calculate sessions across all games (gaps of more than 1 hour = new session)
    sorted_timestamps = sorted(timestamps)
    sessions = 1
    for i in range(1, len(sorted_timestamps)):
        time_gap = sorted_timestamps[i] - sorted_timestamps[i-1]
        if time_gap > 3600:  # 1 hour gap
            sessions += 1
    
    # Calculate daily activity for progress trend
    daily_activity = defaultdict(int)
    for line in all_lines:
        date_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime('%Y-%m-%d')
        daily_activity[date_str] += len(line.line_text) if line.line_text else 0
    
    # Calculate monthly progress (last 30 days)
    today = datetime.date.today()
    monthly_chars = 0
    for i in range(30):
        date = today - datetime.timedelta(days=i)
        date_str = date.strftime('%Y-%m-%d')
        monthly_chars += daily_activity.get(date_str, 0)
    
    # Calculate reading streak using time-based requirements
    current_streak = calculate_time_based_streak(all_lines)
    
    # Calculate average daily reading time
    avg_daily_time_hours = calculate_average_daily_reading_time(all_lines)
    
    # Count unique games
    unique_games = len(set(line.game_name or "Unknown Game" for line in all_lines))
    
    return {
        'total_characters': total_characters,
        'total_characters_formatted': format_large_number(total_characters),
        'total_sentences': total_sentences,
        'total_time_hours': total_time_hours,
        'total_time_formatted': format_time_human_readable(total_time_hours),
        'reading_speed': reading_speed,
        'reading_speed_formatted': format_large_number(reading_speed),
        'sessions': sessions,
        'unique_games': unique_games,
        'monthly_characters': monthly_chars,
        'monthly_characters_formatted': format_large_number(monthly_chars),
        'current_streak': current_streak,
        'avg_daily_time_hours': avg_daily_time_hours,
        'avg_daily_time_formatted': format_time_human_readable(avg_daily_time_hours),
        'first_date': datetime.date.fromtimestamp(min_timestamp).strftime('%Y-%m-%d'),
        'last_date': datetime.date.fromtimestamp(max_timestamp).strftime('%Y-%m-%d'),
        'daily_activity': dict(daily_activity)
    }