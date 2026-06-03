# Multi-Week Planning View — Design Spec

Generated via `/plan-ceo-review` on 2026-06-03. Mode: SCOPE EXPANSION (user chose to build both pitcher and hitter halves together).

## Goal

A player × week grid for the next ~4 fantasy weeks that projects **playing-time volume** — the layer that multiplies the existing per-unit `pitcher_model` and per-game batter scores.

- **Pitchers:** expected number of starts per fantasy week, highlighting 2-start weeks. Announced probables near-term, rotation-turn projection far-term (4+ weeks).
- **Hitters:** expected games started per week, decomposed into **rest** (overall start rate) and **platoon** (start rate split by opposing starter's hand), **recency-weighted** so mid-season role changes show up fast.

Scope for v1 is the projection foundation only. Expected-weekly-points, a streaming optimizer, and add/drop recommendations are explicitly downstream (see NOT in scope).

## Why this is the right foundation

Everything built so far answers *"how good is this player per start/per game?"* Nothing answers *"how many starts/games will they accumulate next week?"* In weekly H2H points, a 2-start week from a mediocre SP beats a 1-start week from an ace. Volume is the biggest lineup lever and it's unbuilt. Get the per-week volume number right and the optimizer is arithmetic on top of the existing model.

## Data sources

### The backbone: ONE MLB StatsAPI schedule fetch does everything

```
GET https://statsapi.mlb.com/api/v1/schedule
    ?sportId=1&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&hydrate=probablePitcher,lineups
```

Returns `dates[].games[]` with `gamePk`, `gameDate`, `teams.home/away.team.id`, `status`, `teams.home/away.probablePitcher.{id,fullName}`, **and `lineups.homePlayers[]/awayPlayers[]`** (the 9-man starting lineup, each with `id`, `fullName`, `primaryPosition`). Free, official, exact. One ranged call (chunked by month for the full season) serves every data need:
- **Past games** → rotation inference (probablePitcher) + **ground-truth batter starts** (lineup membership) + opp-SP hand (probablePitcher → handedness map).
- **Future games** → exact per-week game counts + announced probables.

> **R1 — RESOLVED 2026-06-03 (validated against live API):**
> - `probablePitcher` **IS retained on completed games** (Final). Verified back through May; both teams' actual starters present. No `pitcher_starts` fallback needed.
> - `hydrate=lineups` returns the **full 9-man starting lineup for every completed game**, in the same ranged call. This is ground-truth "started" — no PA/`gamesStarted` heuristic, **no per-player gameLog loop**.
> - Probable horizon: 15/15 games today, decaying to ~5/15 at +4 days, then **0 from +5 days out**. Lineups appear only once posted (~1–2h pre-game; `status` flips to `Manager`), so future games have `lineupN=0` — exactly the regime the projection covers.
>
> Consequence: the data layer collapses to this single endpoint plus one batched `people` call. The separate per-player `gameLog` fetcher and the boxscore fallback are **eliminated**.

### Team identity: use MLB team ids, not abbreviations

`players.team` holds a FanGraphs/ESPN abbrev that does **not** reliably match StatsAPI abbrevs (CHW/CWS, WSH/WAS, SD/SDP). Avoid abbrev-matching entirely: store `players.mlb_team_id` (from the handedness fetch's `currentTeam.id`) and join players → schedule on team id. Sidesteps a whole class of silent join misses.

### Handedness + current team (batched)

```
GET https://statsapi.mlb.com/api/v1/people?personIds={comma,list}&hydrate=currentTeam
```

`batSide.code` (L/R/S), `pitchHand.code` (L/R), `currentTeam.id`. Batched — one call covers many players, not N calls.

### Batter start history (derived from schedule lineups — NO per-player fetch)

A batter "started" a game iff his `mlbam_id` appears in that game's `lineups.homePlayers`/`awayPlayers`. The ranged schedule fetch already carries every lineup, so one pass over `mlb_schedule`'s retained lineup rows reconstructs each ranked batter's full start history. The opposing starter (and thus platoon hand) for each of his games is the *other* team's `probablePitcher` in the same row → handedness map. Zero per-player API calls; a callup with no MLB history simply has no lineup rows yet (handled as "limited data").

## Models

### Pitcher rotation-turn projection

**v1 = FULL engine (user decision 2026-06-03): handle 6-man rotations, openers/bullpen games, skipped starters, and IL re-sync.**

1. From past `mlb_schedule` games per team (most recent ~30 days), build the ordered sequence of actual starters. Infer rotation **size** per team (5 vs 6) from the modal cycle length, not a hardcoded 5 (`rotation_size` config is the fallback default only).
2. **Opener/bullpen-game detection:** a "start" by a pitcher whose season GS count is low and IP-per-start is short is flagged as an opener; it does not claim a rotation slot (the bulk pitcher behind it, if identifiable, holds the turn). Unidentifiable bullpen games consume a schedule slot but project no specific SP.
3. Roll the inferred cycle forward over future scheduled games (next-man-up, one slot per team-game). **Skipped-starter handling:** off-days that would push a turn past a planned skip are absorbed so the cycle re-aligns to reality rather than drifting.
4. **Anchor to announced probables:** where a future game has an announced `probablePitcher`, use it directly and **re-sync the cycle to it** (rotate the slot pointer to that pitcher). Announced truth overrides projection inside the ~5-day window and self-corrects drift.
5. **IL re-sync:** join `injuries`; an IL pitcher is removed from the active cycle (his slot collapses to next-man-up) and projects zero starts until his injury clears. A pitcher returning from IL re-enters at the back of the cycle.
6. Output per pitcher per week: `exp_starts` (count of assigned future games in the week range) + `confidence` (`announced` vs `projected`).

> 2-start-week detection stays reliable even when a specific SP assignment drifts, because it's driven by schedule density (known exactly), not by which human is announced. That's the highest-value output and the most trustworthy part.

### Hitter playing-time (recency-weighted, hand-split)

For each ranked batter, from `batter_game_logs`:

```
weight w_i = exp(-age_days_i / HALF_LIFE)        # HALF_LIFE ≈ 21 days, in app_config
start_rate          = Σ w_i·started_i / Σ w_i                      # overall (rest = 1 - start_rate)
start_rate_vs_LHP   = Σ w_i·started_i / Σ w_i   over games vs LHP   # platoon behavior
start_rate_vs_RHP   = Σ w_i·started_i / Σ w_i   over games vs RHP
```

- **Small-sample shrinkage:** when same-hand games are few, regress the hand-split rate toward `start_rate` by effective (weighted) sample size, so a player with 3 games vs LHP doesn't read as a 0%/100% platoon.
- **Per-week expectation:** `exp_games = Σ over week's games P(start | that game's opposing-SP hand)`, using projected opposing starters from the rotation model. Injury status gates it down.
- Surfaced signals match the user's two asks explicitly: **rest** = overall start_rate; **platoon** = the L/R split (plus bat-hand and the week's matchup hands).

### Week bucketing

`app_config.planning_week_start` (default `monday`). Compute the next 4 boundaries from today; bucket each game's local date.

> **R2 — PARTIALLY RESOLVED 2026-06-03 (live ESPN `mSettings`):** league 133164 "Glen Ellyn Fantasy" runs **one-week H2H matchups** (`matchupPeriodLength=1`, 18 matchup periods, `currentMatchupPeriod=10` at `latestScoringPeriod=71`). So weekly bucketing is correct in principle. Exact **start weekday** not yet pinned from the API (ESPN MLB default is Monday). Mitigation unchanged: `planning_week_start` in `app_config` defaults `monday`; at build step 7 read one live matchup's date span from the `mMatchup` view to confirm the weekday before trusting weekly totals. One-line fix if it's off.

## Schema

```sql
-- players additions (ALTER migrations, matching db.js pattern)
ALTER TABLE players ADD COLUMN bat_hand TEXT;       -- L/R/S
ALTER TABLE players ADD COLUMN throw_hand TEXT;     -- L/R
ALTER TABLE players ADD COLUMN mlb_team_id INTEGER; -- StatsAPI team id

CREATE TABLE IF NOT EXISTS mlb_schedule (
  game_pk INTEGER PRIMARY KEY,
  game_date TEXT NOT NULL,        -- local YYYY-MM-DD
  season INTEGER NOT NULL,
  home_team_id INTEGER NOT NULL,
  away_team_id INTEGER NOT NULL,
  home_sp_mlbam TEXT,             -- probablePitcher id when known
  away_sp_mlbam TEXT,
  status TEXT
);
CREATE INDEX IF NOT EXISTS idx_sched_date ON mlb_schedule(game_date);
CREATE INDEX IF NOT EXISTS idx_sched_home ON mlb_schedule(home_team_id);
CREATE INDEX IF NOT EXISTS idx_sched_away ON mlb_schedule(away_team_id);

CREATE TABLE IF NOT EXISTS batter_game_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  mlbam_id TEXT NOT NULL,
  game_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  opp_team_id INTEGER,
  opp_sp_mlbam TEXT,
  opp_sp_hand TEXT,               -- denormalized at compute for speed
  started INTEGER NOT NULL,       -- 1/0
  UNIQUE(mlbam_id, game_date)
);
CREATE INDEX IF NOT EXISTS idx_bgl_player_id ON batter_game_logs(player_id);

CREATE TABLE IF NOT EXISTS playing_time_projection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  week_index INTEGER NOT NULL,    -- 0..3
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  player_type TEXT NOT NULL,      -- 'P' | 'B'
  games_in_week INTEGER,          -- team games that week
  exp_starts REAL,                -- pitchers
  two_start INTEGER,              -- pitchers: 1 if >=2 projected
  exp_games REAL,                 -- hitters
  start_rate REAL,                -- hitters: overall (rest)
  vs_lhp_rate REAL,
  vs_rhp_rate REAL,
  confidence TEXT,                -- 'announced' | 'projected'
  UNIQUE(player_id, week_index)
);
CREATE INDEX IF NOT EXISTS idx_ptp_player_id ON playing_time_projection(player_id);
```

`app_config` additions: `planning_week_start` (`monday`), `recency_half_life_days` (`21`), `rotation_size` (`5`).

## Scrape & compute flow

New route `/scrape/planning` (and folded into the existing refresh orchestration):

1. Fetch full-season `mlb_schedule` (`probablePitcher,lineups` hydrate, chunked by month) → upsert games; hold lineup arrays in memory for step 3.
2. Batch-fetch handedness + `currentTeam.id` for all ranked players → update `players`. Build mlbam_id → throw_hand map for opp-SP hand denorm.
3. Walk the fetched lineups: for each ranked batter, emit one `batter_game_logs` row per game (started=lineup membership, opp_sp_mlbam = other team's probablePitcher, opp_sp_hand from the hand map) → upsert. No per-player API calls.
4. Compute:
   - Pitcher rotation projection → per-pitcher per-week `exp_starts`, `two_start`, `confidence`.
   - Hitter recency-weighted rates → per-hitter per-week `exp_games`, `start_rate`, `vs_lhp_rate`, `vs_rhp_rate`.
   - Upsert `playing_time_projection`.

Cadence: probables/schedule shift daily → recompute on the view's refresh and nightly. Wire into the existing `DataRefresh` component and per-source freshness timestamps.

**256MB discipline:** schedule is tiny; gameLog and handedness fetches stay sequential/batched with no large retained arrays, mirroring the ESPN 300-batch and per-SP patterns. No memory bump.

## API

`GET /api/planning?weeks=4&scope=all|rostered` → rows joining `playing_time_projection` (pivoted to one object per player with a `weeks[]` array) to `combined_rankings` (name, position, team, `fantasy_team`) and the existing per-unit value (`m10_pts` for SP, batter `pts_per_game`) so the UI can show **volume × quality** in one place.

## UI

New page `client/src/pages/Planning.jsx` (new route + nav entry). Grid: rows = players (grouped: my team first, then by position), columns = next 4 weeks.

- **Pitcher cell:** start count with a gold "2-START" badge when `two_start`; confidence dot (solid = announced, hollow = projected); muted "—" / "0" when not projected to start.
- **Hitter cell:** `exp_games` like "5/6" (expected of scheduled), a platoon flag (e.g., `vL ✗` when `vs_lhp_rate` is low), and a rest indicator from `start_rate`.
- **Week header:** date range + your ESPN matchup that week.
- Reuse amber = "model estimate" header convention. Cover loading / empty / partial (missing handedness, no gamelog yet) states explicitly.
- `scope` toggle: My Roster / All.

## Failure modes & edge cases (registry)

| Codepath | Failure mode | Handling | User sees |
|---|---|---|---|
| Schedule fetch | StatsAPI 5xx/timeout | Retry, keep last-good `mlb_schedule`, set stale freshness | "Schedule data stale" badge |
| Single game missing probable/lineup | Gap in one game's SP or lineup | Skip that game's contribution (don't fabricate); recency weighting absorbs it | Slightly lower confidence |
| Team abbrev mismatch | — | Avoided by joining on `mlb_team_id` | n/a |
| Rotation drift >2 turns | Wrong SP on a day | Confidence=projected; 2-start (density) still correct | Hollow confidence dot |
| Doubleheader | Extra start possible | Counts as another game in the week; cycle handles it | Correct game count |
| Injured SP/hitter | Phantom volume | Join `injuries`, zero/flag | "IL" tag, volume suppressed |
| Few same-hand games | Bogus 0/100% platoon | Shrink hand-split toward overall rate | Softened platoon flag |
| Player with no gamelog (callup) | No rate | Fall back to position-average start rate; flag | "limited data" |
| ESPN week ≠ Mon-Sun (R2) | Off-by-a-day weekly totals | Config-driven boundary; verify in build | configurable |

## Test coverage plan

The projection math is **pure functions** (data in → numbers out), so it gets 100% unit coverage with synthetic fixtures — no network, no DB. Fetchers/routes get thin integration smoke tests.

```
                        ┌─────────────────────────────────────────┐
   PURE (100% target)   │  projectRotation()      ← rotation slots │
   server/src/planning/ │  recencyWeightedRate()  ← weights/decay  │
   *.test.js            │  shrinkHandSplit()      ← small-sample   │
                        │  weekBoundaries()       ← date math      │
                        │  bucketGamesByWeek()    ← game→week       │
                        │  expGamesForBatter()    ← Σ P(start)      │
                        └─────────────────────────────────────────┘
   THIN (smoke only)    │  schedule fetcher (mock fetch → upsert)  │
                        │  /api/planning (shape + pivot)           │
```

Required cases per function:
- **projectRotation:** clean 5-man cycle; 6-man rotation; skipped starter (off-day); injured SP removed mid-cycle; announced probable overrides projection and re-syncs; opener/bullpen game (no qualifying SP) → no phantom start; doubleheader → two starts same day.
- **recencyWeightedRate:** all-started (rate=1); all-benched (rate=0); decay actually down-weights old games (recent role change moves the number); single game; empty history.
- **shrinkHandSplit:** 0 same-hand games → returns overall rate exactly; many same-hand games → returns raw split (shrinkage ~0); midpoint blends by effective N.
- **weekBoundaries:** Monday start; configurable non-Monday start; crosses month boundary; today *is* a boundary day.
- **bucketGamesByWeek:** game on first day, on last day, off-day weeks (0 games), doubleheader.
- **expGamesForBatter:** all RHP week × R/L/S batter; mixed-hand week; injured (gated to 0); missing opp hand → uses overall rate.

## NOT in scope (deferred)

- Expected weekly **points** (volume × per-unit model) — the obvious next layer, but v1 nails volume first.
- Streaming optimizer / add-drop recommender.
- Explicit catcher-rest / day-after-night / vet-maintenance heuristics — recency-weighted empirical rate captures most of this; revisit if it underperforms.
- Player's own wOBA-vs-L/R **performance** splits (we model start *behavior*, not platoon *performance*, in v1).
- Bullpen/reliever volume (SV/HLD streaming).

## What already exists (reused)

- `players` ID spine (mlbam_id) — handedness/team columns bolt on.
- `pitcher_starts` — rotation-inference fallback + per-SP game dates.
- `pitcher_model` (`m10_pts`) and batter `pts_per_game` — the quality side the volume multiplies.
- `injuries`, `rosters`, `combined_rankings` — gating, ownership, joins.
- Scrape-route + per-source freshness + `DataRefresh` patterns.

## Build sequence

1. ~~Validate R1~~ **DONE** — schedule-only, `probablePitcher,lineups` confirmed on completed games.
2. Schema migrations + `mlb_schedule` fetcher (probablePitcher+lineups, monthly chunks); verify team-id joins light up players.
3. Handedness batch fetch → `players`.
4. Lineup→`batter_game_logs` derivation + opp-hand denormalization (in-memory from step 2's fetch, no extra calls).
5. Pitcher rotation projection module + tests (synthetic schedule fixtures).
6. Hitter recency-weighted rate module + tests (shrinkage edge cases).
7. `/scrape/planning` route + freshness wiring.
8. `/api/planning` route.
9. `Planning.jsx` grid + states.
10. Verify in browser, deploy (`--strategy immediate` if rolling 408s).
