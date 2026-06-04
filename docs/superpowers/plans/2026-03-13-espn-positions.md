# ESPN Positional Eligibility Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the ESPN scraper to fetch all players (not just 50) and extract ESPN positional eligibility data into a normalized junction table.

**Architecture:** Replace the flat `batter_positions` table (which stored comma-separated position strings across wide columns) with a normalized `position_eligibility` junction table. Update the ESPN scraper to send the `x-fantasy-filter` header for full player lists and map ESPN's `eligibleSlots` array to standard position strings. Adapt `resolvePosition` and `rescore.js` to query the new table with source-priority fallback.

**Tech Stack:** Node.js, better-sqlite3, Vitest, ESPN Fantasy API

**ESPN Slot ID Reference** (derived from live API testing):

| Slot ID | Position |
|---------|----------|
| 0       | C        |
| 1       | 1B       |
| 2       | 2B       |
| 3       | 3B       |
| 4       | SS       |
| 5       | OF       |

Slots 6+ are lineup-slot types (CI, MI, UTIL, Bench, IL, etc.) and are ignored for positional eligibility. Players with `defaultPositionId` of 1 (SP) or 11 (RP) are pitchers and are skipped for position eligibility.

---

## Chunk 1: Schema Migration and Position Resolution

### Task 1: Replace `batter_positions` with `position_eligibility` in schema

**Files:**
- Modify: `server/src/schema.sql:127-136`

- [ ] **Step 1: Update schema.sql**

Replace the `batter_positions` table definition with:

```sql
CREATE TABLE IF NOT EXISTS position_eligibility (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  position TEXT NOT NULL,
  UNIQUE(name, source, position)
);
```

- [ ] **Step 2: Verify schema loads**

Run:
```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
const db = new Database(':memory:');
db.exec(readFileSync('server/src/schema.sql','utf8'));
console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name).join(', '));
db.close();
"
```

Expected: Table list includes `position_eligibility`, does NOT include `batter_positions`.

- [ ] **Step 3: Commit**

```bash
git add server/src/schema.sql
git commit -m "refactor: replace batter_positions with normalized position_eligibility table"
```

---

### Task 2: Update `resolvePosition` to use the new table shape

**Files:**
- Modify: `server/src/scoring/batter-scoring.js:1-17`
- Modify: `server/tests/scoring/batter-scoring.test.js:10-19`

The old `resolvePosition` took a row with columns `pos_espn_2025`, `pos_yahoo_2025`, etc. and returned the first non-null value. The new version takes an array of `{ source, position }` rows for a single player and picks the best source based on a priority list.

- [ ] **Step 1: Write failing tests for new resolvePosition**

Replace the two existing `resolvePosition` tests in `server/tests/scoring/batter-scoring.test.js` with:

```js
describe('resolvePosition', () => {
  it('returns positions from highest-priority source', () => {
    const rows = [
      { source: 'yahoo_2025', position: 'SS' },
      { source: 'espn_2024', position: '2B' },
    ];
    expect(resolvePosition(rows)).toBe('SS');
  });

  it('returns espn_2025 over yahoo_2025 when both present', () => {
    const rows = [
      { source: 'espn_2025', position: 'OF' },
      { source: 'espn_2025', position: '2B' },
      { source: 'yahoo_2025', position: 'SS' },
    ];
    expect(resolvePosition(rows)).toBe('OF, 2B');
  });

  it('joins multiple positions from same source with comma', () => {
    const rows = [
      { source: 'espn_2025', position: 'SS' },
      { source: 'espn_2025', position: 'OF' },
    ];
    expect(resolvePosition(rows)).toBe('SS, OF');
  });

  it('returns Other when no rows', () => {
    expect(resolvePosition([])).toBe('Other');
  });

  it('prefers manual source above all others', () => {
    const rows = [
      { source: 'espn_2025', position: 'OF' },
      { source: 'manual', position: 'SS' },
    ];
    expect(resolvePosition(rows)).toBe('SS');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/scoring/batter-scoring.test.js`

