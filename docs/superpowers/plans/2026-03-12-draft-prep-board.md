# Draft Prep Board Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally-run React + Express + SQLite web app for fantasy baseball draft preparation with automated data ingestion, configurable scoring, and live draft tracking.

**Architecture:** React (Vite) frontend talks to Express backend via REST JSON API. Backend owns scoring engine, data scrapers, and SQLite persistence via better-sqlite3. Single SQLite file stores all state.

**Tech Stack:** React 18, Vite, TanStack Table, React Router, Tailwind CSS, Express, better-sqlite3, dotenv, csv-parse, vitest (backend tests), node --test (integration)

**Spec:** `docs/superpowers/specs/2026-03-12-draft-prep-board-design.md`

---

## File Structure

```
fantasy-baseball/
├── package.json                    # Root workspace config
├── .env                            # FanGraphs credentials (gitignored)
├── .gitignore
│
├── server/
│   ├── package.json
│   ├── src/
│   │   ├── index.js                # Express app entry point
│   │   ├── db.js                   # SQLite connection + schema init
│   │   ├── schema.sql              # All CREATE TABLE statements
│   │   ├── seed.js                 # Default scoring config + position adjustments
│   │   │
│   │   ├── scoring/
│   │   │   ├── pitcher-scoring.js  # Pitcher raw score, position, adjustment, adj_2020_value
│   │   │   ├── batter-scoring.js   # Batter raw score, position lookup, adjustment
│   │   │   ├── combined.js         # Merge + rank pitchers and batters
│   │   │   └── rescore.js          # Orchestrator: runs all three in sequence
│   │   │
│   │   ├── scrapers/
│   │   │   ├── fangraphs.js        # Auth + CSV download for projections
│   │   │   ├── savant.js           # Statcast CSV fetch + name normalization
│   │   │   ├── espn.js             # ESPN ADP JSON fetch
│   │   │   └── names.js            # Name reconciliation helper
│   │   │
│   │   └── routes/
│   │       ├── rankings.js         # GET /api/rankings, GET /api/rankings/:id
│   │       ├── draft.js            # CRUD for draft sessions + picks
│   │       ├── config.js           # GET/PUT scoring config, position adjustments
│   │       └── scrape.js           # POST /api/scrape/:source triggers scrapers
│   │
│   └── tests/
│       ├── scoring/
│       │   ├── pitcher-scoring.test.js
│       │   ├── batter-scoring.test.js
│       │   └── combined.test.js
│       ├── scrapers/
│       │   ├── names.test.js
│       │   ├── fangraphs.test.js
│       │   ├── savant.test.js
│       │   └── espn.test.js
│       └── routes/
│           ├── rankings.test.js
│           ├── draft.test.js
│           ├── config.test.js
│           └── scrape.test.js
│
├── client/
│   ├── package.json
│   ├── index.html
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── src/
│   │   ├── main.jsx                # React entry point
│   │   ├── App.jsx                 # Router + nav layout
│   │   ├── api.js                  # Fetch wrapper for all backend calls
│   │   │
│   │   ├── pages/
│   │   │   ├── Rankings.jsx        # Rankings table view
│   │   │   ├── Draft.jsx           # Draft tracker view
│   │   │   └── Settings.jsx        # Config editor view
│   │   │
│   │   └── components/
│   │       ├── PlayerTable.jsx     # TanStack Table wrapper (shared by Rankings + Draft)
│   │       ├── PositionFilter.jsx  # Quick position filter buttons
│   │       ├── SearchBar.jsx       # Type-ahead player search
│   │       ├── RosterSidebar.jsx   # Draft: my picks by position
│   │       ├── SessionSelector.jsx # Draft: session dropdown + new session
│   │       ├── WeightsEditor.jsx   # Settings: scoring weights table
│   │       ├── DataRefresh.jsx     # Settings: scraper trigger buttons
│   │       └── NameReplacements.jsx# Settings: name mapping editor
│   │
│   └── tests/
│       └── (component tests as needed)
│
└── .claude/
    └── launch.json                 # Dev server configs for preview
```

---

## Chunk 1: Project Scaffolding + Database

### Task 1: Initialize monorepo and install dependencies

**Files:**
- Create: `package.json` (root)
- Create: `server/package.json`
- Create: `client/package.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Create root package.json with workspaces**

```json
{
  "name": "fantasy-baseball",
  "private": true,
  "workspaces": ["server", "client"]
}
```

- [ ] **Step 2: Create server/package.json**

```json
{
  "name": "server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch src/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "cors": "^2.8.5",
    "csv-parse": "^5.5.0",
    "dotenv": "^16.4.0",
    "express": "^4.21.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Create client/package.json**

```json
{
  "name": "client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "@tanstack/react-table": "^8.20.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
.env
*.db
.superpowers/
```

- [ ] **Step 5: Create .env.example**

```
FANGRAPHS_EMAIL=your-email@example.com
FANGRAPHS_PASSWORD=your-password
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: node_modules created in root, server, client

- [ ] **Step 7: Commit**

```bash
git add package.json server/package.json client/package.json .gitignore .env.example
git commit -m "feat: initialize monorepo with server and client workspaces"
```

### Task 2: Database schema and seed data

**Files:**
- Create: `server/src/schema.sql`
- Create: `server/src/db.js`
- Create: `server/src/seed.js`
- Test: `server/tests/db.test.js`

- [ ] **Step 1: Write the failing test for database initialization**

```js
// server/tests/db.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'src', 'schema.sql');

describe('database schema', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all required tables', () => {
    const schema = readFileSync(schemaPath, 'utf8');
    db.exec(schema);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

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
    expect(tables).toContain('batter_positions');
    expect(tables).toContain('espn_adp');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/db.test.js`
Expected: FAIL — schema.sql not found

- [ ] **Step 3: Write schema.sql**

```sql
-- server/src/schema.sql
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
  rank INTEGER,
  name TEXT NOT NULL,
  team TEXT,
  position TEXT,
  score REAL,
  adj_score REAL,
  espn_adp INTEGER,
  velocity_delta REAL,
  per_game_efficiency REAL,
  value_gap INTEGER
);

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

CREATE TABLE IF NOT EXISTS batter_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pos_espn_2025 TEXT,
  pos_yahoo_2025 TEXT,
  pos_espn_2024 TEXT,
  pos_yahoo_2024 TEXT,
  pos_fantrax_2025 TEXT,
  pos_manual TEXT
);

CREATE TABLE IF NOT EXISTS espn_adp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  adp_rank INTEGER,
  projected_points REAL
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/db.test.js`
Expected: PASS

- [ ] **Step 5: Write seed test**

```js
// Add to server/tests/db.test.js
import { seedDefaults } from '../src/seed.js';

