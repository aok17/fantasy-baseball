import { describe, it, expect } from 'vitest';
import { computeBatterScores, applyBatterVOR, resolvePosition } from '../../src/scoring/batter-scoring.js';

const weights = {
  H: 1.0, '2B': 1.0, '3B': 2.0, HR: 3.1, R: 1.1,
  RBI: 1.1, BB: 1.0, SO: -1.0, SB: 2.0,
};

describe('resolvePosition', () => {
  it('returns positions from highest-priority source prefix', () => {
    expect(resolvePosition([
      { source: 'yahoo_2025', position: 'SS' },
      { source: 'espn_2024', position: '2B' },
    ])).toBe('2B');
  });

  it('returns espn over yahoo when both present', () => {
    expect(resolvePosition([
      { source: 'espn_2025', position: 'OF' },
      { source: 'espn_2025', position: '2B' },
      { source: 'yahoo_2025', position: 'SS' },
    ])).toBe('OF, 2B');
  });

  it('joins multiple positions from same source with comma', () => {
    expect(resolvePosition([
      { source: 'espn_2026', position: 'SS' },
      { source: 'espn_2026', position: 'OF' },
    ])).toBe('SS, OF');
  });

  it('returns DH when no rows', () => {
    expect(resolvePosition([])).toBe('DH');
  });

  it('prefers manual source above all others', () => {
    expect(resolvePosition([
      { source: 'espn_2026', position: 'OF' },
      { source: 'manual', position: 'SS' },
    ])).toBe('SS');
  });

  it('picks newest year when multiple years exist for same prefix', () => {
    expect(resolvePosition([
      { source: 'espn_2024', position: '2B' },
      { source: 'espn_2026', position: 'SS' },
      { source: 'espn_2026', position: 'OF' },
    ])).toBe('SS, OF');
  });
});

describe('computeBatterScores (raw components)', () => {
  it('computes raw score as SUMPRODUCT', () => {
    const batter = {
      name: 'Batter', team: 'NYM', G: 150, H: 160, '2B': 30,
      '3B': 5, HR: 35, R: 95, RBI: 100, BB: 60, SO: 130, SB: 15,
      position: 'OF',
    };
    const r = computeBatterScores([batter], weights)[0];
    // 160 + 30 + 10 + 108.5 + 104.5 + 110 + 60 - 130 + 30 = 483
    expect(r.raw_score).toBeCloseTo(483, 1);
    expect(r.position).toBe('OF');
  });

  it('defaults missing position to DH', () => {
    const r = computeBatterScores([{ name: 'X', team: 'FA', G: 10, H: 5 }], weights)[0];
    expect(r.position).toBe('DH');
  });

  it('handles zero games without crashing', () => {
    const r = computeBatterScores([{ name: 'NoG', team: 'FA', G: 0, position: '1B' }], weights)[0];
    expect(r.pts_per_game).toBe(0);
  });
});

describe('applyBatterVOR (value over positional replacement)', () => {
  it('subtracts the replacement value for the batter position', () => {
    const scored = computeBatterScores([
      { name: 'C1', team: 'STL', G: 120, H: 100, '2B': 20, '3B': 1, HR: 15, R: 50, RBI: 55, BB: 40, SO: 90, SB: 2, position: 'C' },
    ], weights);
    const [b] = applyBatterVOR(scored, { C: 200, OF: 350 });
    expect(b.adj_score).toBeCloseTo(b.raw_score - 200, 5);
    expect(b.adjustment).toBe(-200);
  });

  it('multi-position batter uses the scarcest (lowest-replacement) slot', () => {
    const scored = computeBatterScores([
      { name: 'Multi', team: 'CHC', G: 140, H: 150, position: 'OF, C' },
    ], weights);
    const [b] = applyBatterVOR(scored, { C: 200, OF: 350 });
    // catcher replacement (200) is lower than OF (350) -> bigger VOR
    expect(b.adj_score).toBeCloseTo(b.raw_score - 200, 5);
  });

  it('unknown position falls back to DH replacement', () => {
    const scored = computeBatterScores([{ name: 'P', team: 'X', G: 1, position: 'DH' }], weights);
    const [b] = applyBatterVOR(scored, { DH: 120 });
    expect(b.adj_score).toBeCloseTo(b.raw_score - 120, 5);
  });
});
