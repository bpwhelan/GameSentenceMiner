# VNDB Yomitan Dictionary Generator

A tool to scrape ALL visual novels from VNDB and generate a Yomitan dictionary containing character names for use with Japanese reading tools.

## What Data We Scrape

### Visual Novel Metadata
- `id` - VNDB ID (e.g., "v17")
- `title` - Romanized title
- `title_original` - Original Japanese title
- `developers` - List of developer names
- `release_date` - Release date

### Character Data
For each character in every VN:
- `id` - Character ID (e.g., "c123")
- `name` - Romanized name (e.g., "Okabe Rintarou")
- `name_original` - Japanese name (e.g., "岡部倫太郎")
- `aliases` - Alternative names/nicknames
- `role` - Character role: `main`, `primary`, `side`, or `appears`
- `description` - Character description text
- `image_path` - Local path to downloaded character image
- `traits` - Personality traits, roles, etc. (with spoiler levels)

### Character Images
- Downloaded as separate files (jpg/png)
- Stored locally for offline dictionary building
- Converted to base64 when building the Yomitan dictionary

## How We Store It

All data is stored in `GameSentenceMiner/vndb_scrape_data/`:

```
vndb_scrape_data/
├── progress.json              # Scraping progress & stats
├── vns/
│   ├── v1.json               # VN + characters data
│   ├── v2.json
│   ├── v17.json              # Steins;Gate
│   └── ...
├── images/
│   ├── c123.jpg              # Character images
│   ├── c456.png
│   └── ...
└── output/
    └── vndb_characters.zip    # Final Yomitan dictionary
```

### progress.json
Tracks scraping state for resumability:
```json
{
  "last_processed_id": 12345,
  "total_vns_found": 8000,
  "total_characters": 150000,
  "started_at": "2024-01-16T10:00:00",
  "last_updated": "2024-01-16T15:30:00",
  "rate_limit_state": {
    "requests_in_window": 50,
    "window_start": "2024-01-16T15:25:00"
  }
}
```

### VN JSON Files (vns/v{id}.json)
Each VN is stored as a separate JSON file:
```json
{
  "id": "v17",
  "title": "Steins;Gate",
  "title_original": "シュタインズ・ゲート",
  "developers": ["5pb.", "Nitroplus"],
  "release_date": "2009-10-15",
  "characters": [
    {
      "id": "c123",
      "name": "Okabe Rintarou",
      "name_original": "岡部倫太郎",
      "aliases": ["Hououin Kyouma", "鳳凰院凶真"],
      "role": "main",
      "description": "The protagonist...",
      "image_path": "images/c123.jpg",
      "traits": [
        {"name": "Scientist", "group": "Role", "spoiler": 0},
        {"name": "Chuunibyou", "group": "Personality", "spoiler": 0}
      ]
    }
  ]
}
```

## How We Use It

### Step 1: Scrape VNDB

Start scraping (or resume if interrupted):
```bash
python -m GameSentenceMiner.util.vndb_yomitan_scraper.scraper
```

Options:
```bash
# Test with first 100 VNs
python -m GameSentenceMiner.util.vndb_yomitan_scraper.scraper --end-id 100

# Force start from specific ID
python -m GameSentenceMiner.util.vndb_yomitan_scraper.scraper --start-id 5000

# Custom output directory
python -m GameSentenceMiner.util.vndb_yomitan_scraper.scraper --output-dir /path/to/data
```

The scraper:
- Respects VNDB rate limits (199 requests per 5 minutes)
- Automatically resumes from where it left off
- Saves progress after each VN
- Stops after 100 consecutive missing IDs (end of VNDB)
- Can be interrupted with Ctrl+C (progress is saved)

### Step 2: Build Dictionary

Generate the Yomitan dictionary:
```bash
python -m GameSentenceMiner.util.vndb_yomitan_scraper.dict_builder
```

Options:
```bash
# Just show statistics
python -m GameSentenceMiner.util.vndb_yomitan_scraper.dict_builder --stats

# Build without images (smaller file)
python -m GameSentenceMiner.util.vndb_yomitan_scraper.dict_builder --no-images

# Custom output filename
python -m GameSentenceMiner.util.vndb_yomitan_scraper.dict_builder --output my_dict.zip
```

### Step 3: Import into Yomitan

1. Open Yomitan settings in your browser
2. Go to Dictionaries → Configure installed and enabled dictionaries
3. Click "Import" and select `vndb_scrape_data/output/vndb_characters.zip`
4. Enable the "VNDB Characters" dictionary

### Using the Dictionary

When reading Japanese text, Yomitan will now recognize character names:

- **岡部倫太郎** → Shows: Okabe Rintarou (main character from Steins;Gate)
- **岡部** → Shows the same character (family name lookup)
- **倫太郎** → Shows the same character (given name lookup)
- **鳳凰院凶真** → Shows the same character (alias lookup)

Each entry includes:
- Character image (thumbnail)
- Romanized name
- Role in the VN
- Which VN they're from
- Character description

## Rate Limiting

VNDB allows 200 requests per 5-minute window. The scraper:
- Uses 199 requests per window (safety margin)
- Tracks requests with persistence for resume support
- Waits automatically when limit is reached
- Handles 429 errors with exponential backoff (5 min → 1 hour)

## Estimated Time

- ~60,000+ VNs on VNDB (as of 2024)
- ~2 requests per VN (metadata + characters)
- ~199 requests per 5 minutes
- **Estimated total time: ~50+ hours** (can be interrupted and resumed)

## Dependencies

The scraper only needs:
- `requests`

The dictionary builder additionally needs:
- `jaconv` (for Japanese text processing)
- Other dependencies from `GameSentenceMiner.util.yomitan_dict`
