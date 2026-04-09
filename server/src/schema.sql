-- server/src/schema.sql

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  team TEXT,
  fg_id TEXT,
  mlbam_id TEXT,
  espn_id INTEGER,
  UNIQUE(name, team)
);

CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
CREATE INDEX IF NOT EXISTS idx_players_fg_id ON players(fg_id);
CREATE INDEX IF NOT EXISTS idx_players_mlbam_id ON players(mlbam_id);

CREATE TABLE IF NOT EXISTS pitchers_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  name TEXT NOT NULL,
  team TEXT,
  GS INTEGER, G INTEGER, IP REAL, W INTEGER, L INTEGER,
  QS INTEGER, SV INTEGER, HLD INTEGER,
  H INTEGER, ER INTEGER, HR INTEGER, SO INTEGER, BB INTEGER,
  WHIP REAL, K9 REAL, BB9 REAL, ERA REAL, FIP REAL,
  WAR REAL, RA9WAR REAL,
  fg_id TEXT
);

CREATE TABLE IF NOT EXISTS batters_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  name TEXT NOT NULL,
  team TEXT,
  G INTEGER, PA INTEGER, AB INTEGER, H INTEGER,
  "2B" INTEGER, "3B" INTEGER, HR INTEGER,
  R INTEGER, RBI INTEGER, BB INTEGER, SO INTEGER,
  HBP INTEGER, SB INTEGER, CS INTEGER,
  AVG REAL, OBP REAL, SLG REAL, OPS REAL,
  wOBA REAL, wRC INTEGER,
  BsR REAL, Fld REAL, Off REAL, Def REAL, WAR REAL,
  fg_id TEXT
);

CREATE TABLE IF NOT EXISTS pitchers_actual (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  name TEXT NOT NULL,
  team TEXT,
  GS INTEGER, G INTEGER, IP REAL, W INTEGER, L INTEGER,
  QS INTEGER, SV INTEGER, HLD INTEGER,
  H INTEGER, ER INTEGER, HR INTEGER, SO INTEGER, BB INTEGER,
  WHIP REAL, K9 REAL, BB9 REAL, ERA REAL, FIP REAL,
  WAR REAL, RA9WAR REAL,
  fg_id TEXT
);

CREATE TABLE IF NOT EXISTS batters_actual (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  name TEXT NOT NULL,
  team TEXT,
  G INTEGER, PA INTEGER, AB INTEGER, H INTEGER,
  "2B" INTEGER, "3B" INTEGER, HR INTEGER,
  R INTEGER, RBI INTEGER, BB INTEGER, SO INTEGER,
  HBP INTEGER, SB INTEGER, CS INTEGER,
  AVG REAL, OBP REAL, SLG REAL, OPS REAL,
  wOBA REAL, wRC INTEGER,
  BsR REAL, Fld REAL, Off REAL, Def REAL, WAR REAL,
  fg_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_pitchers_actual_player_id ON pitchers_actual(player_id);
CREATE INDEX IF NOT EXISTS idx_batters_actual_player_id ON batters_actual(player_id);

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

CREATE TABLE IF NOT EXISTS savant_expected (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  mlbam_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  player_type TEXT NOT NULL,
  pa INTEGER,
  xwoba REAL,
  woba REAL,
  xwoba_diff REAL,
  UNIQUE(mlbam_id, player_type)
);

CREATE INDEX IF NOT EXISTS idx_savant_expected_player_id ON savant_expected(player_id);

CREATE TABLE IF NOT EXISTS pitcher_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
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
  player_id INTEGER REFERENCES players(id),
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
  espn_rank INTEGER,
  velocity_delta REAL,
  velo_prev REAL,
  velo_curr REAL,
  velo_n INTEGER,
  per_game_efficiency REAL,
  pos_rank INTEGER,
  value_gap INTEGER
);

CREATE INDEX IF NOT EXISTS idx_combined_player_id ON combined_rankings(player_id);
CREATE INDEX IF NOT EXISTS idx_pitchers_raw_name ON pitchers_raw(name, team);
CREATE INDEX IF NOT EXISTS idx_batters_raw_name ON batters_raw(name, team);
CREATE INDEX IF NOT EXISTS idx_statcast_name ON statcast_pitches(player_name);

CREATE TABLE IF NOT EXISTS pitcher_starts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  mlbam_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  game_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  total_pitches INTEGER,
  pa INTEGER,
  bip INTEGER,
  hits INTEGER,
  hrs INTEGER,
  so INTEGER,
  bb INTEGER,
  whiffs INTEGER,
  swings INTEGER,
  takes INTEGER,
  called_strikes INTEGER,
  babip REAL,
  woba REAL,
  xwoba REAL,
  ip REAL,
  er INTEGER,
  won INTEGER,
  qs INTEGER,
  UNIQUE(mlbam_id, game_date)
);

CREATE INDEX IF NOT EXISTS idx_pitcher_starts_player_id ON pitcher_starts(player_id);
CREATE INDEX IF NOT EXISTS idx_pitcher_starts_date ON pitcher_starts(mlbam_id, game_date);

CREATE TABLE IF NOT EXISTS pitcher_model (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  window INTEGER NOT NULL,
  starts_in_window INTEGER,
  xk_pct REAL,
  xbb_pct REAL,
  regressed_babip REAL,
  regressed_hr9 REAL,
  est_ip REAL,
  est_era REAL,
  est_k_per_start REAL,
  est_bb_per_start REAL,
  est_h_per_start REAL,
  est_er_per_start REAL,
  p_win REAL,
  p_loss REAL,
  p_qs REAL,
  pts_per_start REAL,
  UNIQUE(player_id, window)
);

CREATE INDEX IF NOT EXISTS idx_pitcher_model_player_id ON pitcher_model(player_id);

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
  player_id INTEGER REFERENCES players(id),
  name TEXT NOT NULL,
  espn_id INTEGER,
  source TEXT NOT NULL,
  position TEXT NOT NULL,
  UNIQUE(name, source, position)
);

CREATE TABLE IF NOT EXISTS injuries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  name TEXT NOT NULL,
  team TEXT,
  position TEXT,
  injury TEXT,
  status TEXT,
  latest_update TEXT,
  mlbam_id TEXT,
  UNIQUE(name, team)
);

CREATE TABLE IF NOT EXISTS espn_rank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  name TEXT NOT NULL,
  espn_id INTEGER,
  adp_rank INTEGER,
  projected_points REAL
);

CREATE TABLE IF NOT EXISTS player_notes (
  player_id INTEGER PRIMARY KEY REFERENCES players(id),
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS rosters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  espn_player_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  team_name TEXT NOT NULL,
  UNIQUE(espn_player_id)
);

CREATE INDEX IF NOT EXISTS idx_rosters_espn_player_id ON rosters(espn_player_id);

CREATE INDEX IF NOT EXISTS idx_espn_rank_name ON espn_rank(name);
CREATE INDEX IF NOT EXISTS idx_espn_rank_espn_id ON espn_rank(espn_id);
CREATE INDEX IF NOT EXISTS idx_injuries_name ON injuries(name);
CREATE INDEX IF NOT EXISTS idx_position_eligibility_name ON position_eligibility(name);
