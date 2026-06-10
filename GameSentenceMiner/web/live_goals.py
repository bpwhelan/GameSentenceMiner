"""Overlay live-goals feed.

Pushes a compact snapshot of the user's goals (the ones flagged for overlay
display in goals_settings.overlayGoals) to overlay websocket clients, so the
live-stats widget can render them next to the session stats.

Progress is computed by reusing the goals dashboard builder, so the overlay and
the goals page stay consistent. Goal progress hits the DB, so publishing is
throttled (see MIN_PUBLISH_INTERVAL_SECONDS).
"""

import time

import pytz

LIVE_GOALS_UPDATE_TYPE = "live_goals_update"
MIN_PUBLISH_INTERVAL_SECONDS = 30.0

_last_publish_time = 0.0


def _overlay_goal_config(goals_settings, goal_id):
    overlay_goals = goals_settings.get("overlayGoals") if isinstance(goals_settings, dict) else None
    if not isinstance(overlay_goals, dict):
        return None
    config = overlay_goals.get(goal_id)
    return config if isinstance(config, dict) else None


def _percent(progress, target):
    try:
        target = float(target)
        if target <= 0:
            return 0
        return max(0, min(100, (float(progress) / target) * 100))
    except (TypeError, ValueError):
        return 0


def build_live_goals_payload(now: float | None = None) -> dict:
    """Build the overlay live-goals snapshot for goals enabled for overlay display."""
    from GameSentenceMiner.web.goals_api import (
        _get_current_goals_payload,
        _build_goals_dashboard_payload,
        _get_goal_value,
    )

    updated_at = time.time() if now is None else float(now)

    _, current_goals, goals_settings, last_updated = _get_current_goals_payload()
    dashboard = _build_goals_dashboard_payload(
        current_goals, goals_settings, last_updated, user_tz=pytz.UTC
    )
    goal_progress = dashboard.get("goal_progress", {}) or {}
    today_progress = dashboard.get("today_progress", {}) or {}

    goals = []
    for goal in current_goals:
        goal_id = _get_goal_value(goal, "goal_id", "id")
        if not goal_id:
            continue
        config = _overlay_goal_config(goals_settings, goal_id)
        if not config or config.get("enabled") is not True:
            continue

        metric_type = _get_goal_value(goal, "metric_type", "metricType")
        target_value = _get_goal_value(goal, "target_value", "targetValue")
        default_name = _get_goal_value(goal, "name", default="Goal")
        name_override = config.get("nameOverride")
        view = config.get("view") if config.get("view") in ("today", "overall") else "today"

        overall = goal_progress.get(goal_id, {}) or {}
        today = today_progress.get(goal_id, {}) or {}
        overall_progress = overall.get("progress", 0)

        goals.append(
            {
                "id": goal_id,
                "name": (name_override or "").strip() or default_name,
                "icon": _get_goal_value(goal, "icon", default="🎯"),
                "metric_type": metric_type,
                "view": view,
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