Expected: resolvePosition tests fail (function signature changed).

- [ ] **Step 3: Implement new resolvePosition**

Replace lines 1-13 of `server/src/scoring/batter-scoring.js` (the imports, old `POSITION_COLUMNS`, and old `resolvePosition` — but **keep `primaryPosition` on lines 15-17 intact**, it's still used by `computeBatterScores`):

```js
import { safeDivide } from './utils.js';

const SOURCE_PRIORITY = [
  'manual', 'espn_2025', 'yahoo_2025', 'espn_2024',
  'yahoo_2024', 'fantrax_2025',
];

export function resolvePosition(positionRows) {
  if (!positionRows || positionRows.length === 0) return 'Other';
  for (const source of SOURCE_PRIORITY) {
    const positions = positionRows
      .filter(r => r.source === source)
      .map(r => r.position);
    if (positions.length > 0) return positions.join(', ');
  }
  return 'Other';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/tests/scoring/batter-scoring.test.js`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/scoring/batter-scoring.js server/tests/scoring/batter-scoring.test.js
git commit -m "refactor: resolvePosition reads from normalized position rows

Source priority reordered: manual overrides now take highest priority
(was lowest in the old column-order scheme). This is a deliberate
behavioral fix — manual overrides should always win."
```

---

### Task 3: Update `rescore.js` to query `position_eligibility`

**Files:**
- Modify: `server/src/scoring/rescore.js:68-75`
- Modify: `server/tests/scoring/rescore.test.js:26`

- [ ] **Step 1: Update rescore test to insert into position_eligibility**

In `server/tests/scoring/rescore.test.js`, replace line 26:

```js
// Old:
db.prepare(`INSERT INTO batter_positions (name, pos_espn_2025) VALUES ('Test OF', 'OF')`).run();
// New:
db.prepare(`INSERT INTO position_eligibility (name, source, position) VALUES ('Test OF', 'espn_2025', 'OF')`).run();
```

- [ ] **Step 2: Run rescore tests to verify they fail**

Run: `npx vitest run server/tests/scoring/rescore.test.js`

Expected: Fails because `rescore.js` still queries `batter_positions`.

- [ ] **Step 3: Update rescore.js position lookup**

Replace lines 68-75 of `server/src/scoring/rescore.js` with:

```js
    const rawBatters = db.prepare('SELECT * FROM batters_raw').all();
    const posRows = db.prepare('SELECT name, source, position FROM position_eligibility').all();
    const positionsMap = {};
    for (const row of posRows) {
      if (!positionsMap[row.name]) positionsMap[row.name] = [];
      positionsMap[row.name].push(row);
    }
    const battersWithPos = rawBatters.map(b => ({
      ...b, position: resolvePosition(positionsMap[b.name] || []),
    }));
```

- [ ] **Step 4: Run rescore tests to verify they pass**

Run: `npx vitest run server/tests/scoring/rescore.test.js`

Expected: All 3 tests pass.

- [ ] **Step 5: Update db.test.js table expectation**

In `server/tests/db.test.js:43`, change:

```js
// Old:
expect(tables).toContain('batter_positions');
// New:
expect(tables).toContain('position_eligibility');
```

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/scoring/rescore.js server/tests/scoring/rescore.test.js server/tests/db.test.js
git commit -m "refactor: rescore.js queries position_eligibility junction table"
```

---

## Chunk 2: ESPN Scraper Fix

### Task 4: Update ESPN parser to extract positions

**Files:**
- Modify: `server/src/scrapers/espn.js`
- Modify: `server/tests/scrapers/espn.test.js`

- [ ] **Step 1: Write failing test for position extraction**

Replace `server/tests/scrapers/espn.test.js` entirely:

```js
import { describe, it, expect } from 'vitest';
import { parseEspnResponse, ESPN_SLOT_TO_POSITION } from '../../src/scrapers/espn.js';

const sampleResponse = {
  players: [
    {
      player: { fullName: 'Shohei Ohtani', id: 39832, defaultPositionId: 10, eligibleSlots: [11, 13, 14, 16, 17] },
      ratings: { '0': { positionalRanking: 1, totalRating: 450.5 } },
    },
    {
      player: { fullName: 'Mookie Betts', id: 33039, defaultPositionId: 6, eligibleSlots: [4, 6, 19, 10, 5, 12, 16, 17] },
      ratings: { '0': { positionalRanking: 3, totalRating: 380.2 } },
    },
    {
      player: { fullName: 'Logan Webb', id: 41278, defaultPositionId: 1, eligibleSlots: [13, 14, 16, 17] },
      ratings: { '0': { positionalRanking: 10, totalRating: 200.0 } },
    },
    {
      player: { fullName: 'Cal Raleigh', id: 41345, defaultPositionId: 2, eligibleSlots: [0, 12, 16, 17] },
      ratings: { '0': { positionalRanking: 5, totalRating: 150.0 } },
    },
  ],
};

describe('parseEspnResponse', () => {
  it('extracts name, adp_rank, projected_points', () => {
    const result = parseEspnResponse(sampleResponse);
    const mookie = result.find(p => p.name === 'Mookie Betts');
    expect(mookie.adp_rank).toBe(3);
    expect(mookie.projected_points).toBeCloseTo(380.2);
  });

  it('maps eligibleSlots to position strings for hitters', () => {
    const result = parseEspnResponse(sampleResponse);
    const mookie = result.find(p => p.name === 'Mookie Betts');
    expect(mookie.positions).toEqual(['SS', 'OF']);
  });

  it('returns empty positions array for pitchers (defaultPositionId 1 or 11)', () => {
    const result = parseEspnResponse(sampleResponse);
    const webb = result.find(p => p.name === 'Logan Webb');
    expect(webb.positions).toEqual([]);
  });

  it('maps catcher slot correctly', () => {
    const result = parseEspnResponse(sampleResponse);
    const raleigh = result.find(p => p.name === 'Cal Raleigh');
    expect(raleigh.positions).toEqual(['C']);
  });

  it('handles DH-type players (defaultPositionId 10) as hitters', () => {
    const result = parseEspnResponse(sampleResponse);
    const ohtani = result.find(p => p.name === 'Shohei Ohtani');
    // Ohtani has no standard position slots (0-5), just DH/UTIL/P slots
    expect(ohtani.positions).toEqual([]);
  });
});

describe('ESPN_SLOT_TO_POSITION', () => {
  it('maps all 6 standard hitter slots', () => {
    expect(ESPN_SLOT_TO_POSITION[0]).toBe('C');
    expect(ESPN_SLOT_TO_POSITION[1]).toBe('1B');
    expect(ESPN_SLOT_TO_POSITION[2]).toBe('2B');
    expect(ESPN_SLOT_TO_POSITION[3]).toBe('3B');
    expect(ESPN_SLOT_TO_POSITION[4]).toBe('SS');
    expect(ESPN_SLOT_TO_POSITION[5]).toBe('OF');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/scrapers/espn.test.js`

Expected: Fails — `ESPN_SLOT_TO_POSITION` is not exported, `positions` field doesn't exist.

- [ ] **Step 3: Implement updated parser**

Replace `server/src/scrapers/espn.js` entirely:

```js
import { reconcileName, loadReplacements } from './names.js';

export const ESPN_SLOT_TO_POSITION = {
  0: 'C',
  1: '1B',
  2: '2B',
  3: '3B',
  4: 'SS',
  5: 'OF',
};

const PITCHER_POSITION_IDS = new Set([1, 11]);

export function parseEspnResponse(json) {
  if (!json?.players) return [];
  return json.players.map(p => {
    const isPitcher = PITCHER_POSITION_IDS.has(p.player?.defaultPositionId);
    const slots = p.player?.eligibleSlots || [];
    const positions = isPitcher
      ? []
      : slots
          .filter(s => s in ESPN_SLOT_TO_POSITION)
          .map(s => ESPN_SLOT_TO_POSITION[s]);
    return {
      name: p.player?.fullName || '',
      adp_rank: p.ratings?.['0']?.positionalRanking ?? null,
      projected_points: p.ratings?.['0']?.totalRating ?? null,
      positions,
    };
  }).filter(p => p.name);
}

export async function fetchEspn(db) {
  const year = db.prepare("SELECT value FROM app_config WHERE key='season_year'").get()?.value || '2026';
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leaguedefaults/3?view=kona_player_info`;

  const res = await fetch(url, {
    headers: {
      'x-fantasy-filter': JSON.stringify({
        players: {
          limit: 1500,
          sortPercOwned: { sortAsc: false, sortPriority: 1 },
        },
      }),
    },
  });
  if (!res.ok) throw new Error(`ESPN fetch failed: ${res.status}`);
  const json = await res.json();
  const players = parseEspnResponse(json);

  const replacements = loadReplacements(db);
  const source = `espn_${year}`;

  db.prepare('DELETE FROM espn_adp').run();
  db.prepare('DELETE FROM position_eligibility WHERE source = ?').run(source);

  const insertAdp = db.prepare(
    'INSERT INTO espn_adp (name, adp_rank, projected_points) VALUES (?, ?, ?)'
  );
  const insertPos = db.prepare(
    'INSERT OR IGNORE INTO position_eligibility (name, source, position) VALUES (?, ?, ?)'
  );

  for (const p of players) {
    const name = reconcileName(p.name, replacements);
    insertAdp.run(name, p.adp_rank, p.projected_points);
    for (const pos of p.positions) {
      insertPos.run(name, source, pos);
    }
  }

  return { players: players.length, positions: players.filter(p => p.positions.length > 0).length };
}
```

- [ ] **Step 4: Run parser tests to verify they pass**

Run: `npx vitest run server/tests/scrapers/espn.test.js`

Expected: All tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/scrapers/espn.js server/tests/scrapers/espn.test.js
git commit -m "feat: ESPN scraper fetches 1500 players and extracts positional eligibility"
```

