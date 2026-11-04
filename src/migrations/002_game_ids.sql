-- Games are recorded when they start and their score filled in when they end, matched by this id.
ALTER TABLE __NAMESPACE__.game_scores ADD COLUMN IF NOT EXISTS game_id text;

CREATE UNIQUE INDEX IF NOT EXISTS game_scores_game_id_idx
  ON __NAMESPACE__.game_scores (game_id);
