# Yomitan Character Dictionary

GameSentenceMiner can generate a Yomitan-compatible dictionary containing character names from your recently played visual novels. This makes it easy to look up character names while reading.

## Features

- **Character Names**: Japanese names (kanji) with romanized readings
- **Character Info**: Role, sex, age, physical stats, and personality traits
- **Character Portraits**: Images from VNDB (if available)
- **Multi-Game Support**: Combines characters from your 3 most recently played games
- **Auto-Updates**: Dictionary can automatically update via Yomitan's update system

## First-Time Setup

### Prerequisites

- GameSentenceMiner running with the web server enabled
- Games with VNDB character data (fetched automatically when you play)
- Yomitan browser extension installed

### Step 1: Download the Dictionary

1. Make sure GSM is running
2. Open your browser and navigate to:
   ```
   http://127.0.0.1:{port}/api/yomitan-dict
   ```
   (Replace `{port}` with your texthooker port, default is usually 9001)
3. The browser will download `gsm_characters.zip`

### Step 2: Import into Yomitan

1. Open Yomitan settings (click the Yomitan icon → gear icon)
2. Go to **Dictionaries** → **Configure installed and enabled dictionaries...**
3. Click **Import**
4. Select the downloaded `gsm_characters.zip` file
5. Wait for import to complete
6. The dictionary will appear as **"GSM (Do not delete)"**

### Step 3: Enable the Dictionary

1. In Yomitan dictionary settings, find "GSM (Do not delete)"
2. Make sure it's enabled (toggle should be on)
3. Optionally adjust priority if you want character names to appear before/after regular dictionary entries

## Auto-Update Feature

The dictionary includes a `downloadUrl` that points back to your local GSM instance. This enables Yomitan's automatic update feature:

1. In Yomitan settings, go to **Dictionaries**
2. Click **Check for updates**
3. If the dictionary content has changed (different games played), Yomitan will offer to update

**Note**: Updates only work while GSM is running.

## Dictionary Content

Each character entry includes:

| Field | Description |
|-------|-------------|
| **Term** | Japanese name (kanji) |
| **Reading** | Romanized name |
| **Portrait** | Character image (if available) |
| **Game** | Which visual novel the character is from |
| **Role** | Protagonist / Main Character / Side Character / Minor Role |
| **Stats** | Sex, age, height, blood type (if available) |
| **Personality** | List of character traits |
| **Description** | Character bio (collapsible) |

### Aliases

Characters may have multiple names (nicknames, alternate readings). Each alias creates a separate dictionary entry that shows the same character information.

## Troubleshooting

### "No games with VNDB character data found"

This means none of your recent games have character data from VNDB. To fix:

1. Make sure you've played at least one visual novel that exists on VNDB
2. GSM automatically fetches character data when you start a game
3. Check the GSM database page to verify character data exists

### Dictionary not updating

- Make sure GSM is running when checking for updates
- The revision is based on the current date - updates are detected when the date changes
- You can manually re-download and re-import at any time

### Images not showing

- Some VNDB entries don't have character images
- Image support requires the character to have an image on VNDB
- Check that the image appears in GSM's database management page

## Technical Details

- **Dictionary Format**: Yomitan format version 3
- **Update URL**: `http://127.0.0.1:{port}/api/yomitan-dict`
- **Revision Format**: YYYY.MM.DD (e.g., "2026.01.01")
- **Games Included**: 3 most recently played (by last line timestamp)

## Why "Do not delete"?

The dictionary is named "GSM (Do not delete)" to remind users that:

1. This is an auto-updating dictionary managed by GSM
2. Deleting it means you'd need to re-import manually
3. The content changes based on which games you play
