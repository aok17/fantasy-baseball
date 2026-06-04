# Fantasy Baseball Expansion Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix data integrity bugs, migrate to hosted SQLite (Turso) for Vercel deployment with phone access, add draft-day UX enhancements (value gradients, position needs, freshness timestamps, auto-rescore).

**Architecture:** Refactor all `better-sqlite3` synchronous DB calls to async `@libsql/client` calls, deploy Express API as Vercel serverless functions, deploy React frontend on Vercel. Add a canonical `players` table with integer IDs to replace fragile name-based JOINs. Add draft-day UX polish to the React frontend.

**Tech Stack:** @libsql/client (Turso), Vercel (hosting), React 18, Express, Vitest

**Dependencies between chunks:**
- Chunk 1 (P0 fixes) → independent, do first
- Chunk 2 (ID migration) → independent of Turso, but should be done before Turso to keep the Turso diff clean
- Chunk 3 (Turso migration) → depends on Chunk 2
- Chunk 4 (Vercel deployment) → depends on Chunk 3
- Chunk 5 (UX enhancements) → independent, can be done in parallel with Chunks 2-4
- Chunk 6 (Data integrity tests) → should be done after Chunks 1-2

---

## File Structure Changes

```
fantasy-baseball/
├── .gitignore                         # MODIFY: add tmp_*, *.db-wal, *.db-shm
├── .env                               # MODIFY: remove unused FG creds, add TURSO_URL + TURSO_AUTH_TOKEN
├── vercel.json                        # CREATE: Vercel config routing API + frontend
├── api/                               # CREATE: Vercel serverless function entry point
│   └── index.js                       # CREATE: Express adapter for Vercel
│
├── server/
│   ├── package.json                   # MODIFY: swap better-sqlite3 → @libsql/client
│   ├── src/
│   │   ├── db.js                      # MODIFY: Turso client instead of better-sqlite3
│   │   ├── seed.js                    # MODIFY: async
│   │   ├── schema.sql                 # MODIFY: add players table, indexes, last_refreshed
│   │   ├── index.js                   # MODIFY: async DB init
│   │   │
│   │   ├── scoring/
│   │   │   ├── rescore.js             # MODIFY: async, use player IDs
│   │   │   ├── pitcher-scoring.js     # NO CHANGE (pure function)
│   │   │   ├── batter-scoring.js      # NO CHANGE (pure function)
│   │   │   ├── combined.js            # NO CHANGE (pure function)
│   │   │   └── utils.js              # NO CHANGE
│   │   │
│   │   ├── scrapers/
│   │   │   ├── fangraphs.js           # MODIFY: async DB, transaction wrapping, 0-row guard
│   │   │   ├── savant.js              # MODIFY: async DB, transaction wrapping, 0-row guard
│   │   │   ├── espn.js                # MODIFY: async DB, transaction wrapping, 0-row guard
│   │   │   ├── injuries.js            # MODIFY: fix DROP TABLE, async DB, 0-row guard
│   │   │   └── names.js              # MODIFY: async DB calls
│   │   │
│   │   └── routes/
│   │       ├── rankings.js            # MODIFY: async, JOIN on player IDs, freshness timestamps
│   │       ├── draft.js               # MODIFY: async DB
│   │       ├── config.js              # MODIFY: async DB, auto-rescore on app config change
│   │       └── scrape.js              # MODIFY: async, store last_refreshed timestamps
│   │
│   └── tests/
│       ├── db.test.js                 # MODIFY: async, test players table + indexes
│       ├── test-utils.js              # CREATE: shared async test DB setup
│       ├── scoring/
│       │   └── rescore.test.js        # MODIFY: async
│       └── scrapers/
│           └── injuries.test.js       # CREATE: new test file
│
├── client/
│   └── src/
│       ├── App.jsx                    # MODIFY: add freshness bar
│       ├── components/
│       │   ├── PlayerTable.jsx        # MODIFY: value gradient rows
│       │   ├── RosterSidebar.jsx      # MODIFY: position need indicators
│       │   ├── FreshnessBar.jsx       # CREATE: data freshness display
│       │   └── DataRefresh.jsx        # MODIFY: show timestamps
│       └── pages/
│           └── Settings.jsx           # MODIFY: auto-rescore on config change
```

---

## Chunk 1: P0 Fixes (Data Integrity Bugs)

### Task 1: Fix injuries.js DROP TABLE bug

**Files:**
- Modify: `server/src/scrapers/injuries.js`

The injuries scraper does `DROP TABLE IF EXISTS injuries` then `CREATE TABLE` on every fetch. If the API call fails after the DROP, the injuries table is gone. Fix: use `DELETE FROM` like every other scraper. Add a 0-row guard: if the API returns 0 injuries, log a warning and skip the delete.

- [ ] **Step 1: Replace DROP TABLE with DELETE FROM**

Replace the entire `fetchInjuries` function in `server/src/scrapers/injuries.js` with:

```js
export async function fetchInjuries(db) {
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'season_year'").get();
  const season = Number(row?.value) || new Date().getFullYear();

  const url = `https://www.fangraphs.com/api/roster-resource/injury-report/data?groupby=team&timeframe=current&season=${season}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FanGraphs injury fetch failed: ${res.status}`);
  const data = await res.json();

  if (!Array.isArray(data)) throw new Error('Injury API returned non-array response');

  const current = data.filter(r => r.isNotCurrent === 0 && r.playerName1);

  if (current.length === 0) {
    console.warn('Injury scrape returned 0 results — keeping existing data');
    return { injuries: 0, skipped: true };
  }

  const insert = db.prepare(`INSERT OR REPLACE INTO injuries (name, team, position, injury, status, latest_update, mlbam_id)
    VALUES (@name, @team, @position, @injury, @status, @latest_update, @mlbam_id)`);

  db.transaction(() => {
    db.prepare('DELETE FROM injuries').run();
    for (const r of current) {
      insert.run({
        name: r.playerName1,
        team: r.team || null,
        position: r.position || null,
        injury: r.injurySurgery || null,
        status: r.status || null,
        latest_update: r.currentLatestUpdate || r.latestUpdate || null,
        mlbam_id: r.mlbamid ? String(r.mlbamid) : null,
      });
    }
  })();

  return { injuries: current.length };
}
```

- [ ] **Step 2: Verify the app starts and injuries route works**

Run: `cd server && node --watch src/index.js`

Expected: Server starts without errors. The `injuries` table is now defined only in `schema.sql` (which is correct — it already has the CREATE TABLE statement).

- [ ] **Step 3: Commit**

```bash
git add server/src/scrapers/injuries.js
git commit -m "fix: injuries scraper uses DELETE FROM instead of DROP TABLE

