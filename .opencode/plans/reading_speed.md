# Plan: Replace Flat AFK Timer with Adaptive Reading Time Calculation

## Problem

`calculate_actual_reading_time()` in `stats.py:434` uses a flat `afk_timer_seconds`
(default 60s) to cap every inter-line gap. If a user spends more than 60 seconds on a
line (reading a long sentence, looking up words, re-reading), that time is silently
capped, which deflates reading time and artificially inflates reading speed.

The user currently has to manually tune `afk_timer_seconds` to get accurate stats —
poor UX.

## Available Data Per Line

From `game_line` in the database:

- `line_text` — the actual text content (character count known)
- `timestamp` — when the line appeared (float, Unix)

With consecutive lines sorted by timestamp:

- **gap** = `next_line.timestamp - this_line.timestamp` (time spent "on" a line)
- **char_count** = `len(line_text)` (characters in the line)

This lets us compute per-line reading speed (chars/sec), which enables smarter AFK
detection.

## Solution: Two-Stage Adaptive Calculation

### Stage 1 — Adaptive Per-Line Cap

Each line gets a maximum reasonable reading time based on its character count:

```
max_time_for_line = max(FLOOR_SECONDS, len(text) * MAX_SEC_PER_CHAR)
```

Capped at an absolute ceiling (e.g., 300s) to handle degenerate cases.

Constants:
- `MAX_SEC_PER_CHAR`: ~3-4 seconds (generous — typical Japanese reading is ~0.3-0.5
  sec/char, but this accommodates dictionary lookups)
- `FLOOR_SECONDS`: ~15-20 seconds (for very short/empty lines like character names)
- `ABSOLUTE_CEILING`: ~300 seconds (5 minutes, hard upper bound)

### Stage 2 — Statistical Outlier Replacement

After the adaptive cap, compute the per-line reading speed (chars/sec) distribution
for all non-trivial lines (those with >= some minimum character count to avoid noise):

1. Collect per-line speeds: `speed_i = char_count_i / gap_i`
2. Compute Q1, Q3, IQR of speeds
3. Lines with speed < Q1 - 1.5 * IQR are outlier-slow (likely AFK)
4. Replace outlier gaps with `median_speed * char_count`

This catches subtle AFK on short lines that pass the character-based cap.

### Fallback

If `line_texts` is not provided (backward compat), fall back to the current flat-cap
behavior. This ensures existing callers that don't have text data won't break.

## Algorithm Pseudocode

```python
def calculate_actual_reading_time(timestamps, line_texts=None, afk_timer_seconds=None):
    """
    Two-stage adaptive reading time calculation.

    Stage 1 - Adaptive cap per line:
      max_time_for_line = max(FLOOR_SECONDS, len(text) * MAX_SEC_PER_CHAR)
      capped at absolute ceiling

    Stage 2 - Statistical outlier replacement:
      Compute per-line speed (chars/sec) for all non-trivial lines
      Use IQR to identify outlier-slow lines
      Replace outlier gaps with median_speed * char_count

    Falls back to flat cap if line_texts not provided.
    """
    if not timestamps or len(timestamps) < 2:
        return 0.0

    # If no line texts, fall back to flat cap
    if line_texts is None:
        return _flat_cap_reading_time(timestamps, afk_timer_seconds)

    sorted_pairs = sorted(zip(timestamps, line_texts), key=lambda p: p[0])

    # Stage 1: Adaptive cap
    gaps = []
    for i in range(len(sorted_pairs) - 1):
        raw_gap = sorted_pairs[i + 1][0] - sorted_pairs[i][0]
        text = sorted_pairs[i][1] or ""
        char_count = len(text)
        max_time = max(FLOOR_SECONDS, char_count * MAX_SEC_PER_CHAR)
        max_time = min(max_time, ABSOLUTE_CEILING)
        capped_gap = min(raw_gap, max_time)
        gaps.append((capped_gap, char_count))

    # Stage 2: IQR outlier filtering on per-line speed
    # Only consider lines with enough chars to be meaningful
    MIN_CHARS_FOR_SPEED = 5
    speeds = []
    speed_indices = []
    for i, (gap, char_count) in enumerate(gaps):
        if char_count >= MIN_CHARS_FOR_SPEED and gap > 0:
            speeds.append(char_count / gap)
            speed_indices.append(i)

    if len(speeds) >= 10:  # Need enough data for IQR to be meaningful
        sorted_speeds = sorted(speeds)
        q1 = sorted_speeds[len(sorted_speeds) // 4]
        q3 = sorted_speeds[3 * len(sorted_speeds) // 4]
        iqr = q3 - q1
        lower_bound = q1 - 1.5 * iqr
        median_speed = sorted_speeds[len(sorted_speeds) // 2]

        for j, idx in enumerate(speed_indices):
            if speeds[j] < lower_bound and median_speed > 0:
                # Replace outlier gap with median-based estimate
                char_count = gaps[idx][1]
                estimated_gap = char_count / median_speed
                gaps[idx] = (estimated_gap, char_count)

    return sum(gap for gap, _ in gaps)
```

## Files to Change

