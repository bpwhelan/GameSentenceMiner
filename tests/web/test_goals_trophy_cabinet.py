import datetime
from pathlib import Path

from GameSentenceMiner.util.goals_progress import calculate_goal_progress_window


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_progress_window_caps_expired_goal_at_its_end_date():
    window = calculate_goal_progress_window(
        datetime.date(2026, 2, 1),
        datetime.date(2026, 2, 28),
        datetime.date(2026, 3, 22),
    )

    assert window.include_today_live is False
    assert window.rollup_end_date == datetime.date(2026, 2, 28)
    assert window.has_rollup_range is True


def test_progress_window_keeps_today_live_for_goal_ending_today():
    window = calculate_goal_progress_window(
        datetime.date(2026, 3, 1),
        datetime.date(2026, 3, 22),
        datetime.date(2026, 3, 22),
    )

    assert window.include_today_live is True
    assert window.rollup_end_date == datetime.date(2026, 3, 21)
    assert window.has_rollup_range is True


def test_goals_template_contains_trophy_cabinet_markup():
    template_path = REPO_ROOT / "GameSentenceMiner" / "web" / "templates" / "goals.html"
    template = template_path.read_text(encoding="utf-8")

    assert 'id="trophyCabinetCard"' in template
    assert 'id="trophyGrid"' in template
    assert 'onclick="loadTrophyCabinet()"' in template


def test_goals_javascript_loads_achieved_goal_endpoint():
    js_path = REPO_ROOT / "GameSentenceMiner" / "web" / "static" / "js" / "goals.js"
    javascript = js_path.read_text(encoding="utf-8")

    assert "async function loadTrophyCabinet()" in javascript
    assert "fetch('/api/goals/achieved'" in javascript
    assert "window.loadTrophyCabinet = loadTrophyCabinet;" in javascript
