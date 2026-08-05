// Orchestrates the planning projection: fetch schedule + handedness, derive
// batter start history from lineups, run the rotation engine, compute hitter
// playing-time rates, and persist playing_time_projection.

import { fetchSchedule, fetchHandedness, fetchIlTransactions, upsertSchedule } from '../scrapers/planning.js';
import { projectTeamRotation, inferRotation } from './rotation.js';
import { createPlayerLinker } from './player-link.js';
import { batterRates, expGamesForBatter } from './batter-rate.js';
import { buildIlIntervals, isOnIl } from './il.js';
import { weekBoundaries, bucketGamesByWeek } from './weeks.js';

const POS_BATTER = /\b(C|1B|2B|3B|SS|OF|LF|CF|RF|DH|UTIL)\b/;

// A game that actually happened, whatever StatsAPI calls it. This used to test
// `status === 'Final'`, which silently dropped rain-shortened games: they are
// neither Final (so not counted as past) nor in the future window (their date
// has passed), so the game vanished entirely — taking its starting pitcher with
// it. One such game collapsed Philadelphia to a phantom 4-man rotation, shifting
// every arm up a slot and moving Aaron Nola's two-start week a week late.
// Detail suffixes exist too ("Completed Early: Rain"), hence the prefix match.
export function isPlayed(status) {
  return /^(Final|Game Over|Completed Early)/i.test(String(status ?? ''));
}

