import { Router } from 'express';

export function createRankingsRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT
        cr.*,
        p.fg_id,
        p.mlbam_id,
        inj.latest_update as injury,
        pn.note as note,
        pr.IP as ip, pr.GS as gs, pr.G as pit_g, pr.W, pr.L, pr.QS, pr.SV,
        pr.SO as pit_so, pr.BB as pit_bb, pr.K9 as k9, pr.BB9 as bb9,
        pr.ERA as era, pr.WHIP as whip, pr.FIP as fip,
        pr.WAR as pit_war, pr.RA9WAR as ra9war, pr.HLD as hld,
        br.PA as pa, br.AB as ab, br.G as bat_g, br.H as bat_h,
        br."2B" as doubles, br."3B" as triples, br.HR as hr,
        br.R as runs, br.RBI as rbi, br.BB as bat_bb, br.SO as bat_so,
        br.SB as sb, br.CS as cs, br.HBP as hbp,
        br.AVG as avg, br.OBP as obp, br.SLG as slg, br.OPS as ops,
        br.wOBA as woba, br.wRC as wrc_plus,
        br.WAR as bat_war
      FROM combined_rankings cr
      LEFT JOIN players p ON cr.player_id = p.id
      LEFT JOIN pitchers_raw pr ON pr.player_id = cr.player_id
      LEFT JOIN batters_raw br ON br.player_id = cr.player_id
      LEFT JOIN injuries inj ON inj.player_id = cr.player_id
      LEFT JOIN player_notes pn ON pn.player_id = cr.player_id
      ORDER BY cr.rank
    `).all();
    res.json(rows);
  });

  router.put('/notes', (req, res) => {
    const { player_id, note } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });
    if (note) {
      db.prepare('INSERT INTO player_notes (player_id, note) VALUES (?, ?) ON CONFLICT(player_id) DO UPDATE SET note = excluded.note')
        .run(player_id, note);
    } else {
      db.prepare('DELETE FROM player_notes WHERE player_id = ?').run(player_id);
    }
    res.json({ ok: true });
  });

  return router;
}
