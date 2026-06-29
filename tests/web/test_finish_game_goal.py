import datetime

from GameSentenceMiner.web.goals_api import calculate_finish_game_required_today


def test_finish_game_paces_remaining_over_days_left():
    today = datetime.date(2026, 6, 9)
    end = datetime.date(2026, 6, 30)  # 22 days inclusive
    # 220k target, 0 read -> 10k/day
    assert calculate_finish_game_required_today(220_000, 0, end, today) == 10_000


def test_finish_game_accounts_for_progress():
    today = datetime.date(2026, 6, 9)
    end = datetime.date(2026, 6, 18)  # 10 days inclusive
    # 100k target, 50k read -> 5k/day
    assert calculate_finish_game_required_today(100_000, 50_000, end, today) == 5_000


def test_finish_game_zero_once_reached():
    today = datetime.date(2026, 6, 9)
    end = datetime.date(2026, 6, 30)
    assert calculate_finish_game_required_today(100_000, 100_000, end, today) == 0
    assert calculate_finish_game_required_today(100_000, 120_000, end, today) == 0


def test_finish_game_last_day_requires_all_remaining():
    today = datetime.date(2026, 6, 30)
    end = datetime.date(2026, 6, 30)  # 1 day inclusive
    assert calculate_finish_game_required_today(100_000, 40_000, end, today) == 60_000
