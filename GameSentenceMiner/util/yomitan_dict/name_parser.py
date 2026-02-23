"""Name parsing and reading generation for Japanese character names."""

import jaconv
from typing import Dict


class NameParser:
    """
    Handles parsing and reading generation for Japanese character names.
    
    This class manages:
    - Splitting Japanese names by space (family/given name separation)
    - Converting romanized names to hiragana readings
    - Handling mixed kanji/kana names with per-part logic
    - Generating honorific suffix variants
    """
    
    # Japanese honorific suffixes: (kanji/kana form, hiragana reading)
    HONORIFIC_SUFFIXES = [
        # Respectful/Formal
        ("さん", "さん"),
        ("様", "さま"),
        ("先生", "せんせい"),
        ("先輩", "せんぱい"),
        ("後輩", "こうはい"),
        ("氏", "し"),
        # Casual/Friendly
        ("君", "くん"),
        ("くん", "くん"),  # Alternative hiragana form
        ("ちゃん", "ちゃん"),
        ("たん", "たん"),
        ("坊", "ぼう"),
        # Old-fashioned/Archaic
        ("殿", "どの"),
        ("博士", "はかせ"),
        # Occupational/Specific
        ("社長", "しゃちょう"),
        ("部長", "ぶちょう"),
    ]
    
    def contains_kanji(self, text: str) -> bool:
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
    
    def split_japanese_name(self, name_original: str) -> Dict[str, str | bool]:
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
    
    def split_romanized_name_to_hiragana(self, romanized_name: str) -> Dict[str, str | bool]:
        """
        Split a romanized name and convert each part to hiragana for furigana.
        
        IMPORTANT: Romanized names from VNDB are in Western order "GivenName FamilyName"
        (e.g., "Shinichi Suzuki"), but Japanese names are "FamilyName GivenName"
        (e.g., "須々木 心一"). This method swaps the order when splitting.
        
        Args:
            romanized_name: Full romanized name like "Shinichi Suzuki" (Western order)
            
        Returns:
            Dictionary with keys (in Japanese order to match split_japanese_name):
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
    
    def generate_kana_readings(self, name_original: str) -> Dict[str, str | bool]:
        """
        Generate readings for a kana-only name (hiragana or katakana).
        
        When the Japanese name contains no kanji, we use the name itself as the
        reading (converting katakana to hiragana if needed).
        
        Args:
            name_original: Japanese name in hiragana/katakana like "さくら" or "サクラ"
            
        Returns:
            Dictionary with keys (same structure as split_romanized_name_to_hiragana):
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
    
    def generate_mixed_name_readings(self, name_original: str, romanized_name: str) -> Dict[str, str | bool]:
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
        jp_parts = self.split_japanese_name(name_original)
        
        # For single-word names (no space)
        if not jp_parts['has_space']:
            if self.contains_kanji(name_original):
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
                return self.generate_kana_readings(name_original)
        
        # For two-part names, check each part individually
        family_jp = jp_parts['family'] or ''
        given_jp = jp_parts['given'] or ''
        
        # Check if each part contains kanji
        family_has_kanji = self.contains_kanji(family_jp) if family_jp else False
        given_has_kanji = self.contains_kanji(given_jp) if given_jp else False
        
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
