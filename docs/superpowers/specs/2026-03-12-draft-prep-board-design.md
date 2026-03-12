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

- **Method:** Log in with stored credentials, download Steamer/ZiPS projection CSV exports
- **Output tables:**
  - `pitchers_raw` (~5700 rows) — columns: name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB, WHIP, K/9, BB/9, ERA, FIP, WAR, RA9-WAR, player_id
  - `batters_raw` (~4500 rows) — columns: name, team, G, PA, AB, H, 2B, 3B, HR, R, RBI, BB, SO, HBP, SB, CS, AVG, OBP, SLG, OPS, wOBA, wRC, BsR, Fld, Off, Def, WAR, player_id
- **Trigger:** "Refresh Projections" button

### Baseball Savant / Statcast (public CSV)

- **Method:** Public CSV export API, no auth required
- **Output table:** `statcast_pitches` — one row per pitcher-pitch-type combo, columns include: player_id, player_name, pitch_type, velocity, spin_rate, whiff%, barrel%, xwoba, plus all movement/approach metrics
- **Derived view:** `pitcher_velocity` — computes velocity delta between 2024 regular season max and 2025 spring training max per pitcher. Filters deltas > 10 mph as bad data.
- **Seasons fetched:** Regular season 2024, Spring Training 2025

### ESPN ADP (scraping)

- **Method:** Scrape ESPN fantasy draft rankings page
- **Output table:** `espn_adp` — columns: name, adp_rank, projected_points
- **Joined to players** by name via `name_replacements` table

### Name Reconciliation

- **Table:** `name_replacements` — maps alternate spellings to canonical names (e.g., "Pete Alonso" -> "Peter Alonso")
- **Applied** as a preprocessing step before any cross-source joins
- **Seeded** from the existing 61-row sheet, editable via the app

---

## Scoring Engine

Recomputes all scores whenever projections change or scoring config is edited.

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

2. **Position classification:**
   - SV > 0 → "CLOSER"
   - GS == G → "SP"
   - GS > 0 and GS < G → "SP, RP" (dual-eligible)
   - GS == 0 → "RP"

3. **Adjustment:**
   - Closers: flat -10
   - SPs: `=-MIN(score * 3/7, replacement_level * 10/7 * 3/7) + 165`
   - Default replacement level: 237

4. **Adjusted 2020 Value** (dual-path valuation):
   ```
   MAX(
     -MIN(starting_pts * 3/7, replacement_level * 10/7 * 3/7) + 215 + starting_pts,
     relief_pts + 71
   )
   ```
   Where:
   - `starting_pts = raw_score - relief_pts`
   - `relief_pts = raw_score * (G - GS) / IP`

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

2. **Position scarcity adjustment:**

| Position | Adjustment |
|----------|-----------|
| C        | +70       |
| OF       | +40       |
| 2B       | +30       |
| 3B       | +25       |
| SS       | +20       |
| 1B       | +15       |
| Other    | +10       |

3. Position sourced from `batter_positions` table with multi-source fallback.

### Combined Rankings

- Merge pitchers and batters into a single list
- Score = `MAX(pitcher_adj_value, batter_adj_points)`
- Additional columns: ESPN ADP, velocity delta (pitchers), per-game efficiency, value gap (rank vs ESPN ADP)

### Configuration

All weights, position adjustments, and the replacement level threshold stored in `scoring_config` table. Editable via Settings page. Any change triggers full rescore.

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
- **Notes field** — inline editable per player, persisted to SQLite
- **Multiple draft sessions** — support for multiple leagues

Draft state persisted to `draft_picks` table (columns: player_name, pick_number, drafted_by, session_id, timestamp). Browser-safe — close and reopen without losing state.

### 3. Settings

- Scoring weights editor (pitcher and batter weights in editable tables)
- Position adjustment sliders
- Replacement level threshold input
- Data source refresh buttons with progress indicators
- Name replacements editor

### Navigation

Simple top nav bar with three links: Rankings, Draft, Settings.

---

## Database Schema (key tables)

```sql
-- Raw projection data
pitchers_raw (id, name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB, WHIP, K9, BB9, ERA, FIP, WAR, RA9WAR, player_id)
batters_raw (id, name, team, G, PA, AB, H, 2B, 3B, HR, R, RBI, BB, SO, HBP, SB, CS, AVG, OBP, SLG, OPS, wOBA, wRC, BsR, Fld, Off, Def, WAR, player_id)

-- Statcast
statcast_pitches (id, player_id, player_name, season, season_type, pitch_type, velocity, spin_rate, whiff_pct, barrel_pct, xwoba, ...)

-- Computed scores (materialized by scoring engine)
pitcher_scores (id, name, team, position, raw_score, adjustment, adj_score, adj_2020_value, pts_per_start, starting_pts, relief_pts)
batter_scores (id, name, team, position, raw_score, adjustment, adj_score, pts_per_game)
combined_rankings (id, name, team, position, score, adj_score, espn_adp, velocity_delta, value_gap)

-- Draft state
draft_sessions (id, name, created_at)
draft_picks (id, session_id, player_name, pick_number, drafted_by, timestamp)

-- Configuration
scoring_config (id, category, stat, weight)
position_adjustments (id, position, adjustment)
name_replacements (id, alt_name, canonical_name)
batter_positions (id, name, position_source_1, position_source_2, ...)

-- ESPN
espn_adp (id, name, adp_rank, projected_points)
```

---

## Out of Scope (future phases)

- In-season streaming system (two-starter identification, daily waivers, free agent tracking)
- Batter matchup ratings
- Schedule-based analysis
- Multi-user / networked draft board
- Deployment to a server (this is local-only)