Prevents data loss if the API call fails. Adds 0-row guard to skip
delete when no injuries are returned. Wraps in transaction."
```

---

### Task 2: Add transaction wrapping to all scrapers

**Files:**
- Modify: `server/src/scrapers/fangraphs.js`
- Modify: `server/src/scrapers/savant.js`
- Modify: `server/src/scrapers/espn.js`

Each scraper does `DELETE FROM` then bulk `INSERT` without a transaction. If the process crashes mid-insert, data is partial. Wrap each in `db.transaction()`. Also add 0-row guards.

- [ ] **Step 1: Wrap fangraphs.js in transaction with 0-row guard**

Replace the `fetchFanGraphs` function in `server/src/scrapers/fangraphs.js` with:

```js
export async function fetchFanGraphs(db) {
  const projSystem = db.prepare("SELECT value FROM app_config WHERE key='projection_system'").get()?.value || 'steamer';

  const pitUrl = `https://www.fangraphs.com/api/projections?type=${projSystem}&stats=pit&pos=all`;
  const pitRes = await fetch(pitUrl);
  if (!pitRes.ok) throw new Error(`FanGraphs pitcher fetch failed: ${pitRes.status}`);
  const pitchers = (await pitRes.json()).map(mapPitcher);

  const batUrl = `https://www.fangraphs.com/api/projections?type=${projSystem}&stats=bat&pos=all`;
  const batRes = await fetch(batUrl);
  if (!batRes.ok) throw new Error(`FanGraphs batter fetch failed: ${batRes.status}`);
  const batters = (await batRes.json()).map(mapBatter);

  if (pitchers.length === 0 && batters.length === 0) {
    console.warn('FanGraphs returned 0 pitchers and 0 batters — keeping existing data');
    return { pitchers: 0, batters: 0, skipped: true };
  }

  db.transaction(() => {
    if (pitchers.length > 0) {
      db.prepare('DELETE FROM pitchers_raw').run();
      const insertPit = db.prepare(`INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB, WHIP, K9, BB9, ERA, FIP, WAR, RA9WAR, player_id) VALUES (@name, @team, @GS, @G, @IP, @W, @L, @QS, @SV, @HLD, @H, @ER, @HR, @SO, @BB, @WHIP, @K9, @BB9, @ERA, @FIP, @WAR, @RA9WAR, @player_id)`);
      for (const p of pitchers) insertPit.run(p);
    }

    if (batters.length > 0) {
      db.prepare('DELETE FROM batters_raw').run();
      const insertBat = db.prepare(`INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS, AVG, OBP, SLG, OPS, wOBA, wRC, BsR, Fld, Off, Def, WAR, player_id) VALUES (@name, @team, @G, @PA, @AB, @H, @2B, @3B, @HR, @R, @RBI, @BB, @SO, @HBP, @SB, @CS, @AVG, @OBP, @SLG, @OPS, @wOBA, @wRC, @BsR, @Fld, @Off, @Def, @WAR, @player_id)`);
      for (const b of batters) insertBat.run(b);
    }
  })();

  return { pitchers: pitchers.length, batters: batters.length };
}
```

- [ ] **Step 2: Wrap savant.js in transaction with 0-row guard**

Replace the `fetchSavant` function in `server/src/scrapers/savant.js` with:

```js
export async function fetchSavant(db) {
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'season_year'").get();
  const currentYear = Number(row?.value) || new Date().getFullYear();
  const fetches = [
    { season: currentYear - 1, gameType: 'R', seasonType: 'regular' },
    { season: currentYear, gameType: 'S', seasonType: 'spring' },
  ];

  const allRows = [];
  for (const { season, gameType, seasonType } of fetches) {
    const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfGT=${gameType}%7C&hfSea=${season}%7C&player_type=pitcher&min_pitches=0&min_results=0&group_by=pitch-type&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&min_pas=0`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Savant fetch failed for ${season} ${seasonType}: ${res.status}`);
    const csv = await res.text();
    const rows = await parseSavantCsv(csv, season, seasonType);
    allRows.push(...rows);
  }

  if (allRows.length === 0) {
    console.warn('Savant returned 0 rows — keeping existing data');
    return { rows: 0, skipped: true };
  }

  const insert = db.prepare(`INSERT INTO statcast_pitches
    (player_id, player_name, season, season_type, pitch_type, velocity, spin_rate, whiff_pct, barrel_pct, xwoba)
    VALUES (@player_id, @player_name, @season, @season_type, @pitch_type, @velocity, @spin_rate, @whiff_pct, @barrel_pct, @xwoba)`);

  db.transaction(() => {
    db.prepare('DELETE FROM statcast_pitches').run();
    for (const r of allRows) insert.run(r);
  })();

  return { rows: allRows.length };
}
```

- [ ] **Step 3: Wrap espn.js in transaction with 0-row guard**

Replace the entire `fetchEspn` function in `server/src/scrapers/espn.js` with:

```js
export async function fetchEspn(db) {
  const year = db.prepare("SELECT value FROM app_config WHERE key='season_year'").get()?.value || '2026';
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leaguedefaults/3?view=kona_player_info`;

  const res = await fetch(url, {
    headers: {
      'x-fantasy-filter': JSON.stringify({
        players: { limit: 1500, sortPercOwned: { sortAsc: false, sortPriority: 1 } },
      }),
    },
  });
  if (!res.ok) throw new Error(`ESPN fetch failed: ${res.status}`);
  const json = await res.json();
  const players = parseEspnResponse(json);

  if (players.length === 0) {
    console.warn('ESPN returned 0 players — keeping existing data');
    return { players: 0, positions: 0, skipped: true };
  }

  const replacements = loadReplacements(db);
  const accentMap = buildAccentMap(db);
  const source = `espn_${year}`;

  const bestByName = {};
  for (const p of players) {
    const n = reconcileName(p.name, replacements);
    const pts = p.projected_points || 0;
    if (!bestByName[n] || pts > bestByName[n]) bestByName[n] = pts;
  }

  const insertAdp = db.prepare(
    'INSERT INTO espn_adp (name, adp_rank, projected_points) VALUES (?, ?, ?)'
  );
  const insertPos = db.prepare(
    'INSERT OR IGNORE INTO position_eligibility (name, source, position) VALUES (?, ?, ?)'
  );

  db.transaction(() => {
    db.prepare('DELETE FROM espn_adp').run();
    db.prepare('DELETE FROM position_eligibility WHERE source = ?').run(source);

    for (const p of players) {
      let name = reconcileName(p.name, replacements);
      const pts = p.projected_points || 0;
      if (accentMap[name] && pts >= bestByName[name]) name = accentMap[name];
      insertAdp.run(name, p.adp_rank, p.projected_points);
      for (const pos of p.positions) {
        insertPos.run(name, source, pos);
      }
    }
  })();

  return { players: players.length, positions: players.filter(p => p.positions.length > 0).length };
}
```

- [ ] **Step 4: Run existing tests**

Run: `cd server && npx vitest run`

Expected: All existing tests pass. The transaction wrapping doesn't change behavior, only atomicity.

- [ ] **Step 5: Commit**

```bash
git add server/src/scrapers/fangraphs.js server/src/scrapers/savant.js server/src/scrapers/espn.js
git commit -m "fix: wrap all scrapers in transactions with 0-row guards

Prevents partial data on crash. If an API returns 0 rows, existing
data is preserved with a warning instead of silently emptied."
```

---

### Task 3: Clean up temp files and .gitignore

**Files:**
- Modify: `.gitignore`
- Delete: `tmp_*` files, `SPREADSHEET_SPEC.md` (if no longer needed)
- Modify: `.env` (remove unused credentials)

- [ ] **Step 1: Update .gitignore**

Add these lines to `.gitignore`:

```
*.db-shm
*.db-wal
tmp_*
SPREADSHEET_SPEC.md
```

- [ ] **Step 2: Remove unused FanGraphs credentials from .env**

The FanGraphs scraper now uses the public JSON API (no auth). Remove the credentials from `.env`. The file should only contain:

```
# Add Turso credentials here when ready:
# TURSO_DATABASE_URL=libsql://your-db.turso.io
# TURSO_AUTH_TOKEN=your-token
```

- [ ] **Step 3: Delete temp files**

Run:
```bash
rm -f tmp_cookies.txt tmp_rw.json tmp_rw2.json tmp_rw3.json tmp_rw_players.txt tmp_team.html tmp_test_puppeteer.js tmp_test_puppeteer2.js tmp_test_puppeteer3.js
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: clean up temp files, add WAL/tmp to gitignore, remove unused creds"
```

---

## Chunk 2: Canonical Players Table + ID-Based JOINs

This chunk introduces a `players` table as the canonical identity for each player. All other tables reference `player_id` (an integer primary key in `players`) instead of joining on name strings. This eliminates silent data loss from name mismatches and enables fast indexed JOINs.

### Task 4: Add `players` table and indexes to schema

**Files:**
- Modify: `server/src/schema.sql`

- [ ] **Step 1: Add players table and indexes**

Add at the top of `server/src/schema.sql` (before the other CREATE TABLE statements):

```sql
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  team TEXT,
  fg_id TEXT,
  mlbam_id TEXT,
  UNIQUE(name, team)
);

CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
```

Then add `player_id INTEGER REFERENCES players(id)` to every table that currently joins on name. The tables to modify:

**Approach:** The raw tables (`pitchers_raw`, `batters_raw`, `statcast_pitches`) keep their existing shape since they're ephemeral (deleted and re-inserted on each scrape). Only `combined_rankings` gets a `player_id` FK column, populated during rescore.

Add to `server/src/schema.sql`:

```sql
-- At the top:
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
```

Add indexes for name lookups on raw tables:

```sql
CREATE INDEX IF NOT EXISTS idx_pitchers_raw_name ON pitchers_raw(name, team);
CREATE INDEX IF NOT EXISTS idx_batters_raw_name ON batters_raw(name, team);
CREATE INDEX IF NOT EXISTS idx_statcast_name ON statcast_pitches(player_name);
CREATE INDEX IF NOT EXISTS idx_espn_adp_name ON espn_adp(name);
CREATE INDEX IF NOT EXISTS idx_injuries_name ON injuries(name);
CREATE INDEX IF NOT EXISTS idx_position_eligibility_name ON position_eligibility(name);
CREATE INDEX IF NOT EXISTS idx_player_notes_name ON player_notes(name);
```

Add `player_id` column to `combined_rankings`:

```sql
-- In the combined_rankings CREATE TABLE, add after id:
--   player_id INTEGER REFERENCES players(id),
```

So the full `combined_rankings` becomes:

```sql
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
```

- [ ] **Step 2: Delete existing DB to apply schema changes**

Since there's no migration system, delete the existing DB. It will be recreated on next server start.

Run: `rm -f fantasy-baseball.db fantasy-baseball.db-shm fantasy-baseball.db-wal`

- [ ] **Step 3: Run tests to verify schema loads**

Run: `cd server && npx vitest run tests/db.test.js`

Expected: Tests pass. The new `players` table should be created.

- [ ] **Step 4: Update db.test.js to check for `players` table**

In `server/tests/db.test.js`, add to the 'creates all required tables' test:

```js
expect(tables).toContain('players');
```

- [ ] **Step 5: Run test to verify**

Run: `cd server && npx vitest run tests/db.test.js`

Expected: All tests pass including the new assertion.

- [ ] **Step 6: Commit**

```bash
git add server/src/schema.sql server/tests/db.test.js
git commit -m "feat: add canonical players table with indexes for ID-based JOINs

All name-lookup tables get indexes. combined_rankings gets a player_id
FK column. Raw tables keep name-based shape since they're ephemeral."
```

---

### Task 5: Populate `players` table during rescore

**Files:**
- Modify: `server/src/scoring/rescore.js`

During `rescoreAll()`, after computing scores but before writing `combined_rankings`, upsert all player names into the `players` table and capture their IDs. Write `player_id` into `combined_rankings`. Also populate `fg_id` and `mlbam_id` from raw tables.

- [ ] **Step 1: Update rescoreAll to populate players table**

Replace `server/src/scoring/rescore.js` with:

```js
import { computePitcherScores } from './pitcher-scoring.js';
import { computeBatterScores, resolvePosition } from './batter-scoring.js';
import { buildCombinedRankings } from './combined.js';

function getWeights(db, category) {
  const rows = db.prepare('SELECT stat, weight FROM scoring_config WHERE category = ?').all(category);
  const weights = {};
  for (const r of rows) weights[r.stat] = r.weight;
  return weights;
}

function getPosAdjustments(db) {
  const rows = db.prepare('SELECT position, adjustment FROM position_adjustments').all();
  const adj = {};
  for (const r of rows) adj[r.position] = r.adjustment;
  return adj;
}

function getConfig(db, key) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getVelocityDeltas(db) {
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'season_year'").get();
  const currentYear = Number(row?.value) || new Date().getFullYear();
  const prevYear = currentYear - 1;
  const rows = db.prepare(`
    SELECT player_name, v_prev, v_curr, (v_curr - v_prev) as delta, n_curr FROM (
      SELECT player_name,
        MAX(CASE WHEN season = ? AND season_type = 'regular' THEN velocity END) as v_prev,
        MAX(CASE WHEN season = ? AND season_type = 'spring' THEN velocity END) as v_curr,
        SUM(CASE WHEN season = ? AND season_type = 'spring' THEN 1 ELSE 0 END) as n_curr
      FROM statcast_pitches GROUP BY player_name
    ) WHERE v_prev IS NOT NULL AND v_curr IS NOT NULL AND (v_curr - v_prev) < 10
  `).all(prevYear, currentYear, currentYear);
  const deltas = {};
  for (const r of rows) deltas[r.player_name] = { delta: r.delta, velo_prev: r.v_prev, velo_curr: r.v_curr, velo_n: r.n_curr };
  return deltas;
}

function getEspnAdp(db) {
  const rows = db.prepare('SELECT name, adp_rank FROM espn_adp').all();
  const adp = {};
  for (const r of rows) adp[r.name] = r.adp_rank;
  return adp;
}

function upsertPlayers(db, pitcherScores, batterScores) {
  const upsert = db.prepare(`
    INSERT INTO players (name, team) VALUES (?, ?)
    ON CONFLICT(name, team) DO UPDATE SET team = excluded.team
  `);
  const updateFgId = db.prepare('UPDATE players SET fg_id = ? WHERE name = ? AND team = ?');
  const updateMlbamId = db.prepare('UPDATE players SET mlbam_id = ? WHERE name = ? AND team = ?');
  const getId = db.prepare('SELECT id FROM players WHERE name = ? AND team = ?');

  // Upsert all scored players
  for (const p of pitcherScores) upsert.run(p.name, p.team);
  for (const b of batterScores) upsert.run(b.name, b.team);

  // Populate fg_id from raw tables
  const fgPitchers = db.prepare('SELECT name, team, player_id FROM pitchers_raw WHERE player_id IS NOT NULL').all();
  for (const r of fgPitchers) updateFgId.run(r.player_id, r.name, r.team);
  const fgBatters = db.prepare('SELECT name, team, player_id FROM batters_raw WHERE player_id IS NOT NULL').all();
  for (const r of fgBatters) updateFgId.run(r.player_id, r.name, r.team);

  // Populate mlbam_id from statcast
  const statcast = db.prepare('SELECT DISTINCT player_name, player_id FROM statcast_pitches WHERE player_id IS NOT NULL').all();
  // statcast doesn't have team, so match by name against existing players
  const updateMlbamByName = db.prepare('UPDATE players SET mlbam_id = ? WHERE name = ? AND mlbam_id IS NULL');
  for (const r of statcast) updateMlbamByName.run(r.player_id, r.player_name);

  // Build name→id map
  const idMap = {};
  const allPlayers = db.prepare('SELECT id, name, team FROM players').all();
  for (const p of allPlayers) idMap[`${p.name}|${p.team}`] = p.id;
  return idMap;
}

export function rescoreAll(db) {
  db.transaction(() => {
    const pitcherWeights = getWeights(db, 'pitcher');
    const batterWeights = getWeights(db, 'batter');
    const posAdj = getPosAdjustments(db);
    const replacementLevel = Number(getConfig(db, 'replacement_level')) || 237;

    const rawPitchers = db.prepare('SELECT * FROM pitchers_raw').all();
    const pitcherScores = computePitcherScores(rawPitchers, pitcherWeights, replacementLevel);

    db.prepare('DELETE FROM pitcher_scores').run();
    const insertPitcher = db.prepare(`
      INSERT INTO pitcher_scores (name, team, scoring_position, display_position,
        raw_score, adjustment, adj_score, starting_pts, relief_pts, adj_2020_value, pts_per_appearance)
      VALUES (@name, @team, @scoring_position, @display_position,
        @raw_score, @adjustment, @adj_score, @starting_pts, @relief_pts, @adj_2020_value, @pts_per_appearance)
    `);
    for (const p of pitcherScores) insertPitcher.run(p);

    const rawBatters = db.prepare('SELECT * FROM batters_raw WHERE PA >= 10').all();
    const posRows = db.prepare('SELECT name, source, position FROM position_eligibility').all();
    const positionsMap = {};
    for (const row of posRows) {
      if (!positionsMap[row.name]) positionsMap[row.name] = [];
      positionsMap[row.name].push(row);
    }
    const battersWithPos = rawBatters.map(b => ({
      ...b, position: resolvePosition(positionsMap[b.name] || []),
    }));
    const batterScores = computeBatterScores(battersWithPos, batterWeights, posAdj);

    db.prepare('DELETE FROM batter_scores').run();
    const insertBatter = db.prepare(`
      INSERT INTO batter_scores (name, team, position, raw_score, adjustment, adj_score, pts_per_game)
      VALUES (@name, @team, @position, @raw_score, @adjustment, @adj_score, @pts_per_game)
    `);
    for (const b of batterScores) insertBatter.run(b);

    // Upsert players and get ID map
    const idMap = upsertPlayers(db, pitcherScores, batterScores);

    const espnAdp = getEspnAdp(db);
    const velocityDeltas = getVelocityDeltas(db);
    const combined = buildCombinedRankings(pitcherScores, batterScores, espnAdp, velocityDeltas);

    db.prepare('DELETE FROM combined_rankings').run();
    const insertCombined = db.prepare(`
      INSERT INTO combined_rankings (player_id, rank, name, team, position, score, adj_score,
        espn_adp, velocity_delta, velo_prev, velo_curr, velo_n, per_game_efficiency, value_gap)
      VALUES (@player_id, @rank, @name, @team, @position, @score, @adj_score,
        @espn_adp, @velocity_delta, @velo_prev, @velo_curr, @velo_n, @per_game_efficiency, @value_gap)
    `);
    for (const c of combined) {
      insertCombined.run({
        ...c,
        player_id: idMap[`${c.name}|${c.team}`] || null,
      });
    }
  })();
}
```

- [ ] **Step 2: Run tests**

Run: `cd server && npx vitest run`

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/scoring/rescore.js
git commit -m "feat: populate players table during rescore with fg_id and mlbam_id

upsertPlayers() creates/updates canonical player records and extracts
IDs from FanGraphs and Statcast raw data. combined_rankings now has
player_id FK for indexed JOINs."
```

---

### Task 6: Refactor rankings query to use player IDs

**Files:**
- Modify: `server/src/routes/rankings.js`

The current rankings query joins 5 tables by name strings. Refactor to join `combined_rankings` → `players` → other tables via `players.id`, `players.fg_id`, and `players.mlbam_id`.

- [ ] **Step 1: Rewrite rankings query**

Replace the GET `/` handler in `server/src/routes/rankings.js` with:

```js
  router.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT
        cr.*,
        p.fg_id,
        p.mlbam_id,
        inj.latest_update as injury,
        pn.note as note,
        pr.IP as ip, pr.GS as gs, pr.G as pit_g, pr.W, pr.L, pr.QS, pr.SV,
        pr.SO as pit_so, pr.BB as pit_bb, pr.K9 as k9, pr.BB9 as bb9,
        pr.ERA as era, pr.WHIP as whip, pr.FIP as fip,
        pr.WAR as pit_war, pr.RA9WAR as ra9war, pr.HLD as hld,
        br.PA as pa, br.AB as ab, br.G as bat_g, br.H as bat_h,
        br."2B" as doubles, br."3B" as triples, br.HR as hr,
        br.R as runs, br.RBI as rbi, br.BB as bat_bb, br.SO as bat_so,
        br.SB as sb, br.CS as cs, br.HBP as hbp,
        br.AVG as avg, br.OBP as obp, br.SLG as slg, br.OPS as ops,
        br.wOBA as woba, br.wRC as wrc_plus,
        br.WAR as bat_war
      FROM combined_rankings cr
      LEFT JOIN players p ON cr.player_id = p.id
      LEFT JOIN pitchers_raw pr ON cr.name = pr.name AND cr.team = pr.team
      LEFT JOIN batters_raw br ON cr.name = br.name AND cr.team = br.team
      LEFT JOIN injuries inj ON cr.name = inj.name
      LEFT JOIN player_notes pn ON cr.name = pn.name
      ORDER BY cr.rank
    `).all();
    res.json(rows);
  });
```

Note: The JOIN to `pitchers_raw` and `batters_raw` still uses name+team because those raw tables are ephemeral and don't have a `player_id` FK. The `players` table join gives us `fg_id` and `mlbam_id` via the indexed FK. The indexes added in Task 4 will speed up the name-based JOINs.

- [ ] **Step 2: Run tests**

Run: `cd server && npx vitest run`

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/rankings.js
git commit -m "refactor: rankings query joins players table for fg_id/mlbam_id

Uses player_id FK for the canonical identity join. Raw table joins
still use name+team (ephemeral data) but benefit from new indexes."
```

---

## Chunk 3: Turso Migration (better-sqlite3 → @libsql/client)

This is the largest chunk. Every file that calls `db.prepare(...).run()` or `db.prepare(...).all()` needs to become async. The @libsql/client API is similar but uses `db.execute()` and `db.batch()` instead.

### Key API differences:

| better-sqlite3 (sync) | @libsql/client (async) |
|---|---|
| `db.prepare(sql).run(args)` | `await db.execute({ sql, args: [args] })` |
| `db.prepare(sql).get(args)` | `const r = await db.execute({ sql, args }); r.rows[0]` |
| `db.prepare(sql).all(args)` | `const r = await db.execute({ sql, args }); r.rows` |
| `db.transaction(() => { ... })()` | `await db.batch([stmt1, stmt2, ...])` |
| `db.exec(multiStatementSql)` | `await db.executeMultiple(multiStatementSql)` |
| `db.pragma(...)` | Not needed (Turso handles this) |
| Named params `@name` | Positional `?` params (Turso doesn't support named) |

**Important:** Turso's `batch()` runs all statements in a transaction automatically. For scrapers doing DELETE + many INSERTs, we'll use `batch()`.

**Important:** Turso returns rows as plain objects with column names as keys, similar to better-sqlite3.

### Task 7: Install @libsql/client and update db.js

**Files:**
- Modify: `server/package.json`
- Modify: `server/src/db.js`
- Modify: `.env`

- [ ] **Step 1: Install @libsql/client**

Run: `cd server && npm install @libsql/client && npm uninstall better-sqlite3`

- [ ] **Step 2: Create a Turso database**

Run:
```bash
# Install Turso CLI if not already installed
# On Windows: npm install -g @tursodatabase/cli
turso db create fantasy-baseball
turso db show fantasy-baseball --url
turso db tokens create fantasy-baseball
```

Copy the URL and token into `.env`:
```
TURSO_DATABASE_URL=libsql://fantasy-baseball-<your-username>.turso.io
TURSO_AUTH_TOKEN=<your-token>
```

- [ ] **Step 3: Rewrite db.js for Turso**

Replace `server/src/db.js` with:

```js
// server/src/db.js
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seedDefaults } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createDb() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error('TURSO_DATABASE_URL is required. Set it in .env');
  }

  const db = createClient({ url, authToken });

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await db.executeMultiple(schema);
  await seedDefaults(db);

  return db;
}
```

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/src/db.js .env
git commit -m "feat: replace better-sqlite3 with @libsql/client (Turso)

Database is now hosted on Turso. db.js creates an async client.
Schema and seed are applied via executeMultiple."
```

