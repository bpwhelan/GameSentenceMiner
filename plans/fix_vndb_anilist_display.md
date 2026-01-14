# Fix VNDB/AniList Data Display and Repull Button

## Problem
Games with only VNDB or AniList IDs (no Jiten deck_id) are missing data in the Edit modal and may not show the Repull button correctly.

## Root Cause
The `/api/games-management` endpoint uses `vndb_id` and `anilist_id` to calculate `is_linked` but doesn't include these fields in the API response, so the frontend never receives them.

## Files to Modify

### 1. Backend: GameSentenceMiner/web/jiten_database_api.py
**Location:** Lines 170-201 in the `games_data.append()` dictionary

**Change:** Add two fields to the response:
```python
"vndb_id": game.vndb_id,
"anilist_id": game.anilist_id,
```

**Full context (lines 170-201):**
```python
games_data.append(
    {
        "id": game.id,
        "title_original": game.title_original,
        "title_romaji": game.title_romaji,
        "title_english": game.title_english,
        "type": game.type,
        "description": game.description,
        "image": game.image,
        "deck_id": game.deck_id,
        "vndb_id": game.vndb_id,          # ADD THIS LINE
        "anilist_id": game.anilist_id,    # ADD THIS LINE
        "difficulty": game.difficulty,
        "completed": game.completed,
        "is_linked": is_linked,
        "has_manual_overrides": has_manual_overrides,
        "manual_overrides": game.manual_overrides,
        "line_count": line_count,
        "mined_character_count": actual_char_count,
        "jiten_character_count": game.character_count,
        "start_date": start_date,
        "last_played": last_played,
        "links": game.links,
        "release_date": game.release_date,
        "genres": game.genres if hasattr(game, "genres") else [],
        "tags": game.tags if hasattr(game, "tags") else [],
        "obs_scene_name": game.obs_scene_name
        if hasattr(game, "obs_scene_name")
        else "",
        "character_summary": game.character_summary
        if hasattr(game, "character_summary")
        else "",
    }
)
```

## Expected Results After Fix

### For your "one night, hot springs" game:
1. ✅ Edit modal will show `vndb_id: v22619` in the VNDB ID field
2. ✅ Edit modal will display description, links, and other VNDB data
3. ✅ Repull button will appear (since `is_linked` will be true)
4. ✅ Repull will work correctly using the VNDB ID

### General improvements:
- All games with VNDB IDs will display correctly
- All games with AniList IDs will display correctly
- Mixed-source games (e.g., Jiten + VNDB) will show all IDs
- Repull button will appear for any linked game regardless of source

## Testing Checklist

After implementing the fix, verify:

1. **API Response Test:**
   - Call `/api/games-management`
   - Verify response includes `vndb_id` and `anilist_id` fields
   - Check that games with these IDs have them populated

2. **Edit Modal Test:**
   - Open Edit modal for "one night, hot springs"
   - Verify VNDB ID field shows "v22619"
   - Verify description and other fields are populated
   - Verify Links section shows the VNDB URL

3. **Repull Button Test:**
   - Check that Repull button appears for VNDB-only games
   - Check that Repull button appears for AniList-only games
   - Verify button is labeled "🔄 Repull"

4. **Repull Functionality Test:**
   - Click Repull button on VNDB-only game
   - Verify it fetches fresh VNDB metadata
   - Check console logs show "Sources used: vndb"

5. **Manual Override Test:**
   - Edit VNDB ID field in Edit modal
   - Save changes
   - Verify field is marked as manual override
   - Verify Repull respects the manual override

## Impact Analysis

### Benefits:
- Fixes data display for all VNDB/AniList linked games
- Ensures Repull button appears consistently
- Improves data transparency for users

### Risks:
- Very low risk - only adding fields to existing response
- No breaking changes to frontend (fields are optional)
- Frontend already has input fields for these IDs

### Rollback:
If issues occur, simply remove the two added lines from the API response.
