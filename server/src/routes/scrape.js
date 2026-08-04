import { Router } from 'express';
import { fetchFanGraphs } from '../scrapers/fangraphs.js';
import { fetchRazzball } from '../scrapers/razzball.js';
import { fetchMlbActual } from '../scrapers/mlb-actual.js';
import { fetchSavant } from '../scrapers/savant.js';
import { fetchEspn } from '../scrapers/espn.js';
import { fetchInjuries } from '../scrapers/injuries.js';
import { fetchRosters } from '../scrapers/rosters.js';
import { fetchPitcherStarts } from '../scrapers/pitcher-starts.js';
import { runPlanning } from '../planning/compute.js';
import { refreshTeamOffense } from '../scrapers/team-offense.js';
import { computePitcherModel } from '../scoring/pitcher-model.js';
import { rescoreAll } from '../scoring/rescore.js';

function setLastRefreshed(db, source) {
  db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)")
    .run(`last_refreshed_${source}`, new Date().toISOString());
}

function setLastDuration(db, source, ms) {
  db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)")
    .run(`last_duration_${source}`, String(ms));
}

function seasonYear(db) {
  const r = db.prepare('SELECT value FROM app_config WHERE key = ?').get('season_year');
  return Number(r?.value || new Date().getFullYear());
}

// Two cheap StatsAPI calls; never fail the planning refresh over it.
async function refreshTeamOffenseSafe(db) {
  try {
    return await refreshTeamOffense(db, seasonYear(db));
  } catch (e) {
    console.error('Team offense refresh failed:', e.message);
    return { error: e.message };
  }
}

