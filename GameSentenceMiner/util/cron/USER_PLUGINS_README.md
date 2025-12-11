# User Plugins System

The User Plugins system allows you to customise GameSentenceMiner's behavior by writing Python code that runs automatically every 5 minutes.

**WARNING** Advanced Users only. Your data is at risk.

The GSM api is made for internal use only, so its kinda scuffed for anyone else using it.

Make sure you are absolutely positive it does what you want it to do. Read both the API docs and the code.

API docs: http://localhost:55000/api/docs#

## Quick Start

## 1. Edit Your Plugins File

Open the `plugins.py` file at: `%APPDATA%\GameSentenceMiner\plugins.py` (Windows)

Or right clck the GSM icon in the tray, click open folder and find plugins.py

While you are in this folder, **copy gsm.db** to another folder to back it up before messing with this.

Write functions called by `main()` to make GSM do stuff.

```python
def main():
    hello_world()

def hello_world():
    print("Hello, World!")
```

### 2. Save and Done!

The plugins will run automatically every 5 minutes. No restart needed.

## Example Plugin Functions

Copy these ready-to-use examples into your `plugins.py` file:

### 1. Delete Duplicates from Games

**IMPORTANT**: Read the code example. I added a lot of comments to this one specifically to help you understand how this works.

**IMPORtANT**: You must read the API docs before running any examples. This is really dangerous.

Removes duplicate sentences from selected games:

```python
def delete_duplicates_from_games(games=None, case_sensitive=False, preserve_newest=False):
    """
    Delete duplicate sentences from games using GSM API.
    
    Args:
        games: List of game names to check, or ["all"] for all games (default: ["all"])
        case_sensitive: Whether to compare text case-sensitively (default: False)
        preserve_newest: Whether to keep the newest duplicate instead of oldest (default: False)
    """
    # GSM comes with requests built in, see pyproject.toml in github for other libraries u can use for free
    # alternatively in python tab install a package u want
    import requests
    # gsm uses this for logging
    from GameSentenceMiner.util.configuration import logger
    
    try:
        if not games:
            # be very careful with this
            # this will delete all duplicates globally
            # if you do not set a time window and have games == all, very bad things will happen
            # for example, it will delete "arigatou" from EVERY game ever
            # If you want to use "all", set a time window.
            # If you do not want a time window, set a specific game.
            games = [all]
            # I believe games needs to be GameID from games_table
            # there is an API to get this
            # I will link proper API docs later on, this is just an example
        
        # Prepare API request
        payload = {
            "games": games,
            "case_sensitive": case_sensitive,
            "preserve_newest": preserve_newest,
            "time_window_minutes": 5,
            # you probably want a time window
            # for example if someone says arigatou and then 50 mins later they say this it will be deleted if no time window is set
            # time window says "if its a duplicate within 5 mins, delete"
            # for example, texthooker spam or something
            "ignore_time_window": True  # Find all duplicates in entire game
        }
        
        # Call the deduplication API
        response = requests.post(
            # IMPORTANT you should use /api/preview-deduplication first to preview
            "http://localhost:5000/api/deduplicate",
            # A lot of APIs have previews, if it doesn't have a preview use the search functionality to test
            json=payload,
            timeout=300
        )
        
        if response.status_code == 200:
            # this will appear in gsm console as you use logger
            result = response.json()
            deleted_count = result.get("deleted_count", 0)
            if deleted_count > 0:
                logger.info(f"[Plugin] Deleted {deleted_count} duplicate sentences")
            else:
                logger.info("[Plugin] No duplicates found")
        else:
            logger.error(f"[Plugin] API error: {response.status_code} - {response.text}")
        
    except requests.exceptions.RequestException as e:
        logger.error(f"[Plugin] Failed to connect to GSM API: {e}", exc_info=True)
    except Exception as e:
        logger.error(f"[Plugin] Error in delete_duplicates_from_games: {e}", exc_info=True)


def main():
    # Call it like this:
    delete_duplicates_from_games(games=["all"])
```

### 2. Delete Lines Matching Regex

Deletes entire lines that match a pattern:

