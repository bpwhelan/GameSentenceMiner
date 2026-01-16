"""Rate limiter for VNDB API with persistence for resumability."""

import json
import time
from datetime import datetime
from pathlib import Path
from typing import Optional


class RateLimiter:
    """
    Rate limiter for VNDB API.

    VNDB allows 200 requests per 5-minute window. We use 199 to be safe.
    State is persisted to allow resuming after interruption.
    """

    MAX_REQUESTS = 199
    WINDOW_SECONDS = 300  # 5 minutes

    def __init__(self, progress_file: Path):
        """
        Initialize rate limiter.

        Args:
            progress_file: Path to progress.json file for state persistence
        """
        self.progress_file = progress_file
        self.requests_in_window = 0
        self.window_start: Optional[datetime] = None
        self.retry_count = 0
        self._load_state()

    def _load_state(self) -> None:
        """Load rate limit state from progress file."""
        if not self.progress_file.exists():
            self._reset_window()
            return

        try:
            with open(self.progress_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            rate_state = data.get('rate_limit_state', {})
            self.requests_in_window = rate_state.get('requests_in_window', 0)

            window_start_str = rate_state.get('window_start')
            if window_start_str:
                self.window_start = datetime.fromisoformat(window_start_str)

                # Check if window has expired
                elapsed = (datetime.now() - self.window_start).total_seconds()
                if elapsed >= self.WINDOW_SECONDS:
                    self._reset_window()
            else:
                self._reset_window()

        except (json.JSONDecodeError, KeyError, ValueError):
            self._reset_window()

    def _save_state(self, progress_data: dict) -> None:
        """
        Save rate limit state to progress data dict.

        Args:
            progress_data: The progress dict to update (will be saved by caller)
        """
        progress_data['rate_limit_state'] = {
            'requests_in_window': self.requests_in_window,
            'window_start': self.window_start.isoformat() if self.window_start else None
        }

    def _reset_window(self) -> None:
        """Reset the rate limit window."""
        self.requests_in_window = 0
        self.window_start = datetime.now()

    def _check_window_expired(self) -> bool:
        """Check if current window has expired and reset if so."""
        if self.window_start is None:
            self._reset_window()
            return True

        elapsed = (datetime.now() - self.window_start).total_seconds()
        if elapsed >= self.WINDOW_SECONDS:
            self._reset_window()
            return True
        return False

    def wait_if_needed(self) -> None:
        """
        Wait if we've hit the rate limit.

        Checks if we've made MAX_REQUESTS in the current window.
        If so, waits until the window resets.
        """
        self._check_window_expired()

        if self.requests_in_window >= self.MAX_REQUESTS:
            # Calculate how long to wait
            elapsed = (datetime.now() - self.window_start).total_seconds()
            wait_time = self.WINDOW_SECONDS - elapsed

            if wait_time > 0:
                print(f"Rate limit reached ({self.requests_in_window}/{self.MAX_REQUESTS}). "
                      f"Waiting {wait_time:.0f} seconds...")
                time.sleep(wait_time + 1)  # Add 1 second buffer

            self._reset_window()

    def record_request(self) -> None:
        """Record that a request was made."""
        self._check_window_expired()
        self.requests_in_window += 1

    def handle_rate_limit_error(self) -> None:
        """
        Handle a 429 rate limit error from VNDB.

        First occurrence: wait 5 minutes
        Subsequent occurrences: wait 1 hour
        """
        self.retry_count += 1

        if self.retry_count == 1:
            wait_time = 5 * 60  # 5 minutes
            print(f"Rate limited by server. Waiting 5 minutes...")
        else:
            wait_time = 60 * 60  # 1 hour
            print(f"Rate limited again (attempt {self.retry_count}). Waiting 1 hour...")

        time.sleep(wait_time)
        self._reset_window()

    def reset_retry_count(self) -> None:
        """Reset retry counter after successful request."""
        self.retry_count = 0

    def get_state_for_progress(self) -> dict:
        """Get current state as dict for progress file."""
        return {
            'requests_in_window': self.requests_in_window,
            'window_start': self.window_start.isoformat() if self.window_start else None
        }