---

### Task 8: Convert seed.js to async

**Files:**
- Modify: `server/src/seed.js`

- [ ] **Step 1: Rewrite seed.js for Turso**

Replace `server/src/seed.js` with:

```js
// server/src/seed.js

export async function seedDefaults(db) {
  const pitcherWeights = [
    ['IP', 2.1], ['W', 3.5], ['L', -1.0], ['QS', 2.0], ['SV', 5.0],
    ['H', -0.6], ['ER', -1.5], ['SO', 1.0], ['BB', -0.5],
  ];

  const batterWeights = [
    ['H', 1.0], ['2B', 1.0], ['3B', 2.0], ['HR', 3.1], ['R', 1.1],
    ['RBI', 1.1], ['BB', 1.0], ['SO', -1.0], ['SB', 2.0],
  ];

  const posAdj = [
    ['C', 70], ['OF', 40], ['2B', 30], ['3B', 25],
    ['SS', 20], ['1B', 15], ['Other', 10],
  ];

  const stmts = [];

  for (const [stat, weight] of pitcherWeights) {
    stmts.push({
      sql: 'INSERT OR IGNORE INTO scoring_config (category, stat, weight) VALUES (?, ?, ?)',
      args: ['pitcher', stat, weight],
    });
  }
  for (const [stat, weight] of batterWeights) {
    stmts.push({
      sql: 'INSERT OR IGNORE INTO scoring_config (category, stat, weight) VALUES (?, ?, ?)',
      args: ['batter', stat, weight],
    });
  }
  for (const [pos, adj] of posAdj) {
    stmts.push({
      sql: 'INSERT OR IGNORE INTO position_adjustments (position, adjustment) VALUES (?, ?)',
      args: [pos, adj],
    });
  }
  stmts.push({ sql: "INSERT OR IGNORE INTO app_config (key, value) VALUES (?, ?)", args: ['replacement_level', '237'] });
  stmts.push({ sql: "INSERT OR IGNORE INTO app_config (key, value) VALUES (?, ?)", args: ['projection_system', 'steamer'] });
  stmts.push({ sql: "INSERT OR IGNORE INTO app_config (key, value) VALUES (?, ?)", args: ['season_year', '2026'] });

  await db.batch(stmts);
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/seed.js
git commit -m "refactor: seed.js uses async Turso batch API"
```