describe('seed defaults', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    const schema = readFileSync(schemaPath, 'utf8');
    db.exec(schema);
  });

  afterEach(() => {
    db.close();
  });

  it('seeds pitcher scoring weights', () => {
    seedDefaults(db);
    const weights = db.prepare(
      "SELECT stat, weight FROM scoring_config WHERE category='pitcher' ORDER BY stat"
    ).all();
    expect(weights.find(w => w.stat === 'IP').weight).toBe(2.1);
    expect(weights.find(w => w.stat === 'SV').weight).toBe(5.0);
    expect(weights.find(w => w.stat === 'SO').weight).toBe(1.0);
  });

  it('seeds batter scoring weights', () => {
    seedDefaults(db);
    const weights = db.prepare(
      "SELECT stat, weight FROM scoring_config WHERE category='batter' ORDER BY stat"
    ).all();
    expect(weights.find(w => w.stat === 'HR').weight).toBe(3.1);
    expect(weights.find(w => w.stat === 'SB').weight).toBe(2.0);
    expect(weights.find(w => w.stat === 'SO').weight).toBe(-1.0);
  });

  it('seeds position adjustments', () => {
    seedDefaults(db);
    const adj = db.prepare(
      "SELECT position, adjustment FROM position_adjustments ORDER BY position"
    ).all();
    expect(adj.find(a => a.position === 'C').adjustment).toBe(70);
    expect(adj.find(a => a.position === 'SS').adjustment).toBe(20);
  });

  it('seeds app config defaults', () => {
    seedDefaults(db);
    const rl = db.prepare("SELECT value FROM app_config WHERE key='replacement_level'").get();
    expect(rl.value).toBe('237');
    const ps = db.prepare("SELECT value FROM app_config WHERE key='projection_system'").get();
    expect(ps.value).toBe('steamer');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd server && npx vitest run tests/db.test.js`
Expected: FAIL — seed.js not found

- [ ] **Step 7: Implement seed.js**

```js
// server/src/seed.js
export function seedDefaults(db) {
  const insertWeight = db.prepare(
    'INSERT OR IGNORE INTO scoring_config (category, stat, weight) VALUES (?, ?, ?)'
  );

  const pitcherWeights = [
    ['IP', 2.1], ['W', 3.5], ['L', -1.0], ['QS', 2.0], ['SV', 5.0],
    ['H', -0.6], ['ER', -1.5], ['SO', 1.0], ['BB', -0.5],
  ];
  for (const [stat, weight] of pitcherWeights) {
    insertWeight.run('pitcher', stat, weight);
  }

  const batterWeights = [
    ['H', 1.0], ['2B', 1.0], ['3B', 2.0], ['HR', 3.1], ['R', 1.1],
    ['RBI', 1.1], ['BB', 1.0], ['SO', -1.0], ['SB', 2.0],
  ];
  for (const [stat, weight] of batterWeights) {
    insertWeight.run('batter', stat, weight);
  }

  const insertAdj = db.prepare(
    'INSERT OR IGNORE INTO position_adjustments (position, adjustment) VALUES (?, ?)'
  );
  const posAdj = [
    ['C', 70], ['OF', 40], ['2B', 30], ['3B', 25],
    ['SS', 20], ['1B', 15], ['Other', 10],
  ];
  for (const [pos, adj] of posAdj) {
    insertAdj.run(pos, adj);
  }

  const insertConfig = db.prepare(
    'INSERT OR IGNORE INTO app_config (key, value) VALUES (?, ?)'
  );
  insertConfig.run('replacement_level', '237');
  insertConfig.run('projection_system', 'steamer');
  insertConfig.run('season_year', '2026');
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/db.test.js`
Expected: PASS

- [ ] **Step 9: Write db.js module**

```js
// server/src/db.js
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seedDefaults } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createDb(dbPath = join(__dirname, '..', '..', 'fantasy-baseball.db')) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  seedDefaults(db);

  return db;
}
```

- [ ] **Step 10: Commit**

```bash
git add server/src/schema.sql server/src/db.js server/src/seed.js server/tests/db.test.js
git commit -m "feat: database schema, seed data, and initialization"
```

---

## Chunk 2: Scoring Engine

### Task 3: Pitcher scoring

**Files:**
- Create: `server/src/scoring/pitcher-scoring.js`
- Test: `server/tests/scoring/pitcher-scoring.test.js`

- [ ] **Step 1: Write failing tests for pitcher scoring**

```js
// server/tests/scoring/pitcher-scoring.test.js
import { describe, it, expect } from 'vitest';
import { computePitcherScores } from '../../src/scoring/pitcher-scoring.js';

// Default weights matching spec
const weights = {
  IP: 2.1, W: 3.5, L: -1.0, QS: 2.0, SV: 5.0,
  H: -0.6, ER: -1.5, SO: 1.0, BB: -0.5,
};
const replacementLevel = 237;

describe('computePitcherScores', () => {
  it('computes raw score as SUMPRODUCT of stats and weights', () => {
    const pitcher = {
      name: 'Test SP', team: 'NYY',
      IP: 200, W: 15, L: 8, QS: 25, SV: 0, HLD: 0,
      H: 170, ER: 70, HR: 20, SO: 200, BB: 50, G: 33, GS: 33,
    };
    const result = computePitcherScores([pitcher], weights, replacementLevel);
    // 200*2.1 + 15*3.5 + 8*-1 + 25*2 + 0*5 + 170*-0.6 + 70*-1.5 + 200*1 + 50*-0.5
    // = 420 + 52.5 - 8 + 50 + 0 - 102 - 105 + 200 - 25 = 482.5
    expect(result[0].raw_score).toBeCloseTo(482.5, 1);
  });

  it('classifies scoring_position as CLOSER when SV > 0', () => {
    const closer = {
      name: 'Closer', team: 'BOS', IP: 60, W: 3, L: 2, QS: 0,
      SV: 30, HLD: 0, H: 40, ER: 15, HR: 5, SO: 70, BB: 15, G: 60, GS: 0,
    };
    const result = computePitcherScores([closer], weights, replacementLevel);
    expect(result[0].scoring_position).toBe('CLOSER');
    expect(result[0].adjustment).toBe(-10);
  });

  it('classifies display_position as SP, RP for dual-eligible', () => {
    const swingman = {
      name: 'Swingman', team: 'LAD', IP: 100, W: 5, L: 4, QS: 5,
      SV: 2, HLD: 3, H: 90, ER: 40, HR: 10, SO: 80, BB: 30, G: 40, GS: 15,
    };
    const result = computePitcherScores([swingman], weights, replacementLevel);
    expect(result[0].scoring_position).toBe('CLOSER'); // SV > 0
    expect(result[0].display_position).toBe('SP, RP'); // GS > 0 and GS < G
  });

  it('computes SP adjustment correctly', () => {
    const sp = {
      name: 'SP', team: 'HOU', IP: 180, W: 12, L: 6, QS: 20,
      SV: 0, HLD: 0, H: 150, ER: 60, HR: 18, SO: 190, BB: 40, G: 30, GS: 30,
    };
    const result = computePitcherScores([sp], weights, replacementLevel);
    const expected_adj = -Math.min(result[0].raw_score * 3 / 7, 237 * 10 / 7 * 3 / 7) + 165;
    expect(result[0].adjustment).toBeCloseTo(expected_adj, 1);
  });

  it('computes adj_2020_value with dual-path valuation', () => {
    const sp = {
      name: 'SP', team: 'HOU', IP: 180, W: 12, L: 6, QS: 20,
      SV: 0, HLD: 0, H: 150, ER: 60, HR: 18, SO: 190, BB: 40, G: 30, GS: 30,
    };
    const result = computePitcherScores([sp], weights, replacementLevel);
    // Pure SP: relief_pts = raw * (30-30)/180 = 0, starting_pts = raw
    const raw = result[0].raw_score;
    const sp_value = -Math.min(raw * 3 / 7, 237 * 10 / 7 * 3 / 7) + 215 + raw;
    const rp_value = 0 + 71;
    expect(result[0].adj_2020_value).toBeCloseTo(Math.max(sp_value, rp_value), 1);
  });

  it('handles zero IP without crashing', () => {
    const zeroIP = {
      name: 'NoIP', team: 'FA', IP: 0, W: 0, L: 0, QS: 0,
      SV: 0, HLD: 0, H: 0, ER: 0, HR: 0, SO: 0, BB: 0, G: 0, GS: 0,
    };
    const result = computePitcherScores([zeroIP], weights, replacementLevel);
    expect(result[0].relief_pts).toBe(0);
    expect(result[0].pts_per_appearance).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/scoring/pitcher-scoring.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement pitcher-scoring.js**

```js
// server/src/scoring/pitcher-scoring.js

function safeDivide(a, b) {
  return b === 0 ? 0 : a / b;
}

export function computePitcherScores(pitchers, weights, replacementLevel) {
  return pitchers.map(p => {
    const raw_score =
      (p.IP || 0) * weights.IP +
      (p.W || 0) * weights.W +
      (p.L || 0) * weights.L +
      (p.QS || 0) * weights.QS +
      (p.SV || 0) * weights.SV +
      (p.H || 0) * weights.H +
      (p.ER || 0) * weights.ER +
      (p.SO || 0) * weights.SO +
      (p.BB || 0) * weights.BB;

    const scoring_position = p.SV > 0 ? 'CLOSER' : 'SP';

    let display_position;
    if (p.GS === p.G) display_position = 'SP';
    else if (p.GS === 0) display_position = 'RP';
    else display_position = 'SP, RP';

    const adjustment = scoring_position === 'CLOSER'
      ? -10
      : -Math.min(raw_score * 3 / 7, replacementLevel * 10 / 7 * 3 / 7) + 165;

    const adj_score = raw_score + adjustment;

    const relief_pts = safeDivide(raw_score * (p.G - p.GS), p.IP);
    const starting_pts = raw_score - relief_pts;

    const sp_value = -Math.min(starting_pts * 3 / 7, replacementLevel * 10 / 7 * 3 / 7) + 215 + starting_pts;
    const rp_value = relief_pts + 71;
    const adj_2020_value = Math.max(sp_value, rp_value);

    const pts_per_appearance = safeDivide(raw_score, p.G);

    return {
      name: p.name,
      team: p.team,
      scoring_position,
      display_position,
      raw_score,
      adjustment,
      adj_score,
      starting_pts,
      relief_pts,
      adj_2020_value,
      pts_per_appearance,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/scoring/pitcher-scoring.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/scoring/pitcher-scoring.js server/tests/scoring/pitcher-scoring.test.js
git commit -m "feat: pitcher scoring engine with position classification and dual-path valuation"
```

### Task 4: Batter scoring

**Files:**
- Create: `server/src/scoring/batter-scoring.js`
- Test: `server/tests/scoring/batter-scoring.test.js`

- [ ] **Step 1: Write failing tests for batter scoring**

```js
// server/tests/scoring/batter-scoring.test.js
import { describe, it, expect } from 'vitest';
import { computeBatterScores, resolvePosition } from '../../src/scoring/batter-scoring.js';

const weights = {
  H: 1.0, '2B': 1.0, '3B': 2.0, HR: 3.1, R: 1.1,
  RBI: 1.1, BB: 1.0, SO: -1.0, SB: 2.0,
};
const posAdj = { C: 70, OF: 40, '2B': 30, '3B': 25, SS: 20, '1B': 15, Other: 10 };

describe('resolvePosition', () => {
  it('returns first non-empty position from sources', () => {
    const positions = { pos_espn_2025: null, pos_yahoo_2025: 'SS', pos_espn_2024: '2B' };
    expect(resolvePosition(positions)).toBe('SS');
  });

  it('returns first position from multi-position string for adjustment', () => {
    expect(resolvePosition({ pos_espn_2025: 'OF, 2B' })).toBe('OF, 2B');
  });
});

describe('computeBatterScores', () => {
  it('computes raw score as SUMPRODUCT', () => {
    const batter = {
      name: 'Batter', team: 'NYM', G: 150, H: 160, '2B': 30,
      '3B': 5, HR: 35, R: 95, RBI: 100, BB: 60, SO: 130, SB: 15,
      position: 'OF',
    };
    const result = computeBatterScores([batter], weights, posAdj);
    // 160 + 30 + 10 + 108.5 + 104.5 + 110 + 60 - 130 + 30 = 483
    expect(result[0].raw_score).toBeCloseTo(483, 1);
  });

  it('applies position scarcity adjustment for catcher', () => {
    const catcher = {
      name: 'Catcher', team: 'STL', G: 120, H: 100, '2B': 20,
      '3B': 1, HR: 15, R: 50, RBI: 55, BB: 40, SO: 90, SB: 2,
      position: 'C',
    };
    const result = computeBatterScores([catcher], weights, posAdj);
    expect(result[0].adjustment).toBe(70);
    expect(result[0].adj_score).toBe(result[0].raw_score + 70);
  });

  it('uses first position from multi-position string for adjustment', () => {
    const multi = {
      name: 'Multi', team: 'CHC', G: 140, H: 150, '2B': 25,
      '3B': 3, HR: 20, R: 75, RBI: 80, BB: 50, SO: 110, SB: 10,
      position: 'OF, 2B',
    };
    const result = computeBatterScores([multi], weights, posAdj);
    expect(result[0].adjustment).toBe(40); // OF adjustment, not 2B
  });

  it('handles zero games without crashing', () => {
    const noGames = {
      name: 'NoG', team: 'FA', G: 0, H: 0, '2B': 0, '3B': 0,
      HR: 0, R: 0, RBI: 0, BB: 0, SO: 0, SB: 0, position: '1B',
    };
    const result = computeBatterScores([noGames], weights, posAdj);
    expect(result[0].pts_per_game).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/scoring/batter-scoring.test.js`
Expected: FAIL

- [ ] **Step 3: Implement batter-scoring.js**

```js
// server/src/scoring/batter-scoring.js

function safeDivide(a, b) {
  return b === 0 ? 0 : a / b;
}

const POSITION_COLUMNS = [
  'pos_espn_2025', 'pos_yahoo_2025', 'pos_espn_2024',
  'pos_yahoo_2024', 'pos_fantrax_2025', 'pos_manual',
];

export function resolvePosition(positionRow) {
  for (const col of POSITION_COLUMNS) {
    if (positionRow[col]) return positionRow[col];
  }
  return 'Other';
}

function primaryPosition(positionString) {
  return positionString.split(',')[0].trim();
}

export function computeBatterScores(batters, weights, posAdj) {
  return batters.map(b => {
    const raw_score =
      (b.H || 0) * weights.H +
      (b['2B'] || 0) * weights['2B'] +
      (b['3B'] || 0) * weights['3B'] +
      (b.HR || 0) * weights.HR +
      (b.R || 0) * weights.R +
      (b.RBI || 0) * weights.RBI +
      (b.BB || 0) * weights.BB +
      (b.SO || 0) * weights.SO +
      (b.SB || 0) * weights.SB;

    const position = b.position || 'Other';
    const primary = primaryPosition(position);
    const adjustment = posAdj[primary] ?? posAdj.Other ?? 10;
    const adj_score = raw_score + adjustment;
    const pts_per_game = safeDivide(raw_score, b.G);

    return {
      name: b.name,
      team: b.team,
      position,
      raw_score,
      adjustment,
      adj_score,
      pts_per_game,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/scoring/batter-scoring.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/scoring/batter-scoring.js server/tests/scoring/batter-scoring.test.js
git commit -m "feat: batter scoring engine with position scarcity adjustments"
```

### Task 5: Combined rankings

**Files:**
- Create: `server/src/scoring/combined.js`
- Test: `server/tests/scoring/combined.test.js`

- [ ] **Step 1: Write failing tests**

```js
// server/tests/scoring/combined.test.js
import { describe, it, expect } from 'vitest';
import { buildCombinedRankings } from '../../src/scoring/combined.js';

describe('buildCombinedRankings', () => {
  const pitchers = [
    { name: 'Ace SP', team: 'NYY', display_position: 'SP', raw_score: 500, adj_2020_value: 600, pts_per_appearance: 15 },
    { name: 'Setup RP', team: 'BOS', display_position: 'RP', raw_score: 100, adj_2020_value: 171, pts_per_appearance: 3 },
  ];
  const batters = [
    { name: 'Slugger', team: 'LAD', position: 'OF', raw_score: 450, adj_score: 490, pts_per_game: 3.2 },
    { name: 'Catcher', team: 'STL', position: 'C', raw_score: 200, adj_score: 270, pts_per_game: 1.8 },
  ];
  const espnAdp = { 'Ace SP': 5, 'Slugger': 3, 'Catcher': 80 };
  const velocityDeltas = { 'Ace SP': -1.2, 'Setup RP': 0.5 };

  it('ranks by adj_score descending', () => {
    const result = buildCombinedRankings(pitchers, batters, espnAdp, velocityDeltas);
    expect(result[0].name).toBe('Ace SP');  // adj_score 600
    expect(result[1].name).toBe('Slugger'); // adj_score 490
  });

  it('computes value_gap as rank minus espn_adp', () => {
    const result = buildCombinedRankings(pitchers, batters, espnAdp, velocityDeltas);
    const ace = result.find(r => r.name === 'Ace SP');
    expect(ace.value_gap).toBe(ace.rank - 5);
  });

  it('sets velocity_delta to null for batters', () => {
    const result = buildCombinedRankings(pitchers, batters, espnAdp, velocityDeltas);
    const slugger = result.find(r => r.name === 'Slugger');
    expect(slugger.velocity_delta).toBeNull();
  });

  it('uses pitcher display_position for position column', () => {
    const result = buildCombinedRankings(pitchers, batters, espnAdp, velocityDeltas);
    expect(result.find(r => r.name === 'Ace SP').position).toBe('SP');
  });

  it('breaks ties by score DESC then name ASC', () => {
    const tiedPitchers = [
      { name: 'Beta', team: 'A', display_position: 'SP', raw_score: 300, adj_2020_value: 400, pts_per_appearance: 10 },
      { name: 'Alpha', team: 'B', display_position: 'SP', raw_score: 300, adj_2020_value: 400, pts_per_appearance: 10 },
    ];
    const result = buildCombinedRankings(tiedPitchers, [], {}, {});
    expect(result[0].name).toBe('Alpha');
    expect(result[1].name).toBe('Beta');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/scoring/combined.test.js`
Expected: FAIL

- [ ] **Step 3: Implement combined.js**

```js
// server/src/scoring/combined.js

export function buildCombinedRankings(pitcherScores, batterScores, espnAdp, velocityDeltas) {
  const rows = [];

  for (const p of pitcherScores) {
    rows.push({
      name: p.name,
      team: p.team,
      position: p.display_position,
      score: p.raw_score,
      adj_score: p.adj_2020_value,
      espn_adp: espnAdp[p.name] ?? null,
      velocity_delta: velocityDeltas[p.name] ?? null,
      per_game_efficiency: p.pts_per_appearance,
    });
  }

  for (const b of batterScores) {
    rows.push({
      name: b.name,
      team: b.team,
      position: b.position,
      score: b.raw_score,
      adj_score: b.adj_score,
      espn_adp: espnAdp[b.name] ?? null,
      velocity_delta: null,
      per_game_efficiency: b.pts_per_game,
    });
  }

  rows.sort((a, b) => {
    if (b.adj_score !== a.adj_score) return b.adj_score - a.adj_score;
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return rows.map((row, i) => ({
    ...row,
    rank: i + 1,
    value_gap: row.espn_adp != null ? (i + 1) - row.espn_adp : null,
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/scoring/combined.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/scoring/combined.js server/tests/scoring/combined.test.js
git commit -m "feat: combined rankings with rank, value gap, and tie-breaking"
```

### Task 6: Rescore orchestrator

**Files:**
- Create: `server/src/scoring/rescore.js`
- Test: `server/tests/scoring/rescore.test.js`

- [ ] **Step 1: Write failing test**

```js
// server/tests/scoring/rescore.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seedDefaults } from '../../src/seed.js';
import { rescoreAll } from '../../src/scoring/rescore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('rescoreAll', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    const schema = readFileSync(join(__dirname, '..', '..', 'src', 'schema.sql'), 'utf8');
    db.exec(schema);
    seedDefaults(db);

    // Insert test pitcher
    db.prepare(`INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB)
      VALUES ('Test SP', 'NYY', 30, 30, 200, 15, 8, 25, 0, 0, 170, 70, 20, 200, 50)`).run();

    // Insert test batter
    db.prepare(`INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS)
      VALUES ('Test OF', 'LAD', 150, 600, 550, 160, 30, 5, 35, 95, 100, 60, 130, 5, 15, 3)`).run();

    // Insert batter position
    db.prepare(`INSERT INTO batter_positions (name, pos_espn_2025) VALUES ('Test OF', 'OF')`).run();
  });

  afterEach(() => { db.close(); });

  it('populates pitcher_scores', () => {
    rescoreAll(db);
    const rows = db.prepare('SELECT * FROM pitcher_scores').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Test SP');
    expect(rows[0].scoring_position).toBe('SP');
  });

  it('populates batter_scores', () => {
    rescoreAll(db);
    const rows = db.prepare('SELECT * FROM batter_scores').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Test OF');
    expect(rows[0].position).toBe('OF');
  });

  it('populates combined_rankings with both players', () => {
    rescoreAll(db);
    const rows = db.prepare('SELECT * FROM combined_rankings ORDER BY rank').all();
    expect(rows).toHaveLength(2);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/scoring/rescore.test.js`
Expected: FAIL

- [ ] **Step 3: Implement rescore.js**

```js
// server/src/scoring/rescore.js
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
  const rows = db.prepare(`
    SELECT player_name, v_2024, v_2025, (v_2025 - v_2024) as delta FROM (
      SELECT player_name,
        MAX(CASE WHEN season = 2024 AND season_type = 'regular' THEN velocity END) as v_2024,
        MAX(CASE WHEN season = 2025 AND season_type = 'spring' THEN velocity END) as v_2025
      FROM statcast_pitches GROUP BY player_name
    ) WHERE v_2024 IS NOT NULL AND v_2025 IS NOT NULL AND (v_2025 - v_2024) < 10
  `).all();
  const deltas = {};
  for (const r of rows) deltas[r.player_name] = r.delta;
  return deltas;
}

function getEspnAdp(db) {
  const rows = db.prepare('SELECT name, adp_rank FROM espn_adp').all();
  const adp = {};
  for (const r of rows) adp[r.name] = r.adp_rank;
  return adp;
}

export function rescoreAll(db) {
  const pitcherWeights = getWeights(db, 'pitcher');
  const batterWeights = getWeights(db, 'batter');
  const posAdj = getPosAdjustments(db);
  const replacementLevel = Number(getConfig(db, 'replacement_level')) || 237;

  // Score pitchers
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

  // Score batters
  const rawBatters = db.prepare('SELECT * FROM batters_raw').all();
  const positionsMap = {};
  for (const row of db.prepare('SELECT * FROM batter_positions').all()) {
    positionsMap[row.name] = resolvePosition(row);
  }
  const battersWithPos = rawBatters.map(b => ({
    ...b, position: positionsMap[b.name] || 'Other',
  }));
  const batterScores = computeBatterScores(battersWithPos, batterWeights, posAdj);

  db.prepare('DELETE FROM batter_scores').run();
  const insertBatter = db.prepare(`
    INSERT INTO batter_scores (name, team, position, raw_score, adjustment, adj_score, pts_per_game)
    VALUES (@name, @team, @position, @raw_score, @adjustment, @adj_score, @pts_per_game)
  `);
  for (const b of batterScores) insertBatter.run(b);

  // Build combined
  const espnAdp = getEspnAdp(db);
  const velocityDeltas = getVelocityDeltas(db);
  const combined = buildCombinedRankings(pitcherScores, batterScores, espnAdp, velocityDeltas);

  db.prepare('DELETE FROM combined_rankings').run();
  const insertCombined = db.prepare(`
    INSERT INTO combined_rankings (rank, name, team, position, score, adj_score,
      espn_adp, velocity_delta, per_game_efficiency, value_gap)
    VALUES (@rank, @name, @team, @position, @score, @adj_score,
      @espn_adp, @velocity_delta, @per_game_efficiency, @value_gap)
  `);
  for (const c of combined) insertCombined.run(c);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/scoring/rescore.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/scoring/rescore.js server/tests/scoring/rescore.test.js
git commit -m "feat: rescore orchestrator wiring pitcher, batter, and combined scoring"
```

---

## Chunk 3: Data Scrapers

### Task 7: Name reconciliation helper

**Files:**
- Create: `server/src/scrapers/names.js`
- Test: `server/tests/scrapers/names.test.js`

- [ ] **Step 1: Write failing tests**

```js
// server/tests/scrapers/names.test.js
import { describe, it, expect } from 'vitest';
import { convertLastFirst, reconcileName } from '../../src/scrapers/names.js';

describe('convertLastFirst', () => {
  it('converts "Last, First" to "First Last"', () => {
    expect(convertLastFirst('Verlander, Justin')).toBe('Justin Verlander');
  });

  it('returns unchanged if no comma', () => {
    expect(convertLastFirst('Justin Verlander')).toBe('Justin Verlander');
  });
});

describe('reconcileName', () => {
  const replacements = { 'Pete Alonso': 'Peter Alonso', 'Jake Faria': 'Jacob Faria' };

  it('returns canonical name when alt exists', () => {
    expect(reconcileName('Pete Alonso', replacements)).toBe('Peter Alonso');
  });

  it('returns original name when no replacement exists', () => {
    expect(reconcileName('Mike Trout', replacements)).toBe('Mike Trout');
  });
});
```

- [ ] **Step 2: Run test, verify fail**

Run: `cd server && npx vitest run tests/scrapers/names.test.js`

- [ ] **Step 3: Implement names.js**

```js
// server/src/scrapers/names.js

export function convertLastFirst(name) {
  const commaIdx = name.indexOf(',');
  if (commaIdx === -1) return name;
  const last = name.substring(0, commaIdx).trim();
  const first = name.substring(commaIdx + 1).trim();
  return `${first} ${last}`;
}

export function reconcileName(name, replacements) {
  return replacements[name] || name;
}

export function loadReplacements(db) {
  const rows = db.prepare('SELECT alt_name, canonical_name FROM name_replacements').all();
  const map = {};
  for (const r of rows) map[r.alt_name] = r.canonical_name;
  return map;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd server && npx vitest run tests/scrapers/names.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/scrapers/names.js server/tests/scrapers/names.test.js
git commit -m "feat: name reconciliation helper with Last,First conversion"
```

### Task 8: FanGraphs scraper

**Files:**
- Create: `server/src/scrapers/fangraphs.js`
- Test: `server/tests/scrapers/fangraphs.test.js`

- [ ] **Step 1: Write failing test for CSV parsing (unit-testable without network)**

```js
// server/tests/scrapers/fangraphs.test.js
import { describe, it, expect } from 'vitest';
import { parsePitcherCsv, parseBatterCsv } from '../../src/scrapers/fangraphs.js';

const pitcherCsvSample = `Name,Team,GS,G,IP,W,L,QS,SV,HLD,H,ER,HR,SO,BB,WHIP,K/9,BB/9,ERA,FIP,WAR,RA9-WAR,playerid
"Gerrit Cole",NYY,32,32,200.0,16,6,24,0,0,160,65,22,230,45,1.02,10.35,2.03,2.93,3.10,5.2,5.5,13125`;

const batterCsvSample = `Name,Team,G,PA,AB,H,2B,3B,HR,R,RBI,BB,SO,HBP,SB,CS,AVG,OBP,SLG,OPS,wOBA,wRC+,BsR,Fld,Off,Def,WAR,playerid
"Mookie Betts",LAD,150,650,570,170,35,4,30,110,95,70,100,5,15,3,.298,.384,.540,.924,.380,155,3.5,5.0,35.0,7.0,7.5,13611`;

describe('parsePitcherCsv', () => {
  it('parses CSV into pitcher objects', async () => {
    const result = await parsePitcherCsv(pitcherCsvSample);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Gerrit Cole');
    expect(result[0].team).toBe('NYY');
    expect(result[0].IP).toBe(200);
    expect(result[0].SO).toBe(230);
    expect(result[0].player_id).toBe('13125');
  });
});

describe('parseBatterCsv', () => {
  it('parses CSV into batter objects', async () => {
    const result = await parseBatterCsv(batterCsvSample);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Mookie Betts');
    expect(result[0].HR).toBe(30);
    expect(result[0].SB).toBe(15);
  });
});
```

- [ ] **Step 2: Run test, verify fail**

- [ ] **Step 3: Implement fangraphs.js**

```js
// server/src/scrapers/fangraphs.js
import { parse } from 'csv-parse/sync';

function parseNumeric(val) {
  if (val === '' || val === null || val === undefined) return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

export async function parsePitcherCsv(csvText) {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  return records.map(r => ({
    name: r.Name, team: r.Team,
    GS: parseNumeric(r.GS), G: parseNumeric(r.G), IP: parseNumeric(r.IP),
    W: parseNumeric(r.W), L: parseNumeric(r.L), QS: parseNumeric(r.QS),
    SV: parseNumeric(r.SV), HLD: parseNumeric(r.HLD),
    H: parseNumeric(r.H), ER: parseNumeric(r.ER), HR: parseNumeric(r.HR),
    SO: parseNumeric(r.SO), BB: parseNumeric(r.BB),
    WHIP: parseNumeric(r.WHIP), K9: parseNumeric(r['K/9']), BB9: parseNumeric(r['BB/9']),
    ERA: parseNumeric(r.ERA), FIP: parseNumeric(r.FIP),
    WAR: parseNumeric(r.WAR), RA9WAR: parseNumeric(r['RA9-WAR']),
    player_id: r.playerid || null,
  }));
}

export async function parseBatterCsv(csvText) {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  return records.map(r => ({
    name: r.Name, team: r.Team,
    G: parseNumeric(r.G), PA: parseNumeric(r.PA), AB: parseNumeric(r.AB),
    H: parseNumeric(r.H), '2B': parseNumeric(r['2B']), '3B': parseNumeric(r['3B']),
    HR: parseNumeric(r.HR), R: parseNumeric(r.R), RBI: parseNumeric(r.RBI),
    BB: parseNumeric(r.BB), SO: parseNumeric(r.SO), HBP: parseNumeric(r.HBP),
    SB: parseNumeric(r.SB), CS: parseNumeric(r.CS),
    AVG: parseNumeric(r.AVG), OBP: parseNumeric(r.OBP), SLG: parseNumeric(r.SLG),
    OPS: parseNumeric(r.OPS), wOBA: parseNumeric(r.wOBA), wRC: parseNumeric(r['wRC+']),
    BsR: parseNumeric(r.BsR), Fld: parseNumeric(r.Fld),
    Off: parseNumeric(r.Off), Def: parseNumeric(r.Def), WAR: parseNumeric(r.WAR),
    player_id: r.playerid || null,
  }));
}

export async function fetchFanGraphs(db) {
  const email = process.env.FANGRAPHS_EMAIL;
  const password = process.env.FANGRAPHS_PASSWORD;
  if (!email || !password) throw new Error('FanGraphs credentials not configured in .env');

  const projSystem = db.prepare("SELECT value FROM app_config WHERE key='projection_system'").get()?.value || 'steamer';

  // Login
  const loginRes = await fetch('https://www.fangraphs.com/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) throw new Error(`FanGraphs login failed: ${loginRes.status}`);
  const cookies = loginRes.headers.getSetCookie?.() || [];
  const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');

  // Fetch pitchers
  const pitUrl = `https://www.fangraphs.com/api/projections?type=${projSystem}&stats=pit&pos=all&team=&lg=all&players=0&download=true`;
  const pitRes = await fetch(pitUrl, { headers: { Cookie: cookieHeader } });
  if (!pitRes.ok) throw new Error(`FanGraphs pitcher fetch failed: ${pitRes.status}`);
  const pitCsv = await pitRes.text();
  const pitchers = await parsePitcherCsv(pitCsv);

  // Fetch batters
  const batUrl = `https://www.fangraphs.com/api/projections?type=${projSystem}&stats=bat&pos=all&team=&lg=all&players=0&download=true`;
  const batRes = await fetch(batUrl, { headers: { Cookie: cookieHeader } });
  if (!batRes.ok) throw new Error(`FanGraphs batter fetch failed: ${batRes.status}`);
  const batCsv = await batRes.text();
  const batters = await parseBatterCsv(batCsv);

  // Write to DB
  db.prepare('DELETE FROM pitchers_raw').run();
  const insertPit = db.prepare(`INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB, WHIP, K9, BB9, ERA, FIP, WAR, RA9WAR, player_id) VALUES (@name, @team, @GS, @G, @IP, @W, @L, @QS, @SV, @HLD, @H, @ER, @HR, @SO, @BB, @WHIP, @K9, @BB9, @ERA, @FIP, @WAR, @RA9WAR, @player_id)`);
  for (const p of pitchers) insertPit.run(p);

  db.prepare('DELETE FROM batters_raw').run();
  const insertBat = db.prepare(`INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS, AVG, OBP, SLG, OPS, wOBA, wRC, BsR, Fld, Off, Def, WAR, player_id) VALUES (@name, @team, @G, @PA, @AB, @H, @2B, @3B, @HR, @R, @RBI, @BB, @SO, @HBP, @SB, @CS, @AVG, @OBP, @SLG, @OPS, @wOBA, @wRC, @BsR, @Fld, @Off, @Def, @WAR, @player_id)`);
  for (const b of batters) insertBat.run(b);

  return { pitchers: pitchers.length, batters: batters.length };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd server && npx vitest run tests/scrapers/fangraphs.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/scrapers/fangraphs.js server/tests/scrapers/fangraphs.test.js
git commit -m "feat: FanGraphs scraper with authenticated CSV download and parsing"
```

### Task 9: Baseball Savant scraper

**Files:**
- Create: `server/src/scrapers/savant.js`
- Test: `server/tests/scrapers/savant.test.js`

- [ ] **Step 1: Write failing test for CSV parsing and name conversion**

```js
// server/tests/scrapers/savant.test.js
import { describe, it, expect } from 'vitest';
import { parseSavantCsv } from '../../src/scrapers/savant.js';

const csvSample = `pitches,player_id,player_name,total_pitches,pitch_type,pitch_percent,ba,iso,babip,slg,woba,xwoba,xba,hits,abs,launch_speed,launch_angle,spin_rate,velocity
120,543037,"Verlander, Justin",2800,FF,55.2,.220,.150,.280,.370,.310,.300,.210,95,432,91.5,12.3,2350,95.8`;

describe('parseSavantCsv', () => {
  it('parses CSV and converts names from Last,First to First Last', async () => {
    const result = await parseSavantCsv(csvSample, 2024, 'regular');
    expect(result).toHaveLength(1);
    expect(result[0].player_name).toBe('Justin Verlander');
    expect(result[0].player_id).toBe('543037');
    expect(result[0].velocity).toBe(95.8);
    expect(result[0].season).toBe(2024);
    expect(result[0].season_type).toBe('regular');
  });
});
```

- [ ] **Step 2: Run test, verify fail**

- [ ] **Step 3: Implement savant.js**

```js
// server/src/scrapers/savant.js
import { parse } from 'csv-parse/sync';
import { convertLastFirst } from './names.js';

function num(val) {
  if (val === '' || val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

export async function parseSavantCsv(csvText, season, seasonType) {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  return records.map(r => ({
    player_id: r.player_id || null,
    player_name: convertLastFirst(r.player_name?.replace(/"/g, '') || ''),
    season,
    season_type: seasonType,
    pitch_type: r.pitch_type || null,
    velocity: num(r.velocity),
    spin_rate: num(r.spin_rate),
    whiff_pct: num(r.whiff_percent) ?? num(r.whiffs),
    barrel_pct: num(r.barrel_batted_rate),
    xwoba: num(r.xwoba),
  }));
}

export async function fetchSavant(db) {
  const fetches = [
    { season: 2024, gameType: 'R', seasonType: 'regular' },
    { season: 2025, gameType: 'ST', seasonType: 'spring' },
  ];

  db.prepare('DELETE FROM statcast_pitches').run();
  const insert = db.prepare(`INSERT INTO statcast_pitches
    (player_id, player_name, season, season_type, pitch_type, velocity, spin_rate, whiff_pct, barrel_pct, xwoba)
    VALUES (@player_id, @player_name, @season, @season_type, @pitch_type, @velocity, @spin_rate, @whiff_pct, @barrel_pct, @xwoba)`);

  let total = 0;
  for (const { season, gameType, seasonType } of fetches) {
    const url = `https://baseballsavant.mlb.com/leaderboard/custom?n=abs&stats=pit&qual=1&type=1&season=${season}&month=0&game_type=${gameType}&min=10&csv=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Savant fetch failed for ${season} ${seasonType}: ${res.status}`);
    const csv = await res.text();
    const rows = await parseSavantCsv(csv, season, seasonType);
    for (const r of rows) insert.run(r);
    total += rows.length;
  }

  return { rows: total };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd server && npx vitest run tests/scrapers/savant.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/scrapers/savant.js server/tests/scrapers/savant.test.js
git commit -m "feat: Baseball Savant scraper with name format normalization"
```

### Task 10: ESPN ADP scraper

**Files:**
- Create: `server/src/scrapers/espn.js`
- Test: `server/tests/scrapers/espn.test.js`

- [ ] **Step 1: Write failing test for JSON parsing**

```js
// server/tests/scrapers/espn.test.js
import { describe, it, expect } from 'vitest';
import { parseEspnResponse } from '../../src/scrapers/espn.js';

const sampleResponse = {
  players: [
    { player: { fullName: 'Shohei Ohtani', id: 39832 }, ratings: { '0': { positionalRanking: 1, totalRating: 450.5 } } },
    { player: { fullName: 'Mookie Betts', id: 33039 }, ratings: { '0': { positionalRanking: 3, totalRating: 380.2 } } },
  ],
};

describe('parseEspnResponse', () => {
  it('extracts name, adp_rank, projected_points', () => {
    const result = parseEspnResponse(sampleResponse);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Shohei Ohtani');
    expect(result[0].adp_rank).toBe(1);
    expect(result[0].projected_points).toBeCloseTo(450.5);
  });
});
```

- [ ] **Step 2: Run test, verify fail**

- [ ] **Step 3: Implement espn.js**

```js
// server/src/scrapers/espn.js
import { reconcileName, loadReplacements } from './names.js';

export function parseEspnResponse(json) {
  if (!json?.players) return [];
  return json.players.map(p => ({
    name: p.player?.fullName || '',
    adp_rank: p.ratings?.['0']?.positionalRanking ?? null,
    projected_points: p.ratings?.['0']?.totalRating ?? null,
  })).filter(p => p.name);
}

export async function fetchEspn(db) {
  const year = db.prepare("SELECT value FROM app_config WHERE key='season_year'").get()?.value || '2026';
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leaguedefaults/3?view=kona_player_info`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN fetch failed: ${res.status}`);
  const json = await res.json();
  const players = parseEspnResponse(json);

  const replacements = loadReplacements(db);
  db.prepare('DELETE FROM espn_adp').run();
  const insert = db.prepare('INSERT INTO espn_adp (name, adp_rank, projected_points) VALUES (?, ?, ?)');
  for (const p of players) {
    const name = reconcileName(p.name, replacements);
    insert.run(name, p.adp_rank, p.projected_points);
  }

  return { players: players.length };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd server && npx vitest run tests/scrapers/espn.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/scrapers/espn.js server/tests/scrapers/espn.test.js
git commit -m "feat: ESPN ADP scraper with JSON API parsing"
```

---

## Chunk 4: Backend API + Express Server

### Task 11: Express server and API routes

**Files:**
- Create: `server/src/index.js`
- Create: `server/src/routes/rankings.js`
- Create: `server/src/routes/draft.js`
- Create: `server/src/routes/config.js`
- Create: `server/src/routes/scrape.js`

- [ ] **Step 1: Write rankings route test**

```js
// server/tests/routes/rankings.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seedDefaults } from '../../src/seed.js';
import { createRankingsRouter } from '../../src/routes/rankings.js';
import express from 'express';
import { request } from 'undici';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('rankings API', () => {
  let db, app, server;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(readFileSync(join(__dirname, '..', '..', 'src', 'schema.sql'), 'utf8'));
    seedDefaults(db);

    db.prepare(`INSERT INTO combined_rankings (rank, name, team, position, score, adj_score, espn_adp, velocity_delta, per_game_efficiency, value_gap) VALUES (1, 'Player A', 'NYY', 'SP', 500, 600, 3, -1.2, 15.0, -2)`).run();
    db.prepare(`INSERT INTO combined_rankings (rank, name, team, position, score, adj_score, espn_adp, velocity_delta, per_game_efficiency, value_gap) VALUES (2, 'Player B', 'LAD', 'OF', 450, 490, 5, null, 3.2, -3)`).run();

    app = express();
    app.use('/api/rankings', createRankingsRouter(db));
    server = app.listen(0);
  });

  afterEach(() => { server.close(); db.close(); });

  it('GET /api/rankings returns all ranked players', async () => {
    const port = server.address().port;
    const res = await request(`http://localhost:${port}/api/rankings`);
    const body = await res.body.json();
    expect(res.statusCode).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].rank).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify fail**

- [ ] **Step 3: Implement routes**

```js
// server/src/routes/rankings.js
import { Router } from 'express';

export function createRankingsRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM combined_rankings ORDER BY rank').all();
    res.json(rows);
  });

  return router;
}
```

```js
// server/src/routes/draft.js
import { Router } from 'express';

export function createDraftRouter(db) {
  const router = Router();

  router.get('/sessions', (req, res) => {
    res.json(db.prepare('SELECT * FROM draft_sessions ORDER BY created_at DESC').all());
  });

  router.post('/sessions', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const result = db.prepare('INSERT INTO draft_sessions (name) VALUES (?)').run(name);
    res.json({ id: result.lastInsertRowid, name });
  });

  router.get('/sessions/:id/picks', (req, res) => {
    const picks = db.prepare('SELECT * FROM draft_picks WHERE session_id = ? ORDER BY pick_number').all(req.params.id);
    res.json(picks);
  });

  router.post('/sessions/:id/picks', (req, res) => {
    const { player_name, pick_number, drafted_by, player_notes } = req.body;
    if (!player_name || !pick_number) return res.status(400).json({ error: 'player_name and pick_number required' });
    const result = db.prepare(
      'INSERT INTO draft_picks (session_id, player_name, pick_number, drafted_by, player_notes) VALUES (?, ?, ?, ?, ?)'
    ).run(req.params.id, player_name, pick_number, drafted_by || null, player_notes || null);
    res.json({ id: result.lastInsertRowid });
  });

  router.put('/picks/:id', (req, res) => {
    const { player_notes } = req.body;
    db.prepare('UPDATE draft_picks SET player_notes = ? WHERE id = ?').run(player_notes, req.params.id);
    res.json({ ok: true });
  });

  router.delete('/picks/:id', (req, res) => {
    db.prepare('DELETE FROM draft_picks WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
```

```js
// server/src/routes/config.js
import { Router } from 'express';
import { rescoreAll } from '../scoring/rescore.js';

export function createConfigRouter(db) {
  const router = Router();

  router.get('/weights', (req, res) => {
    res.json(db.prepare('SELECT * FROM scoring_config ORDER BY category, stat').all());
  });

  router.put('/weights', (req, res) => {
    const { weights } = req.body; // [{ category, stat, weight }]
    const update = db.prepare('UPDATE scoring_config SET weight = ? WHERE category = ? AND stat = ?');
    for (const w of weights) update.run(w.weight, w.category, w.stat);
    rescoreAll(db);
    res.json({ ok: true });
  });

  router.get('/positions', (req, res) => {
    res.json(db.prepare('SELECT * FROM position_adjustments ORDER BY position').all());
  });

  router.put('/positions', (req, res) => {
    const { adjustments } = req.body; // [{ position, adjustment }]
    const update = db.prepare('UPDATE position_adjustments SET adjustment = ? WHERE position = ?');
    for (const a of adjustments) update.run(a.adjustment, a.position);
    rescoreAll(db);
    res.json({ ok: true });
  });

  router.get('/app', (req, res) => {
    res.json(db.prepare('SELECT * FROM app_config').all());
  });

  router.put('/app', (req, res) => {
    const { key, value } = req.body;
    db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run(key, value);
    res.json({ ok: true });
  });

  router.get('/name-replacements', (req, res) => {
    res.json(db.prepare('SELECT * FROM name_replacements ORDER BY alt_name').all());
  });

  router.post('/name-replacements', (req, res) => {
    const { alt_name, canonical_name } = req.body;
    const result = db.prepare('INSERT INTO name_replacements (alt_name, canonical_name) VALUES (?, ?)').run(alt_name, canonical_name);
    res.json({ id: result.lastInsertRowid });
  });

  router.delete('/name-replacements/:id', (req, res) => {
    db.prepare('DELETE FROM name_replacements WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
```

```js
// server/src/routes/scrape.js
import { Router } from 'express';
import { fetchFanGraphs } from '../scrapers/fangraphs.js';
import { fetchSavant } from '../scrapers/savant.js';
import { fetchEspn } from '../scrapers/espn.js';
import { rescoreAll } from '../scoring/rescore.js';

export function createScrapeRouter(db) {
  const router = Router();

  router.post('/fangraphs', async (req, res) => {
    try {
      const result = await fetchFanGraphs(db);
      rescoreAll(db);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/savant', async (req, res) => {
    try {
      const result = await fetchSavant(db);
      rescoreAll(db);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/espn', async (req, res) => {
    try {
      const result = await fetchEspn(db);
      rescoreAll(db);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/all', async (req, res) => {
    const results = {};
    try {
      results.fangraphs = await fetchFanGraphs(db);
    } catch (e) { results.fangraphs = { error: e.message }; }
    try {
      results.savant = await fetchSavant(db);
    } catch (e) { results.savant = { error: e.message }; }
    try {
      results.espn = await fetchEspn(db);
    } catch (e) { results.espn = { error: e.message }; }
    rescoreAll(db);
    res.json(results);
  });

  return router;
}
```

```js
// server/src/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createDb } from './db.js';
import { createRankingsRouter } from './routes/rankings.js';
import { createDraftRouter } from './routes/draft.js';
import { createConfigRouter } from './routes/config.js';
import { createScrapeRouter } from './routes/scrape.js';

const db = createDb();
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
```

- [ ] **Step 4: Run route tests, verify pass**

Run: `cd server && npx vitest run tests/routes/rankings.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/index.js server/src/routes/
git commit -m "feat: Express API with rankings, draft, config, and scraper routes"
```

---

## Chunk 5: Frontend Scaffolding + Rankings View

### Task 12: Vite + React + Tailwind scaffolding

**Files:**
- Create: `client/index.html`
- Create: `client/vite.config.js`
- Create: `client/tailwind.config.js`
- Create: `client/postcss.config.js`
- Create: `client/src/main.jsx`
- Create: `client/src/App.jsx`
- Create: `client/src/index.css`
- Create: `client/src/api.js`

- [ ] **Step 1: Create Vite config with proxy**

```js
// client/vite.config.js
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

- [ ] **Step 2: Create Tailwind + PostCSS config**

```js
// client/tailwind.config.js
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: [],
};
```

```js
// client/postcss.config.js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [ ] **Step 3: Create index.html**

```html
<!-- client/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Fantasy Baseball Draft Board</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
```

- [ ] **Step 4: Create main.jsx, App.jsx, index.css, api.js**

```css
/* client/src/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

```jsx
// client/src/main.jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
```

```jsx
// client/src/App.jsx
import { Routes, Route, NavLink } from 'react-router-dom';
import Rankings from './pages/Rankings';
import Draft from './pages/Draft';
import Settings from './pages/Settings';

function Nav() {
  const linkClass = ({ isActive }) =>
    `px-4 py-2 text-sm font-medium ${isActive ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700'}`;

  return (
    <nav className="flex gap-2 border-b border-gray-200 px-4 bg-white">
      <NavLink to="/" end className={linkClass}>Rankings</NavLink>
      <NavLink to="/draft" className={linkClass}>Draft</NavLink>
      <NavLink to="/settings" className={linkClass}>Settings</NavLink>
    </nav>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <main className="p-4">
        <Routes>
          <Route path="/" element={<Rankings />} />
          <Route path="/draft" element={<Draft />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
```

```js
// client/src/api.js
const BASE = '/api';

async function json(url, opts) {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  getRankings: () => json('/rankings'),
  getDraftSessions: () => json('/draft/sessions'),
  createDraftSession: (name) => json('/draft/sessions', { method: 'POST', body: JSON.stringify({ name }) }),
  getDraftPicks: (sessionId) => json(`/draft/sessions/${sessionId}/picks`),
  createDraftPick: (sessionId, pick) => json(`/draft/sessions/${sessionId}/picks`, { method: 'POST', body: JSON.stringify(pick) }),
  updatePickNotes: (pickId, notes) => json(`/draft/picks/${pickId}`, { method: 'PUT', body: JSON.stringify({ player_notes: notes }) }),
  deletePick: (pickId) => json(`/draft/picks/${pickId}`, { method: 'DELETE' }),
  getWeights: () => json('/config/weights'),
  updateWeights: (weights) => json('/config/weights', { method: 'PUT', body: JSON.stringify({ weights }) }),
  getPositionAdj: () => json('/config/positions'),
  updatePositionAdj: (adj) => json('/config/positions', { method: 'PUT', body: JSON.stringify({ adjustments: adj }) }),
  getAppConfig: () => json('/config/app'),
  updateAppConfig: (key, value) => json('/config/app', { method: 'PUT', body: JSON.stringify({ key, value }) }),
  getNameReplacements: () => json('/config/name-replacements'),
  addNameReplacement: (alt, canonical) => json('/config/name-replacements', { method: 'POST', body: JSON.stringify({ alt_name: alt, canonical_name: canonical }) }),
  deleteNameReplacement: (id) => json(`/config/name-replacements/${id}`, { method: 'DELETE' }),
  scrape: (source) => json(`/scrape/${source}`, { method: 'POST' }),
};
```

- [ ] **Step 5: Verify dev server starts**

Run: `cd client && npx vite --host`
Expected: Dev server starts on port 5173

- [ ] **Step 6: Commit**

```bash
git add client/
git commit -m "feat: React + Vite + Tailwind frontend scaffolding with routing and API client"
```

### Task 13: Rankings page with PlayerTable

**Files:**
- Create: `client/src/pages/Rankings.jsx`
- Create: `client/src/components/PlayerTable.jsx`
- Create: `client/src/components/PositionFilter.jsx`
- Create: `client/src/components/SearchBar.jsx`

- [ ] **Step 1: Create PlayerTable component**

```jsx
// client/src/components/PlayerTable.jsx
import { useMemo } from 'react';
import {
  useReactTable, getCoreRowModel, getSortedRowModel,
  getFilteredRowModel, flexRender,
} from '@tanstack/react-table';

const defaultColumns = [
  { accessorKey: 'rank', header: 'Rank', size: 60 },
  { accessorKey: 'name', header: 'Name', size: 180 },
  { accessorKey: 'team', header: 'Team', size: 60 },
  { accessorKey: 'position', header: 'Pos', size: 80 },
  { accessorKey: 'score', header: 'Score', size: 80, cell: ({ getValue }) => getValue()?.toFixed(1) },
  { accessorKey: 'adj_score', header: 'Adj Score', size: 90, cell: ({ getValue }) => getValue()?.toFixed(1) },
  { accessorKey: 'espn_adp', header: 'ESPN ADP', size: 80 },
  { accessorKey: 'value_gap', header: 'Value', size: 70 },
  { accessorKey: 'velocity_delta', header: 'Velo Δ', size: 70, cell: ({ getValue }) => { const v = getValue(); return v != null ? (v > 0 ? '+' : '') + v.toFixed(1) : ''; } },
  { accessorKey: 'per_game_efficiency', header: 'Eff', size: 60, cell: ({ getValue }) => getValue()?.toFixed(2) },
];

export default function PlayerTable({ data, globalFilter, positionFilter, columns = defaultColumns, onRowClick, rowClassName }) {
  const filteredData = useMemo(() => {
    let d = data;
    if (positionFilter) {
      d = d.filter(r => r.position?.includes(positionFilter));
    }
    return d;
  }, [data, positionFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { globalFilter },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: 'includesString',
  });

  return (
    <div className="overflow-auto max-h-[80vh] border rounded">
      <table className="w-full text-sm">
        <thead className="bg-gray-100 sticky top-0">
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id}>
              {hg.headers.map(h => (
                <th key={h.id} className="px-2 py-1 text-left cursor-pointer select-none"
                    style={{ width: h.getSize() }}
                    onClick={h.column.getToggleSortingHandler()}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: ' ↑', desc: ' ↓' }[h.column.getIsSorted()] ?? ''}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => (
            <tr key={row.id}
                className={`border-t hover:bg-blue-50 cursor-pointer ${rowClassName?.(row.original) || ''}`}
                onClick={() => onRowClick?.(row.original)}>
              {row.getVisibleCells().map(cell => (
                <td key={cell.id} className="px-2 py-1">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Create PositionFilter and SearchBar**

```jsx
// client/src/components/PositionFilter.jsx
const POSITIONS = ['All', 'SP', 'RP', 'C', '1B', '2B', '3B', 'SS', 'OF'];

export default function PositionFilter({ value, onChange }) {
  return (
    <div className="flex gap-1">
      {POSITIONS.map(p => (
        <button key={p}
          className={`px-3 py-1 text-xs rounded ${(p === 'All' && !value) || value === p ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
          onClick={() => onChange(p === 'All' ? null : p)}>
          {p}
        </button>
      ))}
    </div>
  );
}
```

```jsx
// client/src/components/SearchBar.jsx
export default function SearchBar({ value, onChange }) {
  return (
    <input
      type="text"
      placeholder="Search players..."
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border rounded px-3 py-1 text-sm w-64"
    />
  );
}
```

- [ ] **Step 3: Create Rankings page**

```jsx
// client/src/pages/Rankings.jsx
import { useState, useEffect } from 'react';
import { api } from '../api';
import PlayerTable from '../components/PlayerTable';
import PositionFilter from '../components/PositionFilter';
import SearchBar from '../components/SearchBar';

export default function Rankings() {
  const [players, setPlayers] = useState([]);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getRankings().then(setPlayers).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-4 text-gray-500">Loading rankings...</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold">Rankings</h1>
        <SearchBar value={search} onChange={setSearch} />
        <PositionFilter value={posFilter} onChange={setPosFilter} />
      </div>
      <PlayerTable data={players} globalFilter={search} positionFilter={posFilter} />
    </div>
  );
}
```

- [ ] **Step 4: Create placeholder pages for Draft and Settings**

```jsx
// client/src/pages/Draft.jsx
export default function Draft() {
  return <div className="p-4 text-gray-500">Draft tracker — coming next</div>;
}
```

```jsx
// client/src/pages/Settings.jsx
export default function Settings() {
  return <div className="p-4 text-gray-500">Settings — coming next</div>;
}
```

- [ ] **Step 5: Verify full stack works**

Run server: `cd server && node src/index.js`
Run client: `cd client && npx vite`
Open: http://localhost:5173 — should show empty Rankings table

- [ ] **Step 6: Commit**

```bash
git add client/src/
git commit -m "feat: Rankings page with sortable/filterable PlayerTable component"
```

---

## Chunk 6: Draft Tracker + Settings Views

### Task 14: Draft Tracker page

**Files:**
- Modify: `client/src/pages/Draft.jsx`
- Create: `client/src/components/RosterSidebar.jsx`
- Create: `client/src/components/SessionSelector.jsx`

- [ ] **Step 1: Create SessionSelector**

```jsx
// client/src/components/SessionSelector.jsx
import { useState } from 'react';

export default function SessionSelector({ sessions, activeId, onSelect, onCreate }) {
  const [newName, setNewName] = useState('');
  const [showNew, setShowNew] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <select value={activeId || ''} onChange={e => onSelect(Number(e.target.value))}
        className="border rounded px-2 py-1 text-sm">
        {sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {showNew ? (
        <form onSubmit={e => { e.preventDefault(); onCreate(newName); setNewName(''); setShowNew(false); }}
          className="flex gap-1">
          <input value={newName} onChange={e => setNewName(e.target.value)}
            placeholder="Session name" className="border rounded px-2 py-1 text-sm" autoFocus />
          <button type="submit" className="px-2 py-1 bg-blue-600 text-white text-xs rounded">Create</button>
        </form>
      ) : (
        <button onClick={() => setShowNew(true)} className="px-2 py-1 bg-gray-200 text-xs rounded hover:bg-gray-300">+ New</button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create RosterSidebar**

```jsx
// client/src/components/RosterSidebar.jsx
export default function RosterSidebar({ picks, rankings }) {
  const myPicks = picks.filter(p => p.drafted_by === 'me');
  const grouped = {};
  for (const pick of myPicks) {
    const player = rankings.find(r => r.name === pick.player_name);
    const pos = player?.position || 'Unknown';
    if (!grouped[pos]) grouped[pos] = [];
    grouped[pos].push({ ...pick, position: pos });
  }

  return (
    <div className="w-56 border-l bg-white p-3 overflow-auto max-h-[80vh]">
      <h3 className="font-bold text-sm mb-2">My Roster ({myPicks.length})</h3>
      {Object.entries(grouped).sort().map(([pos, players]) => (
        <div key={pos} className="mb-2">
          <div className="text-xs font-semibold text-gray-500 uppercase">{pos}</div>
          {players.map(p => (
            <div key={p.id} className="text-sm">#{p.pick_number} {p.player_name}</div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Build full Draft page**

```jsx
// client/src/pages/Draft.jsx
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import PlayerTable from '../components/PlayerTable';
import PositionFilter from '../components/PositionFilter';
import SearchBar from '../components/SearchBar';
import SessionSelector from '../components/SessionSelector';
import RosterSidebar from '../components/RosterSidebar';

export default function Draft() {
  const [rankings, setRankings] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [picks, setPicks] = useState([]);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState(null);
  const [hideTaken, setHideTaken] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.getRankings(), api.getDraftSessions()]).then(([r, s]) => {
      setRankings(r);
      setSessions(s);
      if (s.length > 0) setActiveSession(s[0].id);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (activeSession) api.getDraftPicks(activeSession).then(setPicks);
  }, [activeSession]);

  const takenNames = new Set(picks.map(p => p.player_name));
  const nextPick = picks.length > 0 ? Math.max(...picks.map(p => p.pick_number)) + 1 : 1;

  const displayData = hideTaken ? rankings.filter(r => !takenNames.has(r.name)) : rankings.map(r => ({
    ...r, _taken: takenNames.has(r.name),
  }));

  const handleDraft = useCallback(async (player) => {
    if (!activeSession) return;
    const drafted_by = window.prompt(`Who drafted ${player.name}? (leave blank for "me")`) ?? 'me';
    await api.createDraftPick(activeSession, {
      player_name: player.name,
      pick_number: nextPick,
      drafted_by: drafted_by || 'me',
    });
    setPicks(await api.getDraftPicks(activeSession));
  }, [activeSession, nextPick]);

  const handleCreateSession = async (name) => {
    const s = await api.createDraftSession(name);
    setSessions(prev => [{ ...s, created_at: new Date().toISOString() }, ...prev]);
    setActiveSession(s.id);
  };

  if (loading) return <div className="p-4 text-gray-500">Loading...</div>;

  return (
    <div className="flex">
      <div className="flex-1 space-y-3">
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-lg font-bold">Draft</h1>
          <SessionSelector sessions={sessions} activeId={activeSession}
            onSelect={setActiveSession} onCreate={handleCreateSession} />
          <SearchBar value={search} onChange={setSearch} />
          <PositionFilter value={posFilter} onChange={setPosFilter} />
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={hideTaken} onChange={e => setHideTaken(e.target.checked)} />
            Hide taken
          </label>
          <span className="text-sm text-gray-500">Next pick: #{nextPick}</span>
        </div>
        <PlayerTable data={displayData} globalFilter={search} positionFilter={posFilter}
          onRowClick={handleDraft}
          rowClassName={r => r._taken ? 'opacity-40 line-through' : ''} />
      </div>
      <RosterSidebar picks={picks} rankings={rankings} />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Draft.jsx client/src/components/SessionSelector.jsx client/src/components/RosterSidebar.jsx
git commit -m "feat: Draft Tracker with session management, pick tracking, and roster sidebar"
```

### Task 15: Settings page

**Files:**
- Modify: `client/src/pages/Settings.jsx`
- Create: `client/src/components/WeightsEditor.jsx`
- Create: `client/src/components/DataRefresh.jsx`
- Create: `client/src/components/NameReplacements.jsx`

- [ ] **Step 1: Create WeightsEditor**

```jsx
// client/src/components/WeightsEditor.jsx
import { useState } from 'react';

export default function WeightsEditor({ weights, onSave }) {
  const [local, setLocal] = useState(weights);
  const [dirty, setDirty] = useState(false);

  const pitcherW = local.filter(w => w.category === 'pitcher');
  const batterW = local.filter(w => w.category === 'batter');

  const update = (category, stat, value) => {
    setLocal(prev => prev.map(w =>
      w.category === category && w.stat === stat ? { ...w, weight: Number(value) } : w
    ));
    setDirty(true);
  };

  const save = () => { onSave(local); setDirty(false); };

  const renderTable = (title, items) => (
    <div>
      <h3 className="font-semibold text-sm mb-1">{title}</h3>
      <table className="text-sm border">
        <tbody>
          {items.map(w => (
            <tr key={w.stat} className="border-t">
              <td className="px-2 py-1 font-mono">{w.stat}</td>
              <td className="px-2 py-1">
                <input type="number" step="0.1" value={w.weight}
                  onChange={e => update(w.category, w.stat, e.target.value)}
                  className="border rounded px-1 py-0.5 w-20 text-right" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex gap-6">
        {renderTable('Pitcher Weights', pitcherW)}
        {renderTable('Batter Weights', batterW)}
      </div>
      {dirty && <button onClick={save} className="px-3 py-1 bg-blue-600 text-white text-sm rounded">Save & Rescore</button>}
    </div>
  );
}
```

- [ ] **Step 2: Create DataRefresh**

```jsx
// client/src/components/DataRefresh.jsx
import { useState } from 'react';
import { api } from '../api';

const SOURCES = [
  { key: 'fangraphs', label: 'FanGraphs Projections' },
  { key: 'savant', label: 'Baseball Savant' },
  { key: 'espn', label: 'ESPN ADP' },
];

export default function DataRefresh() {
  const [status, setStatus] = useState({});

  const run = async (source) => {
    setStatus(s => ({ ...s, [source]: 'loading' }));
    try {
      const result = await api.scrape(source);
      setStatus(s => ({ ...s, [source]: `Done: ${JSON.stringify(result)}` }));
    } catch (e) {
      setStatus(s => ({ ...s, [source]: `Error: ${e.message}` }));
    }
  };

  const runAll = async () => {
    setStatus({ all: 'loading' });
    try {
      const result = await api.scrape('all');
      setStatus({ all: `Done: ${JSON.stringify(result)}` });
    } catch (e) {
      setStatus({ all: `Error: ${e.message}` });
    }
  };

  return (
    <div className="space-y-2">
      {SOURCES.map(s => (
        <div key={s.key} className="flex items-center gap-3">
          <button onClick={() => run(s.key)}
            disabled={status[s.key] === 'loading'}
            className="px-3 py-1 bg-gray-200 text-sm rounded hover:bg-gray-300 disabled:opacity-50">
            Refresh {s.label}
          </button>
          {status[s.key] && <span className="text-xs text-gray-500">{status[s.key]}</span>}
        </div>
      ))}
      <button onClick={runAll} disabled={status.all === 'loading'}
        className="px-3 py-1 bg-blue-600 text-white text-sm rounded disabled:opacity-50">
        Refresh All
      </button>
      {status.all && <span className="text-xs text-gray-500">{status.all}</span>}
    </div>
  );
}
```

- [ ] **Step 3: Create NameReplacements**

```jsx
// client/src/components/NameReplacements.jsx
import { useState } from 'react';

export default function NameReplacements({ replacements, onAdd, onDelete }) {
  const [alt, setAlt] = useState('');
  const [canonical, setCanonical] = useState('');

  const handleAdd = (e) => {
    e.preventDefault();
    if (alt && canonical) { onAdd(alt, canonical); setAlt(''); setCanonical(''); }
  };

  return (
    <div className="space-y-2">
      <table className="text-sm border w-full">
        <thead><tr className="bg-gray-100"><th className="px-2 py-1 text-left">Alternate Name</th><th className="px-2 py-1 text-left">Canonical Name</th><th></th></tr></thead>
        <tbody>
          {replacements.map(r => (
            <tr key={r.id} className="border-t">
              <td className="px-2 py-1">{r.alt_name}</td>
              <td className="px-2 py-1">{r.canonical_name}</td>
              <td className="px-2 py-1"><button onClick={() => onDelete(r.id)} className="text-red-500 text-xs">×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={handleAdd} className="flex gap-2">
        <input value={alt} onChange={e => setAlt(e.target.value)} placeholder="Alternate" className="border rounded px-2 py-1 text-sm" />
        <input value={canonical} onChange={e => setCanonical(e.target.value)} placeholder="Canonical" className="border rounded px-2 py-1 text-sm" />
        <button type="submit" className="px-2 py-1 bg-gray-200 text-sm rounded">Add</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Wire up Settings page**

```jsx
// client/src/pages/Settings.jsx
import { useState, useEffect } from 'react';
import { api } from '../api';
import WeightsEditor from '../components/WeightsEditor';
import DataRefresh from '../components/DataRefresh';
import NameReplacements from '../components/NameReplacements';

export default function Settings() {
  const [weights, setWeights] = useState([]);
  const [posAdj, setPosAdj] = useState([]);
  const [config, setConfig] = useState([]);
  const [nameReps, setNameReps] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => Promise.all([
    api.getWeights(), api.getPositionAdj(), api.getAppConfig(), api.getNameReplacements(),
  ]).then(([w, p, c, n]) => { setWeights(w); setPosAdj(p); setConfig(c); setNameReps(n); });

  useEffect(() => { load().finally(() => setLoading(false)); }, []);

  const replacementLevel = config.find(c => c.key === 'replacement_level')?.value || '237';
  const projSystem = config.find(c => c.key === 'projection_system')?.value || 'steamer';

  if (loading) return <div className="p-4 text-gray-500">Loading settings...</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-lg font-bold">Settings</h1>

      <section>
        <h2 className="font-semibold mb-2">Scoring Weights</h2>
        <WeightsEditor weights={weights} onSave={async (w) => { await api.updateWeights(w); load(); }} />
      </section>

      <section>
        <h2 className="font-semibold mb-2">Position Adjustments</h2>
        <div className="flex gap-3 flex-wrap">
          {posAdj.map(a => (
            <div key={a.position} className="flex items-center gap-1">
              <span className="text-sm font-mono w-8">{a.position}</span>
              <input type="number" value={a.adjustment}
                onChange={e => setPosAdj(prev => prev.map(p => p.position === a.position ? { ...p, adjustment: Number(e.target.value) } : p))}
                className="border rounded px-1 py-0.5 w-16 text-right text-sm" />
            </div>
          ))}
          <button onClick={async () => { await api.updatePositionAdj(posAdj); load(); }}
            className="px-3 py-1 bg-blue-600 text-white text-sm rounded">Save</button>
        </div>
      </section>

      <section>
        <h2 className="font-semibold mb-2">General</h2>
        <div className="flex gap-4 items-center text-sm">
          <label>Replacement Level:
            <input type="number" value={replacementLevel}
              onChange={e => api.updateAppConfig('replacement_level', e.target.value)}
              className="border rounded px-2 py-1 w-20 ml-1" />
          </label>
          <label>Projection System:
            <select value={projSystem}
              onChange={e => api.updateAppConfig('projection_system', e.target.value)}
              className="border rounded px-2 py-1 ml-1">
              <option value="steamer">Steamer</option>
              <option value="zips">ZiPS</option>
            </select>
          </label>
        </div>
      </section>

      <section>
        <h2 className="font-semibold mb-2">Data Sources</h2>
        <DataRefresh />
      </section>

      <section>
        <h2 className="font-semibold mb-2">Name Replacements</h2>
        <NameReplacements replacements={nameReps}
          onAdd={async (alt, canonical) => { await api.addNameReplacement(alt, canonical); load(); }}
          onDelete={async (id) => { await api.deleteNameReplacement(id); load(); }} />
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Settings.jsx client/src/components/WeightsEditor.jsx client/src/components/DataRefresh.jsx client/src/components/NameReplacements.jsx
git commit -m "feat: Settings page with weights editor, data refresh, and name replacements"
```

---

## Chunk 7: Dev Server Config + Final Wiring

### Task 16: Create launch.json and .env

**Files:**
- Create: `.claude/launch.json`
- Create: `.env`

- [ ] **Step 1: Create launch.json**

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "server",
      "runtimeExecutable": "node",
      "runtimeArgs": ["--watch", "server/src/index.js"],
      "port": 3001
    },
    {
      "name": "client",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["vite", "--port", "5173"],
      "port": 5173
    }
  ]
}
```

- [ ] **Step 2: Create .env with credentials**

```
FANGRAPHS_EMAIL=adam.kalinich@gmail.com
FANGRAPHS_PASSWORD=non-combatant
```

- [ ] **Step 3: Commit launch.json only (not .env)**

```bash
git add .claude/launch.json
git commit -m "feat: dev server launch configurations for server and client"
```

### Task 17: End-to-end smoke test

- [ ] **Step 1: Start both servers**

Run: `preview_start` for both `server` and `client`

- [ ] **Step 2: Navigate to Settings, click "Refresh All"**

Verify data scrapers run and return counts.

- [ ] **Step 3: Navigate to Rankings**

Verify ranked player list populates with scored data.

- [ ] **Step 4: Navigate to Draft, create a session, draft a player**

Verify pick appears in roster sidebar.

- [ ] **Step 5: Final commit with any fixes**

```bash
git add -A
git commit -m "fix: end-to-end smoke test fixes"
```
