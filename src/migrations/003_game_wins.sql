-- Ping pong matches have a winner: each player's row records the points they scored and whether they won.
ALTER TABLE __NAMESPACE__.game_scores ADD COLUMN IF NOT EXISTS won boolean NOT NULL DEFAULT false;
