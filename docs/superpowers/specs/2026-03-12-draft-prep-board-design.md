# Fantasy Baseball Draft Prep Board — Design Spec

## Overview

A locally-run web application replacing a 28-sheet Google Sheets/Excel workbook for fantasy baseball draft preparation. This first phase covers the draft prep subsystem: projection ingestion, custom scoring engine, combined player rankings, and a live draft tracker.

## Architecture

**Stack:** React (Vite) frontend + Node.js/Express backend + SQLite database.

```
┌─────────────────────────────────────────────────┐
│                React Frontend (Vite)             │
│  ┌───────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ Rankings   │ │ Draft    │ │ Settings       │  │
│  │ Table      │ │ Tracker  │ │ (Weights, etc) │  │
│  └───────────┘ └──────────┘ └────────────────┘  │
└───────────────────┬─────────────────────────────┘
                    │ REST API (JSON)
┌───────────────────┴─────────────────────────────┐
│              Node.js / Express Backend           │
│  ┌───────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ Scoring   │ │ Data     │ │ API            │  │
│  │ Engine    │ │ Scrapers │ │ Routes         │  │
│  └───────────┘ └──────────┘ └────────────────┘  │
└───────────────────┬─────────────────────────────┘
                    │
              ┌─────┴─────┐
              │  SQLite    │
              └───────────┘
```

### Frontend

- **React + Vite** dev server
- **TanStack Table** for sortable, filterable, virtually-scrolled data grids (1500+ rows)
- **React Router** for client-side navigation between three views
- **Tailwind CSS** for styling
- **State management:** React context + local state. Server is source of truth via REST.

### Backend

- **Express** API server
- Three responsibilities: scoring engine, data scrapers, REST API routes
- **better-sqlite3** for synchronous SQLite access (appropriate for single-user local app)

### Storage

Single SQLite file containing all tables. Zero configuration, portable, handles 10K+ rows easily.

---

## Data Pipeline

Three independent scrapers, each writing to SQLite. All triggered via UI buttons (individual or "Refresh All").

### FanGraphs Projections (authenticated)

- **Projection system:** User selects one system (Steamer or ZiPS) in Settings. Only one system is ingested at a time — no averaging. Default: Steamer.
- **Credential storage:** Stored in a `.env` file in the project root (`FANGRAPHS_EMAIL`, `FANGRAPHS_PASSWORD`). Never committed to git (added to `.gitignore`).
- **Authentication flow:**
  1. POST to `https://www.fangraphs.com/api/login` with JSON body `{ email, password }` to obtain a session cookie
  2. Use the session cookie to GET the CSV export URLs:
     - Pitchers: `https://www.fangraphs.com/api/projections?type={projection_system}&stats=pit&pos=all&team=&lg=all&players=0&download=true`
     - Batters: same URL with `stats=bat`
     - `{projection_system}` is substituted from the user's Settings selection: `steamer` or `zips`
  3. Parse the returned CSV
- **Output tables:**
  - `pitchers_raw` (~5700 rows) — columns: name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB, WHIP, K9, BB9, ERA, FIP, WAR, RA9WAR, player_id
  - `batters_raw` (~4500 rows) — columns: name, team, G, PA, AB, H, 2B, 3B, HR, R, RBI, BB, SO, HBP, SB, CS, AVG, OBP, SLG, OPS, wOBA, wRC, BsR, Fld, Off, Def, WAR, player_id
- **Trigger:** "Refresh Projections" button

### Baseball Savant / Statcast (public CSV)

- **Method:** Public CSV export endpoint, no auth required. URL pattern:
  `https://baseballsavant.mlb.com/leaderboard/custom?n=abs&stats=pit&qual=1&type=1&season=2024&month=0&game_type=R&min=10&csv=true`
  Vary `season`, `game_type` (R=regular, ST=spring training).
- **Output table:** `statcast_pitches` — one row per pitcher-pitch-type combo, columns include: player_id, player_name, pitch_type, velocity, spin_rate, whiff_pct, barrel_pct, xwoba, plus all movement/approach metrics
- **Name format:** Statcast stores names as "Last, First" (e.g., "Verlander, Justin"). All Statcast names must be converted to "First Last" format before joining to other data sources. This conversion is applied during ingestion, before name reconciliation.
- **Derived view:** `pitcher_velocity` — computes velocity delta (2025 ST max - 2024 regular max) per pitcher. Only retains rows where `delta < 10` mph (excludes positive deltas >= 10 as likely bad data or mismatched pitch types). Negative deltas (velocity drops) of any magnitude are preserved — this matches the original spreadsheet behavior where large velocity losses are meaningful signals, while large gains are likely data errors.
- **Seasons fetched:** Regular season 2024, Spring Training 2025

