"""
Jiten.moe Update Script for GameSentenceMiner

This module provides functions to automatically update game metadata from jiten.moe,
respecting manual overrides set by users.

Usage:
    from GameSentenceMiner.util.cron.jiten_update import update_all_jiten_games

    # Update all linked games
    result = update_all_jiten_games()
    print(f"Updated {result['updated_games']} out of {result['total_games']} games")
"""

import time
from typing import Optional, Dict, List

from GameSentenceMiner.util.games_table import GamesTable
from GameSentenceMiner.util.configuration import logger
from GameSentenceMiner.util.jiten_api_client import JitenApiClient


def fetch_jiten_data_for_game(game: GamesTable) -> Optional[Dict]:
    """
    Fetch fresh data from jiten.moe API for a specific game.

    Args:
        game: GamesTable object with a deck_id

    Returns:
        Dictionary with normalized jiten.moe data (snake_case keys), or None if fetch fails

    Example return structure:
        {
            'deck_id': 123,
            'title_original': '君と彼女と彼女の恋。',
            'title_romaji': 'Kimi to Kanojo to Kanojo no Koi.',
            'title_english': 'You, Me, and Her',
            'description': 'A visual novel about...',
            'cover_name': 'https://...',
            'media_type': 7,  # 1=Anime, 7=Visual Novel, 2=Manga
            'character_count': 50000,
            'difficulty': 5,
            'difficulty_raw': 5.2,
            'links': [...],
            'aliases': [...],
            'release_date': '2013-06-28'
        }
    """
    if not game.deck_id:
        logger.debug(
            f"Game {game.id} ({game.title_original}) has no deck_id, skipping jiten fetch"
        )
        return None

    try:
        logger.debug(
            f"Fetching jiten.moe data for game: {game.title_original} (deck_id: {game.deck_id})"
        )

        # Use direct deck detail API endpoint
        data = JitenApiClient.get_deck_detail(game.deck_id)

        if not data:
            logger.debug(f"Failed to fetch deck detail for deck_id {game.deck_id}")
            return None

        # Extract main deck data from the detail response
        main_deck = data.get("data", {}).get("mainDeck")
        if not main_deck:
            logger.debug(f"No mainDeck found in response for deck_id {game.deck_id}")
            return None

        # Normalize the deck data
        jiten_data = JitenApiClient.normalize_deck_data(main_deck)
        logger.debug(
            f"Successfully fetched jiten.moe data for: {jiten_data['title_original']}"
        )
        return jiten_data

    except Exception as e:
        logger.debug(f"Unexpected error fetching jiten data for game {game.id}: {e}")
        return None


