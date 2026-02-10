"""
Jiten Upgrader Cron Module
Weekly job to auto-upgrade games from VNDB/AniList to Jiten when available.

This module provides a cron job that:
1. Queries all games with vndb_id or anilist_id (but no deck_id)
2. Checks if Jiten.moe now has entries for these external IDs
3. Auto-links to Jiten if found, downloading metadata and character data

Usage:
    from GameSentenceMiner.util.cron.jiten_upgrader import upgrade_games_to_jiten
    
    # Run the upgrade check
    result = upgrade_games_to_jiten()
    print(f"Upgraded {result['upgraded_to_jiten']} games to Jiten")
"""

import json
import time
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.clients.jiten_api_client import JitenApiClient, JitenLinkType
from typing import Dict, Any, List, Optional

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.shared import GameUpdateService


def upgrade_games_to_jiten() -> Dict[str, Any]:
    """
    Check all games with vndb_id or anilist_id to see if Jiten now has them.
    Auto-link to Jiten if found, respecting manual overrides.
    
    Returns:
        {
            'total_checked': int,
            'upgraded_to_jiten': int,
            'already_on_jiten': int,
            'not_found_on_jiten': int,
            'failed': int,
            'details': [...]  # List of upgrade details
        }
    """
    logger.info("=" * 80)
    logger.info("JITEN UPGRADER - Starting weekly upgrade check")
    logger.info("=" * 80)
    
    start_time = time.time()
    
    # Get all games
    all_games = GamesTable.all()
    
    # Filter for games with external IDs but no Jiten link
    candidates = []
    already_on_jiten = 0
    
    for game in all_games:
        # Skip if already linked to Jiten
        if game.deck_id:
            already_on_jiten += 1
            continue
        
        # Only consider games with VNDB or AniList IDs
        if game.vndb_id or game.anilist_id:
            candidates.append({
                'id': game.id,
                'name': game.title_original,
                'vndb_id': game.vndb_id,
                'anilist_id': game.anilist_id,
                'game': game
            })
    
    total_checked = len(candidates)
    logger.info(f"Found {total_checked} games with VNDB/AniList IDs to check")
    logger.info(f"Already linked to Jiten: {already_on_jiten}")
    
    if total_checked == 0:
        logger.info("No candidates for Jiten upgrade found")
        return {
            'total_checked': 0,
            'upgraded_to_jiten': 0,
            'already_on_jiten': already_on_jiten,
            'not_found_on_jiten': 0,
            'failed': 0,
            'details': [],
            'elapsed_time': time.time() - start_time
        }
    
    # Process each candidate
    upgraded_count = 0
    not_found_count = 0
    failed_count = 0
    details = []
    
    for i, candidate in enumerate(candidates, 1):
        game = candidate['game']
        logger.info(f"[{i}/{total_checked}] Checking: {candidate['name']}")
        
        result = check_and_upgrade_game(game)
        
        if result:
            details.append(result)
            
            if result.get('upgraded'):
                upgraded_count += 1
                logger.info(f"  ✅ Upgraded to Jiten deck_id={result.get('deck_id')}")
            elif result.get('error'):
                failed_count += 1
                logger.warning(f"  ❌ Failed: {result.get('error')}")
            else:
                not_found_count += 1
                logger.info(f"  ⏭️ Not found on Jiten")
        else:
            not_found_count += 1
            details.append({
                'game_id': game.id,
                'name': game.title_original,
                'upgraded': False,
                'reason': 'Not found on Jiten'
            })
        
        # Rate limiting: 1 second delay between API calls
        if i < total_checked:
            time.sleep(1)
    
    elapsed_time = time.time() - start_time
    
    # Log summary
    logger.info("=" * 80)
    logger.info("JITEN UPGRADER - Summary")
    logger.info("=" * 80)
    logger.info(f"Total checked: {total_checked}")
    logger.info(f"Upgraded to Jiten: {upgraded_count}")
    logger.info(f"Already on Jiten: {already_on_jiten}")
    logger.info(f"Not found on Jiten: {not_found_count}")
    logger.info(f"Failed: {failed_count}")
    logger.info(f"Time elapsed: {elapsed_time:.2f} seconds")
    logger.info("=" * 80)
    
    return {
        'total_checked': total_checked,
        'upgraded_to_jiten': upgraded_count,
        'already_on_jiten': already_on_jiten,
        'not_found_on_jiten': not_found_count,
        'failed': failed_count,
        'details': details,
        'elapsed_time': elapsed_time
    }


