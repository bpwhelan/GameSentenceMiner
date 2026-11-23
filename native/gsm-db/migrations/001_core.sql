CREATE TABLE IF NOT EXISTS ai_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gemini_models TEXT,
    groq_models TEXT,
    ollama_models TEXT,
    lm_studio_models TEXT,
    openai_models TEXT,
    last_updated TEXT
);

CREATE TABLE IF NOT EXISTS game_lines (
    id TEXT PRIMARY KEY,
    game_name TEXT,
    line_text TEXT,
    screenshot_in_anki TEXT,
    audio_in_anki TEXT,
    screenshot_path TEXT,
    audio_path TEXT,
    replay_path TEXT,
    translation TEXT,
    language TEXT,
    timestamp REAL,
    original_game_name TEXT,
    game_id TEXT,
    note_ids TEXT,
    last_modified TEXT,
    created_at TEXT,
    tokenized INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    current_goals TEXT,
    goals_settings TEXT,
    last_updated TEXT,
    goals_version TEXT
);

CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    deck_id TEXT,
    title_original TEXT,
    title_romaji TEXT,
    title_english TEXT,
    type TEXT,
    description TEXT,
    image TEXT,
    character_count TEXT,
    difficulty TEXT,
    links TEXT,
    completed TEXT,
    release_date TEXT,
    manual_overrides TEXT,
    obs_scene_name TEXT,
    genres TEXT,
    tags TEXT,
    vndb_character_data TEXT,
    character_summary TEXT,
    vndb_id TEXT,
    anilist_id TEXT,
    status TEXT
);

CREATE TABLE IF NOT EXISTS cron_table (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    description TEXT,
    last_run TEXT,
    next_run TEXT,
    enabled TEXT,
    created_at TEXT,
    schedule TEXT
);

CREATE TABLE IF NOT EXISTS game_daily_rollup (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    game_id TEXT,
    total_characters TEXT,
    total_lines TEXT,
    total_cards_mined TEXT,
    total_reading_time_seconds TEXT,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_stats_rollup (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    total_lines TEXT,
    total_characters TEXT,
    total_sessions TEXT,
    unique_games_played TEXT,
    total_reading_time_seconds TEXT,
    total_active_time_seconds TEXT,
    longest_session_seconds TEXT,
    shortest_session_seconds TEXT,
    average_session_seconds TEXT,
    average_reading_speed_chars_per_hour TEXT,
    peak_reading_speed_chars_per_hour TEXT,
    games_completed TEXT,
    games_started TEXT,
    anki_cards_created TEXT,
    lines_with_screenshots TEXT,
    lines_with_audio TEXT,
    lines_with_translations TEXT,
    unique_kanji_seen TEXT,
    kanji_frequency_data TEXT,
    hourly_activity_data TEXT,
    hourly_reading_speed_data TEXT,
    game_activity_data TEXT,
    games_played_ids TEXT,
    genre_activity_data TEXT,
    type_activity_data TEXT,
    max_chars_in_session TEXT,
    max_time_in_session_seconds TEXT,
    unique_words_seen TEXT,
    word_frequency_data TEXT,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS stats_export_state (
    format_key TEXT PRIMARY KEY,
    last_successful_export_at TEXT,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS third_party_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    characters_read TEXT,
    time_read_seconds TEXT,
    source TEXT,
    label TEXT,
    created_at TEXT,
    game_id TEXT,
    lines_read TEXT,
    source_id TEXT,
    timestamp TEXT
);

CREATE TABLE IF NOT EXISTS stats_reading_breaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT
);
