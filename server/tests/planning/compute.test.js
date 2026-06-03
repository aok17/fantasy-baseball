import { describe, it, expect, beforeEach } from 'vitest';
import { createDb } from '../../src/db.js';
import { computeProjections } from '../../src/planning/compute.js';
import { buildIlIntervals } from '../../src/planning/il.js';

// Synthetic scenario, all in one team1-vs-team2 series.
// Team 1 runs a clean 4-man rotation P1..P4; team 2 runs Q1..Q4.
// Past (Final) games 05-30..06-02 establish the rotations and a batter's
// start history. Future (Scheduled) games 06-03..06-07 (5 games, all in
// week 0 for a Monday start anchored at asOf=2026-06-03) get projected.
// With a 4-man rotation over 5 games, the most-due starter (P1 / Q1) comes
// up twice -> two-start week.

const ASOF = '2026-06-03'; // Wednesday; week 0 (Mon start) = 2026-06-01..06-07

// mlbam ids
const P = { 1: '1001', 2: '1002', 3: '1003', 4: '1004' }; // team 1 SPs
const Q = { 1: '2001', 2: '2002', 3: '2003', 4: '2004' }; // team 2 SPs
const BAT = '2050'; // a team-2 outfielder

function seed(db) {
  const insPlayer = db.prepare('INSERT INTO players (name, team, mlbam_id) VALUES (?, ?, ?)');
  const insRank = db.prepare(
    'INSERT INTO combined_rankings (player_id, rank, name, team, position) VALUES (?, ?, ?, ?, ?)'
  );
  let rank = 1;
  const addRanked = (name, team, mlbam, position) => {
    const { lastInsertRowid: pid } = insPlayer.run(name, team, mlbam);
    insRank.run(pid, rank++, name, team, position);
    return pid;
  };

  const pidP1 = addRanked('Pitcher One', 'T1', P[1], 'SP');
  addRanked('Pitcher Two', 'T1', P[2], 'SP');
  addRanked('Pitcher Three', 'T1', P[3], 'SP');
  addRanked('Pitcher Four', 'T1', P[4], 'SP');
  const pidBat = addRanked('Batter One', 'T2', BAT, 'OF');

  return { pidP1, pidBat };
}

// Build the in-memory games[] computeProjections expects.
function buildGames() {
  const games = [];
  let pk = 1;
  // Past Final games: team1 home (SP = P[n]) vs team2 away (SP = Q[n]).
  // Batter BAT starts every game (in team2's away lineup).
  const past = [
    ['2026-05-30', P[1], Q[1]],
    ['2026-05-31', P[2], Q[2]],
    ['2026-06-01', P[3], Q[3]],
    ['2026-06-02', P[4], Q[4]],
  ];
  for (const [date, hsp, asp] of past) {
    games.push({
      game_pk: pk++,
      game_date: date,
      season: 2026,
      home_team_id: 1,
      away_team_id: 2,
      home_sp_mlbam: hsp,
      away_sp_mlbam: asp,
      status: 'Final',
      home_lineup: [],          // team1 batters: none ranked, irrelevant
      away_lineup: [BAT],       // team2: our batter started
    });
  }
  // Future Scheduled games, SP unannounced (null) -> rotation projects them.
  const future = ['2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07'];
  for (const date of future) {
    games.push({
      game_pk: pk++,
      game_date: date,
      season: 2026,
      home_team_id: 1,
      away_team_id: 2,
      home_sp_mlbam: null,
      away_sp_mlbam: null,
      status: 'Scheduled',
      home_lineup: [],
      away_lineup: [],
    });
  }
  return games;
}

function buildHandMap() {
  const m = new Map();
  // Team 1 pitchers throw L/R alternating.
  m.set(P[1], { bat_hand: 'R', throw_hand: 'L', mlb_team_id: 1 });
  m.set(P[2], { bat_hand: 'R', throw_hand: 'R', mlb_team_id: 1 });
  m.set(P[3], { bat_hand: 'R', throw_hand: 'L', mlb_team_id: 1 });
  m.set(P[4], { bat_hand: 'R', throw_hand: 'R', mlb_team_id: 1 });
  // Team 2 pitchers.
  m.set(Q[1], { bat_hand: 'R', throw_hand: 'R', mlb_team_id: 2 });
  m.set(Q[2], { bat_hand: 'R', throw_hand: 'R', mlb_team_id: 2 });
  m.set(Q[3], { bat_hand: 'R', throw_hand: 'R', mlb_team_id: 2 });
  m.set(Q[4], { bat_hand: 'R', throw_hand: 'R', mlb_team_id: 2 });
  // The batter, on team 2.
  m.set(BAT, { bat_hand: 'L', throw_hand: null, mlb_team_id: 2 });
  return m;
}

