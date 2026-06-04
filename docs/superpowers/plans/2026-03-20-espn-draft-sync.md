# ESPN Draft WebSocket Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-sync live draft picks from ESPN's WebSocket stream into the draft tracker, so picks appear in real-time without manual entry.

**Architecture:** The server connects to ESPN's draft WebSocket at `wss://fantasydraft.espn.com` using a co-manager account's credentials. It receives `SELECTED {teamId} {playerId} {slotId}` messages, maps playerIds to names via the `espn_rank` table, maps teamIds to owner names via the ESPN API, and inserts picks into `draft_picks`. The client polls for picks every 3 seconds and displays a sync status bar. Manual entry remains fully functional as a fallback.

**Tech Stack:** Node.js `ws` library for WebSocket, existing Express/SQLite/React stack.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `server/src/draft-sync.js` | Create | WebSocket client, message parsing, pick insertion |
| `server/tests/draft-sync.test.js` | Create | Unit tests for message parsing, pick mapping, playerMap building |
| `server/src/routes/draft.js` | Modify | Add `/sync/start`, `/sync/stop`, `/sync/status` endpoints |
| `server/src/scrapers/espn.js` | Modify | Store `espn_id` alongside name during scrape |
| `server/src/schema.sql` | Modify | Add `espn_id` column to `espn_rank` table |
| `server/src/db.js` | Modify | Add ALTER TABLE migration for existing DBs |
| `server/src/seed.js` | Modify | Seed `espn_league_id` and `espn_team_id` config |
| `client/src/pages/Draft.jsx` | Modify | Add polling interval + sync status bar |
| `client/src/api.js` | Modify | Add sync API methods |
| `server/package.json` | Modify | Add `ws` dependency |

---

### Task 1: Add `ws` dependency

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Install ws**

```bash
cd server && npm install ws
```

- [ ] **Step 2: Commit**

```bash
git add server/package.json server/package-lock.json
git commit -m "chore: add ws dependency for ESPN draft WebSocket"
```

---

### Task 2: Store ESPN player IDs during scrape

**Files:**
- Modify: `server/src/schema.sql:166-171`
- Modify: `server/src/db.js`
- Modify: `server/src/scrapers/espn.js:14-31,66-81`
- Test: `server/tests/scrapers/espn.test.js`

- [ ] **Step 1: Write failing test — espn_id is stored**

Add to `server/tests/scrapers/espn.test.js`:

```js
it('extracts espn_id from player.id', () => {
  const result = parseEspnResponse(sampleResponse);
  const ohtani = result.find(p => p.name === 'Shohei Ohtani');
  expect(ohtani.espn_id).toBe(39832);
  const mookie = result.find(p => p.name === 'Mookie Betts');
  expect(mookie.espn_id).toBe(33039);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && npx vitest run tests/scrapers/espn.test.js
```
Expected: FAIL — `espn_id` is undefined

- [ ] **Step 3: Add espn_id to parseEspnResponse**

In `server/src/scrapers/espn.js`, modify the return in `parseEspnResponse` (line 24-29):

```js
return {
  name: p.player?.fullName || '',
  espn_id: p.player?.id ?? p.id ?? null,
  adp_rank: p.player?.draftRanksByRankType?.STANDARD?.rank ?? null,
  projected_points: p.ratings?.['0']?.totalRating ?? null,
  positions,
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && npx vitest run tests/scrapers/espn.test.js
```

- [ ] **Step 5: Add espn_id column to schema and migration**

In `server/src/schema.sql`, update the `espn_rank` table (line 166-171):

```sql
CREATE TABLE IF NOT EXISTS espn_rank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  espn_id INTEGER,
  adp_rank INTEGER,
  projected_points REAL
);
```

In `server/src/db.js`, add ALTER TABLE after `seedDefaults(db)` (line 21):

```js
seedDefaults(db);

// Migration: add espn_id column if missing (for existing DBs)
try { db.exec('ALTER TABLE espn_rank ADD COLUMN espn_id INTEGER'); } catch (e) { /* column already exists */ }
```

- [ ] **Step 6: Store espn_id in INSERT**

In `server/src/scrapers/espn.js`, update the INSERT statement (line 66-67):

```js
const insertAdp = db.prepare(
  'INSERT INTO espn_rank (name, espn_id, adp_rank, projected_points) VALUES (?, ?, ?, ?)'
);
```

And the `.run()` call (line 81):