```python
def delete_lines_matching_regex(pattern=r"^(選択肢|選択)", case_sensitive=False):
    """
    Delete all lines that match a regex pattern using GSM API.
    
    Args:
        pattern: Regex pattern to match
        case_sensitive: Whether pattern matching is case-sensitive (default: False)
    """
    import requests
    from GameSentenceMiner.util.configuration import logger
    
    try:
        # Prepare API request
        payload = {
            # ur regex goes here
            "regex_pattern": pattern,
            "case_sensitive": case_sensitive,
            "use_regex": True
        }
        
        # Call the delete text lines API
        response = requests.post(
            "http://localhost:5000/api/delete-text-lines",
            json=payload,
            timeout=300
        )
        
        if response.status_code == 200:
            result = response.json()
            deleted_count = result.get("deleted_count", 0)
            if deleted_count > 0:
                logger.info(f"[Plugin] Deleted {deleted_count} lines matching pattern: {pattern}")
            else:
                logger.info(f"[Plugin] No lines matched pattern: {pattern}")
        else:
            logger.error(f"[Plugin] API error: {response.status_code} - {response.text}")
        
    except requests.exceptions.RequestException as e:
        logger.error(f"[Plugin] Failed to connect to GSM API: {e}", exc_info=True)
    except Exception as e:
        logger.error(f"[Plugin] Error in delete_lines_matching_regex: {e}", exc_info=True)


def main():
    # Call it like this:
    delete_lines_matching_regex(pattern=r"^(選択肢|選択)")
```

Use https://regex101.com/ to build your regex.

Or go to search here http://localhost:55000/search

And select one of our prebuilt regex, and copy that to use.

Test your regex by going here:
http://localhost:55000/search
Enabling "use regex" in advanced options.

Every single line you see in search will be deleted.

### 3. Cleanup Regex from Lines

