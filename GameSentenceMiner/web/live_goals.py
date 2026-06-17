"""Overlay live-goals feed.

Pushes a compact snapshot of every *active* goal (with the same progress numbers
shown on the goals page) to overlay websocket clients. Which goals actually
render, and in which view, is chosen overlay-side (see GSM_Overlay settings) — the
backend just keeps the overlay supplied with up-to-date numbers.

Progress is computed by reusing the goals dashboard builder, so the overlay and
the goals page stay consistent. Goal progress hits the DB, so publishing is
throttled (see MIN_PUBLISH_INTERVAL_SECONDS).
"""

import datetime
import time

LIVE_GOALS_UPDATE_TYPE = "live_goals_update"
MIN_PUBLISH_INTERVAL_SECONDS = 30.0

_STATIC_METRIC_TYPES = ("hours_static", "characters_static", "cards_static")


def _local_timezone():
    """Resolve the machine's local timezone for overlay goal math.

    Overlay publishing has no browser X-Timezone header (unlike the goals page),
    so use the local system timezone. GSM runs on the same machine as the browser,
    so its current UTC offset matches the browser's tz — meaning the "today"
    boundary (and the daily target) line up with what the goals page computes.
    """
    return datetime.datetime.now().astimezone().tzinfo or datetime.timezone.utc


_last_publish_time = 0.0


def _goal_is_active(goal, today_str, get_goal_value):
    """Match the goals page's "active" semantics: custom/static always, else not expired."""
    metric_type = get_goal_value(goal, "metric_type", "metricType")
    if metric_type == "custom" or metric_type in _STATIC_METRIC_TYPES:
        return True
    end_date = get_goal_value(goal, "end_date", "endDate")
    return bool(end_date) and end_date >= today_str


def _percent(progress, target):
    try:
        target = float(target)
        if target <= 0:
            return 0
        return max(0, min(100, (float(progress) / target) * 100))
    except (TypeError, ValueError):
        return 0


def build_live_goals_payload(now: float | None = None) -> dict:
    """Build the overlay live-goals snapshot of every active goal with its progress."""
    from GameSentenceMiner.web.goals_api import (
        _get_current_goals_payload,
        _build_goals_dashboard_payload,
        _get_goal_value,
        get_today_in_timezone,
    )

    updated_at = time.time() if now is None else float(now)
    user_tz = _local_timezone()

    _, current_goals, goals_settings, last_updated = _get_current_goals_payload()
    dashboard = _build_goals_dashboard_payload(current_goals, goals_settings, last_updated, user_tz=user_tz)
    goal_progress = dashboard.get("goal_progress", {}) or {}
    today_progress = dashboard.get("today_progress", {}) or {}
    today_str = dashboard.get("today_date") or get_today_in_timezone(user_tz).isoformat()

    goals = []
    for goal in current_goals:
        goal_id = _get_goal_value(goal, "goal_id", "id")
        if not goal_id:
            continue
        if not _goal_is_active(goal, today_str, _get_goal_value):
            continue

        metric_type = _get_goal_value(goal, "metric_type", "metricType")
        target_value = _get_goal_value(goal, "target_value", "targetValue")
        name = _get_goal_value(goal, "name", default="Goal")

        overall = goal_progress.get(goal_id, {}) or {}
        today = today_progress.get(goal_id, {}) or {}
        overall_progress = overall.get("progress", 0)

        goals.append(
            {
                "id": goal_id,
                "name": name,
                "icon": _get_goal_value(goal, "icon", default="🎯"),
                "metric_type": metric_type,
                "today": {
                    "progress": today.get("progress", 0),
                    "required": today.get("required", 0),
                    "has_target": today.get("has_target", False),
                },
                "overall": {
                    "progress": overall_progress,
                    "target": target_value,
                    "percent": round(_percent(overall_progress, target_value)),
                },
            }
        )

    return {
        "type": LIVE_GOALS_UPDATE_TYPE,
        "updated_at": updated_at,
        "goals": goals,
    }


def publish_live_goals_update(*, force: bool = False) -> bool:
    """Publish an overlay live-goals snapshot, throttled unless force=True."""
    global _last_publish_time
    now = time.time()
    if not force and (now - _last_publish_time) < MIN_PUBLISH_INTERVAL_SECONDS:
        return False

    try:
        from GameSentenceMiner.web.gsm_websocket import ID_OVERLAY, websocket_manager

        if not websocket_manager.has_clients(ID_OVERLAY):
            return False

        _last_publish_time = now
        websocket_manager.send_nowait(ID_OVERLAY, build_live_goals_payload(now=now))
        return True
    except Exception:
        return False