describe('computeProjections (integration, seeded DB)', () => {
  let db, ids;
  beforeEach(() => {
    db = createDb(':memory:');
    ids = seed(db);
    computeProjections(db, { games: buildGames(), handMap: buildHandMap(), asOf: ASOF });
  });

  it('writes a projection row per ranked player per week (4 weeks)', () => {
    const n = db.prepare('SELECT COUNT(*) c FROM playing_time_projection').get().c;
    expect(n).toBe(5 * 4); // 5 ranked players x 4 weeks
  });

  it('persists handedness + team onto players from the handMap', () => {
    const row = db.prepare('SELECT throw_hand, mlb_team_id FROM players WHERE mlbam_id = ?').get(P[1]);
    expect(row.throw_hand).toBe('L');
    expect(row.mlb_team_id).toBe(1);
  });

  it('derives batter_game_logs from past lineups (started=1 each game)', () => {
    const logs = db.prepare('SELECT game_date, started, opp_sp_hand FROM batter_game_logs WHERE mlbam_id = ? ORDER BY game_date').all(BAT);
    expect(logs.length).toBe(4);
    expect(logs.every(l => l.started === 1)).toBe(true);
    // opp SP hand denormalized from team-1 starters: L,R,L,R
    expect(logs.map(l => l.opp_sp_hand)).toEqual(['L', 'R', 'L', 'R']);
  });

  it('projects a two-start week 0 for the most-due pitcher', () => {
    const wk0 = db.prepare(
      "SELECT exp_starts, two_start, player_type, games_in_week FROM playing_time_projection WHERE player_id = ? AND week_index = 0"
    ).get(ids.pidP1);
    expect(wk0.player_type).toBe('P');
    expect(wk0.games_in_week).toBe(5);
    expect(wk0.exp_starts).toBe(2);
    expect(wk0.two_start).toBe(1);
  });

  it('projects the batter starting all 5 week-0 games', () => {
    const wk0 = db.prepare(
      "SELECT player_type, games_in_week, exp_games, start_rate, confidence FROM playing_time_projection WHERE player_id = ? AND week_index = 0"
    ).get(ids.pidBat);
    expect(wk0.player_type).toBe('B');
    expect(wk0.games_in_week).toBe(5);
    expect(wk0.start_rate).toBeCloseTo(1, 5);
    expect(wk0.exp_games).toBeCloseTo(5, 3);
    expect(wk0.confidence).toBe('projected'); // eff_n >= 3 (4 game logs)
  });

  it('treats an "Activated" injury row as healthy (does NOT zero playing time)', () => {
    const db2 = createDb(':memory:');
    const s = seed(db2);
    db2.prepare(
      "INSERT INTO injuries (name, team, status, mlbam_id) VALUES (?, ?, ?, ?)"
    ).run('Batter One', 'T2', 'Activated', BAT);
    computeProjections(db2, { games: buildGames(), handMap: buildHandMap(), asOf: ASOF });
    const wk0 = db2.prepare(
      "SELECT exp_games FROM playing_time_projection WHERE player_id = ? AND week_index = 0"
    ).get(s.pidBat);
    expect(wk0.exp_games).toBeCloseTo(5, 3);
  });

  it('zeros playing time for a batter on the IL', () => {
    const db2 = createDb(':memory:');
    const s = seed(db2);
    db2.prepare(
      "INSERT INTO injuries (name, team, status, mlbam_id) VALUES (?, ?, ?, ?)"
    ).run('Batter One', 'T2', '10-Day IL', BAT);
    computeProjections(db2, { games: buildGames(), handMap: buildHandMap(), asOf: ASOF });
    const wk0 = db2.prepare(
      "SELECT exp_games FROM playing_time_projection WHERE player_id = ? AND week_index = 0"
    ).get(s.pidBat);
    expect(wk0.exp_games).toBeCloseTo(0, 5);
  });

  it('excludes IL-window games from the batter start rate (IL day is not a rest day)', () => {
    const db2 = createDb(':memory:');
    const s = seed(db2);
    // BAT was on the IL 05-30..05-31 (out of the lineup those days), then
    // returned and started 06-01 and 06-02. Build games where he is absent from
    // the first two lineups and present in the last two.
    const games = [];
    let pk = 1;
    const past = [
      ['2026-05-30', P[1], Q[1], []],        // BAT on IL: not in lineup
      ['2026-05-31', P[2], Q[2], []],        // BAT on IL: not in lineup
      ['2026-06-01', P[3], Q[3], [BAT]],     // returned, started
      ['2026-06-02', P[4], Q[4], [BAT]],     // started
    ];
    for (const [date, hsp, asp, awayLineup] of past) {
      games.push({
        game_pk: pk++, game_date: date, season: 2026,
        home_team_id: 1, away_team_id: 2, home_sp_mlbam: hsp, away_sp_mlbam: asp,
        status: 'Final', home_lineup: [], away_lineup: awayLineup,
      });
    }
    for (const date of ['2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07']) {
      games.push({
        game_pk: pk++, game_date: date, season: 2026,
        home_team_id: 1, away_team_id: 2, home_sp_mlbam: null, away_sp_mlbam: null,
        status: 'Scheduled', home_lineup: [], away_lineup: [],
      });
    }
    const ilIntervals = buildIlIntervals([
      { mlbam: BAT, date: '2026-05-30', description: 'placed on the 10-day injured list' },
      { mlbam: BAT, date: '2026-06-01', description: 'activated from the 10-day injured list' },
    ]);
    computeProjections(db2, { games, handMap: buildHandMap(), ilIntervals, asOf: ASOF });

    // Only the two healthy games become logs; the IL games are not stored as
    // started=0 (which would have dragged the rate to ~0.5).
    const logs = db2.prepare('SELECT game_date, started FROM batter_game_logs WHERE mlbam_id = ? ORDER BY game_date').all(BAT);
    expect(logs.map(l => l.game_date)).toEqual(['2026-06-01', '2026-06-02']);
    expect(logs.every(l => l.started === 1)).toBe(true);

    const wk0 = db2.prepare(
      "SELECT start_rate FROM playing_time_projection WHERE player_id = ? AND week_index = 0"
    ).get(s.pidBat);
    expect(wk0.start_rate).toBeCloseTo(1, 5); // not depressed by the missed IL games
  });

  it('counts games a player actually started even inside an open-ended IL window (missing activation)', () => {
    // Real-world quirk (Anthony Volpe 2026): a player is placed on the IL but the
    // activation never lands in the transactions feed, leaving an open-ended
    // interval. He is clearly healthy — he is in the lineups. A start is ground
    // truth and must count; otherwise he gets 0 logs and vanishes from planning.
    const db2 = createDb(':memory:');
    const s = seed(db2);
    const games = [];
    let pk = 1;
    const past = [
      ['2026-05-30', P[1], Q[1], [BAT]],
      ['2026-05-31', P[2], Q[2], [BAT]],
      ['2026-06-01', P[3], Q[3], [BAT]],
      ['2026-06-02', P[4], Q[4], [BAT]],
    ];
    for (const [date, hsp, asp, awayLineup] of past) {
      games.push({
        game_pk: pk++, game_date: date, season: 2026,
        home_team_id: 1, away_team_id: 2, home_sp_mlbam: hsp, away_sp_mlbam: asp,
        status: 'Final', home_lineup: [], away_lineup: awayLineup,
      });
    }
    // Placement on 2026-03-22, NO activation -> open-ended interval covering all
    // of the above games.
    const ilIntervals = buildIlIntervals([
      { mlbam: BAT, date: '2026-03-22', description: 'placed on the 10-day injured list' },
    ]);
    computeProjections(db2, { games, handMap: buildHandMap(), ilIntervals, asOf: ASOF });

    const logs = db2.prepare('SELECT started FROM batter_game_logs WHERE mlbam_id = ?').all(BAT);
    expect(logs.length).toBe(4);                 // all four starts counted
    expect(logs.every(l => l.started === 1)).toBe(true);
    const wk0 = db2.prepare(
      "SELECT start_rate FROM playing_time_projection WHERE player_id = ? AND week_index = 0"
    ).get(s.pidBat);
    expect(wk0.start_rate).toBeCloseTo(1, 5);
  });

  it('writes empty future weeks with zero/zeroish playing time', () => {
    // Weeks 1..3 have no scheduled games in this fixture.
    const wk1P = db.prepare(
      "SELECT exp_starts, two_start, games_in_week FROM playing_time_projection WHERE player_id = ? AND week_index = 1"
    ).get(ids.pidP1);
    expect(wk1P.games_in_week).toBe(0);
    expect(wk1P.exp_starts).toBe(0);
    expect(wk1P.two_start).toBe(0);

    const wk1B = db.prepare(
      "SELECT exp_games, games_in_week FROM playing_time_projection WHERE player_id = ? AND week_index = 1"
    ).get(ids.pidBat);
    expect(wk1B.games_in_week).toBe(0);
    expect(wk1B.exp_games).toBeCloseTo(0, 5);
  });
});
