import { Router } from 'express';
import { getTeamOffenseMap } from '../scrapers/team-offense.js';

// Ordering helpers. Ranked players lead (by rank); everyone else — mostly the
// schedule-derived pitchers who never make a draft-value list — follows, most
// projected starts first, then alphabetically so the order is stable run to run.
const UNRANKED = Number.MAX_SAFE_INTEGER;
function totalStarts(pl) {
  let n = 0;
  for (const w of pl.weeks) n += w.exp_starts ?? 0;
  return n;
}

export function createPlanningRouter(db) {
  const router = Router();

  // GET /api/planning?scope=all|rostered
  // Returns one row per player with a weeks[] array, joined to ranking/value context.
  router.get('/', (req, res) => {
    const scope = req.query.scope === 'rostered' ? 'rostered' : 'all';

    // combined_rankings is LEFT-joined on purpose: it is a draft-value list, so
    // the streamers/call-ups/back-end starters the projection now covers are not
    // in it. An INNER JOIN here silently deleted every one of them from the API
    // response. Fall back to players for identity, and leave rank null.
    const rows = db.prepare(`
      SELECT
        ptp.player_id, ptp.week_index, ptp.week_start, ptp.week_end, ptp.player_type,
        ptp.games_in_week, ptp.exp_starts, ptp.two_start, ptp.exp_games,
        ptp.start_rate, ptp.vs_lhp_rate, ptp.vs_rhp_rate, ptp.confidence,
        COALESCE(cr.name, p.name) AS name,
        COALESCE(cr.position, CASE WHEN ptp.player_type = 'P' THEN 'SP' END) AS position,
        COALESCE(cr.team, p.team) AS team,
        cr.rank,
        p.bat_hand, p.throw_hand,
        r.team_name AS fantasy_team,
        inj.latest_update AS injury,
        pm.pts_per_start AS sp_pts_per_start,
        bs.pts_per_game AS bat_pts_per_game
      FROM playing_time_projection ptp
      LEFT JOIN players p ON p.id = ptp.player_id
      LEFT JOIN combined_rankings cr ON cr.player_id = ptp.player_id
      LEFT JOIN rosters r ON r.espn_player_id = p.espn_id
      LEFT JOIN injuries inj ON inj.player_id = ptp.player_id
      LEFT JOIN pitcher_model pm ON pm.player_id = ptp.player_id AND pm.window = 10
      LEFT JOIN batter_scores bs ON bs.player_id = ptp.player_id
      ORDER BY ptp.player_id, ptp.week_index
    `).all();

    // Per-start detail for pitchers. Two flat reads — the offense lookup table
    // and every projected start — pre-grouped by (player_id, week_index), so
    // attaching them below costs one Map hit per week instead of a query per
    // player. mlb_team_offense is only populated on refresh and may be empty;
    // a missing team degrades to null offense fields but the opponent id (and
    // therefore the start itself) is always emitted.
    const offense = getTeamOffenseMap(db);
    const startsByPlayerWeek = new Map(); // `${player_id}|${week_index}` -> starts[]
    const startRows = db.prepare(`
      SELECT player_id, week_index, game_pk, game_date, opp_team_id, is_home, confidence
      FROM projected_start
      ORDER BY game_date, game_pk
    `).all();
    for (const s of startRows) {
      const key = `${s.player_id}|${s.week_index}`;
      let arr = startsByPlayerWeek.get(key);
      if (!arr) { arr = []; startsByPlayerWeek.set(key, arr); }
      const off = s.opp_team_id != null ? offense.get(s.opp_team_id) : null;
      arr.push({
        game_date: s.game_date,
        game_pk: s.game_pk,
        home: s.is_home === 1,
        opp_team_id: s.opp_team_id,
        opp_team_abbr: off?.abbr ?? null,
        opp_runs_rank: off?.runs_rank ?? null,
        opp_runs_per_game: off?.runs_per_game ?? null,
        confidence: s.confidence,
      });
    }

    // Pivot to one object per player with weeks[].
    const byPlayer = new Map();
    const seenWeeks = new Map(); // player_id -> Set(week_index); combined_rankings
                                 // is not unique per player, so a duplicate
                                 // ranking row must not duplicate the weeks.
    for (const row of rows) {
      if (scope === 'rostered' && !row.fantasy_team) continue;
      let pl = byPlayer.get(row.player_id);
      if (!pl) {
        pl = {
          player_id: row.player_id,
          name: row.name,
          position: row.position,
          team: row.team,
          rank: row.rank ?? null,
          player_type: row.player_type,
          bat_hand: row.bat_hand,
          throw_hand: row.throw_hand,
          fantasy_team: row.fantasy_team,
          injury: row.injury,
          value: row.player_type === 'P' ? row.sp_pts_per_start : row.bat_pts_per_game,
          weeks: [],
        };
        byPlayer.set(row.player_id, pl);
        seenWeeks.set(row.player_id, new Set());
      }
      const seen = seenWeeks.get(row.player_id);
      if (seen.has(row.week_index)) continue;
      seen.add(row.week_index);
      const week = {
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
      };
      // Pitchers only, and always an array (never undefined/null) so the client
      // can map over it unconditionally. Hitters keep their old shape exactly.
      if (row.player_type === 'P') {
        week.starts = startsByPlayerWeek.get(`${row.player_id}|${row.week_index}`) || [];
      }
      pl.weeks.push(week);
    }

    const players = [...byPlayer.values()];
    players.sort((a, b) => {
      const ar = a.rank ?? UNRANKED;
      const br = b.rank ?? UNRANKED;
      if (ar !== br) return ar - br;
      if (ar !== UNRANKED) return 0; // equal ranks: keep insertion order
      const d = totalStarts(b) - totalStarts(a);
      if (d) return d;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    // Week headers come from the projection table itself, not from players[0] —
    // the first player is no longer guaranteed to carry a full weeks[] (and the
    // list can be empty entirely under a filter).
    const weekHeaders = db.prepare(`
      SELECT DISTINCT week_index, week_start, week_end
      FROM playing_time_projection
      ORDER BY week_index
    `).all().map(w => ({
      week_index: w.week_index, week_start: w.week_start, week_end: w.week_end,
    }));

    res.json({ weeks: weekHeaders, players });
  });

  return router;
}
