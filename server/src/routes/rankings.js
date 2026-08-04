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
        r.team_name as fantasy_team,
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
        br.WAR as bat_war,
        se.xwoba as xwoba, se.xwoba_diff as xwoba_diff,
        pa2.IP as a_ip, pa2.GS as a_gs, pa2.G as a_pit_g, pa2.W as a_W, pa2.L as a_L,
        pa2.QS as a_QS, pa2.SV as a_SV, pa2.SO as a_pit_so, pa2.BB as a_pit_bb,
        pa2.K9 as a_k9, pa2.BB9 as a_bb9, pa2.ERA as a_era, pa2.WHIP as a_whip,
        pa2.FIP as a_fip, pa2.HLD as a_hld, pa2.WAR as a_pit_war,
        ba2.PA as a_pa, ba2.AB as a_ab, ba2.G as a_bat_g, ba2.H as a_bat_h,
        ba2."2B" as a_doubles, ba2."3B" as a_triples, ba2.HR as a_hr,
        ba2.R as a_runs, ba2.RBI as a_rbi, ba2.BB as a_bat_bb, ba2.SO as a_bat_so,
        ba2.SB as a_sb, ba2.CS as a_cs,
        ba2.AVG as a_avg, ba2.OBP as a_obp, ba2.SLG as a_slg, ba2.OPS as a_ops,
        ba2.wOBA as a_woba, ba2.wRC as a_wrc_plus, ba2.WAR as a_bat_war,
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
        pm30.regressed_hr9 as m30_hr9, pm30.p_win as m30_pw
      FROM combined_rankings cr
      LEFT JOIN players p ON cr.player_id = p.id
      LEFT JOIN pitchers_raw pr ON pr.player_id = cr.player_id
      LEFT JOIN batters_raw br ON br.player_id = cr.player_id
      LEFT JOIN pitchers_actual pa2 ON pa2.player_id = cr.player_id
      LEFT JOIN batters_actual ba2 ON ba2.player_id = cr.player_id
      LEFT JOIN injuries inj ON inj.player_id = cr.player_id
      LEFT JOIN player_notes pn ON pn.player_id = cr.player_id
      LEFT JOIN rosters r ON r.espn_player_id = p.espn_id
      -- savant_expected is UNIQUE(mlbam_id, player_type), so a player can hold a
      -- pitcher row AND a batter row. Joining on player_id alone matched both and
      -- listed him twice. Pick the profile matching this ranking row, which also
      -- gives a two-way player the right numbers on each of his two rows.
      LEFT JOIN savant_expected se ON se.player_id = cr.player_id
        AND se.player_type = CASE
          WHEN cr.position LIKE '%SP%' OR cr.position LIKE '%RP%' THEN 'P' ELSE 'B' END
      LEFT JOIN pitcher_model pm3 ON pm3.player_id = cr.player_id AND pm3.window = 3
      LEFT JOIN pitcher_model pm10 ON pm10.player_id = cr.player_id AND pm10.window = 10
      LEFT JOIN pitcher_model pm30 ON pm30.player_id = cr.player_id AND pm30.window = 30
      ORDER BY cr.rank
    `).all();
    res.json(rows);
  });

  // Debug endpoint — check ESPN/position matching for a player
  router.get('/debug/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const player = db.prepare('SELECT * FROM players WHERE name LIKE ?').all(`%${name}%`);
    const espn = db.prepare('SELECT * FROM espn_rank WHERE name LIKE ?').all(`%${name}%`);
    const pos = db.prepare('SELECT * FROM position_eligibility WHERE name LIKE ?').all(`%${name}%`);
    const cr = db.prepare('SELECT * FROM combined_rankings WHERE name LIKE ?').all(`%${name}%`);
    res.json({ player, espn, pos, cr });
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
