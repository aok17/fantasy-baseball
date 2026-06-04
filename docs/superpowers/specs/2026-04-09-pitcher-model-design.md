# Pitcher Performance Model — Design Spec

## Goal

Build a per-start pitcher performance model that uses leading indicators to predict points/start, with rolling averages at 3, 10, and 30 start windows. The model is intentionally aggressive on strikeout and walk rate indicators (catching breakouts early) and conservative on BABIP/HR (avoiding noise).

## Data Pipeline

### Three sources, joined by player + game date

**1. Savant main game log** — one bulk CSV fetch per scrape
- Endpoint: `baseballsavant.mlb.com/statcast_search/csv`
- Parameters: `group_by=name-date`, `min_pitches=50`, current season, regular season games
- Fields used: `player_id`, `player_name`, `game_date`, `total_pitches`, `pa`, `abs`, `bip`, `hits`, `singles`, `doubles`, `triples`, `hrs`, `so`, `k_percent`, `bb`, `bb_percent`, `whiffs`, `swings`, `takes`, `swing_miss_percent`, `babip`, `woba`, `xwoba`

**2. Savant called-strike fetch** — same query but with `hfPR=called_strike` filter
- The `pitches` column = called strike count for that game
- Join to main data on `player_id + game_date`
- Derive: `called_strikes = pitches` from this query

**3. MLB Stats API game logs** — per-pitcher fetch for SPs in our rankings
- Endpoint: `statsapi.mlb.com/api/v1/people/{mlbam_id}/stats?stats=gameLog&season={year}&group=pitching`
- Fields used: `date`, `inningsPitched`, `gamesStarted`, `earnedRuns`, `numberOfPitches`
- Provides: exact IP, definitive GS flag, earned runs
- Only fetch for pitchers in `combined_rankings` with `mlbam_id` and position containing SP

### Per-start derived metrics

From the joined data, compute and store:

| Metric | Formula |
|--------|---------|
| `swstr_pct` | whiffs / total_pitches |
| `cstr_pct` | called_strikes / total_pitches |
| `ball_pct` | (takes - called_strikes) / total_pitches |
| `k_pct` | k_percent (from Savant, or so / pa) |
| `bb_pct` | bb_percent (from Savant, or bb / pa) |
| `hr_per_9` | hrs * 9 / IP |
| `babip` | from Savant directly |
| `pitches_per_start` | total_pitches |
| `ip` | from MLB Stats API |
| `er` | from MLB Stats API |
| `w` | 1 if pitcher got the win, 0 otherwise (from MLB API) |
| `qs` | 1 if IP >= 6 and ER <= 3, 0 otherwise |
| `pa` | plate appearances faced |
| `bip` | balls in play |

### Filtering

- Only include games with `gamesStarted = 1` from MLB API (confirmed starts)
- Fallback: if MLB API data unavailable for a pitcher, use `total_pitches >= 50` as heuristic

## Sub-Models

### 1. Strikeout Rate (aggressive)

```
xK% = 1.2 * SwStr% + 0.6 * CStr% - 4.0
```

- SwStr% and CStr% from the rolling window
- K% stabilizes at 30 BF (Tango), so even 3-start window (~65 BF) has signal
- R-squared ~0.82-0.86 from published multivariate models
- Sources: FanGraphs xK% research, Alex Chamberlain CSW work

### 2. Walk Rate (aggressive)

```
xBB% = a * ball_pct + b
```

- Coefficients fit from the season's scraped data (simple linear regression of bb_pct vs ball_pct across all starts)
- BB% stabilizes at 75 BF — 3-start window is aggressive, 10-start is solid
- Fallback initial coefficients: `xBB% = 0.8 * ball_pct - 0.15` (to be refined by fit)

### 3. BABIP + HR (conservative, heavy regression)

Using Tango's published regression constants:

```
regressed_BABIP = (bip * observed_BABIP + 3700 * 0.300) / (bip + 3700)
regressed_HR_FB = (fb * observed_HR_FB + 170 * 0.095) / (fb + 170)
```

- k=3700 for BABIP: at 30 starts (~300 BIP), estimate is 92% league average
- k=170 for HR/FB: at 30 starts (~150 FB), estimate is 53% league average
- 3-start window essentially returns league average — by design
- League averages (LG_BABIP=0.300, LG_HR_FB=0.095) stored in `app_config`

### 4. IP/Start (derived from K%, BB%, pitches/start)

```
bip_pct = 1 - est_k_pct - est_bb_pct
pitches_per_batter = bip_pct * P_BIP + est_k_pct * P_K + est_bb_pct * P_BB
outs_per_batter = bip_pct * 0.72 + est_k_pct * 1.0
pitches_per_out = pitches_per_batter / outs_per_batter
est_IP = (rolling_pitches_per_start / pitches_per_out) / 3
```