def update_single_game_from_jiten(game: GamesTable, jiten_data: Dict) -> Dict:
    """
    Update a single game's fields from jiten.moe data, respecting manual overrides.
    Always re-downloads cover images.

    Args:
        game: GamesTable object to update
        jiten_data: Dictionary with jiten.moe data (from fetch_jiten_data_for_game)

    Returns:
        Dictionary with update summary:
        {
            'success': bool,
            'updated_fields': List[str],
            'skipped_fields': List[str],
            'error': Optional[str]
        }
    """
    try:
        update_fields = {}
        skipped_fields = []

        # Ensure manual_overrides is always a list
        manual_overrides = (
            game.manual_overrides if game.manual_overrides is not None else []
        )
        if not isinstance(manual_overrides, list):
            logger.warning(
                f"⚠️ manual_overrides is not a list for game {game.id}: {type(manual_overrides)}"
            )
            manual_overrides = []

        logger.debug(
            f"Checking fields for game {game.id} (manual overrides: {manual_overrides})"
        )

        # Check each field against manual overrides
        if "deck_id" not in manual_overrides:
            update_fields["deck_id"] = jiten_data["deck_id"]
        else:
            skipped_fields.append("deck_id")

        if "title_original" not in manual_overrides and jiten_data.get(
            "title_original"
        ):
            update_fields["title_original"] = jiten_data["title_original"]
        elif "title_original" in manual_overrides:
            skipped_fields.append("title_original")

        if "title_romaji" not in manual_overrides and jiten_data.get("title_romaji"):
            update_fields["title_romaji"] = jiten_data["title_romaji"]
        elif "title_romaji" in manual_overrides:
            skipped_fields.append("title_romaji")

        if "title_english" not in manual_overrides and jiten_data.get("title_english"):
            update_fields["title_english"] = jiten_data["title_english"]
        elif "title_english" in manual_overrides:
            skipped_fields.append("title_english")

        if "type" not in manual_overrides and jiten_data.get("media_type"):
            # Map media type to string
            media_type_map = {1: "Anime", 7: "Visual Novel", 2: "Manga"}
            update_fields["game_type"] = media_type_map.get(
                jiten_data["media_type"], "Unknown"
            )
        elif "type" in manual_overrides:
            skipped_fields.append("type")

        if "description" not in manual_overrides and jiten_data.get("description"):
            update_fields["description"] = jiten_data["description"]
        elif "description" in manual_overrides:
            skipped_fields.append("description")

        if (
            "difficulty" not in manual_overrides
            and jiten_data.get("difficulty") is not None
        ):
            update_fields["difficulty"] = jiten_data["difficulty"]
        elif "difficulty" in manual_overrides:
            skipped_fields.append("difficulty")

        if (
            "character_count" not in manual_overrides
            and jiten_data.get("character_count") is not None
        ):
            update_fields["character_count"] = jiten_data["character_count"]
        elif "character_count" in manual_overrides:
            skipped_fields.append("character_count")

        if "links" not in manual_overrides and jiten_data.get("links"):
            update_fields["links"] = jiten_data["links"]
        elif "links" in manual_overrides:
            skipped_fields.append("links")

        if "release_date" not in manual_overrides and jiten_data.get("release_date"):
            update_fields["release_date"] = jiten_data["release_date"]
        elif "release_date" in manual_overrides:
            skipped_fields.append("release_date")

        # Always re-download image if not manually overridden
        if "image" not in manual_overrides and jiten_data.get("cover_name"):
            image_data = JitenApiClient.download_cover_image(jiten_data["cover_name"])
            if image_data:
                update_fields["image"] = image_data
                logger.debug(f"Downloaded and encoded image for game {game.id}")
            else:
                logger.debug(f"Failed to download image for game {game.id}")
        elif "image" in manual_overrides:
            skipped_fields.append("image")

        # Update the game using the jiten update method (doesn't mark as manual)
        if update_fields:
            game.update_all_fields_from_jiten(**update_fields)
            logger.debug(
                f"Updated game {game.id} ({game.title_original}): {len(update_fields)} fields"
            )
            return {
                "success": True,
                "updated_fields": list(update_fields.keys()),
                "skipped_fields": skipped_fields,
                "error": None,
            }
        else:
            logger.debug(
                f"No fields updated for game {game.id} - all fields are manually overridden"
            )
            return {
                "success": True,
                "updated_fields": [],
                "skipped_fields": skipped_fields,
                "error": None,
            }

    except Exception as e:
        logger.error(
            f"💥 Error updating game {game.id} from jiten data: {e}", exc_info=True
        )
        return {
            "success": False,
            "updated_fields": [],
            "skipped_fields": skipped_fields,
            "error": str(e),
        }


