import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ensureTeamOffenseTable,
  rankTeamOffense,
  upsertTeamOffense,
  getTeamOffenseMap,
} from '../../src/scrapers/team-offense.js';

function mkDb() {
  const db = new Database(':memory:');
  ensureTeamOffenseTable(db);
  return db;
}

const row = (team_id, abbr, games, runs, name = `Team ${abbr}`) => ({
  team_id, abbr, name, games, runs, runs_per_game: games > 0 ? runs / games : 0,
});

describe('rankTeamOffense', () => {
  it('ranks 1 = most runs per game, N = fewest', () => {
    const ranked = rankTeamOffense([
      row(1, 'AAA', 100, 400), // 4.00
      row(2, 'BBB', 100, 600), // 6.00 -> best
      row(3, 'CCC', 100, 500), // 5.00
    ]);
    const byId = new Map(ranked.map(r => [r.team_id, r.runs_rank]));
    expect(byId.get(2)).toBe(1);
    expect(byId.get(3)).toBe(2);
    expect(byId.get(1)).toBe(3);
  });

  it('ranks on rate, not raw runs (fewer games can still be #1)', () => {
    const ranked = rankTeamOffense([
      row(1, 'AAA', 100, 500), // 5.00
      row(2, 'BBB', 50, 300),  // 6.00 with fewer total runs
    ]);
    expect(ranked.find(r => r.team_id === 2).runs_rank).toBe(1);
    expect(ranked.find(r => r.team_id === 1).runs_rank).toBe(2);
  });

  it('breaks runs_per_game ties by total runs', () => {
    const ranked = rankTeamOffense([
      row(1, 'AAA', 50, 250),  // 5.00, 250 runs
      row(2, 'BBB', 100, 500), // 5.00, 500 runs -> wins the tiebreak
    ]);
    expect(ranked.find(r => r.team_id === 2).runs_rank).toBe(1);
    expect(ranked.find(r => r.team_id === 1).runs_rank).toBe(2);
  });

  it('gives fully tied teams the same rank and skips the next (1,2,2,4)', () => {
    const ranked = rankTeamOffense([
      row(1, 'AAA', 100, 600),
      row(2, 'BBB', 100, 500),
      row(3, 'CCC', 100, 500),
      row(4, 'DDD', 100, 400),
    ]);
    const byId = new Map(ranked.map(r => [r.team_id, r.runs_rank]));
    expect(byId.get(1)).toBe(1);
    expect(byId.get(2)).toBe(2);
    expect(byId.get(3)).toBe(2);
    expect(byId.get(4)).toBe(4);
  });

  it('places a zero-games team last without dividing by zero', () => {
    const ranked = rankTeamOffense([
      row(1, 'AAA', 0, 0),
      row(2, 'BBB', 10, 40),
    ]);
    const t1 = ranked.find(r => r.team_id === 1);
    expect(t1.runs_per_game).toBe(0);
    expect(t1.runs_rank).toBe(2);
  });

  it('computes runs_per_game when the input omits it', () => {
    const ranked = rankTeamOffense([{ team_id: 1, abbr: 'AAA', name: 'A', games: 4, runs: 20 }]);
    expect(ranked[0].runs_per_game).toBe(5);
  });

  it('does not mutate the input rows', () => {
    const input = [row(1, 'AAA', 10, 50)];
    rankTeamOffense(input);
    expect(input[0].runs_rank).toBeUndefined();
  });

  it('handles an empty list', () => {
    expect(rankTeamOffense([])).toEqual([]);
  });
});

