import { Router } from 'express';

export function createPlanningRouter(db) {
  const router = Router();

  // GET /api/planning?scope=all|rostered
  // Returns one row per player with a weeks[] array, joined to ranking/value context.
  router.get('/', (req, res) => {
    const scope = req.query.scope === 'rostered' ? 'rostered' : 'all';

    const rows = db.prepare(`
      SELECT
        ptp.player_id, ptp.week_index, ptp.week_start, ptp.week_end, ptp.player_type,
        ptp.games_in_week, ptp.exp_starts, ptp.two_start, ptp.exp_games,
        ptp.start_rate, ptp.vs_lhp_rate, ptp.vs_rhp_rate, ptp.confidence,
        cr.name, cr.position, cr.team, cr.rank,
        p.bat_hand, p.throw_hand,
        r.team_name AS fantasy_team,
        inj.latest_update AS injury,
        pm.pts_per_start AS sp_pts_per_start,
        bs.pts_per_game AS bat_pts_per_game
      FROM playing_time_projection ptp
      JOIN combined_rankings cr ON cr.player_id = ptp.player_id
      LEFT JOIN players p ON p.id = ptp.player_id
      LEFT JOIN rosters r ON r.espn_player_id = p.espn_id
      LEFT JOIN injuries inj ON inj.player_id = ptp.player_id
      LEFT JOIN pitcher_model pm ON pm.player_id = ptp.player_id AND pm.window = 10
      LEFT JOIN batter_scores bs ON bs.player_id = ptp.player_id
      ORDER BY cr.rank, ptp.week_index
    `).all();

    // Pivot to one object per player with weeks[].
    const byPlayer = new Map();
    for (const row of rows) {
      if (scope === 'rostered' && !row.fantasy_team) continue;
      let pl = byPlayer.get(row.player_id);
      if (!pl) {
        pl = {
          player_id: row.player_id,
          name: row.name,
          position: row.position,
          team: row.team,
          rank: row.rank,
          player_type: row.player_type,
          bat_hand: row.bat_hand,
          throw_hand: row.throw_hand,
          fantasy_team: row.fantasy_team,
          injury: row.injury,
          value: row.player_type === 'P' ? row.sp_pts_per_start : row.bat_pts_per_game,
          weeks: [],
        };
        byPlayer.set(row.player_id, pl);
      }
      pl.weeks.push({
        week_index: row.week_index,
        week_start: row.week_start,
        week_end: row.week_end,
        games_in_week: row.games_in_week,
        exp_starts: row.exp_starts,
        two_start: row.two_start,
        exp_games: row.exp_games,
        start_rate: row.start_rate,
        vs_lhp_rate: row.vs_lhp_rate,
        vs_rhp_rate: row.vs_rhp_rate,
        confidence: row.confidence,
      });
    }

    const players = [...byPlayer.values()];
    const weekHeaders = players[0]?.weeks.map(w => ({
      week_index: w.week_index, week_start: w.week_start, week_end: w.week_end,
    })) || [];

    res.json({ weeks: weekHeaders, players });
  });

  return router;
}
