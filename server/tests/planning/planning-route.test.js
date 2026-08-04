import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createDb } from '../../src/db.js';
import { createPlanningRouter } from '../../src/routes/planning.js';
import { upsertTeamOffense } from '../../src/scrapers/team-offense.js';

// The route used to INNER JOIN combined_rankings, which deleted every projected
// player that isn't on the draft-value list — i.e. exactly the streamers and
// back-end starters the projection now covers.

const WEEKS = [
  { i: 0, s: '2026-06-01', e: '2026-06-07' },
  { i: 1, s: '2026-06-08', e: '2026-06-14' },
];

function addPlayer(db, { name, team, mlbam, espnId = null }) {
  return Number(
    db.prepare('INSERT INTO players (name, team, mlbam_id, espn_id) VALUES (?, ?, ?, ?)')
      .run(name, team, mlbam, espnId).lastInsertRowid
  );
}

function rank(db, pid, r, name, team, position) {
  db.prepare('INSERT INTO combined_rankings (player_id, rank, name, team, position) VALUES (?, ?, ?, ?, ?)')
    .run(pid, r, name, team, position);
}

function project(db, pid, type, perWeek) {
  const stmt = db.prepare(`
    INSERT INTO playing_time_projection
      (player_id, week_index, week_start, week_end, player_type, games_in_week,
       exp_starts, two_start, exp_games, start_rate, vs_lhp_rate, vs_rhp_rate, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const w of WEEKS) {
    const v = perWeek[w.i] ?? {};
    stmt.run(pid, w.i, w.s, w.e, type, v.games ?? 6,
      type === 'P' ? (v.starts ?? 0) : null,
      type === 'P' ? ((v.starts ?? 0) >= 2 ? 1 : 0) : null,
      type === 'B' ? (v.exp_games ?? 0) : null,
      null, null, null, 'projected');
  }
}

// runs_per_game descending -> NYY rank 1, NYM 2, BOS 3.
const OFFENSE = [
  { team_id: 147, abbr: 'NYY', name: 'New York Yankees', games: 100, runs: 512, runs_per_game: 5.12 },
  { team_id: 121, abbr: 'NYM', name: 'New York Mets', games: 100, runs: 450, runs_per_game: 4.5 },
  { team_id: 111, abbr: 'BOS', name: 'Boston Red Sox', games: 100, runs: 400, runs_per_game: 4.0 },
];

function projectStart(db, pid, mlbam, s) {
  db.prepare(`INSERT INTO projected_start
    (player_id, mlbam_id, week_index, game_pk, game_date, team_id, opp_team_id, is_home, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(pid, mlbam, s.week, s.game_pk, s.game_date, s.team_id ?? 147,
      s.opp_team_id, s.is_home, s.confidence ?? 'projected');
}

describe('GET /api/planning', () => {
  let db, app, server, port;

  beforeEach(async () => {
    db = createDb(':memory:');

    // Ranked: an ace SP and a hitter.
    const ace = addPlayer(db, { name: 'Ace Pitcher', team: 'NYY', mlbam: '101' });
    rank(db, ace, 1, 'Ace Pitcher', 'NYY', 'SP');
    project(db, ace, 'P', { 0: { starts: 2 }, 1: { starts: 1 } });

    // Week 0 is a two-start week: away at NYM on 06-03, home vs BOS on 06-05.
    // Inserted out of order on purpose — the route must sort by game_date.
    projectStart(db, ace, '101', { week: 0, game_pk: 5002, game_date: '2026-06-05', opp_team_id: 111, is_home: 1, confidence: 'announced' });
    projectStart(db, ace, '101', { week: 0, game_pk: 5001, game_date: '2026-06-03', opp_team_id: 121, is_home: 0 });
    projectStart(db, ace, '101', { week: 1, game_pk: 5010, game_date: '2026-06-09', opp_team_id: 147, is_home: 1 });

    const bat = addPlayer(db, { name: 'Big Bat', team: 'LAD', mlbam: '102' });
    rank(db, bat, 2, 'Big Bat', 'LAD', 'OF');
    project(db, bat, 'B', { 0: { exp_games: 5.4 }, 1: { exp_games: 5.1 } });

    // Unranked, schedule-derived: no combined_rankings row at all.
    const streamer = addPlayer(db, { name: 'Streamer Sam', team: 'SEA', mlbam: '201' });
    project(db, streamer, 'P', { 0: { starts: 2 }, 1: { starts: 1 } });

    const spot = addPlayer(db, { name: 'Aaron Spotstart', team: 'PIT', mlbam: '202' });
    project(db, spot, 'P', { 0: { starts: 1 }, 1: { starts: 0 } });

    app = express();
    app.use('/api/planning', createPlanningRouter(db));
    await new Promise(r => { server = app.listen(0, r); });
    port = server.address().port;
  });

  afterEach(() => { server.close(); db.close(); });

  const get = async (qs = '') => (await fetch(`http://localhost:${port}/api/planning${qs}`)).json();

  it('returns unranked projected pitchers alongside ranked players', async () => {
    const body = await get();
    const names = body.players.map(p => p.name);
    expect(names).toContain('Streamer Sam');
    expect(names).toContain('Aaron Spotstart');
    expect(body.players).toHaveLength(4);
  });

  it('reports rank: null for players with no combined ranking', async () => {
    const body = await get();
    const sam = body.players.find(p => p.name === 'Streamer Sam');
    expect(sam.rank).toBe(null);
    expect(sam.player_type).toBe('P');
    expect(sam.weeks).toHaveLength(2);
  });

  it('falls back to the players table for name/team and to SP for position', async () => {
    const body = await get();
    const sam = body.players.find(p => p.name === 'Streamer Sam');
    expect(sam.team).toBe('SEA');
    // The client filters positions with position.includes('SP'), so an unranked
    // pitcher needs a usable position string.
    expect(sam.position).toBe('SP');
  });

  it('sorts ranked players first, then unranked by projected starts then name', async () => {
    const body = await get();
    expect(body.players.map(p => p.name)).toEqual([
      'Ace Pitcher',      // rank 1
      'Big Bat',          // rank 2
      'Streamer Sam',     // unranked, 3 projected starts
      'Aaron Spotstart',  // unranked, 1 projected start (name sorts first, starts win)
    ]);
  });

  it('derives week headers from the projection table, not from players[0]', async () => {
    const body = await get();
    expect(body.weeks).toEqual([
      { week_index: 0, week_start: '2026-06-01', week_end: '2026-06-07' },
      { week_index: 1, week_start: '2026-06-08', week_end: '2026-06-14' },
    ]);
  });

  it('still returns week headers when the scope filter empties players[]', async () => {
    // No rosters rows exist, so scope=rostered yields nobody. The old
    // players[0]?.weeks derivation collapsed the headers to [] here too.
    const body = await get('?scope=rostered');
    expect(body.players).toEqual([]);
    expect(body.weeks).toHaveLength(2);
  });

  it('attaches a starts[] to a two-start pitcher week, date-sorted, with opponents', async () => {
    upsertTeamOffense(db, OFFENSE, 2026);
    const body = await get();
    const ace = body.players.find(p => p.name === 'Ace Pitcher');
    const wk0 = ace.weeks.find(w => w.week_index === 0);
    expect(wk0.exp_starts).toBe(2);
    expect(wk0.starts).toEqual([
      {
        game_date: '2026-06-03',
        game_pk: 5001,
        home: false,
        opp_team_id: 121,
        opp_team_abbr: 'NYM',
        opp_runs_rank: 2,
        opp_runs_per_game: 4.5,
        confidence: 'projected',
      },
      {
        game_date: '2026-06-05',
        game_pk: 5002,
        home: true,
        opp_team_id: 111,
        opp_team_abbr: 'BOS',
        opp_runs_rank: 3,
        opp_runs_per_game: 4.0,
        confidence: 'announced',
      },
    ]);
    // Week 1 keeps its own single start (grouping is per player AND week).
    const wk1 = ace.weeks.find(w => w.week_index === 1);
    expect(wk1.starts).toHaveLength(1);
    expect(wk1.starts[0].opp_team_abbr).toBe('NYY');
    expect(wk1.starts[0].opp_runs_rank).toBe(1);
  });

  it('still emits the opponent when mlb_team_offense is empty', async () => {
    // The offense table is created idempotently by the scraper, not by
    // schema.sql, so on a cold DB it does not exist at all yet. The route must
    // not drop starts or throw — the opponent identity is the load-bearing part.
    const exists = () => db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='mlb_team_offense'"
    ).get().c;
    expect(exists()).toBe(0);
    const body = await get();
    expect(exists()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM mlb_team_offense').get().c).toBe(0);
    const wk0 = body.players.find(p => p.name === 'Ace Pitcher').weeks[0];
    expect(wk0.starts).toHaveLength(2);
    expect(wk0.starts[0]).toEqual({
      game_date: '2026-06-03',
      game_pk: 5001,
      home: false,
      opp_team_id: 121,
      opp_team_abbr: null,
      opp_runs_rank: null,
      opp_runs_per_game: null,
      confidence: 'projected',
    });
  });

  it('falls back to nulls for a team missing from a partially-populated offense table', async () => {
    upsertTeamOffense(db, OFFENSE.filter(t => t.team_id !== 121), 2026);
    const body = await get();
    const wk0 = body.players.find(p => p.name === 'Ace Pitcher').weeks[0];
    expect(wk0.starts[0].opp_team_id).toBe(121);
    expect(wk0.starts[0].opp_team_abbr).toBe(null);
    expect(wk0.starts[0].opp_runs_rank).toBe(null);
    expect(wk0.starts[1].opp_team_abbr).toBe('BOS');
  });

  it('gives a pitcher week with no projected starts an empty array, never undefined', async () => {
    const body = await get();
    const sam = body.players.find(p => p.name === 'Streamer Sam');
    for (const w of sam.weeks) expect(w.starts).toEqual([]);
  });

  it('does not add a starts key to hitter weeks', async () => {
    const body = await get();
    const bat = body.players.find(p => p.name === 'Big Bat');
    for (const w of bat.weeks) expect('starts' in w).toBe(false);
  });

  it('does not duplicate weeks when combined_rankings has two rows for a player', async () => {
    const dup = db.prepare('SELECT player_id FROM combined_rankings WHERE rank = 1').get().player_id;
    rank(db, dup, 1, 'Ace Pitcher', 'NYY', 'SP'); // stale duplicate ranking row
    const body = await get();
    const ace = body.players.find(p => p.name === 'Ace Pitcher');
    expect(ace.weeks).toHaveLength(2);
  });
});
