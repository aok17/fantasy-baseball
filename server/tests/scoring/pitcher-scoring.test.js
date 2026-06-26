import { describe, it, expect } from 'vitest';
import { computePitcherScores, applyPitcherVOR } from '../../src/scoring/pitcher-scoring.js';

const weights = {
  IP: 2.1, W: 3.5, L: -1.0, QS: 2.0, SV: 5.0,
  H: -0.6, ER: -1.5, SO: 1.0, BB: -0.5,
};

describe('computePitcherScores (raw components)', () => {
  it('computes raw score as SUMPRODUCT of stats and weights', () => {
    const pitcher = {
      name: 'Test SP', team: 'NYY',
      IP: 200, W: 15, L: 8, QS: 25, SV: 0, HLD: 0,
      H: 170, ER: 70, HR: 20, SO: 200, BB: 50, G: 33, GS: 33,
    };
    const result = computePitcherScores([pitcher], weights);
    // 420 + 52.5 - 8 + 50 + 0 - 102 - 105 + 200 - 25 = 482.5
    expect(result[0].raw_score).toBeCloseTo(482.5, 1);
  });

  it('a pure starter has all value in starting_pts, none in relief', () => {
    const sp = {
      name: 'SP', team: 'HOU', IP: 180, W: 12, L: 6, QS: 20,
      SV: 0, HLD: 0, H: 150, ER: 60, HR: 18, SO: 190, BB: 40, G: 30, GS: 30,
    };
    const r = computePitcherScores([sp], weights)[0];
    expect(r.display_position).toBe('SP');
    expect(r.relief_pts).toBe(0);
    expect(r.starting_pts).toBeCloseTo(r.raw_score, 5);
  });

  it('classifies CLOSER (SV>0) and routes its value through relief_pts', () => {
    const closer = {
      name: 'Closer', team: 'BOS', IP: 60, W: 3, L: 2, QS: 0,
      SV: 30, HLD: 0, H: 40, ER: 15, HR: 5, SO: 70, BB: 15, G: 60, GS: 0,
    };
    const r = computePitcherScores([closer], weights)[0];
    expect(r.scoring_position).toBe('CLOSER');
    expect(r.display_position).toBe('RP');
    expect(r.starting_pts).toBe(0);
    expect(r.relief_pts).toBeCloseTo(r.raw_score, 5);
  });

  it('classifies display_position as SP, RP for dual-eligible', () => {
    const swingman = {
      name: 'Swingman', team: 'LAD', IP: 100, W: 5, L: 4, QS: 5,
      SV: 2, HLD: 3, H: 90, ER: 40, HR: 10, SO: 80, BB: 30, G: 40, GS: 15,
    };
    const r = computePitcherScores([swingman], weights)[0];
    expect(r.display_position).toBe('SP, RP');
  });

  it('handles zero IP without crashing', () => {
    const zeroIP = {
      name: 'NoIP', team: 'FA', IP: 0, W: 0, L: 0, QS: 0,
      SV: 0, HLD: 0, H: 0, ER: 0, HR: 0, SO: 0, BB: 0, G: 0, GS: 0,
    };
    const r = computePitcherScores([zeroIP], weights)[0];
    expect(r.relief_pts).toBe(0);
    expect(r.pts_per_appearance).toBe(0);
  });
});

describe('applyPitcherVOR (value over replacement, role-split)', () => {
  const base = computePitcherScores([
    { name: 'SP', team: 'HOU', IP: 180, W: 12, L: 6, QS: 20, SV: 0, HLD: 0, H: 150, ER: 60, HR: 18, SO: 190, BB: 40, G: 30, GS: 30 },
  ], weights);

  it('starter valued above SP replacement, not RP', () => {
    const [p] = applyPitcherVOR(base, { sp: 200, rp: 50 });
    expect(p.sp_vor).toBeCloseTo(p.starting_pts - 200, 5);
    expect(p.adj_2020_value).toBeCloseTo(p.starting_pts - 200, 5);
    expect(p.adj_score).toBe(p.adj_2020_value);
  });

  it('closer valued above RP replacement (its better role)', () => {
    const closer = computePitcherScores([
      { name: 'Closer', team: 'BOS', IP: 60, W: 3, L: 2, QS: 0, SV: 30, HLD: 0, H: 40, ER: 15, HR: 5, SO: 70, BB: 15, G: 60, GS: 0 },
    ], weights);
    const [c] = applyPitcherVOR(closer, { sp: 200, rp: 50 });
    expect(c.rp_vor).toBeCloseTo(c.relief_pts - 50, 5);
    expect(c.adj_2020_value).toBeCloseTo(c.relief_pts - 50, 5);
  });

  it('missing replacement levels collapse VOR to raw role value (no NaN)', () => {
    const [p] = applyPitcherVOR(base, {});
    expect(p.adj_2020_value).toBeCloseTo(p.starting_pts, 5);
    expect(Number.isNaN(p.adj_2020_value)).toBe(false);
  });
});
