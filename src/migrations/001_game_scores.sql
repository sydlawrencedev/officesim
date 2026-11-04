-- One row per finished game at an arcade machine or pool table. The schema placeholder is filled
-- in at build time (see build.mjs), since migrations must use fully qualified names.
CREATE TABLE IF NOT EXISTS __NAMESPACE__.game_scores (
  id bigserial PRIMARY KEY,
  company_id text NOT NULL,
  agent_id text NOT NULL,
  game text NOT NULL,
  score integer NOT NULL,
  played_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS game_scores_company_game_played_idx
  ON __NAMESPACE__.game_scores (company_id, game, played_at);