// A game that will not be played as scheduled. Previously any non-Final game in
// the window was treated as playable, so a postponement still had a starter
// projected against it.
export function isCalledOff(status) {
  return /^(Postponed|Cancell?ed|Suspended)/i.test(String(status ?? ''));
}

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

  // How lossy is that join? players.mlbam_id is only stamped on by the Savant /
  // statcast scrapers, so ranked players they never matched are invisible to the
  // whole projection. Measure it so the refresh result can report the gap; the
  // linker below repairs the ones the schedule can identify.
  const rankedTotal = db.prepare('SELECT COUNT(*) c FROM combined_rankings').get().c;
  const rankedUnmapped = db.prepare(`
    SELECT COUNT(*) c FROM combined_rankings cr
    LEFT JOIN players p ON p.id = cr.player_id
    WHERE p.id IS NULL OR p.mlbam_id IS NULL
  `).get().c;

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
  const teamFutureGames = new Map();  // team_id -> [{game_pk, game_date, announced_sp, opp_team_id, is_home}]
  const teamCompletedGames = new Map(); // team_id -> [{game_pk, game_date, isHome, lineup:Set, opp_sp}]
  const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };

  // The schedule only contains MLB clubs, so its team ids define the valid set.
  // A player whose currentTeam (from the people API) is a minor-league affiliate
  // (rehab/optioned) won't match here, triggering the lastMlbClub fallback below.
  const validMlbTeamIds = new Set();
  const lastMlbClub = new Map(); // mlbam -> { team_id, game_date } of most recent appearance
  const noteAppearance = (mlbam, teamId, date) => {
    const cur = lastMlbClub.get(mlbam);
    if (!cur || date > cur.game_date) lastMlbClub.set(mlbam, { team_id: teamId, game_date: date });
  };

  for (const g of games) {
    if (g.home_team_id) validMlbTeamIds.add(g.home_team_id);
    if (g.away_team_id) validMlbTeamIds.add(g.away_team_id);
    // Starting pitchers are not in the `lineups` hydrate (that's the batting
    // order), so note them separately or a schedule-only pitcher has no club.
    if (g.home_sp_mlbam) noteAppearance(g.home_sp_mlbam, g.home_team_id, g.game_date);
    if (g.away_sp_mlbam) noteAppearance(g.away_sp_mlbam, g.away_team_id, g.game_date);
    if (isPlayed(g.status)) {
      for (const m of g.home_lineup || []) noteAppearance(m, g.home_team_id, g.game_date);
      for (const m of g.away_lineup || []) noteAppearance(m, g.away_team_id, g.game_date);
      push(teamPastStarts, g.home_team_id, { game_date: g.game_date, sp_mlbam: g.home_sp_mlbam });
      push(teamPastStarts, g.away_team_id, { game_date: g.game_date, sp_mlbam: g.away_sp_mlbam });
      push(teamCompletedGames, g.home_team_id, { game_date: g.game_date, lineup: new Set(g.home_lineup), opp_sp: g.away_sp_mlbam, opp_team_id: g.away_team_id });
      push(teamCompletedGames, g.away_team_id, { game_date: g.game_date, lineup: new Set(g.away_lineup), opp_sp: g.home_sp_mlbam, opp_team_id: g.home_team_id });
    } else if (!isCalledOff(g.status) && g.game_date >= asOf && g.game_date <= windowEnd) {
      // is_home is stamped here, from the schedule row itself, so a projected
      // start never has to guess which side of the matchup its club was on.
      push(teamFutureGames, g.home_team_id, { game_pk: g.game_pk, game_date: g.game_date, announced_sp: g.home_sp_mlbam, opp_team_id: g.away_team_id, is_home: 1 });
      push(teamFutureGames, g.away_team_id, { game_pk: g.game_pk, game_date: g.game_date, announced_sp: g.away_sp_mlbam, opp_team_id: g.home_team_id, is_home: 0 });
    }
  }

  // 4. Derive batter_game_logs from lineups (ranked batters only).
  const batters = ranked.filter(r => POS_BATTER.test(r.position || '') && !/\bSP\b|\bRP\b/.test(r.position || ''));
  // currentTeam from the people API returns a minor-league affiliate id when a
  // player is on a rehab assignment or optioned, which finds zero games in the
  // MLB-only schedule. Fall back to the player's last MLB club from the lineups.
  const teamOf = (mlbam) => {
    const t = handMap.get(mlbam)?.mlb_team_id ?? null;
    if (t != null && validMlbTeamIds.has(t)) return t;
    return lastMlbClub.get(mlbam)?.team_id ?? t;
  };
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
  // Per-start detail, keyed by mlbam. playing_time_projection can only hold the
  // weekly count, so the opponent/home-away of each individual turn is collected
  // here and persisted to projected_start below.
  const startsByMlbam = new Map();          // mlbam -> [{ week_index, game_pk, game_date, team_id, opp_team_id, is_home, confidence }]
  // Every pitcher the schedule/rotation engine touches in the window, and the
  // club he does it for. This is the real pitcher universe — it includes the
  // streamers, call-ups and back-end starters that combined_rankings omits.
  const scheduleTeamOf = new Map();         // mlbam -> team_id
  // Which club each pitcher belongs to NOW. A traded arm keeps appearing in his
  // old club's start history, so without this he stays in that rotation while
  // also joining his new one and the two schedules stack into impossible weeks.
  const lastStartTeam = new Map(); // mlbam -> { team_id, game_date }
  for (const [tid, starts] of teamPastStarts) {
    for (const s of starts) {
      if (!s.sp_mlbam) continue;
      const cur = lastStartTeam.get(s.sp_mlbam);
      if (!cur || s.game_date > cur.game_date) {
        lastStartTeam.set(s.sp_mlbam, { team_id: tid, game_date: s.game_date });
      }
    }
  }
  // currentTeam from the people API is authoritative when it names a real MLB
  // club (it reports a minor-league affiliate for rehab/optioned players); the
  // club he most recently started for is the fallback.
  const currentClubOf = (mlbam) => {
    const t = handMap.get(mlbam)?.mlb_team_id ?? null;
    if (t != null && validMlbTeamIds.has(t)) return t;
    return lastStartTeam.get(mlbam)?.team_id ?? lastMlbClub.get(mlbam)?.team_id ?? null;
  };

  for (const [teamId, future] of teamFutureGames) {
    const past = teamPastStarts.get(teamId) || [];
    // Only pitchers whose club is known to be elsewhere are dropped; an unknown
    // club leaves him where his starts put him.
    const departed = new Set();
    for (const s of past) {
      if (!s.sp_mlbam) continue;
      const club = currentClubOf(s.sp_mlbam);
      if (club != null && club !== teamId) departed.add(s.sp_mlbam);
    }
    // Members of the inferred active rotation count too: in a 5-game week a
    // 6-man rotation leaves someone without a turn, and he still belongs on the
    // board (with 0 starts) rather than vanishing.
    for (const m of inferRotation(past, { openerIds, injured, rotationSizeDefault }).members) {
      if (m.mlbam && !departed.has(m.mlbam) && !scheduleTeamOf.has(m.mlbam)) scheduleTeamOf.set(m.mlbam, teamId);
    }
    // The rotation engine only echoes back game_pk/game_date, so re-join to the
    // schedule entries to recover the opponent and home/away for each turn.
    const futureByPk = new Map(future.map(f => [f.game_pk, f]));
    const assigns = projectTeamRotation(past, future, { openerIds, injured, rotationSizeDefault, departed });
    for (const a of assigns) {
      projectedSpByGameTeam.set(`${a.game_pk}|${teamId}`, { sp: a.sp_mlbam, confidence: a.confidence });
      if (!a.sp_mlbam) continue;
      scheduleTeamOf.set(a.sp_mlbam, teamId); // an actual assignment wins over membership
      const wk = boundaries.find(w => a.game_date >= w.start && a.game_date <= w.end);
      if (!wk) continue;
      const key = `${a.sp_mlbam}|${wk.week_index}`;
      const cur = pitcherWeekStarts.get(key) || { count: 0, allAnnounced: true };
      cur.count++;
      if (a.confidence !== 'announced') cur.allAnnounced = false;
      pitcherWeekStarts.set(key, cur);

      const fg = futureByPk.get(a.game_pk);
      if (!startsByMlbam.has(a.sp_mlbam)) startsByMlbam.set(a.sp_mlbam, []);
      startsByMlbam.get(a.sp_mlbam).push({
        week_index: wk.week_index,
        game_pk: a.game_pk,
        game_date: a.game_date,
        team_id: teamId,
        opp_team_id: fg?.opp_team_id ?? null,
        is_home: fg?.is_home ?? null,
        confidence: a.confidence,
      });
    }
  }

  // 7. Persist projections.
  progress(4, 5, 'Writing projections...');
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

  const insStart = db.prepare(`
    INSERT INTO projected_start
      (player_id, mlbam_id, week_index, game_pk, game_date, team_id, opp_team_id, is_home, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mlbam_id, game_pk) DO UPDATE SET
      player_id=excluded.player_id, week_index=excluded.week_index, game_date=excluded.game_date,
      team_id=excluded.team_id, opp_team_id=excluded.opp_team_id, is_home=excluded.is_home,
      confidence=excluded.confidence
  `);

  // 7a. Build the pitcher universe.
  //
  // Ranked pitchers (anything with SP/RP in position) are the floor, not the
  // ceiling: combined_rankings is a draft-value list, so it omits exactly the
  // arms a manager streams. Union it with every pitcher the rotation engine
  // touched above, linking each one to a players row (adopting an unmapped row
  // or creating one) so playing_time_projection.player_id has something to
  // point at.
  const rankedPitchers = ranked.filter(r => /\bSP\b|\bRP\b/.test(r.position || ''));
  const batterMlbam = new Set(batters.map(b => b.mlbam_id));
  // Never let a schedule pitcher adopt a players row that a ranking file already
  // calls a position player — a duplicate row is cheaper than a mis-link.
  const rankedBatterPid = new Set(
    db.prepare('SELECT player_id, position FROM combined_rankings WHERE player_id IS NOT NULL').all()
      .filter(r => POS_BATTER.test(r.position || '') && !/\bSP\b|\bRP\b/.test(r.position || ''))
      .map(r => r.player_id)
  );
  const linker = createPlayerLinker(db, { excludeIds: rankedBatterPid });

  const pitchers = [];
  const seenPitcherPid = new Set();
  const addPitcher = (playerId, mlbamId) => {
    if (!playerId || seenPitcherPid.has(playerId)) return;
    seenPitcherPid.add(playerId);
    pitchers.push({ player_id: playerId, mlbam_id: mlbamId });
  };
  for (const p of rankedPitchers) addPitcher(p.player_id, p.mlbam_id);

  // Skip mlbams already covered as a ranked pitcher, and any claimed by a ranked
  // batter (a two-way player must not get two conflicting rows for one player_id).
  const rankedPitcherMlbam = new Set(rankedPitchers.map(r => r.mlbam_id));
  const extraMlbam = [...scheduleTeamOf.keys()]
    .filter(m => m && !rankedPitcherMlbam.has(m) && !batterMlbam.has(m))
    .sort();

  let addedPitchers = 0;
  db.transaction(() => {
    for (const m of extraMlbam) {
      const info = handMap.get(m) || {};
      const pid = linker.ensure(m, { name: info.full_name, team: info.team_abbrev });
      if (!pid || seenPitcherPid.has(pid) || rankedBatterPid.has(pid)) continue;
      addPitcher(pid, m);
      addedPitchers++;
    }
    // Newly created/adopted rows missed the handedness pass above.
    for (const p of pitchers) {
      const h = handMap.get(p.mlbam_id);
      if (h) updPlayer.run(h.bat_hand, h.throw_hand, h.mlb_team_id, p.mlbam_id);
    }
  })();

  // A pitcher's club: current team when it's a real MLB club, else the team
  // whose rotation the engine just put him in, else his last MLB appearance.
  const pitcherTeamOf = (mlbam) => {
    const t = handMap.get(mlbam)?.mlb_team_id ?? null;
    if (t != null && validMlbTeamIds.has(t)) return t;
    return scheduleTeamOf.get(mlbam) ?? lastMlbClub.get(mlbam)?.team_id ?? t;
  };

  const bglStmt = db.prepare('SELECT game_date, started, opp_sp_hand FROM batter_game_logs WHERE mlbam_id = ?');
  progress(4, 5, `Writing projections for ${pitchers.length} pitchers (${addedPitchers} unranked) + ${batters.length} batters...`);

  db.transaction(() => {
    db.prepare('DELETE FROM playing_time_projection').run();
    // Same delete-and-rebuild discipline: a start that got reassigned to another
    // arm (or a game that left the window) must not linger.
    db.prepare('DELETE FROM projected_start').run();

    // Pitchers
    for (const p of pitchers) {
      const teamId = pitcherTeamOf(p.mlbam_id);
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
      // Only pitchers in this universe get start rows, so starts.length always
      // agrees with exp_starts for every week the API emits. (A two-way player
      // covered as a batter is deliberately excluded from both.)
      for (const s of startsByMlbam.get(p.mlbam_id) || []) {
        insStart.run(p.player_id, p.mlbam_id, s.week_index, s.game_pk, s.game_date,
          s.team_id, s.opp_team_id, s.is_home, s.confidence);
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
  return {
    games: games.length,
    pitchers: pitchers.length,
    batters: batters.length,
    ranked_pitchers: rankedPitchers.length,
    // Pitchers surfaced purely from the schedule (streamers/call-ups/back-end
    // starters) plus how they were linked to a players row.
    unranked_pitchers: addedPitchers,
    players_adopted: linker.stats.adopted,
    players_created: linker.stats.created,
    // Ranked rows the mlbam mapping still can't reach (no schedule presence).
    ranked_total: rankedTotal,
    ranked_unmapped: rankedUnmapped,
  };
}
