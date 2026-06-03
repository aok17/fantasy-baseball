// Orchestrates the planning projection: fetch schedule + handedness, derive
// batter start history from lineups, run the rotation engine, compute hitter
// playing-time rates, and persist playing_time_projection.

import { fetchSchedule, fetchHandedness, fetchIlTransactions, upsertSchedule } from '../scrapers/planning.js';
import { projectTeamRotation } from './rotation.js';
import { batterRates, expGamesForBatter } from './batter-rate.js';
import { buildIlIntervals, isOnIl } from './il.js';
import { weekBoundaries, bucketGamesByWeek } from './weeks.js';

const POS_BATTER = /\b(C|1B|2B|3B|SS|OF|LF|CF|RF|DH|UTIL)\b/;

function cfg(db, key, fallback) {
  const r = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return r ? r.value : fallback;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function runPlanning(db, onProgress) {
  const progress = onProgress || (() => {});
  const season = Number(cfg(db, 'season_year', new Date().getFullYear()));

  // 1. Schedule (full season, lineups in memory for batter derivation).
  progress(0, 5, 'Fetching MLB schedule...');
  const games = await fetchSchedule(season);
  upsertSchedule(db, games);
  progress(1, 5, `Schedule: ${games.length} games`);

  // 2. Handedness + team for every player we care about (ranked players + all SPs seen).
  const ranked = db.prepare(`
    SELECT cr.player_id, cr.position, p.mlbam_id
    FROM combined_rankings cr JOIN players p ON p.id = cr.player_id
    WHERE p.mlbam_id IS NOT NULL
  `).all();
  const spIds = new Set();
  for (const g of games) {
    if (g.home_sp_mlbam) spIds.add(g.home_sp_mlbam);
    if (g.away_sp_mlbam) spIds.add(g.away_sp_mlbam);
  }
  const wantHand = [...new Set([...ranked.map(r => r.mlbam_id), ...spIds])];
  progress(1, 5, `Fetching handedness for ${wantHand.length} players...`);
  const handMap = await fetchHandedness(wantHand);

  // IL stints, so injured games are excluded from batter start rates (an IL day
  // is not a "rest" day). Per-team fetch over every MLB team in the schedule.
  const teamIds = new Set();
  for (const g of games) {
    if (g.home_team_id) teamIds.add(g.home_team_id);
    if (g.away_team_id) teamIds.add(g.away_team_id);
  }
  progress(1, 5, `Fetching IL transactions for ${teamIds.size} teams...`);
  const ilEvents = await fetchIlTransactions(season, [...teamIds], { endDate: today() });
  const ilIntervals = buildIlIntervals(ilEvents);

  return computeProjections(db, { games, handMap, ilIntervals, asOf: today(), progress });
}

// Pure-of-network projection: given fetched schedule + handedness, derive batter
// history, run the rotation engine, compute hitter rates, persist projections.
// Split out from runPlanning so it can be integration-tested with a seeded DB.
export function computeProjections(db, { games, handMap, ilIntervals = new Map(), asOf, progress = () => {} }) {
  const season = Number(cfg(db, 'season_year', new Date().getFullYear()));
  const weekStart = cfg(db, 'planning_week_start', 'monday');
  const halfLife = Number(cfg(db, 'recency_half_life_days', '21'));
  const rotationSizeDefault = Number(cfg(db, 'rotation_size', '5'));
  const numWeeks = Number(cfg(db, 'planning_weeks', '4'));

  const ranked = db.prepare(`
    SELECT cr.player_id, cr.position, p.mlbam_id
    FROM combined_rankings cr JOIN players p ON p.id = cr.player_id
    WHERE p.mlbam_id IS NOT NULL
  `).all();

  // Persist hand/team onto players rows we have.
  const updPlayer = db.prepare('UPDATE players SET bat_hand=?, throw_hand=?, mlb_team_id=? WHERE mlbam_id=?');
  db.transaction(() => {
    for (const [mlbam, h] of handMap) updPlayer.run(h.bat_hand, h.throw_hand, h.mlb_team_id, mlbam);
  })();
  const handOf = (mlbam) => (mlbam && handMap.get(mlbam)?.throw_hand) || null;
  progress(2, 5, 'Deriving batter start history...');

  // 3. Index games by team; split past (Final) vs future (in window).
  const boundaries = weekBoundaries(asOf, weekStart, numWeeks);
  const windowEnd = boundaries[boundaries.length - 1].end;
  const teamPastStarts = new Map();   // team_id -> [{game_date, sp_mlbam}]
  const teamFutureGames = new Map();  // team_id -> [{game_pk, game_date, announced_sp}]
  const teamCompletedGames = new Map(); // team_id -> [{game_pk, game_date, isHome, lineup:Set, opp_sp}]
  const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };

  for (const g of games) {
    const isFinal = g.status === 'Final';
    if (isFinal) {
      push(teamPastStarts, g.home_team_id, { game_date: g.game_date, sp_mlbam: g.home_sp_mlbam });
      push(teamPastStarts, g.away_team_id, { game_date: g.game_date, sp_mlbam: g.away_sp_mlbam });
      push(teamCompletedGames, g.home_team_id, { game_date: g.game_date, lineup: new Set(g.home_lineup), opp_sp: g.away_sp_mlbam, opp_team_id: g.away_team_id });
      push(teamCompletedGames, g.away_team_id, { game_date: g.game_date, lineup: new Set(g.away_lineup), opp_sp: g.home_sp_mlbam, opp_team_id: g.home_team_id });
    } else if (g.game_date >= asOf && g.game_date <= windowEnd) {
      push(teamFutureGames, g.home_team_id, { game_pk: g.game_pk, game_date: g.game_date, announced_sp: g.home_sp_mlbam, opp_team_id: g.away_team_id });
      push(teamFutureGames, g.away_team_id, { game_pk: g.game_pk, game_date: g.game_date, announced_sp: g.away_sp_mlbam, opp_team_id: g.home_team_id });
    }
  }

  // 4. Derive batter_game_logs from lineups (ranked batters only).
  const batters = ranked.filter(r => POS_BATTER.test(r.position || '') && !/\bSP\b|\bRP\b/.test(r.position || ''));
  const teamOf = (mlbam) => handMap.get(mlbam)?.mlb_team_id ?? null;
  const insBGL = db.prepare(`
    INSERT INTO batter_game_logs (player_id, mlbam_id, game_date, season, opp_team_id, opp_sp_mlbam, opp_sp_hand, started)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mlbam_id, game_date) DO UPDATE SET
      started=excluded.started, opp_sp_mlbam=excluded.opp_sp_mlbam,
      opp_sp_hand=excluded.opp_sp_hand, player_id=excluded.player_id
  `);
  db.transaction(() => {
    // Rebuild from scratch so stale started=0 rows (e.g. games a player was on
    // the IL for, written by an earlier run) don't linger and depress the rate.
    db.prepare('DELETE FROM batter_game_logs').run();
    for (const b of batters) {
      const teamId = teamOf(b.mlbam_id);
      if (!teamId) continue;
      const teamGames = teamCompletedGames.get(teamId) || [];
      for (const cg of teamGames) {
        const started = cg.lineup.has(b.mlbam_id) ? 1 : 0;
        // An IL day is not a rest day — skip injured non-starts so they don't
        // count as missed starts and drag the recency-weighted rate down. But a
        // start is ground-truth health: always count it, even if a stale/
        // open-ended IL interval (e.g. a placement whose activation never made
        // the transaction feed) claims he was still out. Trust the lineup.
        if (started === 0 && isOnIl(ilIntervals, b.mlbam_id, cg.game_date)) continue;
        insBGL.run(b.player_id, b.mlbam_id, cg.game_date, season,
          cg.opp_team_id, cg.opp_sp, handOf(cg.opp_sp), started);
      }
    }
  })();
  progress(3, 5, 'Projecting rotations...');

  // 5. Opener + injury sets for the rotation engine.
  const openerIds = new Set(
    db.prepare(`
      SELECT p.mlbam_id, pr.GS, pr.IP FROM pitchers_raw pr JOIN players p ON p.id = pr.player_id
      WHERE pr.GS >= 3 AND pr.IP IS NOT NULL AND (pr.IP * 1.0 / pr.GS) < 3.0 AND p.mlbam_id IS NOT NULL
    `).all().map(r => String(r.mlbam_id))
  );
  // Only active IL stints count as injured. The injuries feed also carries
  // "Activated" rows (players already back) — those must NOT zero playing time.
  const injured = new Set(
    db.prepare("SELECT DISTINCT mlbam_id FROM injuries WHERE mlbam_id IS NOT NULL AND status LIKE '%IL%'").all().map(r => String(r.mlbam_id))
  );

  // 6. Project each team's rotation; collect per-game projected SP for opp-hand lookups.
  const projectedSpByGameTeam = new Map(); // `${game_pk}|${team_id}` -> { sp, confidence }
  const pitcherWeekStarts = new Map();      // `${mlbam}|${week_index}` -> { count, allAnnounced }
  for (const [teamId, future] of teamFutureGames) {
    const past = teamPastStarts.get(teamId) || [];
    const assigns = projectTeamRotation(past, future, { openerIds, injured, rotationSizeDefault });
    for (const a of assigns) {
      projectedSpByGameTeam.set(`${a.game_pk}|${teamId}`, { sp: a.sp_mlbam, confidence: a.confidence });
      if (!a.sp_mlbam) continue;
      const wk = boundaries.find(w => a.game_date >= w.start && a.game_date <= w.end);
      if (!wk) continue;
      const key = `${a.sp_mlbam}|${wk.week_index}`;
      const cur = pitcherWeekStarts.get(key) || { count: 0, allAnnounced: true };
      cur.count++;
      if (a.confidence !== 'announced') cur.allAnnounced = false;
      pitcherWeekStarts.set(key, cur);
    }
  }

  // 7. Persist projections.
  progress(4, 5, 'Writing projections...');
  const playerByMlbam = new Map(
    db.prepare('SELECT id, mlbam_id FROM players WHERE mlbam_id IS NOT NULL').all().map(r => [String(r.mlbam_id), r.id])
  );
  const upPTP = db.prepare(`
    INSERT INTO playing_time_projection
      (player_id, week_index, week_start, week_end, player_type, games_in_week,
       exp_starts, two_start, exp_games, start_rate, vs_lhp_rate, vs_rhp_rate, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id, week_index) DO UPDATE SET
      week_start=excluded.week_start, week_end=excluded.week_end, player_type=excluded.player_type,
      games_in_week=excluded.games_in_week, exp_starts=excluded.exp_starts, two_start=excluded.two_start,
      exp_games=excluded.exp_games, start_rate=excluded.start_rate,
      vs_lhp_rate=excluded.vs_lhp_rate, vs_rhp_rate=excluded.vs_rhp_rate, confidence=excluded.confidence
  `);

  // Ranked pitchers (anything with SP/RP in position).
  const pitchers = ranked.filter(r => /\bSP\b|\bRP\b/.test(r.position || ''));
  const bglStmt = db.prepare('SELECT game_date, started, opp_sp_hand FROM batter_game_logs WHERE mlbam_id = ?');

  db.transaction(() => {
    db.prepare('DELETE FROM playing_time_projection').run();

    // Pitchers
    for (const p of pitchers) {
      const teamId = teamOf(p.mlbam_id);
      const futureForTeam = teamFutureGames.get(teamId) || [];
      const byWeek = bucketGamesByWeek(futureForTeam, boundaries);
      for (const w of boundaries) {
        const ws = pitcherWeekStarts.get(`${p.mlbam_id}|${w.week_index}`);
        const exp = ws ? ws.count : 0;
        upPTP.run(p.player_id, w.week_index, w.start, w.end, 'P',
          (byWeek.get(w.week_index) || []).length,
          exp, exp >= 2 ? 1 : 0, null, null, null, null,
          ws && ws.allAnnounced ? 'announced' : 'projected');
      }
    }

    // Batters
    for (const b of batters) {
      const teamId = teamOf(b.mlbam_id);
      const rates = batterRates(bglStmt.all(b.mlbam_id), { halfLife, asOfDate: asOf });
      const isInjured = injured.has(b.mlbam_id);
      const futureForTeam = teamFutureGames.get(teamId) || [];
      const byWeek = bucketGamesByWeek(futureForTeam, boundaries);
      for (const w of boundaries) {
        const wkGames = (byWeek.get(w.week_index) || []).map(g => {
          const oppProj = projectedSpByGameTeam.get(`${g.game_pk}|${g.opp_team_id}`);
          return { opp_sp_hand: handOf(oppProj?.sp) };
        });
        const exp = expGamesForBatter(wkGames, rates, isInjured);
        upPTP.run(b.player_id, w.week_index, w.start, w.end, 'B',
          wkGames.length, null, null,
          Number(exp.toFixed(3)),
          rates.start_rate, rates.vs_lhp_rate, rates.vs_rhp_rate,
          rates.eff_n >= 3 ? 'projected' : 'limited');
      }
    }
  })();

  progress(5, 5, 'Done');
  return { games: games.length, pitchers: pitchers.length, batters: batters.length };
}