---

### Task 5: Smoke test the live ESPN scrape

This is a manual verification task — no test file, just confirm it works end-to-end.

- [ ] **Step 1: Start the server**

Run: `npm run dev` (or however the server starts) from the `server/` directory.

- [ ] **Step 2: Trigger the ESPN scrape**

Run: `curl -X POST http://localhost:3000/api/scrape/espn`

Expected: Response like `{"ok":true,"players":1500,"positions":800}` (exact numbers will vary). Should NOT be `{"players":50}`.

- [ ] **Step 3: Verify position data landed**

Run: `curl http://localhost:3000/api/scrape/espn` won't work — instead, query the DB directly or add a quick check:

```bash
node -e "
import Database from 'better-sqlite3';
const db = new Database('server/data/fantasy.db');
console.log('position_eligibility rows:', db.prepare('SELECT COUNT(*) as n FROM position_eligibility').get().n);
console.log('sample:', db.prepare('SELECT * FROM position_eligibility LIMIT 10').all());
console.log('multi-pos:', db.prepare(\"SELECT name, GROUP_CONCAT(position) as positions FROM position_eligibility WHERE source='espn_2026' GROUP BY name HAVING COUNT(*) > 1 LIMIT 5\").all());
db.close();
"
```

Expected: Hundreds of rows in `position_eligibility`. Multi-position players show up (e.g., Mookie Betts with SS, OF).

- [ ] **Step 4: Commit (if any fixups needed)**

Only if smoke testing revealed issues that needed fixing.
