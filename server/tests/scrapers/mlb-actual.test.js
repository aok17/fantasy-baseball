import { describe, it, expect } from 'vitest';
import { parseInnings, mapPitcherSplit, mapBatterSplit } from '../../src/scrapers/mlb-actual.js';
import { toFgAbbrev } from '../../src/scrapers/team-abbrev.js';

const teams = new Map([[143, 'PHI'], [118, 'KCR'], [109, 'ARI'], [145, 'CHW']]);

describe('toFgAbbrev', () => {
  it('maps StatsAPI abbreviations onto the ones in players.team', () => {
    // rescore() links by `name|team`; a mismatch orphans a whole club.
    expect(toFgAbbrev('KC')).toBe('KCR');
    expect(toFgAbbrev('SD')).toBe('SDP');
    expect(toFgAbbrev('SF')).toBe('SFG');
    expect(toFgAbbrev('TB')).toBe('TBR');
    expect(toFgAbbrev('WSH')).toBe('WSN');
    expect(toFgAbbrev('AZ')).toBe('ARI');   // StatsAPI-only spelling
    expect(toFgAbbrev('CWS')).toBe('CHW');  // StatsAPI-only spelling
  });

  it('passes through already-canonical abbreviations', () => {
    for (const t of ['NYY', 'BOS', 'LAD', 'ATH']) expect(toFgAbbrev(t)).toBe(t);
  });

  it('treats free agent / blank as no club', () => {
    expect(toFgAbbrev('FA')).toBeNull();
    expect(toFgAbbrev('')).toBeNull();
    expect(toFgAbbrev(null)).toBeNull();
  });
});

describe('parseInnings', () => {
  // StatsAPI encodes thirds of an inning after the decimal point: "184.2" is
  // 184 innings and 2 outs, NOT 184.2 innings. Treating it as a decimal would
  // quietly skew every rate stat derived from it.
  it('reads the fraction as outs, not tenths', () => {
    expect(parseInnings('184.2')).toBeCloseTo(184 + 2 / 3, 5);
    expect(parseInnings('10.1')).toBeCloseTo(10 + 1 / 3, 5);
    expect(parseInnings('7.0')).toBe(7);
    expect(parseInnings('0.2')).toBeCloseTo(2 / 3, 5);
  });

  it('handles missing or malformed values', () => {
    expect(parseInnings(undefined)).toBe(0);
    expect(parseInnings('')).toBe(0);
    expect(parseInnings('12')).toBe(12);
  });
});

describe('mapPitcherSplit', () => {
  const split = {
    player: { id: 650911, fullName: 'Cristopher Sánchez' },
    team: { id: 143 },
    stat: {
      gamesPitched: 23, gamesStarted: 23, inningsPitched: '144.2',
      wins: 14, losses: 3, saves: 0, holds: 0,
      hits: 130, earnedRuns: 42, homeRuns: 10, strikeOuts: 168,
      baseOnBalls: 30, hitBatsmen: 5, whip: 1.2, era: 2.61,
      strikeoutsPer9Inn: 10.45, walksPer9Inn: 1.87,
    },
  };

  it('maps the counting stats and normalizes the club', () => {
    const p = mapPitcherSplit(split, teams);
    expect(p.name).toBe('Cristopher Sánchez');
    expect(p.team).toBe('PHI');
    expect(p.mlbam_id).toBe('650911');
    expect(p.G).toBe(23);
    expect(p.SO).toBe(168);
    expect(p.IP).toBeCloseTo(144.7, 1);
  });

  it('derives FIP, which StatsAPI does not publish', () => {
    const p = mapPitcherSplit(split, teams, { fipConstant: 3.15 });
    const ip = 144 + 2 / 3;
    const expected = ((13 * 10) + (3 * (30 + 5)) - (2 * 168)) / ip + 3.15;
    expect(p.FIP).toBeCloseTo(expected, 1);
  });

  it('leaves QS at zero — it is not a StatsAPI stat and is backfilled later', () => {
    expect(mapPitcherSplit(split, teams).QS).toBe(0);
  });

  it('zeroes the sabermetrics StatsAPI does not carry', () => {
    const p = mapPitcherSplit(split, teams);
    expect(p.WAR).toBe(0);
    expect(p.RA9WAR).toBe(0);
  });

  it('does not divide by zero for a pitcher with no innings', () => {
    const none = { ...split, stat: { ...split.stat, inningsPitched: '0.0' } };
    expect(mapPitcherSplit(none, teams).FIP).toBe(0);
  });

  it('yields a null club for a player on no roster', () => {
    const noTeam = { ...split, team: { id: 99999 } };
    expect(mapPitcherSplit(noTeam, teams).team).toBeNull();
  });
});

describe('mapBatterSplit', () => {
  const split = {
    player: { id: 677951, fullName: 'Bobby Witt Jr.' },
    team: { id: 118 },
    stat: {
      gamesPlayed: 111, plateAppearances: 506, atBats: 470, hits: 130,
      doubles: 30, triples: 4, homeRuns: 18, runs: 63, rbi: 47,
      baseOnBalls: 30, strikeOuts: 90, hitByPitch: 4,
      stolenBases: 25, caughtStealing: 5,
      avg: '.277', obp: '.330', slg: '.470', ops: '.800',
    },
  };

  it('maps the stats the rankings table displays', () => {
    const b = mapBatterSplit(split, teams);
    expect(b.name).toBe('Bobby Witt Jr.');
    expect(b.team).toBe('KCR');
    expect(b.PA).toBe(506);
    expect(b.HR).toBe(18);
    expect(b.SB).toBe(25);
    expect(b.AVG).toBeCloseTo(0.277, 3);
    expect(b.OPS).toBeCloseTo(0.8, 3);
  });

  it('zeroes the sabermetrics StatsAPI does not carry', () => {
    const b = mapBatterSplit(split, teams);
    for (const k of ['wOBA', 'wRC', 'BsR', 'Fld', 'Off', 'Def', 'WAR']) expect(b[k]).toBe(0);
  });
});
