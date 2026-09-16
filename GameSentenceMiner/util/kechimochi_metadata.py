"""Map GSM metadata to Kechimochi's editable fields and source refresh links."""

from __future__ import annotations

import json
import re
from urllib.parse import urlsplit

LEGACY_FIELDS = {
    "vNDB_ID": "VNDB ID",
    "aniList_ID": "AniList ID",
    "deck_id": "Jiten deck ID",
    "obs_scene_name": "OBS scene",
    "release_date": "Release Date",
    "title_romaji": "Romaji title",
    "title_english": "English title",
    "genres": "Genres",
    "tags": "Tags",
}

SOURCE_NAMES = {
    "vndb.org": "VNDB",
    "jiten.moe": "Jiten.moe",
    "anilist.co": "Anilist",
    "backloggd.com": "Backloggd",
    "imdb.com": "IMDb",
    "cmoa.jp": "Cmoa",
    "bookwalker.jp": "Bookwalker",
    "bookmeter.com": "Bookmeter",
    "shonenjumpplus.com": "Shonen Jump+",
    "dmm.co.jp": "DMM",
}


def _text(value):
    if isinstance(value, list):
        return ", ".join(str(item) for item in value)
    return str(value) if value is not None else ""


def _add_source(extra, url):
    if not isinstance(url, str):
        return
    url = url.strip()
    try:
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            return
    except ValueError:
        return
    # These names match Kechimochi's importers. Its media detail page supplies a
    # Refresh Metadata button for recognized URLs in any Source field.
    host = parts.hostname.removeprefix("www.")
    label = f"Source ({SOURCE_NAMES.get(host, host)})"
    key, number = label, 1
    while key in extra:
        if str(extra[key]).rstrip("/") == url.rstrip("/"):
            return
        number += 1
        key = f"{label} {number}"
    extra[key] = url


def migrate_legacy_metadata(extra):
    """Upgrade CSV-style fields without discarding fields added in Kechimochi."""
    extra = dict(extra)
    for old, new in LEGACY_FIELDS.items():
        if old not in extra:
            continue
        value = extra.pop(old)
        # Kechimochi's editor may have stringified arrays from the old exporter.
        if old in {"genres", "tags"} and isinstance(value, str):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, list):
                    value = parsed
            except ValueError:
                pass
        extra.setdefault(new, _text(value))
    links = extra.get("links")
    if isinstance(links, str):
        try:
            links = json.loads(links)
        except ValueError:
            pass
    if isinstance(links, list) and all(isinstance(link, str) for link in links):
        extra.pop("links", None)
        for link in links:
            _add_source(extra, link)
    return extra


def build_kechimochi_metadata(game, exported):
    extra = migrate_legacy_metadata(exported)
    vndb_id = str(game.vndb_id or "").strip().lower()
    if re.fullmatch(r"v?[1-9][0-9]*", vndb_id):
        _add_source(extra, f"https://vndb.org/v{vndb_id.removeprefix('v')}")
    deck_id = str(game.deck_id or "")
    if re.fullmatch(r"[1-9][0-9]*", deck_id):
        _add_source(extra, f"https://jiten.moe/decks/{deck_id}")
    # A saved AniList URL knows whether the entry is anime or manga. Prefer it
    # over deriving a URL from GSM's more general content type.
    if "Source (Anilist)" not in extra:
        anilist_id = str(game.anilist_id or "").strip()
        game_type = re.sub(r"[\s_-]", "", (game.type or "").lower())
        kind = {
            "anime": "anime",
            "movie": "anime",
            "manga": "manga",
            "novel": "manga",
            "lightnovel": "manga",
            "webnovel": "manga",
        }.get(game_type)
        if kind and re.fullmatch(r"[1-9][0-9]*", anilist_id):
            _add_source(extra, f"https://anilist.co/{kind}/{anilist_id}")
    if game.character_count and game.character_count > 0:
        # Kechimochi uses this exact field for its progress/speed calculations.
        extra["Character count"] = f"{game.character_count:,}"
    if game.difficulty is not None:
        extra["GSM difficulty"] = str(game.difficulty)
    return extra
