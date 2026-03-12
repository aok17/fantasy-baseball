import { describe, it, expect } from 'vitest';
import { computePitcherScores } from '../../src/scoring/pitcher-scoring.js';

const weights = {
  IP: 2.1, W: 3.5, L: -1.0, QS: 2.0, SV: 5.0,
  H: -0.6, ER: -1.5, SO: 1.0, BB: -0.5,
};
const replacementLevel = 237;

describe('computePitcherScores', () => {
  it('computes raw score as SUMPRODUCT of stats and weights', () => {
    const pitcher = {
      name: 'Test SP', team: 'NYY',
      IP: 200, W: 15, L: 8, QS: 25, SV: 0, HLD: 0,
      H: 170, ER: 70, HR: 20, SO: 200, BB: 50, G: 33, GS: 33,
    };
    const result = computePitcherScores([pitcher], weights, replacementLevel);
    // 200*2.1 + 15*3.5 + 8*-1 + 25*2 + 0*5 + 170*-0.6 + 70*-1.5 + 200*1 + 50*-0.5
    // = 420 + 52.5 - 8 + 50 + 0 - 102 - 105 + 200 - 25 = 482.5
    expect(result[0].raw_score).toBeCloseTo(482.5, 1);
  });

  it('classifies scoring_position as CLOSER when SV > 0', () => {
    const closer = {
      name: 'Closer', team: 'BOS', IP: 60, W: 3, L: 2, QS: 0,
      SV: 30, HLD: 0, H: 40, ER: 15, HR: 5, SO: 70, BB: 15, G: 60, GS: 0,
    };
    const result = computePitcherScores([closer], weights, replacementLevel);
    expect(result[0].scoring_position).toBe('CLOSER');
    expect(result[0].adjustment).toBe(-10);
  });

  it('classifies display_position as SP, RP for dual-eligible', () => {
    const swingman = {
      name: 'Swingman', team: 'LAD', IP: 100, W: 5, L: 4, QS: 5,
      SV: 2, HLD: 3, H: 90, ER: 40, HR: 10, SO: 80, BB: 30, G: 40, GS: 15,
    };
    const result = computePitcherScores([swingman], weights, replacementLevel);
    expect(result[0].scoring_position).toBe('CLOSER');
    expect(result[0].display_position).toBe('SP, RP');
  });

  it('computes SP adjustment correctly', () => {
    const sp = {
      name: 'SP', team: 'HOU', IP: 180, W: 12, L: 6, QS: 20,
      SV: 0, HLD: 0, H: 150, ER: 60, HR: 18, SO: 190, BB: 40, G: 30, GS: 30,
    };
    const result = computePitcherScores([sp], weights, replacementLevel);
    const expected_adj = -Math.min(result[0].raw_score * 3 / 7, 237 * 10 / 7 * 3 / 7) + 165;
    expect(result[0].adjustment).toBeCloseTo(expected_adj, 1);
  });

  it('computes adj_2020_value with dual-path valuation', () => {
    const sp = {
      name: 'SP', team: 'HOU', IP: 180, W: 12, L: 6, QS: 20,
      SV: 0, HLD: 0, H: 150, ER: 60, HR: 18, SO: 190, BB: 40, G: 30, GS: 30,
    };
    const result = computePitcherScores([sp], weights, replacementLevel);
    const raw = result[0].raw_score;
    const sp_value = -Math.min(raw * 3 / 7, 237 * 10 / 7 * 3 / 7) + 215 + raw;
    const rp_value = 0 + 71;
    expect(result[0].adj_2020_value).toBeCloseTo(Math.max(sp_value, rp_value), 1);
  });

  it('handles zero IP without crashing', () => {
    const zeroIP = {
      name: 'NoIP', team: 'FA', IP: 0, W: 0, L: 0, QS: 0,
      SV: 0, HLD: 0, H: 0, ER: 0, HR: 0, SO: 0, BB: 0, G: 0, GS: 0,
    };
    const result = computePitcherScores([zeroIP], weights, replacementLevel);
    expect(result[0].relief_pts).toBe(0);
    expect(result[0].pts_per_appearance).toBe(0);
  });
});