Removes patterns from within lines (doesn't delete the line):

```python
def cleanup_regex_from_lines(pattern=r"【.*?】", case_sensitive=False):
    """
    Remove regex pattern from within lines using GSM API (doesn't delete the line, just cleans it).
    
    Args:
        pattern: Regex pattern to remove from lines
        case_sensitive: Whether pattern matching is case-sensitive (default: False)
    """
    import requests
    from GameSentenceMiner.util.configuration import logger
    
    try:
        # Prepare API request
        payload = {
            "regex_pattern": pattern,
            "case_sensitive": case_sensitive
        }
        
        # Call the regex cleanup API
        response = requests.post(
            "http://localhost:5000/api/delete-regex-in-game-lines",
            json=payload,
            timeout=300
        )
        
        if response.status_code == 200:
            result = response.json()
            updated_count = result.get("updated_count", 0)
            if updated_count > 0:
                logger.info(f"[Plugin] Cleaned {updated_count} lines (removed pattern: {pattern})")
            else:
                logger.info(f"[Plugin] No lines needed cleaning for pattern: {pattern}")
        else:
            logger.error(f"[Plugin] API error: {response.status_code} - {response.text}")
        
    except requests.exceptions.RequestException as e:
        logger.error(f"[Plugin] Failed to connect to GSM API: {e}", exc_info=True)
    except Exception as e:
        logger.error(f"[Plugin] Error in cleanup_regex_from_lines: {e}", exc_info=True)


def main():
    # Call it like this:
    cleanup_regex_from_lines(pattern=r"【.*?】")
```

## Available GSM API Endpoints

Start GSM and go to this URL to see all available API endpoints you can use:

http://localhost:55000/api/docs

Use Requests to call these. Be careful. Your data could be deleted if you do this wrong. Make many backups.

## Tips and Best Practices

**IMPORTANT** Back up your database manually before writing a plugin.
Extensively test your plugin code to make sure it is safe for you.

If your data is deleted and you want it back, and there's no backups, there is no way to get it back.

1. **Start Small**: Enable one plugin at a time to test
2. **Use Logging**: Add `logger.info("[Plugin] ...")` to track execution
3. **Test Patterns**: Test regex patterns before using them
4. **Backup**: The database is at `%APPDATA%\GameSentenceMiner\gsm.db`
5. **Comment Out**: Use `#` to disable plugins instead of deleting code
6. **Error Handling**: Plugins catch errors automatically, check logs
7. **API Timeouts**: Use appropriate timeout values for long operations
8. **Check Responses**: Always check `response.status_code` before processing results

## Troubleshooting

### My plugin isn't running

1. Wait 5 minutes, plugins run every 5 minutes.
2. Check logs in console.

### How do I test without waiting

You can run plugins manually:

```bash
python -c "from GameSentenceMiner.util.cron.user_plugins import execute_user_plugins; execute_user_plugins()"
```

But probably best to wait.

# Ideas
* Use ntfy to ping your phone / computer with a reminder to complete your dailies if not done.
* Once your dailies are done, generate statistics and post them to a Discord channel for accountability.
* Build your own stats dashboard / graphing program
* Integrate your apps (Toggl, Anki, Bunpro, Wanikani) into a unified "this is what I did this week" program
* Export stats to Excel
* Download your data from another service, convert to ExStatic format and automatically import that into GSM

If you make a cool plugin, please share it in #resource-sharing in the Discord!

# Real world example

This is **my** plugin file:

```python
"""
User Plugins - Runs every minute via GSM cron system

Edit this file to customize GSM behavior. See USER_PLUGINS_README.md for full documentation.
https://github.com/YOUR_REPO/blob/main/GameSentenceMiner/util/cron/USER_PLUGINS_README.md

Your code runs automatically every minute when enabled.
"""

def main():
    """
    Main entry point - called every minute by GSM cron system.
    Add your custom code here.
    """
    dailies()


def delete_duplicates_from_games():
    import requests
    from GameSentenceMiner.util.configuration import logger

    # from all games
    games = ["all"]
    # delete all lines:
    # regardless of case
    case = "case_insensitive"
    # within 5 minutes of each other
    window = 5
    # burt keep the newest line
    preserve = "preserve_newest"

    payload = {
            "games": games,
            "case_sensitive": case,
            "preserve_newest": preserve,
            "time_window_minutes": window,
            "ignore_time_window": False
    }

    response = requests.post(
        "http://localhost:5000/api/preview-deduplication",
        json=payload,
        timeout=300
    )

    if response.status_code == 200:
        deleted_count = result.get("deleted_count", 0)
        # 100 duplicates within 5 mins of each other, alert me as it may be a bug
        if deleted_count > 100:
            logger.error("[Plugin] Deduplicate might be broken. More than 100 dupes")
            send_notification("[Plugin] Deduplicate might be broken. More than 100 dupes")
            # i think exit() would make GSM really really unhappy, which is good, I want to be alerted ASAP
            exit()

    else:
        logger.error(f"[Plugin] API error: {response.status_code} - {response.text}")
    
    # now do it for realsies
    response = requests.post(
        "http://localhost:5000/api/deduplicate",
        json=payload,
        timeout=300
    )

    if response.status_code == 200:
        deleted_count = result.get("deleted_count", 0)
        if deleted_count > 0:
            logger.info(f"[Plugin] Deleted {deleted_count} duplicate sentences")
            send_notification(f"[Plugin] Deleted {deleted_count} duplicate sentences")
        else:
            logger.info("[Plugin] No duplicates found")
    else:
        logger.error(f"[Plugin] API error: {response.status_code} - {response.text}")
    
def send_notification(message):
    # uses https://ntfy.sh/ to send notifications to me phone
    requests.post("https://ntfy.sh/gsm",data=message.encode(encoding='utf-8'))

def dailies():
    import random
    import requests
    # this runs every 5 mins
    # in a 1 hour session thats 12
    x = random.randint(0, 11)
    if x > 0:
        # easy cheat way to run once an hour roughly
        return
    message = []
    data = requests.get("http://localhost:5050/api/goals/today").json()
    for g in data.get("goals", []):
        name = g.get("goal_name")
        today = g.get("progress_today")
        needed = g.get("progress_needed")
        icon = g.get("goal_icon", "🎯")
        message.append(f"{icon} {name}: {today}/{needed}")
    output =  "\n".join(message)
    send_notification(output)

def delete_regex_lines():
    import requests
    from GameSentenceMiner.util.configuration import logger
    import re

    # anything over 50 chars gets deleted
    pattern = re.compile(r"^.{51,}$")
    try:
        # Prepare API request
        payload = {
            # ur regex goes here
            "regex_pattern": pattern,
            "case_sensitive": False,
            "use_regex": True
        }
        
        # Call the delete text lines API
        response = requests.post(
            "http://localhost:5000/api/delete-text-lines",
            json=payload,
            timeout=300
        )
        
        if response.status_code == 200:
            result = response.json()
            deleted_count = result.get("deleted_count", 0)
            if deleted_count > 0:
                logger.info(f"[Plugin] Deleted {deleted_count} lines matching pattern: {pattern}")
                send_notification(f"[Plugin] Deleted {deleted_count} lines matching pattern: {pattern}")
            else:
                logger.info(f"[Plugin] No lines matched pattern: {pattern}")
        else:
            logger.error(f"[Plugin] API error: {response.status_code} - {response.text}")
        
    except requests.exceptions.RequestException as e:
        logger.error(f"[Plugin] Failed to connect to GSM API: {e}", exc_info=True)
    except Exception as e:
        logger.error(f"[Plugin] Error in delete_lines_matching_regex: {e}", exc_info=True)
```