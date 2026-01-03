# Yomitan Dictionary Download Fix Plan

## Problem
When clicking "Download Dictionary" in the GSM web interface, users get a "file not available" error if their 3 most recently played games don't have VNDB character data.

## Root Cause
The [`get_recent_games()`](GameSentenceMiner/web/yomitan_api.py:17) function:
1. Queries for the 3 most recently played games (any games)
2. Then filters to only return games that have `vndb_character_data`
3. If none of those 3 games have character data → returns empty list → 404 error

## Solution (Option A - Fast Query)
Modify the SQL query to filter for games WITH character data directly in the database query, rather than filtering after retrieval.

### Implementation Steps

#### 1. Update `get_recent_games()` SQL Query
**File:** `GameSentenceMiner/web/yomitan_api.py`

**Current Query:**
```python
query = '''
    SELECT game_id, MAX(timestamp) as last_played
    FROM game_lines
    WHERE game_id IS NOT NULL AND game_id != ''
    GROUP BY game_id
    ORDER BY last_played DESC
    LIMIT ?
'''
rows = GameLinesTable._db.fetchall(query, (limit,))

games = []
for row in rows:
    game_id = row[0]
    game = GamesTable.get(game_id)
    if game and game.vndb_character_data:  # <-- Filtering AFTER query
        games.append(game)
```

**New Query:**
```python
query = '''
    SELECT gl.game_id, MAX(gl.timestamp) as last_played
    FROM game_lines gl
    INNER JOIN games g ON gl.game_id = g.game_id
    WHERE gl.game_id IS NOT NULL 
      AND gl.game_id != ''
      AND g.vndb_character_data IS NOT NULL
      AND g.vndb_character_data != ''
    GROUP BY gl.game_id
    ORDER BY last_played DESC
    LIMIT ?
'''
rows = GameLinesTable._db.fetchall(query, (limit,))

games = []
for row in rows:
    game_id = row[0]
    game = GamesTable.get(game_id)
    if game:  # Already filtered in SQL
        games.append(game)
```

#### 2. Improve Error Handling
**File:** `GameSentenceMiner/web/yomitan_api.py`

**Current Error:**
```python
if not recent_games:
    return jsonify({"error": "No games with VNDB character data found"}), 404
```

**Improved Error:**
```python
if not recent_games:
    return jsonify({
        "error": "No games with VNDB character data found",
        "message": "To use the Yomitan dictionary feature, you need to link your games to jiten.moe/VNDB. Visit the Database page to link your games.",
        "action": "Go to Database → Link Games to get started"
    }), 404
```

#### 3. Optional: Add UI Indicator
**File:** `GameSentenceMiner/web/templates/database.html`

Add a visual indicator showing which games have character data available for the Yomitan dictionary. This could be:
- A badge/icon on games with character data in the game list
- A count showing "X games available for dictionary"
- A status message on the Yomitan card itself

## Benefits
- ✅ More efficient - filters in SQL rather than Python
- ✅ Always returns games that work (have character data)
- ✅ Better error messages guide users to fix the issue
- ✅ Simple implementation - single query change

## Trade-offs
- ⚠️ May return older games if recent games lack character data
  - User confirmed this is acceptable

## Testing Checklist
- [ ] Download works when all recent games have character data
- [ ] Download works when only some games have character data
- [ ] Proper error message when NO games have character data
- [ ] Verify character images load correctly in dictionary
- [ ] Test with 1, 2, and 3+ games with character data
