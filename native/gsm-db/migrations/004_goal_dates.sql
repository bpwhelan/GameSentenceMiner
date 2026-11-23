-- The current settings row shares a table with historical completions. Tie
-- ordering preserves the oldest row when a legacy import has duplicate dates.
CREATE INDEX IF NOT EXISTS idx_goals_date_id ON goals(date DESC, id ASC);
