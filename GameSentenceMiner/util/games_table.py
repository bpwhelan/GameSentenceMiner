import uuid
import re
from difflib import SequenceMatcher
from typing import Optional, List, Dict

from GameSentenceMiner.util.db import SQLiteDBTable
from GameSentenceMiner.util.configuration import logger


class GamesTable(SQLiteDBTable):
    _table = "games"
    _fields = [
        "deck_id",
        "title_original",
        "title_romaji",
        "title_english",
        "type",
        "description",
        "image",
        "character_count",
        "difficulty",
        "links",
        "completed",
        "release_date",
        "manual_overrides",
        "obs_scene_name",
    ]
    _types = [
        str,  # id (primary key)
        int,  # deck_id
        str,  # title_original
        str,  # title_romaji
        str,  # title_english
        str,  # type (string)
        str,  # description
        str,  # image (base64)
        int,  # character_count
        int,  # difficulty
        list,  # links (stored as JSON)
        bool,  # completed
        str,  # release_date (ISO date string)
        list,  # manual_overrides (stored as JSON)
        str,  # obs_scene_name (immutable OBS scene name)
    ]
    _pk = "id"
    _auto_increment = False  # UUID-based primary key

    def __init__(
        self,
        id: Optional[str] = None,
        deck_id: Optional[int] = None,
        title_original: Optional[str] = None,
        title_romaji: Optional[str] = None,
        title_english: Optional[str] = None,
        game_type: Optional[str] = None,
        description: Optional[str] = None,
        image: Optional[str] = None,
        character_count: int = 0,
        difficulty: Optional[int] = None,
        links: Optional[List[Dict]] = None,
        completed: bool = False,
        release_date: Optional[str] = None,
        manual_overrides: Optional[List[str]] = None,
        obs_scene_name: Optional[str] = None,
    ):
        self.id = id if id else str(uuid.uuid4())
        self.deck_id = deck_id
        self.title_original = title_original if title_original else ""
        self.title_romaji = title_romaji if title_romaji else ""
        self.title_english = title_english if title_english else ""
        self.type = game_type if game_type else ""
        self.description = description if description else ""
        self.image = image if image else ""
        self.character_count = character_count
        self.difficulty = difficulty
        self.links = links if links else []
        self.completed = completed
        self.release_date = release_date if release_date else ""
        self.manual_overrides = manual_overrides if manual_overrides else []
        self.obs_scene_name = obs_scene_name if obs_scene_name else ""

    @classmethod
    def get_by_deck_id(cls, deck_id: int) -> Optional["GamesTable"]:
        """Get a game by its jiten.moe deck ID."""
        row = cls._db.fetchone(
            f"SELECT * FROM {cls._table} WHERE deck_id=?", (deck_id,)
        )
        return cls.from_row(row) if row else None

    @classmethod
    def get_by_title(cls, title_original: str) -> Optional["GamesTable"]:
        """Get a game by its original title."""
        row = cls._db.fetchone(
            f"SELECT * FROM {cls._table} WHERE title_original=?", (title_original,)
        )
        return cls.from_row(row) if row else None

    @classmethod
    def get_by_obs_scene_name(cls, obs_scene_name: str) -> Optional["GamesTable"]:
        """Get a game by its OBS scene name."""
        row = cls._db.fetchone(
            f"SELECT * FROM {cls._table} WHERE obs_scene_name=?", (obs_scene_name,)
        )
        return cls.from_row(row) if row else None

    @classmethod
    def normalize_game_name(cls, name: str) -> str:
        """
        Normalize a game name for fuzzy matching.
        Removes version numbers, extra whitespace, and converts to lowercase.
        """
        if not name:
            return ""
        # Remove version patterns like "ver1.00", "v1.0", "Ver.1.0", etc.
        normalized = re.sub(
            r"\s*v(?:er)?\.?\s*\d+(?:\.\d+)*", "", name, flags=re.IGNORECASE
        )
        # Remove extra whitespace
        normalized = " ".join(normalized.split())
        # Convert to lowercase for comparison
        return normalized.lower().strip()

    @classmethod
    def fuzzy_match_game_name(
        cls, name1: str, name2: str, threshold: float = 0.85
    ) -> bool:
        """
        Check if two game names are similar using fuzzy matching.

        Args:
            name1: First game name
            name2: Second game name
            threshold: Similarity threshold (0.0 to 1.0), default 0.85

        Returns:
            True if names are similar enough, False otherwise
        """
        if not name1 or not name2:
            return False

        # Normalize both names
        norm1 = cls.normalize_game_name(name1)
        norm2 = cls.normalize_game_name(name2)

        # Calculate similarity ratio
        similarity = SequenceMatcher(None, norm1, norm2).ratio()

        logger.debug(
            f"[FUZZY_MATCH] Comparing '{name1}' vs '{name2}': normalized='{norm1}' vs '{norm2}', similarity={similarity:.2f}, threshold={threshold}"
        )

        return similarity >= threshold

    @classmethod
    def find_similar_game(
        cls, game_name: str, threshold: float = 0.85
    ) -> Optional["GamesTable"]:
        """
        Find a game with a similar name using fuzzy matching.

        Args:
            game_name: The game name to search for
            threshold: Similarity threshold (default 0.85)

        Returns:
            GamesTable: The similar game if found, None otherwise
        """
        # Get all games
        all_games = cls.all()

        for game in all_games:
            # Check against title_original
            if cls.fuzzy_match_game_name(game_name, game.title_original, threshold):
                logger.debug(
                    f"[FUZZY_MATCH] Found similar game by title_original: '{game_name}' matches '{game.title_original}' (id={game.id})"
                )
                return game

            # Check against obs_scene_name if it exists
            if game.obs_scene_name and cls.fuzzy_match_game_name(
                game_name, game.obs_scene_name, threshold
            ):
                logger.debug(
                    f"[FUZZY_MATCH] Found similar game by obs_scene_name: '{game_name}' matches '{game.obs_scene_name}' (id={game.id})"
                )
                return game

        return None

    @classmethod
    def get_or_create_by_name(cls, game_name: str) -> "GamesTable":
        """
        Get an existing game by name, or create a new one if it doesn't exist.
        This is the primary method for automatically linking game_lines to games.

        Args:
            game_name: The original game name (from game_lines.game_name / OBS scene name)

        Returns:
            GamesTable: The existing or newly created game record
        """
        logger.debug(f"[GET_OR_CREATE] Looking up game: '{game_name}'")

        # Try exact match on title_original first
        existing = cls.get_by_title(game_name)
        if existing:
            logger.debug(
                f"[GET_OR_CREATE] Found exact match in games table: id={existing.id}, deck_id={existing.deck_id}"
            )
            return existing

        logger.debug(
            f"[GET_OR_CREATE] No exact match found, checking game_lines for existing mapping..."
        )

        # Check if existing game_lines already have this game_name mapped to a game_id
        # This handles cases where OBS scene name != game title_original
        from GameSentenceMiner.util.db import GameLinesTable

        # First, let's see what game_names exist in game_lines
        all_game_names = GameLinesTable._db.fetchall(
            f"SELECT DISTINCT game_name FROM {GameLinesTable._table} LIMIT 10"
        )
        logger.debug(
            f"[GET_OR_CREATE] Sample game_names in game_lines: {[row[0] for row in all_game_names]}"
        )

        # Now try to find our specific game_name
        existing_line = GameLinesTable._db.fetchone(
            f"SELECT game_id FROM {GameLinesTable._table} WHERE game_name=? AND game_id IS NOT NULL AND game_id != '' LIMIT 1",
            (game_name,),
        )

        if existing_line and existing_line[0]:
            game_id = existing_line[0]
            logger.debug(
                f"[GET_OR_CREATE] Found existing mapping in game_lines: '{game_name}' -> game_id={game_id}"
            )
            existing_game = cls.get(game_id)
            if existing_game:
                logger.debug(
                    f"[GET_OR_CREATE] ✓ Reusing existing game: '{game_name}' -> game_id={game_id} ('{existing_game.title_original}', deck_id={existing_game.deck_id})"
                )
                return existing_game
            else:
                logger.warning(
                    f"[GET_OR_CREATE] game_id {game_id} found in game_lines but not in games table!"
                )
        else:
            logger.debug(
                f"[GET_OR_CREATE] No existing mapping found in game_lines for '{game_name}'"
            )

        # No existing mapping found - create new UNLINKED game with minimal info
        # Store the OBS scene name in obs_scene_name field for future linking
        new_game = cls(
            title_original=game_name,
            title_romaji="",
            title_english="",
            description="",
            difficulty=None,
            completed=False,
            obs_scene_name=game_name,  # Store original OBS scene name
        )
        new_game.add()  # Use add() instead of save() for new records with UUID primary keys
        logger.debug(
            f"[GET_OR_CREATE] ✗ Created new UNLINKED game record: '{game_name}' (id={new_game.id}, obs_scene_name='{game_name}')"
        )
        logger.debug(
            f"[GET_OR_CREATE] ℹ️ This game needs to be manually linked to jiten.moe via the Games Management interface"
        )
        return new_game

    @classmethod
    def get_all_completed(cls) -> List["GamesTable"]:
        """Get all completed games."""
        rows = cls._db.fetchall(f"SELECT * FROM {cls._table} WHERE completed=1")
        return [cls.from_row(row) for row in rows]

    @classmethod
    def get_all_in_progress(cls) -> List["GamesTable"]:
        """Get all games that are in progress (not completed)."""
        rows = cls._db.fetchall(f"SELECT * FROM {cls._table} WHERE completed=0")
        return [cls.from_row(row) for row in rows]

    @classmethod
    def get_start_date(cls, game_id: str) -> Optional[float]:
        """
        Get the start date (timestamp of first line) for a game.
        Returns Unix timestamp (float) or None if no lines exist.
        """
        from GameSentenceMiner.util.db import GameLinesTable

        result = GameLinesTable._db.fetchone(
            f"SELECT MIN(timestamp) FROM {GameLinesTable._table} WHERE game_id=?",
            (game_id,),
        )
        return result[0] if result and result[0] else None

    @classmethod
    def get_last_played_date(cls, game_id: str) -> Optional[float]:
        """
        Get the last played date (timestamp of most recent line) for a game.
        Returns Unix timestamp (float) or None if no lines exist.
        """
        from GameSentenceMiner.util.db import GameLinesTable

        result = GameLinesTable._db.fetchone(
            f"SELECT MAX(timestamp) FROM {GameLinesTable._table} WHERE game_id=?",
            (game_id,),
        )
        return result[0] if result and result[0] else None

    def is_field_manual(self, field_name: str) -> bool:
        """
        Check if a field has been manually edited and should not be auto-updated.

        Args:
            field_name: The name of the field to check

        Returns:
            True if the field is manually overridden, False otherwise
        """
        return field_name in self.manual_overrides

    def mark_field_manual(self, field_name: str):
        """
        Mark a field as manually edited so it won't be auto-updated.

        Args:
            field_name: The name of the field to mark as manual
        """
        if field_name not in self.manual_overrides and field_name in self._fields:
            self.manual_overrides.append(field_name)
            logger.debug(
                f"Marked field '{field_name}' as manually overridden for game {self.id}"
            )

    def update_all_fields_manual(
        self,
        deck_id: Optional[int] = None,
        title_original: Optional[str] = None,
        title_romaji: Optional[str] = None,
        title_english: Optional[str] = None,
        game_type: Optional[str] = None,
        description: Optional[str] = None,
        image: Optional[str] = None,
        character_count: Optional[int] = None,
        difficulty: Optional[int] = None,
        links: Optional[List[Dict]] = None,
        completed: Optional[bool] = None,
        release_date: Optional[str] = None,
    ):
        """
        Update all fields of the game at once. Only provided fields will be updated.
        Fields that are updated will be automatically marked as manually overridden.

        Args:
            deck_id: jiten.moe deck ID
            title_original: Original Japanese title
            title_romaji: Romanized title
            title_english: English translated title
            game_type: Game type (string)
            description: Game description
            image: Base64-encoded image data
            character_count: Total character count
            difficulty: Difficulty rating
            links: List of link objects
            completed: Whether the game is completed
            release_date: Release date (ISO format string)
        """
        if deck_id is not None:
            self.deck_id = deck_id
            self.mark_field_manual("deck_id")
        if title_original is not None:
            self.title_original = title_original
            self.mark_field_manual("title_original")
        if title_romaji is not None:
            self.title_romaji = title_romaji
            self.mark_field_manual("title_romaji")
        if title_english is not None:
            self.title_english = title_english
            self.mark_field_manual("title_english")
        if game_type is not None:
            self.type = game_type
            self.mark_field_manual("type")
        if description is not None:
            self.description = description
            self.mark_field_manual("description")
        if image is not None:
            self.image = image
            self.mark_field_manual("image")
        if character_count is not None:
            self.character_count = character_count
            self.mark_field_manual("character_count")
        if difficulty is not None:
            self.difficulty = difficulty
            self.mark_field_manual("difficulty")
        if links is not None:
            self.links = links
            self.mark_field_manual("links")
        if completed is not None:
            self.completed = completed
            self.mark_field_manual("completed")
        if release_date is not None:
            self.release_date = release_date
            self.mark_field_manual("release_date")

        self.save()
        logger.debug(f"Updated game {self.id} ({self.title_original})")

    def update_all_fields_from_jiten(
        self,
        deck_id: Optional[int] = None,
        title_original: Optional[str] = None,
        title_romaji: Optional[str] = None,
        title_english: Optional[str] = None,
        game_type: Optional[str] = None,
        description: Optional[str] = None,
        image: Optional[str] = None,
        character_count: Optional[int] = None,
        difficulty: Optional[int] = None,
        links: Optional[List[Dict]] = None,
        completed: Optional[bool] = None,
        release_date: Optional[str] = None,
    ):
        """
        Update all fields of the game at once. Only provided fields will be updated.

        Args:
            deck_id: jiten.moe deck ID
            title_original: Original Japanese title
            title_romaji: Romanized title
            title_english: English translated title
            game_type: Game type (string)
            description: Game description
            image: Base64-encoded image data
            character_count: Total character count
            difficulty: Difficulty rating
            links: List of link objects
            completed: Whether the game is completed
            release_date: Release date (ISO format string)
        """
        if deck_id is not None:
            self.deck_id = deck_id
        if title_original is not None:
            self.title_original = title_original
        if title_romaji is not None:
            self.title_romaji = title_romaji
        if title_english is not None:
            self.title_english = title_english
        if game_type is not None:
            self.type = game_type
        if description is not None:
            self.description = description
        if image is not None:
            self.image = image
        if character_count is not None:
            self.character_count = character_count
        if difficulty is not None:
            self.difficulty = difficulty
        if links is not None:
            self.links = links
        if completed is not None:
            self.completed = completed
        if release_date is not None:
            logger.debug(
                f"📅 GamesTable.update_all_fields_from_jiten: Setting release_date for game {self.id} to '{release_date}' (type: {type(release_date)})"
            )
            self.release_date = release_date
        else:
            logger.debug(
                f"⏭️ GamesTable.update_all_fields_from_jiten: release_date is None for game {self.id}"
            )
        self.save()
        logger.debug(
            f"Updated game {self.id} ({self.title_original}) - final release_date: '{self.release_date}'"
        )

    def add_link(self, link_type: int, url: str, link_id: Optional[int] = None):
        """
        Add a link to the game's links array and persist to database.

        Args:
            link_type: Type of link (e.g., 4 for AniList, 5 for MyAnimeList)
            url: URL of the link
            link_id: Optional link ID

        Note:
            Changes are automatically saved to the database.
        """
        new_link = {"linkType": link_type, "url": url, "deckId": self.deck_id}
        if link_id is not None:
            new_link["linkId"] = link_id

        self.links.append(new_link)
        self.save()

    def get_lines(self) -> List:
        """Get all lines associated with this game."""
        from GameSentenceMiner.util.db import GameLinesTable

        rows = GameLinesTable._db.fetchall(
            f"SELECT * FROM {GameLinesTable._table} WHERE game_id=?", (self.id,)
        )
        return [GameLinesTable.from_row(row) for row in rows]

    @classmethod
    def get_by_game_line(cls, game_line) -> Optional["GamesTable"]:
        """
        Get game metadata from a game_line record using the game_id relationship.
        Falls back to name-based lookup if game_id is missing or invalid.

        Args:
            game_line: A GameLinesTable record

        Returns:
            GamesTable: The game record, or None if not found
        """
        logger.debug(
            f"[GET_BY_GAME_LINE] Looking up game for line with game_name='{game_line.game_name if hasattr(game_line, 'game_name') else 'N/A'}', game_id='{game_line.game_id if hasattr(game_line, 'game_id') else 'N/A'}'"
        )

        # First try using game_id relationship if it exists
        if (
            hasattr(game_line, "game_id")
            and game_line.game_id
            and game_line.game_id.strip()
        ):
            logger.debug(
                f"[GET_BY_GAME_LINE] Attempting lookup by game_id: '{game_line.game_id}'"
            )
            game = cls.get(game_line.game_id)
            if game:
                logger.debug(
                    f"[GET_BY_GAME_LINE] ✓ Found game by game_id: title_original='{game.title_original}', deck_id={game.deck_id}, has_image={bool(game.image)}"
                )
                return game
            else:
                logger.warning(
                    f"[GET_BY_GAME_LINE] game_id '{game_line.game_id}' not found in games table, falling back to name lookup"
                )
        else:
            logger.debug(
                f"[GET_BY_GAME_LINE] No valid game_id, falling back to name lookup"
            )

        # Fallback to name-based lookup
        if hasattr(game_line, "game_name") and game_line.game_name:
            logger.debug(
                f"[GET_BY_GAME_LINE] Attempting lookup by game_name: '{game_line.game_name}'"
            )
            game = cls.get_by_title(game_line.game_name)
            if game:
                logger.debug(
                    f"[GET_BY_GAME_LINE] ✓ Found game by name: title_original='{game.title_original}', deck_id={game.deck_id}, has_image={bool(game.image)}"
                )
            else:
                logger.debug(
                    f"[GET_BY_GAME_LINE] ✗ No game found by name: '{game_line.game_name}'"
                )
            return game

        logger.warning(
            f"[GET_BY_GAME_LINE] ✗ No game found for line (no game_id or game_name)"
        )
        return None
