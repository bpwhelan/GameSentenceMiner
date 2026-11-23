CREATE INDEX IF NOT EXISTS idx_game_lines_missing_language ON game_lines(id) WHERE language IS NULL OR trim(language)='';
CREATE INDEX IF NOT EXISTS idx_daily_stats_rollup_date ON daily_stats_rollup(date);
CREATE INDEX IF NOT EXISTS idx_game_lines_timestamp ON game_lines(timestamp);