```js
insertAdp.run(name, p.espn_id, p.adp_rank, p.projected_points);
```

- [ ] **Step 7: Run all tests**

```bash
cd server && npx vitest run
```

- [ ] **Step 8: Commit**

```bash
git add server/src/schema.sql server/src/db.js server/src/scrapers/espn.js server/tests/scrapers/espn.test.js
git commit -m "feat: store ESPN player IDs in espn_rank table for draft sync"
```

---

### Task 3: Seed ESPN league config

**Files:**
- Modify: `server/src/seed.js:35-40`

- [ ] **Step 1: Add config seeds**

Add after line 40 in `server/src/seed.js`:

```js
insertConfig.run('espn_league_id', '133164');
insertConfig.run('espn_team_id', '7');
```

- [ ] **Step 2: Run tests**

```bash
cd server && npx vitest run
```

- [ ] **Step 3: Commit**

```bash
git add server/src/seed.js
git commit -m "chore: seed ESPN league/team IDs in app_config"
```

---

### Task 4: Build draft sync module — message parsing

**Files:**
- Create: `server/src/draft-sync.js`
- Create: `server/tests/draft-sync.test.js`

This is the core logic. The module has three responsibilities:
1. Parse WebSocket messages (`parseMessage`)
2. Map ESPN data to draft picks (`mapPick`)
3. Manage the WebSocket connection (`DraftSync` class)

- [ ] **Step 1: Write tests for message parsing**

Create `server/tests/draft-sync.test.js`:

```js
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseMessage, mapPick, buildPlayerMap } from '../src/draft-sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseMessage', () => {
  it('parses SELECTED messages', () => {
    const result = parseMessage('SELECTED 8 35983 5');
    expect(result).toEqual({ type: 'SELECTED', teamId: 8, playerId: 35983, slotId: 5 });
  });

  it('parses SELECTING messages', () => {
    const result = parseMessage('SELECTING 6 30000');
    expect(result).toEqual({ type: 'SELECTING', teamId: 6, timeMs: 30000 });
  });

  it('parses CLOCK messages', () => {
    const result = parseMessage('CLOCK 6 28877 8');
    expect(result).toEqual({ type: 'CLOCK', teamId: 6, timeMs: 28877, pickIndex: 8 });
  });

  it('returns null for unknown messages', () => {
    expect(parseMessage('PONG PING%201774037721175')).toEqual({ type: 'PONG' });
    expect(parseMessage('AUTOSUGGEST 35983')).toEqual({ type: 'AUTOSUGGEST' });
    expect(parseMessage('')).toBeNull();
  });

  it('handles messages with trailing newlines', () => {
    const result = parseMessage('SELECTED 10 42404 8\n');
    expect(result).toEqual({ type: 'SELECTED', teamId: 10, playerId: 42404, slotId: 8 });
  });
});

describe('mapPick', () => {
  const playerMap = { 35983: 'Aaron Judge', 42404: 'Bobby Witt Jr.' };
  const teamMap = { 7: 'me', 8: 'Tom', 10: 'Carl' };

  it('maps a SELECTED message to a draft pick', () => {
    const msg = { type: 'SELECTED', teamId: 8, playerId: 35983, slotId: 5 };
    const result = mapPick(msg, playerMap, teamMap, 1);
    expect(result).toEqual({
      player_name: 'Aaron Judge',
      pick_number: 1,
      drafted_by: 'Tom',
    });
  });

  it('labels own team picks as "me"', () => {
    const msg = { type: 'SELECTED', teamId: 7, playerId: 42404, slotId: 4 };
    const result = mapPick(msg, playerMap, teamMap, 3);
    expect(result).toEqual({
      player_name: 'Bobby Witt Jr.',
      pick_number: 3,
      drafted_by: 'me',
    });
  });

  it('uses "Unknown (#id)" for unmapped players', () => {
    const msg = { type: 'SELECTED', teamId: 8, playerId: 99999, slotId: 5 };
    const result = mapPick(msg, playerMap, teamMap, 1);
    expect(result.player_name).toBe('Unknown (#99999)');
  });

  it('uses team ID string for unmapped teams', () => {
    const msg = { type: 'SELECTED', teamId: 99, playerId: 35983, slotId: 5 };
    const result = mapPick(msg, playerMap, teamMap, 1);
    expect(result.drafted_by).toBe('Team 99');
  });
});

describe('buildPlayerMap', () => {
  it('builds espn_id → name map from DB', () => {
    const db = new Database(':memory:');
    const schema = readFileSync(join(__dirname, '..', 'src', 'schema.sql'), 'utf8');
    db.exec(schema);
    // Add espn_id column if not in schema yet
    try { db.exec('ALTER TABLE espn_rank ADD COLUMN espn_id INTEGER'); } catch (e) {}
    db.prepare('INSERT INTO espn_rank (name, espn_id, adp_rank) VALUES (?, ?, ?)').run('Aaron Judge', 33192, 1);
    db.prepare('INSERT INTO espn_rank (name, espn_id, adp_rank) VALUES (?, ?, ?)').run('Mookie Betts', 33039, 5);
    db.prepare('INSERT INTO espn_rank (name, adp_rank) VALUES (?, ?)').run('No ESPN ID', 99);

    const map = buildPlayerMap(db);
    expect(map[33192]).toBe('Aaron Judge');
    expect(map[33039]).toBe('Mookie Betts');
    expect(Object.keys(map).length).toBe(2); // excludes null espn_id
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && npx vitest run tests/draft-sync.test.js
```
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement parseMessage and mapPick**