def update_all_jiten_games() -> Dict:
    """
    Update all games that are linked to jiten.moe (have a deck_id).

    This is the main entry point for the jiten update cron job.
    - Continues on errors (individual game failures don't stop the process)
    - Always re-downloads images
    - Adds 1 second delay between games to avoid rate limiting

    Returns:
        Dictionary with summary statistics:
        {
            'total_games': int,           # Total games in database
            'linked_games': int,          # Games with deck_id
            'updated_games': int,         # Successfully updated
            'failed_games': int,          # Failed to update
            'skipped_games': int,         # No deck_id
            'total_fields_updated': int,  # Total fields updated across all games
            'details': List[Dict]         # Per-game details
        }
    """
    logger.debug("Starting jiten.moe update for all linked games")

    start_time = time.time()

    # Get all games
    all_games = GamesTable.all()
    total_games = len(all_games)

    # Filter for linked games (have deck_id)
    linked_games = [game for game in all_games if game.deck_id]
    linked_count = len(linked_games)
    skipped_count = total_games - linked_count

    logger.debug(
        f"Found {total_games} total games, {linked_count} linked to jiten.moe, {skipped_count} unlinked"
    )

    if linked_count == 0:
        logger.debug("No linked games found, nothing to update")
        return {
            "total_games": total_games,
            "linked_games": 0,
            "updated_games": 0,
            "failed_games": 0,
            "skipped_games": skipped_count,
            "total_fields_updated": 0,
            "details": [],
        }

    # Process each linked game
    updated_count = 0
    failed_count = 0
    total_fields_updated = 0
    details = []

    for i, game in enumerate(linked_games, 1):
        logger.debug(
            f"Processing game {i}/{linked_count}: {game.title_original} (deck_id: {game.deck_id})"
        )

        game_detail = {
            "game_id": game.id,
            "title": game.title_original,
            "deck_id": game.deck_id,
            "success": False,
            "updated_fields": [],
            "skipped_fields": [],
            "error": None,
        }

        try:
            # Fetch jiten data
            jiten_data = fetch_jiten_data_for_game(game)

            if jiten_data is None:
                logger.debug(f"Failed to fetch jiten data for game {game.id}, skipping")
                failed_count += 1
                game_detail["error"] = "Failed to fetch jiten data"
                details.append(game_detail)
                continue

            # Update the game
            result = update_single_game_from_jiten(game, jiten_data)

            if result["success"]:
                updated_count += 1
                total_fields_updated += len(result["updated_fields"])
                game_detail["success"] = True
                game_detail["updated_fields"] = result["updated_fields"]
                game_detail["skipped_fields"] = result["skipped_fields"]
            else:
                failed_count += 1
                game_detail["error"] = result["error"]

            details.append(game_detail)

        except Exception as e:
            logger.error(
                f"💥 Unexpected error processing game {game.id}: {e}", exc_info=True
            )
            failed_count += 1
            game_detail["error"] = str(e)
            details.append(game_detail)

        # Add 1 second delay between games (except after the last one)
        if i < linked_count:
            logger.debug(f"Waiting 1 second before next game...")
            time.sleep(1)

    elapsed_time = time.time() - start_time

    # Log summary
    logger.debug("Jiten.moe update completed")
    logger.debug(f"Summary:")
    logger.debug(f"   - Total games: {total_games}")
    logger.debug(f"   - Linked games: {linked_count}")
    logger.debug(f"   - Successfully updated: {updated_count}")
    logger.debug(f"   - Failed: {failed_count}")
    logger.debug(f"   - Skipped (no deck_id): {skipped_count}")
    logger.debug(f"   - Total fields updated: {total_fields_updated}")
    logger.debug(f"   - Time elapsed: {elapsed_time:.2f} seconds")

    return {
        "total_games": total_games,
        "linked_games": linked_count,
        "updated_games": updated_count,
        "failed_games": failed_count,
        "skipped_games": skipped_count,
        "total_fields_updated": total_fields_updated,
        "elapsed_time": elapsed_time,
        "details": details,
    }


# Example usage for testing
if __name__ == "__main__":
    # Run the update
    result = update_all_jiten_games()

    # Print summary
    print("\n" + "=" * 80)
    print("JITEN UPDATE SUMMARY")
    print("=" * 80)
    print(f"Total games: {result['total_games']}")
    print(f"Linked games: {result['linked_games']}")
    print(f"Successfully updated: {result['updated_games']}")
    print(f"Failed: {result['failed_games']}")
    print(f"Skipped (no deck_id): {result['skipped_games']}")
    print(f"Total fields updated: {result['total_fields_updated']}")
    print(f"Time elapsed: {result['elapsed_time']:.2f} seconds")
    print("=" * 80)

    # Print per-game details
    if result["details"]:
        print("\nPER-GAME DETAILS:")
        print("-" * 80)
        for detail in result["details"]:
            status = "✅" if detail["success"] else "❌"
            print(f"{status} {detail['title']} (deck_id: {detail['deck_id']})")
            if detail["updated_fields"]:
                print(f"   Updated: {', '.join(detail['updated_fields'])}")
            if detail["skipped_fields"]:
                print(f"   Skipped: {', '.join(detail['skipped_fields'])}")
            if detail["error"]:
                print(f"   Error: {detail['error']}")
        print("-" * 80)