### ESPN ADP (scraping)

- **Method:** ESPN's fantasy API endpoint (JSON, not HTML scraping):
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/{year}/segments/0/leaguedefaults/3?view=kona_player_info`
  where `{year}` is the current season year (stored in `app_config` table, key `season_year`). This returns JSON with player rankings, ADP, and projected points. No auth required for default league data.
- **Fallback:** If the API endpoint changes or is unavailable, support CSV upload as a manual alternative.
- **Output table:** `espn_adp` — columns: name, adp_rank, projected_points
- **Joined to players** by name via `name_replacements` table

### Name Reconciliation

- **Table:** `name_replacements` — maps alternate spellings to canonical names (e.g., "Pete Alonso" -> "Peter Alonso")
- **Applied** as a preprocessing step before any cross-source joins (after format normalization — i.e., after Statcast "Last, First" → "First Last" conversion)
- **Seeded** from the existing 61-row sheet, editable via the app

---

## Scoring Engine

Recomputes all scores whenever projections change or scoring config is edited. All division operations use safe guards: if the divisor is 0, the result is 0 (matching the spreadsheet's IFERROR behavior).

### Pitcher Scoring

1. **Raw score** = SUMPRODUCT of stats and weights:

| Stat | Default Weight |
|------|---------------|
| IP   | 2.1           |
| W    | 3.5           |
| L    | -1.0          |
| QS   | 2.0           |
| SV   | 5.0           |
| H (hits) | -0.6      |
| ER   | -1.5          |
| SO   | 1.0           |
| BB   | -0.5          |

2. **Two separate position classifiers** (both are computed and stored):

   **Scoring position** (used for adjustment calculation, stored in `scoring_position`):
   - SV > 0 → "CLOSER"
   - SV == 0 → "SP"
   - This is a simple binary used only to select the adjustment formula.

   **Display position** (used for UI filtering and eligibility, stored in `display_position`):
   - GS == G → "SP"
   - GS == 0 → "RP"
   - GS > 0 and GS < G → "SP, RP" (dual-eligible)
   - This is independent of saves. A closer with starts shows as "SP, RP" for display.

3. **Adjustment** (stored in `adjustment` column, uses scoring_position):
   - Closers: flat -10
   - SPs: `=-MIN(raw_score * 3/7, replacement_level * 10/7 * 3/7) + 165`
   - Default replacement level: 237

4. **Adj Score** (stored in `adj_score`):
   `= raw_score + adjustment`

5. **Adjusted 2020 Value** (stored separately in `adj_2020_value` — this is the primary ranking value used in Combined):

   First compute component scores:
   - `relief_pts = raw_score * (G - GS) / IP` (0 if IP == 0)
   - `starting_pts = raw_score - relief_pts`

   Then:
   ```
   adj_2020_value = MAX(
     -MIN(starting_pts * 3/7, replacement_level * 10/7 * 3/7) + 215 + starting_pts,
     relief_pts + 71
   )
   ```
   This dual-path valuation takes the higher of: SP surplus value (with +215 constant and starting points), or RP value (with +71 floor). This is the value used in Combined rankings.

6. **Per-appearance efficiency** (stored in `pts_per_appearance`):
   `= raw_score / G` (0 if G == 0)
   Note: divides by total games (G), not games started (GS). This matches the original spreadsheet (Pitcher Raw column AC = Y2/D2 where D=G). The name reflects the actual divisor.

### Batter Scoring

1. **Raw score** = SUMPRODUCT of stats and weights:

| Stat | Default Weight |
|------|---------------|
| H    | 1.0           |
| 2B   | 1.0           |
| 3B   | 2.0           |
| HR   | 3.1           |
| R    | 1.1           |
| RBI  | 1.1           |
| BB   | 1.0           |
| SO   | -1.0          |
| SB   | 2.0           |

2. **Position scarcity adjustment** (applied at scoring stage, not at ingestion):

| Position | Adjustment |
|----------|-----------|
| C        | +70       |
| OF       | +40       |
| 2B       | +30       |
| 3B       | +25       |
| SS       | +20       |
| 1B       | +15       |
| Other    | +10       |

   This uses the more granular Batter Projections scale from the original workbook. The simpler Batter Raw scale is not used.

3. **Position lookup:** Sourced from `batter_positions` table. The table stores up to 6 position columns representing different sources/years (e.g., ESPN 2024, ESPN 2025, Yahoo 2025, etc.). Fallback priority: use the first non-empty value scanning left to right (column order = recency priority). The first column is the most authoritative/recent source.

   **Multi-position strings:** Position fields may contain comma-separated values (e.g., "OF, 2B"). For the scarcity adjustment, use the **first listed position** in the string (e.g., "OF, 2B" → OF → +40). The full multi-position string is preserved in the `position` column for display/filtering purposes.

4. **Adj score** (stored in `adj_score`):
   `= raw_score + adjustment`

5. **Per-game efficiency** (stored in `pts_per_game`):
   `= raw_score / G` (0 if G == 0)

### Combined Rankings

- Merge pitchers and batters into a single list
- **Raw score** (`score` column) = `MAX(pitcher.raw_score, batter.raw_score)` — the higher raw score across pitcher/batter projections for this player
- **Ranking value** (`adj_score` column) = `MAX(pitcher.adj_2020_value, batter.adj_score)` — the primary sort column, uses Adjusted 2020 Value for pitchers, Adj Score for batters
- **Position** (`position` column) = pitcher `display_position` if the player has pitcher scores, otherwise batter `position`. For dual-eligible players who appear in both, use the pitcher display_position.
- **Rank** (`rank` column) = ordinal rank when ordering by `adj_score` DESC. Ties broken by `score` DESC, then alphabetical name. Stored as a column in the materialized table, recomputed on every rescore.
- **Value gap** (`value_gap` column) = `rank - espn_adp`. Positive = drafted later than ADP (potential value), negative = overdrafted relative to ADP. NULL if no ESPN ADP data.
- Additional columns: ESPN ADP, velocity delta (pitchers only, NULL for batters), per-game efficiency (`pts_per_appearance` for pitchers, `pts_per_game` for batters)
- **ESPN projected_points:** Ingested into `espn_adp` table but not surfaced in combined_rankings or the UI in Phase 1. Stored for future use.

### Configuration

All weights, position adjustments, and the replacement level threshold stored in `scoring_config` and `position_adjustments` tables. Editable via Settings page. Any change triggers a full rescore of all players.

---

## Frontend Views

### 1. Rankings (default view)

Full sortable/filterable player table. Columns: Rank, Name, Team, Position, Raw Score, Adj Score, ESPN ADP, Value Gap, Velocity Delta (pitchers), Per-Game Efficiency.

- Column visibility toggles
- Position quick-filters (SP, RP, C, IF, OF, etc.)
- Type-ahead search
- Virtual scrolling for performance with 1500+ rows

### 2. Draft Tracker

Rankings table plus draft-day controls:

- **Mark as drafted** — click player to record as taken, pick number auto-increments
- **Toggle taken players** — hide/show drafted players
- **My roster sidebar** — current picks organized by position
- **Notes field** — inline editable per player, persisted to `player_notes` column in `draft_picks` table
- **Multiple draft sessions** — support for multiple leagues via a session selector dropdown at the top of the Draft view. "New Session" button creates a new session with a user-provided name (e.g., "Main League 2026"). The most recently created session is active by default. Switching sessions reloads the draft state for that session.

Draft state persisted to `draft_picks` table. Browser-safe — close and reopen without losing state.

### 3. Settings

- Scoring weights editor (pitcher and batter weights in editable tables)
- Position adjustment sliders
- Replacement level threshold input
- Projection system selector (Steamer / ZiPS)
- Data source refresh buttons with progress indicators
- Name replacements editor

### Navigation

Simple top nav bar with three links: Rankings, Draft, Settings.

---

## Database Schema (key tables)

```sql
-- Raw projection data
pitchers_raw (
  id INTEGER PRIMARY KEY,
  name TEXT, team TEXT,
  GS INT, G INT, IP REAL, W INT, L INT, QS INT, SV INT, HLD INT,
  H INT, ER INT, HR INT, SO INT, BB INT,
  WHIP REAL, K9 REAL, BB9 REAL, ERA REAL, FIP REAL, WAR REAL, RA9WAR REAL,
  player_id TEXT
)

