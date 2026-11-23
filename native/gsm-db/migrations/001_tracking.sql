CREATE UNIQUE INDEX IF NOT EXISTS idx_game_daily_rollup_date_game_id ON game_daily_rollup(date, game_id);
CREATE INDEX IF NOT EXISTS idx_game_daily_rollup_game_id_date ON game_daily_rollup(game_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_third_party_stats_source_id ON third_party_stats(source, source_id)
    WHERE source_id IS NOT NULL AND source_id != '';

CREATE TABLE IF NOT EXISTS sync_game_line_changes (
    line_id TEXT PRIMARY KEY,
    change_type TEXT NOT NULL CHECK (change_type IN ('upsert','delete')),
    changed_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_game_line_changes_changed_at ON sync_game_line_changes(changed_at);

CREATE TRIGGER IF NOT EXISTS trg_game_lines_sync_insert AFTER INSERT ON game_lines BEGIN
    INSERT INTO sync_game_line_changes VALUES(NEW.id,'upsert',coalesce(NEW.last_modified,cast(strftime('%s','now') AS REAL)))
    ON CONFLICT(line_id) DO UPDATE SET change_type='upsert', changed_at=excluded.changed_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_game_lines_sync_update AFTER UPDATE ON game_lines BEGIN
    INSERT INTO sync_game_line_changes VALUES(NEW.id,'upsert',coalesce(NEW.last_modified,cast(strftime('%s','now') AS REAL)))
    ON CONFLICT(line_id) DO UPDATE SET change_type='upsert', changed_at=excluded.changed_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_game_lines_sync_delete AFTER DELETE ON game_lines BEGIN
    INSERT INTO sync_game_line_changes VALUES(OLD.id,'delete',cast(strftime('%s','now') AS REAL))
    ON CONFLICT(line_id) DO UPDATE SET change_type='delete', changed_at=excluded.changed_at;
END;

CREATE TABLE IF NOT EXISTS sync_v2_dirty (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS sync_v2_state (scope TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_v2_records (
    scope TEXT, kind TEXT, id TEXT, record TEXT NOT NULL, PRIMARY KEY(scope,kind,id)
);
CREATE TABLE IF NOT EXISTS sync_v2_outbox (
    scope TEXT, id TEXT, kind TEXT, record_id TEXT, record TEXT, payload TEXT, PRIMARY KEY(scope,id)
);
CREATE TABLE IF NOT EXISTS sync_v2_settings_seen (scope TEXT, id TEXT, value TEXT, PRIMARY KEY(scope,id));
CREATE TABLE IF NOT EXISTS sync_v2_staging (scope TEXT, position INTEGER, record TEXT, PRIMARY KEY(scope,position));
CREATE TRIGGER IF NOT EXISTS gsm_sync_v2_insert AFTER INSERT ON game_lines BEGIN
    INSERT OR IGNORE INTO sync_v2_dirty(id) VALUES(NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS gsm_sync_v2_update AFTER UPDATE ON game_lines
WHEN OLD.game_name IS NOT NEW.game_name OR OLD.line_text IS NOT NEW.line_text OR OLD.language IS NOT NEW.language
    OR OLD.timestamp IS NOT NEW.timestamp OR OLD.note_ids IS NOT NEW.note_ids BEGIN
    INSERT OR IGNORE INTO sync_v2_dirty(id) VALUES(NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS gsm_sync_v2_delete AFTER DELETE ON game_lines BEGIN
    INSERT OR IGNORE INTO sync_v2_dirty(id) VALUES(OLD.id);
END;
