import { describe, it, expect } from 'vitest';
import { computeBatterScores, resolvePosition } from '../../src/scoring/batter-scoring.js';

const weights = {
  H: 1.0, '2B': 1.0, '3B': 2.0, HR: 3.1, R: 1.1,
  RBI: 1.1, BB: 1.0, SO: -1.0, SB: 2.0,
};
const posAdj = { C: 70, OF: 40, '2B': 30, '3B': 25, SS: 20, '1B': 15, Other: 10 };

describe('resolvePosition', () => {
  it('returns positions from highest-priority source', () => {
    const rows = [
      { source: 'yahoo_2025', position: 'SS' },
      { source: 'espn_2024', position: '2B' },
    ];
    expect(resolvePosition(rows)).toBe('SS');
  });

  it('returns espn_2025 over yahoo_2025 when both present', () => {
    const rows = [
      { source: 'espn_2025', position: 'OF' },
      { source: 'espn_2025', position: '2B' },
      { source: 'yahoo_2025', position: 'SS' },
    ];
    expect(resolvePosition(rows)).toBe('OF, 2B');
  });

  it('joins multiple positions from same source with comma', () => {
    const rows = [
      { source: 'espn_2025', position: 'SS' },
      { source: 'espn_2025', position: 'OF' },
    ];
    expect(resolvePosition(rows)).toBe('SS, OF');
  });

  it('returns Other when no rows', () => {
    expect(resolvePosition([])).toBe('Other');
  });

  it('prefers manual source above all others', () => {
    const rows = [
      { source: 'espn_2025', position: 'OF' },
      { source: 'manual', position: 'SS' },
    ];
    expect(resolvePosition(rows)).toBe('SS');
  });
});

describe('computeBatterScores', () => {
  it('computes raw score as SUMPRODUCT', () => {
    const batter = {
      name: 'Batter', team: 'NYM', G: 150, H: 160, '2B': 30,
      '3B': 5, HR: 35, R: 95, RBI: 100, BB: 60, SO: 130, SB: 15,
      position: 'OF',
    };
    const result = computeBatterScores([batter], weights, posAdj);
    // 160 + 30 + 10 + 108.5 + 104.5 + 110 + 60 - 130 + 30 = 483
    expect(result[0].raw_score).toBeCloseTo(483, 1);
  });

  it('applies position scarcity adjustment for catcher', () => {
    const catcher = {
      name: 'Catcher', team: 'STL', G: 120, H: 100, '2B': 20,
      '3B': 1, HR: 15, R: 50, RBI: 55, BB: 40, SO: 90, SB: 2,
      position: 'C',
    };
    const result = computeBatterScores([catcher], weights, posAdj);
    expect(result[0].adjustment).toBe(70);
    expect(result[0].adj_score).toBe(result[0].raw_score + 70);
  });

  it('uses first position from multi-position string for adjustment', () => {
    const multi = {
      name: 'Multi', team: 'CHC', G: 140, H: 150, '2B': 25,
      '3B': 3, HR: 20, R: 75, RBI: 80, BB: 50, SO: 110, SB: 10,
      position: 'OF, 2B',
    };
    const result = computeBatterScores([multi], weights, posAdj);
    expect(result[0].adjustment).toBe(40);
  });

  it('handles zero games without crashing', () => {
    const noGames = {
      name: 'NoG', team: 'FA', G: 0, H: 0, '2B': 0, '3B': 0,
      HR: 0, R: 0, RBI: 0, BB: 0, SO: 0, SB: 0, position: '1B',
    };
    const result = computeBatterScores([noGames], weights, posAdj);
    expect(result[0].pts_per_game).toBe(0);
  });
});