| # | File | Change |
|---|------|--------|
| 1 | `GameSentenceMiner/web/stats.py` | Rewrite `calculate_actual_reading_time()` to accept optional `line_texts` parameter. Implement two-stage adaptive calculation. Keep old signature as fallback. Extract current flat-cap logic into `_flat_cap_reading_time()`. |
| 2 | `GameSentenceMiner/web/stats.py` | Update all internal callers: `calculate_daily_reading_time`, `calculate_reading_speed_heatmap_data`, `calculate_reading_speed_per_game`, `calculate_current_game_stats`, `calculate_all_games_stats`, `calculate_hourly_reading_speed`, `calculate_daily_speed_data`. Pass `line_texts` alongside `timestamps`. |
| 3 | `GameSentenceMiner/web/stats_api.py` | Update callers in `/api/stats` and `/api/game/<id>/stats` endpoints to pass line texts. |
| 4 | `GameSentenceMiner/web/rollup_stats.py` | Update `calculate_live_stats_for_today()` to pass line texts. |
| 5 | `GameSentenceMiner/util/cron/daily_rollup.py` | Update `analyze_sessions()` and `analyze_hourly_data()` to pass line texts. |
| 6 | `GameSentenceMiner/util/stats/live_stats.py` | Update `LiveSessionTracker` to use the new calculation (it has its own inline reading time logic). |
| 7 | `GameSentenceMiner/util/config/configuration.py` | Remove dead `minimum_chars_per_hour` field. Keep `afk_timer_seconds` as the absolute ceiling fallback. |
| 8 | `tests/web/test_stats_pure_functions.py` | Add comprehensive tests for the new adaptive calculation. |

## Key Caller Locations (line references)

### `calculate_actual_reading_time()` — current implementation
- **Definition:** `GameSentenceMiner/web/stats.py:434-466`

### Direct callers of `calculate_actual_reading_time()`
- `stats.py:469` — `calculate_daily_reading_time(lines)` — passes `[float(line.timestamp)]`
- `stats.py:213-264` — `calculate_reading_speed_heatmap_data(lines)` — per-day timestamps
- `stats.py:267-332` — `calculate_games_reading_time(lines)` — per-game timestamps
- `stats.py:339-378` — `calculate_reading_speed_per_game(lines)` — per-game timestamps
- `stats.py:636` — `calculate_current_game_stats()` — timestamps for current game
- `stats.py:802-836` — `calculate_hourly_reading_speed(lines)` — per-hour timestamps
- `stats.py:843-890` — `calculate_daily_speed_data(lines)` — per-day timestamps
- `stats.py:1093-1108` — `calculate_all_games_stats()` — all game timestamps
- `stats_api.py:2551-2555` — `/api/game/<id>/stats` endpoint
- `stats_api.py:2574-2660` — per-game daily speed chart data
- `rollup_stats.py:390-415` — `calculate_live_stats_for_today()`

### Inline AFK-timer logic (same pattern, not calling the function)
- `daily_rollup.py:52-103` — `analyze_sessions()` — inline gap capping
- `daily_rollup.py:127-154` — `analyze_hourly_data()` — inline gap capping
- `live_stats.py:30-37` — `LiveSessionTracker` — inline gap capping

## Backward Compatibility

- Old `calculate_actual_reading_time(timestamps)` signature still works — falls back
  to flat-cap behavior when `line_texts` is not provided.
- Existing rollup data in `daily_stats_rollup` was computed with the old method. New
  data going forward uses the improved method. A one-time re-rollup could be added
  later if desired (not in scope for initial implementation).

## Impact on Existing Stats

- Reading times will generally **increase** (fewer false AFK detections on long lines)
- Reading speeds (chars/hour) will generally **decrease** (more time for same chars)
- "Est. Time Left" on game pages adjusts accordingly
- All charts (daily speed, hourly speed, heatmaps) reflect improved calculation

## Constants to Tune

These can be adjusted after testing with real data:

| Constant | Default | Description |
|----------|---------|-------------|
| `MAX_SEC_PER_CHAR` | 3.0 | Max seconds allowed per character in a line |
| `FLOOR_SECONDS` | 15 | Minimum time allowed for any line (even empty) |
| `ABSOLUTE_CEILING` | 300 | Hard upper bound on any single line's time |
| `MIN_CHARS_FOR_SPEED` | 5 | Minimum chars for a line to be included in IQR |
| IQR multiplier | 1.5 | Standard whisker for outlier detection |
| Min samples for IQR | 10 | Minimum lines needed before applying IQR filtering |

## Test Cases to Add

1. **Normal reading session** — gaps proportional to line length, no outliers
2. **Long AFK gap** — 10-minute gap on a short line, should be capped
3. **Long line, long gap** — 90s gap on a 100-char line should NOT be capped (adaptive)
4. **Empty/short lines** — character names, should use floor_seconds
5. **All short lines** — IQR should still work or gracefully skip
6. **Single line** — returns 0.0
7. **Two lines** — no IQR (too few), only adaptive cap
8. **Mixed session** — some AFK, some normal, verify outlier replacement
9. **Fallback** — call without `line_texts`, verify flat-cap behavior unchanged
10. **Edge case** — all identical gaps/speeds, IQR=0, should not divide by zero