batters_raw (
  id INTEGER PRIMARY KEY,
  name TEXT, team TEXT,
  G INT, PA INT, AB INT, H INT, "2B" INT, "3B" INT, HR INT,
  R INT, RBI INT, BB INT, SO INT, HBP INT, SB INT, CS INT,
  AVG REAL, OBP REAL, SLG REAL, OPS REAL, wOBA REAL, wRC INT,
  BsR REAL, Fld REAL, Off REAL, Def REAL, WAR REAL,
  player_id TEXT
)

-- Statcast (names stored as "First Last" after ingestion normalization)
statcast_pitches (
  id INTEGER PRIMARY KEY,
  player_id TEXT, player_name TEXT,
  season INT, season_type TEXT,  -- 'regular' or 'spring'
  pitch_type TEXT, velocity REAL, spin_rate REAL,
  whiff_pct REAL, barrel_pct REAL, xwoba REAL
  -- additional movement/approach columns as needed
)

-- Velocity delta view (pseudocode — adapt for valid SQLite syntax)
-- SELECT player_name, v_2024, v_2025, delta FROM (
--   SELECT player_name,
--     MAX(CASE WHEN season=2024 AND season_type='regular' THEN velocity END) as v_2024,
--     MAX(CASE WHEN season=2025 AND season_type='spring' THEN velocity END) as v_2025,
--     (MAX(CASE WHEN season=2025 AND season_type='spring' THEN velocity END)
--      - MAX(CASE WHEN season=2024 AND season_type='regular' THEN velocity END)) as delta
--   FROM statcast_pitches GROUP BY player_name
-- ) WHERE delta IS NOT NULL AND delta < 10

