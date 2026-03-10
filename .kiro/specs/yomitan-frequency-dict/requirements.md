# Requirements Document

## Introduction

This feature adds a downloadable Yomitan frequency dictionary to the GSM Database Management page. Users can download a frequency dictionary of their known words (with occurrence counts) in Yomitan-compatible format. The dictionary auto-updates via UNIX timestamp revisions. The existing character name dictionary is also updated to use UNIX timestamps for consistent auto-update behavior.

## Glossary

- **Frequency_Dictionary**: A Yomitan-compatible ZIP archive containing `index.json` and `term_meta_bank_N.json` files that map words to their occurrence counts
- **Character_Dictionary**: The existing Yomitan-compatible ZIP archive containing character name entries from VNDB data
- **Yomitan**: A browser-based Japanese dictionary tool that supports importing custom dictionaries and checking for updates via `indexUrl`/`downloadUrl`
- **Tokenisation**: An opt-in GSM feature that breaks game text into individual words and kanji, storing them in `words`, `word_occurrences`, `kanji`, and `kanji_occurrences` tables
- **Frequency_Dict_Builder**: The component responsible for querying word frequency data and producing the Yomitan frequency dictionary ZIP
- **Database_Page**: The `database.html` web page in GSM where users manage games, data, and download dictionaries
- **Revision**: A version identifier in a Yomitan dictionary's `index.json` used to determine if an update is available
- **Word_Occurrence_Count**: The total number of distinct game lines in which a word appears, computed from the `word_occurrences` table

## Requirements

### Requirement 1: Generate Frequency Dictionary

**User Story:** As a language learner, I want to download a frequency dictionary of my known words, so that I can see how often I encounter each word while using Yomitan.

#### Acceptance Criteria

1. WHEN a user requests the frequency dictionary, THE Frequency_Dict_Builder SHALL query the `words` and `word_occurrences` tables and produce a Yomitan-compatible ZIP containing `index.json` and one or more `term_meta_bank_N.json` files
2. WHEN producing frequency entries, THE Frequency_Dict_Builder SHALL create entries in the format `["word", "freq", {"frequency": N, "reading": "reading"}]` where N is the Word_Occurrence_Count and reading is the word's reading from the `words` table
3. WHEN the `index.json` is created, THE Frequency_Dict_Builder SHALL set `frequencyMode` to `"occurrence-based"` to indicate counts represent raw occurrence numbers
4. WHEN the frequency dictionary ZIP is created, THE Frequency_Dict_Builder SHALL set the `title` field in `index.json` to `"GSM Frequency Dictionary"`
5. WHEN the frequency dictionary ZIP is created, THE Frequency_Dict_Builder SHALL include `downloadUrl` and `indexUrl` fields in `index.json` and set `isUpdatable` to `true`

### Requirement 2: Frequency Dictionary API Endpoints

**User Story:** As a Yomitan user, I want API endpoints for downloading and update-checking the frequency dictionary, so that Yomitan can auto-update my frequency data.

#### Acceptance Criteria

1. WHEN a GET request is made to `/api/yomitan-freq-dict`, THE System SHALL return the frequency dictionary as a ZIP file with `Content-Type: application/zip`
2. WHEN a GET request is made to `/api/yomitan-freq-index`, THE System SHALL return the frequency dictionary `index.json` metadata as JSON with CORS headers
3. IF tokenisation is not enabled, THEN THE System SHALL return an HTTP 404 response with a descriptive error message explaining that tokenisation must be enabled
4. IF no word data exists in the database, THEN THE System SHALL return an HTTP 404 response indicating no frequency data is available

### Requirement 3: UNIX Timestamp Revisions

**User Story:** As a Yomitan user, I want dictionaries to always auto-update when I check for updates, so that I always have the latest data without manual re-importing.

#### Acceptance Criteria

1. WHEN the Frequency_Dict_Builder creates a dictionary, THE Frequency_Dict_Builder SHALL use the current UNIX timestamp (integer seconds since epoch) as the `revision` field in `index.json`
2. WHEN the Character_Dictionary builder creates a dictionary, THE Character_Dictionary builder SHALL use the current UNIX timestamp (integer seconds since epoch) as the `revision` field in `index.json`, replacing the current random number approach
3. WHEN the index endpoint returns metadata, THE System SHALL use the current UNIX timestamp as the revision so that Yomitan detects a newer version is available

### Requirement 4: Database Page UI

**User Story:** As a user, I want a clear option on the Database Management page to download the frequency dictionary, so that I can easily find and use this feature.

#### Acceptance Criteria

1. WHEN the Database_Page loads, THE Database_Page SHALL display a card for the frequency dictionary download alongside the existing character dictionary card
2. WHEN the frequency dictionary card is displayed, THE Database_Page SHALL show a download button that triggers a download from `/api/yomitan-freq-dict`
3. WHEN tokenisation is not enabled, THE Database_Page SHALL display a message on the frequency dictionary card informing the user that tokenisation must be enabled first
4. WHEN the download button is clicked, THE Database_Page SHALL initiate a file download and handle errors by displaying an appropriate message to the user

### Requirement 5: Frequency Data Query

**User Story:** As a developer, I want an efficient query for word frequency data, so that the dictionary generation performs well even with large datasets.

#### Acceptance Criteria

1. WHEN querying frequency data, THE Frequency_Dict_Builder SHALL join the `words` table with `word_occurrences` and group by `word_id` to compute the occurrence count for each word
2. WHEN a word has a reading in the `words` table, THE Frequency_Dict_Builder SHALL include that reading in the frequency entry
3. WHEN a word has zero occurrences (orphaned word record), THE Frequency_Dict_Builder SHALL exclude that word from the frequency dictionary

### Requirement 6: Frequency Dictionary Serialization

**User Story:** As a developer, I want the frequency dictionary to follow the Yomitan `term_meta_bank` format precisely, so that Yomitan correctly imports and displays frequency data.

#### Acceptance Criteria

1. THE Frequency_Dict_Builder SHALL serialize frequency entries into `term_meta_bank_N.json` files (not `term_bank_N.json`)
2. WHEN the number of entries exceeds 10,000, THE Frequency_Dict_Builder SHALL split entries across multiple `term_meta_bank_N.json` files
3. THE Frequency_Dict_Builder SHALL set `format` to `3` in the `index.json`
4. FOR ALL valid word-frequency pairs, serializing to ZIP then reading back the ZIP SHALL produce equivalent `index.json` metadata and `term_meta_bank` entries (round-trip property)
