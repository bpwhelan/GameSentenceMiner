import time
from datetime import datetime, timedelta
from typing import Optional, List, Dict

from GameSentenceMiner.util.db import SQLiteDBTable
from GameSentenceMiner.util.configuration import logger


class CronTable(SQLiteDBTable):
    """
    Table for managing scheduled cron jobs in GSM.
    Stores periodic tasks that need to be executed on a schedule.
    """

    _table = "cron_table"
    _fields = [
        "name",
        "description",
        "last_run",
        "next_run",
        "enabled",
        "created_at",
        "schedule",
    ]
    _types = [
        int,  # id (primary key)
        str,  # name
        str,  # description
        float,  # last_run (Unix timestamp)
        float,  # next_run (Unix timestamp)
        bool,  # enabled
        float,  # created_at (Unix timestamp)
        str,  # schedule (once, daily, weekly, monthly, yearly)
    ]
    _pk = "id"
    _auto_increment = True

    def __init__(
        self,
        id: Optional[int] = None,
        name: Optional[str] = None,
        description: Optional[str] = None,
        last_run: Optional[float] = None,
        next_run: Optional[float] = None,
        enabled: bool = True,
        created_at: Optional[float] = None,
        schedule: str = "once",
    ):
        """
        Initialize a CronTable entry.

        Args:
            id: Primary key (auto-generated if None)
            name: Unique name for the cron job
            description: Human-readable description
            last_run: Unix timestamp of last execution (None if never run)
            next_run: Unix timestamp for next scheduled run
            enabled: Whether the cron job is active
            created_at: Unix timestamp of creation (defaults to now)
            schedule: Schedule type ('once', 'minutely', 'hourly', 'daily', 'weekly', 'monthly', 'yearly')
        """
        self.id = id
        self.name = name if name else ""
        self.description = description if description else ""
        self.last_run = last_run  # None if never run
        self.next_run = next_run if next_run else time.time()
        self.enabled = enabled
        self.created_at = created_at if created_at else time.time()
        self.schedule = (
            schedule
            if schedule in ["once", "minutely", "hourly", "daily", "weekly", "monthly", "yearly"]
            else "once"
        )

    @classmethod
    def create_cron_entry(
        cls,
        name: str,
        description: str,
        next_run: float,
        schedule: str,
        enabled: bool = True,
    ) -> "CronTable":
        """
        Create a new cron entry and save it to the database.

        Args:
            name: Unique name for the cron job
            description: Human-readable description
            next_run: Unix timestamp for next scheduled run
            schedule: Schedule type ('once', 'minutely', 'hourly', 'daily', 'weekly', 'monthly', 'yearly')
            enabled: Whether the cron job is active (default: True)

        Returns:
            CronTable: The created cron entry

        Raises:
            ValueError: If schedule type is invalid or name already exists
        """
        # Validate schedule type
        valid_schedules = ["once", "minutely", "hourly", "daily", "weekly", "monthly", "yearly"]
        if schedule not in valid_schedules:
            raise ValueError(
                f"Invalid schedule type '{schedule}'. Must be one of: {', '.join(valid_schedules)}"
            )

        # Check if name already exists
        existing = cls.get_by_name(name)
        if existing:
            raise ValueError(f"Cron job with name '{name}' already exists")

        # Create new entry
        new_cron = cls(
            name=name,
            description=description,
            next_run=next_run,
            schedule=schedule,
            enabled=enabled,
            created_at=time.time(),
        )
        new_cron.save()
        logger.debug(
            f"Created cron job '{name}' with schedule '{schedule}', next run at {datetime.fromtimestamp(next_run)}"
        )
        return new_cron

    @classmethod
    def get_due_crons(cls) -> List["CronTable"]:
        """
        Get all enabled cron jobs that are due to run now or earlier.

        Returns:
            List[CronTable]: List of cron jobs that need to be executed, ordered by next_run
        """
        now = time.time()
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE enabled=1 AND next_run <= ? ORDER BY next_run ASC",
            (now,),
        )
        crons = [cls.from_row(row) for row in rows]
        if crons:
            logger.debug(f"Found {len(crons)} due cron job(s)")
        return crons

    @classmethod
    def get_by_name(cls, name: str) -> Optional["CronTable"]:
        """
        Get a cron job by its unique name.

        Args:
            name: The name of the cron job

        Returns:
            CronTable: The cron job if found, None otherwise
        """
        row = cls._db.fetchone(f"SELECT * FROM {cls._table} WHERE name=?", (name,))
        return cls.from_row(row) if row else None

    @classmethod
    def get_all_enabled(cls) -> List["CronTable"]:
        """
        Get all enabled cron jobs.

        Returns:
            List[CronTable]: List of all enabled cron jobs
        """
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE enabled=1 ORDER BY next_run ASC"
        )
        return [cls.from_row(row) for row in rows]

    def update_last_run(self, timestamp: Optional[float] = None):
        """
        Update the last_run timestamp for this cron job.

        Args:
            timestamp: Unix timestamp to set (defaults to current time)
        """
        self.last_run = timestamp if timestamp is not None else time.time()
        self.save()
        logger.debug(
            f"Updated last_run for cron job '{self.name}' to {datetime.fromtimestamp(self.last_run)}"
        )

    def update_next_run(self, next_run: float):
        """
        Update the next_run timestamp for this cron job.

        Args:
            next_run: Unix timestamp for next scheduled run
        """
        self.next_run = next_run
        self.save()
        logger.debug(
            f"Updated next_run for cron job '{self.name}' to {datetime.fromtimestamp(next_run)}"
        )

    def enable(self):
        """Enable this cron job."""
        self.enabled = True
        self.save()
        logger.debug(f"Enabled cron job '{self.name}'")

    def disable(self):
        """Disable this cron job."""
        self.enabled = False
        self.save()
        logger.debug(f"Disabled cron job '{self.name}'")

    @classmethod
    def enable_cron(cls, cron_id: int):
        """
        Enable a cron job by ID.

        Args:
            cron_id: The ID of the cron job to enable
        """
        cron = cls.get(cron_id)
        if cron:
            cron.enable()
        else:
            logger.warning(f"Cron job with id {cron_id} not found")

    @classmethod
    def disable_cron(cls, cron_id: int):
        """
        Disable a cron job by ID.

        Args:
            cron_id: The ID of the cron job to disable
        """
        cron = cls.get(cron_id)
        if cron:
            cron.disable()
        else:
            logger.warning(f"Cron job with id {cron_id} not found")

    @classmethod
    def just_ran(cls, cron_id: int):
        """
        Mark a cron job as having just run and calculate the next run time based on its schedule.

        This is a convenience method that:
        1. Sets last_run to current time
        2. Calculates next_run based on the schedule type
        3. Updates the database

        For 'once' schedule, the cron job will be disabled after running.

        Args:
            cron_id: The ID of the cron job that just ran
        """
        cron = cls.get(cron_id)
        if not cron:
            logger.warning(f"Cron job with id {cron_id} not found")
            return

        # Set last_run to now
        now = time.time()
        cron.last_run = now

        # Calculate next_run based on schedule
        now_dt = datetime.fromtimestamp(now)

        if cron.schedule == "once":
            # For one-time jobs, disable after running
            cron.enabled = False
            cron.next_run = now  # Set to now since it won't run again
            logger.debug(
                f"Cron job '{cron.name}' completed (one-time job) and has been disabled"
            )
        elif cron.schedule == "minutely":
            # Schedule for 1 minute from now
            next_run_dt = now_dt + timedelta(minutes=1)
            cron.next_run = next_run_dt.timestamp()
            logger.debug(
                f"Cron job '{cron.name}' completed, next run scheduled for {next_run_dt}"
            )
        elif cron.schedule == "hourly":
            # Schedule for 1 hour from now
            next_run_dt = now_dt + timedelta(hours=1)
            cron.next_run = next_run_dt.timestamp()
            logger.debug(
                f"Cron job '{cron.name}' completed, next run scheduled for {next_run_dt}"
            )
        elif cron.schedule == "daily":
            # Schedule for 3am tomorrow
            # If we schedule at + 24 hours
            # imagine if user opens gsm at like 6pm first time, does some mining
            # tomorrow they open gsm again but at 9am, but the cron is set to run at 6pm
            # so they will have stats from yesterday not rolled up, as stats rollup did not run
            # setting it to 3am means the user always has the full previous day rolled up when they open gsm
            next_run_dt = (now_dt + timedelta(days=1)).replace(
                hour=0, minute=1, second=0, microsecond=0
            )
            cron.next_run = next_run_dt.timestamp()
            logger.debug(
                f"Cron job '{cron.name}' completed, next run scheduled for {next_run_dt}"
            )
        elif cron.schedule == "weekly":
            # Schedule for 3am next week (same day)
            next_run_dt = (now_dt + timedelta(weeks=1)).replace(
                hour=3, minute=0, second=0, microsecond=0
            )
            cron.next_run = next_run_dt.timestamp()
            logger.debug(
                f"Cron job '{cron.name}' completed, next run scheduled for {next_run_dt}"
            )
        elif cron.schedule == "monthly":
            # Schedule for 3am approximately 30 days from now
            next_run_dt = (now_dt + timedelta(days=30)).replace(
                hour=3, minute=0, second=0, microsecond=0
            )
            cron.next_run = next_run_dt.timestamp()
            logger.debug(
                f"Cron job '{cron.name}' completed, next run scheduled for {next_run_dt}"
            )
        elif cron.schedule == "yearly":
            # Schedule for 3am approximately 365 days from now
            next_run_dt = (now_dt + timedelta(days=365)).replace(
                hour=3, minute=0, second=0, microsecond=0
            )
            cron.next_run = next_run_dt.timestamp()
            logger.debug(
                f"Cron job '{cron.name}' completed, next run scheduled for {next_run_dt}"
            )
        else:
            logger.warning(
                f"Unknown schedule type '{cron.schedule}' for cron job '{cron.name}'"
            )
            return

        # Save all changes
        cron.save()