Create `server/src/draft-sync.js`:

```js
import WebSocket from 'ws';

// Parse a WebSocket message from ESPN's draft stream
//
//   SELECTED {teamId} {playerId} {slotId}  — a pick was made
//   SELECTING {teamId} {timeMs}            — team is on the clock
//   CLOCK {teamId} {timeMs} {pickIndex}    — clock tick
//   INIT ...                                — initial binary state
//   TOKEN ...                               — auth confirmation
//   PONG ...                                — keepalive
//   AUTOSUGGEST {playerId}                 — auto-draft suggestion
//
export function parseMessage(raw) {
  if (!raw) return null;
  const msg = raw.trim();
  const parts = msg.split(' ');
  const type = parts[0];

  switch (type) {
    case 'SELECTED':
      return { type, teamId: Number(parts[1]), playerId: Number(parts[2]), slotId: Number(parts[3]) };
    case 'SELECTING':
      return { type, teamId: Number(parts[1]), timeMs: Number(parts[2]) };
    case 'CLOCK':
      return { type, teamId: Number(parts[1]), timeMs: Number(parts[2]), pickIndex: Number(parts[3]) };
    default:
      return { type };
  }
}

// Map a SELECTED message to a draft_picks row
export function mapPick(msg, playerMap, teamMap, pickNumber) {
  return {
    player_name: playerMap[msg.playerId] || `Unknown (#${msg.playerId})`,
    pick_number: pickNumber,
    drafted_by: teamMap[msg.teamId] || `Team ${msg.teamId}`,
  };
}

// Build ESPN player ID → name map from the espn_rank table
export function buildPlayerMap(db) {
  const rows = db.prepare('SELECT espn_id, name FROM espn_rank WHERE espn_id IS NOT NULL').all();
  const map = {};
  for (const r of rows) map[r.espn_id] = r.name;
  return map;
}

// Build team ID → owner first name map from ESPN API
export async function buildTeamMap(leagueId, myTeamId, cookies, year) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leagues/${leagueId}?view=mTeam`;
  const res = await fetch(url, { headers: { Cookie: cookies } });
  if (!res.ok) throw new Error(`ESPN team fetch failed: ${res.status}`);
  const data = await res.json();

  const members = {};
  for (const m of (data.members || [])) members[m.id] = m.firstName;

  const teamMap = {};
  for (const t of (data.teams || [])) {
    if (t.id === myTeamId) {
      teamMap[t.id] = 'me';
    } else {
      const ownerId = t.owners?.[0];
      teamMap[t.id] = members[ownerId] || t.abbrev || `Team ${t.id}`;
    }
  }
  return teamMap;
}

// Get draft security token from ESPN
async function getDraftToken(leagueId, teamId, cookies, year) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leagues/${leagueId}/teams/${teamId}/draftSecurity`;
  const res = await fetch(url, { headers: { Cookie: cookies } });
  if (!res.ok) throw new Error(`Draft security failed: ${res.status}`);
  return (await res.text()).trim();
}

