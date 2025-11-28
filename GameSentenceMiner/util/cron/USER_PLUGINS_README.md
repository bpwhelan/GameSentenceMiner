# User Plugins System

The User Plugins system allows you to customize GameSentenceMiner's behavior by writing Python code that runs automatically every minute.

## Quick Start

### 1. Enable the Plugin System

Run the setup script once:

```bash
python -m GameSentenceMiner.util.cron.setup_user_plugins_cron
```

This creates:
- A cron job that runs every minute
- A `plugins.py` template file at: `%APPDATA%\GameSentenceMiner\plugins.py` (Windows)

### 2. Edit Your Plugins File

Open the `plugins.py` file (location shown by setup script) and uncomment the plugins you want to enable:

```python
def main():
    """Uncomment plugins you want to enable"""
    delete_duplicates_from_timeframe()  # ✅ Enabled
    # delete_lines_matching_regex()     # ❌ Disabled (commented)
    # cleanup_regex_from_lines()        # ❌ Disabled (commented)
```

### 3. Save and Done!

The plugins will run automatically every minute. No restart needed.

## Example Plugin Functions

Copy these ready-to-use examples into your `plugins.py` file:

### 1. Delete Duplicates from Timeframe

Removes duplicate sentences from recent days:

```python
def delete_duplicates_from_timeframe(days_back=7, games=None, case_sensitive=False):
    """
    Delete duplicate sentences from the last N days.
    
    Args:
        days_back: Number of days to look back (default: 7)
        games: List of game names to check, or None for all games
        case_sensitive: Whether to compare text case-sensitively
    """
    import time
    import re
    from collections import defaultdict
    from GameSentenceMiner.util.configuration import logger
    from GameSentenceMiner.util.db import GameLinesTable
    
    try:
        # Calculate time window
        cutoff_time = time.time() - (days_back * 24 * 60 * 60)
        
        # Get lines from selected games
        if games:
            all_lines = []
            for game_name in games:
                game_lines = GameLinesTable.get_all_lines_for_scene(game_name)
                all_lines.extend(game_lines)
        else:
            all_lines = GameLinesTable.all()
        
        # Filter to only lines within timeframe
        recent_lines = [
            line for line in all_lines
            if line.timestamp and float(line.timestamp) >= cutoff_time
        ]
        
        if not recent_lines:
            logger.info(f"[Plugin] No lines found in last {days_back} days")
            return
        
        # Group by game and sort by timestamp
        game_lines = defaultdict(list)
        for line in recent_lines:
            game_name = line.game_name or "Unknown Game"
            game_lines[game_name].append(line)
        
        for game_name in game_lines:
            game_lines[game_name].sort(key=lambda x: float(x.timestamp))
        
        # Find duplicates
        duplicates_to_remove = []
        for game_name, lines in game_lines.items():
            seen_texts = {}
            for line in lines:
                if not line.line_text or not line.line_text.strip():
                    continue
                
                line_text = line.line_text if case_sensitive else line.line_text.lower()
                
                if line_text in seen_texts:
                    duplicates_to_remove.append(line.id)
                else:
                    seen_texts[line_text] = line.id
        
        # Delete duplicates
        deleted_count = 0
        for line_id in set(duplicates_to_remove):
            try:
                GameLinesTable._db.execute(
                    f"DELETE FROM {GameLinesTable._table} WHERE id=?",
                    (line_id,),
                    commit=True,
                )
                deleted_count += 1
            except Exception as e:
                logger.warning(f"[Plugin] Failed to delete duplicate line {line_id}: {e}")
        
        if deleted_count > 0:
            logger.info(f"[Plugin] Deleted {deleted_count} duplicate sentences from last {days_back} days")
        
    except Exception as e:
        logger.error(f"[Plugin] Error in delete_duplicates_from_timeframe: {e}", exc_info=True)


def main():
    # Call it like this:
    delete_duplicates_from_timeframe(days_back=7)
```

**Use cases:**
- Clean up duplicates after importing data
- Remove repeated common phrases
- Keep only first occurrence of each sentence

### 2. Delete Lines Matching Regex

Deletes entire lines that match a pattern:

```python
def delete_lines_matching_regex(pattern=r"^(選択肢|選択)", case_sensitive=False, games=None):
    """
    Delete all lines that match a regex pattern.
    
    Args:
        pattern: Regex pattern to match
        case_sensitive: Whether pattern matching is case-sensitive
        games: List of game names to check, or None for all games
    """
    import re
    from GameSentenceMiner.util.configuration import logger
    from GameSentenceMiner.util.db import GameLinesTable
    
    try:
        # Get lines
        if games:
            all_lines = []
            for game_name in games:
                game_lines = GameLinesTable.get_all_lines_for_scene(game_name)
                all_lines.extend(game_lines)
        else:
            all_lines = GameLinesTable.all()
        
        if not all_lines:
            logger.info("[Plugin] No lines found in database")
            return
        
        # Compile regex
        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            regex = re.compile(pattern, flags)
        except re.error as e:
            logger.error(f"[Plugin] Invalid regex pattern: {e}")
            return
        
        # Find matching lines
        lines_to_delete = []
        for line in all_lines:
            if line.line_text and isinstance(line.line_text, str):
                try:
                    if regex.search(line.line_text):
                        lines_to_delete.append(line.id)
                except Exception as e:
                    logger.warning(f"[Plugin] Regex search error on line {line.id}: {e}")
        
        # Delete matching lines
        deleted_count = 0
        for line_id in set(lines_to_delete):
            try:
                GameLinesTable._db.execute(
                    f"DELETE FROM {GameLinesTable._table} WHERE id=?",
                    (line_id,),
                    commit=True,
                )
                deleted_count += 1
            except Exception as e:
                logger.warning(f"[Plugin] Failed to delete line {line_id}: {e}")
        
        if deleted_count > 0:
            logger.info(f"[Plugin] Deleted {deleted_count} lines matching pattern: {pattern}")
        
    except Exception as e:
        logger.error(f"[Plugin] Error in delete_lines_matching_regex: {e}", exc_info=True)


def main():
    # Call it like this:
    delete_lines_matching_regex(pattern=r"^(選択肢|選択)")
```

**Common patterns:**
- `r"^\s*$"` - Delete empty lines
- `r"^(選択肢|選択)"` - Delete VN choice text
- `r"【.*?】"` - Delete lines with 【】 brackets
- `r"^[A-Z]{2,}:"` - Delete lines like "NARRATOR:"

### 3. Cleanup Regex from Lines

