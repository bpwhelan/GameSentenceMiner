import datetime
from dataclasses import dataclass


@dataclass(frozen=True)
class GoalProgressWindow:
    include_today_live: bool
    rollup_end_date: datetime.date
    has_rollup_range: bool


def calculate_goal_progress_window(
    start_date: datetime.date, end_date: datetime.date, today: datetime.date
) -> GoalProgressWindow:
    """
    Calculate the historical/live stats window for a goal.

    Historical rollups are capped at the goal's own end date. Live stats are
    only included while the goal still overlaps today.
    """
    include_today_live = end_date >= today
    yesterday = today - datetime.timedelta(days=1)
    rollup_end_date = min(end_date, yesterday) if include_today_live else end_date

    return GoalProgressWindow(
        include_today_live=include_today_live,
        rollup_end_date=rollup_end_date,
        has_rollup_range=start_date <= rollup_end_date,
    )
