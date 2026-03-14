import { computePitcherScores } from './pitcher-scoring.js';
import { computeBatterScores, resolvePosition } from './batter-scoring.js';
import { buildCombinedRankings } from './combined.js';

function getWeights(db, category) {
  const rows = db.prepare('SELECT stat, weight FROM scoring_config WHERE category = ?').all(category);
  const weights = {};
  for (const r of rows) weights[r.stat] = r.weight;
  return weights;
}

function getPosAdjustments(db) {
  const rows = db.prepare('SELECT position, adjustment FROM position_adjustments').all();
  const adj = {};
  for (const r of rows) adj[r.position] = r.adjustment;
  return adj;
}

function getConfig(db, key) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getVelocityDeltas(db) {
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'season_year'").get();
  const currentYear = Number(row?.value) || new Date().getFullYear();
  const prevYear = currentYear - 1;
  const rows = db.prepare(`
    SELECT player_name, v_prev, v_curr, (v_curr - v_prev) as delta, n_curr FROM (
      SELECT player_name,
        MAX(CASE WHEN season = ? AND season_type = 'regular' THEN velocity END) as v_prev,
        MAX(CASE WHEN season = ? AND season_type = 'spring' THEN velocity END) as v_curr,
        SUM(CASE WHEN season = ? AND season_type = 'spring' THEN 1 ELSE 0 END) as n_curr
      FROM statcast_pitches GROUP BY player_name
    ) WHERE v_prev IS NOT NULL AND v_curr IS NOT NULL AND (v_curr - v_prev) < 10
  `).all(prevYear, currentYear, currentYear);
  const deltas = {};
  for (const r of rows) deltas[r.player_name] = { delta: r.delta, velo_prev: r.v_prev, velo_curr: r.v_curr, velo_n: r.n_curr };
  return deltas;
}

function getEspnAdp(db) {
  const rows = db.prepare('SELECT name, adp_rank FROM espn_adp').all();
  const adp = {};
  for (const r of rows) adp[r.name] = r.adp_rank;
  return adp;
}

export function rescoreAll(db) {
  db.transaction(() => {
    const pitcherWeights = getWeights(db, 'pitcher');
    const batterWeights = getWeights(db, 'batter');
    const posAdj = getPosAdjustments(db);
    const replacementLevel = Number(getConfig(db, 'replacement_level')) || 237;

    const rawPitchers = db.prepare('SELECT * FROM pitchers_raw').all();
    const pitcherScores = computePitcherScores(rawPitchers, pitcherWeights, replacementLevel);

    db.prepare('DELETE FROM pitcher_scores').run();
    const insertPitcher = db.prepare(`
      INSERT INTO pitcher_scores (name, team, scoring_position, display_position,
        raw_score, adjustment, adj_score, starting_pts, relief_pts, adj_2020_value, pts_per_appearance)
      VALUES (@name, @team, @scoring_position, @display_position,
        @raw_score, @adjustment, @adj_score, @starting_pts, @relief_pts, @adj_2020_value, @pts_per_appearance)
    `);
    for (const p of pitcherScores) insertPitcher.run(p);

    // Filter out pitchers with token batter projections (< 10 PA)
    const rawBatters = db.prepare('SELECT * FROM batters_raw WHERE PA >= 10').all();
    const posRows = db.prepare('SELECT name, source, position FROM position_eligibility').all();
    const positionsMap = {};
    for (const row of posRows) {
      if (!positionsMap[row.name]) positionsMap[row.name] = [];
      positionsMap[row.name].push(row);
    }
    const battersWithPos = rawBatters.map(b => ({
      ...b, position: resolvePosition(positionsMap[b.name] || []),
    }));
    const batterScores = computeBatterScores(battersWithPos, batterWeights, posAdj);

    db.prepare('DELETE FROM batter_scores').run();
    const insertBatter = db.prepare(`
      INSERT INTO batter_scores (name, team, position, raw_score, adjustment, adj_score, pts_per_game)
      VALUES (@name, @team, @position, @raw_score, @adjustment, @adj_score, @pts_per_game)
    `);
    for (const b of batterScores) insertBatter.run(b);

    const espnAdp = getEspnAdp(db);
    const velocityDeltas = getVelocityDeltas(db);
    const combined = buildCombinedRankings(pitcherScores, batterScores, espnAdp, velocityDeltas);

    db.prepare('DELETE FROM combined_rankings').run();
    const insertCombined = db.prepare(`
      INSERT INTO combined_rankings (rank, name, team, position, score, adj_score,
        espn_adp, velocity_delta, velo_prev, velo_curr, velo_n, per_game_efficiency, value_gap)
      VALUES (@rank, @name, @team, @position, @score, @adj_score,
        @espn_adp, @velocity_delta, @velo_prev, @velo_curr, @velo_n, @per_game_efficiency, @value_gap)
    `);
    for (const c of combined) insertCombined.run(c);
  })();
}
