import { Router } from 'express';
import { rescoreAll } from '../scoring/rescore.js';

export function createConfigRouter(db) {
  const router = Router();

  router.get('/weights', (req, res) => {
    res.json(db.prepare('SELECT * FROM scoring_config ORDER BY category, stat').all());
  });

  router.put('/weights', (req, res) => {
    const { weights } = req.body;
    const update = db.prepare('UPDATE scoring_config SET weight = ? WHERE category = ? AND stat = ?');
    for (const w of weights) update.run(w.weight, w.category, w.stat);
    rescoreAll(db);
    res.json({ ok: true });
  });

  router.get('/positions', (req, res) => {
    res.json(db.prepare('SELECT * FROM position_adjustments ORDER BY position').all());
  });

  router.put('/positions', (req, res) => {
    const { adjustments } = req.body;
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
    // Auto-rescore when scoring-relevant config changes
    if (key === 'replacement_level' || key === 'projection_system') {
      rescoreAll(db);
    }
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
