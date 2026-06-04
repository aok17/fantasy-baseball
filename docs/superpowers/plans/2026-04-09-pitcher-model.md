# Pitcher Performance Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a per-start pitcher model that predicts points/start using leading indicators (SwStr%, CStr%, ball rate, regressed BABIP/HR) with 3/10/30-start rolling windows.

**Architecture:** Savant game-log CSV + MLB Stats API game logs → `pitcher_starts` table → rolling window sub-models → `pitcher_model` table → rankings API → UI column groups. Two new server files: scraper and model computation. Minimal changes to existing files (schema, routes, seed, UI).

**Tech Stack:** better-sqlite3, csv-parse, fetch (node built-in), existing Express/React/TanStack Table stack.

---

### Task 1: Schema — Add pitcher_starts and pitcher_model tables

**Files:**
- Modify: `server/src/schema.sql`

- [ ] **Step 1: Add pitcher_starts table to schema.sql**

Add before the `draft_sessions` table:

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
```

- [ ] **Step 2: Add league average defaults to seed.js**

In `server/src/seed.js`, add these `insertConfig.run` calls after the existing ones:

```js
insertConfig.run('lg_babip', '0.300');
insertConfig.run('lg_hr_fb', '0.095');
insertConfig.run('lg_runs_per_game', '4.5');
insertConfig.run('fip_constant', '3.15');
```

- [ ] **Step 3: Verify the app starts**

Run: `cd server && node src/index.js`
Expected: Server starts without errors. Ctrl+C to stop.

- [ ] **Step 4: Commit**

```bash
git add server/src/schema.sql server/src/seed.js
git commit -m "feat: add pitcher_starts and pitcher_model schema + league avg config"
```

---

### Task 2: Scraper — Fetch Savant game logs + called strikes

**Files:**
- Create: `server/src/scrapers/pitcher-starts.js`

- [ ] **Step 1: Create the scraper file with Savant fetching**

Create `server/src/scrapers/pitcher-starts.js`:

```js
import { parse } from 'csv-parse/sync';
import { convertLastFirst } from './names.js';

