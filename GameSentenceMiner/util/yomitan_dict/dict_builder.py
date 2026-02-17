"""Main Yomitan dictionary builder that orchestrates all components."""

import io
import json
import random
import zipfile
from typing import TYPE_CHECKING, Set, List, Dict

from .content_builder import ContentBuilder
from .image_handler import ImageHandler
from .name_parser import NameParser

if TYPE_CHECKING:
    from GameSentenceMiner.util.database.games_table import GamesTable


class YomitanDictBuilder:
    """
    Builder for creating Yomitan-compatible dictionary files from VNDB character data.
    
    This class orchestrates the name parsing, image handling, and content building
    components to create a complete Yomitan dictionary ZIP file.
    """
    
    DICT_TITLE = "GSM Character Dictionary"
    
    # Role scores for prioritization
    ROLE_SCORES = {
        "main": 100,      # Protagonist
        "primary": 75,    # Main characters
        "side": 50,       # Side characters
        "appears": 25,    # Minor appearances
    }
    
    def __init__(self, revision: str = None, download_url: str = None, 
                 game_count: int = 3, spoiler_level: int = 0):
        """
        Initialize the dictionary builder.
        
        Args:
            revision: Version string (defaults to random 12-digit number)
            download_url: URL for Yomitan auto-update feature
            game_count: Number of games requested (for description, default: 3)
            spoiler_level: Maximum spoiler level to include (0=None, 1=Minor, 2=Major, default: 0)
        """
        self.title = self.DICT_TITLE
        self.revision = revision or str(random.randint(100000000000, 999999999999))  # 12 digits
        self.download_url = download_url  # For auto-update support
        self.game_count = game_count  # Track requested game count for description
        self.spoiler_level = spoiler_level  # Maximum spoiler level to include
        self.entries: List[list] = []  # Term bank entries
        self.images: Dict[str, tuple] = {}   # char_id -> (filename, bytes)
        self.tags: Set[str] = set()  # Role tags used
        self.game_titles: List[str] = []  # Track which games are included
        
        # Initialize component classes
        self.name_parser = NameParser()
        self.image_handler = ImageHandler()
        self.content_builder = ContentBuilder(spoiler_level=spoiler_level)
    
    def _get_score(self, role: str) -> int:
        """
        Return priority score based on character role.
        
        Args:
            role: Character role (main/primary/side/appears)
            
        Returns:
            Score value for Yomitan dictionary ordering
        """
        return self.ROLE_SCORES.get(role, 0)
    
    def add_character(self, char: dict, game_title: str) -> None:
        """
        Process a single character and create term entries.
        
        For names containing spaces (e.g., "須々木 心一"), creates 4 entries:
        1. Family name only (須々木) with family name hiragana reading
        2. Given name only (心一) with given name hiragana reading
        3. Combined without space (須々木心一) with full hiragana reading
        4. Original with space (須々木 心一) with full hiragana reading
        
        Reading generation (per-part handling for mixed kanji/kana names):
        - For each name part (family, given) individually:
          - If part contains kanji: Use romanized reading for that part
          - If part is already kana: Use the kana directly (convert katakana to hiragana)
        - Example: "加藤 うみ" → family="かとう" (from romaji), given="うみ" (direct)
        
        Args:
            char: Character data dictionary with fields like id, name, name_original,
                  role, aliases, image_base64, etc.
            game_title: Name of the VN this character is from
        """
        # Extract the primary term (Japanese name)
        name_original = char.get("name_original", "")
        if not name_original:
            # Fallback to romanized name if no Japanese name
            name_original = char.get("name", "")
        
        if not name_original:
            # Skip characters with no name
            return
        
        # Generate hiragana readings using mixed name handling
        # This checks each name part individually:
        # - Parts with kanji: use romanized reading (with order swap)
        # - Parts that are kana: use the kana directly as reading
        romanized_name = char.get("name", "")
        hiragana_readings = self.name_parser.generate_mixed_name_readings(name_original, romanized_name)
        
        # Get role and score
        role = char.get("role", "")
        score = self._get_score(role)
        
        # Handle image if present
        image_path = None
        if char.get("image_base64"):
            filename, image_bytes = self.image_handler.decode_image(char["image_base64"], char["id"])
            self.images[char["id"]] = (filename, image_bytes)
            image_path = f"img/{filename}"
        
        # Build the structured content
        structured_content = self.content_builder.build_structured_content(char, image_path, game_title)
        
        # Add role to tags set
        if role:
            self.tags.add(role)
        
        # Split the name to create multiple searchable entries
        name_parts = self.name_parser.split_japanese_name(name_original)
        
        # Track terms we've added to avoid duplicates
        added_terms = set()
        
        if name_parts['has_space']:
            # Create 4 entries for names with spaces
            
            # 1. Original with space (須々木 心一) - use full hiragana reading
            if name_parts['original'] and name_parts['original'] not in added_terms:
                self.entries.append(self.content_builder.create_term_entry(
                    name_parts['original'], hiragana_readings['full'], role, score, structured_content
                ))
                added_terms.add(name_parts['original'])
            
            # 2. Combined without space (須々木心一) - use full hiragana reading
            if name_parts['combined'] and name_parts['combined'] not in added_terms:
                self.entries.append(self.content_builder.create_term_entry(
                    name_parts['combined'], hiragana_readings['full'], role, score, structured_content
                ))
                added_terms.add(name_parts['combined'])
            
            # 3. Family name only (須々木) - use family hiragana reading
            if name_parts['family'] and name_parts['family'] not in added_terms:
                self.entries.append(self.content_builder.create_term_entry(
                    name_parts['family'], hiragana_readings['family'], role, score, structured_content
                ))
                added_terms.add(name_parts['family'])
            
            # 4. Given name only (心一) - use given hiragana reading
            if name_parts['given'] and name_parts['given'] not in added_terms:
                self.entries.append(self.content_builder.create_term_entry(
                    name_parts['given'], hiragana_readings['given'], role, score, structured_content
                ))
                added_terms.add(name_parts['given'])
        else:
            # Single entry for names without spaces - use full hiragana reading
            self.entries.append(self.content_builder.create_term_entry(
                name_original, hiragana_readings['full'], role, score, structured_content
            ))
            added_terms.add(name_original)
        
        # Create honorific suffix variants for all name entries
        # Store the base names that we created entries for
        base_names_with_readings = []
        
        if name_parts['has_space']:
            # For names with spaces, add honorifics to family, given, combined, and original
            if name_parts['family']:
                base_names_with_readings.append((name_parts['family'], hiragana_readings['family']))
            if name_parts['given']:
                base_names_with_readings.append((name_parts['given'], hiragana_readings['given']))
            if name_parts['combined']:
                base_names_with_readings.append((name_parts['combined'], hiragana_readings['full']))
            if name_parts['original']:
                base_names_with_readings.append((name_parts['original'], hiragana_readings['full']))
        else:
            # For single-word names, just add honorifics to the name itself
            base_names_with_readings.append((name_original, hiragana_readings['full']))
        
        # Add honorific suffix variants
        for base_name, base_reading in base_names_with_readings:
            for suffix, suffix_reading in self.name_parser.HONORIFIC_SUFFIXES:
                term_with_suffix = base_name + suffix
                reading_with_suffix = base_reading + suffix_reading
                
                # Only add if not already present (avoid duplicates)
                if term_with_suffix not in added_terms:
                    self.entries.append(self.content_builder.create_term_entry(
                        term_with_suffix, reading_with_suffix, role, score, structured_content
                    ))
                    added_terms.add(term_with_suffix)
        
        # Create additional entries for aliases - use full hiragana reading
        aliases = char.get("aliases", [])
        if aliases and isinstance(aliases, list):
            for alias in aliases:
                if alias and alias not in added_terms:  # Skip empty or duplicate aliases
                    self.entries.append(self.content_builder.create_term_entry(
                        alias, hiragana_readings['full'], role, score, structured_content
                    ))
                    added_terms.add(alias)
                    
                    # Also add honorific variants for aliases
                    for suffix, suffix_reading in self.name_parser.HONORIFIC_SUFFIXES:
                        alias_with_suffix = alias + suffix
                        reading_with_suffix = hiragana_readings['full'] + suffix_reading
                        
                        if alias_with_suffix not in added_terms:
                            self.entries.append(self.content_builder.create_term_entry(
                                alias_with_suffix, reading_with_suffix, role, score, structured_content
                            ))
                            added_terms.add(alias_with_suffix)
    
    def add_game_characters(self, game: 'GamesTable') -> int:
        """
        Process all characters from a game.
        
        Args:
            game: GamesTable instance with vndb_character_data
            
        Returns:
            Total count of characters added
        """
        # Parse character data JSON if it's a string
        char_data = game.vndb_character_data
        if char_data is None:
            return 0
        
        if isinstance(char_data, str):
            try:
                char_data = json.loads(char_data)
            except json.JSONDecodeError:
                return 0
        
        if not isinstance(char_data, dict):
            return 0
        
        # Extract game title for display
        game_title = game.title_original or game.title_romaji or game.title_english or ""
        
        # Add game title to tracking list
        if game_title:
            self.game_titles.append(game_title)
        
        # Character categories in the data structure
        # VNDB data structure: {"characters": {"main": [...], "primary": [...]}}
        characters_obj = char_data.get("characters", {})
        if not isinstance(characters_obj, dict):
            return 0
        
        categories = ["main", "primary", "side", "appears"]
        
        character_count = 0
        
        # Loop through all categories and add characters
        for category in categories:
            characters = characters_obj.get(category, [])
            if isinstance(characters, list):
                for char in characters:
                    if isinstance(char, dict):
                        self.add_character(char, game_title)
                        character_count += 1
        
        return character_count
    
    def _create_index(self) -> dict:
        """
        Create the dictionary index metadata.
        
        Returns:
            Dictionary containing index.json content with:
            - title: "GSM (Do not delete)"
            - revision: Current date (YYYY.MM.DD)
            - format: 3 (Yomitan dictionary format version)
            - author: "GameSentenceMiner"
            - description: Shows game count and lists included game titles
            - downloadUrl: For auto-update support (if set)
        """
        # Build description with game count and titles
        game_word = "game" if self.game_count == 1 else "games"
        
        if self.game_titles:
            games_list = ", ".join(self.game_titles)
            description = f"Character names from your {self.game_count} most recently played {game_word}: {games_list}"
        else:
            description = f"Character names from your {self.game_count} most recently played {game_word}"
        
        index = {
            "title": self.title,  # "GSM (Do not delete)"
            "revision": self.revision,  # Current date: "2026.01.01"
            "format": 3,  # Yomitan dictionary format version
            "author": "GameSentenceMiner",
            "description": description
        }
        
        # Add downloadUrl for auto-update support
        if self.download_url:
            index["downloadUrl"] = self.download_url
            # Add indexUrl pointing to the metadata endpoint
            index["indexUrl"] = self.download_url.replace("/api/yomitan-dict", "/api/yomitan-index")
            # Mark dictionary as updatable (required for Yomitan to check for updates)
            index["isUpdatable"] = True
        
        return index
    
    def _create_tag_bank(self) -> list:
        """
        Create tag definitions for the dictionary.
        
        Returns:
            List of tag definitions. Each tag is:
            [name, category, order, notes, score]
        """
        # Tag definitions for character roles
        return [
            ["name", "partOfSpeech", 0, "Character name", 0],
            ["main", "name", 0, "Protagonist", 0],
            ["primary", "name", 0, "Main character", 0],
            ["side", "name", 0, "Side character", 0],
            ["appears", "name", 0, "Minor appearance", 0]
        ]
    
    def export_bytes(self) -> bytes:
        """
        Export dictionary as ZIP file bytes.
        
        Returns:
            Bytes of the ZIP file suitable for HTTP response
        """
        # Create in-memory buffer
        buffer = io.BytesIO()
        
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            # 1. Add index.json
            index_data = json.dumps(self._create_index(), ensure_ascii=False, indent=2)
            zf.writestr('index.json', index_data.encode('utf-8'))
            
            # 2. Add tag_bank_1.json
            tag_data = json.dumps(self._create_tag_bank(), ensure_ascii=False)
            zf.writestr('tag_bank_1.json', tag_data.encode('utf-8'))
            
            # 3. Add term_bank_N.json (split if > 10000 entries)
            ENTRIES_PER_BANK = 10000
            for i in range(0, len(self.entries), ENTRIES_PER_BANK):
                chunk = self.entries[i:i + ENTRIES_PER_BANK]
                bank_num = (i // ENTRIES_PER_BANK) + 1
                term_data = json.dumps(chunk, ensure_ascii=False)
                zf.writestr(f'term_bank_{bank_num}.json', term_data.encode('utf-8'))
            
            # 4. Add images to img/ folder
            for char_id, (filename, image_bytes) in self.images.items():
                zf.writestr(f'img/{filename}', image_bytes)
        
        return buffer.getvalue()
    
    def export(self, output_path: str) -> str:
        """
        Export dictionary as ZIP file to disk.
        
        Args:
            output_path: Path to write the ZIP file
            
        Returns:
            The output path
        """
        zip_bytes = self.export_bytes()
        with open(output_path, 'wb') as f:
            f.write(zip_bytes)
        return output_path
