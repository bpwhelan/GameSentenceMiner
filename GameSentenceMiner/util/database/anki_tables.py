from __future__ import annotations


from GameSentenceMiner.util.logging_config import logger
from GameSentenceMiner.util.database.db import SQLiteDB, SQLiteDBTable


class AnkiNotesTable(SQLiteDBTable):
    """Cache of Anki notes, keyed by Anki's note_id."""

    _table = "anki_notes"
    _fields = ["model_name", "fields_json", "tags", "mod", "synced_at"]
    _types = [
        int,
        str,
        str,
        str,
        int,
        float,
    ]  # note_id, model_name, fields_json, tags, mod, synced_at
    _pk = "note_id"
    _auto_increment = False

    def __init__(
        self,
        note_id: int | None = None,
        model_name: str | None = None,
        fields_json: str | None = None,
        tags: str | None = None,
        mod: int | None = None,
        synced_at: float | None = None,
    ):
        self.note_id = note_id
        self.model_name = model_name if model_name is not None else ""
        self.fields_json = fields_json if fields_json is not None else "{}"
        self.tags = tags if tags is not None else "[]"
        self.mod = mod if mod is not None else 0
        self.synced_at = synced_at

    @classmethod
    def get_by_ids(cls, note_ids: list[int]) -> list[AnkiNotesTable]:
        """Fetch multiple notes by their IDs."""
        if not note_ids:
            return []
        placeholders = ", ".join(["?"] * len(note_ids))
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE note_id IN ({placeholders})",
            tuple(note_ids),
        )
        return [cls.from_row(row) for row in rows]


class AnkiCardsTable(SQLiteDBTable):
    """Cache of Anki cards, keyed by Anki's card_id."""

    _table = "anki_cards"
    _fields = [
        "note_id",
        "deck_name",
        "queue",
        "type",
        "due",
        "interval",
        "factor",
        "reps",
        "lapses",
        "synced_at",
    ]
    _types = [
        int,
        int,
        str,
        int,
        int,
        int,
        int,
        int,
        int,
        int,
        float,
    ]  # card_id, note_id, deck_name, queue, type, due, interval, factor, reps, lapses, synced_at
    _pk = "card_id"
    _auto_increment = False

    def __init__(
        self,
        card_id: int | None = None,
        note_id: int | None = None,
        deck_name: str | None = None,
        queue: int | None = None,
        type: int | None = None,
        due: int | None = None,
        interval: int | None = None,
        factor: int | None = None,
        reps: int | None = None,
        lapses: int | None = None,
        synced_at: float | None = None,
    ):
        self.card_id = card_id
        self.note_id = note_id if note_id is not None else 0
        self.deck_name = deck_name if deck_name is not None else ""
        self.queue = queue if queue is not None else 0
        self.type = type if type is not None else 0
        self.due = due if due is not None else 0
        self.interval = interval if interval is not None else 0
        self.factor = factor if factor is not None else 0
        self.reps = reps if reps is not None else 0
        self.lapses = lapses if lapses is not None else 0
        self.synced_at = synced_at

    @classmethod
    def get_by_note_id(cls, note_id: int) -> list[AnkiCardsTable]:
        """Fetch all cards belonging to a given note."""
        rows = cls._db.fetchall(f"SELECT * FROM {cls._table} WHERE note_id = ?", (note_id,))
        return [cls.from_row(row) for row in rows]

    @classmethod
    def get_by_note_ids(cls, note_ids: list[int]) -> list["AnkiCardsTable"]:
        """Fetch all cards for the provided note IDs."""
        if not note_ids:
            return []

        cards: list[AnkiCardsTable] = []
        for start in range(0, len(note_ids), 500):
            chunk = note_ids[start : start + 500]
            placeholders = ", ".join(["?"] * len(chunk))
            rows = cls._db.fetchall(
                f"SELECT * FROM {cls._table} WHERE note_id IN ({placeholders})",
                tuple(chunk),
            )
            cards.extend(cls.from_row(row) for row in rows)
        return cards

    @classmethod
    def get_note_ids_by_card_ids(cls, card_ids: list[int]) -> dict[int, int]:
        """Fetch a map of card IDs to note IDs."""
        if not card_ids:
            return {}

        mapping: dict[int, int] = {}
        for start in range(0, len(card_ids), 500):
            chunk = card_ids[start : start + 500]
            placeholders = ", ".join(["?"] * len(chunk))
            rows = cls._db.fetchall(
                f"SELECT card_id, note_id FROM {cls._table} WHERE card_id IN ({placeholders})",
                tuple(chunk),
            )
            for card_id, note_id in rows:
                mapping[card_id] = note_id
        return mapping