Removes patterns from within lines (doesn't delete the line):

```python
def cleanup_regex_from_lines(pattern=r"【.*?】", replacement="", games=None):
    """
    Remove regex pattern from within lines (doesn't delete the line, just cleans it).
    
    Args:
        pattern: Regex pattern to remove from lines
        replacement: What to replace matches with (default: empty string)
        games: List of game names to check, or None for all games
    """
    import re
    from GameSentenceMiner.util.configuration import logger
    from GameSentenceMiner.util.db import GameLinesTable
    
    try:
        # Get lines
        if games:
            all_lines = []
            for game_name in games:
                game_lines = GameLinesTable.get_all_lines_for_scene(game_name)
                all_lines.extend(game_lines)
        else:
            all_lines = GameLinesTable.all()
        
        if not all_lines:
            logger.info("[Plugin] No lines found in database")
            return
        
        # Compile regex
        try:
            regex = re.compile(pattern)
        except re.error as e:
            logger.error(f"[Plugin] Invalid regex pattern: {e}")
            return
        
        # Clean matching lines
        modified_count = 0
        for line in all_lines:
            if line.line_text and isinstance(line.line_text, str):
                try:
                    new_text = regex.sub(replacement, line.line_text)
                    if new_text != line.line_text:
                        GameLinesTable._db.execute(
                            f"UPDATE {GameLinesTable._table} SET line_text=? WHERE id=?",
                            (new_text, line.id),
                            commit=True,
                        )
                        modified_count += 1
                except Exception as e:
                    logger.warning(f"[Plugin] Regex cleanup error on line {line.id}: {e}")
        
        if modified_count > 0:
            logger.info(f"[Plugin] Cleaned {modified_count} lines (removed pattern: {pattern})")
        
    except Exception as e:
        logger.error(f"[Plugin] Error in cleanup_regex_from_lines: {e}", exc_info=True)


def main():
    # Call it like this:
    cleanup_regex_from_lines(pattern=r"【.*?】")
```

**Common patterns:**
- `r"【.*?】"` - Remove 【character names】
- `r"\[.*?\]"` - Remove [brackets]
- `r"<.*?>"` - Remove <HTML tags>
- `r"\s{2,}"` - Replace multiple spaces with single space

## Writing Custom Plugins

Add your own functions to `plugins.py`:

```python
def my_custom_plugin():
    """Your custom plugin"""
    from GameSentenceMiner.util.configuration import logger
    from GameSentenceMiner.util.db import GameLinesTable
    
    try:
        # Get all lines
        all_lines = GameLinesTable.all()
        
        # Or get lines from specific game
        game_lines = GameLinesTable.get_all_lines_for_scene("MyGame")
        
        # Process lines
        for line in all_lines:
            # Your logic here
            pass
        
        logger.info("[Plugin] My custom plugin completed")
        
    except Exception as e:
        logger.error(f"[Plugin] Error: {e}", exc_info=True)
```

Then call it in `main()`:

```python
def main():
    my_custom_plugin()
```

## Available Utilities

Your plugins have access to:

- `GameLinesTable` - Database operations
- `logger` - Logging (use `logger.info("[Plugin] message")`)
- `time`, `datetime`, `timedelta` - Time utilities
- `re` - Regular expressions
- `defaultdict` - Collections

## Database Operations

### Get Lines

```python
# All lines
all_lines = GameLinesTable.all()

# Lines from specific game
game_lines = GameLinesTable.get_all_lines_for_scene("Game Name")

# All game names
games = GameLinesTable.get_all_games_with_lines()
```

### Modify Lines

```python
# Delete a line
GameLinesTable._db.execute(
    f"DELETE FROM {GameLinesTable._table} WHERE id=?",
    (line_id,),
    commit=True,
)

# Update a line's text
GameLinesTable._db.execute(
    f"UPDATE {GameLinesTable._table} SET line_text=? WHERE id=?",
    (new_text, line_id),
    commit=True,
)
```

### Line Object Properties

```python
line.id            # Unique ID
line.line_text     # The sentence text
line.game_name     # Game name
line.timestamp     # Unix timestamp
line.audio_path    # Path to audio file
line.screenshot_path  # Path to screenshot
```

## Managing the Cron Job

### Disable

```bash
python -m GameSentenceMiner.util.cron.setup_user_plugins_cron --disable
```

### Re-enable

```bash
python -m GameSentenceMiner.util.cron.setup_user_plugins_cron
```

### Check Status

Check the GSM logs at `%APPDATA%\GameSentenceMiner\logs\gamesentenceminer.log`

Look for lines containing `[Plugin]`

## Tips and Best Practices

1. **Start Small**: Enable one plugin at a time to test
2. **Use Logging**: Add `logger.info("[Plugin] ...")` to track execution
3. **Test Patterns**: Test regex patterns before using them
4. **Backup**: The database is at `%APPDATA%\GameSentenceMiner\gsm.db`
5. **Comment Out**: Use `#` to disable plugins instead of deleting code
6. **Error Handling**: Plugins catch errors automatically, check logs

## Troubleshooting

### My plugin isn't running

1. Check if it's uncommented in `main()`
2. Check logs for errors: `%APPDATA%\GameSentenceMiner\logs\gamesentenceminer.log`
3. Verify the cron is enabled: setup script shows status

### How do I test without waiting

You can run plugins manually:

```bash
python -c "from GameSentenceMiner.util.cron.user_plugins import execute_user_plugins; execute_user_plugins()"
```

### Regex isn't matching

- Test patterns at https://regex101.com/
- Remember `\` needs to be `\\` in Python strings
- Use raw strings: `r"pattern"` instead of `"pattern"`

## Examples

### Delete all empty lines

```python
# Add this to your plugins.py:
def main():
    delete_lines_matching_regex(pattern=r"^\s*$")
```

### Clean VN formatting

```python
# Add all three functions above to your plugins.py, then:
def main():
    # Remove character names
    cleanup_regex_from_lines(pattern=r"【.*?】")
    # Remove choices
    delete_lines_matching_regex(pattern=r"^(選択肢|選択)")
    # Clean duplicates from last 24 hours
    delete_duplicates_from_timeframe(days_back=1)
```

### Game-specific cleaning

```python
# Add the cleanup function above to your plugins.py, then:
def main():
    cleanup_regex_from_lines(
        pattern=r"\[.*?\]",
        games=["Visual Novel 1", "Visual Novel 2"]
    )
```

## Schedule Information

- **Frequency**: Every 1 minute (minutely)
- **Execution**: Via GSM's cron system
- **Location**: `%APPDATA%\GameSentenceMiner\plugins.py`
- **Logs**: `%APPDATA%\GameSentenceMiner\logs\gamesentenceminer.log`