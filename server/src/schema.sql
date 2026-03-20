-- server/src/schema.sql

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  team TEXT,
  fg_id TEXT,
  mlbam_id TEXT,
  UNIQUE(name, team)
);

CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
CREATE INDEX IF NOT EXISTS idx_players_fg_id ON players(fg_id);
CREATE INDEX IF NOT EXISTS idx_players_mlbam_id ON players(mlbam_id);

CREATE TABLE IF NOT EXISTS pitchers_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  team TEXT,
  GS INTEGER, G INTEGER, IP REAL, W INTEGER, L INTEGER,
  QS INTEGER, SV INTEGER, HLD INTEGER,
  H INTEGER, ER INTEGER, HR INTEGER, SO INTEGER, BB INTEGER,
  WHIP REAL, K9 REAL, BB9 REAL, ERA REAL, FIP REAL,
  WAR REAL, RA9WAR REAL,
  player_id TEXT
);

CREATE TABLE IF NOT EXISTS batters_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  team TEXT,
  G INTEGER, PA INTEGER, AB INTEGER, H INTEGER,
  "2B" INTEGER, "3B" INTEGER, HR INTEGER,
  R INTEGER, RBI INTEGER, BB INTEGER, SO INTEGER,
  HBP INTEGER, SB INTEGER, CS INTEGER,
  AVG REAL, OBP REAL, SLG REAL, OPS REAL,
  wOBA REAL, wRC INTEGER,
  BsR REAL, Fld REAL, Off REAL, Def REAL, WAR REAL,
  player_id TEXT
);

CREATE TABLE IF NOT EXISTS statcast_pitches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT,
  player_name TEXT NOT NULL,
  season INTEGER NOT NULL,
  season_type TEXT NOT NULL,
  pitch_type TEXT,
  velocity REAL,
  spin_rate REAL,
  whiff_pct REAL,
  barrel_pct REAL,
  xwoba REAL
);

CREATE TABLE IF NOT EXISTS pitcher_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  team TEXT,
  scoring_position TEXT,
  display_position TEXT,
  raw_score REAL,
  adjustment REAL,
  adj_score REAL,
  starting_pts REAL,
  relief_pts REAL,
  adj_2020_value REAL,
  pts_per_appearance REAL
);

CREATE TABLE IF NOT EXISTS batter_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  team TEXT,
  position TEXT,
  raw_score REAL,
  adjustment REAL,
  adj_score REAL,
  pts_per_game REAL
);

CREATE TABLE IF NOT EXISTS combined_rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  rank INTEGER,
  name TEXT NOT NULL,
  team TEXT,
  position TEXT,
  score REAL,
  adj_score REAL,
  espn_adp INTEGER,
  velocity_delta REAL,
  velo_prev REAL,
  velo_curr REAL,
  velo_n INTEGER,
  per_game_efficiency REAL,
  value_gap INTEGER
);

CREATE INDEX IF NOT EXISTS idx_combined_player_id ON combined_rankings(player_id);
CREATE INDEX IF NOT EXISTS idx_pitchers_raw_name ON pitchers_raw(name, team);
CREATE INDEX IF NOT EXISTS idx_batters_raw_name ON batters_raw(name, team);
CREATE INDEX IF NOT EXISTS idx_statcast_name ON statcast_pitches(player_name);

CREATE TABLE IF NOT EXISTS draft_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS draft_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES draft_sessions(id),
  player_name TEXT NOT NULL,
  pick_number INTEGER NOT NULL,
  drafted_by TEXT,
  player_notes TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scoring_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  stat TEXT NOT NULL,
  weight REAL NOT NULL,
  UNIQUE(category, stat)
);

CREATE TABLE IF NOT EXISTS position_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position TEXT NOT NULL UNIQUE,
  adjustment REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS name_replacements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alt_name TEXT NOT NULL UNIQUE,
  canonical_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS position_eligibility (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  position TEXT NOT NULL,
  UNIQUE(name, source, position)
);

CREATE TABLE IF NOT EXISTS injuries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  team TEXT,
  position TEXT,
  injury TEXT,
  status TEXT,
  latest_update TEXT,
  mlbam_id TEXT,
  UNIQUE(name, team)
);

CREATE TABLE IF NOT EXISTS espn_adp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  adp_rank INTEGER,
  projected_points REAL
);

CREATE TABLE IF NOT EXISTS player_notes (
  name TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_espn_adp_name ON espn_adp(name);
CREATE INDEX IF NOT EXISTS idx_injuries_name ON injuries(name);
CREATE INDEX IF NOT EXISTS idx_position_eligibility_name ON position_eligibility(name);
CREATE INDEX IF NOT EXISTS idx_player_notes_name ON player_notes(name);