class AnkiReviewsTable(SQLiteDBTable):
    """Cache of Anki review history. Uses composite review_id = f'{card_id}_{review_time}' as TEXT PK."""

    _table = "anki_reviews"
    _fields = [
        "card_id",
        "note_id",
        "review_time",
        "ease",
        "interval",
        "last_interval",
        "time_taken",
        "synced_at",
    ]
    _types = [
        str,
        int,
        int,
        int,
        int,
        int,
        int,
        int,
        float,
    ]  # review_id (TEXT), card_id, note_id, review_time, ease, interval, last_interval, time_taken, synced_at
    _pk = "review_id"
    _auto_increment = False

    def __init__(
        self,
        review_id: str | None = None,
        card_id: int | None = None,
        note_id: int | None = None,
        review_time: int | None = None,
        ease: int | None = None,
        interval: int | None = None,
        last_interval: int | None = None,
        time_taken: int | None = None,
        synced_at: float | None = None,
    ):
        self.review_id = review_id
        self.card_id = card_id if card_id is not None else 0
        self.note_id = note_id if note_id is not None else 0
        self.review_time = review_time if review_time is not None else 0
        self.ease = ease if ease is not None else 0
        self.interval = interval if interval is not None else 0
        self.last_interval = last_interval if last_interval is not None else 0
        self.time_taken = time_taken if time_taken is not None else 0
        self.synced_at = synced_at


class WordAnkiLinksTable(SQLiteDBTable):
    """Join table linking tokenized words to Anki notes."""

    _table = "word_anki_links"
    _fields = ["word_id", "note_id"]
    _types = [int, int, int]  # id (auto), word_id, note_id
    _pk = "id"
    _auto_increment = True

    def __init__(
        self,
        id: int | None = None,
        word_id: int | None = None,
        note_id: int | None = None,
    ):
        self.id = id
        self.word_id = word_id
        self.note_id = note_id

    @classmethod
    def link(cls, word_id: int, note_id: int) -> None:
        """Insert a word→note link, ignoring duplicates (UNIQUE index enforced)."""
        cls._db.execute(
            f"INSERT OR IGNORE INTO {cls._table} (word_id, note_id) VALUES (?, ?)",
            (word_id, note_id),
            commit=True,
        )

    @classmethod
    def bulk_link(cls, pairs: list[tuple[int, int]]) -> int:
        """Insert many word→note links with OR IGNORE in chunks."""
        if not pairs:
            return 0

        inserted = 0
        with cls._db.transaction():
            for start in range(0, len(pairs), 500):
                chunk = pairs[start : start + 500]
                cur = cls._db.executemany(
                    f"INSERT OR IGNORE INTO {cls._table} (word_id, note_id) VALUES (?, ?)",
                    chunk,
                    commit=False,
                )
                if cur.rowcount is not None and cur.rowcount > 0:
                    inserted += cur.rowcount
        return inserted


class CardKanjiLinksTable(SQLiteDBTable):
    """Join table linking Anki cards to individual kanji characters."""

    _table = "card_kanji_links"
    _fields = ["card_id", "kanji_id"]
    _types = [int, int, int]  # id (auto), card_id, kanji_id
    _pk = "id"
    _auto_increment = True

    def __init__(
        self,
        id: int | None = None,
        card_id: int | None = None,
        kanji_id: int | None = None,
    ):
        self.id = id
        self.card_id = card_id
        self.kanji_id = kanji_id

    @classmethod
    def link(cls, card_id: int, kanji_id: int) -> None:
        """Insert a card→kanji link, ignoring duplicates (UNIQUE index enforced)."""
        cls._db.execute(
            f"INSERT OR IGNORE INTO {cls._table} (card_id, kanji_id) VALUES (?, ?)",
            (card_id, kanji_id),
            commit=True,
        )

    @classmethod
    def bulk_link(cls, pairs: list[tuple[int, int]]) -> int:
        """Insert many card→kanji links with OR IGNORE in chunks."""
        if not pairs:
            return 0

        inserted = 0
        with cls._db.transaction():
            for start in range(0, len(pairs), 500):
                chunk = pairs[start : start + 500]
                cur = cls._db.executemany(
                    f"INSERT OR IGNORE INTO {cls._table} (card_id, kanji_id) VALUES (?, ?)",
                    chunk,
                    commit=False,
                )
                if cur.rowcount is not None and cur.rowcount > 0:
                    inserted += cur.rowcount
        return inserted