describe('upsertTeamOffense', () => {
  let db;
  beforeEach(() => { db = mkDb(); });

  it('creates the table itself when it does not exist yet', () => {
    const fresh = new Database(':memory:');
    expect(() => upsertTeamOffense(fresh, [row(1, 'AAA', 10, 50)], 2026)).not.toThrow();
    expect(fresh.prepare('SELECT COUNT(*) c FROM mlb_team_offense').get().c).toBe(1);
  });

  it('persists every column with the computed rank', () => {
    const n = upsertTeamOffense(db, [
      row(119, 'LAD', 113, 577, 'Los Angeles Dodgers'),
      row(134, 'PIT', 114, 456, 'Pittsburgh Pirates'),
    ], 2026);
    expect(n).toBe(2);
    const lad = db.prepare('SELECT * FROM mlb_team_offense WHERE team_id = 119').get();
    expect(lad.season).toBe(2026);
    expect(lad.abbr).toBe('LAD');
    expect(lad.name).toBe('Los Angeles Dodgers');
    expect(lad.games).toBe(113);
    expect(lad.runs).toBe(577);
    expect(lad.runs_per_game).toBeCloseTo(577 / 113, 6);
    expect(lad.runs_rank).toBe(1);
    expect(lad.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(db.prepare('SELECT runs_rank r FROM mlb_team_offense WHERE team_id = 134').get().r).toBe(2);
  });

  it('produces ranks 1..30 across a full league', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(row(100 + i, `T${i}`, 100, 300 + i * 10));
    upsertTeamOffense(db, rows, 2026);
    const ranks = db.prepare('SELECT runs_rank FROM mlb_team_offense ORDER BY runs_rank').all().map(r => r.runs_rank);
    expect(ranks).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    // Highest scoring team (last one added) is rank 1.
    expect(db.prepare('SELECT team_id FROM mlb_team_offense WHERE runs_rank = 1').get().team_id).toBe(129);
    expect(db.prepare('SELECT team_id FROM mlb_team_offense WHERE runs_rank = 30').get().team_id).toBe(100);
  });

  it('updates in place on re-run rather than duplicating', () => {
    upsertTeamOffense(db, [row(1, 'AAA', 10, 50), row(2, 'BBB', 10, 40)], 2026);
    upsertTeamOffense(db, [row(1, 'AAA', 20, 80), row(2, 'BBB', 20, 140)], 2026);
    expect(db.prepare('SELECT COUNT(*) c FROM mlb_team_offense').get().c).toBe(2);
    const a = db.prepare('SELECT * FROM mlb_team_offense WHERE team_id = 1').get();
    expect(a.games).toBe(20);
    expect(a.runs).toBe(80);
    expect(a.runs_rank).toBe(2); // BBB overtook it
    expect(db.prepare('SELECT runs_rank r FROM mlb_team_offense WHERE team_id = 2').get().r).toBe(1);
  });

  it('skips rows without a team_id', () => {
    const n = upsertTeamOffense(db, [row(1, 'AAA', 10, 50), { abbr: 'ZZZ', games: 1, runs: 1 }], 2026);
    expect(n).toBe(1);
  });

  it('tolerates an empty row list', () => {
    expect(upsertTeamOffense(db, [], 2026)).toBe(0);
    expect(upsertTeamOffense(db, null, 2026)).toBe(0);
  });
});

describe('getTeamOffenseMap', () => {
  it('returns a Map keyed by team_id with the display fields', () => {
    const db = mkDb();
    upsertTeamOffense(db, [
      row(119, 'LAD', 100, 600, 'Los Angeles Dodgers'),
      row(134, 'PIT', 100, 400, 'Pittsburgh Pirates'),
    ], 2026);
    const map = getTeamOffenseMap(db);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(2);
    expect(map.get(119)).toEqual({
      abbr: 'LAD', name: 'Los Angeles Dodgers', runs_per_game: 6, runs_rank: 1,
    });
    expect(map.get(134).runs_rank).toBe(2);
    expect(map.get(999)).toBeUndefined();
  });

  it('returns an empty Map (not a throw) before any refresh', () => {
    const fresh = new Database(':memory:');
    const map = getTeamOffenseMap(fresh);
    expect(map.size).toBe(0);
  });
});

describe('club abbreviations', () => {
  it('normalizes StatsAPI spellings to the ones used in players.team', async () => {
    // Otherwise the same club reads "SF" in a matchup and "SFG" in the player
    // row, and every Giant looks freshly traded.
    const rows = rankTeamOffense([
      { team_id: 137, abbr: 'SF', name: 'Giants', games: 10, runs: 50, runs_per_game: 5 },
      { team_id: 135, abbr: 'SD', name: 'Padres', games: 10, runs: 40, runs_per_game: 4 },
    ]);
    expect(rows).toHaveLength(2);
  });
});
