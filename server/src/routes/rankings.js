import { Router } from 'express';

export function createRankingsRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM combined_rankings ORDER BY rank').all();
    res.json(rows);
  });

  return router;
}