# ---------------------------------------------------------------------------
# Setup / teardown / index helpers
# ---------------------------------------------------------------------------

_ANKI_TABLE_CLASSES = [
    AnkiNotesTable,
    AnkiCardsTable,
    AnkiReviewsTable,
    WordAnkiLinksTable,
    CardKanjiLinksTable,
]


def _create_anki_indexes(db: SQLiteDB) -> None:
    """Create indexes for the Anki cache tables.

    Includes lookup indexes on foreign keys and UNIQUE indexes on the link tables
    to enforce the (word_id, note_id) and (card_id, kanji_id) constraints.
    """
    # Lookup index: cards by note
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_anki_cards_note_id ON anki_cards(note_id)",
        commit=True,
    )
    # Lookup index: reviews by card
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_anki_reviews_card_id ON anki_reviews(card_id)",
        commit=True,
    )
    # UNIQUE constraint on word_anki_links(word_id, note_id)
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_word_anki_links_unique ON word_anki_links(word_id, note_id)",
        commit=True,
    )
    # Lookup index: word_anki_links by word_id
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_word_anki_links_word_id ON word_anki_links(word_id)",
        commit=True,
    )
    # Lookup index: word_anki_links by note_id
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_word_anki_links_note_id ON word_anki_links(note_id)",
        commit=True,
    )
    # UNIQUE constraint on card_kanji_links(card_id, kanji_id)
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_card_kanji_links_unique ON card_kanji_links(card_id, kanji_id)",
        commit=True,
    )
    # Lookup index: card_kanji_links by card_id
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_card_kanji_links_card_id ON card_kanji_links(card_id)",
        commit=True,
    )
    # Lookup index: card_kanji_links by kanji_id
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_card_kanji_links_kanji_id ON card_kanji_links(kanji_id)",
        commit=True,
    )


def setup_anki_tables(db: SQLiteDB) -> None:
    """Register all Anki cache tables with the database and create indexes."""
    for cls in _ANKI_TABLE_CLASSES:
        cls.set_db(db)

    _create_anki_indexes(db)
    logger.info("Anki cache tables setup complete")


def teardown_anki_tables(db: SQLiteDB) -> None:
    """Drop all Anki cache tables (used when feature is disabled)."""
    # Drop link tables first (reference the main tables)
    for cls in reversed(_ANKI_TABLE_CLASSES):
        cls._db = db
        cls._column_order_cache = None
        cls._row_field_mapping_cache = None
        db.execute(f"DROP TABLE IF EXISTS {cls._table}", commit=True)

    logger.info("Anki cache tables teardown complete")


def _migrate_anki_card_sync_cron() -> None:
    """Register the ANKI_CARD_SYNC daily cron if not present, disable anki_word_sync."""
    from datetime import datetime, timedelta
    from GameSentenceMiner.util.database.cron_table import CronTable

    # Register anki_card_sync cron if it doesn't exist yet
    existing = CronTable.get_by_name("anki_card_sync")
    if not existing:
        one_minute_ago = (datetime.now() - timedelta(minutes=1)).timestamp()
        CronTable.create_cron_entry(
            name="anki_card_sync",
            description="Daily full sync of Anki notes, cards, and reviews to local cache",
            next_run=one_minute_ago,
            schedule="daily",
        )
        logger.info("Created anki_card_sync cron job")
    else:
        if not existing.enabled:
            existing.enabled = True
            existing.next_run = (datetime.now() - timedelta(minutes=1)).timestamp()
            existing.save()
            logger.info("Re-enabled anki_card_sync cron job")

    # Disable the old anki_word_sync cron (superseded by anki_card_sync)
    old_cron = CronTable.get_by_name("anki_word_sync")
    if old_cron and old_cron.enabled:
        old_cron.enabled = False
        old_cron.save()
        logger.info("Disabled anki_word_sync cron job (superseded by anki_card_sync)")


def _disable_anki_card_sync_cron() -> None:
    """Disable the Anki cache sync cron when tokenization is off."""
    from GameSentenceMiner.util.database.cron_table import CronTable

    existing = CronTable.get_by_name("anki_card_sync")
    if existing and existing.enabled:
        existing.enabled = False
        existing.save()
        logger.info("Disabled anki_card_sync cron job")


try:
    import GameSentenceMiner.util.database.db as _db_mod

    if getattr(_db_mod, "_pending_tokenization_schema_sync", False):
        _db_mod._pending_tokenization_schema_sync = False
        _db_mod.sync_tokenization_schema_state(_db_mod.gsm_db)
except Exception:
    pass
