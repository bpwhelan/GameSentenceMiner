import base64
import io
import json
import zipfile
from datetime import datetime
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from GameSentenceMiner.util.games_table import GamesTable


class YomitanDictBuilder:
    """Builder for creating Yomitan-compatible dictionary files from VNDB character data."""
    
    DICT_TITLE = "GSM (Do not delete)"
    
    def __init__(self, revision: str = None, download_url: str = None):
        """
        Initialize the dictionary builder.
        
        Args:
            revision: Version string (defaults to current date YYYY.MM.DD)
            download_url: URL for Yomitan auto-update feature
        """
        self.title = self.DICT_TITLE
        self.revision = revision or datetime.now().strftime("%Y.%m.%d")
        self.download_url = download_url  # For auto-update support
        self.entries = []  # Term bank entries
        self.images = {}   # char_id -> (filename, bytes)
        self.tags = set()  # Role tags used
        self.game_titles = []  # Track which games are included

    def _decode_image(self, base64_data: str, char_id: str) -> tuple[str, bytes]:
        """
        Decode a base64-encoded image.
        
        Args:
            base64_data: Base64 string, may include data URI prefix
            char_id: Character ID for generating filename
            
        Returns:
            Tuple of (filename, image_bytes)
        """
        # Strip "data:image/jpeg;base64," or similar prefix if present
        if ',' in base64_data:
            # Handle data URI format: "data:image/jpeg;base64,..."
            header, base64_data = base64_data.split(',', 1)
            # Determine extension from header
            if 'png' in header.lower():
                ext = 'png'
            elif 'gif' in header.lower():
                ext = 'gif'
            elif 'webp' in header.lower():
                ext = 'webp'
            else:
                ext = 'jpg'  # Default to jpg
        else:
            ext = 'jpg'  # Default extension
        
        # Decode base64 to bytes
        image_bytes = base64.b64decode(base64_data)
        filename = f"c{char_id}.{ext}"
        
        return filename, image_bytes

    def _build_structured_content(self, char: dict, image_path: str | None, game_title: str) -> dict:
        """
        Build Yomitan structured content for a character card.
        
        Args:
            char: Character data dictionary with fields like:
                - name: romanized name
                - name_original: Japanese name (kanji)
                - role: main/primary/side/appears
                - sex: m/f
                - age: character age
                - height: height in cm
                - blood_type: A/B/O/AB
                - personality: list of trait names
                - description: character bio text
                - image_base64: base64 image (handled elsewhere)
            image_path: Path to image within ZIP (e.g., "img/c12345.jpg") or None
            game_title: Name of the VN this character is from
            
        Returns:
            Yomitan structured content object
        """
        # Role color mapping
        ROLE_COLORS = {
            "main": "#4CAF50",      # green
            "primary": "#2196F3",   # blue
            "side": "#FF9800",      # orange
            "appears": "#9E9E9E",   # gray
        }
        
        # Role display labels
        ROLE_LABELS = {
            "main": "Protagonist",
            "primary": "Main Character",
            "side": "Side Character",
            "appears": "Minor Role",
        }
        
        # Sex display mapping
        SEX_DISPLAY = {
            "m": "♂ Male",
            "f": "♀ Female",
        }
        
        content = []
        
        # Header: Japanese name (large, bold)
        name_original = char.get("name_original")
        if name_original:
            content.append({
                "tag": "div",
                "style": {"fontWeight": "bold", "fontSize": "1.2em"},
                "content": name_original
            })
        
        # Romanized name below (italic, gray)
        name = char.get("name")
        if name:
            content.append({
                "tag": "div",
                "style": {"fontStyle": "italic", "color": "#666", "marginBottom": "8px"},
                "content": name
            })
        
        # Image (if available)
        if image_path:
            content.append({
                "tag": "img",
                "path": image_path,
                "width": 80,
                "height": 100,
                "sizeUnits": "px",
                "collapsible": False,
                "collapsed": False,
                "background": False
            })
        
        # Game title (which VN this character is from)
        if game_title:
            content.append({
                "tag": "div",
                "style": {"fontSize": "0.9em", "color": "#888", "marginTop": "4px"},
                "content": f"From: {game_title}"
            })
        
        # Role badge with color based on role
        role = char.get("role")
        if role and role in ROLE_LABELS:
            role_color = ROLE_COLORS.get(role, "#9E9E9E")
            role_label = ROLE_LABELS.get(role, role.title())
            content.append({
                "tag": "span",
                "style": {
                    "background": role_color,
                    "color": "white",
                    "padding": "2px 6px",
                    "borderRadius": "3px",
                    "fontSize": "0.85em"
                },
                "content": role_label
            })
        
        # Stats line (sex, age, height, blood type) - combine on one line
        stats_parts = []
        
        sex = char.get("sex")
        if sex and sex in SEX_DISPLAY:
            stats_parts.append(SEX_DISPLAY[sex])
        
        age = char.get("age")
        if age:
            stats_parts.append(f"{age} years old")
        
        height = char.get("height")
        if height:
            stats_parts.append(f"{height}cm")
        
        blood_type = char.get("blood_type")
        if blood_type:
            stats_parts.append(f"Blood: {blood_type}")
        
        if stats_parts:
            content.append({
                "tag": "div",
                "style": {"marginTop": "8px", "fontSize": "0.9em"},
                "content": " • ".join(stats_parts)
            })
        
        # Personality traits as bullet list (if available)
        personality = char.get("personality")
        if personality and isinstance(personality, list) and len(personality) > 0:
            trait_items = [{"tag": "li", "content": trait} for trait in personality]
            content.append({
                "tag": "ul",
                "style": {"marginTop": "8px", "paddingLeft": "20px"},
                "content": trait_items
            })
        
        # Collapsible description (if available)
        description = char.get("description")
        if description and description.strip():
            content.append({
                "tag": "details",
                "content": [
                    {"tag": "summary", "content": "Description"},
                    {
                        "tag": "div",
                        "style": {"fontSize": "0.9em", "marginTop": "4px"},
                        "content": description
                    }
                ]
            })
        
        return {
            "type": "structured-content",
            "content": content
        }

    def _get_score(self, role: str) -> int:
        """
        Return priority score based on character role.
        
        Args:
            role: Character role (main/primary/side/appears)
            
        Returns:
            Score value for Yomitan dictionary ordering
        """
        ROLE_SCORES = {
            "main": 100,      # Protagonist
            "primary": 75,    # Main characters
            "side": 50,       # Side characters
            "appears": 25,    # Minor appearances
        }
        return ROLE_SCORES.get(role, 0)

    def add_character(self, char: dict, game_title: str) -> None:
        """
        Process a single character and create term entries.
        
        Args:
            char: Character data dictionary with fields like id, name, name_original,
                  role, aliases, image_base64, etc.
            game_title: Name of the VN this character is from
        """
        # Extract the primary term (Japanese name)
        term = char.get("name_original", "")
        if not term:
            # Fallback to romanized name if no Japanese name
            term = char.get("name", "")
        
        if not term:
            # Skip characters with no name
            return
        
        # Use romanized name as the reading
        reading = char.get("name", "")
        
        # Get role and score
        role = char.get("role", "")
        score = self._get_score(role)
        
        # Handle image if present
        image_path = None
        if char.get("image_base64"):
            filename, image_bytes = self._decode_image(char["image_base64"], char["id"])
            self.images[char["id"]] = (filename, image_bytes)
            image_path = f"img/{filename}"
        
        # Build the structured content
        structured_content = self._build_structured_content(char, image_path, game_title)
        
        # Create the term entry in Yomitan format
        entry = [
            term,                      # term - Japanese name (kanji)
            reading,                   # reading - romaji/kana
            f"name {role}" if role else "name",  # definitionTags - role tags
            "",                        # rules - empty for names
            score,                     # score - from _get_score
            [structured_content],      # definitions
            0,                         # sequence
            ""                         # termTags
        ]
        self.entries.append(entry)
        
        # Add role to tags set
        if role:
            self.tags.add(role)
        
        # Create additional entries for aliases
        aliases = char.get("aliases", [])
        if aliases and isinstance(aliases, list):
            for alias in aliases:
                if alias and alias != term:  # Skip empty or duplicate aliases
                    alias_entry = [
                        alias,                     # term - alias
                        reading,                   # reading - same as main entry
                        f"name {role}" if role else "name",  # definitionTags
                        "",                        # rules
                        score,                     # score - same priority
                        [structured_content],      # definitions - same content
                        0,                         # sequence
                        ""                         # termTags
                    ]
                    self.entries.append(alias_entry)

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
        categories = ["main", "primary", "side", "appears"]
        
        character_count = 0
        
        # Loop through all categories and add characters
        for category in categories:
            characters = char_data.get(category, [])
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
            - description: Lists included game titles
            - downloadUrl: For auto-update support (if set)
        """
        # Build description from included game titles
        games_desc = ", ".join(self.game_titles) if self.game_titles else "No games"
        
        index = {
            "title": self.title,  # "GSM (Do not delete)"
            "revision": self.revision,  # Current date: "2026.01.01"
            "format": 3,  # Yomitan dictionary format version
            "author": "GameSentenceMiner",
            "description": f"Character names from: {games_desc}"
        }
        
        # Add downloadUrl for auto-update support
        if self.download_url:
            index["downloadUrl"] = self.download_url
        
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
