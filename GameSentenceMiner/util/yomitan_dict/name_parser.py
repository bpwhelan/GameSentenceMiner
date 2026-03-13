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

    # Japanese honorific suffixes: (kanji/kana form, hiragana reading, English description)
    HONORIFIC_SUFFIXES = [
        # ===== Respectful / Formal =====
        ("さん", "さん", "Generic polite suffix (Mr./Ms./Mrs.)"),
        ("様", "さま", "Very formal/respectful (Lord/Lady/Dear)"),
        ("さま", "さま", "Kana form of 様 — very formal/respectful"),
        ("氏", "し", "Formal written suffix (Mr./Ms.)"),
        ("殿", "どの", "Formal/archaic (Lord, used in official documents)"),
        ("殿", "てん", "Alternate reading of 殿 (rare)"),
        ("御前", "おまえ", "Archaic respectful (Your Presence)"),
        ("御前", "ごぜん", "Alternate reading of 御前 (Your Excellency)"),
        ("貴殿", "きでん", "Very formal written (Your Honor)"),
        ("閣下", "かっか", "Your Excellency (diplomatic/military)"),
        ("陛下", "へいか", "Your Majesty (royalty)"),
        ("殿下", "でんか", "Your Highness (royalty)"),
        ("妃殿下", "ひでんか", "Her Royal Highness (princess consort)"),
        ("親王", "しんのう", "Prince of the Blood (Imperial family)"),
        ("内親王", "ないしんのう", "Princess of the Blood (Imperial family)"),
        ("宮", "みや", "Prince/Princess (Imperial branch family)"),
        ("上", "うえ", "Archaic superior address (e.g. 父上)"),
        ("公", "こう", "Duke / Lord (nobility)"),
        ("卿", "きょう", "Lord (archaic nobility, also used in fantasy)"),
        ("侯", "こう", "Marquis (nobility)"),
        ("伯", "はく", "Count/Earl (nobility)"),
        ("子", "し", "Viscount (nobility) / Master (classical)"),
        ("男", "だん", "Baron (nobility)"),
        # ===== Casual / Friendly =====
        ("君", "くん", "Familiar suffix (usually male, junior)"),
        ("くん", "くん", "Kana form of 君 — familiar (usually male)"),
        ("ちゃん", "ちゃん", "Endearing suffix (children, close friends, girls)"),
        ("たん", "たん", "Baby-talk version of ちゃん"),
        ("ちん", "ちん", "Cutesy/playful variant of ちゃん"),
        ("りん", "りん", "Cutesy suffix (internet/otaku culture)"),
        ("っち", "っち", "Playful/affectionate suffix"),
        ("ぴょん", "ぴょん", "Cutesy/bouncy suffix"),
        ("にゃん", "にゃん", "Cat-like cutesy suffix"),
        ("みん", "みん", "Cutesy diminutive suffix"),
        ("ぽん", "ぽん", "Playful suffix"),
        ("坊", "ぼう", "Young boy / little one"),
        ("坊ちゃん", "ぼっちゃん", "Young master / rich boy"),
        ("嬢", "じょう", "Young lady"),
        ("嬢ちゃん", "じょうちゃん", "Little miss"),
        ("お嬢", "おじょう", "Young lady (polite)"),
        ("お嬢様", "おじょうさま", "Young lady (very polite/rich girl)"),
        ("姫", "ひめ", "Princess (also used affectionately)"),
        ("姫様", "ひめさま", "Princess (formal)"),
        ("王子", "おうじ", "Prince"),
        ("王子様", "おうじさま", "Prince (formal/fairy-tale)"),
        ("王女", "おうじょ", "Princess (royal daughter)"),
        # ===== Academic / Educational =====
        ("先生", "せんせい", "Teacher/Doctor/Master"),
        ("先輩", "せんぱい", "Senior (school/work)"),
        ("後輩", "こうはい", "Junior (school/work)"),
        ("教授", "きょうじゅ", "Professor"),
        ("准教授", "じゅんきょうじゅ", "Associate Professor"),
        ("助教", "じょきょう", "Assistant Professor"),
        ("講師", "こうし", "Lecturer"),
        ("博士", "はかせ", "Doctor (academic/scientist)"),
        ("博士", "はくし", "Doctor (alternate formal reading)"),
        ("師匠", "ししょう", "Master/Mentor (arts, martial arts)"),
        ("師範", "しはん", "Master instructor (martial arts)"),
        ("老師", "ろうし", "Venerable teacher / Zen master"),
        ("塾長", "じゅくちょう", "Cram school principal"),
        ("校長", "こうちょう", "School principal"),
        ("学長", "がくちょう", "University president"),
        ("園長", "えんちょう", "Kindergarten/zoo director"),
        ("生徒", "せいと", "Student (used as address in some contexts)"),
        # ===== Corporate / Business =====
        ("社長", "しゃちょう", "Company president/CEO"),
        ("副社長", "ふくしゃちょう", "Vice president"),
        ("会長", "かいちょう", "Chairman"),
        ("部長", "ぶちょう", "Department head/Director"),
        ("副部長", "ふくぶちょう", "Deputy department head"),
        ("課長", "かちょう", "Section chief/Manager"),
        ("係長", "かかりちょう", "Subsection chief"),
        ("主任", "しゅにん", "Chief/Senior staff"),
        ("店長", "てんちょう", "Store manager"),
        ("支配人", "しはいにん", "Manager (hotel/theater)"),
        ("専務", "せんむ", "Senior Managing Director"),
        ("常務", "じょうむ", "Managing Director"),
        ("取締役", "とりしまりやく", "Board Director"),
        ("監督", "かんとく", "Director/Supervisor/Coach"),
        ("所長", "しょちょう", "Office/institute director"),
        ("局長", "きょくちょう", "Bureau director"),
        ("室長", "しつちょう", "Office chief / Lab head"),
        ("班長", "はんちょう", "Squad leader / Team leader"),
        ("組長", "くみちょう", "Group leader (also yakuza boss)"),
        ("番頭", "ばんとう", "Head clerk (traditional business)"),
        ("頭取", "とうどり", "Bank president"),
        ("理事長", "りじちょう", "Board chairman"),
        ("理事", "りじ", "Board member/Trustee"),
        ("総裁", "そうさい", "Governor/President (of institution)"),
        ("代表", "だいひょう", "Representative"),
        # ===== Government / Political =====
        ("大臣", "だいじん", "Minister (government)"),
        ("総理", "そうり", "Prime Minister (short form)"),
        ("総理大臣", "そうりだいじん", "Prime Minister (full)"),
        ("長官", "ちょうかん", "Director-General / Commissioner"),
        ("知事", "ちじ", "Governor (prefecture)"),
        ("市長", "しちょう", "Mayor"),
        ("町長", "ちょうちょう", "Town mayor"),
        ("村長", "そんちょう", "Village chief"),
        ("区長", "くちょう", "Ward mayor"),
        ("議長", "ぎちょう", "Chairman (assembly/parliament)"),
        ("議員", "ぎいん", "Legislator/Councilmember"),
        ("大使", "たいし", "Ambassador"),
        ("公使", "こうし", "Minister (diplomatic)"),
        ("領事", "りょうじ", "Consul"),
        ("奉行", "ぶぎょう", "Magistrate (Edo period)"),
        ("代官", "だいかん", "Magistrate/Intendant (historical)"),
        # ===== Military / Law Enforcement =====
        ("大将", "たいしょう", "General/Admiral"),
        ("中将", "ちゅうじょう", "Lieutenant General"),
        ("少将", "しょうしょう", "Major General"),
        ("大佐", "たいさ", "Colonel"),
        ("中佐", "ちゅうさ", "Lieutenant Colonel"),
        ("少佐", "しょうさ", "Major"),
        ("大尉", "たいい", "Captain (military)"),
        ("中尉", "ちゅうい", "First Lieutenant"),
        ("少尉", "しょうい", "Second Lieutenant"),
        ("軍曹", "ぐんそう", "Sergeant"),
        ("伍長", "ごちょう", "Corporal"),
        ("兵長", "へいちょう", "Lance Corporal / Senior Private"),
        ("上等兵", "じょうとうへい", "Private First Class"),
        ("元帥", "げんすい", "Marshal/Fleet Admiral"),
        ("提督", "ていとく", "Admiral (naval, common in anime)"),
        ("司令", "しれい", "Commander"),
        ("司令官", "しれいかん", "Commanding Officer"),
        ("総司令", "そうしれい", "Supreme Commander"),
        ("参謀", "さんぼう", "Staff Officer / Strategist"),
        ("隊長", "たいちょう", "Squad/Unit captain"),
        ("団長", "だんちょう", "Regiment/Group commander"),
        ("師団長", "しだんちょう", "Division commander"),
        ("艦長", "かんちょう", "Ship captain"),
        ("船長", "せんちょう", "Ship captain (civilian)"),
        ("機長", "きちょう", "Aircraft captain/Pilot in command"),
        ("警部", "けいぶ", "Police Inspector"),
        ("警視", "けいし", "Superintendent (police)"),
        ("巡査", "じゅんさ", "Police officer (patrol)"),
        ("刑事", "けいじ", "Detective"),
        ("署長", "しょちょう", "Police station chief"),
        ("将軍", "しょうぐん", "Shogun / General (historical)"),
        ("大名", "だいみょう", "Feudal lord (historical)"),
        # ===== Religious / Spiritual =====
        ("神", "かみ", "God"),
        ("神様", "かみさま", "God (respectful)"),
        ("上人", "しょうにん", "Holy person (Buddhist)"),
        ("聖人", "せいじん", "Saint"),
        ("法師", "ほうし", "Buddhist priest"),
        ("坊主", "ぼうず", "Buddhist monk (casual)"),
        ("和尚", "おしょう", "Buddhist priest/monk"),
        ("住職", "じゅうしょく", "Head priest (temple)"),
        ("禅師", "ぜんじ", "Zen master"),
        ("大師", "だいし", "Great master (Buddhist title)"),
        ("上座", "じょうざ", "Senior monk"),
        ("尼", "あま", "Buddhist nun"),
        ("巫女", "みこ", "Shrine maiden"),
        ("宮司", "ぐうじ", "Chief Shinto priest"),
        ("神主", "かんぬし", "Shinto priest"),
        ("神父", "しんぷ", "Catholic priest / Father"),
        ("牧師", "ぼくし", "Protestant pastor"),
        ("司祭", "しさい", "Priest (Christian)"),
        ("司教", "しきょう", "Bishop"),
        ("枢機卿", "すうききょう", "Cardinal"),
        ("教皇", "きょうこう", "Pope"),
        ("法王", "ほうおう", "Pope (alternate) / Dharma King"),
        ("猊下", "げいか", "Your Holiness/Eminence"),
        # ===== Medical =====
        ("医師", "いし", "Doctor/Physician"),
        ("医者", "いしゃ", "Doctor (colloquial)"),
        ("看護師", "かんごし", "Nurse"),
        ("薬剤師", "やくざいし", "Pharmacist"),
        ("歯科医", "しかい", "Dentist"),
        ("獣医", "じゅうい", "Veterinarian"),
        ("院長", "いんちょう", "Hospital director"),
        # ===== Martial Arts / Traditional =====
        ("範士", "はんし", "Grand master (martial arts)"),
        ("教士", "きょうし", "Senior teacher (martial arts)"),
        ("達人", "たつじん", "Master/Expert"),
        ("名人", "めいじん", "Grand master (go, shogi, etc.)"),
        ("棋士", "きし", "Professional go/shogi player"),
        ("横綱", "よこづな", "Grand champion (sumo)"),
        ("大関", "おおぜき", "Champion (sumo)"),
        ("関脇", "せきわけ", "Junior champion (sumo)"),
        ("小結", "こむすび", "Junior champion 2nd (sumo)"),
        ("親方", "おやかた", "Stable master (sumo) / Boss (craftsman)"),
        ("力士", "りきし", "Sumo wrestler"),
        # ===== Family / Kinship (used as honorific address) =====
        ("兄", "にい", "Older brother (short)"),
        ("兄さん", "にいさん", "Older brother"),
        ("お兄さん", "おにいさん", "Older brother (polite)"),
        ("お兄ちゃん", "おにいちゃん", "Big bro (affectionate)"),
        ("兄ちゃん", "にいちゃん", "Big bro (casual)"),
        ("兄貴", "あにき", "Big bro (rough/yakuza)"),
        ("兄上", "あにうえ", "Older brother (archaic/formal)"),
        ("姉", "ねえ", "Older sister (short)"),
        ("姉さん", "ねえさん", "Older sister"),
        ("お姉さん", "おねえさん", "Older sister (polite)"),
        ("お姉ちゃん", "おねえちゃん", "Big sis (affectionate)"),
        ("姉ちゃん", "ねえちゃん", "Big sis (casual)"),
        ("姉貴", "あねき", "Big sis (rough)"),
        ("姉上", "あねうえ", "Older sister (archaic/formal)"),
        ("弟", "おとうと", "Younger brother"),
        ("妹", "いもうと", "Younger sister"),
        ("父上", "ちちうえ", "Father (archaic/formal)"),
        ("母上", "ははうえ", "Mother (archaic/formal)"),
        ("お父さん", "おとうさん", "Father"),
        ("お母さん", "おかあさん", "Mother"),
        ("おじさん", "おじさん", "Uncle / Middle-aged man"),
        ("おばさん", "おばさん", "Aunt / Middle-aged woman"),
        ("おじいさん", "おじいさん", "Grandfather / Old man"),
        ("おばあさん", "おばあさん", "Grandmother / Old woman"),
        ("じいちゃん", "じいちゃん", "Grandpa (casual)"),
        ("ばあちゃん", "ばあちゃん", "Grandma (casual)"),
        ("お嫁さん", "およめさん", "Bride / Wife (polite)"),
        ("奥様", "おくさま", "Wife (very polite)"),
        ("奥さん", "おくさん", "Wife (polite)"),
        ("旦那", "だんな", "Husband / Master"),
        ("旦那様", "だんなさま", "Husband / Master (formal)"),
        # ===== Historical / Feudal =====
        ("御所", "ごしょ", "Imperial Palace / Emperor (by metonymy)"),
        ("関白", "かんぱく", "Imperial Regent"),
        ("摂政", "せっしょう", "Regent"),
        ("太閤", "たいこう", "Retired regent (Hideyoshi's title)"),
        ("太政大臣", "だいじょうだいじん", "Grand Chancellor"),
        ("征夷大将軍", "せいいたいしょうぐん", "Shogun (full title)"),
        ("守護", "しゅご", "Provincial governor (medieval)"),
        ("地頭", "じとう", "Land steward (medieval)"),
        ("家老", "かろう", "Chief retainer (samurai)"),
        ("侍", "さむらい", "Samurai"),
        ("武士", "ぶし", "Warrior"),
        ("浪人", "ろうにん", "Masterless samurai"),
        ("忍", "しのび", "Ninja (short form)"),
        ("殿様", "とのさま", "Lord (feudal)"),
        ("お殿様", "おとのさま", "Lord (very polite)"),
        ("お館様", "おやかたさま", "Lord of the castle"),
        ("若", "わか", "Young lord/master"),
        ("若様", "わかさま", "Young lord (formal)"),
        ("若殿", "わかとの", "Young lord"),
        # ===== Fantasy / Fictional (common in VN/anime) =====
        ("王", "おう", "King"),
        ("王様", "おうさま", "King (polite)"),
        ("女王", "じょおう", "Queen"),
        ("女王様", "じょおうさま", "Queen (formal)"),
        ("皇帝", "こうてい", "Emperor"),
        ("皇后", "こうごう", "Empress"),
        ("天皇", "てんのう", "Emperor (Japanese)"),
        ("魔王", "まおう", "Demon King"),
        ("魔王様", "まおうさま", "Demon King (respectful)"),
        ("勇者", "ゆうしゃ", "Hero/Brave"),
        ("勇者様", "ゆうしゃさま", "Hero (respectful)"),
        ("聖女", "せいじょ", "Holy maiden / Saintess"),
        ("魔女", "まじょ", "Witch"),
        ("賢者", "けんじゃ", "Sage/Wise one"),
        ("導師", "どうし", "Guide/Mentor (fantasy)"),
        ("騎士", "きし", "Knight"),
        ("長老", "ちょうろう", "Elder"),
        ("族長", "ぞくちょう", "Clan chief / Tribal leader"),
        ("頭領", "とうりょう", "Boss / Chief (bandits, guilds)"),
        ("首領", "しゅりょう", "Leader / Boss"),
        ("大王", "だいおう", "Great King"),
        ("姫君", "ひめぎみ", "Princess (literary)"),
        ("御方", "おかた", "That person (very respectful)"),
        ("主", "ぬし", "Master/Lord (archaic)"),
        ("主", "あるじ", "Master/Lord (alternate reading)"),
        ("主人", "しゅじん", "Master/Head of household"),
        ("ご主人", "ごしゅじん", "Master (polite)"),
        ("ご主人様", "ごしゅじんさま", "Master (very polite, maid usage)"),
        ("お方", "おかた", "Person (respectful)"),
        # ===== Otaku / Internet / Modern Slang =====
        ("氏", "うじ", "Alternate reading of 氏 (internet)"),
        ("師", "し", "Master/Teacher (respectful, online)"),
        ("大先生", "だいせんせい", "Great teacher (sometimes ironic)"),
        ("御大", "おんたい", "The great one / Big boss"),
        ("大御所", "おおごしょ", "Grand old master / Authority"),
        ("パイセン", "ぱいせん", "Senpai (slang reversal)"),
        ("っす", "っす", "Casual desu (used as address marker)"),
        ("どの", "どの", "Kana form of 殿"),
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

    @staticmethod
    def hira_to_kata(text: str) -> str:
        """
        Convert hiragana to katakana.

        Hiragana range: U+3041 (ぁ) to U+3096 (ゖ). Add 0x60 to get katakana.

        Args:
            text: Text containing hiragana

        Returns:
            Text with hiragana converted to katakana
        """
        result = []
        for ch in text:
            code = ord(ch)
            if 0x3041 <= code <= 0x3096:
                result.append(chr(code + 0x60))
            else:
                result.append(ch)
        return "".join(result)

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
        if not name_original or " " not in name_original:
            return {
                "has_space": False,
                "original": name_original or "",
                "combined": name_original or "",
                "family": None,
                "given": None,
            }

        # Split on first space only (handles names with multiple spaces)
        parts = name_original.split(" ", 1)
        family = parts[0]
        given = parts[1] if len(parts) > 1 else ""
        combined = family + given

        return {
            "has_space": True,
            "original": name_original,
            "combined": combined,
            "family": family,
            "given": given,
        }

    def split_romanized_name_to_hiragana(
        self, romanized_name: str
    ) -> Dict[str, str | bool]:
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
                "has_space": False,
                "original": "",
                "full": "",
                "family": "",
                "given": "",
            }

        if " " not in romanized_name:
            # Single word name - use same reading for both
            full_hiragana = jaconv.alphabet2kana(romanized_name.lower())
            return {
                "has_space": False,
                "original": romanized_name,
                "full": full_hiragana,
                "family": full_hiragana,
                "given": full_hiragana,
            }

        # Split romanized name: "Shinichi Suzuki" -> ["Shinichi", "Suzuki"]
        # In Western order: parts[0] = Given, parts[1] = Family
        parts = romanized_name.split(" ", 1)
        given_romaji = parts[0]  # First part is given name (Western order)
        family_romaji = parts[1] if len(parts) > 1 else ""  # Second part is family name

        # Convert each part to hiragana
        given_hiragana = jaconv.alphabet2kana(given_romaji.lower())
        family_hiragana = (
            jaconv.alphabet2kana(family_romaji.lower()) if family_romaji else ""
        )

        # Full reading in Japanese order: Family + Given (to match Japanese name order)
        full_hiragana = family_hiragana + given_hiragana

        return {
            "has_space": True,
            "original": romanized_name,
            "full": full_hiragana,
            "family": family_hiragana,  # From romanized parts[1]
            "given": given_hiragana,  # From romanized parts[0]
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
                "has_space": False,
                "original": "",
                "full": "",
                "family": "",
                "given": "",
            }

        # Convert katakana to hiragana for the reading
        full_hiragana = jaconv.kata2hira(name_original.replace(" ", ""))

        if " " not in name_original:
            return {
                "has_space": False,
                "original": name_original,
                "full": full_hiragana,
                "family": full_hiragana,
                "given": full_hiragana,
            }

        # Split name: "さくら はな" -> ["さくら", "はな"]
        # Japanese order: parts[0] = Family, parts[1] = Given
        parts = name_original.split(" ", 1)
        family_kana = parts[0]
        given_kana = parts[1] if len(parts) > 1 else ""

        # Convert katakana to hiragana
        family_hiragana = jaconv.kata2hira(family_kana)
        given_hiragana = jaconv.kata2hira(given_kana) if given_kana else ""

        return {
            "has_space": True,
            "original": name_original,
            "full": full_hiragana,
            "family": family_hiragana,
            "given": given_hiragana,
        }

    def generate_mixed_name_readings(
        self, name_original: str, romanized_name: str
    ) -> Dict[str, str | bool]:
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
                "has_space": False,
                "original": "",
                "full": "",
                "family": "",
                "given": "",
            }

        # Split Japanese name into parts (Family Given order)
        jp_parts = self.split_japanese_name(name_original)

        # For single-word names (no space)
        if not jp_parts["has_space"]:
            if self.contains_kanji(name_original):
                # Has kanji - use romanized reading (convert with jaconv)
                full_hiragana = jaconv.alphabet2kana(romanized_name.lower())
                return {
                    "has_space": False,
                    "original": name_original,
                    "full": full_hiragana,
                    "family": full_hiragana,
                    "given": full_hiragana,
                }
            else:
                # Pure kana - use itself as reading (no jaconv conversion from romaji)
                return self.generate_kana_readings(name_original)

        # For two-part names, check each part individually
        family_jp = jp_parts["family"] or ""
        given_jp = jp_parts["given"] or ""

        # Check if each part contains kanji
        family_has_kanji = self.contains_kanji(family_jp) if family_jp else False
        given_has_kanji = self.contains_kanji(given_jp) if given_jp else False

        # Split romanized name (Western order: Given Family)
        # We need to swap to match Japanese order (Family Given)
        romanized_parts = romanized_name.split(" ", 1) if romanized_name else ["", ""]
        given_romaji = (
            romanized_parts[0] if romanized_parts else ""
        )  # Western given = Japanese family
        family_romaji = (
            romanized_parts[1] if len(romanized_parts) > 1 else ""
        )  # Western family = Japanese given

        # Determine family name reading (Japanese family corresponds to Western given)
        if family_has_kanji:
            # Family name has kanji - use corresponding romanized part (Western given) via jaconv
            family_reading = (
                jaconv.alphabet2kana(given_romaji.lower()) if given_romaji else ""
            )
        else:
            # Family name is kana - use Japanese kana directly (kata2hira only)
            family_reading = jaconv.kata2hira(family_jp) if family_jp else ""

        # Determine given name reading (Japanese given corresponds to Western family)
        if given_has_kanji:
            # Given name has kanji - use corresponding romanized part (Western family) via jaconv
            given_reading = (
                jaconv.alphabet2kana(family_romaji.lower()) if family_romaji else ""
            )
        else:
            # Given name is kana - use Japanese kana directly (kata2hira only)
            given_reading = jaconv.kata2hira(given_jp) if given_jp else ""

        # Combine for full reading
        full_reading = family_reading + given_reading

        return {
            "has_space": True,
            "original": name_original,
            "full": full_reading,
            "family": family_reading,
            "given": given_reading,
        }
