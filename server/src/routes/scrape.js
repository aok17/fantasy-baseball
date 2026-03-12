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
