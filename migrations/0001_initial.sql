PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('setup', 'camp', 'tribal', 'voting', 'reveal', 'complete')),
  round INTEGER NOT NULL DEFAULT 1,
  human_player_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'ai', 'host')),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'eliminated')),
  placement INTEGER,
  profile_json TEXT,
  public_facts_json TEXT NOT NULL DEFAULT '[]',
  private_notes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS players_game_id_idx ON players(game_id);

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  source_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  trust INTEGER NOT NULL DEFAULT 50,
  affinity INTEGER NOT NULL DEFAULT 50,
  perceived_threat INTEGER NOT NULL DEFAULT 50,
  alliance TEXT NOT NULL DEFAULT 'none' CHECK (alliance IN ('none', 'loose', 'strong')),
  grudges_json TEXT NOT NULL DEFAULT '[]',
  promises_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  UNIQUE (source_player_id, target_player_id)
);

CREATE INDEX IF NOT EXISTS relationships_game_id_idx ON relationships(game_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('private', 'tribal', 'system')),
  sender_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  recipient_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_game_round_idx ON messages(game_id, round);

CREATE TABLE IF NOT EXISTS tribal_councils (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('questioning', 'voting', 'revealed')),
  transcript_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (game_id, round)
);

CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  tribal_council_id TEXT NOT NULL REFERENCES tribal_councils(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  voter_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  rationale TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tribal_council_id, voter_id)
);

CREATE INDEX IF NOT EXISTS votes_game_round_idx ON votes(game_id, round);

CREATE TABLE IF NOT EXISTS game_events (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS game_events_game_round_idx ON game_events(game_id, round);

CREATE TABLE IF NOT EXISTS memory_summaries (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  summary TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (player_id, round)
);
