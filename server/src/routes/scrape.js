import { Router } from 'express';
import { fetchFanGraphs } from '../scrapers/fangraphs.js';
import { fetchSavant } from '../scrapers/savant.js';
import { fetchEspn } from '../scrapers/espn.js';
import { fetchInjuries } from '../scrapers/injuries.js';
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

  router.post('/savant', async (req, res) => {
    try {
      const result = await fetchSavant(db);
      rescoreAll(db);
      setLastRefreshed(db, 'savant');
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/espn', async (req, res) => {
    try {
      const result = await fetchEspn(db);
      rescoreAll(db);
      setLastRefreshed(db, 'espn');
      res.json({ ok: true, ...result });
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

  router.post('/all', async (req, res) => {
    const results = {};
    try {
      results.fangraphs = await fetchFanGraphs(db);
      setLastRefreshed(db, 'fangraphs');
    } catch (e) { results.fangraphs = { error: e.message }; }
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
    // Respond first, then rescore — frees scrape memory before rescore runs
    res.json(results);
    setImmediate(() => {
      try { rescoreAll(db); } catch (e) { console.error('rescoreAll failed:', e); }
    });
  });

  return router;
}
