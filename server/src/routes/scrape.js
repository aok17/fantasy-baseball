import { Router } from 'express';
import { fetchFanGraphs, fetchFanGraphsActual } from '../scrapers/fangraphs.js';
import { fetchSavant } from '../scrapers/savant.js';
import { fetchEspn } from '../scrapers/espn.js';
import { fetchInjuries } from '../scrapers/injuries.js';
import { fetchRosters } from '../scrapers/rosters.js';
import { fetchPitcherStarts } from '../scrapers/pitcher-starts.js';
import { computePitcherModel } from '../scoring/pitcher-model.js';
import { rescoreAll } from '../scoring/rescore.js';

function setLastRefreshed(db, source) {
  db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)")
    .run(`last_refreshed_${source}`, new Date().toISOString());
}

export function createScrapeRouter(db) {
  const router = Router();

  router.post('/fangraphs', async (req, res) => {
    try {
      const result = await fetchFanGraphs(db);
      rescoreAll(db);
      setLastRefreshed(db, 'fangraphs');
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/fangraphs-actual', async (req, res) => {
    try {
      const result = await fetchFanGraphsActual(db);
      setLastRefreshed(db, 'fangraphs_actual');
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/savant', async (req, res) => {
    try {
      const result = await fetchSavant(db);
      setLastRefreshed(db, 'savant');
      res.json({ ok: true, ...result });
      setImmediate(() => {
        try { rescoreAll(db); } catch (e) { console.error('rescoreAll after Savant failed:', e); }
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/espn', async (req, res) => {
    try {
      const result = await fetchEspn(db);
      setLastRefreshed(db, 'espn');
      // Don't rescore inline — ESPN fetch uses too much memory on 256MB VM.
      // Rescore will run when triggered separately.
      res.json({ ok: true, ...result, note: 'Rescore needed — trigger FanGraphs refresh or /rescore' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/injuries', async (req, res) => {
    try {
      const result = await fetchInjuries(db);
      setLastRefreshed(db, 'injuries');
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/rosters', async (req, res) => {
    try {
      const result = await fetchRosters(db);
      setLastRefreshed(db, 'rosters');
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

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
    try {
      results.fangraphs = await fetchFanGraphs(db);
      setLastRefreshed(db, 'fangraphs');
    } catch (e) { results.fangraphs = { error: e.message }; }
    try {
      results.fangraphs_actual = await fetchFanGraphsActual(db);
      setLastRefreshed(db, 'fangraphs_actual');
    } catch (e) { results.fangraphs_actual = { error: e.message }; }
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
