import { Router } from 'express';
import { DraftSync } from '../draft-sync.js';

export function createDraftRouter(db) {
  const router = Router();
  let activeSyncs = {};

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