def check_and_upgrade_game(game: GamesTable) -> Optional[Dict[str, Any]]:
    """
    Check a single game for Jiten availability and upgrade if found.
    
    Args:
        game: GamesTable object with vndb_id or anilist_id
        
    Returns:
        Upgrade result dict or None if no action taken
    """
    result = {
        'game_id': game.id,
        'name': game.title_original,
        'vndb_id': game.vndb_id,
        'anilist_id': game.anilist_id,
        'upgraded': False,
        'deck_id': None,
        'source': None,
        'error': None
    }
    
    deck_ids = []
    lookup_source = None
    
    try:
        # Try VNDB lookup first (Visual Novels)
        if game.vndb_id:
            logger.debug(f"Looking up Jiten by VNDB ID: {game.vndb_id}")
            deck_ids = JitenApiClient.get_deck_by_link_id(JitenLinkType.VNDB, game.vndb_id)
            if deck_ids:
                lookup_source = 'vndb'
                logger.debug(f"Found {len(deck_ids)} Jiten deck(s) via VNDB")
        
        # Try AniList lookup if VNDB didn't find anything
        if not deck_ids and game.anilist_id:
            logger.debug(f"Looking up Jiten by AniList ID: {game.anilist_id}")
            deck_ids = JitenApiClient.get_deck_by_link_id(JitenLinkType.ANILIST, game.anilist_id)
            if deck_ids:
                lookup_source = 'anilist'
                logger.debug(f"Found {len(deck_ids)} Jiten deck(s) via AniList")
        
        # No Jiten entry found
        if not deck_ids:
            result['reason'] = 'Not found on Jiten'
            return result
        
        # Use the first deck_id found
        deck_id = deck_ids[0]
        result['deck_id'] = deck_id
        result['source'] = lookup_source
        
        # Fetch full Jiten metadata
        logger.debug(f"Fetching Jiten deck detail for deck_id={deck_id}")
        deck_detail = JitenApiClient.get_deck_detail(deck_id)
        
        if not deck_detail:
            result['error'] = 'Failed to fetch Jiten deck detail'
            return result
        
        # Extract main deck data
        main_deck = deck_detail.get('data', {}).get('mainDeck')
        if not main_deck:
            result['error'] = 'Invalid Jiten response - no mainDeck'
            return result
        
        # Normalize the deck data
        jiten_data = JitenApiClient.normalize_deck_data(main_deck)
        
        # Update game with Jiten data, respecting manual overrides
        update_fields = GameUpdateService.build_update_fields(
            jiten_data,
            manual_overrides=game.manual_overrides,
            source='jiten'
        )
        
        # Download cover image if not manually overridden
        if 'image' not in game.manual_overrides and jiten_data.get('cover_name'):
            image_data = JitenApiClient.download_cover_image(jiten_data['cover_name'])
            if image_data:
                update_fields['image'] = image_data
        
        # Apply the update
        if update_fields:
            game.update_all_fields_from_jiten(**update_fields)
            
            # Add Jiten link to game links
            GameUpdateService.add_jiten_link_to_game(game, deck_id)
            game.save()
            
            logger.info(f"Successfully upgraded game '{game.title_original}' to Jiten deck_id={deck_id}")
            result['upgraded'] = True
            result['updated_fields'] = list(update_fields.keys())
            
            # Fetch character data based on media type
            fetch_character_data_for_upgraded_game(game, jiten_data)
        
        return result
        
    except Exception as e:
        logger.exception(f"Error checking/upgrading game {game.id}: {e}")
        result['error'] = str(e)
        return result


