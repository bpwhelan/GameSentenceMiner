import base64
import io
import json
import random
import re
import zipfile
from datetime import datetime
from typing import Optional, TYPE_CHECKING

import jaconv

if TYPE_CHECKING:
    from GameSentenceMiner.util.games_table import GamesTable


class YomitanDictBuilder:
    """Builder for creating Yomitan-compatible dictionary files from VNDB character data."""
    
    DICT_TITLE = "GSM (Do not delete)"
    
    def __init__(self, revision: str = None, download_url: str = None, game_count: int = 3, spoiler_level: int = 0):
        """
        Initialize the dictionary builder.
        
        Args:
            revision: Version string (defaults to current date YYYY.MM.DD)
            download_url: URL for Yomitan auto-update feature
            game_count: Number of games requested (for description, default: 3)
            spoiler_level: Maximum spoiler level to include (0=None, 1=Minor, 2=Major, default: 0)
        """
        self.title = self.DICT_TITLE
        self.revision = revision or str(random.randint(100000000000, 999999999999)) # 12 digits
        self.download_url = download_url  # For auto-update support
        self.game_count = game_count  # Track requested game count for description
        self.spoiler_level = spoiler_level  # Maximum spoiler level to include
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

    def _strip_spoiler_content(self, text: str) -> str:
        """
        Remove spoiler content from text. Handles both VNDB and AniList formats.
        
        VNDB uses: [spoiler]...[/spoiler]
        AniList uses: ~!...!~
        
        Args:
            text: Text potentially containing spoiler tags
            
        Returns:
            Text with spoiler content removed
        """
        if not text:
            return text
        # VNDB: [spoiler]...[/spoiler]
        text = re.sub(r'\[spoiler\].*?\[/spoiler\]', '', text, flags=re.IGNORECASE | re.DOTALL)
        # AniList: ~!...!~
        text = re.sub(r'~!.*?!~', '', text, flags=re.DOTALL)
        return text.strip()

    def _parse_vndb_markup(self, text: str) -> list:
        """
        Parse VNDB markup and convert to Yomitan structured content.
        
        Handles:
        - [url=https://...]text[/url] -> clickable links
        - Plain text sections
        
        Args:
            text: Text potentially containing VNDB markup
            
        Returns:
            List of Yomitan content items (strings and link objects)
        """
        if not text:
            return []
        
        # Pattern to match [url=URL]text[/url]
        url_pattern = re.compile(r'\[url=([^\]]+)\]([^\[]*)\[/url\]', re.IGNORECASE)
        
        result = []
        last_end = 0
        
        for match in url_pattern.finditer(text):
            # Add text before this match
            if match.start() > last_end:
                plain_text = text[last_end:match.start()]
                if plain_text:
                    result.append(plain_text)
            
            # Add the link as structured content
            url = match.group(1)
            link_text = match.group(2)
            result.append({
                "tag": "a",
                "href": url,
                "content": link_text
            })
            
            last_end = match.end()
        
        # Add remaining text after last match
        if last_end < len(text):
            remaining = text[last_end:]
            if remaining:
                result.append(remaining)
        
        # If no matches found, return original text as single item
        if not result:
            return [text]
        
        return result

    def _has_spoiler_tags(self, text: str) -> bool:
        """
        Check if text contains spoiler tags (VNDB or AniList format).
        
        Args:
            text: Text to check for spoiler tags
            
        Returns:
            True if text contains spoiler tags, False otherwise
        """
        if not text:
            return False
        # Check for VNDB format: [spoiler]
        if re.search(r'\[spoiler\]', text, re.IGNORECASE):
            return True
        # Check for AniList format: ~!...!~
        if re.search(r'~!.*?!~', text, flags=re.DOTALL):
            return True
        return False

    def _format_birthday(self, birthday) -> str:
        """
        Format a birthday with month name.
        
        Args:
            birthday: Birthday as [month, day] list or string
            
        Returns:
            Formatted birthday string like "September 1" or empty string
        """
        MONTH_NAMES = {
            1: "January", 2: "February", 3: "March", 4: "April",
            5: "May", 6: "June", 7: "July", 8: "August",
            9: "September", 10: "October", 11: "November", 12: "December"
        }
        
        if isinstance(birthday, list) and len(birthday) >= 2:
            # VNDB format: [month, day]
            month = birthday[0]
            day = birthday[1]
            month_name = MONTH_NAMES.get(month, str(month))
            return f"{month_name} {day}"
        elif isinstance(birthday, str):
            return birthday
        return ""

    def _build_physical_stats_line(self, char: dict) -> str:
        """
        Build a compact inline string for physical attributes.
        
        Example output: "♀ Female • 17 years • 165cm • 50kg • Blood Type A"
        
        Args:
            char: Character data dictionary
            
        Returns:
            Formatted string of physical stats, or empty string if no stats
        """
        SEX_DISPLAY = {
            "m": "♂ Male",
            "f": "♀ Female",
            "male": "♂ Male",
            "female": "♀ Female",
        }
        
        parts = []
        
        sex = char.get("sex")
        if sex:
            sex_lower = sex.lower() if isinstance(sex, str) else sex
            if sex_lower in SEX_DISPLAY:
                parts.append(SEX_DISPLAY[sex_lower])
        
        age = char.get("age")
        if age:
            parts.append(f"{age} years")
        
        height = char.get("height")
        if height:
            parts.append(f"{height}cm")
        
        weight = char.get("weight")
        if weight:
            parts.append(f"{weight}kg")
        
        blood_type = char.get("blood_type")
        if blood_type:
            parts.append(f"Blood Type {blood_type}")
        
        birthday = char.get("birthday")
        if birthday:
            formatted_birthday = self._format_birthday(birthday)
            if formatted_birthday:
                parts.append(f"Birthday: {formatted_birthday}")
        
        return " • ".join(parts)

    def _build_traits_by_category(self, char: dict) -> list:
        """
        Build organized trait items grouped by category.
        
        Args:
            char: Character data dictionary with personality, roles, engages_in, subject_of
            
        Returns:
            List of Yomitan content items for traits
        """
        items = []
        
        # Category definitions with labels
        categories = [
            ("personality", "Personality"),
            ("roles", "Role"),
            ("engages_in", "Activities"),
            ("subject_of", "Subject of"),
        ]
        
        for key, label in categories:
            traits = char.get(key)
            if not traits or not isinstance(traits, list):
                continue
            
            # Filter traits based on spoiler level
            filtered_traits = []
            for trait in traits:
                if isinstance(trait, dict):
                    # New format with spoiler metadata
                    trait_name = trait.get("name", "")
                    trait_spoiler = trait.get("spoiler", 0)
                    # Only include trait if its spoiler level is within our allowed range
                    if trait_name and trait_spoiler <= self.spoiler_level:
                        filtered_traits.append(trait_name)
                elif isinstance(trait, str) and trait:
                    # Old format (plain string) - always include
                    filtered_traits.append(trait)
            
            if filtered_traits:
                # Create a single line with category label and traits
                items.append({
                    "tag": "li",
                    "content": f"{label}: {', '.join(filtered_traits)}"
                })
        
        return items

    def _build_structured_content(self, char: dict, image_path: str | None, game_title: str) -> dict:
        """
        Build Yomitan structured content for a character card.
        
        Spoiler level behavior:
        - Level 0 (No Spoilers): Name, image, game title, role badge only
        - Level 1 (Minor Spoilers): + Description (spoiler tags stripped), + Character info
        - Level 2 (Full Spoilers): + Full description, + All traits
        
        Args:
            char: Character data dictionary with fields like:
                - name: romanized name
                - name_original: Japanese name (kanji)
                - role: main/primary/side/appears
                - sex: m/f
                - age: character age
                - height: height in cm
                - weight: weight in kg
                - blood_type: A/B/O/AB
                - birthday: birthday as list or string
                - personality: list of trait names (with spoiler metadata)
                - roles: list of role traits
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
        
        content = []
        
        # ===== LEVEL 0: Always shown (Name, Image, Game, Role) =====
        
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
                    "fontSize": "0.85em",
                    "marginTop": "4px"
                },
                "content": role_label
            })
        
        # ===== LEVEL 1+: Description and Character Information =====
        
        if self.spoiler_level >= 1:
            # Description section
            description = char.get("description")
            if description and description.strip():
                if self.spoiler_level == 1:
                    # Level 1: Strip spoiler content
                    display_description = self._strip_spoiler_content(description)
                else:
                    # Level 2: Show full description
                    display_description = description
                
                if display_description:  # Only add if there's content left after filtering
                    # Parse VNDB markup (URLs, etc.) into structured content
                    parsed_content = self._parse_vndb_markup(display_description)
                    content.append({
                        "tag": "details",
                        "content": [
                            {"tag": "summary", "content": "Description"},
                            {
                                "tag": "div",
                                "style": {"fontSize": "0.9em", "marginTop": "4px"},
                                "content": parsed_content
                            }
                        ]
                    })
            
            # Character Information section
            char_info_items = []
            
            # Physical stats as a compact inline line
            physical_line = self._build_physical_stats_line(char)
            if physical_line:
                char_info_items.append({
                    "tag": "li",
                    "style": {"fontWeight": "bold"},
                    "content": physical_line
                })
            
            # Traits organized by category
            trait_items = self._build_traits_by_category(char)
            char_info_items.extend(trait_items)
            
            if char_info_items:
                content.append({
                    "tag": "details",
                    "content": [
                        {"tag": "summary", "content": "Character Information"},
                        {
                            "tag": "ul",
                            "style": {"marginTop": "4px", "paddingLeft": "20px"},
                            "content": char_info_items
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

    def _contains_kanji(self, text: str) -> bool:
        """
        Check if text contains any kanji characters.
        
        Uses Unicode CJK Unified Ideographs range (0x4E00-0x9FFF) plus
        CJK Extension A (0x3400-0x4DBF) for rare kanji.
        
        Args:
            text: Text to check for kanji
            
        Returns:
            True if text contains kanji, False if it's hiragana/katakana only
        """
        if not text:
            return False
        for char in text:
            code = ord(char)
            # CJK Unified Ideographs: 0x4E00-0x9FFF
            # CJK Extension A: 0x3400-0x4DBF
            if (0x4E00 <= code <= 0x9FFF) or (0x3400 <= code <= 0x4DBF):
                return True
        return False

    def _split_japanese_name(self, name_original: str) -> dict:
        """
        Split a Japanese name containing a space into components.
        
        Japanese names from VNDB are typically stored as "FamilyName GivenName"
        with a space separator. This method creates multiple searchable variants.
        
        Args:
            name_original: Full Japanese name like "須々木 心一"
            
        Returns:
            Dictionary with keys:
            - family: Family name (須々木)
            - given: Given name (心一)
            - combined: No space (須々木心一)
            - original: With space (須々木 心一)
            - has_space: Boolean indicating if name contains space
        """
        if not name_original or ' ' not in name_original:
            return {
                'has_space': False,
                'original': name_original or '',
                'combined': name_original or '',
                'family': None,
                'given': None
            }
        
        # Split on first space only (handles names with multiple spaces)
        parts = name_original.split(' ', 1)
        family = parts[0]
        given = parts[1] if len(parts) > 1 else ''
        combined = family + given
        
        return {
            'has_space': True,
            'original': name_original,
            'combined': combined,
            'family': family,
            'given': given
        }

    def _split_romanized_name_to_hiragana(self, romanized_name: str) -> dict:
        """
        Split a romanized name and convert each part to hiragana for furigana.
        
        IMPORTANT: Romanized names from VNDB are in Western order "GivenName FamilyName"
        (e.g., "Shinichi Suzuki"), but Japanese names are "FamilyName GivenName"
        (e.g., "須々木 心一"). This method swaps the order when splitting.
        
        Args:
            romanized_name: Full romanized name like "Shinichi Suzuki" (Western order)
            
        Returns:
            Dictionary with keys (in Japanese order to match _split_japanese_name):
            - family: Family name in hiragana (すずき) - from 2nd part of romanized
            - given: Given name in hiragana (しんいち) - from 1st part of romanized
            - full: Full name in hiragana in Japanese order (すずきしんいち)
            - original: Original romanized name (Shinichi Suzuki)
            - has_space: Boolean indicating if name contains space
        """
        if not romanized_name:
            return {
                'has_space': False,
                'original': '',
                'full': '',
                'family': '',
                'given': ''
            }
        
        if ' ' not in romanized_name:
            # Single word name - use same reading for both
            full_hiragana = jaconv.alphabet2kana(romanized_name.lower())
            return {
                'has_space': False,
                'original': romanized_name,
                'full': full_hiragana,
                'family': full_hiragana,
                'given': full_hiragana
            }
        
        # Split romanized name: "Shinichi Suzuki" -> ["Shinichi", "Suzuki"]
        # In Western order: parts[0] = Given, parts[1] = Family
        parts = romanized_name.split(' ', 1)
        given_romaji = parts[0]  # First part is given name (Western order)
        family_romaji = parts[1] if len(parts) > 1 else ''  # Second part is family name
        
        # Convert each part to hiragana
        given_hiragana = jaconv.alphabet2kana(given_romaji.lower())
        family_hiragana = jaconv.alphabet2kana(family_romaji.lower()) if family_romaji else ''
        
        # Full reading in Japanese order: Family + Given (to match Japanese name order)
        full_hiragana = family_hiragana + given_hiragana
        
        return {
            'has_space': True,
            'original': romanized_name,
            'full': full_hiragana,
            'family': family_hiragana,  # From romanized parts[1]
            'given': given_hiragana     # From romanized parts[0]
        }

    def _generate_kana_readings(self, name_original: str) -> dict:
        """
        Generate readings for a kana-only name (hiragana or katakana).
        
        When the Japanese name contains no kanji, we use the name itself as the
        reading (converting katakana to hiragana if needed).
        
        Args:
            name_original: Japanese name in hiragana/katakana like "さくら" or "サクラ"
            
        Returns:
            Dictionary with keys (same structure as _split_romanized_name_to_hiragana):
            - family: Family name reading (in hiragana)
            - given: Given name reading (in hiragana)
            - full: Full name reading (in hiragana)
            - original: Original name
            - has_space: Boolean indicating if name contains space
        """
        if not name_original:
            return {
                'has_space': False,
                'original': '',
                'full': '',
                'family': '',
                'given': ''
            }
        
        # Convert katakana to hiragana for the reading
        full_hiragana = jaconv.kata2hira(name_original.replace(' ', ''))
        
        if ' ' not in name_original:
            return {
                'has_space': False,
                'original': name_original,
                'full': full_hiragana,
                'family': full_hiragana,
                'given': full_hiragana
            }
        
        # Split name: "さくら はな" -> ["さくら", "はな"]
        # Japanese order: parts[0] = Family, parts[1] = Given
        parts = name_original.split(' ', 1)
        family_kana = parts[0]
        given_kana = parts[1] if len(parts) > 1 else ''
        
        # Convert katakana to hiragana
        family_hiragana = jaconv.kata2hira(family_kana)
        given_hiragana = jaconv.kata2hira(given_kana) if given_kana else ''
        
        return {
            'has_space': True,
            'original': name_original,
            'full': full_hiragana,
            'family': family_hiragana,
            'given': given_hiragana
        }

    def _generate_mixed_name_readings(self, name_original: str, romanized_name: str) -> dict:
        """
        Generate readings for a name that may have mixed kanji/kana parts.
        
        This method checks EACH name part individually:
        - If a part contains kanji: use romanized reading for that part (convert romaji with jaconv)
        - If a part is already kana: use the kana directly (do NOT convert romaji with jaconv)
        
        This handles mixed names like "加藤 うみ" correctly:
        - "加藤" contains kanji → use romanized "かとう" (converted from romaji)
        - "うみ" is already hiragana → use "うみ" directly (no jaconv conversion)
        
        Also handles foreign names like "紬 ヴェンダース":
        - "紬" contains kanji → use romanized "Tsumugi" → "つむぎ"
        - "ヴェンダース" is katakana → use katakana directly → "ゔぇんだーす"
        
        Args:
            name_original: Full Japanese name like "紬 ヴェンダース"
            romanized_name: Full romanized name like "Tsumugi Wenders" (Western order)
            
        Returns:
            Dictionary with keys:
            - family: Family name reading in hiragana
            - given: Given name reading in hiragana
            - full: Full name reading in hiragana (family + given)
            - original: Original Japanese name
            - has_space: Boolean indicating if name contains space
        """
        # Handle empty names
        if not name_original:
            return {
                'has_space': False,
                'original': '',
                'full': '',
                'family': '',
                'given': ''
            }
        
        # Split Japanese name into parts (Family Given order)
        jp_parts = self._split_japanese_name(name_original)
        
        # For single-word names (no space)
        if not jp_parts['has_space']:
            if self._contains_kanji(name_original):
                # Has kanji - use romanized reading (convert with jaconv)
                full_hiragana = jaconv.alphabet2kana(romanized_name.lower())
                return {
                    'has_space': False,
                    'original': name_original,
                    'full': full_hiragana,
                    'family': full_hiragana,
                    'given': full_hiragana
                }
            else:
                # Pure kana - use itself as reading (no jaconv conversion from romaji)
                return self._generate_kana_readings(name_original)
        
        # For two-part names, check each part individually
        family_jp = jp_parts['family'] or ''
        given_jp = jp_parts['given'] or ''
        
        # Check if each part contains kanji
        family_has_kanji = self._contains_kanji(family_jp) if family_jp else False
        given_has_kanji = self._contains_kanji(given_jp) if given_jp else False
        
        # Split romanized name (Western order: Given Family)
        # We need to swap to match Japanese order (Family Given)
        romanized_parts = romanized_name.split(' ', 1) if romanized_name else ['', '']
        given_romaji = romanized_parts[0] if romanized_parts else ''  # Western given = Japanese family
        family_romaji = romanized_parts[1] if len(romanized_parts) > 1 else ''  # Western family = Japanese given
        
        # Determine family name reading (Japanese family corresponds to Western given)
        if family_has_kanji:
            # Family name has kanji - use corresponding romanized part (Western given) via jaconv
            family_reading = jaconv.alphabet2kana(given_romaji.lower()) if given_romaji else ''
        else:
            # Family name is kana - use Japanese kana directly (kata2hira only)
            family_reading = jaconv.kata2hira(family_jp) if family_jp else ''
        
        # Determine given name reading (Japanese given corresponds to Western family)
        if given_has_kanji:
            # Given name has kanji - use corresponding romanized part (Western family) via jaconv
            given_reading = jaconv.alphabet2kana(family_romaji.lower()) if family_romaji else ''
        else:
            # Given name is kana - use Japanese kana directly (kata2hira only)
            given_reading = jaconv.kata2hira(given_jp) if given_jp else ''
        
        # Combine for full reading
        full_reading = family_reading + given_reading
        
        return {
            'has_space': True,
            'original': name_original,
            'full': full_reading,
            'family': family_reading,
            'given': given_reading
        }

    def _create_entry(self, term: str, reading: str, role: str, score: int,
                      structured_content: dict) -> list:
        """
        Create a single Yomitan term entry.
        
        Args:
            term: The term/word to look up
            reading: Reading/pronunciation (hiragana, converted from romaji)
            role: Character role for tags
            score: Priority score
            structured_content: The structured content dictionary
            
        Returns:
            List representing a Yomitan term entry
        """
        return [
            term,                      # term
            reading,                   # reading
            f"name {role}" if role else "name",  # definitionTags
            "",                        # rules - empty for names
            score,                     # score
            [structured_content],      # definitions
            0,                         # sequence
            ""                         # termTags
        ]

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
        hiragana_readings = self._generate_mixed_name_readings(name_original, romanized_name)
        
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
        
        # Add role to tags set
        if role:
            self.tags.add(role)
        
        # Split the name to create multiple searchable entries
        name_parts = self._split_japanese_name(name_original)
        
        # Track terms we've added to avoid duplicates
        added_terms = set()
        
        if name_parts['has_space']:
            # Create 4 entries for names with spaces
            
            # 1. Original with space (須々木 心一) - use full hiragana reading
            if name_parts['original'] and name_parts['original'] not in added_terms:
                self.entries.append(self._create_entry(
                    name_parts['original'], hiragana_readings['full'], role, score, structured_content
                ))
                added_terms.add(name_parts['original'])
            
            # 2. Combined without space (須々木心一) - use full hiragana reading
            if name_parts['combined'] and name_parts['combined'] not in added_terms:
                self.entries.append(self._create_entry(
                    name_parts['combined'], hiragana_readings['full'], role, score, structured_content
                ))
                added_terms.add(name_parts['combined'])
            
            # 3. Family name only (須々木) - use family hiragana reading
            if name_parts['family'] and name_parts['family'] not in added_terms:
                self.entries.append(self._create_entry(
                    name_parts['family'], hiragana_readings['family'], role, score, structured_content
                ))
                added_terms.add(name_parts['family'])
            
            # 4. Given name only (心一) - use given hiragana reading
            if name_parts['given'] and name_parts['given'] not in added_terms:
                self.entries.append(self._create_entry(
                    name_parts['given'], hiragana_readings['given'], role, score, structured_content
                ))
                added_terms.add(name_parts['given'])
        else:
            # Single entry for names without spaces - use full hiragana reading
            self.entries.append(self._create_entry(
                name_original, hiragana_readings['full'], role, score, structured_content
            ))
            added_terms.add(name_original)
        
        # Create additional entries for aliases - use full hiragana reading
        aliases = char.get("aliases", [])
        if aliases and isinstance(aliases, list):
            for alias in aliases:
                if alias and alias not in added_terms:  # Skip empty or duplicate aliases
                    self.entries.append(self._create_entry(
                        alias, hiragana_readings['full'], role, score, structured_content
                    ))
                    added_terms.add(alias)

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
        actual_count = len(self.game_titles)
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