-- Computed scores (materialized by scoring engine)
pitcher_scores (
  id INTEGER PRIMARY KEY,
  name TEXT, team TEXT,
  scoring_position TEXT,   -- 'CLOSER' or 'SP' (for adjustment calc)
  display_position TEXT,   -- 'SP', 'RP', or 'SP, RP' (for UI)
  raw_score REAL, adjustment REAL, adj_score REAL,
  starting_pts REAL, relief_pts REAL, adj_2020_value REAL,
  pts_per_appearance REAL
)

batter_scores (
  id INTEGER PRIMARY KEY,
  name TEXT, team TEXT, position TEXT,
  raw_score REAL, adjustment REAL, adj_score REAL,
  pts_per_game REAL
)

combined_rankings (
  id INTEGER PRIMARY KEY,
  rank INT,              -- ordinal rank by adj_score DESC, ties broken by score DESC then name ASC
  name TEXT, team TEXT, position TEXT,
  score REAL,            -- raw score (max of pitcher/batter)
  adj_score REAL,        -- ranking value (pitcher adj_2020_value or batter adj_score)
  espn_adp INT,
  velocity_delta REAL,   -- NULL for batters
  per_game_efficiency REAL,  -- pts_per_appearance for pitchers, pts_per_game for batters
  value_gap INT          -- combined_rank - espn_adp_rank
)

-- Draft state
draft_sessions (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT)
draft_picks (
  id INTEGER PRIMARY KEY,
  session_id INT REFERENCES draft_sessions(id),
  player_name TEXT, pick_number INT,
  drafted_by TEXT,       -- 'me' or other team name
  player_notes TEXT,     -- inline editable notes
  timestamp TEXT
)

-- Configuration
scoring_config (
  id INTEGER PRIMARY KEY,
  category TEXT,  -- 'pitcher' or 'batter'
  stat TEXT,
  weight REAL
)
position_adjustments (id INTEGER PRIMARY KEY, position TEXT, adjustment REAL)
app_config (key TEXT PRIMARY KEY, value TEXT)  -- replacement_level, projection_system, etc.

-- Name reconciliation
name_replacements (id INTEGER PRIMARY KEY, alt_name TEXT, canonical_name TEXT)

-- Position eligibility
batter_positions (
  id INTEGER PRIMARY KEY,
  name TEXT,
  pos_espn_2025 TEXT,    -- most authoritative (leftmost = highest priority)
  pos_yahoo_2025 TEXT,
  pos_espn_2024 TEXT,
  pos_yahoo_2024 TEXT,
  pos_fantrax_2025 TEXT,
  pos_manual TEXT         -- user override
)

-- ESPN
espn_adp (id INTEGER PRIMARY KEY, name TEXT, adp_rank INT, projected_points REAL)
```

---

## Out of Scope (future phases)

- In-season streaming system (two-starter identification, daily waivers, free agent tracking)
- Batter matchup ratings
- Schedule-based analysis
- Multi-user / networked draft board
- Deployment to a server (this is local-only)