def fetch_character_data_for_upgraded_game(game: GamesTable, jiten_data: Dict):
    """
    Fetch character data from VNDB/AniList after upgrading to Jiten.
    
    Args:
        game: The upgraded game
        jiten_data: Normalized Jiten data (to check media type)
    """
    try:
        media_type_string = jiten_data.get('media_type_string', '')
        links = jiten_data.get('links', [])
        
        # Visual Novel - fetch from VNDB
        if media_type_string == 'Visual Novel':
            vndb_id = JitenApiClient.extract_vndb_id(links)
            if vndb_id:
                # Update the vndb_id if not already set
                if not game.vndb_id:
                    game.vndb_id = vndb_id
                    game.save()
                
                from GameSentenceMiner.util.clients.vndb_api_client import VNDBApiClient
                logger.info(f"Fetching VNDB character data for VN ID: {vndb_id}")
                vndb_data = VNDBApiClient.process_vn_characters(
                    vndb_id, max_spoiler=2, preserve_spoiler_metadata=True
                )
                
                if vndb_data:
                    game.vndb_character_data = json.dumps(vndb_data, ensure_ascii=False)
                    game.save()
                    logger.info(f"Stored {vndb_data.get('character_count', 0)} VNDB characters")
        
        # Anime or Manga - fetch from AniList
        elif media_type_string in ['Anime', 'Manga']:
            anilist_info = JitenApiClient.extract_anilist_id(links)
            if anilist_info:
                media_id, media_type = anilist_info
                
                # Update the anilist_id if not already set
                if not game.anilist_id:
                    game.anilist_id = str(media_id)
                    game.save()
                
                from GameSentenceMiner.util.clients.anilist_api_client import AniListApiClient
                logger.info(f"Fetching AniList character data for {media_type} ID: {media_id}")
                anilist_data = AniListApiClient.process_media_characters(
                    media_id, media_type, max_spoiler=2, preserve_spoiler_metadata=True
                )
                
                if anilist_data:
                    game.vndb_character_data = json.dumps(anilist_data, ensure_ascii=False)
                    game.save()
                    logger.info(f"Stored {anilist_data.get('character_count', 0)} AniList characters")
                    
    except Exception as e:
        # Character data fetch should not fail the upgrade
        logger.error(f"Failed to fetch character data for game {game.id}: {e}")


# Example usage for testing
if __name__ == '__main__':
    result = upgrade_games_to_jiten()
    
    print("\n" + "=" * 80)
    print("JITEN UPGRADER SUMMARY")
    print("=" * 80)
    print(f"Total checked: {result['total_checked']}")
    print(f"Upgraded to Jiten: {result['upgraded_to_jiten']}")
    print(f"Already on Jiten: {result['already_on_jiten']}")
    print(f"Not found on Jiten: {result['not_found_on_jiten']}")
    print(f"Failed: {result['failed']}")
    print(f"Time elapsed: {result.get('elapsed_time', 0):.2f} seconds")
    print("=" * 80)
    
    # Print per-game details
    if result['details']:
        print("\nDETAILS:")
        print("-" * 80)
        for detail in result['details']:
            status = "✅ Upgraded" if detail.get('upgraded') else "⏭️ Skipped"
            if detail.get('error'):
                status = "❌ Failed"
            print(f"{status}: {detail['name']}")
            if detail.get('deck_id'):
                print(f"   Jiten deck_id: {detail['deck_id']} (via {detail.get('source', 'unknown')})")
            if detail.get('error'):
                print(f"   Error: {detail['error']}")
        print("-" * 80)
