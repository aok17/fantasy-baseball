import { inferRotation, projectTeamRotation } from '../../src/planning/rotation.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb } from '../../src/db.js';
import { computeProjections, isPlayed, isCalledOff } from '../../src/planning/compute.js';
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

function buildHandMap({ names = false } = {}) {
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
  if (names) {
    // What fetchHandedness really returns for the StatsAPI people payload.
    const label = { [Q[1]]: 'Quincy One', [Q[2]]: 'Quincy Two', [Q[3]]: 'Quincy Three', [Q[4]]: 'Quincy Four' };
    for (const [id, full] of Object.entries(label)) {
      m.set(id, { ...m.get(id), full_name: full, position: 'P', team_abbrev: 'T2' });
    }
  }
  return m;
}

describe('computeProjections (integration, seeded DB)', () => {
  let db, ids;
  beforeEach(() => {
    db = createDb(':memory:');
    ids = seed(db);
    computeProjections(db, { games: buildGames(), handMap: buildHandMap(), asOf: ASOF });
  });

  it('writes a projection row per covered player per week (4 weeks)', () => {
    const n = db.prepare('SELECT COUNT(*) c FROM playing_time_projection').get().c;
    // 5 ranked players + the 4 team-2 starters that exist only in the schedule.
    expect(n).toBe(9 * 4);
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

  it('falls back to last MLB club when handMap team is a minor-league id (rehab/optioned)', () => {
    // The people API hydrate=currentTeam returns a minor-league affiliate id
    // (e.g. 1960) for a player on a rehab assignment, which finds zero games in
    // the MLB-only schedule. He should still map to his last MLB club (team 2)
    // from the lineups and get logs + a non-empty projection.
    const db2 = createDb(':memory:');
    const s = seed(db2);
    const handMap = buildHandMap();
    handMap.set(BAT, { bat_hand: 'L', throw_hand: null, mlb_team_id: 1960 }); // minor-league affiliate
    computeProjections(db2, { games: buildGames(), handMap, asOf: ASOF });

    const logs = db2.prepare('SELECT started FROM batter_game_logs WHERE mlbam_id = ?').all(BAT);
    expect(logs.length).toBe(4);
    expect(logs.every(l => l.started === 1)).toBe(true);

    const wk0 = db2.prepare(
      "SELECT exp_games, games_in_week FROM playing_time_projection WHERE player_id = ? AND week_index = 0"
    ).get(s.pidBat);
    expect(wk0.games_in_week).toBe(5);
    expect(wk0.exp_games).toBeCloseTo(5, 3);
  });

  it('writes one projected_start row per projected start, with opponent + home flag', () => {
    // P1 is the most-due arm: he goes 06-03 (game_pk 5) and 06-07 (game_pk 9).
    // Team 1 is the home club in every fixture game.
    const rows = db.prepare(
      'SELECT * FROM projected_start WHERE mlbam_id = ? ORDER BY game_date'
    ).all(P[1]);
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.game_date)).toEqual(['2026-06-03', '2026-06-07']);
    expect(rows.map(r => r.game_pk)).toEqual([5, 9]);
    expect(rows.every(r => r.player_id === ids.pidP1)).toBe(true);
    expect(rows.every(r => r.week_index === 0)).toBe(true);
    expect(rows.every(r => r.team_id === 1)).toBe(true);
    expect(rows.every(r => r.opp_team_id === 2)).toBe(true);
    expect(rows.every(r => r.is_home === 1)).toBe(true);
    expect(rows.every(r => r.confidence === 'projected')).toBe(true);
  });

  it('flags the opposing starter in the SAME games as away', () => {
    // Q1 pitches the same two game_pks from the other dugout — the home/away
    // flag must come from the schedule row, not from the pitcher's own record.
    const rows = db.prepare(
      'SELECT * FROM projected_start WHERE mlbam_id = ? ORDER BY game_date'
    ).all(Q[1]);
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.game_pk)).toEqual([5, 9]);
    expect(rows.every(r => r.team_id === 2)).toBe(true);
    expect(rows.every(r => r.opp_team_id === 1)).toBe(true);
    expect(rows.every(r => r.is_home === 0)).toBe(true);
  });

  it('writes a start row for every projected turn and none for batters', () => {
    // 5 future games x 2 clubs, every one projectable.
    expect(db.prepare('SELECT COUNT(*) c FROM projected_start').get().c).toBe(10);
    expect(db.prepare('SELECT COUNT(*) c FROM projected_start WHERE mlbam_id = ?').get(BAT).c).toBe(0);
    // exp_starts and the start rows agree.
    const exp = db.prepare(
      'SELECT exp_starts FROM playing_time_projection WHERE player_id = ? AND week_index = 0'
    ).get(ids.pidP1).exp_starts;
    expect(exp).toBe(2);
  });

  it('rebuilds projected_start so stale rows never linger', () => {
    db.prepare(`INSERT INTO projected_start
      (player_id, mlbam_id, week_index, game_pk, game_date, team_id, opp_team_id, is_home, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ids.pidP1, P[1], 0, 999999, '2026-06-04', 1, 2, 1, 'projected');
    computeProjections(db, { games: buildGames(), handMap: buildHandMap(), asOf: ASOF });
    const pks = db.prepare('SELECT game_pk FROM projected_start WHERE mlbam_id = ? ORDER BY game_pk')
      .all(P[1]).map(r => r.game_pk);
    expect(pks).toEqual([5, 9]);
  });

  it('marks an announced probable start as announced', () => {
    const db2 = createDb(':memory:');
    seed(db2);
    const games = buildGames();
    games.find(g => g.game_date === '2026-06-03').home_sp_mlbam = P[2];
    computeProjections(db2, { games, handMap: buildHandMap(), asOf: ASOF });
    const row = db2.prepare(
      'SELECT confidence, is_home, opp_team_id FROM projected_start WHERE mlbam_id = ? AND game_date = ?'
    ).get(P[2], '2026-06-03');
    expect(row.confidence).toBe('announced');
    expect(row.is_home).toBe(1);
    expect(row.opp_team_id).toBe(2);
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

// The whole point of the expansion: combined_rankings is a draft-value list, so
// it omits streamers, call-ups and back-end starters. The schedule knows them.
describe('pitcher universe beyond combined_rankings', () => {
  it('projects team-2 starters that appear only in the schedule', () => {
    const db = createDb(':memory:');
    seed(db); // ranks team-1 SPs + one batter; Q1..Q4 are unranked
    const result = computeProjections(db, {
      games: buildGames(), handMap: buildHandMap({ names: true }), asOf: ASOF,
    });

    expect(result.ranked_pitchers).toBe(4);
    expect(result.unranked_pitchers).toBe(4); // Q1..Q4
    expect(result.pitchers).toBe(8);

    // Each got a players row created from the StatsAPI identity...
    const q1 = db.prepare('SELECT id, name, team FROM players WHERE mlbam_id = ?').get(Q[1]);
    expect(q1).toBeTruthy();
    expect(q1.name).toBe('Quincy One');
    expect(q1.team).toBe('T2');

    // ...and a real projection, including the two-start week the rotation gives
    // the most-due arm over a 5-game week with a 4-man rotation.
    const wk0 = db.prepare(
      "SELECT player_type, games_in_week, exp_starts, two_start FROM playing_time_projection WHERE player_id = ? AND week_index = 0"
    ).get(q1.id);
    expect(wk0.player_type).toBe('P');
    expect(wk0.games_in_week).toBe(5);
    expect(wk0.exp_starts).toBe(2);
    expect(wk0.two_start).toBe(1);

    // No combined_rankings row was invented for them.
    const ranked = db.prepare('SELECT COUNT(*) c FROM combined_rankings WHERE player_id = ?').get(q1.id).c;
    expect(ranked).toBe(0);
  });

  it('falls back to an MLB-id label when StatsAPI gave no name', () => {
    const db = createDb(':memory:');
    seed(db);
    computeProjections(db, { games: buildGames(), handMap: buildHandMap(), asOf: ASOF });
    const q = db.prepare('SELECT name FROM players WHERE mlbam_id = ?').get(Q[2]);
    expect(q.name).toBe(`MLB ${Q[2]}`);
  });

  it('adopts an unmapped players row instead of duplicating a ranked pitcher', () => {
    // Suspect #1: combined_rankings JOIN players WHERE mlbam_id IS NOT NULL.
    // "Quincy One" is ranked but the Savant scraper never stamped his mlbam_id,
    // so he had no projection at all. The schedule identifies him -> the row is
    // adopted (mlbam backfilled) and he keeps his single player_id and rank.
    const db = createDb(':memory:');
    seed(db);
    const { lastInsertRowid: pid } = db.prepare(
      'INSERT INTO players (name, team, mlbam_id) VALUES (?, ?, NULL)'
    ).run('Quincy One', 'T2');
    db.prepare('INSERT INTO combined_rankings (player_id, rank, name, team, position) VALUES (?, ?, ?, ?, ?)')
      .run(pid, 99, 'Quincy One', 'T2', 'SP');

    const result = computeProjections(db, {
      games: buildGames(), handMap: buildHandMap({ names: true }), asOf: ASOF,
    });

    expect(result.players_adopted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM players WHERE name = ?').get('Quincy One').c).toBe(1);
    expect(db.prepare('SELECT mlbam_id FROM players WHERE id = ?').get(pid).mlbam_id).toBe(Q[1]);
    expect(
      db.prepare("SELECT exp_starts FROM playing_time_projection WHERE player_id = ? AND week_index = 0").get(pid).exp_starts
    ).toBe(2);
    // ranked_unmapped is measured before the repair, so it still reports the gap.
    expect(result.ranked_unmapped).toBe(1);
  });

  it('never adopts a players row that a ranking file calls a position player', () => {
    // A name collision between an unmapped hitter and a schedule pitcher must
    // create a new row, not hijack the hitter's.
    const db = createDb(':memory:');
    seed(db);
    const { lastInsertRowid: pid } = db.prepare(
      'INSERT INTO players (name, team, mlbam_id) VALUES (?, ?, NULL)'
    ).run('Quincy One', 'T9');
    db.prepare('INSERT INTO combined_rankings (player_id, rank, name, team, position) VALUES (?, ?, ?, ?, ?)')
      .run(pid, 98, 'Quincy One', 'T9', 'OF');

    const result = computeProjections(db, {
      games: buildGames(), handMap: buildHandMap({ names: true }), asOf: ASOF,
    });
    expect(result.players_adopted).toBe(0);
    expect(db.prepare('SELECT mlbam_id FROM players WHERE id = ?').get(pid).mlbam_id).toBe(null);
    expect(db.prepare('SELECT COUNT(*) c FROM players WHERE mlbam_id = ?').get(Q[1]).c).toBe(1);
  });

  it('resolves a club for a schedule-only pitcher with no currentTeam', () => {
    // handMap has no entry at all (StatsAPI people lookup missed him): the team
    // must still come from the rotation the engine put him in, so games_in_week
    // is his club's real schedule and not 0.
    const db = createDb(':memory:');
    seed(db);
    const handMap = buildHandMap({ names: true });
    handMap.set(Q[1], { bat_hand: 'R', throw_hand: 'R', mlb_team_id: null, full_name: 'Quincy One' });
    computeProjections(db, { games: buildGames(), handMap, asOf: ASOF });
    const pid = db.prepare('SELECT id FROM players WHERE mlbam_id = ?').get(Q[1]).id;
    const wk0 = db.prepare(
      'SELECT games_in_week, exp_starts FROM playing_time_projection WHERE player_id = ? AND week_index = 0'
    ).get(pid);
    expect(wk0.games_in_week).toBe(5);
    expect(wk0.exp_starts).toBe(2);
  });

  it('does not write a pitcher row for a two-way player already covered as a batter', () => {
    // BAT is a ranked OF who also shows up as a probable starter. He must keep
    // his batter projection rather than being overwritten as a pitcher.
    const db = createDb(':memory:');
    const s = seed(db);
    const games = buildGames();
    for (const g of games) if (g.status !== 'Final' && !g.away_sp_mlbam) g.away_sp_mlbam = BAT;
    const result = computeProjections(db, { games, handMap: buildHandMap({ names: true }), asOf: ASOF });
    expect(result.unranked_pitchers).toBe(4);  // Q1..Q4 only — BAT is filtered out
    expect(db.prepare('SELECT COUNT(*) c FROM players WHERE mlbam_id = ?').get(BAT).c).toBe(1);
    const row = db.prepare(
      'SELECT player_type FROM playing_time_projection WHERE player_id = ? AND week_index = 0'
    ).get(s.pidBat);
    expect(row.player_type).toBe('B');
  });
});

describe('game status handling', () => {
  it('counts rain-shortened games as played', () => {
    // "Completed Early" is neither Final nor in the future window, so testing
    // status === 'Final' dropped the game entirely — and its starting pitcher
    // with it, collapsing that club's rotation by one man.
    expect(isPlayed('Completed Early')).toBe(true);
    expect(isPlayed('Completed Early: Rain')).toBe(true);
    expect(isPlayed('Game Over')).toBe(true);
    expect(isPlayed('Final')).toBe(true);
  });

  it('does not count games that have not happened', () => {
    for (const s of ['Scheduled', 'Pre-Game', 'Warmup', 'Postponed', '']) {
      expect(isPlayed(s)).toBe(false);
    }
  });

  it('flags called-off games so no starter is projected against them', () => {
    expect(isCalledOff('Postponed')).toBe(true);
    expect(isCalledOff('Cancelled')).toBe(true);
    expect(isCalledOff('Canceled')).toBe(true);
    expect(isCalledOff('Suspended')).toBe(true);
    expect(isCalledOff('Scheduled')).toBe(false);
    expect(isCalledOff('Final')).toBe(false);
  });

  it('keeps a rotation intact when one past game was shortened', () => {
    // Regression for the real Philadelphia case: Wheeler's Aug 2 start came back
    // as "Completed Early", which dropped him from the inferred rotation and
    // moved Aaron Nola's two-start week a week later than every other source.
    const past = [
      { game_date: '2026-07-28', sp_mlbam: 'nola', status: 'Final' },
      { game_date: '2026-07-29', sp_mlbam: 'luzardo', status: 'Final' },
      { game_date: '2026-07-31', sp_mlbam: 'painter', status: 'Final' },
      { game_date: '2026-08-01', sp_mlbam: 'sanchez', status: 'Final' },
      { game_date: '2026-08-02', sp_mlbam: 'wheeler', status: 'Completed Early' },
      { game_date: '2026-08-03', sp_mlbam: 'nola', status: 'Final' },
    ].filter(g => isPlayed(g.status));

    const { members, size } = inferRotation(past, {});
    expect(size).toBe(5);
    expect(members.map(m => m.mlbam)).toContain('wheeler');

    // Aug 4-6 are announced, which re-syncs the queue exactly as it does live.
    const future = [
      { game_pk: 1, game_date: '2026-08-04', announced_sp: 'luzardo' },
      { game_pk: 2, game_date: '2026-08-05', announced_sp: 'painter' },
      { game_pk: 3, game_date: '2026-08-06', announced_sp: 'sanchez' },
      ...['2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11']
        .map((d, i) => ({ game_pk: 10 + i, game_date: d, announced_sp: null })),
    ];
    const nolaStarts = projectTeamRotation(past, future, {})
      .filter(a => a.sp_mlbam === 'nola').map(a => a.game_date);
    // Wheeler is the most-due arm, so he takes Aug 7 and Nola goes Aug 8 —
    // giving Nola two starts that week alongside his completed Aug 3.
    expect(nolaStarts).toEqual(['2026-08-08']);
  });
});