// Get gameId from draftInit
async function getGameId(leagueId, cookies, year) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leagues/${leagueId}?view=draftInit`;
  const res = await fetch(url, { headers: { Cookie: cookies } });
  if (!res.ok) throw new Error(`Draft init failed: ${res.status}`);
  const data = await res.json();
  return data.gameId;
}

/**
 * DraftSync — manages the WebSocket connection to ESPN's draft stream.
 *
 *   const sync = new DraftSync(db, sessionId);
 *   await sync.start();  // connects and begins inserting picks
 *   sync.stop();         // disconnects
 *   sync.status();       // { connected, pickCount, lastPick, onTheClock, error }
 */
export class DraftSync {
  constructor(db, sessionId) {
    this.db = db;
    this.sessionId = sessionId;
    this.ws = null;
    this.playerMap = null;
    this.teamMap = null;
    this.pickCount = 0;
    this.lastPick = null;
    this.onTheClock = null;
    this.error = null;
    this.connected = false;
    this._pingInterval = null;
    this._reconnectAttempts = 0;
    this._reconnectTimeout = null;
    this._stopped = false;
  }

  _getConfig(key) {
    return this.db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value;
  }

  _getCookies() {
    const swid = this._getConfig('espn_bot_swid') || '{A89C7768-329A-481E-B25C-AF05EEFE74B8}';
    const s2 = this._getConfig('espn_bot_s2');
    if (!s2) throw new Error('espn_bot_s2 not configured — set it in app_config');
    return `SWID=${swid}; espn_s2=${s2}`;
  }

  async start() {
    const leagueId = this._getConfig('espn_league_id');
    const teamId = Number(this._getConfig('espn_team_id'));
    if (!leagueId || !teamId) throw new Error('espn_league_id and espn_team_id must be set in app_config');

    const cookies = this._getCookies();
    const year = this._getConfig('season_year') || '2026';
    this._stopped = false;

    // Build lookup maps
    this.playerMap = buildPlayerMap(this.db);
    console.log(`[DraftSync] Player map: ${Object.keys(this.playerMap).length} players`);

    this.teamMap = await buildTeamMap(leagueId, teamId, cookies, year);
    console.log(`[DraftSync] Team map: ${Object.keys(this.teamMap).length} teams`);

    // Get draft token and gameId
    const token = await getDraftToken(leagueId, teamId, cookies, year);
    const gameId = await getGameId(leagueId, cookies, year);
    const memberId = this._getConfig('espn_bot_swid') || '{A89C7768-329A-481E-B25C-AF05EEFE74B8}';
    const fullToken = `${gameId}:${leagueId}:${teamId}:${memberId}:${token}`;

    const nocache = Math.floor(Math.random() * 1e6);
    const wsUrl = `wss://fantasydraft.espn.com/game-${gameId}/league-${leagueId}/JOIN?1=${gameId}&2=${leagueId}&3=${teamId}&4=${encodeURIComponent(memberId)}&5=${encodeURIComponent(fullToken)}&6=false&7=false&8=KONA&nocache=${nocache}`;

    console.log(`[DraftSync] Connecting to ${wsUrl.substring(0, 80)}...`);

    this.ws = new WebSocket(wsUrl, {
      headers: { Cookie: cookies },
    });

    this._connect(wsUrl, cookies);
  }

  _connect(wsUrl, cookies) {
    this.ws = new WebSocket(wsUrl, { headers: { Cookie: cookies } });
    this._wsUrl = wsUrl;
    this._wsCookies = cookies;

    this.ws.on('open', () => {
      console.log('[DraftSync] Connected');
      this.connected = true;
      this.error = null;
      this._reconnectAttempts = 0;
      // Send periodic pings to keep connection alive
      this._pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(`PING ${Date.now()}`);
        }
      }, 30000);
    });

    this.ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString();
      // Skip INIT (binary state) and TOKEN (auth echo)
      if (raw.startsWith('INIT ') || raw.startsWith('TOKEN ')) return;

      const msg = parseMessage(raw);
      if (!msg || !['SELECTED', 'SELECTING', 'CLOCK'].includes(msg.type)) return;

      if (msg.type === 'SELECTED') {
        this._handlePick(msg);
      } else if (msg.type === 'SELECTING') {
        this.onTheClock = { teamId: msg.teamId, team: this.teamMap[msg.teamId] || `Team ${msg.teamId}` };
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[DraftSync] Disconnected: ${code} ${reason}`);
      this.connected = false;
      this.error = `Disconnected (${code})`;
      clearInterval(this._pingInterval);
      this._tryReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[DraftSync] Error:', err.message);
      this.error = err.message;
      this.connected = false;
    });
  }

  _tryReconnect() {
    if (this._stopped || this._reconnectAttempts >= 10) {
      console.log('[DraftSync] Giving up reconnection');
      this.error = 'Disconnected — reconnection failed';
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;
    console.log(`[DraftSync] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
    this._reconnectTimeout = setTimeout(() => {
      if (!this._stopped) this._connect(this._wsUrl, this._wsCookies);
    }, delay);
  }

  _handlePick(msg) {
    // Get pick number from DB to handle manual + sync coexistence
    const maxPick = this.db.prepare(
      'SELECT MAX(pick_number) as max FROM draft_picks WHERE session_id = ?'
    ).get(this.sessionId);
    const pickNumber = (maxPick?.max || 0) + 1;

    const pick = mapPick(msg, this.playerMap, this.teamMap, pickNumber);
    this.lastPick = pick;
    this.onTheClock = null;

    // Insert idempotently — skip if this player was already drafted in this session
    const existing = this.db.prepare(
      'SELECT id FROM draft_picks WHERE session_id = ? AND player_name = ?'
    ).get(this.sessionId, pick.player_name);

    if (!existing) {
      this.db.prepare(
        'INSERT INTO draft_picks (session_id, player_name, pick_number, drafted_by) VALUES (?, ?, ?, ?)'
      ).run(this.sessionId, pick.player_name, pick.pick_number, pick.drafted_by);
      this.pickCount++;
      console.log(`[DraftSync] Pick #${pick.pick_number}: ${pick.player_name} by ${pick.drafted_by}`);
    }
  }

  stop() {
    this._stopped = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    clearInterval(this._pingInterval);
    clearTimeout(this._reconnectTimeout);
    this.connected = false;
    console.log('[DraftSync] Stopped');
  }

  status() {
    return {
      connected: this.connected,
      pickCount: this.pickCount,
      lastPick: this.lastPick,
      onTheClock: this.onTheClock,
      error: this.error,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd server && npx vitest run tests/draft-sync.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server/src/draft-sync.js server/tests/draft-sync.test.js
git commit -m "feat: draft sync module with WebSocket message parsing and pick insertion"
```

---

### Task 5: Add sync routes to draft router

**Files:**
- Modify: `server/src/routes/draft.js`

- [ ] **Step 1: Add sync endpoints**

Replace `server/src/routes/draft.js` with:

```js
import { Router } from 'express';
import { DraftSync } from '../draft-sync.js';

export function createDraftRouter(db) {
  const router = Router();
  let activeSyncs = {};  // sessionId → DraftSync instance

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

  // --- Sync endpoints ---

  router.post('/sessions/:id/sync/start', async (req, res) => {
    const sessionId = Number(req.params.id);
    if (activeSyncs[sessionId]) {
      return res.json({ ok: true, message: 'already running', ...activeSyncs[sessionId].status() });
    }
    try {
      const sync = new DraftSync(db, sessionId);
      await sync.start();
      activeSyncs[sessionId] = sync;
      res.json({ ok: true, ...sync.status() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/sessions/:id/sync/stop', (req, res) => {
    const sessionId = Number(req.params.id);
    const sync = activeSyncs[sessionId];
    if (sync) {
      sync.stop();
      delete activeSyncs[sessionId];
    }
    res.json({ ok: true });
  });

  router.get('/sessions/:id/sync/status', (req, res) => {
    const sessionId = Number(req.params.id);
    const sync = activeSyncs[sessionId];
    if (!sync) return res.json({ connected: false, pickCount: 0, lastPick: null, onTheClock: null, error: null });
    res.json(sync.status());
  });

  return router;
}
```

- [ ] **Step 2: Run existing tests**

```bash
cd server && npx vitest run
```

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/draft.js
git commit -m "feat: add draft sync start/stop/status endpoints"
```

---

### Task 6: Configure ESPN bot credentials via environment

**Files:**
- Modify: `server/src/seed.js`

ESPN credentials should NOT be committed to source code. They are set via environment variables or the Settings UI.

- [ ] **Step 1: Add placeholder config seeds with env var fallback**

Add after the `espn_team_id` line in `seed.js`:

```js
insertConfig.run('espn_bot_swid', process.env.ESPN_BOT_SWID || '');
insertConfig.run('espn_bot_s2', process.env.ESPN_BOT_S2 || '');
```

- [ ] **Step 2: Create `.env` file (gitignored) with credentials**

Add to `.env` (already in `.gitignore`):

```
ESPN_BOT_SWID={A89C7768-329A-481E-B25C-AF05EEFE74B8}
ESPN_BOT_S2=AEAdKLk8RaerkL0YlRwr8bGgv9YoEAeooQU381wBsRG1%2BPtiKwe6AykfEgSuTDI0Oa9DxgmQ40QGQ9lzb2gG517UVaOTGeoDttuVULn7fl4b2%2Bh9Hkhk6FdBt62Tbn3VCj4zCbvTEGcPws2%2BWHqzYSSU4hGw8bGpyev6v3Ym1RzZ8VKO%2Bgqha%2B%2FeaqkUaEzlUX1diLcRYHWiw2Gy%2BHPFZLVVduqAJiRAO150%2Fdwmv5mwWKrVZ5YhXWHXHXR%2BrNgcCK9PUMjaK08%2FGsEthcTuBxVQyS%2F4fkSh7azjyxaOBeEnBw%3D%3D
```

On Fly.io, set these via `fly secrets set ESPN_BOT_SWID=... ESPN_BOT_S2=...`

Note: `espn_s2` cookies expire periodically. Before draft day, refresh the cookie and update the env var / Fly secret.

- [ ] **Step 3: Run tests**

```bash
cd server && npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add server/src/seed.js
git commit -m "chore: seed ESPN bot config placeholders (credentials via env vars)"
```

---

### Task 7: Add client sync API methods

**Files:**
- Modify: `client/src/api.js`

- [ ] **Step 1: Add sync methods**

Add to the `api` object in `client/src/api.js`:

```js
startSync: (sessionId) => json(`/draft/sessions/${sessionId}/sync/start`, { method: 'POST' }),
stopSync: (sessionId) => json(`/draft/sessions/${sessionId}/sync/stop`, { method: 'POST' }),
getSyncStatus: (sessionId) => json(`/draft/sessions/${sessionId}/sync/status`),
```

- [ ] **Step 2: Commit**

```bash
git add client/src/api.js
git commit -m "feat: add sync API methods to client"
```

---

### Task 8: Add sync status bar and polling to Draft page

**Files:**
- Modify: `client/src/pages/Draft.jsx`

- [ ] **Step 1: Update Draft.jsx**

Replace `client/src/pages/Draft.jsx` with:

```jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import PlayerTable from '../components/PlayerTable';
import PositionFilter from '../components/PositionFilter';
import SearchBar from '../components/SearchBar';
import SessionSelector from '../components/SessionSelector';
import RosterSidebar from '../components/RosterSidebar';

function SyncStatusBar({ sessionId }) {
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!sessionId) return;
    // Poll sync status every 3s
    const poll = () => api.getSyncStatus(sessionId).then(setStatus).catch(() => {});
    poll();
    intervalRef.current = setInterval(poll, 3000);
    return () => clearInterval(intervalRef.current);
  }, [sessionId]);

  const handleStart = async () => {
    setSyncing(true);
    try {
      const result = await api.startSync(sessionId);
      setStatus(result);
    } catch (e) {
      setStatus({ connected: false, error: e.message });
    }
    setSyncing(false);
  };

  const handleStop = async () => {
    await api.stopSync(sessionId);
    setStatus({ connected: false, pickCount: 0, lastPick: null, onTheClock: null, error: null });
  };

  if (!status) return null;

  return (
    <div className="flex items-center gap-3 text-xs px-3 py-1.5 bg-gray-50 border border-gray-200 rounded">
      <span className={`inline-block w-2 h-2 rounded-full ${status.connected ? 'bg-green-500' : status.error ? 'bg-red-500' : 'bg-gray-400'}`} />
      {status.connected ? (
        <>
          <span className="text-green-700 font-medium">ESPN Sync Active</span>
          <span className="text-gray-500">Picks: {status.pickCount}</span>
          {status.onTheClock && (
            <span className="text-amber-600 font-medium">On clock: {status.onTheClock.team}</span>
          )}
          {status.lastPick && (
            <span className="text-gray-500">Last: {status.lastPick.player_name} → {status.lastPick.drafted_by}</span>
          )}
          <button onClick={handleStop} className="text-red-500 hover:text-red-700 ml-auto">Stop</button>
        </>
      ) : (
        <>
          <span className="text-gray-500">{status.error ? `Error: ${status.error}` : 'ESPN Sync Off'}</span>
          <button onClick={handleStart} disabled={syncing}
            className="text-blue-600 hover:text-blue-800 ml-auto disabled:opacity-50">
            {syncing ? 'Connecting...' : 'Start Sync'}
          </button>
        </>
      )}
    </div>
  );
}

export default function Draft() {
  const [rankings, setRankings] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [picks, setPicks] = useState([]);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState(null);
  const [hideTaken, setHideTaken] = useState(true);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef(null);

  useEffect(() => {
    Promise.all([api.getRankings(), api.getDraftSessions()]).then(([r, s]) => {
      setRankings(r);
      setSessions(s);
      if (s.length > 0) setActiveSession(s[0].id);
    }).finally(() => setLoading(false));
  }, []);

  // Poll picks every 3 seconds for live sync updates
  useEffect(() => {
    if (!activeSession) return;
    const poll = () => api.getDraftPicks(activeSession).then(setPicks);
    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => clearInterval(pollRef.current);
  }, [activeSession]);

  const takenNames = new Set(picks.map(p => p.player_name));
  const nextPick = picks.length > 0 ? Math.max(...picks.map(p => p.pick_number)) + 1 : 1;

  const displayData = hideTaken ? rankings.filter(r => !takenNames.has(r.name)) : rankings.map(r => ({
    ...r, _taken: takenNames.has(r.name),
  }));

  const handleNoteChange = useCallback((name, note) => {
    api.updatePlayerNote(name, note);
    setRankings(prev => prev.map(p => p.name === name ? { ...p, note } : p));
  }, []);

  const handleDraft = useCallback(async (player) => {
    if (!activeSession) return;
    const result = window.prompt(`Who drafted ${player.name}? (leave blank for "me")`);
    if (result === null) return;
    const drafted_by = result || 'me';
    await api.createDraftPick(activeSession, {
      player_name: player.name,
      pick_number: nextPick,
      drafted_by,
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
      <div className="flex-1 space-y-4">
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-xl font-bold text-gray-900">Draft</h1>
          <div className="h-5 w-px bg-gray-300" />
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
        <SyncStatusBar sessionId={activeSession} />
        <PlayerTable data={displayData} globalFilter={search} positionFilter={posFilter}
          onRowClick={handleDraft} onNoteChange={handleNoteChange}
          rowClassName={r => r._taken ? 'opacity-40 line-through' : ''} />
      </div>
      <RosterSidebar picks={picks} rankings={rankings} />
    </div>
  );
}
```

- [ ] **Step 2: Run all tests**

```bash
cd server && npx vitest run
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Draft.jsx client/src/api.js
git commit -m "feat: add sync status bar and pick polling to Draft page"
```

---

### Task 9: Integration test with mock draft

**Files:** No new files — manual test procedure

- [ ] **Step 1: Start the dev server**

```bash
cd server && npm run dev
```

- [ ] **Step 2: Run Refresh All to populate espn_id data**

Open the app, go to Settings, click "Refresh All" to populate the `espn_rank` table with `espn_id` values.

- [ ] **Step 3: Create a draft session and start sync**

Open the Draft page, create a new session. Click "Start Sync". Verify:
- Status bar shows "Connecting..." then "ESPN Sync Active" (if a draft is running)
- If no draft is running, status shows an error (expected — the real draft hasn't started)

- [ ] **Step 4: Test manual entry still works alongside sync**

Click a player, enter "me" — verify the pick appears. Verify the status bar doesn't break.

- [ ] **Step 5: Test with a mock draft**

Have Claude Bot start a mock draft from the incognito browser. Open the app on your main browser. Start sync from the draft page. Make picks in the mock draft. Verify picks appear automatically in the app.

Note: This test requires the mock draft to register on `fantasydraft.espn.com`. If it doesn't (as we observed), this test can only be run during the real draft.

---

## Pre-Draft Day Checklist

- [ ] Refresh `espn_s2` cookie for Claude Bot account (cookies expire)
- [ ] Update `espn_bot_s2` in `app_config` table
- [ ] Run "Refresh All" to ensure `espn_id` data is populated
- [ ] Deploy to Fly.io
- [ ] Verify the app loads on phone
- [ ] Create a draft session named "2026 Draft"
- [ ] When draft starts: click "Start Sync" — verify green dot appears
- [ ] If sync fails: manual entry still works (click player, enter drafter name)
