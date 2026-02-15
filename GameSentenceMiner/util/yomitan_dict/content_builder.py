"""Content building for Yomitan dictionary structured content."""

import re
from typing import List, Optional


class ContentBuilder:
    """
    Builds Yomitan structured content for character cards.
    
    This class manages:
    - Building character card layouts
    - Formatting physical stats and traits
    - Handling spoiler filtering
    - Parsing VNDB markup
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
    
    # Month names for birthday formatting
    MONTH_NAMES = {
        1: "January", 2: "February", 3: "March", 4: "April",
        5: "May", 6: "June", 7: "July", 8: "August",
        9: "September", 10: "October", 11: "November", 12: "December"
    }
    
    # Sex display mapping
    SEX_DISPLAY = {
        "m": "♂ Male",
        "f": "♀ Female",
        "male": "♂ Male",
        "female": "♀ Female",
    }
    
    def __init__(self, spoiler_level: int = 0):
        """
        Initialize the content builder.
        
        Args:
            spoiler_level: Maximum spoiler level to include (0=None, 1=Minor, 2=Major)
        """
        self.spoiler_level = spoiler_level
    
    def strip_spoiler_content(self, text: str) -> str:
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
    
    def has_spoiler_tags(self, text: str) -> bool:
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
    
    def parse_vndb_markup(self, text: str) -> str:
        """
        Parse VNDB markup and convert to plain text.
        
        Handles:
        - [url=https://...]text[/url] -> just the link text (removes URL markup)
        - Returns plain text to avoid nested structured content issues
        
        Note: Previously this returned structured content with <a> tags, but
        Yomitan's schema requires href to match pattern ^(?:https?:|\\?)[\\w\\W]*
        and has strict rules about nesting. Converting to plain text is safer.
        
        Args:
            text: Text potentially containing VNDB markup
            
        Returns:
            Plain text string with URL markup converted to just the link text
        """
        if not text:
            return ""
        
        # Pattern to match [url=URL]text[/url] - extract just the link text
        url_pattern = re.compile(r'\[url=[^\]]+\]([^\[]*)\[/url\]', re.IGNORECASE)
        
        # Replace [url=...]text[/url] with just the text
        result = url_pattern.sub(r'\1', text)
        
        return result
    
    def format_birthday(self, birthday) -> str:
        """
        Format a birthday with month name.
        
        Args:
            birthday: Birthday as [month, day] list or string
            
        Returns:
            Formatted birthday string like "September 1" or empty string
        """
        if isinstance(birthday, list) and len(birthday) >= 2:
            # VNDB format: [month, day]
            month = birthday[0]
            day = birthday[1]
            month_name = self.MONTH_NAMES.get(month, str(month))
            return f"{month_name} {day}"
        elif isinstance(birthday, str):
            return birthday
        return ""
    
    def build_physical_stats_line(self, char: dict) -> str:
        """
        Build a compact inline string for physical attributes.
        
        Example output: "♀ Female • 17 years • 165cm • 50kg • Blood Type A"
        
        Args:
            char: Character data dictionary
            
        Returns:
            Formatted string of physical stats, or empty string if no stats
        """
        parts = []
        
        sex = char.get("sex")
        if sex:
            sex_lower = sex.lower() if isinstance(sex, str) else sex
            if sex_lower in self.SEX_DISPLAY:
                parts.append(self.SEX_DISPLAY[sex_lower])
        
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
            formatted_birthday = self.format_birthday(birthday)
            if formatted_birthday:
                parts.append(f"Birthday: {formatted_birthday}")
        
        return " • ".join(parts)
    
    def build_traits_by_category(self, char: dict) -> List[dict]:
        """
        Build organized trait items grouped by category.
        
        Filters traits based on spoiler level setting.
        
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
    
    def build_structured_content(self, char: dict, image_path: Optional[str], game_title: str) -> dict:
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
        if role and role in self.ROLE_LABELS:
            role_color = self.ROLE_COLORS.get(role, "#9E9E9E")
            role_label = self.ROLE_LABELS.get(role, role.title())
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
                    display_description = self.strip_spoiler_content(description)
                else:
                    # Level 2: Show full description
                    display_description = description
                
                if display_description:  # Only add if there's content left after filtering
                    # Parse VNDB markup (URLs, etc.) into structured content
                    parsed_content = self.parse_vndb_markup(display_description)
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
            physical_line = self.build_physical_stats_line(char)
            if physical_line:
                char_info_items.append({
                    "tag": "li",
                    "style": {"fontWeight": "bold"},
                    "content": physical_line
                })
            
            # Traits organized by category (with spoiler filtering)
            trait_items = self.build_traits_by_category(char)
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
    
    def create_term_entry(self, term: str, reading: str, role: str, score: int,
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
