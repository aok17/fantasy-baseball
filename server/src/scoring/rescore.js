import { computePitcherScores, applyPitcherVOR } from './pitcher-scoring.js';
import { computePitcherModel } from './pitcher-model.js';
import { computeBatterScores, applyBatterVOR, resolvePosition } from './batter-scoring.js';
import { computeReplacement, DEFAULT_SLOTS } from './replacement.js';
import { buildCombinedRankings } from './combined.js';
import { normalizeName } from '../planning/player-link.js';

function getWeights(db, category) {
  const rows = db.prepare('SELECT stat, weight FROM scoring_config WHERE category = ?').all(category);
  const weights = {};
  for (const r of rows) weights[r.stat] = r.weight;
  return weights;
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

// Projection feeds don't agree on spelling: Razzball publishes accent-stripped
// names ("Cristopher Sanchez", "Carlos Rodon") where the FanGraphs data already
// in players uses the accented form ("Cristopher Sánchez", "Carlos Rodón").
// Everything below keys players by exact name, so left alone that would insert a
// SECOND row for the same man — splitting his ESPN roster link, position
// eligibility, injury status and playing-time projection across two records.
// Rewrite incoming names onto the spelling already on file before anything is
// keyed by name. Ambiguous names (two players sharing one normalized form on
// different clubs) are left alone rather than risk merging two people.
function buildCanonMaps(db) {
  const existing = db.prepare('SELECT name, team FROM players').all();
  if (!existing.length) return null;
  const byNameTeam = new Map(); // "normname|team" -> canonical spelling
  const byName = new Map();     // "normname" -> { name, team }, or null if ambiguous
  for (const p of existing) {
    const k = normalizeName(p.name);
    if (!k) continue;
    byNameTeam.set(`${k}|${p.team}`, p.name);
    const prev = byName.get(k);
    byName.set(k, byName.has(k) && prev?.name !== p.name ? null : { name: p.name, team: p.team });
  }
  return { byNameTeam, byName };
}

// The canonical (name, team) for one feed row, or null if it's already right.
function canonicalFor(maps, name, team) {
  const k = normalizeName(name);
  if (!k) return null;
  const sole = maps.byName.get(k) || null;
  const canonName = maps.byNameTeam.get(`${k}|${team}`) ?? sole?.name ?? name;
  // A feed that lists someone as a free agent (Razzball's "FA" -> null club)
  // would otherwise insert a second, teamless row for a player already on file:
  // SQLite treats NULLs as distinct in UNIQUE(name, team), so the upsert can't
  // collapse them. Adopt the club already on record instead.
  const canonTeam = team == null && sole?.team != null ? sole.team : team;
  if (canonName === name && canonTeam === team) return null;
  return { name: canonName, team: canonTeam };
}

// Rewrite the raw projection tables onto the spellings already in players.
//
// This has to happen in the TABLES, not just in the in-memory score arrays.
// Renaming only the arrays left pitchers_raw/batters_raw holding the feed's
// accent-stripped spelling, so the player_id backfill — which matches on exact
// name — never matched, and the rankings query then LEFT JOINed those rows to
// nothing. Every accented player (José Ramírez, Ronald Acuña Jr., Jesús
// Luzardo — 95 of them) appeared in the rankings with every stat column blank.
function canonicalizeRawTables(db) {
  const maps = buildCanonMaps(db);
  if (!maps) return 0;
  let renamed = 0;
  for (const table of ['pitchers_raw', 'batters_raw']) {
    const upd = db.prepare(`UPDATE ${table} SET name = ?, team = ? WHERE id = ?`);
    for (const r of db.prepare(`SELECT id, name, team FROM ${table}`).all()) {
      const canon = canonicalFor(maps, r.name, r.team);
      if (canon) { upd.run(canon.name, canon.team, r.id); renamed++; }
    }
  }
  return renamed;
}

// Safety net for score arrays built before the tables were canonicalized.
function canonicalizeNames(db, ...rowSets) {
  const maps = buildCanonMaps(db);
  if (!maps) return 0;
  let renamed = 0;
  for (const rows of rowSets) {
    for (const r of rows) {
      if (!r?.name) continue;
      const canon = canonicalFor(maps, r.name, r.team);
      if (!canon) continue;
      r.name = canon.name;
      r.team = canon.team;
      renamed++;
    }
  }
  return renamed;
}

// Every table that points at players.id, for the merge below.
const PLAYER_FK_TABLES = [
  'pitchers_raw', 'batters_raw', 'pitchers_actual', 'batters_actual',
  'pitcher_scores', 'batter_scores', 'combined_rankings', 'injuries',
  'espn_rank', 'position_eligibility', 'savant_expected', 'pitcher_model',
  'playing_time_projection', 'projected_start', 'pitcher_starts', 'player_notes',
];

// Collapse duplicate players rows that share a name and have NO club.
//
// UNIQUE(name, team) does not constrain NULL teams in SQLite — two NULLs are
// never "equal" — so the ON CONFLICT upsert below silently inserted a fresh row
// for every teamless player on every refresh. The consequences were invisible
// but severe: pitchers_raw would link to the first row while combined_rankings
// linked to the last, so the rankings query joined the two halves of the same
// player to each other and found nothing. Alex Cobb had rows 1157 and 2206.
function mergeDuplicatePlayers(db) {
  const groups = db.prepare(`
    SELECT MIN(id) keep, name, COUNT(*) c FROM players
    WHERE team IS NULL GROUP BY name HAVING c > 1
  `).all();
  if (!groups.length) return 0;

  const dupsOf = db.prepare('SELECT id FROM players WHERE name = ? AND team IS NULL AND id != ?');
  let merged = 0;
  for (const g of groups) {
    for (const d of dupsOf.all(g.name, g.keep)) {
      for (const t of PLAYER_FK_TABLES) {
        // OR IGNORE: a table with a unique player_id (player_notes) may already
        // hold a row for the surviving id; the loser is dropped next.
        try { db.prepare(`UPDATE OR IGNORE ${t} SET player_id = ? WHERE player_id = ?`).run(g.keep, d.id); } catch (e) { /* table may not exist */ }
        try { db.prepare(`DELETE FROM ${t} WHERE player_id = ?`).run(d.id); } catch (e) { /* table may not exist */ }
      }
      db.prepare('DELETE FROM players WHERE id = ?').run(d.id);
      merged++;
    }
  }
  return merged;
}

function upsertPlayers(db, pitcherScores, batterScores) {
  // Must run before any name-keyed insert or lookup below.
  const renamed = canonicalizeNames(db, pitcherScores, batterScores);
  if (renamed) console.log(`Canonicalized ${renamed} feed names onto existing players rows`);

  // Null-safe upsert. ON CONFLICT(name, team) cannot fire for a NULL team, so a
  // blind INSERT duplicated every teamless player on each run; look first.
  const findPlayer = db.prepare('SELECT id FROM players WHERE name = ? AND team IS ?');
  const insertPlayer = db.prepare('INSERT INTO players (name, team) VALUES (?, ?)');
  const upsert = {
    run: (name, team) => {
      const t = team ?? null;
      const found = findPlayer.get(name, t);
      if (found) return found.id;
      return Number(insertPlayer.run(name, t).lastInsertRowid);
    },
  };
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

  // Populate mlbam_id from the raw projection tables. Razzball ships an MLBAM id
  // per row; FanGraphs never did, which left ~40 ranked players with no mlbam_id
  // and therefore no playing-time projection at all (the planning pipeline joins
  // on it). Matched on name+team first since that's the stronger signal, then by
  // name alone. Both only fill NULLs, so an id already established elsewhere wins.
  const updateMlbamByNameTeam = db.prepare(
    'UPDATE players SET mlbam_id = ? WHERE name = ? AND team = ? AND mlbam_id IS NULL'
  );
  for (const table of ['pitchers_raw', 'batters_raw']) {
    const rows = db.prepare(`SELECT name, team, mlbam_id FROM ${table} WHERE mlbam_id IS NOT NULL`).all();
    for (const r of rows) updateMlbamByNameTeam.run(r.mlbam_id, r.name, r.team);
    for (const r of rows) updateMlbamByName.run(r.mlbam_id, r.name);
  }

  // Populate mlbam_id from statcast
  const statcast = db.prepare('SELECT DISTINCT player_name, player_id FROM statcast_pitches WHERE player_id IS NOT NULL').all();
  for (const r of statcast) updateMlbamByName.run(r.player_id, r.player_name);

  // Build name→id map
  const idMap = {};
  const allPlayers = db.prepare('SELECT id, name, team FROM players').all();
  for (const p of allPlayers) idMap[`${p.name}|${p.team}`] = p.id;

  // Populate player_id FK on all satellite tables. Team comparisons use IS, not
  // =, because = is never true when either side is NULL — so every teamless
  // player (a feed's free agents) previously failed to link and joined to
  // nothing in the rankings query.
  db.exec(`
    UPDATE pitchers_raw SET player_id = (
      SELECT p.id FROM players p WHERE p.name = pitchers_raw.name AND p.team IS pitchers_raw.team
    ) WHERE player_id IS NULL;
    UPDATE batters_raw SET player_id = (
      SELECT p.id FROM players p WHERE p.name = batters_raw.name AND p.team IS batters_raw.team
    ) WHERE player_id IS NULL;
    UPDATE espn_rank SET player_id = (
      SELECT p.id FROM players p WHERE p.name = espn_rank.name AND p.team IS NOT NULL
      ORDER BY p.fg_id IS NOT NULL DESC LIMIT 1
    ) WHERE player_id IS NULL;
    UPDATE injuries SET player_id = (
      SELECT p.id FROM players p WHERE p.name = injuries.name AND p.team IS injuries.team
    ) WHERE player_id IS NULL;
  `);

  // The rankings query LEFT JOINs pitchers_raw / batters_raw / pitchers_actual /
  // batters_actual on player_id, and none of those columns is unique. Two rows
  // sharing a player_id therefore fan the result out and the same player appears
  // twice in the rankings — 45 duplicate rows in production, e.g. Andrew Vaughn
  // and Randy Vásquez listed twice at identical rank and score. Collapse to one
  // row per player per table. Idempotent, so it also cleans data already on disk.
  for (const table of ['pitchers_raw', 'batters_raw', 'pitchers_actual', 'batters_actual']) {
    try {
      db.prepare(`
        DELETE FROM ${table} WHERE player_id IS NOT NULL AND id NOT IN (
          SELECT MIN(id) FROM ${table} WHERE player_id IS NOT NULL GROUP BY player_id
        )
      `).run();
    } catch (e) { /* table may not exist on an old DB */ }
  }

  // injuries is UNIQUE(name, team), so a traded player keeps a stale row under
  // his old club and both resolve to the same player_id — which fanned the
  // rankings query out (Andrew Vaughn, CHW -> MIL, listed twice). Keep the
  // newest row per player; savant_expected is handled in the query instead,
  // since its two rows per player are legitimate (pitcher and batter profiles).
  try {
    db.prepare(`
      DELETE FROM injuries WHERE player_id IS NOT NULL AND id NOT IN (
        SELECT MAX(id) FROM injuries WHERE player_id IS NOT NULL GROUP BY player_id
      )
    `).run();
  } catch (e) { /* table may not exist on an old DB */ }

  // Copy espn_id from espn_rank to players for ID-based matching
  // Always re-derive (not WHERE NULL) in case ESPN data changed
  db.exec(`
    UPDATE players SET espn_id = (
      SELECT er.espn_id FROM espn_rank er WHERE er.player_id = players.id AND er.espn_id IS NOT NULL
    );
  `);

  // Match position_eligibility via espn_id (handles name collisions like two "Julio Rodriguez")
  db.exec(`
    UPDATE position_eligibility SET player_id = (
      SELECT p.id FROM players p WHERE p.espn_id = position_eligibility.espn_id
    ) WHERE player_id IS NULL AND espn_id IS NOT NULL;
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
    const leagueSize = Number(getConfig(db, 'league_size')) || 10;
    let slots;
    try { slots = JSON.parse(getConfig(db, 'roster_slots') || ''); } catch { slots = null; }
    if (!slots) slots = DEFAULT_SLOTS;

    // Repair any teamless duplicates left by earlier runs before anything reads
    // players, or the name maps and idMap below inherit the split.
    const mergedPlayers = mergeDuplicatePlayers(db);
    if (mergedPlayers) console.log(`Merged ${mergedPlayers} duplicate teamless player rows`);

    // Put the feed's spellings onto the names already on file BEFORE anything
    // reads these tables, so the score arrays, the player_id backfill and the
    // rankings joins all agree on one spelling per player.
    const renamedRaw = canonicalizeRawTables(db);
    if (renamedRaw) console.log(`Canonicalized ${renamedRaw} raw projection rows onto existing player names`);

    // Collapse duplicate rows before anything reads them. Doing this only after
    // player_id is assigned would be too late: the score arrays are built from
    // these tables, so a duplicate row would still reach combined_rankings even
    // once the table itself was cleaned. GROUP BY treats NULL teams as equal
    // here, unlike the UNIQUE(name, team) constraint.
    for (const t of ['pitchers_raw', 'batters_raw', 'pitchers_actual', 'batters_actual']) {
      try {
        db.prepare(`DELETE FROM ${t} WHERE id NOT IN (SELECT MIN(id) FROM ${t} GROUP BY name, team)`).run();
      } catch (e) { /* table may not exist on an old DB */ }
    }

    const rawPitchers = db.prepare('SELECT * FROM pitchers_raw').all();
    let pitcherScores = computePitcherScores(rawPitchers, pitcherWeights);

    const rawBatters = db.prepare('SELECT * FROM batters_raw WHERE PA >= 10').all();

    // Upsert players and populate player_id FKs on satellite tables FIRST,
    // so position_eligibility.player_id is set via espn_id before we read it.
    // We need a preliminary batter score pass to get player names/teams.
    const idMap = upsertPlayers(db, pitcherScores, rawBatters);

    // NOW read position_eligibility with player_ids properly linked
    const posRows = db.prepare('SELECT player_id, name, source, position FROM position_eligibility').all();
    const positionsMap = {};
    for (const row of posRows) {
      const key = row.player_id || row.name;
      if (!positionsMap[key]) positionsMap[key] = [];
      positionsMap[key].push(row);
    }
    const battersWithPos = rawBatters.map(b => {
      const key = b.player_id || b.name;
      const pid = idMap[`${b.name}|${b.team}`];
      return { ...b, position: resolvePosition(positionsMap[pid] || positionsMap[key] || positionsMap[b.name] || []) };
    });
    let batterScores = computeBatterScores(battersWithPos, batterWeights);

    // Derive replacement levels from the full scored pools + real roster construction,
    // then apply Value Over Replacement. No hand-tuned constants anywhere downstream.
    const repl = computeReplacement(pitcherScores, batterScores, { leagueSize, slots });
    pitcherScores = applyPitcherVOR(pitcherScores, repl);
    batterScores = applyBatterVOR(batterScores, repl.byPos);

    const setCfg = db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)');
    setCfg.run('last_replacement_sp', String(repl.sp));
    setCfg.run('last_replacement_rp', String(repl.rp));
    setCfg.run('last_replacement_by_pos', JSON.stringify(repl.byPos));
    console.log(`VOR replacement (league=${leagueSize}): SP=${repl.sp.toFixed(1)} RP=${repl.rp.toFixed(1)} byPos=${JSON.stringify(repl.byPos)}`);

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

    // Recompute pitcher model if start data exists
    try { computePitcherModel(db); } catch (e) { console.error('Pitcher model computation failed:', e); }
  })();
}
