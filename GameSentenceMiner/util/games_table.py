import uuid
from typing import Optional, List, Dict

from GameSentenceMiner.util.db import SQLiteDBTable
from GameSentenceMiner.util.configuration import logger


class GamesTable(SQLiteDBTable):
    _table = 'games'
    _fields = [
        'deck_id', 'title_original', 'title_romaji', 'title_english',
        'type',
        'description', 'image', 'character_count', 'difficulty', 'links', 'completed',
        'manual_overrides'
    ]
    _types = [
        str,      # id (primary key)
        int,      # deck_id
        str,      # title_original
        str,      # title_romaji
        str,      # title_english
        str,      # type (string)
        str,      # description
        str,      # image (base64)
        int,      # character_count
        int,      # difficulty
        list,     # links (stored as JSON)
        bool,     # completed
        list      # manual_overrides (stored as JSON)
    ]
    _pk = 'id'
    _auto_increment = False  # UUID-based primary key

    def __init__(
        self,
        id: Optional[str] = None,
        deck_id: Optional[int] = None,
        title_original: Optional[str] = None,
        title_romaji: Optional[str] = None,
        title_english: Optional[str] = None,
        type: Optional[str] = None,
        description: Optional[str] = None,
        image: Optional[str] = None,
        character_count: int = 0,
        difficulty: Optional[int] = None,
        links: Optional[List[Dict]] = None,
        completed: bool = False,
        manual_overrides: Optional[List[str]] = None
    ):
        self.id = id if id else str(uuid.uuid4())
        self.deck_id = deck_id
        self.title_original = title_original if title_original else ''
        self.title_romaji = title_romaji if title_romaji else ''
        self.title_english = title_english if title_english else ''
        self.type = type if type else ''
        self.description = description if description else ''
        self.image = image if image else ''
        self.character_count = character_count
        self.difficulty = difficulty
        self.links = links if links else []
        self.completed = completed
        self.manual_overrides = manual_overrides if manual_overrides else []

    @classmethod
    def get_by_deck_id(cls, deck_id: int) -> Optional['GamesTable']:
        """Get a game by its jiten.moe deck ID."""
        row = cls._db.fetchone(
            f"SELECT * FROM {cls._table} WHERE deck_id=?", (deck_id,))
        return cls.from_row(row) if row else None

    @classmethod
    def get_by_title(cls, title_original: str) -> Optional['GamesTable']:
        """Get a game by its original title."""
        row = cls._db.fetchone(
            f"SELECT * FROM {cls._table} WHERE title_original=?", (title_original,))
        return cls.from_row(row) if row else None

    @classmethod
    def get_or_create_by_name(cls, game_name: str) -> 'GamesTable':
        """
        Get an existing game by name, or create a new one if it doesn't exist.
        This is the primary method for automatically linking game_lines to games.
        
        Args:
            game_name: The original game name (from game_lines.game_name)
            
        Returns:
            GamesTable: The existing or newly created game record
        """
        # Try to find existing game
        existing = cls.get_by_title(game_name)
        if existing:
            return existing
        
        # Create new game with minimal info
        new_game = cls(
            title_original=game_name,
            title_romaji='',
            title_english='',
            description='',
            difficulty=None,
            completed=False
        )
        new_game.save()
        logger.info(f"Auto-created new game record: {game_name} (id={new_game.id})")
        return new_game

    @classmethod
    def get_all_completed(cls) -> List['GamesTable']:
        """Get all completed games."""
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE completed=1")
        return [cls.from_row(row) for row in rows]

    @classmethod
    def get_all_in_progress(cls) -> List['GamesTable']:
        """Get all games that are in progress (not completed)."""
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE completed=0")
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
            (game_id,)
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
            (game_id,)
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
            logger.debug(f"Marked field '{field_name}' as manually overridden for game {self.id}")

    def update_all_fields_manual(
        self,
        deck_id: Optional[int] = None,
        title_original: Optional[str] = None,
        title_romaji: Optional[str] = None,
        title_english: Optional[str] = None,
        type: Optional[str] = None,
        description: Optional[str] = None,
        image: Optional[str] = None,
        character_count: Optional[int] = None,
        difficulty: Optional[int] = None,
        links: Optional[List[Dict]] = None,
        completed: Optional[bool] = None
    ):
        """
        Update all fields of the game at once. Only provided fields will be updated.
        Fields that are updated will be automatically marked as manually overridden.
        
        Args:
            deck_id: jiten.moe deck ID
            title_original: Original Japanese title
            title_romaji: Romanized title
            title_english: English translated title
            description: Game description
            image: Base64-encoded image data
            character_count: Total character count
            difficulty: Difficulty rating
            links: List of link objects
            completed: Whether the game is completed
        """
        if deck_id is not None:
            self.deck_id = deck_id
            self.mark_field_manual('deck_id')
        if title_original is not None:
            self.title_original = title_original
            self.mark_field_manual('title_original')
        if title_romaji is not None:
            self.title_romaji = title_romaji
            self.mark_field_manual('title_romaji')
        if title_english is not None:
            self.title_english = title_english
            self.mark_field_manual('title_english')
        if type is not None:
            self.type = type
            self.mark_field_manual('type')
        if description is not None:
            self.description = description
            self.mark_field_manual('description')
        if image is not None:
            self.image = image
            self.mark_field_manual('image')
        if character_count is not None:
            self.character_count = character_count
            self.mark_field_manual('character_count')
        if difficulty is not None:
            self.difficulty = difficulty
            self.mark_field_manual('difficulty')
        if links is not None:
            self.links = links
            self.mark_field_manual('links')
        if completed is not None:
            self.completed = completed
            self.mark_field_manual('completed')
        
        self.save()
        logger.info(f"Updated game {self.id} ({self.title_original})")

    def update_all_fields_from_jiten(
        self,
        deck_id: Optional[int] = None,
        title_original: Optional[str] = None,
        title_romaji: Optional[str] = None,
        title_english: Optional[str] = None,
        type: Optional[str] = None,
        description: Optional[str] = None,
        image: Optional[str] = None,
        character_count: Optional[int] = None,
        difficulty: Optional[int] = None,
        links: Optional[List[Dict]] = None,
        completed: Optional[bool] = None
    ):
        """
        Update all fields of the game at once. Only provided fields will be updated.
        
        Args:
            deck_id: jiten.moe deck ID
            title_original: Original Japanese title
            title_romaji: Romanized title
            title_english: English translated title
            description: Game description
            image: Base64-encoded image data
            character_count: Total character count
            difficulty: Difficulty rating
            links: List of link objects
            completed: Whether the game is completed
        """
        if deck_id is not None:
            self.deck_id = deck_id
        if title_original is not None:
            self.title_original = title_original
        if title_romaji is not None:
            self.title_romaji = title_romaji
        if title_english is not None:
            self.title_english = title_english
        if type is not None:
            self.type = type
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
        self.save()
        logger.info(f"Updated game {self.id} ({self.title_original})")

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
        new_link = {
            'linkType': link_type,
            'url': url,
            'deckId': self.deck_id
        }
        if link_id is not None:
            new_link['linkId'] = link_id
        
        self.links.append(new_link)
        self.save()

    def get_lines(self) -> List:
        """Get all lines associated with this game."""
        from GameSentenceMiner.util.db import GameLinesTable
        rows = GameLinesTable._db.fetchall(
            f"SELECT * FROM {GameLinesTable._table} WHERE game_id=?", (self.id,))
        return [GameLinesTable.from_row(row) for row in rows]