export function createScrapeRouter(db) {
  const router = Router();

  // Expose last durations so client can estimate progress
  router.get('/durations', (req, res) => {
    const rows = db.prepare("SELECT key, value FROM app_config WHERE key LIKE 'last_duration_%'").all();
    const durations = {};
    for (const r of rows) durations[r.key.replace('last_duration_', '')] = Number(r.value);
    res.json(durations);
  });

  router.post('/fangraphs', async (req, res) => {
    const t0 = Date.now();
    try {
      const result = await fetchFanGraphs(db);
      rescoreAll(db);
      setLastRefreshed(db, 'fangraphs');
      setLastDuration(db, 'fangraphs', Date.now() - t0);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Razzball's published Steamer projections — the automatic replacement for
  // /fangraphs, which now 403s behind FanGraphs' Cloudflare bot challenge.
  router.post('/razzball', async (req, res) => {
    const t0 = Date.now();
    try {
      const result = await fetchRazzball(db);
      rescoreAll(db);
      setLastRefreshed(db, 'razzball');
      setLastDuration(db, 'razzball', Date.now() - t0);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Season actuals from MLB StatsAPI. Replaces /fangraphs-actual, whose leaders
  // endpoint 403s behind the same Cloudflare challenge as the projections.
  router.post('/mlb-actual', async (req, res) => {
    const t0 = Date.now();
    try {
      const result = await fetchMlbActual(db);
      setLastRefreshed(db, 'mlb_actual');
      setLastDuration(db, 'mlb-actual', Date.now() - t0);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/savant', async (req, res) => {
    const t0 = Date.now();
    try {
      const result = await fetchSavant(db);
      setLastRefreshed(db, 'savant');
      setLastDuration(db, 'savant', Date.now() - t0);
      res.json({ ok: true, ...result });
      setImmediate(() => {
        try { rescoreAll(db); } catch (e) { console.error('rescoreAll after Savant failed:', e); }
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/espn', async (req, res) => {
    const t0 = Date.now();
    try {
      const result = await fetchEspn(db);
      setLastRefreshed(db, 'espn');
      setLastDuration(db, 'espn', Date.now() - t0);
      res.json({ ok: true, ...result, note: 'Rescore needed — trigger FanGraphs refresh or /rescore' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/injuries', async (req, res) => {
    const t0 = Date.now();
    try {
      const result = await fetchInjuries(db);
      setLastRefreshed(db, 'injuries');
      setLastDuration(db, 'injuries', Date.now() - t0);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/rosters', async (req, res) => {
    const t0 = Date.now();
    try {
      const result = await fetchRosters(db);
      setLastRefreshed(db, 'rosters');
      setLastDuration(db, 'rosters', Date.now() - t0);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/pitcher-starts', async (req, res) => {
    const t0 = Date.now();
    const wantsSSE = (req.headers.accept || '').includes('text/event-stream');
    if (wantsSSE) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      try {
        const result = await fetchPitcherStarts(db, (step, total, message) => {
          send({ type: 'progress', step, total, message });
        });
        setLastRefreshed(db, 'pitcher_starts');
        setLastDuration(db, 'pitcher-starts', Date.now() - t0);
        send({ type: 'done', result: { ok: true, ...result } });
        res.end();
        setImmediate(() => {
          try { computePitcherModel(db); } catch (e) { console.error('Pitcher model failed:', e); }
        });
      } catch (e) {
        send({ type: 'error', error: e.message });
        res.end();
      }
    } else {
      try {
        const result = await fetchPitcherStarts(db);
        setLastRefreshed(db, 'pitcher_starts');
        setLastDuration(db, 'pitcher-starts', Date.now() - t0);
        res.json({ ok: true, ...result });
        setImmediate(() => {
          try { computePitcherModel(db); } catch (e) { console.error('Pitcher model failed:', e); }
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  });

  router.post('/planning', async (req, res) => {
    const t0 = Date.now();
    const wantsSSE = (req.headers.accept || '').includes('text/event-stream');
    if (wantsSSE) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      try {
        const result = await runPlanning(db, (step, total, message) => {
          send({ type: 'progress', step, total, message });
        });
        send({ type: 'progress', step: 5, total: 6, message: 'Fetching team offense...' });
        const teamOffense = await refreshTeamOffenseSafe(db);
        setLastRefreshed(db, 'planning');
        setLastDuration(db, 'planning', Date.now() - t0);
        send({ type: 'done', result: { ok: true, ...result, team_offense: teamOffense } });
        res.end();
      } catch (e) {
        send({ type: 'error', error: e.message });
        res.end();
      }
    } else {
      try {
        const result = await runPlanning(db);
        const teamOffense = await refreshTeamOffenseSafe(db);
        setLastRefreshed(db, 'planning');
        setLastDuration(db, 'planning', Date.now() - t0);
        res.json({ ok: true, ...result, team_offense: teamOffense });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  });

  router.post('/rescore', (req, res) => {
    try {
      rescoreAll(db);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/all', async (req, res) => {
    const results = {};
    // Projections come from Razzball now — fetchFanGraphs 403s behind
    // Cloudflare and FanGraphs does not support programmatic access.
    try {
      results.razzball = await fetchRazzball(db);
      setLastRefreshed(db, 'razzball');
    } catch (e) { results.razzball = { error: e.message }; }
    try {
      results.mlb_actual = await fetchMlbActual(db);
      setLastRefreshed(db, 'mlb_actual');
    } catch (e) { results.mlb_actual = { error: e.message }; }
    try {
      results.savant = await fetchSavant(db);
      setLastRefreshed(db, 'savant');
    } catch (e) { results.savant = { error: e.message }; }
    try {
      results.espn = await fetchEspn(db);
      setLastRefreshed(db, 'espn');
    } catch (e) { results.espn = { error: e.message }; }
    try {
      results.injuries = await fetchInjuries(db);
      setLastRefreshed(db, 'injuries');
    } catch (e) { results.injuries = { error: e.message }; }
    try {
      results.rosters = await fetchRosters(db);
      setLastRefreshed(db, 'rosters');
    } catch (e) { results.rosters = { error: e.message }; }
    try {
      results.pitcher_starts = await fetchPitcherStarts(db);
      setLastRefreshed(db, 'pitcher_starts');
    } catch (e) { results.pitcher_starts = { error: e.message }; }
    // Respond first, then rescore — frees scrape memory before rescore runs
    res.json(results);
    setImmediate(() => {
      try { rescoreAll(db); } catch (e) { console.error('rescoreAll failed:', e); }
    });
  });

  return router;
}