function num(val) {
  if (val === '' || val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

function parseSavantGameLog(csvText) {
  let csv = csvText.replace(/^\uFEFF/, '');
  if (!csv.trim() || csv.includes('No data')) return [];
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
  return records.map(r => ({
    mlbam_id: r.player_id || null,
    player_name: convertLastFirst(r.player_name?.replace(/"/g, '') || ''),
    game_date: r.game_date || null,
    total_pitches: num(r.total_pitches),
    pa: num(r.pa),
    bip: num(r.bip),
    hits: num(r.hits),
    hrs: num(r.hrs),
    so: num(r.so),
    bb: num(r.bb),
    whiffs: num(r.whiffs),
    swings: num(r.swings),
    takes: num(r.takes),
    babip: num(r.babip),
    woba: num(r.woba),
    xwoba: num(r.xwoba),
  }));
}

function parseCalledStrikes(csvText) {
  let csv = csvText.replace(/^\uFEFF/, '');
  if (!csv.trim() || csv.includes('No data')) return new Map();
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
  const map = new Map();
  for (const r of records) {
    const key = `${r.player_id}|${r.game_date}`;
    map.set(key, num(r.pitches) || 0);
  }
  return map;
}

async function fetchSavantGameLogs(season) {
  const base = 'https://baseballsavant.mlb.com/statcast_search/csv';
  const params = `?all=true&hfGT=R%7C&hfSea=${season}%7C&player_type=pitcher&group_by=name-date&min_pitches=50&min_results=0&min_pas=0&sort_col=pitches&sort_order=desc&chk_stats_pa=on&chk_stats_abs=on&chk_stats_bip=on&chk_stats_hits=on&chk_stats_hrs=on&chk_stats_so=on&chk_stats_k_percent=on&chk_stats_bb=on&chk_stats_bb_percent=on&chk_stats_whiffs=on&chk_stats_swings=on&chk_stats_ba=on&chk_stats_babip=on&chk_stats_woba=on&chk_stats_xwoba=on`;

  const mainRes = await fetch(`${base}${params}`);
  if (!mainRes.ok) throw new Error(`Savant game log fetch failed: ${mainRes.status}`);
  const mainCsv = await mainRes.text();
  const starts = parseSavantGameLog(mainCsv);

  // Second fetch for called strikes
  const csRes = await fetch(`${base}${params}&hfPR=called_strike%7C`);
  if (!csRes.ok) throw new Error(`Savant called-strike fetch failed: ${csRes.status}`);
  const csCsv = await csRes.text();
  const csMap = parseCalledStrikes(csCsv);

  // Merge called strikes into main data
  for (const s of starts) {
    const key = `${s.mlbam_id}|${s.game_date}`;
    s.called_strikes = csMap.get(key) || 0;
  }

  return starts;
}

async function fetchMlbGameLog(mlbamId, season) {
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbamId}/stats?stats=gameLog&season=${season}&group=pitching`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  const splits = json.stats?.[0]?.splits || [];
  return splits
    .filter(s => s.stat.gamesStarted > 0 && s.gameType === 'R')
    .map(s => ({
      date: s.date,
      ip: parseIP(s.stat.inningsPitched),
      er: s.stat.earnedRuns || 0,
      won: s.stat.wins > 0 ? 1 : 0,
      loss: s.stat.losses > 0 ? 1 : 0,
      pitches: s.stat.numberOfPitches || 0,
    }));
}

// Parse "5.2" (5 and 2/3 innings) to 5.667
function parseIP(ipStr) {
  if (!ipStr) return 0;
  const parts = String(ipStr).split('.');
  const full = parseInt(parts[0]) || 0;
  const partial = parseInt(parts[1]) || 0;
  return full + partial / 3;
}

export async function fetchPitcherStarts(db) {
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'season_year'").get();
  const season = Number(row?.value) || new Date().getFullYear();

  // 1. Fetch Savant game logs
  const savantStarts = await fetchSavantGameLogs(season);
  console.log(`Savant game logs: ${savantStarts.length} starts`);

  // 2. Get SP mlbam_ids from combined_rankings
  const sps = db.prepare(`
    SELECT DISTINCT p.mlbam_id FROM combined_rankings cr
    JOIN players p ON p.id = cr.player_id
    WHERE cr.position LIKE '%SP%' AND p.mlbam_id IS NOT NULL
  `).all();
  const spIds = new Set(sps.map(r => r.mlbam_id));

  // 3. Fetch MLB API game logs for each SP
  const mlbLogs = new Map(); // mlbam_id|date -> { ip, er, won, loss }
  let mlbTotal = 0;
  for (const mlbamId of spIds) {
    const logs = await fetchMlbGameLog(mlbamId, season);
    for (const g of logs) {
      mlbLogs.set(`${mlbamId}|${g.date}`, g);
      mlbTotal++;
    }
  }
  console.log(`MLB API game logs: ${mlbTotal} starts for ${spIds.size} pitchers`);

  // 4. Join and upsert into pitcher_starts
  const findPlayer = db.prepare('SELECT id FROM players WHERE mlbam_id = ?');
  const upsert = db.prepare(`
    INSERT INTO pitcher_starts
      (player_id, mlbam_id, player_name, game_date, season,
       total_pitches, pa, bip, hits, hrs, so, bb,
       whiffs, swings, takes, called_strikes,
       babip, woba, xwoba, ip, er, won, qs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mlbam_id, game_date) DO UPDATE SET
      player_id=excluded.player_id, total_pitches=excluded.total_pitches,
      pa=excluded.pa, bip=excluded.bip, hits=excluded.hits, hrs=excluded.hrs,
      so=excluded.so, bb=excluded.bb, whiffs=excluded.whiffs, swings=excluded.swings,
      takes=excluded.takes, called_strikes=excluded.called_strikes,
      babip=excluded.babip, woba=excluded.woba, xwoba=excluded.xwoba,
      ip=excluded.ip, er=excluded.er, won=excluded.won, qs=excluded.qs
  `);

  let inserted = 0;
  db.transaction(() => {
    for (const s of savantStarts) {
      if (!s.mlbam_id || !s.game_date) continue;

      // Try to find MLB API data for this start
      const mlb = mlbLogs.get(`${s.mlbam_id}|${s.game_date}`);

      // Skip if no MLB API data (not a confirmed start) and not in our SP list
      if (!mlb && !spIds.has(s.mlbam_id)) continue;

      const ip = mlb?.ip ?? null;
      const er = mlb?.er ?? null;
      const won = mlb?.won ?? 0;
      const qs = (ip != null && er != null && ip >= 6 && er <= 3) ? 1 : 0;
      const playerId = findPlayer.get(s.mlbam_id)?.id ?? null;

      upsert.run(
        playerId, s.mlbam_id, s.player_name, s.game_date, season,
        s.total_pitches, s.pa, s.bip, s.hits, s.hrs, s.so, s.bb,
        s.whiffs, s.swings, s.takes, s.called_strikes,
        s.babip, s.woba, s.xwoba, ip, er, won, qs
      );
      inserted++;
    }
  })();

  return { starts: inserted, pitchers: spIds.size };
}
```

- [ ] **Step 2: Verify the file parses**

Run: `cd server && node -e "import('./src/scrapers/pitcher-starts.js').then(() => console.log('OK'))"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add server/src/scrapers/pitcher-starts.js
git commit -m "feat: add pitcher-starts scraper (Savant game logs + MLB API)"
```

---

### Task 3: Model computation — Rolling windows and sub-models

**Files:**
- Create: `server/src/scoring/pitcher-model.js`

- [ ] **Step 1: Create the model computation file**

Create `server/src/scoring/pitcher-model.js`:

```js
import { safeDivide } from './utils.js';

function getConfig(db, key, fallback) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? Number(row.value) : fallback;
}

function getWeights(db) {
  const rows = db.prepare("SELECT stat, weight FROM scoring_config WHERE category = 'pitcher'").all();
  const w = {};
  for (const r of rows) w[r.stat] = r.weight;
  return w;
}

// Get the most recent N starts for a pitcher, ordered newest-first
function getRecentStarts(db, playerId, n) {
  return db.prepare(`
    SELECT * FROM pitcher_starts
    WHERE player_id = ? AND ip IS NOT NULL
    ORDER BY game_date DESC LIMIT ?
  `).all(playerId, n);
}

// Rolling averages over an array of starts
function rollingAvg(starts, field) {
  const vals = starts.map(s => s[field]).filter(v => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function rollingSum(starts, field) {
  return starts.reduce((sum, s) => sum + (s[field] || 0), 0);
}

// Sub-model 1: Strikeout rate (aggressive)
// xK% = 1.2 * SwStr% + 0.6 * CStr% - 4.0
function estimateKPct(starts) {
  const totalPitches = rollingSum(starts, 'total_pitches');
  const whiffs = rollingSum(starts, 'whiffs');
  const calledStrikes = rollingSum(starts, 'called_strikes');
  if (totalPitches === 0) return null;

  const swstrPct = (whiffs / totalPitches) * 100;
  const cstrPct = (calledStrikes / totalPitches) * 100;
  const xk = 1.2 * swstrPct + 0.6 * cstrPct - 4.0;
  return Math.max(0, Math.min(xk / 100, 0.60)); // return as fraction, clamped
}

// Sub-model 2: Walk rate (aggressive)
// xBB% from ball rate: xBB% = 0.8 * ball_pct - 0.15
function estimateBBPct(starts) {
  const totalPitches = rollingSum(starts, 'total_pitches');
  const takes = rollingSum(starts, 'takes');
  const calledStrikes = rollingSum(starts, 'called_strikes');
  if (totalPitches === 0) return null;

  const ballPct = (takes - calledStrikes) / totalPitches;
  const xbb = 0.8 * ballPct - 0.15;
  return Math.max(0.01, Math.min(xbb, 0.25)); // clamp to reasonable range
}

// Sub-model 3: BABIP (conservative, heavy regression)
// regressed = (bip * observed + k * lg_avg) / (bip + k)
function regressedBABIP(starts, lgBabip) {
  const bip = rollingSum(starts, 'bip');
  const hits = rollingSum(starts, 'hits');
  const hrs = rollingSum(starts, 'hrs');
  const so = rollingSum(starts, 'so');
  if (bip === 0) return lgBabip;

  const hitsOnBip = hits - hrs; // BABIP excludes HR
  const observedBabip = safeDivide(hitsOnBip, bip);
  const k = 3700;
  return (bip * observedBabip + k * lgBabip) / (bip + k);
}

// Sub-model 3b: HR rate (conservative, heavy regression)
function regressedHR9(starts, lgHrFb) {
  const bip = rollingSum(starts, 'bip');
  const hrs = rollingSum(starts, 'hrs');
  if (bip === 0) return lgHrFb;

  // Approximate FB as ~35% of BIP (league average)
  const fb = bip * 0.35;
  const observedHrFb = safeDivide(hrs, fb);
  const k = 170;
  const regHrFb = (fb * observedHrFb + k * lgHrFb) / (fb + k);

  // Convert HR/FB back to HR/9 using estimated IP
  const ip = rollingSum(starts, 'ip');
  if (ip === 0) return regHrFb * 0.35 * 3 * 9; // rough fallback
  const bipPer9 = bip * 9 / ip;
  return regHrFb * 0.35 * bipPer9;
}

// Sub-model 4: IP/start (derived from K%, BB%, pitches/start)
function estimateIP(starts, estKPct, estBBPct) {
  const avgPitches = rollingAvg(starts, 'total_pitches');
  if (!avgPitches || estKPct == null || estBBPct == null) return rollingAvg(starts, 'ip');

  const bipPct = 1 - estKPct - estBBPct;
  const P_BIP = 3.5, P_K = 5.0, P_BB = 5.5;
  const pitchesPerBatter = bipPct * P_BIP + estKPct * P_K + estBBPct * P_BB;
  const outsPerBatter = bipPct * 0.72 + estKPct * 1.0;
  const pitchesPerOut = safeDivide(pitchesPerBatter, outsPerBatter);
  if (pitchesPerOut === 0) return rollingAvg(starts, 'ip');

  return safeDivide(avgPitches, pitchesPerOut * 3);
}

// Sub-model 5: ERA via FIP
function estimateERA(estK, estBB, estHR, estIP, fipConstant) {
  if (!estIP || estIP === 0) return null;
  return safeDivide((13 * estHR) + (3 * estBB) - (2 * estK), estIP) + fipConstant;
}

// Sub-model 6: Win probability via Pythagorean expectation
function estimateWinProb(starts, estERA, lgRunsPerGame) {
  if (estERA == null) return { pWin: null, pLoss: null };

  const runsAllowed = estERA; // proxy: ERA ≈ runs allowed rate
  const lgR = lgRunsPerGame;
  const pythWinPct = safeDivide(lgR * lgR, lgR * lgR + runsAllowed * runsAllowed);

  // Decision rate from rolling window
  const totalStarts = starts.length;
  const decisions = starts.filter(s => s.won === 1 || (s.er != null)).length; // approximate
  const wins = rollingSum(starts, 'won');
  const losses = starts.filter(s => s.won === 0 && s.ip != null).length;
  // Use historical decision rate (~60%) as fallback
  const decisionRate = totalStarts > 0 ? Math.min((wins + (totalStarts - wins) * 0.4) / totalStarts, 0.75) : 0.6;

  return {
    pWin: pythWinPct * decisionRate,
    pLoss: (1 - pythWinPct) * decisionRate,
  };
}

// Sub-model 7: QS probability
function estimateQSProb(starts, estIP, estERA) {
  if (estIP == null || estERA == null) return null;

  // Blend rolling QS rate with model-derived estimate
  const totalStarts = starts.length;
  const qsCount = rollingSum(starts, 'qs');
  const rollingQsRate = totalStarts > 0 ? qsCount / totalStarts : 0;

  // Model-based: if est_IP >= 6 and est_ER_in_6IP <= 3
  const estERin6 = estERA * 6 / 9;
  const modelQs = (estIP >= 6 && estERin6 <= 3) ? 0.7 : // likely QS
                  (estIP >= 5.5 && estERin6 <= 3.5) ? 0.4 : // borderline
                  0.15; // unlikely

  // Blend: 50/50 rolling rate and model estimate
  return rollingQsRate * 0.5 + modelQs * 0.5;
}

// Compute full model for one pitcher at one window size
function computeForWindow(db, playerId, windowSize, config, weights) {
  const starts = getRecentStarts(db, playerId, windowSize);
  if (starts.length === 0) return null;

  const xkPct = estimateKPct(starts);
  const xbbPct = estimateBBPct(starts);
  const regBabip = regressedBABIP(starts, config.lgBabip);
  const regHr9 = regressedHR9(starts, config.lgHrFb);
  const estIP = estimateIP(starts, xkPct, xbbPct);
  const estPA = rollingAvg(starts, 'pa') || 25;

  // Per-start counting stats
  const estK = (xkPct || 0.20) * estPA;
  const estBB = (xbbPct || 0.077) * estPA;
  const estBIP = estPA - estK - estBB;
  const estHR = (regHr9 || 1.2) * (estIP || 6) / 9;
  const estH = regBabip * Math.max(estBIP, 0) + estHR;

  const estERA = estimateERA(estK, estBB, estHR, estIP, config.fipConstant);
  const estER = estERA != null ? estERA * (estIP || 6) / 9 : null;

  const { pWin, pLoss } = estimateWinProb(starts, estERA, config.lgRunsPerGame);
  const pQS = estimateQSProb(starts, estIP, estERA);

  // Points per start
  let pts = 0;
  if (estIP != null) pts += estIP * (weights.IP || 0);
  pts += estK * (weights.SO || 0);
  pts += estBB * (weights.BB || 0);
  pts += estH * (weights.H || 0);
  if (estER != null) pts += estER * (weights.ER || 0);
  if (pWin != null) pts += pWin * (weights.W || 0);
  if (pLoss != null) pts += pLoss * (weights.L || 0);
  if (pQS != null) pts += pQS * (weights.QS || 0);

  return {
    player_id: playerId,
    window: windowSize,
    starts_in_window: starts.length,
    xk_pct: xkPct,
    xbb_pct: xbbPct,
    regressed_babip: regBabip,
    regressed_hr9: regHr9,
    est_ip: estIP,
    est_era: estERA,
    est_k_per_start: estK,
    est_bb_per_start: estBB,
    est_h_per_start: estH,
    est_er_per_start: estER,
    p_win: pWin,
    p_loss: pLoss,
    p_qs: pQS,
    pts_per_start: pts,
  };
}

export function computePitcherModel(db) {
  const config = {
    lgBabip: getConfig(db, 'lg_babip', 0.300),
    lgHrFb: getConfig(db, 'lg_hr_fb', 0.095),
    lgRunsPerGame: getConfig(db, 'lg_runs_per_game', 4.5),
    fipConstant: getConfig(db, 'fip_constant', 3.15),
  };
  const weights = getWeights(db);

  // Get all pitchers who have starts
  const pitchers = db.prepare(`
    SELECT DISTINCT player_id FROM pitcher_starts WHERE player_id IS NOT NULL AND ip IS NOT NULL
  `).all();

  const upsert = db.prepare(`
    INSERT INTO pitcher_model
      (player_id, window, starts_in_window, xk_pct, xbb_pct,
       regressed_babip, regressed_hr9, est_ip, est_era,
       est_k_per_start, est_bb_per_start, est_h_per_start, est_er_per_start,
       p_win, p_loss, p_qs, pts_per_start)
    VALUES (@player_id, @window, @starts_in_window, @xk_pct, @xbb_pct,
       @regressed_babip, @regressed_hr9, @est_ip, @est_era,
       @est_k_per_start, @est_bb_per_start, @est_h_per_start, @est_er_per_start,
       @p_win, @p_loss, @p_qs, @pts_per_start)
    ON CONFLICT(player_id, window) DO UPDATE SET
       starts_in_window=excluded.starts_in_window, xk_pct=excluded.xk_pct,
       xbb_pct=excluded.xbb_pct, regressed_babip=excluded.regressed_babip,
       regressed_hr9=excluded.regressed_hr9, est_ip=excluded.est_ip,
       est_era=excluded.est_era, est_k_per_start=excluded.est_k_per_start,
       est_bb_per_start=excluded.est_bb_per_start, est_h_per_start=excluded.est_h_per_start,
       est_er_per_start=excluded.est_er_per_start, p_win=excluded.p_win,
       p_loss=excluded.p_loss, p_qs=excluded.p_qs, pts_per_start=excluded.pts_per_start
  `);

  let count = 0;
  db.transaction(() => {
    for (const { player_id } of pitchers) {
      for (const w of [3, 10, 30]) {
        const result = computeForWindow(db, player_id, w, config, weights);
        if (result) {
          upsert.run(result);
          count++;
        }
      }
    }
  })();

  return { models: count, pitchers: pitchers.length };
}
```

- [ ] **Step 2: Verify the file parses**

Run: `cd server && node -e "import('./src/scoring/pitcher-model.js').then(() => console.log('OK'))"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add server/src/scoring/pitcher-model.js
git commit -m "feat: add pitcher model computation (K%, BB%, BABIP, HR, IP, ERA, W, QS sub-models)"
```

---

### Task 4: Wire scrape route + trigger model after scrape

**Files:**
- Modify: `server/src/routes/scrape.js`
- Modify: `server/src/scoring/rescore.js`

- [ ] **Step 1: Add pitcher-starts route to scrape.js**

At the top of `server/src/routes/scrape.js`, add the import:

```js
import { fetchPitcherStarts } from '../scrapers/pitcher-starts.js';
import { computePitcherModel } from '../scoring/pitcher-model.js';
```

Add this route before the `router.post('/rescore', ...)` route:

```js
  router.post('/pitcher-starts', async (req, res) => {
    try {
      const result = await fetchPitcherStarts(db);
      setLastRefreshed(db, 'pitcher_starts');
      res.json({ ok: true, ...result });
      setImmediate(() => {
        try { computePitcherModel(db); } catch (e) { console.error('Pitcher model failed:', e); }
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
```

- [ ] **Step 2: Add to /all route**

In the `/all` handler, add after the rosters block and before the `res.json(results)` line:

```js
    try {
      results.pitcher_starts = await fetchPitcherStarts(db);
      setLastRefreshed(db, 'pitcher_starts');
    } catch (e) { results.pitcher_starts = { error: e.message }; }
```

- [ ] **Step 3: Run computePitcherModel after rescore**

In `server/src/scoring/rescore.js`, add at the top:

```js
import { computePitcherModel } from './pitcher-model.js';
```

At the end of `rescoreAll`, after the final `insertCombined` loop but still inside the transaction, add:

```js
    // Recompute pitcher model if start data exists
    try { computePitcherModel(db); } catch (e) { console.error('Pitcher model computation failed:', e); }
```

- [ ] **Step 4: Add to DataRefresh UI**

In `client/src/components/DataRefresh.jsx`, add to the SOURCES array:

```js
  { key: 'pitcher-starts', label: 'Pitcher Model' },
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/scrape.js server/src/scoring/rescore.js client/src/components/DataRefresh.jsx
git commit -m "feat: wire pitcher-starts scrape route + trigger model computation"
```

---

### Task 5: Rankings API — expose pitcher model data

**Files:**
- Modify: `server/src/routes/rankings.js`

- [ ] **Step 1: Add pitcher_model JOINs to rankings query**

In `server/src/routes/rankings.js`, in the main SELECT query, add these columns after the `ba2.WAR as a_bat_war` line:

```sql
        pm3.pts_per_start as m3_pts, pm3.xk_pct as m3_xk, pm3.xbb_pct as m3_xbb,
        pm3.est_era as m3_era, pm3.est_ip as m3_ip, pm3.p_qs as m3_pqs,
        pm3.starts_in_window as m3_n,
        pm3.est_k_per_start as m3_k, pm3.est_bb_per_start as m3_bb,
        pm3.est_h_per_start as m3_h, pm3.regressed_babip as m3_babip,
        pm3.regressed_hr9 as m3_hr9, pm3.p_win as m3_pw,
        pm10.pts_per_start as m10_pts, pm10.xk_pct as m10_xk, pm10.xbb_pct as m10_xbb,
        pm10.est_era as m10_era, pm10.est_ip as m10_ip, pm10.p_qs as m10_pqs,
        pm10.starts_in_window as m10_n,
        pm10.est_k_per_start as m10_k, pm10.est_bb_per_start as m10_bb,
        pm10.est_h_per_start as m10_h, pm10.regressed_babip as m10_babip,
        pm10.regressed_hr9 as m10_hr9, pm10.p_win as m10_pw,
        pm30.pts_per_start as m30_pts, pm30.xk_pct as m30_xk, pm30.xbb_pct as m30_xbb,
        pm30.est_era as m30_era, pm30.est_ip as m30_ip, pm30.p_qs as m30_pqs,
        pm30.starts_in_window as m30_n,
        pm30.est_k_per_start as m30_k, pm30.est_bb_per_start as m30_bb,
        pm30.est_h_per_start as m30_h, pm30.regressed_babip as m30_babip,
        pm30.regressed_hr9 as m30_hr9, pm30.p_win as m30_pw,
```

Add these JOINs after the `LEFT JOIN savant_expected` line:

```sql
      LEFT JOIN pitcher_model pm3 ON pm3.player_id = cr.player_id AND pm3.window = 3
      LEFT JOIN pitcher_model pm10 ON pm10.player_id = cr.player_id AND pm10.window = 10
      LEFT JOIN pitcher_model pm30 ON pm30.player_id = cr.player_id AND pm30.window = 30
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/rankings.js
git commit -m "feat: expose pitcher model data in rankings API (3/10/30 windows)"
```

---

### Task 6: UI — Add model column groups with amber headers

**Files:**
- Modify: `client/src/components/PlayerTable.jsx`

- [ ] **Step 1: Add model accessor keys to NUMERIC_ACCESSORS**

In `client/src/components/PlayerTable.jsx`, add to the `NUMERIC_ACCESSORS` Set (after the `a_bat_war` line):

```js
  'm3_pts', 'm3_xk', 'm3_xbb', 'm3_era', 'm3_ip', 'm3_pqs', 'm3_n',
  'm3_k', 'm3_bb', 'm3_h', 'm3_babip', 'm3_hr9', 'm3_pw',
  'm10_pts', 'm10_xk', 'm10_xbb', 'm10_era', 'm10_ip', 'm10_pqs', 'm10_n',
  'm10_k', 'm10_bb', 'm10_h', 'm10_babip', 'm10_hr9', 'm10_pw',
  'm30_pts', 'm30_xk', 'm30_xbb', 'm30_era', 'm30_ip', 'm30_pqs', 'm30_n',
  'm30_k', 'm30_bb', 'm30_h', 'm30_babip', 'm30_hr9', 'm30_pw',
```

- [ ] **Step 2: Add amber color for model groups**

In `GROUP_HEADER_COLORS`, add:

```js
  model_3: 'text-amber-700',
  model_10: 'text-amber-700',
  model_30: 'text-amber-700',
```

- [ ] **Step 3: Add model column definitions**

Add these column definitions after the savant `xwoba_diff` column and before the closing `];` of `ALL_COLUMNS`:

```js
  // Model (3-start rolling)
  { accessorKey: 'm3_pts', header: 'Pts', size: 52, cell: num1, group: 'model_3', filterFn: columnFilterFn },
  { accessorKey: 'm3_xk', header: 'xK%', size: 48, cell: ({ getValue }) => { const v = getValue(); return v != null ? (v * 100).toFixed(1) : ''; }, group: 'model_3', filterFn: columnFilterFn },
  { accessorKey: 'm3_xbb', header: 'xBB%', size: 52, cell: ({ getValue }) => { const v = getValue(); return v != null ? (v * 100).toFixed(1) : ''; }, group: 'model_3', filterFn: columnFilterFn },
  { accessorKey: 'm3_era', header: 'ERA', size: 50, cell: num2, group: 'model_3', filterFn: columnFilterFn },
  { accessorKey: 'm3_ip', header: 'IP', size: 44, cell: num1, group: 'model_3', filterFn: columnFilterFn },
  { accessorKey: 'm3_pqs', header: 'QS%', size: 48, cell: ({ getValue }) => { const v = getValue(); return v != null ? (v * 100).toFixed(0) + '%' : ''; }, group: 'model_3', filterFn: columnFilterFn },
  { accessorKey: 'm3_n', header: 'N', size: 32, cell: raw, group: 'model_3', filterFn: columnFilterFn },
  // Model (10-start rolling)
  { accessorKey: 'm10_pts', header: 'Pts', size: 52, cell: num1, group: 'model_10', filterFn: columnFilterFn },
  { accessorKey: 'm10_xk', header: 'xK%', size: 48, cell: ({ getValue }) => { const v = getValue(); return v != null ? (v * 100).toFixed(1) : ''; }, group: 'model_10', filterFn: columnFilterFn },
  { accessorKey: 'm10_xbb', header: 'xBB%', size: 52, cell: ({ getValue }) => { const v = getValue(); return v != null ? (v * 100).toFixed(1) : ''; }, group: 'model_10', filterFn: columnFilterFn },
  { accessorKey: 'm10_era', header: 'ERA', size: 50, cell: num2, group: 'model_10', filterFn: columnFilterFn },
  { accessorKey: 'm10_ip', header: 'IP', size: 44, cell: num1, group: 'model_10', filterFn: columnFilterFn },
  { accessorKey: 'm10_pqs', header: 'QS%', size: 48, cell: ({ getValue }) => { const v = getValue(); return v != null ? (v * 100).toFixed(0) + '%' : ''; }, group: 'model_10', filterFn: columnFilterFn },
  { accessorKey: 'm10_n', header: 'N', size: 32, cell: raw, group: 'model_10', filterFn: columnFilterFn },
  // Model (30-start rolling)
  { accessorKey: 'm30_pts', header: 'Pts', size: 52, cell: num1, group: 'model_30', filterFn: columnFilterFn },
  { accessorKey: 'm30_xk', header: 'xK%', size: 48, cell: ({ getValue }) => { const v = getValue(); return v != null ? (v * 100).toFixed(1) : ''; }, group: 'model_30', filterFn: columnFilterFn },
  { accessorKey: 'm30_xbb', header: 'xBB%', size: 52, cell: ({ getValue }) => { const v = getValue(); return v != null ? (v * 100).toFixed(1) : ''; }, group: 'model_30', filterFn: columnFilterFn },
  { accessorKey: 'm30_era', header: 'ERA', size: 50, cell: num2, group: 'model_30', filterFn: columnFilterFn },
  { accessorKey: 'm30_ip', header: 'IP', size: 44, cell: num1, group: 'model_30', filterFn: columnFilterFn },
  { accessorKey: 'm30_pqs', header: 'QS%', size: 48, cell: ({ getValue }) => { const v = getValue(); return v != null ? (v * 100).toFixed(0) + '%' : ''; }, group: 'model_30', filterFn: columnFilterFn },
  { accessorKey: 'm30_n', header: 'N', size: 32, cell: raw, group: 'model_30', filterFn: columnFilterFn },
```

- [ ] **Step 4: Add model groups to ColumnPicker**

In the `ColumnPicker` component, update the `groups` object to include model groups:

```js
  const groups = {
    scoring: 'Scoring', velo: 'Velocity',
    pitcher: 'Pitching (Proj)', pitcher_actual: 'Pitching (Actual)',
    batter: 'Batting (Proj)', batter_actual: 'Batting (Actual)',
    savant: 'Savant',
    model_3: 'Model (3-Start)', model_10: 'Model (10-Start)', model_30: 'Model (30-Start)',
  };
```

- [ ] **Step 5: Add m3_pts and m10_pts to DEFAULT_VISIBLE**

In the `DEFAULT_VISIBLE` Set, add:

```js
  'm3_pts', 'm10_pts',
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/PlayerTable.jsx
git commit -m "feat: add pitcher model columns to UI (3/10/30 rolling windows, amber headers)"
```

---

### Task 7: End-to-end verification

- [ ] **Step 1: Start the server**

Run: `cd server && node src/index.js`
Expected: Server starts without errors.

- [ ] **Step 2: Test the pitcher-starts scrape endpoint**

In a separate terminal:
```bash
curl -X POST http://localhost:3000/api/scrape/pitcher-starts
```
Expected: JSON response with `{ "ok": true, "starts": <number>, "pitchers": <number> }`. May take 30-60 seconds due to MLB API calls.

- [ ] **Step 3: Verify model data in rankings**

```bash
curl http://localhost:3000/api/rankings | node -e "process.stdin.on('data', d => { const rows = JSON.parse(d); const sp = rows.find(r => r.m3_pts != null); if (sp) { console.log(sp.name, 'm3_pts:', sp.m3_pts, 'm10_pts:', sp.m10_pts); } else { console.log('No model data found — may need more starts in DB'); } })"
```
Expected: A pitcher name with non-null model scores, or a message if the season hasn't started yet.

- [ ] **Step 4: Verify UI build and column picker**

Run: `npm run build`
Open the app in a browser. Click the "Columns" button. Verify:
- Three new groups appear: "Model (3-Start)", "Model (10-Start)", "Model (30-Start)"
- Group labels appear in amber/orange color
- "Pts" columns for 3-start and 10-start are visible by default

- [ ] **Step 5: Commit any fixes**

If any fixes were needed, commit them:
```bash
git add -A
git commit -m "fix: end-to-end verification fixes for pitcher model"
```
