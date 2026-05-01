"""SQLite-backed persistence for the Anki batch review queue.

Each row corresponds to a card that was mined while ``batch_review_queue_enabled``
was on. The card was already auto-accepted into Anki using the VAD result; the
row preserves the snapshot needed to re-open the confirmation dialog later and
overwrite the note with the user's edits.
"""

from typing import List, Optional

from GameSentenceMiner.util.database.db import SQLiteDBTable


class PendingReviewsTable(SQLiteDBTable):
    _table = "pending_reviews"
    _fields = [
        "created_at",
        "status",
        "game",
        "expression",
        "sentence_preview",
        "anki_note_id",
        "mined_line_id",
        "selected_line_ids",
        "audio_path",
        "screenshot_path",
        "prev_screenshot_path",
        "source_video_path",
        "screenshot_timestamp",
        "prev_screenshot_timestamp",
        "vad_result_data",
        "audio_edit_context_data",
        "translation",
        "pending_animated",
        "pending_video",
        "extra_tags",
        "anki_card_creation_time",
        "last_modified",
        "failure_reason",
    ]
    _types = [
        str,  # entry_id (PK)
        float,  # created_at
        str,  # status: pending|reviewing|done|failed
        str,  # game
        str,  # expression
        str,  # sentence_preview
        str,  # anki_note_id (stored as str to keep parity with other tables)
        str,  # mined_line_id
        list,  # selected_line_ids JSON
        str,  # audio_path snapshot
        str,  # screenshot_path snapshot
        str,  # prev_screenshot_path snapshot
        str,  # source_video_path snapshot
        float,  # screenshot_timestamp
        float,  # prev_screenshot_timestamp
        dict,  # vad_result_data JSON
        dict,  # audio_edit_context_data JSON
        str,  # translation
        bool,  # pending_animated
        bool,  # pending_video
        list,  # extra_tags JSON
        float,  # anki_card_creation_time (unix seconds)
        float,  # last_modified
        str,  # failure_reason (if status=failed)
    ]
    _pk = "entry_id"
    _auto_increment = False

    def __init__(
        self,
        entry_id: Optional[str] = None,
        created_at: Optional[float] = None,
        status: Optional[str] = None,
        game: Optional[str] = None,
        expression: Optional[str] = None,
        sentence_preview: Optional[str] = None,
        anki_note_id: Optional[str] = None,
        mined_line_id: Optional[str] = None,
        selected_line_ids: Optional[List[str]] = None,
        audio_path: Optional[str] = None,
        screenshot_path: Optional[str] = None,
        prev_screenshot_path: Optional[str] = None,
        source_video_path: Optional[str] = None,
        screenshot_timestamp: Optional[float] = None,
        prev_screenshot_timestamp: Optional[float] = None,
        vad_result_data: Optional[dict] = None,
        audio_edit_context_data: Optional[dict] = None,
        translation: Optional[str] = None,
        pending_animated: Optional[bool] = None,
        pending_video: Optional[bool] = None,
        extra_tags: Optional[List[str]] = None,
        anki_card_creation_time: Optional[float] = None,
        last_modified: Optional[float] = None,
        failure_reason: Optional[str] = None,
    ):
        self.entry_id = entry_id
        self.created_at = created_at
        self.status = status if status is not None else "pending"
        self.game = game if game is not None else ""
        self.expression = expression if expression is not None else ""
        self.sentence_preview = sentence_preview if sentence_preview is not None else ""
        self.anki_note_id = anki_note_id if anki_note_id is not None else ""
        self.mined_line_id = mined_line_id if mined_line_id is not None else ""
        self.selected_line_ids = selected_line_ids if selected_line_ids is not None else []
        self.audio_path = audio_path if audio_path is not None else ""
        self.screenshot_path = screenshot_path if screenshot_path is not None else ""
        self.prev_screenshot_path = prev_screenshot_path if prev_screenshot_path is not None else ""
        self.source_video_path = source_video_path if source_video_path is not None else ""
        self.screenshot_timestamp = screenshot_timestamp if screenshot_timestamp is not None else 0.0
        self.prev_screenshot_timestamp = prev_screenshot_timestamp if prev_screenshot_timestamp is not None else 0.0
        self.vad_result_data = vad_result_data if vad_result_data is not None else {}
        self.audio_edit_context_data = audio_edit_context_data if audio_edit_context_data is not None else {}
        self.translation = translation if translation is not None else ""
        self.pending_animated = bool(pending_animated) if pending_animated is not None else False
        self.pending_video = bool(pending_video) if pending_video is not None else False
        self.extra_tags = extra_tags if extra_tags is not None else []
        self.anki_card_creation_time = anki_card_creation_time if anki_card_creation_time is not None else 0.0
        self.last_modified = last_modified
        self.failure_reason = failure_reason if failure_reason is not None else ""

    @classmethod
    def list_by_status(cls, status: str) -> List["PendingReviewsTable"]:
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE status=? ORDER BY created_at ASC",
            (status,),
        )
        return [cls.from_row(row) for row in rows]

    @classmethod
    def list_active(cls) -> List["PendingReviewsTable"]:
        """Return all rows that have not yet been finalized (``done``)."""
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE status IN ('pending', 'reviewing', 'failed') ORDER BY created_at ASC"
        )
        return [cls.from_row(row) for row in rows]

    @classmethod
    def count_pending(cls) -> int:
        row = cls._db.fetchone(f"SELECT COUNT(*) FROM {cls._table} WHERE status='pending'")
        return int(row[0]) if row and row[0] is not None else 0

    @classmethod
    def get_referenced_videos(cls) -> List[str]:
        """Distinct ``source_video_path`` values across non-final rows."""
        rows = cls._db.fetchall(
            f"SELECT DISTINCT source_video_path FROM {cls._table} "
            "WHERE status IN ('pending', 'reviewing', 'failed') AND source_video_path != ''"
        )
        return [row[0] for row in rows if row and row[0]]

    @classmethod
    def delete_done_older_than(cls, cutoff_epoch_seconds: float) -> int:
        cur = cls._db.execute(
            f"DELETE FROM {cls._table} WHERE status='done' AND last_modified IS NOT NULL AND last_modified < ?",
            (cutoff_epoch_seconds,),
            commit=True,
        )
        return cur.rowcount if cur is not None else 0
