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
    SELECT p.id as pid, sp.player_name, v_prev, v_curr, (v_curr - v_prev) as delta, n_curr FROM (
      SELECT player_name,
        MAX(CASE WHEN season = ? AND season_type = 'regular' THEN velocity END) as v_prev,
        MAX(CASE WHEN season = ? AND season_type = 'spring' THEN velocity END) as v_curr,
        SUM(CASE WHEN season = ? AND season_type = 'spring' THEN 1 ELSE 0 END) as n_curr
      FROM statcast_pitches GROUP BY player_name
    ) sp
    LEFT JOIN players p ON p.name = sp.player_name
    WHERE v_prev IS NOT NULL AND v_curr IS NOT NULL AND (v_curr - v_prev) < 10
  `).all(prevYear, currentYear, currentYear);
  const deltas = {};
  for (const r of rows) {
    if (r.pid) deltas[r.pid] = { delta: r.delta, velo_prev: r.v_prev, velo_curr: r.v_curr, velo_n: r.n_curr };
  }
  return deltas;
}

function getEspnRank(db) {
  const rows = db.prepare('SELECT player_id, adp_rank FROM espn_rank WHERE player_id IS NOT NULL').all();
  const rank = {};
  for (const r of rows) rank[r.player_id] = r.adp_rank;
  return rank;
}

function upsertPlayers(db, pitcherScores, batterScores) {
  const upsert = db.prepare(`
    INSERT INTO players (name, team) VALUES (?, ?)
    ON CONFLICT(name, team) DO UPDATE SET team = excluded.team
  `);
  const updateFgId = db.prepare('UPDATE players SET fg_id = ? WHERE name = ? AND team = ?');
  const updateMlbamByName = db.prepare('UPDATE players SET mlbam_id = ? WHERE name = ? AND mlbam_id IS NULL');

  // Upsert all scored players
  for (const p of pitcherScores) upsert.run(p.name, p.team);
  for (const b of batterScores) upsert.run(b.name, b.team);

  // Populate fg_id from raw tables
  const fgPitchers = db.prepare('SELECT name, team, fg_id FROM pitchers_raw WHERE fg_id IS NOT NULL').all();
  for (const r of fgPitchers) updateFgId.run(r.fg_id, r.name, r.team);
  const fgBatters = db.prepare('SELECT name, team, fg_id FROM batters_raw WHERE fg_id IS NOT NULL').all();
  for (const r of fgBatters) updateFgId.run(r.fg_id, r.name, r.team);

  // Populate mlbam_id from statcast
  const statcast = db.prepare('SELECT DISTINCT player_name, player_id FROM statcast_pitches WHERE player_id IS NOT NULL').all();
  for (const r of statcast) updateMlbamByName.run(r.player_id, r.player_name);

  // Build name→id map
  const idMap = {};
  const allPlayers = db.prepare('SELECT id, name, team FROM players').all();
  for (const p of allPlayers) idMap[`${p.name}|${p.team}`] = p.id;

  // Populate player_id FK on all satellite tables
  db.exec(`
    UPDATE pitchers_raw SET player_id = (
      SELECT p.id FROM players p WHERE p.name = pitchers_raw.name AND p.team = pitchers_raw.team
    ) WHERE player_id IS NULL;
    UPDATE batters_raw SET player_id = (
      SELECT p.id FROM players p WHERE p.name = batters_raw.name AND p.team = batters_raw.team
    ) WHERE player_id IS NULL;
    UPDATE espn_rank SET player_id = (
      SELECT p.id FROM players p WHERE p.name = espn_rank.name
    ) WHERE player_id IS NULL;
    UPDATE injuries SET player_id = (
      SELECT p.id FROM players p WHERE p.name = injuries.name AND p.team = injuries.team
    ) WHERE player_id IS NULL;
    UPDATE position_eligibility SET player_id = (
      SELECT p.id FROM players p WHERE p.name = position_eligibility.name
    ) WHERE player_id IS NULL;
  `);

  return idMap;
}

export function rescoreAll(db) {
  db.transaction(() => {
    const pitcherWeights = getWeights(db, 'pitcher');
    const batterWeights = getWeights(db, 'batter');
    const posAdj = getPosAdjustments(db);
    const replacementLevel = Number(getConfig(db, 'replacement_level')) || 237;

    const rawPitchers = db.prepare('SELECT * FROM pitchers_raw').all();
    const pitcherScores = computePitcherScores(rawPitchers, pitcherWeights, replacementLevel);

    const rawBatters = db.prepare('SELECT * FROM batters_raw WHERE PA >= 10').all();
    const posRows = db.prepare('SELECT player_id, name, source, position FROM position_eligibility').all();
    const positionsMap = {};
    for (const row of posRows) {
      const key = row.player_id || row.name;
      if (!positionsMap[key]) positionsMap[key] = [];
      positionsMap[key].push(row);
    }
    const battersWithPos = rawBatters.map(b => {
      const key = b.player_id || b.name;
      return { ...b, position: resolvePosition(positionsMap[key] || positionsMap[b.name] || []) };
    });
    const batterScores = computeBatterScores(battersWithPos, batterWeights, posAdj);

    // Upsert players and populate player_id FKs on satellite tables
    const idMap = upsertPlayers(db, pitcherScores, batterScores);

    db.prepare('DELETE FROM pitcher_scores').run();
    const insertPitcher = db.prepare(`
      INSERT INTO pitcher_scores (player_id, name, team, scoring_position, display_position,
        raw_score, adjustment, adj_score, starting_pts, relief_pts, adj_2020_value, pts_per_appearance)
      VALUES (@player_id, @name, @team, @scoring_position, @display_position,
        @raw_score, @adjustment, @adj_score, @starting_pts, @relief_pts, @adj_2020_value, @pts_per_appearance)
    `);
    for (const p of pitcherScores) insertPitcher.run({ ...p, player_id: idMap[`${p.name}|${p.team}`] || null });

    db.prepare('DELETE FROM batter_scores').run();
    const insertBatter = db.prepare(`
      INSERT INTO batter_scores (player_id, name, team, position, raw_score, adjustment, adj_score, pts_per_game)
      VALUES (@player_id, @name, @team, @position, @raw_score, @adjustment, @adj_score, @pts_per_game)
    `);
    for (const b of batterScores) insertBatter.run({ ...b, player_id: idMap[`${b.name}|${b.team}`] || null });

    const espnRank = getEspnRank(db);
    const velocityDeltas = getVelocityDeltas(db);
    const combined = buildCombinedRankings(pitcherScores, batterScores, espnRank, velocityDeltas, idMap);

    db.prepare('DELETE FROM combined_rankings').run();
    const insertCombined = db.prepare(`
      INSERT INTO combined_rankings (player_id, rank, name, team, position, score, adj_score,
        espn_rank, velocity_delta, velo_prev, velo_curr, velo_n, per_game_efficiency, pos_rank, value_gap)
      VALUES (@player_id, @rank, @name, @team, @position, @score, @adj_score,
        @espn_rank, @velocity_delta, @velo_prev, @velo_curr, @velo_n, @per_game_efficiency, @pos_rank, @value_gap)
    `);
    for (const c of combined) insertCombined.run(c);
  })();
}