- P_BIP, P_K, P_BB = average pitches per ball-in-play, strikeout, walk — fit from scraped data
- Fallback initial constants: P_BIP=3.5, P_K=5.0, P_BB=5.5
- `rolling_pitches_per_start` = straight rolling average of actual pitch counts (reflects manager's leash)
- IP responds to K%/BB% changes: higher K% → more pitches per out → slightly less IP

### 5. ERA (derived via FIP)

```
est_FIP = ((13 * est_HR_per_game) + (3 * est_BB_per_game) - (2 * est_K_per_game)) / est_IP + FIP_CONSTANT
est_ER_per_start = est_FIP * est_IP / 9
```

- FIP coefficients are fixed (13, 3, 2) per linear run weights
- FIP_CONSTANT ~3.15, stored in `app_config`, updated per season
- ERA is fully downstream of K%, BB%, and HR sub-models

### 6. Win Probability (derived from ERA)

```
pythagorean_win_pct = lg_runs^2 / (lg_runs^2 + est_runs_allowed^2)
est_runs_allowed = est_FIP  (proxy)
decision_rate = rolling average of (W + L) / starts in window
P(W) = pythagorean_win_pct * decision_rate
P(L) = (1 - pythagorean_win_pct) * decision_rate
```

- League average runs/game (~4.5) stored in `app_config`
- Decision rate observed from the rolling window

### 7. QS Probability (derived from IP and ERA estimates)

```
P(QS) = P(IP >= 6) * P(ER <= 3 | IP >= 6)
```

- P(IP >= 6): logistic function of est_IP, or simpler — rolling fraction of starts with IP >= 6 at similar estimated IP levels
- P(ER <= 3 | IP >= 6): derived from estimated ERA — if est_ERA = 3.50, then est_ER in 6 IP = 2.33, so P(ER <= 3) is high
- Simplified: `P(QS) = rolling_qs_rate`, blended with the model's IP/ERA estimates

## Points/Start Estimate

Using scoring weights from `scoring_config` (current values):

```
pts_per_start =
    est_IP * 2.1
  + est_K * 1.0
  + est_BB * -0.5
  + est_H * -0.6
  + est_ER * -1.5
  + P(W) * 3.5
  + P(L) * -1.0
  + P(QS) * 2.0
```

Where:
- `est_K` = xK% * est_PA_per_start
- `est_BB` = xBB% * est_PA_per_start
- `est_H` = regressed_BABIP * est_BIP + est_HR
- `est_HR` = regressed_HR_per_9 * est_IP / 9
- `est_BIP` = est_PA - est_K - est_BB (approx)
- `est_PA_per_start` = rolling average PA

## Rolling Windows

All sub-models computed at three windows:
- **3-start**: most recent 3 starts — volatile, catches breakouts early
- **10-start**: ~6 weeks of starts — balanced signal
- **30-start**: ~full season — stable baseline

Each window produces a complete set of estimates (xK%, xBB%, regressed BABIP, est_IP, est_ERA, pts/start).

## Schema

### New table: `pitcher_starts`

Stores one row per pitcher per start with raw game data.

```sql
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
```

### New table: `pitcher_model`

Stores computed model outputs per pitcher, per rolling window.

```sql
CREATE TABLE IF NOT EXISTS pitcher_model (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  window INTEGER NOT NULL,  -- 3, 10, or 30
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
```

### `app_config` additions

| Key | Default | Description |
|-----|---------|-------------|
| `lg_babip` | `0.300` | League average BABIP |
| `lg_hr_fb` | `0.095` | League average HR/FB% |
| `lg_k_pct` | `0.200` | League average K% |
| `lg_bb_pct` | `0.077` | League average BB% |
| `lg_runs_per_game` | `4.5` | League average runs/game |
| `fip_constant` | `3.15` | FIP constant for current season |

## Scraping & Computation Flow

1. **Scrape** (`/scrape/pitcher-starts`):
   - Fetch Savant main game log CSV (all pitchers, current season, 50+ pitches)
   - Fetch Savant called-strike CSV (same params, `hfPR=called_strike`)
   - Join on `player_id + game_date` to get called_strikes count
   - For each SP in `combined_rankings` with `mlbam_id`: fetch MLB Stats API game log
   - Join MLB API data on `mlbam_id + date` to get IP, ER, GS flag
   - Filter to starts only (GS=1)
   - Upsert into `pitcher_starts`

2. **Compute** (runs after scrape, or on `/scrape/rescore`):
   - For each pitcher with starts in `pitcher_starts`:
     - Compute 3/10/30-start rolling windows
     - Run sub-models (K%, BB%, BABIP, HR, IP, ERA, W, QS)
     - Compute pts/start
     - Upsert into `pitcher_model`

## API

Rankings endpoint already joins all data. Add:

```sql
LEFT JOIN pitcher_model pm3 ON pm3.player_id = cr.player_id AND pm3.window = 3
LEFT JOIN pitcher_model pm10 ON pm10.player_id = cr.player_id AND pm10.window = 10
LEFT JOIN pitcher_model pm30 ON pm30.player_id = cr.player_id AND pm30.window = 30
```

Expose key fields with prefixes: `m3_pts`, `m10_pts`, `m30_pts`, `m3_xk`, `m10_xk`, etc.

## UI

### Column groups in PlayerTable

Add three new column groups to the column picker:

- **Model (3-start)** — `m3_pts`, `m3_xk`, `m3_xbb`, `m3_era`, `m3_ip`, `m3_pqs`
- **Model (10-start)** — same fields with `m10_` prefix
- **Model (30-start)** — same fields with `m30_` prefix

Header color: a distinct color from projected (purple) and actual (emerald) — likely **amber/orange** to signal "model estimate."

### Default visible columns

Add `m3_pts` and `m10_pts` to the default visible set for quick comparison.

## Constants to Fit from Data

On first scrape with enough data, fit these from the actual start data:

- **BB% regression coefficients**: `xBB% = a * ball_pct + b` (OLS across all starts)
- **Pitches per outcome**: average pitches for K, BIP, BB outcomes across all starts
- **QS probability model**: logistic or empirical from IP/ER distributions

Store fitted coefficients in `app_config` so they persist and can be manually adjusted.

## File Structure

```
server/src/scrapers/pitcher-starts.js    — data fetching (Savant + MLB API)
server/src/scoring/pitcher-model.js      — sub-models + pts/start computation
```

Follows existing patterns: scraper fetches and stores raw data, scoring module computes derived values.