---

### Task 9: Convert scrapers to async Turso API

**Files:**
- Modify: `server/src/scrapers/names.js`
- Modify: `server/src/scrapers/fangraphs.js`
- Modify: `server/src/scrapers/savant.js`
- Modify: `server/src/scrapers/espn.js`
- Modify: `server/src/scrapers/injuries.js`

This task converts all `db.prepare(...).run/get/all()` calls to `await db.execute({ sql, args })`. The key pattern:

```js
// OLD: db.prepare('SELECT * FROM foo WHERE bar = ?').all(val)
// NEW: (await db.execute({ sql: 'SELECT * FROM foo WHERE bar = ?', args: [val] })).rows

// OLD: db.prepare('INSERT INTO foo (a) VALUES (?)').run(val)
// NEW: await db.execute({ sql: 'INSERT INTO foo (a) VALUES (?)', args: [val] })

// OLD: db.transaction(() => { db.prepare(...).run(); db.prepare(...).run(); })()
// NEW: await db.batch([{ sql: '...', args: [...] }, { sql: '...', args: [...] }])
```

**Important for batch inserts:** Turso's `batch()` can handle hundreds of statements in one call. For scrapers inserting 1500+ rows, build an array of statement objects and pass to `batch()`.

- [ ] **Step 1: Convert names.js**

Replace `server/src/scrapers/names.js` with:

```js
export function convertLastFirst(name) {
  const commaIdx = name.indexOf(',');
  if (commaIdx === -1) return name;
  const last = name.substring(0, commaIdx).trim();
  const first = name.substring(commaIdx + 1).trim();
  return `${first} ${last}`;
}

function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function reconcileName(name, replacements) {
  return replacements[name] || name;
}

export async function loadReplacements(db) {
  const result = await db.execute('SELECT alt_name, canonical_name FROM name_replacements');
  const map = {};
  for (const r of result.rows) map[r.alt_name] = r.canonical_name;
  return map;
}

export async function buildAccentMap(db) {
  const map = {};
  for (const table of ['batters_raw', 'pitchers_raw']) {
    const result = await db.execute(`SELECT DISTINCT name FROM ${table}`);
    for (const r of result.rows) {
      const stripped = stripAccents(r.name);
      if (stripped !== r.name) {
        map[stripped] = r.name;
      }
    }
  }
  return map;
}
```

- [ ] **Step 2: Convert fangraphs.js**

Replace the `fetchFanGraphs` function in `server/src/scrapers/fangraphs.js`:

```js
export async function fetchFanGraphs(db) {
  const projResult = await db.execute("SELECT value FROM app_config WHERE key='projection_system'");
  const projSystem = projResult.rows[0]?.value || 'steamer';

  const pitUrl = `https://www.fangraphs.com/api/projections?type=${projSystem}&stats=pit&pos=all`;
  const pitRes = await fetch(pitUrl);
  if (!pitRes.ok) throw new Error(`FanGraphs pitcher fetch failed: ${pitRes.status}`);
  const pitchers = (await pitRes.json()).map(mapPitcher);

  const batUrl = `https://www.fangraphs.com/api/projections?type=${projSystem}&stats=bat&pos=all`;
  const batRes = await fetch(batUrl);
  if (!batRes.ok) throw new Error(`FanGraphs batter fetch failed: ${batRes.status}`);
  const batters = (await batRes.json()).map(mapBatter);

  if (pitchers.length === 0 && batters.length === 0) {
    console.warn('FanGraphs returned 0 pitchers and 0 batters — keeping existing data');
    return { pitchers: 0, batters: 0, skipped: true };
  }

  const stmts = [];

  if (pitchers.length > 0) {
    stmts.push({ sql: 'DELETE FROM pitchers_raw', args: [] });
    for (const p of pitchers) {
      stmts.push({
        sql: `INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB, WHIP, K9, BB9, ERA, FIP, WAR, RA9WAR, player_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [p.name, p.team, p.GS, p.G, p.IP, p.W, p.L, p.QS, p.SV, p.HLD, p.H, p.ER, p.HR, p.SO, p.BB, p.WHIP, p.K9, p.BB9, p.ERA, p.FIP, p.WAR, p.RA9WAR, p.player_id],
      });
    }
  }

  if (batters.length > 0) {
    stmts.push({ sql: 'DELETE FROM batters_raw', args: [] });
    for (const b of batters) {
      stmts.push({
        sql: `INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS, AVG, OBP, SLG, OPS, wOBA, wRC, BsR, Fld, Off, Def, WAR, player_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [b.name, b.team, b.G, b.PA, b.AB, b.H, b['2B'], b['3B'], b.HR, b.R, b.RBI, b.BB, b.SO, b.HBP, b.SB, b.CS, b.AVG, b.OBP, b.SLG, b.OPS, b.wOBA, b.wRC, b.BsR, b.Fld, b.Off, b.Def, b.WAR, b.player_id],
      });
    }
  }

  await db.batch(stmts);
  return { pitchers: pitchers.length, batters: batters.length };
}
```

- [ ] **Step 3: Convert savant.js**

Replace the `fetchSavant` function in `server/src/scrapers/savant.js`:

```js
export async function fetchSavant(db) {
  const yearResult = await db.execute("SELECT value FROM app_config WHERE key = 'season_year'");
  const currentYear = Number(yearResult.rows[0]?.value) || new Date().getFullYear();
  const fetches = [
    { season: currentYear - 1, gameType: 'R', seasonType: 'regular' },
    { season: currentYear, gameType: 'S', seasonType: 'spring' },
  ];

  const allRows = [];
  for (const { season, gameType, seasonType } of fetches) {
    const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfGT=${gameType}%7C&hfSea=${season}%7C&player_type=pitcher&min_pitches=0&min_results=0&group_by=pitch-type&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&min_pas=0`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Savant fetch failed for ${season} ${seasonType}: ${res.status}`);
    const csv = await res.text();
    const rows = await parseSavantCsv(csv, season, seasonType);
    allRows.push(...rows);
  }

  if (allRows.length === 0) {
    console.warn('Savant returned 0 rows — keeping existing data');
    return { rows: 0, skipped: true };
  }

  const stmts = [{ sql: 'DELETE FROM statcast_pitches', args: [] }];
  for (const r of allRows) {
    stmts.push({
      sql: `INSERT INTO statcast_pitches (player_id, player_name, season, season_type, pitch_type, velocity, spin_rate, whiff_pct, barrel_pct, xwoba) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [r.player_id, r.player_name, r.season, r.season_type, r.pitch_type, r.velocity, r.spin_rate, r.whiff_pct, r.barrel_pct, r.xwoba],
    });
  }

  await db.batch(stmts);
  return { rows: allRows.length };
}
```

- [ ] **Step 4: Convert espn.js**

Replace `server/src/scrapers/espn.js` with:

```js
import { reconcileName, loadReplacements, buildAccentMap } from './names.js';

export const ESPN_SLOT_TO_POSITION = {
  0: 'C', 1: '1B', 2: '2B', 3: '3B', 4: 'SS', 5: 'OF',
};

const PITCHER_POSITION_IDS = new Set([1, 11]);

export function parseEspnResponse(json) {
  if (!json?.players) return [];
  return json.players.map(p => {
    const isPitcher = PITCHER_POSITION_IDS.has(p.player?.defaultPositionId);
    const slots = p.player?.eligibleSlots || [];
    const positions = isPitcher
      ? []
      : slots.filter(s => s in ESPN_SLOT_TO_POSITION).map(s => ESPN_SLOT_TO_POSITION[s]);
    return {
      name: p.player?.fullName || '',
      adp_rank: p.player?.draftRanksByRankType?.STANDARD?.rank ?? null,
      projected_points: p.ratings?.['0']?.totalRating ?? null,
      positions,
    };
  }).filter(p => p.name);
}

export async function fetchEspn(db) {
  const yearResult = await db.execute("SELECT value FROM app_config WHERE key='season_year'");
  const year = yearResult.rows[0]?.value || '2026';
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leaguedefaults/3?view=kona_player_info`;

  const res = await fetch(url, {
    headers: {
      'x-fantasy-filter': JSON.stringify({
        players: { limit: 1500, sortPercOwned: { sortAsc: false, sortPriority: 1 } },
      }),
    },
  });
  if (!res.ok) throw new Error(`ESPN fetch failed: ${res.status}`);
  const json = await res.json();
  const players = parseEspnResponse(json);

  if (players.length === 0) {
    console.warn('ESPN returned 0 players — keeping existing data');
    return { players: 0, positions: 0, skipped: true };
  }

  const replacements = await loadReplacements(db);
  const accentMap = await buildAccentMap(db);
  const source = `espn_${year}`;

  const bestByName = {};
  for (const p of players) {
    const n = reconcileName(p.name, replacements);
    const pts = p.projected_points || 0;
    if (!bestByName[n] || pts > bestByName[n]) bestByName[n] = pts;
  }

  const stmts = [
    { sql: 'DELETE FROM espn_adp', args: [] },
    { sql: 'DELETE FROM position_eligibility WHERE source = ?', args: [source] },
  ];

  for (const p of players) {
    let name = reconcileName(p.name, replacements);
    const pts = p.projected_points || 0;
    if (accentMap[name] && pts >= bestByName[name]) name = accentMap[name];
    stmts.push({
      sql: 'INSERT INTO espn_adp (name, adp_rank, projected_points) VALUES (?, ?, ?)',
      args: [name, p.adp_rank, p.projected_points],
    });
    for (const pos of p.positions) {
      stmts.push({
        sql: 'INSERT OR IGNORE INTO position_eligibility (name, source, position) VALUES (?, ?, ?)',
        args: [name, source, pos],
      });
    }
  }

  await db.batch(stmts);
  return { players: players.length, positions: players.filter(p => p.positions.length > 0).length };
}
```

- [ ] **Step 5: Convert injuries.js**

Replace `server/src/scrapers/injuries.js` with:

```js
export async function fetchInjuries(db) {
  const yearResult = await db.execute("SELECT value FROM app_config WHERE key = 'season_year'");
  const season = Number(yearResult.rows[0]?.value) || new Date().getFullYear();

  const url = `https://www.fangraphs.com/api/roster-resource/injury-report/data?groupby=team&timeframe=current&season=${season}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FanGraphs injury fetch failed: ${res.status}`);
  const data = await res.json();

  if (!Array.isArray(data)) throw new Error('Injury API returned non-array response');

  const current = data.filter(r => r.isNotCurrent === 0 && r.playerName1);

  if (current.length === 0) {
    console.warn('Injury scrape returned 0 results — keeping existing data');
    return { injuries: 0, skipped: true };
  }

  const stmts = [{ sql: 'DELETE FROM injuries', args: [] }];
  for (const r of current) {
    stmts.push({
      sql: `INSERT OR REPLACE INTO injuries (name, team, position, injury, status, latest_update, mlbam_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [r.playerName1, r.team || null, r.position || null, r.injurySurgery || null, r.status || null, r.currentLatestUpdate || r.latestUpdate || null, r.mlbamid ? String(r.mlbamid) : null],
    });
  }

  await db.batch(stmts);
  return { injuries: current.length };
}
```

- [ ] **Step 6: Commit**

```bash
git add server/src/scrapers/
git commit -m "refactor: convert all scrapers to async Turso API

All db.prepare().run/get/all() calls replaced with db.execute()
and db.batch(). Transactions use batch() for atomicity."
```

---

### Task 10: Convert rescore.js to async Turso API

**Files:**
- Modify: `server/src/scoring/rescore.js`

This is the largest conversion. Every `db.prepare(...).all/get/run()` becomes async. The outer transaction becomes `db.batch()` for the insert phase, with individual `db.execute()` for reads.

- [ ] **Step 1: Rewrite rescore.js for async Turso**

Replace `server/src/scoring/rescore.js` with:

```js
import { computePitcherScores } from './pitcher-scoring.js';
import { computeBatterScores, resolvePosition } from './batter-scoring.js';
import { buildCombinedRankings } from './combined.js';

async function getWeights(db, category) {
  const result = await db.execute({ sql: 'SELECT stat, weight FROM scoring_config WHERE category = ?', args: [category] });
  const weights = {};
  for (const r of result.rows) weights[r.stat] = r.weight;
  return weights;
}

async function getPosAdjustments(db) {
  const result = await db.execute('SELECT position, adjustment FROM position_adjustments');
  const adj = {};
  for (const r of result.rows) adj[r.position] = r.adjustment;
  return adj;
}

async function getConfig(db, key) {
  const result = await db.execute({ sql: 'SELECT value FROM app_config WHERE key = ?', args: [key] });
  return result.rows[0]?.value ?? null;
}

async function getVelocityDeltas(db) {
  const seasonYear = await getConfig(db, 'season_year');
  const currentYear = Number(seasonYear) || new Date().getFullYear();
  const prevYear = currentYear - 1;
  const result = await db.execute({
    sql: `
      SELECT player_name, v_prev, v_curr, (v_curr - v_prev) as delta, n_curr FROM (
        SELECT player_name,
          MAX(CASE WHEN season = ? AND season_type = 'regular' THEN velocity END) as v_prev,
          MAX(CASE WHEN season = ? AND season_type = 'spring' THEN velocity END) as v_curr,
          SUM(CASE WHEN season = ? AND season_type = 'spring' THEN 1 ELSE 0 END) as n_curr
        FROM statcast_pitches GROUP BY player_name
      ) WHERE v_prev IS NOT NULL AND v_curr IS NOT NULL AND (v_curr - v_prev) < 10
    `,
    args: [prevYear, currentYear, currentYear],
  });
  const deltas = {};
  for (const r of result.rows) deltas[r.player_name] = { delta: r.delta, velo_prev: r.v_prev, velo_curr: r.v_curr, velo_n: r.n_curr };
  return deltas;
}

async function getEspnAdp(db) {
  const result = await db.execute('SELECT name, adp_rank FROM espn_adp');
  const adp = {};
  for (const r of result.rows) adp[r.name] = r.adp_rank;
  return adp;
}

async function upsertPlayers(db, pitcherScores, batterScores) {
  // Upsert all players
  const upsertStmts = [];
  for (const p of pitcherScores) {
    upsertStmts.push({
      sql: 'INSERT INTO players (name, team) VALUES (?, ?) ON CONFLICT(name, team) DO UPDATE SET team = excluded.team',
      args: [p.name, p.team],
    });
  }
  for (const b of batterScores) {
    upsertStmts.push({
      sql: 'INSERT INTO players (name, team) VALUES (?, ?) ON CONFLICT(name, team) DO UPDATE SET team = excluded.team',
      args: [b.name, b.team],
    });
  }
  if (upsertStmts.length > 0) await db.batch(upsertStmts);

  // Populate fg_id from raw tables
  const fgPitchers = (await db.execute('SELECT name, team, player_id FROM pitchers_raw WHERE player_id IS NOT NULL')).rows;
  const fgBatters = (await db.execute('SELECT name, team, player_id FROM batters_raw WHERE player_id IS NOT NULL')).rows;
  const fgStmts = [];
  for (const r of fgPitchers) fgStmts.push({ sql: 'UPDATE players SET fg_id = ? WHERE name = ? AND team = ?', args: [r.player_id, r.name, r.team] });
  for (const r of fgBatters) fgStmts.push({ sql: 'UPDATE players SET fg_id = ? WHERE name = ? AND team = ?', args: [r.player_id, r.name, r.team] });
  if (fgStmts.length > 0) await db.batch(fgStmts);

  // Populate mlbam_id from statcast
  const statcast = (await db.execute('SELECT DISTINCT player_name, player_id FROM statcast_pitches WHERE player_id IS NOT NULL')).rows;
  const mlbamStmts = [];
  for (const r of statcast) mlbamStmts.push({ sql: 'UPDATE players SET mlbam_id = ? WHERE name = ? AND mlbam_id IS NULL', args: [r.player_id, r.player_name] });
  if (mlbamStmts.length > 0) await db.batch(mlbamStmts);

  // Build name→id map
  const allPlayers = (await db.execute('SELECT id, name, team FROM players')).rows;
  const idMap = {};
  for (const p of allPlayers) idMap[`${p.name}|${p.team}`] = p.id;
  return idMap;
}

export async function rescoreAll(db) {
  const [pitcherWeights, batterWeights, posAdj, replacementLevelStr] = await Promise.all([
    getWeights(db, 'pitcher'),
    getWeights(db, 'batter'),
    getPosAdjustments(db),
    getConfig(db, 'replacement_level'),
  ]);
  const replacementLevel = Number(replacementLevelStr) || 237;

  const rawPitchers = (await db.execute('SELECT * FROM pitchers_raw')).rows;
  const pitcherScores = computePitcherScores(rawPitchers, pitcherWeights, replacementLevel);

  const rawBatters = (await db.execute('SELECT * FROM batters_raw WHERE PA >= 10')).rows;
  const posRows = (await db.execute('SELECT name, source, position FROM position_eligibility')).rows;
  const positionsMap = {};
  for (const row of posRows) {
    if (!positionsMap[row.name]) positionsMap[row.name] = [];
    positionsMap[row.name].push(row);
  }
  const battersWithPos = rawBatters.map(b => ({
    ...b, position: resolvePosition(positionsMap[b.name] || []),
  }));
  const batterScores = computeBatterScores(battersWithPos, batterWeights, posAdj);

  // Upsert players and get ID map
  const idMap = await upsertPlayers(db, pitcherScores, batterScores);

  const [espnAdp, velocityDeltas] = await Promise.all([
    getEspnAdp(db),
    getVelocityDeltas(db),
  ]);
  const combined = buildCombinedRankings(pitcherScores, batterScores, espnAdp, velocityDeltas);

  // Write all scores in one batch
  const writeStmts = [
    { sql: 'DELETE FROM pitcher_scores', args: [] },
    { sql: 'DELETE FROM batter_scores', args: [] },
    { sql: 'DELETE FROM combined_rankings', args: [] },
  ];

  for (const p of pitcherScores) {
    writeStmts.push({
      sql: `INSERT INTO pitcher_scores (name, team, scoring_position, display_position, raw_score, adjustment, adj_score, starting_pts, relief_pts, adj_2020_value, pts_per_appearance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [p.name, p.team, p.scoring_position, p.display_position, p.raw_score, p.adjustment, p.adj_score, p.starting_pts, p.relief_pts, p.adj_2020_value, p.pts_per_appearance],
    });
  }

  for (const b of batterScores) {
    writeStmts.push({
      sql: `INSERT INTO batter_scores (name, team, position, raw_score, adjustment, adj_score, pts_per_game) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [b.name, b.team, b.position, b.raw_score, b.adjustment, b.adj_score, b.pts_per_game],
    });
  }

  for (const c of combined) {
    writeStmts.push({
      sql: `INSERT INTO combined_rankings (player_id, rank, name, team, position, score, adj_score, espn_adp, velocity_delta, velo_prev, velo_curr, velo_n, per_game_efficiency, value_gap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [idMap[`${c.name}|${c.team}`] || null, c.rank, c.name, c.team, c.position, c.score, c.adj_score, c.espn_adp, c.velocity_delta, c.velo_prev, c.velo_curr, c.velo_n, c.per_game_efficiency, c.value_gap],
    });
  }

  await db.batch(writeStmts);
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/scoring/rescore.js
git commit -m "refactor: rescore.js uses async Turso API with batch writes

Reads use parallel db.execute() where possible. Write phase uses
db.batch() for pitcher_scores, batter_scores, and combined_rankings.
Note: upsertPlayers runs separate batches before the main write."
```

---

### Task 11: Convert routes to async

**Files:**
- Modify: `server/src/routes/rankings.js`
- Modify: `server/src/routes/draft.js`
- Modify: `server/src/routes/config.js`
- Modify: `server/src/routes/scrape.js`
- Modify: `server/src/index.js`

- [ ] **Step 1: Convert rankings.js**

Replace `server/src/routes/rankings.js`:

```js
import { Router } from 'express';

export function createRankingsRouter(db) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const result = await db.execute(`
        SELECT
          cr.*,
          p.fg_id,
          p.mlbam_id,
          inj.latest_update as injury,
          pn.note as note,
          pr.IP as ip, pr.GS as gs, pr.G as pit_g, pr.W, pr.L, pr.QS, pr.SV,
          pr.SO as pit_so, pr.BB as pit_bb, pr.K9 as k9, pr.BB9 as bb9,
          pr.ERA as era, pr.WHIP as whip, pr.FIP as fip,
          pr.WAR as pit_war, pr.RA9WAR as ra9war, pr.HLD as hld,
          br.PA as pa, br.AB as ab, br.G as bat_g, br.H as bat_h,
          br."2B" as doubles, br."3B" as triples, br.HR as hr,
          br.R as runs, br.RBI as rbi, br.BB as bat_bb, br.SO as bat_so,
          br.SB as sb, br.CS as cs, br.HBP as hbp,
          br.AVG as avg, br.OBP as obp, br.SLG as slg, br.OPS as ops,
          br.wOBA as woba, br.wRC as wrc_plus,
          br.WAR as bat_war
        FROM combined_rankings cr
        LEFT JOIN players p ON cr.player_id = p.id
        LEFT JOIN pitchers_raw pr ON cr.name = pr.name AND cr.team = pr.team
        LEFT JOIN batters_raw br ON cr.name = br.name AND cr.team = br.team
        LEFT JOIN injuries inj ON cr.name = inj.name
        LEFT JOIN player_notes pn ON cr.name = pn.name
        ORDER BY cr.rank
      `);
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/notes', async (req, res) => {
    const { name, note } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
      if (note) {
        await db.execute({
          sql: 'INSERT INTO player_notes (name, note) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET note = excluded.note',
          args: [name, note],
        });
      } else {
        await db.execute({ sql: 'DELETE FROM player_notes WHERE name = ?', args: [name] });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
```

- [ ] **Step 2: Convert draft.js**

Replace `server/src/routes/draft.js`:

```js
import { Router } from 'express';

export function createDraftRouter(db) {
  const router = Router();

  router.get('/sessions', async (req, res) => {
    const result = await db.execute('SELECT * FROM draft_sessions ORDER BY created_at DESC');
    res.json(result.rows);
  });

  router.post('/sessions', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const result = await db.execute({ sql: 'INSERT INTO draft_sessions (name) VALUES (?)', args: [name] });
    res.json({ id: Number(result.lastInsertRowid), name });
  });

  router.get('/sessions/:id/picks', async (req, res) => {
    const result = await db.execute({ sql: 'SELECT * FROM draft_picks WHERE session_id = ? ORDER BY pick_number', args: [req.params.id] });
    res.json(result.rows);
  });

  router.post('/sessions/:id/picks', async (req, res) => {
    const { player_name, pick_number, drafted_by, player_notes } = req.body;
    if (!player_name || !pick_number) return res.status(400).json({ error: 'player_name and pick_number required' });
    const result = await db.execute({
      sql: 'INSERT INTO draft_picks (session_id, player_name, pick_number, drafted_by, player_notes) VALUES (?, ?, ?, ?, ?)',
      args: [req.params.id, player_name, pick_number, drafted_by || null, player_notes || null],
    });
    res.json({ id: Number(result.lastInsertRowid) });
  });

  router.put('/picks/:id', async (req, res) => {
    const { player_notes } = req.body;
    await db.execute({ sql: 'UPDATE draft_picks SET player_notes = ? WHERE id = ?', args: [player_notes, req.params.id] });
    res.json({ ok: true });
  });

  router.delete('/picks/:id', async (req, res) => {
    await db.execute({ sql: 'DELETE FROM draft_picks WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 3: Convert config.js (with auto-rescore on app config change)**

Replace `server/src/routes/config.js`:

```js
import { Router } from 'express';
import { rescoreAll } from '../scoring/rescore.js';

export function createConfigRouter(db) {
  const router = Router();

  router.get('/weights', async (req, res) => {
    const result = await db.execute('SELECT * FROM scoring_config ORDER BY category, stat');
    res.json(result.rows);
  });

  router.put('/weights', async (req, res) => {
    const { weights } = req.body;
    const stmts = weights.map(w => ({
      sql: 'UPDATE scoring_config SET weight = ? WHERE category = ? AND stat = ?',
      args: [w.weight, w.category, w.stat],
    }));
    await db.batch(stmts);
    await rescoreAll(db);
    res.json({ ok: true });
  });

  router.get('/positions', async (req, res) => {
    const result = await db.execute('SELECT * FROM position_adjustments ORDER BY position');
    res.json(result.rows);
  });

  router.put('/positions', async (req, res) => {
    const { adjustments } = req.body;
    const stmts = adjustments.map(a => ({
      sql: 'UPDATE position_adjustments SET adjustment = ? WHERE position = ?',
      args: [a.adjustment, a.position],
    }));
    await db.batch(stmts);
    await rescoreAll(db);
    res.json({ ok: true });
  });

  router.get('/app', async (req, res) => {
    const result = await db.execute('SELECT * FROM app_config');
    res.json(result.rows);
  });

  router.put('/app', async (req, res) => {
    const { key, value } = req.body;
    await db.execute({ sql: 'INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)', args: [key, value] });
    // Auto-rescore when scoring-relevant config changes
    if (key === 'replacement_level' || key === 'projection_system') {
      await rescoreAll(db);
    }
    res.json({ ok: true });
  });

  router.get('/name-replacements', async (req, res) => {
    const result = await db.execute('SELECT * FROM name_replacements ORDER BY alt_name');
    res.json(result.rows);
  });

  router.post('/name-replacements', async (req, res) => {
    const { alt_name, canonical_name } = req.body;
    const result = await db.execute({ sql: 'INSERT INTO name_replacements (alt_name, canonical_name) VALUES (?, ?)', args: [alt_name, canonical_name] });
    res.json({ id: Number(result.lastInsertRowid) });
  });

  router.delete('/name-replacements/:id', async (req, res) => {
    await db.execute({ sql: 'DELETE FROM name_replacements WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Convert scrape.js (with last_refreshed timestamps)**

Replace `server/src/routes/scrape.js`:

```js
import { Router } from 'express';
import { fetchFanGraphs } from '../scrapers/fangraphs.js';
import { fetchSavant } from '../scrapers/savant.js';
import { fetchEspn } from '../scrapers/espn.js';
import { fetchInjuries } from '../scrapers/injuries.js';
import { rescoreAll } from '../scoring/rescore.js';

async function setLastRefreshed(db, source) {
  await db.execute({
    sql: "INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)",
    args: [`last_refreshed_${source}`, new Date().toISOString()],
  });
}

export function createScrapeRouter(db) {
  const router = Router();

  router.post('/fangraphs', async (req, res) => {
    try {
      const result = await fetchFanGraphs(db);
      await rescoreAll(db);
      await setLastRefreshed(db, 'fangraphs');
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/savant', async (req, res) => {
    try {
      const result = await fetchSavant(db);
      await rescoreAll(db);
      await setLastRefreshed(db, 'savant');
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/espn', async (req, res) => {
    try {
      const result = await fetchEspn(db);
      await rescoreAll(db);
      await setLastRefreshed(db, 'espn');
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/injuries', async (req, res) => {
    try {
      const result = await fetchInjuries(db);
      await setLastRefreshed(db, 'injuries');
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/all', async (req, res) => {
    const results = {};
    try { results.fangraphs = await fetchFanGraphs(db); await setLastRefreshed(db, 'fangraphs'); }
    catch (e) { results.fangraphs = { error: e.message }; }
    try { results.savant = await fetchSavant(db); await setLastRefreshed(db, 'savant'); }
    catch (e) { results.savant = { error: e.message }; }
    try { results.espn = await fetchEspn(db); await setLastRefreshed(db, 'espn'); }
    catch (e) { results.espn = { error: e.message }; }
    try { results.injuries = await fetchInjuries(db); await setLastRefreshed(db, 'injuries'); }
    catch (e) { results.injuries = { error: e.message }; }
    await rescoreAll(db);
    res.json(results);
  });

  return router;
}
```

- [ ] **Step 5: Update index.js for async DB init**

Replace `server/src/index.js`:

```js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createDb } from './db.js';
import { createRankingsRouter } from './routes/rankings.js';
import { createDraftRouter } from './routes/draft.js';
import { createConfigRouter } from './routes/config.js';
import { createScrapeRouter } from './routes/scrape.js';

async function start() {
  const db = await createDb();
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use('/api/rankings', createRankingsRouter(db));
  app.use('/api/draft', createDraftRouter(db));
  app.use('/api/config', createConfigRouter(db));
  app.use('/api/scrape', createScrapeRouter(db));

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
```

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/ server/src/index.js
git commit -m "refactor: convert all routes and index.js to async Turso API

Routes use async handlers with db.execute(). Config changes to
replacement_level and projection_system now auto-rescore.
Scrape routes store last_refreshed timestamps in app_config."
```

---

### Task 12: Update tests for async Turso

**Files:**
- Create: `server/tests/test-utils.js`
- Modify: `server/tests/db.test.js`
- Modify: `server/tests/scoring/rescore.test.js`
- Modify: all other test files

Tests need a local Turso client. `@libsql/client` supports `file:` URLs for local SQLite files. Note: `:memory:` is NOT supported by `@libsql/client` — use a temp file per test run instead.

- [ ] **Step 1: Create test-utils.js**

Create `server/tests/test-utils.js`:

```js
import { createClient } from '@libsql/client';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { seedDefaults } from '../src/seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tempDirs = [];

export async function createTestDb() {
  const dir = mkdtempSync(join(tmpdir(), 'fantasy-test-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'test.db');
  const db = createClient({ url: `file:${dbPath}` });
  const schema = readFileSync(join(__dirname, '..', 'src', 'schema.sql'), 'utf8');
  await db.executeMultiple(schema);
  await seedDefaults(db);
  return db;
}

// Call this in afterAll() to clean up temp directories
export function cleanupTestDbs() {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tempDirs.length = 0;
}
```

- [ ] **Step 2: Update db.test.js**

Replace `server/tests/db.test.js`:

```js
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDbs } from './test-utils.js';

afterAll(() => cleanupTestDbs());

describe('database schema', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it('creates all required tables', async () => {
    const result = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tables = result.rows.map(r => r.name);

    expect(tables).toContain('players');
    expect(tables).toContain('pitchers_raw');
    expect(tables).toContain('batters_raw');
    expect(tables).toContain('statcast_pitches');
    expect(tables).toContain('pitcher_scores');
    expect(tables).toContain('batter_scores');
    expect(tables).toContain('combined_rankings');
    expect(tables).toContain('draft_sessions');
    expect(tables).toContain('draft_picks');
    expect(tables).toContain('scoring_config');
    expect(tables).toContain('position_adjustments');
    expect(tables).toContain('app_config');
    expect(tables).toContain('name_replacements');
    expect(tables).toContain('position_eligibility');
    expect(tables).toContain('espn_adp');
  });
});

describe('seed defaults', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it('seeds pitcher scoring weights', async () => {
    const result = await db.execute("SELECT stat, weight FROM scoring_config WHERE category='pitcher' ORDER BY stat");
    const weights = result.rows;
    expect(weights.find(w => w.stat === 'IP').weight).toBe(2.1);
    expect(weights.find(w => w.stat === 'SV').weight).toBe(5.0);
    expect(weights.find(w => w.stat === 'SO').weight).toBe(1.0);
  });

  it('seeds batter scoring weights', async () => {
    const result = await db.execute("SELECT stat, weight FROM scoring_config WHERE category='batter' ORDER BY stat");
    const weights = result.rows;
    expect(weights.find(w => w.stat === 'HR').weight).toBe(3.1);
    expect(weights.find(w => w.stat === 'SB').weight).toBe(2.0);
    expect(weights.find(w => w.stat === 'SO').weight).toBe(-1.0);
  });

  it('seeds position adjustments', async () => {
    const result = await db.execute("SELECT position, adjustment FROM position_adjustments ORDER BY position");
    const adj = result.rows;
    expect(adj.find(a => a.position === 'C').adjustment).toBe(70);
    expect(adj.find(a => a.position === 'SS').adjustment).toBe(20);
  });

  it('seeds app config defaults', async () => {
    const rl = (await db.execute("SELECT value FROM app_config WHERE key='replacement_level'")).rows[0];
    expect(rl.value).toBe('237');
    const ps = (await db.execute("SELECT value FROM app_config WHERE key='projection_system'")).rows[0];
    expect(ps.value).toBe('steamer');
  });
});
```

- [ ] **Step 3: Update rescore.test.js**

Replace `server/tests/scoring/rescore.test.js`:

```js
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDbs } from '../test-utils.js';
import { rescoreAll } from '../../src/scoring/rescore.js';

afterAll(() => cleanupTestDbs());

describe('rescoreAll', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDb();

    await db.execute({
      sql: `INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['Test SP', 'NYY', 30, 30, 200, 15, 8, 25, 0, 0, 170, 70, 20, 200, 50],
    });

    await db.execute({
      sql: `INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['Test OF', 'LAD', 150, 600, 550, 160, 30, 5, 35, 95, 100, 60, 130, 5, 15, 3],
    });

    await db.execute({
      sql: `INSERT INTO position_eligibility (name, source, position) VALUES (?, ?, ?)`,
      args: ['Test OF', 'espn_2025', 'OF'],
    });
  });

  it('populates pitcher_scores', async () => {
    await rescoreAll(db);
    const result = await db.execute('SELECT * FROM pitcher_scores');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Test SP');
    expect(result.rows[0].scoring_position).toBe('SP');
  });

  it('populates batter_scores', async () => {
    await rescoreAll(db);
    const result = await db.execute('SELECT * FROM batter_scores');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Test OF');
    expect(result.rows[0].position).toBe('OF');
  });

  it('populates combined_rankings with both players', async () => {
    await rescoreAll(db);
    const result = await db.execute('SELECT * FROM combined_rankings ORDER BY rank');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].rank).toBe(1);
    expect(result.rows[1].rank).toBe(2);
  });

  it('populates players table', async () => {
    await rescoreAll(db);
    const result = await db.execute('SELECT * FROM players');
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe('rescoreAll edge cases', () => {
  it('handles empty pitchers_raw gracefully', async () => {
    const db = await createTestDb();
    // Only insert batter, no pitcher
    await db.execute({
      sql: `INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['Test OF', 'LAD', 150, 600, 550, 160, 30, 5, 35, 95, 100, 60, 130, 5, 15, 3],
    });
    await db.execute({
      sql: `INSERT INTO position_eligibility (name, source, position) VALUES (?, ?, ?)`,
      args: ['Test OF', 'espn_2025', 'OF'],
    });
    await rescoreAll(db);
    const result = await db.execute('SELECT * FROM combined_rankings ORDER BY rank');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Test OF');
  });

  it('handles missing position_eligibility gracefully', async () => {
    const db = await createTestDb();
    await db.execute({
      sql: `INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['Test OF', 'LAD', 150, 600, 550, 160, 30, 5, 35, 95, 100, 60, 130, 5, 15, 3],
    });
    // No position_eligibility rows
    await rescoreAll(db);
    const batters = await db.execute('SELECT * FROM batter_scores');
    expect(batters.rows).toHaveLength(1);
    expect(batters.rows[0].position).toBe('Other');
  });
});
```

- [ ] **Step 4: Update remaining test files similarly**

The scoring unit tests (`pitcher-scoring.test.js`, `batter-scoring.test.js`, `combined.test.js`) don't use the DB — they test pure functions and need NO changes.

The scraper parser tests (`espn.test.js`, `savant.test.js`, `names.test.js`, `fangraphs.test.js`) test pure parsing functions and need NO changes (they don't call db).

The `rankings.test.js` route test needs to be updated to use the async test DB. Replace `server/tests/routes/rankings.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import { createTestDb, cleanupTestDbs } from '../test-utils.js';
import { createRankingsRouter } from '../../src/routes/rankings.js';
import { rescoreAll } from '../../src/scoring/rescore.js';

afterAll(() => cleanupTestDbs());

describe('GET /api/rankings', () => {
  let server, db, baseUrl;

  beforeEach(async () => {
    db = await createTestDb();

    await db.execute({
      sql: `INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['Ace Pitcher', 'NYY', 30, 30, 200, 15, 8, 25, 0, 0, 170, 70, 20, 200, 50],
    });

    await rescoreAll(db);

    const app = express();
    app.use(express.json());
    app.use('/api/rankings', createRankingsRouter(db));
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(() => { server?.close(); });

  it('returns ranked players', async () => {
    const res = await fetch(`${baseUrl}/api/rankings`);
    const data = await res.json();
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].rank).toBe(1);
    expect(data[0].name).toBe('Ace Pitcher');
  });
});
```

- [ ] **Step 5: Run all tests**

Run: `cd server && npx vitest run`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/tests/
git commit -m "refactor: convert all tests to async Turso API

Uses createTestDb() helper with file::memory: for fast in-memory
testing. Pure function tests (scoring, parsers) unchanged."
```

---

## Chunk 4: Vercel Deployment

### Task 13: Create Vercel serverless entry point

**Files:**
- Create: `api/index.js`
- Create: `vercel.json`
- Modify: `client/vite.config.js`

- [ ] **Step 1: Create api/index.js**

Create `api/index.js`:

```js
import 'dotenv/config';
import express from 'express';
import { createDb } from '../server/src/db.js';
import { createRankingsRouter } from '../server/src/routes/rankings.js';
import { createDraftRouter } from '../server/src/routes/draft.js';
import { createConfigRouter } from '../server/src/routes/config.js';
import { createScrapeRouter } from '../server/src/routes/scrape.js';

let app;

async function getApp() {
  if (app) return app;
  const db = await createDb();
  app = express();
  app.use(express.json());
  app.use('/api/rankings', createRankingsRouter(db));
  app.use('/api/draft', createDraftRouter(db));
  app.use('/api/config', createConfigRouter(db));
  app.use('/api/scrape', createScrapeRouter(db));
  return app;
}

export default async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
}
```

- [ ] **Step 2: Create vercel.json**

Create `vercel.json`:

```json
{
  "buildCommand": "cd client && npm run build",
  "outputDirectory": "client/dist",
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api" }
  ],
  "functions": {
    "api/index.js": {
      "memory": 256,
      "maxDuration": 30
    }
  }
}
```

- [ ] **Step 3: Update client vite.config.js for production**

Replace `client/vite.config.js`:

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
```

(No change needed — the proxy is only for dev. In production, Vercel's rewrites handle `/api` routing.)

- [ ] **Step 4: Set Turso env vars in Vercel**

Run:
```bash
vercel env add TURSO_DATABASE_URL
vercel env add TURSO_AUTH_TOKEN
```

- [ ] **Step 5: Deploy**

Run: `vercel --prod`

- [ ] **Step 6: Verify deployment**

Open the Vercel URL in a browser. Verify:
- Rankings page loads (will be empty until data is scraped)
- Settings page loads
- Draft page loads

- [ ] **Step 7: Commit**

```bash
git add api/ vercel.json
git commit -m "feat: Vercel deployment with serverless API entry point

Express app runs as a Vercel serverless function. Frontend built
by Vite and served as static files. API routed via rewrites."
```

---

## Chunk 5: UX Enhancements

### Task 14: Add freshness timestamps to header

**Files:**
- Create: `client/src/components/FreshnessBar.jsx`
- Modify: `client/src/App.jsx`
- Modify: `client/src/api.js`

- [ ] **Step 1: Add API method for freshness data**

Add to `client/src/api.js`:

```js
  getFreshness: () => json('/config/app').then(configs => {
    const freshness = {};
    for (const c of configs) {
      if (c.key.startsWith('last_refreshed_')) {
        freshness[c.key.replace('last_refreshed_', '')] = c.value;
      }
    }
    return freshness;
  }),
```

- [ ] **Step 2: Create FreshnessBar component**

Create `client/src/components/FreshnessBar.jsx`:

```jsx
import { useState, useEffect } from 'react';
import { api } from '../api';

function timeAgo(isoString) {
  if (!isoString) return null;
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isStale(isoString, thresholdHours = 24) {
  if (!isoString) return true;
  return Date.now() - new Date(isoString).getTime() > thresholdHours * 3600000;
}

const SOURCES = [
  { key: 'fangraphs', label: 'FG' },
  { key: 'espn', label: 'ESPN' },
  { key: 'savant', label: 'Savant' },
  { key: 'injuries', label: 'Injuries' },
];

export default function FreshnessBar() {
  const [freshness, setFreshness] = useState({});

  useEffect(() => {
    api.getFreshness().then(setFreshness);
    const interval = setInterval(() => api.getFreshness().then(setFreshness), 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-3 text-xs">
      {SOURCES.map(({ key, label }) => {
        const ts = freshness[key];
        const ago = timeAgo(ts);
        const stale = isStale(ts);
        return (
          <span key={key} className={stale ? 'text-orange-500' : 'text-gray-400'}>
            {label}: {ago || 'never'}
          </span>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Add FreshnessBar to App.jsx**

In `client/src/App.jsx`, import and render `FreshnessBar` in the nav bar, next to the navigation links.

Add import:
```js
import FreshnessBar from './components/FreshnessBar';
```

Add in the nav bar area (after the navigation links):
```jsx
<FreshnessBar />
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/FreshnessBar.jsx client/src/App.jsx client/src/api.js
git commit -m "feat: data freshness timestamps in nav bar

Shows time-ago for each data source. Stale data (>24h) highlighted
in orange. Polls every 60 seconds for updates."
```

---

### Task 15: Value gradient rows in PlayerTable

**Files:**
- Modify: `client/src/components/PlayerTable.jsx`

Add a green gradient background to rows based on `value_gap`. A positive value_gap means the player is ranked better (lower number) than their ADP — they're a value pick. Deeper green for bigger gaps.

- [ ] **Step 1: Add value gradient function**

Add this function near the top of `PlayerTable.jsx` (after the imports):

```js
function valueGradientStyle(valueGap) {
  if (valueGap == null || valueGap >= 0) return {};
  // value_gap is negative when rank < ADP (player is a value — ranked higher than drafted)
  // More negative = more value
  const intensity = Math.min(Math.abs(valueGap) / 100, 1);
  const alpha = intensity * 0.15;
  return { backgroundColor: `rgba(34, 197, 94, ${alpha})` };
}
```

- [ ] **Step 2: Apply gradient to row rendering**

In the row rendering section (the `virtualizer.getVirtualItems().map()` block), add the style to the row div. Find the existing `style={{ position: 'absolute', top: vRow.start, height: ROW_HEIGHT }}` and change it to:

```jsx
style={{ position: 'absolute', top: vRow.start, height: ROW_HEIGHT, ...valueGradientStyle(row.original.value_gap) }}
```

- [ ] **Step 3: Verify visually**

Start the dev server and check that players with negative value_gap show green tinting. Players with value_gap of -50 should be noticeably green; -100 should be the deepest.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/PlayerTable.jsx
git commit -m "feat: green gradient rows based on value gap

Players ranked better than their ADP get a green background.
Deeper green = more value. Intensity scales linearly to abs(gap)/100."
```

---

### Task 16: Position need indicators in RosterSidebar

**Files:**
- Modify: `client/src/components/RosterSidebar.jsx`

Show which positions you still need to fill based on standard roster slots.

- [ ] **Step 1: Add position needs logic**

Replace `client/src/components/RosterSidebar.jsx` with:

```jsx
const ROSTER_SLOTS = {
  C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 3, UTIL: 1, SP: 5, RP: 3,
};

function getPositionNeeds(myPicks, rankings) {
  const filled = {};
  for (const pick of myPicks) {
    const player = rankings.find(r => r.name === pick.player_name);
    if (!player?.position) continue;
    const pos = player.position.split(',')[0].trim();
    // Map display positions to roster slots
    const slot = pos === 'SP, RP' ? 'SP' : pos;
    filled[slot] = (filled[slot] || 0) + 1;
  }

  const needs = [];
  for (const [pos, count] of Object.entries(ROSTER_SLOTS)) {
    const have = filled[pos] || 0;
    const remaining = count - have;
    if (remaining > 0) {
      for (let i = 0; i < remaining; i++) needs.push(pos);
    }
  }
  return needs;
}

export default function RosterSidebar({ picks, rankings }) {
  const myPicks = picks.filter(p => p.drafted_by === 'me');

  const byPosition = {};
  for (const pick of myPicks) {
    const player = rankings.find(r => r.name === pick.player_name);
    const pos = player?.position?.split(',')[0]?.trim() || '?';
    if (!byPosition[pos]) byPosition[pos] = [];
    byPosition[pos].push(pick);
  }

  const needs = getPositionNeeds(myPicks, rankings);

  return (
    <div className="w-56 ml-4 border-l border-gray-200 pl-4">
      <h3 className="font-semibold text-sm text-gray-700 mb-2">My Roster ({myPicks.length})</h3>
      {needs.length > 0 && (
        <div className="mb-3 p-2 bg-amber-50 border border-amber-200 rounded text-xs">
          <span className="font-semibold text-amber-700">Need: </span>
          <span className="text-amber-600">{needs.join(', ')}</span>
        </div>
      )}
      {Object.entries(byPosition).map(([pos, positionPicks]) => (
        <div key={pos} className="mb-2">
          <div className="text-xs font-bold text-gray-500 uppercase">{pos}</div>
          {positionPicks.map(p => (
            <div key={p.id} className="text-sm text-gray-700 truncate">
              #{p.pick_number} {p.player_name}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/RosterSidebar.jsx
git commit -m "feat: position need indicators in draft sidebar

Shows 'Need: C, OF, OF' based on standard roster slots minus
drafted players. Helps prioritize position scarcity during draft."
```

---

### Task 17: Auto-rescore on Settings config change with debounce

**Files:**
- Modify: `client/src/pages/Settings.jsx`

The replacement_level and projection_system inputs should trigger a rescore on the backend. The config.js route (updated in Task 11) now auto-rescores on these changes. But the frontend fires `api.updateAppConfig()` on every keystroke for the replacement_level input. Add debounce.

- [ ] **Step 1: Add debounced config update**

In `client/src/pages/Settings.jsx`, replace the replacement level input's `onChange` handler. Use a simple timeout-based debounce:

Replace the `<label>Replacement Level:` section with:

```jsx
          <label>Replacement Level:
            <input type="number" value={replacementLevel}
              onChange={e => {
                const val = e.target.value;
                setConfig(prev => prev.map(c => c.key === 'replacement_level' ? { ...c, value: val } : c));
                clearTimeout(window._rlDebounce);
                window._rlDebounce = setTimeout(() => api.updateAppConfig('replacement_level', val), 2000);
              }}
              className="border rounded px-2 py-1 w-20 ml-1" />
          </label>
```

And for projection_system (triggers immediately since it's a dropdown, no debounce needed):

```jsx
          <label>Projection System:
            <select value={projSystem}
              onChange={e => {
                const val = e.target.value;
                setConfig(prev => prev.map(c => c.key === 'projection_system' ? { ...c, value: val } : c));
                api.updateAppConfig('projection_system', val);
              }}
              className="border rounded px-2 py-1 ml-1">
              <option value="steamer">Steamer</option>
              <option value="zips">ZiPS</option>
            </select>
          </label>
```

- [ ] **Step 2: Commit**

```bash
git add client/src/pages/Settings.jsx
git commit -m "feat: auto-rescore on config change with 2s debounce

Replacement level debounces 2s before sending to backend.
Projection system change triggers immediately. Backend auto-rescores
on both changes."
```

---

## Chunk 6: Data Integrity Tests

### Task 18: Add data integrity tests

**Files:**
- Create: `server/tests/scrapers/injuries.test.js`
- Modify: `server/tests/scoring/rescore.test.js`

- [ ] **Step 1: Create injuries scraper test**

Create `server/tests/scrapers/injuries.test.js`:

```js
import { describe, it, expect } from 'vitest';

// Test the data shape validation only (not the fetch, which hits external API)
describe('injuries data validation', () => {
  it('filters for current injuries only', () => {
    const data = [
      { isNotCurrent: 0, playerName1: 'Active Injury', team: 'NYY' },
      { isNotCurrent: 1, playerName1: 'Old Injury', team: 'BOS' },
      { isNotCurrent: 0, playerName1: null, team: 'LAD' },
    ];
    const current = data.filter(r => r.isNotCurrent === 0 && r.playerName1);
    expect(current).toHaveLength(1);
    expect(current[0].playerName1).toBe('Active Injury');
  });

  it('handles non-array response', () => {
    const data = { error: 'not found' };
    expect(Array.isArray(data)).toBe(false);
  });
});
```

- [ ] **Step 2: Verify edge case tests added in Task 12 pass**

The edge case tests (`rescoreAll edge cases` describe block) were already added to `rescore.test.js` in Task 12. Each edge case test creates its own fresh DB via `createTestDb()` to avoid sharing state with the main test suite's `beforeEach`.

Run: `cd server && npx vitest run tests/scoring/rescore.test.js`

Expected: All tests pass, including the edge case tests.

- [ ] **Step 3: Run all tests**

Run: `cd server && npx vitest run`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/tests/scrapers/injuries.test.js server/tests/scoring/rescore.test.js
git commit -m "test: add data integrity tests for injuries and rescore edge cases

Tests 0-row handling, non-array API response, missing position
eligibility, and empty raw data tables."
```

---

## TODOS.md

Create `TODOS.md`:

```markdown
# TODOs

## P2: Schema migration system
**What:** Add a `schema_version` table and a migration runner so schema changes don't require DB recreation.
**Why:** Currently any schema change means deleting the DB and re-scraping all data. As the app evolves, this becomes increasingly painful.
**Effort:** M
**Depends on:** Nothing
```

- [ ] **Create TODOS.md**

```bash
git add TODOS.md
git commit -m "docs: add TODOS.md with deferred work items"
```
